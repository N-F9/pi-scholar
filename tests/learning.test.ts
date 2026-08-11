import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { openDatabase, type ScholarDatabase } from "../src/database.js";
import { QuizConflictError, QuizService } from "../src/quiz.js";
import { localDate, SchedulerService, ValidationError } from "../src/scheduler.js";
import { parseWikiBodySections, parseWikiDocumentSections } from "../src/wiki-sections.js";

const LEARNING_WIKI_ROOT = mkdtempSync(join(tmpdir(), "pi-scholar-learning-"));
const PAGE_BODY = `${[
  "# Part",
  "section text",
  "# A",
  "section text",
  "# B",
  "section text",
  "# Later",
  "later section text",
].join("\n")}\n`;
function pageDocument(pageId: string, body: string): string {
  return `---\ntype: note\nid: ${pageId}\ntitle: ${pageId}\ndescription: ${pageId} description\n---\n${body}`;
}
const PAGE_MARKDOWN = pageDocument("p1", PAGE_BODY);
afterAll(() => rmSync(LEARNING_WIKI_ROOT, { recursive: true, force: true }));

function addPage(db: ScholarDatabase, pageId: string, markdown = PAGE_BODY): void {
  const document = markdown.startsWith("---\n") ? markdown : pageDocument(pageId, markdown);
  writeFileSync(join(LEARNING_WIKI_ROOT, `${pageId}.md`), document);
  const digest = createHash("sha256").update(document).digest("hex");
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
    kind: "free-response" as const,
    prompt,
    pages: [{ pageId, criterion: `Explain ${pageId}`, weight: 1 }],
    sourceRefs: [],
  };
}
test("section parsers keep headed preambles and exclude OKF frontmatter", () => {
  const body = "Meaningful preamble.\n\n# Heading\n\nHeading text.\n";
  const document = pageDocument("parser", body);
  const bodySections = parseWikiBodySections(body, "parser");
  assert.deepEqual(
    bodySections.map((section) => ({ anchor: section.anchor, heading: section.heading })),
    [
      { anchor: "", heading: undefined },
      { anchor: "#heading", heading: "Heading" },
    ],
  );
  const commentPreambleSections = parseWikiBodySections(
    "<!-- comment-only -->\n\n# Heading\n\nHeading text.\n",
    "parser",
  );
  assert.deepEqual(
    commentPreambleSections.map((section) => section.anchor),
    ["#heading"],
  );
  assert.deepEqual(parseWikiBodySections("<!-- comment-only -->\n", "parser"), []);
  const headinglessSections = parseWikiBodySections("Only page text.\n", "parser");
  assert.deepEqual(
    headinglessSections.map((section) => ({ anchor: section.anchor, heading: section.heading })),
    [{ anchor: "", heading: undefined }],
  );
  const documentSections = parseWikiDocumentSections(document, "parser");
  assert.equal(documentSections.length, 2);
  assert.equal(
    document.slice(documentSections[0]!.startOffset, documentSections[0]!.endOffset),
    "Meaningful preamble.\n\n",
  );
  assert.equal(
    document.slice(documentSections[1]!.startOffset, documentSections[1]!.endOffset),
    "# Heading\n\nHeading text.\n",
  );
  assert.equal(documentSections[0]!.startOffset, document.indexOf(body));
  assert.equal(documentSections[0]!.textDigest, createHash("sha256").update("Meaningful preamble.\n\n").digest("hex"));
  assert.equal(
    document.slice(documentSections[0]!.startOffset, documentSections[0]!.endOffset).includes("description"),
    false,
  );
});

test("headingless eligible pages publish page evidence and authorize page-only readings", () => {
  const { db, scheduler, date } = setup();
  addPage(db, "headingless", pageDocument("headingless", "Only page-level exposition.\n"));
  ensureDue(scheduler, ["headingless"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: ["headingless"],
    questionSpecs: [question("headingless")],
  });
  const evidence = quiz.gradingEvidence(generated);
  assert.deepEqual(
    evidence.map((item) => item.anchor),
    [""],
  );
  assert.equal(evidence[0]?.heading, undefined);
  assert.equal(evidence[0]?.excerpt.includes("---"), false);
  const questionId = generated.questions[0]!.questionId;
  const draft = quiz.saveDraft({ date, revision: generated.revision, answers: { [questionId]: "answer" } });
  const sealed = quiz.sealSubmission({ date, revision: draft.revision });
  const authorized = quiz.gradingEvidence(sealed)[0]!;
  const settled = quiz.settleGrade({
    date,
    revision: sealed.revision,
    submissionId: "headingless-submission",
    questions: [{ questionId, feedback: "Good explanation." }],
    pages: [
      {
        pageId: "headingless",
        rating: "Good",
        evidence: [authorized.reference],
        readings: [{ pageId: "headingless", anchor: "" }],
      },
    ],
  });
  assert.equal(settled.pages[0]!.readings[0]!.anchor, "");
  assert.equal(quiz.readingHref({ pageId: "headingless", anchor: "" }), "wiki/headingless.md");
  db.close();
});
test("grading rejects malformed stored evidence paths without a live vault", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({ date, selectedPageIds: ["p1"], questionSpecs: [question("p1")] });
  db.run("UPDATE quiz_evidence SET relative_path = ? WHERE quiz_id = ?", ["../escape.md", generated.quizId]);
  const snapshotOnly = new QuizService(db, undefined, scheduler);
  assert.throws(() => snapshotOnly.gradingEvidence(generated), ValidationError);
  db.close();
});

