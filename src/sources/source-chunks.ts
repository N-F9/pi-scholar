import { randomUUID } from "node:crypto";
import { closeSync, constants, promises as fs, openSync, readSync } from "node:fs";
import { type FileHandle, open as openFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { DoclingResult as ExternalDoclingResult } from "../external/docling.js";
import { assertNoSymlinkPath } from "../vault.js";
import {
  copyFileNoFollow,
  copyFileRangeNoFollow,
  digestBytes,
  hashFile,
  lstatNoFollow,
  lstatNoFollowSync,
  walkFiles,
  writeFully,
} from "./source-files.js";
import type { ChunkPlanEndpoint, DoclingResult, SourceChunk, TreeSnapshot } from "./source-service.js";

const IO_BUFFER_SIZE = 64 * 1024;
const MAX_ATOMS = 2048;
export interface AtomMetadata {
  index: number;
  startByte: number;
  endByte: number;
  byteLength: number;
  startLine: number;
  endLine: number;
}
export interface FileDoclingResult {
  extractedPath: string;
  converter?: { name: string; version?: string };
  attachments: Array<{ path: string; absolutePath: string; byteLength: number; digest: string }>;
}
export interface ExtractionFileBoundary {
  startByte: number;
  endByte: number;
  preserveBlankRuns: boolean;
}

function atomRowsFromBuffer(extracted: Buffer): AtomMetadata[] {
  if (extracted.length === 0) return [];
  const atoms: AtomMetadata[] = [];
  let lineStart = 0;
  let lineNumber = 1;
  const finishLine = (end: number): void => {
    atoms.push({
      index: atoms.length,
      startByte: lineStart,
      endByte: end,
      byteLength: end - lineStart,
      startLine: lineNumber,
      endLine: lineNumber,
    });
    lineStart = end;
    lineNumber++;
  };
  for (let index = 0; index < extracted.length; index++) if (extracted[index] === 10) finishLine(index + 1);
  if (lineStart < extracted.length) finishLine(extracted.length);
  return atoms;
}

async function scanFile(path: string, visit: (byte: number, position: number) => void): Promise<number> {
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const buffer = Buffer.allocUnsafe(IO_BUFFER_SIZE);
  let position = 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`extraction must be a regular file: ${path}`);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      for (let index = 0; index < bytesRead; index++) visit(buffer[index]!, position++);
    }
    return stat.size;
  } finally {
    await handle.close();
  }
}

export async function planFileAtoms(path: string): Promise<AtomMetadata[]> {
  const stat = await lstatNoFollow(path);
  if (!stat.isFile()) throw new Error(`extraction must be a regular file: ${path}`);
  if (stat.size === 0) return [];
  let lineCount = 0;
  let lastByte = -1;
  await scanFile(path, (byte) => {
    if (byte === 10) lineCount++;
    lastByte = byte;
  });
  if (lastByte !== 10) lineCount++;
  const groupSize = Math.max(1, Math.ceil(lineCount / MAX_ATOMS));
  const atoms: AtomMetadata[] = [];
  let groupStart = 0;
  let groupStartLine = 1;
  let groupLines = 0;
  let lineNumber = 1;
  let finalSize = 0;
  const finishLine = (end: number): void => {
    const endLine = lineNumber;
    groupLines++;
    if (groupLines >= groupSize) {
      atoms.push({
        index: atoms.length,
        startByte: groupStart,
        endByte: end,
        byteLength: end - groupStart,
        startLine: groupStartLine,
        endLine,
      });
      groupStart = end;
      groupStartLine = endLine + 1;
      groupLines = 0;
    }
    lineNumber++;
  };
  await scanFile(path, (byte, position) => {
    finalSize = position + 1;
    if (byte === 10) finishLine(finalSize);
  });
  if (lastByte !== 10) finishLine(finalSize);
  if (groupLines > 0)
    atoms.push({
      index: atoms.length,
      startByte: groupStart,
      endByte: finalSize,
      byteLength: finalSize - groupStart,
      startLine: groupStartLine,
      endLine: lineNumber - 1,
    });
  if (!atoms.length) throw new Error("extraction is empty");
  return atoms;
}

