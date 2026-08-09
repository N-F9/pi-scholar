import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { safeRelativePath, type VaultPaths } from './vault.js';
import { transaction, type ScholarDatabase, type SqlRow, type SqlRunResult } from './database.js';
import { qmdCollectionName } from './external/qmd.js';
import type { WikiIssueRecord } from './contracts.js';

export type WikiIssueKind = 'incorrect' | 'unclear' | 'missing' | 'bad-boundary';
export type WikiIssueStatus = 'open' | 'resolved' | 'reopened';
export interface WikiPage { pageId: string; relativePath: string; title: string; digest: string; revision: number; status: 'active' | 'drifted' | 'retired'; quizWorthiness: 'eligible' | 'skip' | 'unknown'; updatedAt: string; body?: string }
export interface WikiPageInput { path: string; title?: string; body: string; pageId?: string; quizWorthiness?: 'eligible' | 'skip' | 'unknown' }
export type DriftResolution = 'record-issue' | 'restore';
export interface QmdAdapter { search(query: string, options?: { collection: string; scope: 'wiki/**/*.md'; limit?: number }): Promise<unknown> | unknown }
export interface WikiAdapters { qmd?: QmdAdapter; commit?: () => Promise<boolean> | boolean; doctor?: () => Promise<boolean> | boolean; lint?: () => Promise<boolean> | boolean }
export interface WikiCreateResult { page: WikiPage; content: string }
export interface DriftReport { page: WikiPage; drifted: boolean; authoredDigest: string; currentDigest: string; diff: string; choices: ['record-issue', 'restore'] }
export interface WikiSearchOptions { mode?: 'semantic' | 'lexical' | 'exact'; limit?: number }
export type WikiIssue = WikiIssueRecord;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROJECTION_NAMES = new Set(['index.md', 'log.md']);
const BLOCKED_TAG = /<\s*\/?\s*(script|style|iframe|object|embed|form|base|meta|link)(?:\s|\/?>)/iu;
const EVENT_ATTRIBUTE = /\bon[a-z][a-z0-9:_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/iu;
const DANGEROUS_URI = /\b(?:javascript|vbscript)\s*:/iu;
const DANGEROUS_DATA = /\bdata\s*:\s*(?:text\/html|text\/javascript|application\/(?:javascript|x-javascript)|image\/svg\+xml)\b/iu;

type PageRow = SqlRow;
type SnapshotRow = SqlRow;
type IssueRow = SqlRow;
function dbRun(db: ScholarDatabase, sql: string, params: unknown[] = []): SqlRunResult { return db.run(sql, params) }
function dbGet<T = SqlRow>(db: ScholarDatabase, sql: string, params: unknown[] = []): T | undefined { return db.get<T>(sql, params) }
function dbAll<T = SqlRow>(db: ScholarDatabase, sql: string, params: unknown[] = []): T[] { return db.all<T>(sql, params) }
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function now(): string { return new Date().toISOString() }
function vaultRoot(paths: Partial<VaultPaths> & { root?: string }): string {
  const root = paths.wikiRoot ?? (paths.root ? join(paths.root, 'wiki') : undefined);
  if (!root) throw new Error('wiki root is required');
  return root;
}
function normalizePagePath(paths: Partial<VaultPaths> & { root?: string }, requested: string): { relativePath: string; absolutePath: string } {
  if (!requested.endsWith('.md')) throw new Error('wiki pages must use .md');
  const root = vaultRoot(paths);
  const absolute = safeRelativePath(root, requested);
  const relativePath = relative(root, absolute).replaceAll('\\', '/');
  if (relativePath.split('/').some((part) => part === '.snapshots') || PROJECTION_NAMES.has(relativePath) || PROJECTION_NAMES.has(relativePath.split('/').at(-1) ?? '')) throw new Error('reserved wiki path');
  return { relativePath, absolutePath: absolute };
}
function yamlValue(value: string): string { return JSON.stringify(value) }
export function isExecutableHtml(value: string): boolean { return BLOCKED_TAG.test(value) || EVENT_ATTRIBUTE.test(value) || DANGEROUS_URI.test(value) || DANGEROUS_DATA.test(value) }
function assertInertMarkdown(body: string): void { if (isExecutableHtml(body)) throw new Error('raw executable HTML is not allowed in wiki Markdown') }
function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  if (!content.startsWith('---\n')) throw new Error('wiki page requires frontmatter');
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('unterminated wiki frontmatter');
  const fields: Record<string, string> = {};
  for (const line of content.slice(4, end).split('\n')) {
    if (!line) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*)(.*)$/u.exec(line);
    if (!match) throw new Error('invalid wiki frontmatter');
    const key = match[1];
    if (key === undefined || key in fields) throw new Error('invalid wiki frontmatter');
    let value = match[2] ?? '';
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) as string } catch { throw new Error('invalid wiki frontmatter value') }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error('invalid wiki frontmatter value');
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    fields[key] = value;
  }
  return { fields, body: content.slice(end + 5) };
}
function serializePage(pageId: string, title: string, body: string, quizWorthiness: string, createdAt: string, updatedAt: string): string {
  assertInertMarkdown(body);
  return `---\nid: ${yamlValue(pageId)}\ntitle: ${yamlValue(title)}\ntype: note\ncreated: ${yamlValue(createdAt)}\nupdated: ${yamlValue(updatedAt)}\nquiz-worthiness: ${yamlValue(quizWorthiness)}\n---\n${body.endsWith('\n') ? body : `${body}\n`}`;
}
function rowToPage(row: PageRow, body?: string): WikiPage {
  const page: WikiPage = {
    pageId: String(row.page_id ?? row.pageId ?? row.id),
    relativePath: String(row.relative_path ?? row.relativePath ?? row.path),
    title: String(row.title ?? ''),
    digest: String(row.digest ?? ''),
    revision: Number(row.revision ?? 1),
    status: (row.status ?? 'active') as WikiPage['status'],
    quizWorthiness: (row.quiz_worthiness ?? row.quizWorthiness ?? 'unknown') as WikiPage['quizWorthiness'],
    updatedAt: String(row.updated_at ?? row.updatedAt ?? ''),
  };
  if (body !== undefined) page.body = body;
  return page;
}
function rowToIssue(row: IssueRow): WikiIssue {
  return {
    issueId: String(row.issue_id),
    pageId: typeof row.page_id === 'string' ? row.page_id : undefined,
    heading: typeof row.heading === 'string' ? row.heading : undefined,
    cardId: typeof row.card_id === 'string' ? row.card_id : undefined,
    pageDigest: typeof row.page_digest === 'string' ? row.page_digest : undefined,
    kind: row.kind as WikiIssueKind,
    description: String(row.description),
    status: row.status as WikiIssueStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    resolution: typeof row.resolution === 'string' ? row.resolution : undefined,
  };
}
function linksFromMarkdown(body: string): string[] {
  const links: string[] = [];
  const pattern = /!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
  for (const match of body.matchAll(pattern)) {
    const target = match[1];
    if (!target || target.startsWith('#') || /^https?:\/\//iu.test(target)) continue;
    links.push(target.split('#', 1)[0] ?? target);
  }
  return links;
}
function titleFromPath(path: string): string {
  const name = path.split('/').at(-1)?.replace(/\.md$/iu, '') ?? path;
  return name.replace(/[-_]+/gu, ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
function simpleDiff(before: string, after: string): string {
  const left = before.split(/\r?\n/u);
  const right = after.split(/\r?\n/u);
  return ['--- authored', '+++ current', ...left.map((line) => `- ${line}`), ...right.map((line) => `+ ${line}`)].join('\n');
}
function positiveLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('search limit must be between 1 and 100');
  return value;
}

export class WikiService {
  readonly db: ScholarDatabase;
  readonly paths: Partial<VaultPaths> & { root?: string };
  readonly adapters: WikiAdapters;
  constructor(db: ScholarDatabase, paths: Partial<VaultPaths> & { root?: string }, adapters: WikiAdapters = {}) { this.db = db; this.paths = paths; this.adapters = adapters }
  private root(): string { return vaultRoot(this.paths) }
  private async atomicWrite(path: string, content: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, content, { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, path);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  private catalog(pageId: string): PageRow | undefined { return dbGet<PageRow>(this.db, 'SELECT * FROM pages WHERE page_id = ?', [pageId]); }
  private catalogByPath(path: string): PageRow | undefined { return dbGet<PageRow>(this.db, 'SELECT * FROM pages WHERE relative_path = ?', [path]); }
  private snapshotPath(page: WikiPage): string { return join(this.root(), '.snapshots', `${page.pageId}.md`) }
  private authored(pageId: string): { digest: string; revision: number; content: string } | undefined {
    const row = this.catalog(pageId);
    if (!row) return undefined;
    const snapshot = dbGet<SnapshotRow>(this.db, 'SELECT * FROM authored_snapshots WHERE relative_path = ?', [row.relative_path]);
    if (!snapshot) return undefined;
    const path = typeof snapshot.commit_id === 'string' && snapshot.commit_id.startsWith('file:') ? snapshot.commit_id.slice(5) : this.snapshotPath(rowToPage(row));
    return { digest: String(snapshot.digest), revision: Number(snapshot.revision), content: readFileSync(path, 'utf8') };
  }
  private async writeCatalog(page: WikiPage, content: string, previousPath?: string): Promise<void> {
    const snapshot = this.snapshotPath(page);
    await this.atomicWrite(snapshot, content);
    transaction(this.db, () => {
      const existing = this.catalog(page.pageId);
      const createdAt = existing ? String(existing.created_at) : page.updatedAt;
      if (existing) dbRun(this.db, 'UPDATE pages SET relative_path = ?, title = ?, digest = ?, revision = ?, status = ?, quiz_worthiness = ?, updated_at = ? WHERE page_id = ?', [page.relativePath, page.title, page.digest, page.revision, page.status, page.quizWorthiness, page.updatedAt, page.pageId]);
      else dbRun(this.db, 'INSERT INTO pages (page_id, relative_path, title, digest, revision, status, quiz_worthiness, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [page.pageId, page.relativePath, page.title, page.digest, page.revision, page.status, page.quizWorthiness, createdAt, page.updatedAt]);
      if (previousPath && previousPath !== page.relativePath) dbRun(this.db, 'DELETE FROM authored_snapshots WHERE relative_path = ?', [previousPath]);
      dbRun(this.db, 'INSERT OR REPLACE INTO authored_snapshots (relative_path, digest, revision, captured_at, commit_id) VALUES (?, ?, ?, ?, ?)', [page.relativePath, page.digest, page.revision, page.updatedAt, `file:${snapshot}`]);
    });
  }
  async create(input: WikiPageInput): Promise<WikiCreateResult> {
    const location = normalizePagePath(this.paths, input.path);
    if (this.catalogByPath(location.relativePath)) throw new Error('wiki path already exists');
    if (input.pageId) throw new Error('page ID is host-minted');
    const pageId = randomUUID();
    const createdAt = now();
    const title = input.title ?? titleFromPath(location.relativePath);
    const content = serializePage(pageId, title, input.body, input.quizWorthiness ?? 'unknown', createdAt, createdAt);
    await this.atomicWrite(location.absolutePath, content);
    const page: WikiPage = { pageId, relativePath: location.relativePath, title, digest: digest(content), revision: 1, status: 'active', quizWorthiness: input.quizWorthiness ?? 'unknown', updatedAt: createdAt };
    await this.writeCatalog(page, content);
    await this.refreshProjections();
    return { page, content };
  }
  async update(pageId: string, input: { body?: string; title?: string; quizWorthiness?: WikiPage['quizWorthiness']; expectedDigest?: string; path?: string }): Promise<WikiCreateResult> {
    const row = this.catalog(pageId);
    if (!row) throw new Error('page not found');
    const page = rowToPage(row);
    const location = normalizePagePath(this.paths, input.path ?? page.relativePath);
    if (location.relativePath !== page.relativePath) throw new Error('page path changes must use rename');
    const current = await fs.readFile(location.absolutePath, 'utf8');
    const parsed = parseFrontmatter(current);
    if (parsed.fields.id !== pageId) throw new Error('page ID mismatch');
    const expected = input.expectedDigest ?? page.digest;
    if (expected !== digest(current)) throw new Error('page changed since it was read');
    const updatedAt = now();
    const content = serializePage(pageId, input.title ?? parsed.fields.title ?? page.title, input.body ?? parsed.body, input.quizWorthiness ?? page.quizWorthiness, parsed.fields.created ?? updatedAt, updatedAt);
    await this.atomicWrite(location.absolutePath, content);
    const updated: WikiPage = { ...page, title: input.title ?? page.title, digest: digest(content), revision: page.revision + 1, status: 'active', quizWorthiness: input.quizWorthiness ?? page.quizWorthiness, updatedAt };
    await this.writeCatalog(updated, content);
    await this.refreshProjections();
    return { page: updated, content };
  }
  async rename(pageId: string, requestedPath: string): Promise<WikiPage> {
    const row = this.catalog(pageId);
    if (!row) throw new Error('page not found');
    const page = rowToPage(row);
    const from = normalizePagePath(this.paths, page.relativePath);
    const to = normalizePagePath(this.paths, requestedPath);
    if (this.catalogByPath(to.relativePath)) throw new Error('wiki path already exists');
    const content = await fs.readFile(from.absolutePath, 'utf8');
    const parsed = parseFrontmatter(content);
    if (parsed.fields.id !== pageId) throw new Error('page ID mismatch');
    await fs.mkdir(dirname(to.absolutePath), { recursive: true, mode: 0o700 });
    await fs.rename(from.absolutePath, to.absolutePath);
    const updated: WikiPage = { ...page, relativePath: to.relativePath, revision: page.revision + 1, updatedAt: now(), status: 'active' };
    try {
      await this.writeCatalog(updated, content, page.relativePath);
      await fs.rm(this.snapshotPath(page), { force: true });
    } catch (error) {
      await fs.rename(to.absolutePath, from.absolutePath).catch(() => undefined);
      throw error;
    }
    await this.refreshProjections();
    return updated;
  }
  async readExact(requestedPath: string): Promise<Buffer> { const location = normalizePagePath(this.paths, requestedPath); return fs.readFile(location.absolutePath) }
  async semanticSearch(query: string, limit?: number): Promise<unknown[]> { return this.search(query, { mode: 'semantic', limit }) }
  async lexicalSearch(query: string, limit?: number): Promise<unknown[]> { return this.search(query, { mode: 'lexical', limit }) }
  async get(pageIdOrPath: string): Promise<WikiPage & { content: string }> {
    const row = ID.test(pageIdOrPath) ? this.catalog(pageIdOrPath) : this.catalogByPath(pageIdOrPath);
    if (!row) throw new Error('page not found');
    const page = rowToPage(row);
    const content = (await this.readExact(page.relativePath)).toString('utf8');
    return { ...page, content };
  }
  async list(): Promise<WikiPage[]> { return dbAll<PageRow>(this.db, "SELECT * FROM pages WHERE status != 'retired' ORDER BY relative_path, page_id").map((row) => rowToPage(row)); }
  private qmdPath(value: unknown): string | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const path = (value as Record<string, unknown>).path;
    return typeof path === 'string' ? path.replaceAll('\\', '/') : undefined;
  }
  private async search(query: string, options: WikiSearchOptions): Promise<unknown[]> {
    if (!query.trim()) throw new Error('search query is required');
    const limit = positiveLimit(options.limit);
    const mode = options.mode ?? 'semantic';
    if (mode === 'semantic') {
      if (!this.adapters.qmd) throw new Error('semantic search unavailable: qmd adapter not configured');
      const vaultId = this.paths.vaultId;
      if (!vaultId) throw new Error('qmd search requires vault identity');
      const result = await this.adapters.qmd.search(query, { collection: qmdCollectionName(vaultId), scope: 'wiki/**/*.md', limit });
      if (!Array.isArray(result)) throw new Error('qmd returned malformed search results');
      const filtered: unknown[] = [];
      for (const item of result) {
        const path = this.qmdPath(item);
        if (!path || path.includes('.snapshots/')) continue;
        const normalized = path.startsWith('wiki/') ? path.slice('wiki/'.length) : path;
        const row = this.catalogByPath(normalized);
        if (row?.status === 'drifted' || row?.status === 'retired') continue;
        filtered.push(item);
        if (limit !== undefined && filtered.length >= limit) break;
      }
      return filtered;
    }
    if (mode === 'exact') {
      const row = ID.test(query) ? this.catalog(query) : this.catalogByPath(query);
      return row ? [await this.get(row.page_id as string)] : [];
    }
    const needle = query.toLocaleLowerCase();
    const result: Array<{ page: WikiPage; matches: number[]; snippets: string[] }> = [];
    for (const page of await this.list()) {
      if (page.status !== 'active') continue;
      const content = await this.get(page.pageId);
      const lines = content.content.split('\n');
      const matches = lines.flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [index] : []);
      if (matches.length) result.push({ page, matches, snippets: matches.map((index) => lines[index] ?? '') });
      if (limit !== undefined && result.length >= limit) break;
    }
    return result;
  }
  async report(input: { pageId?: string; heading?: string; cardId?: string; pageDigest?: string; kind?: WikiIssueKind; description: string }): Promise<WikiIssue> {
    if (!input.description.trim()) throw new Error('issue description is required');
    const page = input.pageId ? this.catalog(input.pageId) : undefined;
    if (input.pageId && !page) throw new Error('page not found');
    if (input.heading !== undefined && !input.heading.trim()) throw new Error('issue heading is required when provided');
    const createdAt = now();
    const issue: WikiIssue = { issueId: randomUUID(), pageId: input.pageId, heading: input.heading, cardId: input.cardId, pageDigest: input.pageDigest ?? (page ? String(page.digest) : undefined), kind: input.kind ?? 'incorrect', description: input.description, status: 'open', createdAt, updatedAt: createdAt };
    transaction(this.db, () => dbRun(this.db, 'INSERT INTO wiki_issues (issue_id, page_id, heading, card_id, page_digest, kind, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [issue.issueId, issue.pageId ?? null, issue.heading ?? null, issue.cardId ?? null, issue.pageDigest ?? null, issue.kind, issue.description, issue.status, issue.createdAt, issue.updatedAt]));
    return issue;
  }
  async inspectDrift(pageId: string): Promise<DriftReport> {
    const page = await this.get(pageId);
    const snapshot = this.authored(pageId);
    if (!snapshot) throw new Error('product-authored snapshot is unavailable');
    const authoredDigest = snapshot.digest;
    const currentDigest = digest(page.content);
    const drifted = authoredDigest !== currentDigest;
    transaction(this.db, () => dbRun(this.db, 'UPDATE pages SET status = ?, updated_at = ? WHERE page_id = ?', [drifted ? 'drifted' : page.status === 'retired' ? 'retired' : 'active', now(), pageId]));
    const currentPage = { ...page, status: drifted ? 'drifted' as const : page.status === 'retired' ? 'retired' as const : 'active' as const };
    return { page: currentPage, drifted, authoredDigest, currentDigest, diff: drifted ? simpleDiff(snapshot.content, page.content) : '', choices: ['record-issue', 'restore'] };
  }
  async resolveDrift(pageId: string, choice: DriftResolution): Promise<{ page: WikiPage; issue?: WikiIssue; restored: true }> {
    if (choice !== 'record-issue' && choice !== 'restore') throw new Error('unsupported drift resolution');
    const report = await this.inspectDrift(pageId);
    if (!report.drifted) return { page: report.page, restored: true };
    const snapshot = this.authored(pageId);
    if (!snapshot) throw new Error('product-authored snapshot is unavailable');
    const parsed = parseFrontmatter(snapshot.content);
    const location = normalizePagePath(this.paths, report.page.relativePath);
    await this.atomicWrite(location.absolutePath, snapshot.content);
    const updated: WikiPage = { ...report.page, status: 'active', digest: snapshot.digest, revision: report.page.revision + 1, updatedAt: now(), title: parsed.fields.title ?? report.page.title };
    await this.writeCatalog(updated, snapshot.content);
    await this.refreshProjections();
    const issue = choice === 'record-issue' ? await this.report({ pageId, pageDigest: report.currentDigest, kind: 'incorrect', description: `Unsupported direct edit restored as issue evidence:\n\n${report.diff}` }) : undefined;
    return { page: updated, ...(issue ? { issue } : {}), restored: true };
  }
  async patchIssue(issueId: string, patch: { status?: WikiIssueStatus; resolution?: string; guardedEdit?: boolean; cardUpdated?: boolean; qmdRefreshed?: boolean; lintPassed?: boolean; doctorPassed?: boolean; logRefreshed?: boolean; committed?: boolean }): Promise<WikiIssue> {
    const current = dbGet<IssueRow>(this.db, 'SELECT * FROM wiki_issues WHERE issue_id = ?', [issueId]);
    if (!current) throw new Error('issue not found');
    let status = patch.status ?? current.status as WikiIssueStatus;
    if (status === 'open' && (current.status === 'resolved' || current.status === 'reopened')) status = 'reopened';
    if (status === 'resolved' && !(patch.guardedEdit && patch.cardUpdated && patch.qmdRefreshed && patch.lintPassed && patch.doctorPassed && patch.logRefreshed && patch.committed)) throw new Error('issue resolution prerequisites are incomplete');
    const updatedAt = now();
    transaction(this.db, () => dbRun(this.db, 'UPDATE wiki_issues SET status = ?, resolution = ?, updated_at = ? WHERE issue_id = ?', [status, patch.resolution ?? current.resolution ?? null, updatedAt, issueId]));
    const updated = dbGet<IssueRow>(this.db, 'SELECT * FROM wiki_issues WHERE issue_id = ?', [issueId]);
    if (!updated) throw new Error('issue disappeared after update');
    return rowToIssue(updated);
  }
  async refreshProjections(): Promise<{ indexPath: string; logPath: string; backlinks: Record<string, string[]>; lint: string[] }> {
    const pages = (await this.list()).filter((page) => page.status === 'active');
    const backlinks: Record<string, string[]> = {};
    for (const page of pages) {
      const content = (await this.readExact(page.relativePath)).toString('utf8');
      for (const target of linksFromMarkdown(content)) {
        const pageDirectory = dirname(page.relativePath);
        const candidate = normalize(join(pageDirectory, target)).replaceAll('\\', '/');
        const resolved = relative(this.root(), safeRelativePath(this.root(), candidate)).replaceAll('\\', '/');
        (backlinks[resolved] ??= []).push(page.relativePath);
      }
    }
    for (const list of Object.values(backlinks)) list.sort();
    const indexBody = ['# Wiki index', '', ...pages.map((page) => `- [${page.title}](${page.relativePath}) — ${page.pageId}`), ''].join('\n');
    const logBody = ['# Wiki log', '', ...pages.map((page) => `- ${page.updatedAt} ${page.relativePath} ${page.digest}`), ''].join('\n');
    const indexPath = join(this.root(), 'index.md');
    const logPath = join(this.root(), 'log.md');
    await this.atomicWrite(indexPath, indexBody);
    await this.atomicWrite(logPath, logBody);
    return { indexPath, logPath, backlinks, lint: this.lintSync(pages, backlinks) };
  }
  lintSync(pages: WikiPage[] = [], backlinks: Record<string, string[]> = {}): string[] {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      if (seen.has(page.pageId)) errors.push(`duplicate page ID: ${page.pageId}`);
      seen.add(page.pageId);
      if (!page.relativePath.endsWith('.md')) errors.push(`invalid page path: ${page.relativePath}`);
      try {
        const content = readFileSync(join(this.root(), page.relativePath), 'utf8');
        assertInertMarkdown(content);
        const parsed = parseFrontmatter(content);
        if (parsed.fields.id !== page.pageId || !ID.test(parsed.fields.id)) errors.push(`${page.relativePath}: stable page ID mismatch`);
        for (const field of ['title', 'type', 'created', 'updated']) if (!parsed.fields[field]) errors.push(`${page.relativePath}: missing ${field}`);
        if (digest(content) !== page.digest) errors.push(`${page.relativePath}: catalog digest mismatch`);
      } catch (error) { errors.push(`${page.relativePath}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    for (const [target, sources] of Object.entries(backlinks)) if (!target.endsWith('.md')) errors.push(`invalid backlink target: ${target}`); else if (new Set(sources).size !== sources.length) errors.push(`duplicate backlink source: ${target}`);
    return errors;
  }
}

export function parseWikiMarkdown(content: string): { fields: Record<string, string>; body: string } { return parseFrontmatter(content) }
export function serializeWikiMarkdown(pageId: string, title: string, body: string, quizWorthiness = 'unknown', createdAt = now(), updatedAt = createdAt): string { if (!ID.test(pageId)) throw new Error('page ID must be host-minted UUID'); return serializePage(pageId, title, body, quizWorthiness, createdAt, updatedAt) }
export function sanitizeImportedMarkdown(value: string): string {
  return value
    .replace(/<\s*(script|style|iframe|object|embed|form|base|meta|link)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu, '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|base|meta|link)\b[^>]*>/giu, (tag) => tag.replaceAll('<', '&lt;').replaceAll('>', '&gt;'))
    .replace(/\bon[a-z][a-z0-9:_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/giu, '')
    .replace(/\b(?:javascript|vbscript)\s*:/giu, '')
    .replace(/\bdata\s*:\s*(?:text\/html|text\/javascript|application\/(?:javascript|x-javascript)|image\/svg\+xml)\b/giu, '');
}
