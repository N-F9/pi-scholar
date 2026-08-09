import assert from "node:assert/strict";
import { test } from "vitest";
import { openDatabase } from "../src/database.js";
import { QuizService } from "../src/quiz.js";
import { localDate, SchedulerService, ValidationError } from "../src/scheduler.js";

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


function page(db: ReturnType<typeof openDatabase>, pageId: string, digest = `digest-${pageId}`): void {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO pages (page_id, relative_path, title, digest, revision, status, quiz_worthiness, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'eligible', ?, ?)",
    [pageId, `${pageId}.md`, pageId, digest, now, now],
  );
}

function binding(pageId: string, anchor = "#part") {
  return {
    pageId,
    anchor,
    startOffset: 0,
    endOffset: 12,
    textDigest: `digest-${pageId}`,
    pageDigest: `digest-${pageId}`,
    pageRevision: 1,
    sectionText: "section text",
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
  db.run(
    "INSERT INTO question_cards (question_id, card_id, criterion_json, weight) VALUES (?, ?, ?, 1)",
    [questionId, cardId, JSON.stringify("Explain the section")],
  );
}

test("prerequisites block until every prerequisite is in Review and reject cycles", () => {
  const { db, scheduler, date } = setup();
  const due = `${date}T00:00:00.000Z`;
  const first = scheduler.createCard({ cardId: "a", initialDueAt: due, bindings: [binding("p1")] });
  const second = scheduler.createCard({ cardId: "b", initialDueAt: due, bindings: [binding("p2")] });
  scheduler.setPrerequisites(second.cardId, [first.cardId]);
  assert.deepEqual(scheduler.eligibleCards(date).map((card) => card.cardId), ["a"]);
  db.run("UPDATE review_cards SET fsrs_state = 2 WHERE card_id = ?", [first.cardId]);
  assert.deepEqual(scheduler.eligibleCards(date).map((card) => card.cardId).sort(), ["a", "b"]);
  assert.throws(() => scheduler.setPrerequisites(first.cardId, [second.cardId]), ValidationError);
  assert.throws(() => scheduler.setPrerequisites(second.cardId, ["missing"]), ValidationError);
  db.close();
});

test("split and merge retire parents, preserve raw review lineage, and reset FSRS", () => {
  const { db, scheduler, date } = setup();
  const parent = scheduler.createCard({ cardId: "parent", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p1")] });
  insertQuizFixture(db, "fixture-quiz", date, parent.cardId, "fixture-question");
  scheduler.transitionCard(parent.cardId, "Good", `${date}T00:00:00Z`, { quizId: "fixture-quiz", questionId: "fixture-question", answerRevision: 1 });
  const children = scheduler.splitCard(parent.cardId, [
    { cardId: "left", bindings: [binding("p1", "#left")] },
    { cardId: "right", bindings: [binding("p2", "#right")] },
  ]);
  assert.equal(scheduler.getCard(parent.cardId).status, "retired");
  assert.ok(children.every((card) => card.fsrsState === "New"));
  assert.equal(scheduler.historicalReviews(children[0]!.cardId).length, 1);
  const merged = scheduler.mergeCards(children.map((card) => card.cardId), { cardId: "merged", bindings: [binding("p1", "#merged")] });
  assert.equal(merged.fsrsState, "New");
  assert.equal(scheduler.historicalReviews(merged.cardId).length, 1);
  assert.ok(scheduler.lineage(parent.cardId).some((entry) => entry.event === "retire" && entry.childCardIds.length === 0));
  db.close();
});

test("due selection interleaves page topics and is bounded", () => {
  const { db, scheduler, date } = setup();
  for (let i = 0; i < 6; i++) scheduler.createCard({ cardId: `c${i}`, initialDueAt: `${date}T00:00:00Z`, bindings: [binding(i % 2 ? "p2" : "p1", `#${i}`)] });
  const selected = scheduler.selectDueCards(date);
  assert.equal(selected.length, 4);
  assert.equal(selected[0]?.cardId, "c0");
  assert.equal(selected[1]?.cardId, "c1");
  db.close();
});

test("quiz skips empty days and records failed generation without partial questions", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({ cardId: "future", initialDueAt: `${nextDate(date)}T00:00:00Z`, bindings: [binding("p1")] });
  const quiz = new QuizService(db, undefined, scheduler);
  const skipped = quiz.createDailyQuiz({ date });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.sheetPath, undefined);
  db.close();

  const generatedSetup = setup();
  generatedSetup.scheduler.createCard({ cardId: "q-a", initialDueAt: `${generatedSetup.date}T00:00:00Z`, bindings: [binding("p1", "#a")] });
  const generatedQuiz = new QuizService(generatedSetup.db, undefined, generatedSetup.scheduler);
  const failed = generatedQuiz.createDailyQuiz({ date: generatedSetup.date, questions: [] });
  assert.equal(failed.status, "failed");
  assert.equal(generatedSetup.db.all("SELECT * FROM quiz_questions WHERE quiz_id = ?", [failed.quizId]).length, 0);
  generatedSetup.db.close();
});

test("quiz seals revision-safe answers and settles differential grades idempotently", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({ cardId: "q-a", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p1", "#a")] });
  scheduler.createCard({ cardId: "q-b", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p2", "#b")] });
  const quiz = new QuizService(db, undefined, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [{
      questionId: "q",
      kind: "short-answer",
      prompt: "Explain both",
      cardIds: ["q-a", "q-b"],
      cards: [
        { cardId: "q-a", criterion: "Explain card A", weight: 1 },
        { cardId: "q-b", criterion: "Explain card B", weight: 1 },
      ],
      sourceRefs: ["p1#%23a", "p2#%23b"],
    }],
  });
  const draft = quiz.saveDraft(generated.date, generated.revision, { q: "answer" });
  assert.throws(() => quiz.saveDraft(generated.date, generated.revision, { q: "stale" }));
  const sealed = quiz.sealSubmission(generated.date, draft.revision);
  const settled = quiz.settleGrade({
    date: generated.date,
    revision: sealed.revision,
    submissionId: "submission-1",
    questions: [{
      questionId: "q",
      feedback: "Review the distinction",
      cards: [
        { cardId: "q-a", rating: "Good", feedback: "Correct", evidence: ["Explained A"] },
        { cardId: "q-b", rating: "Again", feedback: "Missed", evidence: ["Omitted B"] },
      ],
    }],
  });
  assert.deepEqual(settled.questions[0]?.cards.map((card) => card.rating), ["Good", "Again"]);
  assert.deepEqual(settled.questions[0]?.cards.map((card) => card.evidence.length), [1, 1]);
  const retry = quiz.settleGrade({ date: generated.date, submissionId: "submission-1", questions: [] });
  assert.equal(retry.questions.length, 1);
  assert.equal(db.all("SELECT * FROM raw_reviews WHERE quiz_id = ?", [generated.quizId]).length, 2);
  db.close();
});

test("canonical parser validates the stored open quiz and expiration changes no FSRS state", () => {
  const { db, scheduler, date } = setup();
  scheduler.createCard({ cardId: "parser-card", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p1")] });
  const quiz = new QuizService(db, undefined, scheduler);
  const generated = quiz.createDailyQuiz({
    date,
    questions: [{
      questionId: "parser-question",
      kind: "short-answer",
      prompt: "Explain",
      cardIds: ["parser-card"],
      cards: [{ cardId: "parser-card", criterion: "Explain", weight: 1 }],
    }],
  });
  assert.equal(quiz.parseSheet(quiz.renderSheet(generated)).quizId, generated.quizId);
  assert.throws(() => quiz.parseSheet(`${quiz.renderSheet(generated)}\nAnswer key: no`), ValidationError);
  db.close();

  const expiration = setup();
  const card = expiration.scheduler.createCard({ cardId: "old", initialDueAt: `${date}T00:00:00Z`, bindings: [binding("p1")] });
  const oldDate = previousDate(date);
  insertQuizFixture(expiration.db, "old-quiz", oldDate, card.cardId, "old-question");
  const oldQuiz = new QuizService(expiration.db, undefined, expiration.scheduler);
  assert.equal(oldQuiz.expirePrior(date), 1);
  assert.equal(oldQuiz.get(oldDate)?.status, "expired");
  assert.equal(expiration.db.all("SELECT * FROM raw_reviews").length, 0);
  expiration.db.close();
});
