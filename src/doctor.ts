import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { atomizeExtraction } from "./sources.js";
import { gitDependencyIdentity, gitStatus } from "./external/git.js";
import { doclingDependencyIdentity } from "./external/docling.js";
import { qmdDependencyIdentity, qmdScopeCheck } from "./external/qmd.js";
import { openDatabase, SCHEMA_VERSION, validateSchema, type ScholarDatabase } from "./database.js";
import { QuizService } from "./quiz.js";
import { localDate, SchedulerService } from "./scheduler.js";
import type { DoctorCheck, DoctorReport, JsonValue } from "./contracts.js";
import { readFileNoFollow, resolveVault, safeRelativePath, type VaultPaths } from "./vault.js";

function check(name: string, status: DoctorCheck["status"], message: string, details?: JsonValue): DoctorCheck {
  return details === undefined ? { name, status, message } : { name, status, message, details };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
type DependencyCache = { readonly fingerprint: string; readonly check: DoctorCheck };
const dependencyCheckCache = new Map<string, DependencyCache>();

function dependencyFingerprint(name: string): string {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !directory.startsWith("/")) continue;
    const candidate = join(directory, name);
    try {
      const executable = realpathSync(candidate);
      const stat = statSync(executable);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      return `${pathValue}\u0000${executable}\u0000${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      // Try the next PATH entry.
    }
  }
  return `${pathValue}\u0000missing`;
}
function collectFiles(root: string, suffix: string, output: string[] = [], prefix = ""): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      output.push(`SYMLINK:${relativePath}`);
    } else if (entry.isDirectory()) {
      collectFiles(absolutePath, suffix, output, relativePath);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      output.push(relativePath);
    }
  }
  return output;
}

function checkRoots(paths: VaultPaths): DoctorCheck {
  const roots = [
    paths.vaultRoot,
    paths.metadataRoot,
    join(paths.metadataRoot, "snapshots"),
    join(paths.metadataRoot, "snapshots", "wiki"),
    paths.inboxRoot,
    paths.sourcesRoot,
    paths.wikiRoot,
    paths.quizzesRoot,
    paths.qmdRoot,
    paths.workRoot,
  ];
  for (const root of roots) {
    try {
      const stat = lstatSync(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return check("roots", "fail", `Root is not a real directory: ${root}`);
    } catch (error) {
      return check("roots", "fail", `Root is unavailable: ${root}: ${errorMessage(error)}`);
    }
  }
  for (const [label, path] of [["vault.json", paths.vaultConfigPath], [".gitignore", join(paths.vaultRoot, ".gitignore")]] as const) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) return check("roots", "fail", `${label} is not a regular file: ${path}`);
      readFileNoFollow(path);
    } catch (error) {
      return check("roots", "fail", `${label} is unavailable or unsafe: ${errorMessage(error)}`);
    }
  }
  return check("roots", "pass", "All product roots and vault metadata are real directories/files");
}

function checkDatabase(paths: VaultPaths): DoctorCheck[] {
  try {
    const stat = lstatSync(paths.databasePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return [check("schema", "fail", `Database is not a regular file: ${paths.databasePath}`)];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [check("schema", "fail", `Database is missing: ${paths.databasePath}`)];
    return [check("schema", "fail", `Database cannot be inspected: ${errorMessage(error)}`)];
  }
  let db: ScholarDatabase | undefined;
  try {
    db = openDatabase(paths, { readOnly: true, initializeSchema: false });
    validateSchema(db);
    const schema = check("schema", "pass", `Schema version ${SCHEMA_VERSION} is complete`);
    const integrity = db.integrityCheck();
    const integrityCheck = integrity.length === 1 && integrity[0] === "ok" ? check("integrity", "pass", "SQLite integrity_check passed") : check("integrity", "fail", `SQLite integrity_check failed: ${integrity.join(", ")}`);
    const foreignKeys = db.all<{ table: string; rowid: number; parent: string; fkid: number }>("PRAGMA foreign_key_check");
    const foreignKeyCheck = foreignKeys.length === 0 ? check("foreign-keys", "pass", "SQLite foreign-key check passed") : check("foreign-keys", "fail", `${foreignKeys.length} foreign-key violations found`);
    return [schema, integrityCheck, foreignKeyCheck];
  } catch (error) {
    return [check("schema", "fail", `Database cannot be inspected read-only: ${errorMessage(error)}`)];
  } finally {
    db?.close();
  }
}

function checkPackets(paths: VaultPaths): DoctorCheck {
  let entries;
  try {
    entries = readdirSync(paths.sourcesRoot, { withFileTypes: true });
  } catch (error) {
    return check("source-packets", "fail", `Cannot inspect source packets: ${errorMessage(error)}`);
  }
  let db: ScholarDatabase | undefined;
  try {
    db = openDatabase(paths, { readOnly: true, initializeSchema: false });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Invalid source packet entry: ${entry.name}`);
      const packet = join(paths.sourcesRoot, entry.name);
      const packetNames = readdirSync(packet).sort((left, right) => left.localeCompare(right));
      const allowedPacketNames = ["attachments", "chunks", "extracted.md", "manifest.json", "original"];
      if (packetNames.length !== allowedPacketNames.length || packetNames.some((name, index) => name !== allowedPacketNames[index])) throw new Error(`Packet contains unexpected artifacts: ${entry.name}`);
      const unsafeEntry = collectFiles(packet, "\u0000").find((item) => item.startsWith("SYMLINK:"));
      if (unsafeEntry) throw new Error(`Packet contains symlink: ${entry.name}/${unsafeEntry.slice(8)}`);
      const readRegular = (target: string): Buffer => {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Packet path is not a regular file: ${target}`);
        return readFileNoFollow(target);
      };
      for (const required of ["manifest.json", "extracted.md", "original", "chunks", "attachments"]) {
        const target = join(packet, required);
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) throw new Error(`Packet contains symlink: ${entry.name}/${required}`);
        const shouldBeDirectory = required === "original" || required === "chunks" || required === "attachments";
        if (shouldBeDirectory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Packet artifact has wrong type: ${entry.name}/${required}`);
      }
      const manifest = JSON.parse(readRegular(join(packet, "manifest.json")).toString("utf8")) as Record<string, unknown>;
      if (manifest.id !== entry.name || manifest.sourceId !== entry.name) throw new Error(`Manifest id/sourceId mismatch: ${entry.name}`);
      const records = (value: unknown, label: string): Record<string, unknown>[] => {
        if (!Array.isArray(value)) throw new Error(`Manifest ${label} is not an array: ${entry.name}`);
        return value.map((item, index) => {
          if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error(`Manifest ${label}[${index}] is not an object: ${entry.name}`);
          return item as Record<string, unknown>;
        });
      };
      const files = records(manifest.files, "files");
      const chunks = records(manifest.chunks, "chunks");
      const attachments = manifest.attachments === undefined ? [] : records(manifest.attachments, "attachments");
      const integer = (value: unknown, label: string): number => {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}: ${entry.name}`);
        return value;
      };
      const aliasedInteger = (record: Record<string, unknown>, keys: readonly string[], label: string): number => {
        const values = keys.filter((key) => record[key] !== undefined).map((key) => integer(record[key], `${label}.${key}`));
        if (values.length === 0) throw new Error(`Missing ${label}: ${entry.name}`);
        if (values.some((value) => value !== values[0])) throw new Error(`Conflicting ${label}: ${entry.name}`);
        return values[0]!;
      };
      const digest = (value: unknown, label: string): string => {
        if (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value)) throw new Error(`Invalid ${label}: ${entry.name}`);
        return value;
      };
      const aliasedDigest = (record: Record<string, unknown>, keys: readonly string[], label: string): string => {
        const values = keys.filter((key) => record[key] !== undefined).map((key) => digest(record[key], `${label}.${key}`));
        if (values.length === 0) throw new Error(`Missing ${label}: ${entry.name}`);
        if (values.some((value) => value !== values[0])) throw new Error(`Conflicting ${label}: ${entry.name}`);
        return values[0]!;
      };
      const relativePath = (record: Record<string, unknown>, label: string): string => {
        const values = ["relativePath", "path"].filter((key) => record[key] !== undefined).map((key) => {
          if (typeof record[key] !== "string" || !record[key]) throw new Error(`Invalid ${label}.${key}: ${entry.name}`);
          return record[key] as string;
        });
        if (values.length === 0) throw new Error(`Missing ${label}.relativePath: ${entry.name}`);
        if (values.some((value) => value !== values[0])) throw new Error(`Conflicting ${label} path identity: ${entry.name}`);
        return values[0]!;
      };
      const fileRecords = files.map((record, index) => {
        const path = relativePath(record, `files[${index}]`);
        safeRelativePath(join(packet, "original"), path);
        return { path, byteLength: aliasedInteger(record, ["byteLength", "bytes"], `files[${index}].byteLength`), digest: digest(record.digest, `files[${index}].digest`) };
      });
      const attachmentRecords = attachments.map((record, index) => {
        const path = relativePath(record, `attachments[${index}]`);
        safeRelativePath(join(packet, "attachments"), path);
        return { path, byteLength: aliasedInteger(record, ["byteLength", "bytes"], `attachments[${index}].byteLength`), digest: digest(record.digest, `attachments[${index}].digest`) };
      });
      const checkFiles = (root: string, expected: readonly { readonly path: string; readonly byteLength: number; readonly digest: string }[], label: string): number => {
        const inspectTree = (current: string, prefix = ""): void => {
          for (const child of readdirSync(current, { withFileTypes: true })) {
            const childPath = prefix ? `${prefix}/${child.name}` : child.name;
            const target = join(current, child.name);
            if (child.isSymbolicLink()) throw new Error(`${label} tree contains symlink: ${entry.name}/${childPath}`);
            if (child.isDirectory()) inspectTree(target, childPath);
            else if (!child.isFile()) throw new Error(`${label} tree contains a non-regular entry: ${entry.name}/${childPath}`);
          }
        };
        inspectTree(root);
        const pathsOnDisk = collectFiles(root, "");
        const expectedPaths = new Set(expected.map((file) => file.path));
        if (expectedPaths.size !== expected.length || pathsOnDisk.length !== expected.length || pathsOnDisk.some((path) => !expectedPaths.has(path))) throw new Error(`${label} file set mismatch: ${entry.name}`);
        let total = 0;
        for (const file of expected) {
          const body = readRegular(safeRelativePath(root, file.path));
          total += body.byteLength;
          if (body.byteLength !== file.byteLength || createHash("sha256").update(body).digest("hex") !== file.digest) throw new Error(`${label} identity/digest mismatch: ${entry.name}/${file.path}`);
        }
        return total;
      };
      const originalTotal = checkFiles(join(packet, "original"), fileRecords, "Original");
      checkFiles(join(packet, "attachments"), attachmentRecords, "Attachment");
      const declaredOriginalTotal = aliasedInteger(manifest, ["originalByteLength", "originalBytes"], "manifest original byte length");
      if (declaredOriginalTotal !== originalTotal || declaredOriginalTotal !== fileRecords.reduce((sum, file) => sum + file.byteLength, 0)) throw new Error(`Original aggregate byte length mismatch: ${entry.name} (declared ${declaredOriginalTotal}, actual ${originalTotal})`);
      const originalDigest = digest(manifest.originalDigest, "manifest originalDigest");
      const extracted = readRegular(join(packet, "extracted.md"));
      const declaredExtractionTotal = aliasedInteger(manifest, ["extractedByteLength", "extractionBytes"], "manifest extracted byte length");
      if (declaredExtractionTotal !== extracted.byteLength) throw new Error(`Extracted aggregate byte length mismatch: ${entry.name} (declared ${declaredExtractionTotal}, actual ${extracted.byteLength})`);
      const extractedDigest = aliasedDigest(manifest, ["extractedDigest", "extractionDigest"], "manifest extracted digest");
      if (createHash("sha256").update(extracted).digest("hex") !== extractedDigest) throw new Error(`Extracted digest mismatch: ${entry.name}`);
      const atoms = atomizeExtraction(extracted);
      const chunkNames = readdirSync(join(packet, "chunks")).sort((left, right) => left.localeCompare(right));
      if (chunks.length === 0 || chunkNames.length !== chunks.length) throw new Error(`Chunk file set is incomplete: ${entry.name}`);
      const chunkBodies: Buffer[] = [];
      let atomCursor = 0;
      let byteCursor = 0;
      let chunkByteTotal = 0;
      for (const [index, record] of chunks.entries()) {
        const expectedName = `${String(index + 1).padStart(4, "0")}.md`;
        if (chunkNames[index] !== expectedName) throw new Error(`Chunk file order is invalid: ${entry.name}/${expectedName}`);
        const body = readRegular(join(packet, "chunks", expectedName));
        const chunkIndex = aliasedInteger(record, ["index", "ordinal"], `chunks[${index}].index`);
        const ordinal = aliasedInteger(record, ["ordinal", "index"], `chunks[${index}].ordinal`);
        const chunkId = record.chunkId;
        const chunkSourceId = record.sourceId;
        const chunkPath = record.relativePath;
        if (chunkIndex !== index || ordinal !== index || chunkSourceId !== entry.name || chunkId !== `${entry.name}:${index}` || chunkPath !== "extracted.md") throw new Error(`Chunk source/chunk id or relative path mismatch: ${entry.name}/${index}`);
        const startAtom = aliasedInteger(record, ["startAtom", "atomStart"], `chunks[${index}].startAtom`);
        const endAtom = aliasedInteger(record, ["endAtom", "atomEnd"], `chunks[${index}].endAtom`);
        const startByte = integer(record.startByte, `chunks[${index}].startByte`);
        const endByte = integer(record.endByte, `chunks[${index}].endByte`);
        const byteLength = aliasedInteger(record, ["byteLength", "bytes"], `chunks[${index}].byteLength`);
        if (startAtom !== atomCursor || endAtom <= startAtom || endAtom > atoms.length || startByte !== byteCursor || endByte < startByte || endByte - startByte !== body.byteLength || endByte - startByte !== byteLength) throw new Error(`Chunk atom/byte range is not contiguous: ${entry.name}/${index}`);
        const firstAtom = atoms[startAtom];
        const lastAtom = atoms[endAtom - 1];
        if (!firstAtom || !lastAtom || firstAtom.startByte !== startByte || lastAtom.endByte !== endByte || !body.equals(extracted.subarray(startByte, endByte))) throw new Error(`Chunk atom/byte range does not match extraction: ${entry.name}/${index}`);
        if (createHash("sha256").update(body).digest("hex") !== digest(record.digest, `chunks[${index}].digest`)) throw new Error(`Chunk digest mismatch: ${entry.name}/${index}`);
        chunkBodies.push(body);
        atomCursor = endAtom;
        byteCursor = endByte;
        chunkByteTotal += body.byteLength;
      }
      if (atomCursor !== atoms.length || byteCursor !== extracted.byteLength || chunkByteTotal !== extracted.byteLength || !Buffer.concat(chunkBodies, chunkByteTotal).equals(extracted)) throw new Error(`Chunk final totals/reconstruction mismatch: ${entry.name}`);
      const source = db.get<{ source_id: string; kind: string; status: string; repository_revision: string | null; digest: string | null; manifest_path: string | null }>("SELECT source_id, kind, status, repository_revision, digest, manifest_path FROM sources WHERE source_id = ?", [entry.name]);
      const manifestRevision = manifest.repositoryRevision ?? manifest.revision;
      const repositoryRevisionValid = source?.kind !== "repository"
        || (typeof source.repository_revision === "string" && source.repository_revision.length > 0 && typeof manifestRevision === "string" && manifestRevision === source.repository_revision);
      if (!source || source.status !== "published" || source.kind !== manifest.kind || !repositoryRevisionValid || (source.repository_revision !== null && manifestRevision !== source.repository_revision) || (source.repository_revision === null && manifest.repositoryRevision !== undefined) || source.digest !== originalDigest || !source.manifest_path || resolve(source.manifest_path) !== resolve(packet)) throw new Error(`Source catalog provenance/linkage is invalid: ${entry.name}`);
      const dbFiles = db.all<{ relative_path: string; byte_length: number; digest: string }>("SELECT relative_path, byte_length, digest FROM source_files WHERE source_id = ? ORDER BY relative_path", [entry.name]);
      const filesByPath = new Map(fileRecords.map((file) => [file.path, file]));
      if (dbFiles.length !== fileRecords.length || dbFiles.some((row) => {
        const expected = filesByPath.get(row.relative_path);
        return !expected || row.byte_length !== expected.byteLength || row.digest !== expected.digest;
      })) throw new Error(`Source file catalog identity/digest mismatch: ${entry.name}`);
      const dbChunks = db.all<{ chunk_id: string; source_id: string; ordinal: number; relative_path: string; byte_length: number; digest: string; atom_start: number; atom_end: number }>("SELECT chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end FROM source_chunks WHERE source_id = ? ORDER BY ordinal", [entry.name]);
      if (dbChunks.length !== chunks.length || chunks.some((record, index) => {
        const row = dbChunks[index];
        return !row || row.chunk_id !== `${entry.name}:${index}` || row.source_id !== entry.name || row.ordinal !== index || row.relative_path !== "extracted.md" || row.byte_length !== aliasedInteger(record, ["byteLength", "bytes"], `chunks[${index}].byteLength`) || row.digest !== record.digest || row.atom_start !== aliasedInteger(record, ["startAtom", "atomStart"], `chunks[${index}].startAtom`) || row.atom_end !== aliasedInteger(record, ["endAtom", "atomEnd"], `chunks[${index}].atomEnd`);
      })) throw new Error(`Source chunk catalog identity/digest mismatch: ${entry.name}`);
    }
    const sources = db.all<{ source_id: string; status: string; digest: string | null; manifest_path: string | null }>("SELECT source_id, status, digest, manifest_path FROM sources WHERE status != 'removed' ORDER BY source_id");
    for (const source of sources) {
      if (source.manifest_path === null) {
        if (source.status === "failed") continue;
        throw new Error(`Source catalog row has no packet path: ${source.source_id}`);
      }
      const packet = safeRelativePath(paths.sourcesRoot, source.source_id);
      if (resolve(source.manifest_path) !== resolve(packet)) throw new Error(`Source catalog packet path is not exact and contained: ${source.source_id}`);
      const packetStat = lstatSync(packet);
      if (packetStat.isSymbolicLink() || !packetStat.isDirectory()) throw new Error(`Source catalog packet is not a real directory: ${source.source_id}`);
      const manifestPath = join(packet, "manifest.json");
      const manifestStat = lstatSync(manifestPath);
      if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error(`Source catalog manifest is not a regular file: ${source.source_id}`);
      const manifest = JSON.parse(readFileNoFollow(manifestPath).toString("utf8")) as Record<string, unknown>;
      if (manifest.id !== source.source_id || manifest.sourceId !== source.source_id || manifest.originalDigest !== source.digest) throw new Error(`Source catalog reverse linkage is invalid: ${source.source_id}`);
    }
    return check("source-packets", "pass", `${entries.length} source packet(s) have valid immutable artifacts, aggregate lengths, reconstruction, and bidirectional catalog linkage`);
  } catch (error) {
    return check("source-packets", "fail", errorMessage(error));
  } finally {
    db?.close();
  }
}
const WORKFLOW_KINDS = new Set(["source-admission", "wiki-maintenance", "daily-quiz", "quiz-grader", "sync"]);
const WORKFLOW_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const WORKFLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const QUIZ_GRADER_BINDING_PREFIX = "quiz-grader:v1:";

function checkWorkflows(paths: VaultPaths): DoctorCheck {
  let db: ScholarDatabase | undefined;
  try {
    db = openDatabase(paths, { readOnly: true, initializeSchema: false });
    const running: { requestId: string; kind: string; startedAt: string }[] = [];
    const rows = db.all<Record<string, unknown>>("SELECT request_id, kind, status, started_at, finished_at, progress, message, error_code, error_message, idempotency_key FROM workflows ORDER BY request_id");
    for (const row of rows) {
      const requestId = row.request_id;
      if (typeof requestId !== "string" || !WORKFLOW_ID.test(requestId)) throw new Error(`Workflow request_id is malformed: ${String(requestId)}`);
      if (typeof row.kind !== "string" || !WORKFLOW_KINDS.has(row.kind)) throw new Error(`Workflow kind is malformed: ${requestId}`);
      if (typeof row.status !== "string" || !WORKFLOW_STATUSES.has(row.status)) throw new Error(`Workflow status is malformed: ${requestId}`);
      if (typeof row.progress !== "number" || !Number.isFinite(row.progress) || row.progress < 0 || row.progress > 1) throw new Error(`Workflow progress is malformed: ${requestId}`);
      const boundedText = (key: string, maxBytes: number): void => {
        const value = row[key];
        if (value === null || (typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes)) return;
        throw new Error(`Workflow ${key} metadata is malformed: ${requestId}`);
      };
      boundedText("message", 500);
      boundedText("error_code", 100);
      boundedText("error_message", 500);
      const idempotencyKey = row.idempotency_key;
      if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/u.test(idempotencyKey))) throw new Error(`Workflow idempotency_key metadata is malformed: ${requestId}`);
      const timestamp = (key: string): number | undefined => {
        const value = row[key];
        if (value === null) return undefined;
        if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value)) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Workflow ${key} metadata is malformed: ${requestId}`);
        return Date.parse(value);
      };
      const startedAt = timestamp("started_at");
      const finishedAt = timestamp("finished_at");
      if (startedAt !== undefined && finishedAt !== undefined && finishedAt < startedAt) throw new Error(`Workflow timestamps are out of order: ${requestId}`);
      if (row.kind === "quiz-grader" && (row.status === "queued" || row.status === "running")) {
        if (typeof row.message !== "string" || !row.message) throw new Error(`Quiz grader workflow binding is missing: ${requestId}`);
        if (row.status === "queued") {
          let payload: unknown;
          try { payload = JSON.parse(row.message); } catch { throw new Error(`Quiz grader workflow payload is malformed: ${requestId}`); }
          if (typeof payload !== "object" || payload === null || Array.isArray(payload) || Object.keys(payload).length !== 3 || !Object.keys(payload).every((key) => ["date", "revision", "submissionId"].includes(key))) throw new Error(`Quiz grader workflow payload is malformed: ${requestId}`);
          const value = payload as Record<string, unknown>;
          if (typeof value.date !== "string" || value.date !== localDate(value.date) || typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1 || typeof value.submissionId !== "string" || !value.submissionId) throw new Error(`Quiz grader workflow payload is malformed: ${requestId}`);
          const quiz = db.get<{ quiz_id: string; date: string; revision: number; status: string }>("SELECT quiz_id, date, revision, status FROM quizzes WHERE date = ?", [value.date]);
          const expectedSubmissionId = quiz ? `${quiz.quiz_id}:r${quiz.revision}` : undefined;
          const validRetryKey = expectedSubmissionId ? `${expectedSubmissionId}:retry:${requestId}` : undefined;
          if (!quiz || quiz.status !== "submitted" || quiz.revision !== value.revision || value.submissionId !== expectedSubmissionId || (idempotencyKey !== expectedSubmissionId && idempotencyKey !== validRetryKey)) throw new Error(`Quiz grader workflow payload is not linked to a submitted quiz: ${requestId}`);
        } else {
          if (!row.message.startsWith(QUIZ_GRADER_BINDING_PREFIX)) throw new Error(`Quiz grader workflow binding is malformed: ${requestId}`);
          let binding: unknown;
          try { binding = JSON.parse(row.message.slice(QUIZ_GRADER_BINDING_PREFIX.length)); } catch { throw new Error(`Quiz grader workflow binding is malformed: ${requestId}`); }
          if (typeof binding !== "object" || binding === null || Array.isArray(binding) || Object.keys(binding).length !== 2 || !Object.keys(binding).every((key) => ["quizId", "ownerHash"].includes(key))) throw new Error(`Quiz grader workflow binding is malformed: ${requestId}`);
          const value = binding as Record<string, unknown>;
          if (typeof value.quizId !== "string" || !value.quizId || typeof value.ownerHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.ownerHash)) throw new Error(`Quiz grader workflow binding is malformed: ${requestId}`);
          const quiz = db.get<{ quiz_id: string; status: string }>("SELECT quiz_id, status FROM quizzes WHERE quiz_id = ?", [value.quizId]);
          if (!quiz || quiz.status !== "submitted") throw new Error(`Quiz grader workflow binding is not linked to a submitted quiz: ${requestId}`);
        }
      }
      if (row.status === "queued") {
        if (startedAt !== undefined || finishedAt !== undefined || row.progress !== 0 || row.error_code !== null || row.error_message !== null) throw new Error(`Queued workflow metadata is inconsistent: ${requestId}`);
      } else if (row.status === "running") {
        if (startedAt === undefined || finishedAt !== undefined || row.error_code !== null || row.error_message !== null) throw new Error(`Running workflow metadata is inconsistent: ${requestId}`);
        running.push({ requestId, kind: row.kind, startedAt: String(row.started_at) });
      } else {
        if (startedAt === undefined || finishedAt === undefined) throw new Error(`Finished workflow metadata is incomplete: ${requestId}`);
        if (row.status === "succeeded" && (row.progress !== 1 || row.error_code !== null || row.error_message !== null)) throw new Error(`Succeeded workflow metadata is inconsistent: ${requestId}`);
      }
    }
    if (running.length > 0) {
      const listed = running.map((row) => `${row.requestId} (${row.kind})`).join(", ");
      return check("workflows", "warn", `Running workflow row(s) require operation-specific retry; no recovery performed: ${listed}`, { running: running.map((row) => ({ requestId: row.requestId, kind: row.kind, startedAt: row.startedAt })) });
    }
    return check("workflows", "pass", `${rows.length} workflow row(s) have valid status and metadata`);
  } catch (error) {
    return check("workflows", "fail", errorMessage(error));
  } finally {
    db?.close();
  }
}

const PAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function pageIdFromMarkdown(markdown: string): string | undefined {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/u.exec(markdown)?.[1];
  return /^(?:page[-_]id|id):\s*["']?([^\s"']+)["']?\s*$/mu.exec(frontmatter ?? "")?.[1];
}

function checkPages(paths: VaultPaths): DoctorCheck {
  let files: string[];
  try {
    files = collectFiles(paths.wikiRoot, ".md");
  } catch (error) {
    return check("page-ids", "fail", `Cannot traverse wiki pages: ${errorMessage(error)}`);
  }
  files = files.filter((relativePath) => relativePath.startsWith("SYMLINK:") || (!relativePath.startsWith(".snapshots/") && relativePath !== ".snapshots"));
  const ids = new Map<string, string>();
  for (const relativePath of files) {
    if (relativePath.startsWith("SYMLINK:")) return check("page-ids", "fail", `Wiki contains symlink: ${relativePath.slice(8)}`);
    const baseName = relativePath.split("/").at(-1)?.toLowerCase();
    if (baseName === "index.md" || baseName === "log.md") continue;
    const absolutePath = join(paths.wikiRoot, relativePath);
    let markdown: string;
    try {
      markdown = readFileNoFollow(absolutePath).toString("utf8");
    } catch (error) {
      return check("page-ids", "fail", `Cannot read wiki page ${relativePath}: ${errorMessage(error)}`);
    }
    const pageId = pageIdFromMarkdown(markdown);
    if (!pageId || !PAGE_ID_PATTERN.test(pageId)) return check("page-ids", "fail", `Wiki page has invalid stable page ID: ${relativePath}`);
    const previous = ids.get(pageId);
    if (previous) return check("page-ids", "fail", `Duplicate page_id ${pageId}: ${previous} and ${relativePath}`);
    ids.set(pageId, relativePath);
  }
  let db: ScholarDatabase | undefined;
  try {
    db = openDatabase(paths, { readOnly: true, initializeSchema: false });
    const rows = db.all<{ page_id: string; relative_path: string; digest: string; revision: number; status: string }>("SELECT page_id, relative_path, digest, revision, status FROM pages");
    const byPath = new Map(rows.map((row) => [row.relative_path, row]));
    const snapshots = db.all<{ relative_path: string; digest: string; revision: number }>("SELECT relative_path, digest, revision FROM authored_snapshots");
    const snapshotsByPath = new Map(snapshots.map((row) => [row.relative_path, row]));
    const byPageId = new Map(rows.map((row) => [row.page_id, row]));
    for (const relativePath of snapshotsByPath.keys()) {
      if (!byPath.has(relativePath)) return check("page-drift", "fail", `Authored snapshot catalog has no matching page: ${relativePath}`);
    }
    let snapshotFiles: string[];
    try {
      snapshotFiles = collectFiles(join(paths.metadataRoot, "snapshots", "wiki"), ".md");
    } catch (error) {
      return check("page-drift", "fail", `Cannot traverse authored wiki snapshots: ${errorMessage(error)}`);
    }
    const snapshotIds = new Map<string, string>();
    for (const relativePath of snapshotFiles) {
      if (relativePath.startsWith("SYMLINK:")) return check("page-drift", "fail", `Authored snapshot tree contains symlink: ${relativePath.slice(8)}`);
      if (relativePath.includes("/")) return check("page-drift", "fail", `Authored snapshot has invalid path: ${relativePath}`);
      const pageId = relativePath.slice(0, -3);
      if (!PAGE_ID_PATTERN.test(pageId)) return check("page-drift", "fail", `Authored snapshot has a non-UUID filename: ${relativePath}`);
      if (snapshotIds.has(pageId)) return check("page-drift", "fail", `Duplicate authored snapshot filename: ${relativePath}`);
      snapshotIds.set(pageId, relativePath);
      const row = byPageId.get(pageId);
      if (!row) return check("page-drift", "fail", `Authored snapshot has no matching page: ${relativePath}`);
      if (!snapshotsByPath.has(row.relative_path)) return check("page-drift", "fail", `Authored snapshot has no catalog row: ${relativePath}`);
    }
    for (const [pageId, relativePath] of ids) {
      const row = byPath.get(relativePath);
      if (!row || row.page_id !== pageId) return check("page-drift", "fail", `Page catalog mismatch: ${relativePath}`);
      const digest = createHash("sha256").update(readFileNoFollow(join(paths.wikiRoot, relativePath))).digest("hex");
      if (row.digest !== digest && row.status !== "drifted") return check("page-drift", "fail", `Page digest drifted without a drift record: ${relativePath}`);
    }
    for (const row of rows) {
      if (row.status === "retired") continue;
      if (ids.get(row.page_id) !== row.relative_path) return check("page-drift", "fail", `Page catalog has no matching wiki artifact: ${row.relative_path}`);
      if (!PAGE_ID_PATTERN.test(row.page_id)) return check("page-drift", "fail", `Page catalog has an invalid stable ID: ${row.relative_path}`);
      const snapshot = snapshotsByPath.get(row.relative_path);
      if (!snapshot || snapshot.digest !== row.digest || Number(snapshot.revision) !== Number(row.revision)) return check("page-drift", "fail", `Authored snapshot catalog mismatch: ${row.relative_path}`);
      const snapshotPath = safeRelativePath(join(paths.metadataRoot, "snapshots", "wiki"), `${row.page_id}.md`);
      const snapshotStat = lstatSync(snapshotPath);
      if (snapshotStat.isSymbolicLink() || !snapshotStat.isFile()) return check("page-drift", "fail", `Authored snapshot is not a regular file: ${row.relative_path}`);
      const snapshotDigest = createHash("sha256").update(readFileNoFollow(snapshotPath)).digest("hex");
      if (snapshotDigest !== row.digest || snapshotDigest !== snapshot.digest) return check("page-drift", "fail", `Authored snapshot digest mismatch: ${row.relative_path}`);
    }
  } catch (error) {
    return check("page-drift", "fail", `Cannot inspect page catalog: ${errorMessage(error)}`);
  } finally {
    db?.close();
  }
  return check("page-ids", "pass", `${ids.size} wiki page(s) have unique stable IDs and bidirectional catalog entries`);
}

