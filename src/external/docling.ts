import { constants, existsSync, promises as fs, lstatSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { safeRelativePath, type VaultPaths } from "../vault.js";
import { type ChildResult, type ChildRunOptions, runChild, runChildSync } from "./process.js";

const DOCLING_TIMEOUT_MS = 60 * 60 * 1000;
const DEPENDENCY_TIMEOUT_MS = 30_000;
const QPDF_TIMEOUT_MS = 5 * 60 * 1000;
export const PDF_BATCH_PAGES = 256;
const DOCLING_VERSION_PATTERN = /^(?:docling(?:\s+version)?\s*:?\s+)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/iu;
const QPDF_VERSION_PATTERN = /^qpdf version \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/iu;

export interface DoclingRequest {
  readonly inputRelativePath: string;
  readonly outputRelativeDirectory: string;
  readonly mediaType?: string;
  readonly timeoutMs?: number;
}

export interface DoclingResult {
  readonly command: ChildResult;
  readonly outputDirectory: string;
  readonly converter: { readonly name: "docling"; readonly version: string };
}

export type DoclingSyncRunner = (paths: VaultPaths, args: readonly string[], timeoutMs?: number) => ChildResult;
export type DoclingAsyncRunner = (
  executable: string,
  args: readonly string[],
  options: ChildRunOptions,
) => Promise<ChildResult>;

export interface DoclingRuntime {
  readonly run?: DoclingAsyncRunner;
  readonly dependencyIdentity?: (paths: VaultPaths) => { readonly executable: string; readonly version: string };
}

interface PdfPart {
  readonly path: string;
  readonly startPage: number;
  readonly endPage: number;
  readonly stem: string;
}

interface OutputFile {
  readonly path: string;
  readonly absolutePath: string;
}

interface ConvertedPart extends PdfPart {
  readonly outputDirectory: string;
}

function validateDocumentPath(paths: VaultPaths, relativePath: string): string {
  const path = safeRelativePath(paths.workRoot, relativePath);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Docling input must be a regular file");
  return path;
}

function validateOutputDirectory(paths: VaultPaths, relativePath: string): string {
  const output = safeRelativePath(paths.workRoot, relativePath);
  if (existsSync(output)) {
    const stat = lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Docling output must be a real directory");
  }
  return output;
}

function outputDetail(command: ChildResult): string {
  return (command.stderr.trim() || command.stdout.trim()).slice(0, 500);
}

function assertSuccessful(label: string, command: ChildResult, timeoutMs: number): void {
  if (command.timedOut) throw new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
  if (command.signal) throw new Error(`${label} terminated by signal ${command.signal}`);
  if (command.code !== 0) {
    const detail = outputDetail(command);
    throw new Error(`${label} failed with exit code ${command.code ?? "unknown"}${detail ? `: ${detail}` : ""}`);
  }
}

function conversionArgs(inputPath: string, outputDirectory: string): readonly string[] {
  return ["convert", "--image-export-mode", "referenced", "--output", outputDirectory, inputPath];
}

export function doclingArgs(
  paths: VaultPaths,
  request: DoclingRequest,
): { readonly inputPath: string; readonly outputDirectory: string; readonly args: readonly string[] } {
  const inputPath = validateDocumentPath(paths, request.inputRelativePath);
  const outputDirectory = validateOutputDirectory(paths, request.outputRelativeDirectory);
  return {
    inputPath,
    outputDirectory,
    args: conversionArgs(inputPath, outputDirectory),
  };
}

export function doclingEnvironment(paths: VaultPaths): Readonly<Record<string, string>> {
  return { HOME: paths.workRoot, XDG_CACHE_HOME: join(paths.workRoot, "cache"), DOCLING_CACHE_DIR: paths.workRoot };
}

function isPdf(inputPath: string, mediaType: string | undefined): boolean {
  return (
    extname(inputPath).toLowerCase() === ".pdf" ||
    mediaType?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
  );
}

async function pdfPageCount(paths: VaultPaths, inputPath: string, runner: DoclingAsyncRunner): Promise<number> {
  const result = await runner("qpdf", ["--show-npages", inputPath], {
    cwd: paths.workRoot,
    timeoutMs: QPDF_TIMEOUT_MS,
  });
  assertSuccessful("qpdf page count", result, QPDF_TIMEOUT_MS);
  const output = result.stdout.trim();
  if (!/^[1-9]\d*$/u.test(output)) throw new Error("qpdf page count returned an invalid page count");
  const count = Number(output);
  if (!Number.isSafeInteger(count)) throw new Error("qpdf page count exceeds the supported range");
  return count;
}

async function splitPdf(
  paths: VaultPaths,
  inputPath: string,
  pageCount: number,
  workspace: string,
  runner: DoclingAsyncRunner,
): Promise<readonly PdfPart[]> {
  const result = await runner("qpdf", [`--split-pages=${PDF_BATCH_PAGES}`, inputPath, join(workspace, "part.pdf")], {
    cwd: paths.workRoot,
    timeoutMs: QPDF_TIMEOUT_MS,
  });
  assertSuccessful("qpdf PDF split", result, QPDF_TIMEOUT_MS);
  const entries = await fs.readdir(workspace, { withFileTypes: true });
  const parts = await Promise.all(
    entries.map(async (entry) => {
      const match = /^part-(\d+)(?:-(\d+))?\.pdf$/u.exec(entry.name);
      if (!entry.isFile() || !match) throw new Error(`qpdf produced an unexpected split artifact: ${entry.name}`);
      const path = join(workspace, entry.name);
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`qpdf split is not a regular file: ${entry.name}`);
      const startPage = Number(match[1]);
      const endPage = Number(match[2] ?? match[1]);
      if (!Number.isSafeInteger(startPage) || !Number.isSafeInteger(endPage))
        throw new Error("qpdf split page range exceeds the supported range");
      return { path, startPage, endPage };
    }),
  );
  if (parts.length === 0) throw new Error("qpdf produced no PDF batches");
  parts.sort((left, right) => left.startPage - right.startPage);
  let nextPage = 1;
  for (const part of parts) {
    const pages = part.endPage - part.startPage + 1;
    if (
      part.startPage !== nextPage ||
      part.endPage < part.startPage ||
      part.endPage > pageCount ||
      pages > PDF_BATCH_PAGES ||
      (part.endPage < pageCount && pages !== PDF_BATCH_PAGES)
    )
      throw new Error("qpdf split page ranges are incomplete or invalid");
    nextPage = part.endPage + 1;
  }
  if (nextPage !== pageCount + 1) throw new Error("qpdf split page ranges do not cover the PDF");
  return Promise.all(
    parts.map(async (part): Promise<PdfPart> => {
      const stem = `pages-${part.startPage}-${part.endPage}-${basename(workspace)}`;
      const path = join(workspace, `${stem}.pdf`);
      await fs.rename(part.path, path);
      return { ...part, path, stem };
    }),
  );
}

