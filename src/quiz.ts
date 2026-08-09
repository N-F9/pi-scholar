import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./vault.js";
import { transaction as databaseTransaction } from "./database.js";
import type {
  CardRating,
  QuizGradeRecord,
  QuizQuestionCardRecord,
  QuizQuestionKind,
  QuizQuestionRecord,
  QuizRecord,
} from "./contracts.js";
import { RATINGS, RevisionConflictError, SchedulerService, ValidationError, localDate } from "./scheduler.js";
import type { SqlDatabase, SqlDatabaseSource, VaultPathsLike } from "./scheduler.js";
export interface QuestionSpecInput {
  readonly questionId?: string;
  readonly kind: QuizQuestionKind;
  readonly prompt: string;
  readonly choices?: readonly string[];
  readonly cardIds: readonly string[];
  readonly cards: readonly QuizQuestionCardRecord[];
  readonly sourceRefs?: readonly string[];
  readonly answerKey?: unknown;
}

export interface QuizDraftInput {
  readonly date: string | Date;
  readonly revision: number;
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
}

export interface ReadingLink {
  readonly pageId: string;
  readonly anchor: string;
  readonly heading?: string;
}

export interface CardGradeInput {
  readonly cardId: string;
  readonly rating: CardRating;
  readonly feedback?: string;
  readonly evidence?: readonly string[];
  readonly readings?: readonly ReadingLink[];
}

export interface QuestionGradeInput {
  readonly questionId: string;
  readonly feedback?: string;
  readonly cards: readonly CardGradeInput[];
  readonly readings?: readonly ReadingLink[];
}

export interface GradeSubmissionInput {
  readonly date: string | Date;
  readonly revision?: number;
  readonly submissionId?: string;
  readonly questions: readonly QuestionGradeInput[];
}

export interface QuizGenerationInput {
  readonly date: string | Date;
  readonly questions?: readonly QuestionSpecInput[];
}

export interface SettledCardResult extends QuizGradeRecord {
  readonly evidence: readonly string[];
  readonly readings: readonly ReadingLink[];
  readonly dueAt?: string;
  readonly fsrsState?: string;
}

export interface SettledQuestionResult {
  readonly questionId: string;
  readonly feedback: string;
  readonly cards: readonly SettledCardResult[];
  readonly readings: readonly ReadingLink[];
}

export interface SettledQuizResult {
  readonly quiz: QuizRecord;
  readonly questions: readonly SettledQuestionResult[];
}

export class QuizConflictError extends Error {
  readonly code = "quiz-conflict";
  constructor(message: string) {
    super(message);
    this.name = "QuizConflictError";
  }
}

const FORBIDDEN_SHEET_TEXT = /answer\s*key|correct\s+answer|grading\s+criteria|rubric/i;

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value as T | undefined) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function changedRows(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const changes = (result as { changes?: number | bigint }).changes;
  return Number(changes ?? 0);
}
function requireDatabaseChange(result: unknown, message: string): void {
  if (changedRows(result) !== 1) throw new RevisionConflictError(message);
}


interface PersistedCardFeedback {
  readonly cardId: string;
  readonly feedback: string;
  readonly evidence: readonly string[];
  readonly readings: readonly ReadingLink[];
}

interface PersistedResultEnvelope {
  readonly version: 1;
  readonly settlementId: string;
  readonly answerRevision: number;
  readonly feedback: string;
  readonly readings: readonly ReadingLink[];
  readonly cards: readonly PersistedCardFeedback[];
}

function encodeResultEnvelope(value: PersistedResultEnvelope): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function validReading(value: unknown): value is ReadingLink {
  if (!value || typeof value !== "object") return false;
  const reading = value as { pageId?: unknown; anchor?: unknown; heading?: unknown };
  return typeof reading.pageId === "string" && Boolean(reading.pageId) && typeof reading.anchor === "string" && Boolean(reading.anchor) && (reading.heading === undefined || typeof reading.heading === "string");
}

function validPersistedCard(value: unknown): value is PersistedCardFeedback {
  if (!value || typeof value !== "object") return false;
  const card = value as { cardId?: unknown; feedback?: unknown; evidence?: unknown; readings?: unknown };
  return typeof card.cardId === "string" && Boolean(card.cardId) && typeof card.feedback === "string" && Array.isArray(card.evidence) && card.evidence.every((item) => typeof item === "string") && Array.isArray(card.readings) && card.readings.every(validReading);
}

function decodeResultEnvelope(value: string): PersistedResultEnvelope | undefined {
  const marker = /^<!-- pi-scholar-result ([A-Za-z0-9_-]+) -->(?:\n|$)/u.exec(value);
  const encoded = marker?.[1];
  if (!encoded) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<PersistedResultEnvelope>;
    if (
      parsed.version !== 1 ||
      typeof parsed.settlementId !== "string" ||
      typeof parsed.answerRevision !== "number" ||
      !Number.isInteger(parsed.answerRevision) ||
      typeof parsed.feedback !== "string" ||
      !Array.isArray(parsed.readings) ||
      !parsed.readings.every(validReading) ||
      !Array.isArray(parsed.cards) ||
      !parsed.cards.every(validPersistedCard)
    ) return undefined;
    return parsed as PersistedResultEnvelope;
  } catch {
    return undefined;
  }
}

