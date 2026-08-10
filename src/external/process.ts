import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
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
  readonly outputOverflowed?: boolean;
}

function validateArgv(executable: string, args: readonly string[]): void {
  if (!executable || /[\u0000-\u001f\u007f]/u.test(executable)) throw new Error("invalid child executable");
  if (!isAbsolute(executable) && !/^[A-Za-z0-9._-]+$/u.test(executable))
    throw new Error("child executable must be a name or absolute path");
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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || /[\u0000-\u001f\u007f]/u.test(value))
      throw new Error("child environment contains an invalid value");
    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
  }
  if (bytes > 64 * 1024) throw new Error("child environment exceeds 64 KiB");
}

function validateOptions(options: ChildRunOptions): void {
  if (!options.cwd || /[\u0000\u000a\u000d]/u.test(options.cwd)) throw new Error("invalid child working directory");
  const stat = lstatSync(options.cwd);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("child working directory must be a real directory");
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
    throw new Error("child timeout must be positive");
  if (
    options.maxOutputBytes !== undefined &&
    (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)
  )
    throw new Error("child output bound must be positive");
  validateEnvironment(options.env);
  if (options.stdin !== undefined && Buffer.byteLength(options.stdin) > 64 * 1024)
    throw new Error("child stdin exceeds 64 KiB");
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

function boundedAppend(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
): { bytes: number; overflowed: boolean } {
  const retainedBytes = Math.min(chunk.byteLength, maxBytes - currentBytes);
  if (retainedBytes > 0) chunks.push(chunk.subarray(0, retainedBytes));
  return { bytes: currentBytes + retainedBytes, overflowed: retainedBytes < chunk.byteLength };
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
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverflowed = false;
  let timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => {
    const appended = boundedAppend(stdoutChunks, stdoutBytes, chunk, maxOutputBytes);
    stdoutBytes = appended.bytes;
    outputOverflowed ||= appended.overflowed;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const appended = boundedAppend(stderrChunks, stderrBytes, chunk, maxOutputBytes);
    stderrBytes = appended.bytes;
    outputOverflowed ||= appended.overflowed;
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
    resolve({
      executable: pinnedExecutable,
      args: [...args],
      code,
      signal,
      timedOut,
      stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
      stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
      outputOverflowed,
    });
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
  const outputOverflowed =
    Boolean(
      result.error &&
        ["ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes((result.error as NodeJS.ErrnoException).code ?? ""),
    ) ||
    (Buffer.isBuffer(result.stdout) && result.stdout.byteLength > maxOutputBytes) ||
    (Buffer.isBuffer(result.stderr) && result.stderr.byteLength > maxOutputBytes);
  return {
    executable: pinnedExecutable,
    args: [...args],
    code: result.status,
    signal: result.signal,
    timedOut,
    stdout: Buffer.isBuffer(result.stdout)
      ? result.stdout.subarray(0, maxOutputBytes).toString("utf8")
      : String(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr)
      ? result.stderr.subarray(0, maxOutputBytes).toString("utf8")
      : String(result.stderr ?? ""),
    outputOverflowed,
  };
}