interface FileChunkScanner {
  readonly chunks: AtomMetadata[];
  visit(byte: number, position: number): void;
  finish(): void;
}

export function chunkEndpointNumber(endpoint: number | ChunkPlanEndpoint): number | undefined {
  if (typeof endpoint === "number") return endpoint;
  if (typeof endpoint !== "object" || endpoint === null || Array.isArray(endpoint)) return undefined;
  const record = endpoint as unknown as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "endLine")) return undefined;
  return typeof record.endLine === "number" ? record.endLine : undefined;
}

function fileEndpointNumbers(proposed: readonly (number | ChunkPlanEndpoint)[] | undefined): number[] | undefined {
  if (!proposed?.length) return undefined;
  const endpoints = proposed.map(chunkEndpointNumber);
  for (const endpoint of endpoints)
    if (endpoint === undefined || !Number.isInteger(endpoint) || endpoint <= 0)
      throw new Error("chunk endpoints must be increasing line endpoints");
  for (let index = 1; index < endpoints.length; index++)
    if (endpoints[index]! <= endpoints[index - 1]!)
      throw new Error("chunk endpoints must be strictly increasing line endpoints");
  return endpoints as number[];
}

function createFileChunkScanner(proposed: readonly (number | ChunkPlanEndpoint)[] | undefined): FileChunkScanner {
  const endpoints = fileEndpointNumbers(proposed);
  const chunks: AtomMetadata[] = [];
  let lineCount = 0;
  let chunkStartByte = 0;
  let chunkStartLine = 1;
  let scannedSize = 0;
  let lastByte = -1;
  let nextEndpoint = 0;
  const finishLine = (endByte: number): void => {
    const endLine = ++lineCount;
    scannedSize = endByte;
    lastByte = 10;
    const endpoint = endpoints?.[nextEndpoint];
    if (endpoint === endLine) {
      chunks.push({
        index: chunks.length,
        startByte: chunkStartByte,
        endByte,
        byteLength: endByte - chunkStartByte,
        startLine: chunkStartLine,
        endLine,
      });
      chunkStartByte = endByte;
      chunkStartLine = endLine + 1;
      nextEndpoint++;
    } else if (endpoint !== undefined && endpoint < endLine) {
      throw new Error("chunk endpoints must be strictly increasing line endpoints");
    }
  };
  return {
    chunks,
    visit(byte, position) {
      scannedSize = position + 1;
      lastByte = byte;
      if (byte === 10) finishLine(position + 1);
    },
    finish() {
      if (scannedSize > 0 && lastByte !== 10) {
        const endLine = ++lineCount;
        const endpoint = endpoints?.[nextEndpoint];
        if (endpoint === endLine) {
          chunks.push({
            index: chunks.length,
            startByte: chunkStartByte,
            endByte: scannedSize,
            byteLength: scannedSize - chunkStartByte,
            startLine: chunkStartLine,
            endLine,
          });
          chunkStartByte = scannedSize;
          chunkStartLine = endLine + 1;
          nextEndpoint++;
        } else if (endpoint !== undefined && endpoint < endLine) {
          throw new Error("chunk endpoints must be strictly increasing line endpoints");
        }
      }
      if (!lineCount) {
        if (endpoints?.length) throw new Error("chunk endpoints must cover all extraction lines");
        return;
      }
      if (!endpoints) {
        if (chunks.length === 0)
          chunks.push({
            index: 0,
            startByte: 0,
            endByte: scannedSize,
            byteLength: scannedSize,
            startLine: 1,
            endLine: lineCount,
          });
        return;
      }
      if (endpoints.at(-1)! > lineCount) throw new Error("chunk endpoints must be increasing line endpoints");
      if (nextEndpoint !== endpoints.length || endpoints.at(-1) !== lineCount)
        throw new Error("chunk endpoints must cover all extraction lines");
    },
  };
}
async function copySpoolRange(input: FileHandle, output: FileHandle, start: number, end: number): Promise<void> {
  const buffer = Buffer.allocUnsafe(IO_BUFFER_SIZE);
  let position = start;
  while (position < end) {
    const want = Math.min(buffer.length, end - position);
    const { bytesRead } = await input.read(buffer, 0, want, position);
    if (!bytesRead) throw new Error("normalization spool ended unexpectedly");
    await writeFully(output, buffer, 0, bytesRead);
    position += bytesRead;
  }
}