function adaptDatabase(source: SqlDatabaseSource): SqlDatabase {
  return {
    exec: (sql) => source.exec(sql),
    run: (sql, ...parameters) => source.run(sql, parameters.length ? parameters : undefined),
    get: (sql, ...parameters) => source.get(sql, parameters.length ? parameters : undefined),
    all: (sql, ...parameters) => source.all(sql, parameters.length ? parameters : undefined),
  };
}

function transaction<T>(source: SqlDatabaseSource, operation: () => T): T {
  return databaseTransaction(source as never, operation);
}

function cleanMarkdown(value: string): string {
  return value.replace(/\r/g, "").replace(/<!--/g, "< !--").trim();
}
function anchorFragment(anchor: string): string {
  return anchor.replace(/^#+/u, "");
}

function answerText(answer: string | readonly string[]): string {
  return typeof answer === "string" ? answer : answer.join(", ");
}

function normalizedAnswer(value: string | readonly string[]): string | readonly string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return String(value);
}

function pathForSheet(paths: VaultPathsLike | undefined, date: string): string | undefined {
  const root = paths?.quizzesRoot ?? paths?.quizzes ?? (paths?.root ? join(paths.root, "quizzes") : undefined);
  return root ? join(root, date.slice(0, 4), date.slice(5, 7), `${date}.md`) : undefined;
}


export class QuizService {
  readonly db: SqlDatabase;
  readonly paths?: VaultPathsLike;
  readonly scheduler: SchedulerService;
  private readonly source: SqlDatabaseSource;

  constructor(source: SqlDatabaseSource, paths?: VaultPathsLike, scheduler?: SchedulerService) {
    this.source = source;
    this.db = adaptDatabase(source);
    this.paths = paths;
    this.scheduler = scheduler ?? new SchedulerService(source, paths);
  }

  get(dateOrQuizId: string | Date): QuizRecord | undefined {
    const key = dateOrQuizId instanceof Date ? localDate(dateOrQuizId) : String(dateOrQuizId);
    const row = this.db.get<Record<string, unknown>>(key.includes("-") && key.length === 10
      ? "SELECT * FROM quizzes WHERE date = ?"
      : "SELECT * FROM quizzes WHERE quiz_id = ?", key);
    return row ? this.mapQuiz(row) : undefined;
  }

  list(): QuizRecord[] {
    return this.db.all<Record<string, unknown>>("SELECT * FROM quizzes ORDER BY date DESC").map((row) => this.mapQuiz(row));
  }

  createDailyQuiz(input: QuizGenerationInput | string | Date, questionSpecs?: readonly QuestionSpecInput[]): QuizRecord {
    const date = localDate(typeof input === "object" && !(input instanceof Date) ? input.date : input);
    if (date !== localDate(new Date())) throw new ValidationError("Daily quizzes may only be created for the current local date");
    const existing = this.get(date);
    if (existing) return existing;
    this.expirePrior(date);
    const selectedCards = this.scheduler.selectDueCards(date);
    const quizId = randomUUID();
    const sheetPath = pathForSheet(this.paths, date);
    const specs = typeof input === "object" && !(input instanceof Date) ? input.questions : questionSpecs;
    if (!selectedCards.length) {
      transaction(this.source, () => {
        this.db.run(
          "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'skipped', NULL, ?, NULL, ?, NULL)",
          quizId,
          date,
          nowIso(),
          "skipped-no-eligible-cards",
        );
      });
      return this.get(date)!;
    }
    try {
      const questions = this.validateQuestionSpecs(specs ?? [], selectedCards.map((card) => card.cardId));
      transaction(this.source, () => {
        this.db.run(
          "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'open', ?, ?, NULL, NULL, NULL)",
          quizId,
          date,
          sheetPath ?? null,
          nowIso(),
        );
        for (const [ordinal, question] of questions.entries()) {
          const questionId = question.questionId?.trim() || randomUUID();
          this.db.run(
            "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, grading_criteria_json, source_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            questionId,
            quizId,
            ordinal,
            question.kind,
            cleanMarkdown(question.prompt),
            question.choices ? json(question.choices) : null,
            question.answerKey === undefined ? null : json(question.answerKey),
            json(question.cards),
            json(question.sourceRefs ?? []),
          );
          for (const card of question.cards) {
            this.db.run(
              "INSERT INTO question_cards (question_id, card_id, criterion_json, weight) VALUES (?, ?, ?, ?)",
              questionId,
              card.cardId,
              json(card.criterion.trim()),
              card.weight,
            );
          }
        }
      });
      const quiz = this.get(date)!;
      this.writeSheet(quiz);
      return quiz;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transaction(this.source, () => {
        this.db.run("DELETE FROM quizzes WHERE quiz_id = ?", quizId);
        this.db.run(
          "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'failed', NULL, ?, NULL, ?, ?)",
          quizId,
          date,
          nowIso(),
          "generation-failed",
          message,
        );
      if (sheetPath) {
        try {
          rmSync(sheetPath, { force: true });
        } catch {
          // The failed outcome remains authoritative if cleanup cannot remove a prior artifact.
        }
      }
      });
      return this.get(date)!;
    }
  }

