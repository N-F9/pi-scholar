import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import type { WikiIssueRecord } from "./contracts.js";
import { type ScholarDatabase, type SqlRow, type SqlRunResult, transaction } from "./database.js";
import { type QmdIndexOptions, qmdCollectionName } from "./external/qmd.js";
import {
  type OkfProjectionPage,
  okfCitationText,
  okfFootnoteLabels,
  okfMarkdownEscapedAt,
  parseOkfConcept,
  removeOkfFootnoteDefinitions,
  renderOkfIndex,
  renderOkfLog,
  serializeOkfConcept,
  validateOkfConcept,
} from "./okf.js";
import { readFileNoFollow, safeRelativePath, type VaultPaths } from "./vault.js";

export type WikiIssueKind = "incorrect" | "unclear" | "missing" | "bad-boundary";
export type WikiIssueStatus = "open" | "resolved" | "reopened";
export interface WikiPage {
  pageId: string;
  relativePath: string;
  title: string;
  digest: string;
  revision: number;
  status: "active" | "drifted" | "retired";
  quizWorthiness: "eligible" | "skip" | "unknown";
  updatedAt: string;
  body?: string;
}
export interface WikiPageInput {
  path: string;
  title?: string;
  body: string;
  pageId?: string;
  quizWorthiness?: "eligible" | "skip" | "unknown";
  frontmatter?: Record<string, unknown>;
}
export type DriftResolution = "record-issue" | "restore";
export interface QmdAdapter {
  search(
    query: string,
    options?: { collection: string; scope: "wiki/**/*.md"; limit?: number; ignoredPaths?: readonly string[] },
  ): Promise<unknown> | unknown;
  index?: (options?: QmdIndexOptions) => Promise<void> | void;
}
export interface WikiAdapters {
  qmd?: QmdAdapter;
  commit?: () => Promise<boolean> | boolean;
  doctor?: () => Promise<boolean> | boolean;
  lint?: () => Promise<boolean> | boolean;
}
export interface WikiCreateResult {
  page: WikiPage;
  content: string;
}
export interface WikiPreparedUpdate extends WikiCreateResult {
  expectedDigest: string;
}
export interface DriftReport {
  page: WikiPage;
  drifted: boolean;
  authoredDigest: string;
  currentDigest: string;
  diff: string;
  choices: ["record-issue", "restore"];
}
export interface WikiSearchOptions {
  mode?: "semantic" | "lexical" | "exact";
  limit?: number;
}
export type WikiIssue = WikiIssueRecord;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROJECTION_NAMES = new Set(["index.md", "log.md"]);
const BLOCKED_TAG = /<\s*\/?\s*(script|style|iframe|object|embed|form|base|meta|link)(?:\s|\/?>)/iu;
const EVENT_ATTRIBUTE = /\bon[a-z][a-z0-9:_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/iu;
const DANGEROUS_URI = /\b(?:javascript|vbscript)\s*:/iu;
const DANGEROUS_DATA =
  /\bdata\s*:\s*(?:text\/html|text\/javascript|application\/(?:javascript|x-javascript)|image\/svg\+xml)\b/iu;

type PageRow = SqlRow;
type SnapshotRow = SqlRow;
type IssueRow = SqlRow;
function dbRun(db: ScholarDatabase, sql: string, params: unknown[] = []): SqlRunResult {
  return db.run(sql, params);
}
function dbGet<T = SqlRow>(db: ScholarDatabase, sql: string, params: unknown[] = []): T | undefined {
  return db.get<T>(sql, params);
}
function dbAll<T = SqlRow>(db: ScholarDatabase, sql: string, params: unknown[] = []): T[] {
  return db.all<T>(sql, params);
}
function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function now(): string {
  return new Date().toISOString();
}
function vaultRoot(paths: Partial<VaultPaths> & { root?: string }): string {
  const root = paths.wikiRoot ?? (paths.root ? join(paths.root, "wiki") : undefined);
  if (!root) throw new Error("wiki root is required");
  return root;
}
function normalizePagePath(
  paths: Partial<VaultPaths> & { root?: string },
  requested: string,
): { relativePath: string; absolutePath: string } {
  if (!requested.endsWith(".md")) throw new Error("wiki pages must use .md");
  const root = vaultRoot(paths);
  const absolute = safeRelativePath(root, requested);
  const relativePath = relative(root, absolute).replaceAll("\\", "/");
  if (
    relativePath.split("/").some((part) => part === ".snapshots") ||
    PROJECTION_NAMES.has(relativePath) ||
    PROJECTION_NAMES.has(relativePath.split("/").at(-1) ?? "")
  )
    throw new Error("reserved wiki path");
  return { relativePath, absolutePath: absolute };
}
export function isExecutableHtml(value: string): boolean {
  return (
    BLOCKED_TAG.test(value) || EVENT_ATTRIBUTE.test(value) || DANGEROUS_URI.test(value) || DANGEROUS_DATA.test(value)
  );
}
function assertInertMarkdown(body: string): void {
  if (isExecutableHtml(body)) throw new Error("raw executable HTML is not allowed in wiki Markdown");
}
function assertPageTitle(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error("wiki page title is required");
}
function serializePage(frontmatter: Record<string, unknown>, body: string): string {
  assertInertMarkdown(body);
  return serializeOkfConcept(frontmatter, body);
}
type SourceChunkCitationRow = {
  chunk_id: string;
  source_id: string;
  ordinal: number;
  chunk_digest: string;
  source_digest: string | null;
  display_name: string;
  status: string;
};
const UUID_CHUNK_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/iu;
const UUID_CHUNK_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+/giu;
function sourceCitationId(row: SourceChunkCitationRow): string {
  return `${row.source_id}:${row.ordinal}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function rowToPage(row: PageRow, body?: string): WikiPage {
  const page: WikiPage = {
    pageId: String(row.page_id ?? row.pageId ?? row.id),
    relativePath: String(row.relative_path ?? row.relativePath ?? row.path),
    title: String(row.title ?? ""),
    digest: String(row.digest ?? ""),
    revision: Number(row.revision ?? 1),
    status: (row.status ?? "active") as WikiPage["status"],
    quizWorthiness: (row.quiz_worthiness ?? row.quizWorthiness ?? "unknown") as WikiPage["quizWorthiness"],
    updatedAt: String(row.updated_at ?? row.updatedAt ?? ""),
  };
  if (body !== undefined) page.body = body;
  return page;
}
function rowToIssue(row: IssueRow): WikiIssue {
  return {
    issueId: String(row.issue_id),
    pageId: typeof row.page_id === "string" ? row.page_id : undefined,
    heading: typeof row.heading === "string" ? row.heading : undefined,
    pageDigest: typeof row.page_digest === "string" ? row.page_digest : undefined,
    kind: row.kind as WikiIssueKind,
    description: String(row.description),
    status: row.status as WikiIssueStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    resolution: typeof row.resolution === "string" ? row.resolution : undefined,
  };
}
function linksFromMarkdown(body: string): string[] {
  const links: string[] = [];
  const pattern = /!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
  for (const match of body.matchAll(pattern)) {
    const target = match[1];
    if (!target || target.startsWith("#") || /^https?:\/\//iu.test(target)) continue;
    links.push(target.split("#", 1)[0] ?? target);
  }
  return links;
}
function resolveWikiLink(root: string, pagePath: string, target: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new Error("invalid Markdown link encoding");
  }
  if (
    !decoded ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded) ||
    /^[A-Za-z]:/u.test(decoded)
  )
    throw new Error(`unsafe Markdown link: ${target}`);
  const candidate = decoded.startsWith("/")
    ? decoded.slice(1)
    : normalize(join(dirname(pagePath), decoded)).replaceAll("\\", "/");
  return relative(root, safeRelativePath(root, candidate)).replaceAll("\\", "/");
}
function validateMarkdownLinks(root: string, pagePath: string, body: string): void {
  for (const target of linksFromMarkdown(body)) resolveWikiLink(root, pagePath, target);
}
function titleFromPath(path: string): string {
  const name = path.split("/").at(-1)?.replace(/\.md$/iu, "") ?? path;
  return name.replace(/[-_]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
function simpleDiff(before: string, after: string): string {
  const left = before.split(/\r?\n/u);
  const right = after.split(/\r?\n/u);
  return ["--- authored", "+++ current", ...left.map((line) => `- ${line}`), ...right.map((line) => `+ ${line}`)].join(
    "\n",
  );
}
function positiveLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("search limit must be between 1 and 100");
  return value;
}

export class WikiService {
  readonly db: ScholarDatabase;
  readonly paths: Partial<VaultPaths> & { root?: string };
  readonly adapters: WikiAdapters;
  constructor(db: ScholarDatabase, paths: Partial<VaultPaths> & { root?: string }, adapters: WikiAdapters = {}) {
    this.db = db;
    this.paths = paths;
    this.adapters = adapters;
  }
  private root(): string {
    return vaultRoot(this.paths);
  }
  private qmdIgnoredPaths(): readonly string[] {
    return dbAll<{ readonly relative_path: string }>(
      this.db,
      "SELECT relative_path FROM pages WHERE status = 'drifted' ORDER BY relative_path",
    ).map(({ relative_path }) => relative_path);
  }
  async refreshQmdIndex(): Promise<void> {
    const index = this.adapters.qmd?.index;
    if (typeof index === "function") await index({ ignoredPaths: this.qmdIgnoredPaths() });
  }
  private async refreshQmd(): Promise<void> {
    try {
      await this.refreshQmdIndex();
    } catch {
      /* application maintenance checks enforce qmd */
    }
  }
  private async atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
      await fs.rename(temp, path);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  private async assertDestinationAbsent(path: string): Promise<void> {
    try {
      await fs.lstat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("wiki path already exists");
  }
  private async optionalBytes(path: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw error;
    }
  }
  private async restoreOptional(path: string, content: Buffer | undefined): Promise<void> {
    if (content === undefined) await fs.rm(path, { force: true });
    else await this.atomicWrite(path, content);
  }
  private catalog(pageId: string): PageRow | undefined {
    return dbGet<PageRow>(this.db, "SELECT * FROM pages WHERE page_id = ?", [pageId]);
  }
  private catalogByPath(path: string): PageRow | undefined {
    return dbGet<PageRow>(this.db, "SELECT * FROM pages WHERE relative_path = ?", [path]);
  }
  private snapshotPath(page: WikiPage): string {
    const metadataRoot = this.paths.metadataRoot ?? join(this.root(), ".pi-scholar");
    return join(metadataRoot, "snapshots", "wiki", `${page.pageId}.md`);
  }
  private authored(pageId: string): { digest: string; revision: number; content: string } | undefined {
    const row = this.catalog(pageId);
    if (!row) return undefined;
    const snapshot = dbGet<SnapshotRow>(this.db, "SELECT * FROM authored_snapshots WHERE relative_path = ?", [
      row.relative_path,
    ]);
    if (!snapshot) return undefined;
    const path = this.snapshotPath(rowToPage(row));
    const content = readFileNoFollow(path).toString("utf8");
    const recordedDigest = String(snapshot.digest);
    if (recordedDigest !== row.digest || digest(content) !== recordedDigest) return undefined;
    return {
      digest: recordedDigest,
      revision: Number(snapshot.revision),
      content,
    };
  }
  private async authoredPage(page: WikiPage): Promise<(WikiPage & { content: string }) | undefined> {
    if (page.status !== "active") return undefined;
    try {
      const current = await this.get(page.pageId);
      const snapshot = this.authored(page.pageId);
      const currentDigest = digest(current.content);
      if (
        !snapshot ||
        currentDigest !== snapshot.digest ||
        currentDigest !== page.digest ||
        current.status !== "active"
      )
        return undefined;
      return current;
    } catch {
      return undefined;
    }
  }
  private async writeCatalog(page: WikiPage, content: string, previousPath?: string): Promise<void> {
    assertPageTitle(page.title);
    const snapshot = this.snapshotPath(page);
    await this.atomicWrite(snapshot, content);
    transaction(this.db, () => {
      const existing = this.catalog(page.pageId);
      const createdAt = existing ? String(existing.created_at) : page.updatedAt;
      if (existing)
        dbRun(
          this.db,
          "UPDATE pages SET relative_path = ?, title = ?, digest = ?, revision = ?, status = ?, quiz_worthiness = ?, updated_at = ? WHERE page_id = ?",
          [
            page.relativePath,
            page.title,
            page.digest,
            page.revision,
            page.status,
            page.quizWorthiness,
            page.updatedAt,
            page.pageId,
          ],
        );
      else
        dbRun(
          this.db,
          "INSERT INTO pages (page_id, relative_path, title, digest, revision, status, quiz_worthiness, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            page.pageId,
            page.relativePath,
            page.title,
            page.digest,
            page.revision,
            page.status,
            page.quizWorthiness,
            createdAt,
            page.updatedAt,
          ],
        );
      if (previousPath && previousPath !== page.relativePath)
        dbRun(this.db, "DELETE FROM authored_snapshots WHERE relative_path = ?", [previousPath]);
      dbRun(
        this.db,
        "INSERT OR REPLACE INTO authored_snapshots (relative_path, digest, revision, captured_at, commit_id) VALUES (?, ?, ?, ?, ?)",
        [page.relativePath, page.digest, page.revision, page.updatedAt, `file:${snapshot}`],
      );
    });
  }
  private sourceRows(): SourceChunkCitationRow[] {
    return dbAll<SourceChunkCitationRow>(
      this.db,
      "SELECT c.chunk_id, c.source_id, c.ordinal, c.digest AS chunk_digest, s.digest AS source_digest, s.display_name, s.status FROM source_chunks c JOIN sources s ON s.source_id = c.source_id WHERE s.status != 'removed' ORDER BY c.source_id, c.ordinal",
    ).map((row) => ({
      ...row,
      chunk_id: String(row.chunk_id),
      source_id: String(row.source_id),
      ordinal: Number(row.ordinal),
      chunk_digest: String(row.chunk_digest),
      source_digest: row.source_digest === null ? null : String(row.source_digest),
      display_name: String(row.display_name),
      status: String(row.status),
    }));
  }
  private sourceAwareContent(
    frontmatter: Record<string, unknown>,
    body: string,
  ): {
    frontmatter: Record<string, unknown>;
    body: string;
  } {
    const rows = this.sourceRows();
    const byId = new Map<string, SourceChunkCitationRow>();
    for (const row of rows) {
      const expectedId = sourceCitationId(row);
      if (row.chunk_id !== expectedId) throw new Error(`source chunk identity is invalid: ${row.chunk_id}`);
      byId.set(expectedId, row);
    }
    const cited = new Map<string, SourceChunkCitationRow>();
    const labels = okfFootnoteLabels(body);
    const citationText = okfCitationText(body);
    for (const label of labels.references) {
      const row = byId.get(label);
      if (row) cited.set(label, row);
      else if (UUID_CHUNK_REFERENCE.test(label)) throw new Error(`unknown source chunk citation: ${label}`);
    }
    for (const match of citationText.matchAll(UUID_CHUNK_TEXT)) {
      const label = match[0];
      const offset = match.index;
      if (!label || offset === undefined) continue;
      const opening = offset - 2;
      if (opening >= 0 && citationText.slice(opening, offset) === "[^" && okfMarkdownEscapedAt(citationText, opening))
        continue;
      if (!byId.has(label)) throw new Error(`unknown source chunk citation: ${label}`);
      if (citationText.slice(Math.max(0, offset - 2), offset) !== "[^" || citationText[offset + label.length] !== "]")
        throw new Error(`raw source chunk ID is not a keyed footnote reference: ${label}`);
    }
    const next = { ...frontmatter };
    if (next.sources !== undefined && !Array.isArray(next.sources))
      throw new Error("OKF sources must be a YAML sequence");
    const existingSources = Array.isArray(next.sources) ? next.sources : [];
    if (existingSources.some((source) => !isRecord(source)))
      throw new Error("OKF source entries must be YAML mappings");
    const priorManagedIds = existingSources
      .filter(
        (source) =>
          isRecord(source.pi_scholar) && source.pi_scholar.managed_by === "pi-scholar" && typeof source.id === "string",
      )
      .map((source) => String(source.id));
    const references = new Set(labels.references);
    for (const label of labels.definitions) {
      if (!references.has(label) && (byId.has(label) || UUID_CHUNK_REFERENCE.test(label)))
        throw new Error(`orphan managed footnote definition: ${label}`);
    }
    const retainedSources = existingSources.filter(
      (source) => !(isRecord(source.pi_scholar) && source.pi_scholar.managed_by === "pi-scholar"),
    );
    const managedSources = [...cited.values()].map((row) => ({
      id: sourceCitationId(row),
      resource: `pi-scholar://source/${row.source_id}/chunk/${row.ordinal}`,
      title: row.display_name,
      pi_scholar: {
        managed_by: "pi-scholar",
        source_id: row.source_id,
        chunk_id: row.chunk_id,
        ordinal: row.ordinal,
        ...(row.source_digest ? { source_digest: row.source_digest } : {}),
        chunk_digest: row.chunk_digest,
      },
    }));
    if (retainedSources.length || managedSources.length || Array.isArray(next.sources))
      next.sources = [...retainedSources, ...managedSources];
    const definitions = managedSources.map((source) => `[^${source.id}]: Pi Scholar source evidence`);
    let nextBody = removeOkfFootnoteDefinitions(
      body,
      new Set([...priorManagedIds, ...managedSources.map((source) => source.id)]),
    );
    if (definitions.length) {
      if (!nextBody.endsWith("\n")) nextBody += "\n";
      nextBody += `\n${definitions.join("\n")}\n`;
    }
    return { frontmatter: next, body: nextBody };
  }
  private serializeContent(frontmatter: Record<string, unknown>, body: string): string {
    const prepared = this.sourceAwareContent(frontmatter, body);
    return serializePage(prepared.frontmatter, prepared.body);
  }
  async create(input: WikiPageInput): Promise<WikiCreateResult> {
    const location = normalizePagePath(this.paths, input.path);
    if (this.catalogByPath(location.relativePath)) throw new Error("wiki path already exists");
    await this.assertDestinationAbsent(location.absolutePath);
    if (input.pageId) throw new Error("page ID is host-minted");
    const pageId = randomUUID();
    const createdAt = now();
    const title = input.title ?? titleFromPath(location.relativePath);
    assertPageTitle(title);
    const quizWorthiness = input.quizWorthiness ?? "unknown";
    const frontmatter: Record<string, unknown> = {
      ...(input.frontmatter ?? {}),
      id: pageId,
      title,
      type: input.frontmatter?.type ?? "note",
      created: createdAt,
      updated: createdAt,
      "quiz-worthiness": quizWorthiness,
    };
    const content = this.serializeContent(frontmatter, input.body);
    validateMarkdownLinks(this.root(), location.relativePath, input.body);
    const page: WikiPage = {
      pageId,
      relativePath: location.relativePath,
      title,
      digest: digest(content),
      revision: 1,
      status: "active",
      quizWorthiness: input.quizWorthiness ?? "unknown",
      updatedAt: createdAt,
    };
    const snapshotPath = this.snapshotPath(page);
    const indexPath = join(this.root(), "index.md");
    const logPath = join(this.root(), "log.md");
    const priorIndex = await this.optionalBytes(indexPath);
    const priorLog = await this.optionalBytes(logPath);
    const rollback = async (): Promise<void> => {
      const errors: unknown[] = [];
      const attempt = async (action: () => Promise<void> | void): Promise<void> => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => fs.rm(location.absolutePath, { force: true }));
      await attempt(() => fs.rm(snapshotPath, { force: true }));
      await attempt(() => {
        transaction(this.db, () => {
          dbRun(this.db, "DELETE FROM authored_snapshots WHERE relative_path = ?", [page.relativePath]);
          dbRun(this.db, "DELETE FROM pages WHERE page_id = ?", [page.pageId]);
        });
      });
      await attempt(() => this.restoreOptional(indexPath, priorIndex));
      await attempt(() => this.restoreOptional(logPath, priorLog));
      if (errors.length) {
        const detail = errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ");
        throw new Error(`wiki create rollback failed: ${detail}`, { cause: errors[0] });
      }
    };
    try {
      await this.atomicWrite(location.absolutePath, content);
      await this.writeCatalog(page, content);
      await this.refreshProjections();
      await this.refreshQmd();
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new Error(
          `wiki create failed and rollback failed: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return { page, content };
  }
  async prepareUpdate(
    pageId: string,
    input: {
      body?: string;
      title?: string;
      quizWorthiness?: WikiPage["quizWorthiness"];
      expectedDigest?: string;
      path?: string;
    },
    updatedAt = now(),
  ): Promise<WikiPreparedUpdate> {
    const row = this.catalog(pageId);
    if (!row) throw new Error("page not found");
    const page = rowToPage(row);
    const location = normalizePagePath(this.paths, input.path ?? page.relativePath);
    if (location.relativePath !== page.relativePath) throw new Error("page path changes must use rename");
    const current = await fs.readFile(location.absolutePath, "utf8");
    const currentParsed = parseOkfConcept(current);
    if (currentParsed.frontmatter.id !== pageId) throw new Error("page ID mismatch");
    const expected = input.expectedDigest ?? page.digest;
    const currentDigest = digest(current);
    if (expected !== currentDigest) throw new Error("page changed since it was read");
    const authored = currentDigest !== page.digest ? this.authored(pageId) : undefined;
    if (currentDigest !== page.digest && (!authored || authored.digest !== page.digest))
      throw new Error("product-authored snapshot is unavailable");
    const parsed = authored ? parseOkfConcept(authored.content) : currentParsed;
    if (parsed.frontmatter.id !== pageId) throw new Error("page ID mismatch");
    const body = input.body ?? parsed.body;
    const title =
      input.title ??
      (typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : undefined) ??
      page.title;
    assertPageTitle(title);
    const quizWorthiness = input.quizWorthiness ?? page.quizWorthiness;
    const frontmatter: Record<string, unknown> = {
      ...parsed.frontmatter,
      id: pageId,
      title,
      created: typeof parsed.frontmatter.created === "string" ? parsed.frontmatter.created : updatedAt,
      updated: updatedAt,
      "quiz-worthiness": quizWorthiness,
    };
    const content = this.serializeContent(frontmatter, body);
    validateMarkdownLinks(this.root(), page.relativePath, body);
    const updated: WikiPage = {
      ...page,
      title,
      digest: digest(content),
      revision: page.revision + 1,
      status: "active",
      quizWorthiness: input.quizWorthiness ?? page.quizWorthiness,
      updatedAt,
    };
    return { page: updated, content, expectedDigest: expected };
  }
  async update(
    pageId: string,
    input: {
      body?: string;
      title?: string;
      quizWorthiness?: WikiPage["quizWorthiness"];
      expectedDigest?: string;
      path?: string;
    },
    prepared?: WikiPreparedUpdate,
  ): Promise<WikiCreateResult> {
    const next = prepared ?? (await this.prepareUpdate(pageId, input));
    assertPageTitle(next.page.title);
    const nextFrontmatter = parseOkfConcept(next.content).frontmatter;
    assertPageTitle(nextFrontmatter.title);
    const priorPageRow = this.catalog(pageId);
    if (!priorPageRow) throw new Error("page not found");
    const page = rowToPage(priorPageRow);
    const location = normalizePagePath(this.paths, input.path ?? page.relativePath);
    if (
      location.relativePath !== page.relativePath ||
      next.page.pageId !== pageId ||
      next.page.revision !== page.revision + 1
    )
      throw new Error("prepared wiki update is stale");
    const priorPageBytes = await fs.readFile(location.absolutePath);
    const current = priorPageBytes.toString("utf8");
    if (digest(current) !== next.expectedDigest) throw new Error("page changed since it was prepared");
    const snapshotPath = this.snapshotPath(page);
    const priorSnapshotRow = dbGet<SnapshotRow>(this.db, "SELECT * FROM authored_snapshots WHERE relative_path = ?", [
      page.relativePath,
    ]);
    const priorSnapshotBytes = await this.optionalBytes(snapshotPath);
    const indexPath = join(this.root(), "index.md");
    const logPath = join(this.root(), "log.md");
    const priorIndex = await this.optionalBytes(indexPath);
    const priorLog = await this.optionalBytes(logPath);
    const rollback = async (): Promise<void> => {
      const errors: unknown[] = [];
      const attempt = async (action: () => Promise<void> | void): Promise<void> => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => this.atomicWrite(location.absolutePath, priorPageBytes));
      await attempt(() => this.restoreOptional(snapshotPath, priorSnapshotBytes));
      await attempt(() => {
        transaction(this.db, () => {
          dbRun(
            this.db,
            "UPDATE pages SET relative_path = ?, title = ?, digest = ?, revision = ?, status = ?, quiz_worthiness = ?, updated_at = ? WHERE page_id = ?",
            [
              priorPageRow.relative_path,
              priorPageRow.title,
              priorPageRow.digest,
              priorPageRow.revision,
              priorPageRow.status,
              priorPageRow.quiz_worthiness,
              priorPageRow.updated_at,
              pageId,
            ],
          );
          dbRun(this.db, "DELETE FROM authored_snapshots WHERE relative_path = ?", [page.relativePath]);
          if (priorSnapshotRow)
            dbRun(
              this.db,
              "INSERT OR REPLACE INTO authored_snapshots (relative_path, digest, revision, captured_at, commit_id) VALUES (?, ?, ?, ?, ?)",
              [
                priorSnapshotRow.relative_path,
                priorSnapshotRow.digest,
                priorSnapshotRow.revision,
                priorSnapshotRow.captured_at,
                priorSnapshotRow.commit_id ?? null,
              ],
            );
        });
      });
      await attempt(() => this.restoreOptional(indexPath, priorIndex));
      await attempt(() => this.restoreOptional(logPath, priorLog));
      if (errors.length) {
        const detail = errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ");
        throw new Error(`wiki update rollback failed: ${detail}`, { cause: errors[0] });
      }
    };
    try {
      await this.atomicWrite(location.absolutePath, next.content);
      await this.writeCatalog(next.page, next.content);
      await this.refreshProjections();
      await this.refreshQmd();
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new Error(
          `wiki update failed and rollback failed: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return { page: next.page, content: next.content };
  }
  async rename(pageId: string, requestedPath: string): Promise<WikiPage> {
    const priorPageRow = this.catalog(pageId);
    if (!priorPageRow) throw new Error("page not found");
    const page = rowToPage(priorPageRow);
    const from = normalizePagePath(this.paths, page.relativePath);
    const to = normalizePagePath(this.paths, requestedPath);
    if (this.catalogByPath(to.relativePath)) throw new Error("wiki path already exists");
    await this.assertDestinationAbsent(to.absolutePath);
    const priorPageBytes = await fs.readFile(from.absolutePath);
    const content = priorPageBytes.toString("utf8");
    const parsed = parseOkfConcept(content);
    if (parsed.frontmatter.id !== pageId) throw new Error("page ID mismatch");
    const currentDigest = digest(content);
    const authored = this.authored(pageId);
    if (
      currentDigest !== page.digest ||
      !authored ||
      authored.digest !== page.digest ||
      authored.revision !== page.revision ||
      digest(authored.content) !== page.digest
    )
      throw new Error("wiki page changed outside Pi Scholar; inspect drift before renaming");
    const snapshotPath = this.snapshotPath(page);
    const priorSnapshotRow = dbGet<SnapshotRow>(this.db, "SELECT * FROM authored_snapshots WHERE relative_path = ?", [
      page.relativePath,
    ]);
    const priorSnapshot = await this.optionalBytes(snapshotPath);
    const indexPath = join(this.root(), "index.md");
    const logPath = join(this.root(), "log.md");
    const priorIndex = await this.optionalBytes(indexPath);
    const priorLog = await this.optionalBytes(logPath);
    await fs.mkdir(dirname(to.absolutePath), { recursive: true });
    await fs.rename(from.absolutePath, to.absolutePath);
    const updated: WikiPage = {
      ...page,
      relativePath: to.relativePath,
      revision: page.revision + 1,
      updatedAt: now(),
      status: "active",
    };
    const rollback = async (): Promise<void> => {
      const errors: unknown[] = [];
      const attempt = async (action: () => Promise<void> | void): Promise<void> => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => fs.rm(to.absolutePath, { force: true }));
      await attempt(() => this.atomicWrite(from.absolutePath, priorPageBytes));
      await attempt(() => this.restoreOptional(snapshotPath, priorSnapshot));
      await attempt(() => {
        transaction(this.db, () => {
          dbRun(
            this.db,
            "UPDATE pages SET relative_path = ?, title = ?, digest = ?, revision = ?, status = ?, quiz_worthiness = ?, updated_at = ? WHERE page_id = ?",
            [
              priorPageRow.relative_path,
              priorPageRow.title,
              priorPageRow.digest,
              priorPageRow.revision,
              priorPageRow.status,
              priorPageRow.quiz_worthiness,
              priorPageRow.updated_at,
              pageId,
            ],
          );
          dbRun(this.db, "DELETE FROM authored_snapshots WHERE relative_path = ?", [updated.relativePath]);
          if (priorSnapshotRow)
            dbRun(
              this.db,
              "INSERT OR REPLACE INTO authored_snapshots (relative_path, digest, revision, captured_at, commit_id) VALUES (?, ?, ?, ?, ?)",
              [
                priorSnapshotRow.relative_path,
                priorSnapshotRow.digest,
                priorSnapshotRow.revision,
                priorSnapshotRow.captured_at,
                priorSnapshotRow.commit_id ?? null,
              ],
            );
        });
      });
      await attempt(() => this.restoreOptional(indexPath, priorIndex));
      await attempt(() => this.restoreOptional(logPath, priorLog));
      if (errors.length) {
        const detail = errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ");
        throw new Error(`wiki rename rollback failed: ${detail}`, { cause: errors[0] });
      }
    };
    try {
      await this.writeCatalog(updated, content, page.relativePath);
      await this.refreshProjections();
      await this.refreshQmd();
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new Error(
          `wiki rename failed and rollback failed: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return updated;
  }
  async retire(pageId: string): Promise<WikiPage> {
    const priorPageRow = this.catalog(pageId);
    if (!priorPageRow) throw new Error("page not found");
    const page = rowToPage(priorPageRow);
    if (page.status !== "active") throw new Error("page is not active");
    const unresolvedIssue = dbGet<{ issue_id: string }>(
      this.db,
      "SELECT issue_id FROM wiki_issues WHERE page_id = ? AND status IN ('open', 'reopened') LIMIT 1",
      [pageId],
    );
    if (unresolvedIssue) throw new Error("page has an open or reopened linked issue");
    const location = normalizePagePath(this.paths, page.relativePath);
    if (!this.authored(pageId)) throw new Error("product-authored snapshot is unavailable");
    const priorPageBytes = readFileNoFollow(location.absolutePath);
    const parsed = parseOkfConcept(priorPageBytes.toString("utf8"));
    if (parsed.frontmatter.id !== pageId) throw new Error("page ID mismatch");
    const indexPath = join(this.root(), "index.md");
    const logPath = join(this.root(), "log.md");
    const priorIndex = await this.optionalBytes(indexPath);
    const priorLog = await this.optionalBytes(logPath);
    const retired: WikiPage = {
      ...page,
      revision: page.revision + 1,
      status: "retired",
      quizWorthiness: "skip",
      updatedAt: now(),
    };
    const rollback = async (): Promise<void> => {
      const errors: unknown[] = [];
      const attempt = async (action: () => Promise<void> | void): Promise<void> => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => this.atomicWrite(location.absolutePath, priorPageBytes));
      await attempt(() => {
        transaction(this.db, () => {
          dbRun(
            this.db,
            "UPDATE pages SET relative_path = ?, title = ?, digest = ?, revision = ?, status = ?, quiz_worthiness = ?, updated_at = ? WHERE page_id = ?",
            [
              priorPageRow.relative_path,
              priorPageRow.title,
              priorPageRow.digest,
              priorPageRow.revision,
              priorPageRow.status,
              priorPageRow.quiz_worthiness,
              priorPageRow.updated_at,
              pageId,
            ],
          );
        });
      });
      await attempt(() => this.restoreOptional(indexPath, priorIndex));
      await attempt(() => this.restoreOptional(logPath, priorLog));
      if (errors.length) {
        const detail = errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ");
        throw new Error(`wiki retirement rollback failed: ${detail}`, { cause: errors[0] });
      }
    };
    try {
      await fs.rm(location.absolutePath);
      transaction(this.db, () => {
        const result = dbRun(
          this.db,
          "UPDATE pages SET revision = ?, status = ?, quiz_worthiness = ?, updated_at = ? WHERE page_id = ? AND status = 'active'",
          [retired.revision, retired.status, retired.quizWorthiness, retired.updatedAt, pageId],
        );
        if (Number(result.changes) !== 1) throw new Error("page is not active");
      });
      await this.refreshProjections();
      await this.refreshQmd();
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new Error(
          `wiki retirement failed and rollback failed: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return retired;
  }
  async readExact(requestedPath: string): Promise<Buffer> {
    const location = normalizePagePath(this.paths, requestedPath);
    return fs.readFile(location.absolutePath);
  }
  async semanticSearch(query: string, limit?: number): Promise<unknown[]> {
    return this.search(query, { mode: "semantic", limit });
  }
  async lexicalSearch(query: string, limit?: number): Promise<unknown[]> {
    return this.search(query, { mode: "lexical", limit });
  }
  async get(pageIdOrPath: string): Promise<WikiPage & { content: string }> {
    const row = ID.test(pageIdOrPath) ? this.catalog(pageIdOrPath) : this.catalogByPath(pageIdOrPath);
    if (!row) throw new Error("page not found");
    const page = rowToPage(row);
    const content = (await this.readExact(page.relativePath)).toString("utf8");
    return { ...page, content };
  }
  async list(): Promise<WikiPage[]> {
    return dbAll<PageRow>(this.db, "SELECT * FROM pages WHERE status != 'retired' ORDER BY relative_path, page_id").map(
      (row) => rowToPage(row),
    );
  }
  private qmdPath(value: unknown): string {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("qmd returned malformed search result");
    const record = value as Record<string, unknown>;
    const relativePath = (path: string): string => {
      if (
        !path ||
        /[\u0000-\u001f\u007f]/u.test(path) ||
        path.includes("\\") ||
        path.startsWith("/") ||
        path.startsWith("//") ||
        /^[A-Za-z]:/u.test(path) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
      )
        throw new Error("qmd returned an unsafe wiki path");
      const normalized = normalize(path).replaceAll("\\", "/");
      const candidate = normalized.startsWith("wiki/") ? normalized.slice("wiki/".length) : normalized;
      if (
        !candidate ||
        candidate === "." ||
        !candidate.endsWith(".md") ||
        path.split("/").some((part) => part === "..") ||
        candidate.split("/").some((part) => part === ".snapshots" || part === ".pi-scholar")
      )
        throw new Error("qmd returned an unsafe wiki path");
      return candidate;
    };
    if (typeof record.path === "string") return relativePath(record.path);
    if (typeof record.file !== "string" || !this.paths.vaultId) throw new Error("qmd returned malformed search result");
    const pathStart = record.file.indexOf("/", "qmd://".length);
    const rawPath = pathStart < 0 ? "" : (record.file.slice(pathStart).split(/[?#]/u, 1)[0] ?? "");
    if (
      rawPath.split("/").some((part) => {
        try {
          const decoded = decodeURIComponent(part);
          return decoded === ".." || decoded === ".";
        } catch {
          return false;
        }
      })
    )
      throw new Error("qmd returned an unsafe wiki URI");
    let parsed: URL;
    try {
      parsed = new URL(record.file);
    } catch {
      throw new Error("qmd returned a malformed wiki URI");
    }
    const collection = qmdCollectionName(this.paths.vaultId);
    if (
      parsed.protocol !== "qmd:" ||
      parsed.host !== collection ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      !parsed.pathname.startsWith("/") ||
      /%(?:2f|5c)/iu.test(parsed.pathname)
    )
      throw new Error("qmd returned an unsafe wiki URI");
    let decoded: string;
    try {
      decoded = decodeURIComponent(parsed.pathname.slice(1));
    } catch {
      throw new Error("qmd returned a malformed wiki URI");
    }
    return relativePath(decoded);
  }
  private async search(query: string, options: WikiSearchOptions): Promise<unknown[]> {
    if (!query.trim()) throw new Error("search query is required");
    const limit = positiveLimit(options.limit);
    const mode = options.mode ?? "semantic";
    if (mode === "semantic") {
      if (!this.adapters.qmd) throw new Error("semantic search unavailable: qmd adapter not configured");
      const vaultId = this.paths.vaultId;
      if (!vaultId) throw new Error("qmd search requires vault identity");
      const ignoredPaths = this.qmdIgnoredPaths();
      const searchLimit = limit === undefined ? undefined : Math.min(100, limit + ignoredPaths.length);
      const result = await this.adapters.qmd.search(query, {
        collection: qmdCollectionName(vaultId),
        scope: "wiki/**/*.md",
        limit: searchLimit,
        ignoredPaths,
      });
      if (!Array.isArray(result)) throw new Error("qmd returned malformed search results");
      const filtered: unknown[] = [];
      for (const item of result) {
        const path = this.qmdPath(item);
        if (path === "index.md" || path === "log.md") continue;
        const row = this.catalogByPath(path);
        if (!row) throw new Error("qmd returned an unknown wiki page");
        if (row.status !== "active" || !(await this.authoredPage(rowToPage(row)))) continue;
        filtered.push({ ...(item as Record<string, unknown>), path });
        if (limit !== undefined && filtered.length >= limit) break;
      }
      return filtered;
    }
    if (mode === "exact") {
      const row = ID.test(query) ? this.catalog(query) : this.catalogByPath(query);
      return row ? [await this.get(row.page_id as string)] : [];
    }
    const needle = query.toLocaleLowerCase();
    const result: Array<{ page: WikiPage; matches: number[]; snippets: string[] }> = [];
    for (const page of await this.list()) {
      const current = await this.authoredPage(page);
      if (!current) continue;
      const lines = current.content.split("\n");
      const matches = lines.flatMap((line, index) => (line.toLocaleLowerCase().includes(needle) ? [index] : []));
      if (matches.length) result.push({ page: current, matches, snippets: matches.map((index) => lines[index] ?? "") });
      if (limit !== undefined && result.length >= limit) break;
    }
    return result;
  }
  async report(input: {
    pageId?: string;
    heading?: string;
    pageDigest?: string;
    kind?: WikiIssueKind;
    description: string;
  }): Promise<WikiIssue> {
    if (!input.description.trim()) throw new Error("issue description is required");
    const page = input.pageId ? this.catalog(input.pageId) : undefined;
    if (input.pageId && !page) throw new Error("page not found");
    if (input.heading !== undefined && !input.heading.trim())
      throw new Error("issue heading is required when provided");
    const createdAt = now();
    const issue: WikiIssue = {
      issueId: randomUUID(),
      pageId: input.pageId,
      heading: input.heading,
      pageDigest: input.pageDigest ?? (page ? String(page.digest) : undefined),
      kind: input.kind ?? "incorrect",
      description: input.description,
      status: "open",
      createdAt,
      updatedAt: createdAt,
    };
    transaction(this.db, () =>
      dbRun(
        this.db,
        "INSERT INTO wiki_issues (issue_id, page_id, heading, page_digest, kind, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          issue.issueId,
          issue.pageId ?? null,
          issue.heading ?? null,
          issue.pageDigest ?? null,
          issue.kind,
          issue.description,
          issue.status,
          issue.createdAt,
          issue.updatedAt,
        ],
      ),
    );
    return issue;
  }
  async inspectDrift(pageId: string): Promise<DriftReport> {
    const page = await this.get(pageId);
    const snapshot = this.authored(pageId);
    if (!snapshot) throw new Error("product-authored snapshot is unavailable");
    const authoredDigest = snapshot.digest;
    const currentDigest = digest(page.content);
    const contentDrifted = authoredDigest !== currentDigest;
    const drifted = page.status === "drifted" || contentDrifted;
    const currentPage = {
      ...page,
      status: drifted ? ("drifted" as const) : page.status === "retired" ? ("retired" as const) : ("active" as const),
    };
    return {
      page: currentPage,
      drifted,
      authoredDigest,
      currentDigest,
      diff: contentDrifted ? simpleDiff(snapshot.content, page.content) : "",
      choices: ["record-issue", "restore"],
    };
  }
  async resolveDrift(
    pageId: string,
    choice: DriftResolution,
  ): Promise<{ page: WikiPage; issue?: WikiIssue; restored: true }> {
    if (choice !== "record-issue" && choice !== "restore") throw new Error("unsupported drift resolution");
    const report = await this.inspectDrift(pageId);
    if (!report.drifted) return { page: report.page, restored: true };
    if (report.authoredDigest === report.currentDigest)
      throw new Error("semantic drift requires maintenance correction");
    const snapshot = this.authored(pageId);
    if (!snapshot) throw new Error("product-authored snapshot is unavailable");
    const priorPageRow = this.catalog(pageId);
    if (!priorPageRow) throw new Error("page not found");
    const parsed = parseOkfConcept(snapshot.content);
    const location = normalizePagePath(this.paths, report.page.relativePath);
    const snapshotPath = this.snapshotPath(report.page);
    const priorSnapshotRow = dbGet<SnapshotRow>(this.db, "SELECT * FROM authored_snapshots WHERE relative_path = ?", [
      report.page.relativePath,
    ]);
    const optionalBytes = async (path: string): Promise<Buffer | undefined> => {
      try {
        return await fs.readFile(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    };
    const priorPageBytes = await fs.readFile(location.absolutePath);
    const priorSnapshotBytes = await optionalBytes(snapshotPath);
    const indexPath = join(this.root(), "index.md");
    const logPath = join(this.root(), "log.md");
    const priorIndexBytes = await optionalBytes(indexPath);
    const priorLogBytes = await optionalBytes(logPath);
    const issue =
      choice === "record-issue"
        ? {
            issueId: randomUUID(),
            pageId,
            pageDigest: snapshot.digest,
            kind: "incorrect" as const,
            description: `Unsupported direct edit restored as issue evidence:\n\n${report.diff}`,
            status: "open" as const,
            createdAt: now(),
            updatedAt: now(),
          }
        : undefined;
    const restore = async (): Promise<void> => {
      const errors: unknown[] = [];
      const attempt = async (action: () => Promise<void> | void): Promise<void> => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => this.atomicWrite(location.absolutePath, priorPageBytes));
      await attempt(async () => {
        if (priorSnapshotBytes === undefined) await fs.rm(snapshotPath, { force: true });
        else await this.atomicWrite(snapshotPath, priorSnapshotBytes);
      });
      await attempt(() => {
        transaction(this.db, () => {
          dbRun(
            this.db,
            "UPDATE pages SET relative_path = ?, title = ?, digest = ?, revision = ?, status = ?, quiz_worthiness = ?, updated_at = ? WHERE page_id = ?",
            [
              priorPageRow.relative_path,
              priorPageRow.title,
              priorPageRow.digest,
              priorPageRow.revision,
              priorPageRow.status,
              priorPageRow.quiz_worthiness,
              priorPageRow.updated_at,
              pageId,
            ],
          );
          dbRun(this.db, "DELETE FROM authored_snapshots WHERE relative_path = ?", [report.page.relativePath]);
          if (priorSnapshotRow)
            dbRun(
              this.db,
              "INSERT OR REPLACE INTO authored_snapshots (relative_path, digest, revision, captured_at, commit_id) VALUES (?, ?, ?, ?, ?)",
              [
                priorSnapshotRow.relative_path,
                priorSnapshotRow.digest,
                priorSnapshotRow.revision,
                priorSnapshotRow.captured_at,
                priorSnapshotRow.commit_id ?? null,
              ],
            );
          if (issue) dbRun(this.db, "DELETE FROM wiki_issues WHERE issue_id = ?", [issue.issueId]);
        });
      });
      await attempt(async () => {
        if (priorIndexBytes === undefined) await fs.rm(indexPath, { force: true });
        else await this.atomicWrite(indexPath, priorIndexBytes);
      });
      await attempt(async () => {
        if (priorLogBytes === undefined) await fs.rm(logPath, { force: true });
        else await this.atomicWrite(logPath, priorLogBytes);
      });
      if (errors.length) {
        const detail = errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ");
        throw new Error(`wiki drift resolution rollback failed: ${detail}`, { cause: errors[0] });
      }
    };
    const updated: WikiPage = {
      ...report.page,
      status: "active",
      digest: snapshot.digest,
      revision: report.page.revision + 1,
      updatedAt: now(),
      title: typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : report.page.title,
    };
    try {
      await this.atomicWrite(location.absolutePath, snapshot.content);
      await this.writeCatalog(updated, snapshot.content);
      await this.refreshProjections();
      await this.refreshQmd();
      if (issue) {
        transaction(this.db, () =>
          dbRun(
            this.db,
            "INSERT INTO wiki_issues (issue_id, page_id, heading, page_digest, kind, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              issue.issueId,
              issue.pageId,
              null,
              issue.pageDigest,
              issue.kind,
              issue.description,
              issue.status,
              issue.createdAt,
              issue.updatedAt,
            ],
          ),
        );
      }
    } catch (error) {
      try {
        await restore();
      } catch (rollbackError) {
        throw new Error(
          `wiki drift resolution failed and rollback failed: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return { page: updated, ...(issue ? { issue } : {}), restored: true };
  }
  async patchIssue(issueId: string, patch: { status?: WikiIssueStatus; resolution?: string }): Promise<WikiIssue> {
    const current = dbGet<IssueRow>(this.db, "SELECT * FROM wiki_issues WHERE issue_id = ?", [issueId]);
    if (!current) throw new Error("issue not found");
    if (patch.status === "resolved") throw new Error("issue resolution requires a composite maintenance proposal");
    let status = patch.status ?? (current.status as WikiIssueStatus);
    if (status === "open" && (current.status === "resolved" || current.status === "reopened")) status = "reopened";
    const updatedAt = now();
    transaction(this.db, () =>
      dbRun(this.db, "UPDATE wiki_issues SET status = ?, resolution = ?, updated_at = ? WHERE issue_id = ?", [
        status,
        patch.resolution ?? current.resolution ?? null,
        updatedAt,
        issueId,
      ]),
    );
    const updated = dbGet<IssueRow>(this.db, "SELECT * FROM wiki_issues WHERE issue_id = ?", [issueId]);
    if (!updated) throw new Error("issue disappeared after update");
    return rowToIssue(updated);
  }
  async resolveIssueAfterCorrection(issueId: string, resolution: string): Promise<WikiIssue> {
    if (!resolution.trim()) throw new Error("issue resolution is required");
    const current = dbGet<IssueRow>(this.db, "SELECT * FROM wiki_issues WHERE issue_id = ?", [issueId]);
    if (!current) throw new Error("issue not found");
    if (current.status === "resolved") throw new Error("issue is already resolved");
    const updatedAt = now();
    transaction(this.db, () =>
      dbRun(this.db, "UPDATE wiki_issues SET status = ?, resolution = ?, updated_at = ? WHERE issue_id = ?", [
        "resolved",
        resolution,
        updatedAt,
        issueId,
      ]),
    );
    const updated = dbGet<IssueRow>(this.db, "SELECT * FROM wiki_issues WHERE issue_id = ?", [issueId]);
    if (!updated) throw new Error("issue disappeared after update");
    return rowToIssue(updated);
  }
  async refreshProjections(
    write = true,
  ): Promise<{ indexPath: string; logPath: string; backlinks: Record<string, string[]>; lint: string[] }> {
    const pages = (await this.list()).filter((page) => page.status === "active");
    const backlinks: Record<string, string[]> = {};
    const projectionPages: OkfProjectionPage[] = [];
    for (const page of pages) {
      assertPageTitle(page.title);
      const content = (await this.readExact(page.relativePath)).toString("utf8");
      const parsed = parseOkfConcept(content);
      validateOkfConcept(content);
      assertPageTitle(parsed.frontmatter.title);
      projectionPages.push({
        title: page.title,
        path: page.relativePath,
        description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : undefined,
        updatedAt: page.updatedAt,
        digest: page.digest,
      });
      validateMarkdownLinks(this.root(), page.relativePath, parsed.body);
      for (const target of linksFromMarkdown(parsed.body)) {
        const resolved = resolveWikiLink(this.root(), page.relativePath, target);
        const backlinksForTarget = backlinks[resolved] ?? [];
        backlinks[resolved] = backlinksForTarget;
        backlinksForTarget.push(page.relativePath);
      }
    }
    for (const list of Object.values(backlinks)) list.sort();
    const indexBody = renderOkfIndex(projectionPages);
    const logBody = renderOkfLog(projectionPages);
    const indexPath = join(this.root(), "index.md");
    const logPath = join(this.root(), "log.md");
    if (write) {
      await this.atomicWrite(indexPath, indexBody);
      await this.atomicWrite(logPath, logBody);
    }
    return { indexPath, logPath, backlinks, lint: this.lintSync(pages, backlinks) };
  }
  lintSync(pages: WikiPage[] = [], backlinks: Record<string, string[]> = {}): string[] {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      if (seen.has(page.pageId)) errors.push(`duplicate page ID: ${page.pageId}`);
      seen.add(page.pageId);
      if (!page.relativePath.endsWith(".md")) errors.push(`invalid page path: ${page.relativePath}`);
      try {
        const content = readFileSync(join(this.root(), page.relativePath), "utf8");
        assertInertMarkdown(content);
        const parsed = parseOkfConcept(content);
        validateOkfConcept(content);
        const parsedId = parsed.frontmatter.id;
        if (parsedId !== page.pageId || typeof parsedId !== "string" || !ID.test(parsedId))
          errors.push(`${page.relativePath}: stable page ID mismatch`);
        for (const field of ["title", "type", "created", "updated"]) {
          const value = parsed.frontmatter[field];
          if (typeof value !== "string" || !value.trim()) errors.push(`${page.relativePath}: missing ${field}`);
        }
        if (digest(content) !== page.digest) errors.push(`${page.relativePath}: catalog digest mismatch`);
      } catch (error) {
        errors.push(`${page.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [target, sources] of Object.entries(backlinks))
      if (!target.endsWith(".md")) errors.push(`invalid backlink target: ${target}`);
      else if (new Set(sources).size !== sources.length) errors.push(`duplicate backlink source: ${target}`);
    return errors;
  }
}
export function parseWikiMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
  return parseOkfConcept(content);
}
export function serializeWikiMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  assertInertMarkdown(body);
  return serializeOkfConcept(frontmatter, body);
}

export function sanitizeImportedMarkdown(value: string): string {
  return value
    .replace(/<\s*(script|style|iframe|object|embed|form|base|meta|link)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu, "")
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|base|meta|link)\b[^>]*>/giu, (tag) =>
      tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    )
    .replace(/\bon[a-z][a-z0-9:_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/giu, "")
    .replace(/\b(?:javascript|vbscript)\s*:/giu, "")
    .replace(
      /\bdata\s*:\s*(?:text\/html|text\/javascript|application\/(?:javascript|x-javascript)|image\/svg\+xml)\b/giu,
      "",
    );
}
