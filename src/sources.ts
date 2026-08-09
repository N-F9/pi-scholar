import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { constants, promises as fs, lstatSync, readFileSync, type Stats } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  PreparedAdmission as ContractPreparedAdmission,
  SourceKind as ContractSourceKind,
  SourceManifest as ContractSourceManifest,
} from "./contracts.js";
import { type ScholarDatabase, type SqlRow, type SqlRunResult, transaction } from "./database.js";
import type { DoclingResult as ExternalDoclingResult } from "./external/docling.js";
import { runChild } from "./external/process.js";
import { QuizService } from "./quiz.js";
import { safeRelativePath, type VaultPaths } from "./vault.js";
export interface VaultPathsLike extends Partial<VaultPaths> {
  root?: string;
  inbox?: string;
  sources?: string;
  work?: string;
}
export type SourceKind = ContractSourceKind;
export type InputKind = SourceKind | "upload" | "pasted";
export interface StageMetadata {
  version: 1;
  requestedKind: InputKind;
  kind: SourceKind;
  displayName: string;
  originalName?: string;
  sourceUri?: string;
  mediaType?: string;
  repositoryRevision?: string;
  payload: "payload";
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
export interface FileSnapshot {
  path: string;
  size: number;
  digest: string;
  bytes: Buffer;
}
export interface PhysicalIdentity {
  device: string;
  inode: string;
  mode: number;
  size: number;
  mtimeNs: string;
}
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
export interface SourceClaim {
  claimId: string;
  entry: InboxEntry;
  snapshot: TreeSnapshot;
  claimedAt: string;
}
export interface AdmissionResult {
  sourceId: string;
  manifest: SourceManifest;
  packetPath: string;
  removedInbox: boolean;
  claim: SourceClaim;
}
export interface SourceRemovalPreview {
  sourceId: string;
  packetPath: string;
  currentDigest: string;
  dependentPageIds: string[];
  confirmationId: string;
}
export interface SourceRemovalResult extends SourceRemovalPreview {
  removed: boolean;
}
export interface SourceChunk {
  index: number;
  startAtom: number;
  endAtom: number;
  startByte: number;
  endByte: number;
  digest: string;
  body: Buffer;
}
export interface SourceManifest extends Omit<ContractSourceManifest, "converter" | "files" | "chunks"> {
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
  files: Array<ContractSourceManifest["files"][number] & { path: string; bytes: number }>;
  chunks: Array<
    ContractSourceManifest["chunks"][number] & {
      index: number;
      startAtom: number;
      endAtom: number;
      startByte: number;
      endByte: number;
      digest: string;
      body?: never;
    }
  >;
}
export type PreparedAdmission = ContractPreparedAdmission;
interface PreparedAttachment {
  path: string;
  byteLength: number;
  digest: string;
}
interface PersistedPreparedAdmission extends PreparedAdmission {
  entryRelativePath: string;
  entryIdentity: PhysicalIdentity;
  snapshotIdentity: PhysicalIdentity;
  snapshotBytes: number;
  revision?: string;
  metadata?: StageMetadata;
  converter?: { name: string; version: string };
  attachments: PreparedAttachment[];
  extractedDigest: string;
  extractedByteLength: number;
}
export interface SourceAdapters {
  docling?:
    | ((input: {
        claim: SourceClaim;
        originalPath: string;
        kind: SourceKind;
        mediaType?: string;
      }) => Promise<DoclingResult | ExternalDoclingResult> | DoclingResult | ExternalDoclingResult)
    | {
        convert(input: {
          claim: SourceClaim;
          originalPath: string;
          kind: SourceKind;
          mediaType?: string;
        }): Promise<DoclingResult | ExternalDoclingResult> | DoclingResult | ExternalDoclingResult;
      };
  fetchUrl?: (url: string) => Promise<{ bytes: Uint8Array; mediaType?: string; name?: string }>;
  gitRevision?: ((root: string) => Promise<string> | string) | { revision(root: string): Promise<string> | string };
}
export interface DoclingResult {
  extracted: Uint8Array | string;
  converter?: { name: string; version?: string };
  attachments?: Array<{ path: string; bytes: Uint8Array | string }>;
}
export interface ChunkPlanEndpoint {
  endAtom?: number;
  end?: number;
  index?: number;
}

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const ENVELOPE_NAME = ".pi-scholar-source.json";
const SOURCE_KINDS: readonly SourceKind[] = ["document", "url", "text", "note", "code", "directory", "repository"];
const INPUT_KINDS: readonly InputKind[] = [...SOURCE_KINDS, "upload", "pasted"];
const MAX_SOURCE_REDIRECTS = 5;
const METADATA_HOSTNAMES: Record<string, true> = {
  metadata: true,
  "metadata.google.internal": true,
  "metadata.google.com": true,
  "instance-data.ec2.internal": true,
  "100.100.100.200": true,
};
type SafeAddress = { address: string; family: 4 | 6 };
function ipv4Unsafe(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second, third] = parts;
  if (first === undefined || second === undefined || third === undefined) return true;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 192 && second === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    (first === 169 && second === 254 && third === 169)
  );
}
function ipv6Bytes(address: string): number[] | undefined {
  const value = address.toLowerCase().split("%", 1)[0] ?? "";
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (!part) return [];
    const values: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        const octets = piece.split(".").map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
          return undefined;
        values.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(piece)) return undefined;
        values.push(Number.parseInt(piece, 16));
      }
    }
    return values;
  };
  const left = parse(halves[0] ?? "");
  const right = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (
    !left ||
    !right ||
    (halves.length === 1 && left.length !== 8) ||
    (halves.length === 2 && left.length + right.length >= 8)
  )
    return undefined;
  const groups = [
    ...left,
    ...(halves.length === 2 ? Array.from({ length: 8 - left.length - right.length }, () => 0) : []),
    ...right,
  ];
  if (groups.length !== 8) return undefined;
  return groups.flatMap((group) => [(group >>> 8) & 0xff, group & 0xff]);
}
function unsafeAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Unsafe(address);
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  if (bytes?.length !== 16) return true;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = allZero || (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15]! === 1);
  if (
    loopback ||
    bytes[0]! === 0xff ||
    (bytes[0]! & 0xfe) === 0xfc ||
    (bytes[0]! === 0xfe && (bytes[1]! & 0xc0) === 0x80)
  )
    return true;
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10]! === 0xff && bytes[11]! === 0xff;
  return mapped ? ipv4Unsafe(bytes.slice(12).join(".")) : bytes.slice(0, 12).every((byte) => byte === 0);
}
async function safeAddressFor(url: URL): Promise<SafeAddress> {
  const hostname = url.hostname
    .replace(/^\[|\]$/gu, "")
    .toLowerCase()
    .replace(/\.$/u, "");
  if (METADATA_HOSTNAMES[hostname]) throw new Error("source URL targets cloud metadata");
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (unsafeAddress(hostname)) throw new Error("source URL targets a private or special address");
    return { address: hostname, family: literalFamily as 4 | 6 };
  }
  if (!hostname) throw new Error("source URL hostname is required");
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!answers.length) throw new Error("source URL hostname has no addresses");
  const addresses = answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
  if (addresses.some(({ address }) => unsafeAddress(address)))
    throw new Error("source URL resolves to a private or special address");
  const first = addresses[0];
  if (!first || (first.family !== 4 && first.family !== 6)) throw new Error("source URL address family is unsupported");
  return first;
}
function provenanceUrl(url: URL): string {
  const safe = new URL(url.toString());
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.toString();
}
function sanitizedSourceUri(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("source URL protocol is not allowed");
  return provenanceUrl(parsed);
}
function publicSourceUri(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return sanitizedSourceUri(value);
  } catch {
    return undefined;
  }
}
interface SourceHttpResponse {
  status: number;
  location?: string;
  bytes?: Buffer;
  mediaType?: string;
}
export function pinnedSourceLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function requestSource(url: URL, address: SafeAddress): Promise<SourceHttpResponse> {
  const { promise, resolve: resolveRequest, reject: rejectRequest } = Promise.withResolvers<SourceHttpResponse>();
  let request: ClientRequest | undefined;
  let settled = false;
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    request?.destroy();
    rejectRequest(error instanceof Error ? error : new Error(String(error)));
  };
  const pathname = `${url.pathname || "/"}${url.search}`;
  const baseOptions = {
    protocol: url.protocol,
    hostname: url.hostname.replace(/^\[|\]$/gu, ""),
    port: url.port || undefined,
    path: pathname,
    method: "GET",
    agent: false,
    lookup: pinnedSourceLookup(address.address, address.family),
  };
  const onResponse = (response: IncomingMessage): void => {
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (typeof location !== "string" || !location) fail(new Error("source redirect has no location"));
      else {
        settled = true;
        resolveRequest({ status, location });
      }
      return;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      fail(new Error(`source fetch failed: ${status}`));
      return;
    }
    const advertised = response.headers["content-length"];
    if (advertised !== undefined) {
      const length = Number(Array.isArray(advertised) ? advertised[0] : advertised);
      if (!Number.isSafeInteger(length) || length < 0) {
        response.destroy();
        fail(new Error("source content length is invalid"));
        return;
      }
      if (length > MAX_SOURCE_BYTES) {
        response.destroy();
        fail(new Error("source exceeds 100 MiB limit"));
        return;
      }
    }
    const chunks: Buffer[] = [];
    let total = 0;
    response.on("data", (chunk: Buffer | Uint8Array) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        response.destroy();
        fail(new Error("source exceeds 100 MiB limit"));
        return;
      }
      chunks.push(bytes);
    });
    response.once("aborted", () => fail(new Error("source response aborted")));
    response.once("error", fail);
    response.once("end", () => {
      if (settled) return;
      settled = true;
      resolveRequest({
        status,
        bytes: Buffer.concat(chunks, total),
        mediaType: response.headers["content-type"]?.toString(),
      });
    });
  };
  request =
    url.protocol === "https:"
      ? httpsRequest({ ...baseOptions, servername: baseOptions.hostname }, onResponse)
      : httpRequest(baseOptions, onResponse);
  request.once("error", fail);
  request.end();
  return promise;
}