async function outputFiles(root: string, relativeRoot = ""): Promise<readonly OutputFile[]> {
  const directory = relativeRoot ? safeRelativePath(root, relativeRoot) : root;
  const directoryStat = await fs.lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
    throw new Error(`Docling output is not a real directory: ${relativeRoot || "."}`);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const output: OutputFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = join(relativeRoot, entry.name);
    const absolutePath = safeRelativePath(root, relativePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`Docling output contains a symlink: ${relativePath}`);
    if (stat.isDirectory()) output.push(...(await outputFiles(root, relativePath)));
    else if (stat.isFile()) output.push({ path: relativePath, absolutePath });
    else throw new Error(`Docling output is not a regular file: ${relativePath}`);
  }
  return output;
}

async function writeFully(output: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await output.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error("combined Docling extraction write made no progress");
    offset += bytesWritten;
  }
}

async function appendMarkdownPart(
  markdownFile: OutputFile,
  output: FileHandle,
  replacements: readonly { readonly source: string; readonly target: string }[],
): Promise<boolean> {
  const input = await fs.open(markdownFile.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const encoded = replacements
    .map(({ source, target }) => ({
      source: Buffer.from(`${source.replaceAll("\\", "/")}/`),
      target: Buffer.from(`${target.replaceAll("\\", "/")}/`),
    }))
    .sort((left, right) => right.source.length - left.source.length);
  const overlap = Math.max(...encoded.map(({ source }) => source.length)) - 1;
  let pending = Buffer.alloc(0);
  let hasContent = false;
  const writeReplaced = async (bytes: Buffer, matchStartLimit: number): Promise<number> => {
    let cursor = 0;
    for (;;) {
      let match: { readonly index: number; readonly source: Buffer; readonly target: Buffer } | undefined;
      for (const replacement of encoded) {
        const index = bytes.indexOf(replacement.source, cursor);
        if (
          index >= 0 &&
          index < matchStartLimit &&
          (!match || index < match.index || (index === match.index && replacement.source.length > match.source.length))
        )
          match = { index, ...replacement };
      }
      if (!match) break;
      await writeFully(output, bytes.subarray(cursor, match.index));
      await writeFully(output, match.target);
      cursor = match.index + match.source.length;
    }
    const pendingStart = Math.max(cursor, matchStartLimit);
    await writeFully(output, bytes.subarray(cursor, pendingStart));
    return pendingStart;
  };
  try {
    if (!(await input.stat()).isFile())
      throw new Error(`Docling extraction is not a regular file: ${markdownFile.absolutePath}`);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      for (const byte of chunk)
        if (byte !== 9 && byte !== 10 && byte !== 11 && byte !== 12 && byte !== 13 && byte !== 32) {
          hasContent = true;
          break;
        }
      const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const pendingStart = await writeReplaced(bytes, Math.max(0, bytes.length - overlap));
      pending = Buffer.from(bytes.subarray(pendingStart));
    }
    await writeReplaced(pending, pending.length);
    return hasContent;
  } finally {
    await input.close();
  }
}

