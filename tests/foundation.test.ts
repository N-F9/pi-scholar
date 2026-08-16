import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "vitest";
import { main } from "../src/cli.js";
import { openDatabase, SCHEMA_SQL, transaction, validateSchema } from "../src/database.js";
import { doctor } from "../src/doctor.js";
import {
  convertWithDocling,
  doclingArgs,
  doclingDependencyIdentity,
  doclingEnvironment,
  PDF_BATCH_PAGES,
  qpdfDependencyIdentity,
} from "../src/external/docling.js";
import { gitDependencyIdentity, localCheckpointCommit, runGit, runGitSync } from "../src/external/git.js";
import { runChild, runChildSync } from "../src/external/process.js";
import {
  qmdArgs,
  qmdCollection,
  qmdDependencyIdentity,
  qmdEnvironment,
  qmdScopeCheck,
  qmdSearch,
} from "../src/external/qmd.js";
import { API_VERSION } from "../src/index.js";
import { QuizService } from "../src/quiz.js";
import { writeFully } from "../src/sources/source-files.js";
import { SourceService } from "../src/sources/source-service.js";
import {
  acquireWriterLock,
  initVault,
  readFileNoFollow,
  resolveVault,
  safeRelativePath,
  type VaultPaths,
} from "../src/vault.js";
import { WikiService } from "../src/wiki.js";

