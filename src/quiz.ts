import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import katex from "katex";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import type {
  PageLearningRecord,
  QuizEvidenceRecord,
  QuizGradeRecord,
  QuizQuestionKind,
  QuizQuestionPageRecord,
  QuizQuestionRecord,
  QuizRecord,
  ReviewRating,
  WorkflowRecord,
} from "./contracts.js";
import { transaction as databaseTransaction } from "./database.js";
import type { SqlDatabase, SqlDatabaseSource, VaultPathsLike } from "./scheduler.js";
import {
  localDate,
  RATINGS,
  RevisionConflictError,
  SchedulerService,
  SEALED_QUIZ_REVIEW,
  ValidationError,
} from "./scheduler.js";
import { atomicWriteFile, readFileNoFollow, safeRelativePath } from "./vault.js";
import { parseWikiDocumentSections } from "./wiki-sections.js";
export interface QuestionSpecInput {
  readonly kind: QuizQuestionKind;
  readonly prompt: string;
  readonly choices?: readonly string[];
  readonly pages: readonly QuizQuestionPageRecord[];
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

export interface PageGradeInput {
  readonly pageId: string;
  readonly rating: ReviewRating;
  readonly feedback?: string;
  readonly evidence: readonly string[];
  readonly readings?: readonly ReadingLink[];
}

export interface QuestionGradeInput {
  readonly questionId: string;
  readonly feedback?: string;
}

export interface GradeSubmissionInput {
  readonly date: string | Date;
  readonly revision?: number;
  readonly submissionId?: string;
  readonly requestId?: string;
  readonly questions: readonly QuestionGradeInput[];
  readonly pages: readonly PageGradeInput[];
}

export interface QuizGenerationInput {
  readonly date: string | Date;
  readonly questionSpecs?: readonly QuestionSpecInput[];
  readonly selectedPageIds?: readonly string[];
}

export interface SettledQuestionResult {
  readonly questionId: string;
  readonly feedback: string;
}

export interface SettledPageResult extends QuizGradeRecord {
  readonly reviewId: string;
  readonly evidence: readonly string[];
  readonly readings: readonly ReadingLink[];
}

export interface SettledQuizResult {
  readonly quiz: QuizRecord;
  readonly questions: readonly SettledQuestionResult[];
  readonly pages: readonly SettledPageResult[];
}

export class QuizConflictError extends Error {
  readonly code = "quiz-conflict";
  constructor(message: string) {
    super(message);
    this.name = "QuizConflictError";
  }
}

const FORBIDDEN_SHEET_TEXT = /answer\s*key|correct\s+answer|grading\s+criteria|rubric/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function decodePercentEscapes(value: string): string {
  let decoded = value;
  while (true) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    if (next === decoded) return decoded;
    decoded = next;
  }
}
function normalizeSearchable(value: string): string {
  return decodePercentEscapes(value)
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFC")
    .replace(/[ \t\n\f\r]+/gu, " ")
    .trim();
}
function renderedMathValue(value: string): string {
  return katex
    .renderToString(value, { maxExpand: 1_000, output: "mathml", throwOnError: false, trust: false })
    .replace(/<annotation\b[\s\S]*?<\/annotation>/gu, "")
    .replace(/<[^>]+>/gu, "");
}
function renderedMarkdownValues(value: string): string {
  const properties: string[] = [];
  const render = (node: unknown): string => {
    if (!node || typeof node !== "object") return "";
    const record = node as Record<string, unknown>;
    if (record.type === "html") return "";
    for (const key of ["url", "title"]) if (typeof record[key] === "string") properties.push(record[key]);
    if ((record.type === "inlineMath" || record.type === "math") && typeof record.value === "string")
      properties.push(renderedMathValue(record.value));
    if (record.type === "image" || record.type === "imageReference")
      return typeof record.alt === "string" ? record.alt : "";
    if (record.type === "break") return "\n";
    if (Array.isArray(record.children)) {
      const separator = ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(String(record.type))
        ? "\n"
        : "";
      return record.children.map(render).join(separator);
    }
    return typeof record.value === "string" ? record.value : "";
  };
  return [
    render(
      fromMarkdown(value, {
        extensions: [gfm(), math()],
        mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
      }),
    ),
    ...properties,
  ].join("\n");
}

export interface QuizVisibleTextToken {
  readonly value: string;
  readonly match: "boundary" | "substring";
}
function boundaryToken(value: string): QuizVisibleTextToken {
  return { value, match: "boundary" };
}

function substringToken(value: string): QuizVisibleTextToken {
  return { value, match: "substring" };
}
const UUID_PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function pageIdToken(value: string): QuizVisibleTextToken {
  return UUID_PAGE_ID.test(value) ? substringToken(value) : boundaryToken(value);
}
const MANAGED_IMAGE_URI =
  /pi-scholar:\/\/source\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/attachment\/[0-9a-f]{64}/iu;
const PRIVATE_SOURCE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;

export function validateQuizVisibleText(value: string, hiddenTokens: readonly QuizVisibleTextToken[]): void {
  const rendered = decodePercentEscapes(`${value}\n${renderedMarkdownValues(value)}`);
  if (/\p{Bidi_Control}/u.test(rendered)) throw new ValidationError("Quiz Markdown contains private metadata");
  const searchable = normalizeSearchable(rendered);
  if (MANAGED_IMAGE_URI.test(searchable) || PRIVATE_SOURCE_ID.test(searchable))
    throw new ValidationError("Quiz Markdown contains private metadata");
  const tokens = new Map<string, QuizVisibleTextToken["match"]>();
  for (const token of hiddenTokens) {
    const normalized = normalizeSearchable(token.value);
    if (!normalized) continue;
    if (token.match === "substring" || !tokens.has(normalized)) tokens.set(normalized, token.match);
  }
  if (!tokens.size) return;
  const substringTokens = [...tokens].filter(([, match]) => match === "substring").map(([token]) => token);
  const boundaryTokens = [...tokens].filter(([, match]) => match === "boundary").map(([token]) => token);
  if (
    (substringTokens.length &&
      new RegExp(`(?:${substringTokens.map(escapeRegExp).join("|")})`, "iu").test(searchable)) ||
    (boundaryTokens.length &&
      new RegExp(`(?<![\\p{L}\\p{N}_])(?:${boundaryTokens.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`, "iu").test(
        searchable,
      ))
  ) {
    throw new ValidationError("Quiz Markdown contains private metadata");
  }
}

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

interface PreparedPageGrade {
  readonly input: PageGradeInput;
  readonly evidence: readonly string[];
  readonly evidenceRecords: readonly QuizEvidenceRecord[];
  readonly readings: readonly ReadingLink[];
  readonly feedback: string;
}

interface PreparedQuestionGrade {
  readonly input: QuestionGradeInput;
  readonly question: QuizQuestionRecord;
  readonly feedback: string;
}

