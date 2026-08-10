import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, it, vi } from "vitest";
import piScholarExtension from "../pi/extension.ts";
import { parseCliArgs } from "../src/cli.js";
import { openDatabase } from "../src/database.js";
import { WorkflowCoordinator } from "../src/workflows.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type ToolExecutor = (
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: { readonly cwd: string },
) => Promise<unknown>;
type FakeLifecycleApp = {
  readonly paths: { readonly vaultRoot: string };
  readonly finishes: { readonly status: string; readonly options: unknown }[];
  readonly updates: readonly unknown[];
  beginWorkflow: (kind: string) => Promise<{ readonly workflow: { readonly requestId: string } }>;
  getExtractContext: () => Promise<unknown>;
  getIngestContext: () => Promise<unknown>;
  getLintContext: () => Promise<unknown>;
  getQuizContext: () => Promise<unknown>;
  getQuizEvidence: (input: unknown) => Promise<unknown>;
  publishQuiz: (input: unknown) => Promise<unknown>;
  publishExtraction: (input: unknown) => Promise<unknown>;
  applyWikiChange: (input: unknown) => Promise<unknown>;
  applyIngestChange: (input: unknown) => Promise<unknown>;
  finishWorkflow: (requestId: string, status: string, options?: unknown) => Promise<unknown>;
  updateWorkflow: (requestId: string, options: unknown) => Promise<unknown>;
};

const runtimeApps = vi.hoisted(() => new Map<string, FakeLifecycleApp>());
vi.mock("../dist/application/application.js", () => ({
  createApplication: ({ paths }: { readonly paths: { readonly vaultRoot: string } }) => {
    const app = runtimeApps.get(paths.vaultRoot);
    if (!app) throw new Error(`missing fake app for ${paths.vaultRoot}`);
    return app;
  },
}));
vi.mock("../dist/vault.js", () => ({
  resolveVault: (cwd?: string) => ({ vaultRoot: cwd ?? "test-vault" }),
}));

let lifecycleTestNumber = 0;

function registerLifecycleTools(): Map<string, ToolExecutor> {
  const tools = new Map<string, ToolExecutor>();
  const pi = {
    registerTool: (tool: { readonly name: string; readonly execute: ToolExecutor }) => {
      tools.set(tool.name, tool.execute);
    },
    registerCommand: () => undefined,
    on: () => undefined,
  } as unknown as ExtensionAPI;
  piScholarExtension(pi);
  return tools;
}

function fakeLifecycleApp(
  context: unknown,
  publishExtraction: (input: unknown) => Promise<unknown>,
): { readonly app: FakeLifecycleApp; readonly root: string; readonly tools: Map<string, ToolExecutor> } {
  const root = `lifecycle-test-${++lifecycleTestNumber}`;
  const finishes: { status: string; options: unknown }[] = [];
  const updates: unknown[] = [];
  const app: FakeLifecycleApp = {
    paths: { vaultRoot: root },
    finishes,
    updates,
    beginWorkflow: async (kind) => ({ workflow: { requestId: `${kind}-${root}` } }),
    getExtractContext: async () => context,
    getIngestContext: async () => ({}),
    getLintContext: async () => ({}),
    getQuizContext: async () => context,
    getQuizEvidence: async () => [],
    publishQuiz: async () => ({}),
    publishExtraction,
    applyWikiChange: async () => ({}),
    applyIngestChange: async () => ({}),
    finishWorkflow: async (_requestId, status, options) => {
      finishes.push({ status, options });
      return {};
    },
    updateWorkflow: async (_requestId, options) => {
      updates.push(options);
      return {};
    },
  };
  runtimeApps.set(root, app);
  return { app, root, tools: registerLifecycleTools() };
}

