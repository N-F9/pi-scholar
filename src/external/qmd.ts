import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertNoSymlinkPath, readFileNoFollow, VAULT_ID_PATTERN, type VaultPaths } from "../vault.js";
import { type ChildResult, runChild, runChildSync } from "./process.js";

const QMD_TIMEOUT_MS = 120_000;
const QMD_SCOPE_TIMEOUT_MS = 10_000;
// 100 JSON search results must fit without truncation; API diagnostics are sliced separately.
const QMD_OUTPUT_BYTES = 1024 * 1024;
const VERSION_PATTERN = /^(?:qmd(?:\s+version)?\s*:?\s+)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/iu;

export interface QmdCollection {
  readonly name: string;
  readonly root: string;
  readonly include: "**/*.md";
}

export interface QmdSearchResult {
  readonly path: string;
  readonly score: number;
  readonly snippet: string;
}

export type QmdSyncRunner = (paths: VaultPaths, args: readonly string[], timeoutMs?: number) => ChildResult;
export interface QmdIndexOptions {
  readonly ignoredPaths?: readonly string[];
}

export type QmdAsyncRunner = (paths: VaultPaths, args: readonly string[], timeoutMs?: number) => Promise<ChildResult>;

export function qmdCollectionName(vaultId: string): string {
  if (!VAULT_ID_PATTERN.test(vaultId)) throw new Error("qmd collection identity requires a host-minted vault ID");
  return `pi-scholar-${vaultId}`;
}

export function qmdCollection(paths: VaultPaths): QmdCollection {
  return { name: qmdCollectionName(paths.vaultId), root: paths.wikiRoot, include: "**/*.md" };
}