type Row = SqlRow;
function dbRun(db: ScholarDatabase, sql: string, params: unknown[] = []): SqlRunResult {
  return db.run(sql, params);
}
function dbGet<T = Row>(db: ScholarDatabase, sql: string, params: unknown[] = []): T | undefined {
  return db.get<T>(sql, params);
}
function dbAll<T = Row>(db: ScholarDatabase, sql: string, params: unknown[] = []): T[] {
  return db.all<T>(sql, params);
}
function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function canonical(value: unknown): string {
  const normalizeValue = (input: unknown): unknown => {
    if (input === undefined || typeof input === "function" || typeof input === "symbol" || typeof input === "bigint")
      throw new Error("value cannot be serialized canonically");
    if (input === null || typeof input === "string" || typeof input === "number" || typeof input === "boolean")
      return input;
    if (input instanceof Uint8Array) return Buffer.from(input).toString("base64");
    if (Array.isArray(input)) return input.map((item) => normalizeValue(item));
    if (typeof input === "object") {
      const record = input as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
        const nested = record[key];
        if (nested !== undefined) normalized[key] = normalizeValue(nested);
      }
      return normalized;
    }
    throw new Error("value cannot be serialized canonically");
  };
  const output = JSON.stringify(normalizeValue(value));
  if (output === undefined) throw new Error("value cannot be serialized canonically");
  return output;
}
function validRelativePath(value: string): string {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value) || value.includes("\\") || isAbsolute(value))
    throw new Error("invalid relative path");
  const normalized = normalize(value).replaceAll("\\", "/");
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  )
    throw new Error("path traversal");
  return normalized;
}
function vaultRootFor(paths: VaultPathsLike): string {
  const root = paths.root ?? paths.vaultRoot;
  if (typeof root !== "string") throw new Error("vault root is required");
  return root;
}
function workArtifactRelative(paths: VaultPathsLike, target: string): string {
  const absolute = resolve(target);
  const work = resolve(pathFor(paths, "work"));
  const workRelative = relative(work, absolute).replaceAll("\\", "/");
  if (!workRelative || workRelative === ".." || workRelative.startsWith("../") || isAbsolute(workRelative))
    throw new Error("prepared path escapes work");
  const vaultRelative = relative(resolve(vaultRootFor(paths)), absolute).replaceAll("\\", "/");
  return validRelativePath(vaultRelative);
}
function resolveWorkArtifact(paths: VaultPathsLike, requested: string): string {
  const absolute = safeRelativePath(vaultRootFor(paths), validRelativePath(requested));
  return ensureWithin(pathFor(paths, "work"), absolute);
}
function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function statIdentity(stat: Stats): PhysicalIdentity {
  const mtimeNs =
    "mtimeNs" in stat && typeof stat.mtimeNs === "bigint"
      ? stat.mtimeNs.toString()
      : String(Math.round(stat.mtimeMs * 1_000_000));
  return { device: String(stat.dev), inode: String(stat.ino), mode: stat.mode, size: stat.size, mtimeNs };
}
function pathFor(paths: VaultPathsLike, name: "inbox" | "sources" | "work" | "quizzes"): string {
  const explicit =
    name === "inbox"
      ? (paths.inbox ?? paths.inboxRoot)
      : name === "sources"
        ? (paths.sources ?? paths.sourcesRoot)
        : name === "work"
          ? (paths.work ?? paths.workRoot)
          : paths.quizzesRoot;
  if (typeof explicit === "string") return explicit;
  const root = paths.root ?? paths.vaultRoot;
  if (typeof root !== "string") throw new Error("vault root is required");
  return join(root, name === "work" ? ".pi-scholar/work" : name);
}
function wikiPathFor(paths: VaultPathsLike): string {
  const explicit = paths.wikiRoot;
  if (typeof explicit === "string") return explicit;
  const root = paths.root ?? paths.vaultRoot;
  if (typeof root !== "string") throw new Error("vault root is required");
  return join(root, "wiki");
}
function sourceRecord(row: Row): Record<string, unknown> {
  const { source_uri: _sourceUri, ...rest } = row;
  return {
    ...rest,
    sourceId: row.source_id,
    displayName: row.display_name,
    originalName: row.original_name,
    sourceUri: publicSourceUri(row.source_uri),
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
async function rejectSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  let current = root;
  for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`symlink ancestor rejected: ${current}`);
  }
}
async function readNoFollow(path: string): Promise<Buffer> {
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    const bytes = Buffer.from(await handle.readFile());
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
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
    if (name === ".git") continue;
    total += await measurePath(join(path, name));
    if (total > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
  }
  return total;
}
async function walkFiles(root: string, current = "", skipGit = true): Promise<FileSnapshot[]> {
  const absolute = join(root, current);
  await rejectSymlinkAncestors(absolute);
  const stat = await lstatNoFollow(absolute);
  if (stat.isFile()) {
    const bytes = await readNoFollow(absolute);
    return [{ path: current.replaceAll("\\", "/"), size: bytes.byteLength, digest: digestBytes(bytes), bytes }];
  }
  if (!stat.isDirectory()) throw new Error(`unsupported filesystem entry: ${absolute}`);
  const files: FileSnapshot[] = [];
  for (const name of (await fs.readdir(absolute)).sort((a, b) => a.localeCompare(b))) {
    if (skipGit && name === ".git") continue;
    validRelativePath(join(current, name));
    files.push(...(await walkFiles(root, join(current, name), skipGit)));
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SOURCE_BYTES)
      throw new Error("source exceeds 100 MiB limit");
  }
  return files;
}
const SAFE_REPOSITORY_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;
const SAFE_REPOSITORY_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
} as const;
async function repositoryGit(
  root: string,
  command: "ls-files" | "rev-parse",
  maxOutputBytes: number,
): Promise<Awaited<ReturnType<typeof runChild>>> {
  const args =
    command === "ls-files"
      ? [...SAFE_REPOSITORY_GIT_ARGS, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]
      : [...SAFE_REPOSITORY_GIT_ARGS, "rev-parse", "HEAD"];
  return runChild("git", ["-C", root, ...args], {
    cwd: root,
    timeoutMs: 120_000,
    maxOutputBytes,
    env: SAFE_REPOSITORY_GIT_ENV,
  });
}
async function repositoryRevision(root: string): Promise<string> {
  const result = await repositoryGit(root, "rev-parse", 1024);
  if (result.timedOut || result.code !== 0)
    throw new Error(`git revision lookup failed (${result.code ?? result.signal ?? "unknown"})`);
  const revision = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/iu.test(revision)) throw new Error("git revision is invalid");
  return revision;
}
async function repositoryFiles(root: string): Promise<FileSnapshot[]> {
  const result = await repositoryGit(root, "ls-files", MAX_SOURCE_BYTES + 1);
  if (result.timedOut || result.code !== 0)
    throw new Error(`git file listing failed (${result.code ?? result.signal ?? "unknown"})`);
  if (Buffer.byteLength(result.stdout, "utf8") >= MAX_SOURCE_BYTES)
    throw new Error("repository file listing exceeds 100 MiB limit");
  const files: FileSnapshot[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const rawPath of result.stdout.split("\0")) {
    if (!rawPath) continue;
    const normalized = rawPath;
    if (normalized.split("/").includes(".git")) continue;
    if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error("repository file path contains control characters");
    const path = validRelativePath(normalized);
    if (seen.has(path)) continue;
    seen.add(path);
    const absolute = ensureWithin(root, join(root, path));
    await rejectSymlinkAncestors(absolute);
    const stat = await lstatNoFollow(absolute);
    if (!stat.isFile()) throw new Error(`repository entry is not a regular file: ${path}`);
    const bytes = await readNoFollow(absolute);
    total += bytes.byteLength;
    if (total > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
    files.push({ path, size: bytes.byteLength, digest: digestBytes(bytes), bytes });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
function sameIdentity(a: PhysicalIdentity, b: PhysicalIdentity): boolean {
  return (
    a.device === b.device && a.inode === b.inode && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs
  );
}
function ensureWithin(root: string, target: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel === "" || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path escapes vault");
  return targetAbs;
}
function safeChildPath(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target)).replaceAll("\\", "/");
  if (!rel || rel.startsWith("../") || isAbsolute(rel)) throw new Error("path escapes vault");
  return safeRelativePath(root, rel);
}
function inferKind(path: string, stat?: Stats): SourceKind {
  if (stat?.isDirectory()) return "directory";
  const ext = extname(path).toLowerCase();
  if (
    [".pdf", ".epub", ".docx", ".pptx", ".xlsx", ".html", ".htm", ".png", ".jpg", ".jpeg", ".tif", ".tiff"].includes(
      ext,
    )
  )
    return "document";
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".c",
      ".h",
      ".cpp",
      ".cc",
      ".sh",
      ".sql",
    ].includes(ext)
  )
    return "code";
  return "text";
}
function textualUrl(claim: SourceClaim, mediaType?: string): boolean {
  const media = mediaType?.toLowerCase().split(";", 1)[0];
  if (
    media &&
    [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "application/xml",
      "text/xml",
      "application/yaml",
      "text/yaml",
    ].includes(media)
  )
    return true;
  return [".md", ".markdown", ".txt", ".text", ".json", ".xml", ".csv", ".yaml", ".yml"].includes(
    extname(claim.entry.metadata?.originalName ?? claim.entry.relativePath).toLowerCase(),
  );
}
function treeDigest(files: FileSnapshot[], identity: PhysicalIdentity, revision?: string): string {
  return digestBytes(
    Buffer.from(
      canonical({ identity, revision, files: files.map(({ path, size, digest }) => ({ path, size, digest })) }),
    ),
  );
}
function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new Error(`invalid source manifest ${key}`);
  return value;
}
function parseMetadata(raw: string): StageMetadata {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid staged source metadata");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid staged source metadata");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.requestedKind !== "string" ||
    !INPUT_KINDS.includes(record.requestedKind as InputKind) ||
    typeof record.kind !== "string" ||
    !SOURCE_KINDS.includes(record.kind as SourceKind) ||
    typeof record.displayName !== "string" ||
    !record.displayName ||
    /[\u0000-\u001f\u007f]/u.test(record.displayName) ||
    record.payload !== "payload"
  )
    throw new Error("invalid staged source metadata");
  const requestedKind = record.requestedKind as InputKind;
  const kind = record.kind as SourceKind;
  const originalName = typeof record.originalName === "string" ? record.originalName : undefined;
  if (originalName !== undefined) validRelativePath(originalName);
  if (
    (requestedKind === "url" && kind !== "url") ||
    ((requestedKind === "text" || requestedKind === "pasted") && kind !== "text") ||
    (requestedKind === "upload" && kind !== inferKind(originalName ?? record.displayName)) ||
    (requestedKind === "repository" && kind !== "repository") ||
    (requestedKind !== "url" &&
      requestedKind !== "text" &&
      requestedKind !== "pasted" &&
      requestedKind !== "upload" &&
      requestedKind !== "repository")
  )
    throw new Error("staged source metadata kind is inconsistent");
  if (requestedKind === "url" && typeof record.sourceUri !== "string")
    throw new Error("staged URL source metadata is missing sourceUri");
  if (requestedKind === "upload" && originalName === undefined)
    throw new Error("staged upload metadata is missing originalName");
  if (
    kind === "repository" &&
    (typeof record.repositoryRevision !== "string" ||
      !record.repositoryRevision ||
      /[\u0000-\u001f\u007f]/u.test(record.repositoryRevision))
  )
    throw new Error("invalid staged repository revision");
  const metadata: StageMetadata = {
    version: 1,
    requestedKind,
    kind,
    displayName: record.displayName,
    payload: "payload",
  };
  for (const key of ["originalName", "sourceUri", "mediaType", "repositoryRevision"] as const) {
    const item = record[key];
    if (item !== undefined) {
      if (typeof item !== "string" || item.includes("\0") || /[\u0000-\u001f\u007f]/u.test(item))
        throw new Error("invalid staged source metadata");
      metadata[key] = key === "sourceUri" ? sanitizedSourceUri(item) : item;
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
    if (!envelopeStat.isFile()) throw new Error("staged source metadata must be a file");
    const metadata = parseMetadata((await readNoFollow(envelope)).toString("utf8"));
    const payload = join(path, metadata.payload);
    const payloadStat = await lstatNoFollow(payload);
    if (metadata.kind === "repository" ? !payloadStat.isDirectory() : !payloadStat.isFile())
      throw new Error(
        `staged source payload must be a regular ${metadata.kind === "repository" ? "directory" : "file"}`,
      );
    return metadata;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  }
}
async function snapshotPath(
  path: string,
  relativePath: string,
  kind?: SourceKind,
  revision?: string,
  metadata?: StageMetadata,
): Promise<TreeSnapshot> {
  const stat = await lstatNoFollow(path);
  const identity = statIdentity(stat);
  const files = stat.isDirectory()
    ? kind === "repository" && !metadata
      ? await repositoryFiles(path)
      : await walkFiles(path)
    : [{ path: basename(path), size: 0, digest: "", bytes: Buffer.alloc(0) }];
  if (!stat.isDirectory()) {
    const first = files[0];
    if (!first) throw new Error("source file snapshot is empty");
    const bytes = await readNoFollow(path);
    first.bytes = bytes;
    first.size = bytes.byteLength;
    first.digest = digestBytes(bytes);
  }
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (bytes > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
  const finalKind = kind ?? (stat.isDirectory() ? "directory" : inferKind(path, stat));
  return {
    root: path,
    relativePath: validRelativePath(relativePath),
    kind: finalKind,
    identity,
    digest: treeDigest(files, identity, revision),
    bytes,
    files,
    revision,
    metadata,
  };
}
async function writeTree(root: string, files: FileSnapshot[]): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = ensureWithin(root, join(root, validRelativePath(file.path)));
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await openFile(target, "wx", 0o600);
    try {
      await handle.writeFile(file.bytes);
    } finally {
      await handle.close();
    }
  }
}
function atomRows(extracted: Buffer): Array<{ start: number; end: number; bytes: Buffer }> {
  const rows: Array<{ start: number; end: number; bytes: Buffer }> = [];
  let start = 0;
  for (let index = 0; index < extracted.length; index++)
    if (extracted[index] === 10) {
      rows.push({ start, end: index + 1, bytes: extracted.subarray(start, index + 1) });
      start = index + 1;
    }
  if (start < extracted.length || rows.length === 0)
    rows.push({ start, end: extracted.length, bytes: extracted.subarray(start) });
  return rows;
}
export function atomizeExtraction(
  extracted: string | Uint8Array,
): Array<{ index: number; startByte: number; endByte: number; body: Buffer }> {
  return atomRows(Buffer.from(extracted)).map((row, index) => ({
    index,
    startByte: row.start,
    endByte: row.end,
    body: Buffer.from(row.bytes),
  }));
}
export function validateChunkEndpoints(
  extracted: string | Uint8Array,
  proposed?: Array<number | ChunkPlanEndpoint>,
): SourceChunk[] {
  const bytes = Buffer.from(extracted);
  const atoms = atomizeExtraction(bytes);
  const raw = proposed?.map((endpoint) =>
    typeof endpoint === "number" ? endpoint : (endpoint.endAtom ?? endpoint.end ?? endpoint.index),
  );
  const endpoints = raw?.length ? raw : [atoms.length];
  for (const endpoint of endpoints)
    if (endpoint === undefined || !Number.isInteger(endpoint) || endpoint <= 0 || endpoint > atoms.length)
      throw new Error("chunk endpoints must be increasing atom endpoints");
  const finalEndpoint = endpoints.at(-1);
  if (finalEndpoint !== atoms.length) throw new Error("chunk endpoints must cover the extraction");
  for (let index = 1; index < endpoints.length; index++) {
    const current = endpoints[index];
    const previous = endpoints[index - 1];
    if (current === undefined || previous === undefined || current <= previous)
      throw new Error("chunk endpoints must be strictly increasing");
  }
  const chunks: SourceChunk[] = [];
  let startAtom = 0;
  for (let index = 0; index < endpoints.length; index++) {
    const endAtom = endpoints[index];
    if (endAtom === undefined) throw new Error("chunk endpoint is missing");
    const start = atoms[startAtom];
    const end = atoms[endAtom - 1];
    if (!start || !end) throw new Error("chunk endpoint is outside extraction");
    const body = Buffer.from(bytes.subarray(start.startByte, end.endByte));
    chunks.push({
      index,
      startAtom,
      endAtom,
      startByte: start.startByte,
      endByte: end.endByte,
      digest: digestBytes(body),
      body,
    });
    startAtom = endAtom;
  }
  return chunks;
}
export function reconstructChunks(chunks: Array<Pick<SourceChunk, "body">>): Buffer {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.body)));
}

