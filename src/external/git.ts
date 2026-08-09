import { existsSync, lstatSync } from "node:fs";
import { runChild, runChildSync, type ChildResult, type ChildRunOptions } from "./process.js";
import type { VaultPaths } from "../vault.js";

const GIT_TIMEOUT_MS = 120_000;
const SUBJECT_PATTERN = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const ARG_PATTERN = /^[A-Za-z0-9._/@:+-]+$/u;

export interface GitStatus {
  readonly branch?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly clean: boolean;
  readonly diverged: boolean;
  readonly raw: string;
}

export interface GitPushResult {
  readonly ok: boolean;
  readonly status: GitStatus;
  readonly output: string;
  readonly error?: string;
}

export interface GitCheckpointResult {
  readonly committed: boolean;
  readonly commitId?: string;
  readonly subject: string;
}

function validateGitArg(value: string, label: string): void {
  if (!value || value.startsWith("-") || !ARG_PATTERN.test(value)) throw new Error(`invalid Git ${label}`);
}

function gitOptions(paths: VaultPaths, timeoutMs = GIT_TIMEOUT_MS): ChildRunOptions {
  return { cwd: paths.vaultRoot, timeoutMs, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } };
}

function assertGitDirectory(paths: VaultPaths): void {
  if (existsSync(`${paths.vaultRoot}/.git`)) {
    const stat = lstatSync(`${paths.vaultRoot}/.git`);
    if (stat.isSymbolicLink()) throw new Error(".git must not be a symlink");
  }
}

function commandFailure(result: ChildResult, command: string): Error {
  return new Error(`${command} failed (${result.code ?? result.signal ?? "unknown"}): ${(result.stderr || result.stdout).trim()}`);
}

export function initializeRepository(paths: VaultPaths): void {
  assertGitDirectory(paths);
  const result = runChildSync("git", ["init", "--quiet"], gitOptions(paths));
  if (result.code !== 0) throw commandFailure(result, "git init");
}

function validateGitCommand(args: readonly string[]): void {
  const command = args[0];
  if (!command || !["init", "status", "add", "diff", "commit", "push", "fetch", "rev-parse", "show", "ls-files"].includes(command)) throw new Error("unsupported Git operation");
  if (args.some((arg) => /[\u0000\u000a\u000d]/u.test(arg))) throw new Error("Git argv contains a control character");
  if (args.some((arg) => arg === "--force" || arg === "--force-with-lease" || arg === "-f") || ["reset", "merge", "rebase", "checkout", "clean"].includes(command)) throw new Error("unsafe Git operation");
}

export async function runGit(paths: VaultPaths, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<ChildResult> {
  validateGitCommand(args);
  for (const arg of args) if (arg.startsWith("--") && arg.includes("=")) throw new Error("Git options must use separate argv values");
  return runChild("git", args, gitOptions(paths, timeoutMs));
}

export function runGitSync(paths: VaultPaths, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): ChildResult {
  validateGitCommand(args);
  return runChildSync("git", args, gitOptions(paths, timeoutMs));
}

export function parseGitStatus(raw: string): GitStatus {
  let branch: string | undefined;
  let ahead = 0;
  let behind = 0;
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
    if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+([0-9]+) -([0-9]+)$/u.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    }
  }
  const entries = raw.split(/\r?\n/u).filter((line) => line.length > 0 && !line.startsWith("#"));
  return { branch, ahead, behind, clean: entries.length === 0, diverged: ahead > 0 && behind > 0, raw };
}

export function gitStatus(paths: VaultPaths): GitStatus {
  assertGitDirectory(paths);
  const result = runGitSync(paths, ["status", "--porcelain=v2", "--branch", "--ahead-behind"]);
  if (result.code !== 0) throw commandFailure(result, "git status");
  return parseGitStatus(result.stdout);
}

function validateSubject(subject: string): void {
  if (!SUBJECT_PATTERN.test(subject) || subject.trim() !== subject) throw new Error("invalid Git commit subject");
}

export function localCheckpointCommit(paths: VaultPaths, subject: string): GitCheckpointResult {
  validateSubject(subject);
  assertGitDirectory(paths);
  let result = runGitSync(paths, ["add", "--all", "--", "."]);
  if (result.code !== 0) throw commandFailure(result, "git add");
  result = runGitSync(paths, ["diff", "--cached", "--quiet"]);
  if (result.code === 0) return { committed: false, subject };
  if (result.code !== 1) throw commandFailure(result, "git diff");
  result = runGitSync(paths, ["commit", "--no-gpg-sign", "-m", subject]);
  if (result.code !== 0) throw commandFailure(result, "git commit");
  const commitIdResult = runGitSync(paths, ["rev-parse", "HEAD"]);
  if (commitIdResult.code !== 0) throw commandFailure(commitIdResult, "git rev-parse");
  return { committed: true, commitId: commitIdResult.stdout.trim(), subject };
}

function validateRemote(remote: string): void {
  validateGitArg(remote, "remote");
}

export function safePush(paths: VaultPaths, remote = "origin", branch?: string): GitPushResult {
  validateRemote(remote);
  if (branch !== undefined) validateGitArg(branch, "branch");
  const status = gitStatus(paths);
  if (status.diverged) return { ok: false, status, output: "Git history is diverged; no push attempted", error: "DIVERGED" };
  if (status.ahead === 0 && /^# branch\.upstream /mu.test(status.raw)) return { ok: true, status, output: "No local commits to push" };
  const args = ["push", "--porcelain", remote];
  if (branch !== undefined) args.push(branch);
  const result = runGitSync(paths, args);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.code !== 0) {
    const noUpstream = /no configured push destination|has no upstream branch|src refspec .* does not match any|set the remote as upstream/iu.test(output);
    return { ok: false, status: gitStatus(paths), output, error: noUpstream ? "NO_UPSTREAM" : result.timedOut ? "TIMEOUT" : "PUSH_FAILED" };
  }
  return { ok: true, status: gitStatus(paths), output };
}

export function gitDependencyIdentity(paths: VaultPaths): { readonly executable: string; readonly version: string; readonly workTree: boolean } {
  const version = runChildSync("git", ["--version"], gitOptions(paths, 10_000));
  const workTree = runGitSync(paths, ["rev-parse", "--is-inside-work-tree"]);
  return {
    executable: "git",
    version: version.stdout.trim(),
    workTree: workTree.code === 0 && workTree.stdout.trim() === "true",
  };
}
