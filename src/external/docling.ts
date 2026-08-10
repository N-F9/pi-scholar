import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { safeRelativePath, type VaultPaths } from "../vault.js";
import { type ChildResult, runChild, runChildSync } from "./process.js";

const DOCLING_TIMEOUT_MS = 300_000;
const DOCLING_VERSION_PATTERN = /^(?:docling(?:\s+version)?\s*:?\s+)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/iu;

export interface DoclingRequest {
  readonly inputRelativePath: string;
  readonly outputRelativeDirectory: string;
  readonly timeoutMs?: number;
}

export interface DoclingResult {
  readonly command: ChildResult;
  readonly outputDirectory: string;
}

export type DoclingSyncRunner = (paths: VaultPaths, args: readonly string[], timeoutMs?: number) => ChildResult;

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
function assertSuccessful(command: ChildResult): void {
  if (command.timedOut) throw new Error("Docling conversion timed out");
  if (command.code !== 0)
    throw new Error(`Docling conversion failed with exit code ${command.code ?? "unknown"}: ${command.stderr.trim()}`);
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
    args: ["--output", outputDirectory, inputPath],
  };
}

export function doclingEnvironment(paths: VaultPaths): Readonly<Record<string, string>> {
  return { HOME: paths.workRoot, XDG_CACHE_HOME: join(paths.workRoot, "cache"), DOCLING_CACHE_DIR: paths.workRoot };
}

export async function convertWithDocling(paths: VaultPaths, request: DoclingRequest): Promise<DoclingResult> {
  const command = doclingArgs(paths, request);
  const result = await runChild("docling", command.args, {
    cwd: paths.workRoot,
    timeoutMs: request.timeoutMs ?? DOCLING_TIMEOUT_MS,
    env: doclingEnvironment(paths),
  });
  assertSuccessful(result);
  return {
    command: result,
    outputDirectory: command.outputDirectory,
  };
}

export function convertWithDoclingSync(paths: VaultPaths, request: DoclingRequest): DoclingResult {
  const command = doclingArgs(paths, request);
  const result = runChildSync("docling", command.args, {
    cwd: paths.workRoot,
    timeoutMs: request.timeoutMs ?? DOCLING_TIMEOUT_MS,
    env: doclingEnvironment(paths),
  });
  assertSuccessful(result);
  return {
    command: result,
    outputDirectory: command.outputDirectory,
  };
}

export function doclingDependencyIdentity(
  paths: VaultPaths,
  runner: DoclingSyncRunner = (target, args, timeoutMs = 10_000) =>
    runChildSync("docling", args, { cwd: target.workRoot, timeoutMs, env: doclingEnvironment(target) }),
): { readonly executable: string; readonly version: string } {
  const result = runner(paths, ["--version"], 10_000);
  if (result.timedOut || result.signal || result.code !== 0) {
    const detail = (
      result.stderr.trim() ||
      result.stdout.trim() ||
      result.signal ||
      String(result.code ?? "unknown")
    ).slice(0, 500);
    throw new Error(`docling --version failed: ${detail}`);
  }
  const version = [...result.stdout.split(/\r?\n/u), ...result.stderr.split(/\r?\n/u)]
    .map((line) => line.trim())
    .find((line) => DOCLING_VERSION_PATTERN.test(line));
  if (!version) throw new Error("docling --version returned an empty or malformed version");
  return { executable: result.executable, version };
}
