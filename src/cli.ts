#!/usr/bin/env node
import { createApplication } from "./application/application.js";
import { openDatabase } from "./database.js";
import { doctor } from "./doctor.js";
import { localCheckpointCommit } from "./external/git.js";
import type { ChildResult } from "./external/process.js";
import { ensureQmdCollection } from "./external/qmd.js";
import type { ScholarServer } from "./server.js";
import { initVault, NoVaultError, resolveVault } from "./vault.js";

export interface CliArgs {
  readonly command: "init" | "doctor" | "serve" | "sync";
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
    "  pi-scholar sync [--vault path]",
  ].join("\n");
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const command = argv[0];
  if (command !== "init" && command !== "doctor" && command !== "serve" && command !== "sync") throw new Error(usage());
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
      if (!next || !Number.isInteger(parsed) || parsed < 1 || parsed > 65_535)
        throw new Error("--port must be an integer between 1 and 65535");
      port = parsed;
    } else if (value.startsWith("-")) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      positional.push(value);
    }
  }
  if (port !== undefined && command !== "serve") throw new Error("--port is only valid for serve");
  if (vaultPath !== undefined && command !== "serve" && command !== "sync")
    throw new Error(`--vault is not used with ${command}; pass [path]`);
  if ((command === "serve" || command === "sync") && positional.length > 0)
    throw new Error(`${command} accepts no positional arguments`);
  if ((command === "init" || command === "doctor") && positional.length > 1)
    throw new Error(`${command} accepts at most one path`);
  if ((command === "init" || command === "doctor") && vaultPath !== undefined)
    throw new Error(`--vault is not used with ${command}; pass [path]`);
  const positionalPath = command === "init" || command === "doctor" ? positional[0] : undefined;
  return {
    command,
    positional,
    ...(positionalPath ? { vaultPath: positionalPath } : vaultPath ? { vaultPath } : {}),
    ...(port === undefined ? {} : { port }),
  };
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

function qmdInitializationFailure(result: ChildResult): string | undefined {
  if (result.timedOut) return "collection setup timed out";
  if (result.signal) return `collection setup terminated by ${result.signal}`;
  if (result.code === 0) return undefined;
  return `collection setup failed (${result.code ?? "unknown"}): ${(result.stderr.trim() || result.stdout.trim()).slice(0, 500)}`;
}

function waitForServerShutdown(server: ScholarServer): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let closePromise: Promise<void> | undefined;
  let settled = false;
  const cleanup = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  const finish = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error === undefined) resolve();
    else reject(error);
  };
  const onSignal = (): void => {
    if (closePromise) return;
    closePromise = Promise.resolve().then(() => server.closeGracefully());
    closePromise.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return promise;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.command === "init") {
    const paths = initVault(parsed.positional[0] ?? process.cwd());
    let qmdResult: ChildResult | undefined;
    let qmdError: string | undefined;
    try {
      qmdResult = ensureQmdCollection(paths);
    } catch (error) {
      qmdError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    }
    const db = openDatabase(paths);
    try {
      db.checkpoint();
    } finally {
      db.close();
    }
    const report = doctor(paths.vaultRoot);
    const qmdFailure = qmdResult ? qmdInitializationFailure(qmdResult) : undefined;
    const qmdCheckNames: Record<string, true> = { qmd: true, "qmd-scope": true };
    const warnings = [
      ...(qmdError ? [`qmd: ${qmdError}`] : []),
      ...(qmdFailure ? [`qmd: ${qmdFailure}`] : []),
      ...report.checks
        .filter((item) => qmdCheckNames[item.name] === true && item.status !== "pass")
        .map((item) => `${item.name}: ${item.message}`),
    ];
    const failures = report.checks
      .filter((item) => item.status === "fail" && qmdCheckNames[item.name] !== true)
      .map((item) => `${item.name}: ${item.message}`);
    if (failures.length > 0) throw new Error(`Initialization failed: ${failures.join("; ")}`);
    localCheckpointCommit(paths, "scholar: initialize vault");
    print({
      ok: true,
      vaultRoot: paths.vaultRoot,
      vaultId: paths.vaultId,
      ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
    });
    return 0;
  }
  if (parsed.command === "doctor") return reportDoctor(parsed.positional[0]);
  const paths = resolveVault(parsed.vaultPath);
  if (parsed.command === "serve") {
    // Keep non-server CLI commands from loading the HTTP and browser runtime.
    const { startServer } = await import("./server.js");
    const server = await startServer({ paths, ...(parsed.port === undefined ? {} : { port: parsed.port }) });
    await waitForServerShutdown(server);
    return 0;
  }
  if (parsed.command === "sync") {
    const application = createApplication(paths);
    try {
      const result = await application.sync();
      if (!result.ok) {
        print({
          ok: false,
          status: result.status,
          error: result.error ?? "git push failed",
          output: result.output.slice(-4096),
        });
        return 1;
      }
      print({ ok: true, status: result.status, output: result.output.slice(-4096) });
      return 0;
    } finally {
      await application.close();
    }
  }
  throw new Error("unsupported CLI command");
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message =
        error instanceof NoVaultError ? error.message : error instanceof Error ? error.message : String(error);
      process.stderr.write(`pi-scholar: ${message}\n`);
      process.exitCode = 1;
    });
}
