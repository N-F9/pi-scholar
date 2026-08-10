import { lstatSync, type Stats } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { VaultPaths } from "../vault.js";
import { type ChildResult, type ChildRunOptions, runChild, runChildSync } from "./process.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_REVISION_TIMEOUT_MS = 5_000;
const GIT_REVISION_OUTPUT_BYTES = 1024;
const SUBJECT_PATTERN = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const ARG_PATTERN = /^[A-Za-z0-9._/@:+-]+$/u;
const SAFE_GIT_ASSIGNMENTS: readonly string[] = ["--porcelain=v2"];
const SAFE_GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;
const SAFE_GIT_COMMIT_CONFIG = [
  ...SAFE_GIT_CONFIG,
  "-c",
  "user.name=Pi Scholar",
  "-c",
  "user.email=pi-scholar@localhost",
] as const;

export interface GitStatus {
  readonly branch?: string;
  readonly upstream?: string;
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

function gitOptions(cwd: string, timeoutMs = GIT_TIMEOUT_MS): ChildRunOptions {
  return {
    cwd,
    timeoutMs,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
  };
}

function assertGitDirectory(paths: VaultPaths, allowMissing = false): void {
  const gitPath = `${paths.vaultRoot}/.git`;
  let stat: Stats;
  try {
    stat = lstatSync(gitPath);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("vault Git repository is missing");
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(".git must not be a symbolic link");
  if (stat.isDirectory()) return;
  if (stat.isFile()) {
    const result = runChildSync("git", ["-C", paths.vaultRoot, ...SAFE_GIT_CONFIG, "rev-parse", "--git-dir"], {
      ...gitOptions(paths.vaultRoot, GIT_REVISION_TIMEOUT_MS),
      maxOutputBytes: GIT_REVISION_OUTPUT_BYTES,
    });
    if (result.code !== 0 || result.timedOut || result.signal || !result.stdout.trim())
      throw new Error("vault Git linked-worktree metadata is invalid");
    return;
  }
  throw new Error(".git must be a real directory or linked-worktree file");
}

function commandFailure(result: ChildResult, command: string): Error {
  return new Error(
    `${command} failed (${result.code ?? result.signal ?? "unknown"}): ${(result.stderr || result.stdout).trim()}`,
  );
}

export async function gitRevision(root: string): Promise<string> {
  const args = ["rev-parse", "HEAD"] as const;
  validateGitCommand(args);
  const result = await runChild("git", ["-C", root, ...SAFE_GIT_CONFIG, ...args], {
    ...gitOptions(root, GIT_REVISION_TIMEOUT_MS),
    maxOutputBytes: GIT_REVISION_OUTPUT_BYTES,
  });
  if (result.code !== 0) throw commandFailure(result, "git rev-parse");
  return result.stdout.trim();
}

export function initializeRepository(paths: VaultPaths): void {
  assertGitDirectory(paths, true);
  const result = runChildSync("git", [...SAFE_GIT_CONFIG, "init", "--quiet"], gitOptions(paths.vaultRoot));
  if (result.code !== 0) throw commandFailure(result, "git init");
  assertGitDirectory(paths);
}

function validateGitCommand(args: readonly string[]): void {
  const command = args[0];
  if (
    !command ||
    !["init", "status", "add", "diff", "commit", "push", "fetch", "rev-parse", "show", "ls-files"].includes(command)
  )
    throw new Error("unsupported Git operation");
  if (args.some((arg) => /[\u0000\u000a\u000d]/u.test(arg))) throw new Error("Git argv contains a control character");
  if (
    args.some((arg) => /^(?:--force(?:-with-lease)?(?:=|$)|-f(?:=|$))/u.test(arg)) ||
    ["reset", "merge", "rebase", "checkout", "clean"].includes(command)
  )
    throw new Error("unsafe Git operation");
  if (args.some((arg) => arg.startsWith("--") && arg.includes("=") && !SAFE_GIT_ASSIGNMENTS.includes(arg)))
    throw new Error("Git options must use separate argv values");
}

export async function runGit(
  paths: VaultPaths,
  args: readonly string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<ChildResult> {
  assertGitDirectory(paths);
  validateGitCommand(args);
  return runChild("git", [...SAFE_GIT_CONFIG, ...args], gitOptions(paths.vaultRoot, timeoutMs));
}
export function runGitSync(paths: VaultPaths, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): ChildResult {
  assertGitDirectory(paths);
  validateGitCommand(args);
  const config = args[0] === "commit" ? SAFE_GIT_COMMIT_CONFIG : SAFE_GIT_CONFIG;
  return runChildSync("git", [...config, ...args], gitOptions(paths.vaultRoot, timeoutMs));
}

export function parseGitStatus(raw: string): GitStatus {
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
    if (line.startsWith("# branch.upstream ")) upstream = line.slice("# branch.upstream ".length).trim();
    if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+([0-9]+) -([0-9]+)$/u.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    }
  }
  const entries = raw.split(/\r?\n/u).filter((line) => line.length > 0 && !line.startsWith("#"));
  return { branch, upstream, ahead, behind, clean: entries.length === 0, diverged: ahead > 0 && behind > 0, raw };
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

export function localCheckpointCommit(
  paths: VaultPaths,
  subject: string,
  excludedPaths: readonly string[] = [],
): GitCheckpointResult {
  validateSubject(subject);
  assertGitDirectory(paths);
  const exclusions = excludedPaths.map((path) => {
    const pathspec = relative(paths.vaultRoot, resolve(path)).split(sep).join("/");
    if (!pathspec || pathspec === ".." || pathspec.startsWith("../") || pathspec.startsWith("/"))
      throw new Error("Git exclusion path escapes vault");
    return pathspec;
  });
  if (exclusions.length) {
    const stagedExcluded = runGitSync(paths, ["diff", "--cached", "--quiet", "--", ...exclusions]);
    if (stagedExcluded.code === 1) throw new Error("Git checkpoint has pre-staged excluded changes");
    if (stagedExcluded.code !== 0) throw commandFailure(stagedExcluded, "git diff");
  }
  const pathspecs = [".", ...exclusions.map((path) => `:(exclude,literal)${path}`)];
  let result = runGitSync(paths, ["add", "--all", "--", ...pathspecs]);
  if (result.code !== 0) throw commandFailure(result, "git add");
  result = runGitSync(paths, ["diff", "--cached", "--quiet", "--", ...pathspecs]);
  if (result.code === 0) return { committed: false, subject };
  if (result.code !== 1) throw commandFailure(result, "git diff");
  result = runGitSync(paths, ["commit", "--no-gpg-sign", "--only", "-m", subject, "--", ...pathspecs]);
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
  if (status.diverged)
    return { ok: false, status, output: "Git history is diverged; no push attempted", error: "DIVERGED" };
  if (status.ahead === 0 && /^# branch\.upstream /mu.test(status.raw))
    return { ok: true, status, output: "No local commits to push" };
  const args = ["push", "--porcelain", remote];
  if (branch !== undefined) args.push(branch);
  const result = runGitSync(paths, args);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.code !== 0) {
    const noUpstream =
      /no configured push destination|has no upstream branch|src refspec .* does not match any|set the remote as upstream/iu.test(
        output,
      );
    let reconciled = false;
    try {
      const fetch = runGitSync(paths, ["fetch", "--prune", remote]);
      if (fetch.code === 0) {
        const local = runGitSync(paths, ["rev-parse", "HEAD"]);
        const upstreamRef = branch ? `refs/remotes/${remote}/${branch}` : "@{upstream}";
        const upstream = runGitSync(paths, ["rev-parse", upstreamRef]);
        const localId = local.code === 0 ? local.stdout.trim() : "";
        const upstreamId = upstream.code === 0 ? upstream.stdout.trim() : "";
        reconciled = /^[0-9a-f]{40,64}$/iu.test(localId) && localId === upstreamId;
      }
    } catch {
      // Preserve the original push failure when reconciliation cannot run.
    }
    const reconciledStatus = gitStatus(paths);
    if (reconciled)
      return { ok: true, status: reconciledStatus, output: `${output}\nPush status reconciled after remote update` };
    return {
      ok: false,
      status: reconciledStatus,
      output,
      error: noUpstream ? "NO_UPSTREAM" : result.timedOut ? "TIMEOUT" : "PUSH_FAILED",
    };
  }
  return { ok: true, status: gitStatus(paths), output };
}

export function gitDependencyIdentity(paths: VaultPaths): {
  readonly executable: string;
  readonly version: string;
  readonly workTree: boolean;
} {
  const version = runChildSync("git", ["--version"], gitOptions(paths.vaultRoot, 10_000));
  const versionText = version.stdout.trim();
  if (version.code !== 0 || version.timedOut || version.signal !== null || !versionText)
    throw commandFailure(version, "git --version");
  validateGitCommand(["rev-parse", "--is-inside-work-tree"]);
  const workTree = runChildSync(
    "git",
    [...SAFE_GIT_CONFIG, "rev-parse", "--is-inside-work-tree"],
    gitOptions(paths.vaultRoot, GIT_REVISION_TIMEOUT_MS),
  );
  if (workTree.code !== 0 || workTree.timedOut || workTree.signal !== null || workTree.stdout.trim() !== "true")
    throw commandFailure(workTree, "git rev-parse --is-inside-work-tree");
  return { executable: version.executable, version: versionText, workTree: true };
}
