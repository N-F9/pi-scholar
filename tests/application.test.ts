import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, it } from "vitest";
import { ScholarApplication } from "../src/application/application.js";
import { decodeExtractPublicationInput } from "../src/application/decoders.js";
import { publicSource, publicWorkflow } from "../src/application/projections.js";
import type { GradingContext } from "../src/contracts.js";
import { openDatabase } from "../src/database.js";
import { doctor } from "../src/doctor.js";
import { gitStatus, localCheckpointCommit } from "../src/external/git.js";
import { QuizService } from "../src/quiz.js";
import { localDate, SchedulerService } from "../src/scheduler.js";
import { acquireWriterLock, initVault, LockBusyError } from "../src/vault.js";
import { parseWikiMarkdown, WikiService } from "../src/wiki.js";

it("redacts persisted source and workflow diagnostics from public projections", () => {
  const source = publicSource({
    sourceId: "source",
    kind: "text",
    status: "failed",
    displayName: "source",
    errorCode: "EXTRACT_FAILED",
    errorMessage: "/home/alice/private",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const workflow = publicWorkflow({
    requestId: "1c4a9f7f-6c19-4b86-9bf8-6d2af3a4e0c2",
    kind: "ingest",
    status: "failed",
    progress: 0,
    errorCode: "INGEST_FAILED",
    errorMessage: "/home/alice/private",
  });
  assert.equal("errorMessage" in source, false);
  assert.equal("errorMessage" in workflow, false);
});
it("requires non-empty extraction line endpoints", () => {
  const base = { claimId: "claim", preparedId: "prepared", digest: "digest" };
  for (const endpoints of [undefined, [], [0], ["1"]]) {
    assert.throws(
      () => decodeExtractPublicationInput({ ...base, ...(endpoints === undefined ? {} : { endpoints }) }),
      /endpoints must be a non-empty array/u,
    );
  }
  assert.deepEqual(decodeExtractPublicationInput({ ...base, endpoints: [2, 4] }).endpoints, [2, 4]);
});

type DurableApplication = ScholarApplication & {
  durableDirect<T>(operation: () => T | PromiseLike<T>, subject: string): Promise<T>;
};

function durable(
  app: ScholarApplication,
  operation: () => unknown | PromiseLike<unknown>,
  subject: string,
): Promise<unknown> {
  return (app as unknown as DurableApplication).durableDirect(operation, subject);
}

function fixture(options: { readonly maintenance?: boolean; readonly realDoctor?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-scholar-durable-"));
  const paths = initVault(join(root, "vault"));
  const db = openDatabase(paths);
  const calls: string[] = [];
  const wiki = new WikiService(
    db,
    paths,
    options.maintenance ? { qmd: { search: () => [], index: async () => undefined } } : undefined,
  );
  const scheduler = new SchedulerService(db, paths);
  const quiz = new QuizService(db, paths, scheduler);
  const app = new ScholarApplication({
    wikiService: wiki,
    schedulerService: scheduler,
    quizService: quiz,
    paths,
    db,
    adapters: options.maintenance ? { wiki: { qmd: { search: () => [], index: async () => undefined } } } : undefined,
    doctor: options.realDoctor
      ? doctor
      : () => {
          calls.push("doctor");
          return { ok: true, checkedAt: new Date().toISOString(), checks: [] };
        },
    commit: (_paths, subject) => {
      calls.push(`commit:${subject}`);
      return { committed: true, subject };
    },
  });
  const checkpoint = db.checkpoint.bind(db);
  (db as unknown as { checkpoint: () => void }).checkpoint = () => {
    calls.push("checkpoint");
    checkpoint();
  };
  return { app, db, paths, calls, wiki, scheduler, quiz };
}

async function publishedChunkId(app: ScholarApplication): Promise<string> {
  await app.stageSource({ kind: "text", text: "ingest evidence\n", name: "ingest-evidence.txt" });
  const claim = (await app.getExtractContext()).claims[0];
  if (!claim) throw new Error("extract claim is missing");
  await app.publishExtraction({
    claimId: claim.claimId,
    preparedId: claim.preparedId,
    digest: claim.digest,
    endpoints: [1],
  });
  const chunk = (await app.getIngestContext()).sources[0]?.chunks[0];
  if (!chunk) throw new Error("published source chunk is missing");
  return chunk.chunkId;
}

describe("durable application writes", () => {
  it("checkpoints, doctors, and commits exactly once after the operation", async () => {
    const { app, db, calls } = fixture();
    try {
      assert.equal(
        await durable(
          app,
          () => {
            calls.push("operation");
            return "done";
          },
          "test:write",
        ),
        "done",
      );
      assert.deepEqual(calls, ["operation", "checkpoint", "doctor", "commit:test:write"]);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("finalizes source staging through the durable pipeline", async () => {
    const { app, db, calls } = fixture();
    try {
      const result = await app.stageSource({ kind: "text", text: "staged\n", name: "staged.txt" });
      assert.equal(result.source.status, "pending");
      assert.deepEqual(calls, ["checkpoint", "doctor", "commit:source:stage"]);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("cleans private staging after lock contention and retries exactly once", async () => {
    const { app, db, paths } = fixture();
    try {
      const lock = acquireWriterLock(paths);
      try {
        await assert.rejects(
          app.stageSource({ kind: "text", text: "blocked\n", name: "blocked.txt" }),
          (error: unknown) => error instanceof LockBusyError,
        );
        assert.deepEqual(await fs.readdir(paths.inboxRoot), []);
        assert.equal(
          (await fs.readdir(paths.workRoot)).some((name) => name.startsWith(".source-stage-")),
          false,
        );
      } finally {
        lock.release();
      }
      const result = await app.stageSource({ kind: "text", text: "retry\n", name: "retry.txt" });
      assert.equal(result.source.status, "pending");
      assert.equal((await fs.readdir(paths.inboxRoot)).length, 1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("reports applied, non-retryable finalization failures and never commits degraded state", async () => {
    for (const stage of ["checkpoint", "doctor", "commit"] as const) {
      const { app, db, calls } = fixture();
      const originalCheckpoint = db.checkpoint.bind(db);
      if (stage === "checkpoint")
        (db as unknown as { checkpoint: () => void }).checkpoint = () => {
          calls.push("checkpoint");
          throw new Error("checkpoint failed");
        };
      if (stage === "doctor") {
        (app as unknown as { doctorFn: () => unknown }).doctorFn = () => {
          calls.push("doctor");
          return { ok: false, checkedAt: new Date().toISOString(), checks: [] };
        };
      }
      if (stage === "commit") {
        (app as unknown as { commitFn: () => unknown }).commitFn = () => {
          calls.push("commit:test:write");
          throw new Error("commit failed");
        };
      }
      try {
        await assert.rejects(
          durable(
            app,
            () => {
              calls.push("operation");
              return "applied";
            },
            "test:write",
          ),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, "MUTATION_APPLIED_FINALIZATION_FAILED");
            assert.deepEqual((error as { details?: unknown }).details, { applied: true, retryable: false, stage });
            return true;
          },
        );
        assert.deepEqual(
          calls,
          stage === "checkpoint"
            ? ["operation", "checkpoint"]
            : stage === "doctor"
              ? ["operation", "checkpoint", "doctor"]
              : ["operation", "checkpoint", "doctor", "commit:test:write"],
        );
      } finally {
        (db as unknown as { checkpoint: () => void }).checkpoint = originalCheckpoint;
        await app.close();
        db.close();
      }
    }
  });
  it("rejects unsupported issue statuses before wiki mutation", async () => {
    const { app, db } = fixture();
    try {
      for (const status of ["open", "pending"]) {
        await assert.rejects(app.patchIssue("missing-issue", { status } as never), /issue status is invalid/u);
      }
    } finally {
      await app.close();
      db.close();
    }
  });
  it("caches a published source across finalization failure without recording admission failure", async () => {
    const { app, db } = fixture();
    const originalCheckpoint = db.checkpoint.bind(db);
    try {
      await app.stageSource({ kind: "text", text: "durable source\n", name: "durable.txt" });
      const context = await app.getExtractContext();
      const claim = context.claims[0];
      if (!claim) throw new Error("admission claim is missing");
      const input = { claimId: claim.claimId, preparedId: claim.preparedId, digest: claim.digest, endpoints: [1] };
      const appliedCheckpointFailure = (error: unknown): boolean => {
        if (error === null || typeof error !== "object" || !("code" in error) || !("details" in error)) return false;
        assert.equal(error.code, "MUTATION_APPLIED_FINALIZATION_FAILED");
        assert.deepEqual(error.details, { applied: true, retryable: false, stage: "checkpoint" });
        return true;
      };
      (db as unknown as { checkpoint: () => void }).checkpoint = () => {
        throw new Error("checkpoint failed after publication");
      };
      await assert.rejects(app.publishExtraction(input), appliedCheckpointFailure);
      const row = db.get<{ source_id: string; status: string; error_code: string | null }>(
        "SELECT source_id, status, error_code FROM sources",
      );
      assert.equal(row?.status, "published");
      assert.equal(row?.error_code, null);
      await assert.rejects(app.publishExtraction(input), appliedCheckpointFailure);
      (db as unknown as { checkpoint: () => void }).checkpoint = originalCheckpoint;
      const retry = await app.publishExtraction(input);
      assert.equal(retry.sourceId, row?.source_id);
      const published = db.get<{ status: string; error_code: string | null }>(
        "SELECT status, error_code FROM sources WHERE source_id = ?",
        [retry.sourceId],
      );
      assert.equal(published?.status, "published");
      assert.equal(published?.error_code, null);
    } finally {
      (db as unknown as { checkpoint: () => void }).checkpoint = originalCheckpoint;
      await app.close();
      db.close();
    }
  });
  it("refreshes OKF projections after source removal drifts a dependent page", async () => {
    const { app, db, paths, wiki } = fixture();
    try {
      await app.stageSource({ kind: "text", text: "evidence\n", name: "evidence.txt" });
      const claim = (await app.getExtractContext()).claims[0];
      if (!claim) throw new Error("admission claim is missing");
      const admitted = await app.publishExtraction({
        claimId: claim.claimId,
        preparedId: claim.preparedId,
        digest: claim.digest,
        endpoints: [1],
      });
      const page = await app.createNote({
        path: "grounded.md",
        body: `# Grounded\n\nClaim.[^${admitted.sourceId}:0]`,
      });
      const preview = await app.removalPreview(admitted.sourceId);
      assert.deepEqual(preview.dependentPageIds, [page.page.pageId]);
      let qmdRefreshes = 0;
      wiki.refreshQmdIndex = async () => {
        qmdRefreshes += 1;
      };
      const refreshProjections = wiki.refreshProjections.bind(wiki);
      wiki.refreshProjections = async () => {
        throw new Error("injected projection failure");
      };
      try {
        await assert.rejects(
          app.removeSource(admitted.sourceId, preview.confirmationId),
          (error: Error & { code?: string; details?: Record<string, unknown> }) => {
            assert.equal(error.code, "MUTATION_APPLIED_FINALIZATION_FAILED");
            assert.deepEqual(error.details, { applied: true, retryable: true, stage: "projection" });
            return true;
          },
        );
      } finally {
        wiki.refreshProjections = refreshProjections;
      }
      await app.removeSource(admitted.sourceId, preview.confirmationId);
      assert.equal(qmdRefreshes, 1);
      assert.equal((await fs.readFile(join(paths.wikiRoot, "index.md"), "utf8")).includes("grounded.md"), false);
      assert.equal((await fs.readFile(join(paths.wikiRoot, "log.md"), "utf8")).includes("grounded.md"), false);
      const report = doctor(paths.vaultRoot);
      assert.equal(report.checks.find((check) => check.name === "okf")?.status, "pass");
      assert.notEqual(report.checks.find((check) => check.name === "page-drift")?.status, "fail");
    } finally {
      await app.close();
      db.close();
    }
  }, 30_000);
  it("surfaces source-removal qmd failures after checkpoint and commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-source-qmd-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const calls: string[] = [];
    let qmdIndexes = 0;
    const app = new ScholarApplication({
      paths,
      db,
      adapters: {
        wiki: {
          qmd: {
            search: () => [],
            index: async () => {
              assert.throws(() => acquireWriterLock(paths), LockBusyError);
              calls.push("qmd");
              qmdIndexes += 1;
              if (qmdIndexes === 1) throw new Error("injected source qmd failure");
            },
          },
        },
      },
      doctor: () => {
        calls.push("doctor");
        return { ok: true, checkedAt: new Date().toISOString(), checks: [] };
      },
      commit: (_paths, subject) => {
        calls.push(`commit:${subject}`);
        return { committed: true, subject };
      },
    });
    const checkpoint = db.checkpoint.bind(db);
    (db as unknown as { checkpoint: () => void }).checkpoint = () => {
      calls.push("checkpoint");
      checkpoint();
    };
    try {
      await app.stageSource({ kind: "text", text: "evidence\n", name: "evidence.txt" });
      const claim = (await app.getExtractContext()).claims[0];
      if (!claim) throw new Error("admission claim is missing");
      const admitted = await app.publishExtraction({
        claimId: claim.claimId,
        preparedId: claim.preparedId,
        digest: claim.digest,
        endpoints: [1],
      });
      const preview = await app.removalPreview(admitted.sourceId);
      await assert.rejects(
        app.removeSource(admitted.sourceId, preview.confirmationId),
        (error: Error & { code?: string; details?: Record<string, unknown> }) => {
          assert.equal(error.code, "MUTATION_APPLIED_FINALIZATION_FAILED");
          assert.deepEqual(error.details, { applied: true, retryable: true, stage: "qmd" });
          return true;
        },
      );
      assert.deepEqual(calls.slice(-4), ["checkpoint", "doctor", "commit:source:remove", "qmd"]);
      assert.equal(
        db.get<{ status: string }>("SELECT status FROM sources WHERE source_id = ?", [admitted.sourceId])?.status,
        "removed",
      );
      const retry = await app.removeSource(admitted.sourceId, preview.confirmationId);
      assert.equal(retry.status, "removed");
      assert.equal(qmdIndexes, 2);
    } finally {
      (db as unknown as { checkpoint: () => void }).checkpoint = checkpoint;
      await app.close();
      db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("restores a page issue exactly when commit fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-rollback-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const wiki = new WikiService(db, paths, { qmd: { search: () => [], index: async () => undefined } });
    const app = new ScholarApplication({
      paths,
      wikiService: wiki,
      db,
      adapters: { wiki: { qmd: { search: () => [], index: async () => undefined } } },
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: () => {
        throw new Error("injected commit failure");
      },
    });
    const tableNames = [
      "pages",
      "authored_snapshots",
      "wiki_issues",
      "page_learning",
      "page_prerequisites",
      "page_reviews",
      "question_pages",
      "page_results",
    ];
    const rows = (name: string) =>
      db
        .all<Record<string, unknown>>(`SELECT * FROM ${name}`)
        .sort((left, right) => String(JSON.stringify(left)).localeCompare(String(JSON.stringify(right))));
    try {
      const originalBody = "# Section\n\nauthored\n";
      const correctedBody = "# Section\n\ncorrected\n";
      const page = await wiki.create({
        path: "rollback.md",
        description: "Rollback page correction.",
        body: originalBody,
        quizWorthiness: "eligible",
      });
      const issue = await wiki.report({
        pageId: page.page.pageId,
        heading: "Section",
        description: "Wrong section.",
      });
      const destinations = [
        join(paths.wikiRoot, page.page.relativePath),
        join(paths.metadataRoot, "snapshots", "wiki", `${page.page.pageId}.md`),
        join(paths.wikiRoot, "index.md"),
        join(paths.wikiRoot, "log.md"),
      ];
      const beforeFiles = await Promise.all(destinations.map((path) => fs.readFile(path)));
      const beforeTables = Object.fromEntries(tableNames.map((name) => [name, rows(name)]));
      await assert.rejects(
        app.applyWikiChange({
          kind: "resolve-issue",
          issueId: issue.issueId,
          page: { pageId: page.page.pageId, expectedDigest: page.page.digest, body: correctedBody },
          resolution: "Corrected the section.",
        }),
        /injected commit failure/u,
      );
      for (const [index, path] of destinations.entries())
        assert.equal((await fs.readFile(path)).equals(beforeFiles[index]!), true, path);
      for (const name of tableNames) assert.deepEqual(rows(name), beforeTables[name]);
      assert.equal((await app.listIssues()).issues.find((entry) => entry.issueId === issue.issueId)?.status, "open");
      assert.deepEqual(
        (await fs.readdir(paths.workRoot)).filter((name) => name.startsWith("maintenance-rollback-")),
        [],
      );
    } finally {
      await app.close();
      db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("rolls back non-resolve page maintenance when qmd checks fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-page-rollback-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    let qmdIndexes = 0;
    const wiki = new WikiService(db, paths, {
      qmd: {
        search: () => [],
        index: async () => {
          qmdIndexes += 1;
          if (qmdIndexes === 2) throw new Error("injected page qmd failure");
        },
      },
    });
    const app = new ScholarApplication({
      paths,
      wikiService: wiki,
      db,
      adapters: {
        wiki: {
          qmd: {
            search: () => [],
            index: async () => {
              qmdIndexes += 1;
              if (qmdIndexes === 2) throw new Error("injected page qmd failure");
            },
          },
        },
      },
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: (_paths, subject) => ({ committed: true, subject }),
    });
    try {
      const page = await wiki.create({ path: "page-rollback.md", body: "before\n", quizWorthiness: "skip" });
      const destinations = [
        join(paths.wikiRoot, page.page.relativePath),
        join(paths.metadataRoot, "snapshots", "wiki", `${page.page.pageId}.md`),
        join(paths.wikiRoot, "index.md"),
        join(paths.wikiRoot, "log.md"),
      ];
      const beforeFiles = await Promise.all(destinations.map((path) => fs.readFile(path)));
      const beforePages = db.all<Record<string, unknown>>("SELECT * FROM pages");
      const beforeSnapshots = db.all<Record<string, unknown>>("SELECT * FROM authored_snapshots");
      await assert.rejects(
        app.applyWikiChange({
          kind: "update-page",
          pageId: page.page.pageId,
          expectedDigest: page.page.digest,
          body: "after\n",
        }),
        /injected page qmd failure/u,
      );
      assert.equal(qmdIndexes, 3);
      for (const [index, path] of destinations.entries())
        assert.equal((await fs.readFile(path)).equals(beforeFiles[index]!), true, path);
      assert.deepEqual(db.all<Record<string, unknown>>("SELECT * FROM pages"), beforePages);
      assert.deepEqual(db.all<Record<string, unknown>>("SELECT * FROM authored_snapshots"), beforeSnapshots);
      assert.deepEqual(
        (await fs.readdir(paths.workRoot)).filter((name) => name.startsWith("maintenance-rollback-")),
        [],
      );
    } finally {
      await app.close();
      db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("refreshes qmd after direct create rollback", async () => {
    const { app, db, paths, wiki } = fixture({ maintenance: true });
    const pagePath = join(paths.wikiRoot, "direct-create-rollback.md");
    const indexPath = join(paths.wikiRoot, "index.md");
    const logPath = join(paths.wikiRoot, "log.md");
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const beforePages = db.all<Record<string, unknown>>("SELECT * FROM pages");
    const beforeSnapshots = db.all<Record<string, unknown>>("SELECT * FROM authored_snapshots");
    const qmd = wiki.adapters.qmd as { index: () => Promise<void> };
    let qmdIndexes = 0;
    qmd.index = async () => {
      qmdIndexes += 1;
      if (qmdIndexes === 1) {
        assert.match(await fs.readFile(pagePath, "utf8"), /Inside mutation/u);
        assert.ok(db.get("SELECT page_id FROM pages WHERE relative_path = ?", ["direct-create-rollback.md"]));
        throw new Error("injected create qmd failure");
      }
      assert.equal((await fs.readdir(paths.wikiRoot)).includes("direct-create-rollback.md"), false);
      assert.equal(
        db.get("SELECT page_id FROM pages WHERE relative_path = ?", ["direct-create-rollback.md"]),
        undefined,
      );
    };
    try {
      await assert.rejects(
        app.createNote({
          path: "direct-create-rollback.md",
          body: "# Inside mutation\n\nCreated.\n",
          quizWorthiness: "skip",
        }),
        /injected create qmd failure/u,
      );
      assert.equal(qmdIndexes, 2);
      assert.equal((await fs.readdir(paths.wikiRoot)).includes("direct-create-rollback.md"), false);
      assert.equal((await fs.readFile(indexPath)).equals(beforeIndex), true);
      assert.equal((await fs.readFile(logPath)).equals(beforeLog), true);
      assert.deepEqual(db.all<Record<string, unknown>>("SELECT * FROM pages"), beforePages);
      assert.deepEqual(db.all<Record<string, unknown>>("SELECT * FROM authored_snapshots"), beforeSnapshots);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("refreshes qmd after direct update rollback", async () => {
    const { app, db, paths, wiki } = fixture({ maintenance: true });
    try {
      const original = await app.createNote({
        path: "direct-update-rollback.md",
        body: "# Before\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      const pagePath = join(paths.wikiRoot, original.page.relativePath);
      const snapshotPath = join(paths.metadataRoot, "snapshots", "wiki", `${original.page.pageId}.md`);
      const destinations = [pagePath, snapshotPath, join(paths.wikiRoot, "index.md"), join(paths.wikiRoot, "log.md")];
      const beforeFiles = await Promise.all(destinations.map((path) => fs.readFile(path)));
      const beforePages = db.all<Record<string, unknown>>("SELECT * FROM pages");
      const beforeSnapshots = db.all<Record<string, unknown>>("SELECT * FROM authored_snapshots");
      const qmd = wiki.adapters.qmd as { index: () => Promise<void> };
      let qmdIndexes = 0;
      qmd.index = async () => {
        qmdIndexes += 1;
        if (qmdIndexes === 1) {
          assert.match(await fs.readFile(pagePath, "utf8"), /Changed by mutation/u);
          assert.equal(
            db.get<{ revision: number }>("SELECT revision FROM pages WHERE page_id = ?", [original.page.pageId])
              ?.revision,
            original.page.revision + 1,
          );
          throw new Error("injected update qmd failure");
        }
        assert.equal((await fs.readFile(pagePath)).equals(beforeFiles[0]!), true);
        assert.equal(
          db.get<{ revision: number }>("SELECT revision FROM pages WHERE page_id = ?", [original.page.pageId])
            ?.revision,
          original.page.revision,
        );
      };
      await assert.rejects(
        app.updateNote(original.page.pageId, { body: "# Before\n\nChanged by mutation.\n" }),
        /injected update qmd failure/u,
      );
      assert.equal(qmdIndexes, 2);
      for (const [index, path] of destinations.entries())
        assert.equal((await fs.readFile(path)).equals(beforeFiles[index]!), true, path);
      assert.deepEqual(db.all<Record<string, unknown>>("SELECT * FROM pages"), beforePages);
      assert.deepEqual(db.all<Record<string, unknown>>("SELECT * FROM authored_snapshots"), beforeSnapshots);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("refreshes qmd after direct drift resolution rollback", async () => {
    const { app, db, paths, wiki } = fixture({ maintenance: true });
    try {
      const original = await app.createNote({
        path: "direct-drift-rollback.md",
        body: "# Drift\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      const pagePath = join(paths.wikiRoot, original.page.relativePath);
      await fs.appendFile(pagePath, "\nExternal edit.\n");
      const drift = await wiki.inspectDrift(original.page.pageId);
      const snapshotPath = join(paths.metadataRoot, "snapshots", "wiki", `${original.page.pageId}.md`);
      const destinations = [pagePath, snapshotPath, join(paths.wikiRoot, "index.md"), join(paths.wikiRoot, "log.md")];
      const beforeFiles = await Promise.all(destinations.map((path) => fs.readFile(path)));
      const beforePages = db.all<Record<string, unknown>>("SELECT * FROM pages");
      const beforeSnapshots = db.all<Record<string, unknown>>("SELECT * FROM authored_snapshots");
      const qmd = wiki.adapters.qmd as { index: () => Promise<void> };
      let qmdIndexes = 0;
      qmd.index = async () => {
        qmdIndexes += 1;
        if (qmdIndexes === 1) {
          assert.equal((await fs.readFile(pagePath, "utf8")).includes("External edit."), false);
          assert.equal(
            db.get<{ revision: number }>("SELECT revision FROM pages WHERE page_id = ?", [original.page.pageId])
              ?.revision,
            original.page.revision + 1,
          );
          throw new Error("injected drift qmd failure");
        }
        assert.equal((await fs.readFile(pagePath)).equals(beforeFiles[0]!), true);
        assert.equal(
          db.get<{ revision: number }>("SELECT revision FROM pages WHERE page_id = ?", [original.page.pageId])
            ?.revision,
          original.page.revision,
        );
      };
      await assert.rejects(
        app.resolveDrift(original.page.pageId, { action: "restore", expectedDigest: drift.currentDigest }),
        /injected drift qmd failure/u,
      );
      assert.equal(qmdIndexes, 2);
      for (const [index, path] of destinations.entries())
        assert.equal((await fs.readFile(path)).equals(beforeFiles[index]!), true, path);
      assert.deepEqual(db.all<Record<string, unknown>>("SELECT * FROM pages"), beforePages);
      assert.deepEqual(db.all<Record<string, unknown>>("SELECT * FROM authored_snapshots"), beforeSnapshots);
      assert.equal((await wiki.inspectDrift(original.page.pageId)).drifted, true);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("rejects rollback restoration through a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-rollback-symlink-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const wiki = new WikiService(db, paths, { qmd: { search: () => [], index: async () => undefined } });
    const outside = join(root, "outside.txt");
    await fs.writeFile(outside, "outside\n");
    let destination = "";
    const app = new ScholarApplication({
      paths,
      db,
      wikiService: wiki,
      adapters: { wiki: { qmd: { search: () => [], index: async () => undefined } } },
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: () => {
        rmSync(destination);
        symlinkSync(outside, destination);
        throw new Error("injected commit failure");
      },
    });
    try {
      const page = await wiki.create({ path: "rollback-symlink.md", body: "before\n", quizWorthiness: "skip" });
      destination = join(paths.wikiRoot, page.page.relativePath);
      await assert.rejects(
        app.applyWikiChange({
          kind: "update-page",
          pageId: page.page.pageId,
          expectedDigest: page.page.digest,
          body: "after\n",
        }),
        (error: unknown) => {
          if (error === null || typeof error !== "object" || !("code" in error) || !("details" in error)) return false;
          assert.equal(error.code, "MUTATION_APPLIED_FINALIZATION_FAILED");
          assert.deepEqual(error.details, {
            applied: true,
            retryable: false,
            stage: "rollback",
          });
          return true;
        },
      );
      assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
      assert.equal(await fs.readlink(destination), outside);
    } finally {
      await app.close();
      db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects rollback deletion through a symlinked parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-rollback-parent-symlink-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const outside = join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, "marker.txt"), "outside\n");
    const parent = join(paths.wikiRoot, "nested");
    const app = new ScholarApplication({
      paths,
      db,
      adapters: { wiki: { qmd: { search: () => [], index: async () => undefined } } },
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: () => {
        rmSync(parent, { recursive: true, force: true });
        symlinkSync(outside, parent);
        throw new Error("injected commit failure");
      },
    });
    try {
      await assert.rejects(
        app.applyWikiChange({
          kind: "create-page",
          path: "nested/new.md",
          body: "before\n",
          quizWorthiness: "skip",
        }),
        (error: unknown) => {
          if (error === null || typeof error !== "object" || !("code" in error) || !("details" in error)) return false;
          assert.equal(error.code, "MUTATION_APPLIED_FINALIZATION_FAILED");
          assert.deepEqual(error.details, {
            applied: true,
            retryable: false,
            stage: "rollback",
          });
          return true;
        },
      );
      assert.equal(await fs.readFile(join(outside, "marker.txt"), "utf8"), "outside\n");
      assert.equal(await fs.readlink(parent), outside);
    } finally {
      await app.close();
      db.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("resolves wiki paths before drift inspection", async () => {
    const { app, db, paths } = fixture();
    try {
      const created = await app.createNote({
        path: "path-read.md",
        body: "# Path read\n\nAuthored content.\n",
        quizWorthiness: "skip",
      });
      const path = join(paths.wikiRoot, created.page.relativePath);
      await fs.appendFile(path, "\nExternal edit.\n");
      const result = await app.getWiki(created.page.relativePath);
      assert.equal(result.page.pageId, created.page.pageId);
      assert.equal(result.page.relativePath, created.page.relativePath);
      assert.equal(result.drift?.expectedDigest, created.page.digest);
      assert.notEqual(result.drift?.actualDigest, created.page.digest);
    } finally {
      await app.close();
      db.close();
    }
  });
});
describe("knowledge capability contexts", () => {
  it("exposes only verified published source packets to ingest", async () => {
    const { app, db, paths } = fixture();
    try {
      await app.stageSource({ kind: "text", text: "published\n", name: "published.txt" });
      const claim = (await app.getExtractContext()).claims[0];
      if (!claim) throw new Error("extract claim is missing");
      const published = await app.publishExtraction({
        claimId: claim.claimId,
        preparedId: claim.preparedId,
        digest: claim.digest,
        endpoints: [1],
      });
      await app.stageSource({ kind: "text", text: "pending\n", name: "pending.txt" });
      const context = await app.getIngestContext();
      assert.equal(context.sources.length, 1);
      const packet = context.sources[0];
      if (!packet) throw new Error("published packet is missing");
      assert.equal(packet.source.sourceId, published.sourceId);
      assert.equal(packet.source.status, "published");
      assert.equal(packet.source.manifestPath, packet.packetPath);
      assert.equal(packet.manifest.sourceId, published.sourceId);
      assert.equal(packet.packetPath, join(paths.sourcesRoot, published.sourceId));
      assert.equal(packet.chunks.length, packet.manifest.chunks.length);
      for (const [index, chunk] of packet.chunks.entries()) {
        const expectedPath = join(packet.packetPath, "chunks", `${String(index + 1).padStart(4, "0")}.md`);
        assert.equal(chunk.path, expectedPath);
        assert.equal((await fs.stat(chunk.path)).isFile(), true);
        const { path: _path, ...manifestChunk } = chunk;
        assert.deepEqual(manifestChunk, packet.manifest.chunks[index]);
      }
    } finally {
      await app.close();
      db.close();
    }
  });

  it("fails closed when a published source packet cannot be verified", async () => {
    const { app, db, paths } = fixture();
    try {
      await app.stageSource({ kind: "text", text: "tamper me\n", name: "tamper.txt" });
      const claim = (await app.getExtractContext()).claims[0];
      if (!claim) throw new Error("extract claim is missing");
      const published = await app.publishExtraction({
        claimId: claim.claimId,
        preparedId: claim.preparedId,
        digest: claim.digest,
        endpoints: [1],
      });
      await fs.appendFile(join(paths.sourcesRoot, published.sourceId, "extracted.md"), "tampered\n");
      await assert.rejects(app.getIngestContext(), /unavailable or unverified/u);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("builds full and targeted lint scopes without source paths", async () => {
    const { app, db } = fixture();
    try {
      const full = await app.getLintContext();
      assert.deepEqual(full.scope, { kind: "full" });
      assert.equal(Object.hasOwn(full, "sources"), false);
      const targeted = await app.getLintContext({ description: "repair backlinks" });
      assert.deepEqual(targeted.scope, { kind: "targeted", description: "repair backlinks" });
      assert.equal(Object.hasOwn(targeted, "sources"), false);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("keeps drifted pages in ingest and lint repair contexts", async () => {
    const { app, db, wiki } = fixture();
    try {
      const drifted = await app.createNote({ path: "drifted.md", body: "# Drifted\n", quizWorthiness: "skip" });
      const retired = await app.createNote({ path: "retired.md", body: "# Retired\n", quizWorthiness: "skip" });
      db.run("UPDATE pages SET status = 'drifted' WHERE page_id = ?", [drifted.page.pageId]);
      db.run("UPDATE pages SET status = 'retired' WHERE page_id = ?", [retired.page.pageId]);
      const open = await wiki.report({ description: "open issue" });
      const reopened = await wiki.report({ description: "reopened issue" });
      await wiki.patchIssue(reopened.issueId, { status: "reopened" });
      const resolved = await wiki.report({ description: "resolved issue" });
      await wiki.resolveIssueAfterCorrection(resolved.issueId, "corrected");

      const ingest = await app.getIngestContext();
      const lint = await app.getLintContext();
      for (const context of [ingest, lint]) {
        assert.equal(
          context.pages.some(({ page }) => page.pageId === drifted.page.pageId && page.status === "drifted"),
          true,
        );
        assert.equal(
          context.pages.some(({ page }) => page.pageId === retired.page.pageId),
          false,
        );
        const issueIds = new Set(context.issues.map((issue) => issue.issueId));
        assert.equal(issueIds.has(open.issueId), true);
        assert.equal(issueIds.has(reopened.issueId), true);
        assert.equal(issueIds.has(resolved.issueId), false);
      }
    } finally {
      await app.close();
      db.close();
    }
  });
  it("keeps wiki, ingest, and lint reads from healing missing learning state", async () => {
    const { app, db } = fixture();
    try {
      const page = await app.createNote({
        path: "missing-learning.md",
        description: "Missing learning guard.",
        body: "# Missing learning\n",
        quizWorthiness: "eligible",
      });
      db.run("DELETE FROM page_learning WHERE page_id = ?", [page.page.pageId]);
      await assert.rejects(app.getWiki(page.page.pageId), /learning state is missing/u);
      await assert.rejects(app.getIngestContext(), /learning state is missing/u);
      await assert.rejects(app.getLintContext(), /learning state is missing/u);
      assert.equal(db.get("SELECT page_id FROM page_learning WHERE page_id = ?", [page.page.pageId]), undefined);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects stale retire changes before mutating the page", async () => {
    const { app, db, wiki } = fixture({ maintenance: true });
    try {
      const page = await app.createNote({ path: "stale-retire.md", body: "# Stale retire\n", quizWorthiness: "skip" });
      await assert.rejects(
        app.applyWikiChange({ kind: "retire-page", pageId: page.page.pageId, expectedDigest: "stale-digest" }),
        /stale/u,
      );
      const current = await wiki.get(page.page.pageId);
      assert.equal(current.status, "active");
      assert.equal(current.digest, page.page.digest);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("guards prerequisite changes while a quiz is unresolved", async () => {
    const { app, db } = fixture({ maintenance: true });
    try {
      const page = await app.createNote({
        path: "quiz-guarded.md",
        description: "Quiz guard page.",
        body: "# Quiz guarded\n",
        quizWorthiness: "eligible",
      });
      const prerequisite = await app.createNote({
        path: "quiz-prerequisite.md",
        description: "Quiz prerequisite page.",
        body: "# Quiz prerequisite\n",
        quizWorthiness: "eligible",
      });
      const quizId = randomUUID();
      const questionId = randomUUID();
      db.run("INSERT INTO quizzes (quiz_id, date, revision, status, generated_at) VALUES (?, ?, 1, 'open', ?)", [
        quizId,
        "2099-01-01",
        new Date().toISOString(),
      ]);
      db.run(
        "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, source_refs_json) VALUES (?, ?, 0, 'free-response', ?, NULL, NULL, ?)",
        [questionId, quizId, "Explain", "[]"],
      );
      db.run("INSERT INTO question_pages (question_id, page_id, criterion_json, weight) VALUES (?, ?, ?, 1)", [
        questionId,
        page.page.pageId,
        "{}",
      ]);
      await assert.rejects(
        app.applyWikiChange({
          kind: "prerequisites",
          pageId: page.page.pageId,
          prerequisitePageIds: [prerequisite.page.pageId],
        }),
        /unresolved quiz/u,
      );
      assert.equal(
        db.get("SELECT 1 FROM page_prerequisites WHERE page_id = ? AND prerequisite_page_id = ?", [
          page.page.pageId,
          prerequisite.page.pageId,
        ]),
        undefined,
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects retiring pages until prerequisite edges are repaired", async () => {
    const { app, db, wiki } = fixture({ maintenance: true });
    try {
      const dependent = await app.createNote({
        path: "dependent.md",
        description: "Dependent prerequisite page.",
        body: "# Dependent\n",
        quizWorthiness: "eligible",
      });
      const prerequisite = await app.createNote({
        path: "prerequisite.md",
        description: "Prerequisite edge page.",
        body: "# Prerequisite\n",
        quizWorthiness: "eligible",
      });
      await app.applyWikiChange({
        kind: "prerequisites",
        pageId: dependent.page.pageId,
        prerequisitePageIds: [prerequisite.page.pageId],
      });
      for (const page of [dependent.page, prerequisite.page]) {
        await assert.rejects(
          app.applyWikiChange({ kind: "retire-page", pageId: page.pageId, expectedDigest: page.digest }),
          /quiz-eligible/u,
        );
        assert.equal((await wiki.get(page.pageId)).status, "active");
      }
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("application quiz date guards", () => {
  it("uses the configured timezone when rejecting stale submissions", async () => {
    const { app, db } = fixture();
    try {
      await app.updateSettings({ timezone: "Pacific/Kiritimati" });
      const current = (await app.getSettings()).settings.facts.localDate;
      const stale = new Date(`${current}T00:00:00.000Z`);
      stale.setUTCDate(stale.getUTCDate() - 1);
      await assert.rejects(
        app.sealSubmission(stale.toISOString().slice(0, 10), { expectedRevision: 1 }),
        /current local date/u,
      );
    } finally {
      await app.close();
      db.close();
    }
  });
  it("refreshes timezone eligibility for live injected schedulers sharing a vault", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-timezone-"));
    const paths = initVault(join(root, "vault"));
    const dbA = openDatabase(paths);
    const dbB = openDatabase(paths);
    const schedulerA = new SchedulerService(dbA, paths);
    const schedulerB = new SchedulerService(dbB, paths);
    const quizB = new QuizService(dbB, paths, schedulerB);
    const appA = new ScholarApplication({
      paths,
      db: dbA,
      schedulerService: schedulerA,
      quizService: new QuizService(dbA, paths, schedulerA),
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: (_paths, subject) => ({ committed: true, subject }),
    });
    const appB = new ScholarApplication({
      paths,
      db: dbB,
      schedulerService: schedulerB,
      quizService: quizB,
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: (_paths, subject) => ({ committed: true, subject }),
    });
    const pageId = "shared-timezone-page";
    const now = new Date().toISOString();
    dbA.run(
      "INSERT INTO pages (page_id, relative_path, title, digest, revision, status, quiz_worthiness, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'eligible', ?, ?)",
      [pageId, `${pageId}.md`, pageId, "digest", now, now],
    );
    schedulerA.ensurePageLearning(pageId, "2026-08-13T00:30:00.000Z");
    dbA.run("UPDATE page_learning SET due_at = ? WHERE page_id = ?", ["2026-08-13T00:30:00.000Z", pageId]);
    try {
      await appA.updateSettings({ timezone: "America/Los_Angeles" });
      assert.deepEqual(
        schedulerB.eligiblePages("2026-08-12", false).map((page) => page.pageId),
        [pageId],
      );
      assert.deepEqual(
        quizB.scheduler.eligiblePages("2026-08-12", false).map((page) => page.pageId),
        [pageId],
      );
    } finally {
      await appA.close();
      await appB.close();
      dbA.close();
      dbB.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not expire prior open quizzes when current publication is rejected", async () => {
    const { app, db, date, pageId } = await gradingFixture();
    const previous = new Date(`${date}T00:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const oldDate = previous.toISOString().slice(0, 10);
    const oldQuizId = randomUUID();
    db.run(
      "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'open', NULL, ?, NULL, NULL, NULL)",
      [oldQuizId, oldDate, new Date().toISOString()],
    );
    try {
      await assert.rejects(
        app.publishQuiz({
          status: "published",
          date,
          questions: [
            {
              kind: "free-response",
              prompt: "Explain",
              pages: [{ pageId, criterion: "Explain", weight: 1 }],
              sourceRefs: ["not-authorized"],
            },
          ],
        }),
      );
      assert.equal(
        db.get<{ status: string }>("SELECT status FROM quizzes WHERE quiz_id = ?", [oldQuizId])?.status,
        "open",
      );
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("application quiz publication guards", () => {
  it("blocks quiz evidence and publication while initialization is active", async () => {
    const { app, db, calls } = fixture();
    const date = localDate(new Date());
    try {
      await assert.rejects(app.getQuizEvidence({ date, pageIds: ["nonexistent-page"] }), (error: Error) => {
        assert.equal(error.message, "Initialization maintenance is active; quiz evidence is blocked");
        return true;
      });
      calls.length = 0;
      await assert.rejects(
        app.publishQuiz({ status: "skipped", date, reason: "Initialization maintenance is active" }),
        (error: Error) => {
          assert.equal(error.message, "Initialization maintenance is active; quiz publication is blocked");
          return true;
        },
      );
      assert.equal(db.get("SELECT 1 FROM quizzes LIMIT 1"), undefined);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("returns verified compact candidates without evidence excerpts", async () => {
    const { app, db, scheduler } = fixture();
    const date = localDate(new Date());
    const page = await app.createNote({
      path: "publication-page.md",
      description: "A page for publication.",
      title: "Publication page",
      body: "# Section\n\nSection text\n",
      quizWorthiness: "eligible",
    });
    const pageId = page.page.pageId;
    scheduler.ensurePageLearning(pageId, `${date}T00:00:00.000Z`);
    await app.updateSettings({ initializationEnabled: false });
    try {
      const context = await app.getQuizContext({ date });
      assert.deepEqual(Object.keys(context).sort(), ["candidates", "date", "expiredCount", "initializationEnabled"]);
      assert.equal(context.candidates.length, 1);
      const candidate = context.candidates[0]!;
      assert.deepEqual(Object.keys(candidate).sort(), ["description", "dueAt", "pageId", "path", "title"]);
      assert.equal(candidate.pageId, pageId);
      assert.equal(candidate.path, page.page.relativePath);
      assert.equal(candidate.title, "Publication page");
      assert.equal(candidate.description, "A page for publication.");
      assert.equal(candidate.dueAt, scheduler.getPageLearning(pageId).dueAt);
      assert.equal("excerpt" in candidate, false);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("bounds daily descriptions without changing canonical OKF", async () => {
    const { app, db, wiki, scheduler } = fixture();
    const date = localDate(new Date());
    const description = `  ${"é".repeat(600)}  `;
    const page = await app.createNote({
      path: "bounded-description.md",
      title: "Bounded description",
      description,
      body: "# Section\n\nSection text.\n",
      quizWorthiness: "eligible",
    });
    const pageId = page.page.pageId;
    scheduler.ensurePageLearning(pageId, `${date}T00:00:00.000Z`);
    await app.updateSettings({ initializationEnabled: false });
    try {
      const candidate = (await app.getQuizContext({ date })).candidates.find((item) => item.pageId === pageId);
      assert.equal(candidate?.description, "é".repeat(512));
      assert.equal(Buffer.byteLength(candidate?.description ?? "", "utf8"), 1024);
      const stored = parseWikiMarkdown((await wiki.get(pageId)).content);
      assert.equal(stored.frontmatter.description, description);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("publishes a grounded quiz for a described headingless page", async () => {
    const { app, db, scheduler } = fixture();
    const date = localDate(new Date());
    const page = await app.createNote({
      path: "headingless-publication.md",
      title: "Headingless publication",
      description: "A page described without a heading.",
      body: "Meaningful page-level exposition without a Markdown heading.\n",
      quizWorthiness: "eligible",
    });
    const pageId = page.page.pageId;
    scheduler.ensurePageLearning(pageId, `${date}T00:00:00.000Z`);
    await app.updateSettings({ initializationEnabled: false });
    try {
      const evidence = await app.getQuizEvidence({ date, pageIds: [pageId] });
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.anchor, "");
      assert.equal(evidence[0]?.heading, undefined);
      assert.equal(evidence[0]?.excerpt.includes("---"), false);
      const quiz = await app.publishQuiz({
        status: "published",
        date,
        questions: [
          {
            kind: "free-response",
            prompt: "Explain the page",
            pages: [{ pageId, criterion: "Connect the explanation to the source", weight: 1 }],
            sourceRefs: evidence.map((item) => item.reference),
          },
        ],
      });
      assert.equal(quiz.questions.length, 1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns authoritative evidence only for the requested due subset", async () => {
    const { app, db, calls, scheduler } = fixture();
    const date = localDate(new Date());
    const first = await app.createNote({
      path: "evidence-first.md",
      description: "First evidence page.",
      body: "# First\n\nFirst text\n",
      quizWorthiness: "eligible",
    });
    const second = await app.createNote({
      path: "evidence-second.md",
      description: "Second evidence page.",
      body: "# Second\n\nSecond text\n",
      quizWorthiness: "eligible",
    });
    const future = await app.createNote({
      path: "evidence-future.md",
      description: "Future evidence page.",
      body: "# Future\n\nFuture text\n",
      quizWorthiness: "eligible",
    });
    scheduler.ensurePageLearning(first.page.pageId, `${date}T00:00:00.000Z`);
    scheduler.ensurePageLearning(second.page.pageId, `${date}T00:00:00.000Z`);
    db.run("UPDATE page_learning SET due_at = ? WHERE page_id = ?", [
      new Date(Date.now() + 2 * 86_400_000).toISOString(),
      future.page.pageId,
    ]);
    await app.updateSettings({ initializationEnabled: false });
    calls.length = 0;
    try {
      const evidence = await app.getQuizEvidence({ date, pageIds: [second.page.pageId, first.page.pageId] });
      assert.deepEqual([...new Set(evidence.map((item) => item.pageId))], [second.page.pageId, first.page.pageId]);
      assert.ok(evidence.every((item) => item.excerpt.length > 0));
      await assert.rejects(app.getQuizEvidence({ date, pageIds: [future.page.pageId] }), /not currently eligible/u);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("excludes live-drift pages from quiz candidates, evidence, and publication", async () => {
    const { app, db, paths, scheduler } = fixture();
    const date = localDate(new Date());
    const page = await app.createNote({
      path: "live-drift.md",
      description: "Live drift page.",
      body: "# Live drift\n\nCataloged text\n",
      quizWorthiness: "eligible",
    });
    const pageId = page.page.pageId;
    scheduler.ensurePageLearning(pageId, `${date}T00:00:00.000Z`);
    await app.updateSettings({ initializationEnabled: false });
    await fs.appendFile(join(paths.wikiRoot, page.page.relativePath), "\nPhysical edit\n");
    try {
      const context = await app.getQuizContext({ date });
      assert.equal(
        context.candidates.some((candidate) => candidate.pageId === pageId),
        false,
      );
      await assert.rejects(app.getQuizEvidence({ date, pageIds: [pageId] }), /Quiz page is not currently eligible/u);
      await assert.rejects(
        app.publishQuiz({
          status: "published",
          date,
          questions: [
            {
              kind: "free-response",
              prompt: "Explain the page",
              pages: [{ pageId, criterion: "Explain", weight: 1 }],
              sourceRefs: ["not-authorized"],
            },
          ],
        }),
        /Quiz question references an ineligible page/u,
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects empty and duplicate evidence requests", async () => {
    const { app, db } = fixture();
    const date = localDate(new Date());
    const page = await app.createNote({
      path: "evidence-validation.md",
      description: "Evidence validation page.",
      body: "# Section\n\nSection text\n",
      quizWorthiness: "eligible",
    });
    try {
      await assert.rejects(app.getQuizEvidence({ date, pageIds: [] }), /non-empty/u);
      await assert.rejects(app.getQuizEvidence({ date, pageIds: [page.page.pageId, page.page.pageId] }), /unique/u);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("publishes an uncapped quiz for a selected due subset with multiple questions per page", async () => {
    const { app, db, scheduler } = fixture();
    const date = localDate(new Date());
    const page = await app.createNote({
      path: "publication-page.md",
      description: "Selected publication page.",
      title: "Publication page",
      body: "# Section\n\nSection text\n",
      quizWorthiness: "eligible",
    });
    const unselected = await app.createNote({
      path: "unselected-page.md",
      description: "Unselected publication page.",
      title: "Unselected page",
      body: "# Other\n\nOther text\n",
      quizWorthiness: "eligible",
    });
    const pageId = page.page.pageId;
    scheduler.ensurePageLearning(pageId, `${date}T00:00:00.000Z`);
    scheduler.ensurePageLearning(unselected.page.pageId, `${date}T00:00:00.000Z`);
    await app.updateSettings({ initializationEnabled: false });
    try {
      const evidence = await app.getQuizEvidence({ date, pageIds: [pageId] });
      const sourceRefs = evidence.map((item) => item.reference);
      const questions = Array.from({ length: 5 }, (_, index) => ({
        kind: "free-response" as const,
        prompt: `Explain point ${index + 1}`,
        pages: [{ pageId, criterion: "Explain the section", weight: 1 }],
        sourceRefs,
      }));
      const quiz = await app.publishQuiz({ status: "published", date, questions });
      assert.equal(quiz.questions.length, 5);
      assert.equal(
        db.all(
          "SELECT qp.question_id FROM question_pages qp JOIN quiz_questions qq ON qq.question_id = qp.question_id WHERE qq.quiz_id = ?",
          [quiz.quizId],
        ).length,
        5,
      );
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("browser quiz drafts", () => {
  it("saves through the browser queue without checkpointing or committing", async () => {
    const { app, db, calls, date, questionId, quiz } = await gradingFixture();
    try {
      calls.length = 0;
      const saved = await app.saveAnswers(
        date,
        {
          expectedRevision: quiz.revision,
          answers: [{ questionId, answer: "updated answer" }],
        },
        { origin: "browser" },
      );
      assert.equal(saved.revision, quiz.revision + 1);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
      db.close();
    }
  });
});
describe("application browser mutation boundary", () => {
  it("drains browser mutations in FIFO order before closing its database", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-browser-close-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const wiki = new WikiService(db, paths);
    const app = new ScholarApplication({
      paths,
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      db,
      wikiService: wiki,
      commit: (_paths, subject) => ({ committed: true, subject }),
    });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const originalReport = wiki.report.bind(wiki);
    wiki.report = async (input) => {
      order.push(input.description);
      if (order.length === 1) {
        started.resolve();
        await release.promise;
      }
      return originalReport(input);
    };
    const mutations: Promise<unknown>[] = [];
    let closing: Promise<void> | undefined;
    let closeResolved = false;
    try {
      const first = app.reportIssue({ kind: "incorrect", description: "first" }, { origin: "browser" });
      const second = app.reportIssue({ kind: "incorrect", description: "second" }, { origin: "browser" });
      mutations.push(first, second);
      await started.promise;
      closing = app.close().then(() => {
        closeResolved = true;
      });
      await waitForImmediate();
      assert.equal(closeResolved, false);
      assert.deepEqual(order, ["first"]);
      release.resolve();
      await Promise.all([first, second, closing]);
      assert.deepEqual(order, ["first", "second"]);
      await assert.rejects(
        app.reportIssue({ kind: "incorrect", description: "after close" }, { origin: "browser" }),
        /browser mutation worker is closed/u,
      );
    } finally {
      release.resolve();
      await Promise.allSettled([...mutations, ...(closing ? [closing] : [])]);
      if (!closing) await app.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function gradingFixture() {
  const fixtureValue = fixture();
  const { wiki, scheduler, quiz: quizService } = fixtureValue;
  const date = localDate(new Date());
  const page = await wiki.create({
    path: "page-1.md",
    description: "Grading fixture page.",
    title: "Page 1",
    body: "# Section\n\nSection text\n",
    quizWorthiness: "eligible",
  });
  const pageId = page.page.pageId;
  scheduler.ensurePageLearning(pageId, `${date}T00:00:00.000Z`);
  const quiz = quizService.createDailyQuiz({
    date,
    selectedPageIds: [pageId],
    questionSpecs: [
      {
        kind: "free-response",
        prompt: "Explain the section",
        pages: [{ pageId, criterion: "Identify the section's central idea", weight: 1 }],
        sourceRefs: [],
      },
    ],
  });
  const questionId = quiz.questions[0]?.questionId;
  if (!questionId) throw new Error("grading fixture question missing");
  const draft = quizService.saveDraft({ date, revision: quiz.revision, answers: { [questionId]: "answer" } });
  return { ...fixtureValue, date, pageId, questionId, quiz: quizService.get(date)!, draft };
}
async function prerequisiteFixture() {
  const fixtureValue = fixture({ maintenance: true });
  const { wiki, scheduler } = fixtureValue;
  const dependent = await wiki.create({
    path: "dependent.md",
    description: "Dependent grading page.",
    title: "Dependent",
    body: "# Section\n\ndependent\n",
    quizWorthiness: "eligible",
  });
  const prerequisite = await wiki.create({
    path: "prerequisite.md",
    description: "Prerequisite grading page.",
    title: "Prerequisite",
    body: "# Section\n\nprerequisite\n",
    quizWorthiness: "eligible",
  });
  scheduler.ensurePageLearning(dependent.page.pageId);
  scheduler.ensurePageLearning(prerequisite.page.pageId);
  scheduler.setPrerequisites(dependent.page.pageId, [prerequisite.page.pageId]);
  return { ...fixtureValue, dependent: dependent.page, prerequisite: prerequisite.page };
}

function gradeFor(context: GradingContext, pageId: string, questionId: string, evidence: readonly string[]) {
  assert.ok(context.quiz);
  return {
    requestId: context.requestId!,
    date: context.date,
    revision: context.revision!,
    submissionId: context.submissionId!,
    questions: [{ questionId, feedback: "Explained the page." }],
    pages: [
      {
        pageId,
        rating: "Good" as const,
        evidence: [...evidence],
        readings: [{ pageId, anchor: "#section" }],
      },
    ],
  };
}

describe("quiz grading workflow lifecycle", () => {
  it("rejects workflow request IDs in question and page feedback before persistence", async () => {
    const { app, db, date, pageId, questionId, draft } = await gradingFixture();
    const owner = randomUUID();
    try {
      const sealed = await app.sealSubmission(date, { expectedRevision: draft.revision });
      const first = await app.getGradingContext({ date }, owner);
      const firstEvidence = first.evidence?.find((item) => item.pageId === pageId)?.reference;
      assert.ok(firstEvidence);
      const firstGrade = gradeFor(first, pageId, questionId, [firstEvidence]);
      await assert.rejects(
        app.settleGrade(
          {
            ...firstGrade,
            questions: [{ questionId, feedback: `x${first.requestId}` }],
          },
          owner,
        ),
        /private metadata/u,
      );
      const retry = await app.getGradingContext({ date }, owner);
      const retryEvidence = retry.evidence?.find((item) => item.pageId === pageId)?.reference;
      assert.ok(retryEvidence);
      const retryGrade = gradeFor(retry, pageId, questionId, [retryEvidence]);
      await assert.rejects(
        app.settleGrade(
          {
            ...retryGrade,
            questions: [{ questionId, feedback: "visible feedback" }],
            pages: [{ ...retryGrade.pages[0]!, feedback: `x${retry.requestId}` }],
          },
          owner,
        ),
        /private metadata/u,
      );
      assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 0);
      assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 0);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("atomically queues, claims, validates ownership, and settles one sealed submission", async () => {
    const { app, db, date, pageId, questionId, draft } = await gradingFixture();
    const owner = randomUUID();
    const staleRequestId = randomUUID();
    db.run(
      "INSERT INTO workflows (request_id, kind, status, started_at, finished_at, progress, message, error_code, error_message, idempotency_key) VALUES (?, 'quiz-grader', 'queued', NULL, NULL, 0, ?, NULL, NULL, ?)",
      [staleRequestId, "malformed-grader-payload", "stale-grader-queue"],
    );
    try {
      const sealed = await app.sealSubmission(date, { expectedRevision: draft.revision });
      assert.equal(db.all("SELECT request_id FROM workflows WHERE kind = 'quiz-grader'").length, 2);
      assert.equal(sealed.workflow.status, "queued");
      const context = await app.getGradingContext({ date }, owner);
      assert.equal(context.requestId, sealed.workflow.requestId);
      assert.equal(context.submissionId, `${sealed.quiz.quizId}:r${sealed.quiz.revision}`);
      assert.equal((await app.getWorkflow(context.requestId!)).status, "running");
      assert.equal((await app.getWorkflow(staleRequestId)).status, "queued");
      const evidence = context.evidence?.find((item) => item.pageId === pageId)?.reference;
      assert.ok(evidence);
      await assert.rejects(
        app.settleGrade({ ...gradeFor(context, pageId, questionId, [evidence]), requestId: "wrong-request" }, owner),
        /unknown/u,
      );
      assert.equal((await app.getWorkflow(context.requestId!)).status, "running");
      const grade = gradeFor(context, pageId, questionId, [evidence]);
      const settled = await app.settleGrade(grade, owner);
      assert.equal(settled.quiz.status, "submitted");
      assert.equal((await app.getWorkflow(context.requestId!)).status, "succeeded");
      assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 1);
      assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 1);
      const replay = await app.settleGrade(grade, owner);
      assert.equal(replay.quiz.quizId, settled.quiz.quizId);
      await assert.rejects(app.settleGrade({ ...grade, questions: [] }, owner), /replay|committed result/u);
      assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 1);
      assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("keeps running grading claims exclusive while allowing the same owner to retry", async () => {
    const { app, db, date, pageId, questionId, draft } = await gradingFixture();
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    try {
      await app.sealSubmission(date, { expectedRevision: draft.revision });
      const first = await app.getGradingContext({ date }, ownerA);
      const other = await app.getGradingContext({ date }, ownerB);
      assert.equal(other.requestId, undefined);
      assert.equal(other.quiz, undefined);
      const retry = await app.getGradingContext({ date }, ownerA);
      assert.equal(retry.requestId, first.requestId);
      assert.equal(retry.submissionId, first.submissionId);
      const evidence = retry.evidence?.find((item) => item.pageId === pageId)?.reference;
      assert.ok(evidence);
      await assert.rejects(app.settleGrade(gradeFor(retry, pageId, questionId, [evidence]), ownerB), /another grader/u);
      await app.settleGrade(gradeFor(retry, pageId, questionId, [evidence]), ownerA);
      assert.equal((await app.getWorkflow(first.requestId!)).status, "succeeded");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("fails an invalid owned request and creates a new retry request for the sealed quiz", async () => {
    const { app, db, date, pageId, questionId, draft } = await gradingFixture();
    const firstOwner = randomUUID();
    const retryOwner = randomUUID();
    try {
      const sealed = await app.sealSubmission(date, { expectedRevision: draft.revision });
      const first = await app.getGradingContext({ date }, firstOwner);
      const firstWorkflow = first.requestId!;
      await assert.rejects(app.settleGrade(gradeFor(first, pageId, questionId, ["not-authorized"]), firstOwner));
      assert.equal((await app.getWorkflow(firstWorkflow)).status, "failed");
      const failure = db.get<{ error_message: string }>("SELECT error_message FROM workflows WHERE request_id = ?", [
        firstWorkflow,
      ]);
      assert.equal(failure?.error_message, `Page grade cites unauthorized evidence: ${pageId}`);
      assert.ok(Buffer.byteLength(failure?.error_message ?? "", "utf8") <= 500);
      assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 0);
      assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 0);
      const retry = await app.getGradingContext({ date }, retryOwner);
      assert.notEqual(retry.requestId, firstWorkflow);
      assert.equal(retry.submissionId, first.submissionId);
      const evidence = retry.evidence?.find((item) => item.pageId === pageId)?.reference;
      assert.ok(evidence);
      await app.settleGrade(gradeFor(retry, pageId, questionId, [evidence]), retryOwner);
      assert.equal((await app.getWorkflow(retry.requestId!)).status, "succeeded");
    } finally {
      await app.close();
      db.close();
    }
  });
  it("hides private quiz-grader messages from public workflow reads", async () => {
    const { app, db, date, draft } = await gradingFixture();
    const owner = randomUUID();
    try {
      const sealed = await app.sealSubmission(date, { expectedRevision: draft.revision });
      const requestId = sealed.workflow.requestId;
      const queuedMessage = db.get<{ message: string }>("SELECT message FROM workflows WHERE request_id = ?", [
        requestId,
      ])?.message;
      assert.match(queuedMessage ?? "", /submissionId/u);
      assert.equal("message" in sealed.workflow, false);
      assert.equal("errorMessage" in sealed.workflow, false);
      const listedWorkflow = (await app.listWorkflows()).workflows.find((workflow) => workflow.requestId === requestId);
      assert.ok(listedWorkflow);
      assert.equal("message" in listedWorkflow, false);
      assert.equal("errorMessage" in listedWorkflow, false);
      assert.equal(listedWorkflow.status, "queued");
      await app.getGradingContext({ date }, owner);
      const detail = await app.getWorkflow(requestId);
      assert.equal(detail.status, "running");
      assert.equal(detail.progress, 0);
      assert.equal("message" in detail, false);
      assert.equal("errorMessage" in detail, false);
      const statusWorkflow = (await app.status()).workflows.find((workflow) => workflow.requestId === requestId);
      assert.ok(statusWorkflow);
      assert.equal("message" in statusWorkflow, false);
      assert.equal("errorMessage" in statusWorkflow, false);
      const runningMessage = db.get<{ message: string }>("SELECT message FROM workflows WHERE request_id = ?", [
        requestId,
      ])?.message;
      assert.match(runningMessage ?? "", /ownerHash/u);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("application wiki mutation quiz guards", () => {
  it("blocks an update covered by an open quiz without changing the page", async () => {
    const { app, db, pageId, wiki } = await gradingFixture();
    try {
      const before = await wiki.get(pageId);
      await assert.rejects(app.updateNote(pageId, { body: "# Section\n\nchanged\n" }), /unresolved quiz/u);
      const after = await wiki.get(pageId);
      assert.equal(after.content, before.content);
      assert.equal(after.digest, before.digest);
      assert.equal(after.revision, before.revision);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("blocks an update covered by a submitted but unsettled quiz without changing the page", async () => {
    const { app, db, date, pageId, draft, wiki } = await gradingFixture();
    try {
      const sealed = await app.sealSubmission(date, { expectedRevision: draft.revision });
      assert.equal(sealed.quiz.status, "submitted");
      assert.equal(db.all("SELECT 1 FROM page_results WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 0);
      const before = await wiki.get(pageId);
      await assert.rejects(app.updateNote(pageId, { body: "# Section\n\nchanged\n" }), /unresolved quiz/u);
      const after = await wiki.get(pageId);
      assert.equal(after.content, before.content);
      assert.equal(after.digest, before.digest);
      assert.equal(after.revision, before.revision);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("allows an update after the covered quiz is settled", async () => {
    const { app, db, date, pageId, questionId, draft, wiki } = await gradingFixture();
    const owner = randomUUID();
    try {
      await app.sealSubmission(date, { expectedRevision: draft.revision });
      const context = await app.getGradingContext({ date }, owner);
      const evidence = context.evidence?.find((item) => item.pageId === pageId)?.reference;
      assert.ok(evidence);
      await app.settleGrade(gradeFor(context, pageId, questionId, [evidence]), owner);
      const before = await wiki.get(pageId);
      const updated = await app.updateNote(pageId, { body: "# Section\n\nchanged\n" });
      assert.notEqual(updated.page.digest, before.digest);
      assert.equal(updated.page.revision, before.revision + 1);
      assert.match(updated.markdown, /changed/u);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("application prerequisite mutation guards", () => {
  it("rejects making a dependent page ineligible without mutating the page or edge", async () => {
    const { app, db, dependent, wiki } = await prerequisiteFixture();
    try {
      const before = await wiki.get(dependent.pageId);
      const beforePrerequisites = db.all<Record<string, unknown>>(
        "SELECT page_id, prerequisite_page_id FROM page_prerequisites ORDER BY page_id, prerequisite_page_id",
      );
      await assert.rejects(app.updateNote(dependent.pageId, { quizWorthiness: "skip" }), /prerequisites/u);
      const after = await wiki.get(dependent.pageId);
      assert.equal(after.quizWorthiness, before.quizWorthiness);
      assert.equal(after.digest, before.digest);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(
        db.all<Record<string, unknown>>(
          "SELECT page_id, prerequisite_page_id FROM page_prerequisites ORDER BY page_id, prerequisite_page_id",
        ),
        beforePrerequisites,
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects making a prerequisite page unknown through maintenance without mutating the page or edge", async () => {
    const { app, db, prerequisite, wiki } = await prerequisiteFixture();
    try {
      const before = await wiki.get(prerequisite.pageId);
      const beforePrerequisites = db.all<Record<string, unknown>>(
        "SELECT page_id, prerequisite_page_id FROM page_prerequisites ORDER BY page_id, prerequisite_page_id",
      );
      await assert.rejects(
        app.applyWikiChange({
          kind: "update-page",
          pageId: prerequisite.pageId,
          expectedDigest: before.digest,
          body: "# Section\n\nchanged\n",
          quizWorthiness: "unknown",
        }),
        /prerequisites/u,
      );
      const after = await wiki.get(prerequisite.pageId);
      assert.equal(after.quizWorthiness, before.quizWorthiness);
      assert.equal(after.digest, before.digest);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(
        db.all<Record<string, unknown>>(
          "SELECT page_id, prerequisite_page_id FROM page_prerequisites ORDER BY page_id, prerequisite_page_id",
        ),
        beforePrerequisites,
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects ineligible resolve-issue corrections before preparing the page update", async () => {
    const { app, db, dependent, wiki } = await prerequisiteFixture();
    try {
      const issue = await wiki.report({
        pageId: dependent.pageId,
        heading: "Section",
        description: "Correct the section.",
      });
      const before = await wiki.get(dependent.pageId);
      const beforePrerequisites = db.all<Record<string, unknown>>(
        "SELECT page_id, prerequisite_page_id FROM page_prerequisites ORDER BY page_id, prerequisite_page_id",
      );
      await assert.rejects(
        app.applyWikiChange({
          kind: "resolve-issue",
          issueId: issue.issueId,
          page: {
            pageId: dependent.pageId,
            expectedDigest: before.digest,
            description: "Dependent grading page.",
          },
          resolution: "No page correction.",
        }),
        /actual page correction/u,
      );
      await assert.rejects(
        app.applyWikiChange({
          kind: "resolve-issue",
          issueId: issue.issueId,
          page: {
            pageId: dependent.pageId,
            expectedDigest: before.digest,
            body: "# Section\n\ncorrected\n",
            quizWorthiness: "skip",
          },
          resolution: "Corrected the section.",
        }),
        /prerequisites/u,
      );
      const after = await wiki.get(dependent.pageId);
      assert.equal(after.quizWorthiness, before.quizWorthiness);
      assert.equal(after.digest, before.digest);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(
        db.all<Record<string, unknown>>(
          "SELECT page_id, prerequisite_page_id FROM page_prerequisites ORDER BY page_id, prerequisite_page_id",
        ),
        beforePrerequisites,
      );
      assert.equal((await app.listIssues()).issues.find((item) => item.issueId === issue.issueId)?.status, "open");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("does not over-block body-only or eligible updates on prerequisite pages", async () => {
    const { app, db, prerequisite, wiki } = await prerequisiteFixture();
    try {
      const first = await wiki.get(prerequisite.pageId);
      const bodyOnly = await app.updateNote(prerequisite.pageId, {
        body: "# Section\n\nbody-only\n",
      });
      assert.equal(bodyOnly.page.quizWorthiness, first.quizWorthiness);
      assert.equal(bodyOnly.page.revision, first.revision + 1);
      const eligible = await app.updateNote(prerequisite.pageId, {
        body: "# Section\n\neligible\n",
        quizWorthiness: "eligible",
      });
      assert.equal(eligible.page.quizWorthiness, "eligible");
      assert.equal(eligible.page.revision, bodyOnly.page.revision + 1);
      assert.equal(db.all("SELECT page_id, prerequisite_page_id FROM page_prerequisites").length, 1);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("application capability boundaries", () => {
  it("requires an immutable citation for ingest page edits but not generic lint edits", async () => {
    const { app, db, wiki } = fixture({ maintenance: true });
    try {
      const created = await app.createNote({
        path: "ingest-citation.md",
        body: "# Ingest citation\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      const proposal = {
        kind: "update-page" as const,
        pageId: created.page.pageId,
        expectedDigest: created.page.digest,
        body: "# Ingest citation\n\nUpdated without a citation.\n",
      };
      await assert.rejects(app.applyIngestChange(proposal), /immutable source chunk citation/u);
      assert.match((await wiki.get(created.page.pageId)).content, /Original/u);

      const lint = await app.applyWikiChange(proposal);
      assert.equal(lint.page?.pageId, created.page.pageId);
      assert.match((await wiki.get(created.page.pageId)).content, /Updated without a citation/u);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("rejects empty ingest exposition while preserving cited updates and retirement", async () => {
    const { app, db, wiki } = fixture({ maintenance: true });
    try {
      await assert.rejects(
        app.applyIngestChange({
          kind: "create-page",
          path: "ingest-empty-create.md",
          body: " \t\n",
        }),
        /non-empty/u,
      );

      const chunkId = await publishedChunkId(app);
      for (const [index, body] of [
        `[^${chunkId}]`,
        `# Evidence\n\n[^${chunkId}]`,
        `Topic\n=====\n[^${chunkId}]`,
        `[](https://example.test)[^${chunkId}]`,
        `# Grounded\n\nSupported [^${chunkId}].\n\n# [](https://example.test)\n\nUnsupported claim.`,
        `# Grounded\n\nSupported [^${chunkId}].\n\n# [][empty]\n\nUnsupported claim.\n\n[empty]: https://example.test`,
        `---\n\n[^${chunkId}]`,
        `- [^${chunkId}]`,
      ].entries()) {
        await assert.rejects(
          app.applyIngestChange({
            kind: "create-page",
            path: `ingest-citation-only-${index}.md`,
            body,
          }),
          /non-empty/u,
        );
      }
      const created = await app.createNote({
        path: "ingest-empty-replacement.md",
        body: `# Ingest\n\nOriginal support [^${chunkId}].\n`,
        quizWorthiness: "skip",
      });
      await assert.rejects(
        app.applyIngestChange({
          kind: "update-page",
          pageId: created.page.pageId,
          expectedDigest: created.page.digest,
          body: " \n\t ",
        }),
        /non-empty/u,
      );
      assert.match((await wiki.get(created.page.pageId)).content, /Original support/u);

      const issue = await wiki.report({
        pageId: created.page.pageId,
        pageDigest: created.page.digest,
        heading: "Ingest",
        kind: "incorrect",
        description: "Replace the empty exposition.",
      });
      await assert.rejects(
        app.applyIngestChange({
          kind: "resolve-issue",
          issueId: issue.issueId,
          page: {
            pageId: created.page.pageId,
            expectedDigest: created.page.digest,
            body: "\n  ",
          },
          resolution: "The empty replacement is rejected.",
        }),
        /non-empty/u,
      );
      assert.equal((await app.listIssues()).issues.find((item) => item.issueId === issue.issueId)?.status, "open");

      const updated = await app.applyIngestChange({
        kind: "update-page",
        pageId: created.page.pageId,
        expectedDigest: created.page.digest,
        body: `# Ingest\n\nUpdated support [^${chunkId}].\n`,
      });
      assert.equal(updated.page?.pageId, created.page.pageId);

      const retire = await app.createNote({
        path: "ingest-retire.md",
        body: "# Retire\n\nRemove this page explicitly.\n",
        quizWorthiness: "skip",
      });
      const retired = await app.applyIngestChange({
        kind: "retire-page",
        pageId: retire.page.pageId,
        expectedDigest: retire.page.digest,
      });
      assert.equal(retired.page?.status, "retired");
    } finally {
      await app.close();
      db.close();
    }
  });
  it("repairs multiple live-drift pages sequentially without over-blocking unrelated drift", async () => {
    const { app, db, paths, wiki } = fixture({ maintenance: true });
    try {
      const first = await app.createNote({
        path: "drift-first.md",
        description: "Original first description.",
        body: "# First\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      const second = await app.createNote({
        path: "drift-second.md",
        body: "# Second\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      const firstPath = join(paths.wikiRoot, first.page.relativePath);
      const firstContent = await fs.readFile(firstPath, "utf8");
      assert.match(firstContent, /description: Original first description\./u);
      await fs.writeFile(
        firstPath,
        firstContent.replace("description: Original first description.", "description: External first description."),
      );
      await fs.appendFile(join(paths.wikiRoot, first.page.relativePath), "\nExternal first edit.\n");
      await fs.appendFile(join(paths.wikiRoot, second.page.relativePath), "\nExternal second edit.\n");
      const firstDrift = await wiki.inspectDrift(first.page.pageId);
      const secondDrift = await wiki.inspectDrift(second.page.pageId);
      await assert.rejects(
        app.applyIngestChange({
          kind: "update-page",
          pageId: first.page.pageId,
          expectedDigest: firstDrift.currentDigest,
          title: "First repaired",
        }),
        /body/u,
      );
      await assert.rejects(
        app.applyWikiChange({
          kind: "update-page",
          pageId: first.page.pageId,
          expectedDigest: firstDrift.currentDigest,
          title: "First repaired",
          body: "# First\n\nRepaired.\n",
        }),
        /description/u,
      );
      (app as unknown as { doctorFn: typeof doctor }).doctorFn = doctor;

      await app.applyWikiChange({
        kind: "update-page",
        pageId: first.page.pageId,
        expectedDigest: firstDrift.currentDigest,
        body: "# First\n\nRepaired.\n",
        description: "External first description.",
      });
      assert.equal((await wiki.inspectDrift(first.page.pageId)).drifted, false);
      assert.equal((await wiki.inspectDrift(second.page.pageId)).drifted, true);

      await app.applyWikiChange({
        kind: "update-page",
        pageId: second.page.pageId,
        expectedDigest: secondDrift.currentDigest,

        body: "# Second\n\nRepaired.\n",
      });
      assert.equal((await wiki.inspectDrift(first.page.pageId)).drifted, false);
      assert.equal((await wiki.inspectDrift(second.page.pageId)).drifted, false);
    } finally {
      await app.close();
      db.close();
    }
  }, 15_000);
  it("repairs malformed byte drift from the verified authored snapshot", async () => {
    const { app, db, paths, wiki } = fixture({ maintenance: true });
    try {
      const created = await app.createNote({
        path: "malformed-drift.md",
        description: "Authored description.",
        body: "# Authored\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      const malformed = Buffer.concat([
        Buffer.from("---\nid: broken\ntitle: [\n---\nMalformed.\n"),
        Buffer.from([0x80]),
      ]);
      await fs.writeFile(join(paths.wikiRoot, created.page.relativePath), malformed);
      const drift = await wiki.inspectDrift(created.page.pageId);
      assert.equal(drift.currentDigest, createHash("sha256").update(malformed).digest("hex"));
      await assert.rejects(
        app.applyWikiChange({
          kind: "update-page",
          pageId: created.page.pageId,
          expectedDigest: drift.currentDigest,
          title: "Repaired",
          body: "# Repaired\n\nCorrected.\n",
          quizWorthiness: "skip",
        }),
        /description/u,
      );

      const repaired = await app.applyWikiChange({
        kind: "update-page",
        pageId: created.page.pageId,
        expectedDigest: drift.currentDigest,
        title: "Repaired",
        description: "Repaired description.",
        body: "# Repaired\n\nCorrected.\n",
        quizWorthiness: "skip",
      });
      assert.equal(repaired.page?.title, "Repaired");
      assert.equal((await wiki.inspectDrift(created.page.pageId)).drifted, false);
      assert.equal(doctor(paths.vaultRoot).ok, true);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("rechecks unrelated drift after asynchronous qmd maintenance", async () => {
    const { app, db, paths, wiki } = fixture({ maintenance: true });
    try {
      const first = await app.createNote({
        path: "race-first.md",
        body: "# First\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      const second = await app.createNote({
        path: "race-second.md",
        body: "# Second\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      await fs.appendFile(join(paths.wikiRoot, first.page.relativePath), "\nExternal first edit.\n");
      await fs.appendFile(join(paths.wikiRoot, second.page.relativePath), "\nExternal second edit.\n");
      const firstDrift = await wiki.inspectDrift(first.page.pageId);
      const secondPath = join(paths.wikiRoot, second.page.relativePath);
      const qmd = wiki.adapters.qmd as { index: () => Promise<void> };
      let indexes = 0;
      qmd.index = async () => {
        indexes += 1;
        if (indexes === 3) await fs.appendFile(secondPath, "\nConcurrent second edit.\n");
      };

      await assert.rejects(
        app.applyWikiChange({
          kind: "update-page",
          pageId: first.page.pageId,
          expectedDigest: firstDrift.currentDigest,
          body: "# First\n\nRepaired.\n",
        }),
        /Preexisting wiki drift changed during mutation/u,
      );
      assert.match(await fs.readFile(secondPath, "utf8"), /Concurrent second edit/u);
      assert.equal((await wiki.inspectDrift(first.page.pageId)).drifted, true);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("resolves directly drifted linked issues with separate authored and live digest guards", async () => {
    const { app, db, paths, wiki } = fixture({ maintenance: true });
    try {
      const created = await app.createNote({
        path: "resolve-drifted-issue.md",
        body: "# Resolve drifted issue\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      const staleIssue = await wiki.report({
        pageId: created.page.pageId,
        heading: "Resolve drifted issue",
        description: "Correct the authored revision.",
      });
      const authoredRevision = await app.updateNote(created.page.pageId, {
        body: "# Resolve drifted issue\n\nAuthored revision.\n",
      });
      const validIssue = await wiki.report({
        pageId: created.page.pageId,
        heading: "Resolve drifted issue",
        description: "Correct the direct edit.",
      });
      await fs.appendFile(join(paths.wikiRoot, created.page.relativePath), "\nExternal direct edit.\n");
      const drift = await wiki.inspectDrift(created.page.pageId);
      const correctedBody = "# Resolve drifted issue\n\nCorrected.\n";

      await assert.rejects(
        app.applyWikiChange({
          kind: "resolve-issue",
          issueId: staleIssue.issueId,
          page: { pageId: created.page.pageId, expectedDigest: drift.currentDigest, body: correctedBody },
          resolution: "Corrected the authored revision.",
        }),
        /issue page version is stale/u,
      );
      await assert.rejects(
        app.applyWikiChange({
          kind: "resolve-issue",
          issueId: validIssue.issueId,
          page: { pageId: created.page.pageId, expectedDigest: authoredRevision.page.digest, body: correctedBody },
          resolution: "Corrected the direct edit.",
        }),
        /issue page digest is stale/u,
      );

      const resolved = await app.applyWikiChange({
        kind: "resolve-issue",
        issueId: validIssue.issueId,
        page: { pageId: created.page.pageId, expectedDigest: drift.currentDigest, body: correctedBody },
        resolution: "Corrected the direct edit.",
      });
      assert.equal(resolved.issue?.status, "resolved");
      assert.equal((await wiki.get(created.page.pageId)).status, "active");
      assert.equal((await wiki.inspectDrift(created.page.pageId)).drifted, false);
      assert.match((await wiki.get(created.page.pageId)).content, /Corrected/u);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("leaves unrelated drift bytes outside a targeted checkpoint", async () => {
    const { app, db, paths, wiki } = fixture({ maintenance: true });
    try {
      const first = await app.createNote({
        path: "checkpoint-first.md",
        body: "# First\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      const second = await app.createNote({
        path: "checkpoint-second.md",
        body: "# Second\n\nOriginal.\n",
        quizWorthiness: "skip",
      });
      localCheckpointCommit(paths, "test: baseline");
      await fs.appendFile(join(paths.wikiRoot, first.page.relativePath), "\nExternal first edit.\n");
      await fs.appendFile(join(paths.wikiRoot, second.page.relativePath), "\nExternal second edit.\n");
      const firstDrift = await wiki.inspectDrift(first.page.pageId);
      const secondDrift = await wiki.inspectDrift(second.page.pageId);
      (app as unknown as { commitFn: typeof localCheckpointCommit }).commitFn = localCheckpointCommit;

      await app.applyWikiChange({
        kind: "update-page",
        pageId: first.page.pageId,
        expectedDigest: firstDrift.currentDigest,
        body: "# First\n\nRepaired.\n",
      });
      const afterFirst = gitStatus(paths);
      assert.equal(afterFirst.raw.includes(second.page.relativePath), true);
      assert.equal(afterFirst.raw.includes(first.page.relativePath), false);

      await app.applyWikiChange({
        kind: "update-page",
        pageId: second.page.pageId,
        expectedDigest: secondDrift.currentDigest,
        body: "# Second\n\nRepaired.\n",
      });
      assert.equal(gitStatus(paths).clean, true);
    } finally {
      await app.close();
      db.close();
    }
  }, 15_000);

  it("refuses retirement with open or reopened linked issues without changing page bytes", async () => {
    const { app, db, paths, wiki } = fixture({ maintenance: true });
    try {
      for (const status of ["open", "reopened"] as const) {
        const created = await app.createNote({
          path: `blocked-retire-${status}.md`,
          body: `# Blocked ${status}\n`,
          quizWorthiness: "skip",
        });
        const issue = await wiki.report({
          pageId: created.page.pageId,
          heading: "Blocked",
          description: "Keep this page until corrected.",
        });
        if (status === "reopened") await wiki.patchIssue(issue.issueId, { status });
        const pagePath = join(paths.wikiRoot, created.page.relativePath);
        const beforeBytes = await fs.readFile(pagePath);
        await assert.rejects(
          app.applyWikiChange({
            kind: "retire-page",
            pageId: created.page.pageId,
            expectedDigest: created.page.digest,
          }),
          /open or reopened linked issue/u,
        );
        assert.equal((await fs.readFile(pagePath)).equals(beforeBytes), true);
        const after = await wiki.get(created.page.pageId);
        assert.equal(after.status, "active");
        assert.equal(after.digest, created.page.digest);
        assert.equal(after.revision, created.page.revision);
        assert.equal((await app.listIssues()).issues.find((item) => item.issueId === issue.issueId)?.status, status);
      }
    } finally {
      await app.close();
      db.close();
    }
  });

  it("persists EXTRACT_FAILED when extraction publication validation fails", async () => {
    const { app, db, paths } = fixture();
    try {
      await app.stageSource({ kind: "text", text: "extract me\n", name: "extract-failure.txt" });
      const claim = (await app.getExtractContext()).claims[0];
      if (!claim) throw new Error("extract claim is missing");
      await fs.appendFile(join(paths.vaultRoot, claim.extractedPath), "\nTampered extraction.\n");
      await assert.rejects(
        app.publishExtraction({
          claimId: claim.claimId,
          preparedId: claim.preparedId,
          digest: claim.digest,
          endpoints: [1],
        }),
      );
      const failure = db.get<{ status: string; error_code: string | null; error_message: string | null }>(
        "SELECT status, error_code, error_message FROM sources WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1",
      );
      assert.equal(failure?.status, "failed");
      assert.equal(failure?.error_code, "EXTRACT_FAILED");
      assert.equal(failure?.error_message, "prepared extraction digest mismatch");
      assert.ok(Buffer.byteLength(failure.error_message, "utf8") <= 500);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("recovers abandoned workflows through ScholarApplication", async () => {
    const { app, db } = fixture();
    try {
      const running = await app.beginWorkflow("lint");

      const recovered = await app.recoverAbandonedWorkflows();

      assert.equal(recovered.workflows.length, 1);
      assert.equal(recovered.workflows[0]?.requestId, running.workflow.requestId);
      assert.equal(recovered.workflows[0]?.status, "failed");
      assert.equal(recovered.workflows[0]?.errorCode, "PI_SESSION_INTERRUPTED");
      assert.equal(
        recovered.workflows[0]?.errorMessage,
        "The previous Pi session ended before completing this workflow.",
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("reports successful ingest and lint facts independently", async () => {
    const { app, db } = fixture();
    try {
      const ingest = await app.beginWorkflow("ingest");
      await app.finishWorkflow(ingest.workflow.requestId, "succeeded", {
        message: "ingest complete",
      });
      const lint = await app.beginWorkflow("lint");
      const lintResult = await app.finishWorkflow(lint.workflow.requestId, "succeeded", {
        message: "lint complete",
      });
      const failedIngest = await app.beginWorkflow("ingest");
      const failedIngestResult = await app.finishWorkflow(failedIngest.workflow.requestId, "failed", {
        message: "ingest failed",
        errorCode: "INGEST_FAILED",
        errorMessage: "source packet unavailable",
      });

      const facts = (await app.getSettings()).settings.facts;
      assert.equal(facts.lastIngestAt, failedIngestResult.workflow.finishedAt);
      assert.equal(facts.lastIngestResult, "failed (INGEST_FAILED): Workflow failed");
      assert.equal(facts.lastLintAt, lintResult.workflow.finishedAt);
      assert.equal(facts.lastLintResult, "lint complete");
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("ingest section-local citation boundaries", () => {
  it("requires an authorized citation in every substantive created section", async () => {
    const { app, db } = fixture({ maintenance: true });
    try {
      const chunkId = await publishedChunkId(app);
      await assert.rejects(
        app.applyIngestChange({
          kind: "create-page",
          path: "ingest-create-plain-rejected.md",
          body: "Uncited plain prose without a heading.\n",
        }),
        /immutable source chunk citation/u,
      );
      await assert.rejects(
        app.applyIngestChange({
          kind: "create-page",
          path: "ingest-create-rejected.md",
          body: `# Grounded\n\nClaim [^${chunkId}].\n\n## Uncited\n\nNew unsupported content.\n`,
        }),
        /immutable source chunk citation/u,
      );
      const created = await app.applyIngestChange({
        kind: "create-page",
        path: "ingest-create-accepted.md",
        body: `# Grounded\n\nClaim [^${chunkId}].\n\n## Grounded again\n\nMore support [^${chunkId}].\n`,
      });
      assert.equal(created.page?.relativePath, "ingest-create-accepted.md");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("requires citations in changed update sections instead of reusing unchanged cited sections", async () => {
    const { app, db, wiki } = fixture({ maintenance: true });
    try {
      const chunkId = await publishedChunkId(app);
      const original = await app.createNote({
        path: "ingest-update.md",
        body: `# Grounded\n\nExisting support [^${chunkId}].\n\n## Changed\n\nOriginal unsupported text.\n`,
        quizWorthiness: "skip",
      });
      const rejectedBody = `# Grounded\n\nExisting support [^${chunkId}].\n\n## Changed\n\nUpdated unsupported text.\n`;
      await assert.rejects(
        app.applyIngestChange({
          kind: "update-page",
          pageId: original.page.pageId,
          expectedDigest: original.page.digest,
          body: rejectedBody,
        }),
        /immutable source chunk citation/u,
      );
      assert.match((await wiki.get(original.page.pageId)).content, /Original unsupported text/u);
      const accepted = await app.applyIngestChange({
        kind: "update-page",
        pageId: original.page.pageId,
        expectedDigest: original.page.digest,
        body: `# Grounded\n\nExisting support [^${chunkId}].\n\n## Changed\n\nUpdated support [^${chunkId}].\n`,
      });
      assert.equal(accepted.page?.pageId, original.page.pageId);
      assert.match((await wiki.get(original.page.pageId)).content, /Updated support/u);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("treats ordinary footnote definitions as substantive changed evidence", async () => {
    const { app, db, wiki } = fixture({ maintenance: true });
    try {
      await publishedChunkId(app);
      const original = await app.createNote({
        path: "ingest-ordinary-footnote.md",
        body: "# Notes\n\nStable statement [^note].\n\n[^note]: Original note.\n",
        quizWorthiness: "skip",
      });
      await assert.rejects(
        app.applyIngestChange({
          kind: "update-page",
          pageId: original.page.pageId,
          expectedDigest: original.page.digest,
          body: "# Notes\n\nStable statement [^note].\n\n[^note]: Unsupported replacement.\n",
        }),
        /immutable source chunk citation/u,
      );
      assert.match((await wiki.get(original.page.pageId)).content, /Original note/u);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("pairs slug-colliding headings without inventing section changes", async () => {
    const { app, db } = fixture({ maintenance: true });
    try {
      const chunkId = await publishedChunkId(app);
      const original = await app.createNote({
        path: "ingest-colliding-headings.md",
        body: `# A\n\nOriginal support [^${chunkId}].\n\n# A-1\n\nUnchanged literal section.\n\n# A\n\nUnchanged duplicate section.\n`,
        quizWorthiness: "skip",
      });
      const updated = await app.applyIngestChange({
        kind: "update-page",
        pageId: original.page.pageId,
        expectedDigest: original.page.digest,
        body: `# A\n\nUpdated support [^${chunkId}].\n\n# A-1\n\nUnchanged literal section.\n\n# A\n\nUnchanged duplicate section.\n`,
      });
      assert.equal(updated.page?.pageId, original.page.pageId);
    } finally {
      await app.close();
      db.close();
    }
  });
  it("rejects empty headings that could merge uncited ingest claims", async () => {
    const { app, db } = fixture({ maintenance: true });
    try {
      const chunkId = await publishedChunkId(app);
      await assert.rejects(
        app.applyIngestChange({
          kind: "create-page",
          path: "ingest-empty-heading.md",
          body: `# Grounded\r\n\r\nClaim [^${chunkId}].\r\n\r\n##\r\n\r\nUnsupported claim.\r\n`,
        }),
        /non-empty headings/u,
      );
      const existing = await app.createNote({
        path: "authored-empty-heading.md",
        body: `# Grounded\n\nClaim [^${chunkId}].\n\n##\n\nOriginal unsupported claim.\n`,
        quizWorthiness: "skip",
      });
      await assert.rejects(
        app.applyIngestChange({
          kind: "update-page",
          pageId: existing.page.pageId,
          expectedDigest: existing.page.digest,
          body: `# Grounded\n\nClaim [^${chunkId}].\n\nChanged unsupported claim.\n`,
        }),
        /non-empty headings/u,
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("requires citations in changed resolve-issue sections instead of reusing unchanged cited sections", async () => {
    const { app, db, wiki } = fixture({ maintenance: true });
    try {
      const chunkId = await publishedChunkId(app);
      const original = await app.createNote({
        path: "ingest-resolve.md",
        body: `# Grounded\n\nExisting support [^${chunkId}].\n\n## Changed\n\nOriginal unsupported text.\n`,
        quizWorthiness: "skip",
      });
      const issue = await wiki.report({
        pageId: original.page.pageId,
        pageDigest: original.page.digest,
        heading: "Changed",
        kind: "incorrect",
        description: "Correct the changed section.",
      });
      await assert.rejects(
        app.applyIngestChange({
          kind: "resolve-issue",
          issueId: issue.issueId,
          page: {
            pageId: original.page.pageId,
            expectedDigest: original.page.digest,
            body: `# Grounded\n\nExisting support [^${chunkId}].\n\n## Changed\n\nCorrected unsupported text.\n`,
          },
          resolution: "Correction needs source evidence.",
        }),
        /immutable source chunk citation/u,
      );
      assert.equal((await app.listIssues()).issues.find((item) => item.issueId === issue.issueId)?.status, "open");
      const resolved = await app.applyIngestChange({
        kind: "resolve-issue",
        issueId: issue.issueId,
        page: {
          pageId: original.page.pageId,
          expectedDigest: original.page.digest,
          body: `# Grounded\n\nExisting support [^${chunkId}].\n\n## Changed\n\nCorrected support [^${chunkId}].\n`,
        },
        resolution: "Correction is grounded in the cited source chunk.",
      });
      assert.equal(resolved.issue?.status, "resolved");
      assert.match((await wiki.get(original.page.pageId)).content, /Corrected support/u);
    } finally {
      await app.close();
      db.close();
    }
  });
});
