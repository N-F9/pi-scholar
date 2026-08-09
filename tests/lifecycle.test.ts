import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { parseCliArgs } from "../src/cli.js";
import { WorkflowCoordinator } from "../src/workflows.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piScholarExtension from "../pi/extension.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function packageManifest(): { readonly pi: { readonly extensions: readonly string[]; readonly skills: readonly string[] } } {
  return JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    readonly pi: { readonly extensions: readonly string[]; readonly skills: readonly string[] };
  };
}

describe("Pi package lifecycle", () => {
  it("ships one extension and exactly four declared skills", () => {
    const manifest = packageManifest();
    assert.deepEqual(manifest.pi.extensions, ["./pi/extension.ts"]);
    assert.equal(manifest.pi.skills.length, 4);
    assert.deepEqual(
      [...manifest.pi.skills].sort(),
      [
        "./skills/daily-quiz",
        "./skills/quiz-grader",
        "./skills/source-admission",
        "./skills/wiki-maintenance",
      ],
    );
    for (const skill of manifest.pi.skills) {
      assert.equal(readFileSync(join(repositoryRoot, skill, "SKILL.md"), "utf8").includes("name:"), true);
    }
    assert.deepEqual(readdirSync(join(repositoryRoot, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), ["daily-quiz", "quiz-grader", "source-admission", "wiki-maintenance"]);
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
      "scholar_admit_source",
      "scholar_apply_maintenance",
      "scholar_finish_maintenance",
      "scholar_get_admission_context",
      "scholar_get_grading_context",
      "scholar_get_maintenance_context",
      "scholar_get_quiz_context",
      "scholar_note",
      "scholar_publish_quiz",
      "scholar_remove_source",
      "scholar_search",
      "scholar_settle_grade",
      "scholar_status",
    ]);
    assert.deepEqual([...toolModes].filter(([, mode]) => mode === "sequential").map(([name]) => name).sort(), [
      "scholar_add",
      "scholar_admit_source",
      "scholar_apply_maintenance",
      "scholar_finish_maintenance",
      "scholar_get_admission_context",
      "scholar_get_grading_context",
      "scholar_get_maintenance_context",
      "scholar_get_quiz_context",
      "scholar_note",
      "scholar_publish_quiz",
      "scholar_remove_source",
      "scholar_settle_grade",
    ]);
    assert.equal(toolModes.get("scholar_search"), undefined);
    assert.equal(toolModes.get("scholar_status"), undefined);
    assert.deepEqual([...commands].sort(), ["add", "issue", "scholar-status"]);
    assert.deepEqual(events, ["session_shutdown"]);
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

      const failed = workflows.beginWorkflow("wiki-maintenance");
      const failure = workflows.failWorkflow(failed.requestId, { errorCode: "E".repeat(120), errorMessage: "é".repeat(400) });
      assert.equal(failure.status, "failed");
      assert.ok(Buffer.byteLength(failure.errorCode ?? "", "utf8") <= 100);
      assert.ok(Buffer.byteLength(failure.errorMessage ?? "", "utf8") <= 500);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