  saveDraft(input: QuizDraftInput): QuizRecord;
  saveDraft(date: string | Date, revision: number, answers: Readonly<Record<string, string | readonly string[]>>): QuizRecord;
  saveDraft(
    inputOrDate: QuizDraftInput | string | Date,
    expectedRevision?: number,
    draftAnswers?: Readonly<Record<string, string | readonly string[]>>,
  ): QuizRecord {
    const input = typeof inputOrDate === "object" && !(inputOrDate instanceof Date)
      ? inputOrDate
      : { date: inputOrDate, revision: expectedRevision!, answers: draftAnswers ?? {} };
    const date = localDate(input.date);
    const quiz = this.requireQuiz(date);
    if (quiz.status !== "open") throw new QuizConflictError("Only an open quiz accepts drafts");
    if (input.revision !== quiz.revision) throw new RevisionConflictError("The quiz draft revision is stale");
    const questionIds = new Set(quiz.questions.map((question) => question.questionId));
    if (Object.keys(input.answers).some((questionId) => !questionIds.has(questionId))) throw new ValidationError("Draft contains an unknown question");
    const nextRevision = quiz.revision + 1;
    transaction(this.source, () => {
      for (const [questionId, answer] of Object.entries(input.answers)) {
        this.db.run(
          "INSERT INTO quiz_answers (quiz_id, question_id, revision, answer_json, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (quiz_id, question_id) DO UPDATE SET revision = excluded.revision, answer_json = excluded.answer_json, saved_at = excluded.saved_at",
          quiz.quizId,
          questionId,
          nextRevision,
          json(normalizedAnswer(answer)),
          nowIso(),
        );
      }
      this.db.run("UPDATE quiz_answers SET revision = ? WHERE quiz_id = ? AND revision < ?", nextRevision, quiz.quizId, nextRevision);
      const result = this.db.run("UPDATE quizzes SET revision = ? WHERE quiz_id = ? AND status = 'open' AND revision = ?", nextRevision, quiz.quizId, quiz.revision);
      requireDatabaseChange(result, "The quiz draft revision is stale");
    });
    const result = this.requireQuiz(date);
    this.writeSheet(result, this.answerMap(result.quizId));
    return result;
  }

  sealSubmission(input: QuizDraftInput): QuizRecord;
  sealSubmission(date: string | Date, revision: number, answers?: Readonly<Record<string, string | readonly string[]>>): QuizRecord;
  sealSubmission(
    inputOrDate: QuizDraftInput | string | Date,
    expectedRevision?: number,
    submittedAnswers?: Readonly<Record<string, string | readonly string[]>>,
  ): QuizRecord {
    const input = typeof inputOrDate === "object" && !(inputOrDate instanceof Date)
      ? inputOrDate
      : { date: inputOrDate, revision: expectedRevision!, answers: submittedAnswers };
    const date = localDate(input.date);
    const quiz = this.requireQuiz(date);
    if (quiz.status !== "open") throw new QuizConflictError("Only the current open quiz can be submitted");
    if (input.revision !== quiz.revision) throw new RevisionConflictError("The quiz submission revision is stale");
    const existingAnswers = this.answerMap(quiz.quizId);
    const answers = input.answers ?? existingAnswers;
    this.validateCompleteAnswers(quiz, answers);
    transaction(this.source, () => {
      for (const question of quiz.questions) {
        const answer = answers[question.questionId];
        if (answer === undefined) throw new ValidationError(`Missing answer for ${question.questionId}`);
        this.db.run(
          "INSERT INTO quiz_answers (quiz_id, question_id, revision, answer_json, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (quiz_id, question_id) DO UPDATE SET revision = excluded.revision, answer_json = excluded.answer_json, saved_at = excluded.saved_at",
          quiz.quizId,
          question.questionId,
          quiz.revision,
          json(normalizedAnswer(answer)),
          nowIso(),
        );
      }
      const result = this.db.run("UPDATE quizzes SET status = 'submitted', submitted_at = ? WHERE quiz_id = ? AND status = 'open' AND revision = ?", nowIso(), quiz.quizId, quiz.revision);
      requireDatabaseChange(result, "The quiz submission revision is stale");
    });
    const result = this.requireQuiz(date);
    this.writeSheet(result, this.answerMap(result.quizId));
    return result;
  }

  expirePrior(date: string | Date): number {
    const day = localDate(date);
    const result = this.db.run("UPDATE quizzes SET status = 'expired' WHERE status = 'open' AND date < ?", day) as { changes?: number | bigint } | undefined;
    return Number(result?.changes ?? 0);
  }

