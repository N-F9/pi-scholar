import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, readFileNoFollow, safeRelativePath } from "./vault.js";
import { parseWikiSections } from "./wiki-sections.js";
import { transaction as databaseTransaction } from "./database.js";
import type {
  CardRating,
  QuizEvidenceRecord,
  QuizGradeRecord,
  QuizQuestionCardRecord,
  QuizQuestionKind,
  QuizQuestionRecord,
  QuizRecord,
  ReviewCardRecord,
  WorkflowRecord,
} from "./contracts.js";
import { RATINGS, RevisionConflictError, SEALED_QUIZ_REVIEW, SchedulerService, ValidationError, localDate } from "./scheduler.js";
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
export interface QuizSubmissionInput {
  readonly date: string | Date;
  readonly revision: number;
  readonly answers?: Readonly<Record<string, string | readonly string[]>>;
}


export interface CardGradeInput {
  readonly cardId: string;
  readonly rating: CardRating;
  readonly feedback?: string;
  readonly evidence: readonly string[];
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
  readonly selectedCardIds?: readonly string[];
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
interface PreparedCardGrade {
  readonly input: CardGradeInput;
  readonly evidence: readonly string[];
  readonly evidenceRecords: readonly QuizEvidenceRecord[];
  readonly readings: readonly ReadingLink[];
  readonly feedback: string;
}

interface PreparedQuestionGrade {
  readonly input: QuestionGradeInput;
  readonly question: QuizQuestionRecord;
  readonly feedback: string;
  readonly readings: readonly ReadingLink[];
  readonly cards: readonly PreparedCardGrade[];
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
interface PreparedSeal {
  readonly date: string;
  readonly quiz: QuizRecord;
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
  readonly submittedAt: string;
  readonly rendered: string;
  readonly sheetPath?: string;
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
  return value.replace(/\r/g, "").replace(/<!--/g, "< !--").replace(/^(#{1,6})(?=\s)/gmu, "\\$1").trim();
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
export function evidenceReference(cardId: string, pageId: string, anchor: string, pageDigest: string, pageRevision: number, textDigest: string): string {
  return createHash("sha256").update(JSON.stringify([cardId, pageId, anchor, pageDigest, pageRevision, textDigest])).digest("hex");
}
function validWikiPath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.includes("\\") && !value.includes("\u0000") && !value.split("/").some((segment) => segment === "..") && !/^[A-Za-z]:/u.test(value);
}
function encodeHrefComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}


function boundedUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
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
  /** Snapshot current binding/page metadata for internal graders; never expose this through browser DTOs. */
  gradingEvidence(quizOrDate: QuizRecord | string | Date): QuizEvidenceRecord[] {
    const quiz = typeof quizOrDate === "object" && !(quizOrDate instanceof Date) ? quizOrDate : this.get(quizOrDate);
    if (!quiz) throw new ValidationError("No quiz for grading evidence");
    if (this.paths?.wiki) return this.uniqueEvidence(quiz.questions.flatMap((question) => question.cardIds.flatMap((cardId) => this.evidenceForCard(cardId))));
    return this.snapshotEvidence(quiz);
  }

  private selectedCardsFor(date: string, selectedCardIds?: readonly string[]): ReviewCardRecord[] {
    const due = this.scheduler.selectDueCards(date);
    if (selectedCardIds === undefined) return due;
    const ids = selectedCardIds.map((cardId) => cardId.trim());
    if (new Set(ids).size !== ids.length || ids.some((cardId) => !cardId)) throw new ValidationError("Quiz card selection contains duplicate or empty IDs");
    const byId = new Map(due.map((card) => [card.cardId, card]));
    if (ids.some((cardId) => !byId.has(cardId))) throw new ValidationError("Quiz card selection is not due and eligible");
    return ids.map((cardId) => byId.get(cardId)!);
  }

