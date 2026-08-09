#!/usr/bin/env node
import { doctor } from "./doctor.js";
import { initVault, NoVaultError, resolveVault, tryAcquireRunGuard, type LockHandle, type VaultPaths } from "./vault.js";

export interface CliArgs {
  readonly command: "init" | "doctor" | "serve" | "run" | "sync";
  readonly positional: readonly string[];
  readonly vaultPath?: string;
  readonly port?: number;
}

function usage(): string {
  return [
    "Usage:",
    "  pi-scholar init [path]",
    "  pi-scholar doctor [path]",
    "  pi-scholar serve [--vault path] [--port port]",
    "  pi-scholar run scheduled [--vault path]",
    "  pi-scholar sync [--vault path]",
  ].join("\n");
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const command = argv[0];
  if (command !== "init" && command !== "doctor" && command !== "serve" && command !== "run" && command !== "sync") throw new Error(usage());
  const positional: string[] = [];
  let vaultPath: string | undefined;
  let port: number | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) throw new Error("CLI argument is missing");
    if (value === "--vault") {
      const next = argv[++index];
      if (!next) throw new Error("--vault requires a path");
      vaultPath = next;
    } else if (value === "--port") {
      const next = argv[++index];
      const parsed = Number(next);
      if (!next || !Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("--port must be an integer between 1 and 65535");
      port = parsed;
    } else if (value.startsWith("-")) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      positional.push(value);
    }
  }
  if (command === "run" && positional[0] !== "scheduled") throw new Error("Only 'pi-scholar run scheduled' is supported");
  if (command === "run" && positional.length > 1) throw new Error("run scheduled accepts no positional arguments");
  if ((command === "serve" || command === "sync") && positional.length > 0) throw new Error(`${command} accepts no positional arguments`);
  if ((command === "init" || command === "doctor") && positional.length > 1) throw new Error(`${command} accepts at most one path`);
  if ((command === "init" || command === "doctor") && vaultPath !== undefined) throw new Error(`--vault is not used with ${command}; pass [path]`);
  const positionalPath = command === "init" || command === "doctor" ? positional[0] : undefined;
  return { command, positional, ...(positionalPath ? { vaultPath: positionalPath } : vaultPath ? { vaultPath } : {}), ...(port === undefined ? {} : { port }) };
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}
function reportDoctor(path: string | undefined): number {
  const report = doctor(path);
  if (!report.ok && report.checks.length === 1 && report.checks[0]?.name === "vault") {
    print(report.checks[0].message);
  } else {
    print(report);
  }
  return report.ok ? 0 : 1;
}

// Server/application are optional stage-owned hooks; keep CLI bootstrap compilable while those modules are packaged.
async function delegate(modulePath: string, names: readonly string[], ...args: unknown[]): Promise<unknown> {
  const module = (await import(modulePath)) as Record<string, unknown>;
  for (const name of names) {
    const candidate = module[name];
    if (typeof candidate === "function") return (candidate as (...values: unknown[]) => unknown)(...args);
  }
  throw new Error(`No supported ${names.join(" or ")} delegation hook is installed`);
}

async function runScheduled(paths: VaultPaths): Promise<number> {
  const guard: LockHandle | undefined = tryAcquireRunGuard(paths);
  if (!guard) {
    print("A scheduled run is already active; exiting without blocking writers.");
    return 0;
  }
  try {
    await delegate("./application.js", ["runScheduled", "runScheduledWorkflow"], paths);
    return 0;
  } finally {
    guard.release();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.command === "init") {
    const paths = initVault(parsed.positional[0] ?? process.cwd());
    print({ ok: true, vaultRoot: paths.vaultRoot, vaultId: paths.vaultId });
    return 0;
  }
  if (parsed.command === "doctor") return reportDoctor(parsed.positional[0]);
  const paths = resolveVault(parsed.vaultPath);
  if (parsed.command === "serve") {
    await delegate("./server.js", ["startServer", "serve"], { paths, port: parsed.port });
    return 0;
  }
  if (parsed.command === "run") return runScheduled(paths);
  await delegate("./application.js", ["sync", "syncVault"], paths);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    const message = error instanceof NoVaultError ? error.message : error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-scholar: ${message}\n`);
    process.exitCode = 1;
  });
}