  settleGrade(input: GradeSubmissionInput): SettledQuizResult;
  settleGrade(date: string | Date, submission: Omit<GradeSubmissionInput, "date">): SettledQuizResult;
  settleGrade(inputOrDate: GradeSubmissionInput | string | Date, submission?: Omit<GradeSubmissionInput, "date">): SettledQuizResult {
    const input = typeof inputOrDate === "object" && !(inputOrDate instanceof Date)
      ? inputOrDate
      : { ...(submission ?? { questions: [] }), date: inputOrDate };
    const date = localDate(input.date);
    const quiz = this.requireQuiz(date);
    if (quiz.status === "expired") throw new QuizConflictError("Expired quizzes cannot be graded");
    if (quiz.status !== "submitted") throw new QuizConflictError("The quiz must be sealed before grading");
    if (input.revision !== undefined && input.revision !== quiz.revision) throw new RevisionConflictError("The graded answer revision is stale");
    const settlementId = `${quiz.quizId}:r${quiz.revision}:s${input.submissionId ?? ""}`;
    const prior = this.readSettledResults(quiz);
    if (prior) {
      const persistedSettlement = this.readSettlementIdentity(quiz);
      if (persistedSettlement && persistedSettlement !== settlementId) throw new QuizConflictError("The quiz already has a different committed settlement");
      this.writeSheet(prior.quiz, this.answerMap(prior.quiz.quizId), prior.questions);
      return prior;
    }
    const answerRows = this.db.all<Record<string, unknown>>("SELECT question_id, revision FROM quiz_answers WHERE quiz_id = ?", quiz.quizId);
    if (answerRows.length !== quiz.questions.length || answerRows.some((row) => Number(row.revision) !== quiz.revision)) {
      throw new ValidationError("The sealed quiz answers do not match the committed revision");
    }
    const questionById = new Map(quiz.questions.map((question) => [question.questionId, question]));
    if (input.questions.length !== quiz.questions.length || input.questions.some((question) => !questionById.has(question.questionId))) {
      throw new ValidationError("Grading must cover every displayed question exactly once");
    }
    const seenQuestions = new Set<string>();
    const seenCardsOverall = new Set<string>();
    for (const questionGrade of input.questions) {
      if (seenQuestions.has(questionGrade.questionId)) throw new ValidationError("A question was graded more than once");
      seenQuestions.add(questionGrade.questionId);
      const question = questionById.get(questionGrade.questionId);
      if (!question) throw new ValidationError("Grading references an unknown question");
      const expectedCards = new Set(question.cardIds);
      if (questionGrade.cards.length !== expectedCards.size || questionGrade.cards.some((card) => !expectedCards.has(card.cardId))) throw new ValidationError("Every card tested by a question requires one grade");
      this.validateQuestionReadings(question.cardIds, questionGrade.readings ?? []);
      const seenCards = new Set<string>();
      for (const card of questionGrade.cards) {
        if (seenCards.has(card.cardId)) throw new ValidationError("A card was graded more than once in one question");
        seenCards.add(card.cardId);
        if (seenCardsOverall.has(card.cardId)) throw new ValidationError("A card cannot be graded by more than one question");
        seenCardsOverall.add(card.cardId);
        if (!RATINGS.includes(card.rating)) throw new ValidationError(`Unsupported FSRS rating: ${card.rating}`);
        const evidence = (card.evidence ?? []).map((item) => item.trim()).filter(Boolean);
        if (!evidence.length) throw new ValidationError(`Every card grade requires evidence: ${card.cardId}`);
        this.validateReadings(card.cardId, card.readings ?? []);
      }
    }
    if (seenCardsOverall.size !== quiz.questions.flatMap((question) => question.cardIds).length) {
      throw new ValidationError("Grading must cover every selected card exactly once");
    }
    const settledAt = nowIso();
    const results: SettledQuestionResult[] = [];
    transaction(this.source, () => {
      for (const questionGrade of input.questions) {
        const question = questionById.get(questionGrade.questionId);
        if (!question) throw new ValidationError("Grading references an unknown question");
        const questionFeedback = questionGrade.feedback?.trim() || "";
        const explicitReadings = [...(questionGrade.readings ?? [])];
        const fallbackReadings = question.cardIds.flatMap((cardId) => this.scheduler.bindings(cardId).map((binding) => ({ pageId: binding.pageId, anchor: binding.anchor, heading: binding.heading })));
        const questionReadings = this.uniqueReadings(explicitReadings.length ? explicitReadings : fallbackReadings);
        const cardResults: SettledCardResult[] = [];
        for (const cardInput of questionGrade.cards) {
          const raw = this.scheduler.transitionCardInTransaction(cardInput.cardId, cardInput.rating, settledAt, {
            quizId: quiz.quizId,
            questionId: question.questionId,
            answerRevision: quiz.revision,
            settlementId,
          });
          this.db.run("INSERT INTO card_results (result_id, quiz_id, question_id, card_id, rating, review_id) VALUES (?, ?, ?, ?, ?, ?)", randomUUID(), quiz.quizId, question.questionId, cardInput.cardId, cardInput.rating, raw.reviewId);
          const after = this.scheduler.getCard(cardInput.cardId);
          const cardReadings = this.uniqueReadings([...(cardInput.readings ?? []), ...questionReadings]);
          cardResults.push({
            gradeId: raw.reviewId,
            quizId: quiz.quizId,
            questionId: question.questionId,
            cardId: cardInput.cardId,
            rating: cardInput.rating,
            feedback: cardInput.feedback?.trim() || questionFeedback,
            gradedAt: settledAt,
            evidence: (cardInput.evidence ?? []).map((item) => item.trim()).filter(Boolean),
            readings: cardReadings,
            dueAt: after.dueAt,
            fsrsState: after.fsrsState,
          });
        }
        const resultId = randomUUID();
        this.db.run(
          "INSERT INTO question_results (result_id, quiz_id, question_id, answer_revision, feedback, graded_at) VALUES (?, ?, ?, ?, ?, ?)",
          resultId,
          quiz.quizId,
          question.questionId,
          quiz.revision,
          this.persistFeedback(questionFeedback, questionReadings, questionGrade.cards, settlementId, quiz.revision),
          settledAt,
        );
        const readings = this.uniqueReadings(cardResults.flatMap((card) => card.readings));
        results.push({ questionId: question.questionId, feedback: questionFeedback, cards: cardResults, readings });
      }
    });
    const settled = { quiz: this.requireQuiz(date), questions: results };
    this.writeSheet(settled.quiz, this.answerMap(settled.quiz.quizId), results);
    return settled;
  }

