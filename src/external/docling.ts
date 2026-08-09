import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runChild, runChildSync, type ChildResult } from "./process.js";
import { readFileNoFollow, safeRelativePath, type VaultPaths } from "../vault.js";
const DOCLING_TIMEOUT_MS = 300_000;

export interface DoclingRequest {
  readonly inputRelativePath: string;
  readonly outputRelativeDirectory: string;
  readonly timeoutMs?: number;
}

export interface DoclingResult {
  readonly command: ChildResult;
  readonly outputDirectory: string;
  readonly extracted: Buffer;
}

function validateDocumentPath(paths: VaultPaths, relativePath: string): string {
  const path = safeRelativePath(paths.workRoot, relativePath);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Docling input must be a regular file");
  if (stat.size > 100 * 1024 * 1024) throw new Error("Docling input exceeds the 100 MiB source limit");
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
function assertSuccessful(command: ChildResult): void {
  if (command.timedOut) throw new Error("Docling conversion timed out");
  if (command.code !== 0) throw new Error(`Docling conversion failed with exit code ${command.code ?? "unknown"}: ${command.stderr.trim()}`);
}

function findMarkdown(directory: string): string {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Docling output contains a symlink: ${target}`);
    if (entry.isDirectory()) {
      try {
        return findMarkdown(target);
      } catch (error) {
        if (error instanceof Error && error.message === "Docling output contains no Markdown") continue;
        throw error;
      }
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) return target;
  }
  throw new Error("Docling output contains no Markdown");
}

function readExtracted(outputDirectory: string): Buffer {
  const stat = lstatSync(outputDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Docling output directory is not a real directory");
  return readFileNoFollow(findMarkdown(outputDirectory));
}

export function doclingArgs(paths: VaultPaths, request: DoclingRequest): { readonly inputPath: string; readonly outputDirectory: string; readonly args: readonly string[] } {
  const inputPath = validateDocumentPath(paths, request.inputRelativePath);
  const outputDirectory = validateOutputDirectory(paths, request.outputRelativeDirectory);
  return {
    inputPath,
    outputDirectory,
    args: ["--output", outputDirectory, inputPath],
  };
}

export async function convertWithDocling(paths: VaultPaths, request: DoclingRequest): Promise<DoclingResult> {
  const command = doclingArgs(paths, request);
  const result = await runChild("docling", command.args, {
    cwd: paths.workRoot,
    timeoutMs: request.timeoutMs ?? DOCLING_TIMEOUT_MS,
    env: { DOCLING_CACHE_DIR: paths.workRoot },
  });
  assertSuccessful(result);
  return { command: result, outputDirectory: command.outputDirectory, extracted: readExtracted(command.outputDirectory) };
}

export function convertWithDoclingSync(paths: VaultPaths, request: DoclingRequest): DoclingResult {
  const command = doclingArgs(paths, request);
  const result = runChildSync("docling", command.args, {
    cwd: paths.workRoot,
    timeoutMs: request.timeoutMs ?? DOCLING_TIMEOUT_MS,
    env: { DOCLING_CACHE_DIR: paths.workRoot },
  });
  assertSuccessful(result);
  return { command: result, outputDirectory: command.outputDirectory, extracted: readExtracted(command.outputDirectory) };
}

export function doclingDependencyIdentity(paths: VaultPaths): { readonly executable: string; readonly version: string } {
  const result = runChildSync("docling", ["--version"], { cwd: paths.workRoot, timeoutMs: 10_000, env: { DOCLING_CACHE_DIR: paths.workRoot } });
  return { executable: "docling", version: result.stdout.trim() || result.stderr.trim() };
}
