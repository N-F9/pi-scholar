import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { openDatabase, type ScholarDatabase } from "../src/database.js";
import { QuizConflictError, QuizService } from "../src/quiz.js";
import { localDate, SchedulerService, ValidationError } from "../src/scheduler.js";

const LEARNING_WIKI_ROOT = mkdtempSync(join(tmpdir(), "pi-scholar-learning-"));
const PAGE_MARKDOWN = `${[
  "# Part",
  "section text",
  "# A",
  "section text",
  "# B",
  "section text",
  "# Later",
  "later section text",
].join("\n")}\n`;
afterAll(() => rmSync(LEARNING_WIKI_ROOT, { recursive: true, force: true }));

function addPage(db: ScholarDatabase, pageId: string, markdown = PAGE_MARKDOWN): void {
  writeFileSync(join(LEARNING_WIKI_ROOT, `${pageId}.md`), markdown);
  const digest = createHash("sha256").update(markdown).digest("hex");
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO pages (page_id, relative_path, title, digest, revision, status, quiz_worthiness, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'eligible', ?, ?)",
    [pageId, `${pageId}.md`, pageId, digest, now, now],
  );
}

function setup() {
  const db = openDatabase(":memory:");
  addPage(db, "p1");
  addPage(db, "p2");
  return { db, scheduler: new SchedulerService(db), date: localDate(new Date()) };
}

function ensureDue(scheduler: SchedulerService, pageIds: readonly string[], date: string): void {
  for (const pageId of pageIds) scheduler.ensurePageLearning(pageId, `${date}T00:00:00.000Z`);
}

function question(pageId: string, prompt = "Explain the page") {
  return {
    kind: "short-answer" as const,
    prompt,
    pages: [{ pageId, criterion: `Explain ${pageId}`, weight: 1 }],
    sourceRefs: [],
  };
}

test("page prerequisites gate due selection until every prerequisite is in Review and reject cycles", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1", "p2"], date);
  scheduler.setPrerequisites("p2", ["p1"]);
  assert.deepEqual(scheduler.listPrerequisites("p2"), [{ pageId: "p2", prerequisitePageId: "p1" }]);
  assert.deepEqual(
    scheduler.selectDuePages(date, 4).map((page) => page.pageId),
    ["p1"],
  );
  db.run("INSERT INTO quizzes (quiz_id, date, revision, status) VALUES (?, ?, 1, 'open')", ["prerequisite-quiz", date]);

  const review = scheduler.transitionPage("p1", "Easy", `${date}T12:00:00.000Z`, {
    quizId: "prerequisite-quiz",
    submissionId: "prerequisite-submission",
    revision: 1,
  });
  assert.equal(review.pageId, "p1");
  assert.equal(scheduler.getPageLearning("p1").fsrsState, "Review");
  assert.deepEqual(
    scheduler.selectDuePages(date, 4).map((page) => page.pageId),
    ["p2"],
  );
  assert.throws(() => scheduler.setPrerequisites("p1", ["p2"]), ValidationError);
  assert.throws(() => scheduler.setPrerequisites("p1", ["p1"]), ValidationError);
  assert.throws(() => scheduler.setPrerequisites("p2", ["missing-page"]), ValidationError);
  db.close();
});

test("setPrerequisites rejects skipped or unknown endpoints without creating state", () => {
  {
    const { db, scheduler } = setup();
    db.run("UPDATE pages SET quiz_worthiness = 'skip' WHERE page_id = ?", ["p2"]);
    assert.throws(() => scheduler.setPrerequisites("p2", ["p1"]), ValidationError);
    assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM page_learning")?.count, 0);
    assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM page_prerequisites")?.count, 0);
    db.close();
  }
  {
    const { db, scheduler } = setup();
    db.run("UPDATE pages SET quiz_worthiness = 'unknown' WHERE page_id = ?", ["p2"]);
    assert.throws(() => scheduler.setPrerequisites("p2", ["p1"]), ValidationError);
    assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM page_learning")?.count, 0);
    assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM page_prerequisites")?.count, 0);
    db.close();
  }
  {
    const { db, scheduler } = setup();
    db.run("UPDATE pages SET quiz_worthiness = 'skip' WHERE page_id = ?", ["p1"]);
    assert.throws(() => scheduler.setPrerequisites("p2", ["p1"]), ValidationError);
    assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM page_learning")?.count, 0);
    assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM page_prerequisites")?.count, 0);
    db.close();
  }
  {
    const { db, scheduler } = setup();
    db.run("UPDATE pages SET quiz_worthiness = 'unknown' WHERE page_id = ?", ["p1"]);
    assert.throws(() => scheduler.setPrerequisites("p2", ["p1"]), ValidationError);
    assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM page_learning")?.count, 0);
    assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM page_prerequisites")?.count, 0);
    db.close();
  }
});

