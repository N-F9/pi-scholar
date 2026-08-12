import { randomUUID } from "node:crypto";
import type { DateInput, CardInput as FsrsCardInput, Grade } from "ts-fsrs";
import { fsrs, Rating } from "ts-fsrs";
import type {
  FsrsState,
  PageLearningRecord,
  PagePrerequisiteRecord,
  PageReviewRecord,
  ReviewRating,
} from "./contracts.js";
import type { ScholarDatabase } from "./database.js";
import { transaction as databaseTransaction } from "./database.js";

export interface SqlDatabase {
  exec(sql: string): void;
  run(sql: string, ...parameters: unknown[]): unknown;
  get<T = Record<string, unknown>>(sql: string, ...parameters: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...parameters: unknown[]): T[];
}

export type SqlDatabaseSource = Pick<ScholarDatabase, "exec" | "run" | "get" | "all">;

function adaptDatabase(source: SqlDatabaseSource): SqlDatabase {
  return {
    exec: (sql) => source.exec(sql),
    run: (sql, ...parameters) => source.run(sql, parameters.length ? (parameters as never) : undefined),
    get: (sql, ...parameters) => source.get(sql, parameters.length ? (parameters as never) : undefined),
    all: (sql, ...parameters) => source.all(sql, parameters.length ? (parameters as never) : undefined),
  };
}

export interface VaultPathsLike {
  readonly root?: string;
  readonly vaultRoot?: string;
  readonly quizzes?: string;
  readonly quizzesRoot?: string;
  readonly wiki?: string;
}

export interface CoveragePage {
  readonly pageId: string;
  readonly status?: "active" | "drifted" | "retired";
  readonly quizWorthiness?: "eligible" | "skip" | "unknown";
}

export interface CoverageReport {
  readonly ok: boolean;
  readonly coveredPageIds: readonly string[];
  readonly skippedPageIds: readonly string[];
  readonly missingPageIds: readonly string[];
}

export interface PrerequisiteResult {
  readonly pageId: string;
  readonly prerequisites: readonly string[];
}

export class RevisionConflictError extends Error {
  readonly code = "revision-conflict";
  constructor(message = "The page learning revision is stale") {
    super(message);
    this.name = "RevisionConflictError";
  }
}