interface PreparedGradeSubmission {
  readonly questions: readonly PreparedQuestionGrade[];
  readonly pages: readonly PreparedPageGrade[];
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
  return value
    .replace(/\r/g, "")
    .replace(/<!--/g, "< !--")
    .replace(/^(#{1,6})(?=\s)/gmu, "\\$1")
    .trim();
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
export function evidenceReference(
  pageId: string,
  anchor: string,
  pageDigest: string,
  pageRevision: number,
  textDigest: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([pageId, anchor, pageDigest, pageRevision, textDigest]))
    .digest("hex");
}
function validWikiPath(value: string): boolean {
  return (
    Boolean(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\u0000") &&
    !value.split("/").some((segment) => segment === "..") &&
    !/^[A-Za-z]:/u.test(value)
  );
}
function validReading(value: unknown): value is ReadingLink {
  if (!value || typeof value !== "object") return false;
  const reading = value as { pageId?: unknown; anchor?: unknown; heading?: unknown };
  return (
    typeof reading.pageId === "string" &&
    Boolean(reading.pageId) &&
    typeof reading.anchor === "string" &&
    (reading.anchor === "" || (reading.anchor.startsWith("#") && reading.anchor.length > 1)) &&
    (reading.anchor !== "" || reading.heading === undefined) &&
    (reading.heading === undefined || typeof reading.heading === "string")
  );
}

function encodeHrefComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
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
    const row = this.db.get<Record<string, unknown>>(
      key.includes("-") && key.length === 10
        ? "SELECT * FROM quizzes WHERE date = ?"
        : "SELECT * FROM quizzes WHERE quiz_id = ?",
      key,
    );
    return row ? this.mapQuiz(row) : undefined;
  }

  list(): QuizRecord[] {
    return this.db
      .all<Record<string, unknown>>("SELECT * FROM quizzes ORDER BY date DESC")
      .map((row) => this.mapQuiz(row));
  }
  /** Snapshot the sealed page evidence; this is internal and never part of browser DTOs. */
  gradingEvidence(quizOrDate: QuizRecord | string | Date): QuizEvidenceRecord[] {
    const quiz = typeof quizOrDate === "object" && !(quizOrDate instanceof Date) ? quizOrDate : this.get(quizOrDate);
    if (!quiz) throw new ValidationError("No quiz for grading evidence");
    const snapshot = this.snapshotEvidence(quiz);
    const wikiRoot =
      this.paths?.wiki ??
      (this.paths as { readonly wikiRoot?: string } | undefined)?.wikiRoot ??
      (this.paths?.root ? join(this.paths.root, "wiki") : undefined) ??
      (this.paths?.vaultRoot ? join(this.paths.vaultRoot, "wiki") : undefined);
    if (!wikiRoot) return snapshot;
    const expectedPages = [...new Set(quiz.questions.flatMap((question) => question.pages.map((page) => page.pageId)))];
    const current = this.uniqueEvidence(expectedPages.flatMap((pageId) => this.evidenceForPage(pageId)));
    if (
      current.length !== snapshot.length ||
      snapshot.some((record) => {
        const latest = current.find((candidate) => candidate.reference === record.reference);
        return (
          !latest ||
          latest.pageId !== record.pageId ||
          latest.path !== record.path ||
          latest.anchor !== record.anchor ||
          latest.heading !== record.heading ||
          latest.pageDigest !== record.pageDigest ||
          latest.pageRevision !== record.pageRevision ||
          latest.textDigest !== record.textDigest ||
          latest.excerpt !== record.excerpt
        );
      })
    )
      throw new ValidationError("Quiz evidence snapshot is stale");
    return snapshot;
  }

  private selectedPagesFor(date: string, selectedPageIds?: readonly string[]): PageLearningRecord[] {
    const due = this.scheduler.eligiblePages(date);
    if (selectedPageIds === undefined) return due;
    const ids = selectedPageIds.map((pageId) => pageId.trim());
    if (new Set(ids).size !== ids.length || ids.some((pageId) => !pageId))
      throw new ValidationError("Quiz page selection contains duplicate or empty IDs");
    const byId = new Map(due.map((page) => [page.pageId, page]));
    if (ids.some((pageId) => !byId.has(pageId)))
      throw new ValidationError("Quiz page selection is not due and eligible");
    return ids.map((pageId) => byId.get(pageId)!);
  }

  createDailyQuiz(
    input: QuizGenerationInput | string | Date,
    questionSpecs?: readonly QuestionSpecInput[],
  ): QuizRecord {
    const date = localDate(typeof input === "object" && !(input instanceof Date) ? input.date : input);
    const existing = this.get(date);
    if (existing) return existing;
    const selectedPageIds = typeof input === "object" && !(input instanceof Date) ? input.selectedPageIds : undefined;
    const selectedPages = this.selectedPagesFor(date, selectedPageIds);
    const quizId = randomUUID();
    const sheetPath = pathForSheet(this.paths, date);
    const specs = typeof input === "object" && !(input instanceof Date) ? input.questionSpecs : questionSpecs;
    if (!selectedPages.length) {
      transaction(this.source, () => {
        this.db.run(
          "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'skipped', NULL, ?, NULL, ?, NULL)",
          quizId,
          date,
          nowIso(),
          "skipped-no-eligible-pages",
        );
      });
      return this.get(date)!;
    }
    const validated = this.validateQuestionSpecs(
      specs ?? [],
      selectedPages.map((page) => page.pageId),
    );
    const questions = validated.map(
      (question, ordinal) =>
        ({
          questionId: randomUUID(),
          quizId,
          ordinal,
          kind: question.kind,
          prompt: cleanMarkdown(question.prompt),
          choices: question.choices?.map(cleanMarkdown),
          pages: question.pages.map((page) => ({
            pageId: page.pageId,
            criterion: page.criterion.trim(),
            weight: page.weight,
          })),
          sourceRefs: [...(question.sourceRefs ?? [])],
        }) satisfies QuizQuestionRecord,
    );
    const evidence = this.uniqueEvidence(selectedPages.flatMap((page) => this.evidenceForPage(page.pageId)));
    const preview: QuizRecord = { quizId, date, revision: 1, status: "open", questions };
    const rendered = this.renderSheet(preview);
    this.validateRenderedSheet(rendered, this.hiddenTokensForQuiz(preview, evidence));
    try {
      this.replaceSheet(sheetPath, rendered, () =>
        transaction(this.source, () => {
          this.db.run(
            "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'open', ?, ?, NULL, NULL, NULL)",
            quizId,
            date,
            sheetPath ?? null,
            nowIso(),
          );
          for (const item of evidence) {
            this.db.run(
              "INSERT INTO quiz_evidence (quiz_id, reference, page_id, relative_path, anchor, heading, page_digest, page_revision, text_digest, excerpt, excerpt_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              quizId,
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
            const sourceRefs = question.sourceRefs;
            const spec = validated[question.ordinal]!;
            this.db.run(
              "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, source_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              question.questionId,
              quizId,
              question.ordinal,
              question.kind,
              question.prompt,
              question.choices ? json(question.choices) : null,
              spec.answerKey === undefined ? null : json(spec.answerKey),
              json(sourceRefs),
            );
            for (const page of question.pages) {
              this.db.run(
                "INSERT INTO question_pages (question_id, page_id, criterion_json, weight) VALUES (?, ?, ?, ?)",
                question.questionId,
                page.pageId,
                json(page.criterion),
                page.weight,
              );
            }
          }
        }),
      );
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
  saveDraft(
    date: string | Date,
    revision: number,
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): QuizRecord;
  saveDraft(
    inputOrDate: QuizDraftInput | string | Date,
    expectedRevision?: number,
    draftAnswers?: Readonly<Record<string, string | readonly string[]>>,
  ): QuizRecord {
    const input =
      typeof inputOrDate === "object" && !(inputOrDate instanceof Date)
        ? inputOrDate
        : { date: inputOrDate, revision: expectedRevision!, answers: draftAnswers ?? {} };
    const date = localDate(input.date);
    const quiz = this.requireQuiz(date);
    if (quiz.status !== "open") throw new QuizConflictError("Only an open quiz accepts drafts");
    if (input.revision !== quiz.revision) throw new RevisionConflictError("The quiz draft revision is stale");
    const questionIds = new Set(quiz.questions.map((question) => question.questionId));
    if (Object.keys(input.answers).some((questionId) => !questionIds.has(questionId)))
      throw new ValidationError("Draft contains an unknown question");
    const hiddenTokens = this.hiddenTokensForQuiz(quiz);
    for (const answer of Object.values(input.answers)) this.validateAnswerText(answer, hiddenTokens);
    const nextRevision = quiz.revision + 1;
    const answers = { ...this.answerMap(quiz.quizId), ...input.answers };
    const preview: QuizRecord = { ...quiz, revision: nextRevision };
    const rendered = this.renderSheet(preview, answers);
    this.validateRenderedSheet(rendered, this.hiddenTokensForQuiz(preview));
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
        this.db.run(
          "UPDATE quiz_answers SET revision = ? WHERE quiz_id = ? AND revision < ?",
          nextRevision,
          quiz.quizId,
          nextRevision,
        );
        const update = this.db.run(
          "UPDATE quizzes SET revision = ? WHERE quiz_id = ? AND status = 'open' AND revision = ?",
          nextRevision,
          quiz.quizId,
          quiz.revision,
        );
        requireDatabaseChange(update, "The quiz draft revision is stale");
      });
      return this.requireQuiz(date);
    });
    return result;
  }

