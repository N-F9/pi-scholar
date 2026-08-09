import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { openDatabase } from "../src/database.js";
import { QuizConflictError, QuizService } from "../src/quiz.js";
import { localDate, SchedulerService, ValidationError } from "../src/scheduler.js";
import { parseWikiSections } from "../src/wiki-sections.js";
import { WorkflowCoordinator } from "../src/workflows.js";

function currentDate(): string {
  return localDate(new Date());
}

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}
function nextDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

const LEARNING_WIKI_ROOT = mkdtempSync(join(tmpdir(), "pi-scholar-learning-"));
const PAGE_MARKDOWN = `${[
  "# Part",
  "section text",
  "# A",
  "section text",
  "# B",
  "section text",
  "# Left",
  "section text",
  "# Right",
  "section text",
  "# Merged",
  "section text",
  "# 0",
  "section text",
  "# 1",
  "section text",
  "# 2",
  "section text",
  "# 3",
  "section text",
  "# 4",
  "section text",
  "# 5",
  "section text",
  "# Atomic",
  "section text",
  "# Callback",
  "section text",
  "# Later",
  "later section text",
].join("\n")}\n`;
afterAll(() => rmSync(LEARNING_WIKI_ROOT, { recursive: true, force: true }));

function page(db: ReturnType<typeof openDatabase>, pageId: string): void {
  writeFileSync(join(LEARNING_WIKI_ROOT, `${pageId}.md`), PAGE_MARKDOWN);
  const digest = createHash("sha256").update(PAGE_MARKDOWN).digest("hex");
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO pages (page_id, relative_path, title, digest, revision, status, quiz_worthiness, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'eligible', ?, ?)",
    [pageId, `${pageId}.md`, pageId, digest, now, now],
  );
}

function binding(pageId: string, anchor = "#part") {
  const section = parseWikiSections(PAGE_MARKDOWN, pageId).find((candidate) => candidate.anchor === anchor);
  if (!section) throw new Error(`missing fixture section ${anchor}`);
  const sectionText = PAGE_MARKDOWN.slice(section.startOffset, section.endOffset);
  const boundText = section.heading === "Later" ? "later section text" : "section text";
  const startOffset = sectionText.indexOf(boundText);
  if (startOffset < 0) throw new Error(`missing fixture bytes ${anchor}`);
  const endOffset = startOffset + boundText.length;
  return {
    pageId,
    heading: section.heading,
    anchor,
    startOffset,
    endOffset,
    textDigest: createHash("sha256").update(boundText).digest("hex"),
    pageDigest: createHash("sha256").update(PAGE_MARKDOWN).digest("hex"),
    pageRevision: 1,
    sectionText,
  };
}

function setup() {
  const db = openDatabase(":memory:");
  page(db, "p1");
  page(db, "p2");
  return { db, scheduler: new SchedulerService(db), date: currentDate() };
}

function insertQuizFixture(
  db: ReturnType<typeof openDatabase>,
  quizId: string,
  date: string,
  cardId: string,
  questionId: string,
  status: "open" | "submitted" = "open",
): void {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, ?, NULL, ?, NULL, NULL, NULL)",
    [quizId, date, status, now],
  );
  db.run(
    "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, grading_criteria_json, source_refs_json) VALUES (?, ?, 0, 'short-answer', 'Explain the section', NULL, NULL, ?, '[]')",
    [questionId, quizId, JSON.stringify([{ cardId, criterion: "Explain the section", weight: 1 }])],
  );
  db.run("INSERT INTO question_cards (question_id, card_id, criterion_json, weight) VALUES (?, ?, ?, 1)", [
    questionId,
    cardId,
    JSON.stringify("Explain the section"),
  ]);
}

test("prerequisites block until every prerequisite is in Review and reject cycles", () => {
  const { db, scheduler, date } = setup();
  const due = `${date}T00:00:00.000Z`;
  const first = scheduler.createCard({ cardId: "a", initialDueAt: due, bindings: [binding("p1")] });
  const second = scheduler.createCard({ cardId: "b", initialDueAt: due, bindings: [binding("p2")] });
  scheduler.setPrerequisites(second.cardId, [first.cardId]);
  assert.deepEqual(
    scheduler.eligibleCards(date).map((card) => card.cardId),
    ["a"],
  );
  db.run("UPDATE review_cards SET fsrs_state = 2 WHERE card_id = ?", [first.cardId]);
  assert.deepEqual(
    scheduler
      .eligibleCards(date)
      .map((card) => card.cardId)
      .sort(),
    ["a", "b"],
  );
  assert.throws(() => scheduler.setPrerequisites(first.cardId, [second.cardId]), ValidationError);
  assert.throws(() => scheduler.setPrerequisites(second.cardId, ["missing"]), ValidationError);
  db.close();
});

