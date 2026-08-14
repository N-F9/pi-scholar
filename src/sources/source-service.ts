import { randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  PreparedAdmission as ContractPreparedAdmission,
  SourceKind as ContractSourceKind,
  SourceManifest as ContractSourceManifest,
  ExtractProgressPhase,
  SourceRecord,
} from "../contracts.js";
import { type ScholarDatabase, type SqlRow, type SqlRunResult, transaction } from "../database.js";
import type { DoclingResult as ExternalDoclingResult } from "../external/docling.js";
import {
  okfCitationText,
  okfFootnoteLabels,
  okfMarkdownEscapedAt,
  okfSourceReferences,
  parseOkfConcept,
} from "../okf.js";
import { QuizService } from "../quiz.js";
import { ValidationError } from "../scheduler.js";
import { atomicWriteFile, readFileNoFollow, safeRelativePath, type VaultPaths } from "../vault.js";
import {
  assertNoEmbeddedDoclingImages,
  atomizeExtraction,
  chunkEndpointNumber,
  copyDoclingExtraction,
  type ExtractionFileBoundary,
  normalizeDoclingResult,
  normalizeMarkdownFile,
  planFileAtoms,
  validateChunkEndpoints,
  validateFileEndpoints,
  writeFileChunks,
  writeNativeExtraction,
} from "./source-chunks.js";
import {
  canonical,
  copyFileNoFollow,
  copyPathNoFollow,
  deterministicUuid,
  digestBytes,
  ENVELOPE_NAME,
  ensureWithin,
  hashFile,
  inferKind,
  lstatNoFollow,
  lstatNoFollowSync,
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
  snapshotPath,
  stagedMetadata,
  statIdentity,
  textualUrl,
  treeDigest,
  validRelativePath,
  walkFiles,
  wikiPathFor,
  workArtifactRelative,
  writeFully,
  writeTree,
} from "./source-files.js";
import {
  parseManifest,
  parsePreparedMetadata,
  verifyRetainedAttachment,
  verifyRetainedPacket,
} from "./source-packets.js";
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
export interface PreparedSourceStage {
  readonly stageId: string;
}
export interface FileSnapshot {
  path: string;
  size: number;
  digest: string;
  absolutePath: string;
  identity?: PhysicalIdentity;
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
  normalizer: { name: "markdown-blank-lines"; version: "2" };
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
export type SourcePreparationObserver = (phase: ExtractProgressPhase) => void | Promise<void>;

function emitPreparationPhase(observer: SourcePreparationObserver | undefined, phase: ExtractProgressPhase): void {
  try {
    const result = observer?.(phase);
    if (result) void Promise.resolve(result).catch(() => undefined);
  } catch {}
}
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
  endLine: number;
}

const MAX_SOURCE_REDIRECTS = 5;
const DEFAULT_SOURCE_TIMEOUT_MS = 300_000;
const SOURCE_ERROR_MESSAGE_BYTES = 500;

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
export interface SourceHttpResponse {
  status: number;
  location?: string;
  mediaType?: string;
}
export async function requestSourceToFile(
  url: URL,
  target: string,
  timeoutMs = DEFAULT_SOURCE_TIMEOUT_MS,
): Promise<SourceHttpResponse> {
  const { promise, resolve: resolveRequest, reject: rejectRequest } = Promise.withResolvers<SourceHttpResponse>();
  let request: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let settled = false;
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    request?.destroy();
    response?.destroy();
    void fs.rm(target, { force: true }).catch(() => undefined);
    rejectRequest(error instanceof Error ? error : new Error(String(error)));
  };
  const pathname = `${url.pathname || "/"}${url.search}`;
  const options = {
    protocol: url.protocol,
    hostname: url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname,
    port: url.port || undefined,
    path: pathname,
    method: "GET",
    agent: false,
  };
  const onResponse = (incoming: IncomingMessage): void => {
    response = incoming;
    const status = incoming.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = incoming.headers.location;
      incoming.destroy();
      if (typeof location !== "string" || !location) fail(new Error("source redirect has no location"));
      else {
        settled = true;
        clearTimeout(deadline);
        resolveRequest({ status, location });
      }
      return;
    }
    if (status < 200 || status >= 300) {
      incoming.destroy();
      fail(new Error(`source fetch failed: ${status}`));
      return;
    }
    const advertised = incoming.headers["content-length"];
    if (Array.isArray(advertised) && advertised.length !== 1) {
      incoming.destroy();
      fail(new Error("source content length is invalid"));
      return;
    }
    const contentLength = Array.isArray(advertised) ? advertised[0] : advertised;
    if (
      contentLength !== undefined &&
      (!/^\d+$/u.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))
    ) {
      incoming.destroy();
      fail(new Error("source content length is invalid"));
      return;
    }
    void (async () => {
      let output: FileHandle | undefined;
      try {
        output = await fs.open(target, "wx", 0o600);
        for await (const chunk of incoming)
          await writeFully(output, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        await output.close();
        output = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(deadline);
          resolveRequest({ status, mediaType: incoming.headers["content-type"]?.toString() });
        }
      } catch (error) {
        await output?.close().catch(() => undefined);
        fail(error);
      }
    })();
  };
  deadline = setTimeout(() => fail(new Error("source fetch timed out")), timeoutMs);
  deadline.unref();
  try {
    request = url.protocol === "https:" ? httpsRequest(options, onResponse) : httpRequest(options, onResponse);
    request.setTimeout(timeoutMs, () => fail(new Error("source fetch timed out")));
    request.once("error", fail);
    request.end();
  } catch (error) {
    fail(error);
  }
  return promise;
}

