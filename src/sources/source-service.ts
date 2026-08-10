import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { promises as fs, readFileSync, type Stats } from "node:fs";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  PreparedAdmission as ContractPreparedAdmission,
  SourceKind as ContractSourceKind,
  SourceManifest as ContractSourceManifest,
} from "../contracts.js";
import { type ScholarDatabase, type SqlRow, type SqlRunResult, transaction } from "../database.js";
import type { DoclingResult as ExternalDoclingResult } from "../external/docling.js";
import { QuizService } from "../quiz.js";
import { safeRelativePath, type VaultPaths } from "../vault.js";
import {
  atomizeExtraction,
  chunkExtraction,
  nativeExtraction,
  normalizeDoclingResult,
  reconstructChunks,
  validateChunkEndpoints,
} from "./source-chunks.js";
import {
  canonical,
  copyPathNoFollow,
  copyRepositoryNoSecrets,
  deterministicUuid,
  digestBytes,
  ENVELOPE_NAME,
  ensureWithin,
  inferKind,
  lstatNoFollow,
  MAX_SOURCE_BYTES,
  measurePath,
  pathFor,
  provenanceUrl,
  publicSourceUri,
  readNoFollow,
  repositoryFiles,
  repositoryRevision,
  resolveWorkArtifact,
  SOURCE_KINDS,
  safeChildPath,
  sameIdentity,
  sanitizedSourceUri,
  snapshotPath,
  stagedMetadata,
  statIdentity,
  textualUrl,
  treeDigest,
  validRelativePath,
  walkFiles,
  wikiPathFor,
  workArtifactRelative,
  writeTree,
} from "./source-files.js";
import { parseManifest, parsePreparedMetadata, verifyRetainedPacket } from "./source-packets.js";
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
export interface PersistedPreparedAdmission extends PreparedAdmission {
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

export { atomizeExtraction, chunkExtraction, nativeExtraction, reconstructChunks, validateChunkEndpoints };
export const sha256 = digestBytes;