test("page learning is created on demand, keeps stable IDs, and excludes drifted or retired pages", () => {
  const { db, scheduler, date } = setup();
  const first = scheduler.ensurePageLearning("p1", `${date}T00:00:00.000Z`);
  assert.equal(first.pageId, "p1");
  assert.equal(scheduler.ensurePageLearning("p1").revision, first.revision);
  assert.deepEqual(
    scheduler.listPageLearning().map((page) => page.pageId),
    ["p1"],
  );

  assert.ok(scheduler.eligiblePages(date).some((page) => page.pageId === "p2"));
  assert.equal(scheduler.getPageLearning("p2").pageId, "p2");
  db.run("UPDATE pages SET relative_path = ?, title = ?, revision = revision + 1 WHERE page_id = ?", [
    "renamed.md",
    "Renamed page",
    "p1",
  ]);
  assert.equal(scheduler.getPageLearning("p1").pageId, "p1");

  addPage(db, "p3");
  ensureDue(scheduler, ["p2", "p3"], date);
  db.run("UPDATE pages SET status = 'drifted' WHERE page_id = ?", ["p2"]);
  db.run("UPDATE pages SET status = 'retired' WHERE page_id = ?", ["p3"]);
  assert.deepEqual(
    scheduler.selectDuePages(date, 4).map((page) => page.pageId),
    ["p1"],
  );
  db.close();
});

test("due page selection is bounded and coverage reports pages without learning state", () => {
  const { db, scheduler, date } = setup();
  const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
  for (const pageId of ids.slice(2)) addPage(db, pageId);
  ensureDue(scheduler, ids, date);
  const selected = scheduler.selectDuePages(date, 4);
  assert.equal(selected.length, 4);
  assert.deepEqual(
    selected.map((page) => page.pageId),
    ids.slice(0, 4),
  );

  addPage(db, "untracked");
  const coverage = scheduler.validateCoverage();
  assert.equal(coverage.ok, false);
  assert.deepEqual(coverage.missingPageIds, ["untracked"]);
  db.close();
});

test("open quiz sheets use opaque comments, numeric headings, and no learner metadata", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: ["p1"],
    questionSpecs: [question("p1")],
  });
  const questionId = generated.questions[0]!.questionId;
  assert.match(questionId, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/u);
  const sheet = quiz.renderSheet(generated);
  assert.match(sheet, /<!-- pi-scholar:quiz format=1 id=[^ ]+ revision=1 -->/u);
  assert.match(sheet, /<!-- pi-scholar:question id=[0-9a-f-]+ -->/u);
  const headings = [...sheet.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => match[1]!.trim());
  assert.ok(headings.length > 0);
  assert.ok(headings.every((heading) => /^\d+(?:[.)]|\s)/u.test(heading)));
  for (const forbidden of [
    "p1",
    "#part",
    "sourceRefs",
    "evidence",
    "criterion",
    "rubric",
    "answer-key",
    "pageDigest",
    "textDigest",
    "reviewId",
    "rating",
    "FSRS",
  ])
    assert.equal(sheet.includes(forbidden), false, `open sheet leaked ${forbidden}`);
  assert.equal(quiz.parseSheet(sheet).quizId, generated.quizId);
  assert.throws(() => quiz.parseSheet(`${sheet}\n## rubric\nprivate metadata`), ValidationError);
  db.close();
});
test("quiz rejects repeated single-page coverage before persistence", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  assert.throws(
    () =>
      quiz.createDailyQuiz({
        date,
        selectedPageIds: ["p1"],
        questionSpecs: [question("p1", "First explanation"), question("p1", "Second explanation")],
      }),
    (error) => error instanceof ValidationError && /exactly one single-page question/u.test(error.message),
  );
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quizzes")?.count, 0);
  db.close();
});