async function combineParts(
  converted: readonly ConvertedPart[],
  stagingDirectory: string,
  finalOutputDirectory: string,
): Promise<void> {
  await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
  const combined = await fs.open(join(stagingDirectory, "combined.md"), "wx", 0o600);
  try {
    for (const [index, part] of converted.entries()) {
      const files = await outputFiles(part.outputDirectory);
      const markdownFile = files.find((file) =>
        [".md", ".markdown", ".txt"].includes(extname(file.path).toLowerCase()),
      );
      if (!markdownFile)
        throw new Error(`Docling pages ${part.startPage}-${part.endPage} produced no Markdown or text output`);
      const attachments = files.filter((file) => file !== markdownFile);
      const range = `${part.startPage}-${part.endPage}`;
      const namespace = `pages-${range}`;
      const sourceNamespace = `${part.stem}_artifacts`;
      const sourcePrefix = `${sourceNamespace}/`;
      const attachmentPaths = attachments.map((file) => {
        const path = file.path.replaceAll("\\", "/");
        if (!path.startsWith(sourcePrefix))
          throw new Error(`Docling pages ${range} produced an attachment outside its range namespace: ${file.path}`);
        return { file, path: path.slice(sourcePrefix.length) };
      });
      if (index > 0) await writeFully(combined, Buffer.from("\n\n"));
      const targetDirectory = join(finalOutputDirectory, namespace);
      const partHasContent = await appendMarkdownPart(markdownFile, combined, [
        { source: join(part.outputDirectory, sourceNamespace), target: targetDirectory },
        { source: sourceNamespace, target: targetDirectory },
      ]);
      if (!partHasContent) throw new Error(`Docling pages ${range} produced an empty text output`);
      for (const { file, path } of attachmentPaths) {
        const target = join(stagingDirectory, namespace, path);
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
        if (existsSync(target)) throw new Error(`Docling pages ${range} produced a duplicate attachment: ${path}`);
        await fs.rename(file.absolutePath, target);
      }
    }
  } finally {
    await combined.close();
  }
}

async function directConversion(
  paths: VaultPaths,
  inputPath: string,
  outputDirectory: string,
  timeoutMs: number,
  runner: DoclingAsyncRunner,
  label = "Docling conversion",
): Promise<ChildResult> {
  const result = await runner("docling", conversionArgs(inputPath, outputDirectory), {
    cwd: paths.workRoot,
    timeoutMs,
    env: doclingEnvironment(paths),
  });
  assertSuccessful(label, result, timeoutMs);
  return result;
}

