import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, promises as fs, readFileSync, type Stats } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeRelativePath, type VaultPaths } from './vault.js';
import { transaction, type ScholarDatabase, type SqlRow, type SqlRunResult } from './database.js';
import type { SourceKind as ContractSourceKind, SourceManifest as ContractSourceManifest } from './contracts.js';
import type { DoclingResult as ExternalDoclingResult } from './external/docling.js';

export interface VaultPathsLike extends Partial<VaultPaths> {
  root?: string;
  inbox?: string;
  sources?: string;
  work?: string;
  [key: string]: unknown;
}
export type SourceKind = ContractSourceKind;
export type InputKind = SourceKind | 'upload' | 'pasted';
export interface StageMetadata {
  version: 1;
  requestedKind: InputKind;
  kind: SourceKind;
  displayName: string;
  originalName?: string;
  sourceUri?: string;
  mediaType?: string;
  payload: 'payload';
}
export interface SourceStageRequest {
  kind?: InputKind;
  path?: string;
  filePath?: string;
  url?: string;
  text?: string;
  bytes?: Uint8Array;
  name?: string;
  displayName?: string;
  mediaType?: string;
  originalName?: string;
}
export interface FileSnapshot { path: string; size: number; digest: string; bytes: Buffer }
export interface PhysicalIdentity { device: string; inode: string; mode: number; size: number; mtimeNs: string }
export interface TreeSnapshot {
  root: string;
  relativePath: string;
  kind: SourceKind;
  identity: PhysicalIdentity;
  digest: string;
  bytes: number;
  files: FileSnapshot[];
  revision?: string;
  metadata?: StageMetadata;
}
export interface InboxEntry {
  relativePath: string;
  absolutePath: string;
  kind: SourceKind;
  identity: PhysicalIdentity;
  digest?: string;
  bytes?: number;
  metadata?: StageMetadata;
  error?: string;
}
export interface SourceClaim { claimId: string; entry: InboxEntry; snapshot: TreeSnapshot; claimedAt: string }
export interface SourceChunk { index: number; startAtom: number; endAtom: number; startByte: number; endByte: number; digest: string; body: Buffer }
export interface SourceManifest extends Omit<ContractSourceManifest, 'converter' | 'files' | 'chunks'> {
  id: string;
  sourceId: string;
  kind: SourceKind;
  displayName: string;
  originalName: string;
  originalUrl?: string;
  sourceUri?: string;
  revision?: string;
  repositoryRevision?: string;
  mediaType?: string;
  inputKind?: InputKind;
  stagedMetadata?: StageMetadata;
  capturedAt: string;
  converter?: { name: string; version: string };
  originalBytes: number;
  originalByteLength: number;
  originalDigest: string;
  extractionBytes: number;
  extractedByteLength: number;
  extractionDigest: string;
  extractedDigest: string;
  files: Array<ContractSourceManifest['files'][number] & { path: string; bytes: number }>;
  chunks: Array<ContractSourceManifest['chunks'][number] & { index: number; startAtom: number; endAtom: number; startByte: number; endByte: number; digest: string; body?: never }>;
}
export interface AdmissionResult { sourceId: string; manifest: SourceManifest; packetPath: string; removedInbox: boolean; claim: SourceClaim }
export interface SourceRemovalPreview { sourceId: string; packetPath: string; currentDigest: string; dependents: Array<Record<string, unknown>>; confirmationId: string }
export interface SourceRemovalResult extends SourceRemovalPreview { removed: boolean }
export interface SourceAdapters {
  docling?: ((input: { claim: SourceClaim; originalPath: string; kind: SourceKind; mediaType?: string }) => Promise<DoclingResult | ExternalDoclingResult> | DoclingResult | ExternalDoclingResult) | { convert(input: { claim: SourceClaim; originalPath: string; kind: SourceKind; mediaType?: string }): Promise<DoclingResult | ExternalDoclingResult> | DoclingResult | ExternalDoclingResult };
  fetchUrl?: (url: string) => Promise<{ bytes: Uint8Array; mediaType?: string; name?: string }>;
  gitRevision?: ((root: string) => Promise<string> | string) | { revision(root: string): Promise<string> | string };
}
export interface DoclingResult { extracted: Uint8Array | string; converter?: { name: string; version?: string }; attachments?: Array<{ path: string; bytes: Uint8Array | string }> }
export interface ChunkPlanEndpoint { endAtom?: number; end?: number; index?: number }

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const ENVELOPE_NAME = '.pi-scholar-source.json';
const execFileAsync = promisify(execFile);
const SOURCE_KINDS: readonly SourceKind[] = ['document', 'url', 'text', 'note', 'code', 'directory', 'repository'];
const INPUT_KINDS: readonly InputKind[] = [...SOURCE_KINDS, 'upload', 'pasted'];