test("split and merge retire parents, preserve raw review lineage, and reset FSRS", () => {
  const { db, scheduler, date } = setup();
  const parent = scheduler.createCard({
    cardId: "parent",
    initialDueAt: `${date}T00:00:00Z`,
    bindings: [binding("p1")],
  });
  insertQuizFixture(db, "fixture-quiz", date, parent.cardId, "fixture-question");
  scheduler.transitionCard(parent.cardId, "Good", `${date}T00:00:00Z`, {
    quizId: "fixture-quiz",
    questionId: "fixture-question",
    answerRevision: 1,
  });
  const children = scheduler.splitCard(parent.cardId, [
    { cardId: "left", bindings: [binding("p1", "#left")] },
    { cardId: "right", bindings: [binding("p2", "#right")] },
  ]);
  assert.equal(scheduler.getCard(parent.cardId).status, "retired");
  assert.ok(children.every((card) => card.fsrsState === "New"));
  assert.equal(scheduler.historicalReviews(children[0]!.cardId).length, 1);
  const merged = scheduler.mergeCards(
    children.map((card) => card.cardId),
    { cardId: "merged", bindings: [binding("p1", "#merged")] },
  );
  assert.equal(merged.fsrsState, "New");
  assert.equal(scheduler.historicalReviews(merged.cardId).length, 1);
  assert.ok(
    scheduler.lineage(parent.cardId).some((entry) => entry.event === "retire" && entry.childCardIds.length === 0),
  );
  db.close();
});

test("due selection interleaves page topics and is bounded", () => {
  const { db, scheduler, date } = setup();
  for (let i = 0; i < 6; i++)
    scheduler.createCard({
      cardId: `c${i}`,
      initialDueAt: `${date}T00:00:00Z`,
      bindings: [binding(i % 2 ? "p2" : "p1", `#${i}`)],
    });
  const selected = scheduler.selectDueCards(date);
  assert.equal(selected.length, 4);
  assert.equal(selected[0]?.cardId, "c0");
  assert.equal(selected[1]?.cardId, "c1");
  db.close();
});

test("quiz skips empty days and lets invalid proposals retry without a dated row", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({ cardId: "future", initialDueAt: `${nextDate(date)}T00:00:00Z`, bindings: [binding("p1")] });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const skipped = quiz.createDailyQuiz({ date });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.sheetPath, undefined);
  db.close();

  const generatedSetup = setup();
  generatedSetup.scheduler.createCard({
    cardId: "q-a",
    initialDueAt: `${generatedSetup.date}T00:00:00Z`,
    bindings: [binding("p1", "#a")],
  });
  insertQuizFixture(generatedSetup.db, "prior-open", previousDate(generatedSetup.date), "q-a", "prior-question");
  const generatedQuiz = new QuizService(generatedSetup.db, { wiki: LEARNING_WIKI_ROOT }, generatedSetup.scheduler);
  assert.throws(() => generatedQuiz.createDailyQuiz({ date: generatedSetup.date, questions: [] }), ValidationError);
  assert.equal(generatedQuiz.get(previousDate(generatedSetup.date))?.status, "open");
  assert.equal(generatedSetup.db.all("SELECT * FROM quizzes WHERE date = ?", [generatedSetup.date]).length, 0);
  const retried = generatedQuiz.createDailyQuiz({
    date: generatedSetup.date,
    questions: [
      {
        kind: "short-answer",
        prompt: "Explain",
        cardIds: ["q-a"],
        cards: [{ cardId: "q-a", criterion: "Explain", weight: 1 }],
      },
    ],
  });
  assert.equal(retried.status, "open");
  generatedSetup.db.close();
});

test("quiz grading requires a submitted quiz", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({ cardId: "open-card", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p1")] });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  quiz.createDailyQuiz({
    date,
    questions: [
      {
        kind: "short-answer",
        prompt: "Explain",
        cardIds: ["open-card"],
        cards: [{ cardId: "open-card", criterion: "Explain", weight: 1 }],
      },
    ],
  });
  assert.throws(() => quiz.settleGrade({ date, submissionId: "open-grade", questions: [] }), QuizConflictError);
  db.close();
});