function isLocalDoclingResult(result: DoclingResult | ExternalDoclingResult): result is DoclingResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const record = result as unknown as Record<string, unknown>;
  return "extracted" in record && !("outputDirectory" in record) && !("command" in record);
}
async function normalizeDoclingResult(result: DoclingResult | ExternalDoclingResult): Promise<DoclingResult> {
  if (isLocalDoclingResult(result)) return result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("invalid Docling result");
  const record = result as unknown as Record<string, unknown>;
  if (
    typeof record.outputDirectory !== "string" ||
    record.command === null ||
    typeof record.command !== "object" ||
    Array.isArray(record.command)
  )
    throw new Error("invalid Docling result");
  const command = record.command as Record<string, unknown>;
  if (typeof command.code === "number" && command.code !== 0)
    throw new Error(`Docling conversion failed with exit code ${command.code}`);
  const files = await walkFiles(record.outputDirectory);
  const extracted = files.find((file) => [".md", ".markdown", ".txt"].includes(extname(file.path).toLowerCase()));
  if (!extracted) throw new Error("Docling produced no Markdown or text output");
  return {
    extracted: extracted.bytes,
    converter: { name: "docling", version: "unknown" },
    attachments: files
      .filter((file) => file.path !== extracted.path)
      .map((file) => ({ path: file.path, bytes: file.bytes })),
  };
}
function parseManifestValue(raw: unknown): SourceManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid source manifest");
  const record = raw as Record<string, unknown>;
  requiredString(record, "sourceId");
  requiredString(record, "originalDigest");
  if (!Array.isArray(record.files) || !Array.isArray(record.chunks)) throw new Error("invalid source manifest files");
  if (record.attachments === undefined) record.attachments = [];
  if (!Array.isArray(record.attachments)) throw new Error("invalid source manifest attachments");
  for (const key of ["sourceUri", "originalUrl"] as const) {
    if (typeof record[key] !== "string") continue;
    const sanitized = sanitizedSourceUri(record[key]);
    if (sanitized !== record[key]) throw new Error("source manifest URL is not canonical");
    record[key] = sanitized;
  }
  if (record.stagedMetadata !== undefined) {
    if (
      record.stagedMetadata === null ||
      typeof record.stagedMetadata !== "object" ||
      Array.isArray(record.stagedMetadata)
    )
      throw new Error("invalid source manifest metadata");
    const metadata = record.stagedMetadata as Record<string, unknown>;
    if (typeof metadata.sourceUri === "string") {
      const sanitized = sanitizedSourceUri(metadata.sourceUri);
      if (sanitized !== metadata.sourceUri) throw new Error("source manifest metadata URL is not canonical");
      metadata.sourceUri = sanitized;
    }
  }
  return raw as SourceManifest;
}
function parseManifest(packet: string): SourceManifest {
  const manifestPath = join(packet, "manifest.json");
  const stat = lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("source manifest must be a regular file");
  return parseManifestValue(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
}
function manifestInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`invalid source manifest ${key}`);
  return value;
}
function manifestDigest(value: unknown, key: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value)) throw new Error(`invalid source manifest ${key}`);
  return value;
}
function manifestAttachments(value: unknown): Array<{ path: string; byteLength: number; digest: string }> {
  if (!Array.isArray(value)) throw new Error("invalid source manifest attachments");
  return value
    .map((item, index) => {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        throw new Error(`invalid source manifest attachment ${index}`);
      const record = item as Record<string, unknown>;
      const path = record.path;
      const relativePath = record.relativePath;
      if (typeof path !== "string" || relativePath !== path)
        throw new Error(`invalid source manifest attachment ${index}`);
      const normalizedPath = validRelativePath(path);
      const byteLength = manifestInteger(record.byteLength, `attachments[${index}].byteLength`);
      if (manifestInteger(record.bytes, `attachments[${index}].bytes`) !== byteLength)
        throw new Error(`source manifest attachment length mismatch: ${path}`);
      return {
        path: normalizedPath,
        byteLength,
        digest: manifestDigest(record.digest, `attachments[${index}].digest`),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}
async function verifyRetainedPacket(
  packet: string,
  expected: { sourceId: string; originalDigest: string },
): Promise<SourceManifest> {
  await rejectSymlinkAncestors(packet);
  const packetStat = await lstatNoFollow(packet);
  if (!packetStat.isDirectory()) throw new Error("source packet must be a directory");
  const names = (await fs.readdir(packet)).sort((left, right) => left.localeCompare(right));
  const allowed = ["attachments", "chunks", "extracted.md", "manifest.json", "original"];
  if (names.length !== allowed.length || names.some((name, index) => name !== allowed[index]))
    throw new Error("source packet contains unexpected artifacts");
  const requiredDirectory = async (name: string): Promise<string> => {
    const target = join(packet, name);
    const stat = await lstatNoFollow(target);
    if (!stat.isDirectory()) throw new Error(`source packet ${name} must be a directory`);
    return target;
  };
  const originalRoot = await requiredDirectory("original");
  const chunksRoot = await requiredDirectory("chunks");
  const attachmentsRoot = await requiredDirectory("attachments");
  const manifestPath = join(packet, "manifest.json");
  const manifestStat = await lstatNoFollow(manifestPath);
  if (!manifestStat.isFile()) throw new Error("source manifest must be a regular file");
  const manifest = parseManifestValue(JSON.parse((await readNoFollow(manifestPath)).toString("utf8")) as unknown);
  const attachmentFiles = await walkFiles(attachmentsRoot, "", false);
  const expectedAttachments = manifestAttachments(manifest.attachments);
  const actualAttachments = attachmentFiles.map((file) => ({
    path: file.path,
    byteLength: file.size,
    digest: file.digest,
  }));
  if (canonical(expectedAttachments) !== canonical(actualAttachments))
    throw new Error("retained source attachments mismatch");
  if (
    manifest.id !== manifest.sourceId ||
    manifest.sourceId !== expected.sourceId ||
    manifest.originalDigest !== expected.originalDigest
  )
    throw new Error("retained source packet identity mismatch");
  manifestDigest(manifest.originalDigest, "originalDigest");
  const originalFiles = await walkFiles(originalRoot, "", false);
  const expectedFiles = manifest.files.map((file, index) => {
    const record = file as unknown as Record<string, unknown>;
    const relativePath = record.relativePath;
    if (typeof relativePath !== "string" || typeof record.path !== "string" || record.path !== relativePath)
      throw new Error(`invalid source manifest file ${index}`);
    const normalizedPath = validRelativePath(relativePath);
    const byteLength = manifestInteger(record.byteLength, `files[${index}].byteLength`);
    if (manifestInteger(record.bytes, `files[${index}].bytes`) !== byteLength)
      throw new Error(`source manifest file length mismatch: ${relativePath}`);
    return {
      relativePath: normalizedPath,
      byteLength,
      digest: manifestDigest(record.digest, `files[${index}].digest`),
    };
  });
  const actualFiles = originalFiles.map((file) => ({
    relativePath: file.path,
    byteLength: file.size,
    digest: file.digest,
  }));
  if (canonical(expectedFiles) !== canonical(actualFiles)) throw new Error("retained source original files mismatch");
  const originalBytes = actualFiles.reduce((sum, file) => sum + file.byteLength, 0);
  if (
    manifestInteger(manifest.originalBytes, "originalBytes") !== originalBytes ||
    manifestInteger(manifest.originalByteLength, "originalByteLength") !== originalBytes
  )
    throw new Error("retained source original length mismatch");
  const extractedPath = join(packet, "extracted.md");
  const extractedStat = await lstatNoFollow(extractedPath);
  if (!extractedStat.isFile()) throw new Error("source extraction must be a regular file");
  const extracted = await readNoFollow(extractedPath);
  const extractedLength = manifestInteger(manifest.extractedByteLength, "extractedByteLength");
  if (
    manifestInteger(manifest.extractionBytes, "extractionBytes") !== extractedLength ||
    extractedLength !== extracted.byteLength
  )
    throw new Error("retained source extraction length mismatch");
  const extractedDigest = manifestDigest(manifest.extractedDigest, "extractedDigest");
  if (
    manifestDigest(manifest.extractionDigest, "extractionDigest") !== extractedDigest ||
    digestBytes(extracted) !== extractedDigest
  )
    throw new Error("retained source extraction digest mismatch");
  const atoms = atomizeExtraction(extracted);
  const chunkNames = (await fs.readdir(chunksRoot)).sort((left, right) => left.localeCompare(right));
  if (!manifest.chunks.length || chunkNames.length !== manifest.chunks.length)
    throw new Error("retained source chunks are incomplete");
  const chunkBodies: Buffer[] = [];
  let nextAtom = 0;
  let nextByte = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    const record = chunk as unknown as Record<string, unknown>;
    const expectedName = `${String(index + 1).padStart(4, "0")}.md`;
    if (chunkNames[index] !== expectedName) throw new Error("retained source chunk order is invalid");
    const chunkPath = join(chunksRoot, expectedName);
    const chunkStat = await lstatNoFollow(chunkPath);
    if (!chunkStat.isFile()) throw new Error("source chunk must be a regular file");
    const body = await readNoFollow(chunkPath);
    if (
      manifestInteger(record.index, `chunks[${index}].index`) !== index ||
      manifestInteger(record.ordinal, `chunks[${index}].ordinal`) !== index ||
      record.sourceId !== expected.sourceId ||
      record.chunkId !== `${expected.sourceId}:${index}` ||
      record.relativePath !== "extracted.md"
    )
      throw new Error("retained source chunk metadata mismatch");
    const startAtom = manifestInteger(record.startAtom, `chunks[${index}].startAtom`);
    const atomStart = manifestInteger(record.atomStart, `chunks[${index}].atomStart`);
    const endAtom = manifestInteger(record.endAtom, `chunks[${index}].endAtom`);
    const atomEnd = manifestInteger(record.atomEnd, `chunks[${index}].atomEnd`);
    const startByte = manifestInteger(record.startByte, `chunks[${index}].startByte`);
    const endByte = manifestInteger(record.endByte, `chunks[${index}].endByte`);
    if (
      startAtom !== atomStart ||
      endAtom !== atomEnd ||
      startAtom !== nextAtom ||
      endAtom <= startAtom ||
      endAtom > atoms.length ||
      startByte !== nextByte ||
      endByte < startByte ||
      endByte - startByte !== body.byteLength ||
      endByte - startByte !== manifestInteger(record.byteLength, `chunks[${index}].byteLength`)
    )
      throw new Error("retained source chunk coverage is invalid");
    const firstAtom = atoms[startAtom];
    const lastAtom = atoms[endAtom - 1];
    if (
      !firstAtom ||
      !lastAtom ||
      firstAtom.startByte !== startByte ||
      lastAtom.endByte !== endByte ||
      !body.equals(extracted.subarray(startByte, endByte)) ||
      digestBytes(body) !== manifestDigest(record.digest, `chunks[${index}].digest`)
    )
      throw new Error("retained source chunk digest mismatch");
    chunkBodies.push(body);
    nextAtom = endAtom;
    nextByte = endByte;
  }
  if (nextAtom !== atoms.length || nextByte !== extracted.byteLength || !Buffer.concat(chunkBodies).equals(extracted))
    throw new Error("retained source chunk reconstruction is incomplete");
  return manifest;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid prepared metadata ${label}`);
  return value as Record<string, unknown>;
}
function integerField(record: Record<string, unknown>, key: string, minimum = 0): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum)
    throw new Error(`invalid prepared metadata ${key}`);
  return value;
}
function identityField(value: unknown, label: string): PhysicalIdentity {
  const record = objectRecord(value, label);
  const mode = record.mode;
  if (
    typeof record.device !== "string" ||
    typeof record.inode !== "string" ||
    typeof mode !== "number" ||
    !Number.isInteger(mode) ||
    typeof record.size !== "number" ||
    !Number.isInteger(record.size) ||
    record.size < 0 ||
    typeof record.mtimeNs !== "string"
  )
    throw new Error(`invalid prepared metadata ${label}`);
  return { device: record.device, inode: record.inode, mode, size: record.size, mtimeNs: record.mtimeNs };
}
function parsePreparedMetadata(raw: unknown): PersistedPreparedAdmission {
  const record = objectRecord(raw, "root");
  const preparedId = requiredString(record, "preparedId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(preparedId))
    throw new Error("invalid prepared metadata preparedId");
  const claimId = requiredString(record, "claimId");
  const kind = requiredString(record, "kind") as SourceKind;
  if (!SOURCE_KINDS.includes(kind)) throw new Error("invalid prepared metadata kind");
  const displayName = requiredString(record, "displayName");
  const digest = requiredString(record, "digest");
  const snapshotPath = validRelativePath(requiredString(record, "snapshotPath"));
  const extractedPath = validRelativePath(requiredString(record, "extractedPath"));
  const filesValue = record.files;
  if (!Array.isArray(filesValue)) throw new Error("invalid prepared metadata files");
  const files = filesValue.map((value) => {
    const item = objectRecord(value, "file");
    const relativePath = validRelativePath(requiredString(item, "relativePath"));
    const byteLength = integerField(item, "byteLength");
    const fileDigest = requiredString(item, "digest");
    return { relativePath, byteLength, digest: fileDigest };
  });
  if (new Set(files.map((file) => file.relativePath)).size !== files.length)
    throw new Error("invalid prepared metadata duplicate file");
  const atomsValue = record.atoms;
  if (!Array.isArray(atomsValue)) throw new Error("invalid prepared metadata atoms");
  const atoms = atomsValue.map((value) => {
    const item = objectRecord(value, "atom");
    const index = integerField(item, "index");
    const startByte = integerField(item, "startByte");
    const endByte = integerField(item, "endByte");
    const byteLength = integerField(item, "byteLength");
    if (endByte < startByte || endByte - startByte !== byteLength)
      throw new Error("invalid prepared metadata atom bounds");
    return { index, startByte, endByte, byteLength };
  });
  const entryRelativePath = validRelativePath(requiredString(record, "entryRelativePath"));
  const entryIdentity = identityField(record.entryIdentity, "entryIdentity");
  const snapshotIdentity = identityField(record.snapshotIdentity, "snapshotIdentity");
  const snapshotBytes = integerField(record, "snapshotBytes");
  const revision = record.revision === undefined ? undefined : requiredString(record, "revision");
  let metadata: StageMetadata | undefined;
  if (record.metadata !== undefined) {
    const metadataJson = JSON.stringify(record.metadata);
    if (metadataJson === undefined) throw new Error("invalid prepared metadata metadata");
    metadata = parseMetadata(metadataJson);
  }
  const converterValue = record.converter;
  let converter: { name: string; version: string } | undefined;
  if (converterValue !== undefined) {
    const item = objectRecord(converterValue, "converter");
    converter = { name: requiredString(item, "name"), version: requiredString(item, "version") };
  }
  const attachmentsValue = record.attachments;
  if (!Array.isArray(attachmentsValue)) throw new Error("invalid prepared metadata attachments");
  const attachments = attachmentsValue.map((value) => {
    const item = objectRecord(value, "attachment");
    return {
      path: validRelativePath(requiredString(item, "path")),
      byteLength: integerField(item, "byteLength"),
      digest: requiredString(item, "digest"),
    };
  });
  if (new Set(attachments.map((attachment) => attachment.path)).size !== attachments.length)
    throw new Error("invalid prepared metadata duplicate attachment");
  const extractedDigest = requiredString(record, "extractedDigest");
  const extractedByteLength = integerField(record, "extractedByteLength");
  return {
    preparedId,
    claimId,
    kind,
    displayName,
    digest,
    snapshotPath,
    extractedPath,
    files,
    atoms,
    entryRelativePath,
    entryIdentity,
    snapshotIdentity,
    snapshotBytes,
    revision,
    metadata,
    converter,
    attachments,
    extractedDigest,
    extractedByteLength,
  };
}

async function copyPathNoFollow(source: string, target: string): Promise<void> {
  const stat = await lstatNoFollow(source);
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink()) throw new Error(`symlink rejected: ${target}`);
    throw new Error(`staging target already exists: ${target}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: false, mode: 0o700 });
    for (const name of (await fs.readdir(source)).sort((left, right) => left.localeCompare(right))) {
      if (name === ".git") continue;
      validRelativePath(name);
      await copyPathNoFollow(join(source, name), join(target, name));
    }
    return;
  }
  const bytes = await readNoFollow(source);
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await openFile(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
async function copyRepositoryNoSecrets(target: string, files: FileSnapshot[], metadata: StageMetadata): Promise<void> {
  await fs.mkdir(target, { recursive: false, mode: 0o700 });
  await fs.writeFile(join(target, ENVELOPE_NAME), `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
  await writeTree(join(target, metadata.payload), files);
}

export class SourceService {
  readonly db: ScholarDatabase;
  readonly paths: VaultPathsLike;
  readonly adapters: SourceAdapters;
  private readonly retainedPrepared = new Map<string, { prepared: PreparedAdmission; seal: string }>();
  constructor(db: ScholarDatabase, paths: VaultPathsLike, adapters: SourceAdapters = {}) {
    this.db = db;
    this.paths = paths;
    this.adapters = adapters;
  }
  private inbox(): string {
    return pathFor(this.paths, "inbox");
  }
  private readonly completedPrepared = new Map<string, { prepared: PreparedAdmission; result: AdmissionResult }>();
  private async ensureInbox(): Promise<void> {
    const inbox = this.inbox();
    try {
      const stat = await lstatNoFollow(inbox);
      if (!stat.isDirectory()) throw new Error("inbox root must be a real directory");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"))
        throw error;
      await fs.mkdir(inbox, { recursive: false, mode: 0o700 });
      const stat = await lstatNoFollow(inbox);
      if (!stat.isDirectory()) throw new Error("inbox root must be a real directory");
    }
  }
  private sources(): string {
    return pathFor(this.paths, "sources");
  }
  private work(): string {
    return pathFor(this.paths, "work");
  }
  private preparedRoot(preparedId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(preparedId))
      throw new Error("invalid prepared id");
    return safeRelativePath(this.work(), `admission-${preparedId}`);
  }
  private preparedMetadataPath(preparedId: string): string {
    return join(this.preparedRoot(preparedId), ".pi-scholar-prepared.json");
  }
  private async loadPrepared(preparedId: string): Promise<PersistedPreparedAdmission> {
    const metadataPath = this.preparedMetadataPath(preparedId);
    const stat = await lstatNoFollow(metadataPath);
    if (!stat.isFile()) throw new Error("prepared metadata must be a regular file");
    const raw = JSON.parse((await readNoFollow(metadataPath)).toString("utf8")) as unknown;
    const prepared = parsePreparedMetadata(raw);
    if (prepared.preparedId !== preparedId) throw new Error("prepared id mismatch");
    return prepared;
  }
  private async revalidateClaim(claim: SourceClaim): Promise<SourceClaim> {
    const entry = (await this.discover()).find((candidate) => candidate.relativePath === claim.entry.relativePath);
    if (!entry) throw new Error("source claim entry is missing");
    const current = await this.claim(entry);
    if (
      current.claimId !== claim.claimId ||
      current.snapshot.digest !== claim.snapshot.digest ||
      !sameIdentity(current.entry.identity, claim.entry.identity) ||
      !sameIdentity(current.snapshot.identity, claim.snapshot.identity)
    )
      throw new Error("source claim is stale");
    return current;
  }
  private assertPreparedClaim(prepared: PersistedPreparedAdmission, claim: SourceClaim, digest: string): void {
    if (
      prepared.claimId !== claim.claimId ||
      prepared.entryRelativePath !== claim.entry.relativePath ||
      prepared.digest !== digest ||
      claim.snapshot.digest !== digest ||
      !sameIdentity(prepared.entryIdentity, claim.entry.identity) ||
      !sameIdentity(prepared.snapshotIdentity, claim.snapshot.identity) ||
      prepared.snapshotBytes !== claim.snapshot.bytes
    )
      throw new Error("prepared source claim is stale");
    const expectedFiles = claim.snapshot.files.map((file) => ({
      relativePath: file.path,
      byteLength: file.size,
      digest: file.digest,
    }));
    if (canonical(expectedFiles) !== canonical(prepared.files)) throw new Error("prepared source files changed");
  }
  private async defaultFetch(url: URL): Promise<{ bytes: Uint8Array; mediaType?: string; name?: string }> {
    let current = new URL(url.toString());
    for (let redirect = 0; ; redirect++) {
      if (!["http:", "https:"].includes(current.protocol)) throw new Error("source redirect protocol is not allowed");
      const response = await requestSource(current, await safeAddressFor(current));
      if (response.location !== undefined) {
        if (redirect >= MAX_SOURCE_REDIRECTS) throw new Error("source redirect limit exceeded");
        current = new URL(response.location, current);
        continue;
      }
      if (!response.bytes) throw new Error("source response body is missing");
      return { bytes: response.bytes, mediaType: response.mediaType, name: basename(current.pathname) || undefined };
    }
  }
  private async stageEnvelope(
    metadata: StageMetadata,
    bytes: Uint8Array,
  ): Promise<{ relativePath: string; absolutePath: string; kind: SourceKind; metadata: StageMetadata }> {
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
    const name = `${randomUUID()}.pi-scholar`;
    const target = safeRelativePath(this.inbox(), name);
    await fs.mkdir(target, { recursive: false, mode: 0o700 });
    try {
      const metadataPath = join(target, ENVELOPE_NAME);
      const payloadPath = join(target, metadata.payload);
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
      await fs.writeFile(payloadPath, Buffer.from(bytes), { flag: "wx", mode: 0o600 });
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      throw error;
    }
    return { relativePath: name, absolutePath: target, kind: metadata.kind, metadata };
  }
  async stage(
    request: SourceStageRequest,
  ): Promise<{ relativePath: string; absolutePath: string; kind: SourceKind; metadata?: StageMetadata }> {
    await this.ensureInbox();
    const forms = [
      request.url !== undefined,
      request.text !== undefined,
      request.bytes !== undefined,
      request.path !== undefined,
      request.filePath !== undefined,
    ].filter(Boolean).length;
    if (forms > 1) throw new Error("source input has multiple payloads");
    if (request.url !== undefined) {
      if (request.kind !== undefined && request.kind !== "url") throw new Error("URL source kind must be url");
      const parsed = new URL(request.url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("only HTTP(S) URLs are accepted");
      const fetched = this.adapters.fetchUrl
        ? await this.adapters.fetchUrl(parsed.toString())
        : await this.defaultFetch(parsed);
      if (fetched.bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
      const rawName = request.name ?? fetched.name ?? (basename(parsed.pathname) || "source.txt");
      const originalName = validRelativePath(request.originalName ?? rawName);
      const displayName = request.displayName ?? originalName;
      const mediaType = request.mediaType ?? fetched.mediaType;
      if (
        /[\u0000-\u001f\u007f]/u.test(displayName) ||
        (mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(mediaType))
      )
        throw new Error("invalid staged source metadata");
      const metadata: StageMetadata = {
        version: 1,
        requestedKind: request.kind ?? "url",
        kind: "url",
        displayName,
        originalName,
        sourceUri: provenanceUrl(parsed),
        mediaType,
        payload: "payload",
      };
      return this.stageEnvelope(metadata, fetched.bytes);
    }
    if (request.text !== undefined) {
      if (request.kind !== undefined && request.kind !== "text" && request.kind !== "pasted")
        throw new Error("text source kind must be text or pasted");
      const rawName = request.name ?? "source.txt";
      const originalName = validRelativePath(request.originalName ?? rawName);
      const requestedKind = request.kind ?? "pasted";
      const bytes = Buffer.from(request.text, "utf8");
      const displayName = request.displayName ?? originalName;
      if (
        /[\u0000-\u001f\u007f]/u.test(displayName) ||
        (request.mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(request.mediaType))
      )
        throw new Error("invalid staged source metadata");
      const metadata: StageMetadata = {
        version: 1,
        requestedKind,
        kind: "text",
        displayName,
        originalName,
        mediaType: request.mediaType,
        payload: "payload",
      };
      return this.stageEnvelope(metadata, bytes);
    }
    if (request.bytes !== undefined) {
      if (request.kind !== "upload") throw new Error("bytes source kind must be upload");
      if (!(request.bytes instanceof Uint8Array)) throw new Error("bytes source payload must be binary");
      const rawName = request.name ?? "source.txt";
      const originalName = validRelativePath(request.originalName ?? rawName);
      const bytes = Buffer.from(request.bytes);
      const kind = inferKind(originalName);
      const displayName = request.displayName ?? originalName;
      if (
        /[\u0000-\u001f\u007f]/u.test(displayName) ||
        (request.mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(request.mediaType))
      )
        throw new Error("invalid staged source metadata");
      const metadata: StageMetadata = {
        version: 1,
        requestedKind: "upload",
        kind,
        displayName,
        originalName,
        mediaType: request.mediaType,
        payload: "payload",
      };
      return this.stageEnvelope(metadata, bytes);
    }
    const input = request.path ?? request.filePath;
    if (!input) throw new Error("source input is required");
    if (request.kind !== undefined && !SOURCE_KINDS.includes(request.kind as SourceKind))
      throw new Error("invalid source kind");
    const source = resolve(input);
    const name = validRelativePath(request.name ?? basename(source));
    if (name.includes("/")) throw new Error("staging name must be a single filename");
    await rejectSymlinkAncestors(source);
    const stat = await lstatNoFollow(source);
    const repository = stat.isDirectory() && (await this.isRepository(source));
    const kind: SourceKind = repository ? "repository" : inferKind(source, stat);
    if (!repository && inferKind(name, stat) !== kind) throw new Error(`staging name kind must be ${kind}`);
    let initialRevision: string | undefined;
    let verifiedGitRevision = false;
    if (repository) {
      try {
        initialRevision = await repositoryRevision(source);
        verifiedGitRevision = true;
      } catch (error) {
        if (!this.adapters.gitRevision) throw error;
        initialRevision = await this.revision(source);
      }
    }
    const files = repository ? await repositoryFiles(source) : undefined;
    if (repository && verifiedGitRevision) {
      const finalRevision = await repositoryRevision(source);
      if (initialRevision !== finalRevision) throw new Error("repository changed during staging");
    }
    if (repository && !initialRevision) throw new Error("repository revision is unavailable");
    if (!repository) await measurePath(source);
    if (request.kind !== undefined && request.kind !== kind) throw new Error(`path source kind must be ${kind}`);
    const revision = repository
      ? this.adapters.gitRevision
        ? await this.revision(source)
        : initialRevision
      : undefined;
    const metadata = repository
      ? (() => {
          const originalName = validRelativePath(request.originalName ?? name);
          const displayName = request.displayName ?? originalName;
          if (
            /[\u0000-\u001f\u007f]/u.test(displayName) ||
            (request.mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(request.mediaType))
          )
            throw new Error("invalid staged source metadata");
          return {
            version: 1 as const,
            requestedKind: (request.kind ?? kind) as InputKind,
            kind,
            displayName,
            originalName,
            mediaType: request.mediaType,
            repositoryRevision: revision,
            payload: "payload" as const,
          };
        })()
      : undefined;
    const targetName = repository ? `${randomUUID()}.pi-scholar` : name;
    const target = safeRelativePath(this.inbox(), targetName);
    if (source !== target) {
      let targetExisted = false;
      try {
        await lstatNoFollow(target);
        targetExisted = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"))
          throw error;
      }
      if (targetExisted) throw new Error(`staging target already exists: ${target}`);
      try {
        if (repository) await copyRepositoryNoSecrets(target, files ?? [], metadata!);
        else await copyPathNoFollow(source, target);
      } catch (error) {
        if (!targetExisted) {
          try {
            await fs.rm(target, { recursive: true, force: true });
          } catch {
            /* Preserve the original staging failure. */
          }
        }
        throw error;
      }
    }
    return {
      relativePath: relative(this.inbox(), target).replaceAll("\\", "/"),
      absolutePath: target,
      kind,
      ...(metadata ? { metadata } : {}),
    };
  }
  async discover(): Promise<InboxEntry[]> {
    const inbox = this.inbox();
    const entries: InboxEntry[] = [];
    for (const name of (await fs.readdir(inbox)).sort((a, b) => a.localeCompare(b))) {
      const path = join(inbox, name);
      try {
        const stat = await lstatNoFollow(path);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error("unsupported inbox entry");
        const metadata = stat.isDirectory() ? await stagedMetadata(path) : undefined;
        const kind = metadata
          ? metadata.requestedKind === "upload"
            ? inferKind(metadata.originalName ?? metadata.displayName)
            : metadata.kind
          : stat.isDirectory()
            ? (await this.isRepository(path))
              ? "repository"
              : "directory"
            : inferKind(path, stat);
        entries.push({
          relativePath: name.replaceAll("\\", "/"),
          absolutePath: path,
          kind,
          identity: statIdentity(stat),
          metadata,
        });
      } catch (error) {
        entries.push({
          relativePath: name.replaceAll("\\", "/"),
          absolutePath: path,
          kind: "text",
          identity: { device: "", inode: "", mode: 0, size: 0, mtimeNs: "" },
          digest: `error:${error instanceof Error ? error.message : String(error)}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return entries.sort(
      (left, right) =>
        Number(Boolean(left.error)) - Number(Boolean(right.error)) ||
        left.relativePath.localeCompare(right.relativePath),
    );
  }
  private async snapshotForEntry(entry: InboxEntry, revision?: string): Promise<TreeSnapshot> {
    const root = entry.metadata ? join(entry.absolutePath, entry.metadata.payload) : entry.absolutePath;
    return snapshotPath(root, entry.relativePath, entry.kind, revision, entry.metadata);
  }
  async claim(entry: InboxEntry): Promise<SourceClaim> {
    if (entry.error) throw new Error(entry.error);
    const current = await lstatNoFollow(entry.absolutePath);
    if (!sameIdentity(statIdentity(current), entry.identity)) throw new Error("inbox entry changed before claim");
    const metadata = current.isDirectory() ? await stagedMetadata(entry.absolutePath) : undefined;
    if (canonical(metadata ?? null) !== canonical(entry.metadata ?? null))
      throw new Error("inbox entry metadata changed before claim");
    const kind = metadata
      ? metadata.requestedKind === "upload"
        ? inferKind(metadata.originalName ?? metadata.displayName)
        : metadata.kind
      : entry.kind;
    const validatedEntry = { ...entry, kind, metadata };
    const repository = current.isDirectory() && !metadata && (await this.isRepository(entry.absolutePath));
    const stagedRepository = current.isDirectory() && metadata?.kind === "repository";
    const revision = repository
      ? await this.revision(entry.absolutePath)
      : stagedRepository
        ? metadata?.repositoryRevision
        : undefined;
    if ((repository || stagedRepository) && !revision) throw new Error("repository revision is unavailable");
    const snapshot = await this.snapshotForEntry(validatedEntry, revision);
    const afterEntry = await lstatNoFollow(entry.absolutePath);
    const afterMetadata = afterEntry.isDirectory() ? await stagedMetadata(entry.absolutePath) : undefined;
    const afterValidatedEntry = { ...validatedEntry, metadata: afterMetadata };
    const afterRevision = repository
      ? await this.revision(entry.absolutePath)
      : stagedRepository
        ? afterMetadata?.repositoryRevision
        : undefined;
    if (repository && afterRevision !== revision) throw new Error("repository changed during snapshot");
    const after = await this.snapshotForEntry(afterValidatedEntry, afterRevision);
    if (
      !sameIdentity(statIdentity(afterEntry), entry.identity) ||
      canonical(afterMetadata ?? null) !== canonical(metadata ?? null) ||
      snapshot.digest !== after.digest ||
      !sameIdentity(snapshot.identity, after.identity)
    )
      throw new Error("inbox entry changed during snapshot");
    const claimId = deterministicUuid(
      canonical({
        scope: "claim",
        digest: snapshot.digest,
        identity: snapshot.identity,
        revision,
        kind: snapshot.kind,
        metadata: snapshot.metadata,
      }),
    );
    return { claimId, entry: validatedEntry, snapshot, claimedAt: new Date().toISOString() };
  }
  async prepareClaim(input: SourceClaim | InboxEntry): Promise<PreparedAdmission> {
    const supplied = "snapshot" in input ? input : await this.claim(input);
    const claim = await this.revalidateClaim(supplied);
    const preparedId = randomUUID();
    const root = this.preparedRoot(preparedId);
    const originalRoot = join(root, "original");
    const attachmentsRoot = join(root, "attachments");
    const extractedAbsolute = join(root, "extracted.md");
    await fs.mkdir(this.work(), { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(root, { recursive: false, mode: 0o700 });
      await fs.mkdir(join(root, "chunks"), { recursive: false, mode: 0o700 });
      await fs.mkdir(attachmentsRoot, { recursive: false, mode: 0o700 });
      await writeTree(originalRoot, claim.snapshot.files);
      const mediaType = claim.snapshot.metadata?.mediaType;
      const useDocling =
        claim.snapshot.kind === "document" || (claim.snapshot.kind === "url" && !textualUrl(claim, mediaType));
      let extracted: Buffer;
      let attachments: Array<{ path: string; bytes: Uint8Array | string }> = [];
      let converter: { name: string; version: string } | undefined;
      if (useDocling) {
        if (!this.adapters.docling) throw new Error("Docling adapter is required for document extraction");
        if (claim.snapshot.files.length !== 1) throw new Error("Docling requires a single regular document file");
        const originalFile = claim.snapshot.files[0];
        if (!originalFile) throw new Error("Docling requires a document file");
        const originalPath = ensureWithin(originalRoot, join(originalRoot, validRelativePath(originalFile.path)));
        const originalStat = await lstatNoFollow(originalPath);
        if (!originalStat.isFile()) throw new Error("Docling input must be a regular file");
        const converted =
          typeof this.adapters.docling === "function"
            ? await this.adapters.docling({ claim, originalPath, kind: claim.snapshot.kind, mediaType })
            : await this.adapters.docling.convert({ claim, originalPath, kind: claim.snapshot.kind, mediaType });
        const normalizedResult = await normalizeDoclingResult(converted);
        extracted = Buffer.from(normalizedResult.extracted);
        converter = {
          name: normalizedResult.converter?.name ?? "docling",
          version: normalizedResult.converter?.version ?? "unknown",
        };
        attachments = normalizedResult.attachments ?? [];
      } else extracted = nativeExtraction(claim.snapshot);
      if (!extracted.length) throw new Error("empty extraction");
      if (extracted.byteLength > MAX_SOURCE_BYTES) throw new Error("extraction exceeds 100 MiB limit");
      await fs.writeFile(extractedAbsolute, extracted, { flag: "wx", mode: 0o600 });
      const attachmentSnapshots: FileSnapshot[] = [];
      let attachmentBytes = 0;
      for (const attachment of attachments) {
        const attachmentPath = validRelativePath(attachment.path);
        const bytes = Buffer.from(attachment.bytes);
        attachmentBytes += bytes.byteLength;
        if (bytes.byteLength > MAX_SOURCE_BYTES || attachmentBytes > MAX_SOURCE_BYTES)
          throw new Error("attachment exceeds 100 MiB limit");
        attachmentSnapshots.push({ path: attachmentPath, size: bytes.byteLength, digest: digestBytes(bytes), bytes });
      }
      await writeTree(attachmentsRoot, attachmentSnapshots);
      const atoms = atomizeExtraction(extracted).map((atom) => ({
        index: atom.index,
        startByte: atom.startByte,
        endByte: atom.endByte,
        byteLength: atom.endByte - atom.startByte,
      }));
      const prepared: PreparedAdmission = {
        preparedId,
        claimId: claim.claimId,
        kind: claim.snapshot.kind,
        displayName: claim.snapshot.metadata?.displayName ?? claim.entry.relativePath,
        digest: claim.snapshot.digest,
        snapshotPath: workArtifactRelative(this.paths, originalRoot),
        extractedPath: workArtifactRelative(this.paths, extractedAbsolute),
        files: claim.snapshot.files.map((file) => ({
          relativePath: file.path,
          byteLength: file.size,
          digest: file.digest,
        })),
        atoms,
      };
      const attachmentRecords = attachmentSnapshots
        .map(({ path, size, digest }) => ({ path, byteLength: size, digest }))
        .sort((left, right) => left.path.localeCompare(right.path));
      const persisted: PersistedPreparedAdmission = {
        ...prepared,
        entryRelativePath: claim.entry.relativePath,
        entryIdentity: claim.entry.identity,
        snapshotIdentity: claim.snapshot.identity,
        snapshotBytes: claim.snapshot.bytes,
        revision: claim.snapshot.revision,
        metadata: claim.snapshot.metadata,
        converter,
        attachments: attachmentRecords,
        extractedDigest: digestBytes(extracted),
        extractedByteLength: extracted.byteLength,
      };
      const seal = canonical(persisted);
      await fs.writeFile(this.preparedMetadataPath(preparedId), `${JSON.stringify(persisted, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      this.retainedPrepared.set(preparedId, { prepared, seal });
      return prepared;
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  async cleanupPrepared(preparedId: string): Promise<void> {
    const root = resolve(this.preparedRoot(preparedId));
    const work = resolve(this.work());
    const withinWork = relative(work, root).replaceAll("\\", "/");
    if (!withinWork || withinWork === ".." || withinWork.startsWith("../") || isAbsolute(withinWork))
      throw new Error("prepared path escapes work");
    await fs.rm(root, { recursive: true, force: true });
    this.retainedPrepared.delete(preparedId);
  }
  private async publishPacket(
    manifest: SourceManifest,
    temporary: string,
    packet: string,
    claim: SourceClaim,
  ): Promise<{ manifest: SourceManifest; removedInbox: boolean }> {
    let createdPacket = false;
    let temporaryPresent = true;
    let createdPacketIdentity: PhysicalIdentity | undefined;
    let publishedManifest = manifest;
    try {
      await fs.mkdir(this.sources(), { recursive: true, mode: 0o700 });
      try {
        await fs.rename(temporary, packet);
        createdPacket = true;
      } catch (error) {
        const packetExists = await lstatNoFollow(packet).then(
          (stat) => stat.isDirectory(),
          (error) => {
            if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
              return false;
            throw error;
          },
        );
        if (!packetExists) throw error;
        const raced = parseManifest(packet);
        if (raced.sourceId !== manifest.sourceId || raced.originalDigest !== claim.snapshot.digest) throw error;
        publishedManifest = raced;
        await fs.rm(temporary, { recursive: true, force: true });
        temporaryPresent = false;
      }
      if (createdPacket) {
        createdPacketIdentity = statIdentity(await lstatNoFollow(packet));
        temporaryPresent = false;
      }
      publishedManifest = await verifyRetainedPacket(packet, {
        sourceId: manifest.sourceId,
        originalDigest: claim.snapshot.digest,
      });
      this.recordSource(publishedManifest, packet);
    } catch (error) {
      if (createdPacket && createdPacketIdentity) {
        try {
          const current = await lstatNoFollow(packet);
          if (sameIdentity(statIdentity(current), createdPacketIdentity))
            await fs.rm(packet, { recursive: true, force: false });
        } catch {
          /* Preserve the database or publication failure. */
        }
      }
      throw error;
    } finally {
      if (temporaryPresent) {
        try {
          await fs.rm(temporary, { recursive: true, force: true });
        } catch {
          /* Best-effort cleanup after a failed publication. */
        }
      }
    }
    return { manifest: publishedManifest, removedInbox: await this.removeInboxAfterAdmission(claim) };
  }
  async publishPreparedClaim(input: {
    prepared: PreparedAdmission;
    preparedId: string;
    claimId: string;
    digest: string;
    endpoints?: readonly number[];
  }): Promise<AdmissionResult> {
    const completed = this.completedPrepared.get(input.preparedId);
    if (completed) {
      if (
        completed.prepared !== input.prepared ||
        completed.result.claim.claimId !== input.claimId ||
        completed.result.claim.snapshot.digest !== input.digest
      )
        throw new Error("prepared admission identity mismatch");
      return completed.result;
    }
    const retained = this.retainedPrepared.get(input.preparedId);
    if (!retained || retained.prepared !== input.prepared)
      throw new Error("prepared admission is not the retained host record");
    const prepared = await this.loadPrepared(input.preparedId);
    if (canonical(prepared) !== retained.seal || prepared.claimId !== input.claimId || prepared.digest !== input.digest)
      throw new Error("prepared claim identity mismatch");
    const preparedRoot = this.preparedRoot(prepared.preparedId);
    const originalRoot = resolveWorkArtifact(this.paths, prepared.snapshotPath);
    const extractedPath = resolveWorkArtifact(this.paths, prepared.extractedPath);
    if (
      resolve(originalRoot) !== resolve(join(preparedRoot, "original")) ||
      resolve(extractedPath) !== resolve(join(preparedRoot, "extracted.md"))
    )
      throw new Error("prepared artifact path mismatch");
    const entry = (await this.discover()).find((candidate) => candidate.relativePath === prepared.entryRelativePath);
    if (!entry) throw new Error("source claim entry is missing");
    const claim = await this.claim(entry);
    this.assertPreparedClaim(prepared, claim, input.digest);
    const preparedFiles = await walkFiles(originalRoot);
    const preparedFileRecords = preparedFiles.map((file) => ({
      relativePath: file.path,
      byteLength: file.size,
      digest: file.digest,
    }));
    if (
      canonical(preparedFileRecords) !== canonical(prepared.files) ||
      treeDigest(preparedFiles, prepared.snapshotIdentity, prepared.revision) !== prepared.digest
    )
      throw new Error("prepared snapshot digest mismatch");
    const extracted = await readNoFollow(extractedPath);
    if (extracted.byteLength !== prepared.extractedByteLength || digestBytes(extracted) !== prepared.extractedDigest)
      throw new Error("prepared extraction digest mismatch");
    const actualAtoms = atomizeExtraction(extracted).map((atom) => ({
      index: atom.index,
      startByte: atom.startByte,
      endByte: atom.endByte,
      byteLength: atom.endByte - atom.startByte,
    }));
    if (canonical(actualAtoms) !== canonical(prepared.atoms)) throw new Error("prepared atom index mismatch");
    const preparedAttachmentsRoot = ensureWithin(preparedRoot, join(preparedRoot, "attachments"));
    const preparedAttachmentFiles = await walkFiles(preparedAttachmentsRoot);
    const preparedAttachmentRecords = preparedAttachmentFiles.map((file) => ({
      path: file.path,
      byteLength: file.size,
      digest: file.digest,
    }));
    if (canonical(preparedAttachmentRecords) !== canonical(prepared.attachments))
      throw new Error("prepared attachment digest mismatch");
    const chunks = validateChunkEndpoints(extracted, input.endpoints === undefined ? undefined : [...input.endpoints]);
    const existing = await this.normalizeExistingPacket(claim, {});
    if (existing) {
      this.completedPrepared.set(prepared.preparedId, { prepared: input.prepared, result: existing });
      try {
        await this.cleanupPrepared(prepared.preparedId);
      } catch {
        /* Retain the idempotent result; transient work cleanup can be retried. */
      }
      return existing;
    }
    const sourceId = this.sourceIdFor(claim, {});
    const packet = join(this.sources(), sourceId);
    const temporary = join(this.work(), `packet-${sourceId}-${randomUUID()}`);
    await fs.mkdir(temporary, { recursive: false, mode: 0o700 });
    let manifest!: SourceManifest;
    try {
      await writeTree(join(temporary, "original"), preparedFiles);
      await fs.mkdir(join(temporary, "chunks"), { recursive: false, mode: 0o700 });
      const packetAttachments = join(temporary, "attachments");
      await fs.mkdir(packetAttachments, { recursive: false, mode: 0o700 });
      await writeTree(packetAttachments, preparedAttachmentFiles);
      await fs.writeFile(join(temporary, "extracted.md"), extracted, { flag: "wx", mode: 0o600 });
      for (const chunk of chunks)
        await fs.writeFile(join(temporary, "chunks", `${String(chunk.index + 1).padStart(4, "0")}.md`), chunk.body, {
          flag: "wx",
          mode: 0o600,
        });
      const mediaType = prepared.metadata?.mediaType;
      const originalName = validRelativePath(prepared.metadata?.originalName ?? claim.entry.relativePath);
      const capturedAt = new Date().toISOString();
      manifest = {
        id: sourceId,
        sourceId,
        kind: claim.snapshot.kind,
        displayName: prepared.displayName,
        originalName,
        originalUrl: prepared.metadata?.sourceUri,
        sourceUri: prepared.metadata?.sourceUri,
        revision: claim.snapshot.revision,
        repositoryRevision: claim.snapshot.revision,
        mediaType,
        inputKind: prepared.metadata?.requestedKind,
        stagedMetadata: prepared.metadata,
        capturedAt,
        converter: prepared.converter,
        originalBytes: claim.snapshot.bytes,
        originalByteLength: claim.snapshot.bytes,
        originalDigest: claim.snapshot.digest,
        extractionBytes: extracted.byteLength,
        extractedByteLength: extracted.byteLength,
        extractionDigest: prepared.extractedDigest,
        extractedDigest: prepared.extractedDigest,
        files: claim.snapshot.files.map(({ path, size, digest }) => ({
          path,
          relativePath: path,
          bytes: size,
          byteLength: size,
          digest,
          mediaType,
        })),
        attachments: preparedAttachmentFiles.map(({ path, size, digest }) => ({
          path,
          relativePath: path,
          bytes: size,
          byteLength: size,
          digest,
          mediaType,
        })),
        chunks: chunks.map(({ index, startAtom, endAtom, startByte, endByte, digest }) => ({
          index,
          chunkId: `${sourceId}:${index}`,
          sourceId,
          ordinal: index,
          relativePath: "extracted.md",
          byteLength: endByte - startByte,
          atomStart: startAtom,
          atomEnd: endAtom,
          startAtom,
          endAtom,
          startByte,
          endByte,
          digest,
        })),
      };
      await fs.writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await fs.mkdir(this.sources(), { recursive: true, mode: 0o700 });
    } catch (error) {
      try {
        await fs.rm(temporary, { recursive: true, force: true });
      } catch {
        /* Best-effort cleanup after packet construction failure. */
      }
      throw error;
    }
    const published = await this.publishPacket(manifest, temporary, packet, claim);
    const result = {
      sourceId: published.manifest.sourceId,
      manifest: published.manifest,
      packetPath: packet,
      removedInbox: published.removedInbox,
      claim,
    };
    this.completedPrepared.set(prepared.preparedId, { prepared: input.prepared, result });
    try {
      await this.cleanupPrepared(prepared.preparedId);
    } catch {
      /* Retain the idempotent result; transient work cleanup can be retried. */
    }
    return result;
  }

  private async isRepository(path: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(join(path, ".git"));
      return stat.isDirectory() || stat.isFile();
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async revision(path: string): Promise<string | undefined> {
    if (typeof this.adapters.gitRevision === "function") return (await this.adapters.gitRevision(path)) || undefined;
    if (this.adapters.gitRevision) return (await this.adapters.gitRevision.revision(path)) || undefined;
    try {
      return await repositoryRevision(path);
    } catch {
      return undefined;
    }
  }
  private sourceIdFor(
    claim: SourceClaim,
    options: { mediaType?: string; originalName?: string; url?: string },
  ): string {
    const sourceUri = options.url === undefined ? claim.snapshot.metadata?.sourceUri : sanitizedSourceUri(options.url);
    return deterministicUuid(
      canonical({
        scope: "source",
        digest: claim.snapshot.digest,
        identity: claim.snapshot.identity,
        revision: claim.snapshot.revision,
        kind: claim.snapshot.kind,
        metadata: claim.snapshot.metadata,
        mediaType: options.mediaType ?? claim.snapshot.metadata?.mediaType,
        originalName: options.originalName ?? claim.snapshot.metadata?.originalName ?? claim.entry.relativePath,
        sourceUri,
      }),
    );
  }
  private async removeInboxAfterAdmission(claim: SourceClaim): Promise<boolean> {
    try {
      const current = await lstatNoFollow(claim.entry.absolutePath);
      if (!sameIdentity(statIdentity(current), claim.entry.identity)) return false;
      const snapshot = await this.snapshotForEntry(claim.entry, claim.snapshot.revision);
      if (snapshot.digest !== claim.snapshot.digest || !sameIdentity(snapshot.identity, claim.snapshot.identity))
        return false;
      await fs.rm(claim.entry.absolutePath, { recursive: true, force: false });
      return true;
    } catch {
      // Publication is durable; stale or inaccessible inbox cleanup stays pending for retry.
      return false;
    }
  }
  private async normalizeExistingPacket(
    claim: SourceClaim,
    options: { mediaType?: string; originalName?: string; url?: string },
  ): Promise<AdmissionResult | undefined> {
    const sourceId = this.sourceIdFor(claim, options);
    const packet = join(this.sources(), sourceId);
    try {
      const stat = await lstatNoFollow(packet);
      if (!stat.isDirectory()) throw new Error("source packet must be a directory");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw error;
    }
    const manifest = await verifyRetainedPacket(packet, { sourceId, originalDigest: claim.snapshot.digest });
    this.recordSource(manifest, packet);
    return { sourceId, manifest, packetPath: packet, removedInbox: await this.removeInboxAfterAdmission(claim), claim };
  }
  async admitClaim(
    claim: SourceClaim,
    options: {
      endpoints?: Array<number | ChunkPlanEndpoint>;
      mediaType?: string;
      originalName?: string;
      url?: string;
    } = {},
  ): Promise<AdmissionResult> {
    const existing = await this.normalizeExistingPacket(claim, options);
    if (existing) return existing;
    try {
      claim = await this.revalidateClaim(claim);
    } catch (error) {
      const sourceId = this.sourceIdFor(claim, options);
      const row = dbGet<Row>(this.db, "SELECT status FROM sources WHERE source_id = ?", [sourceId]);
      if (String(row?.status ?? "") !== "removed") throw error;
    }
    const sourceId = this.sourceIdFor(claim, options);
    const packet = join(this.sources(), sourceId);
    const temporary = join(this.work(), `packet-${sourceId}-${randomUUID()}`);
    await fs.mkdir(temporary, { recursive: false, mode: 0o700 });
    let manifest!: SourceManifest;
    try {
      await fs.mkdir(join(temporary, "original"), { recursive: false, mode: 0o700 });
      await fs.mkdir(join(temporary, "chunks"), { recursive: false, mode: 0o700 });
      await fs.mkdir(join(temporary, "attachments"), { recursive: false, mode: 0o700 });
      await writeTree(join(temporary, "original"), claim.snapshot.files);
      let extracted: Buffer;
      let attachments: Array<{ path: string; bytes: Uint8Array | string }> = [];
      let converter: { name: string; version: string } | undefined;
      const mediaType = options.mediaType ?? claim.snapshot.metadata?.mediaType;
      const useDocling =
        claim.snapshot.kind === "document" || (claim.snapshot.kind === "url" && !textualUrl(claim, mediaType));
      if (useDocling) {
        if (!this.adapters.docling) throw new Error("Docling adapter is required for document extraction");
        if (claim.snapshot.files.length !== 1) throw new Error("Docling requires a single regular document file");
        const originalFile = claim.snapshot.files[0];
        if (!originalFile) throw new Error("Docling requires a document file");
        const originalRoot = join(temporary, "original");
        const originalPath = ensureWithin(originalRoot, join(originalRoot, validRelativePath(originalFile.path)));
        const originalStat = await lstatNoFollow(originalPath);
        if (!originalStat.isFile()) throw new Error("Docling input must be a regular file");
        const converted =
          typeof this.adapters.docling === "function"
            ? await this.adapters.docling({ claim, originalPath, kind: claim.snapshot.kind, mediaType })
            : await this.adapters.docling.convert({ claim, originalPath, kind: claim.snapshot.kind, mediaType });
        const normalizedResult = await normalizeDoclingResult(converted);
        extracted = Buffer.from(normalizedResult.extracted);
        converter = {
          name: normalizedResult.converter?.name ?? "docling",
          version: normalizedResult.converter?.version ?? "unknown",
        };
        attachments = normalizedResult.attachments ?? [];
      } else extracted = nativeExtraction(claim.snapshot);
      if (!extracted.length) throw new Error("empty extraction");
      if (extracted.byteLength > MAX_SOURCE_BYTES) throw new Error("extraction exceeds 100 MiB limit");
      const chunks = validateChunkEndpoints(extracted, options.endpoints);
      await fs.writeFile(join(temporary, "extracted.md"), extracted, { flag: "wx", mode: 0o600 });
      let attachmentBytes = 0;
      for (const attachment of attachments) {
        const target = ensureWithin(
          join(temporary, "attachments"),
          join(join(temporary, "attachments"), validRelativePath(attachment.path)),
        );
        const bytes = Buffer.from(attachment.bytes);
        attachmentBytes += bytes.byteLength;
        if (bytes.byteLength > MAX_SOURCE_BYTES || attachmentBytes > MAX_SOURCE_BYTES)
          throw new Error("attachment exceeds 100 MiB limit");
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      }
      for (const chunk of chunks)
        await fs.writeFile(join(temporary, "chunks", `${String(chunk.index + 1).padStart(4, "0")}.md`), chunk.body, {
          flag: "wx",
          mode: 0o600,
        });
      const attachmentFiles = await walkFiles(join(temporary, "attachments"), "", false);
      const originalName = validRelativePath(
        options.originalName ?? claim.snapshot.metadata?.originalName ?? claim.entry.relativePath,
      );
      const displayName = options.originalName ?? claim.snapshot.metadata?.displayName ?? originalName;
      const sourceUri =
        options.url === undefined ? claim.snapshot.metadata?.sourceUri : sanitizedSourceUri(options.url);
      const capturedAt = new Date().toISOString();
      manifest = {
        id: sourceId,
        sourceId,
        kind: claim.snapshot.kind,
        displayName,
        originalName,
        originalUrl: sourceUri,
        sourceUri,
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
        files: claim.snapshot.files.map(({ path, size, digest }) => ({
          path,
          relativePath: path,
          bytes: size,
          byteLength: size,
          digest,
          mediaType,
        })),
        attachments: attachmentFiles.map(({ path, size, digest }) => ({
          path,
          relativePath: path,
          bytes: size,
          byteLength: size,
          digest,
          mediaType,
        })),
        chunks: chunks.map(({ index, startAtom, endAtom, startByte, endByte, digest }) => ({
          index,
          chunkId: `${sourceId}:${index}`,
          sourceId,
          ordinal: index,
          relativePath: "extracted.md",
          byteLength: endByte - startByte,
          atomStart: startAtom,
          atomEnd: endAtom,
          startAtom,
          endAtom,
          startByte,
          endByte,
          digest,
        })),
      };
      await fs.writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await fs.mkdir(this.sources(), { recursive: true, mode: 0o700 });
    } catch (error) {
      try {
        await fs.rm(temporary, { recursive: true, force: true });
      } catch {
        /* Best-effort cleanup after packet construction failure. */
      }
      throw error;
    }
    const published = await this.publishPacket(manifest, temporary, packet, claim);
    return {
      sourceId: published.manifest.sourceId,
      manifest: published.manifest,
      packetPath: packet,
      removedInbox: published.removedInbox,
      claim,
    };
  }
  private recordFailure(entry: InboxEntry, error: unknown, claim?: SourceClaim): void {
    const now = new Date().toISOString();
    const sourceId = deterministicUuid(
      canonical({
        scope: "failure",
        path: entry.relativePath,
        identity: entry.identity,
        digest: claim?.snapshot.digest ?? entry.digest ?? "",
        kind: claim?.snapshot.kind ?? entry.kind,
      }),
    );
    const message = error instanceof Error ? error.message : String(error);
    transaction(this.db, () => {
      const existing = dbGet<Row>(this.db, "SELECT source_id FROM sources WHERE source_id = ?", [sourceId]);
      if (existing)
        dbRun(
          this.db,
          "UPDATE sources SET status = ?, display_name = ?, original_name = ?, digest = ?, error_code = ?, error_message = ?, updated_at = ? WHERE source_id = ?",
          [
            "failed",
            entry.metadata?.displayName ?? entry.relativePath,
            entry.metadata?.originalName ?? entry.relativePath,
            claim?.snapshot.digest ?? entry.digest ?? null,
            "ADMISSION_FAILED",
            message,
            now,
            sourceId,
          ],
        );
      else
        dbRun(
          this.db,
          "INSERT INTO sources (source_id, kind, status, display_name, original_name, source_uri, media_type, repository_revision, captured_at, digest, manifest_path, error_code, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            sourceId,
            claim?.snapshot.kind ?? entry.kind,
            "failed",
            entry.metadata?.displayName ?? entry.relativePath,
            entry.metadata?.originalName ?? entry.relativePath,
            entry.metadata?.sourceUri ?? null,
            entry.metadata?.mediaType ?? null,
            claim?.snapshot.revision ?? null,
            now,
            claim?.snapshot.digest ?? entry.digest ?? null,
            null,
            "ADMISSION_FAILED",
            message,
            now,
            now,
          ],
        );
    });
  }
  recordAdmissionFailure(entry: InboxEntry, error: unknown, claim?: SourceClaim): void {
    this.recordFailure(entry, error, claim);
  }
  async admitClaims(
    entries?: InboxEntry[],
  ): Promise<Array<{ claim?: SourceClaim; result?: AdmissionResult; error?: string }>> {
    const pending = entries ?? (await this.discover());
    const results: Array<{ claim?: SourceClaim; result?: AdmissionResult; error?: string }> = [];
    for (const entry of pending) {
      let claim: SourceClaim | undefined;
      try {
        claim = await this.claim(entry);
        results.push({ claim, result: await this.admitClaim(claim) });
      } catch (error) {
        try {
          this.recordFailure(entry, error, claim);
        } catch (diagnosticError) {
          throw new Error(
            `admission failed: ${error instanceof Error ? error.message : String(error)}; diagnostic persistence failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`,
            { cause: diagnosticError },
          );
        }
        results.push({ claim, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }
  private recordSource(manifest: SourceManifest, packet: string): void {
    transaction(this.db, () => {
      const existing = dbGet<Row>(this.db, "SELECT * FROM sources WHERE source_id = ?", [manifest.sourceId]);
      const values = [
        manifest.sourceId,
        manifest.kind,
        "published",
        manifest.displayName,
        manifest.originalName,
        manifest.sourceUri ?? null,
        manifest.mediaType ?? null,
        manifest.repositoryRevision ?? null,
        manifest.capturedAt,
        manifest.originalDigest,
        packet,
        manifest.capturedAt,
        manifest.capturedAt,
      ];
      if (!existing)
        dbRun(
          this.db,
          "INSERT INTO sources (source_id, kind, status, display_name, original_name, source_uri, media_type, repository_revision, captured_at, digest, manifest_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          values,
        );
      else {
        if (String(existing.digest ?? "") !== manifest.originalDigest)
          throw new Error("source identity conflicts with existing database record");
        const now = new Date().toISOString();
        dbRun(
          this.db,
          "UPDATE sources SET kind = ?, status = ?, display_name = ?, original_name = ?, source_uri = ?, media_type = ?, repository_revision = ?, captured_at = ?, digest = ?, manifest_path = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE source_id = ?",
          [
            manifest.kind,
            "published",
            manifest.displayName,
            manifest.originalName,
            manifest.sourceUri ?? null,
            manifest.mediaType ?? null,
            manifest.repositoryRevision ?? null,
            manifest.capturedAt,
            manifest.originalDigest,
            packet,
            now,
            manifest.sourceId,
          ],
        );
      }
      for (const file of manifest.files) {
        const found = dbGet<Row>(this.db, "SELECT * FROM source_files WHERE source_id = ? AND relative_path = ?", [
          manifest.sourceId,
          file.relativePath,
        ]);
        if (!found)
          dbRun(
            this.db,
            "INSERT INTO source_files (source_id, relative_path, byte_length, digest, media_type) VALUES (?, ?, ?, ?, ?)",
            [
              manifest.sourceId,
              file.relativePath,
              file.byteLength,
              file.digest,
              file.mediaType ?? manifest.mediaType ?? null,
            ],
          );
        else if (String(found.digest) !== file.digest || Number(found.byte_length) !== file.byteLength)
          throw new Error("source file identity conflicts with existing database record");
      }
      const expectedChunks = new Map(manifest.chunks.map((chunk) => [chunk.chunkId, chunk]));
      const existingChunks = dbAll<Row>(this.db, "SELECT * FROM source_chunks WHERE source_id = ?", [
        manifest.sourceId,
      ]);
      if (
        existingChunks.length > manifest.chunks.length ||
        existingChunks.some((row) => !expectedChunks.has(String(row.chunk_id)))
      )
        throw new Error("source chunk catalog set conflicts with retained packet");
      for (const chunk of manifest.chunks) {
        const found = dbGet<Row>(this.db, "SELECT * FROM source_chunks WHERE chunk_id = ?", [chunk.chunkId]);
        if (!found)
          dbRun(
            this.db,
            "INSERT INTO source_chunks (chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              chunk.chunkId,
              manifest.sourceId,
              chunk.ordinal,
              chunk.relativePath,
              chunk.byteLength,
              chunk.digest,
              chunk.atomStart,
              chunk.atomEnd,
            ],
          );
        else if (
          String(found.source_id) !== manifest.sourceId ||
          Number(found.ordinal) !== chunk.ordinal ||
          String(found.relative_path) !== chunk.relativePath ||
          Number(found.byte_length) !== chunk.byteLength ||
          String(found.digest) !== chunk.digest ||
          Number(found.atom_start) !== chunk.atomStart ||
          Number(found.atom_end) !== chunk.atomEnd
        )
          throw new Error("source chunk identity conflicts with existing database record");
      }
    });
  }
  list(): Array<Record<string, unknown>> {
    return dbAll<Row>(this.db, "SELECT * FROM sources ORDER BY captured_at, source_id").map((row) => sourceRecord(row));
  }
  private refreshDependencies(): void {
    transaction(this.db, () => {
      dbRun(this.db, "DELETE FROM source_dependencies WHERE page_id IS NOT NULL OR relation <> 'citation'");
      const sources = dbAll<{ source_id: string }>(
        this.db,
        "SELECT source_id FROM sources WHERE status != 'removed' ORDER BY source_id",
      );
      const chunks = dbAll<{ source_id: string; chunk_id: string }>(
        this.db,
        "SELECT source_id, chunk_id FROM source_chunks ORDER BY source_id, ordinal",
      );
      const chunksBySource = new Map<string, string[]>();
      for (const chunk of chunks) {
        const values = chunksBySource.get(chunk.source_id) ?? [];
        values.push(chunk.chunk_id);
        chunksBySource.set(chunk.source_id, values);
      }
      const pages = dbAll<Row>(
        this.db,
        "SELECT page_id, relative_path FROM pages WHERE status != 'retired' ORDER BY relative_path, page_id",
      );
      const wikiRoot = wikiPathFor(this.paths);
      for (const page of pages) {
        const pageId = String(page.page_id);
        const path = validRelativePath(String(page.relative_path ?? ""));
        const absolute = safeRelativePath(wikiRoot, path);
        let body: string;
        try {
          body = readFileSync(absolute, "utf8");
        } catch (error) {
          if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for (const source of sources) {
          const sourceId = String(source.source_id);
          const citedChunks = (chunksBySource.get(sourceId) ?? []).filter((chunkId) => body.includes(chunkId));
          if (citedChunks.length) {
            for (const chunkId of citedChunks)
              dbRun(
                this.db,
                "INSERT OR IGNORE INTO source_dependencies (source_id, page_id, chunk_id, relation) VALUES (?, ?, ?, ?)",
                [sourceId, pageId, chunkId, "citation"],
              );
          } else if (body.includes(sourceId)) {
            dbRun(
              this.db,
              "INSERT OR IGNORE INTO source_dependencies (source_id, page_id, chunk_id, relation) VALUES (?, ?, ?, ?)",
              [sourceId, pageId, null, "citation"],
            );
          }
        }
      }
      const coveredPages = dbAll<{ page_id: string }>(
        this.db,
        "SELECT DISTINCT qp.page_id FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.quiz_id JOIN question_pages qp ON qp.question_id = qq.question_id JOIN quiz_evidence qe ON qe.quiz_id = q.quiz_id AND qe.page_id = qp.page_id WHERE q.status = 'open' ORDER BY qp.page_id",
      );
      for (const page of coveredPages) {
        dbRun(
          this.db,
          "INSERT OR IGNORE INTO source_dependencies (source_id, page_id, chunk_id, relation) SELECT source_id, page_id, chunk_id, 'question' FROM source_dependencies WHERE relation = 'citation' AND page_id = ?",
          [page.page_id],
        );
      }
    });
  }
  private currentDependentPageIds(sourceId: string): string[] {
    return [
      ...new Set(
        dbAll<{ page_id: string }>(
          this.db,
          "SELECT DISTINCT sd.page_id FROM source_dependencies sd JOIN pages p ON p.page_id = sd.page_id WHERE sd.source_id = ? AND sd.relation = 'citation' AND p.status != 'retired' AND sd.page_id IS NOT NULL ORDER BY sd.page_id",
          [sourceId],
        ).map((row) => row.page_id),
      ),
    ];
  }
  private affectedOpenQuizIds(sourceId: string): string[] {
    return dbAll<{ quiz_id: string }>(
      this.db,
      "SELECT DISTINCT q.quiz_id FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.quiz_id JOIN question_pages qp ON qp.question_id = qq.question_id JOIN quiz_evidence qe ON qe.quiz_id = q.quiz_id AND qe.page_id = qp.page_id JOIN source_dependencies sd ON sd.source_id = ? AND sd.page_id = qp.page_id AND sd.relation = 'citation' JOIN pages p ON p.page_id = qp.page_id WHERE q.status = 'open' AND p.status != 'retired' ORDER BY q.quiz_id",
      [sourceId],
    ).map((row) => row.quiz_id);
  }
  private affectedSubmittedQuizIds(sourceId: string): string[] {
    return dbAll<{ quiz_id: string }>(
      this.db,
      "SELECT DISTINCT q.quiz_id FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.quiz_id JOIN question_pages qp ON qp.question_id = qq.question_id JOIN quiz_evidence qe ON qe.quiz_id = q.quiz_id AND qe.page_id = qp.page_id JOIN source_dependencies sd ON sd.source_id = ? AND sd.page_id = qp.page_id AND sd.relation = 'citation' JOIN pages p ON p.page_id = qp.page_id WHERE q.status = 'submitted' AND NOT EXISTS (SELECT 1 FROM page_results pr WHERE pr.quiz_id = q.quiz_id AND pr.page_id = qp.page_id) AND p.status != 'retired' ORDER BY q.quiz_id",
      [sourceId],
    ).map((row) => row.quiz_id);
  }
  private sourceDependencyRows(sourceId: string): Row[] {
    return dbAll<Row>(
      this.db,
      "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies WHERE source_id = ? ORDER BY source_id, page_id IS NOT NULL, page_id, chunk_id IS NOT NULL, chunk_id, relation",
      [sourceId],
    );
  }
  private removalConfirmationId(sourceId: string, currentDigest: string, dependentPageIds: string[]): string {
    return digestBytes(
      Buffer.from(
        canonical({
          sourceId,
          currentDigest,
          dependentPageIds,
          sourceDependencies: this.sourceDependencyRows(sourceId),
          affectedOpenQuizIds: this.affectedOpenQuizIds(sourceId),
          affectedSubmittedQuizIds: this.affectedSubmittedQuizIds(sourceId),
        }),
      ),
    );
  }
  private removalLocations(
    sourceId: string,
    source: Row,
  ): { digest: string; packetPath: string; quarantineRoot: string; quarantine: string } {
    const digest = String(source.digest ?? "");
    if (!/^[0-9a-f]{64}$/iu.test(digest)) throw new Error("source digest is invalid");
    const packetPath = safeChildPath(this.sources(), String(source.manifest_path ?? join(this.sources(), sourceId)));
    const quarantineRoot = resolve(this.work(), "quarantine");
    const quarantine = ensureWithin(quarantineRoot, join(quarantineRoot, `${sourceId}-${digest.slice(0, 16)}`));
    return { digest, packetPath, quarantineRoot, quarantine };
  }
  private async validRemovalPacket(path: string, sourceId: string, digest: string): Promise<boolean> {
    let stat: Stats;
    try {
      stat = await lstatNoFollow(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory()) throw new Error("source packet must be a directory");
    await verifyRetainedPacket(path, { sourceId, originalDigest: digest });
    return true;
  }
  private removalCleanupPending(sourceId: string, cause: unknown): Error {
    return Object.assign(new Error(`source ${sourceId} was removed but packet cleanup is pending; retry removal`), {
      code: "SOURCE_REMOVAL_CLEANUP_PENDING",
      details: { applied: true, retryable: true },
      cause,
    });
  }
  private async reconcileRemovalState(
    sourceId: string,
    source: Row,
    locations: { digest: string; packetPath: string; quarantineRoot: string; quarantine: string },
  ): Promise<SourceRemovalResult | undefined> {
    const originalPresent = await this.validRemovalPacket(locations.packetPath, sourceId, locations.digest);
    const quarantinePresent = await this.validRemovalPacket(locations.quarantine, sourceId, locations.digest);
    if (originalPresent && quarantinePresent) throw new Error("source removal state is ambiguous");
    if (String(source.status ?? "") === "removed") {
      try {
        if (originalPresent) await fs.rm(locations.packetPath, { recursive: true, force: false });
        if (quarantinePresent) await fs.rm(locations.quarantine, { recursive: true, force: false });
      } catch (error) {
        throw this.removalCleanupPending(sourceId, error);
      }
      const dependentPageIds: string[] = [];
      return {
        sourceId,
        packetPath: locations.packetPath,
        currentDigest: locations.digest,
        dependentPageIds,
        confirmationId: this.removalConfirmationId(sourceId, locations.digest, dependentPageIds),
        removed: true,
      };
    }
    if (!originalPresent && quarantinePresent) {
      await fs.mkdir(locations.quarantineRoot, { recursive: true, mode: 0o700 });
      await fs.rename(locations.quarantine, locations.packetPath);
      if (!(await this.validRemovalPacket(locations.packetPath, sourceId, locations.digest)))
        throw new Error("source packet restore failed");
    }
    if (!originalPresent && !quarantinePresent) throw new Error("source packet is missing");
    return undefined;
  }
  removalPreview(sourceId: string): SourceRemovalPreview {
    const source = dbGet<Row>(this.db, "SELECT * FROM sources WHERE source_id = ?", [sourceId]);
    if (!source) throw new Error("source not found");
    const locations = this.removalLocations(sourceId, source);
    const manifest = parseManifest(locations.packetPath);
    if (manifest.sourceId !== sourceId || manifest.originalDigest !== locations.digest)
      throw new Error("source packet identity mismatch");
    this.refreshDependencies();
    const dependentPageIds = this.currentDependentPageIds(sourceId);
    const currentDigest = manifest.originalDigest;
    const confirmationId = this.removalConfirmationId(sourceId, currentDigest, dependentPageIds);
    return { sourceId, packetPath: locations.packetPath, currentDigest, dependentPageIds, confirmationId };
  }
  async removeConfirmed(
    sourceId: string,
    confirmation: string | { confirmationId?: string },
  ): Promise<SourceRemovalResult> {
    const source = dbGet<Row>(this.db, "SELECT * FROM sources WHERE source_id = ?", [sourceId]);
    if (!source) throw new Error("source not found");
    const locations = this.removalLocations(sourceId, source);
    const reconciled = await this.reconcileRemovalState(sourceId, source, locations);
    if (reconciled) return reconciled;
    const preview = this.removalPreview(sourceId);
    const token = typeof confirmation === "string" ? confirmation : confirmation.confirmationId;
    if (token !== preview.confirmationId) throw new Error("stale removal confirmation");
    const affectedSubmittedQuizIds = this.affectedSubmittedQuizIds(sourceId);
    if (affectedSubmittedQuizIds.length)
      throw new Error(
        `source removal conflict: submitted quizzes without page settlement: ${affectedSubmittedQuizIds.join(", ")}`,
      );
    const affectedQuizIds = this.affectedOpenQuizIds(sourceId);
    const quizSheetSnapshots: Array<{ sheetPath: string; previous?: Buffer }> = affectedQuizIds.flatMap(
      (quizId): Array<{ sheetPath: string; previous?: Buffer }> => {
        const row = dbGet<Row>(this.db, "SELECT date, sheet_path FROM quizzes WHERE quiz_id = ?", [quizId]);
        if (!row) return [];
        const date = String(row.date ?? "");
        const sheetPath = String(
          row.sheet_path ?? join(pathFor(this.paths, "quizzes"), date.slice(0, 4), date.slice(5, 7), `${date}.md`),
        );
        try {
          return [{ sheetPath, previous: readFileSync(sheetPath) }];
        } catch (error) {
          if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
            return [{ sheetPath }];
          throw error;
        }
      },
    );
    await fs.mkdir(locations.quarantineRoot, { recursive: true, mode: 0o700 });
    await fs.rename(preview.packetPath, locations.quarantine);
    try {
      transaction(this.db, () => {
        const now = new Date().toISOString();
        dbRun(this.db, "UPDATE sources SET status = ?, updated_at = ? WHERE source_id = ?", ["removed", now, sourceId]);
        for (const pageId of preview.dependentPageIds) {
          const page = dbGet<Row>(this.db, "SELECT digest FROM pages WHERE page_id = ?", [pageId]);
          if (!page) throw new Error(`dependent page is missing: ${pageId}`);
          dbRun(this.db, "UPDATE pages SET status = ?, revision = revision + 1, updated_at = ? WHERE page_id = ?", [
            "drifted",
            now,
            pageId,
          ]);
          dbRun(
            this.db,
            "INSERT INTO wiki_issues (issue_id, page_id, heading, page_digest, kind, description, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)",
            [
              randomUUID(),
              pageId,
              page.digest,
              "missing",
              `Source ${sourceId} was removed; revise this page and its review evidence against the remaining admitted sources.`,
              "open",
              now,
              now,
            ],
          );
        }
        new QuizService(this.db, this.paths).expireOpenQuizIds(affectedQuizIds);
        dbRun(this.db, "DELETE FROM source_dependencies WHERE source_id = ?", [sourceId]);
      });
    } catch (error) {
      const restoreErrors: unknown[] = [];
      for (const sheet of quizSheetSnapshots) {
        try {
          if (sheet.previous === undefined) await fs.rm(sheet.sheetPath, { force: true });
          else await fs.writeFile(sheet.sheetPath, sheet.previous, { mode: 0o600 });
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
      }
      try {
        await fs.rename(locations.quarantine, preview.packetPath);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
      if (restoreErrors.length) {
        const detail = restoreErrors
          .map((restoreError) => (restoreError instanceof Error ? restoreError.message : String(restoreError)))
          .join("; ");
        throw new Error(
          `source removal transaction failed and rollback failed: ${error instanceof Error ? error.message : String(error)}; ${detail}`,
          { cause: restoreErrors[0] },
        );
      }
      throw error;
    }
    try {
      await fs.rm(locations.quarantine, { recursive: true, force: true });
    } catch (error) {
      throw this.removalCleanupPending(sourceId, error);
    }
    return { ...preview, removed: true };
  }
}

export function nativeExtraction(snapshot: TreeSnapshot): Buffer {
  if (snapshot.files.length === 1 && snapshot.kind !== "directory" && snapshot.kind !== "repository") {
    const first = snapshot.files[0];
    if (!first) throw new Error("source snapshot has no file");
    return Buffer.from(first.bytes);
  }
  const pieces: Buffer[] = [];
  for (const file of snapshot.files) {
    const last = file.bytes.at(-1);
    pieces.push(
      Buffer.from(`--- FILE: ${file.path} ---\n`),
      file.bytes,
      Buffer.from(last === 10 ? "" : "\n"),
      Buffer.from(`--- END FILE: ${file.path} ---\n`),
    );
  }
  return Buffer.concat(pieces);
}
export const sha256 = digestBytes;
export function chunkExtraction(
  extracted: string | Uint8Array,
  endpoints?: Array<number | ChunkPlanEndpoint>,
): SourceChunk[] {
  return validateChunkEndpoints(extracted, endpoints);
}