  createDailyQuiz(input: QuizGenerationInput | string | Date, questionSpecs?: readonly QuestionSpecInput[]): QuizRecord {
    const date = localDate(typeof input === "object" && !(input instanceof Date) ? input.date : input);
    const existing = this.get(date);
    if (existing) return existing;
    const selectedCardIds = typeof input === "object" && !(input instanceof Date) ? input.selectedCardIds : undefined;
    const selectedCards = this.selectedCardsFor(date, selectedCardIds);
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
    const validated = this.validateQuestionSpecs(specs ?? [], selectedCards.map((card) => card.cardId));
    const questions = validated.map((question, ordinal) => ({
      questionId: question.questionId?.trim() || randomUUID(),
      quizId,
      ordinal,
      kind: question.kind,
      prompt: cleanMarkdown(question.prompt),
      choices: question.choices,
      cardIds: [...question.cardIds],
      cards: question.cards.map((card) => ({ cardId: card.cardId, criterion: card.criterion.trim(), weight: card.weight })),
      sourceRefs: [...(question.sourceRefs ?? [])],
    } satisfies QuizQuestionRecord));
    const evidence = this.uniqueEvidence(selectedCards.flatMap((card) => this.evidenceForCard(card.cardId)));
    const preview: QuizRecord = { quizId, date, revision: 1, status: "open", questions };
    const rendered = this.renderSheet(preview);
    this.validateRenderedSheet(rendered);
    try {
      this.replaceSheet(sheetPath, rendered, () => transaction(this.source, () => {
        this.db.run(
          "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'open', ?, ?, NULL, NULL, NULL)",
          quizId,
          date,
          sheetPath ?? null,
          nowIso(),
        );
        for (const item of evidence) {
          this.db.run(
            "INSERT INTO quiz_evidence (quiz_id, card_id, reference, page_id, relative_path, anchor, heading, page_digest, page_revision, text_digest, excerpt, excerpt_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            quizId,
            item.cardId,
            item.reference,
            item.pageId,
            item.path,
            item.anchor,
            item.heading ?? null,
            item.pageDigest,
            item.pageRevision,
            item.textDigest,
            item.excerpt,
            createHash("sha256").update(item.excerpt).digest("hex"),
          );
        }
        for (const question of questions) {
          this.db.run(
            "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, grading_criteria_json, source_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            question.questionId,
            quizId,
            question.ordinal,
            question.kind,
            question.prompt,
            question.choices ? json(question.choices) : null,
            null,
            json(question.cards),
            json(question.sourceRefs),
          );
          for (const card of question.cards) {
            this.db.run(
              "INSERT INTO question_cards (question_id, card_id, criterion_json, weight) VALUES (?, ?, ?, ?)",
              question.questionId,
              card.cardId,
              json(card.criterion),
              card.weight,
            );
          }
        }
      }));
      return this.get(date)!;
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
    for (const answer of Object.values(input.answers)) this.validateAnswerText(answer);
    const nextRevision = quiz.revision + 1;
    const answers = { ...this.answerMap(quiz.quizId), ...input.answers };
    const preview: QuizRecord = { ...quiz, revision: nextRevision };
    const rendered = this.renderSheet(preview, answers);
    this.validateRenderedSheet(rendered);
    const result = this.replaceSheet(preview.sheetPath ?? pathForSheet(this.paths, date), rendered, () => {
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
        const update = this.db.run("UPDATE quizzes SET revision = ? WHERE quiz_id = ? AND status = 'open' AND revision = ?", nextRevision, quiz.quizId, quiz.revision);
        requireDatabaseChange(update, "The quiz draft revision is stale");
      });
      return this.requireQuiz(date);
    });
    return result;
  }


  sealSubmission(input: QuizDraftInput): QuizRecord;
  sealSubmission(date: string | Date, revision: number, answers?: Readonly<Record<string, string | readonly string[]>>): QuizRecord;
  sealSubmission(
    inputOrDate: QuizDraftInput | string | Date,
    expectedRevision?: number,
    submittedAnswers?: Readonly<Record<string, string | readonly string[]>>,
  ): QuizRecord {
    const input: QuizSubmissionInput = typeof inputOrDate === "object" && !(inputOrDate instanceof Date)
      ? inputOrDate
      : { date: inputOrDate, revision: expectedRevision!, answers: submittedAnswers };
    const prepared = this.prepareSeal(input);
    return this.replaceSheet(prepared.sheetPath, prepared.rendered, () => {
      transaction(this.source, () => this.sealInTransaction(prepared));
      return this.requireQuiz(prepared.date);
    });
  }

  sealSubmissionAndQueue(
    input: QuizSubmissionInput,
    requestId: string,
    enqueue: (requestId: string, quiz: QuizRecord) => WorkflowRecord,
  ): { readonly quiz: QuizRecord; readonly workflow: WorkflowRecord } {
    const prepared = this.prepareSeal(input);
    return this.replaceSheet(prepared.sheetPath, prepared.rendered, () => {
      let workflow: WorkflowRecord | undefined;
      transaction(this.source, () => {
        const sealed = this.sealInTransaction(prepared);
        workflow = enqueue(requestId, sealed);
      });
      const quiz = this.requireQuiz(prepared.date);
      if (!workflow) throw new Error("quiz grader workflow disappeared");
      return { quiz, workflow };
    });
  }