test("quiz seals revision-safe answers and settles differential grades idempotently", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({ cardId: "q-a", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p1", "#a")] });
  scheduler.createCard({ cardId: "q-b", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p2", "#b")] });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [
      {
        questionId: "q",
        kind: "short-answer",
        prompt: "Explain both",
        cardIds: ["q-a", "q-b"],
        cards: [
          { cardId: "q-a", criterion: "Explain card A", weight: 1 },
          { cardId: "q-b", criterion: "Explain card B", weight: 1 },
        ],
        sourceRefs: ["p1#%23a", "p2#%23b"],
      },
    ],
  });
  const learnerSheet = quiz.renderSheet(generated);
  assert.equal(learnerSheet.includes("q-a"), false);
  assert.equal(learnerSheet.includes("p1#%23a"), false);
  assert.throws(
    () => quiz.saveDraft(generated.date, generated.revision, { q: "\n\n## private rubric" }),
    /structural Markdown/,
  );
  assert.equal(db.all("SELECT * FROM quiz_answers WHERE quiz_id = ?", [generated.quizId]).length, 0);
  const draft = quiz.saveDraft(generated.date, generated.revision, { q: "answer" });
  assert.throws(() => quiz.saveDraft(generated.date, generated.revision, { q: "stale" }));
  const sealed = quiz.sealSubmission(generated.date, draft.revision);
  const evidence = quiz.gradingEvidence(sealed);
  const evidenceA = evidence.find((item) => item.cardId === "q-a")!;
  const evidenceB = evidence.find((item) => item.cardId === "q-b")!;
  const settled = quiz.settleGrade({
    date: generated.date,
    revision: sealed.revision,
    submissionId: "submission-1",
    questions: [
      {
        questionId: "q",
        feedback: "Review the distinction",
        cards: [
          {
            cardId: "q-a",
            rating: "Good",
            feedback: "Correct",
            evidence: [evidenceA.reference],
            readings: [{ pageId: evidenceA.pageId, anchor: evidenceA.anchor }],
          },
          {
            cardId: "q-b",
            rating: "Again",
            feedback: "Missed",
            evidence: [evidenceB.reference],
            readings: [{ pageId: evidenceB.pageId, anchor: evidenceB.anchor }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    settled.questions[0]?.cards.map((card) => card.rating),
    ["Good", "Again"],
  );
  assert.deepEqual(
    settled.questions[0]?.cards.map((card) => card.evidence.length),
    [1, 1],
  );
  const retry = quiz.settleGrade({ date: generated.date, submissionId: "submission-1", questions: [] });
  assert.equal(retry.questions.length, 1);
  assert.equal(db.all("SELECT * FROM raw_reviews WHERE quiz_id = ?", [generated.quizId]).length, 2);
  db.close();
});
test("quiz rejects fabricated and stale evidence before FSRS transitions", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({
    cardId: "evidence-card",
    initialDueAt: `${date}T00:00:00Z`,
    bindings: [binding("p1", "#part")],
  });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [
      {
        questionId: "evidence-question",
        kind: "short-answer",
        prompt: "Explain",
        cardIds: ["evidence-card"],
        cards: [{ cardId: "evidence-card", criterion: "Explain", weight: 1 }],
      },
    ],
  });
  const draft = quiz.saveDraft(generated.date, generated.revision, { "evidence-question": "answer" });
  const sealed = quiz.sealSubmission(generated.date, draft.revision);
  const authorized = quiz.gradingEvidence(sealed).find((item) => item.cardId === "evidence-card")!;
  const grade = (evidence: string, readingAnchor = authorized.anchor) => ({
    date,
    revision: sealed.revision,
    submissionId: "evidence-test",
    questions: [
      {
        questionId: "evidence-question",
        cards: [
          {
            cardId: "evidence-card",
            rating: "Good" as const,
            evidence: [evidence],
            readings: [{ pageId: authorized.pageId, anchor: readingAnchor }],
          },
        ],
      },
    ],
  });
  assert.throws(() => quiz.settleGrade(grade("fabricated")), ValidationError);
  assert.equal(db.all("SELECT * FROM raw_reviews WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  db.run("UPDATE pages SET digest = ?, revision = revision + 1 WHERE page_id = ?", ["changed-page-digest", "p1"]);
  assert.throws(() => quiz.settleGrade(grade(authorized.reference)), ValidationError);
  assert.equal(db.all("SELECT * FROM raw_reviews WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  assert.equal(scheduler.getCard("evidence-card").fsrsState, "New");
  db.close();
});
test("quiz evidence resolves a later anchored section to its bound bytes", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({
    cardId: "later-card",
    initialDueAt: `${date}T00:00:00Z`,
    bindings: [binding("p1", "#later")],
  });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [
      {
        questionId: "later-question",
        kind: "short-answer",
        prompt: "Explain",
        cardIds: ["later-card"],
        cards: [{ cardId: "later-card", criterion: "Explain", weight: 1 }],
      },
    ],
  });
  const evidence = quiz.gradingEvidence(generated).find((item) => item.cardId === "later-card");
  assert.equal(evidence?.anchor, "#later");
  assert.equal(evidence?.excerpt, "later section text");
  db.close();
});

test("quiz missing evidence page fails before writes or FSRS transition", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({ cardId: "missing-page-card", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p1")] });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [
      {
        questionId: "missing-page-question",
        kind: "short-answer",
        prompt: "Explain",
        cardIds: ["missing-page-card"],
        cards: [{ cardId: "missing-page-card", criterion: "Explain", weight: 1 }],
      },
    ],
  });
  const draft = quiz.saveDraft(generated.date, generated.revision, { "missing-page-question": "answer" });
  const sealed = quiz.sealSubmission(generated.date, draft.revision);
  const authorized = quiz.gradingEvidence(sealed).find((item) => item.cardId === "missing-page-card")!;
  rmSync(join(LEARNING_WIKI_ROOT, "p1.md"));
  assert.throws(
    () =>
      quiz.settleGrade({
        date,
        revision: sealed.revision,
        submissionId: "missing-page-submission",
        questions: [
          {
            questionId: "missing-page-question",
            cards: [
              {
                cardId: "missing-page-card",
                rating: "Good",
                evidence: [authorized.reference],
                readings: [{ pageId: authorized.pageId, anchor: authorized.anchor }],
              },
            ],
          },
        ],
      }),
    ValidationError,
  );
  assert.equal(scheduler.getCard("missing-page-card").fsrsState, "New");
  assert.equal(db.all("SELECT * FROM raw_reviews WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  db.close();
});

test("quiz post-context page drift fails before FSRS transition", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({ cardId: "drift-card", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p1")] });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [
      {
        questionId: "drift-question",
        kind: "short-answer",
        prompt: "Explain",
        cardIds: ["drift-card"],
        cards: [{ cardId: "drift-card", criterion: "Explain", weight: 1 }],
      },
    ],
  });
  const draft = quiz.saveDraft(generated.date, generated.revision, { "drift-question": "answer" });
  const sealed = quiz.sealSubmission(generated.date, draft.revision);
  const authorized = quiz.gradingEvidence(sealed).find((item) => item.cardId === "drift-card")!;
  writeFileSync(
    join(LEARNING_WIKI_ROOT, "p1.md"),
    PAGE_MARKDOWN.replace("# Part\nsection text", "# Part\nchanged section text"),
  );
  assert.throws(
    () =>
      quiz.settleGrade({
        date,
        revision: sealed.revision,
        submissionId: "drift-submission",
        questions: [
          {
            questionId: "drift-question",
            cards: [
              {
                cardId: "drift-card",
                rating: "Good",
                evidence: [authorized.reference],
                readings: [{ pageId: authorized.pageId, anchor: authorized.anchor }],
              },
            ],
          },
        ],
      }),
    ValidationError,
  );
  assert.equal(scheduler.getCard("drift-card").fsrsState, "New");
  assert.equal(db.all("SELECT * FROM raw_reviews WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  db.close();
});
test("atomic seal queue callback rolls back submission and workflow together", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({
    cardId: "atomic-card",
    initialDueAt: `${date}T00:00:00Z`,
    bindings: [binding("p1", "#atomic")],
  });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [
      {
        questionId: "atomic-question",
        kind: "short-answer",
        prompt: "Explain",
        cardIds: ["atomic-card"],
        cards: [{ cardId: "atomic-card", criterion: "Explain", weight: 1 }],
      },
    ],
  });
  const draft = quiz.saveDraft(generated.date, generated.revision, { "atomic-question": "answer" });
  const workflows = new WorkflowCoordinator(db);
  const requestId = randomUUID();
  assert.throws(() =>
    quiz.sealSubmissionAndQueue({ date, revision: draft.revision }, requestId, (id, sealed) => {
      workflows.queueInTransaction("quiz-grader", id, `${sealed.quizId}:r${sealed.revision}`);
      throw new Error("queue callback failed");
    }),
  );
  assert.equal(quiz.get(date)?.status, "open");
  assert.equal(db.all("SELECT * FROM workflows WHERE request_id = ?", [requestId]).length, 0);
  db.close();
});
test("grade callback failure rolls back FSRS and result rows", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({
    cardId: "grade-callback-card",
    initialDueAt: `${date}T00:00:00Z`,
    bindings: [binding("p1", "#callback")],
  });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [
      {
        questionId: "grade-callback-question",
        kind: "short-answer",
        prompt: "Explain",
        cardIds: ["grade-callback-card"],
        cards: [{ cardId: "grade-callback-card", criterion: "Explain", weight: 1 }],
      },
    ],
  });
  const draft = quiz.saveDraft(generated.date, generated.revision, { "grade-callback-question": "answer" });
  const sealed = quiz.sealSubmission(generated.date, draft.revision);
  const evidence = quiz.gradingEvidence(sealed).find((item) => item.cardId === "grade-callback-card")!;
  const grade = {
    date,
    revision: sealed.revision,
    submissionId: "callback-failure",
    questions: [
      {
        questionId: "grade-callback-question",
        cards: [
          {
            cardId: "grade-callback-card",
            rating: "Good" as const,
            evidence: [evidence.reference],
            readings: [{ pageId: evidence.pageId, anchor: evidence.anchor }],
          },
        ],
      },
    ],
  };
  assert.throws(() =>
    quiz.settleGrade(grade, () => {
      throw new Error("workflow update failed");
    }),
  );
  assert.equal(db.all("SELECT * FROM raw_reviews WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  assert.equal(db.all("SELECT * FROM card_results WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  assert.equal(db.all("SELECT * FROM question_results WHERE quiz_id = ?", [sealed.quizId]).length, 0);
  db.close();
});

