import { lstatSync } from "node:fs";
import type { VaultPaths } from "./vault.js";

interface DatabaseHandle {
  exec(sql: string): unknown;
  prepare(sql: string): object;
  close(): void;
}

type DatabaseConstructor = new (path: string, options: Record<string, unknown>) => DatabaseHandle;

// Node and Bun expose different built-in SQLite modules, so this import is runtime-selected.
const runningOnBun = "bun" in process.versions;
const sqliteModule = (await import(runningOnBun ? "bun:sqlite" : "node:sqlite")) as unknown as {
  readonly Database?: DatabaseConstructor;
  readonly DatabaseSync?: DatabaseConstructor;
};
const selectedDatabase = runningOnBun ? sqliteModule.Database : sqliteModule.DatabaseSync;
if (!selectedDatabase) throw new Error("SQLite runtime is unavailable");
const SqliteDatabase: DatabaseConstructor = selectedDatabase;

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

export const SCHEMA_VERSION = 3 as const;
export const REQUIRED_TABLES = [
  "schema_meta",
  "sources",
  "source_files",
  "source_chunks",
  "source_dependencies",
  "pages",
  "wiki_issues",
  "authored_snapshots",
  "page_learning",
  "page_prerequisites",
  "quizzes",
  "quiz_questions",
  "page_reviews",
  "question_pages",
  "quiz_answers",
  "question_results",
  "page_results",
  "quiz_evidence",
  "workflows",
  "settings",
] as const;

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schema_meta: ["schema_version", "applied_at"],
  sources: [
    "source_id",
    "kind",
    "status",
    "display_name",
    "original_name",
    "source_uri",
    "media_type",
    "repository_revision",
    "captured_at",
    "digest",
    "manifest_path",
    "error_code",
    "error_message",
    "created_at",
    "updated_at",
  ],
  source_files: ["source_id", "relative_path", "byte_length", "digest", "media_type"],
  source_chunks: [
    "chunk_id",
    "source_id",
    "ordinal",
    "relative_path",
    "byte_length",
    "digest",
    "atom_start",
    "atom_end",
  ],
  source_dependencies: ["source_id", "page_id", "chunk_id", "relation"],
  pages: [
    "page_id",
    "relative_path",
    "title",
    "digest",
    "revision",
    "status",
    "quiz_worthiness",
    "created_at",
    "updated_at",
  ],
  wiki_issues: [
    "issue_id",
    "page_id",
    "heading",
    "page_digest",
    "kind",
    "description",
    "status",
    "resolution",
    "created_at",
    "updated_at",
  ],
  authored_snapshots: ["relative_path", "digest", "revision", "captured_at", "commit_id"],
  page_learning: [
    "page_id",
    "initial_due_at",
    "due_at",
    "fsrs_state",
    "stability",
    "difficulty",
    "reps",
    "lapses",
    "scheduled_days",
    "last_review_at",
    "revision",
    "created_at",
    "updated_at",
  ],
  page_prerequisites: ["page_id", "prerequisite_page_id"],
  quizzes: [
    "quiz_id",
    "date",
    "revision",
    "status",
    "sheet_path",
    "generated_at",
    "submitted_at",
    "error_code",
    "error_message",
  ],
  quiz_questions: [
    "question_id",
    "quiz_id",
    "ordinal",
    "kind",
    "prompt",
    "choices_json",
    "answer_key_json",
    "source_refs_json",
  ],
  page_reviews: [
    "review_id",
    "page_id",
    "quiz_id",
    "submission_id",
    "revision",
    "rating",
    "reviewed_at",
    "state_before_json",
    "state_after_json",
    "settlement_id",
  ],
  question_pages: ["question_id", "page_id", "criterion_json", "weight"],
  quiz_answers: ["quiz_id", "question_id", "revision", "answer_json", "saved_at"],
  question_results: ["result_id", "quiz_id", "question_id", "answer_revision", "feedback", "graded_at"],
  page_results: [
    "result_id",
    "quiz_id",
    "page_id",
    "rating",
    "feedback",
    "evidence_json",
    "readings_json",
    "review_id",
  ],
  quiz_evidence: [
    "quiz_id",
    "reference",
    "page_id",
    "relative_path",
    "anchor",
    "heading",
    "page_digest",
    "page_revision",
    "text_digest",
    "excerpt",
    "excerpt_digest",
  ],
  workflows: [
    "request_id",
    "kind",
    "status",
    "started_at",
    "finished_at",
    "progress",
    "message",
    "error_code",
    "error_message",
    "idempotency_key",
  ],
  settings: ["key", "value_json", "updated_at"],
};