  expirePrior(date: string | Date): number {
    const day = localDate(date);
    const result = this.db.run("UPDATE quizzes SET status = 'expired' WHERE status = 'open' AND date < ?", day) as { changes?: number | bigint } | undefined;
    return Number(result?.changes ?? 0);
  }
  expireOpenQuizIds(quizIds: readonly string[]): number {
    const ids = [...new Set(quizIds.map((quizId) => quizId.trim()).filter(Boolean))];
    if (!ids.length) return 0;
    const quizzes = ids.flatMap((quizId) => {
      const quiz = this.get(quizId);
      return quiz?.status === "open" ? [quiz] : [];
    });
    if (!quizzes.length) return 0;
    const sheets = quizzes.map((quiz) => {
      const sheetPath = quiz.sheetPath ?? pathForSheet(this.paths, quiz.date);
      const previous = sheetPath && existsSync(sheetPath) ? readFileNoFollow(sheetPath) : undefined;
      const expired = { ...quiz, status: "expired" as const };
      return {
        sheetPath,
        previous,
        rendered: this.renderSheet(expired, this.answerMap(quiz.quizId), this.readSettledResults(quiz)?.questions),
      };
    });
    try {
      for (const [index, sheet] of sheets.entries()) {
        this.replaceSheet(sheet.sheetPath, sheet.rendered, () => {
          if (index !== sheets.length - 1) return;
          transaction(this.source, () => {
            const result = this.db.run(
              `UPDATE quizzes SET status = 'expired' WHERE status = 'open' AND quiz_id IN (${ids.map(() => "?").join(", ")})`,
              ...ids,
            ) as { changes?: number | bigint } | undefined;
            if (Number(result?.changes ?? 0) !== quizzes.length) throw new RevisionConflictError("Quiz expiration revision is stale");
          });
        });
      }
    } catch (error) {
      for (const sheet of sheets) {
        if (!sheet.sheetPath) continue;
        try {
          if (sheet.previous === undefined) rmSync(sheet.sheetPath, { force: true });
          else atomicWriteFile(sheet.sheetPath, sheet.previous);
        } catch {
          // Preserve the expiration error; a later canonical rewrite can recover the projection.
        }
      }
      throw error;
    }
    return quizzes.length;
  }

