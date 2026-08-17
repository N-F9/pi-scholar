import { createHash } from "node:crypto";
import { promises as fs, lstatSync } from "node:fs";
import { extname, join } from "node:path";
import { readFileNoFollow } from "../vault.js";
import { validateFileEndpoints } from "./source-chunks.js";
import {
  canonical,
  compareFileRange,
  hashFile,
  INPUT_KINDS,
  lstatNoFollow,
  parseMetadata,
  readNoFollow,
  requiredString,
  SOURCE_KINDS,
  sanitizedSourceUri,
  treeDigest,
  validRelativePath,
  walkFiles,
} from "./source-files.js";
import type {
  PersistedPreparedAdmission,
  PhysicalIdentity,
  SourceKind,
  SourceManifest,
  StageMetadata,
} from "./source-service.js";

function manifestOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error(`invalid source manifest ${key}`);
  return value;
}

function manifestRequiredString(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid source manifest ${key}`);
  return value;
}

function parseManifestValue(raw: unknown): SourceManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid source manifest");
  const record = raw as Record<string, unknown>;
  manifestRequiredString(record, "id");
  manifestRequiredString(record, "sourceId");
  const kind = manifestRequiredString(record, "kind") as SourceKind;
  if (!SOURCE_KINDS.includes(kind)) throw new Error("invalid source manifest kind");
  manifestRequiredString(record, "displayName");
  const capturedAt = manifestRequiredString(record, "capturedAt");
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("invalid source manifest capturedAt");
  const normalizer = record.normalizer;
  if (
    normalizer === null ||
    typeof normalizer !== "object" ||
    Array.isArray(normalizer) ||
    (normalizer as Record<string, unknown>).name !== "markdown-blank-lines" ||
    (normalizer as Record<string, unknown>).version !== "2"
  )
    throw new Error("invalid source manifest normalizer");
  for (const key of ["originalBytes", "originalByteLength", "extractionBytes", "extractedByteLength"]) {
    manifestInteger(record[key], key);
  }
  for (const key of ["originalDigest", "extractionDigest", "extractedDigest"]) {
    manifestDigest(record[key], key);
  }
  if (!Array.isArray(record.files) || !Array.isArray(record.chunks)) throw new Error("invalid source manifest files");
  if (!Array.isArray(record.attachments)) throw new Error("invalid source manifest attachments");
  for (const [label, entries] of [
    ["files", record.files],
    ["attachments", record.attachments],
  ] as const) {
    for (const [index, item] of entries.entries()) {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        throw new Error(`invalid source manifest ${label} ${index}`);
      manifestOptionalString(item as Record<string, unknown>, "mediaType");
    }
  }
  const originalName = manifestOptionalString(record, "originalName");
  if (originalName !== undefined) validRelativePath(originalName);
  for (const key of ["sourceUri", "originalUrl"] as const) {
    const value = manifestOptionalString(record, key);
    if (value === undefined) continue;
    const sanitized = sanitizedSourceUri(value);
    if (sanitized !== value) throw new Error("source manifest URL is not canonical");
    record[key] = sanitized;
  }
  if (
    (record.sourceUri === undefined) !== (record.originalUrl === undefined) ||
    record.sourceUri !== record.originalUrl
  )
    throw new Error("source manifest URL fields disagree");
  manifestOptionalString(record, "mediaType");
  const revision = record.revision === undefined ? undefined : manifestRequiredString(record, "revision");
  const repositoryRevision =
    record.repositoryRevision === undefined ? undefined : manifestRequiredString(record, "repositoryRevision");
  if (revision !== repositoryRevision) throw new Error("source manifest revision fields disagree");
  if (record.inputKind !== undefined) {
    const inputKind = manifestOptionalString(record, "inputKind");
    if (!inputKind || !(INPUT_KINDS as readonly string[]).includes(inputKind))
      throw new Error("invalid source manifest input kind");
  }
  if (record.converter !== undefined) {
    const converter = record.converter;
    if (converter === null || typeof converter !== "object" || Array.isArray(converter))
      throw new Error("invalid source manifest converter");
    const converterRecord = converter as Record<string, unknown>;
    manifestRequiredString(converterRecord, "name");
    manifestRequiredString(converterRecord, "version");
  }
  if (record.stagedMetadata !== undefined) {
    const metadataJson = JSON.stringify(record.stagedMetadata);
    if (metadataJson === undefined) throw new Error("invalid source manifest metadata");
    record.stagedMetadata = parseMetadata(metadataJson);
  }
  return raw as SourceManifest;
}

export function readManifest(packet: string): { readonly manifest: SourceManifest; readonly manifestDigest: string } {
  const manifestPath = join(packet, "manifest.json");
  const stat = lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("source manifest must be a regular file");
  const bytes = readFileNoFollow(manifestPath);
  return {
    manifest: parseManifestValue(JSON.parse(bytes.toString("utf8")) as unknown),
    manifestDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}
export function parseManifest(packet: string): SourceManifest {
  return readManifest(packet).manifest;
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
  const attachments = value
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
  for (let index = 1; index < attachments.length; index++) {
    if (attachments[index - 1]!.path === attachments[index]!.path)
      throw new Error(`source manifest attachment path is duplicated: ${attachments[index]!.path}`);
  }
  return attachments;
}
export interface VerifiedSourceAttachment {
  readonly bytes: Buffer;
  readonly byteLength: number;
  readonly contentType: "image/png" | "image/jpeg" | "image/webp";
  readonly manifest: SourceManifest;
  readonly manifestDigest: string;
}

function rasterContentType(path: string): VerifiedSourceAttachment["contentType"] {
  switch (extname(path).toLocaleLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      throw new Error("source attachment media type is not renderable");
  }
}

export async function verifyRetainedAttachment(
  packet: string,
  expected: { sourceId: string; originalDigest: string; manifestDigest: string; attachmentDigest: string },
): Promise<VerifiedSourceAttachment> {
  const packetStat = await lstatNoFollow(packet);
  if (!packetStat.isDirectory()) throw new Error("source packet must be a directory");
  const attachmentsRoot = join(packet, "attachments");
  if (!(await lstatNoFollow(attachmentsRoot)).isDirectory())
    throw new Error("source packet attachments are unavailable");
  const manifestPath = join(packet, "manifest.json");
  if (!(await lstatNoFollow(manifestPath)).isFile()) throw new Error("source manifest must be a regular file");
  const manifestBytes = await readNoFollow(manifestPath);
  const manifestDigestValue = createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestDigestValue !== expected.manifestDigest) throw new Error("source manifest digest mismatch");
  const manifest = parseManifestValue(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  if (
    manifest.id !== manifest.sourceId ||
    manifest.sourceId !== expected.sourceId ||
    manifest.originalDigest !== expected.originalDigest
  )
    throw new Error("source packet identity mismatch");
  const attachments = manifestAttachments(manifest.attachments);
  const matches = attachments.filter((attachment) => attachment.digest === expected.attachmentDigest);
  if (!matches.length) throw new Error("source attachment identity is ambiguous or unavailable");
  const attachment = matches[0]!;
  const contentType = rasterContentType(attachment.path);
  const attachmentPath = join(attachmentsRoot, attachment.path);
  const bytes = await readNoFollow(attachmentPath);
  if (bytes.byteLength !== attachment.byteLength) throw new Error("source attachment byte length mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== attachment.digest)
    throw new Error("source attachment digest mismatch");
  return { bytes, byteLength: bytes.byteLength, contentType, manifest, manifestDigest: manifestDigestValue };
}

export async function verifyRetainedPacket(
  packet: string,
  expected: { sourceId: string; originalDigest: string },
): Promise<{ readonly manifest: SourceManifest; readonly manifestDigest: string }> {
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
  const manifestBytes = await readNoFollow(manifestPath);
  const manifest = parseManifestValue(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const manifestDigestValue = createHash("sha256").update(manifestBytes).digest("hex");
  for (const [label, entries] of [
    ["files", manifest.files],
    ["attachments", manifest.attachments],
  ] as const) {
    for (const [index, entry] of entries.entries()) {
      const mediaType = (entry as unknown as Record<string, unknown>).mediaType;
      if (mediaType !== manifest.mediaType) throw new Error(`retained source ${label} media type mismatch at ${index}`);
    }
  }
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
  if (treeDigest(originalFiles, manifest.repositoryRevision) !== manifest.originalDigest)
    throw new Error("retained source original tree digest mismatch");
  const extractedPath = join(packet, "extracted.md");
  const extractedStat = await lstatNoFollow(extractedPath);
  if (!extractedStat.isFile()) throw new Error("source extraction must be a regular file");
  const extractedFile = await hashFile(extractedPath);
  const extractedLength = manifestInteger(manifest.extractedByteLength, "extractedByteLength");
  if (
    manifestInteger(manifest.extractionBytes, "extractionBytes") !== extractedLength ||
    extractedLength !== extractedFile.size
  )
    throw new Error("retained source extraction length mismatch");
  const extractedDigest = manifestDigest(manifest.extractedDigest, "extractedDigest");
  if (
    manifestDigest(manifest.extractionDigest, "extractionDigest") !== extractedDigest ||
    extractedFile.digest !== extractedDigest
  )
    throw new Error("retained source extraction digest mismatch");
  const chunkNames = (await fs.readdir(chunksRoot)).sort((left, right) => left.localeCompare(right));
  if (!manifest.chunks.length || chunkNames.length !== manifest.chunks.length)
    throw new Error("retained source chunks are incomplete");
  const planned = await validateFileEndpoints(
    extractedPath,
    manifest.chunks.map((chunk, index) =>
      manifestInteger((chunk as unknown as Record<string, unknown>).endAtom, `chunks[${index}].endAtom`),
    ),
  );
  let nextAtom = 0;
  let nextByte = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    const record = chunk as unknown as Record<string, unknown>;
    const expectedName = `${String(index + 1).padStart(4, "0")}.md`;
    if (chunkNames[index] !== expectedName) throw new Error("retained source chunk order is invalid");
    const chunkPath = join(chunksRoot, expectedName);
    const chunkStat = await lstatNoFollow(chunkPath);
    if (!chunkStat.isFile()) throw new Error("source chunk must be a regular file");
    const chunkFile = await hashFile(chunkPath);
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
    const byteLength = manifestInteger(record.byteLength, `chunks[${index}].byteLength`);
    const plannedChunk = planned.chunks[index];
    if (
      startAtom !== atomStart ||
      endAtom !== atomEnd ||
      startAtom !== nextAtom ||
      endAtom <= startAtom ||
      startByte !== nextByte ||
      endByte < startByte ||
      endByte - startByte !== chunkFile.size ||
      endByte - startByte !== byteLength ||
      !plannedChunk ||
      plannedChunk.startLine - 1 !== startAtom ||
      plannedChunk.endLine !== endAtom ||
      plannedChunk.startByte !== startByte ||
      plannedChunk.endByte !== endByte
    )
      throw new Error("retained source chunk coverage is invalid");
    if (
      !(await compareFileRange(extractedPath, startByte, endByte, chunkPath)) ||
      chunkFile.digest !== manifestDigest(record.digest, `chunks[${index}].digest`)
    )
      throw new Error("retained source chunk digest mismatch");
    nextAtom = endAtom;
    nextByte = endByte;
  }
  if (nextAtom !== planned.chunks.at(-1)?.endLine || nextByte !== extractedFile.size)
    throw new Error("retained source chunk reconstruction is incomplete");
  return { manifest, manifestDigest: manifestDigestValue };
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
export function parsePreparedMetadata(raw: unknown): PersistedPreparedAdmission {
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
    const startLine = integerField(item, "startLine");
    const endLine = integerField(item, "endLine");
    if (endByte < startByte || endByte - startByte !== byteLength || startLine < 1 || endLine < startLine)
      throw new Error("invalid prepared metadata atom bounds");
    return { index, startByte, endByte, byteLength, startLine, endLine };
  });
  if (atoms.length > 2048) throw new Error("invalid prepared metadata atom count");
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
