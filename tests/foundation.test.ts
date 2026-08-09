import { strict as assert } from "node:assert";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { openDatabase, transaction } from "../src/database.js";
import { doctor } from "../src/doctor.js";
import { runChildSync } from "../src/external/process.js";
import { acquireWriterLock, initVault, readFileNoFollow, resolveVault, safeRelativePath } from "../src/vault.js";

describe("vault foundation", () => {
  it("initializes exactly the product roots and discovers from a child directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    for (const name of [".pi-scholar", "inbox", "sources", "wiki", "quizzes", ".git"]) assert.equal(lstatSync(join(paths.vaultRoot, name)).isDirectory(), true);
    assert.equal(existsSync(paths.vaultConfigPath), true);
    const nested = join(paths.wikiRoot, "nested");
    mkdirSync(nested);
    const discovered = resolveVault(nested);
    assert.equal(discovered.vaultId, paths.vaultId);
  });

  it("rejects traversal, control characters, and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    assert.throws(() => safeRelativePath(paths.wikiRoot, "../escape"));
    assert.throws(() => safeRelativePath(paths.wikiRoot, "bad\u0000name"));
    symlinkSync(paths.sourcesRoot, join(paths.wikiRoot, "link"));
    assert.throws(() => safeRelativePath(paths.wikiRoot, "link/file.md"));
  });

  it("creates the complete schema and rolls back transactions", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const paths = initVault(join(root, "vault"));
    const db = openDatabase(paths);
    assert.ok(db.tableNames().includes("review_cards"));
    assert.ok(db.tableNames().includes("question_results"));
    assert.throws(() => transaction(db, () => {
      db.run("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)", ["x", "{}", new Date().toISOString()]);
      throw new Error("rollback");
    }));
    assert.equal(db.get("SELECT key FROM settings WHERE key = ?", ["x"]), undefined);
    db.close();
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

  it("invokes children with argv and rejects NUL-bearing arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-"));
    const result = runChildSync(process.execPath, ["-e", "process.stdout.write('ok')"], { cwd: root, timeoutMs: 5_000 });
    assert.equal(result.stdout, "ok");
    assert.throws(() => runChildSync(process.execPath, ["-e\u0000bad"], { cwd: root }));
    writeFileSync(join(root, "kept.txt"), "doctor must not mutate");
  });
});
