import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, posix, relative, resolve, sep, win32 } from "node:path";
import { openDatabase, transaction } from "./database.js";
import { initializeRepository } from "./external/git.js";
import { renderOkfIndex, renderOkfLog } from "./okf.js";
export const VAULT_FORMAT_VERSION = 1 as const;
export const DEFAULT_VAULT_HOST = "127.0.0.1" as const;
export const DEFAULT_VAULT_PORT = 4816 as const;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
export const VAULT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface VaultPaths {
  readonly vaultRoot: string;
  readonly metadataRoot: string;
  readonly vaultConfigPath: string;
  readonly databasePath: string;
  readonly qmdRoot: string;
  readonly workRoot: string;
  readonly inboxRoot: string;
  readonly sourcesRoot: string;
  readonly wikiRoot: string;
  readonly quizzesRoot: string;
  readonly writerLockPath: string;
  readonly vaultId: string;
  readonly formatVersion: number;
}

export interface VaultConfig {
  readonly formatVersion: number;
  readonly vaultId: string;
}

export class VaultError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

export class NoVaultError extends VaultError {
  constructor() {
    super("NO_VAULT", "No Pi Scholar vault found. Run pi-scholar init [path].");
    this.name = "NoVaultError";
  }
}

export class PathSafetyError extends VaultError {
  constructor(message: string) {
    super("UNSAFE_PATH", message);
    this.name = "PathSafetyError";
  }
}

export class LockBusyError extends VaultError {
  constructor(path: string) {
    super("LOCK_BUSY", `Pi Scholar is busy: ${path}`);
    this.name = "LockBusyError";
  }
}

export interface LockHandle {
  readonly path: string;
  readonly token: string;
  release(): void;
}

function rejectControls(value: string, label: string): void {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new PathSafetyError(`${label} contains a control character`);
  }
}

