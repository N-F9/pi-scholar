import { existsSync, lstatSync } from "node:fs";
import { relative, resolve } from "node:path";
import { runChild, runChildSync, type ChildResult } from "./process.js";
import type { VaultPaths } from "../vault.js";

const QMD_TIMEOUT_MS = 120_000;
const VAULT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

export function qmdCollectionName(vaultId: string): string {
  if (!VAULT_ID_PATTERN.test(vaultId)) throw new Error("qmd collection identity requires a host-minted vault ID");
  return `pi-scholar-${vaultId}`;
}

export function qmdCollection(paths: VaultPaths): QmdCollection {
  return { name: qmdCollectionName(paths.vaultId), root: paths.wikiRoot, include: "**/*.md" };
}

function assertQmdScope(paths: VaultPaths, root: string): void {
  const wiki = resolve(paths.wikiRoot);
  const candidate = resolve(root);
  if (candidate !== wiki || relative(wiki, candidate) !== "") throw new Error("qmd scope must be exactly vault/wiki");
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("qmd scope must be a real wiki directory");
  if (resolve(paths.sourcesRoot) === candidate || resolve(paths.quizzesRoot) === candidate) throw new Error("qmd cannot index sources or quizzes");
}

function qmdArgs(paths: VaultPaths, args: readonly string[]): string[] {
  const collection = qmdCollection(paths);
  assertQmdScope(paths, collection.root);
  const command = args[0];
  if (!command || !["collection", "index", "query", "search", "status"].includes(command)) throw new Error("unsupported qmd operation");
  if (command === "collection" && args[1] !== "add") throw new Error("qmd collection mutation is limited to add");
  if (args.some((arg) => /[\u0000]/u.test(arg))) throw new Error("qmd argv contains NUL");
  return ["--collection", collection.name, ...args];
}

export async function runQmd(paths: VaultPaths, args: readonly string[], timeoutMs = QMD_TIMEOUT_MS): Promise<ChildResult> {
  return runChild("qmd", qmdArgs(paths, args), { cwd: paths.qmdRoot, timeoutMs, env: { QMD_HOME: paths.qmdRoot } });
}

export function runQmdSync(paths: VaultPaths, args: readonly string[], timeoutMs = QMD_TIMEOUT_MS): ChildResult {
  return runChildSync("qmd", qmdArgs(paths, args), { cwd: paths.qmdRoot, timeoutMs, env: { QMD_HOME: paths.qmdRoot } });
}

export function ensureQmdCollection(paths: VaultPaths): ChildResult {
  const collection = qmdCollection(paths);
  return runQmdSync(paths, ["collection", "add", collection.root, "--name", collection.name, "--mask", collection.include]);
}

export function qmdSearch(paths: VaultPaths, query: string, limit = 20): Promise<ChildResult> {
  if (!query || /[\u0000\u000a\u000d]/u.test(query)) throw new Error("qmd query must be nonempty and single-line");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("qmd result limit must be between 1 and 100");
  return runQmd(paths, ["query", query, "--limit", String(limit)]);
}

export function qmdDependencyIdentity(paths: VaultPaths): { readonly executable: string; readonly version: string } {
  const result = runChildSync("qmd", ["--version"], { cwd: paths.qmdRoot, timeoutMs: 10_000, env: { QMD_HOME: paths.qmdRoot } });
  return { executable: "qmd", version: result.stdout.trim() || result.stderr.trim() };
}

export function qmdScopeCheck(paths: VaultPaths): { readonly ok: boolean; readonly collection: QmdCollection; readonly message: string } {
  const collection = qmdCollection(paths);
  try {
    assertQmdScope(paths, collection.root);
    return { ok: true, collection, message: "qmd scope is wiki-only" };
  } catch (error) {
    return { ok: false, collection, message: (error as Error).message };
  }
}