function checkScheduler(paths: VaultPaths): DoctorCheck {
  let db: ScholarDatabase | undefined;
  try {
    db = openDatabase(paths, { readOnly: true, initializeSchema: false });
    const cards = new Set(db.all<{ card_id: string }>("SELECT card_id FROM review_cards").map((row) => row.card_id));
    const graph = new Map<string, string[]>();
    for (const row of db.all<{ card_id: string; prerequisite_card_id: string }>("SELECT card_id, prerequisite_card_id FROM card_prerequisites")) {
      if (!cards.has(row.card_id) || !cards.has(row.prerequisite_card_id)) return check("scheduler", "fail", "Card prerequisite references a missing card");
      graph.set(row.card_id, [...(graph.get(row.card_id) ?? []), row.prerequisite_card_id]);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (cardId: string): boolean => {
      if (visiting.has(cardId)) return false;
      if (visited.has(cardId)) return true;
      visiting.add(cardId);
      for (const prerequisite of graph.get(cardId) ?? []) if (!visit(prerequisite)) return false;
      visiting.delete(cardId);
      visited.add(cardId);
      return true;
    };
    for (const cardId of cards) if (!visit(cardId)) return check("scheduler", "fail", "Card prerequisite graph contains a cycle");
    const coverage = new SchedulerService(db, paths).validateCoverage();
    if (!coverage.ok) return check("scheduler", "fail", `Eligible wiki pages have no active card bindings: ${coverage.missingPageIds.join(", ")}`);
    return check("scheduler", "pass", `${cards.size} review card(s) have valid prerequisite relationships and wiki coverage`);
  } catch (error) {
    return check("scheduler", "fail", `Cannot inspect scheduler relationships: ${errorMessage(error)}`);
  } finally {
    db?.close();
  }
}

function checkQuizzes(paths: VaultPaths): DoctorCheck {
  let files: string[];
  try {
    files = collectFiles(paths.quizzesRoot, ".md");
  } catch (error) {
    return check("quiz-projections", "fail", `Cannot traverse quiz projections: ${errorMessage(error)}`);
  }
  const projections = new Map<string, { quizId: string; revision: number; questionIds: string[]; absolutePath: string; markdown: string }>();
  for (const relativePath of files) {
    if (relativePath.startsWith("SYMLINK:")) return check("quiz-projections", "fail", `Quiz tree contains symlink: ${relativePath.slice(8)}`);
    const baseName = relativePath.split("/").at(-1)?.toLowerCase();
    if (baseName === "index.md" || baseName === "log.md") continue;
    const match = /^(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.md$/u.exec(relativePath);
    const year = match?.[1];
    const month = match?.[2];
    const date = match?.[3];
    if (!year || !month || !date || month !== date.slice(5, 7) || year !== date.slice(0, 4)) return check("quiz-projections", "fail", `Quiz projection has invalid path: ${relativePath}`);
    const absolutePath = join(paths.quizzesRoot, relativePath);
    let markdown: string;
    try {
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return check("quiz-projections", "fail", `Quiz projection is not a regular file: ${relativePath}`);
      markdown = readFileNoFollow(absolutePath).toString("utf8");
    } catch (error) {
      return check("quiz-projections", "fail", `Cannot read quiz projection ${relativePath}: ${errorMessage(error)}`);
    }
    if (/answer\s*key|correct\s+answer|grading\s+criteria|\brubric\b/iu.test(markdown)) return check("quiz-projections", "fail", `Quiz projection contains private grading material: ${relativePath}`);
    const header = new RegExp(`^# Pi Scholar Quiz — ${date}\\s*$`, "mu").test(markdown);
    const identity = /<!--\s*pi-scholar quiz-id=([^\s]+) revision=(\d+)\s*-->/mu.exec(markdown);
    if (!header || !identity) return check("quiz-projections", "fail", `Quiz projection identity is invalid: ${relativePath}`);
    projections.set(date, {
      quizId: identity[1]!,
      revision: Number(identity[2]),
      questionIds: [...markdown.matchAll(/^## \d+\. ([^\n]+)$/gmu)].map((question) => question[1]!),
      absolutePath,
      markdown,
    });
  }
  let db: ScholarDatabase | undefined;
  try {
    db = openDatabase(paths, { readOnly: true, initializeSchema: false });
    const quizService = new QuizService(db, paths, new SchedulerService(db, paths));
    const quizzes = db.all<{ quiz_id: string; date: string; revision: number; status: string; sheet_path: string | null }>("SELECT quiz_id, date, revision, status, sheet_path FROM quizzes ORDER BY date");
    for (const row of quizzes) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(row.date) || !Number.isInteger(Number(row.revision)) || Number(row.revision) < 1) return check("quiz-projections", "fail", `Quiz identity is invalid: ${row.quiz_id}`);
      const questionRows = db.all<{ question_id: string }>("SELECT question_id FROM quiz_questions WHERE quiz_id = ? ORDER BY ordinal", [row.quiz_id]);
      if (row.status === "open" && questionRows.length === 0) return check("quiz-projections", "fail", `Open quiz ${row.quiz_id} has no questions`);
      const projection = projections.get(row.date);
      if (row.sheet_path) {
        const expectedPath = join(paths.quizzesRoot, row.date.slice(0, 4), row.date.slice(5, 7), `${row.date}.md`);
        if (resolve(row.sheet_path) !== resolve(expectedPath) || !projection || projection.quizId !== row.quiz_id || projection.revision !== row.revision) return check("quiz-projections", "fail", `Quiz identity/projection mismatch: ${row.date}`);
        if (projection.questionIds.length !== questionRows.length || projection.questionIds.some((id, index) => id !== questionRows[index]?.question_id)) return check("quiz-projections", "fail", `Quiz question identity mismatch: ${row.date}`);
        try {
          quizService.parseSheet(projection.markdown);
        } catch (error) {
          return check("quiz-projections", "fail", `Quiz projection content does not match SQLite: ${row.date}: ${errorMessage(error)}`);
        }
      } else if (projection) {
        return check("quiz-projections", "fail", `Quiz projection has no SQLite identity: ${row.date}`);
      }
    }
    for (const [date] of projections) if (!quizzes.some((row) => row.date === date)) return check("quiz-projections", "fail", `Quiz projection has no SQLite row: ${date}`);
    return check("quiz-projections", "pass", `${projections.size} dated quiz projection(s) have valid identity, answer visibility, and question bounds`);
  } catch (error) {
    return check("quiz-projections", "fail", `Cannot inspect quiz projections: ${errorMessage(error)}`);
  } finally {
    db?.close();
  }
}

function checkDependencies(paths: VaultPaths): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const probes: readonly [string, () => { readonly executable: string; readonly version: string }][] = [
    ["git", () => gitDependencyIdentity(paths)],
    ["qmd", () => qmdDependencyIdentity(paths)],
    ["docling", () => doclingDependencyIdentity(paths)],
  ];
  for (const [name, probe] of probes) {
    const fingerprint = dependencyFingerprint(name);
    const cached = dependencyCheckCache.get(name);
    if (cached?.fingerprint === fingerprint) {
      checks.push(cached.check);
      continue;
    }
    const required = name === "git";
    try {
      const identity = probe();
      const result = identity.version ? check(name, "pass", identity.version) : check(name, required ? "fail" : "warn", `${name} version could not be determined`);
      dependencyCheckCache.set(name, { fingerprint: dependencyFingerprint(name), check: result });
      checks.push(result);
    } catch (error) {
      const result = check(name, required ? "fail" : "warn", `${name} unavailable: ${errorMessage(error)}`);
      dependencyCheckCache.set(name, { fingerprint: dependencyFingerprint(name), check: result });
      checks.push(result);
    }
  }
  return checks;
}

function checkExternalState(paths: VaultPaths, qmdDependency: DoctorCheck | undefined): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (qmdDependency?.status !== "pass") {
    checks.push(check("qmd-scope", "warn", `qmd semantic ranking unavailable; exact and lexical navigation remain usable${qmdDependency ? `: ${qmdDependency.message}` : ""}`));
  } else {
    const qmdScope = qmdScopeCheck(paths);
    checks.push(qmdScope.ok ? check("qmd-scope", "pass", qmdScope.message) : check("qmd-scope", "warn", `qmd semantic ranking unavailable; exact and lexical navigation remain usable: ${qmdScope.message}`));
  }
  try {
    const status = gitStatus(paths);
    checks.push(status.diverged ? check("git-state", "fail", "Git history is diverged") : check("git-state", "pass", status.clean ? "Git worktree is clean" : "Git worktree has uncommitted changes"));
  } catch (error) {
    checks.push(check("git-state", "fail", `Git state unavailable: ${errorMessage(error)}`));
  }
  return checks;
}


export function doctor(explicitPath?: string): DoctorReport {
  const checkedAt = new Date().toISOString();
  let paths: VaultPaths;
  try {
    paths = resolveVault(explicitPath);
  } catch (error) {
    return { ok: false, checkedAt, checks: [check("vault", "fail", errorMessage(error))] };
  }
  const roots = checkRoots(paths);
  if (roots.status === "fail") return { ok: false, checkedAt, checks: [roots] };
  const dependencyChecks = checkDependencies(paths);
  const checks = [roots, ...checkDatabase(paths), checkPackets(paths), checkWorkflows(paths), checkPages(paths), checkScheduler(paths), checkQuizzes(paths), ...dependencyChecks, ...checkExternalState(paths, dependencyChecks.find((item) => item.name === "qmd"))];
  return { ok: checks.every((item) => item.status !== "fail"), checkedAt, checks };
}

export const runDoctor = doctor;
