import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import type { VaultPaths } from "./vault.js";


export type SqlValue = string | number | bigint | boolean | Uint8Array | null;
export type SqlParameters = readonly unknown[] | Readonly<Record<string, SqlValue>>;
export type SqlRow = Readonly<Record<string, unknown>>;

export interface SqlRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface OpenDatabaseOptions {
  readonly readOnly?: boolean;
  readonly initializeSchema?: boolean;
}

export const SCHEMA_VERSION = 1 as const;
export const REQUIRED_TABLES = [
  "schema_meta",
  "sources",
  "source_files",
  "source_chunks",
  "source_dependencies",
  "pages",
  "wiki_issues",
  "authored_snapshots",
  "review_cards",
  "card_bindings",
  "card_prerequisites",
  "card_lineage",
  "raw_reviews",
  "quizzes",
  "quiz_questions",
  "question_cards",
  "quiz_answers",
  "question_results",
  "card_results",
  "workflows",
  "settings",
] as const;
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schema_meta: ["schema_version", "applied_at"],
  sources: ["source_id", "kind", "status", "display_name", "original_name", "source_uri", "media_type", "repository_revision", "captured_at", "digest", "manifest_path", "error_code", "error_message", "created_at", "updated_at"],
  source_files: ["source_id", "relative_path", "byte_length", "digest", "media_type"],
  source_chunks: ["chunk_id", "source_id", "ordinal", "relative_path", "byte_length", "digest", "atom_start", "atom_end"],
  source_dependencies: ["source_id", "page_id", "chunk_id", "relation"],
  pages: ["page_id", "relative_path", "title", "digest", "revision", "status", "quiz_worthiness", "created_at", "updated_at"],
  wiki_issues: ["issue_id", "page_id", "heading", "card_id", "page_digest", "kind", "description", "status", "resolution", "created_at", "updated_at"],
  authored_snapshots: ["relative_path", "digest", "revision", "captured_at", "commit_id"],
  review_cards: ["card_id", "status", "prompt", "initial_due_at", "due_at", "fsrs_state", "stability", "difficulty", "reps", "lapses", "scheduled_days", "last_review_at", "revision", "created_at", "updated_at"],
  card_bindings: ["binding_id", "card_id", "page_id", "heading", "anchor", "start_offset", "end_offset", "text_digest", "revision", "active"],
  card_prerequisites: ["card_id", "prerequisite_card_id", "created_at"],
  card_lineage: ["lineage_id", "event", "parent_card_id", "child_card_id", "occurred_at", "metadata_json"],
  raw_reviews: ["review_id", "card_id", "quiz_id", "question_id", "answer_revision", "rating", "reviewed_at", "state_before_json", "state_after_json", "settlement_id"],
  quizzes: ["quiz_id", "date", "revision", "status", "sheet_path", "generated_at", "submitted_at", "error_code", "error_message"],
  quiz_questions: ["question_id", "quiz_id", "ordinal", "kind", "prompt", "choices_json", "answer_key_json", "grading_criteria_json", "source_refs_json"],
  question_cards: ["question_id", "card_id", "criterion_json", "weight"],
  quiz_answers: ["quiz_id", "question_id", "revision", "answer_json", "saved_at"],
  question_results: ["result_id", "quiz_id", "question_id", "answer_revision", "feedback", "graded_at"],
  card_results: ["result_id", "quiz_id", "question_id", "card_id", "rating", "review_id"],
  workflows: ["request_id", "kind", "status", "started_at", "finished_at", "progress", "message", "error_code", "error_message", "idempotency_key"],
  settings: ["key", "value_json", "updated_at"],
};

