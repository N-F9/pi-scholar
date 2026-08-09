import { randomUUID } from "node:crypto";
import type { DateInput, CardInput as FsrsCardInput, Grade } from "ts-fsrs";
import { fsrs, Rating } from "ts-fsrs";
import type {
  CardBindingRecord,
  CardLineageRecord,
  CardPrerequisiteRecord,
  CardRating,
  FsrsState,
  RawReviewRecord,
  ReviewCardRecord,
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

export interface CardBindingInput {
  readonly pageId: string;
  readonly heading?: string;
  readonly anchor: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly start?: number;
  readonly end?: number;
  readonly textDigest: string;
  readonly pageDigest: string;
  readonly pageRevision: number;
  readonly sectionText: string;
}

export interface NormalizedBinding {
  readonly pageId: string;
  readonly heading?: string;
  readonly anchor: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly textDigest: string;
}

export interface CreateReviewCardInput {
  readonly cardId?: string;
  readonly prompt?: string;
  readonly topic?: string;
  readonly initialDueAt?: string | Date;
  readonly dueAt?: string | Date;
  readonly bindings: readonly CardBindingInput[];
}
export interface UpdateReviewCardInput {
  readonly prompt?: string;
  readonly status?: "active" | "retired";
  readonly bindings?: readonly CardBindingInput[];
  readonly expectedRevision?: number;
}

export interface CardRevisionInput {
  readonly bindings: readonly CardBindingInput[];
  readonly prompt?: string;
  readonly expectedRevision?: number;
}

export interface SplitCardInput {
  readonly cardId?: string;
  readonly prompt?: string;
  readonly bindings: readonly CardBindingInput[];
  readonly expectedRevision?: number;
}

export interface MergeCardInput {
  readonly cardId?: string;
  readonly prompt?: string;
  readonly bindings: readonly CardBindingInput[];
  readonly expectedRevisions?: Readonly<Record<string, number>>;
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
  readonly cardId: string;
  readonly prerequisites: readonly string[];
}

export interface HistoricalReview extends RawReviewRecord {
  readonly originCardId: string;
}

export class RevisionConflictError extends Error {
  readonly code = "revision-conflict";
  constructor(message = "The card revision is stale") {
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

const CARD_STATES: readonly FsrsState[] = ["New", "Learning", "Review", "Relearning"];
const RATINGS: readonly CardRating[] = ["Again", "Hard", "Good", "Easy"];

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

export function localDate(value: string | Date): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
    throw new ValidationError("date must be a valid calendar date");
  }
  const date = asDate(value, "date");
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const SEALED_QUIZ_REVIEW = Symbol("sealed-quiz-review");

export interface ReviewTransitionContext {
  readonly quizId: string;
  readonly questionId: string;
  readonly answerRevision: number;
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

function fsrsSnapshot(card: {
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
  const state = typeof card.state === "number" ? card.state : stateNumber(parseState(card.state));
  return {
    due: new Date(card.due).toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduled_days: card.scheduled_days ?? 0,
    learning_steps: card.learning_steps ?? 0,
    reps: card.reps,
    lapses: card.lapses,
    state,
    last_review:
      card.last_review === undefined || card.last_review === null ? null : new Date(card.last_review).toISOString(),
  };
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
function stateNumber(value: FsrsState | number): number {
  if (typeof value === "number") return value;
  return CARD_STATES.indexOf(value);
}

function ratingValue(value: CardRating): Grade {
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

function bindingInput(input: CardBindingInput): NormalizedBinding {
  const pageId = input.pageId?.trim();
  const anchor = input.anchor?.trim();
  const digest = input.textDigest?.trim();
  const startOffset = input.startOffset ?? input.start;
  const endOffset = input.endOffset ?? input.end;
  if (!pageId || !anchor || !digest) throw new ValidationError("Bindings require pageId, anchor, and textDigest");
  if (
    startOffset === undefined ||
    endOffset === undefined ||
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset
  ) {
    throw new ValidationError("Binding offsets must be nonnegative integers with endOffset > startOffset");
  }
  if (digest.length > 512) throw new ValidationError("Binding digest is too long");
  return { pageId, anchor, heading: input.heading?.trim() || undefined, startOffset, endOffset, textDigest: digest };
}
function parseState(value: unknown): FsrsState {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < CARD_STATES.length) {
    return CARD_STATES[value] as FsrsState;
  }
  const text = String(value ?? "");
  if (CARD_STATES.includes(text as FsrsState)) return text as FsrsState;
  const numeric = Number(text);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < CARD_STATES.length) {
    return CARD_STATES[numeric] as FsrsState;
  }
  return "New";
}

function mapCard(row: Record<string, unknown>): ReviewCardRecord {
  const state = parseState(row.fsrs_state);
  const createdAt = isoOrUndefined(row.created_at) ?? nowIso();
  const updatedAt = isoOrUndefined(row.updated_at) ?? createdAt;
  const dueAt = isoOrUndefined(row.due_at) ?? nowIso();
  return {
    cardId: String(row.card_id),
    status: row.status === "retired" ? "retired" : "active",
    prompt: row.prompt === null || row.prompt === undefined ? undefined : String(row.prompt),
    initialDueAt: isoOrUndefined(row.initial_due_at) ?? dueAt,
    dueAt,
    fsrsState: state,
    stability: Number(row.stability ?? 0),
    difficulty: Number(row.difficulty ?? 0),
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
    scheduledDays: Number(row.scheduled_days ?? 0),
    lastReviewAt: isoOrUndefined(row.last_review_at),
    revision: Number(row.revision ?? 1),
    createdAt,
    updatedAt,
  };
}

function mapBinding(row: Record<string, unknown>): CardBindingRecord {
  return {
    bindingId: String(row.binding_id),
    cardId: String(row.card_id),
    pageId: String(row.page_id),
    heading: row.heading === null || row.heading === undefined ? undefined : String(row.heading),
    anchor: String(row.anchor),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    textDigest: String(row.text_digest),
    revision: Number(row.revision ?? 1),
    active: Number(row.active ?? 1) === 1,
  };
}

function mapLineage(row: Record<string, unknown>): CardLineageRecord {
  return {
    lineageId: String(row.lineage_id),
    event: String(row.event) as CardLineageRecord["event"],
    parentCardIds: [String(row.parent_card_id)],
    childCardIds: row.child_card_id === null || row.child_card_id === undefined ? [] : [String(row.child_card_id)],
    occurredAt: isoOrUndefined(row.occurred_at) ?? nowIso(),
    metadata: parseJson(row.metadata_json, undefined),
  };
}

export class SchedulerService {
  readonly db: SqlDatabase;
  readonly paths?: VaultPathsLike;
  private readonly source: SqlDatabaseSource;
  private readonly engine = fsrs();

  constructor(source: SqlDatabaseSource, paths?: VaultPathsLike) {
    this.source = source;
    this.db = adaptDatabase(source);
    this.paths = paths;
  }

  getCard(cardId: string): ReviewCardRecord {
    const row = this.db.get<Record<string, unknown>>("SELECT * FROM review_cards WHERE card_id = ?", cardId);
    if (!row) throw new ValidationError(`Unknown review card: ${cardId}`);
    return mapCard(row);
  }

  listCards(activeOnly = false): ReviewCardRecord[] {
    const rows = this.db.all<Record<string, unknown>>(
      activeOnly
        ? "SELECT * FROM review_cards WHERE status = 'active' ORDER BY due_at, card_id"
        : "SELECT * FROM review_cards ORDER BY created_at, card_id",
    );
    return rows.map(mapCard);
  }

  bindings(cardId: string, activeOnly = true): CardBindingRecord[] {
    const sql = activeOnly
      ? "SELECT * FROM card_bindings WHERE card_id = ? AND active = 1 ORDER BY binding_id"
      : "SELECT * FROM card_bindings WHERE card_id = ? ORDER BY revision, binding_id";
    return this.db.all<Record<string, unknown>>(sql, cardId).map(mapBinding);
  }

  prerequisites(cardId: string): CardPrerequisiteRecord[] {
    return this.db
      .all<Record<string, unknown>>(
        "SELECT card_id, prerequisite_card_id FROM card_prerequisites WHERE card_id = ? ORDER BY prerequisite_card_id",
        cardId,
      )
      .map((row) => ({ cardId: String(row.card_id), prerequisiteCardId: String(row.prerequisite_card_id) }));
  }

  private validateBindings(inputs: readonly CardBindingInput[]): NormalizedBinding[] {
    const bindings = inputs.map(bindingInput);
    for (const [index, binding] of bindings.entries()) {
      const input = inputs[index];
      if (!input) throw new ValidationError("Binding input is missing");
      const pageDigest = String(input.pageDigest ?? "").trim();
      const sectionText = String(input.sectionText ?? "");
      if (!pageDigest || pageDigest.length > 512 || !Number.isInteger(input.pageRevision) || input.pageRevision < 1) {
        throw new ValidationError("Bindings require a current page digest and revision");
      }
      if (!sectionText.trim() || binding.endOffset > sectionText.length) {
        throw new ValidationError("Binding section text must be nonempty and contain the binding bounds");
      }
      const page = this.db.get<Record<string, unknown>>(
        "SELECT status, quiz_worthiness, digest, revision FROM pages WHERE page_id = ?",
        binding.pageId,
      );
      if (page?.status !== "active" || page.quiz_worthiness !== "eligible") {
        throw new ValidationError(`Binding references an unavailable page: ${binding.pageId}`);
      }
      if (String(page.digest) !== pageDigest)
        throw new ValidationError(`Binding page digest is stale: ${binding.pageId}`);
      if (Number(page.revision) !== input.pageRevision)
        throw new ValidationError(`Binding page revision is stale: ${binding.pageId}`);
    }
    return bindings;
  }
  createCard(input: CreateReviewCardInput): ReviewCardRecord {
    const due = asDate(input.initialDueAt ?? input.dueAt, "initialDueAt");
    const bindings = this.validateBindings(input.bindings);
    if (!bindings.length) throw new ValidationError("A review card requires at least one binding");
    const cardId = input.cardId?.trim() || randomUUID();
    const now = nowIso();
    transaction(this.source, () => {
      if (this.db.get("SELECT card_id FROM review_cards WHERE card_id = ?", cardId))
        throw new ValidationError(`Duplicate review card: ${cardId}`);
      this.db.run(
        `INSERT INTO review_cards
          (card_id, status, prompt, initial_due_at, due_at, fsrs_state, stability, difficulty, reps, lapses, scheduled_days, last_review_at, revision, created_at, updated_at)
         VALUES (?, 'active', ?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, 1, ?, ?)`,
        cardId,
        input.prompt?.trim() || null,
        due.toISOString(),
        due.toISOString(),
        now,
        now,
      );
      this.insertBindings(cardId, 1, bindings);
    });
    return this.getCard(cardId);
  }

  updateCard(cardId: string, input: UpdateReviewCardInput): ReviewCardRecord {
    const current = this.getCard(cardId);
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision)
      throw new RevisionConflictError();
    if (input.bindings)
      return this.reviseCard(cardId, {
        bindings: input.bindings,
        prompt: input.prompt,
        expectedRevision: input.expectedRevision,
      });
    if (input.status !== undefined && input.status !== "active" && input.status !== "retired")
      throw new ValidationError("Invalid card status");
    const prompt = input.prompt === undefined ? (current.prompt ?? null) : input.prompt.trim() || null;
    transaction(this.source, () => {
      const result = this.db.run(
        "UPDATE review_cards SET prompt = ?, status = COALESCE(?, status), revision = revision + 1, updated_at = ? WHERE card_id = ? AND revision = ?",
        prompt,
        input.status ?? null,
        nowIso(),
        cardId,
        current.revision,
      );
      requireRevision(result);
      if (input.status === "retired") {
        this.db.run("DELETE FROM card_prerequisites WHERE card_id = ? OR prerequisite_card_id = ?", cardId, cardId);
        this.recordLineage("retire", [cardId], [], undefined);
      }
    });
    return this.getCard(cardId);
  }

  reviseCard(cardId: string, input: CardRevisionInput): ReviewCardRecord {
    const current = this.getCard(cardId);
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision)
      throw new RevisionConflictError();
    const bindings = this.validateBindings(input.bindings);
    if (!bindings.length) throw new ValidationError("A review card requires at least one binding");
    transaction(this.source, () => {
      const nextRevision = current.revision + 1;
      const result = this.db.run(
        "UPDATE review_cards SET prompt = ?, revision = ?, updated_at = ? WHERE card_id = ? AND revision = ?",
        input.prompt?.trim() ?? current.prompt ?? null,
        nextRevision,
        nowIso(),
        cardId,
        current.revision,
      );
      requireRevision(result);
      this.db.run("UPDATE card_bindings SET active = 0 WHERE card_id = ? AND active = 1", cardId);
      this.insertBindings(cardId, nextRevision, bindings);
    });
    return this.getCard(cardId);
  }

  retireCard(cardId: string, expectedRevision?: number): ReviewCardRecord {
    const card = this.getCard(cardId);
    if (expectedRevision !== undefined && expectedRevision !== card.revision) throw new RevisionConflictError();
    if (card.status === "retired") return card;
    const revision = expectedRevision ?? card.revision;
    transaction(this.source, () => {
      const result = this.db.run(
        "UPDATE review_cards SET status = 'retired', updated_at = ? WHERE card_id = ? AND status = 'active' AND revision = ?",
        nowIso(),
        cardId,
        revision,
      );
      requireRevision(result);
      this.db.run("DELETE FROM card_prerequisites WHERE card_id = ? OR prerequisite_card_id = ?", cardId, cardId);
      this.recordLineage("retire", [cardId], [], undefined);
    });
    return this.getCard(cardId);
  }

  splitCard(cardId: string, children: readonly SplitCardInput[]): readonly ReviewCardRecord[] {
    const parent = this.getCard(cardId);
    if (parent.status !== "active") throw new ValidationError("Only an active card can be split");
    if (children.length < 2) throw new ValidationError("A split requires at least two child cards");
    const expectedRevision =
      children.find((child) => child.expectedRevision !== undefined)?.expectedRevision ?? parent.revision;
    if (
      expectedRevision !== parent.revision ||
      children.some((child) => child.expectedRevision !== undefined && child.expectedRevision !== expectedRevision)
    ) {
      throw new RevisionConflictError();
    }
    const normalized = children.map((child) => {
      const bindings = this.validateBindings(child.bindings);
      if (!bindings.length) throw new ValidationError("Split child requires at least one binding");
      return { id: child.cardId?.trim() || randomUUID(), prompt: child.prompt, bindings };
    });
    if (new Set(normalized.map((child) => child.id)).size !== normalized.length)
      throw new ValidationError("Split child IDs must be distinct");
    if (normalized.some((child) => this.db.get("SELECT card_id FROM review_cards WHERE card_id = ?", child.id)))
      throw new ValidationError("Split child ID already exists");
    const now = new Date();
    transaction(this.source, () => {
      this.retireWithinTransaction(cardId, expectedRevision);
      for (const child of normalized) {
        this.insertFreshCard(child.id, child.prompt, now, child.bindings);
      }
      const childIds = normalized.map((child) => child.id);
      this.recordLineage("split", [cardId], childIds, undefined);
      this.rewritePrerequisitesForSplit(cardId, childIds);
    });
    return normalized.map((child) => this.getCard(child.id));
  }
  mergeCards(parentCardIds: readonly string[], input: MergeCardInput): ReviewCardRecord {
    const ids = [...new Set(parentCardIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length < 2) throw new ValidationError("A merge requires at least two parent cards");
    const parents = ids.map((id) => this.getCard(id));
    if (parents.some((card) => card.status !== "active")) throw new ValidationError("Only active cards can be merged");
    const bindings = this.validateBindings(input.bindings);
    if (!bindings.length) throw new ValidationError("Merged card requires at least one binding");
    const cardId = input.cardId?.trim() || randomUUID();
    if (this.db.get("SELECT card_id FROM review_cards WHERE card_id = ?", cardId))
      throw new ValidationError(`Duplicate review card: ${cardId}`);
    const now = new Date();
    transaction(this.source, () => {
      for (const parent of parents)
        this.retireWithinTransaction(parent.cardId, input.expectedRevisions?.[parent.cardId] ?? parent.revision);
      this.insertFreshCard(cardId, input.prompt, now, bindings);
      this.recordLineage("merge", ids, [cardId], undefined);
      this.rewritePrerequisitesForMerge(ids, cardId);
    });
    return this.getCard(cardId);
  }

  setPrerequisites(
    cardId: string,
    prerequisiteCardIds: readonly string[],
    expectedRevision?: number,
  ): PrerequisiteResult {
    const card = this.getCard(cardId);
    if (card.status !== "active") throw new ValidationError("Retired cards cannot receive prerequisites");
    if (expectedRevision !== undefined && expectedRevision !== card.revision) throw new RevisionConflictError();
    const ids = [...new Set(prerequisiteCardIds.map((id) => id.trim()))];
    if (ids.some((id) => !id)) throw new ValidationError("Prerequisite IDs must be nonempty");
    if (ids.includes(cardId)) throw new ValidationError("A card cannot prerequisite itself");
    const cards = this.listCards(false);
    const known = new Set(cards.filter((entry) => entry.status === "active").map((entry) => entry.cardId));
    if (ids.some((id) => !known.has(id)))
      throw new ValidationError("Prerequisite references an unknown or retired card");
    const edges = new Map<string, Set<string>>();
    for (const entry of cards)
      edges.set(entry.cardId, new Set(this.prerequisites(entry.cardId).map((edge) => edge.prerequisiteCardId)));
    edges.set(cardId, new Set(ids));
    if (this.hasCycle(edges)) throw new ValidationError("Prerequisite graph contains a cycle");
    const revision = expectedRevision ?? card.revision;
    transaction(this.source, () => {
      const current = this.db.get<Record<string, unknown>>(
        "SELECT revision, status FROM review_cards WHERE card_id = ?",
        cardId,
      );
      if (current?.status !== "active" || Number(current.revision) !== revision) throw new RevisionConflictError();
      this.db.run("DELETE FROM card_prerequisites WHERE card_id = ?", cardId);
      for (const prerequisiteCardId of ids)
        this.db.run(
          "INSERT INTO card_prerequisites (card_id, prerequisite_card_id, created_at) VALUES (?, ?, ?)",
          cardId,
          prerequisiteCardId,
          nowIso(),
        );
    });
    return { cardId, prerequisites: ids };
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
      this.db
        .all<{ page_id: string }>(
          "SELECT DISTINCT b.page_id FROM card_bindings b JOIN review_cards c ON c.card_id = b.card_id WHERE b.active = 1 AND c.status = 'active'",
        )
        .map((row) => String(row.page_id)),
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

  eligibleCards(date: string | Date): ReviewCardRecord[] {
    const day = localDate(date);
    const cards = this.listCards(true).filter((card) => localDate(card.dueAt) <= day);
    return cards.filter((card) => {
      const binding = this.db.get(
        "SELECT b.binding_id FROM card_bindings b JOIN pages p ON p.page_id = b.page_id WHERE b.card_id = ? AND b.revision = ? AND b.active = 1 AND p.status = 'active' AND p.quiz_worthiness = 'eligible'",
        card.cardId,
        card.revision,
      );
      if (!binding) return false;
      return this.prerequisites(card.cardId).every((edge) => {
        const prerequisite = this.getCard(edge.prerequisiteCardId);
        return prerequisite.status === "active" && prerequisite.fsrsState === "Review";
      });
    });
  }

  selectDueCards(date: string | Date): ReviewCardRecord[] {
    const cards = this.eligibleCards(date);
    const byTopic = new Map<string, ReviewCardRecord[]>();
    for (const card of cards) {
      const topic = this.bindings(card.cardId)[0]?.pageId ?? "";
      const queue = byTopic.get(topic) ?? [];
      queue.push(card);
      byTopic.set(topic, queue);
    }
    for (const queue of byTopic.values())
      queue.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.cardId.localeCompare(b.cardId));
    const topics = [...byTopic.keys()].sort();
    const selected: ReviewCardRecord[] = [];
    while (selected.length < 4 && topics.some((topic) => (byTopic.get(topic)?.length ?? 0) > 0)) {
      for (const topic of topics) {
        const card = byTopic.get(topic)?.shift();
        if (card) selected.push(card);
        if (selected.length === 4) break;
      }
    }
    return selected;
  }

  historicalReviews(cardId: string): HistoricalReview[] {
    this.getCard(cardId);
    const ancestors = this.ancestorIds(cardId);
    const placeholders = ancestors.map(() => "?").join(",");
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM raw_reviews WHERE card_id IN (${placeholders}) ORDER BY reviewed_at, review_id`,
      ...ancestors,
    );
    return rows.map((row) => ({
      reviewId: String(row.review_id),
      cardId: String(row.card_id),
      originCardId: String(row.card_id),
      quizId: String(row.quiz_id),
      questionId: String(row.question_id),
      answerRevision: Number(row.answer_revision),
      rating: String(row.rating) as CardRating,
      reviewedAt: isoOrUndefined(row.reviewed_at) ?? nowIso(),
      stateBefore: parseJson(row.state_before_json, null),
      stateAfter: parseJson(row.state_after_json, null),
      settlementId: String(row.settlement_id),
    }));
  }

  lineage(cardId?: string): CardLineageRecord[] {
    const rows = cardId
      ? this.db.all<Record<string, unknown>>(
          "SELECT * FROM card_lineage WHERE parent_card_id = ? OR child_card_id = ? ORDER BY occurred_at, lineage_id",
          cardId,
          cardId,
        )
      : this.db.all<Record<string, unknown>>("SELECT * FROM card_lineage ORDER BY occurred_at, lineage_id");
    return rows.map(mapLineage);
  }

  /** Apply one independent FSRS transition. Call inside a caller transaction for atomic grading. */
  transitionCard(
    cardId: string,
    rating: CardRating,
    reviewedAt: string | Date,
    context: ReviewTransitionContext,
  ): RawReviewRecord {
    return transaction(this.source, () => this.transitionCardInTransaction(cardId, rating, reviewedAt, context));
  }

  transitionCardInTransaction(
    cardId: string,
    rating: CardRating,
    reviewedAt: string | Date,
    context: ReviewTransitionContext,
  ): RawReviewRecord {
    const card = this.getCard(cardId);
    if (card.status !== "active" && context.authorization !== SEALED_QUIZ_REVIEW)
      throw new ValidationError("Retired cards cannot be reviewed");
    const at = asDate(reviewedAt, "reviewedAt");
    const before = this.toFsrsCard(card);
    const result = this.engine.next(before, at, ratingValue(rating));
    const after = result.card;
    const beforeSnapshot = fsrsSnapshot(before);
    const afterSnapshot = fsrsSnapshot(after);
    const reviewId = randomUUID();
    this.db.run(
      `UPDATE review_cards SET due_at = ?, fsrs_state = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, scheduled_days = ?, last_review_at = ?, updated_at = ? WHERE card_id = ?`,
      after.due.toISOString(),
      stateNumber(parseState(after.state)),
      after.stability,
      after.difficulty,
      after.reps,
      after.lapses,
      after.scheduled_days ?? 0,
      at.toISOString(),
      nowIso(),
      cardId,
    );
    this.db.run(
      `INSERT INTO raw_reviews (review_id, card_id, quiz_id, question_id, answer_revision, rating, reviewed_at, state_before_json, state_after_json, settlement_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reviewId,
      cardId,
      context.quizId,
      context.questionId,
      context.answerRevision,
      rating,
      at.toISOString(),
      json(beforeSnapshot),
      json(afterSnapshot),
      context.settlementId ?? `${context.quizId}:${context.questionId}:${cardId}:${context.answerRevision}`,
    );
    return {
      reviewId,
      cardId,
      quizId: context.quizId,
      questionId: context.questionId,
      answerRevision: context.answerRevision,
      rating,
      reviewedAt: at.toISOString(),
      stateBefore: beforeSnapshot,
      stateAfter: afterSnapshot,
      settlementId:
        context.settlementId ?? `${context.quizId}:${context.questionId}:${cardId}:${context.answerRevision}`,
    };
  }

  private toFsrsCard(card: ReviewCardRecord): FsrsCardInput {
    return {
      due: new Date(card.dueAt),
      stability: card.stability,
      difficulty: card.difficulty,
      elapsed_days: 0,
      scheduled_days: card.scheduledDays,
      learning_steps: 0,
      reps: card.reps,
      lapses: card.lapses,
      state: parseState(card.fsrsState),
      last_review: card.lastReviewAt ? new Date(card.lastReviewAt) : undefined,
    };
  }

  private insertBindings(cardId: string, revision: number, bindings: readonly NormalizedBinding[]): void {
    for (const binding of bindings) {
      this.db.run(
        `INSERT INTO card_bindings (binding_id, card_id, page_id, heading, anchor, start_offset, end_offset, text_digest, revision, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        randomUUID(),
        cardId,
        binding.pageId,
        binding.heading ?? null,
        binding.anchor,
        binding.startOffset,
        binding.endOffset,
        binding.textDigest,
        revision,
      );
    }
  }

  private insertFreshCard(
    cardId: string,
    prompt: string | undefined,
    due: Date,
    bindings: readonly NormalizedBinding[],
  ): void {
    const iso = nowIso();
    this.db.run(
      `INSERT INTO review_cards
        (card_id, status, prompt, initial_due_at, due_at, fsrs_state, stability, difficulty, reps, lapses, scheduled_days, last_review_at, revision, created_at, updated_at)
       VALUES (?, 'active', ?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, 1, ?, ?)`,
      cardId,
      prompt?.trim() || null,
      due.toISOString(),
      due.toISOString(),
      iso,
      iso,
    );
    this.insertBindings(cardId, 1, bindings);
  }

  private retireWithinTransaction(cardId: string, expectedRevision: number): void {
    const result = this.db.run(
      "UPDATE review_cards SET status = 'retired', updated_at = ? WHERE card_id = ? AND status = 'active' AND revision = ?",
      nowIso(),
      cardId,
      expectedRevision,
    );
    requireRevision(result);
    this.recordLineage("retire", [cardId], [], undefined);
  }

  private recordLineage(
    event: CardLineageRecord["event"],
    parentCardIds: readonly string[],
    childCardIds: readonly string[],
    metadata: unknown,
  ): void {
    if (!childCardIds.length && event !== "retire") throw new ValidationError(`${event} lineage requires child cards`);
    const children: readonly (string | null)[] = childCardIds.length ? childCardIds : [null];
    for (const parentCardId of parentCardIds) {
      for (const childCardId of children) {
        this.db.run(
          "INSERT INTO card_lineage (lineage_id, event, parent_card_id, child_card_id, occurred_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
          randomUUID(),
          event,
          parentCardId,
          childCardId,
          nowIso(),
          metadata === undefined ? null : json(metadata),
        );
      }
    }
  }

  private rewritePrerequisitesForSplit(parentId: string, childIds: readonly string[]): void {
    const incoming = this.db.all<{ card_id: string }>(
      "SELECT card_id FROM card_prerequisites WHERE prerequisite_card_id = ?",
      parentId,
    );
    const outgoing = this.db.all<{ prerequisite_card_id: string }>(
      "SELECT prerequisite_card_id FROM card_prerequisites WHERE card_id = ?",
      parentId,
    );
    this.db.run("DELETE FROM card_prerequisites WHERE card_id = ? OR prerequisite_card_id = ?", parentId, parentId);
    for (const childId of childIds)
      for (const row of outgoing)
        this.db.run(
          "INSERT INTO card_prerequisites (card_id, prerequisite_card_id, created_at) VALUES (?, ?, ?)",
          childId,
          row.prerequisite_card_id,
          nowIso(),
        );
    for (const row of incoming)
      for (const childId of childIds)
        this.db.run(
          "INSERT INTO card_prerequisites (card_id, prerequisite_card_id, created_at) VALUES (?, ?, ?)",
          row.card_id,
          childId,
          nowIso(),
        );
  }

  private rewritePrerequisitesForMerge(parentIds: readonly string[], mergedId: string): void {
    const placeholders = parentIds.map(() => "?").join(",");
    const outgoing = this.db.all<{ prerequisite_card_id: string }>(
      `SELECT prerequisite_card_id FROM card_prerequisites WHERE card_id IN (${placeholders})`,
      ...parentIds,
    );
    const incoming = this.db.all<{ card_id: string }>(
      `SELECT card_id FROM card_prerequisites WHERE prerequisite_card_id IN (${placeholders})`,
      ...parentIds,
    );
    this.db.run(
      `DELETE FROM card_prerequisites WHERE card_id IN (${placeholders}) OR prerequisite_card_id IN (${placeholders})`,
      ...parentIds,
      ...parentIds,
    );
    const outgoingIds = [
      ...new Set(outgoing.map((row) => row.prerequisite_card_id).filter((id) => !parentIds.includes(id))),
    ];
    for (const prerequisiteCardId of outgoingIds)
      this.db.run(
        "INSERT INTO card_prerequisites (card_id, prerequisite_card_id, created_at) VALUES (?, ?, ?)",
        mergedId,
        prerequisiteCardId,
        nowIso(),
      );
    for (const cardId of [...new Set(incoming.map((row) => row.card_id).filter((id) => !parentIds.includes(id)))])
      this.db.run(
        "INSERT INTO card_prerequisites (card_id, prerequisite_card_id, created_at) VALUES (?, ?, ?)",
        cardId,
        mergedId,
        nowIso(),
      );
  }

  private ancestorIds(cardId: string): string[] {
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const rows = this.db.all<Record<string, unknown>>(
        "SELECT parent_card_id FROM card_lineage WHERE child_card_id = ?",
        id,
      );
      for (const row of rows) visit(String(row.parent_card_id));
    };
    visit(cardId);
    return [...seen];
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

export { CARD_STATES, RATINGS };