const REQUIRED_SCHEMA_FRAGMENTS: Readonly<Record<string, readonly string[]>> = {
  source_chunks: ["unique (source_id, chunk_id)"],
  source_dependencies: [
    "check (page_id is not null or chunk_id is not null)",
    "foreign key (source_id, chunk_id) references source_chunks(source_id, chunk_id)",
  ],
  page_prerequisites: ["check (page_id <> prerequisite_page_id)"],
  page_reviews: ["unique (quiz_id, page_id, revision)", "unique (settlement_id, page_id)"],
  question_pages: ["criterion_json text not null", "weight real not null"],
  page_results: ["unique (quiz_id, page_id)", "unique (review_id)"],
  quiz_evidence: ["primary key (quiz_id, reference)"],
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

CREATE TABLE IF NOT EXISTS page_learning (
  page_id TEXT PRIMARY KEY REFERENCES pages(page_id) ON DELETE RESTRICT,
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

CREATE TABLE IF NOT EXISTS page_prerequisites (
  page_id TEXT NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  prerequisite_page_id TEXT NOT NULL REFERENCES pages(page_id) ON DELETE RESTRICT,
  PRIMARY KEY (page_id, prerequisite_page_id),
  CHECK (page_id <> prerequisite_page_id)
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
  source_refs_json TEXT NOT NULL,
  UNIQUE (quiz_id, ordinal)
);
CREATE TABLE IF NOT EXISTS page_reviews (
  review_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(page_id) ON DELETE RESTRICT,
  quiz_id TEXT NOT NULL REFERENCES quizzes(quiz_id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  rating TEXT NOT NULL CHECK (rating IN ('Again','Hard','Good','Easy')),
  reviewed_at TEXT NOT NULL,
  state_before_json TEXT NOT NULL,
  state_after_json TEXT NOT NULL,
  settlement_id TEXT NOT NULL,
  UNIQUE (quiz_id, page_id, revision),
  UNIQUE (settlement_id, page_id)
);

CREATE TABLE IF NOT EXISTS question_pages (
  question_id TEXT NOT NULL REFERENCES quiz_questions(question_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(page_id) ON DELETE RESTRICT,
  criterion_json TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight > 0),
  PRIMARY KEY (question_id, page_id)
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

CREATE TABLE IF NOT EXISTS page_results (
  result_id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(quiz_id) ON DELETE RESTRICT,
  page_id TEXT NOT NULL REFERENCES pages(page_id) ON DELETE RESTRICT,
  rating TEXT NOT NULL CHECK (rating IN ('Again','Hard','Good','Easy')),
  feedback TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  readings_json TEXT NOT NULL,
  review_id TEXT NOT NULL REFERENCES page_reviews(review_id) ON DELETE RESTRICT,
  UNIQUE (quiz_id, page_id),
  UNIQUE (review_id)
);

CREATE TABLE IF NOT EXISTS quiz_evidence (
  quiz_id TEXT NOT NULL REFERENCES quizzes(quiz_id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(page_id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL,
  anchor TEXT NOT NULL,
  heading TEXT,
  page_digest TEXT NOT NULL,
  page_revision INTEGER NOT NULL CHECK (page_revision > 0),
  text_digest TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  excerpt_digest TEXT NOT NULL,
  PRIMARY KEY (quiz_id, reference)
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
  readonly #database: DatabaseHandle;
  #transactionDepth = 0;

  constructor(path: string, database: DatabaseHandle) {
    this.path = path;
    this.#database = database;
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  run(sql: string, parameters?: SqlParameters): SqlRunResult {
    const result = bind(this.#database.prepare(sql), parameters, "run") as {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
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
    return this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(
      (row) => row.name,
    );
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
  const unsupported = db
    .all<{ type: string; name: string }>("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .filter((object) => object.type !== "table" || !required[object.name]);
  if (unsupported.length)
    throw new Error(
      `Pi Scholar database has unsupported objects: ${unsupported.map((object) => `${object.type} ${object.name}`).join(", ")}`,
    );
  const missing = REQUIRED_TABLES.filter((table) => !existing.includes(table));
  if (missing.length) throw new Error(`Pi Scholar database schema is missing tables: ${missing.join(", ")}`);
  const metadata = db.all<{ schema_version: number | bigint }>("SELECT schema_version FROM schema_meta");
  if (metadata.length !== 1 || Number(metadata[0]?.schema_version) !== SCHEMA_VERSION)
    throw new Error("Pi Scholar database schema_meta does not match the schema version");
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = new Set(db.all<{ name: string }>(`PRAGMA table_info('${table}')`).map((row) => row.name));
    const missingColumns = columns.filter((column) => !actual.has(column));
    if (missingColumns.length)
      throw new Error(`Pi Scholar database table ${table} is missing columns: ${missingColumns.join(", ")}`);
  }
  for (const [table, fragments] of Object.entries(REQUIRED_SCHEMA_FRAGMENTS)) {
    const definition = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [
      table,
    ])?.sql;
    const normalized = normalizedSql(definition ?? "");
    const missingFragments = fragments.filter((fragment) => !normalized.includes(normalizedSql(fragment)));
    if (missingFragments.length)
      throw new Error(`Pi Scholar database table ${table} is missing constraints: ${missingFragments.join("; ")}`);
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
  db.run("INSERT INTO schema_meta (schema_version, applied_at) VALUES (?, ?)", [
    SCHEMA_VERSION,
    new Date().toISOString(),
  ]);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  validateSchema(db);
}

function validateDatabaseSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${path}${suffix}`;
    try {
      const stat = lstatSync(sidecar);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`Pi Scholar database sidecar must be a regular file: ${sidecar}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function openDatabase(input: string | VaultPaths, options: OpenDatabaseOptions = {}): ScholarDatabase {
  const readOnly = options.readOnly ?? false;
  const path = typeof input === "string" ? input : input.databasePath;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`Pi Scholar database path must be a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  validateDatabaseSidecars(path);
  const database = new SqliteDatabase(
    path,
    runningOnBun ? { readonly: readOnly, create: !readOnly } : { readOnly, enableForeignKeyConstraints: true },
  );
  if (runningOnBun) database.exec("PRAGMA foreign_keys = ON");
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