const REQUIRED_SCHEMA_FRAGMENTS: Readonly<Record<string, readonly string[]>> = {
  source_chunks: ["unique (source_id, chunk_id)"],
  source_dependencies: ["check (page_id is not null or chunk_id is not null)", "foreign key (source_id, chunk_id) references source_chunks(source_id, chunk_id)"],
  card_lineage: ["check ((event = 'retire' and child_card_id is null) or (event <> 'retire' and child_card_id is not null))", "check (child_card_id is null or parent_card_id <> child_card_id)"],
  question_cards: ["criterion_json text not null", "weight real not null"],
};

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  schema_version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('document','url','text','note','code','directory','repository')),
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','processing','published','failed','removed')),
  display_name TEXT NOT NULL,
  original_name TEXT,
  source_uri TEXT,
  media_type TEXT,
  repository_revision TEXT,
  captured_at TEXT,
  digest TEXT,
  manifest_path TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  digest TEXT NOT NULL,
  media_type TEXT,
  PRIMARY KEY (source_id, relative_path)
);
CREATE TABLE IF NOT EXISTS source_chunks (
  chunk_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  relative_path TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  digest TEXT NOT NULL,
  atom_start INTEGER NOT NULL CHECK (atom_start >= 0),
  atom_end INTEGER NOT NULL CHECK (atom_end >= atom_start),
  UNIQUE (source_id, ordinal),
  UNIQUE (source_id, chunk_id)
);
CREATE TABLE IF NOT EXISTS source_dependencies (
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT,
  page_id TEXT REFERENCES pages(page_id) ON DELETE RESTRICT,
  chunk_id TEXT,
  relation TEXT NOT NULL CHECK (relation IN ('citation','claim','question')),
  CHECK (page_id IS NOT NULL OR chunk_id IS NOT NULL),
  FOREIGN KEY (source_id, chunk_id) REFERENCES source_chunks(source_id, chunk_id) ON DELETE RESTRICT,
  PRIMARY KEY (source_id, page_id, chunk_id, relation)
);