export async function normalizeMarkdownFile(
  source: string,
  target: string,
  collapseBlankRuns = true,
  fileBoundaries?: readonly ExtractionFileBoundary[],
): Promise<void> {
  const inputStat = await lstatNoFollow(source);
  if (!inputStat.isFile()) throw new Error(`Markdown source must be a regular file: ${source}`);
  assertNoSymlinkPath(target);
  if (!collapseBlankRuns) {
    await copyFileNoFollow(source, target);
    return;
  }
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const output = await openFile(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const spoolPath = join(dirname(target), `.${basename(target)}.${randomUUID()}.line`);
  let spoolWriter: FileHandle | undefined;
  let spoolReader: FileHandle | undefined;
  let input: FileHandle | undefined;
  let inFence: { char: string; length: number } | undefined;
  let previousBlank = false;
  let lineStart = 0;
  let position = 0;
  let pendingStart: number | undefined;
  let pendingEnd = 0;
  let lineBlank = true;
  let boundaryIndex = 0;
  let leadingSpaces = 0;
  let fenceChar: string | undefined;
  let fenceLength = 0;
  let fenceTailOnly = true;
  let fencePhase: "leading" | "run" | "tail" | "invalid" = "leading";
  const flushPending = async (): Promise<void> => {
    if (pendingStart === undefined) return;
    await copySpoolRange(spoolReader!, output, pendingStart, pendingEnd);
    pendingStart = undefined;
    pendingEnd = 0;
  };
  const boundaryAt = (lineStartByte: number): ExtractionFileBoundary | undefined => {
    let boundary = fileBoundaries?.[boundaryIndex];
    while (boundary && boundary.endByte <= lineStartByte) {
      boundaryIndex++;
      boundary = fileBoundaries?.[boundaryIndex];
    }
    return boundary && boundary.startByte <= lineStartByte ? boundary : undefined;
  };
  const scanLineByte = (byte: number): void => {
    if (byte !== 32 && byte !== 9 && byte !== 13) lineBlank = false;
    if (fencePhase === "invalid") return;
    if (fencePhase === "leading") {
      if (byte === 32 || byte === 9) {
        if (leadingSpaces < 3) leadingSpaces++;
        else fencePhase = "invalid";
      } else if (byte === 96 || byte === 126) {
        fenceChar = String.fromCharCode(byte);
        fenceLength = 1;
        fencePhase = "run";
      } else {
        fencePhase = "invalid";
      }
      return;
    }
    if (fencePhase === "run") {
      if (byte === fenceChar?.charCodeAt(0)) {
        fenceLength++;
      } else {
        fencePhase = "tail";
        if (byte !== 32 && byte !== 9 && byte !== 13) fenceTailOnly = false;
      }
      return;
    }
    if (byte !== 32 && byte !== 9 && byte !== 13) fenceTailOnly = false;
  };
  const finishLine = async (end: number): Promise<void> => {
    const marker =
      fenceChar && fenceLength >= 3 ? { char: fenceChar, length: fenceLength, tailOnly: fenceTailOnly } : undefined;
    const blank = lineBlank;
    const boundary = boundaryAt(lineStart);
    if (fileBoundaries && !boundary) {
      inFence = undefined;
      previousBlank = false;
    }
    const preserveBlank = boundary?.preserveBlankRuns === true;
    if (preserveBlank || inFence || !blank || !previousBlank) {
      if (pendingStart === undefined) pendingStart = lineStart;
      pendingEnd = end;
    } else {
      await flushPending();
    }
    if (inFence) {
      if (marker?.tailOnly && marker.char === inFence.char && marker.length >= inFence.length) inFence = undefined;
    } else if (blank) {
      previousBlank = true;
    } else {
      previousBlank = false;
      if (marker) inFence = { char: marker.char, length: marker.length };
    }
    lineStart = end;
    lineBlank = true;
    fenceChar = undefined;
    leadingSpaces = 0;
    fenceLength = 0;
    fenceTailOnly = true;
    fencePhase = "leading";
  };
  try {
    spoolWriter = await openFile(spoolPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    spoolReader = await openFile(spoolPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    input = await openFile(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.allocUnsafe(IO_BUFFER_SIZE);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      await writeFully(spoolWriter, buffer, 0, bytesRead);
      for (let index = 0; index < bytesRead; index++) {
        const byte = buffer[index]!;
        if (byte === 10) await finishLine(position + index + 1);
        else scanLineByte(byte);
      }
      position += bytesRead;
    }
    if (lineStart < position) await finishLine(position);
    await flushPending();
  } catch (error) {
    await output.close().catch(() => undefined);
    await fs.rm(target, { force: true });
    throw error;
  } finally {
    await input?.close().catch(() => undefined);
    await spoolReader?.close().catch(() => undefined);
    await spoolWriter?.close().catch(() => undefined);
    await fs.rm(spoolPath, { force: true });
  }
  await output.close();
}
export function atomizeExtraction(extracted: string | Uint8Array): Array<AtomMetadata & { body: Buffer }> {
  const bytes = Buffer.from(extracted);
  return atomRowsFromBuffer(bytes).map((atom) => ({
    ...atom,
    body: Buffer.from(bytes.subarray(atom.startByte, atom.endByte)),
  }));
}

function endpointsFrom(proposed: readonly (number | ChunkPlanEndpoint)[] | undefined, atomCount: number): number[] {
  const endpoints = proposed?.length ? proposed.map(chunkEndpointNumber) : [atomCount];
  for (const endpoint of endpoints)
    if (endpoint === undefined || !Number.isInteger(endpoint) || endpoint <= 0 || endpoint > atomCount)
      throw new Error("chunk endpoints must be increasing line endpoints");
  if (endpoints.at(-1) !== atomCount) throw new Error("chunk endpoints must cover all extraction lines");
  for (let index = 1; index < endpoints.length; index++)
    if (endpoints[index]! <= endpoints[index - 1]!)
      throw new Error("chunk endpoints must be strictly increasing line endpoints");
  return endpoints as number[];
}

export function validateChunkEndpoints(
  extracted: string | Uint8Array,
  proposed?: Array<number | ChunkPlanEndpoint>,
): SourceChunk[] {
  const bytes = Buffer.from(extracted);
  const atoms = atomizeExtraction(bytes);
  const endpoints = endpointsFrom(proposed, atoms.length);
  const chunks: SourceChunk[] = [];
  let startAtom = 0;
  for (const [index, endAtom] of endpoints.entries()) {
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

export async function validateFileEndpoints(
  path: string,
  proposed?: readonly (number | ChunkPlanEndpoint)[],
): Promise<{ chunks: AtomMetadata[] }> {
  const scanner = createFileChunkScanner(proposed);
  await scanFile(path, (byte, position) => scanner.visit(byte, position));
  scanner.finish();
  return { chunks: scanner.chunks };
}

export function validateFileEndpointsSync(
  path: string,
  proposed?: readonly (number | ChunkPlanEndpoint)[],
): { chunks: AtomMetadata[] } {
  const stat = lstatNoFollowSync(path);
  if (!stat.isFile()) throw new Error(`extraction must be a regular file: ${path}`);
  const scanner = createFileChunkScanner(proposed);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const buffer = Buffer.allocUnsafe(IO_BUFFER_SIZE);
  let position = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      for (let index = 0; index < count; index++, position++) scanner.visit(buffer[index]!, position);
    }
  } finally {
    closeSync(fd);
  }
  scanner.finish();
  return { chunks: scanner.chunks };
}

export async function writeFileChunks(
  path: string,
  root: string,
  chunks: readonly AtomMetadata[],
): Promise<Array<AtomMetadata & { digest: string }>> {
  await fs.mkdir(root, { recursive: false, mode: 0o700 });
  const output: Array<AtomMetadata & { digest: string }> = [];
  for (const chunk of chunks) {
    const target = `${root}/${String(chunk.index + 1).padStart(4, "0")}.md`;
    await copyFileRangeNoFollow(path, target, chunk.startByte, chunk.endByte);
    const digest = await hashFile(target);
    output.push({ ...chunk, digest: digest.digest });
  }
  return output;
}

function isLocalDoclingResult(result: DoclingResult | ExternalDoclingResult): result is DoclingResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const record = result as unknown as Record<string, unknown>;
  return "extracted" in record && !("outputDirectory" in record);
}

export async function normalizeDoclingResult(
  result: DoclingResult | ExternalDoclingResult,
): Promise<DoclingResult | FileDoclingResult> {
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
  const files = await walkFiles(record.outputDirectory, "", false);
  const extracted = files.find((file) => [".md", ".markdown", ".txt"].includes(extname(file.path).toLowerCase()));
  if (!extracted) throw new Error("Docling produced no Markdown or text output");
  return {
    extractedPath: extracted.absolutePath,
    converter: { name: "docling", version: "unknown" },
    attachments: files
      .filter((file) => file.path !== extracted.path)
      .map((file) => ({
        path: file.path,
        absolutePath: file.absolutePath,
        byteLength: file.size,
        digest: file.digest,
      })),
  };
}

export async function writeNativeExtraction(
  snapshot: TreeSnapshot,
  target: string,
  preserveBlankRuns?: ReadonlySet<string>,
): Promise<ExtractionFileBoundary[] | undefined> {
  if (snapshot.files.length === 1 && snapshot.kind !== "directory" && snapshot.kind !== "repository") {
    const first = snapshot.files[0];
    if (!first) throw new Error("source snapshot has no file");
    await copyFileNoFollow(first.absolutePath, target);
    return undefined;
  }
  const output = await openFile(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const boundaries: ExtractionFileBoundary[] = [];
  let outputPosition = 0;
  const write = async (bytes: Uint8Array): Promise<void> => {
    await writeFully(output, bytes);
    outputPosition += bytes.byteLength;
  };
  const append = async (source: string): Promise<void> => {
    const input = await openFile(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.allocUnsafe(IO_BUFFER_SIZE);
    try {
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        await writeFully(output, buffer, 0, bytesRead);
        outputPosition += bytesRead;
      }
    } finally {
      await input.close();
    }
  };
  try {
    for (const file of snapshot.files) {
      await write(Buffer.from(`--- FILE: ${file.path} ---\n`));
      const startByte = outputPosition;
      await append(file.absolutePath);
      if (file.size > 0) {
        const tail = await openFile(file.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const last = Buffer.alloc(1);
        try {
          await tail.read(last, 0, 1, file.size - 1);
        } finally {
          await tail.close();
        }
        if (last[0] !== 10) await write(Buffer.from("\n"));
      }
      boundaries.push({
        startByte,
        endByte: outputPosition,
        preserveBlankRuns: preserveBlankRuns?.has(file.path) === true,
      });
      await write(Buffer.from(`--- END FILE: ${file.path} ---\n`));
    }
  } finally {
    await output.close();
  }
  return boundaries;
}