function assertDirectory(path: string, label: string, create = false): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new PathSafetyError(`${label} must not be a symlink: ${path}`);
    if (!stat.isDirectory()) throw new VaultError("WRONG_TYPE", `${label} must be a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && create) {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      return;
    }
    throw error;
  }
}

export function assertNoSymlinkPath(path: string): void {
  const absolute = resolve(path);
  const parsed = win32.parse(absolute);
  let current = parsed.root || sep;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new PathSafetyError(`symlink path component is not allowed: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function validateVaultId(vaultId: unknown): asserts vaultId is string {
  if (typeof vaultId !== "string" || !VAULT_ID_PATTERN.test(vaultId)) {
    throw new VaultError("INVALID_VAULT_CONFIG", "vault.json contains an invalid host-minted vault ID");
  }
}

function readVaultConfig(configPath: string): VaultConfig {
  let raw: string;
  try {
    raw = readFileNoFollow(configPath).toString("utf8");
  } catch (error) {
    throw new VaultError("INVALID_VAULT_CONFIG", `Cannot read ${configPath}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new VaultError("INVALID_VAULT_CONFIG", `${configPath} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VaultError("INVALID_VAULT_CONFIG", `${configPath} must contain an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.formatVersion !== VAULT_FORMAT_VERSION) {
    throw new VaultError("UNSUPPORTED_VAULT_FORMAT", `${configPath} has unsupported formatVersion`);
  }
  validateVaultId(record.vaultId);
  return { formatVersion: VAULT_FORMAT_VERSION, vaultId: record.vaultId };
}

function createPaths(vaultRoot: string, config: VaultConfig): VaultPaths {
  const metadataRoot = join(vaultRoot, ".pi-scholar");
  return Object.freeze({
    vaultRoot,
    metadataRoot,
    vaultConfigPath: join(metadataRoot, "vault.json"),
    databasePath: join(metadataRoot, "state.sqlite"),
    qmdRoot: join(metadataRoot, "qmd"),
    workRoot: join(metadataRoot, "work"),
    inboxRoot: join(vaultRoot, "inbox"),
    sourcesRoot: join(vaultRoot, "sources"),
    wikiRoot: join(vaultRoot, "wiki"),
    quizzesRoot: join(vaultRoot, "quizzes"),
    writerLockPath: `${vaultRoot}.pi-scholar.lock`,
    vaultId: config.vaultId,
    formatVersion: config.formatVersion,
  });
}

function validateVaultLayout(paths: VaultPaths): void {
  assertNoSymlinkPath(paths.vaultRoot);
  assertDirectory(paths.vaultRoot, "vault root");
  for (const [name, path] of [
    [".pi-scholar", paths.metadataRoot],
    ["snapshots", join(paths.metadataRoot, "snapshots")],
    ["wiki snapshots", join(paths.metadataRoot, "snapshots", "wiki")],
    ["inbox", paths.inboxRoot],
    ["sources", paths.sourcesRoot],
    ["wiki", paths.wikiRoot],
    ["quizzes", paths.quizzesRoot],
    ["qmd", paths.qmdRoot],
    ["work", paths.workRoot],
  ] as const) {
    assertNoSymlinkPath(path);
    assertDirectory(path, name);
  }
  const configStat = lstatSync(paths.vaultConfigPath);
  if (configStat.isSymbolicLink() || !configStat.isFile()) {
    throw new PathSafetyError(`vault.json must be a regular file: ${paths.vaultConfigPath}`);
  }
  validateGitignore(join(paths.vaultRoot, ".gitignore"));
  if (existsSync(paths.writerLockPath) && lstatSync(paths.writerLockPath).isSymbolicLink()) {
    throw new PathSafetyError(`writer lock must not be a symlink: ${paths.writerLockPath}`);
  }
}

function findVault(start: string): VaultPaths {
  rejectControls(start, "vault path");
  assertNoSymlinkPath(start);
  let current = resolve(start);
  try {
    if (!statSync(current).isDirectory()) current = dirname(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  while (true) {
    const metadataRoot = join(current, ".pi-scholar");
    const configPath = join(metadataRoot, "vault.json");
    if (existsSync(configPath)) {
      const config = readVaultConfig(configPath);
      const paths = createPaths(realpathSync(current), config);
      validateVaultLayout(paths);
      return paths;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new NoVaultError();
}

/** Resolve an explicit root, or walk upward from cwd to the nearest vault. */
export function resolveVault(explicitPath?: string): VaultPaths {
  if (explicitPath !== undefined) return findVault(resolve(explicitPath));
  return findVault(process.cwd());
}

/**
 * Resolve a user/model-selected path beneath a trusted root. The input must
 * already be a normalized, slash-separated relative path and may not resolve
 * through a symlink.
 */
export function safeRelativePath(root: string | VaultPaths, requestedPath: string): string {
  const trustedRoot = typeof root === "string" ? root : root.vaultRoot;
  rejectControls(trustedRoot, "root path");
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new PathSafetyError("relative path is required");
  }
  rejectControls(requestedPath, "relative path");
  if (
    requestedPath.includes("\\") ||
    isAbsolute(requestedPath) ||
    posix.isAbsolute(requestedPath) ||
    win32.isAbsolute(requestedPath) ||
    /^[A-Za-z]:/u.test(requestedPath)
  ) {
    throw new PathSafetyError(`absolute or platform-specific path is not allowed: ${requestedPath}`);
  }
  const normalized = normalize(requestedPath);
  if (normalized !== requestedPath || normalized === "." || normalized.startsWith(`..${sep}`) || normalized === "..") {
    throw new PathSafetyError(`path must be normalized and contained: ${requestedPath}`);
  }
  const rootAbsolute = resolve(trustedRoot);
  const candidate = resolve(rootAbsolute, requestedPath);
  const containment = relative(rootAbsolute, candidate);
  if (!containment || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
    throw new PathSafetyError(`path escapes trusted root: ${requestedPath}`);
  }
  assertNoSymlinkPath(rootAbsolute);
  assertNoSymlinkPath(candidate);
  return candidate;
}
export function readFileNoFollow(path: string, maxBytes?: number): Buffer {
  assertNoSymlinkPath(path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new PathSafetyError(`regular file required: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new PathSafetyError(`regular file required: ${path}`);
    if (maxBytes !== undefined && opened.size > maxBytes)
      throw new PathSafetyError(`file exceeds ${maxBytes} bytes: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteFile(path: string, data: string | Uint8Array, mode = 0o600): void {
  rejectControls(path, "file path");
  assertNoSymlinkPath(dirname(path));
  const directory = dirname(path);
  assertDirectory(directory, "file parent");
  if (existsSync(path)) {
    const destination = lstatSync(path);
    if (destination.isSymbolicLink() || !destination.isFile())
      throw new PathSafetyError(`atomic destination must be a regular file: ${path}`);
  }
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", mode);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temporary, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // The descriptor may already be closed.
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function ensureDirectory(path: string, label: string): void {
  if (existsSync(path)) {
    assertDirectory(path, label);
    return;
  }
  assertNoSymlinkPath(dirname(path));
  mkdirSync(path, { recursive: false, mode: 0o700 });
}

const VAULT_GITIGNORE = `# Pi Scholar transient state\n/inbox/\n/.pi-scholar/qmd/\n/.pi-scholar/work/\n/.pi-scholar/state.sqlite-wal\n/.pi-scholar/state.sqlite-shm\n/.pi-scholar/state.sqlite-journal\n/*.log\n/.pi-scholar/*.log\n`;

const DURABLE_GITIGNORE_PATTERNS = [
  /^(?:\/|\*\*\/)?(?:sources|wiki|quizzes)(?:[*?/]|$)/iu,
  /^(?:\/|\*\*\/)?(?:snapshots|state\.sqlite)(?:[*?/]|$)/iu,
  /^(?:\/|\*\*\/)?\.pi-scholar(?:\/?$|\/(?:snapshots|state\.sqlite)(?:[*?/]|$)|\/\*{1,2}(?:\/|$))/iu,
  /^(?:\/|\*\*\/)?\*{1,2}(?:\/\*{1,2})*\/?$/u,
  /^(?:\/|\*\*\/)?\*[^/]*\.(?:md|sqlite)(?:\/)?$/iu,
] as const;

function ignoresDurablePath(rule: string): boolean {
  const pattern = rule.startsWith("!") ? rule.slice(1).trim() : rule;
  return DURABLE_GITIGNORE_PATTERNS.some((candidate) => candidate.test(pattern));
}

function validateGitignore(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new PathSafetyError(`vault .gitignore must be a regular file: ${path}`);
    const contents = readFileNoFollow(path).toString("utf8");
    for (const rawRule of contents.split(/\r?\n/u)) {
      const rule = rawRule.trim();
      if (rule.length > 0 && !rule.startsWith("#") && ignoresDurablePath(rule)) {
        throw new PathSafetyError(`vault .gitignore must not ignore durable vault data: ${rule}`);
      }
    }
  } catch (error) {
    if (error instanceof PathSafetyError) throw error;
    throw new PathSafetyError(`vault .gitignore is unavailable: ${path}`);
  }
}

function ensureGitignore(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    atomicWriteFile(path, VAULT_GITIGNORE);
    return;
  }
  validateGitignore(path);
}

function seedDefaultSettings(paths: VaultPaths): void {
  const db = openDatabase(paths);
  try {
    transaction(db, () => {
      const now = new Date().toISOString();
      const defaults: readonly [string, string][] = [
        ["initializationEnabled", "true"],
        ["timezone", JSON.stringify("local")],
        ["port", String(DEFAULT_VAULT_PORT)],
        ["host", JSON.stringify(DEFAULT_VAULT_HOST)],
      ];
      for (const [key, value] of defaults)
        db.run("INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)", [key, value, now]);
    });
    db.checkpoint();
  } finally {
    db.close();
  }
}
function seedWikiProjections(paths: VaultPaths): void {
  for (const [path, content] of [
    [join(paths.wikiRoot, "index.md"), renderOkfIndex([])],
    [join(paths.wikiRoot, "log.md"), renderOkfLog([])],
  ] as const)
    if (!existsSync(path)) atomicWriteFile(path, content);
}

/** Create the product roots, durable schema, derived directories, and Git repository. */
export function initVault(requestedRoot = process.cwd()): VaultPaths {
  rejectControls(requestedRoot, "vault path");
  const vaultRoot = resolve(requestedRoot);
  assertNoSymlinkPath(vaultRoot);
  if (existsSync(vaultRoot)) assertDirectory(vaultRoot, "vault root");
  else {
    assertNoSymlinkPath(dirname(vaultRoot));
    mkdirSync(vaultRoot, { recursive: true, mode: 0o700 });
  }

  const metadataRoot = join(vaultRoot, ".pi-scholar");
  const configPath = join(metadataRoot, "vault.json");
  if (existsSync(configPath)) {
    ensureDirectory(join(metadataRoot, "snapshots"), "snapshots");
    ensureDirectory(join(metadataRoot, "snapshots", "wiki"), "wiki snapshots");
    const paths = resolveVault(vaultRoot);
    seedDefaultSettings(paths);
    seedWikiProjections(paths);
    initializeRepository(paths);
    return paths;
  }

  ensureDirectory(metadataRoot, ".pi-scholar");
  const config: VaultConfig = { formatVersion: VAULT_FORMAT_VERSION, vaultId: randomUUID() };
  atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const paths = createPaths(vaultRoot, config);
  for (const [name, path] of [
    ["inbox", paths.inboxRoot],
    ["sources", paths.sourcesRoot],
    ["wiki", paths.wikiRoot],
    ["quizzes", paths.quizzesRoot],
    ["qmd", paths.qmdRoot],
    ["work", paths.workRoot],
    ["snapshots", join(paths.metadataRoot, "snapshots")],
    ["wiki snapshots", join(paths.metadataRoot, "snapshots", "wiki")],
  ] as const)
    ensureDirectory(path, name);
  ensureGitignore(join(vaultRoot, ".gitignore"));
  seedWikiProjections(paths);
  validateVaultLayout(paths);
  seedDefaultSettings(paths);
  initializeRepository(paths);
  return paths;
}
function recoverStaleLock(path: string): boolean {
  let observed: Buffer;
  try {
    observed = readFileNoFollow(path);
    const record = JSON.parse(observed.toString("utf8")) as { pid?: unknown };
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return false;
    try {
      process.kill(record.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    if (!readFileNoFollow(path).equals(observed)) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

function acquireLock(path: string): LockHandle | undefined {
  const token = randomUUID();
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`);
      fsyncSync(fd);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the write error.
      }
      try {
        rmSync(path, { force: true });
      } catch {
        // Preserve the write error.
      }
      throw error;
    }
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && recoverStaleLock(path)) return acquireLock(path);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  let released = false;
  return {
    path,
    token,
    release(): void {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(readFileNoFollow(path).toString("utf8")) as { token?: unknown };
        if (current.token === token) unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

export function acquireWriterLock(
  paths: VaultPaths,
  options: { readonly waitMs?: number; readonly pollMs?: number } = {},
): LockHandle {
  const waitMs = options.waitMs ?? 0;
  const pollMs = options.pollMs ?? 25;
  if (!Number.isFinite(waitMs) || waitMs < 0)
    throw new VaultError("INVALID_LOCK_WAIT", "Lock waitMs must be a finite nonnegative number");
  if (!Number.isFinite(pollMs) || pollMs <= 0)
    throw new VaultError("INVALID_LOCK_WAIT", "Lock pollMs must be a finite positive number");
  const deadline = Date.now() + waitMs;
  const sleeper = waitMs > 0 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (;;) {
    const lock = acquireLock(paths.writerLockPath);
    if (lock) return lock;
    const remaining = deadline - Date.now();
    if (waitMs === 0 || remaining <= 0) throw new LockBusyError(paths.writerLockPath);
    Atomics.wait(sleeper!, 0, 0, Math.min(pollMs, remaining));
  }
}

export async function withWriterLock<T>(paths: VaultPaths, operation: () => T | PromiseLike<T>): Promise<T> {
  const lock = acquireWriterLock(paths);
  try {
    return await operation();
  } finally {
    lock.release();
  }
}
