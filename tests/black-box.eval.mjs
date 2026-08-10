import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runActor, runJudge } from "./eval-support.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");
const maxFixtureBytes = 32 * 1024;
const corpusSetting = process.env.PI_SCHOLAR_CORPUS?.trim();
if (!corpusSetting) throw new Error("Pi Scholar eval prerequisite unavailable (corpus): set PI_SCHOLAR_CORPUS");

const corpusRoot = resolve(corpusSetting);
try {
  if (!statSync(corpusRoot).isDirectory()) throw new Error("not a directory");
} catch (error) {
  throw new Error(`Pi Scholar eval prerequisite unavailable (corpus): ${corpusRoot}: ${error.message}`);
}

const fixturePath = join(corpusRoot, "native", "text", "plain-notes.txt");
let fixtureStat;
try {
  fixtureStat = statSync(fixturePath);
  if (!fixtureStat.isFile()) throw new Error("not a regular file");
  if (fixtureStat.size > maxFixtureBytes) throw new Error(`exceeds ${maxFixtureBytes} bytes`);
} catch (error) {
  throw new Error(`Pi Scholar eval prerequisite unavailable (plain-notes fixture): ${fixturePath}: ${error.message}`);
}
const fixtureBytes = readFileSync(fixturePath);
const fixtureText = fixtureBytes.toString("utf8");
if (!Buffer.from(fixtureText, "utf8").equals(fixtureBytes))
  throw new Error(`Pi Scholar eval prerequisite unavailable (plain-notes fixture): ${fixturePath}: not valid UTF-8`);

