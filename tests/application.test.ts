import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { ScholarApplication } from "../src/application/application.js";
import type { GradingContext } from "../src/contracts.js";
import { openDatabase } from "../src/database.js";
import { doctor } from "../src/doctor.js";
import { localDate } from "../src/scheduler.js";
import { initVault } from "../src/vault.js";
import { WikiService } from "../src/wiki.js";

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

function fixture(options: { readonly maintenance?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-scholar-durable-"));
  const paths = initVault(join(root, "vault"));
  const db = openDatabase(paths);
  const calls: string[] = [];
  const app = new ScholarApplication({
    paths,
    db,
    adapters: options.maintenance ? { wiki: { qmd: { search: () => [], index: async () => undefined } } } : undefined,
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
  return { app, db, paths, calls };
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
      const context = await app.getAdmissionContext();
      const claim = context.claims[0];
      if (!claim) throw new Error("admission claim is missing");
      const input = { claimId: claim.claimId, preparedId: claim.preparedId, digest: claim.digest };
      (db as unknown as { checkpoint: () => void }).checkpoint = () => {
        throw new Error("checkpoint failed after publication");
      };
      await assert.rejects(app.admitSource(input), (error: unknown) => {
        if (error === null || typeof error !== "object" || !("code" in error) || !("details" in error)) return false;
        assert.equal(error.code, "MUTATION_APPLIED_FINALIZATION_FAILED");
        assert.deepEqual(error.details, { applied: true, retryable: false, stage: "checkpoint" });
        return true;
      });
      const row = db.get<{ source_id: string; status: string; error_code: string | null }>(
        "SELECT source_id, status, error_code FROM sources",
      );
      assert.equal(row?.status, "published");
      assert.equal(row?.error_code, null);
      const retry = await app.admitSource(input);
      assert.equal(retry.sourceId, row?.source_id);
      assert.equal(
        db.get<{ status: string; error_code: string | null }>(
          "SELECT status, error_code FROM sources WHERE source_id = ?",
          [retry.sourceId],
        )?.status,
        "published",
      );
    } finally {
      (db as unknown as { checkpoint: () => void }).checkpoint = originalCheckpoint;
      await app.close();
      db.close();
    }
  });
  it("refreshes OKF projections after source removal drifts a dependent page", async () => {
    const { app, db, paths } = fixture();
    try {
      await app.stageSource({ kind: "text", text: "evidence\n", name: "evidence.txt" });
      const claim = (await app.getAdmissionContext()).claims[0];
      if (!claim) throw new Error("admission claim is missing");
      const admitted = await app.admitSource({
        claimId: claim.claimId,
        preparedId: claim.preparedId,
        digest: claim.digest,
      });
      const page = await app.createNote({
        path: "grounded.md",
        body: `# Grounded\n\nClaim.[^${admitted.sourceId}:0]`,
      });
      const preview = await app.removalPreview(admitted.sourceId);
      assert.deepEqual(preview.dependentPageIds, [page.page.pageId]);
      const wikiCandidate: unknown = Reflect.get(app, "wiki");
      assert.ok(wikiCandidate instanceof WikiService);
      const wiki = wikiCandidate;
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
  it("restores a page issue exactly when commit fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-rollback-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const app = new ScholarApplication({
      paths,
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
      const page = await app.wiki.create({ path: "rollback.md", body: originalBody, quizWorthiness: "eligible" });
      const issue = await app.wiki.report({
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
        app.applyMaintenance({
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
    const app = new ScholarApplication({
      paths,
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
      const page = await app.wiki.create({ path: "page-rollback.md", body: "before\n", quizWorthiness: "skip" });
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
        app.applyMaintenance({
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
              kind: "short-answer",
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
  it("rejects duplicate single-page coverage before persisting a quiz", async () => {
    const { app, db } = fixture();
    const date = localDate(new Date());
    const page = await app.wiki.create({
      path: "publication-page.md",
      title: "Publication page",
      body: "# Section\n\nSection text\n",
      quizWorthiness: "eligible",
    });
    const pageId = page.page.pageId;
    app.scheduler.ensurePageLearning(pageId, `${date}T00:00:00.000Z`);
    await app.updateSettings({ initializationEnabled: false });
    try {
      const context = await app.getQuizContext({ date });
      const reference = context.evidence?.find((item) => item.pageId === pageId)?.reference;
      assert.ok(reference);
      const question = {
        kind: "short-answer" as const,
        prompt: "Explain the section",
        pages: [{ pageId, criterion: "Explain the section", weight: 1 }],
        sourceRefs: [reference],
      };
      await assert.rejects(
        app.publishQuiz({ status: "published", date, questions: [question, question] }),
        /exactly one single-page question/u,
      );
      assert.equal(app.quiz.get(date), undefined);
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
async function gradingFixture() {
  const fixtureValue = fixture();
  const { app } = fixtureValue;
  const date = localDate(new Date());
  const page = await app.wiki.create({
    path: "page-1.md",
    title: "Page 1",
    body: "# Section\n\nSection text\n",
    quizWorthiness: "eligible",
  });
  const pageId = page.page.pageId;
  app.scheduler.ensurePageLearning(pageId, `${date}T00:00:00.000Z`);
  const quiz = app.quiz.createDailyQuiz({
    date,
    selectedPageIds: [pageId],
    questionSpecs: [
      {
        kind: "short-answer",
        prompt: "Explain the section",
        pages: [{ pageId, criterion: "Explain the section", weight: 1 }],
        sourceRefs: [],
      },
    ],
  });
  const questionId = quiz.questions[0]?.questionId;
  if (!questionId) throw new Error("grading fixture question missing");
  const draft = app.quiz.saveDraft({ date, revision: quiz.revision, answers: { [questionId]: "answer" } });
  return { ...fixtureValue, date, pageId, questionId, quiz: app.quiz.get(date)!, draft };
}
async function prerequisiteFixture() {
  const fixtureValue = fixture({ maintenance: true });
  const { app } = fixtureValue;
  const dependent = await app.wiki.create({
    path: "dependent.md",
    title: "Dependent",
    body: "# Section\n\ndependent\n",
    quizWorthiness: "eligible",
  });
  const prerequisite = await app.wiki.create({
    path: "prerequisite.md",
    title: "Prerequisite",
    body: "# Section\n\nprerequisite\n",
    quizWorthiness: "eligible",
  });
  app.scheduler.ensurePageLearning(dependent.page.pageId);
  app.scheduler.ensurePageLearning(prerequisite.page.pageId);
  app.scheduler.setPrerequisites(dependent.page.pageId, [prerequisite.page.pageId]);
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
      const listedWorkflow = (await app.listWorkflows()).workflows.find((workflow) => workflow.requestId === requestId);
      assert.ok(listedWorkflow);
      assert.equal("message" in listedWorkflow, false);
      assert.equal(listedWorkflow.status, "queued");
      await app.getGradingContext({ date }, owner);
      const detail = await app.getWorkflow(requestId);
      assert.equal(detail.status, "running");
      assert.equal(detail.progress, 0);
      assert.equal("message" in detail, false);
      const statusWorkflow = (await app.status()).workflows.find((workflow) => workflow.requestId === requestId);
      assert.ok(statusWorkflow);
      assert.equal("message" in statusWorkflow, false);
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
    const { app, db, pageId } = await gradingFixture();
    try {
      const before = await app.wiki.get(pageId);
      await assert.rejects(app.updateNote(pageId, { body: "# Section\n\nchanged\n" }), /unresolved quiz/u);
      const after = await app.wiki.get(pageId);
      assert.equal(after.content, before.content);
      assert.equal(after.digest, before.digest);
      assert.equal(after.revision, before.revision);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("blocks an update covered by a submitted but unsettled quiz without changing the page", async () => {
    const { app, db, date, pageId, draft } = await gradingFixture();
    try {
      const sealed = await app.sealSubmission(date, { expectedRevision: draft.revision });
      assert.equal(sealed.quiz.status, "submitted");
      assert.equal(db.all("SELECT 1 FROM page_results WHERE quiz_id = ?", [sealed.quiz.quizId]).length, 0);
      const before = await app.wiki.get(pageId);
      await assert.rejects(app.updateNote(pageId, { body: "# Section\n\nchanged\n" }), /unresolved quiz/u);
      const after = await app.wiki.get(pageId);
      assert.equal(after.content, before.content);
      assert.equal(after.digest, before.digest);
      assert.equal(after.revision, before.revision);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("allows an update after the covered quiz is settled", async () => {
    const { app, db, date, pageId, questionId, draft } = await gradingFixture();
    const owner = randomUUID();
    try {
      await app.sealSubmission(date, { expectedRevision: draft.revision });
      const context = await app.getGradingContext({ date }, owner);
      const evidence = context.evidence?.find((item) => item.pageId === pageId)?.reference;
      assert.ok(evidence);
      await app.settleGrade(gradeFor(context, pageId, questionId, [evidence]), owner);
      const before = await app.wiki.get(pageId);
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
    const { app, db, dependent } = await prerequisiteFixture();
    try {
      const before = await app.wiki.get(dependent.pageId);
      const beforePrerequisites = db.all<Record<string, unknown>>(
        "SELECT page_id, prerequisite_page_id FROM page_prerequisites ORDER BY page_id, prerequisite_page_id",
      );
      await assert.rejects(app.updateNote(dependent.pageId, { quizWorthiness: "skip" }), /prerequisites/u);
      const after = await app.wiki.get(dependent.pageId);
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
    const { app, db, prerequisite } = await prerequisiteFixture();
    try {
      const before = await app.wiki.get(prerequisite.pageId);
      const beforePrerequisites = db.all<Record<string, unknown>>(
        "SELECT page_id, prerequisite_page_id FROM page_prerequisites ORDER BY page_id, prerequisite_page_id",
      );
      await assert.rejects(
        app.applyMaintenance({
          kind: "update-page",
          pageId: prerequisite.pageId,
          expectedDigest: before.digest,
          body: "# Section\n\nchanged\n",
          quizWorthiness: "unknown",
        }),
        /prerequisites/u,
      );
      const after = await app.wiki.get(prerequisite.pageId);
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
    const { app, db, dependent } = await prerequisiteFixture();
    try {
      const issue = await app.wiki.report({
        pageId: dependent.pageId,
        heading: "Section",
        description: "Correct the section.",
      });
      const before = await app.wiki.get(dependent.pageId);
      const beforePrerequisites = db.all<Record<string, unknown>>(
        "SELECT page_id, prerequisite_page_id FROM page_prerequisites ORDER BY page_id, prerequisite_page_id",
      );
      await assert.rejects(
        app.applyMaintenance({
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
      const after = await app.wiki.get(dependent.pageId);
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
    const { app, db, prerequisite } = await prerequisiteFixture();
    try {
      const first = await app.wiki.get(prerequisite.pageId);
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