  settleGrade(input: GradeSubmissionInput, afterPersist?: (result: SettledQuizResult) => void): SettledQuizResult;
  settleGrade(date: string | Date, submission: Omit<GradeSubmissionInput, "date">, afterPersist?: (result: SettledQuizResult) => void): SettledQuizResult;
  settleGrade(
    inputOrDate: GradeSubmissionInput | string | Date,
    submissionOrAfterPersist?: Omit<GradeSubmissionInput, "date"> | ((result: SettledQuizResult) => void),
    afterPersist?: (result: SettledQuizResult) => void,
  ): SettledQuizResult {
    const callback = typeof submissionOrAfterPersist === "function" ? submissionOrAfterPersist : afterPersist;
    const submission = typeof submissionOrAfterPersist === "function" ? undefined : submissionOrAfterPersist;
    const input = typeof inputOrDate === "object" && !(inputOrDate instanceof Date)
      ? inputOrDate
      : { ...(submission ?? { questions: [] }), date: inputOrDate };
    const date = localDate(input.date);
    const quiz = this.requireQuiz(date);
    if (quiz.status === "expired") throw new QuizConflictError("Expired quizzes cannot be graded");
    if (quiz.status !== "submitted") throw new QuizConflictError("Only submitted quizzes can be graded");
    if (input.revision !== undefined && input.revision !== quiz.revision) throw new RevisionConflictError("The quiz grade revision is stale");
    const settlementId = input.submissionId?.trim() || randomUUID();
    const prior = this.readSettledResults(quiz);

    if (prior) {
      const persistedSettlement = this.readSettlementIdentity(quiz);
      if (persistedSettlement && persistedSettlement !== settlementId) throw new QuizConflictError("The quiz already has a different committed settlement");
      if (callback) transaction(this.source, () => callback(prior));
      try {
        this.writeSheet(prior.quiz, this.answerMap(prior.quiz.quizId), prior.questions);
      } catch {
        // A committed grade remains authoritative when a repair write cannot replace its sheet.
      }
      return prior;
    }
    const answerRows = this.db.all<Record<string, unknown>>("SELECT question_id, revision FROM quiz_answers WHERE quiz_id = ?", quiz.quizId);
    if (answerRows.length !== quiz.questions.length || answerRows.some((row) => Number(row.revision) !== quiz.revision)) {
      throw new ValidationError("The sealed quiz answers do not match the committed revision");
    }
    const prepared = this.prepareGradeSubmission(quiz, input);
    const previewResults: SettledQuestionResult[] = prepared.map((questionGrade) => ({
      questionId: questionGrade.question.questionId,
      feedback: questionGrade.feedback,
      cards: questionGrade.cards.map((card) => ({
        gradeId: "preview",
        quizId: quiz.quizId,
        questionId: questionGrade.question.questionId,
        cardId: card.input.cardId,
        rating: card.input.rating,
        feedback: card.feedback,
        gradedAt: nowIso(),
        evidence: card.evidence,
        readings: card.readings,
      })),
      readings: this.uniqueReadings(questionGrade.cards.flatMap((card) => card.readings)),
    }));
    const rendered = this.renderSheet(quiz, this.answerMap(quiz.quizId), previewResults);
    this.validateRenderedSheet(rendered);
    const settledAt = nowIso();
    const settled = this.replaceSheet(quiz.sheetPath ?? pathForSheet(this.paths, date), rendered, () => {
      const results: SettledQuestionResult[] = [];
      let committed: SettledQuizResult | undefined;
      transaction(this.source, () => {
        this.revalidatePreparedGrades(quiz, prepared);
        for (const questionGrade of prepared) {
          const cardResults: SettledCardResult[] = [];
          for (const card of questionGrade.cards) {
            const raw = this.scheduler.transitionCardInTransaction(card.input.cardId, card.input.rating, settledAt, {
              quizId: quiz.quizId,
              questionId: questionGrade.question.questionId,
              answerRevision: quiz.revision,
              settlementId,
              authorization: SEALED_QUIZ_REVIEW,
            });
            this.db.run("INSERT INTO card_results (result_id, quiz_id, question_id, card_id, rating, review_id) VALUES (?, ?, ?, ?, ?, ?)", randomUUID(), quiz.quizId, questionGrade.question.questionId, card.input.cardId, card.input.rating, raw.reviewId);
            const after = this.scheduler.getCard(card.input.cardId);
            cardResults.push({
              gradeId: raw.reviewId,
              quizId: quiz.quizId,
              questionId: questionGrade.question.questionId,
              cardId: card.input.cardId,
              rating: card.input.rating,
              feedback: card.feedback,
              gradedAt: settledAt,
              evidence: card.evidence,
              readings: card.readings,
              dueAt: after.dueAt,
              fsrsState: after.fsrsState,
            });
          }
          const persistedCards = questionGrade.cards.map((card) => ({ ...card.input, evidence: card.evidence, readings: card.readings }));
          this.db.run(
            "INSERT INTO question_results (result_id, quiz_id, question_id, answer_revision, feedback, graded_at) VALUES (?, ?, ?, ?, ?, ?)",
            randomUUID(),
            quiz.quizId,
            questionGrade.question.questionId,
            quiz.revision,
            this.persistFeedback(questionGrade.feedback, questionGrade.readings, persistedCards, settlementId, quiz.revision),
            settledAt,
          );
          results.push({
            questionId: questionGrade.question.questionId,
            feedback: questionGrade.feedback,
            cards: cardResults,
            readings: this.uniqueReadings(cardResults.flatMap((card) => card.readings)),
          });
        }
        committed = { quiz: this.requireQuiz(date), questions: results };
        if (callback) callback(committed);
      });
      if (!committed) throw new Error("Quiz grade transaction did not commit");
      return committed;
    });
    return settled;
  }
  readingHref(reading: ReadingLink): string {
    const row = this.db.get<Record<string, unknown>>("SELECT relative_path FROM pages WHERE page_id = ?", reading.pageId);
    const relativePath = String(row?.relative_path ?? "");
    if (!validWikiPath(relativePath)) {
      throw new ValidationError(`Reading page path is unavailable: ${reading.pageId}`);
    }
    const encodedPath = relativePath.split("/").map(encodeHrefComponent).join("/");
    return `wiki/${encodedPath}#${encodeHrefComponent(anchorFragment(reading.anchor))}`;
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
          if (result.readings.length) lines.push("", "Readings:", ...result.readings.map((reading) => `- [${reading.heading ?? reading.anchor}](${this.readingHref(reading)})`));

          lines.push("");
        }
      }
    }
    if (!results) lines.push("## Results", "", "_Not graded yet._", "");
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  parseSheet(markdown: string): QuizRecord {
    this.validateRenderedSheet(markdown);
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
    if (stored.status === "submitted" && answerRows.length !== stored.questions.length) throw new ValidationError("Quiz sheet answers are incomplete");
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

  private prepareSeal(input: QuizSubmissionInput): PreparedSeal {
    const date = localDate(input.date);
    const quiz = this.requireQuiz(date);
    if (quiz.status !== "open") throw new QuizConflictError("Only the current open quiz can be submitted");
    if (input.revision !== quiz.revision) throw new RevisionConflictError("The quiz submission revision is stale");
    const answers = input.answers ?? this.answerMap(quiz.quizId);
    this.validateCompleteAnswers(quiz, answers);
    const submittedAt = nowIso();
    const preview: QuizRecord = { ...quiz, status: "submitted", submittedAt };
    const rendered = this.renderSheet(preview, answers);
    this.validateRenderedSheet(rendered);
    return { date, quiz, answers, submittedAt, rendered, sheetPath: quiz.sheetPath ?? pathForSheet(this.paths, date) };
  }

  private sealInTransaction(prepared: PreparedSeal): QuizRecord {
    const { quiz, answers, submittedAt } = prepared;
    for (const question of quiz.questions) {
      const answer = answers[question.questionId];
      if (answer === undefined) throw new ValidationError(`Missing answer for ${question.questionId}`);
      this.db.run(
        "INSERT INTO quiz_answers (quiz_id, question_id, revision, answer_json, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (quiz_id, question_id) DO UPDATE SET revision = excluded.revision, answer_json = excluded.answer_json, saved_at = excluded.saved_at",
        quiz.quizId,
        question.questionId,
        quiz.revision,
        json(normalizedAnswer(answer)),
        submittedAt,
      );
    }
    const result = this.db.run("UPDATE quizzes SET status = 'submitted', submitted_at = ? WHERE quiz_id = ? AND status = 'open' AND revision = ?", submittedAt, quiz.quizId, quiz.revision);
    requireDatabaseChange(result, "The quiz submission revision is stale");
    return this.requireQuiz(quiz.date);
  }
  private snapshotEvidence(quiz: QuizRecord): QuizEvidenceRecord[] {
    const expectedCards = new Set(quiz.questions.flatMap((question) => question.cardIds));
    const rows = this.db.all<Record<string, unknown>>("SELECT * FROM quiz_evidence WHERE quiz_id = ? ORDER BY card_id, reference", quiz.quizId);
    if (!rows.length || !expectedCards.size) throw new ValidationError("Quiz evidence snapshot is missing");
    const seen = new Set<string>();
    const evidence: QuizEvidenceRecord[] = [];
    for (const row of rows) {
      const quizId = String(row.quiz_id ?? "");
      const cardId = String(row.card_id ?? "");
      const reference = String(row.reference ?? "");
      const pageId = String(row.page_id ?? "");
      const path = String(row.relative_path ?? "");
      const anchor = String(row.anchor ?? "");
      const pageDigest = String(row.page_digest ?? "");
      const textDigest = String(row.text_digest ?? "");
      const excerpt = typeof row.excerpt === "string" ? row.excerpt : "";
      const excerptDigest = String(row.excerpt_digest ?? "");
      const pageRevision = Number(row.page_revision);
      const heading = row.heading === null || row.heading === undefined ? undefined : String(row.heading);
      if (
        quizId !== quiz.quizId ||
        !expectedCards.has(cardId) ||
        !reference ||
        !/^[0-9a-f]{64}$/u.test(reference) ||
        seen.has(`${cardId}:${reference}`) ||
        !pageId ||
        !validWikiPath(path) ||
        !anchor.startsWith("#") ||
        !/^[0-9a-f]{64}$/u.test(pageDigest) ||
        !Number.isInteger(pageRevision) ||
        pageRevision < 1 ||
        !/^[0-9a-f]{64}$/u.test(textDigest) ||
        !excerpt ||
        Buffer.byteLength(excerpt, "utf8") > 8192 ||
        !/^[0-9a-f]{64}$/u.test(excerptDigest) ||
        createHash("sha256").update(excerpt).digest("hex") !== excerptDigest ||
        evidenceReference(cardId, pageId, anchor, pageDigest, pageRevision, textDigest) !== reference
      ) throw new ValidationError("Quiz evidence snapshot is malformed");
      seen.add(`${cardId}:${reference}`);
      evidence.push({
        reference,
        cardId,
        pageId,
        path,
        anchor,
        ...(heading === undefined ? {} : { heading }),
        pageDigest,
        pageRevision,
        textDigest,
        excerpt,
      });
    }
    if (seen.size !== rows.length || expectedCards.size !== new Set(evidence.map((item) => item.cardId)).size) throw new ValidationError("Quiz evidence snapshot is incomplete");
    return evidence;
  }
  private sourceReferencesForCard(cardId: string): string[] {
    const references = this.evidenceForCard(cardId).map((item) => item.reference);
    if (!references.length) throw new ValidationError(`Card has no source evidence: ${cardId}`);
    return references;
  }


  private evidenceForCard(cardId: string): QuizEvidenceRecord[] {
    const evidence: QuizEvidenceRecord[] = [];
    for (const binding of this.scheduler.bindings(cardId)) {
      const page = this.db.get<Record<string, unknown>>("SELECT status, quiz_worthiness, relative_path, digest, revision FROM pages WHERE page_id = ?", binding.pageId);
      if (!page || page.status !== "active" || page.quiz_worthiness !== "eligible") throw new ValidationError(`Binding references unavailable evidence page: ${binding.pageId}`);
      const path = String(page.relative_path ?? "");
      const pageDigest = String(page.digest ?? "");
      const pageRevision = Number(page.revision ?? 0);
      if (!validWikiPath(path) || !pageDigest || !Number.isInteger(pageRevision) || pageRevision < 1) throw new ValidationError(`Binding evidence metadata is invalid: ${binding.pageId}`);
      const wikiRoot = this.paths?.wiki ?? (this.paths as { readonly wikiRoot?: string } | undefined)?.wikiRoot ?? (this.paths?.root ? join(this.paths.root, "wiki") : undefined);
      if (!wikiRoot) throw new ValidationError(`Binding evidence page is unavailable: ${binding.pageId}`);
      let content: string;
      let bytes: Buffer;
      try {
        const pagePath = safeRelativePath(wikiRoot, path);
        bytes = readFileNoFollow(pagePath);
        content = bytes.toString("utf8");
      } catch {
        throw new ValidationError(`Binding evidence page is unavailable: ${binding.pageId}`);
      }
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      if (actualDigest !== pageDigest) throw new ValidationError(`Binding evidence page is stale: ${binding.pageId}`);
      const section = parseWikiSections(content, binding.pageId).find((candidate) => candidate.anchor === binding.anchor);
      if (!section || (binding.heading !== undefined && binding.heading !== section.heading)) throw new ValidationError(`Binding evidence section is unavailable: ${binding.pageId}${binding.anchor}`);
      const sectionText = content.slice(section.startOffset, section.endOffset);
      const startOffset = binding.startOffset;
      const endOffset = binding.endOffset;
      if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || startOffset < 0 || endOffset <= startOffset || endOffset > sectionText.length) throw new ValidationError(`Binding evidence bounds are invalid: ${binding.pageId}${binding.anchor}`);
      const boundText = sectionText.slice(startOffset, endOffset);
      const textDigest = createHash("sha256").update(boundText).digest("hex");
      if (!boundText || textDigest !== binding.textDigest) throw new ValidationError(`Binding evidence bytes are stale: ${binding.pageId}${binding.anchor}`);
      evidence.push({
        reference: evidenceReference(cardId, binding.pageId, binding.anchor, pageDigest, pageRevision, binding.textDigest),
        cardId,
        pageId: binding.pageId,
        path,
        anchor: binding.anchor,
        ...(binding.heading === undefined ? {} : { heading: binding.heading }),
        pageDigest,
        pageRevision,
        textDigest: binding.textDigest,
        excerpt: boundedUtf8(boundText, 8192),
      });
    }
    if (!evidence.length) throw new ValidationError(`Review card has no authorized evidence: ${cardId}`);
    return evidence;
  }

  private uniqueEvidence(evidence: readonly QuizEvidenceRecord[]): QuizEvidenceRecord[] {
    const seen = new Set<string>();
    const unique: QuizEvidenceRecord[] = [];
    for (const item of evidence) {
      const key = `${item.cardId}:${item.reference}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }
    return unique;
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
      if (!question || (question.kind !== "short-answer" && question.kind !== "multiple-choice")) throw new ValidationError("Question kind is invalid");
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
      if (question.questionId !== undefined && (!question.questionId.trim() || questionIds.has(question.questionId.trim()))) throw new ValidationError("Question IDs must be distinct and nonempty");
      if (question.questionId) questionIds.add(question.questionId.trim());
      if (question.choices !== undefined && (!Array.isArray(question.choices) || question.choices.some((choice) => typeof choice !== "string"))) throw new ValidationError("Question options must be strings");
      if (question.kind === "multiple-choice" && (!question.choices || question.choices.length < 2 || new Set(question.choices).size !== question.choices.length)) throw new ValidationError("Multiple-choice questions require distinct options");
      if (question.choices?.some((choice) => !choice.trim() || FORBIDDEN_SHEET_TEXT.test(choice))) throw new ValidationError("Question options must be nonempty and answer-key-free");
    }
    if (covered.size !== selected.size) throw new ValidationError("Daily quiz questions must cover every selected card");
    for (const cardId of selected) if (!covered.has(cardId)) throw new ValidationError("Daily quiz questions must cover every selected card");
    return specs;
  }
  private prepareGradeSubmission(quiz: QuizRecord, input: GradeSubmissionInput): PreparedQuestionGrade[] {
    const questionById = new Map(quiz.questions.map((question) => [question.questionId, question]));
    if (input.questions.length !== quiz.questions.length || input.questions.some((question) => !questionById.has(question.questionId))) {
      throw new ValidationError("Grading must cover every displayed question exactly once");
    }
    const evidenceByCard = new Map<string, Map<string, QuizEvidenceRecord>>();
    for (const item of this.gradingEvidence(quiz)) {
      const byReference = evidenceByCard.get(item.cardId) ?? new Map<string, QuizEvidenceRecord>();
      byReference.set(item.reference, item);
      evidenceByCard.set(item.cardId, byReference);
    }
    const seenQuestions = new Set<string>();
    const seenCardsOverall = new Set<string>();
    const prepared: PreparedQuestionGrade[] = [];
    for (const questionGrade of input.questions) {
      if (seenQuestions.has(questionGrade.questionId)) throw new ValidationError("A question was graded more than once");
      seenQuestions.add(questionGrade.questionId);
      const question = questionById.get(questionGrade.questionId);
      if (!question) throw new ValidationError("Grading references an unknown question");
      const expectedCards = new Set(question.cardIds);
      if (questionGrade.cards.length !== expectedCards.size || questionGrade.cards.some((card) => !expectedCards.has(card.cardId))) throw new ValidationError("Every card tested by a question requires one grade");
      const questionFeedback = questionGrade.feedback?.trim() || "";
      this.validateFeedback(questionFeedback);
      const questionReadings = this.uniqueReadings(questionGrade.readings ?? []);
      this.validateQuestionReadings(evidenceByCard, question.cardIds, questionReadings);
      const seenCards = new Set<string>();
      const cards: PreparedCardGrade[] = [];
      for (const card of questionGrade.cards) {
        if (seenCards.has(card.cardId)) throw new ValidationError("A card was graded more than once in one question");
        seenCards.add(card.cardId);
        if (seenCardsOverall.has(card.cardId)) throw new ValidationError("A card cannot be graded by more than one question");
        seenCardsOverall.add(card.cardId);
        if (!RATINGS.includes(card.rating)) throw new ValidationError(`Unsupported FSRS rating: ${card.rating}`);
        const evidence = card.evidence.map((item) => typeof item === "string" ? item.trim() : "");
        if (!evidence.length || evidence.some(Boolean) === false || evidence.some((item) => !item)) throw new ValidationError(`Every card grade requires authorized evidence IDs: ${card.cardId}`);
        if (new Set(evidence).size !== evidence.length) throw new ValidationError(`Card grade repeats evidence IDs: ${card.cardId}`);
        const records = evidence.map((reference) => evidenceByCard.get(card.cardId)?.get(reference)).filter((item): item is QuizEvidenceRecord => Boolean(item));
        if (records.length !== evidence.length) throw new ValidationError(`Card grade cites unauthorized evidence: ${card.cardId}`);
        const readings = this.uniqueReadings([...(card.readings ?? []), ...questionReadings]);
        if (!readings.length) throw new ValidationError(`Every card grade requires exact readings: ${card.cardId}`);
        this.validateReadings(evidenceByCard.get(card.cardId) ?? new Map<string, QuizEvidenceRecord>(), card.cardId, readings);
        if (readings.some((reading) => !records.some((record) => record.pageId === reading.pageId && record.anchor === reading.anchor))) throw new ValidationError(`Card grade readings are not covered by authorized evidence: ${card.cardId}`);
        const feedback = card.feedback?.trim() || questionFeedback;
        this.validateFeedback(feedback);
        cards.push({ input: card, evidence, evidenceRecords: records, readings, feedback });
      }
      prepared.push({ input: questionGrade, question, feedback: questionFeedback, readings: questionReadings, cards });
    }
    if (seenCardsOverall.size !== quiz.questions.flatMap((question) => question.cardIds).length) throw new ValidationError("Grading must cover every selected card exactly once");
    return prepared;
  }

  private revalidatePreparedGrades(quiz: QuizRecord, prepared: readonly PreparedQuestionGrade[]): void {
    const evidenceByCard = new Map<string, Map<string, QuizEvidenceRecord>>();
    for (const item of this.gradingEvidence(quiz)) {
      const byReference = evidenceByCard.get(item.cardId) ?? new Map<string, QuizEvidenceRecord>();
      byReference.set(item.reference, item);
      evidenceByCard.set(item.cardId, byReference);
    }
    for (const question of prepared) {
      this.validateQuestionReadings(evidenceByCard, question.question.cardIds, question.readings);
      for (const card of question.cards) {
        const current = evidenceByCard.get(card.input.cardId) ?? new Map<string, QuizEvidenceRecord>();
        for (const record of card.evidenceRecords) {
          const latest = current.get(record.reference);
          if (
            !latest ||
            latest.cardId !== record.cardId ||
            latest.pageId !== record.pageId ||
            latest.path !== record.path ||
            latest.anchor !== record.anchor ||
            latest.heading !== record.heading ||
            latest.pageDigest !== record.pageDigest ||
            latest.pageRevision !== record.pageRevision ||
            latest.textDigest !== record.textDigest ||
            latest.excerpt !== record.excerpt
          ) throw new RevisionConflictError(`Grading evidence is stale: ${record.reference}`);
        }
        this.validateReadings(current, card.input.cardId, card.readings);
      }
    }
  }


  private validateAnswerText(answer: string | readonly string[]): void {
    const text = answerText(answer);
    if (FORBIDDEN_SHEET_TEXT.test(text) || /^#{1,6}\s/mu.test(text)) throw new ValidationError("Answers may not contain private grading material or structural Markdown");
  }

  private validateFeedback(feedback: string): void {
    if (FORBIDDEN_SHEET_TEXT.test(feedback)) throw new ValidationError("Feedback may not contain private grading material");
  }

  private validateCompleteAnswers(quiz: QuizRecord, answers: Readonly<Record<string, string | readonly string[]>>): void {
    for (const question of quiz.questions) {
      const answer = answers[question.questionId];
      if (answer === undefined || answerText(answer).trim() === "") throw new ValidationError(`Missing answer for ${question.questionId}`);
      if (question.kind === "multiple-choice") {
        const values = Array.isArray(answer) ? answer : [answer];
        if (values.some((value) => !question.choices?.includes(value))) throw new ValidationError(`Invalid choice for ${question.questionId}`);
      }
      this.validateAnswerText(answer);
    }
  }

  private answerMap(quizId: string): Record<string, string | readonly string[]> {
    const answers: Record<string, string | readonly string[]> = {};
    for (const row of this.db.all<Record<string, unknown>>("SELECT question_id, answer_json FROM quiz_answers WHERE quiz_id = ?", quizId)) answers[String(row.question_id)] = parseJson(row.answer_json, "");
    return answers;
  }

  private validateReadings(evidence: ReadonlyMap<string, QuizEvidenceRecord>, cardId: string, readings: readonly ReadingLink[]): void {
    for (const reading of readings) {
      if (!validReading(reading)) throw new ValidationError(`Reading is malformed for ${cardId}`);
      const record = [...evidence.values()].find((candidate) => candidate.pageId === reading.pageId && candidate.anchor === reading.anchor && (reading.heading === undefined || reading.heading === candidate.heading));
      if (!record) throw new ValidationError(`Reading is not an authorized sealed evidence section for ${cardId}`);
    }
  }

  private validateQuestionReadings(evidenceByCard: ReadonlyMap<string, ReadonlyMap<string, QuizEvidenceRecord>>, cardIds: readonly string[], readings: readonly ReadingLink[]): void {
    const evidence = cardIds.flatMap((cardId) => [...(evidenceByCard.get(cardId)?.values() ?? [])]);
    for (const reading of readings) {
      if (!validReading(reading) || !evidence.some((candidate) => candidate.pageId === reading.pageId && candidate.anchor === reading.anchor && (reading.heading === undefined || reading.heading === candidate.heading))) {
        throw new ValidationError("Reading is not an exact sealed evidence section");
      }
    }
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
    const links = readings.map((reading) => `[${reading.heading ?? reading.anchor}](${this.readingHref(reading)})`);
    const human = [feedback, ...cardFeedback, links.length ? `Readings: ${links.join(", ")}` : ""].filter(Boolean).join("\n\n") || "No feedback.";
    return `<!-- pi-scholar-result ${encodeResultEnvelope(envelope)} -->\n${human}`;
  }

  private readSettlementIdentity(quiz: QuizRecord): string | undefined {
    const row = this.db.get<Record<string, unknown>>("SELECT feedback FROM question_results WHERE quiz_id = ? ORDER BY graded_at, question_id LIMIT 1", quiz.quizId);
    return row ? decodeResultEnvelope(String(row.feedback))?.settlementId : undefined;
  }

  readSettledResult(quiz: QuizRecord): SettledQuizResult | undefined {
    return this.readSettledResults(quiz);
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

  private validateRenderedSheet(markdown: string): void {
    if (!markdown.trim() || FORBIDDEN_SHEET_TEXT.test(markdown) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(markdown)) {
      throw new ValidationError("Rendered quiz sheet contains forbidden controlled content");
    }
    if (!/^# Pi Scholar Quiz — \d{4}-\d{2}-\d{2}\s*$/mu.test(markdown) || !/<!--\s*pi-scholar quiz-id=[^\s]+ revision=\d+\s*-->/u.test(markdown)) {
      throw new ValidationError("Rendered quiz sheet header is invalid");
    }
  }

  private replaceSheet<T>(sheetPath: string | undefined, rendered: string, operation: () => T): T {
    if (!sheetPath) return operation();
    mkdirSync(join(sheetPath, ".."), { recursive: true });
    const previous = existsSync(sheetPath) ? readFileNoFollow(sheetPath) : undefined;
    atomicWriteFile(sheetPath, rendered);
    try {
      return operation();
    } catch (error) {
      try {
        if (previous) atomicWriteFile(sheetPath, previous);
        else rmSync(sheetPath, { force: true });
      } catch {
        // Preserve the database operation's error; the next successful retry rewrites the canonical sheet.
      }
      throw error;
    }
  }

  private writeSheet(quiz: QuizRecord, answers?: Readonly<Record<string, string | readonly string[]>>, results?: readonly SettledQuestionResult[]): void {
    const sheetPath = quiz.sheetPath ?? pathForSheet(this.paths, quiz.date);
    if (!sheetPath) return;
    const rendered = this.renderSheet(quiz, answers, results);
    this.validateRenderedSheet(rendered);
    this.replaceSheet(sheetPath, rendered, () => undefined);
  }
}

export { FORBIDDEN_SHEET_TEXT };
