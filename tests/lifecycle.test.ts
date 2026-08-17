import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, it, vi } from "vitest";
import piScholarExtension from "../pi/extension.ts";
import { parseCliArgs } from "../src/cli.js";
import { openDatabase } from "../src/database.js";
import { runChildSync } from "../src/external/process.js";
import { WorkflowCoordinator } from "../src/workflows.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type ToolUpdate = {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly details: unknown;
};

type ToolExecutor = (
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: ((update: ToolUpdate) => void) | undefined,
  ctx: { readonly cwd: string },
) => Promise<unknown>;
type CommandHandler = (args: string, ctx: object) => Promise<void> | void;
type LifecycleHooks = {
  readonly agentEnd: Array<() => Promise<void> | void>;
  readonly followUps: string[];
};
type FakeLifecycleApp = {
  readonly paths: { readonly vaultRoot: string };
  readonly finishes: { readonly requestId: string; readonly status: string; readonly options: unknown }[];
  readonly updates: readonly unknown[];
  readonly order: readonly string[];
  recoverAbandonedWorkflows: () => Promise<unknown>;
  status: () => Promise<unknown>;
  updateSettings: (input: unknown) => Promise<unknown>;
  beginWorkflow: (kind: string) => Promise<{ readonly workflow: { readonly requestId: string } }>;
  getExtractContext: (
    input?: { readonly pendingSourceIds?: readonly string[] },
    observer?: (event: {
      readonly entry: number;
      readonly total: number;
      readonly filename: string;
      readonly phase: string;
    }) => void | Promise<void>,
  ) => Promise<unknown>;
  getIngestContext: (input?: { readonly sourceIds?: readonly string[] }) => Promise<unknown>;
  getLintContext: () => Promise<unknown>;
  getQuizContext: () => Promise<unknown>;
  getQuizEvidence: (input: unknown) => Promise<unknown>;
  publishQuiz: (input: unknown) => Promise<unknown>;
  publishExtraction: (input: unknown) => Promise<unknown>;
  stageSource: (request: unknown) => Promise<unknown>;
  applyWikiChange: (input: unknown) => Promise<unknown>;
  applyIngestChange: (input: unknown, workflowRequestId?: string) => Promise<unknown>;
  finishWorkflow: (requestId: string, status: string, options?: unknown) => Promise<unknown>;
  updateWorkflow: (requestId: string, options: unknown) => Promise<unknown>;
  close?: () => Promise<void>;
};

const runtimeApps = vi.hoisted(() => new Map<string, FakeLifecycleApp>());
const vaultResolutionHooks = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../dist/application/application.js", () => ({
  createApplication: ({ paths }: { readonly paths: { readonly vaultRoot: string } }) => {
    const app = runtimeApps.get(paths.vaultRoot);
    if (!app) throw new Error(`missing fake app for ${paths.vaultRoot}`);
    return app;
  },
}));
vi.mock("../dist/vault.js", () => ({
  resolveVault: (cwd?: string) => {
    const vaultRoot = cwd ?? "test-vault";
    vaultResolutionHooks.get(vaultRoot)?.();
    return { vaultRoot };
  },
}));

let lifecycleTestNumber = 0;

function registerLifecycleTools(
  commands?: Map<string, CommandHandler>,
  hooks?: LifecycleHooks,
  parameters?: Map<string, unknown>,
): Map<string, ToolExecutor> {
  const tools = new Map<string, ToolExecutor>();
  const pi = {
    registerTool: (tool: { readonly name: string; readonly execute: ToolExecutor; readonly parameters?: unknown }) => {
      tools.set(tool.name, tool.execute);
      parameters?.set(tool.name, tool.parameters);
    },
    registerCommand: (name: string, command: { readonly handler?: CommandHandler }) => {
      if (command.handler) commands?.set(name, command.handler);
    },
    on: (event: string, handler: () => Promise<void> | void) => {
      if (event === "agent_end") hooks?.agentEnd.push(handler);
    },
    sendUserMessage: (content: string) => {
      hooks?.followUps.push(content);
    },
  } as unknown as ExtensionAPI;
  piScholarExtension(pi);
  return tools;
}

function fakeLifecycleApp(
  context: unknown,
  publishExtraction: (input: unknown) => Promise<unknown>,
  root = `lifecycle-test-${++lifecycleTestNumber}`,
  commands?: Map<string, CommandHandler>,
): {
  readonly app: FakeLifecycleApp;
  readonly root: string;
  readonly tools: Map<string, ToolExecutor>;
  readonly followUps: readonly string[];
  readonly endAgent: () => Promise<void>;
} {
  const finishes: { requestId: string; status: string; options: unknown }[] = [];
  const updates: unknown[] = [];
  const order: string[] = [];
  const hooks: LifecycleHooks = { agentEnd: [], followUps: [] };
  const app: FakeLifecycleApp = {
    paths: { vaultRoot: root },
    finishes,
    updates,
    order,
    recoverAbandonedWorkflows: async () => {
      order.push("recover");
      return {};
    },
    status: async () => ({}),
    updateSettings: async (input) => {
      updates.push(input);
      return {};
    },
    beginWorkflow: async (kind) => {
      order.push(`begin:${kind}`);
      return { workflow: { requestId: `${kind}-${root}` } };
    },
    getExtractContext: async () => context,
    getIngestContext: async () => ({}),
    getLintContext: async () => ({}),
    getQuizContext: async () => context,
    getQuizEvidence: async () => [],
    publishQuiz: async () => ({}),
    publishExtraction,
    stageSource: async () => ({}),
    applyWikiChange: async () => ({}),
    applyIngestChange: async () => ({}),
    finishWorkflow: async (requestId, status, options) => {
      finishes.push({ requestId, status, options });
      return {};
    },
    updateWorkflow: async (_requestId, options) => {
      updates.push(options);
      return {};
    },
  };
  runtimeApps.set(root, app);
  return {
    app,
    root,
    tools: registerLifecycleTools(commands, hooks),
    followUps: hooks.followUps,
    endAgent: async () => {
      for (const handler of hooks.agentEnd) await handler();
    },
  };
}

async function invoke(
  tools: Map<string, ToolExecutor>,
  name: string,
  params: unknown,
  root: string,
  signal?: AbortSignal,
  onUpdate?: (update: ToolUpdate) => void,
): Promise<unknown> {
  const execute = tools.get(name);
  if (!execute) throw new Error(`missing tool ${name}`);
  return execute(name, params, signal, onUpdate, { cwd: root });
}

function claim(claimId: string, preparedId: string): Record<string, string> {
  return { claimId, preparedId, digest: `${preparedId}-digest` };
}