  renderSheet(quiz: QuizRecord, answers?: Readonly<Record<string, string | readonly string[]>>, results?: readonly SettledQuestionResult[]): string {
    const lines = [
      `# Pi Scholar Quiz — ${quiz.date}`,
      "",
      `<!-- pi-scholar quiz-id=${quiz.quizId} revision=${quiz.revision} -->`,
      "",
    ];
    for (const [index, question] of quiz.questions.entries()) {
      lines.push(`## ${index + 1}. ${question.questionId}`, "", `**Mode:** ${question.kind}`, "", cleanMarkdown(question.prompt), "", `**Review cards:** ${question.cardIds.join(", ")}`);
      if (question.sourceRefs.length) lines.push(`**Bound sections:** ${question.sourceRefs.map(cleanMarkdown).join(", ")}`, "");
      if (question.choices?.length) for (const choice of question.choices) lines.push(`- [ ] ${cleanMarkdown(choice)}`);
      lines.push("", "### Your answer", cleanMarkdown(answerText(answers?.[question.questionId] ?? "")), "");
      if (results) {
        const result = results.find((entry) => entry.questionId === question.questionId);
        if (result) {
          lines.push("### Results", cleanMarkdown(result.feedback || "No feedback."));
          if (result.readings.length) lines.push("", "Readings:", ...result.readings.map((reading) => `- [${reading.heading ?? reading.anchor}](wiki/${reading.pageId}#${anchorFragment(reading.anchor)})`));
          lines.push("");
        }
      }
    }
    if (!results) lines.push("## Results", "", "_Not graded yet._", "");
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  parseSheet(markdown: string): QuizRecord {
    if (FORBIDDEN_SHEET_TEXT.test(markdown)) throw new ValidationError("Quiz sheets may not contain answer keys or private grading material");
    const header = /^# Pi Scholar Quiz — (\d{4}-\d{2}-\d{2})\s*$/m.exec(markdown);
    const identity = /<!--\s*pi-scholar quiz-id=([^\s]+) revision=(\d+)\s*-->/m.exec(markdown);
    const date = header?.[1];
    const quizId = identity?.[1];
    const revisionText = identity?.[2];
    if (!date || !quizId || !revisionText) throw new ValidationError("Invalid canonical quiz sheet header");
    const revision = Number(revisionText);
    if (!Number.isInteger(revision) || revision < 1) throw new ValidationError("Invalid canonical quiz revision");
    const stored = this.get(date);
    if (!stored || stored.quizId !== quizId || stored.revision !== revision) throw new ValidationError("Quiz sheet identity does not match SQLite");
    const answerRows = this.db.all<Record<string, unknown>>("SELECT question_id, revision FROM quiz_answers WHERE quiz_id = ?", stored.quizId);
    if (answerRows.some((row) => Number(row.revision) !== stored.revision)) throw new ValidationError("Quiz sheet answers are not at the committed revision");
    const questionIds = new Set(stored.questions.map((question) => question.questionId));
    if (answerRows.some((row) => !questionIds.has(String(row.question_id)))) throw new ValidationError("Quiz sheet contains an unknown answer");
    if ((stored.status === "submitted" || stored.status === "expired") && answerRows.length !== stored.questions.length) throw new ValidationError("Quiz sheet answers are incomplete");
    const sections = [...markdown.matchAll(/^## (\d+)\. ([^\n]+)\n\n\*\*Mode:\*\* (short-answer|multiple-choice)\n\n([\s\S]*?)(?=^## |(?![\s\S]))/gmi)];
    if (sections.length !== stored.questions.length) throw new ValidationError("Quiz sheet questions do not match SQLite");
    for (const [ordinal, match] of sections.entries()) {
      const ordinalText = match[1];
      const questionId = match[2];
      const kind = match[3];
      const body = match[4];
      const expected = stored.questions[ordinal];
      if (!ordinalText || !questionId || !kind || body === undefined || !expected || Number(ordinalText) !== ordinal + 1) throw new ValidationError("Quiz sheet question identity is invalid");
      const cardLine = /^\*\*Review cards:\*\*\s*(.+)$/mi.exec(body);
      const refsLine = /^\*\*Bound sections:\*\*\s*(.+)$/mi.exec(body);
      const cardText = cardLine?.[1];
      const refsText = refsLine?.[1];
      const prompt = body
        .replace(/\n### Your answer[\s\S]*$/i, "")
        .replace(/^\*\*Review cards:\*\*.*$/gim, "")
        .replace(/^\*\*Bound sections:\*\*.*$/gim, "")
        .replace(/^- \[ \] .*$/gim, "")
        .trim();
      const choices = [...body.matchAll(/^- \[ \] (.+)$/gim)].map((choice) => choice[1]).filter((choice): choice is string => choice !== undefined);
      const cardIds = cardText ? cardText.split(/,\s*/u) : [];
      const sourceRefs = refsText ? refsText.split(/,\s*/u) : [];
      if (
        questionId.trim() !== expected.questionId ||
        kind.toLowerCase() !== expected.kind ||
        cleanMarkdown(prompt) !== cleanMarkdown(expected.prompt) ||
        JSON.stringify(choices.length ? choices : undefined) !== JSON.stringify(expected.choices) ||
        JSON.stringify(cardIds) !== JSON.stringify(expected.cardIds) ||
        JSON.stringify(sourceRefs) !== JSON.stringify(expected.sourceRefs)
      ) throw new ValidationError("Quiz sheet question content does not match SQLite");
    }
    const settled = this.readSettledResults(stored);
    const canonical = this.renderSheet(stored, this.answerMap(stored.quizId), settled?.questions);
    if (cleanMarkdown(markdown) !== cleanMarkdown(canonical)) throw new ValidationError("Quiz sheet answers or Results do not match SQLite");
    return stored;
  }

  private requireQuiz(date: string): QuizRecord {
    const quiz = this.get(date);
    if (!quiz) throw new ValidationError(`No quiz for ${date}`);
    return quiz;
  }

  private mapQuiz(row: Record<string, unknown>): QuizRecord {
    const quizId = String(row.quiz_id);
    const questions = this.db.all<Record<string, unknown>>("SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY ordinal", quizId).map((question) => {
      const questionId = String(question.question_id);
      const cardRows = this.db.all<Record<string, unknown>>("SELECT card_id, criterion_json, weight FROM question_cards WHERE question_id = ? ORDER BY card_id", questionId);
      const criteriaById = new Map<string, { criterion?: unknown; weight?: unknown }>();
      const persistedCriteria = parseJson<unknown>(question.grading_criteria_json, []);
      if (Array.isArray(persistedCriteria)) {
        for (const value of persistedCriteria) {
          if (!value || typeof value !== "object") continue;
          const item = value as { cardId?: unknown; criterion?: unknown; weight?: unknown };
          if (typeof item.cardId === "string") criteriaById.set(item.cardId, { criterion: item.criterion, weight: item.weight });
        }
      }
      for (const card of cardRows) criteriaById.set(String(card.card_id), { criterion: card.criterion_json, weight: card.weight });
      const cards = [...criteriaById.entries()].map(([cardId, criterionData]) => {
        const parsed = parseJson<unknown>(criterionData.criterion, "");
        const criterion = typeof parsed === "string"
          ? parsed
          : parsed && typeof parsed === "object" && "criterion" in parsed
            ? String((parsed as { criterion?: unknown }).criterion ?? "")
            : String(parsed ?? "");
        return { cardId, criterion, weight: Number(criterionData.weight ?? 0) } satisfies QuizQuestionCardRecord;
      });
      return {
        questionId,
        quizId,
        ordinal: Number(question.ordinal),
        kind: String(question.kind) as QuizQuestionKind,
        prompt: String(question.prompt),
        choices: parseJson<string[] | undefined>(question.choices_json, undefined),
        cardIds: cards.map((card) => card.cardId),
        cards,
        sourceRefs: parseJson<string[]>(question.source_refs_json, []),
      } satisfies QuizQuestionRecord;
    });
    return {
      quizId,
      date: String(row.date),
      revision: Number(row.revision),
      status: String(row.status) as QuizRecord["status"],
      questions,
      sheetPath: row.sheet_path ? String(row.sheet_path) : undefined,
      generatedAt: row.generated_at ? String(row.generated_at) : undefined,
      submittedAt: row.submitted_at ? String(row.submitted_at) : undefined,
    };
  }

  private validateQuestionSpecs(specs: readonly QuestionSpecInput[], selectedCardIds: readonly string[]): readonly QuestionSpecInput[] {
    if (!specs.length) throw new ValidationError("Quiz generation produced no question specifications");
    if (specs.length > 4) throw new ValidationError("A daily quiz may contain at most four questions");
    if (specs.filter((question) => question.cardIds.length > 1).length > 2) throw new ValidationError("A daily quiz may contain at most two synthesis questions");
    const selected = new Set(selectedCardIds);
    const covered = new Set<string>();
    const assigned = new Set<string>();
    const questionIds = new Set<string>();
    for (const question of specs) {
      const prompt = question.prompt.trim();
      if (!prompt || FORBIDDEN_SHEET_TEXT.test(prompt)) throw new ValidationError("Question prompts must be nonempty and answer-key-free");
      if (!question.cardIds.length || new Set(question.cardIds).size !== question.cardIds.length) throw new ValidationError("Question card bindings must be distinct and nonempty");
      if (!Array.isArray(question.cards) || question.cards.length !== question.cardIds.length) throw new ValidationError("Every question card requires a grading criterion and weight");
      for (const [index, card] of question.cards.entries()) {
        if (!card || card.cardId !== question.cardIds[index] || !card.criterion.trim() || !Number.isFinite(card.weight) || card.weight <= 0) {
          throw new ValidationError("Every question card requires a nonempty criterion and positive weight");
        }
      }
      if (question.cardIds.some((cardId) => !selected.has(cardId))) throw new ValidationError("Question references a card outside today's eligible selection");
      if (question.cardIds.some((cardId) => assigned.has(cardId))) throw new ValidationError("A card cannot be tested by more than one question");
      for (const cardId of question.cardIds) {
        covered.add(cardId);
        assigned.add(cardId);
      }
      if (question.questionId && questionIds.has(question.questionId)) throw new ValidationError("Question IDs must be distinct");
      if (question.questionId) questionIds.add(question.questionId);
      if (question.kind === "multiple-choice" && (!question.choices || question.choices.length < 2 || new Set(question.choices).size !== question.choices.length)) throw new ValidationError("Multiple-choice questions require distinct options");
      if (question.choices?.some((choice) => !choice.trim() || FORBIDDEN_SHEET_TEXT.test(choice))) throw new ValidationError("Question options must be nonempty and answer-key-free");
    }
    if (covered.size !== selected.size) throw new ValidationError("Daily quiz questions must cover every selected card");
    for (const cardId of selected) if (!covered.has(cardId)) throw new ValidationError("Daily quiz questions must cover every selected card");
    return specs;
  }

  private validateCompleteAnswers(quiz: QuizRecord, answers: Readonly<Record<string, string | readonly string[]>>): void {
    for (const question of quiz.questions) {
      const answer = answers[question.questionId];
      if (answer === undefined || answerText(answer).trim() === "") throw new ValidationError(`Missing answer for ${question.questionId}`);
      if (question.kind === "multiple-choice") {
        const values = Array.isArray(answer) ? answer : [answer];
        if (values.some((value) => !question.choices?.includes(value))) throw new ValidationError(`Invalid choice for ${question.questionId}`);
      }
      if (FORBIDDEN_SHEET_TEXT.test(answerText(answer))) throw new ValidationError("Answers may not contain private grading material");
    }
  }

  private answerMap(quizId: string): Record<string, string | readonly string[]> {
    const answers: Record<string, string | readonly string[]> = {};
    for (const row of this.db.all<Record<string, unknown>>("SELECT question_id, answer_json FROM quiz_answers WHERE quiz_id = ?", quizId)) answers[String(row.question_id)] = parseJson(row.answer_json, "");
    return answers;
  }

  private validateReadings(cardId: string, readings: readonly ReadingLink[]): void {
    const bindings = this.scheduler.bindings(cardId);
    for (const reading of readings) if (!bindings.some((binding) => binding.pageId === reading.pageId && binding.anchor === reading.anchor)) throw new ValidationError(`Reading is not an exact binding for ${cardId}`);
  }
  private validateQuestionReadings(cardIds: readonly string[], readings: readonly ReadingLink[]): void {
    const bindings = cardIds.flatMap((cardId) => this.scheduler.bindings(cardId));
    for (const reading of readings) if (!bindings.some((binding) => binding.pageId === reading.pageId && binding.anchor === reading.anchor)) throw new ValidationError("Reading is not an exact question binding");
  }

  private uniqueReadings(readings: readonly ReadingLink[]): ReadingLink[] {
    const seen = new Set<string>();
    const unique: ReadingLink[] = [];
    for (const reading of readings) {
      const key = `${reading.pageId}#${reading.anchor}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(reading);
      }
    }
    return unique;
  }

  private persistFeedback(feedback: string, readings: readonly ReadingLink[], cards: readonly CardGradeInput[], settlementId: string, answerRevision: number): string {
    const envelope: PersistedResultEnvelope = {
      version: 1,
      settlementId,
      answerRevision,
      feedback,
      readings,
      cards: cards.map((card) => ({
        cardId: card.cardId,
        feedback: card.feedback?.trim() || feedback,
        evidence: (card.evidence ?? []).map((item) => item.trim()).filter(Boolean),
        readings: card.readings ?? [],
      })),
    };
    const cardFeedback = cards
      .filter((card) => card.feedback?.trim() || card.evidence?.some((item) => item.trim()))
      .map((card) => {
        const details = [`${card.cardId}: ${card.feedback?.trim() || feedback}`];
        const evidence = (card.evidence ?? []).map((item) => item.trim()).filter(Boolean);
        if (evidence.length) details.push(`Evidence: ${evidence.join("; ")}`);
        return details.join("\n");
      });
    const links = readings.map((reading) => `[${reading.heading ?? reading.anchor}](wiki/${reading.pageId}#${anchorFragment(reading.anchor)})`);
    const human = [feedback, ...cardFeedback, links.length ? `Readings: ${links.join(", ")}` : ""].filter(Boolean).join("\n\n") || "No feedback.";
    return `<!-- pi-scholar-result ${encodeResultEnvelope(envelope)} -->\n${human}`;
  }

  private readSettlementIdentity(quiz: QuizRecord): string | undefined {
    const row = this.db.get<Record<string, unknown>>("SELECT feedback FROM question_results WHERE quiz_id = ? ORDER BY graded_at, question_id LIMIT 1", quiz.quizId);
    return row ? decodeResultEnvelope(String(row.feedback))?.settlementId : undefined;
  }

  private readSettledResults(quiz: QuizRecord): SettledQuizResult | undefined {
    const rows = this.db.all<Record<string, unknown>>("SELECT * FROM question_results WHERE quiz_id = ? ORDER BY graded_at, question_id", quiz.quizId);
    const cardCount = this.db.get<Record<string, unknown>>("SELECT COUNT(*) AS count FROM card_results WHERE quiz_id = ?", quiz.quizId);
    if (!rows.length) {
      if (Number(cardCount?.count ?? 0) !== 0) throw new ValidationError("Committed grade is missing question Results");
      return undefined;
    }
    if (rows.length !== quiz.questions.length) throw new ValidationError("Committed grade is incomplete");
    const rowByQuestion = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const questionId = String(row.question_id);
      if (rowByQuestion.has(questionId)) throw new ValidationError("Committed grade contains duplicate question Results");
      rowByQuestion.set(questionId, row);
    }
    const questions: SettledQuestionResult[] = [];
    const seenCards = new Set<string>();
    let settlementId: string | undefined;
    for (const question of quiz.questions) {
      const row = rowByQuestion.get(question.questionId);
      if (!row) throw new ValidationError("Committed grade is missing a question Result");
      if (Number(row.answer_revision) !== quiz.revision) throw new ValidationError("Committed grade revision does not match the sealed submission");
      const envelope = decodeResultEnvelope(String(row.feedback));
      if (!envelope || envelope.answerRevision !== quiz.revision) throw new ValidationError("Committed grade feedback is not durable");
      if (settlementId === undefined) settlementId = envelope.settlementId;
      if (settlementId !== envelope.settlementId) throw new ValidationError("Committed grade settlement identity is inconsistent");
      const cardRows = this.db.all<Record<string, unknown>>("SELECT * FROM card_results WHERE quiz_id = ? AND question_id = ? ORDER BY card_id", quiz.quizId, question.questionId);
      if (cardRows.length !== question.cardIds.length) throw new ValidationError("Committed grade is missing a card Result");
      const expectedCards = new Set(question.cardIds);
      const cards: SettledCardResult[] = [];
      for (const cardRow of cardRows) {
        const cardId = String(cardRow.card_id);
        if (!expectedCards.has(cardId) || seenCards.has(cardId)) throw new ValidationError("Committed grade contains an unexpected or duplicate card Result");
        seenCards.add(cardId);
        const persistedCard = envelope.cards.find((card) => card.cardId === cardId);
        if (!persistedCard) throw new ValidationError("Committed grade is missing per-card feedback");
        const current = this.scheduler.getCard(cardId);
        const cardReadings = this.uniqueReadings([...(envelope.readings ?? []), ...(persistedCard.readings ?? [])]);
        cards.push({
          gradeId: String(cardRow.review_id),
          quizId: quiz.quizId,
          questionId: question.questionId,
          cardId,
          rating: String(cardRow.rating) as CardRating,
          feedback: persistedCard.feedback,
          gradedAt: String(row.graded_at),
          evidence: persistedCard.evidence,
          readings: cardReadings,
          dueAt: current.dueAt,
          fsrsState: current.fsrsState,
        });
      }
      if (envelope.cards.length !== question.cardIds.length) throw new ValidationError("Committed grade has incomplete per-card feedback");
      const readings = this.uniqueReadings([...(envelope.readings ?? []), ...cards.flatMap((card) => card.readings)]);
      questions.push({ questionId: question.questionId, feedback: envelope.feedback, cards, readings });
    }
    if (seenCards.size !== quiz.questions.flatMap((question) => question.cardIds).length) throw new ValidationError("Committed grade has incomplete card Results");
    return { quiz, questions };
  }

  private writeSheet(quiz: QuizRecord, answers?: Readonly<Record<string, string | readonly string[]>>, results?: readonly SettledQuestionResult[]): void {
    const sheetPath = quiz.sheetPath ?? pathForSheet(this.paths, quiz.date);
    if (!sheetPath) return;
    mkdirSync(join(sheetPath, ".."), { recursive: true });
    atomicWriteFile(sheetPath, this.renderSheet(quiz, answers, results));
  }
}

export { FORBIDDEN_SHEET_TEXT };