export function qmdEnvironment(paths: VaultPaths): Readonly<Record<string, string>> {
  return {
    HOME: paths.qmdRoot,
    XDG_CACHE_HOME: join(paths.qmdRoot, "cache"),
    XDG_CONFIG_HOME: join(paths.qmdRoot, ".config"),
    QMD_HOME: paths.qmdRoot,
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function qmdConfigPath(paths: VaultPaths): string {
  return join(paths.qmdRoot, ".config", "qmd", "index.yml");
}

function loadQmdConfig(paths: VaultPaths): { readonly path: string; readonly config: Record<string, unknown> } {
  const path = qmdConfigPath(paths);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileNoFollow(path).toString("utf8"));
  } catch (error) {
    throw new Error(`qmd collection config is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.collections)) throw new Error("qmd collection config is malformed");
  return { path, config: parsed };
}

const QMD_GLOB_META = new Set(["\\", "*", "?", "(", ")", "[", "]", "{", "}", "!", "+", "@"]);

function exactQmdIgnorePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !value.endsWith(".md") ||
    isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.startsWith("/")
  )
    throw new Error("qmd ignore entries must be exact normalized wiki Markdown paths");
  return value;
}

function qmdIgnorePattern(path: string): string {
  return path.replace(/[*?()[\]{}!+@]/gu, (character) => `\\${character}`);
}

function decodeQmdIgnorePattern(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("qmd collection ignore list is malformed");
  let path = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      path += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined || !QMD_GLOB_META.has(escaped))
      throw new Error("qmd collection ignore list must contain exact escaped wiki paths");
    path += escaped;
  }
  return path;
}

function normalizedQmdIgnorePaths(paths: readonly string[] | undefined, configured = false): string[] {
  const unique = new Set<string>();
  for (const value of paths ?? []) {
    const path = exactQmdIgnorePath(configured ? decodeQmdIgnorePattern(value) : value);
    const pattern = qmdIgnorePattern(path);
    if (configured && value !== pattern)
      throw new Error("qmd collection ignore entries must use exact escaped wiki paths");
    unique.add(pattern);
  }
  return [...unique].sort();
}

function qmdCollectionConfig(
  paths: VaultPaths,
  collectionName: string,
): { readonly path: string; readonly config: Record<string, unknown>; readonly collection: Record<string, unknown> } {
  const loaded = loadQmdConfig(paths);
  const collectionValue = loaded.config.collections;
  if (!isRecord(collectionValue) || !isRecord(collectionValue[collectionName]))
    throw new Error(`qmd collection config is missing ${collectionName}`);
  return { ...loaded, collection: collectionValue[collectionName] };
}

function configuredQmdIgnorePaths(paths: VaultPaths, collectionName: string): string[] {
  const { collection } = qmdCollectionConfig(paths, collectionName);
  const configured = collection.ignore;
  if (configured === undefined) return [];
  if (!Array.isArray(configured)) throw new Error("qmd collection ignore list is malformed");
  return normalizedQmdIgnorePaths(configured, true);
}

function writeQmdIgnorePaths(paths: VaultPaths, collectionName: string, ignoredPaths: readonly string[]): void {
  const expected = normalizedQmdIgnorePaths(ignoredPaths);
  const loaded = qmdCollectionConfig(paths, collectionName);
  const collections = loaded.config.collections;
  if (!isRecord(collections)) throw new Error("qmd collection config is malformed");
  const current = collections[collectionName];
  if (!isRecord(current)) throw new Error(`qmd collection config is missing ${collectionName}`);
  const nextCollection = { ...current };
  if (expected.length) nextCollection.ignore = expected;
  else delete nextCollection.ignore;
  const nextConfig = { ...loaded.config, collections: { ...collections, [collectionName]: nextCollection } };
  const configDirectory = dirname(loaded.path);
  assertNoSymlinkPath(configDirectory);
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(configDirectory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, stringifyYaml(nextConfig), { flag: "wx", mode: 0o600 });
    renameSync(temporary, loaded.path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function assertQmdScope(paths: VaultPaths, candidateRoot: string): void {
  if (!isAbsolute(candidateRoot) || /[\u0000-\u001f\u007f]/u.test(candidateRoot))
    throw new Error("qmd scope path must be an absolute safe path");
  const wikiRoot = resolve(paths.wikiRoot);
  const wikiStat = lstatSync(wikiRoot);
  if (wikiStat.isSymbolicLink() || !wikiStat.isDirectory()) throw new Error("qmd scope must be a real wiki directory");
  const wikiRealRoot = realpathSync(wikiRoot);
  const candidatePath = resolve(candidateRoot);
  const candidateStat = lstatSync(candidatePath);
  if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory())
    throw new Error("qmd collection path must be a real directory");
  if (realpathSync(candidatePath) !== wikiRealRoot)
    throw new Error("qmd collection path must equal the vault wiki directory");
  for (const forbiddenRoot of [paths.sourcesRoot, paths.quizzesRoot]) {
    try {
      if (realpathSync(resolve(forbiddenRoot)) === wikiRealRoot) throw new Error("qmd cannot index sources or quizzes");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
function assertNoQmdOverride(args: readonly string[]): void {
  for (const arg of args) {
    if (/^(?:--(?:collection|index)(?:[-=]|$)|-(?:c|i)(?:=|$))/u.test(arg))
      throw new Error("qmd collection/index overrides are not allowed");
  }
}

function assertQueryShape(command: string, args: readonly string[]): void {
  const query = args[1];
  const limit = args[5];
  if (
    args.length !== 6 ||
    typeof query !== "string" ||
    !query ||
    /[\u0000\u000a\u000d]/u.test(query) ||
    args[2] !== "--format" ||
    args[3] !== "json" ||
    args[4] !== "-n" ||
    typeof limit !== "string" ||
    !/^(?:[1-9][0-9]?|100)$/u.test(limit)
  ) {
    throw new Error(`qmd ${command} arguments are not allowed`);
  }
}

export function qmdArgs(paths: VaultPaths, args: readonly string[]): string[] {
  const collection = qmdCollection(paths);
  assertQmdScope(paths, collection.root);
  assertNoQmdOverride(args);
  const command = args[0];
  if (command === "collection") {
    const add = ["collection", "add", collection.root, "--name", collection.name, "--mask", collection.include];
    const show = ["collection", "show", collection.name];
    if (!args.every((arg, index) => arg === add[index]) || args.length !== add.length) {
      if (!args.every((arg, index) => arg === show[index]) || args.length !== show.length)
        throw new Error("qmd collection operation is not allowed");
    }
  } else if (command === "update" || command === "status") {
    if (args.length !== 1) throw new Error(`qmd ${command} arguments are not allowed`);
  } else if (command === "query" || command === "search") {
    assertQueryShape(command, args);
  } else {
    throw new Error("unsupported qmd operation");
  }
  return ["--collection", collection.name, ...args];
}

export async function runQmd(
  paths: VaultPaths,
  args: readonly string[],
  timeoutMs = QMD_TIMEOUT_MS,
): Promise<ChildResult> {
  return runChild("qmd", qmdArgs(paths, args), {
    cwd: paths.qmdRoot,
    timeoutMs,
    maxOutputBytes: QMD_OUTPUT_BYTES,
    env: qmdEnvironment(paths),
  });
}

export async function qmdRefresh(paths: VaultPaths, options: QmdIndexOptions = {}): Promise<ChildResult> {
  const collection = qmdCollection(paths);
  assertQmdScope(paths, collection.root);
  writeQmdIgnorePaths(paths, collection.name, options.ignoredPaths ?? []);
  return runQmd(paths, ["update"]);
}

export function runQmdSync(paths: VaultPaths, args: readonly string[], timeoutMs = QMD_TIMEOUT_MS): ChildResult {
  return runChildSync("qmd", qmdArgs(paths, args), {
    cwd: paths.qmdRoot,
    timeoutMs,
    maxOutputBytes: QMD_OUTPUT_BYTES,
    env: qmdEnvironment(paths),
  });
}

export function ensureQmdCollection(paths: VaultPaths): ChildResult {
  const collection = qmdCollection(paths);
  return runQmdSync(paths, [
    "collection",
    "add",
    collection.root,
    "--name",
    collection.name,
    "--mask",
    collection.include,
  ]);
}

export function qmdSearch(
  paths: VaultPaths,
  query: string,
  limit = 20,
  runner: QmdAsyncRunner = runQmd,
): Promise<ChildResult> {
  if (!query || /[\u0000\u000a\u000d]/u.test(query)) throw new Error("qmd query must be nonempty and single-line");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("qmd result limit must be between 1 and 100");
  return runner(paths, ["query", query, "--format", "json", "-n", String(limit)]);
}

export function qmdDependencyIdentity(
  paths: VaultPaths,
  runner: QmdSyncRunner = (target, args, timeoutMs = 10_000) =>
    runChildSync("qmd", args, { cwd: target.qmdRoot, timeoutMs, env: qmdEnvironment(target) }),
): { readonly executable: string; readonly version: string } {
  const result = runner(paths, ["--version"], 10_000);
  if (result.timedOut || result.signal || result.code !== 0) {
    const detail = (
      result.stderr.trim() ||
      result.stdout.trim() ||
      result.signal ||
      String(result.code ?? "unknown")
    ).slice(0, 500);
    throw new Error(`qmd --version failed: ${detail}`);
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (!VERSION_PATTERN.test(version)) throw new Error("qmd --version returned an empty or malformed version");
  return { executable: result.executable, version };
}

interface QmdCollectionMetadata {
  readonly path: string;
  readonly pattern: string;
}

function parseCollectionMetadata(stdout: string): QmdCollectionMetadata | undefined {
  let path: string | undefined;
  let pattern: string | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!/^[ \t]*(?:Path|Pattern):/u.test(line)) continue;
    const match = /^[ \t]*(Path|Pattern):[ \t]+(\S(?:.*\S)?)$/u.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (!key || !value || value !== value.trim()) return undefined;
    if (key === "Path") {
      if (path !== undefined) return undefined;
      path = value;
    } else {
      if (pattern !== undefined) return undefined;
      pattern = value;
    }
  }
  return path === undefined || pattern === undefined ? undefined : { path, pattern };
}

export function qmdScopeCheck(
  paths: VaultPaths,
  runner: QmdSyncRunner = runQmdSync,
  expectedIgnoredPaths?: readonly string[],
): { readonly ok: boolean; readonly collection: QmdCollection; readonly message: string } {
  const collection = qmdCollection(paths);
  try {
    assertQmdScope(paths, collection.root);
    const result = runner(paths, ["collection", "show", collection.name], QMD_SCOPE_TIMEOUT_MS);
    if (result.timedOut || result.signal || result.code !== 0) {
      const detail = (
        result.stderr.trim() ||
        result.stdout.trim() ||
        result.signal ||
        String(result.code ?? "unknown")
      ).slice(0, 500);
      throw new Error(`qmd collection show failed: ${detail}`);
    }
    const metadata = parseCollectionMetadata(result.stdout);
    if (!metadata) throw new Error("qmd collection metadata is missing or malformed");
    assertQmdScope(paths, metadata.path);
    if (metadata.pattern !== collection.include)
      throw new Error(`qmd collection pattern must be exactly ${collection.include}`);
    if (expectedIgnoredPaths !== undefined) {
      const expected = normalizedQmdIgnorePaths(expectedIgnoredPaths);
      const configured = configuredQmdIgnorePaths(paths, collection.name);
      if (configured.length !== expected.length || configured.some((path, index) => path !== expected[index]))
        throw new Error("qmd collection ignore list does not exactly match catalogued drifted wiki paths");
    }
    return { ok: true, collection, message: "qmd collection is exactly the vault wiki with Markdown-only scope" };
  } catch (error) {
    return { ok: false, collection, message: error instanceof Error ? error.message : String(error) };
  }
}