  sealSubmission(input: QuizDraftInput): QuizRecord;
  sealSubmission(
    date: string | Date,
    revision: number,
    answers?: Readonly<Record<string, string | readonly string[]>>,
  ): QuizRecord;
  sealSubmission(
    inputOrDate: QuizDraftInput | string | Date,
    expectedRevision?: number,
    submittedAnswers?: Readonly<Record<string, string | readonly string[]>>,
  ): QuizRecord {
    const input: QuizSubmissionInput =
      typeof inputOrDate === "object" && !(inputOrDate instanceof Date)
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
    const result = this.db.run("UPDATE quizzes SET status = 'expired' WHERE status = 'open' AND date < ?", day) as
      | { changes?: number | bigint }
      | undefined;
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
      const settled = this.readSettledResults(quiz);
      return {
        sheetPath,
        previous,
        rendered: this.renderSheet(expired, this.answerMap(quiz.quizId), settled?.questions, settled?.pages),
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
            if (Number(result?.changes ?? 0) !== quizzes.length)
              throw new RevisionConflictError("Quiz expiration revision is stale");
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
  settleGrade(
    date: string | Date,
    submission: Omit<GradeSubmissionInput, "date">,
    afterPersist?: (result: SettledQuizResult) => void,
  ): SettledQuizResult;
  settleGrade(
    inputOrDate: GradeSubmissionInput | string | Date,
    submissionOrAfterPersist?: Omit<GradeSubmissionInput, "date"> | ((result: SettledQuizResult) => void),
    afterPersist?: (result: SettledQuizResult) => void,
  ): SettledQuizResult {
    const callback = typeof submissionOrAfterPersist === "function" ? submissionOrAfterPersist : afterPersist;
    const submission = typeof submissionOrAfterPersist === "function" ? undefined : submissionOrAfterPersist;
    const input =
      typeof inputOrDate === "object" && !(inputOrDate instanceof Date)
        ? inputOrDate
        : { ...(submission ?? { questions: [], pages: [] }), date: inputOrDate };
    const date = localDate(input.date);
    const quiz = this.requireQuiz(date);
    if (quiz.status === "expired") throw new QuizConflictError("Expired quizzes cannot be graded");
    if (quiz.status !== "submitted") throw new QuizConflictError("Only submitted quizzes can be graded");
    if (input.revision !== undefined && input.revision !== quiz.revision)
      throw new RevisionConflictError("The quiz grade revision is stale");
    const requestedSettlementId = input.submissionId?.trim();
    const settlementId = requestedSettlementId || randomUUID();
    const submissionId = requestedSettlementId || settlementId;
    const prior = this.readSettledResults(quiz);

    if (prior) {
      const persistedSettlement = this.readSettlementIdentity(quiz);
      if (persistedSettlement && requestedSettlementId && persistedSettlement !== requestedSettlementId)
        throw new QuizConflictError("The quiz already has a different committed settlement");
      if (callback) transaction(this.source, () => callback(prior));
      try {
        this.writeSheet(prior.quiz, this.answerMap(prior.quiz.quizId), prior.questions, prior.pages);
      } catch {
        // A committed grade remains authoritative when a repair write cannot replace its sheet.
      }
      return prior;
    }
    const answerRows = this.db.all<Record<string, unknown>>(
      "SELECT question_id, revision FROM quiz_answers WHERE quiz_id = ?",
      quiz.quizId,
    );
    if (
      answerRows.length !== quiz.questions.length ||
      answerRows.some((row) => Number(row.revision) !== quiz.revision)
    ) {
      throw new ValidationError("The sealed quiz answers do not match the committed revision");
    }
    const prepared = this.prepareGradeSubmission(quiz, input);
    const settledAt = nowIso();
    const previewResults: SettledQuestionResult[] = prepared.questions.map((questionGrade) => ({
      questionId: questionGrade.question.questionId,
      feedback: questionGrade.feedback,
    }));
    const previewPages: SettledPageResult[] = prepared.pages.map((page) => ({
      gradeId: "preview",
      quizId: quiz.quizId,
      pageId: page.input.pageId,
      rating: page.input.rating,
      feedback: page.feedback,
      gradedAt: settledAt,
      reviewId: "preview",
      evidence: page.evidence,
      readings: page.readings,
    }));
    const rendered = this.renderSheet(quiz, this.answerMap(quiz.quizId), previewResults, previewPages);
    this.validateRenderedSheet(rendered, this.hiddenTokensForQuiz(quiz, undefined, input.requestId));
    const settled = this.replaceSheet(quiz.sheetPath ?? pathForSheet(this.paths, date), rendered, () => {
      let committed: SettledQuizResult | undefined;
      transaction(this.source, () => {
        this.revalidatePreparedGrades(quiz, prepared);
        for (const questionGrade of prepared.questions) {
          this.db.run(
            "INSERT INTO question_results (result_id, quiz_id, question_id, answer_revision, feedback, graded_at) VALUES (?, ?, ?, ?, ?, ?)",
            randomUUID(),
            quiz.quizId,
            questionGrade.question.questionId,
            quiz.revision,
            questionGrade.feedback,
            settledAt,
          );
        }
        for (const pageGrade of prepared.pages) {
          const review = this.scheduler.transitionPageInTransaction(
            pageGrade.input.pageId,
            pageGrade.input.rating,
            settledAt,
            {
              quizId: quiz.quizId,
              submissionId,
              revision: quiz.revision,
              settlementId,
              authorization: SEALED_QUIZ_REVIEW,
            },
          );
          this.db.run(
            "INSERT INTO page_results (result_id, quiz_id, page_id, rating, feedback, evidence_json, readings_json, review_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            randomUUID(),
            quiz.quizId,
            pageGrade.input.pageId,
            pageGrade.input.rating,
            pageGrade.feedback,
            json(pageGrade.evidence),
            json(pageGrade.readings),
            review.reviewId,
          );
        }
        committed = this.readSettledResults(this.requireQuiz(date));
        if (!committed) throw new Error("Quiz grade transaction did not commit");
        if (callback) callback(committed);
      });
      if (!committed) throw new Error("Quiz grade transaction did not commit");
      return committed;
    });
    return settled;
  }
  readingHref(reading: ReadingLink): string {
    const row = this.db.get<Record<string, unknown>>(
      "SELECT relative_path FROM pages WHERE page_id = ?",
      reading.pageId,
    );
    const relativePath = String(row?.relative_path ?? "");
    if (!validWikiPath(relativePath)) {
      throw new ValidationError(`Reading page path is unavailable: ${reading.pageId}`);
    }
    const encodedPath = relativePath.split("/").map(encodeHrefComponent).join("/");
    return reading.anchor === ""
      ? `wiki/${encodedPath}`
      : `wiki/${encodedPath}#${encodeHrefComponent(anchorFragment(reading.anchor))}`;
  }

  renderSheet(
    quiz: QuizRecord,
    answers?: Readonly<Record<string, string | readonly string[]>>,
    results?: readonly SettledQuestionResult[],
    pageResults?: readonly SettledPageResult[],
  ): string {
    const lines = [
      `# 1. Pi Scholar Quiz — ${quiz.date}`,
      "",
      `<!-- pi-scholar:quiz format=1 id=${quiz.quizId} revision=${quiz.revision} -->`,
      "",
    ];
    for (const [index, question] of quiz.questions.entries()) {
      lines.push(
        `## ${index + 1}. Question`,
        "",
        `<!-- pi-scholar:question id=${question.questionId} -->`,
        "",
        `**Mode:** ${question.kind}`,
        "",
        cleanMarkdown(question.prompt),
        "",
      );
      if (question.choices?.length) for (const choice of question.choices) lines.push(`- [ ] ${cleanMarkdown(choice)}`);
      lines.push(
        "",
        `### ${index + 1}. Your answer`,
        cleanMarkdown(answerText(answers?.[question.questionId] ?? "")),
        "",
      );
      if (results) {
        const result = results.find((entry) => entry.questionId === question.questionId);
        if (result) {
          lines.push(`### ${index + 1}. Results`, cleanMarkdown(result.feedback || "No feedback."));
          lines.push("");
        }
      }
    }
    if (pageResults?.length) {
      lines.push(`## ${quiz.questions.length + 1}. Page review`, "");
      for (const page of pageResults) {
        lines.push(cleanMarkdown(page.feedback || "No page feedback."));
        for (const [index, reading] of page.readings.entries()) {
          lines.push(`- [Reading ${index + 1}](${this.readingHref(reading)})`);
        }
        lines.push("");
      }
    }
    return `${lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()}\n`;
  }

  parseSheet(markdown: string): QuizRecord {
    this.validateRenderedSheet(markdown);
    const header = /^# \d+\. Pi Scholar Quiz — (\d{4}-\d{2}-\d{2})\s*$/m.exec(markdown);
    const identity = /<!--\s*pi-scholar:quiz format=1 id=([^\s]+) revision=(\d+)\s*-->/m.exec(markdown);
    const date = header?.[1];
    const quizId = identity?.[1];
    const revisionText = identity?.[2];
    if (!date || !quizId || !revisionText) throw new ValidationError("Invalid canonical quiz sheet header");
    const revision = Number(revisionText);
    if (!Number.isInteger(revision) || revision < 1) throw new ValidationError("Invalid canonical quiz revision");
    const stored = this.get(date);
    if (!stored || stored.quizId !== quizId || stored.revision !== revision)
      throw new ValidationError("Quiz sheet identity does not match SQLite");
    this.validateRenderedSheet(markdown, this.hiddenTokensForQuiz(stored));
    const answerRows = this.db.all<Record<string, unknown>>(
      "SELECT question_id, revision FROM quiz_answers WHERE quiz_id = ?",
      stored.quizId,
    );
    if (answerRows.some((row) => Number(row.revision) !== stored.revision))
      throw new ValidationError("Quiz sheet answers are not at the committed revision");
    const questionIds = new Set(stored.questions.map((question) => question.questionId));
    if (answerRows.some((row) => !questionIds.has(String(row.question_id))))
      throw new ValidationError("Quiz sheet contains an unknown answer");
    if (stored.status === "submitted" && answerRows.length !== stored.questions.length)
      throw new ValidationError("Quiz sheet answers are incomplete");
    const sections = [
      ...markdown.matchAll(
        /^## (\d+)\. Question\n\n<!--\s*pi-scholar:question id=([^\s]+)\s*-->\n\n\*\*Mode:\*\* (free-response|multiple-choice)\n\n([\s\S]*?)(?=^## |(?![\s\S]))/gim,
      ),
    ];
    if (sections.length !== stored.questions.length)
      throw new ValidationError("Quiz sheet questions do not match SQLite");
    for (const [ordinal, match] of sections.entries()) {
      const ordinalText = match[1];
      const questionId = match[2];
      const kind = match[3];
      const body = match[4];
      const expected = stored.questions[ordinal];
      if (
        !ordinalText ||
        !questionId ||
        !kind ||
        body === undefined ||
        !expected ||
        Number(ordinalText) !== ordinal + 1
      )
        throw new ValidationError("Quiz sheet question identity is invalid");
      const prompt = body
        .replace(/\n### \d+\. Your answer[\s\S]*$/i, "")
        .replace(/^- \[ \] .*$/gim, "")
        .trim();
      const choices = [...body.matchAll(/^- \[ \] (.+)$/gim)]
        .map((choice) => choice[1])
        .filter((choice): choice is string => choice !== undefined);
      if (
        questionId.trim() !== expected.questionId ||
        kind.toLowerCase() !== expected.kind ||
        cleanMarkdown(prompt) !== cleanMarkdown(expected.prompt) ||
        JSON.stringify(choices.length ? choices : undefined) !== JSON.stringify(expected.choices)
      )
        throw new ValidationError("Quiz sheet question content does not match SQLite");
    }
    const settled = this.readSettledResults(stored);
    const canonical = this.renderSheet(stored, this.answerMap(stored.quizId), settled?.questions, settled?.pages);
    if (cleanMarkdown(markdown) !== cleanMarkdown(canonical))
      throw new ValidationError("Quiz sheet answers or Results do not match SQLite");
    return stored;
  }

  private requireQuiz(date: string): QuizRecord {
    const quiz = this.get(date);
    if (!quiz) throw new ValidationError(`No quiz for ${date}`);
    return quiz;
  }
  private hiddenTokensForQuiz(
    quiz: QuizRecord,
    evidence?: readonly QuizEvidenceRecord[],
    requestId?: string,
  ): readonly QuizVisibleTextToken[] {
    const evidenceTokens = evidence
      ? evidence.flatMap((item) => [
          substringToken(item.reference),
          pageIdToken(item.pageId),
          substringToken(item.pageDigest),
          substringToken(item.textDigest),
        ])
      : this.db
          .all<Record<string, unknown>>(
            "SELECT reference, page_id, page_digest, text_digest FROM quiz_evidence WHERE quiz_id = ?",
            quiz.quizId,
          )
          .flatMap((row) =>
            [
              typeof row.reference === "string" ? substringToken(row.reference) : undefined,
              typeof row.page_id === "string" ? pageIdToken(row.page_id) : undefined,
              typeof row.page_digest === "string" ? substringToken(row.page_digest) : undefined,
              typeof row.text_digest === "string" ? substringToken(row.text_digest) : undefined,
            ].filter((token): token is QuizVisibleTextToken => Boolean(token)),
          );
    return [
      substringToken(quiz.quizId),
      ...quiz.questions.flatMap((question) => [
        substringToken(question.questionId),
        ...question.pages.flatMap((page) => [
          pageIdToken(page.pageId),
          substringToken(page.criterion),
          substringToken(renderedMarkdownValues(page.criterion)),
        ]),
        ...(question.sourceRefs ?? []).map(boundaryToken),
      ]),
      ...evidenceTokens,
      ...(requestId ? [substringToken(requestId)] : []),
    ];
  }

  private mapQuiz(row: Record<string, unknown>): QuizRecord {
    const quizId = String(row.quiz_id);
    const questions = this.db
      .all<Record<string, unknown>>("SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY ordinal", quizId)
      .map((question) => {
        const questionId = String(question.question_id);
        const pages = this.db
          .all<Record<string, unknown>>(
            "SELECT page_id, criterion_json, weight FROM question_pages WHERE question_id = ? ORDER BY page_id",
            questionId,
          )
          .map((page) => {
            const parsed = parseJson<unknown>(page.criterion_json, "");
            const criterion =
              typeof parsed === "string"
                ? parsed
                : parsed && typeof parsed === "object" && "criterion" in parsed
                  ? String((parsed as { criterion?: unknown }).criterion ?? "")
                  : String(parsed ?? "");
            return {
              pageId: String(page.page_id),
              criterion,
              weight: Number(page.weight),
            } satisfies QuizQuestionPageRecord;
          });
        return {
          questionId,
          quizId,
          ordinal: Number(question.ordinal),
          kind: String(question.kind) as QuizQuestionKind,
          prompt: String(question.prompt),
          choices: parseJson<string[] | undefined>(question.choices_json, undefined),
          pages,
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
    this.validateRenderedSheet(rendered, this.hiddenTokensForQuiz(preview));
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
    const result = this.db.run(
      "UPDATE quizzes SET status = 'submitted', submitted_at = ? WHERE quiz_id = ? AND status = 'open' AND revision = ?",
      submittedAt,
      quiz.quizId,
      quiz.revision,
    );
    requireDatabaseChange(result, "The quiz submission revision is stale");
    return this.requireQuiz(quiz.date);
  }
  private snapshotEvidence(quiz: QuizRecord): QuizEvidenceRecord[] {
    const expectedPages = new Set(quiz.questions.flatMap((question) => question.pages.map((page) => page.pageId)));
    const rows = this.db.all<Record<string, unknown>>(
      "SELECT * FROM quiz_evidence WHERE quiz_id = ? ORDER BY page_id, reference",
      quiz.quizId,
    );
    if (!rows.length || !expectedPages.size) throw new ValidationError("Quiz evidence snapshot is missing");
    const seen = new Set<string>();
    const evidence: QuizEvidenceRecord[] = [];
    for (const row of rows) {
      const quizId = String(row.quiz_id ?? "");
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
        !expectedPages.has(pageId) ||
        !reference ||
        !/^[0-9a-f]{64}$/u.test(reference) ||
        seen.has(reference) ||
        !validWikiPath(path) ||
        !(
          (anchor === "" && heading === undefined) ||
          (anchor.startsWith("#") && anchor.length > 1 && heading !== undefined)
        ) ||
        !/^[0-9a-f]{64}$/u.test(pageDigest) ||
        !Number.isInteger(pageRevision) ||
        pageRevision < 1 ||
        !/^[0-9a-f]{64}$/u.test(textDigest) ||
        !excerpt ||
        Buffer.byteLength(excerpt, "utf8") > 8192 ||
        !/^[0-9a-f]{64}$/u.test(excerptDigest) ||
        createHash("sha256").update(excerpt).digest("hex") !== excerptDigest ||
        evidenceReference(pageId, anchor, pageDigest, pageRevision, textDigest) !== reference
      )
        throw new ValidationError("Quiz evidence snapshot is malformed");
      seen.add(reference);
      evidence.push({
        reference,
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
    if (seen.size !== rows.length || expectedPages.size !== new Set(evidence.map((item) => item.pageId)).size)
      throw new ValidationError("Quiz evidence snapshot is incomplete");
    return evidence;
  }

  private evidenceForPage(pageId: string): QuizEvidenceRecord[] {
    const page = this.db.get<Record<string, unknown>>(
      "SELECT status, quiz_worthiness, relative_path, digest, revision FROM pages WHERE page_id = ?",
      pageId,
    );
    if (page?.status !== "active" || page.quiz_worthiness !== "eligible")
      throw new ValidationError(`Evidence page is unavailable: ${pageId}`);
    const path = String(page.relative_path ?? "");
    const pageDigest = String(page.digest ?? "");
    const pageRevision = Number(page.revision ?? 0);
    if (
      !validWikiPath(path) ||
      !/^[0-9a-f]{64}$/u.test(pageDigest) ||
      !Number.isInteger(pageRevision) ||
      pageRevision < 1
    )
      throw new ValidationError(`Evidence page metadata is invalid: ${pageId}`);
    const wikiRoot =
      this.paths?.wiki ??
      (this.paths as { readonly wikiRoot?: string } | undefined)?.wikiRoot ??
      (this.paths?.root ? join(this.paths.root, "wiki") : undefined) ??
      (this.paths?.vaultRoot ? join(this.paths.vaultRoot, "wiki") : undefined);
    if (!wikiRoot) throw new ValidationError(`Evidence page is unavailable: ${pageId}`);
    let bytes: Buffer;
    try {
      bytes = readFileNoFollow(safeRelativePath(wikiRoot, path));
    } catch {
      throw new ValidationError(`Evidence page is unavailable: ${pageId}`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== pageDigest)
      throw new ValidationError(`Evidence page is stale: ${pageId}`);
    const content = bytes.toString("utf8");
    const sections = parseWikiDocumentSections(content, pageId);
    return sections.map((section) => {
      const sectionText = content.slice(section.startOffset, section.endOffset);
      if (!sectionText || createHash("sha256").update(sectionText).digest("hex") !== section.textDigest)
        throw new ValidationError(`Evidence section is stale: ${pageId}${section.anchor}`);
      return {
        reference: evidenceReference(pageId, section.anchor, pageDigest, pageRevision, section.textDigest),
        pageId,
        path,
        anchor: section.anchor,
        ...(section.heading === undefined ? {} : { heading: section.heading }),
        pageDigest,
        pageRevision,
        textDigest: section.textDigest,
        excerpt: boundedUtf8(sectionText, 8192),
      };
    });
  }

  private uniqueEvidence(evidence: readonly QuizEvidenceRecord[]): QuizEvidenceRecord[] {
    const seen = new Set<string>();
    const unique: QuizEvidenceRecord[] = [];
    for (const item of evidence) {
      if (seen.has(item.reference)) continue;
      seen.add(item.reference);
      unique.push(item);
    }
    return unique;
  }

  private validateQuestionSpecs(
    specs: readonly QuestionSpecInput[],
    selectedPageIds: readonly string[],
  ): readonly QuestionSpecInput[] {
    if (!specs.length) throw new ValidationError("Quiz generation produced no question specifications");
    const selected = new Set(selectedPageIds);
    const covered = new Set<string>();
    for (const question of specs) {
      if (!question || (question.kind !== "free-response" && question.kind !== "multiple-choice"))
        throw new ValidationError("Question kind is invalid");
      const boundaryTokens = [
        ...selectedPageIds.map(pageIdToken),
        ...(Array.isArray(question.sourceRefs)
          ? question.sourceRefs
              .filter((reference): reference is string => typeof reference === "string")
              .map(boundaryToken)
          : []),
      ];
      const prompt = question.prompt.trim();
      if (!prompt || FORBIDDEN_SHEET_TEXT.test(prompt))
        throw new ValidationError("Question prompts must be nonempty and answer-key-free");
      validateQuizVisibleText(prompt, boundaryTokens);
      if (!Array.isArray(question.pages) || !question.pages.length)
        throw new ValidationError("Every question must cover at least one wiki page");
      const pageIds = question.pages.map((page) => (page && typeof page.pageId === "string" ? page.pageId.trim() : ""));
      if (new Set(pageIds).size !== pageIds.length || pageIds.some((pageId) => !pageId))
        throw new ValidationError("Question page bindings must be distinct and nonempty");
      for (const [index, page] of question.pages.entries()) {
        if (
          !page ||
          pageIds[index] !== page.pageId.trim() ||
          !page.criterion.trim() ||
          !Number.isFinite(page.weight) ||
          page.weight <= 0
        )
          throw new ValidationError("Every question page requires a nonempty criterion and positive weight");
        covered.add(page.pageId);
        if (!selected.has(page.pageId)) throw new ValidationError("Question references an ineligible wiki page");
      }
      if (
        question.sourceRefs !== undefined &&
        (!Array.isArray(question.sourceRefs) || question.sourceRefs.some((reference) => typeof reference !== "string"))
      )
        throw new ValidationError("Question source references must be strings");
      if (
        question.choices !== undefined &&
        (!Array.isArray(question.choices) || question.choices.some((choice) => typeof choice !== "string"))
      )
        throw new ValidationError("Question options must be strings");
      if (
        question.kind === "multiple-choice" &&
        (!question.choices || question.choices.length < 2 || new Set(question.choices).size !== question.choices.length)
      )
        throw new ValidationError("Multiple-choice questions require distinct options");
      for (const choice of question.choices ?? []) {
        if (!choice.trim() || FORBIDDEN_SHEET_TEXT.test(choice))
          throw new ValidationError("Question options must be nonempty and answer-key-free");
        validateQuizVisibleText(choice, boundaryTokens);
      }
    }
    if (covered.size !== selected.size || [...selected].some((pageId) => !covered.has(pageId)))
      throw new ValidationError("Every selected page must be referenced by a question");
    return specs;
  }
  private prepareGradeSubmission(quiz: QuizRecord, input: GradeSubmissionInput): PreparedGradeSubmission {
    const questionById = new Map(quiz.questions.map((question) => [question.questionId, question]));
    if (
      input.questions.length !== quiz.questions.length ||
      input.questions.some((question) => !questionById.has(question.questionId))
    ) {
      throw new ValidationError("Grading must cover every displayed question exactly once");
    }
    const hiddenTokens = this.hiddenTokensForQuiz(quiz, undefined, input.requestId);
    const expectedPageIds = new Set(quiz.questions.flatMap((question) => question.pages.map((page) => page.pageId)));
    if (input.pages.length !== expectedPageIds.size || input.pages.some((page) => !expectedPageIds.has(page.pageId))) {
      throw new ValidationError("Grading must cover every covered page exactly once");
    }
    const evidenceByPage = new Map<string, Map<string, QuizEvidenceRecord>>();
    for (const item of this.gradingEvidence(quiz)) {
      const byReference = evidenceByPage.get(item.pageId) ?? new Map<string, QuizEvidenceRecord>();
      byReference.set(item.reference, item);
      evidenceByPage.set(item.pageId, byReference);
    }
    const seenQuestions = new Set<string>();
    const questions: PreparedQuestionGrade[] = [];
    for (const questionGrade of input.questions) {
      if (seenQuestions.has(questionGrade.questionId))
        throw new ValidationError("A question was graded more than once");
      seenQuestions.add(questionGrade.questionId);
      const question = questionById.get(questionGrade.questionId);
      if (!question) throw new ValidationError("Grading references an unknown question");
      const feedback = questionGrade.feedback?.trim() || "";
      this.validateFeedback(feedback, hiddenTokens);
      questions.push({ input: questionGrade, question, feedback });
    }

    const seenPages = new Set<string>();
    const pages: PreparedPageGrade[] = [];
    for (const pageGrade of input.pages) {
      if (seenPages.has(pageGrade.pageId)) throw new ValidationError("A page was graded more than once");
      seenPages.add(pageGrade.pageId);
      if (!expectedPageIds.has(pageGrade.pageId))
        throw new ValidationError(`Grading references an uncovered page: ${pageGrade.pageId}`);
      if (!RATINGS.includes(pageGrade.rating))
        throw new ValidationError(`Unsupported FSRS rating: ${pageGrade.rating}`);
      const feedback = pageGrade.feedback?.trim() || "";

      const evidence = pageGrade.evidence.map((item) => (typeof item === "string" ? item.trim() : ""));
      if (!evidence.length || evidence.some((item) => !item))
        throw new ValidationError(`Every page grade requires authorized evidence IDs: ${pageGrade.pageId}`);
      if (new Set(evidence).size !== evidence.length)
        throw new ValidationError(`Page grade repeats evidence IDs: ${pageGrade.pageId}`);
      const byReference = evidenceByPage.get(pageGrade.pageId) ?? new Map<string, QuizEvidenceRecord>();
      const evidenceRecords = evidence
        .map((reference) => byReference.get(reference))
        .filter((item): item is QuizEvidenceRecord => Boolean(item));
      if (evidenceRecords.length !== evidence.length)
        throw new ValidationError(`Page grade cites unauthorized evidence: ${pageGrade.pageId}`);
      const readings = this.uniqueReadings(pageGrade.readings ?? []);
      this.validateReadings(byReference, pageGrade.pageId, readings);
      if (
        readings.some(
          (reading) =>
            !evidenceRecords.some(
              (record) =>
                record.pageId === reading.pageId &&
                record.anchor === reading.anchor &&
                (reading.heading === undefined || reading.heading === record.heading),
            ),
        )
      )
        throw new ValidationError(`Page grade readings are not covered by cited evidence: ${pageGrade.pageId}`);
      this.validateFeedback(feedback, hiddenTokens);
      pages.push({ input: pageGrade, evidence, evidenceRecords, readings, feedback });
    }
    return { questions, pages };
  }

  private revalidatePreparedGrades(quiz: QuizRecord, prepared: PreparedGradeSubmission): void {
    const evidenceByPage = new Map<string, Map<string, QuizEvidenceRecord>>();
    for (const item of this.gradingEvidence(quiz)) {
      const byReference = evidenceByPage.get(item.pageId) ?? new Map<string, QuizEvidenceRecord>();
      byReference.set(item.reference, item);
      evidenceByPage.set(item.pageId, byReference);
    }
    for (const page of prepared.pages) {
      const current = evidenceByPage.get(page.input.pageId) ?? new Map<string, QuizEvidenceRecord>();
      for (const record of page.evidenceRecords) {
        const latest = current.get(record.reference);
        if (
          !latest ||
          latest.pageId !== record.pageId ||
          latest.path !== record.path ||
          latest.anchor !== record.anchor ||
          latest.heading !== record.heading ||
          latest.pageDigest !== record.pageDigest ||
          latest.pageRevision !== record.pageRevision ||
          latest.textDigest !== record.textDigest ||
          latest.excerpt !== record.excerpt
        )
          throw new RevisionConflictError(`Grading evidence is stale: ${record.reference}`);
      }
      this.validateReadings(current, page.input.pageId, page.readings);
    }
  }

  private validateAnswerText(
    answer: string | readonly string[],
    hiddenTokens: readonly QuizVisibleTextToken[] = [],
  ): void {
    const text = answerText(answer);
    validateQuizVisibleText(text, hiddenTokens);
    if (FORBIDDEN_SHEET_TEXT.test(text) || /^#{1,6}\s/mu.test(text))
      throw new ValidationError("Answers may not contain private grading material or structural Markdown");
  }

  private validateFeedback(feedback: string, hiddenTokens: readonly QuizVisibleTextToken[] = []): void {
    validateQuizVisibleText(feedback, hiddenTokens);
    if (FORBIDDEN_SHEET_TEXT.test(feedback))
      throw new ValidationError("Feedback may not contain private grading material");
  }

  private validateCompleteAnswers(
    quiz: QuizRecord,
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): void {
    const hiddenTokens = this.hiddenTokensForQuiz(quiz);
    for (const question of quiz.questions) {
      const answer = answers[question.questionId];
      if (answer === undefined || answerText(answer).trim() === "")
        throw new ValidationError(`Missing answer for ${question.questionId}`);
      if (question.kind === "multiple-choice") {
        const values = Array.isArray(answer) ? answer : [answer];
        if (values.some((value) => !question.choices?.includes(value)))
          throw new ValidationError(`Invalid choice for ${question.questionId}`);
      }
      this.validateAnswerText(answer, hiddenTokens);
    }
  }

  private answerMap(quizId: string): Record<string, string | readonly string[]> {
    const answers: Record<string, string | readonly string[]> = {};
    for (const row of this.db.all<Record<string, unknown>>(
      "SELECT question_id, answer_json FROM quiz_answers WHERE quiz_id = ?",
      quizId,
    ))
      answers[String(row.question_id)] = parseJson(row.answer_json, "");
    return answers;
  }

  private validateReadings(
    evidence: ReadonlyMap<string, QuizEvidenceRecord>,
    pageId: string,
    readings: readonly ReadingLink[],
  ): void {
    for (const reading of readings) {
      if (!validReading(reading) || reading.pageId !== pageId)
        throw new ValidationError(`Reading is malformed or outside the graded page: ${pageId}`);
      const record = [...evidence.values()].find(
        (candidate) =>
          candidate.pageId === reading.pageId &&
          candidate.anchor === reading.anchor &&
          (reading.heading === undefined || reading.heading === candidate.heading),
      );
      if (!record) throw new ValidationError(`Reading is not an authorized sealed evidence section for ${pageId}`);
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

  private readSettlementIdentity(quiz: QuizRecord): string | undefined {
    const row = this.db.get<Record<string, unknown>>(
      "SELECT settlement_id FROM page_reviews WHERE quiz_id = ? ORDER BY reviewed_at, page_id LIMIT 1",
      quiz.quizId,
    );
    return row ? String(row.settlement_id ?? "") || undefined : undefined;
  }

  readSettledResult(quiz: QuizRecord): SettledQuizResult | undefined {
    return this.readSettledResults(quiz);
  }

  private readSettledResults(quiz: QuizRecord): SettledQuizResult | undefined {
    const questionRows = this.db.all<Record<string, unknown>>(
      "SELECT * FROM question_results WHERE quiz_id = ? ORDER BY graded_at, question_id",
      quiz.quizId,
    );
    const pageRows = this.db.all<Record<string, unknown>>(
      "SELECT * FROM page_results WHERE quiz_id = ? ORDER BY page_id",
      quiz.quizId,
    );
    const reviewRows = this.db.all<Record<string, unknown>>(
      "SELECT * FROM page_reviews WHERE quiz_id = ? ORDER BY reviewed_at, page_id",
      quiz.quizId,
    );
    if (!questionRows.length && !pageRows.length && !reviewRows.length) return undefined;
    if (
      questionRows.length !== quiz.questions.length ||
      pageRows.length !==
        new Set(quiz.questions.flatMap((question) => question.pages.map((page) => page.pageId))).size ||
      reviewRows.length !== pageRows.length
    )
      throw new ValidationError("Committed grade is incomplete");
    const hiddenTokens = this.hiddenTokensForQuiz(quiz);

    const questionById = new Map<string, Record<string, unknown>>();
    for (const row of questionRows) {
      const questionId = String(row.question_id ?? "");
      if (!questionId || questionById.has(questionId))
        throw new ValidationError("Committed grade contains duplicate question Results");
      if (!quiz.questions.some((question) => question.questionId === questionId))
        throw new ValidationError("Committed grade contains an unexpected question Result");
      if (Number(row.answer_revision) !== quiz.revision)
        throw new ValidationError("Committed grade revision does not match the sealed submission");
      const feedback = String(row.feedback ?? "");
      this.validateFeedback(feedback, hiddenTokens);
      questionById.set(questionId, row);
    }
    const questions: SettledQuestionResult[] = [];
    for (const question of quiz.questions) {
      const row = questionById.get(question.questionId);
      if (!row) throw new ValidationError("Committed grade is missing a question Result");
      questions.push({ questionId: question.questionId, feedback: String(row.feedback ?? "") });
    }

    const expectedPageIds = new Set(quiz.questions.flatMap((question) => question.pages.map((page) => page.pageId)));
    const reviewByPage = new Map<string, Record<string, unknown>>();
    const reviewById = new Map<string, Record<string, unknown>>();
    let settlementId: string | undefined;
    for (const row of reviewRows) {
      const pageId = String(row.page_id ?? "");
      const reviewId = String(row.review_id ?? "");
      const currentSettlement = String(row.settlement_id ?? "");
      if (!expectedPageIds.has(pageId) || !reviewId || reviewByPage.has(pageId) || reviewById.has(reviewId))
        throw new ValidationError("Committed grade contains an unexpected or duplicate page review");
      if (!currentSettlement) throw new ValidationError("Committed grade page review has no settlement identity");
      if (settlementId === undefined) settlementId = currentSettlement;
      if (settlementId !== currentSettlement)
        throw new ValidationError("Committed grade settlement identity is inconsistent");
      if (!RATINGS.includes(String(row.rating) as ReviewRating))
        throw new ValidationError("Committed grade page review has an invalid rating");
      reviewByPage.set(pageId, row);
      reviewById.set(reviewId, row);
    }

    const pages: SettledPageResult[] = [];
    const resultByPage = new Map<string, SettledPageResult>();
    for (const row of pageRows) {
      const pageId = String(row.page_id ?? "");
      const reviewId = String(row.review_id ?? "");
      if (!expectedPageIds.has(pageId) || resultByPage.has(pageId))
        throw new ValidationError("Committed grade contains an unexpected or duplicate page Result");
      const review = reviewById.get(reviewId);
      if (!review || String(review.page_id) !== pageId)
        throw new ValidationError("Committed grade page Result is missing its page review");
      const evidenceValue = parseJson<unknown>(row.evidence_json, undefined);
      const readingsValue = parseJson<unknown>(row.readings_json, undefined);
      if (
        !Array.isArray(evidenceValue) ||
        evidenceValue.some((item) => typeof item !== "string" || !item) ||
        new Set(evidenceValue).size !== evidenceValue.length ||
        !Array.isArray(readingsValue) ||
        !readingsValue.every(validReading)
      )
        throw new ValidationError("Committed grade page evidence or readings are malformed");
      const rating = String(row.rating) as ReviewRating;
      if (!RATINGS.includes(rating) || String(review.rating) !== rating)
        throw new ValidationError("Committed grade page rating is inconsistent");
      const feedback = String(row.feedback ?? "");
      this.validateFeedback(feedback, hiddenTokens);
      resultByPage.set(pageId, {
        gradeId: reviewId,
        quizId: quiz.quizId,
        pageId,
        rating,
        feedback,
        gradedAt: String(review.reviewed_at ?? ""),
        reviewId,
        evidence: evidenceValue,
        readings: readingsValue,
      });
    }
    for (const pageId of expectedPageIds) {
      if (!resultByPage.has(pageId) || !reviewByPage.has(pageId))
        throw new ValidationError("Committed grade is missing a page Result");
      pages.push(resultByPage.get(pageId)!);
    }
    return { quiz, questions, pages };
  }

  private validateRenderedSheet(markdown: string, hiddenTokens: readonly QuizVisibleTextToken[] = []): void {
    if (
      !markdown.trim() ||
      FORBIDDEN_SHEET_TEXT.test(markdown) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(markdown)
    ) {
      throw new ValidationError("Rendered quiz sheet contains forbidden controlled content");
    }
    if (
      !/^# \d+\. Pi Scholar Quiz — \d{4}-\d{2}-\d{2}\s*$/mu.test(markdown) ||
      !/<!--\s*pi-scholar:quiz format=1 id=[^\s]+ revision=\d+\s*-->/u.test(markdown)
    ) {
      throw new ValidationError("Rendered quiz sheet header is invalid");
    }
    const headings = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => match[1]!.trim());
    if (!headings.length || headings.some((heading) => !/^\d+(?:[.)]|\s)/u.test(heading)))
      throw new ValidationError("Rendered quiz sheet headings must be numeric");
    const comments = [...markdown.matchAll(/<!--[\s\S]*?-->/gu)].map((match) => match[0]);
    if (
      comments.length < 1 ||
      comments.some(
        (comment) =>
          !/^<!--\s*pi-scholar:(?:quiz format=1 id=[^\s]+ revision=\d+|question id=[^\s]+)\s*-->$/u.test(comment),
      ) ||
      comments.filter((comment) => /^<!--\s*pi-scholar:quiz\b/u.test(comment)).length !== 1
    )
      throw new ValidationError("Rendered quiz sheet comments are invalid");
    const visibleMarkdown = markdown.replace(
      /<!--\s*pi-scholar:(?:quiz format=1 id=[^\s]+ revision=\d+|question id=[^\s]+)\s*-->/gu,
      "",
    );
    validateQuizVisibleText(visibleMarkdown, hiddenTokens);
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

  private writeSheet(
    quiz: QuizRecord,
    answers?: Readonly<Record<string, string | readonly string[]>>,
    results?: readonly SettledQuestionResult[],
    pageResults?: readonly SettledPageResult[],
  ): void {
    const sheetPath = quiz.sheetPath ?? pathForSheet(this.paths, quiz.date);
    if (!sheetPath) return;
    const rendered = this.renderSheet(quiz, answers, results, pageResults);
    this.validateRenderedSheet(rendered, this.hiddenTokensForQuiz(quiz));
    this.replaceSheet(sheetPath, rendered, () => undefined);
  }
}