export async function convertWithDocling(
  paths: VaultPaths,
  request: DoclingRequest,
  runtime: DoclingRuntime = {},
): Promise<DoclingResult> {
  const command = doclingArgs(paths, request);
  const identity = (runtime.dependencyIdentity ?? doclingDependencyIdentity)(paths);
  const runner = runtime.run ?? runChild;
  const timeoutMs = request.timeoutMs ?? DOCLING_TIMEOUT_MS;
  if (!isPdf(command.inputPath, request.mediaType)) {
    const result = await directConversion(paths, command.inputPath, command.outputDirectory, timeoutMs, runner);
    return {
      command: result,
      outputDirectory: command.outputDirectory,
      converter: { name: "docling", version: identity.version },
    };
  }
  const pageCount = await pdfPageCount(paths, command.inputPath, runner);
  if (pageCount <= PDF_BATCH_PAGES) {
    const result = await directConversion(paths, command.inputPath, command.outputDirectory, timeoutMs, runner);
    return {
      command: result,
      outputDirectory: command.outputDirectory,
      converter: { name: "docling", version: identity.version },
    };
  }
  if (existsSync(command.outputDirectory)) throw new Error("Batched Docling output directory already exists");
  const workspace = await fs.mkdtemp(join(dirname(command.outputDirectory), "docling-batches-"));
  let lastResult: ChildResult | undefined;
  try {
    const parts = await splitPdf(paths, command.inputPath, pageCount, workspace, runner);
    const converted: ConvertedPart[] = [];
    for (const [index, part] of parts.entries()) {
      const outputDirectory = join(workspace, `output-${String(index + 1).padStart(4, "0")}`);
      lastResult = await directConversion(
        paths,
        part.path,
        outputDirectory,
        timeoutMs,
        runner,
        `Docling conversion for pages ${part.startPage}-${part.endPage}`,
      );
      converted.push({ ...part, outputDirectory });
    }
    const stagingDirectory = join(workspace, "combined");
    await combineParts(converted, stagingDirectory, command.outputDirectory);
    await fs.rename(stagingDirectory, command.outputDirectory);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
  if (!lastResult) throw new Error("qpdf produced no PDF batches");
  return {
    command: lastResult,
    outputDirectory: command.outputDirectory,
    converter: { name: "docling", version: identity.version },
  };
}

export function doclingDependencyIdentity(
  paths: VaultPaths,
  runner: DoclingSyncRunner = (target, args, timeoutMs = DEPENDENCY_TIMEOUT_MS) =>
    runChildSync("docling", args, { cwd: target.workRoot, timeoutMs, env: doclingEnvironment(target) }),
): { readonly executable: string; readonly version: string } {
  const result = runner(paths, ["--version"], DEPENDENCY_TIMEOUT_MS);
  assertSuccessful("docling --version", result, DEPENDENCY_TIMEOUT_MS);
  const version = [...result.stdout.split(/\r?\n/u), ...result.stderr.split(/\r?\n/u)]
    .map((line) => line.trim())
    .find((line) => DOCLING_VERSION_PATTERN.test(line));
  if (!version) throw new Error("docling --version returned an empty or malformed version");
  return { executable: result.executable, version };
}

export function qpdfDependencyIdentity(
  paths: VaultPaths,
  runner: DoclingSyncRunner = (target, args, timeoutMs = DEPENDENCY_TIMEOUT_MS) =>
    runChildSync("qpdf", args, { cwd: target.workRoot, timeoutMs }),
): { readonly executable: string; readonly version: string } {
  const result = runner(paths, ["--version"], DEPENDENCY_TIMEOUT_MS);
  assertSuccessful("qpdf --version", result, DEPENDENCY_TIMEOUT_MS);
  const version = [...result.stdout.split(/\r?\n/u), ...result.stderr.split(/\r?\n/u)]
    .map((line) => line.trim())
    .find((line) => QPDF_VERSION_PATTERN.test(line));
  if (!version) throw new Error("qpdf --version returned an empty or malformed version");
  return { executable: result.executable, version };
}
