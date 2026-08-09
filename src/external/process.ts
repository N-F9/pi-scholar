import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const PINNED_EXECUTABLES = new Map<string, string>();

export interface ChildRunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
}

export interface ChildResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function validateArgv(executable: string, args: readonly string[]): void {
  if (!executable || /[\u0000-\u001f\u007f]/u.test(executable)) throw new Error("invalid child executable");
  if (!isAbsolute(executable) && !/^[A-Za-z0-9._-]+$/u.test(executable)) throw new Error("child executable must be a name or absolute path");
  for (const arg of args) {
    if (typeof arg !== "string" || /[\u0000]/u.test(arg)) throw new Error("child argv contains an invalid value");
  }
}

function assertExecutableFile(path: string): string {
  let realPath: string;
  try {
    realPath = realpathSync(path);
    const stat = statSync(realPath);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("not a regular executable file");
    accessSync(realPath, constants.X_OK);
  } catch (error) {
    throw new Error(`child executable is not a regular executable file: ${path}`, { cause: error });
  }
  return realPath;
}

function findBareExecutable(name: string): string {
  const path = process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  for (const directory of path.split(delimiter)) {
    if (!directory || !isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory)) continue;
    try {
      return assertExecutableFile(join(directory, name));
    } catch {
      // Try the next closed PATH entry.
    }
  }
  throw new Error(`child executable was not found in PATH: ${name}`);
}

function pinExecutable(executable: string): string {
  const pinned = PINNED_EXECUTABLES.get(executable);
  if (pinned) return pinned;
  const resolved = isAbsolute(executable) ? assertExecutableFile(executable) : findBareExecutable(executable);
  PINNED_EXECUTABLES.set(executable, resolved);
  return resolved;
}

function validateEnvironment(overrides: Readonly<Record<string, string>> | undefined): void {
  if (!overrides) return;
  const entries = Object.entries(overrides);
  if (entries.length > 64) throw new Error("child environment has too many entries");
  let bytes = 0;
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("child environment contains an invalid value");
    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
  }
  if (bytes > 64 * 1024) throw new Error("child environment exceeds 64 KiB");
}

function validateOptions(options: ChildRunOptions): void {
  if (!options.cwd || /[\u0000\u000a\u000d]/u.test(options.cwd)) throw new Error("invalid child working directory");
  const stat = lstatSync(options.cwd);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("child working directory must be a real directory");
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error("child timeout must be positive");
  if (options.maxOutputBytes !== undefined && (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)) throw new Error("child output bound must be positive");
  validateEnvironment(options.env);
  if (options.stdin !== undefined && Buffer.byteLength(options.stdin) > 64 * 1024) throw new Error("child stdin exceeds 64 KiB");
}

function environment(overrides: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    ...overrides,
  };
}

function terminateTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

function boundedAppend(current: string, chunk: Buffer, maxBytes: number): string {
  if (Buffer.byteLength(current, "utf8") >= maxBytes) return current;
  const remaining = maxBytes - Buffer.byteLength(current, "utf8");
  return current + chunk.subarray(0, remaining).toString("utf8");
}

export function runChild(executable: string, args: readonly string[], options: ChildRunOptions): Promise<ChildResult> {
  validateArgv(executable, args);
  const pinnedExecutable = pinExecutable(executable);
  validateOptions(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const { promise, resolve, reject } = Promise.withResolvers<ChildResult>();
  const child = spawn(pinnedExecutable, [...args], {
    cwd: options.cwd,
    env: environment(options.env),
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(options.stdin === undefined ? undefined : Buffer.from(options.stdin));
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = boundedAppend(stdout, chunk, maxOutputBytes);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = boundedAppend(stderr, chunk, maxOutputBytes);
  });
  let killTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    const pid = child.pid;
    terminateTree(pid, "SIGTERM");
    killTimer = setTimeout(() => terminateTree(pid, "SIGKILL"), 1_000);
    killTimer.unref();
  }, timeoutMs);
  const clearTimers = (): void => {
    clearTimeout(timer);
    clearTimeout(killTimer);
  };
  child.once("error", (error) => {
    clearTimers();
    reject(error);
  });
  child.once("close", (code, signal) => {
    clearTimers();
    resolve({ executable: pinnedExecutable, args: [...args], code, signal, timedOut, stdout, stderr });
  });
  return promise;
}
export function runChildSync(executable: string, args: readonly string[], options: ChildRunOptions): ChildResult {
  validateArgv(executable, args);
  const pinnedExecutable = pinExecutable(executable);
  validateOptions(options);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const spawnOptions = {
    cwd: options.cwd,
    env: environment(options.env),
    shell: false,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    killSignal: "SIGKILL" as const,
    encoding: "buffer" as const,
    maxBuffer: maxOutputBytes,
    input: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
  };
  Object.assign(spawnOptions, { detached: true });
  const result = spawnSync(pinnedExecutable, [...args], spawnOptions);
  const timedOut = Boolean(result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT");
  if (timedOut) terminateTree(result.pid, "SIGKILL");
  return {
    executable: pinnedExecutable,
    args: [...args],
    code: result.status,
    signal: result.signal,
    timedOut,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout.subarray(0, maxOutputBytes).toString("utf8") : String(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr.subarray(0, maxOutputBytes).toString("utf8") : String(result.stderr ?? ""),
  };
}
