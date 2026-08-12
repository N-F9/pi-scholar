import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { openDatabase, type ScholarDatabase } from "../src/database.js";
import { QuizConflictError, QuizService, validateQuizVisibleText } from "../src/quiz.js";
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
function syntheticPagePath(pageId: string): string {
  return `fixture-${createHash("sha256").update(pageId).digest("hex").slice(0, 12)}.md`;
}
const PAGE_MARKDOWN = pageDocument("p1", PAGE_BODY);
afterAll(() => rmSync(LEARNING_WIKI_ROOT, { recursive: true, force: true }));

function addPage(db: ScholarDatabase, pageId: string, markdown = PAGE_BODY): void {
  const document = markdown.startsWith("---\n") ? markdown : pageDocument(pageId, markdown);
  writeFileSync(join(LEARNING_WIKI_ROOT, syntheticPagePath(pageId)), document);
  const digest = createHash("sha256").update(document).digest("hex");
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO pages (page_id, relative_path, title, digest, revision, status, quiz_worthiness, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'eligible', ?, ?)",
    [pageId, syntheticPagePath(pageId), pageId, digest, now, now],
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
test("due eligibility uses the configured timezone for both day and due timestamps", () => {
  const db = openDatabase(":memory:");
  addPage(db, "timezone-page");
  const scheduler = new SchedulerService(db, undefined, "America/Los_Angeles");
  scheduler.ensurePageLearning("timezone-page");
  db.run("UPDATE page_learning SET due_at = ? WHERE page_id = ?", ["2026-08-13T00:30:00.000Z", "timezone-page"]);
  assert.deepEqual(
    scheduler.eligiblePages("2026-08-12", false).map((page) => page.pageId),
    ["timezone-page"],
  );
  assert.deepEqual(scheduler.eligiblePages("2026-08-11", false), []);
  db.close();
});
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

test("section parser recognizes Setext headings and keeps their boundaries", () => {
  const setextBody = "Topic\n=====\nTopic evidence.\n\nNext\n-----\nNext evidence.\n";
  const sections = parseWikiBodySections(setextBody, "setext");
  assert.deepEqual(
    sections.map((item) => ({ anchor: item.anchor, heading: item.heading })),
    [
      { anchor: "#topic", heading: "Topic" },
      { anchor: "#next", heading: "Next" },
    ],
  );
  assert.equal(setextBody.slice(sections[0]!.startOffset, sections[0]!.endOffset), "Topic\n=====\nTopic evidence.\n\n");
  assert.equal(setextBody.slice(sections[1]!.startOffset, sections[1]!.endOffset), "Next\n-----\nNext evidence.\n");

  const mixedBody = "Topic\n=====\nSetext evidence.\n\n# Topic\nATX evidence.\n";
  assert.deepEqual(
    parseWikiBodySections(mixedBody, "mixed").map((item) => ({ anchor: item.anchor, heading: item.heading })),
    [
      { anchor: "#topic", heading: "Topic" },
      { anchor: "#topic-1", heading: "Topic" },
    ],
  );
  const inlineSetextSections = parseWikiBodySections(
    "[Topic](https://example.test)\n=====\nSetext evidence.\n",
    "inline-setext",
  );
  assert.deepEqual(
    inlineSetextSections.map((item) => ({ anchor: item.anchor, heading: item.heading })),
    [{ anchor: "#topic", heading: "Topic" }],
  );
  const richAtxSections = parseWikiBodySections("# **ATX** [link](x) `code`\n\nATX evidence.\n", "rich-atx");
  assert.deepEqual(
    richAtxSections.map((item) => ({ anchor: item.anchor, heading: item.heading })),
    [{ anchor: "#atx-link-code", heading: "ATX link code" }],
  );
  const imageAtxBody = "# ![Architecture](diagram.png)\n\nImage evidence.\n\n# Following\nFollowing evidence.\n";
  const imageAtxSections = parseWikiBodySections(imageAtxBody, "image-atx");
  assert.deepEqual(
    imageAtxSections.map((item) => ({ anchor: item.anchor, heading: item.heading })),
    [
      { anchor: "#image-architecture", heading: "[Image: Architecture]" },
      { anchor: "#following", heading: "Following" },
    ],
  );
  assert.equal(
    imageAtxBody.slice(imageAtxSections[0]!.startOffset, imageAtxSections[0]!.endOffset),
    "# ![Architecture](diagram.png)\n\nImage evidence.\n\n",
  );

  const imageSetextBody =
    "![Architecture](diagram.png)\n===\nSetext image evidence.\n\nFollowing\n---\nFollowing evidence.\n";
  const imageSetextSections = parseWikiBodySections(imageSetextBody, "image-setext");
  assert.deepEqual(
    imageSetextSections.map((item) => ({ anchor: item.anchor, heading: item.heading })),
    [
      { anchor: "#image-architecture", heading: "[Image: Architecture]" },
      { anchor: "#following", heading: "Following" },
    ],
  );
  assert.equal(
    imageSetextBody.slice(imageSetextSections[0]!.startOffset, imageSetextSections[0]!.endOffset),
    "![Architecture](diagram.png)\n===\nSetext image evidence.\n\n",
  );

  const imageReferenceBody =
    "# ![Architecture][architecture]\n\n[architecture]: diagram.png\n\nReference image evidence.\n";
  assert.deepEqual(
    parseWikiBodySections(imageReferenceBody, "image-reference").map((item) => ({
      anchor: item.anchor,
      heading: item.heading,
    })),
    [{ anchor: "#image-architecture", heading: "[Image: Architecture]" }],
  );
  assert.deepEqual(
    parseWikiBodySections("# ![](diagram.png)\n\nFallback image evidence.\n", "image-fallback").map((item) => ({
      anchor: item.anchor,
      heading: item.heading,
    })),
    [{ anchor: "#image-illustration", heading: "[Image: illustration]" }],
  );

  const hardBreakSetext = "One\\\nTwo\n===\nEvidence.\n";
  assert.deepEqual(
    parseWikiBodySections(hardBreakSetext, "hard-break").map((item) => ({
      anchor: item.anchor,
      heading: item.heading,
    })),
    [{ anchor: "#one-two", heading: "One\nTwo" }],
  );

  const indentedBody = "Preamble.\n\n  # Heading\n\nBody.\n";
  const indentedSections = parseWikiBodySections(indentedBody, "indented");
  assert.equal(indentedBody.slice(indentedSections[0]!.startOffset, indentedSections[0]!.endOffset), "Preamble.\n\n");
  assert.equal(indentedBody.slice(indentedSections[1]!.startOffset), "  # Heading\n\nBody.\n");

  const crBody = "# First\rFirst evidence.\r# Second\rSecond evidence.\r";
  const crSections = parseWikiBodySections(crBody, "cr");
  assert.equal(crBody.slice(crSections[0]!.startOffset, crSections[0]!.endOffset), "# First\rFirst evidence.\r");
  assert.equal(crBody.slice(crSections[1]!.startOffset), "# Second\rSecond evidence.\r");

  const fencedBody = "```md\nIgnored\n-----\nIgnored body.\n```\nActual\n=====\nActual evidence.\n";
  const fencedSections = parseWikiBodySections(fencedBody, "fenced");
  assert.deepEqual(
    fencedSections.map((item) => ({ anchor: item.anchor, heading: item.heading })),
    [
      { anchor: "", heading: undefined },
      { anchor: "#actual", heading: "Actual" },
    ],
  );
  assert.equal(
    fencedBody.slice(fencedSections[0]!.startOffset, fencedSections[0]!.endOffset),
    "```md\nIgnored\n-----\nIgnored body.\n```\n",
  );
  assert.equal(fencedBody.slice(fencedSections[1]!.startOffset), "Actual\n=====\nActual evidence.\n");
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
  assert.equal(quiz.readingHref({ pageId: "headingless", anchor: "" }), `wiki/${syntheticPagePath("headingless")}`);
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
        feedback: "First page feedback",
        evidence: [authorized.reference],
        readings: [{ pageId: "p1", anchor: authorized.anchor }],
      },
      {
        pageId: "p2",
        rating: "Good" as const,
        feedback: "Second page feedback",
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
  const p1Feedback = sheet.indexOf("First page feedback");
  const p1Reading = sheet.indexOf(`- [Reading 1](${quiz.readingHref(settled.pages[0]!.readings[0]!)})`);
  const p2Feedback = sheet.indexOf("Second page feedback");
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

test("grading rejects generated reading targets that expose page IDs before persistence", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({ date, selectedPageIds: ["p1"], questionSpecs: [question("p1")] });
  const questionId = generated.questions[0]!.questionId;
  const draft = quiz.saveDraft({ date, revision: generated.revision, answers: { [questionId]: "answer" } });
  const sealed = quiz.sealSubmission({ date, revision: draft.revision });
  const evidence = quiz.gradingEvidence(sealed)[0]!;
  db.run("UPDATE pages SET relative_path = ? WHERE page_id = ?", ["p1.md", "p1"]);
  assert.throws(
    () =>
      quiz.settleGrade({
        date,
        revision: sealed.revision,
        submissionId: "generated-reading-target",
        questions: [{ questionId, feedback: "Valid feedback." }],
        pages: [
          {
            pageId: "p1",
            rating: "Good",
            evidence: [evidence.reference],
            readings: [{ pageId: "p1", anchor: evidence.anchor }],
          },
        ],
      }),
    ValidationError,
  );
  assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [sealed.quizId]).length, 0);
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
    join(LEARNING_WIKI_ROOT, syntheticPagePath("p1")),
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

test("quiz rejects exact hidden metadata in prompts, choices, answers, and feedback", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const pageDigest = db.get<{ digest: string }>("SELECT digest FROM pages WHERE page_id = ?", ["p1"])!.digest;
  const opaqueId = randomUUID();
  const sourceReference = `${randomUUID()}:0`;
  assert.throws(
    () => validateQuizVisibleText(`x${opaqueId}`, [{ value: opaqueId, match: "substring" }]),
    ValidationError,
  );
  assert.throws(
    () => validateQuizVisibleText(`x${sourceReference}`, [{ value: sourceReference, match: "substring" }]),
    ValidationError,
  );
  assert.throws(
    () => validateQuizVisibleText(opaqueId.replace("-", "\\-"), [{ value: opaqueId, match: "substring" }]),
    ValidationError,
  );
  assert.throws(
    () => validateQuizVisibleText(opaqueId.replace("-", "-\u200b"), [{ value: opaqueId, match: "substring" }]),
    ValidationError,
  );
  assert.throws(
    () =>
      validateQuizVisibleText(opaqueId.replace(/^([^-]+)-([^-]+)/u, "$1-**$2**"), [
        { value: opaqueId, match: "substring" },
      ]),
    ValidationError,
  );
  assert.throws(
    () =>
      validateQuizVisibleText(opaqueId.replace(/^([^-]+)-([^-]+)/u, "$1-~~$2~~"), [
        { value: opaqueId, match: "substring" },
      ]),
    ValidationError,
  );
  assert.throws(
    () =>
      validateQuizVisibleText(opaqueId.replace(/^([^-]+)-([^-]+)-/u, "$1-<em>$2</em>-"), [
        { value: opaqueId, match: "substring" },
      ]),
    ValidationError,
  );
  assert.throws(
    () =>
      validateQuizVisibleText(`![${opaqueId.replace("-", "\\-")}][img]\n\n[img]: image.png`, [
        { value: opaqueId, match: "substring" },
      ]),
    ValidationError,
  );
  assert.throws(
    () => validateQuizVisibleText(`x${pageDigest}`, [{ value: pageDigest, match: "substring" }]),
    ValidationError,
  );
  assert.doesNotThrow(() => validateQuizVisibleText("xp1", [{ value: "p1", match: "boundary" }]));
  const storedCriterion = "Stored **grading crit\u00e9rion &amp; evidence**";
  const renderedCriterion = "Stored grading crit\u00e9rion & evidence";
  const softBreakCriterion = renderedCriterion.replace("grading ", "grading\n");
  const decomposedCriterion = renderedCriterion.normalize("NFD");
  assert.throws(
    () =>
      quiz.createDailyQuiz({
        date,
        selectedPageIds: ["p1"],
        questionSpecs: [question("p1", "Explain p1")],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      quiz.createDailyQuiz({
        date,
        selectedPageIds: ["p1"],
        questionSpecs: [
          {
            ...question("p1"),
            kind: "multiple-choice",
            choices: ["p1", "other"],
          },
        ],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      quiz.createDailyQuiz({
        date,
        selectedPageIds: ["p1"],
        questionSpecs: [question("p1", `Explain x${pageDigest}`)],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      quiz.createDailyQuiz({
        date,
        selectedPageIds: ["p1"],
        questionSpecs: [{ ...question("p1", "Explain evidence-reference"), sourceRefs: ["evidence-reference"] }],
      }),
    ValidationError,
  );
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: ["p1"],
    questionSpecs: [
      {
        ...question("p1"),
        pages: [{ pageId: "p1", criterion: storedCriterion, weight: 1 }],
        sourceRefs: ["evidence-reference"],
      },
    ],
  });
  const questionId = generated.questions[0]!.questionId;
  assert.throws(
    () =>
      quiz.saveDraft({
        date,
        revision: generated.revision,
        answers: { [questionId]: `page-${questionId.toUpperCase()}` },
      }),
    ValidationError,
  );
  assert.throws(
    () => quiz.saveDraft({ date, revision: generated.revision, answers: { [questionId]: "p1" } }),
    ValidationError,
  );
  const draft = quiz.saveDraft({ date, revision: generated.revision, answers: { [questionId]: "valid answer" } });
  const sealed = quiz.sealSubmission({ date, revision: draft.revision });
  const evidence = quiz.gradingEvidence(sealed)[0]!;
  const requestId = randomUUID();
  const requestGrade = {
    date,
    revision: sealed.revision,
    requestId,
    submissionId: "hidden-request-feedback",
    questions: [{ questionId, feedback: `x${requestId}` }],
    pages: [{ pageId: "p1", rating: "Good" as const, evidence: [evidence.reference] }],
  };
  assert.throws(() => quiz.settleGrade(requestGrade), ValidationError);
  assert.throws(
    () =>
      quiz.settleGrade({
        ...requestGrade,
        questions: [{ questionId, feedback: "visible feedback" }],
        pages: [{ ...requestGrade.pages[0]!, feedback: `x${requestId}` }],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      quiz.settleGrade({
        date,
        revision: sealed.revision,
        submissionId: "hidden-feedback",
        questions: [{ questionId, feedback: "p1" }],
        pages: [{ pageId: "p1", rating: "Good", evidence: [evidence.reference] }],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      quiz.settleGrade({
        ...requestGrade,
        requestId: randomUUID(),
        submissionId: "hidden-criterion-feedback",
        questions: [{ questionId, feedback: storedCriterion }],
        pages: [{ ...requestGrade.pages[0]!, feedback: "visible feedback" }],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      quiz.settleGrade({
        ...requestGrade,
        requestId: randomUUID(),
        submissionId: "hidden-letter-adjacent-criterion-feedback",
        questions: [{ questionId, feedback: `x${storedCriterion}` }],
        pages: [{ ...requestGrade.pages[0]!, feedback: "visible feedback" }],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      quiz.settleGrade({
        ...requestGrade,
        requestId: randomUUID(),
        submissionId: "hidden-rendered-criterion-feedback",
        questions: [{ questionId, feedback: renderedCriterion }],
        pages: [{ ...requestGrade.pages[0]!, feedback: "visible feedback" }],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      quiz.settleGrade({
        ...requestGrade,
        requestId: randomUUID(),
        submissionId: "hidden-soft-break-criterion-feedback",
        questions: [{ questionId, feedback: softBreakCriterion }],
        pages: [{ ...requestGrade.pages[0]!, feedback: "visible feedback" }],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      quiz.settleGrade({
        ...requestGrade,
        requestId: randomUUID(),
        submissionId: "hidden-decomposed-criterion-feedback",
        questions: [{ questionId, feedback: `x${decomposedCriterion}` }],
        pages: [{ ...requestGrade.pages[0]!, feedback: "visible feedback" }],
      }),
    ValidationError,
  );
  assert.equal(db.all("SELECT * FROM question_results WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  assert.equal(db.all("SELECT * FROM page_results WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  assert.equal(db.all("SELECT * FROM page_reviews WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  db.close();
});

test("quiz treats host-minted page UUIDs as opaque metadata", () => {
  const { db, scheduler, date } = setup();
  const pageId = randomUUID();
  addPage(db, pageId);
  ensureDue(scheduler, [pageId], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: [pageId],
    questionSpecs: [
      {
        kind: "free-response",
        prompt: "Explain the page",
        pages: [{ pageId, criterion: "Identify the central idea", weight: 1 }],
        sourceRefs: [],
      },
    ],
  });
  const questionId = generated.questions[0]!.questionId;
  assert.throws(
    () =>
      quiz.saveDraft({
        date,
        revision: generated.revision,
        answers: { [questionId]: `x${pageId}` },
      }),
    ValidationError,
  );
  db.close();
});

test("quiz keeps permitted identity comments and does not block answer-key values", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: ["p1"],
    questionSpecs: [
      {
        kind: "multiple-choice",
        prompt: "Choose the correct statement",
        choices: ["correct", "incorrect"],
        pages: [{ pageId: "p1", criterion: "Explain the page", weight: 1 }],
        sourceRefs: [],
        answerKey: "correct",
      },
    ],
  });
  const questionId = generated.questions[0]!.questionId;
  const draft = quiz.saveDraft({ date, revision: generated.revision, answers: { [questionId]: "correct" } });
  const sealed = quiz.sealSubmission({ date, revision: draft.revision });
  const sheet = quiz.renderSheet(sealed, { [questionId]: "correct" });
  assert.match(sheet, new RegExp(`pi-scholar:quiz format=1 id=${generated.quizId} revision=`, "u"));
  assert.match(sheet, new RegExp(`pi-scholar:question id=${questionId}`, "u"));
  assert.match(sheet, /correct/u);
  db.close();
});

test("quiz rejects quiz and question identifiers outside identity comments", () => {
  const { db, scheduler, date } = setup();
  ensureDue(scheduler, ["p1"], date);
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    selectedPageIds: ["p1"],
    questionSpecs: [question("p1")],
  });
  const questionId = generated.questions[0]!.questionId;
  db.run("UPDATE quiz_questions SET prompt = ? WHERE question_id = ?", [generated.quizId, questionId]);
  assert.throws(() => quiz.parseSheet(quiz.renderSheet(quiz.get(date)!)), ValidationError);
  db.run("UPDATE quiz_questions SET prompt = ? WHERE question_id = ?", [questionId, questionId]);
  assert.throws(() => quiz.parseSheet(quiz.renderSheet(quiz.get(date)!)), ValidationError);
  db.close();
});