describe("vault foundation", () => {
  it("keeps the package-root API version export", () => {
    assert.equal(API_VERSION, "v1");
  });
  it("initializes exactly the product roots and discovers from a child directory", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const vaultPath = join(root, "vault");
    assert.equal(await main(["init", vaultPath]), 0);
    const paths = resolveVault(vaultPath);
    const history = runChildSync("git", ["rev-list", "--count", "HEAD"], { cwd: paths.vaultRoot, timeoutMs: 5_000 });
    assert.equal(history.code, 0);
    assert.equal(history.stdout.trim(), "1");
    const subject = runChildSync("git", ["log", "-1", "--format=%s"], { cwd: paths.vaultRoot, timeoutMs: 5_000 });
    assert.equal(subject.stdout.trim(), "scholar: initialize vault");
    for (const name of [".pi-scholar", "inbox", "sources", "wiki", "quizzes", ".git"])
      assert.equal(lstatSync(join(paths.vaultRoot, name)).isDirectory(), true);
    assert.equal(existsSync(paths.vaultConfigPath), true);
    const nested = join(paths.wikiRoot, "nested");
    mkdirSync(nested);
    const discovered = resolveVault(nested);
    assert.equal(discovered.vaultId, paths.vaultId);
  });

  it("validates persisted simulated-date settings without failing active simulations", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-settings-"));
    const paths = initVault(join(root, "vault"));
    const settingsCheck = () => doctor(paths.vaultRoot).checks.find((item) => item.name === "settings");

    assert.equal(settingsCheck()?.status, "pass");

    let db = openDatabase(paths);
    db.run(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
      ["simulatedDate", JSON.stringify("2026-08-20"), new Date().toISOString()],
    );
    db.close();
    const active = settingsCheck();
    assert.equal(active?.status, "warn");
    assert.match(active?.message ?? "", /2026-08-20/u);
    assert.equal(doctor(paths.vaultRoot).ok, true);

    for (const value of ['{"malformed"', "42", JSON.stringify("2026-02-29")]) {
      db = openDatabase(paths);
      db.run("UPDATE settings SET value_json = ?, updated_at = ? WHERE key = 'simulatedDate'", [
        value,
        new Date().toISOString(),
      ]);
      db.close();
      assert.equal(settingsCheck()?.status, "fail");
    }
  });

  it("checks qmd collection metadata against the physical wiki root", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const collection = qmdCollection(paths);
    const result = qmdScopeCheck(paths, (_paths, args) => {
      assert.deepEqual(args, ["collection", "show", collection.name]);
      return {
        executable: "qmd",
        args: [...args],
        code: 0,
        signal: null,
        timedOut: false,
        stdout: `  Path:     ${collection.root}\n  Pattern:  ${collection.include}\n`,
        stderr: "",
      };
    });
    assert.equal(result.ok, true);
    const mismatch = qmdScopeCheck(paths, (_paths, args) => ({
      executable: "qmd",
      args: [...args],
      code: 0,
      signal: null,
      timedOut: false,
      stdout: `Path: ${paths.sourcesRoot}\nPattern: ${collection.include}\n`,
      stderr: "",
    }));
    assert.equal(mismatch.ok, false);
    const duplicate = qmdScopeCheck(paths, (_paths, args) => ({
      executable: "qmd",
      args: [...args],
      code: 0,
      signal: null,
      timedOut: false,
      stdout: `  Path: ${collection.root}\n  Path: ${collection.root}\n  Pattern: ${collection.include}\n`,
      stderr: "",
    }));
    assert.equal(duplicate.ok, false);
  });
  it("matches literal qmd ignore paths without treating glob metacharacters as patterns", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const collection = qmdCollection(paths);
    const configDirectory = join(paths.qmdRoot, ".config", "qmd");
    mkdirSync(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "index.yml");
    const config = [
      "collections:",
      `  ${collection.name}:`,
      `    path: ${JSON.stringify(collection.root)}`,
      `    pattern: ${JSON.stringify(collection.include)}`,
      "    ignore:",
      '      - "\\\\[x\\\\].md"',
      "",
    ].join("\n");
    writeFileSync(configPath, config);
    const runner = (_paths: VaultPaths, args: readonly string[]) => ({
      executable: "qmd",
      args: [...args],
      code: 0,
      signal: null,
      timedOut: false,
      stdout: `Path: ${collection.root}\nPattern: ${collection.include}\n`,
      stderr: "",
    });
    const result = qmdScopeCheck(paths, runner, ["[x].md"]);
    assert.equal(result.ok, true);
    writeFileSync(configPath, config.replace("\\\\[x\\\\].md", "[x].md"));
    assert.equal(qmdScopeCheck(paths, runner, ["[x].md"]).ok, false);
  });

  it("isolates qmd configuration/cache and requests bounded JSON search output", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    assert.deepEqual(qmdEnvironment(paths), {
      HOME: paths.qmdRoot,
      XDG_CACHE_HOME: join(paths.qmdRoot, "cache"),
      XDG_CONFIG_HOME: join(paths.qmdRoot, ".config"),
      QMD_HOME: paths.qmdRoot,
    });
    const result = await qmdSearch(paths, "hybrid query", 7, (_paths, args) => {
      assert.deepEqual(args, ["query", "hybrid query", "--format", "json", "-n", "7"]);
      return Promise.resolve({
        executable: "qmd",
        args: [...args],
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "[]",
        stderr: "",
      });
    });
    assert.equal(result.code, 0);
  });
  it("pins qmd commands to the vault collection and rejects overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const collection = qmdCollection(paths);
    assert.deepEqual(
      qmdArgs(paths, ["collection", "add", collection.root, "--name", collection.name, "--mask", collection.include]),
      [
        "--collection",
        collection.name,
        "collection",
        "add",
        collection.root,
        "--name",
        collection.name,
        "--mask",
        collection.include,
      ],
    );
    assert.deepEqual(qmdArgs(paths, ["collection", "show", collection.name]), [
      "--collection",
      collection.name,
      "collection",
      "show",
      collection.name,
    ]);
    assert.deepEqual(qmdArgs(paths, ["update"]), ["--collection", collection.name, "update"]);
    assert.deepEqual(qmdArgs(paths, ["query", "term", "--format", "json", "-n", "100"]), [
      "--collection",
      collection.name,
      "query",
      "term",
      "--format",
      "json",
      "-n",
      "100",
    ]);
    for (const args of [
      ["collection", "add", paths.sourcesRoot, "--name", collection.name, "--mask", collection.include],
      ["collection", "add", collection.root, "--name", "other", "--mask", collection.include],
      ["collection", "add", collection.root, "--name", collection.name, "--mask", "*.txt"],
      ["collection", "show", collection.name, "--collection", "other"],
      ["update", "--index", "other"],
      ["query", "term", "--format", "json", "-n", "10", "--collection", "other"],
    ] as const)
      assert.throws(() => qmdArgs(paths, args));
  });

  it("fails closed on dependency identity results and isolates Docling state", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    assert.deepEqual(doclingEnvironment(paths), {
      HOME: paths.workRoot,
      XDG_CACHE_HOME: join(paths.workRoot, "cache"),
      DOCLING_CACHE_DIR: paths.workRoot,
    });
    writeFileSync(join(paths.workRoot, "input.pdf"), "pdf");
    const command = doclingArgs(paths, {
      inputRelativePath: "input.pdf",
      outputRelativeDirectory: "docling-output",
    });
    assert.deepEqual(command.args, [
      "convert",
      "--image-export-mode",
      "referenced",
      "--output",
      command.outputDirectory,
      command.inputPath,
    ]);
    const qmd = qmdDependencyIdentity(paths, (_paths, args) => ({
      executable: "/pinned/qmd",
      args: [...args],
      code: 0,
      signal: null,
      timedOut: false,
      stdout: "qmd version 2.5.3",
      stderr: "",
    }));
    assert.deepEqual(qmd, { executable: "/pinned/qmd", version: "qmd version 2.5.3" });
    const docling = doclingDependencyIdentity(paths, (_paths, args) => ({
      executable: "/pinned/docling",
      args: [...args],
      code: 0,
      signal: null,
      timedOut: false,
      stdout: "Docling version 2.4.1",
      stderr: "",
    }));
    assert.deepEqual(docling, { executable: "/pinned/docling", version: "Docling version 2.4.1" });
    const qpdf = qpdfDependencyIdentity(paths, (_paths, args) => ({
      executable: "/pinned/qpdf",
      args: [...args],
      code: 0,
      signal: null,
      timedOut: false,
      stdout: "qpdf version 11.9.0",
      stderr: "",
    }));
    assert.deepEqual(qpdf, { executable: "/pinned/qpdf", version: "qpdf version 11.9.0" });
    for (const result of [
      { code: 1, signal: null, timedOut: false },
      { code: 0, signal: "SIGTERM" as const, timedOut: false },
      { code: 0, signal: null, timedOut: true },
    ]) {
      assert.throws(() =>
        qmdDependencyIdentity(paths, (_paths, args) => ({
          executable: "/pinned/qmd",
          args: [...args],
          ...result,
          stdout: "qmd version 2.5.3",
          stderr: "",
        })),
      );
      assert.throws(() =>
        doclingDependencyIdentity(paths, (_paths, args) => ({
          executable: "/pinned/docling",
          args: [...args],
          ...result,
          stdout: "Docling version 2.4.1",
          stderr: "",
        })),
      );
      assert.throws(() =>
        qpdfDependencyIdentity(paths, (_paths, args) => ({
          executable: "/pinned/qpdf",
          args: [...args],
          ...result,
          stdout: "qpdf version 11.9.0",
          stderr: "",
        })),
      );
    }
    assert.throws(() =>
      qmdDependencyIdentity(paths, (_paths, args) => ({
        executable: "/pinned/qmd",
        args: [...args],
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "not-a-version",
        stderr: "",
      })),
    );
    assert.throws(() =>
      doclingDependencyIdentity(paths, (_paths, args) => ({
        executable: "/pinned/docling",
        args: [...args],
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
      })),
    );
    assert.throws(() =>
      qpdfDependencyIdentity(paths, (_paths, args) => ({
        executable: "/pinned/qpdf",
        args: [...args],
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "not qpdf",
        stderr: "",
      })),
    );
  });

  it("converts oversized PDFs sequentially and combines namespaced output", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi scholar (docling batches)-"));
    const paths = initVault(join(root, "vault"));
    const input = join(paths.workRoot, "network.pdf");
    writeFileSync(input, "original PDF");
    const calls: string[] = [];
    let activeConversions = 0;
    let maximumActiveConversions = 0;
    const runner = async (executable: string, args: readonly string[]) => {
      calls.push(`${executable}:${args[0]}`);
      const success = (stdout = "") => ({
        executable: `/pinned/${executable}`,
        args: [...args],
        code: 0,
        signal: null,
        timedOut: false,
        stdout,
        stderr: "",
      });
      if (executable === "qpdf" && args[0] === "--show-npages") return success("513\n");
      if (executable === "qpdf" && args[0] === `--split-pages=${PDF_BATCH_PAGES}`) {
        const directory = dirname(args.at(-1)!);
        for (const name of ["part-001-256.pdf", "part-257-512.pdf", "part-513.pdf"])
          writeFileSync(join(directory, name), name);
        return success();
      }
      assert.equal(executable, "docling");
      const stem = basename(args.at(-1)!, ".pdf");
      const part = /^pages-(\d+)-(\d+)-docling-batches-.+$/u.exec(stem);
      assert.ok(part);
      const range = `${Number(part[1])}-${Number(part[2])}`;
      const outputIndex = args.indexOf("--output") + 1;
      const output = args[outputIndex]!;
      activeConversions++;
      maximumActiveConversions = Math.max(maximumActiveConversions, activeConversions);
      try {
        await delay(5);
        const artifacts = join(output, `${stem}_artifacts`);
        mkdirSync(artifacts, { recursive: true });
        writeFileSync(join(artifacts, "image.png"), `image ${range}`);
        const heading = `# Pages ${range}\n\n`;
        const absoluteOpening = "\n\n![Image](";
        const padding =
          range === "1-256" ? "x".repeat(65_532 - Buffer.byteLength(heading) - Buffer.byteLength(absoluteOpening)) : "";
        writeFileSync(
          join(output, `${stem}.md`),
          `${heading}${padding}${absoluteOpening}${join(artifacts, "image.png")})\n\n![Relative](${stem}_artifacts/image.png)\n\nLiteral document_artifacts/image.png stays.\n`,
        );
      } finally {
        activeConversions--;
      }
      return success();
    };
    try {
      const result = await convertWithDocling(
        paths,
        {
          inputRelativePath: "network.pdf",
          outputRelativeDirectory: "docling-output",
          mediaType: "application/pdf",
        },
        {
          run: runner,
          dependencyIdentity: () => ({ executable: "/pinned/docling", version: "Docling version 2.4.1" }),
        },
      );
      assert.equal(maximumActiveConversions, 1);
      assert.deepEqual(calls, [
        "qpdf:--show-npages",
        `qpdf:--split-pages=${PDF_BATCH_PAGES}`,
        "docling:convert",
        "docling:convert",
        "docling:convert",
      ]);
      assert.deepEqual(readdirSync(result.outputDirectory).sort(), [
        "combined.md",
        "pages-1-256",
        "pages-257-512",
        "pages-513-513",
      ]);
      const combined = readFileSync(join(result.outputDirectory, "combined.md"), "utf8");
      let previousHeading = -1;
      for (const heading of ["# Pages 1-256", "# Pages 257-512", "# Pages 513-513"]) {
        const offset = combined.indexOf(heading);
        assert.ok(offset > previousHeading);
        previousHeading = offset;
      }
      for (const range of ["1-256", "257-512", "513-513"]) {
        const target = join(result.outputDirectory, `pages-${range}`, "image.png").replaceAll("\\", "/");
        assert.equal(combined.split(target).length - 1, 2);
      }
      assert.doesNotMatch(combined, /docling-batches-/u);
      assert.equal(combined.match(/Literal document_artifacts\/image\.png stays\./gu)?.length, 3);
      assert.equal(readFileSync(input, "utf8"), "original PDF");
      assert.equal(
        readdirSync(paths.workRoot).some((name) => name.startsWith("docling-batches-")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the failed page range and removes batched intermediates", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-docling-failure-"));
    const paths = initVault(join(root, "vault"));
    writeFileSync(join(paths.workRoot, "network.pdf"), "original PDF");
    const runner = async (executable: string, args: readonly string[]) => {
      const result = {
        executable: `/pinned/${executable}`,
        args: [...args],
        code: 0,
        signal: null as NodeJS.Signals | null,
        timedOut: false,
        stdout: "",
        stderr: "",
      };
      if (executable === "qpdf" && args[0] === "--show-npages") return { ...result, stdout: "300\n" };
      if (executable === "qpdf") {
        const directory = dirname(args.at(-1)!);
        writeFileSync(join(directory, "part-001-256.pdf"), "first");
        writeFileSync(join(directory, "part-257-300.pdf"), "second");
        return result;
      }
      if (basename(args.at(-1)!, ".pdf").startsWith("pages-257-300-"))
        return { ...result, code: null, signal: "SIGKILL" as const };
      const output = args[args.indexOf("--output") + 1]!;
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "document.md"), "# First\n");
      return result;
    };
    try {
      await assert.rejects(
        convertWithDocling(
          paths,
          {
            inputRelativePath: "network.pdf",
            outputRelativeDirectory: "docling-output",
            mediaType: "application/pdf",
          },
          {
            run: runner,
            dependencyIdentity: () => ({ executable: "/pinned/docling", version: "Docling version 2.4.1" }),
          },
        ),
        /Docling conversion for pages 257-300 terminated by signal SIGKILL/u,
      );
      assert.equal(existsSync(join(paths.workRoot, "docling-output")), false);
      assert.equal(
        readdirSync(paths.workRoot).some((name) => name.startsWith("docling-batches-")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete qpdf ranges without starting Docling", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-docling-ranges-"));
    const paths = initVault(join(root, "vault"));
    writeFileSync(join(paths.workRoot, "network.pdf"), "original PDF");
    let doclingStarted = false;
    const runner = async (executable: string, args: readonly string[]) => {
      const result = {
        executable: `/pinned/${executable}`,
        args: [...args],
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
      };
      if (executable === "qpdf" && args[0] === "--show-npages") return { ...result, stdout: "513\n" };
      if (executable === "qpdf") {
        const directory = dirname(args.at(-1)!);
        writeFileSync(join(directory, "part-001-256.pdf"), "first");
        writeFileSync(join(directory, "part-258-513.pdf"), "gap");
        return result;
      }
      doclingStarted = true;
      return result;
    };
    try {
      await assert.rejects(
        convertWithDocling(
          paths,
          {
            inputRelativePath: "network.pdf",
            outputRelativeDirectory: "docling-output",
            mediaType: "application/pdf",
          },
          {
            run: runner,
            dependencyIdentity: () => ({ executable: "/pinned/docling", version: "Docling version 2.4.1" }),
          },
        ),
        /qpdf split page ranges are incomplete or invalid/u,
      );
      assert.equal(doclingStarted, false);
      assert.equal(existsSync(join(paths.workRoot, "docling-output")), false);
      assert.equal(
        readdirSync(paths.workRoot).some((name) => name.startsWith("docling-batches-")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal, control characters, and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    assert.throws(() => safeRelativePath(paths.wikiRoot, "../escape"));
    assert.throws(() => safeRelativePath(paths.wikiRoot, "bad\u0000name"));
    symlinkSync(paths.sourcesRoot, join(paths.wikiRoot, "link"));
    assert.throws(() => safeRelativePath(paths.wikiRoot, "link/file.md"));
  });
  it("honors requested atomic file modes despite a restrictive umask", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-umask-"));
    const target = join(root, "atomic.txt");
    const child = runChildSync(
      process.execPath,
      [
        "--import",
        "jiti/register",
        "--input-type=module",
        "-e",
        `import { strict as assert } from "node:assert";
import { statSync } from "node:fs";
const modulePath = process.env.PI_VAULT_MODULE;
const targetPath = process.env.PI_ATOMIC_PATH;
if (!modulePath || !targetPath) throw new Error("atomic write child environment is incomplete");
const loaded = await import(modulePath);
const { atomicWriteFile } = loaded.default ?? loaded;
const originalUmask = process.umask();
try {
  process.umask(0o077);
  for (const mode of [0o644, 0o666]) {
    atomicWriteFile(targetPath, "mode", mode);
    assert.equal(statSync(targetPath).mode & 0o777, mode);
  }
} finally {
  process.umask(originalUmask);
}
`,
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        env: {
          PI_VAULT_MODULE: "./src/vault.ts",
          PI_ATOMIC_PATH: target,
        },
      },
    );
    assert.equal(child.code, 0, child.stderr || child.stdout);
  });

  it("rejects a gitignore symlink before existing-vault Git operations", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const gitignore = join(paths.vaultRoot, ".gitignore");
    rmSync(gitignore);
    symlinkSync(join(root, "missing-gitignore"), gitignore);
    assert.throws(() => initVault(paths.vaultRoot));
    const report = doctor(paths.vaultRoot);
    assert.equal(report.ok, false);
    assert.equal(lstatSync(gitignore).isSymbolicLink(), true);
  });
  it("keeps durable vault data out of Gitignore while allowing user rules", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const gitignore = join(paths.vaultRoot, ".gitignore");
    const defaults = readFileSync(gitignore, "utf8");
    assert.equal(defaults.includes("/.pi-scholar/snapshots/"), false);
    assert.match(defaults, /\/inbox\/\n/u);
    assert.match(defaults, /\/\.pi-scholar\/qmd\/\n/u);
    assert.match(defaults, /\/\.pi-scholar\/work\/\n/u);
    writeFileSync(gitignore, `${defaults}node_modules/\n`);
    assert.doesNotThrow(() => initVault(paths.vaultRoot));
    for (const rule of ["/sources/", "/wiki/", "/quizzes/", "/.pi-scholar/snapshots/", "/.pi-scholar/state.sqlite"]) {
      writeFileSync(gitignore, `${defaults}node_modules/\n${rule}\n`);
      assert.throws(() => initVault(paths.vaultRoot));
    }
  });

  it("creates schema v5 page learning tables and rolls back transactions", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const tables = db.tableNames();
    for (const table of [
      "schema_meta",
      "pages",
      "page_learning",
      "page_prerequisites",
      "page_reviews",
      "quizzes",
      "quiz_questions",
      "question_pages",
      "quiz_answers",
      "question_results",
      "page_results",
      "quiz_evidence",
    ])
      assert.equal(tables.includes(table), true, `missing schema v5 table ${table}`);
    for (const table of [
      "review_cards",
      "card_bindings",
      "card_prerequisites",
      "card_lineage",
      "question_cards",
      "card_results",
      "raw_reviews",
    ])
      assert.equal(tables.includes(table), false, `removed schema table ${table} is still present`);
    assert.equal(
      db.get<{ schema_version: number }>("SELECT MAX(schema_version) AS schema_version FROM schema_meta")
        ?.schema_version,
      5,
    );
    const pagePrerequisitesSql = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_prerequisites'",
    )?.sql;
    const pageReviewsSql = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_reviews'",
    )?.sql;
    const questionPagesSql = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'question_pages'",
    )?.sql;
    const pageResultsSql = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_results'",
    )?.sql;
    const quizEvidenceSql = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quiz_evidence'",
    )?.sql;
    const quizQuestionsSql = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quiz_questions'",
    )?.sql;
    const sourcesSql = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sources'",
    )?.sql;
    assert.match(sourcesSql ?? "", /manifest_digest\s+TEXT/iu);
    const legacyQuestionKind = ["short", "answer"].join("-");
    assert.match(pagePrerequisitesSql ?? "", /PRIMARY KEY\s*\(\s*page_id\s*,\s*prerequisite_page_id\s*\)/iu);
    db.run(
      "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'open', NULL, NULL, NULL, NULL, NULL)",
      ["legacy-quiz", "2099-12-31"],
    );
    assert.match(pagePrerequisitesSql ?? "", /CHECK\s*\(\s*page_id\s*<>\s*prerequisite_page_id\s*\)/iu);
    assert.match(pageReviewsSql ?? "", /UNIQUE\s*\([^)]*quiz_id[^)]*page_id/iu);
    assert.match(questionPagesSql ?? "", /criterion_json\s+TEXT\s+NOT\s+NULL/iu);
    assert.match(questionPagesSql ?? "", /weight\s+REAL\s+NOT\s+NULL/iu);
    assert.match(pageResultsSql ?? "", /UNIQUE\s*\([^)]*quiz_id[^)]*page_id/iu);
    assert.match(quizEvidenceSql ?? "", /PRIMARY KEY\s*\(\s*quiz_id\s*,\s*reference\s*\)/iu);
    assert.match(
      quizQuestionsSql ?? "",
      /CHECK\s*\(\s*kind\s+IN\s*\(\s*'free-response'\s*,\s*'multiple-choice'\s*\)\s*\)/iu,
    );
    assert.throws(() =>
      db.run(
        "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, source_refs_json) VALUES (?, ?, 0, ?, ?, NULL, NULL, '[]')",
        ["legacy-question", "legacy-quiz", legacyQuestionKind, "Legacy question"],
      ),
    );
    assert.equal(/\bcard_id\b/iu.test(quizEvidenceSql ?? ""), false);
    const issueColumns = db.all<{ name: string }>("PRAGMA table_info(wiki_issues)").map((column) => column.name);
    assert.equal(issueColumns.includes("card_id"), false);
    assert.equal(
      db.all<{ table: string }>("PRAGMA foreign_key_list(page_prerequisites)").some((key) => key.table === "pages"),
      true,
    );
    assert.equal(
      db
        .all<{ table: string }>("PRAGMA foreign_key_list(question_pages)")
        .some((key) => key.table === "quiz_questions"),
      true,
    );
    assert.throws(() =>
      transaction(db, () => {
        db.run("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)", [
          "x",
          "{}",
          new Date().toISOString(),
        ]);
        throw new Error("rollback");
      }),
    );
    assert.equal(db.get("SELECT key FROM settings WHERE key = ?", ["x"]), undefined);
    db.close();
  });
  it("rejects partial and non-canonical schema v5 definitions", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-schema-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    db.exec("DROP TABLE settings");
    assert.throws(() => validateSchema(db), /missing tables/u);
    db.exec(`
      CREATE TABLE settings (
        key TEXT,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    assert.throws(() => validateSchema(db), /canonical schema v5/u);
    db.close();
  });
  it("rejects case-changed quoted CHECK literals in canonical schema", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-schema-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const canonicalSourcesSql = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sources'",
    )?.sql;
    assert.ok(canonicalSourcesSql);
    db.exec("DROP TABLE sources");
    db.exec(canonicalSourcesSql.replace("'url'", "'URL'"));
    assert.equal(Number(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0), 5);
    assert.throws(() => validateSchema(db), /canonical schema v5/u);
    db.close();
  });

  it("rolls back failed first-time schema creation atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-schema-"));
    const db = openDatabase(join(root, "state.sqlite"), { initializeSchema: false });
    assert.throws(
      () =>
        transaction(db, () => {
          db.exec(SCHEMA_SQL);
          db.run("INSERT INTO schema_meta (schema_version, applied_at) VALUES (?, ?)", [5, new Date().toISOString()]);
          db.exec("PRAGMA user_version = 5");
          validateSchema(db);
          throw new Error("abort schema creation");
        }),
      /abort schema creation/u,
    );
    assert.deepEqual(db.tableNames(), []);
    assert.equal(Number(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0), 0);
    db.close();
  });
  it("rejects incomplete WAL checkpoints while a reader pins frames", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-wal-"));
    const paths = initVault(join(root, "vault"));
    const writer = openDatabase(paths);
    const reader = openDatabase(paths, { readOnly: true, initializeSchema: false });
    try {
      reader.exec("BEGIN");
      reader.get("SELECT COUNT(*) AS count FROM settings");
      writer.run("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)", [
        `wal-pin-${randomUUID()}`,
        "{}",
        new Date().toISOString(),
      ]);
      assert.throws(() => writer.checkpoint(), /WAL checkpoint incomplete/u);
    } finally {
      try {
        reader.exec("ROLLBACK");
      } finally {
        reader.close();
        writer.close();
      }
    }
  });

  it("rejects unknown schema tables and follows no symlink reads", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    db.exec("CREATE TABLE rogue (value TEXT)");
    db.close();
    assert.throws(() => openDatabase(paths));
    const regular = join(root, "regular.txt");
    const link = join(root, "link.txt");
    writeFileSync(regular, "safe");
    symlinkSync(regular, link);
    assert.equal(readFileNoFollow(regular).toString("utf8"), "safe");
    assert.throws(() => readFileNoFollow(regular, 3));
    assert.throws(() => readFileNoFollow(link));
  });

  it("excludes a second writer and leaves doctor read-only", { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const lock = acquireWriterLock(paths);
    assert.throws(() => acquireWriterLock(paths, { waitMs: 0 }));
    lock.release();
    const before = readFileSync(paths.vaultConfigPath, "utf8");
    const report = doctor(paths.vaultRoot);
    assert.ok(report.checks.length > 0);
    assert.equal(readFileSync(paths.vaultConfigPath, "utf8"), before);
  });
  it("doctor enforces OKF root and concept conformance", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const initial = doctor(paths.vaultRoot);
    assert.equal(initial.checks.find((item) => item.name === "okf")?.status, "pass");
    const indexPath = join(paths.wikiRoot, "index.md");
    const index = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, index.replace('okf_version: "0.2"', 'okf_version: "0.1"'));
    assert.equal(doctor(paths.vaultRoot).checks.find((item) => item.name === "okf")?.status, "fail");
    writeFileSync(indexPath, index);
    writeFileSync(join(paths.wikiRoot, "malformed.md"), "---\ntitle: Missing type\n---\nbody\n");
    assert.equal(doctor(paths.vaultRoot).checks.find((item) => item.name === "okf")?.status, "fail");
  });
  it("doctor tolerates malformed bytes for a catalogued drifted page", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const wiki = new WikiService(db, paths);
    const created = await wiki.create({ path: "unsupported.md", body: "authored" });
    const pagePath = join(paths.wikiRoot, created.page.relativePath);
    const unsupported = Buffer.from("not an OKF concept\n\nraw unsupported bytes\n");
    writeFileSync(pagePath, unsupported);
    db.run("UPDATE pages SET status = 'drifted' WHERE page_id = ?", [created.page.pageId]);
    await wiki.refreshProjections();
    const report = doctor(paths.vaultRoot);
    assert.equal(report.checks.find((item) => item.name === "okf")?.status, "pass");
    assert.equal(report.checks.find((item) => item.name === "page-ids")?.status, "pass");
    assert.deepEqual(readFileSync(pagePath), unsupported);
    db.run("UPDATE pages SET status = 'active' WHERE page_id = ?", [created.page.pageId]);
    assert.equal(doctor(paths.vaultRoot).checks.find((item) => item.name === "okf")?.status, "fail");
    db.close();
  });

  it("doctor rejects a tampered quiz answer without rewriting the sheet", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const date = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const sheetPath = join(paths.quizzesRoot, date.slice(0, 4), date.slice(5, 7), `${date}.md`);
    const pageId = "doctor-page";
    const questionId = randomUUID();
    db.run(
      "INSERT INTO pages (page_id, relative_path, title, digest, revision, status, quiz_worthiness, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'eligible', ?, ?)",
      [pageId, "doctor.md", "Doctor page", "doctor-digest", now, now],
    );
    db.run(
      "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'open', ?, ?, NULL, NULL, NULL)",
      ["doctor-quiz", date, sheetPath, now],
    );
    db.run(
      "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, source_refs_json) VALUES (?, ?, 0, 'free-response', ?, NULL, NULL, '[]')",
      [questionId, "doctor-quiz", "Explain the page"],
    );
    db.run("INSERT INTO question_pages (question_id, page_id, criterion_json, weight) VALUES (?, ?, ?, ?)", [
      questionId,
      pageId,
      JSON.stringify("Identify the page's central idea"),
      1,
    ]);
    db.run("INSERT INTO quiz_answers (quiz_id, question_id, revision, answer_json, saved_at) VALUES (?, ?, 1, ?, ?)", [
      "doctor-quiz",
      questionId,
      JSON.stringify("expected"),
      now,
    ]);
    const quizService = new QuizService(db, paths);
    const sheet = quizService.renderSheet(
      {
        quizId: "doctor-quiz",
        date,
        revision: 1,
        status: "open",
        questions: [
          {
            questionId,
            quizId: "doctor-quiz",
            ordinal: 0,
            kind: "free-response",
            prompt: "Explain the page",
            pages: [{ pageId, criterion: "Identify the page's central idea", weight: 1 }],
            sourceRefs: [],
          },
        ],
      },
      { [questionId]: "expected" },
    );
    mkdirSync(join(sheetPath, ".."), { recursive: true });
    writeFileSync(sheetPath, sheet.replace("expected", "tampered"), "utf8");
    const tampered = readFileSync(sheetPath, "utf8");
    const report = doctor(paths.vaultRoot);
    assert.equal(report.checks.find((item) => item.name === "quiz-projections")?.status, "fail");
    assert.equal(readFileSync(sheetPath, "utf8"), tampered);
    db.close();
  });
  it("doctor accepts an expired quiz projection with incomplete answers", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const date = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const sheetPath = join(paths.quizzesRoot, date.slice(0, 4), date.slice(5, 7), `${date}.md`);
    const pageId = "expired-page";
    const questionId = randomUUID();
    db.run(
      "INSERT INTO pages (page_id, relative_path, title, digest, revision, status, quiz_worthiness, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'eligible', ?, ?)",
      [pageId, "expired.md", "Expired page", "expired-digest", now, now],
    );
    db.run(
      "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'expired', ?, ?, NULL, NULL, NULL)",
      ["expired-quiz", date, sheetPath, now],
    );
    db.run(
      "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, source_refs_json) VALUES (?, ?, 0, 'free-response', ?, NULL, NULL, '[]')",
      [questionId, "expired-quiz", "Explain the page"],
    );
    db.run("INSERT INTO question_pages (question_id, page_id, criterion_json, weight) VALUES (?, ?, ?, ?)", [
      questionId,
      pageId,
      JSON.stringify("Identify the page's central idea"),
      1,
    ]);
    const quizService = new QuizService(db, paths);
    const sheet = quizService.renderSheet(quizService.get(date)!);
    mkdirSync(join(sheetPath, ".."), { recursive: true });
    writeFileSync(sheetPath, sheet, "utf8");
    try {
      const report = doctor(paths.vaultRoot);
      assert.equal(report.checks.find((item) => item.name === "quiz-projections")?.status, "pass");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invokes children with argv and rejects NUL-bearing arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const result = runChildSync(process.execPath, ["-e", "process.stdout.write('ok')"], {
      cwd: root,
      timeoutMs: 5_000,
    });
    assert.equal(result.stdout, "ok");
    assert.throws(() => runChildSync(process.execPath, ["-e\u0000bad"], { cwd: root }));
    writeFileSync(join(root, "kept.txt"), "doctor must not mutate");
  });
  it("caps child output and reports truncation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const result = await runChild(process.execPath, ["-e", "process.stdout.write('abcdef')"], {
      cwd: root,
      timeoutMs: 5_000,
      maxOutputBytes: 4,
    });
    assert.equal(result.stdout, "abcd");
    assert.equal(result.outputOverflowed, true);
  });
  it("counts capped child output by raw bytes across split UTF-8 chunks", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const result = await runChild(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0xe2]), () => process.stdout.write(Buffer.from([0x82, 0xac])))"],
      { cwd: root, timeoutMs: 5_000, maxOutputBytes: 4 },
    );
    assert.equal(result.stdout, "€");
    assert.equal(result.outputOverflowed, false);
  });
  it("kills detached descendants after a timed-out leader exits", async () => {
    // This integration check intentionally uses the real process-group timer; fake clocks cannot drive OS signals.
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const descendantPidPath = join(root, "descendant.pid");
    const heartbeatPath = join(root, "descendant.heartbeat");
    const descendantScript = [
      "const { writeFileSync } = require('node:fs');",
      "const path = process.env.PI_DESCENDANT_FILE;",
      "const tick = () => writeFileSync(path, String(Date.now()));",
      "tick();",
      "setInterval(tick, 25);",
      "process.on('SIGTERM', () => {});",
    ].join("\n");
    const leaderScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
      "writeFileSync(process.env.PI_DESCENDANT_PID_FILE, String(child.pid));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const result = await runChild(process.execPath, ["-e", leaderScript], {
      cwd: root,
      timeoutMs: 500,
      env: { PI_DESCENDANT_FILE: heartbeatPath, PI_DESCENDANT_PID_FILE: descendantPidPath },
    });
    assert.equal(result.timedOut, true);
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    const heartbeatAtReturn = readFileSync(heartbeatPath, "utf8");
    try {
      await delay(150);
      assert.equal(readFileSync(heartbeatPath, "utf8"), heartbeatAtReturn);
    } finally {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {}
    }
  });
  it("doctor rejects a non-removed source row whose packet is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO sources (source_id, kind, status, display_name, original_name, captured_at, digest, manifest_path, created_at, updated_at) VALUES (?, 'text', 'published', ?, ?, ?, ?, ?, ?, ?)",
      [
        "reverse-source",
        "Reverse source",
        "reverse.txt",
        now,
        "digest",
        join(paths.sourcesRoot, "reverse-source"),
        now,
        now,
      ],
    );
    db.close();
    const report = doctor(paths.vaultRoot);
    assert.equal(report.checks.find((item) => item.name === "source-packets")?.status, "fail");
  });
  it("previews current source dependents without mutating dependencies", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const sources = new SourceService(db, paths);
    const wiki = new WikiService(db, paths);
    try {
      writeFileSync(join(paths.inboxRoot, "preview.txt"), "evidence\n");
      const entry = (await sources.discover())[0];
      if (!entry) throw new Error("source entry was not discovered");
      const result = await sources.admitClaim(await sources.claim(entry));
      const chunkId = result.manifest.chunks[0]?.chunkId;
      if (!chunkId) throw new Error("source chunk is missing");
      const page = await wiki.create({
        path: "preview.md",
        body: `# Grounded\n\nGrounded at [^${chunkId}].\n`,
      });
      const now = new Date().toISOString();
      db.run(
        "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'submitted', NULL, ?, ?, NULL, NULL)",
        ["preview-submitted", "2099-01-03", now, now],
      );
      db.run(
        "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, source_refs_json) VALUES (?, ?, 0, 'free-response', ?, NULL, NULL, ?)",
        ["preview-question", "preview-submitted", "Explain", "[]"],
      );
      db.run("INSERT INTO question_pages (question_id, page_id, criterion_json, weight) VALUES (?, ?, ?, ?)", [
        "preview-question",
        page.page.pageId,
        JSON.stringify("Explain"),
        1,
      ]);
      db.run(
        "INSERT INTO quiz_evidence (quiz_id, reference, page_id, relative_path, anchor, heading, page_digest, page_revision, text_digest, excerpt, excerpt_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "preview-submitted",
          "preview-evidence",
          page.page.pageId,
          page.page.relativePath,
          "#grounded",
          "Grounded",
          page.page.digest,
          page.page.revision,
          "text-digest",
          `Grounded at [^${chunkId}].`,
          "excerpt-digest",
        ],
      );
      const dependenciesBefore = db.all<Record<string, unknown>>(
        "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies ORDER BY source_id, page_id, chunk_id, relation",
      );
      assert.deepEqual(dependenciesBefore, []);
      const initialPreview = sources.removalPreview(result.sourceId);
      assert.deepEqual(initialPreview.dependentPageIds, [page.page.pageId]);
      assert.deepEqual(
        db.all<Record<string, unknown>>(
          "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies ORDER BY source_id, page_id, chunk_id, relation",
        ),
        dependenciesBefore,
      );
      assert.equal(sources.removalPreview(result.sourceId).confirmationId, initialPreview.confirmationId);
      await assert.rejects(
        sources.removeConfirmed(result.sourceId, initialPreview.confirmationId),
        /submitted quizzes without page settlement/iu,
      );
      const pagePath = join(paths.wikiRoot, page.page.relativePath);
      writeFileSync(pagePath, `${page.content}\nExternal edit.\n`);
      const editedPreview = sources.removalPreview(result.sourceId);
      assert.notEqual(editedPreview.confirmationId, initialPreview.confirmationId);
      await assert.rejects(
        sources.removeConfirmed(result.sourceId, initialPreview.confirmationId),
        (error: unknown) => {
          if (!(error instanceof Error) || !("code" in error)) return false;
          assert.equal(error.code, "revision-conflict");
          assert.match(error.message, /stale removal confirmation/iu);
          return true;
        },
      );
      writeFileSync(pagePath, page.content);
      assert.equal(sources.removalPreview(result.sourceId).confirmationId, initialPreview.confirmationId);
      rmSync(pagePath);
      assert.throws(() => sources.removalPreview(result.sourceId), /ENOENT|no such file/iu);
      writeFileSync(pagePath, page.content);
      db.run("INSERT INTO source_dependencies (source_id, page_id, chunk_id, relation) VALUES (?, NULL, ?, ?)", [
        result.sourceId,
        chunkId,
        "citation",
      ]);
      const staleRows = db.all<Record<string, unknown>>(
        "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies ORDER BY source_id, page_id, chunk_id, relation",
      );
      const confirmationPreview = sources.removalPreview(result.sourceId);
      assert.deepEqual(confirmationPreview.dependentPageIds, [page.page.pageId]);
      assert.deepEqual(
        db.all<Record<string, unknown>>(
          "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies ORDER BY source_id, page_id, chunk_id, relation",
        ),
        staleRows,
      );
      await assert.rejects(
        sources.removeConfirmed(result.sourceId, confirmationPreview.confirmationId),
        /submitted quizzes without page settlement/iu,
      );
      assert.deepEqual(
        db
          .all<Record<string, unknown>>(
            "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies ORDER BY source_id, page_id, chunk_id, relation",
          )
          .map((row) => ({ ...row })),
        [
          { source_id: result.sourceId, page_id: null, chunk_id: chunkId, relation: "citation" },
          { source_id: result.sourceId, page_id: page.page.pageId, chunk_id: chunkId, relation: "citation" },
        ],
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("doctor streams source artifacts and rejects packet tampering", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const sources = new SourceService(db, paths);
    let dbClosed = false;
    const input = Buffer.from(Array.from({ length: 512 }, (_, index) => `line-${index}-${"x".repeat(240)}\n`).join(""));
    writeFileSync(join(paths.inboxRoot, "doctor.txt"), input);
    try {
      const entry = (await sources.discover())[0];
      if (!entry) throw new Error("source entry was not discovered");
      const result = await sources.admitClaim(await sources.claim(entry));
      db.close();
      dbClosed = true;
      assert.equal(doctor(paths.vaultRoot).checks.find((item) => item.name === "source-packets")?.status, "pass");

      const originalRecord = result.manifest.files[0];
      const chunkRecord = result.manifest.chunks[0];
      if (!originalRecord || !chunkRecord) throw new Error("source packet records are incomplete");
      const originalPath = join(result.packetPath, "original", originalRecord.path);
      const extractedPath = join(result.packetPath, "extracted.md");
      const chunkPath = join(result.packetPath, "chunks", "0001.md");
      const originalBytes = readFileSync(originalPath);
      const extractedBytes = readFileSync(extractedPath);
      const chunkBytes = readFileSync(chunkPath);
      writeFileSync(originalPath, Buffer.from("tampered original\n"));
      assert.equal(doctor(paths.vaultRoot).checks.find((item) => item.name === "source-packets")?.status, "fail");
      writeFileSync(originalPath, originalBytes);
      writeFileSync(extractedPath, Buffer.from("tampered extraction\n"));
      assert.equal(doctor(paths.vaultRoot).checks.find((item) => item.name === "source-packets")?.status, "fail");
      writeFileSync(extractedPath, extractedBytes);
      writeFileSync(chunkPath, Buffer.from("tampered chunk\n"));
      assert.equal(doctor(paths.vaultRoot).checks.find((item) => item.name === "source-packets")?.status, "fail");
      writeFileSync(chunkPath, chunkBytes);
      assert.equal(doctor(paths.vaultRoot).checks.find((item) => item.name === "source-packets")?.status, "pass");
    } finally {
      if (!dbClosed) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("doctor rejects a missing authored wiki snapshot file", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const page = await new WikiService(db, paths).create({ path: "missing-snapshot.md", body: "body" });
    rmSync(join(paths.metadataRoot, "snapshots", "wiki", `${page.page.pageId}.md`));
    db.close();
    const report = doctor(paths.vaultRoot);
    assert.equal(report.checks.find((item) => item.name === "page-drift")?.status, "fail");
  });

  it("doctor rejects a missing authored wiki snapshot catalog row", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    const page = await new WikiService(db, paths).create({ path: "missing-snapshot-row.md", body: "body" });
    db.run("DELETE FROM authored_snapshots WHERE relative_path = ?", [page.page.relativePath]);
    db.close();
    const report = doctor(paths.vaultRoot);
    assert.equal(report.checks.find((item) => item.name === "page-drift")?.status, "fail");
  });
  it("doctor reports unreadable wiki and quiz traversal as failing checks", () => {
    const wikiRoot = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const wikiPaths = initVault(join(wikiRoot, "vault"));
    const unreadableWiki = join(wikiPaths.wikiRoot, "unreadable");
    mkdirSync(unreadableWiki);
    writeFileSync(join(unreadableWiki, "page.md"), "unreadable");
    chmodSync(unreadableWiki, 0o000);
    try {
      const report = doctor(wikiPaths.vaultRoot);
      assert.equal(report.checks.find((item) => item.name === "page-ids")?.status, "fail");
    } finally {
      chmodSync(unreadableWiki, 0o700);
    }

    const quizRoot = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const quizPaths = initVault(join(quizRoot, "vault"));
    const unreadableQuiz = join(quizPaths.quizzesRoot, "2025");
    mkdirSync(unreadableQuiz);
    writeFileSync(join(unreadableQuiz, "01.md"), "unreadable");
    chmodSync(unreadableQuiz, 0o000);
    try {
      const report = doctor(quizPaths.vaultRoot);
      assert.equal(report.checks.find((item) => item.name === "quiz-projections")?.status, "fail");
    } finally {
      chmodSync(unreadableQuiz, 0o700);
    }
  });

  it("doctor rejects orphan authored wiki snapshot files", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    await new WikiService(db, paths).create({ path: "orphan-snapshot.md", body: "body" });
    writeFileSync(join(paths.metadataRoot, "snapshots", "wiki", `${randomUUID()}.md`), "orphan");
    db.close();
    const report = doctor(paths.vaultRoot);
    assert.equal(report.checks.find((item) => item.name === "page-drift")?.status, "fail");
  });

  it("doctor rejects non-UUID authored wiki snapshot filenames", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    await new WikiService(db, paths).create({ path: "invalid-snapshot.md", body: "body" });
    writeFileSync(join(paths.metadataRoot, "snapshots", "wiki", "not-a-page-id.md"), "invalid");
    db.close();
    const report = doctor(paths.vaultRoot);
    assert.equal(report.checks.find((item) => item.name === "page-drift")?.status, "fail");
  });

  it("pins a bare executable to its first PATH resolution", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const first = join(root, "first");
    const second = join(root, "second");
    const relativeCandidate = join(root, "relative");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(relativeCandidate);
    const name = `pi-scholar-pin-${randomUUID()}`;
    const firstExecutable = join(first, name);
    const secondExecutable = join(second, name);
    const relativeExecutable = join(relativeCandidate, name);
    writeFileSync(firstExecutable, "#!/bin/sh\nprintf first\n", { mode: 0o700 });
    writeFileSync(secondExecutable, "#!/bin/sh\nprintf second\n", { mode: 0o700 });
    writeFileSync(relativeExecutable, "#!/bin/sh\nprintf relative\n", { mode: 0o700 });
    chmodSync(firstExecutable, 0o700);
    chmodSync(secondExecutable, 0o700);
    chmodSync(relativeExecutable, 0o700);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${relative(process.cwd(), relativeCandidate)}${delimiter}${first}`;
      const firstResult = runChildSync(name, [], { cwd: root, timeoutMs: 5_000 });
      assert.equal(firstResult.stdout, "first");
      assert.equal(firstResult.executable, realpathSync(firstExecutable));
      process.env.PATH = second;
      const secondResult = runChildSync(name, [], { cwd: root, timeoutMs: 5_000 });
      assert.equal(secondResult.stdout, "first");
      assert.equal(secondResult.executable, firstResult.executable);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
  it("applies the same fail-closed Git option validation to async and sync adapters", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    for (const args of [
      ["push", "--force=true"],
      ["push", "--force-with-lease=origin/main"],
    ] as const) {
      assert.throws(() => runGitSync(paths, args), /unsafe Git operation/u);
      await assert.rejects(runGit(paths, args), /unsafe Git operation/u);
    }
    const assignment = ["status", "--unknown=value"] as const;
    assert.throws(() => runGitSync(paths, assignment), /Git options must use separate argv values/u);
    await assert.rejects(runGit(paths, assignment), /Git options must use separate argv values/u);
    assert.equal(runGitSync(paths, ["status", "--porcelain=v2", "--branch", "--ahead-behind"]).code, 0);
  });
  it("redacts Git push diagnostics from the public result", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-git-push-"));
    const paths = initVault(join(root, "vault"));
    const realGit = runChildSync("git", ["--version"], { cwd: paths.vaultRoot, timeoutMs: 5_000 }).executable;
    const wrapperDirectory = join(root, "bin");
    mkdirSync(wrapperDirectory);
    writeFileSync(
      join(wrapperDirectory, "git"),
      `#!/bin/sh
for arg
do
  if [ "$arg" = "push" ]; then
    printf '%s\n' "remote=https://alice:secret@example.invalid/repo.git path=${paths.vaultRoot} ref=refs/heads/main"
    printf '%s\n' "fatal: credential=top-secret subprocess=/private/git-helper" >&2
    exit 73
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`,
      { mode: 0o700 },
    );
    const child = runChildSync(
      process.execPath,
      [
        "--import",
        "jiti/register",
        "--input-type=module",
        "-e",
        `const modulePath = process.env.PI_GIT_MODULE;
const vaultRoot = process.env.PI_VAULT_ROOT;
if (!modulePath || !vaultRoot) throw new Error("push child environment is incomplete");
const loaded = await import(modulePath);
const { safePush } = loaded.default ?? loaded;
const result = safePush({ vaultRoot });
process.stdout.write(JSON.stringify({ output: result.output, error: result.error }));
`,
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        env: {
          PATH: `${wrapperDirectory}${delimiter}${process.env.PATH ?? ""}`,
          PI_GIT_MODULE: "./src/external/git.ts",
          PI_VAULT_ROOT: paths.vaultRoot,
        },
      },
    );
    assert.equal(child.code, 0, child.stderr || child.stdout);
    assert.deepEqual(JSON.parse(child.stdout), {
      output: "Git push failed",
      error: "PUSH_FAILED",
    });
  });
  it("treats Git checkpoint exclusions as literal path names", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const wildcardPath = join(paths.wikiRoot, "a*b.md");
    const siblingPath = join(paths.wikiRoot, "ab.md");
    writeFileSync(wildcardPath, "excluded\n");
    writeFileSync(siblingPath, "included\n");
    assert.equal(runGitSync(paths, ["add", "--", "wiki/ab.md"]).code, 0);
    const result = localCheckpointCommit(paths, "test: literal exclusion", [wildcardPath]);
    assert.equal(result.committed, true);
    assert.equal(runGitSync(paths, ["show", "HEAD:wiki/ab.md"]).stdout, "included\n");
    assert.equal(runGitSync(paths, ["ls-files", "--", ":(literal)wiki/a*b.md"]).stdout, "");

    writeFileSync(wildcardPath, "excluded and staged\n");
    assert.equal(runGitSync(paths, ["add", "--", ":(literal)wiki/a*b.md"]).code, 0);
    assert.throws(
      () => localCheckpointCommit(paths, "test: reject staged exclusion", [wildcardPath]),
      /Git checkpoint has pre-staged excluded changes/u,
    );
  });
  it("commits the validated index while a child Git wrapper edits the worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const includedPath = join(paths.wikiRoot, "included.md");
    writeFileSync(includedPath, "validated\n");
    const realGit = runChildSync("git", ["--version"], { cwd: paths.vaultRoot, timeoutMs: 5_000 }).executable;
    const wrapperDirectory = join(root, "bin");
    mkdirSync(wrapperDirectory);
    writeFileSync(
      join(wrapperDirectory, "git"),
      `#!/bin/sh
for arg
do
  if [ "$arg" = "commit" ]; then
    printf '%s\n' "later" > ${JSON.stringify(includedPath)}
    break
  fi
  if [ "$arg" = "rev-parse" ]; then
    printf '%s\n' "follow-up lookup disabled" >&2
    exit 97
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`,
      { mode: 0o700 },
    );
    const child = runChildSync(
      process.execPath,
      [
        "--import",
        "jiti/register",
        "--input-type=module",
        "-e",
        `const modulePath = process.env.PI_GIT_MODULE;
const vaultRoot = process.env.PI_VAULT_ROOT;
if (!modulePath || !vaultRoot) throw new Error("checkpoint child environment is incomplete");
const loaded = await import(modulePath);
const { localCheckpointCommit } = loaded.default ?? loaded;
const result = localCheckpointCommit({ vaultRoot }, "test: indexed checkpoint");
if (result.commitId !== undefined) throw new Error("checkpoint unexpectedly looked up a commit id");
`,
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        env: {
          PATH: `${wrapperDirectory}${delimiter}${process.env.PATH ?? ""}`,
          PI_GIT_MODULE: "./src/external/git.ts",
          PI_VAULT_ROOT: paths.vaultRoot,
        },
      },
    );
    assert.equal(child.code, 0, child.stderr || child.stdout);
    assert.equal(readFileSync(includedPath, "utf8"), "later\n");
    assert.equal(runGitSync(paths, ["show", "HEAD:wiki/included.md"]).stdout, "validated\n");
    assert.match(runGitSync(paths, ["status", "--porcelain=v2"]).stdout, /wiki\/included\.md/u);
  });

  it("rejects Git dependency identity outside a work tree", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = { vaultRoot: root } as VaultPaths;
    assert.throws(() => gitDependencyIdentity(paths), /git rev-parse --is-inside-work-tree failed/u);
  });
  it("completes every byte when a file handle short-writes", async () => {
    const chunks: number[] = [];
    const handle = {
      write: async (
        _buffer: Uint8Array,
        _offset: number,
        length: number,
      ): Promise<{ bytesWritten: number; buffer: Uint8Array }> => {
        const bytesWritten = Math.min(2, length);
        chunks.push(bytesWritten);
        return { bytesWritten, buffer: _buffer };
      },
    } as unknown as FileHandle;
    const bytes = Buffer.from("short writes must not lose bytes");
    await writeFully(handle, bytes);
    assert.equal(
      chunks.reduce((sum, size) => sum + size, 0),
      bytes.byteLength,
    );
    assert.ok(chunks.length > 1);
  });
});