function commandDiagnostic(result) {
  return [
    result.error?.message,
    result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`,
    result.stderr?.slice(-4096),
    result.stdout?.slice(-4096),
  ]
    .filter(Boolean)
    .join("\n");
}

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    timeout: 2 * 60 * 1000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, commandDiagnostic(result));
  assert.equal(result.status, 0, commandDiagnostic(result));
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`Scholar CLI returned invalid JSON: ${error.message}\n${result.stdout.slice(-4096)}`);
  }
}

function snapshotTree(root) {
  const snapshot = [];
  function visit(path, relativeRoot) {
    const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const absolutePath = join(path, entry.name);
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      const stat = lstatSync(absolutePath);
      if (stat.isDirectory()) {
        snapshot.push({ path: relativePath, type: "directory" });
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        snapshot.push({ path: relativePath, type: "file", bytes: readFileSync(absolutePath).toString("base64") });
      } else if (stat.isSymbolicLink()) {
        snapshot.push({ path: relativePath, type: "symlink", target: readlinkSync(absolutePath) });
      } else {
        snapshot.push({ path: relativePath, type: "other" });
      }
    }
  }
  visit(root, "");
  return snapshot;
}

function domainSnapshot(vault, names) {
  return Object.fromEntries(names.map((name) => [name, snapshotTree(join(vault, name))]));
}

function assertDomainSnapshot(vault, expected) {
  for (const [name, snapshot] of Object.entries(expected))
    assert.deepEqual(snapshotTree(join(vault, name)), snapshot, `${name} tree changed`);
}

function localDate() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function doctor(vault) {
  const report = runCli(["doctor", vault]);
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  return report;
}

test("pasted source is staged pending extraction", async () => {
  const trialRoot = mkdtempSync(join(tmpdir(), "pi-scholar-pasted-eval-"));
  const vault = join(trialRoot, "vault");
  try {
    const initialized = runCli(["init", vault]);
    assert.equal(initialized.ok, true);
    const initial = domainSnapshot(vault, ["sources", "wiki", "quizzes"]);
    const prompt = [
      "Call exactly one Scholar tool: scholar_add. Do not call any other tool.",
      "Use exactly the following JSON argument object; preserve the text value exactly after JSON decoding.",
      "After the call, answer concisely that the source is staged and pending extraction.",
      JSON.stringify({
        kind: "pasted",
        text: fixtureText,
        name: "plain-notes.txt",
        displayName: "plain-notes.txt",
        originalName: "plain-notes.txt",
        mediaType: "text/plain",
      }),
    ].join("\n");

    const actor = await runActor({ cwd: vault, prompt });
    assert.deepEqual(
      actor.toolCalls.map((call) => call.name),
      ["scholar_add"],
    );
    const [call] = actor.toolCalls;
    assert.equal(call.args.kind, "pasted");
    assert.equal(call.args.text, fixtureText);
    assert.equal(call.result?.details?.source?.status, "pending");

    const inboxEntries = readdirSync(join(vault, "inbox"), { withFileTypes: true });
    assert.equal(inboxEntries.length, 1);
    assert.equal(inboxEntries[0].isDirectory(), true);
    const envelopeRoot = join(vault, "inbox", inboxEntries[0].name);
    assert.deepEqual(readdirSync(envelopeRoot).sort(), [".pi-scholar-source.json", "payload"]);
    const metadata = JSON.parse(readFileSync(join(envelopeRoot, ".pi-scholar-source.json"), "utf8"));
    assert.equal(metadata.requestedKind, "pasted");
    assert.equal(metadata.kind, "text");
    assert.equal(metadata.payload, "payload");
    assert.deepEqual(readFileSync(join(envelopeRoot, metadata.payload)), fixtureBytes);
    assertDomainSnapshot(vault, initial);

    const report = doctor(vault);
    const rubric =
      "Pass only if the actor answer is concise, accurately says the pasted source was staged or is pending extraction, and does not claim extraction, publication, or addition to the trusted wiki.";
    const verdict = await runJudge({
      rubric,
      evidence: {
        actorAnswer: actor.answer,
        scholarCalls: actor.toolCalls,
        artifacts: { envelopeMetadata: metadata, doctor: { ok: report.ok } },
      },
    });
    assert.equal(verdict.pass, true, verdict.reason);
  } finally {
    rmSync(trialRoot, { recursive: true, force: true });
  }
});

test("daily quiz is guarded in a fresh vault", async () => {
  const trialRoot = mkdtempSync(join(tmpdir(), "pi-scholar-quiz-eval-"));
  const vault = join(trialRoot, "vault");
  try {
    const initialized = runCli(["init", vault]);
    assert.equal(initialized.ok, true);
    const initial = domainSnapshot(vault, ["inbox", "sources", "wiki", "quizzes"]);
    const dateBefore = localDate();

    const actor = await runActor({ cwd: vault, prompt: "/skill:daily" });
    const dateAfter = localDate();
    assert.deepEqual(
      actor.toolCalls.map((call) => call.name),
      ["scholar_get_daily_context"],
    );
    const context = actor.toolCalls[0].result?.details;
    assert.equal([dateBefore, dateAfter].includes(context?.date), true);
    assert.equal(context?.initializationEnabled, true);
    assert.equal(context?.expiredCount, 0);
    assert.deepEqual(context?.eligiblePages, []);
    assert.deepEqual(context?.evidence, []);
    assert.equal(Object.hasOwn(context, "quiz"), false);
    assert.equal(context?.message, "Initialization maintenance is active; quiz publication is blocked.");
    assertDomainSnapshot(vault, initial);

    const report = doctor(vault);
    const rubric =
      "Pass only if the actor answer is concise, reports the guarded quiz outcome with the shown date and expiry count, and does not claim a quiz was published.";
    const verdict = await runJudge({
      rubric,
      evidence: {
        actorAnswer: actor.answer,
        scholarCalls: actor.toolCalls,
        artifacts: { quizContext: context, doctor: { ok: report.ok } },
      },
    });
    assert.equal(verdict.pass, true, verdict.reason);
  } finally {
    rmSync(trialRoot, { recursive: true, force: true });
  }
});