test("canonical parser validates the stored open quiz and expiration changes no FSRS state", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({ cardId: "parser-card", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p1")] });
  const quiz = new QuizService(db, { wiki: LEARNING_WIKI_ROOT }, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [
      {
        questionId: "parser-question",
        kind: "short-answer",
        prompt: "Explain",
        cardIds: ["parser-card"],
        cards: [{ cardId: "parser-card", criterion: "Explain", weight: 1 }],
      },
    ],
  });
  assert.equal(quiz.parseSheet(quiz.renderSheet(generated)).quizId, generated.quizId);
  assert.throws(() => quiz.parseSheet(`${quiz.renderSheet(generated)}\nAnswer key: no`), ValidationError);
  db.close();

  const expiration = setup();
  const card = expiration.scheduler.createCard({
    cardId: "old",
    initialDueAt: `${date}T00:00:00Z`,
    bindings: [binding("p1")],
  });
  const oldDate = previousDate(date);
  insertQuizFixture(expiration.db, "old-quiz", oldDate, card.cardId, "old-question");
  const oldQuiz = new QuizService(expiration.db, { wiki: LEARNING_WIKI_ROOT }, expiration.scheduler);
  assert.equal(oldQuiz.expirePrior(date), 1);
  assert.equal(oldQuiz.get(oldDate)?.status, "expired");
  assert.equal(expiration.db.all("SELECT * FROM raw_reviews").length, 0);
  expiration.db.close();
});

test("workflow idempotency keys reject a different supplied request ID", () => {
  const { db } = setup();
  const workflows = new WorkflowCoordinator(db);
  const requestId = randomUUID();
  const first = workflows.queueInTransaction("quiz-grader", requestId, "workflow-key");
  assert.equal(first.requestId, requestId);
  assert.throws(
    () => workflows.queueInTransaction("quiz-grader", randomUUID(), "workflow-key"),
    /workflow idempotency key is already bound/u,
  );
  const retry = workflows.queueInTransaction("quiz-grader", requestId, "workflow-key");
  assert.equal(retry.requestId, requestId);
  db.close();
});