type Row = SqlRow;
function dbRun(db: ScholarDatabase, sql: string, params: unknown[] = []): SqlRunResult { return db.run(sql, params) }
function dbGet<T = Row>(db: ScholarDatabase, sql: string, params: unknown[] = []): T | undefined { return db.get<T>(sql, params) }
function dbAll<T = Row>(db: ScholarDatabase, sql: string, params: unknown[] = []): T[] { return db.all<T>(sql, params) }
function digestBytes(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function canonical(value: unknown): string {
  const normalizeValue = (input: unknown): unknown => {
    if (input === undefined || typeof input === 'function' || typeof input === 'symbol' || typeof input === 'bigint') throw new Error('value cannot be serialized canonically');
    if (input === null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') return input;
    if (input instanceof Uint8Array) return Buffer.from(input).toString('base64');
    if (Array.isArray(input)) return input.map((item) => normalizeValue(item));
    if (typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
        const nested = record[key];
        if (nested !== undefined) normalized[key] = normalizeValue(nested);
      }
      return normalized;
    }
    throw new Error('value cannot be serialized canonically');
  };
  const output = JSON.stringify(normalizeValue(value));
  if (output === undefined) throw new Error('value cannot be serialized canonically');
  return output;
}
function validRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || isAbsolute(value)) throw new Error('invalid relative path');
  const normalized = normalize(value).replaceAll('\\', '/');
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('path traversal');
  return normalized;
}
function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function statIdentity(stat: Stats): PhysicalIdentity {
  const mtimeNs = 'mtimeNs' in stat && typeof stat.mtimeNs === 'bigint' ? stat.mtimeNs.toString() : String(Math.round(stat.mtimeMs * 1_000_000));
  return { device: String(stat.dev), inode: String(stat.ino), mode: stat.mode, size: stat.size, mtimeNs };
}
function pathFor(paths: VaultPathsLike, name: 'inbox' | 'sources' | 'work'): string {
  const explicit = name === 'inbox' ? paths.inbox ?? paths.inboxRoot : name === 'sources' ? paths.sources ?? paths.sourcesRoot : paths.work ?? paths.workRoot;
  if (typeof explicit === 'string') return explicit;
  const root = paths.root ?? paths.vaultRoot;
  if (typeof root !== 'string') throw new Error('vault root is required');
  return join(root, name === 'work' ? '.pi-scholar/work' : name);
}
function wikiPathFor(paths: VaultPathsLike): string {
  const explicit = paths.wikiRoot;
  if (typeof explicit === 'string') return explicit;
  const root = paths.root ?? paths.vaultRoot;
  if (typeof root !== 'string') throw new Error('vault root is required');
  return join(root, 'wiki');
}
function sourceRecord(row: Row): Record<string, unknown> {
  return {
    ...row,
    sourceId: row.source_id,
    displayName: row.display_name,
    originalName: row.original_name,
    sourceUri: row.source_uri,
    repositoryRevision: row.repository_revision,
    manifestPath: row.manifest_path,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
async function lstatNoFollow(path: string): Promise<Stats> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${path}`);
  return stat;
}
async function readNoFollow(path: string): Promise<Buffer> {
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    const bytes = Buffer.from(await handle.readFile());
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('source exceeds 100 MiB limit');
    return bytes;
  } finally {
    await handle.close();
  }
}
async function measurePath(path: string): Promise<number> {
  const stat = await lstatNoFollow(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error(`unsupported filesystem entry: ${path}`);
  let total = 0;
  for (const name of (await fs.readdir(path)).sort((a, b) => a.localeCompare(b))) {
    if (name === '.git') continue;
    total += await measurePath(join(path, name));
    if (total > MAX_SOURCE_BYTES) throw new Error('source exceeds 100 MiB limit');
  }
  return total;
}
async function walkFiles(root: string, current = ''): Promise<FileSnapshot[]> {
  const absolute = join(root, current);
  const stat = await lstatNoFollow(absolute);
  if (stat.isFile()) {
    const bytes = await readNoFollow(absolute);
    return [{ path: current.replaceAll('\\', '/'), size: bytes.byteLength, digest: digestBytes(bytes), bytes }];
  }
  if (!stat.isDirectory()) throw new Error(`unsupported filesystem entry: ${absolute}`);
  const files: FileSnapshot[] = [];
  for (const name of (await fs.readdir(absolute)).sort((a, b) => a.localeCompare(b))) {
    if (current === '' && name === '.git') continue;
    validRelativePath(join(current, name));
    files.push(...await walkFiles(root, join(current, name)));
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SOURCE_BYTES) throw new Error('source exceeds 100 MiB limit');
  }
  return files;
}
function sameIdentity(a: PhysicalIdentity, b: PhysicalIdentity): boolean { return a.device === b.device && a.inode === b.inode && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs }
function ensureWithin(root: string, target: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path escapes vault');
  return targetAbs;
}
function safeChildPath(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target)).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || isAbsolute(rel)) throw new Error('path escapes vault');
  return safeRelativePath(root, rel);
}
function inferKind(path: string, stat?: Stats): SourceKind {
  if (stat?.isDirectory()) return 'directory';
  const ext = extname(path).toLowerCase();
  if (['.pdf', '.epub', '.docx', '.pptx', '.xlsx', '.html', '.htm', '.png', '.jpg', '.jpeg', '.tif', '.tiff'].includes(ext)) return 'document';
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cc', '.sh', '.sql'].includes(ext)) return 'code';
  return 'text';
}
function textualUrl(claim: SourceClaim, mediaType?: string): boolean {
  const media = mediaType?.toLowerCase().split(';', 1)[0];
  if (media && ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'text/xml', 'application/yaml', 'text/yaml'].includes(media)) return true;
  return ['.md', '.markdown', '.txt', '.text', '.json', '.xml', '.csv', '.yaml', '.yml'].includes(extname(claim.entry.metadata?.originalName ?? claim.entry.relativePath).toLowerCase());
}
function treeDigest(files: FileSnapshot[], identity: PhysicalIdentity, revision?: string): string {
  return digestBytes(Buffer.from(canonical({ identity, revision, files: files.map(({ path, size, digest }) => ({ path, size, digest })) })));
}
function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) throw new Error(`invalid source manifest ${key}`);
  return value;
}
function parseMetadata(raw: string): StageMetadata {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown } catch { throw new Error('invalid staged source metadata') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid staged source metadata');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.requestedKind !== 'string' || !INPUT_KINDS.includes(record.requestedKind as InputKind) || typeof record.kind !== 'string' || !SOURCE_KINDS.includes(record.kind as SourceKind) || typeof record.displayName !== 'string' || !record.displayName || /[\u0000-\u001f\u007f]/u.test(record.displayName) || record.payload !== 'payload') throw new Error('invalid staged source metadata');
  const metadata: StageMetadata = { version: 1, requestedKind: record.requestedKind as InputKind, kind: record.kind as SourceKind, displayName: record.displayName, payload: 'payload' };
  for (const key of ['originalName', 'sourceUri', 'mediaType'] as const) {
    const item = record[key];
    if (item !== undefined) {
      if (typeof item !== 'string' || item.includes('\0') || /[\u0000-\u001f\u007f]/u.test(item)) throw new Error('invalid staged source metadata');
      metadata[key] = item;
    }
  }
  validRelativePath(metadata.payload);
  return metadata;
}
async function stagedMetadata(path: string): Promise<StageMetadata | undefined> {
  const stat = await lstatNoFollow(path);
  if (!stat.isDirectory()) return undefined;
  const envelope = join(path, ENVELOPE_NAME);
  try {
    const envelopeStat = await lstatNoFollow(envelope);
    if (!envelopeStat.isFile()) throw new Error('staged source metadata must be a file');
    const metadata = parseMetadata((await readNoFollow(envelope)).toString('utf8'));
    const payload = join(path, metadata.payload);
    const payloadStat = await lstatNoFollow(payload);
    if (!payloadStat.isFile()) throw new Error('staged source payload must be a regular file');
    return metadata;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
async function snapshotPath(path: string, relativePath: string, kind?: SourceKind, revision?: string, metadata?: StageMetadata): Promise<TreeSnapshot> {
  const stat = await lstatNoFollow(path);
  const identity = statIdentity(stat);
  const files = stat.isDirectory() ? await walkFiles(path) : [{ path: basename(path), size: 0, digest: '', bytes: Buffer.alloc(0) }];
  if (!stat.isDirectory()) {
    const first = files[0];
    if (!first) throw new Error('source file snapshot is empty');
    const bytes = await readNoFollow(path);
    first.bytes = bytes;
    first.size = bytes.byteLength;
    first.digest = digestBytes(bytes);
  }
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (bytes > MAX_SOURCE_BYTES) throw new Error('source exceeds 100 MiB limit');
  const finalKind = kind ?? (stat.isDirectory() ? 'directory' : inferKind(path, stat));
  return { root: path, relativePath: validRelativePath(relativePath), kind: finalKind, identity, digest: treeDigest(files, identity, revision), bytes, files, revision, metadata };
}
async function writeTree(root: string, files: FileSnapshot[]): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = ensureWithin(root, join(root, validRelativePath(file.path)));
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await openFile(target, 'wx', 0o600);
    try { await handle.writeFile(file.bytes) } finally { await handle.close() }
  }
}
function atomRows(extracted: Buffer): Array<{ start: number; end: number; bytes: Buffer }> {
  const rows: Array<{ start: number; end: number; bytes: Buffer }> = [];
  let start = 0;
  for (let index = 0; index < extracted.length; index++) if (extracted[index] === 10) { rows.push({ start, end: index + 1, bytes: extracted.subarray(start, index + 1) }); start = index + 1 }
  if (start < extracted.length || rows.length === 0) rows.push({ start, end: extracted.length, bytes: extracted.subarray(start) });
  return rows;
}
export function atomizeExtraction(extracted: string | Uint8Array): Array<{ index: number; startByte: number; endByte: number; body: Buffer }> {
  return atomRows(Buffer.from(extracted)).map((row, index) => ({ index, startByte: row.start, endByte: row.end, body: Buffer.from(row.bytes) }));
}
export function validateChunkEndpoints(extracted: string | Uint8Array, proposed?: Array<number | ChunkPlanEndpoint>): SourceChunk[] {
  const bytes = Buffer.from(extracted);
  const atoms = atomizeExtraction(bytes);
  const raw = proposed?.map((endpoint) => typeof endpoint === 'number' ? endpoint : endpoint.endAtom ?? endpoint.end ?? endpoint.index);
  const endpoints = raw?.length ? raw : [atoms.length];
  for (const endpoint of endpoints) if (endpoint === undefined || !Number.isInteger(endpoint) || endpoint <= 0 || endpoint > atoms.length) throw new Error('chunk endpoints must be increasing atom endpoints');
  const finalEndpoint = endpoints.at(-1);
  if (finalEndpoint !== atoms.length) throw new Error('chunk endpoints must cover the extraction');
  for (let index = 1; index < endpoints.length; index++) {
    const current = endpoints[index];
    const previous = endpoints[index - 1];
    if (current === undefined || previous === undefined || current <= previous) throw new Error('chunk endpoints must be strictly increasing');
  }
  const chunks: SourceChunk[] = [];
  let startAtom = 0;
  for (let index = 0; index < endpoints.length; index++) {
    const endAtom = endpoints[index];
    if (endAtom === undefined) throw new Error('chunk endpoint is missing');
    const start = atoms[startAtom];
    const end = atoms[endAtom - 1];
    if (!start || !end) throw new Error('chunk endpoint is outside extraction');
    const body = Buffer.from(bytes.subarray(start.startByte, end.endByte));
    chunks.push({ index, startAtom, endAtom, startByte: start.startByte, endByte: end.endByte, digest: digestBytes(body), body });
    startAtom = endAtom;
  }
  return chunks;
}
export function reconstructChunks(chunks: Array<Pick<SourceChunk, 'body'>>): Buffer { return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.body))) }

function isLocalDoclingResult(result: DoclingResult | ExternalDoclingResult): result is DoclingResult {
  return typeof result === 'object' && result !== null && !Array.isArray(result) && 'extracted' in result;
}
async function normalizeDoclingResult(result: DoclingResult | ExternalDoclingResult): Promise<DoclingResult> {
  if (isLocalDoclingResult(result)) return result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('invalid Docling result');
  const record = result as unknown as Record<string, unknown>;
  if (typeof record.outputDirectory !== 'string' || record.command === null || typeof record.command !== 'object' || Array.isArray(record.command)) throw new Error('invalid Docling result');
  const command = record.command as Record<string, unknown>;
  if (typeof command.code === 'number' && command.code !== 0) throw new Error(`Docling conversion failed with exit code ${command.code}`);
  const files = await walkFiles(record.outputDirectory);
  const extracted = files.find((file) => ['.md', '.markdown', '.txt'].includes(extname(file.path).toLowerCase()));
  if (!extracted) throw new Error('Docling produced no Markdown or text output');
  return { extracted: extracted.bytes, converter: { name: 'docling', version: 'unknown' }, attachments: files.filter((file) => file.path !== extracted.path).map((file) => ({ path: file.path, bytes: file.bytes })) };
}
function parseManifest(packet: string): SourceManifest {
  const manifestPath = join(packet, 'manifest.json');
  const stat = lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('source manifest must be a regular file');
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid source manifest');
  const record = raw as Record<string, unknown>;
  requiredString(record, 'sourceId');
  requiredString(record, 'originalDigest');
  if (!Array.isArray(record.files) || !Array.isArray(record.chunks)) throw new Error('invalid source manifest files');
  return raw as SourceManifest;
}

async function copyPathNoFollow(source: string, target: string): Promise<void> {
  const stat = await lstatNoFollow(source);
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink()) throw new Error(`symlink rejected: ${target}`);
    throw new Error(`staging target already exists: ${target}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
  }
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: false, mode: 0o700 });
    for (const name of (await fs.readdir(source)).sort((left, right) => left.localeCompare(right))) {
      validRelativePath(name);
      await copyPathNoFollow(join(source, name), join(target, name));
    }
    return;
  }
  const bytes = await readNoFollow(source);
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await openFile(target, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

export class SourceService {
  readonly db: ScholarDatabase;
  readonly paths: VaultPathsLike;
  readonly adapters: SourceAdapters;
  constructor(db: ScholarDatabase, paths: VaultPathsLike, adapters: SourceAdapters = {}) { this.db = db; this.paths = paths; this.adapters = adapters }
  private inbox(): string { return pathFor(this.paths, 'inbox') }
  private sources(): string { return pathFor(this.paths, 'sources') }
  private work(): string { return pathFor(this.paths, 'work') }
  private async defaultFetch(url: URL): Promise<{ bytes: Uint8Array; mediaType?: string; name?: string }> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`source fetch failed: ${response.status}`);
    const advertised = Number(response.headers.get('content-length') ?? 0);
    if (advertised > MAX_SOURCE_BYTES) throw new Error('source exceeds 100 MiB limit');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('source exceeds 100 MiB limit');
    return { bytes, mediaType: response.headers.get('content-type') ?? undefined, name: basename(url.pathname) || undefined };
  }
  private async stageEnvelope(metadata: StageMetadata, bytes: Uint8Array): Promise<{ relativePath: string; absolutePath: string; kind: SourceKind; metadata: StageMetadata }> {
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('source exceeds 100 MiB limit');
    const name = `${randomUUID()}.pi-scholar`;
    const target = safeRelativePath(this.inbox(), name);
    await fs.mkdir(target, { recursive: false, mode: 0o700 });
    try {
      const metadataPath = join(target, ENVELOPE_NAME);
      const payloadPath = join(target, metadata.payload);
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(payloadPath, Buffer.from(bytes), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      throw error;
    }
    return { relativePath: name, absolutePath: target, kind: metadata.kind, metadata };
  }
  async stage(request: SourceStageRequest): Promise<{ relativePath: string; absolutePath: string; kind: SourceKind; metadata?: StageMetadata }> {
    if (request.url) {
      const parsed = new URL(request.url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('only credential-free HTTP(S) URLs are accepted');
      const fetched = this.adapters.fetchUrl ? await this.adapters.fetchUrl(parsed.toString()) : await this.defaultFetch(parsed);
      if (fetched.bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('source exceeds 100 MiB limit');
      const rawName = request.name ?? fetched.name ?? (basename(parsed.pathname) || 'source.txt');
      const originalName = validRelativePath(request.originalName ?? rawName);
      const displayName = request.displayName ?? originalName;
      const mediaType = request.mediaType ?? fetched.mediaType;
      if (/[\u0000-\u001f\u007f]/u.test(displayName) || (mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(mediaType))) throw new Error('invalid staged source metadata');
      const metadata: StageMetadata = { version: 1, requestedKind: request.kind ?? 'url', kind: 'url', displayName, originalName, sourceUri: parsed.toString(), mediaType, payload: 'payload' };
      return this.stageEnvelope(metadata, fetched.bytes);
    }
    if (request.text !== undefined || request.bytes !== undefined) {
      const rawName = request.name ?? 'source.txt';
      const originalName = validRelativePath(request.originalName ?? rawName);
      const requestedKind = request.kind ?? 'pasted';
      const kind: SourceKind = requestedKind === 'upload' ? inferKind(originalName) : requestedKind === 'pasted' ? 'text' : SOURCE_KINDS.includes(requestedKind as SourceKind) ? requestedKind as SourceKind : (() => { throw new Error('invalid staged source kind') })();
      const bytes = Buffer.from(request.bytes ?? Buffer.from(request.text ?? '', 'utf8'));
      const displayName = request.displayName ?? originalName;
      if (/[\u0000-\u001f\u007f]/u.test(displayName) || (request.mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(request.mediaType))) throw new Error('invalid staged source metadata');
      const metadata: StageMetadata = { version: 1, requestedKind, kind, displayName, originalName, mediaType: request.mediaType, payload: 'payload' };
      return this.stageEnvelope(metadata, bytes);
    }
    const input = request.path ?? request.filePath;
    if (!input) throw new Error('source input is required');
    const source = resolve(input);
    const stat = await lstatNoFollow(source);
    await measurePath(source);
    const name = validRelativePath(request.name ?? basename(source));
    const target = safeRelativePath(this.inbox(), name);
    if (source !== target) await copyPathNoFollow(source, target);
    const requestedKind = request.kind;
    const kind: SourceKind = requestedKind === 'upload' ? inferKind(name, stat) : requestedKind === 'pasted' ? 'text' : requestedKind && SOURCE_KINDS.includes(requestedKind as SourceKind) ? requestedKind as SourceKind : inferKind(source, stat);
    if (!SOURCE_KINDS.includes(kind)) throw new Error('invalid source kind');
    return { relativePath: relative(this.inbox(), target).replaceAll('\\', '/'), absolutePath: target, kind };
  }
  async discover(): Promise<InboxEntry[]> {
    await fs.mkdir(this.inbox(), { recursive: true, mode: 0o700 });
    const entries: InboxEntry[] = [];
    for (const name of (await fs.readdir(this.inbox())).sort((a, b) => a.localeCompare(b))) {
      const path = join(this.inbox(), name);
      try {
        const stat = await lstatNoFollow(path);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error('unsupported inbox entry');
        const metadata = stat.isDirectory() ? await stagedMetadata(path) : undefined;
        const kind = metadata ? metadata.requestedKind === 'upload' ? inferKind(metadata.originalName ?? metadata.displayName) : metadata.kind : stat.isDirectory() ? (await this.isRepository(path) ? 'repository' : 'directory') : inferKind(path, stat);
        entries.push({ relativePath: name.replaceAll('\\', '/'), absolutePath: path, kind, identity: statIdentity(stat), metadata });
      } catch (error) {
        entries.push({ relativePath: name.replaceAll('\\', '/'), absolutePath: path, kind: 'text', identity: { device: '', inode: '', mode: 0, size: 0, mtimeNs: '' }, digest: `error:${error instanceof Error ? error.message : String(error)}`, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return entries;
  }
  private async snapshotForEntry(entry: InboxEntry, revision?: string): Promise<TreeSnapshot> {
    const root = entry.metadata ? join(entry.absolutePath, entry.metadata.payload) : entry.absolutePath;
    return snapshotPath(root, entry.relativePath, entry.kind, revision, entry.metadata);
  }
  async claim(entry: InboxEntry): Promise<SourceClaim> {
    if (entry.error) throw new Error(entry.error);
    const current = await lstatNoFollow(entry.absolutePath);
    if (!sameIdentity(statIdentity(current), entry.identity)) throw new Error('inbox entry changed before claim');
    const repository = current.isDirectory() && !entry.metadata && await this.isRepository(entry.absolutePath);
    const revision = repository ? await this.revision(entry.absolutePath) : undefined;
    if (repository && !revision) throw new Error('repository revision is unavailable');
    const snapshot = await this.snapshotForEntry(entry, revision);
    const afterEntry = await lstatNoFollow(entry.absolutePath);
    const afterRevision = repository ? await this.revision(entry.absolutePath) : undefined;
    if (repository && afterRevision !== revision) throw new Error('repository changed during snapshot');
    const after = await this.snapshotForEntry(entry, afterRevision);
    if (!sameIdentity(statIdentity(afterEntry), entry.identity) || snapshot.digest !== after.digest || !sameIdentity(snapshot.identity, after.identity)) throw new Error('inbox entry changed during snapshot');
    const claimId = deterministicUuid(canonical({ scope: 'claim', digest: snapshot.digest, identity: snapshot.identity, revision, kind: snapshot.kind, metadata: snapshot.metadata }));
    return { claimId, entry, snapshot, claimedAt: new Date().toISOString() };
  }
  private async isRepository(path: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(join(path, '.git'));
      return stat.isDirectory() || stat.isFile();
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private async revision(path: string): Promise<string | undefined> {
    if (typeof this.adapters.gitRevision === 'function') return (await this.adapters.gitRevision(path)) || undefined;
    if (this.adapters.gitRevision) return (await this.adapters.gitRevision.revision(path)) || undefined;
    try {
      const result = await execFileAsync('git', ['-C', path, 'rev-parse', 'HEAD'], { timeout: 5000, maxBuffer: 1024 * 1024 });
      return result.stdout.trim() || undefined;
    } catch { return undefined }
  }
  private sourceIdFor(claim: SourceClaim, options: { mediaType?: string; originalName?: string; url?: string }): string {
    return deterministicUuid(canonical({ scope: 'source', digest: claim.snapshot.digest, identity: claim.snapshot.identity, revision: claim.snapshot.revision, kind: claim.snapshot.kind, metadata: claim.snapshot.metadata, mediaType: options.mediaType ?? claim.snapshot.metadata?.mediaType, originalName: options.originalName ?? claim.snapshot.metadata?.originalName ?? claim.entry.relativePath, sourceUri: options.url ?? claim.snapshot.metadata?.sourceUri }));
  }
  private async removeInboxAfterAdmission(claim: SourceClaim): Promise<boolean> {
    try {
      const current = await lstatNoFollow(claim.entry.absolutePath);
      if (!sameIdentity(statIdentity(current), claim.entry.identity)) return false;
      const snapshot = await this.snapshotForEntry(claim.entry, claim.snapshot.revision);
      if (snapshot.digest !== claim.snapshot.digest || !sameIdentity(snapshot.identity, claim.snapshot.identity)) return false;
      await fs.rm(claim.entry.absolutePath, { recursive: true, force: false });
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) return false;
      throw error;
    }
  }
  private async normalizeExistingPacket(claim: SourceClaim, options: { mediaType?: string; originalName?: string; url?: string }): Promise<AdmissionResult | undefined> {
    const sourceId = this.sourceIdFor(claim, options);
    const packet = join(this.sources(), sourceId);
    try {
      const stat = await lstatNoFollow(packet);
      if (!stat.isDirectory()) throw new Error('source packet must be a directory');
      const manifest = parseManifest(packet);
      if (manifest.sourceId !== sourceId || manifest.originalDigest !== claim.snapshot.digest) throw new Error('existing source packet identity mismatch');
      this.recordSource(manifest, packet);
      return { sourceId, manifest, packetPath: packet, removedInbox: await this.removeInboxAfterAdmission(claim), claim };
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async admitClaim(claim: SourceClaim, options: { endpoints?: Array<number | ChunkPlanEndpoint>; mediaType?: string; originalName?: string; url?: string } = {}): Promise<AdmissionResult> {
    const existing = await this.normalizeExistingPacket(claim, options);
    if (existing) return existing;
    const sourceId = this.sourceIdFor(claim, options);
    const packet = join(this.sources(), sourceId);
    const temporary = join(this.work(), `packet-${sourceId}`);
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(join(temporary, 'original'), { recursive: true, mode: 0o700 });
    await fs.mkdir(join(temporary, 'chunks'), { recursive: true, mode: 0o700 });
    await fs.mkdir(join(temporary, 'attachments'), { recursive: true, mode: 0o700 });
    await writeTree(join(temporary, 'original'), claim.snapshot.files);
    let extracted: Buffer;
    let attachments: Array<{ path: string; bytes: Uint8Array | string }> = [];
    let converter: { name: string; version: string } | undefined;
    const mediaType = options.mediaType ?? claim.snapshot.metadata?.mediaType;
    const useDocling = claim.snapshot.kind === 'document' || (claim.snapshot.kind === 'url' && !textualUrl(claim, mediaType));
    if (useDocling) {
      if (!this.adapters.docling) throw new Error('Docling adapter is required for document extraction');
      const converted = typeof this.adapters.docling === 'function' ? await this.adapters.docling({ claim, originalPath: join(temporary, 'original'), kind: claim.snapshot.kind, mediaType }) : await this.adapters.docling.convert({ claim, originalPath: join(temporary, 'original'), kind: claim.snapshot.kind, mediaType });
      const normalizedResult = await normalizeDoclingResult(converted);
      extracted = Buffer.from(normalizedResult.extracted);
      converter = { name: normalizedResult.converter?.name ?? 'docling', version: normalizedResult.converter?.version ?? 'unknown' };
      attachments = normalizedResult.attachments ?? [];
    } else extracted = nativeExtraction(claim.snapshot);
    if (!extracted.length) throw new Error('empty extraction');
    if (extracted.byteLength > MAX_SOURCE_BYTES) throw new Error('extraction exceeds 100 MiB limit');
    const chunks = validateChunkEndpoints(extracted, options.endpoints);
    await fs.writeFile(join(temporary, 'extracted.md'), extracted, { flag: 'wx', mode: 0o600 });
    for (const attachment of attachments) {
      const target = ensureWithin(join(temporary, 'attachments'), join(join(temporary, 'attachments'), validRelativePath(attachment.path)));
      const bytes = Buffer.from(attachment.bytes);
      if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('attachment exceeds 100 MiB limit');
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    for (const chunk of chunks) await fs.writeFile(join(temporary, 'chunks', `${String(chunk.index + 1).padStart(4, '0')}.md`), chunk.body, { flag: 'wx', mode: 0o600 });
    const originalName = validRelativePath(options.originalName ?? claim.snapshot.metadata?.originalName ?? claim.entry.relativePath);
    const displayName = options.originalName ?? claim.snapshot.metadata?.displayName ?? originalName;
    const capturedAt = new Date().toISOString();
    const manifest: SourceManifest = {
      id: sourceId,
      sourceId,
      kind: claim.snapshot.kind,
      displayName,
      originalName,
      originalUrl: options.url ?? claim.snapshot.metadata?.sourceUri,
      sourceUri: options.url ?? claim.snapshot.metadata?.sourceUri,
      revision: claim.snapshot.revision,
      repositoryRevision: claim.snapshot.revision,
      mediaType,
      inputKind: claim.snapshot.metadata?.requestedKind,
      stagedMetadata: claim.snapshot.metadata,
      capturedAt,
      converter,
      originalBytes: claim.snapshot.bytes,
      originalByteLength: claim.snapshot.bytes,
      originalDigest: claim.snapshot.digest,
      extractionBytes: extracted.byteLength,
      extractedByteLength: extracted.byteLength,
      extractionDigest: digestBytes(extracted),
      extractedDigest: digestBytes(extracted),
      files: claim.snapshot.files.map(({ path, size, digest }) => ({ path, relativePath: path, bytes: size, byteLength: size, digest, mediaType })),
      chunks: chunks.map(({ index, startAtom, endAtom, startByte, endByte, digest }) => ({ index, chunkId: `${sourceId}:${index}`, sourceId, ordinal: index, relativePath: 'extracted.md', byteLength: endByte - startByte, atomStart: startAtom, atomEnd: endAtom, startAtom, endAtom, startByte, endByte, digest })),
    };
    await fs.writeFile(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.mkdir(this.sources(), { recursive: true, mode: 0o700 });
    try {
      await fs.rename(temporary, packet);
    } catch (error) {
      const packetExists = await fs.stat(packet).then(() => true, () => false);
      if (!packetExists) throw error;
      const raced = parseManifest(packet);
      if (raced.sourceId !== sourceId || raced.originalDigest !== claim.snapshot.digest) throw error;
    }
    this.recordSource(manifest, packet);
    const removedInbox = await this.removeInboxAfterAdmission(claim);
    return { sourceId, manifest, packetPath: packet, removedInbox, claim };
  }
  private recordFailure(entry: InboxEntry, error: unknown, claim?: SourceClaim): void {
    const now = new Date().toISOString();
    const sourceId = deterministicUuid(canonical({ scope: 'failure', path: entry.relativePath, identity: entry.identity, digest: claim?.snapshot.digest ?? entry.digest ?? '', kind: claim?.snapshot.kind ?? entry.kind }));
    const message = error instanceof Error ? error.message : String(error);
    transaction(this.db, () => {
      const existing = dbGet<Row>(this.db, 'SELECT source_id FROM sources WHERE source_id = ?', [sourceId]);
      if (existing) dbRun(this.db, 'UPDATE sources SET status = ?, display_name = ?, original_name = ?, digest = ?, error_code = ?, error_message = ?, updated_at = ? WHERE source_id = ?', ['failed', entry.metadata?.displayName ?? entry.relativePath, entry.metadata?.originalName ?? entry.relativePath, claim?.snapshot.digest ?? entry.digest ?? null, 'ADMISSION_FAILED', message, now, sourceId]);
      else dbRun(this.db, 'INSERT INTO sources (source_id, kind, status, display_name, original_name, source_uri, media_type, repository_revision, captured_at, digest, manifest_path, error_code, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [sourceId, claim?.snapshot.kind ?? entry.kind, 'failed', entry.metadata?.displayName ?? entry.relativePath, entry.metadata?.originalName ?? entry.relativePath, entry.metadata?.sourceUri ?? null, entry.metadata?.mediaType ?? null, claim?.snapshot.revision ?? null, now, claim?.snapshot.digest ?? entry.digest ?? null, null, 'ADMISSION_FAILED', message, now, now]);
    });
  }
  async admitClaims(entries?: InboxEntry[]): Promise<Array<{ claim?: SourceClaim; result?: AdmissionResult; error?: string }>> {
    const pending = entries ?? await this.discover();
    const results: Array<{ claim?: SourceClaim; result?: AdmissionResult; error?: string }> = [];
    for (const entry of pending) {
      let claim: SourceClaim | undefined;
      try {
        claim = await this.claim(entry);
        results.push({ claim, result: await this.admitClaim(claim) });
      } catch (error) {
        try { this.recordFailure(entry, error, claim) } catch (diagnosticError) { throw new Error(`admission failed: ${error instanceof Error ? error.message : String(error)}; diagnostic persistence failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`, { cause: diagnosticError }); }
        results.push({ claim, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }
  private recordSource(manifest: SourceManifest, packet: string): void {
    transaction(this.db, () => {
      const existing = dbGet<Row>(this.db, 'SELECT * FROM sources WHERE source_id = ?', [manifest.sourceId]);
      const values = [manifest.sourceId, manifest.kind, 'published', manifest.displayName, manifest.originalName, manifest.sourceUri ?? null, manifest.mediaType ?? null, manifest.repositoryRevision ?? null, manifest.capturedAt, manifest.originalDigest, packet, manifest.capturedAt, manifest.capturedAt];
      if (!existing) dbRun(this.db, 'INSERT INTO sources (source_id, kind, status, display_name, original_name, source_uri, media_type, repository_revision, captured_at, digest, manifest_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', values);
      else if (String(existing.digest ?? '') !== manifest.originalDigest) throw new Error('source identity conflicts with existing database record');
      for (const file of manifest.files) {
        const found = dbGet<Row>(this.db, 'SELECT * FROM source_files WHERE source_id = ? AND relative_path = ?', [manifest.sourceId, file.relativePath]);
        if (!found) dbRun(this.db, 'INSERT INTO source_files (source_id, relative_path, byte_length, digest, media_type) VALUES (?, ?, ?, ?, ?)', [manifest.sourceId, file.relativePath, file.byteLength, file.digest, file.mediaType ?? manifest.mediaType ?? null]);
        else if (String(found.digest) !== file.digest || Number(found.byte_length) !== file.byteLength) throw new Error('source file identity conflicts with existing database record');
      }
      for (const chunk of manifest.chunks) {
        const found = dbGet<Row>(this.db, 'SELECT * FROM source_chunks WHERE chunk_id = ?', [chunk.chunkId]);
        if (!found) dbRun(this.db, 'INSERT INTO source_chunks (chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [chunk.chunkId, manifest.sourceId, chunk.ordinal, chunk.relativePath, chunk.byteLength, chunk.digest, chunk.atomStart, chunk.atomEnd]);
        else if (String(found.digest) !== chunk.digest || String(found.source_id) !== manifest.sourceId) throw new Error('source chunk identity conflicts with existing database record');
      }
    });
  }
  list(): Array<Record<string, unknown>> { return dbAll<Row>(this.db, 'SELECT * FROM sources ORDER BY captured_at, source_id').map((row) => sourceRecord(row)); }
  private currentDependents(sourceId: string): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = dbAll<Row>(this.db, 'SELECT * FROM source_dependencies WHERE source_id = ? ORDER BY page_id, chunk_id, relation', [sourceId]).map((row) => ({ ...row }));
    const wikiRoot = wikiPathFor(this.paths);
    const pages = dbAll<Row>(this.db, 'SELECT page_id, relative_path, digest FROM pages ORDER BY relative_path');
    for (const page of pages) {
      const path = validRelativePath(String(page.relative_path ?? ''));
      const absolute = safeRelativePath(wikiRoot, path);
      let body: string;
      try { body = readFileSync(absolute, 'utf8') } catch (error) { if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      if (body.includes(sourceId)) rows.push({ page_id: page.page_id, artifact_path: path, digest: page.digest, kind: 'citation' });
    }
    return rows;
  }
  removalPreview(sourceId: string): SourceRemovalPreview {
    const source = dbGet<Row>(this.db, 'SELECT * FROM sources WHERE source_id = ?', [sourceId]);
    if (!source) throw new Error('source not found');
    const rawPacket = String(source.manifest_path ?? join(this.sources(), sourceId));
    const packetPath = safeChildPath(this.sources(), rawPacket);
    const manifest = parseManifest(packetPath);
    if (manifest.sourceId !== sourceId) throw new Error('source packet identity mismatch');
    const dependents = this.currentDependents(sourceId);
    const currentDigest = manifest.originalDigest;
    const confirmationId = digestBytes(Buffer.from(canonical({ sourceId, currentDigest, dependents })));
    return { sourceId, packetPath, currentDigest, dependents, confirmationId };
  }
  async removeConfirmed(sourceId: string, confirmation: string | { confirmationId?: string }): Promise<SourceRemovalResult> {
    const preview = this.removalPreview(sourceId);
    const token = typeof confirmation === 'string' ? confirmation : confirmation.confirmationId;
    if (token !== preview.confirmationId) throw new Error('stale removal confirmation');
    const quarantineRoot = join(this.work(), 'quarantine');
    await fs.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    const quarantine = ensureWithin(quarantineRoot, join(quarantineRoot, `${sourceId}-${preview.currentDigest.slice(0, 16)}`));
    await fs.rename(preview.packetPath, quarantine);
    try {
      transaction(this.db, () => {
        const now = new Date().toISOString();
        dbRun(this.db, 'UPDATE sources SET status = ?, updated_at = ? WHERE source_id = ?', ['removed', now, sourceId]);
        const pageIds = new Set<string>();
        const cardIds = new Set<string>();
        for (const dependent of preview.dependents) {
          if (typeof dependent.page_id === 'string') pageIds.add(dependent.page_id);
          if (typeof dependent.card_id === 'string') cardIds.add(dependent.card_id);
        }
        for (const pageId of pageIds) {
          dbRun(this.db, 'UPDATE pages SET status = ?, revision = revision + 1, updated_at = ? WHERE page_id = ?', ['drifted', now, pageId]);
          for (const binding of dbAll<Row>(this.db, 'SELECT card_id FROM card_bindings WHERE page_id = ?', [pageId])) if (typeof binding.card_id === 'string') cardIds.add(binding.card_id);
          dbRun(this.db, 'UPDATE card_bindings SET active = 0 WHERE page_id = ?', [pageId]);
        }
        for (const cardId of cardIds) dbRun(this.db, 'UPDATE review_cards SET status = ?, updated_at = ? WHERE card_id = ?', ['retired', now, cardId]);
        dbRun(this.db, 'DELETE FROM source_dependencies WHERE source_id = ?', [sourceId]);
      });
    } catch (error) {
      try { await fs.rename(quarantine, preview.packetPath) } catch (restoreError) { throw new Error(`source removal transaction failed and packet restore failed: ${error instanceof Error ? error.message : String(error)}; ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, { cause: restoreError }); }
      throw error;
    }
    return { ...preview, removed: true };
  }
}

export function nativeExtraction(snapshot: TreeSnapshot): Buffer {
  if (snapshot.files.length === 1 && snapshot.kind !== 'directory' && snapshot.kind !== 'repository') {
    const first = snapshot.files[0];
    if (!first) throw new Error('source snapshot has no file');
    return Buffer.from(first.bytes);
  }
  const pieces: Buffer[] = [];
  for (const file of snapshot.files) {
    const last = file.bytes.at(-1);
    pieces.push(Buffer.from(`--- FILE: ${file.path} ---\n`), file.bytes, Buffer.from(last === 10 ? '' : '\n'), Buffer.from(`--- END FILE: ${file.path} ---\n`));
  }
  return Buffer.concat(pieces);
}
export const sha256 = digestBytes;
export function chunkExtraction(extracted: string | Uint8Array, endpoints?: Array<number | ChunkPlanEndpoint>): SourceChunk[] { return validateChunkEndpoints(extracted, endpoints) }