CREATE TABLE IF NOT EXISTS pages (
  page_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  digest TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('active','drifted','retired')),
  quiz_worthiness TEXT NOT NULL CHECK (quiz_worthiness IN ('eligible','skip','unknown')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wiki_issues (
  issue_id TEXT PRIMARY KEY,
  page_id TEXT REFERENCES pages(page_id) ON DELETE RESTRICT,
  heading TEXT,
  card_id TEXT REFERENCES review_cards(card_id) ON DELETE RESTRICT,
  page_digest TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('incorrect','unclear','missing','bad-boundary')),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved','reopened')),
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS authored_snapshots (
  relative_path TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  captured_at TEXT NOT NULL,
  commit_id TEXT
);

CREATE TABLE IF NOT EXISTS review_cards (
  card_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active','retired')),
  prompt TEXT,
  initial_due_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  fsrs_state INTEGER NOT NULL CHECK (fsrs_state BETWEEN 0 AND 3),
  stability REAL NOT NULL CHECK (stability >= 0),
  difficulty REAL NOT NULL CHECK (difficulty >= 0),
  reps INTEGER NOT NULL CHECK (reps >= 0),
  lapses INTEGER NOT NULL CHECK (lapses >= 0),
  scheduled_days INTEGER NOT NULL CHECK (scheduled_days >= 0),
  last_review_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_bindings (
  binding_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES review_cards(card_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(page_id) ON DELETE RESTRICT,
  heading TEXT,
  anchor TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  text_digest TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  UNIQUE (card_id, page_id, anchor, revision)
);

CREATE TABLE IF NOT EXISTS card_prerequisites (
  card_id TEXT NOT NULL REFERENCES review_cards(card_id) ON DELETE CASCADE,
  prerequisite_card_id TEXT NOT NULL REFERENCES review_cards(card_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, prerequisite_card_id),
  CHECK (card_id <> prerequisite_card_id)
);

CREATE TABLE IF NOT EXISTS card_lineage (
  lineage_id TEXT PRIMARY KEY,
  event TEXT NOT NULL CHECK (event IN ('split','merge','retire','successor')),
  parent_card_id TEXT NOT NULL REFERENCES review_cards(card_id) ON DELETE RESTRICT,
  child_card_id TEXT REFERENCES review_cards(card_id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT,
  CHECK ((event = 'retire' AND child_card_id IS NULL) OR (event <> 'retire' AND child_card_id IS NOT NULL)),
  CHECK (child_card_id IS NULL OR parent_card_id <> child_card_id),
  UNIQUE (lineage_id, parent_card_id, child_card_id)
);

CREATE TABLE IF NOT EXISTS raw_reviews (
  review_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES review_cards(card_id) ON DELETE RESTRICT,
  quiz_id TEXT NOT NULL REFERENCES quizzes(quiz_id) ON DELETE RESTRICT,
  question_id TEXT NOT NULL REFERENCES quiz_questions(question_id) ON DELETE RESTRICT,
  answer_revision INTEGER NOT NULL CHECK (answer_revision >= 0),
  rating TEXT NOT NULL CHECK (rating IN ('Again','Hard','Good','Easy')),
  reviewed_at TEXT NOT NULL,
  state_before_json TEXT NOT NULL,
  state_after_json TEXT NOT NULL,
  settlement_id TEXT NOT NULL,
  UNIQUE (quiz_id, question_id, card_id, answer_revision),
  UNIQUE (settlement_id, card_id)
);

CREATE TABLE IF NOT EXISTS quizzes (
  quiz_id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('open','submitted','expired','skipped','failed')),
  sheet_path TEXT,
  generated_at TEXT,
  submitted_at TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  question_id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(quiz_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('short-answer','multiple-choice')),
  prompt TEXT NOT NULL,
  choices_json TEXT,
  answer_key_json TEXT,
  grading_criteria_json TEXT,
  source_refs_json TEXT NOT NULL,
  UNIQUE (quiz_id, ordinal)
);

CREATE TABLE IF NOT EXISTS question_cards (
  question_id TEXT NOT NULL REFERENCES quiz_questions(question_id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES review_cards(card_id) ON DELETE RESTRICT,
  criterion_json TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight > 0),
  PRIMARY KEY (question_id, card_id)
);

CREATE TABLE IF NOT EXISTS quiz_answers (
  quiz_id TEXT NOT NULL REFERENCES quizzes(quiz_id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES quiz_questions(question_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  answer_json TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (quiz_id, question_id),
  UNIQUE (quiz_id, question_id, revision)
);

CREATE TABLE IF NOT EXISTS question_results (
  result_id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(quiz_id) ON DELETE RESTRICT,
  question_id TEXT NOT NULL REFERENCES quiz_questions(question_id) ON DELETE RESTRICT,
  answer_revision INTEGER NOT NULL CHECK (answer_revision >= 0),
  feedback TEXT NOT NULL,
  graded_at TEXT NOT NULL,
  UNIQUE (quiz_id, question_id, answer_revision)
);

CREATE TABLE IF NOT EXISTS card_results (
  result_id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(quiz_id) ON DELETE RESTRICT,
  question_id TEXT NOT NULL REFERENCES quiz_questions(question_id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES review_cards(card_id) ON DELETE RESTRICT,
  rating TEXT NOT NULL CHECK (rating IN ('Again','Hard','Good','Easy')),
  review_id TEXT NOT NULL REFERENCES raw_reviews(review_id) ON DELETE RESTRICT,
  UNIQUE (quiz_id, question_id, card_id),
  UNIQUE (review_id)
);

CREATE TABLE IF NOT EXISTS workflows (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('source-admission','wiki-maintenance','daily-quiz','quiz-grader','sync')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  started_at TEXT,
  finished_at TEXT,
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  message TEXT,
  error_code TEXT,
  error_message TEXT,
  idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function bind(statement: object, parameters: SqlParameters | undefined, method: "run" | "get" | "all"): unknown {
  const execute = Reflect.get(statement, method);
  if (typeof execute !== "function") throw new Error(`SQLite statement does not support ${method}`);
  const values = parameters === undefined ? [] : Array.isArray(parameters) ? [...parameters] : [parameters];
  return Reflect.apply(execute, statement, values);
}

export class ScholarDatabase {
  readonly path: string;
  readonly #database: DatabaseSync;
  #transactionDepth = 0;

  constructor(path: string, database: DatabaseSync) {
    this.path = path;
    this.#database = database;
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  run(sql: string, parameters?: SqlParameters): SqlRunResult {
    const result = bind(this.#database.prepare(sql), parameters, "run") as { changes: number | bigint; lastInsertRowid: number | bigint };
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }
  get<T = SqlRow>(sql: string, parameters?: SqlParameters): T | undefined {
    return bind(this.#database.prepare(sql), parameters, "get") as T | undefined;
  }

  all<T = SqlRow>(sql: string, parameters?: SqlParameters): T[] {
    return bind(this.#database.prepare(sql), parameters, "all") as T[];
  }

  checkpoint(): void {
    this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  integrityCheck(): string[] {
    return this.all<{ integrity_check: string }>("PRAGMA integrity_check").map((row) => row.integrity_check);
  }

  tableNames(): string[] {
    return this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
  }

  close(): void {
    this.#database.close();
  }

  get transactionDepth(): number {
    return this.#transactionDepth;
  }

  _beginTransaction(): string | undefined {
    if (this.#transactionDepth === 0) {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#transactionDepth = 1;
      return undefined;
    }
    const savepoint = `scholar_sp_${this.#transactionDepth}`;
    this.#database.exec(`SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    return savepoint;
  }

  _commitTransaction(savepoint: string | undefined): void {
    if (savepoint) {
      this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      this.#transactionDepth -= 1;
      return;
    }
    this.#database.exec("COMMIT");
    this.#transactionDepth = 0;
  }

  _rollbackTransaction(savepoint: string | undefined): void {
    if (savepoint) {
      this.#database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      this.#transactionDepth -= 1;
      return;
    }
    this.#database.exec("ROLLBACK");
    this.#transactionDepth = 0;
  }
}

function normalizedSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/gu, " ").trim();
}

export function validateSchema(db: ScholarDatabase): void {
  const current = Number(db.get<{ user_version: number | bigint }>("PRAGMA user_version")?.user_version ?? 0);
  if (current !== SCHEMA_VERSION) throw new Error(`Unsupported Pi Scholar database schema version: ${current}`);
  const existing = db.tableNames().filter((table) => table !== "sqlite_sequence");
  const required = Object.fromEntries(REQUIRED_TABLES.map((table) => [table, true])) as Record<string, true>;
  const unknown = existing.filter((table) => !required[table]);
  if (unknown.length) throw new Error(`Pi Scholar database has unknown tables: ${unknown.join(", ")}`);
  const missing = REQUIRED_TABLES.filter((table) => !existing.includes(table));
  if (missing.length) throw new Error(`Pi Scholar database schema is missing tables: ${missing.join(", ")}`);
  const metadata = db.all<{ schema_version: number | bigint }>("SELECT schema_version FROM schema_meta");
  if (metadata.length !== 1 || Number(metadata[0]?.schema_version) !== SCHEMA_VERSION) throw new Error("Pi Scholar database schema_meta does not match the schema version");
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = new Set(db.all<{ name: string }>(`PRAGMA table_info('${table}')`).map((row) => row.name));
    const missingColumns = columns.filter((column) => !actual.has(column));
    if (missingColumns.length) throw new Error(`Pi Scholar database table ${table} is missing columns: ${missingColumns.join(", ")}`);
  }
  for (const [table, fragments] of Object.entries(REQUIRED_SCHEMA_FRAGMENTS)) {
    const definition = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])?.sql;
    const normalized = normalizedSql(definition ?? "");
    const missingFragments = fragments.filter((fragment) => !normalized.includes(normalizedSql(fragment)));
    if (missingFragments.length) throw new Error(`Pi Scholar database table ${table} is missing constraints: ${missingFragments.join("; ")}`);
  }
}

function ensureSchema(db: ScholarDatabase): void {
  const current = Number(db.get<{ user_version: number | bigint }>("PRAGMA user_version")?.user_version ?? 0);
  const existing = db.tableNames().filter((table) => table !== "sqlite_sequence");
  if (current !== 0 && current !== SCHEMA_VERSION) {
    throw new Error(`Unsupported Pi Scholar database schema version: ${current}`);
  }
  if (current === SCHEMA_VERSION) {
    validateSchema(db);
    return;
  }
  if (existing.length > 0) throw new Error("Pi Scholar database has an unknown unversioned schema");
  db.exec(SCHEMA_SQL);
  db.run("INSERT INTO schema_meta (schema_version, applied_at) VALUES (?, ?)", [SCHEMA_VERSION, new Date().toISOString()]);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  validateSchema(db);
}

export function openDatabase(input: string | VaultPaths, options: OpenDatabaseOptions = {}): ScholarDatabase {
  const readOnly = options.readOnly ?? false;
  const path = typeof input === "string" ? input : input.databasePath;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Pi Scholar database path must be a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const database = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true });
  const db = new ScholarDatabase(path, database);
  if (!readOnly) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  if (options.initializeSchema ?? !readOnly) ensureSchema(db);
  return db;
}

export function transaction<T>(db: ScholarDatabase, operation: () => T): T {
  const savepoint = db._beginTransaction();
  try {
    const value = operation();
    db._commitTransaction(savepoint);
    return value;
  } catch (error) {
    try {
      db._rollbackTransaction(savepoint);
    } catch {
      // Preserve the operation's error; the connection remains unusable for writes.
    }
    throw error;
  }
}