export class ValidationError extends Error {
  readonly code = "validation-error";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const FSRS_STATES: readonly FsrsState[] = ["New", "Learning", "Review", "Relearning"];
const RATINGS: readonly ReviewRating[] = ["Again", "Hard", "Good", "Easy"];

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function asDate(value: string | Date | undefined, field: string): Date {
  if (value === undefined) throw new ValidationError(`${field} is required`);
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a valid date`);
  return date;
}

export function localDate(value: string | Date, timezone = "local"): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
    throw new ValidationError("date must be a valid calendar date");
  }
  const date = asDate(value, "date");
  if (timezone !== "local") {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
    } catch {
      throw new ValidationError("timezone is invalid");
    }
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const SEALED_QUIZ_REVIEW = Symbol("sealed-quiz-review");

export interface ReviewTransitionContext {
  readonly quizId: string;
  readonly submissionId: string;
  readonly revision: number;
  readonly settlementId?: string;
  readonly authorization?: typeof SEALED_QUIZ_REVIEW;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value as T | undefined) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseState(value: unknown): FsrsState {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < FSRS_STATES.length)
    return FSRS_STATES[value] as FsrsState;
  const text = String(value ?? "");
  if (FSRS_STATES.includes(text as FsrsState)) return text as FsrsState;
  const numeric = Number(text);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < FSRS_STATES.length)
    return FSRS_STATES[numeric] as FsrsState;
  return "New";
}

function stateNumber(value: FsrsState | number): number {
  if (typeof value === "number") return value;
  const state = FSRS_STATES.indexOf(value);
  if (state < 0) throw new ValidationError(`Unsupported FSRS state: ${value}`);
  return state;
}

function ratingValue(value: ReviewRating): Grade {
  switch (value) {
    case "Again":
      return Rating.Again;
    case "Hard":
      return Rating.Hard;
    case "Good":
      return Rating.Good;
    case "Easy":
      return Rating.Easy;
    default:
      throw new ValidationError(`Unsupported FSRS rating: ${value}`);
  }
}

function isoOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function changedRows(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const changes = (result as { changes?: number | bigint }).changes;
  return Number(changes ?? 0);
}

function requireRevision(result: unknown): void {
  if (changedRows(result) !== 1) throw new RevisionConflictError();
}

function transaction<T>(db: SqlDatabaseSource, fn: () => T): T {
  return databaseTransaction(db as never, fn);
}

function mapPageLearning(row: Record<string, unknown>): PageLearningRecord {
  const dueAt = isoOrUndefined(row.due_at) ?? nowIso();
  const createdAt = isoOrUndefined(row.created_at) ?? nowIso();
  return {
    pageId: String(row.page_id),
    initialDueAt: isoOrUndefined(row.initial_due_at) ?? dueAt,
    dueAt,
    fsrsState: parseState(row.fsrs_state),
    stability: Number(row.stability ?? 0),
    difficulty: Number(row.difficulty ?? 0),
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
    scheduledDays: Number(row.scheduled_days ?? 0),
    lastReviewAt: isoOrUndefined(row.last_review_at),
    revision: Number(row.revision ?? 1),
    createdAt,
    updatedAt: isoOrUndefined(row.updated_at) ?? createdAt,
  };
}

function mapPageReview(row: Record<string, unknown>): PageReviewRecord {
  return {
    reviewId: String(row.review_id),
    pageId: String(row.page_id),
    quizId: String(row.quiz_id),
    submissionId: String(row.submission_id),
    revision: Number(row.revision),
    rating: String(row.rating) as ReviewRating,
    reviewedAt: isoOrUndefined(row.reviewed_at) ?? nowIso(),
    stateBefore: parseJson(row.state_before_json, null),
    stateAfter: parseJson(row.state_after_json, null),
    settlementId: String(row.settlement_id),
  };
}

function fsrsSnapshot(input: {
  readonly due: DateInput;
  readonly stability: number;
  readonly difficulty: number;
  readonly scheduled_days?: number;
  readonly learning_steps?: number;
  readonly reps: number;
  readonly lapses: number;
  readonly state: unknown;
  readonly last_review?: DateInput | null;
}): Record<string, string | number | null> {
  return {
    due: new Date(input.due).toISOString(),
    stability: input.stability,
    difficulty: input.difficulty,
    scheduled_days: input.scheduled_days ?? 0,
    learning_steps: input.learning_steps ?? 0,
    reps: input.reps,
    lapses: input.lapses,
    state: typeof input.state === "number" ? input.state : stateNumber(parseState(input.state)),
    last_review:
      input.last_review === undefined || input.last_review === null ? null : new Date(input.last_review).toISOString(),
  };
}

export class SchedulerService {
  readonly db: SqlDatabase;
  readonly paths?: VaultPathsLike;
  private readonly source: SqlDatabaseSource;
  private readonly engine = fsrs();
  private timezone: string;

  constructor(source: SqlDatabaseSource, paths?: VaultPathsLike, timezone = "local") {
    this.source = source;
    this.db = adaptDatabase(source);
    this.paths = paths;
    this.timezone = timezone;
  }

  setTimezone(timezone: string): void {
    this.timezone = timezone;
  }

  ensurePageLearning(pageId: string, initialDueAt?: string | Date): PageLearningRecord {
    const id = pageId.trim();
    if (!id) throw new ValidationError("pageId is required");
    if (!this.db.get("SELECT page_id FROM pages WHERE page_id = ?", id))
      throw new ValidationError(`Unknown wiki page: ${id}`);
    const due = initialDueAt === undefined ? new Date() : asDate(initialDueAt, "initialDueAt");
    const now = nowIso();
    transaction(this.source, () => {
      this.db.run(
        `INSERT OR IGNORE INTO page_learning
          (page_id, initial_due_at, due_at, fsrs_state, stability, difficulty, reps, lapses, scheduled_days, last_review_at, revision, created_at, updated_at)
         VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, 1, ?, ?)`,
        id,
        due.toISOString(),
        due.toISOString(),
        now,
        now,
      );
    });
    return this.getPageLearning(id);
  }

  getPageLearning(pageId: string): PageLearningRecord {
    const id = pageId.trim();
    const row = this.db.get<Record<string, unknown>>("SELECT * FROM page_learning WHERE page_id = ?", id);
    if (!row) throw new ValidationError(`Page learning state is missing: ${id}`);
    return mapPageLearning(row);
  }

  listPageLearning(activeOnly = false): PageLearningRecord[] {
    const sql = activeOnly
      ? `SELECT l.* FROM page_learning l JOIN pages p ON p.page_id = l.page_id
         WHERE p.status = 'active' AND p.quiz_worthiness = 'eligible' ORDER BY l.due_at, l.page_id`
      : "SELECT * FROM page_learning ORDER BY due_at, page_id";
    return this.db.all<Record<string, unknown>>(sql).map(mapPageLearning);
  }

  listPrerequisites(pageId: string): PagePrerequisiteRecord[] {
    const id = pageId.trim();
    return this.db
      .all<Record<string, unknown>>(
        "SELECT page_id, prerequisite_page_id FROM page_prerequisites WHERE page_id = ? ORDER BY prerequisite_page_id",
        id,
      )
      .map((row) => ({ pageId: String(row.page_id), prerequisitePageId: String(row.prerequisite_page_id) }));
  }

  setPrerequisites(
    pageId: string,
    prerequisitePageIds: readonly string[],
    expectedRevision?: number,
  ): PrerequisiteResult {
    const id = pageId.trim();
    const page = this.db.get<Record<string, unknown>>(
      "SELECT status, quiz_worthiness FROM pages WHERE page_id = ?",
      id,
    );
    if (!page) throw new ValidationError(`Unknown wiki page: ${id}`);
    if (page.status !== "active") throw new ValidationError("Inactive pages cannot receive prerequisites");
    if (page.quiz_worthiness !== "eligible") throw new ValidationError("Ineligible pages cannot receive prerequisites");
    const ids = prerequisitePageIds.map((value) => value.trim());
    if (ids.some((value) => !value)) throw new ValidationError("Prerequisite page IDs must be nonempty");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.includes(id)) throw new ValidationError("A page cannot prerequisite itself");
    const pages = this.db.all<Record<string, unknown>>("SELECT page_id, status, quiz_worthiness FROM pages");
    const eligibleIds = new Set(
      pages
        .filter((row) => row.status === "active" && row.quiz_worthiness === "eligible")
        .map((row) => String(row.page_id)),
    );
    if (uniqueIds.some((value) => !eligibleIds.has(value)))
      throw new ValidationError("Prerequisite references an unknown, inactive, or ineligible page");
    const edges = new Map<string, Set<string>>();
    for (const row of this.db.all<Record<string, unknown>>(
      "SELECT page_id, prerequisite_page_id FROM page_prerequisites",
    )) {
      const target = String(row.page_id);
      const prerequisites = edges.get(target) ?? new Set<string>();
      prerequisites.add(String(row.prerequisite_page_id));
      edges.set(target, prerequisites);
    }
    edges.set(id, new Set(uniqueIds));
    if (this.hasCycle(edges)) throw new ValidationError("Prerequisite graph contains a cycle");
    const learning = this.ensurePageLearning(id);
    const revision = expectedRevision ?? learning.revision;
    if (revision !== learning.revision) throw new RevisionConflictError();
    transaction(this.source, () => {
      const result = this.db.run(
        "UPDATE page_learning SET revision = revision + 1, updated_at = ? WHERE page_id = ? AND revision = ?",
        nowIso(),
        id,
        revision,
      );
      requireRevision(result);
      this.db.run("DELETE FROM page_prerequisites WHERE page_id = ?", id);
      for (const prerequisitePageId of uniqueIds)
        this.db.run(
          "INSERT INTO page_prerequisites (page_id, prerequisite_page_id) VALUES (?, ?)",
          id,
          prerequisitePageId,
        );
    });
    return { pageId: id, prerequisites: uniqueIds };
  }

  validateCoverage(pages?: readonly CoveragePage[]): CoverageReport {
    const sourcePages = pages
      ? [...pages]
      : this.db
          .all<Record<string, unknown>>("SELECT page_id, status, quiz_worthiness FROM pages ORDER BY page_id")
          .map((row) => ({
            pageId: String(row.page_id),
            status: (row.status as CoveragePage["status"]) ?? "active",
            quizWorthiness: (row.quiz_worthiness as CoveragePage["quizWorthiness"]) ?? "unknown",
          }));
    const covered = new Set(
      this.db.all<{ page_id: string }>("SELECT page_id FROM page_learning").map((row) => String(row.page_id)),
    );
    const coveredPageIds: string[] = [];
    const skippedPageIds: string[] = [];
    const missingPageIds: string[] = [];
    for (const page of sourcePages) {
      if (page.status !== undefined && page.status !== "active") continue;
      if (page.quizWorthiness === "skip") skippedPageIds.push(page.pageId);
      else if (page.quizWorthiness === "eligible") {
        if (covered.has(page.pageId)) coveredPageIds.push(page.pageId);
        else missingPageIds.push(page.pageId);
      }
    }
    return { ok: missingPageIds.length === 0, coveredPageIds, skippedPageIds, missingPageIds };
  }

  eligiblePages(date: string | Date, initializeMissing = true): PageLearningRecord[] {
    const day = localDate(date, this.timezone);
    if (initializeMissing) {
      const eligible = this.db.all<{ page_id: string }>(
        "SELECT page_id FROM pages WHERE status = 'active' AND quiz_worthiness = 'eligible' ORDER BY page_id",
      );
      for (const page of eligible) {
        if (!this.db.get("SELECT page_id FROM page_learning WHERE page_id = ?", page.page_id))
          this.ensurePageLearning(page.page_id);
      }
    }
    const learning = this.listPageLearning(true).filter((entry) => localDate(entry.dueAt, this.timezone) <= day);
    const prerequisites = this.db.all<Record<string, unknown>>(
      "SELECT page_id, prerequisite_page_id FROM page_prerequisites",
    );
    const byPage = new Map<string, string[]>();
    for (const row of prerequisites) {
      const pageId = String(row.page_id);
      const list = byPage.get(pageId) ?? [];
      list.push(String(row.prerequisite_page_id));
      byPage.set(pageId, list);
    }
    const byLearning = new Map(learning.map((entry) => [entry.pageId, entry]));
    return learning.filter((entry) =>
      (byPage.get(entry.pageId) ?? []).every((prerequisitePageId) => {
        const prerequisite = this.db.get<Record<string, unknown>>(
          "SELECT status FROM pages WHERE page_id = ?",
          prerequisitePageId,
        );
        const prerequisiteLearning =
          byLearning.get(prerequisitePageId) ??
          (() => {
            const row = this.db.get<Record<string, unknown>>(
              "SELECT * FROM page_learning WHERE page_id = ?",
              prerequisitePageId,
            );
            return row ? mapPageLearning(row) : undefined;
          })();
        return prerequisite?.status === "active" && prerequisiteLearning?.fsrsState === "Review";
      }),
    );
  }

  pageHistory(pageId: string): PageReviewRecord[] {
    const id = pageId.trim();
    if (!this.db.get("SELECT page_id FROM pages WHERE page_id = ?", id))
      throw new ValidationError(`Unknown wiki page: ${id}`);
    return this.db
      .all<Record<string, unknown>>("SELECT * FROM page_reviews WHERE page_id = ? ORDER BY reviewed_at, review_id", id)
      .map(mapPageReview);
  }

  transitionPage(
    pageId: string,
    rating: ReviewRating,
    reviewedAt: string | Date,
    context: ReviewTransitionContext,
  ): PageReviewRecord {
    return transaction(this.source, () => this.transitionPageInTransaction(pageId, rating, reviewedAt, context));
  }

  transitionPageInTransaction(
    pageId: string,
    rating: ReviewRating,
    reviewedAt: string | Date,
    context: ReviewTransitionContext,
  ): PageReviewRecord {
    const id = pageId.trim();
    if (!id) throw new ValidationError("pageId is required");
    if (!RATINGS.includes(rating)) throw new ValidationError(`Unsupported FSRS rating: ${rating}`);
    if (!context.quizId.trim() || !context.submissionId.trim())
      throw new ValidationError("quizId and submissionId are required");
    if (!Number.isInteger(context.revision) || context.revision < 0)
      throw new ValidationError("revision must be a nonnegative integer");
    const page = this.db.get<Record<string, unknown>>("SELECT status FROM pages WHERE page_id = ?", id);
    if (!page) throw new ValidationError(`Unknown wiki page: ${id}`);
    if (page.status !== "active" && context.authorization !== SEALED_QUIZ_REVIEW)
      throw new ValidationError("Inactive pages cannot be reviewed");
    const learning = this.getPageLearning(id);
    const existing = this.db.get<Record<string, unknown>>(
      "SELECT * FROM page_reviews WHERE quiz_id = ? AND page_id = ? AND revision = ?",
      context.quizId,
      id,
      context.revision,
    );
    if (existing) {
      if (String(existing.submission_id) !== context.submissionId || String(existing.rating) !== rating)
        throw new ValidationError("Page review revision is already settled");
      return mapPageReview(existing);
    }
    const at = asDate(reviewedAt, "reviewedAt");
    const before = this.toFsrsInput(learning);
    const after = this.engine.next(before, at, ratingValue(rating)).card;
    const beforeSnapshot = fsrsSnapshot(before);
    const afterSnapshot = fsrsSnapshot(after);
    const reviewId = randomUUID();
    const settlementId = context.settlementId ?? `${context.quizId}:${id}:${context.submissionId}:${context.revision}`;
    const update = this.db.run(
      `UPDATE page_learning
       SET due_at = ?, fsrs_state = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, scheduled_days = ?, last_review_at = ?, revision = revision + 1, updated_at = ?
       WHERE page_id = ? AND revision = ?`,
      after.due.toISOString(),
      stateNumber(parseState(after.state)),
      after.stability,
      after.difficulty,
      after.reps,
      after.lapses,
      after.scheduled_days ?? 0,
      at.toISOString(),
      nowIso(),
      id,
      learning.revision,
    );
    requireRevision(update);
    this.db.run(
      `INSERT INTO page_reviews
        (review_id, page_id, quiz_id, submission_id, revision, rating, reviewed_at, state_before_json, state_after_json, settlement_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reviewId,
      id,
      context.quizId,
      context.submissionId,
      context.revision,
      rating,
      at.toISOString(),
      json(beforeSnapshot),
      json(afterSnapshot),
      settlementId,
    );
    return {
      reviewId,
      pageId: id,
      quizId: context.quizId,
      submissionId: context.submissionId,
      revision: context.revision,
      rating,
      reviewedAt: at.toISOString(),
      stateBefore: beforeSnapshot,
      stateAfter: afterSnapshot,
      settlementId,
    };
  }

  private toFsrsInput(learning: PageLearningRecord): FsrsCardInput {
    return {
      due: new Date(learning.dueAt),
      stability: learning.stability,
      difficulty: learning.difficulty,
      elapsed_days: 0,
      scheduled_days: learning.scheduledDays,
      learning_steps: 0,
      reps: learning.reps,
      lapses: learning.lapses,
      state: parseState(learning.fsrsState),
      last_review: learning.lastReviewAt ? new Date(learning.lastReviewAt) : undefined,
    };
  }

  private hasCycle(edges: Map<string, Set<string>>): boolean {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: string): boolean => {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const dependency of edges.get(node) ?? []) if (visit(dependency)) return true;
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    return [...edges.keys()].some(visit);
  }
}

export { FSRS_STATES, RATINGS };