test("grading snapshots page sections directly and settles one FSRS transition per page bundle", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1", "p2"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: ["p1", "p2"],
    questionSpecs: [
      question("p1", "First explanation"),
      question("p2", "Second explanation"),
      {
        kind: "short-answer" as const,
        prompt: "Compare both pages",
        pages: [
          { pageId: "p1", criterion: "Compare p1", weight: 1 },
          { pageId: "p2", criterion: "Compare p2", weight: 1 },
        ],
        sourceRefs: [],
      },
    ],
  });
  const evidence = quiz.gradingEvidence(generated);
  const pageEvidence = evidence.filter((item) => item.pageId === "p1");
  assert.ok(pageEvidence.length > 0);
  assert.deepEqual(pageEvidence.map((item) => item.anchor).sort(), ["#a", "#b", "#later", "#part"]);
  assert.ok(pageEvidence.some((item) => item.excerpt.includes("section text")));
  const evidenceColumns = db.all<{ name: string }>("PRAGMA table_info(quiz_evidence)").map((column) => column.name);
  assert.ok(evidenceColumns.includes("page_id"));
  assert.ok(evidenceColumns.includes("anchor"));
  assert.ok(evidenceColumns.includes("excerpt"));
  assert.equal(evidenceColumns.includes("card_id"), false);

  const draft = quiz.saveDraft(generated.date, generated.revision, {
    [generated.questions[0]!.questionId]: "first answer",
    [generated.questions[1]!.questionId]: "second answer",
    [generated.questions[2]!.questionId]: "comparison answer",
  });
  const sealed = quiz.sealSubmission(generated.date, draft.revision);
  const authorized = quiz.gradingEvidence(sealed).find((item) => item.pageId === "p1")!;
  const authorizedP2 = quiz.gradingEvidence(sealed).find((item) => item.pageId === "p2")!;
  const grade = {
    requestId: "page-bundle-request",
    date: generated.date,
    revision: sealed.revision,
    submissionId: "page-bundle-submission",
    questions: generated.questions.map((item) => ({ questionId: item.questionId, feedback: "Review the distinction" })),
    pages: [
      {
        pageId: "p1",
        rating: "Good" as const,
        feedback: "Understood",
        evidence: [authorized.reference],
        readings: [{ pageId: "p1", anchor: authorized.anchor }],
      },
      {
        pageId: "p2",
        rating: "Good" as const,
        feedback: "Understood",
        evidence: [authorizedP2.reference],
        readings: [{ pageId: "p2", anchor: authorizedP2.anchor }],
      },
    ],
  };
  const settled = quiz.settleGrade(grade);
  assert.equal(settled.pages.length, 2);
  assert.equal(settled.pages[0]!.pageId, "p1");
  assert.equal(settled.pages[1]!.pageId, "p2");
  assert.equal(settled.pages[0]!.evidence.length, 1);
  assert.equal(settled.pages[0]!.readings.length, 1);
  assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [generated.quizId]).length, 2);
  assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [generated.quizId]).length, 2);
  assert.equal(db.all("SELECT * FROM question_results WHERE quiz_id = ?", [generated.quizId]).length, 3);
  assert.equal(scheduler.pageHistory("p1").length, 1);
  assert.equal(scheduler.pageHistory("p2").length, 1);

  const retry = quiz.settleGrade(grade);
  assert.equal(retry.pages.length, 2);
  assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [generated.quizId]).length, 2);
  assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [generated.quizId]).length, 2);
  db.close();
});

test("grading rejects fabricated or stale direct evidence before page transition", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({ date, selectedPageIds: ["p1"], questionSpecs: [question("p1")] });
  const draft = quiz.saveDraft(generated.date, generated.revision, { [generated.questions[0]!.questionId]: "answer" });
  const sealed = quiz.sealSubmission(generated.date, draft.revision);
  const authorized = quiz.gradingEvidence(sealed).find((item) => item.pageId === "p1")!;
  const makeGrade = (reference: string) => ({
    requestId: randomUUID(),
    date: generated.date,
    revision: sealed.revision,
    submissionId: randomUUID(),
    questions: [{ questionId: generated.questions[0]!.questionId, feedback: "feedback" }],
    pages: [{ pageId: "p1", rating: "Good" as const, evidence: [reference] }],
  });
  assert.throws(() => quiz.settleGrade(makeGrade("fabricated-reference")), ValidationError);
  assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  writeFileSync(
    join(LEARNING_WIKI_ROOT, "p1.md"),
    PAGE_MARKDOWN.replace("# Part\nsection text", "# Part\nchanged section text"),
  );
  assert.throws(() => quiz.settleGrade(makeGrade(authorized.reference)), ValidationError);
  assert.equal(scheduler.getPageLearning("p1").fsrsState, "New");
  assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  db.close();
});

test("quiz revision checks prevent stale drafts and grading an open revision", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({ date, selectedPageIds: ["p1"], questionSpecs: [question("p1")] });
  const draft = quiz.saveDraft(generated.date, generated.revision, { [generated.questions[0]!.questionId]: "answer" });
  const openGrade = {
    requestId: "open-request",
    date,
    revision: generated.revision,
    submissionId: "open",
    questions: [],
    pages: [],
  };
  assert.throws(() => quiz.settleGrade(openGrade), QuizConflictError);
  assert.throws(() => quiz.sealSubmission(generated.date, generated.revision));
  quiz.sealSubmission(generated.date, draft.revision);
  db.close();
});

test("quiz enforces the four-question publication bound", () => {
  const { db, scheduler, date } = setup();
  const pageIds = ["p1", "p2", "p3", "p4", "p5"];
  for (const pageId of pageIds.slice(2)) addPage(db, pageId);
  ensureDue(scheduler, pageIds, date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  assert.throws(
    () =>
      quiz.createDailyQuiz({
        date,
        selectedPageIds: pageIds,
        questionSpecs: pageIds.map((pageId) => question(pageId)),
      }),
    ValidationError,
  );
  db.close();
});