test("page prerequisites gate due selection until every prerequisite is in Review and reject cycles", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1", "p2"], date);
  scheduler.setPrerequisites("p2", ["p1"]);
  assert.deepEqual(scheduler.listPrerequisites("p2"), [{ pageId: "p2", prerequisitePageId: "p1" }]);
  assert.deepEqual(
    scheduler.eligiblePages(date).map((page) => page.pageId),
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
    scheduler.eligiblePages(date).map((page) => page.pageId),
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
    scheduler.eligiblePages(date).map((page) => page.pageId),
    ["p1"],
  );
  db.close();
});

test("due page eligibility includes all due pages and coverage reports pages without learning state", () => {
  const { db, scheduler, date } = setup();
  const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
  for (const pageId of ids.slice(2)) addPage(db, pageId);
  ensureDue(scheduler, ids, date);
  const selected = scheduler.eligiblePages(date);
  assert.equal(selected.length, ids.length);
  assert.deepEqual(
    selected.map((page) => page.pageId),
    ids,
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
test("quiz permits multiple questions sampling distinct sections of one page", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: ["p1"],
    questionSpecs: [
      {
        ...question("p1", "Explain the first section"),
        pages: [{ pageId: "p1", criterion: "Explain #part", weight: 1 }],
      },
      {
        ...question("p1", "Explain the second section"),
        pages: [{ pageId: "p1", criterion: "Explain #a", weight: 1 }],
      },
    ],
  });
  assert.equal(generated.questions.length, 2);
  assert.deepEqual(
    generated.questions.map((item) => item.pages[0]?.criterion),
    ["Explain #part", "Explain #a"],
  );
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quizzes")?.count, 1);
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
        kind: "free-response" as const,
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
        feedback: "P1 feedback",
        evidence: [authorized.reference],
        readings: [{ pageId: "p1", anchor: authorized.anchor }],
      },
      {
        pageId: "p2",
        rating: "Good" as const,
        feedback: "P2 feedback",
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
  const sheet = quiz.renderSheet(settled.quiz, undefined, settled.questions, settled.pages);
  const p1Feedback = sheet.indexOf("P1 feedback");
  const p1Reading = sheet.indexOf(`- [Reading 1](${quiz.readingHref(settled.pages[0]!.readings[0]!)})`);
  const p2Feedback = sheet.indexOf("P2 feedback");
  const p2Reading = sheet.indexOf(`- [Reading 1](${quiz.readingHref(settled.pages[1]!.readings[0]!)})`);
  assert.ok(p1Feedback >= 0 && p1Reading > p1Feedback);
  assert.ok(p2Feedback > p1Reading && p2Reading > p2Feedback);
  assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [generated.quizId]).length, 2);
  assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [generated.quizId]).length, 2);
  assert.equal(db.all("SELECT * FROM question_results WHERE quiz_id = ?", [generated.quizId]).length, 3);
  assert.equal(scheduler.pageHistory("p1").length, 1);
  assert.equal(scheduler.pageHistory("p2").length, 1);
  assert.equal(scheduler.getPageLearning("p1").reps, 1);
  assert.equal(scheduler.getPageLearning("p2").reps, 1);

  const retry = quiz.settleGrade(grade);
  assert.equal(retry.pages.length, 2);
  assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [generated.quizId]).length, 2);
  assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [generated.quizId]).length, 2);
  assert.equal(scheduler.getPageLearning("p1").reps, 1);
  assert.equal(scheduler.getPageLearning("p2").reps, 1);
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

test("quiz publishes more than four questions", () => {
  const { db, scheduler, date } = setup();
  const pageIds = ["p1", "p2", "p3", "p4", "p5"];
  for (const pageId of pageIds.slice(2)) addPage(db, pageId);
  ensureDue(scheduler, pageIds, date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: pageIds,
    questionSpecs: pageIds.map((pageId) => question(pageId)),
  });
  assert.equal(generated.status, "open");
  assert.equal(generated.questions.length, 5);
  db.close();
});

test("quiz publishes more than two synthesis questions", () => {
  const { db, scheduler, date } = setup();
  const pageIds = ["p1", "p2"];
  ensureDue(scheduler, pageIds, date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const synthesis = (prompt: string) => ({
    kind: "free-response" as const,
    prompt,
    pages: [
      { pageId: "p1", criterion: "Compare p1", weight: 1 },
      { pageId: "p2", criterion: "Compare p2", weight: 1 },
    ],
    sourceRefs: [],
  });
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: pageIds,
    questionSpecs: [synthesis("First comparison"), synthesis("Second comparison"), synthesis("Third comparison")],
  });
  assert.equal(generated.status, "open");
  assert.equal(generated.questions.length, 3);
  assert.ok(generated.questions.every((item) => item.pages.length === 2));
  db.close();
});
