import { lstatSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;

export interface ChildRunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
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

function validateOptions(options: ChildRunOptions): void {
  if (!options.cwd || /[\u0000\u000a\u000d]/u.test(options.cwd)) throw new Error("invalid child working directory");
  const stat = lstatSync(options.cwd);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("child working directory must be a real directory");
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error("child timeout must be positive");
  if (options.maxOutputBytes !== undefined && (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)) throw new Error("child output bound must be positive");
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
  validateOptions(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const { promise, resolve, reject } = Promise.withResolvers<ChildResult>();
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: environment(options.env),
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = boundedAppend(stdout, chunk, maxOutputBytes);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = boundedAppend(stderr, chunk, maxOutputBytes);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child.pid, "SIGTERM");
    setTimeout(() => terminateTree(child.pid, "SIGKILL"), 1_000).unref();
  }, timeoutMs);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    resolve({ executable, args: [...args], code, signal, timedOut, stdout, stderr });
  });
  return promise;
}

export function runChildSync(executable: string, args: readonly string[], options: ChildRunOptions): ChildResult {
  validateArgv(executable, args);
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
  };
  Object.assign(spawnOptions, { detached: true });
  const result = spawnSync(executable, [...args], spawnOptions);
  const timedOut = Boolean(result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT");
  if (timedOut) terminateTree(result.pid, "SIGKILL");
  return {
    executable,
    args: [...args],
    code: result.status,
    signal: result.signal,
    timedOut,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout.subarray(0, maxOutputBytes).toString("utf8") : String(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr.subarray(0, maxOutputBytes).toString("utf8") : String(result.stderr ?? ""),
  };
}