type CurrentCitationDependency = {
  sourceId: string;
  pageId: string;
  chunkId: string;
  pageDigest: string;
};
type Row = SqlRow;
const PI_CHUNK_LABEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/iu;
const PI_CHUNK_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+/giu;
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
  return {
    sourceId: row.source_id,
    kind: row.kind,
    status: row.status,
    displayName: row.display_name,
    originalName: row.original_name,
    sourceUri: publicSourceUri(row.source_uri),
    mediaType: row.media_type,
    repositoryRevision: row.repository_revision,
    capturedAt: row.captured_at,
    digest: row.digest,
    manifestPath: row.manifest_path,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function fileSnapshotRecord(file: FileSnapshot): {
  path: string;
  size: number;
  digest: string;
  identity?: PhysicalIdentity;
} {
  return { path: file.path, size: file.size, digest: file.digest, identity: file.identity };
}
function sameFileSnapshots(left: FileSnapshot[], right: FileSnapshot[]): boolean {
  return (
    canonical(left.map(fileSnapshotRecord).sort((a, b) => a.path.localeCompare(b.path))) ===
    canonical(right.map(fileSnapshotRecord).sort((a, b) => a.path.localeCompare(b.path)))
  );
}
function sameFileContents(left: FileSnapshot[], right: FileSnapshot[]): boolean {
  return (
    canonical(
      left.map(({ path, size, digest }) => ({ path, size, digest })).sort((a, b) => a.path.localeCompare(b.path)),
    ) ===
    canonical(
      right.map(({ path, size, digest }) => ({ path, size, digest })).sort((a, b) => a.path.localeCompare(b.path)),
    )
  );
}
function manifestProvenance(manifest: SourceManifest): Record<string, unknown> {
  return {
    kind: manifest.kind,
    displayName: manifest.displayName,
    originalName: manifest.originalName,
    sourceUri: manifest.sourceUri,
    mediaType: manifest.mediaType,
    revision: manifest.revision,
    repositoryRevision: manifest.repositoryRevision,
    inputKind: manifest.inputKind,
    converter: manifest.converter ?? null,
    capturedAt: manifest.capturedAt,
    stagedMetadata: manifest.stagedMetadata ?? null,
  };
}
function claimProvenance(claim: SourceClaim, publication: SourceManifest): Record<string, unknown> {
  const metadata = claim.snapshot.metadata;
  return {
    kind: claim.snapshot.kind,
    displayName: metadata?.displayName ?? claim.entry.relativePath,
    originalName: metadata?.originalName ?? claim.entry.relativePath,
    sourceUri: metadata?.sourceUri,
    mediaType: metadata?.mediaType,
    revision: claim.snapshot.revision,
    repositoryRevision: claim.snapshot.revision,
    inputKind: metadata?.requestedKind,
    converter: publication.converter ?? null,
    capturedAt: publication.capturedAt,
    stagedMetadata: metadata ?? null,
  };
}
function assertManifestClaimProvenance(
  manifest: SourceManifest,
  claim: SourceClaim,
  publication: SourceManifest = manifest,
): void {
  if (canonical(manifestProvenance(manifest)) !== canonical(claimProvenance(claim, publication)))
    throw new Error("source packet provenance mismatch");
}
const SOURCE_STAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type RetainedSourceStage = {
  readonly prepared: PreparedSourceStage;
  readonly kind: SourceKind;
  readonly metadata: StageMetadata;
};

export class SourceService {
  readonly db: ScholarDatabase;
  readonly paths: VaultPathsLike;
  readonly adapters: SourceAdapters;
  private readonly retainedSourceStages = new Map<string, RetainedSourceStage>();
  private readonly retainedPrepared = new Map<string, { prepared: PreparedAdmission; seal: string }>();
  constructor(db: ScholarDatabase, paths: VaultPathsLike, adapters: SourceAdapters = {}) {
    this.db = db;
    this.paths = paths;
    this.adapters = adapters;
  }
  private inbox(): string {
    return pathFor(this.paths, "inbox");
  }
  private assertSourceOutsideInbox(source: string): void {
    try {
      ensureWithin(this.inbox(), source);
    } catch {
      return;
    }
    throw new ValidationError("source path must be outside inbox");
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
  private sourceStageRoot(stageId: string): string {
    if (!SOURCE_STAGE_ID.test(stageId)) throw new Error("invalid source stage id");
    return safeRelativePath(this.work(), `.source-stage-${stageId}`);
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
  private async defaultFetch(url: URL, target: string): Promise<{ mediaType?: string; name?: string }> {
    let current = new URL(url.toString());
    for (let redirect = 0; ; redirect++) {
      if (!["http:", "https:"].includes(current.protocol)) throw new Error("source redirect protocol is not allowed");
      if (redirect > 0) await fs.rm(target, { force: true });
      const response = await requestSourceToFile(current, target);
      if (response.location !== undefined) {
        if (redirect >= MAX_SOURCE_REDIRECTS) throw new Error("source redirect limit exceeded");
        current = new URL(response.location, current);
        continue;
      }
      return { mediaType: response.mediaType, name: basename(current.pathname) || undefined };
    }
  }
  private async privateStageRoot(): Promise<{ stageId: string; root: string }> {
    await fs.mkdir(this.work(), { recursive: true, mode: 0o700 });
    const stat = await lstatNoFollow(this.work());
    if (!stat.isDirectory()) throw new Error("work root must be a real directory");
    const stageId = randomUUID();
    const root = this.sourceStageRoot(stageId);
    await fs.mkdir(root, { recursive: false, mode: 0o700 });
    return { stageId, root };
  }
  private async retainSourceStage(
    stageId: string,
    kind: SourceKind,
    metadata: StageMetadata,
  ): Promise<PreparedSourceStage> {
    const prepared: PreparedSourceStage = { stageId };
    this.retainedSourceStages.set(stageId, {
      prepared: structuredClone(prepared),
      kind,
      metadata: structuredClone(metadata),
    });
    return prepared;
  }
  private loadSourceStage(stage: PreparedSourceStage): RetainedSourceStage {
    const retained = this.retainedSourceStages.get(stage.stageId);
    if (!retained || canonical(retained.prepared) !== canonical(stage))
      throw new Error("source stage is not owned by this service");
    return retained;
  }
  async publishPreparedStage(stage: PreparedSourceStage): Promise<InboxEntry> {
    const retained = this.loadSourceStage(stage);
    const root = this.sourceStageRoot(stage.stageId);
    try {
      const rootStat = await lstatNoFollow(root);
      if (!rootStat.isDirectory()) throw new Error("source stage root must be a directory");
      const metadata = await stagedMetadata(root);
      if (!metadata || metadata.kind !== retained.kind || canonical(metadata) !== canonical(retained.metadata))
        throw new Error("source stage metadata is invalid");
      await this.ensureInbox();
      const relativePath = `${randomUUID()}.pi-scholar`;
      const target = join(this.inbox(), relativePath);
      await fs.rename(root, target);
      const result: InboxEntry = {
        relativePath,
        absolutePath: target,
        kind: retained.kind,
        identity: statIdentity(rootStat),
        metadata,
      };
      await this.cleanupPreparedStage(stage).catch(() => undefined);
      return result;
    } catch (error) {
      await this.cleanupPreparedStage(stage).catch(() => undefined);
      throw error;
    }
  }
  async cleanupPreparedStage(stage: PreparedSourceStage): Promise<void> {
    this.retainedSourceStages.delete(stage.stageId);
    await fs.rm(this.sourceStageRoot(stage.stageId), { recursive: true, force: true });
  }
  private async stageEnvelope(metadata: StageMetadata, bytes: Uint8Array): Promise<PreparedSourceStage> {
    const { stageId, root } = await this.privateStageRoot();
    try {
      await fs.writeFile(join(root, ENVELOPE_NAME), `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
      await fs.writeFile(join(root, metadata.payload), Buffer.from(bytes), { flag: "wx", mode: 0o600 });
      return await this.retainSourceStage(stageId, metadata.kind, metadata);
    } catch (error) {
      await this.cleanupPreparedStage({ stageId }).catch(() => undefined);
      throw error;
    }
  }
  async prepareStage(request: SourceStageRequest): Promise<PreparedSourceStage> {
    const forms = [
      request.url !== undefined,
      request.text !== undefined,
      request.bytes !== undefined,
      request.path !== undefined,
      request.filePath !== undefined,
    ].filter(Boolean).length;
    if (forms > 1) throw new ValidationError("source input has multiple payloads");
    if (request.url !== undefined) {
      if (request.kind !== undefined && request.kind !== "url")
        throw new ValidationError("URL source kind must be url");
      let parsed: URL;
      try {
        parsed = new URL(request.url);
      } catch {
        throw new ValidationError("source URL is invalid");
      }
      if (!["http:", "https:"].includes(parsed.protocol)) throw new ValidationError("only HTTP(S) URLs are accepted");
      const metadataFor = (fetchedName?: string): StageMetadata => {
        const originalName = validRelativePath(
          request.originalName ?? request.name ?? fetchedName ?? (basename(parsed.pathname) || "source.txt"),
        );
        const displayName = request.displayName ?? originalName;
        if (
          /[\u0000-\u001f\u007f]/u.test(displayName) ||
          (mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(mediaType))
        )
          throw new ValidationError("invalid staged source metadata");
        return {
          version: 1,
          requestedKind: request.kind ?? "url",
          kind: "url",
          displayName,
          originalName,
          sourceUri: provenanceUrl(parsed),
          mediaType,
          payload: "payload",
        };
      };
      let bytes: Uint8Array;
      let mediaType = request.mediaType;
      if (this.adapters.fetchUrl) {
        const fetched = await this.adapters.fetchUrl(parsed.toString());
        bytes = fetched.bytes;
        mediaType ??= fetched.mediaType;
        return this.stageEnvelope(metadataFor(fetched.name), bytes);
      }
      const { stageId, root } = await this.privateStageRoot();
      try {
        const fetched = await this.defaultFetch(parsed, join(root, "payload"));
        mediaType ??= fetched.mediaType;
        const metadata = metadataFor(fetched.name);
        await fs.writeFile(join(root, ENVELOPE_NAME), `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
        return await this.retainSourceStage(stageId, "url", metadata);
      } catch (error) {
        await this.cleanupPreparedStage({ stageId }).catch(() => undefined);
        throw error;
      }
    }
    if (request.text !== undefined) {
      if (request.kind !== undefined && request.kind !== "text" && request.kind !== "pasted")
        throw new ValidationError("text source kind must be text or pasted");
      const originalName = validRelativePath(request.originalName ?? request.name ?? "source.txt");
      const displayName = request.displayName ?? originalName;
      if (
        /[\u0000-\u001f\u007f]/u.test(displayName) ||
        (request.mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(request.mediaType))
      )
        throw new ValidationError("invalid staged source metadata");
      return this.stageEnvelope(
        {
          version: 1,
          requestedKind: request.kind ?? "pasted",
          kind: "text",
          displayName,
          originalName,
          mediaType: request.mediaType,
          payload: "payload",
        },
        Buffer.from(request.text, "utf8"),
      );
    }
    if (request.bytes !== undefined) {
      if (request.kind !== "upload") throw new ValidationError("bytes source kind must be upload");
      if (!(request.bytes instanceof Uint8Array)) throw new ValidationError("source payload must be binary");
      const originalName = validRelativePath(request.originalName ?? request.name ?? "source.txt");
      const kind = inferKind(originalName);
      const displayName = request.displayName ?? originalName;
      if (
        /[\u0000-\u001f\u007f]/u.test(displayName) ||
        (request.mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(request.mediaType))
      )
        throw new ValidationError("invalid staged source metadata");
      return this.stageEnvelope(
        {
          version: 1,
          requestedKind: "upload",
          kind,
          displayName,
          originalName,
          mediaType: request.mediaType,
          payload: "payload",
        },
        request.bytes,
      );
    }
    if (request.filePath !== undefined) {
      if (request.kind !== "upload") throw new ValidationError("filePath source kind must be upload");
      const source = resolve(request.filePath);
      this.assertSourceOutsideInbox(source);
      const stat = await lstatNoFollow(source);
      if (!stat.isFile()) throw new ValidationError("upload filePath must be a regular file");
      const originalName = validRelativePath(request.originalName ?? request.name ?? basename(source));
      const kind = inferKind(originalName);
      const displayName = request.displayName ?? originalName;
      if (
        /[\u0000-\u001f\u007f]/u.test(displayName) ||
        (request.mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(request.mediaType))
      )
        throw new ValidationError("invalid staged source metadata");
      const metadata: StageMetadata = {
        version: 1,
        requestedKind: "upload",
        kind,
        displayName,
        originalName,
        mediaType: request.mediaType,
        payload: "payload",
      };
      const { stageId, root } = await this.privateStageRoot();
      try {
        await fs.writeFile(join(root, ENVELOPE_NAME), `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
        await copyFileNoFollow(source, join(root, metadata.payload));
        return await this.retainSourceStage(stageId, kind, metadata);
      } catch (error) {
        await this.cleanupPreparedStage({ stageId }).catch(() => undefined);
        throw error;
      }
    }
    const input = request.path;
    if (!input) throw new ValidationError("source input is required");
    if (request.kind !== undefined && !SOURCE_KINDS.includes(request.kind as SourceKind))
      throw new ValidationError("invalid source kind");
    const source = resolve(input);
    this.assertSourceOutsideInbox(source);
    const name = validRelativePath(request.name ?? basename(source));
    if (name.includes("/")) throw new ValidationError("staging name must be a single filename");
    const stat = await lstatNoFollow(source);
    const repository = stat.isDirectory() && (await this.isRepository(source));
    const kind: SourceKind = repository ? "repository" : inferKind(source, stat);
    if (!repository && inferKind(name, stat) !== kind) throw new ValidationError(`staging name kind must be ${kind}`);
    const gitRevision = this.adapters.gitRevision;
    const revisionProvider = repository
      ? typeof gitRevision === "function"
        ? gitRevision
        : gitRevision
          ? (root: string) => gitRevision.revision(root)
          : repositoryRevision
      : undefined;
    const readRevision = async (): Promise<string | undefined> =>
      revisionProvider ? (await revisionProvider(source)) || undefined : undefined;
    const initialRevision = repository ? await readRevision() : undefined;
    const files = repository ? await repositoryFiles(source) : undefined;
    const beforeCopyRevision = repository ? await readRevision() : undefined;
    if (repository && beforeCopyRevision !== initialRevision) throw new Error("repository changed during staging");
    if (repository && !initialRevision) throw new Error("repository revision is unavailable");
    if (!repository) await measurePath(source);
    if (request.kind !== undefined && request.kind !== kind)
      throw new ValidationError(`path source kind must be ${kind}`);
    const revision = repository ? initialRevision : undefined;
    const originalName = validRelativePath(request.originalName ?? name);
    const displayName = request.displayName ?? originalName;
    if (
      /[\u0000-\u001f\u007f]/u.test(displayName) ||
      (request.mediaType !== undefined && /[\u0000-\u001f\u007f]/u.test(request.mediaType))
    )
      throw new ValidationError("invalid staged source metadata");
    const metadata: StageMetadata = {
      version: 1,
      requestedKind: (request.kind ?? kind) as InputKind,
      kind,
      displayName,
      originalName,
      mediaType: request.mediaType,
      repositoryRevision: revision,
      payload: "payload",
    };
    const { stageId, root } = await this.privateStageRoot();
    try {
      await fs.writeFile(join(root, ENVELOPE_NAME), `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
      if (repository) {
        await fs.mkdir(join(root, metadata.payload), { recursive: false, mode: 0o700 });
        await writeTree(join(root, metadata.payload), files ?? []);
      } else {
        await copyPathNoFollow(source, join(root, metadata.payload));
      }
      if (repository) {
        const copiedFiles = await walkFiles(join(root, metadata!.payload), "", false);
        if (!sameFileContents(files ?? [], copiedFiles)) throw new Error("repository copy digest mismatch");
        const afterFiles = await repositoryFiles(source);
        const afterRevision = await readRevision();
        if (afterRevision !== initialRevision || !sameFileSnapshots(files ?? [], afterFiles))
          throw new Error("repository changed during staging");
      }
      return await this.retainSourceStage(stageId, kind, metadata);
    } catch (error) {
      await this.cleanupPreparedStage({ stageId }).catch(() => undefined);
      throw error;
    }
  }
  async stage(request: SourceStageRequest): Promise<InboxEntry> {
    const prepared = await this.prepareStage(request);
    try {
      return await this.publishPreparedStage(prepared);
    } catch (error) {
      await this.cleanupPreparedStage(prepared).catch(() => undefined);
      throw error;
    }
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
  async prepareClaim(
    input: SourceClaim | InboxEntry,
    observer?: SourcePreparationObserver,
  ): Promise<PreparedAdmission> {
    const supplied = "snapshot" in input ? input : await this.claim(input);
    const claim = await this.revalidateClaim(supplied);
    emitPreparationPhase(observer, "preparing");
    const preparedId = randomUUID();
    const root = this.preparedRoot(preparedId);
    const originalRoot = join(root, "original");
    const attachmentsRoot = join(root, "attachments");
    const rawExtracted = join(root, ".extracted.raw");
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
      const preserveBlankRuns =
        claim.snapshot.kind === "directory" || claim.snapshot.kind === "repository"
          ? new Set(
              claim.snapshot.files
                .filter((file) => ![".md", ".markdown"].includes(extname(file.path).toLowerCase()))
                .map((file) => file.path),
            )
          : undefined;
      let fileBoundaries: ExtractionFileBoundary[] | undefined;
      let converter: { name: string; version: string } | undefined;
      if (useDocling) {
        if (!this.adapters.docling) throw new Error("Docling adapter is required for document extraction");
        if (claim.snapshot.files.length !== 1) throw new Error("Docling requires a single regular document file");
        const originalFile = claim.snapshot.files[0];
        if (!originalFile) throw new Error("Docling requires a document file");
        const originalPath = ensureWithin(originalRoot, join(originalRoot, validRelativePath(originalFile.path)));
        emitPreparationPhase(observer, "docling");
        const converted =
          typeof this.adapters.docling === "function"
            ? await this.adapters.docling({ claim, originalPath, kind: claim.snapshot.kind, mediaType })
            : await this.adapters.docling.convert({ claim, originalPath, kind: claim.snapshot.kind, mediaType });
        const normalizedResult = await normalizeDoclingResult(converted);
        converter = {
          name: normalizedResult.converter?.name ?? "docling",
          version: normalizedResult.converter?.version ?? "unknown",
        };
        if ("extractedPath" in normalizedResult) {
          await copyDoclingExtraction(normalizedResult.extractedPath, rawExtracted);
          for (const attachment of normalizedResult.attachments) {
            const target = ensureWithin(attachmentsRoot, join(attachmentsRoot, validRelativePath(attachment.path)));
            await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await copyFileNoFollow(attachment.absolutePath, target);
          }
        } else {
          const extracted = Buffer.from(normalizedResult.extracted);
          assertNoEmbeddedDoclingImages(extracted);
          await fs.writeFile(rawExtracted, extracted, { flag: "wx", mode: 0o600 });
          for (const attachment of normalizedResult.attachments ?? []) {
            const target = ensureWithin(attachmentsRoot, join(attachmentsRoot, validRelativePath(attachment.path)));
            await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await fs.writeFile(target, Buffer.from(attachment.bytes), { flag: "wx", mode: 0o600 });
          }
        }
      } else {
        emitPreparationPhase(observer, "extracting");
        const copiedSnapshot = {
          ...claim.snapshot,
          root: originalRoot,
          files: claim.snapshot.files.map((file) => ({
            ...file,
            absolutePath: ensureWithin(originalRoot, join(originalRoot, validRelativePath(file.path))),
          })),
        };
        fileBoundaries = await writeNativeExtraction(copiedSnapshot, rawExtracted, preserveBlankRuns);
      }
      const rawStat = await lstatNoFollow(rawExtracted);
      if (!rawStat.isFile() || rawStat.size === 0) throw new Error("empty extraction");
      emitPreparationPhase(observer, "normalizing");
      await normalizeMarkdownFile(rawExtracted, extractedAbsolute, claim.snapshot.kind !== "code", fileBoundaries);
      await fs.rm(rawExtracted, { force: true });
      emitPreparationPhase(observer, "validating/indexing");
      const extractedHash = await hashFile(extractedAbsolute);
      if (extractedHash.size === 0) throw new Error("empty extraction");
      const attachmentSnapshots = await walkFiles(attachmentsRoot, "", false);
      const atoms = await planFileAtoms(extractedAbsolute);
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
        extractedDigest: extractedHash.digest,
        extractedByteLength: extractedHash.size,
      };
      const seal = canonical(persisted);
      await fs.writeFile(this.preparedMetadataPath(preparedId), `${JSON.stringify(persisted, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      this.retainedPrepared.set(preparedId, { prepared, seal });
      emitPreparationPhase(observer, "ready");
      return prepared;
    } catch (error) {
      emitPreparationPhase(observer, "failed");
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
      const verified = await verifyRetainedPacket(packet, {
        sourceId: manifest.sourceId,
        originalDigest: claim.snapshot.digest,
      });
      publishedManifest = verified.manifest;
      assertManifestClaimProvenance(publishedManifest, claim, manifest);
      this.recordSource(publishedManifest, packet, verified.manifestDigest);
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
    const preparedFiles = await walkFiles(originalRoot, "", false);
    const preparedFileRecords = preparedFiles.map((file) => ({
      relativePath: file.path,
      byteLength: file.size,
      digest: file.digest,
    }));
    if (
      canonical(preparedFileRecords) !== canonical(prepared.files) ||
      treeDigest(preparedFiles, prepared.revision) !== prepared.digest
    )
      throw new Error("prepared snapshot digest mismatch");
    const extractedHash = await hashFile(extractedPath);
    if (extractedHash.size !== prepared.extractedByteLength || extractedHash.digest !== prepared.extractedDigest)
      throw new Error("prepared extraction digest mismatch");
    const actualAtoms = await planFileAtoms(extractedPath);
    if (canonical(actualAtoms) !== canonical(prepared.atoms)) throw new Error("prepared atom index mismatch");
    const preparedAttachmentsRoot = ensureWithin(preparedRoot, join(preparedRoot, "attachments"));
    const preparedAttachmentFiles = await walkFiles(preparedAttachmentsRoot, "", false);
    const preparedAttachmentRecords = preparedAttachmentFiles.map((file) => ({
      path: file.path,
      byteLength: file.size,
      digest: file.digest,
    }));
    if (canonical(preparedAttachmentRecords) !== canonical(prepared.attachments))
      throw new Error("prepared attachment digest mismatch");
    const planned = await validateFileEndpoints(extractedPath, input.endpoints);
    const existing = await this.normalizeExistingPacket(claim);
    if (existing) {
      this.completedPrepared.set(prepared.preparedId, { prepared: input.prepared, result: existing });
      await this.cleanupPrepared(prepared.preparedId).catch(() => undefined);
      return existing;
    }
    const sourceId = this.sourceIdFor(claim);
    const packet = join(this.sources(), sourceId);
    const temporary = join(this.work(), `packet-${sourceId}-${randomUUID()}`);
    await fs.mkdir(temporary, { recursive: false, mode: 0o700 });
    let manifest!: SourceManifest;
    try {
      await writeTree(join(temporary, "original"), preparedFiles);
      const packetChunks = join(temporary, "chunks");
      const packetAttachments = join(temporary, "attachments");
      await fs.mkdir(packetAttachments, { recursive: false, mode: 0o700 });
      await writeTree(packetAttachments, preparedAttachmentFiles);
      await copyFileNoFollow(extractedPath, join(temporary, "extracted.md"));
      const chunkFiles = await writeFileChunks(join(temporary, "extracted.md"), packetChunks, planned.chunks);
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
        normalizer: { name: "markdown-blank-lines", version: "2" },
        originalBytes: claim.snapshot.bytes,
        originalByteLength: claim.snapshot.bytes,
        originalDigest: claim.snapshot.digest,
        extractionBytes: extractedHash.size,
        extractedByteLength: extractedHash.size,
        extractionDigest: extractedHash.digest,
        extractedDigest: extractedHash.digest,
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
        chunks: chunkFiles.map(({ index, startByte, endByte, digest }) => {
          const plannedChunk = planned.chunks[index];
          const startAtom =
            plannedChunk && plannedChunk.index === index && plannedChunk.startByte === startByte
              ? plannedChunk.startLine - 1
              : -1;
          const endAtom =
            plannedChunk && plannedChunk.index === index && plannedChunk.endByte === endByte
              ? plannedChunk.endLine
              : -1;
          if (startAtom < 0 || endAtom <= startAtom) throw new Error("chunk atom mapping failed");
          return {
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
          };
        }),
      };
      await fs.writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await fs.mkdir(this.sources(), { recursive: true, mode: 0o700 });
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
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
    await this.cleanupPrepared(prepared.preparedId).catch(() => undefined);
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
  private sourceIdFor(claim: SourceClaim): string {
    const metadata = claim.snapshot.metadata;
    return deterministicUuid(
      canonical({
        scope: "source",
        digest: claim.snapshot.digest,
        revision: claim.snapshot.revision,
        kind: claim.snapshot.kind,
        sourceUri: metadata?.sourceUri,
        normalizer: { name: "markdown-blank-lines", version: "2" },
        displayName: metadata?.displayName ?? claim.entry.relativePath,
        originalName: metadata?.originalName ?? claim.entry.relativePath,
        mediaType: metadata?.mediaType,
        requestedKind: metadata?.requestedKind,
        repositoryRevision: metadata?.repositoryRevision,
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
  private async normalizeExistingPacket(claim: SourceClaim): Promise<AdmissionResult | undefined> {
    const sourceId = this.sourceIdFor(claim);
    const packet = join(this.sources(), sourceId);
    try {
      const stat = await lstatNoFollow(packet);
      if (!stat.isDirectory()) throw new Error("source packet must be a directory");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw error;
    }
    const verified = await verifyRetainedPacket(packet, { sourceId, originalDigest: claim.snapshot.digest });
    const { manifest, manifestDigest } = verified;
    const durableDigest = dbGet<Row>(this.db, "SELECT manifest_digest FROM sources WHERE source_id = ?", [
      sourceId,
    ])?.manifest_digest;
    if (typeof durableDigest === "string") {
      if (durableDigest !== manifestDigest) throw new Error("source manifest digest mismatch");
    } else assertManifestClaimProvenance(manifest, claim);
    this.recordSource(manifest, packet, manifestDigest);
    return { sourceId, manifest, packetPath: packet, removedInbox: await this.removeInboxAfterAdmission(claim), claim };
  }
  async admitClaim(
    claim: SourceClaim,
    options: {
      endpoints?: Array<number | ChunkPlanEndpoint>;
    } = {},
  ): Promise<AdmissionResult> {
    const existing = await this.normalizeExistingPacket(claim);
    if (existing) return existing;
    const prepared = await this.prepareClaim(claim);
    const endpoints = options.endpoints?.map((endpoint) => {
      const value = chunkEndpointNumber(endpoint);
      if (value === undefined) throw new Error("chunk line endpoint is missing");
      return value;
    });
    return this.publishPreparedClaim({
      prepared,
      preparedId: prepared.preparedId,
      claimId: prepared.claimId,
      digest: prepared.digest,
      endpoints,
    });
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
    const diagnostic = (error instanceof Error ? error.message : String(error)).trim();
    const message = boundedUtf8(diagnostic || "Source extraction failed", SOURCE_ERROR_MESSAGE_BYTES);
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
            "EXTRACT_FAILED",
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
            "EXTRACT_FAILED",
            message,
            now,
            now,
          ],
        );
    });
  }
  recordExtractFailure(entry: InboxEntry, error: unknown, claim?: SourceClaim): void {
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
  private recordSource(manifest: SourceManifest, packet: string, retainedManifestDigest: string): void {
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
        retainedManifestDigest,
        packet,
        manifest.capturedAt,
        manifest.capturedAt,
      ];
      if (!existing)
        dbRun(
          this.db,
          "INSERT INTO sources (source_id, kind, status, display_name, original_name, source_uri, media_type, repository_revision, captured_at, digest, manifest_digest, manifest_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          values,
        );
      else {
        if (String(existing.digest ?? "") !== manifest.originalDigest)
          throw new Error("source identity conflicts with existing database record");
        if (
          existing.status === "published" &&
          existing.manifest_digest !== null &&
          existing.manifest_digest !== undefined &&
          String(existing.manifest_digest) !== retainedManifestDigest
        )
          throw new Error("source manifest identity conflicts with existing database record");
        const now = new Date().toISOString();
        dbRun(
          this.db,
          "UPDATE sources SET kind = ?, status = ?, display_name = ?, original_name = ?, source_uri = ?, media_type = ?, repository_revision = ?, captured_at = ?, digest = ?, manifest_digest = ?, manifest_path = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE source_id = ?",
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
            retainedManifestDigest,
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
  async publishedAttachment(sourceId: string, attachmentDigest: string) {
    const row = dbGet<Row>(this.db, "SELECT * FROM sources WHERE source_id = ? AND status = 'published'", [sourceId]);
    if (!row) throw new Error("published source not found");
    const packetPath = safeChildPath(this.sources(), String(row.manifest_path ?? join(this.sources(), sourceId)));
    const verified = await verifyRetainedAttachment(packetPath, {
      sourceId,
      originalDigest: String(row.digest ?? ""),
      manifestDigest: String(row.manifest_digest ?? ""),
      attachmentDigest,
    });
    const { manifest } = verified;
    if (
      row.source_id !== manifest.sourceId ||
      row.kind !== manifest.kind ||
      row.display_name !== manifest.displayName ||
      (row.original_name ?? undefined) !== (manifest.originalName ?? undefined) ||
      (row.source_uri ?? undefined) !== (manifest.sourceUri ?? undefined) ||
      (row.media_type ?? undefined) !== (manifest.mediaType ?? undefined) ||
      (row.repository_revision ?? undefined) !== (manifest.repositoryRevision ?? undefined) ||
      row.captured_at !== manifest.capturedAt ||
      row.digest !== manifest.originalDigest
    )
      throw new Error("published source provenance mismatch");
    return verified;
  }

  async publishedPackets(
    sourceIds?: readonly string[],
  ): Promise<Array<{ readonly source: SourceRecord; readonly manifest: SourceManifest; readonly packetPath: string }>> {
    const rows = dbAll<Row>(
      this.db,
      "SELECT * FROM sources WHERE status = 'published' ORDER BY captured_at, source_id",
    );
    const byId = new Map(rows.map((row) => [String(row.source_id), row]));
    const published =
      sourceIds === undefined
        ? rows
        : sourceIds.map((sourceId) => {
            const row = byId.get(sourceId);
            if (!row) throw new Error("published source is unavailable");
            return row;
          });
    const packets: Array<{
      readonly source: SourceRecord;
      readonly manifest: SourceManifest;
      readonly packetPath: string;
    }> = [];
    for (const row of published) {
      try {
        const sourceId = String(row.source_id);
        const digest = String(row.digest ?? "");
        const packetPath = safeChildPath(this.sources(), String(row.manifest_path ?? join(this.sources(), sourceId)));
        const verified = await verifyRetainedPacket(packetPath, { sourceId, originalDigest: digest });
        const { manifest, manifestDigest } = verified;
        if (row.manifest_digest !== manifestDigest) throw new Error("source manifest digest mismatch");
        if (
          row.source_id !== manifest.sourceId ||
          row.kind !== manifest.kind ||
          row.display_name !== manifest.displayName ||
          (row.original_name ?? undefined) !== (manifest.originalName ?? undefined) ||
          (row.source_uri ?? undefined) !== (manifest.sourceUri ?? undefined) ||
          (row.media_type ?? undefined) !== (manifest.mediaType ?? undefined) ||
          (row.repository_revision ?? undefined) !== (manifest.repositoryRevision ?? undefined) ||
          row.captured_at !== manifest.capturedAt ||
          row.digest !== manifest.originalDigest
        )
          throw new Error("published source provenance mismatch");
        packets.push({ source: sourceRecord(row) as unknown as SourceRecord, manifest, packetPath });
      } catch (error) {
        throw new Error("published source packet is unavailable or unverified", { cause: error });
      }
    }
    return packets;
  }
  private discoverCurrentCitationDependencies(): CurrentCitationDependency[] {
    const sources = dbAll<{ source_id: string; digest: string | null; status: string }>(
      this.db,
      "SELECT source_id, digest, status FROM sources ORDER BY source_id",
    );
    const sourceById = new Map(sources.map((source) => [source.source_id, source]));
    const chunks = dbAll<{
      source_id: string;
      chunk_id: string;
      ordinal: number;
      digest: string;
    }>(this.db, "SELECT source_id, chunk_id, ordinal, digest FROM source_chunks ORDER BY source_id, ordinal");
    const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
    const chunkByIdentity = new Map(chunks.map((chunk) => [`${chunk.source_id}\0${chunk.chunk_id}`, chunk]));
    const pages = dbAll<Row>(
      this.db,
      "SELECT page_id, relative_path, status FROM pages WHERE status != 'retired' ORDER BY relative_path, page_id",
    );
    const wikiRoot = wikiPathFor(this.paths);
    const dependencies: CurrentCitationDependency[] = [];
    for (const page of pages) {
      const pageId = String(page.page_id);
      const pageStatus = String(page.status ?? "");
      const path = validRelativePath(String(page.relative_path ?? ""));
      const absolute = safeRelativePath(wikiRoot, path);
      const markdown = readFileNoFollow(absolute).toString("utf8");
      const pageDigest = digestBytes(Buffer.from(markdown));
      const { body } = parseOkfConcept(markdown);
      const references = okfSourceReferences(markdown);
      const citationText = okfCitationText(body);
      const footnoteLabels = okfFootnoteLabels(citationText);
      const referenceLabels = new Set(footnoteLabels.references);
      const definitionLabels = new Set(footnoteLabels.definitions);
      const labels = new Set([...referenceLabels, ...definitionLabels]);
      for (const match of citationText.matchAll(PI_CHUNK_TOKEN)) {
        const label = match[0];
        const offset = match.index;
        if (
          offset !== undefined &&
          offset >= 2 &&
          citationText.slice(offset - 2, offset) === "[^" &&
          okfMarkdownEscapedAt(citationText, offset - 2)
        )
          continue;
        if (
          label &&
          (offset === undefined ||
            offset < 2 ||
            citationText.slice(offset - 2, offset) !== "[^" ||
            citationText[offset + label.length] !== "]")
        )
          throw new Error(`managed OKF source provenance mismatch on page ${path}`);
      }
      const managedByLabel = new Map(
        references
          .filter((reference) => reference.piScholar?.managedBy === "pi-scholar" && typeof reference.id === "string")
          .map((reference) => [reference.id!, reference] as const),
      );
      for (const label of labels) {
        const chunk = chunkById.get(label);
        if ((PI_CHUNK_LABEL.test(label) || chunk !== undefined) && !managedByLabel.has(label))
          throw new Error(`managed OKF source provenance mismatch on page ${path}`);
      }
      for (const reference of references) {
        const identity = reference.piScholar;
        if (identity?.managedBy !== "pi-scholar") continue;
        const source = sourceById.get(identity.sourceId);
        if (
          typeof reference.id !== "string" ||
          !referenceLabels.has(reference.id) ||
          !definitionLabels.has(reference.id)
        )
          throw new Error(`managed OKF source provenance mismatch on page ${path}`);
        const chunk = chunkByIdentity.get(`${identity.sourceId}\0${identity.chunkId}`);
        const expectedChunkId = `${identity.sourceId}:${identity.ordinal}`;
        if (
          !source ||
          (source.status === "removed" && pageStatus !== "drifted") ||
          !chunk ||
          !Number.isInteger(identity.ordinal) ||
          chunk.ordinal !== identity.ordinal ||
          chunk.chunk_id !== expectedChunkId ||
          reference.id !== identity.chunkId ||
          reference.resource !== `pi-scholar://source/${identity.sourceId}/chunk/${identity.ordinal}` ||
          identity.sourceDigest !== source.digest ||
          identity.chunkDigest !== chunk.digest
        )
          throw new Error(`managed OKF source provenance mismatch on page ${path}`);
        if (source.status === "removed") continue;
        dependencies.push({ sourceId: identity.sourceId, pageId, chunkId: identity.chunkId, pageDigest });
      }
    }
    return dependencies;
  }
  private refreshDependencies(): void {
    const dependencies = this.discoverCurrentCitationDependencies();
    transaction(this.db, () => {
      dbRun(this.db, "DELETE FROM source_dependencies WHERE page_id IS NOT NULL OR relation <> 'citation'");
      for (const dependency of dependencies) {
        dbRun(
          this.db,
          "INSERT OR IGNORE INTO source_dependencies (source_id, page_id, chunk_id, relation) VALUES (?, ?, ?, ?)",
          [dependency.sourceId, dependency.pageId, dependency.chunkId, "citation"],
        );
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
  private currentDependentPageIds(sourceId: string, dependencies: CurrentCitationDependency[]): string[] {
    return [
      ...new Set(
        dependencies.filter((dependency) => dependency.sourceId === sourceId).map((dependency) => dependency.pageId),
      ),
    ].sort();
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
  private affectedOpenQuizIdsForPages(pageIds: readonly string[]): string[] {
    if (!pageIds.length) return [];
    const placeholders = pageIds.map(() => "?").join(", ");
    return dbAll<{ quiz_id: string }>(
      this.db,
      `SELECT DISTINCT q.quiz_id FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.quiz_id JOIN question_pages qp ON qp.question_id = qq.question_id JOIN quiz_evidence qe ON qe.quiz_id = q.quiz_id AND qe.page_id = qp.page_id JOIN pages p ON p.page_id = qp.page_id WHERE q.status = 'open' AND qp.page_id IN (${placeholders}) AND p.status != 'retired' ORDER BY q.quiz_id`,
      [...pageIds],
    ).map((row) => row.quiz_id);
  }
  private affectedSubmittedQuizIdsForPages(pageIds: readonly string[]): string[] {
    if (!pageIds.length) return [];
    const placeholders = pageIds.map(() => "?").join(", ");
    return dbAll<{ quiz_id: string }>(
      this.db,
      `SELECT DISTINCT q.quiz_id FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.quiz_id JOIN question_pages qp ON qp.question_id = qq.question_id JOIN quiz_evidence qe ON qe.quiz_id = q.quiz_id AND qe.page_id = qp.page_id JOIN pages p ON p.page_id = qp.page_id WHERE q.status = 'submitted' AND qp.page_id IN (${placeholders}) AND NOT EXISTS (SELECT 1 FROM page_results pr WHERE pr.quiz_id = q.quiz_id AND pr.page_id = qp.page_id) AND p.status != 'retired' ORDER BY q.quiz_id`,
      [...pageIds],
    ).map((row) => row.quiz_id);
  }
  private sourceDependencyRows(sourceId: string): Row[] {
    return dbAll<Row>(
      this.db,
      "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies WHERE source_id = ? ORDER BY source_id, page_id IS NOT NULL, page_id, chunk_id IS NOT NULL, chunk_id, relation",
      [sourceId],
    );
  }
  private removalConfirmationId(
    sourceId: string,
    currentDigest: string,
    dependentPageIds: string[],
    dependencies?: readonly CurrentCitationDependency[],
  ): string {
    let sourceDependencies: Row[];
    if (dependencies === undefined) sourceDependencies = this.sourceDependencyRows(sourceId);
    else {
      const preserved = dbAll<Row>(
        this.db,
        "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies WHERE source_id = ? AND page_id IS NULL AND relation = 'citation' ORDER BY source_id, chunk_id",
        [sourceId],
      );
      const current = new Map<string, { source_id: string; page_id: string; chunk_id: string }>();
      for (const dependency of dependencies) {
        if (dependency.sourceId === sourceId)
          current.set(`${dependency.pageId}\0${dependency.chunkId}`, {
            source_id: dependency.sourceId,
            page_id: dependency.pageId,
            chunk_id: dependency.chunkId,
          });
      }
      const coveredPageIds = new Set(
        dbAll<{ page_id: string }>(
          this.db,
          "SELECT DISTINCT qp.page_id FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.quiz_id JOIN question_pages qp ON qp.question_id = qq.question_id JOIN quiz_evidence qe ON qe.quiz_id = q.quiz_id AND qe.page_id = qp.page_id WHERE q.status = 'open' ORDER BY qp.page_id",
        ).map((row) => row.page_id),
      );
      sourceDependencies = [
        ...preserved,
        ...[...current.values()].map((dependency) => ({ ...dependency, relation: "citation" })),
        ...[...current.values()]
          .filter((dependency) => coveredPageIds.has(dependency.page_id))
          .map((dependency) => ({ ...dependency, relation: "question" })),
      ];
    }
    const dependentPages =
      dependencies === undefined
        ? dbAll<{ page_id: string; digest: string }>(
            this.db,
            "SELECT page_id, digest FROM pages WHERE page_id IN (SELECT page_id FROM source_dependencies WHERE source_id = ? AND page_id IS NOT NULL) ORDER BY page_id",
            [sourceId],
          )
        : [
            ...new Map(
              dependencies
                .filter((dependency) => dependency.sourceId === sourceId)
                .map((dependency) => [
                  dependency.pageId,
                  { page_id: dependency.pageId, digest: dependency.pageDigest },
                ]),
            ).values(),
          ].sort((left, right) => left.page_id.localeCompare(right.page_id));
    const affectedOpenQuizIds =
      dependencies === undefined
        ? this.affectedOpenQuizIds(sourceId)
        : this.affectedOpenQuizIdsForPages(dependentPageIds);
    const affectedSubmittedQuizIds =
      dependencies === undefined
        ? this.affectedSubmittedQuizIds(sourceId)
        : this.affectedSubmittedQuizIdsForPages(dependentPageIds);
    return digestBytes(
      Buffer.from(
        canonical({
          sourceId,
          currentDigest,
          dependentPageIds,
          dependentPages,
          sourceDependencies,
          affectedOpenQuizIds,
          affectedSubmittedQuizIds,
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
  private quizSheetPath(sheetPath: string | undefined, date: string): string {
    const root = pathFor(this.paths, "quizzes");
    const fallback = join(root, date.slice(0, 4), date.slice(5, 7), `${date}.md`);
    const candidate = sheetPath === undefined ? fallback : isAbsolute(sheetPath) ? sheetPath : join(root, sheetPath);
    const relativePath = relative(resolve(root), resolve(candidate)).replaceAll("\\", "/");
    return safeRelativePath(root, relativePath);
  }

  removalPreview(sourceId: string): SourceRemovalPreview {
    const source = dbGet<Row>(this.db, "SELECT * FROM sources WHERE source_id = ?", [sourceId]);
    if (!source) throw new Error("source not found");
    const locations = this.removalLocations(sourceId, source);
    const manifest = parseManifest(locations.packetPath);
    if (manifest.sourceId !== sourceId || manifest.originalDigest !== locations.digest)
      throw new Error("source packet identity mismatch");
    const dependencies = this.discoverCurrentCitationDependencies();
    const dependentPageIds = this.currentDependentPageIds(sourceId, dependencies);
    const currentDigest = manifest.originalDigest;
    const confirmationId = this.removalConfirmationId(sourceId, currentDigest, dependentPageIds, dependencies);
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
    this.refreshDependencies();
    const preview = this.removalPreview(sourceId);
    const token = typeof confirmation === "string" ? confirmation : confirmation.confirmationId;
    if (token !== preview.confirmationId)
      throw Object.assign(new Error("stale removal confirmation"), { code: "revision-conflict" });
    const affectedSubmittedQuizIds = this.affectedSubmittedQuizIds(sourceId);
    if (affectedSubmittedQuizIds.length)
      throw new Error(
        `source removal conflict: submitted quizzes without page settlement: ${affectedSubmittedQuizIds.join(", ")}`,
      );
    const affectedQuizIds = this.affectedOpenQuizIds(sourceId);
    const quizSheetSnapshots: Array<{ sheetPath: string; previous?: Buffer; mode?: number }> = affectedQuizIds.flatMap(
      (quizId): Array<{ sheetPath: string; previous?: Buffer; mode?: number }> => {
        const row = dbGet<Row>(this.db, "SELECT date, sheet_path FROM quizzes WHERE quiz_id = ?", [quizId]);
        if (!row) return [];
        const date = String(row.date ?? "");
        const sheetPath = this.quizSheetPath(row.sheet_path ? String(row.sheet_path) : undefined, date);
        try {
          const stat = lstatNoFollowSync(sheetPath);
          return [{ sheetPath, previous: readFileNoFollow(sheetPath), mode: stat.mode & 0o777 }];
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
          else atomicWriteFile(sheet.sheetPath, sheet.previous, sheet.mode);
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

export { atomizeExtraction, validateChunkEndpoints };
export const sha256 = digestBytes;
