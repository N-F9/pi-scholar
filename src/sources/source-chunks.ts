import { extname } from "node:path";
import type { DoclingResult as ExternalDoclingResult } from "../external/docling.js";
import { digestBytes, walkFiles } from "./source-files.js";
import type { ChunkPlanEndpoint, DoclingResult, SourceChunk, TreeSnapshot } from "./source-service.js";

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
export async function normalizeDoclingResult(result: DoclingResult | ExternalDoclingResult): Promise<DoclingResult> {
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

export function chunkExtraction(
  extracted: string | Uint8Array,
  endpoints?: Array<number | ChunkPlanEndpoint>,
): SourceChunk[] {
  return validateChunkEndpoints(extracted, endpoints);
}