function packageManifest(): {
  readonly pi: { readonly extensions: readonly string[]; readonly skills: readonly string[] };
} {
  return JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    readonly pi: { readonly extensions: readonly string[]; readonly skills: readonly string[] };
  };
}

describe("Pi package lifecycle", () => {
  it("ships one extension and exactly five declared skills", () => {
    const manifest = packageManifest();
    assert.deepEqual(manifest.pi.extensions, ["./pi/extension.ts"]);
    assert.equal(manifest.pi.skills.length, 5);
    assert.deepEqual([...manifest.pi.skills].sort(), [
      "./skills/daily",
      "./skills/extract",
      "./skills/ingest",
      "./skills/lint",
      "./skills/quiz-grader",
    ]);
    for (const skill of manifest.pi.skills) {
      assert.equal(readFileSync(join(repositoryRoot, skill, "SKILL.md"), "utf8").includes("name:"), true);
    }
    assert.deepEqual(
      readdirSync(join(repositoryRoot, "skills"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
      ["daily", "extract", "ingest", "lint", "quiz-grader"],
    );
  });

  it("ships the portable wiki Markdown authoring contract", () => {
    const skillRequirements = [
      "`$...$`",
      "opening and closing `$$` delimiters",
      "`\\(...\\)`",
      "`\\[...\\]`",
      "fenced code block",
      "fenced `mermaid` diagram",
      "Mermaid has no quota",
    ];
    for (const skill of ["ingest", "lint"]) {
      const prompt = readFileSync(join(repositoryRoot, "skills", skill, "SKILL.md"), "utf8");
      for (const requirement of skillRequirements)
        assert.equal(prompt.includes(requirement), true, `${skill} is missing ${requirement}`);
    }

    const parameters = new Map<string, unknown>();
    registerLifecycleTools(undefined, undefined, parameters);
    const schemaRequirements = [
      "$...$",
      "$$ delimiters",
      "wrap formulas in backticks",
      "fenced code block",
      "fenced Mermaid diagram",
      "diagrams by quota",
    ];
    for (const tool of ["scholar_note", "scholar_apply_ingest", "scholar_apply_lint"]) {
      const schema = JSON.stringify(parameters.get(tool));
      for (const requirement of schemaRequirements)
        assert.equal(schema.includes(requirement), true, `${tool} is missing ${requirement}`);
    }
  });

  it("executes the built CLI entrypoint", () => {
    const result = runChildSync(process.execPath, [join(repositoryRoot, "dist", "cli.js")], {
      cwd: repositoryRoot,
      timeoutMs: 5_000,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage:/u);
  });

  it("registers public and typed internal Scholar tools without a process launcher", () => {
    const tools: string[] = [];
    const toolModes = new Map<string, string | undefined>();
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool: (tool: { readonly name: string; readonly executionMode?: string }) => {
        tools.push(tool.name);
        toolModes.set(tool.name, tool.executionMode);
      },
      registerCommand: (name: string) => commands.push(name),
      on: (event: string) => events.push(event),
    } as unknown as ExtensionAPI;
    piScholarExtension(pi);

    assert.deepEqual([...tools].sort(), [
      "scholar_add",
      "scholar_apply_ingest",
      "scholar_apply_lint",
      "scholar_finish_ingest",
      "scholar_finish_lint",
      "scholar_get_daily_context",
      "scholar_get_daily_evidence",
      "scholar_get_extract_context",
      "scholar_get_grading_context",
      "scholar_get_ingest_context",
      "scholar_get_lint_context",
      "scholar_note",
      "scholar_publish_daily",
      "scholar_publish_extraction",
      "scholar_remove_source",
      "scholar_search",
      "scholar_settle_grade",
      "scholar_status",
    ]);
    assert.deepEqual(
      [...toolModes]
        .filter(([, mode]) => mode === "sequential")
        .map(([name]) => name)
        .sort(),
      [
        "scholar_add",
        "scholar_apply_ingest",
        "scholar_apply_lint",
        "scholar_finish_ingest",
        "scholar_finish_lint",
        "scholar_get_daily_context",
        "scholar_get_daily_evidence",
        "scholar_get_extract_context",
        "scholar_get_grading_context",
        "scholar_get_ingest_context",
        "scholar_get_lint_context",
        "scholar_note",
        "scholar_publish_daily",
        "scholar_publish_extraction",
        "scholar_remove_source",
        "scholar_settle_grade",
      ],
    );
    assert.equal(toolModes.get("scholar_search"), undefined);
    assert.equal(toolModes.get("scholar_status"), undefined);
    assert.deepEqual([...commands].sort(), [
      "scholar-add",
      "scholar-issue",
      "scholar-lint",
      "scholar-maintenance",
      "scholar-status",
    ]);
    assert.deepEqual(events, ["agent_end", "session_shutdown"]);
  });

  it("recovers abandoned workflows before starting tool work", async () => {
    const fixture = fakeLifecycleApp({}, async () => ({}));

    await invoke(fixture.tools, "scholar_get_lint_context", {}, fixture.root);

    assert.deepEqual(fixture.app.order, ["recover", "begin:lint"]);
  });

  it("shares recovery across concurrent first tool calls", async () => {
    const fixture = fakeLifecycleApp({}, async () => ({}));
    const recovery = Promise.withResolvers<void>();
    const bothResolved = Promise.withResolvers<void>();
    let recoveries = 0;
    let resolutions = 0;
    vaultResolutionHooks.set(fixture.root, () => {
      resolutions++;
      if (resolutions === 2) bothResolved.resolve();
    });
    fixture.app.recoverAbandonedWorkflows = async () => {
      recoveries++;
      await recovery.promise;
      return {};
    };

    const calls = Promise.all([
      invoke(fixture.tools, "scholar_get_lint_context", {}, fixture.root),
      invoke(fixture.tools, "scholar_get_ingest_context", {}, fixture.root),
    ]);
    await bothResolved.promise;
    recovery.resolve();
    await calls;
    vaultResolutionHooks.delete(fixture.root);

    assert.equal(recoveries, 1);
  });

  it("does not claim a workflow when cancelled during initialization", async () => {
    const fixture = fakeLifecycleApp({}, async () => ({}));
    const recovery = Promise.withResolvers<void>();
    const recoveryStarted = Promise.withResolvers<void>();
    fixture.app.recoverAbandonedWorkflows = async () => {
      fixture.app.order.push("recover");
      recoveryStarted.resolve();
      await recovery.promise;
      return {};
    };
    const controller = new AbortController();
    const call = invoke(fixture.tools, "scholar_get_lint_context", {}, fixture.root, controller.signal);
    await recoveryStarted.promise;
    controller.abort();
    recovery.resolve();

    await assert.rejects(call, /Operation cancelled/u);
    assert.deepEqual(fixture.app.order, ["recover"]);
    assert.deepEqual(fixture.app.finishes, []);
  });

  it("expands and stages scholar-add filesystem arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-add-"));
    const books = join(root, "books");
    const other = join(root, "other");
    mkdirSync(books);
    mkdirSync(other);
    writeFileSync(join(books, "book1.pdf"), "one");
    writeFileSync(join(books, "book2.pdf"), "two");
    writeFileSync(join(other, "golden notes.pdf"), "notes");
    const commands = new Map<string, CommandHandler>();
    const fixture = fakeLifecycleApp({}, async () => ({}), root, commands);
    const staged: unknown[] = [];
    const notifications: string[] = [];
    const statuses: Array<string | undefined> = [];
    fixture.app.stageSource = async (request) => {
      staged.push(request);
      return {};
    };
    const handler = commands.get("scholar-add");
    if (!handler) throw new Error("scholar-add command was not registered");
    const context = {
      cwd: root,
      hasUI: true,
      signal: undefined,
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: (_key: string, status: string | undefined) => statuses.push(status),
      },
    };

    try {
      await handler(`books/*.pdf books/book1.pdf "${join(other, "golden notes.pdf")}"`, context);
      await handler("books/", context);
      assert.deepEqual(staged, [
        { path: join(books, "book1.pdf") },
        { path: join(books, "book2.pdf") },
        { path: join(other, "golden notes.pdf") },
        { path: books },
      ]);
      assert.deepEqual(notifications, ["3 sources staged in inbox", "Source staged in inbox"]);
      await assert.rejects(handler("missing/*.pdf", context), /No filesystem path matched "missing\/\*\.pdf"/u);
      assert.equal(staged.length, 4);
      assert.deepEqual(statuses, [
        "Staging source",
        "Staging sources",
        undefined,
        "Staging source",
        "Staging source",
        undefined,
        "Staging source",
        undefined,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders bounded human status while preserving structured tool status", async () => {
    const commands = new Map<string, CommandHandler>();
    const fixture = fakeLifecycleApp({}, async () => ({}), undefined, commands);
    const status = {
      status: "degraded",
      version: "1.2.3\u0000candidate",
      vaultId: "vault\nid",
      doctor: "fail",
      settings: {
        maintenanceEnabled: true,
        simulatedDate: "2026-08-20",
        timezone: "America/New_York",
        port: 4816,
        host: "127.0.0.1",
        updatedAt: "2026-08-14T12:00:00.000Z",
        facts: {
          localDate: "2026-08-14",
          pendingInboxCount: 2,
          openIssueCount: 3,
          lastIngestAt: "2026-08-14T10:00:00.000Z",
          lastIngestResult: "ingested\ncleanly",
          lastLintAt: "2026-08-14T11:00:00.000Z",
          lastLintResult: "failed\u0007 safely",
          recentChanges: Array.from({ length: 7 }, (_, index) => `change-${index + 1}`),
          git: {
            branch: "release\nbranch",
            clean: false,
            ahead: 1,
            behind: 2,
            diverged: true,
            upstream: "origin/release",
          },
        },
      },
      workflows: [
        {
          requestId: "active",
          kind: "extract",
          status: "running",
          startedAt: "2026-08-14T12:00:00.000Z",
          progress: 0.5,
          message: "preparing\nbook.pdf",
        },
        ...Array.from({ length: 7 }, (_, index) => ({
          requestId: `recent-${index}`,
          kind: "lint",
          status: "succeeded",
          finishedAt: `2026-08-14T0${index}:00:00.000Z`,
          progress: 1,
          message: `lint-${index + 1}`,
        })),
      ],
    };
    fixture.app.status = async () => status;

    const structured = (await invoke(fixture.tools, "scholar_status", {}, fixture.root)) as {
      readonly content: readonly { readonly text: string }[];
      readonly details: unknown;
    };
    assert.deepEqual(structured.details, status);
    assert.equal(structured.content[0]?.text, JSON.stringify(status));

    const notifications: string[] = [];
    const handler = commands.get("scholar-status");
    if (!handler) throw new Error("scholar-status command was not registered");
    await handler("", {
      cwd: fixture.root,
      signal: undefined,
      ui: { notify: (message: string) => notifications.push(message) },
    });

    assert.equal(notifications.length, 1);
    const [notification] = notifications;
    assert.doesNotMatch(notification!, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    assert.match(notification!, /^Pi Scholar: degraded\nVersion: 1\.2\.3 candidate\nVault: vault id\nDoctor: fail/mu);
    assert.match(notification!, /Date: 2026-08-14 \(America\/New_York\)/u);
    assert.match(notification!, /Simulated date: 2026-08-20/u);
    assert.match(notification!, /Maintenance: enabled/u);
    assert.match(notification!, /Inbox: 2 pending\nIssues: 3 open/u);
    assert.match(notification!, /Git: release branch, dirty, upstream origin\/release, 1 ahead, 2 behind, diverged/u);
    assert.match(notification!, /Recent changes: 7[\s\S]*change-5[\s\S]*… 2 more/u);
    assert.match(notification!, /Active workflows: 1\n {2}- extract running — preparing book\.pdf/u);
    assert.match(notification!, /Recent workflows: 7[\s\S]*lint-5[\s\S]*… 2 more/u);
    assert.doesNotMatch(notification!, /change-6|lint-6/u);
    assert.doesNotMatch(notification!, /\bdue\b/iu);

    fixture.app.status = async () => ({
      ...status,
      settings: {
        ...status.settings,
        facts: {
          ...status.settings.facts,
          git: {
            clean: false,
            ahead: 0,
            behind: 0,
            diverged: false,
            message: "Git state\nunavailable",
          },
        },
      },
    });
    await handler("", {
      cwd: fixture.root,
      signal: undefined,
      ui: { notify: (message: string) => notifications.push(message) },
    });
    assert.match(notifications[1]!, /Git: unavailable — Git state unavailable/u);
  });

  it("prompts and expands the bundled lint skill without command metadata", async () => {
    const handlers = new Map<string, CommandHandler>();
    const messages: string[] = [];
    const order: string[] = [];
    const prompts: Array<string | undefined> = ["  whole wiki  ", undefined];
    const skillPath = join(repositoryRoot, "skills", "lint", "SKILL.md");
    const baseDir = dirname(skillPath);
    const pi = {
      registerTool: () => undefined,
      registerCommand: (name: string, command: { readonly handler: CommandHandler }) => {
        handlers.set(name, command.handler);
      },
      getCommands: () => [{ name: "skill:lint", source: "skill" }],
      sendUserMessage: (message: string) => {
        order.push("send");
        messages.push(message);
      },
      on: () => undefined,
    } as unknown as ExtensionAPI;
    piScholarExtension(pi);
    const handler = handlers.get("scholar-lint");
    if (!handler) throw new Error("scholar-lint command was not registered");
    const context = {
      hasUI: true,
      ui: {
        input: async () => prompts.shift(),
        notify: () => undefined,
      },
      waitForIdle: async () => order.push("idle"),
    };
    await handler("  repair broken references  ", context);
    await handler("   ", context);
    await handler("", context);
    const body = stripFrontmatter(readFileSync(skillPath, "utf8")).trim();
    const skillBlock = `<skill name="lint" location="${skillPath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
    assert.deepEqual(messages, [`${skillBlock}\n\nrepair broken references`, `${skillBlock}\n\nwhole wiki`]);
    assert.deepEqual(order, ["idle", "send", "idle", "send"]);
    assert.equal(
      messages.some((message) => message.includes("/skill:lint")),
      false,
    );
  });
  it("controls maintenance mode through scholar-maintenance on and off", async () => {
    const commands = new Map<string, CommandHandler>();
    const fixture = fakeLifecycleApp({}, async () => ({}), undefined, commands);
    const notifications: string[] = [];
    const handler = commands.get("scholar-maintenance");
    if (!handler) throw new Error("scholar-maintenance command was not registered");
    const context = {
      cwd: fixture.root,
      signal: undefined,
      ui: { notify: (message: string) => notifications.push(message) },
    };

    await handler("", context);
    await handler("invalid", context);
    assert.deepEqual(fixture.app.updates, []);
    await handler(" on ", context);
    await handler(" off ", context);
    assert.deepEqual(fixture.app.updates, [{ maintenanceEnabled: true }, { maintenanceEnabled: false }]);
    assert.deepEqual(notifications, [
      "Usage: /scholar-maintenance on|off",
      "Usage: /scholar-maintenance on|off",
      "Maintenance mode enabled; daily quiz publishing is paused",
      "Maintenance mode disabled; daily quiz publishing is enabled",
    ]);
  });
  it("keeps the daily publish action available after context and evidence reads", async () => {
    const calls: string[] = [];
    const fixture = fakeLifecycleApp({ maintenanceEnabled: false }, async () => ({}));
    fixture.app.getQuizContext = async () => {
      calls.push("context");
      return {
        date: "2026-08-10",
        maintenanceEnabled: false,
        expiredCount: 0,
        candidates: [
          {
            pageId: "page-a",
            path: "page-a.md",
            title: "Page A",
            description: "Page A description.",
            dueAt: "2026-08-10T00:00:00.000Z",
          },
        ],
      };
    };
    fixture.app.getQuizEvidence = async (input) => {
      calls.push(`evidence:${JSON.stringify(input)}`);
      return [{ reference: "ref-a" }];
    };
    fixture.app.publishQuiz = async () => {
      calls.push("publish");
      return { status: "published" };
    };

    await invoke(fixture.tools, "scholar_get_daily_context", { date: "2026-08-10" }, fixture.root);
    await invoke(
      fixture.tools,
      "scholar_get_daily_evidence",
      { date: "2026-08-10", pageIds: ["page-a"] },
      fixture.root,
    );
    await invoke(
      fixture.tools,
      "scholar_get_daily_evidence",
      { date: "2026-08-10", pageIds: ["page-a"] },
      fixture.root,
    );
    await invoke(
      fixture.tools,
      "scholar_publish_daily",
      {
        status: "published",
        date: "2026-08-10",
        questions: [
          {
            kind: "free-response",
            prompt: "Explain page A",
            pages: [{ pageId: "page-a", criterion: "Explain", weight: 1 }],
            sourceRefs: ["ref-a"],
          },
        ],
      },
      fixture.root,
    );
    assert.deepEqual(calls, [
      "context",
      'evidence:{"date":"2026-08-10","pageIds":["page-a"]}',
      'evidence:{"date":"2026-08-10","pageIds":["page-a"]}',
      "publish",
    ]);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["succeeded"],
    );
    await assert.rejects(
      invoke(
        fixture.tools,
        "scholar_publish_daily",
        { status: "skipped", date: "2026-08-10", reason: "none" },
        fixture.root,
      ),
      /daily context is required/u,
    );
  });

  it("accepts developer tools only for serve", () => {
    assert.deepEqual(parseCliArgs(["serve", "--dev-tools"]), {
      command: "serve",
      positional: [],
      developerTools: true,
    });
    assert.deepEqual(parseCliArgs(["serve"]), { command: "serve", positional: [] });
    for (const command of ["init", "doctor", "sync"] as const)
      assert.throws(() => parseCliArgs([command, "--dev-tools"]), /--dev-tools is only valid for serve/u);
  });

  it("has no runner, weekday planner, or child-process orchestration", () => {
    assert.equal(existsSync(join(repositoryRoot, "src", "pi-runner.ts")), false);
    const cli = readFileSync(join(repositoryRoot, "src", "cli.ts"), "utf8");
    const extension = readFileSync(join(repositoryRoot, "pi", "extension.ts"), "utf8");
    assert.throws(() => parseCliArgs(["run", "scheduled"]), /Usage:/);
    assert.match(cli, /command: "init" \| "doctor" \| "serve" \| "sync"/u);
    assert.doesNotMatch(cli, /runScheduled|planScheduledRun|tryAcquireRunGuard|child_process|spawn\(/u);
    assert.doesNotMatch(extension, /child_process|spawn\(|execFile\(|node:child_process/u);
    assert.doesNotMatch(extension, /\.\.\/src\/(application|vault)\.js/u);
    assert.doesNotMatch(extension, /kind:\s*"document"\s*\}/u);
    assert.doesNotMatch(extension, /WEEKDAY|weekday|Monday|Sunday|scheduled/u);
  });

  it("does not let duplicate extraction publication attempts consume claims", async () => {
    const first = claim("claim-first", "prepared-first");
    const second = claim("claim-second", "prepared-second");
    const third = claim("claim-third", "prepared-third");
    const fixture = fakeLifecycleApp({ claims: [first, second, third] }, async (input) => {
      const claimId = (input as { readonly claimId: string }).claimId;
      if (claimId === second.claimId) throw new Error("publication failed");
      return { sourceId: claimId, manifest: {}, removedInbox: true };
    });
    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    const publish = (value: Record<string, string>) =>
      invoke(fixture.tools, "scholar_publish_extraction", { ...value, endpoints: [1] }, fixture.root);
    await publish(first);
    await publish(first);
    await assert.rejects(publish(second), /publication failed/u);
    await assert.rejects(publish(second), /publication failed/u);
    await publish(third);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["failed"],
    );
  });

  it("continues an agent that stops before its extraction batch is complete", async () => {
    const first = claim("claim-continue-first", "prepared-continue-first");
    const second = claim("claim-continue-second", "prepared-continue-second");
    const fixture = fakeLifecycleApp({ claims: [first, second] }, async (input) => ({
      sourceId: (input as { readonly claimId: string }).claimId,
      manifest: {},
      removedInbox: true,
    }));
    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    await invoke(fixture.tools, "scholar_publish_extraction", { ...first, endpoints: [1] }, fixture.root);
    await fixture.endAgent();
    assert.deepEqual(fixture.followUps, [
      "Continue the current extract batch: 1 claimed source(s) still require a scholar_publish_extraction attempt. Do not summarize or stop until every claim has been attempted.",
    ]);
    assert.deepEqual(fixture.app.finishes, []);

    await invoke(fixture.tools, "scholar_publish_extraction", { ...second, endpoints: [1] }, fixture.root);
    await fixture.endAgent();
    assert.equal(fixture.followUps.length, 1);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["succeeded"],
    );
  });

  it("passes thrown extraction diagnostics to workflow finalization", async () => {
    const fixture = fakeLifecycleApp({}, async () => ({ sourceId: "unused", manifest: {}, removedInbox: false }));
    fixture.app.getExtractContext = async () => {
      throw new Error("local extraction diagnostic");
    };
    await assert.rejects(
      invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root),
      /local extraction diagnostic/u,
    );
    assert.deepEqual(fixture.app.finishes, [
      {
        requestId: `extract-${fixture.root}`,
        status: "failed",
        options: { errorCode: "PI_WORKFLOW_FAILED", errorMessage: "local extraction diagnostic" },
      },
    ]);
  });

  it("forwards exact source filters and structured extraction progress", async () => {
    const fixture = fakeLifecycleApp({ claims: [] }, async () => ({}));
    const extractInputs: unknown[] = [];
    const ingestInputs: unknown[] = [];
    const updates: ToolUpdate[] = [];
    const progressEvent = {
      entry: 2,
      total: 3,
      filename: "delayed.pdf",
      phase: "docling",
    };
    fixture.app.getExtractContext = async (input, observer) => {
      extractInputs.push(input);
      await observer?.(progressEvent);
      return { claims: [] };
    };
    fixture.app.getIngestContext = async (input) => {
      ingestInputs.push(input);
      return { packets: [] };
    };

    await invoke(
      fixture.tools,
      "scholar_get_extract_context",
      { pendingSourceIds: ["pending-first", "pending-third"] },
      fixture.root,
      undefined,
      (update) => updates.push(update),
    );
    const ingest = (await invoke(
      fixture.tools,
      "scholar_get_ingest_context",
      { sourceIds: ["source-third", "source-first"] },
      fixture.root,
    )) as { readonly details: unknown };

    assert.deepEqual(extractInputs, [{ pendingSourceIds: ["pending-first", "pending-third"] }]);
    assert.deepEqual(ingestInputs, [{ sourceIds: ["source-third", "source-first"] }]);
    assert.ok(
      updates.some(
        (update) => update.details === progressEvent && update.content[0]?.text === "2/3 delayed.pdf: docling",
      ),
    );
    assert.deepEqual(ingest.details, {
      packets: [],
      workflowRequestId: `ingest-${fixture.root}`,
    });
    await invoke(fixture.tools, "scholar_finish_ingest", {}, fixture.root);
  });
  it("replays extraction after applied and unapplied initial progress failures", async () => {
    for (const applied of [false, true]) {
      const only = claim(`claim-context-update-${applied}`, `prepared-context-update-${applied}`);
      const context = { claims: [only] };
      const fixture = fakeLifecycleApp(context, async (input) => ({
        sourceId: (input as { readonly claimId: string }).claimId,
        manifest: {},
        removedInbox: true,
      }));
      const update = fixture.app.updateWorkflow.bind(fixture.app);
      let failUpdate = true;
      fixture.app.updateWorkflow = async (requestId, options) => {
        if (failUpdate) {
          failUpdate = false;
          const error = new Error("injected context update failure");
          if (applied) Object.assign(error, { details: { applied: true } });
          throw error;
        }
        return update(requestId, options);
      };
      await assert.rejects(
        invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root),
        /injected context update failure/u,
      );
      assert.deepEqual(fixture.app.finishes, []);
      const replay = (await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root)) as {
        readonly details: unknown;
      };
      assert.deepEqual(replay.details, context);
      await invoke(fixture.tools, "scholar_publish_extraction", { ...only, endpoints: [1] }, fixture.root);
      assert.deepEqual(
        fixture.app.finishes.map(({ status }) => status),
        ["succeeded"],
      );
    }
  });
  it("replays ingest, lint, and daily contexts after applied and unapplied progress failures", async () => {
    for (const applied of [false, true]) {
      for (const kind of ["ingest", "lint", "daily"] as const) {
        const context =
          kind === "daily" ? { date: "2026-08-10", maintenanceEnabled: false, marker: kind } : { marker: kind };
        const fixture = fakeLifecycleApp(context, async () => ({}));
        const contextTool = `scholar_get_${kind}_context`;
        const finishTool =
          kind === "ingest" ? "scholar_finish_ingest" : kind === "lint" ? "scholar_finish_lint" : undefined;
        if (kind === "ingest") fixture.app.getIngestContext = async () => context;
        if (kind === "lint") fixture.app.getLintContext = async () => context;
        if (kind === "daily") fixture.app.getQuizContext = async () => context;
        const update = fixture.app.updateWorkflow.bind(fixture.app);
        let failUpdate = true;
        fixture.app.updateWorkflow = async (requestId, options) => {
          if (failUpdate) {
            failUpdate = false;
            const error = new Error("injected context update failure");
            if (applied) Object.assign(error, { details: { applied: true } });
            throw error;
          }
          return update(requestId, options);
        };

        await assert.rejects(invoke(fixture.tools, contextTool, {}, fixture.root), /injected context update failure/u);
        const replay = (await invoke(fixture.tools, contextTool, {}, fixture.root)) as { readonly details: unknown };
        assert.deepEqual(
          replay.details,
          kind === "ingest" ? { ...context, workflowRequestId: `ingest-${fixture.root}` } : context,
        );
        await assert.rejects(invoke(fixture.tools, contextTool, {}, fixture.root), /workflow is already running/u);

        if (finishTool) {
          await invoke(fixture.tools, finishTool, {}, fixture.root);
          await assert.rejects(invoke(fixture.tools, finishTool, {}, fixture.root), /context is required/u);
        } else {
          await invoke(
            fixture.tools,
            "scholar_publish_daily",
            { status: "skipped", date: "2026-08-10", reason: "maintenance disabled" },
            fixture.root,
          );
          await assert.rejects(
            invoke(
              fixture.tools,
              "scholar_publish_daily",
              { status: "skipped", date: "2026-08-10", reason: "maintenance disabled" },
              fixture.root,
            ),
            /context is required/u,
          );
        }
        assert.deepEqual(
          fixture.app.finishes.map(({ status }) => status),
          ["succeeded"],
        );
      }
    }
  });
  it("does not replay stale context after a direct successful wiki change", async () => {
    for (const kind of ["ingest", "lint"] as const) {
      const context = { marker: kind };
      const fixture = fakeLifecycleApp(context, async () => ({}));
      if (kind === "ingest") fixture.app.getIngestContext = async () => context;
      else fixture.app.getLintContext = async () => context;
      const update = fixture.app.updateWorkflow.bind(fixture.app);
      let failUpdate = true;
      fixture.app.updateWorkflow = async (requestId, options) => {
        if (failUpdate) {
          failUpdate = false;
          throw new Error("injected context update failure");
        }
        return update(requestId, options);
      };

      await assert.rejects(
        invoke(fixture.tools, `scholar_get_${kind}_context`, {}, fixture.root),
        /injected context update failure/u,
      );
      await invoke(
        fixture.tools,
        `scholar_apply_${kind}`,
        kind === "ingest" ? { workflowRequestId: `ingest-${fixture.root}`, change: {} } : {},
        fixture.root,
      );
      await assert.rejects(
        invoke(fixture.tools, `scholar_get_${kind}_context`, {}, fixture.root),
        /workflow is already running/u,
      );
      await invoke(fixture.tools, `scholar_finish_${kind}`, {}, fixture.root);
    }
  });
  it("returns exact ingest and lint results without an apply-time workflow update", async () => {
    for (const kind of ["ingest", "lint"] as const) {
      const context = { marker: `${kind}-context` };
      const result = { kind: "create-page" as const };
      const fixture = fakeLifecycleApp(context, async () => ({}));
      let operationCalls = 0;
      if (kind === "ingest") {
        fixture.app.getIngestContext = async () => context;
        fixture.app.applyIngestChange = async () => {
          operationCalls += 1;
          return result;
        };
      } else {
        fixture.app.getLintContext = async () => context;
        fixture.app.applyWikiChange = async () => {
          operationCalls += 1;
          return result;
        };
      }

      const loaded = (await invoke(fixture.tools, `scholar_get_${kind}_context`, {}, fixture.root)) as {
        readonly details: unknown;
      };
      assert.deepEqual(
        loaded.details,
        kind === "ingest" ? { ...context, workflowRequestId: `ingest-${fixture.root}` } : context,
      );
      fixture.app.updateWorkflow = async () => {
        throw new Error("unexpected apply progress write");
      };
      if (kind === "ingest") {
        await assert.rejects(
          invoke(
            fixture.tools,
            "scholar_apply_ingest",
            { workflowRequestId: "wrong-workflow", change: {} },
            fixture.root,
          ),
          /does not match the current context/u,
        );
        assert.equal(operationCalls, 0);
      }
      const applied = (await invoke(
        fixture.tools,
        `scholar_apply_${kind}`,
        kind === "ingest" ? { workflowRequestId: `ingest-${fixture.root}`, change: {} } : {},
        fixture.root,
      )) as {
        readonly details: unknown;
      };
      assert.strictEqual(applied.details, result);
      assert.equal(operationCalls, 1);
      await invoke(fixture.tools, `scholar_finish_${kind}`, {}, fixture.root);
      assert.deepEqual(
        fixture.app.finishes.map(({ status }) => status),
        ["succeeded"],
      );
    }
  });

  it("rejects ingest apply outside the parent-owned context", async () => {
    const fixture = fakeLifecycleApp({}, async () => ({}));
    let applyCalls = 0;
    fixture.app.applyIngestChange = async () => {
      applyCalls += 1;
      return {};
    };

    await assert.rejects(
      invoke(
        fixture.tools,
        "scholar_apply_ingest",
        { workflowRequestId: "parent-ingest", change: { kind: "create-page" } },
        fixture.root,
      ),
      /ingest context is required before applying/u,
    );
    assert.equal(applyCalls, 0);
    assert.deepEqual(fixture.app.order, []);
  });

  it("replays exact daily maintenance context after applied and unapplied automatic finish failures", async () => {
    for (const applied of [false, true]) {
      const context = { date: "2026-08-10", maintenanceEnabled: true, expiredCount: 1 };
      const fixture = fakeLifecycleApp(context, async () => ({}));
      let contextCalls = 0;
      fixture.app.getQuizContext = async () => ({ ...context, expiredCount: ++contextCalls });
      const finish = fixture.app.finishWorkflow.bind(fixture.app);
      let failFinish = true;
      fixture.app.finishWorkflow = async (requestId, status, options) => {
        if (failFinish) {
          failFinish = false;
          const error = new Error("injected daily automatic finish failure");
          if (applied) Object.assign(error, { details: { applied: true } });
          throw error;
        }
        return finish(requestId, status, options);
      };

      await assert.rejects(
        invoke(fixture.tools, "scholar_get_daily_context", { date: "2026-08-10" }, fixture.root),
        /injected daily automatic finish failure/u,
      );
      const replay = (await invoke(
        fixture.tools,
        "scholar_get_daily_context",
        { date: "2026-08-10" },
        fixture.root,
      )) as {
        readonly details: unknown;
      };
      assert.deepEqual(replay.details, context);
      assert.equal(contextCalls, 1);
      assert.deepEqual(
        fixture.app.finishes.map(({ status }) => status),
        applied ? [] : ["succeeded"],
      );
      await assert.rejects(
        invoke(
          fixture.tools,
          "scholar_publish_daily",
          { status: "skipped", date: "2026-08-10", reason: "maintenance disabled" },
          fixture.root,
        ),
        /context is required/u,
      );
    }
  });

  it("retries an applied extraction publication failure with the identical input", async () => {
    const only = claim("claim-applied-publication", "prepared-applied-publication");
    const publication = { sourceId: only.claimId, manifest: {}, removedInbox: true };
    let publicationCalls = 0;
    const fixture = fakeLifecycleApp({ claims: [only] }, async () => {
      publicationCalls += 1;
      if (publicationCalls === 1)
        throw Object.assign(new Error("applied publication finalization failure"), {
          publicationApplied: true,
          details: { applied: true },
        });
      return publication;
    });
    const input = { ...only, endpoints: [1] };

    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    await assert.rejects(
      invoke(fixture.tools, "scholar_publish_extraction", input, fixture.root),
      /applied publication finalization failure/u,
    );
    assert.deepEqual(fixture.app.finishes, []);
    await fixture.endAgent();
    assert.deepEqual(fixture.followUps, []);
    const retry = (await invoke(fixture.tools, "scholar_publish_extraction", input, fixture.root)) as {
      readonly details: unknown;
    };
    assert.strictEqual(retry.details, publication);
    assert.equal(publicationCalls, 2);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["succeeded"],
    );
  });

  it("does not continue a fully attempted batch after applied publication failures", async () => {
    const claims = [
      claim("claim-applied-first", "prepared-applied-first"),
      claim("claim-applied-second", "prepared-applied-second"),
      claim("claim-applied-third", "prepared-applied-third"),
    ];
    const failed = new Set<string>();
    const fixture = fakeLifecycleApp({ claims }, async (input) => {
      const claimId = (input as { readonly claimId: string }).claimId;
      if (!failed.has(claimId)) {
        failed.add(claimId);
        throw Object.assign(new Error(`applied publication finalization failure: ${claimId}`), {
          publicationApplied: true,
          details: { applied: true },
        });
      }
      return { sourceId: claimId, manifest: {}, removedInbox: true };
    });

    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    for (const value of claims)
      await assert.rejects(
        invoke(fixture.tools, "scholar_publish_extraction", { ...value, endpoints: [1] }, fixture.root),
        /applied publication finalization failure/u,
      );
    await fixture.endAgent();
    assert.deepEqual(fixture.followUps, []);
    assert.deepEqual(fixture.app.finishes, []);

    await invoke(fixture.tools, "scholar_publish_extraction", { ...claims[0], endpoints: [1] }, fixture.root);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["succeeded"],
    );
  });

  it("counts applied failure-record finalization as a failed extraction attempt", async () => {
    const only = claim("claim-applied-failure-record", "prepared-applied-failure-record");
    const fixture = fakeLifecycleApp({ claims: [only] }, async () => {
      throw Object.assign(new Error("applied failure-record finalization failure"), { details: { applied: true } });
    });

    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    await assert.rejects(
      invoke(fixture.tools, "scholar_publish_extraction", { ...only, endpoints: [1] }, fixture.root),
      /applied failure-record finalization failure/u,
    );
    await fixture.endAgent();
    assert.deepEqual(fixture.followUps, []);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["failed"],
    );
  });

  it("retains a publication failure through later successful claims", async () => {
    const first = claim("claim-failing", "prepared-failing");
    const second = claim("claim-success", "prepared-success");
    const fixture = fakeLifecycleApp({ claims: [first, second] }, async (input) => {
      const claimId = (input as { readonly claimId: string }).claimId;
      if (claimId === first.claimId) throw new Error("publication failed");
      return { sourceId: claimId, manifest: {}, removedInbox: true };
    });
    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    await assert.rejects(
      invoke(fixture.tools, "scholar_publish_extraction", { ...first, endpoints: [1] }, fixture.root),
      /publication failed/u,
    );
    assert.deepEqual(fixture.app.finishes, []);
    await invoke(fixture.tools, "scholar_publish_extraction", { ...second, endpoints: [1] }, fixture.root);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["failed"],
    );
  });

  it("does not poison extraction success with a malformed duplicate", async () => {
    const first = claim("claim-duplicate", "prepared-duplicate");
    const second = claim("claim-after-duplicate", "prepared-after-duplicate");
    let firstAttempts = 0;
    const fixture = fakeLifecycleApp({ claims: [first, second] }, async (input) => {
      const claimId = (input as { readonly claimId: string }).claimId;
      if (claimId === first.claimId && ++firstAttempts === 2) throw new Error("malformed duplicate");
      return { sourceId: claimId, manifest: {}, removedInbox: true };
    });
    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    await invoke(fixture.tools, "scholar_publish_extraction", { ...first, endpoints: [1] }, fixture.root);
    await assert.rejects(
      invoke(fixture.tools, "scholar_publish_extraction", { ...first, endpoints: [1] }, fixture.root),
      /malformed duplicate/u,
    );
    await invoke(fixture.tools, "scholar_publish_extraction", { ...second, endpoints: [1] }, fixture.root);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["succeeded"],
    );
  });

  it("retries an extraction progress update without recording a publication failure", async () => {
    const first = claim("claim-update", "prepared-update");
    const second = claim("claim-after-update", "prepared-after-update");
    const fixture = fakeLifecycleApp({ claims: [first, second] }, async (input) => ({
      sourceId: (input as { readonly claimId: string }).claimId,
      manifest: {},
      removedInbox: true,
    }));
    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    const update = fixture.app.updateWorkflow.bind(fixture.app);
    let failUpdate = true;
    fixture.app.updateWorkflow = async (requestId, options) => {
      if (failUpdate) {
        failUpdate = false;
        throw new Error("injected update failure");
      }
      return update(requestId, options);
    };
    await assert.rejects(
      invoke(fixture.tools, "scholar_publish_extraction", { ...first, endpoints: [1] }, fixture.root),
      /injected update failure/u,
    );
    await invoke(fixture.tools, "scholar_publish_extraction", { ...first, endpoints: [1] }, fixture.root);
    await invoke(fixture.tools, "scholar_publish_extraction", { ...second, endpoints: [1] }, fixture.root);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["succeeded"],
    );
  });

  it("retries an unapplied extraction finish without issuing a failed finish", async () => {
    const only = claim("claim-finish", "prepared-finish");
    const fixture = fakeLifecycleApp({ claims: [only] }, async (input) => ({
      sourceId: (input as { readonly claimId: string }).claimId,
      manifest: {},
      removedInbox: true,
    }));
    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    const finish = fixture.app.finishWorkflow.bind(fixture.app);
    let failFinish = true;
    fixture.app.finishWorkflow = async (requestId, status, options) => {
      if (failFinish) {
        failFinish = false;
        throw Object.assign(new Error("injected finish failure"), { details: { applied: false } });
      }
      return finish(requestId, status, options);
    };
    await assert.rejects(
      invoke(fixture.tools, "scholar_publish_extraction", { ...only, endpoints: [1] }, fixture.root),
      /injected finish failure/u,
    );
    await invoke(fixture.tools, "scholar_publish_extraction", { ...only, endpoints: [1] }, fixture.root);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["succeeded"],
    );
  });

  it("deletes extract state after an applied finish error instead of double-finishing", async () => {
    const only = claim("claim-applied-finish", "prepared-applied-finish");
    const fixture = fakeLifecycleApp({ claims: [only] }, async (input) => ({
      sourceId: (input as { readonly claimId: string }).claimId,
      manifest: {},
      removedInbox: true,
    }));
    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    const finish = fixture.app.finishWorkflow.bind(fixture.app);
    let failFinish = true;
    fixture.app.finishWorkflow = async (requestId, status, options) => {
      if (failFinish) {
        failFinish = false;
        throw Object.assign(new Error("applied finish failure"), { details: { applied: true } });
      }
      return finish(requestId, status, options);
    };
    await assert.rejects(
      invoke(fixture.tools, "scholar_publish_extraction", { ...only, endpoints: [1] }, fixture.root),
      /applied finish failure/u,
    );
    await assert.rejects(
      invoke(fixture.tools, "scholar_publish_extraction", { ...only, endpoints: [1] }, fixture.root),
      /extract context is required/u,
    );
    assert.deepEqual(fixture.app.finishes, []);
  });

  it("replays an empty extract exactly after an applied automatic finish error", async () => {
    const context = { claims: [], failures: [{ message: "nothing extractable" }] };
    const fixture = fakeLifecycleApp(context, async () => ({
      sourceId: "unused",
      manifest: {},
      removedInbox: false,
    }));
    let contextCalls = 0;
    fixture.app.getExtractContext = async () => {
      contextCalls++;
      return context;
    };
    let failFinish = true;
    fixture.app.finishWorkflow = async () => {
      if (failFinish) {
        failFinish = false;
        throw Object.assign(new Error("applied empty finish failure"), { details: { applied: true } });
      }
      return {};
    };
    await assert.rejects(
      invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root),
      /applied empty finish failure/u,
    );
    const replay = (await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root)) as {
      readonly details: unknown;
    };
    assert.strictEqual(replay.details, context);
    assert.equal(contextCalls, 1);
  });

  it("does not issue a failed finish after an applied lint finish error", async () => {
    const fixture = fakeLifecycleApp({}, async () => ({}));
    await invoke(fixture.tools, "scholar_get_lint_context", {}, fixture.root);
    const finish = fixture.app.finishWorkflow.bind(fixture.app);
    let failFinish = true;
    fixture.app.finishWorkflow = async (requestId, status, options) => {
      if (failFinish) {
        failFinish = false;
        throw Object.assign(new Error("applied lint finish failure"), { details: { applied: true } });
      }
      return finish(requestId, status, options);
    };
    await assert.rejects(
      invoke(fixture.tools, "scholar_finish_lint", {}, fixture.root),
      /applied lint finish failure/u,
    );
    await assert.rejects(invoke(fixture.tools, "scholar_finish_lint", {}, fixture.root), /lint context is required/u);
    assert.deepEqual(fixture.app.finishes, []);
  });
  it("tracks bounded workflow lifecycle state transactionally", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-lifecycle-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const workflows = new WorkflowCoordinator(db);
      const started = workflows.beginWorkflow("sync", "sync-test");
      assert.match(started.requestId, /^[0-9a-f-]{36}$/iu);
      assert.equal(started.status, "running");
      assert.equal(started.progress, 0);
      assert.equal(db.transactionDepth, 0);

      const retried = workflows.beginWorkflow("sync", "sync-test");
      assert.equal(retried.requestId, started.requestId);
      assert.equal(db.all("SELECT request_id FROM workflows WHERE idempotency_key = ?", ["sync-test"]).length, 1);

      const updated = workflows.updateWorkflow(started.requestId, { progress: 0.5, message: "🙂".repeat(200) });
      assert.equal(updated.progress, 0.5);
      assert.ok(Buffer.byteLength(updated.message ?? "", "utf8") <= 500);

      const succeeded = workflows.finishWorkflow(started.requestId, "succeeded", { message: "done" });
      assert.equal(succeeded.status, "succeeded");
      assert.equal(succeeded.progress, 1);
      assert.equal(succeeded.message, "done");
      assert.ok(succeeded.finishedAt);
      assert.throws(() => workflows.updateWorkflow(started.requestId, { progress: 0.75 }), /not running/u);

      const diagnostic = `SQLite busy while committing workflow: ${"é".repeat(400)}`;
      const failed = workflows.beginWorkflow("lint");
      const failure = workflows.finishWorkflow(failed.requestId, "failed", {
        errorCode: "E".repeat(120),
        errorMessage: diagnostic,
      });
      assert.equal(failure.status, "failed");
      assert.ok(Buffer.byteLength(failure.errorCode ?? "", "utf8") <= 100);
      assert.equal(failure.errorMessage, `SQLite busy while committing workflow: ${"é".repeat(230)}`);
      assert.ok(Buffer.byteLength(failure.errorMessage ?? "", "utf8") <= 500);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails only running workflows during session recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-recovery-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const workflows = new WorkflowCoordinator(db);
      const sync = workflows.beginWorkflow("sync", "recover-sync");
      const updatedSync = workflows.updateWorkflow(sync.requestId, { progress: 0.5 });
      const grader = workflows.beginWorkflow("quiz-grader", "recover-grader");
      workflows.updateWorkflow(grader.requestId, { message: "private owner binding" });
      const queuedId = "00000000-0000-4000-8000-000000000001";
      workflows.queueInTransaction("quiz-grader", queuedId, "queued-grader");
      const completed = workflows.beginWorkflow("daily", "completed-daily");
      workflows.finishWorkflow(completed.requestId, "succeeded");

      const recovered = workflows.failRunningWorkflows({
        message: "Workflow interrupted",
        errorCode: "PI_SESSION_INTERRUPTED",
        errorMessage: "The previous Pi session ended before completing this workflow.",
      });

      assert.deepEqual(
        recovered.map(({ requestId }) => requestId),
        [sync.requestId, grader.requestId],
      );
      assert.equal(recovered[0]?.progress, 0.5);
      assert.equal(recovered[0]?.startedAt, updatedSync.startedAt);
      for (const workflow of recovered) {
        assert.equal(workflow.status, "failed");
        assert.equal(workflow.message, "Workflow interrupted");
        assert.equal(workflow.errorCode, "PI_SESSION_INTERRUPTED");
        assert.equal(workflow.errorMessage, "The previous Pi session ended before completing this workflow.");
        assert.ok(workflow.finishedAt);
      }
      assert.equal(workflows.get(queuedId)?.status, "queued");
      assert.equal(workflows.get(completed.requestId)?.status, "succeeded");
      assert.deepEqual(workflows.failRunningWorkflows({}), []);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