async function invoke(tools: Map<string, ToolExecutor>, name: string, params: unknown, root: string): Promise<unknown> {
  const execute = tools.get(name);
  if (!execute) throw new Error(`missing tool ${name}`);
  return execute(name, params, undefined, undefined, { cwd: root });
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
    assert.deepEqual([...commands].sort(), ["scholar-add", "scholar-issue", "scholar-lint", "scholar-status"]);
    assert.deepEqual(events, ["session_shutdown"]);
  });

  it("expands the current-session lint skill before sending the command", async () => {
    type CommandHandler = (args: string, ctx: object) => Promise<void> | void;
    const handlers = new Map<string, CommandHandler>();
    const messages: string[] = [];
    const order: string[] = [];
    const skillPath = join(repositoryRoot, "skills", "lint", "SKILL.md");
    const baseDir = dirname(skillPath);
    const pi = {
      registerTool: () => undefined,
      registerCommand: (name: string, command: { readonly handler: CommandHandler }) => {
        handlers.set(name, command.handler);
      },
      getCommands: () => [
        {
          name: "skill:lint",
          source: "skill",
          sourceInfo: { path: skillPath, baseDir },
        },
      ],
      waitForIdle: async () => {
        order.push("idle");
      },
      sendUserMessage: (message: string) => {
        order.push("send");
        messages.push(message);
      },
      on: () => undefined,
    } as unknown as ExtensionAPI;
    piScholarExtension(pi);
    const handler = handlers.get("scholar-lint");
    if (!handler) throw new Error("scholar-lint command was not registered");
    const context = { waitForIdle: async () => order.push("idle") };
    await handler("  repair broken references  ", context);
    await handler("   ", context);
    const body = stripFrontmatter(readFileSync(skillPath, "utf8")).trim();
    const skillBlock = `<skill name="lint" location="${skillPath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
    assert.deepEqual(messages, [`${skillBlock}\n\nrepair broken references`, skillBlock]);
    assert.deepEqual(order, ["idle", "send", "idle", "send"]);
    assert.equal(
      messages.some((message) => message.includes("/skill:lint")),
      false,
    );
  });
  it("keeps the daily publish action available after context and evidence reads", async () => {
    const calls: string[] = [];
    const fixture = fakeLifecycleApp({ initializationEnabled: false }, async () => ({}));
    fixture.app.getQuizContext = async () => {
      calls.push("context");
      return {
        date: "2026-08-10",
        initializationEnabled: false,
        expiredCount: 0,
        candidates: [
          { pageId: "page-a", path: "page-a.md", title: "Page A", dueAt: "2026-08-10T00:00:00.000Z", sections: [] },
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

  it("finishes extraction failed when every preparation fails", async () => {
    const fixture = fakeLifecycleApp(
      {
        claims: [],
        failures: [{ relativePath: "broken.txt", errorCode: "EXTRACT_FAILED", errorMessage: "cannot prepare" }],
      },
      async () => ({ sourceId: "unused", manifest: {}, removedInbox: false }),
    );
    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["failed"],
    );
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

  it("does not fail an empty extract after an applied automatic finish error", async () => {
    const fixture = fakeLifecycleApp({ claims: [] }, async () => ({
      sourceId: "unused",
      manifest: {},
      removedInbox: false,
    }));
    const finish = fixture.app.finishWorkflow.bind(fixture.app);
    let failFinish = true;
    fixture.app.finishWorkflow = async (requestId, status, options) => {
      if (failFinish) {
        failFinish = false;
        throw Object.assign(new Error("applied empty finish failure"), { details: { applied: true } });
      }
      return finish(requestId, status, options);
    };
    await assert.rejects(
      invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root),
      /applied empty finish failure/u,
    );
    await invoke(fixture.tools, "scholar_get_extract_context", {}, fixture.root);
    assert.deepEqual(
      fixture.app.finishes.map(({ status }) => status),
      ["succeeded"],
    );
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

      const failed = workflows.beginWorkflow("lint");
      const failure = workflows.failWorkflow(failed.requestId, {
        errorCode: "E".repeat(120),
        errorMessage: "é".repeat(400),
      });
      assert.equal(failure.status, "failed");
      assert.ok(Buffer.byteLength(failure.errorCode ?? "", "utf8") <= 100);
      assert.ok(Buffer.byteLength(failure.errorMessage ?? "", "utf8") <= 500);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
