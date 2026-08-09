import { createHash } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { runChild } from "../external/process.js";
import { assertNoSymlinkPath, safeRelativePath } from "../vault.js";
import type {
  FileSnapshot,
  InputKind,
  PhysicalIdentity,
  SourceClaim,
  SourceKind,
  StageMetadata,
  TreeSnapshot,
  VaultPathsLike,
} from "./source-service.js";

export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const ENVELOPE_NAME = ".pi-scholar-source.json";
export const SOURCE_KINDS: readonly SourceKind[] = [
  "document",
  "url",
  "text",
  "note",
  "code",
  "directory",
  "repository",
];
export const INPUT_KINDS: readonly InputKind[] = [...SOURCE_KINDS, "upload", "pasted"];
function provenanceUrl(url: URL): string {
  const safe = new URL(url.toString());
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.toString();
}
function sanitizedSourceUri(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("source URL protocol is not allowed");
  return provenanceUrl(parsed);
}
function publicSourceUri(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return sanitizedSourceUri(value);
  } catch {
    return undefined;
  }
}
function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function canonical(value: unknown): string {
  const normalizeValue = (input: unknown): unknown => {
    if (input === undefined || typeof input === "function" || typeof input === "symbol" || typeof input === "bigint")
      throw new Error("value cannot be serialized canonically");
    if (input === null || typeof input === "string" || typeof input === "number" || typeof input === "boolean")
      return input;
    if (input instanceof Uint8Array) return Buffer.from(input).toString("base64");
    if (Array.isArray(input)) return input.map((item) => normalizeValue(item));
    if (typeof input === "object") {
      const record = input as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
        const nested = record[key];
        if (nested !== undefined) normalized[key] = normalizeValue(nested);
      }
      return normalized;
    }
    throw new Error("value cannot be serialized canonically");
  };
  const output = JSON.stringify(normalizeValue(value));
  if (output === undefined) throw new Error("value cannot be serialized canonically");
  return output;
}
function validRelativePath(value: string): string {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value) || value.includes("\\") || isAbsolute(value))
    throw new Error("invalid relative path");
  const normalized = normalize(value).replaceAll("\\", "/");
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  )
    throw new Error("path traversal");
  return normalized;
}
function vaultRootFor(paths: VaultPathsLike): string {
  const root = paths.root ?? paths.vaultRoot;
  if (typeof root !== "string") throw new Error("vault root is required");
  return root;
}
function workArtifactRelative(paths: VaultPathsLike, target: string): string {
  const absolute = resolve(target);
  const work = resolve(pathFor(paths, "work"));
  const workRelative = relative(work, absolute).replaceAll("\\", "/");
  if (!workRelative || workRelative === ".." || workRelative.startsWith("../") || isAbsolute(workRelative))
    throw new Error("prepared path escapes work");
  const vaultRelative = relative(resolve(vaultRootFor(paths)), absolute).replaceAll("\\", "/");
  return validRelativePath(vaultRelative);
}
function resolveWorkArtifact(paths: VaultPathsLike, requested: string): string {
  const absolute = safeRelativePath(vaultRootFor(paths), validRelativePath(requested));
  return ensureWithin(pathFor(paths, "work"), absolute);
}
function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function statIdentity(stat: Stats): PhysicalIdentity {
  const mtimeNs =
    "mtimeNs" in stat && typeof stat.mtimeNs === "bigint"
      ? stat.mtimeNs.toString()
      : String(Math.round(stat.mtimeMs * 1_000_000));
  return { device: String(stat.dev), inode: String(stat.ino), mode: stat.mode, size: stat.size, mtimeNs };
}
function pathFor(paths: VaultPathsLike, name: "inbox" | "sources" | "work" | "quizzes"): string {
  const explicit =
    name === "inbox"
      ? (paths.inbox ?? paths.inboxRoot)
      : name === "sources"
        ? (paths.sources ?? paths.sourcesRoot)
        : name === "work"
          ? (paths.work ?? paths.workRoot)
          : paths.quizzesRoot;
  if (typeof explicit === "string") return explicit;
  const root = paths.root ?? paths.vaultRoot;
  if (typeof root !== "string") throw new Error("vault root is required");
  return join(root, name === "work" ? ".pi-scholar/work" : name);
}
function wikiPathFor(paths: VaultPathsLike): string {
  const explicit = paths.wikiRoot;
  if (typeof explicit === "string") return explicit;
  const root = paths.root ?? paths.vaultRoot;
  if (typeof root !== "string") throw new Error("vault root is required");
  return join(root, "wiki");
}
async function lstatNoFollow(path: string): Promise<Stats> {
  assertNoSymlinkPath(path);
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${path}`);
  return stat;
}
async function readNoFollow(path: string): Promise<Buffer> {
  assertNoSymlinkPath(path);
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    const bytes = Buffer.from(await handle.readFile());
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function measurePath(path: string): Promise<number> {
  const stat = await lstatNoFollow(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error(`unsupported filesystem entry: ${path}`);
  let total = 0;
  for (const name of (await fs.readdir(path)).sort((a, b) => a.localeCompare(b))) {
    if (name === ".git") continue;
    total += await measurePath(join(path, name));
    if (total > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
  }
  return total;
}
async function walkFiles(root: string, current = "", skipGit = true): Promise<FileSnapshot[]> {
  const absolute = join(root, current);
  const stat = await lstatNoFollow(absolute);
  if (stat.isFile()) {
    const bytes = await readNoFollow(absolute);
    return [{ path: current.replaceAll("\\", "/"), size: bytes.byteLength, digest: digestBytes(bytes), bytes }];
  }
  if (!stat.isDirectory()) throw new Error(`unsupported filesystem entry: ${absolute}`);
  const files: FileSnapshot[] = [];
  for (const name of (await fs.readdir(absolute)).sort((a, b) => a.localeCompare(b))) {
    if (skipGit && name === ".git") continue;
    validRelativePath(join(current, name));
    files.push(...(await walkFiles(root, join(current, name), skipGit)));
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_SOURCE_BYTES)
      throw new Error("source exceeds 100 MiB limit");
  }
  return files;
}
const SAFE_REPOSITORY_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;
const SAFE_REPOSITORY_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
} as const;
async function repositoryGit(
  root: string,
  command: "ls-files" | "rev-parse",
  maxOutputBytes: number,
): Promise<Awaited<ReturnType<typeof runChild>>> {
  const args =
    command === "ls-files"
      ? [...SAFE_REPOSITORY_GIT_ARGS, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]
      : [...SAFE_REPOSITORY_GIT_ARGS, "rev-parse", "HEAD"];
  return runChild("git", ["-C", root, ...args], {
    cwd: root,
    timeoutMs: 120_000,
    maxOutputBytes,
    env: SAFE_REPOSITORY_GIT_ENV,
  });
}
async function repositoryRevision(root: string): Promise<string> {
  const result = await repositoryGit(root, "rev-parse", 1024);
  if (result.timedOut || result.code !== 0)
    throw new Error(`git revision lookup failed (${result.code ?? result.signal ?? "unknown"})`);
  const revision = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/iu.test(revision)) throw new Error("git revision is invalid");
  return revision;
}
async function repositoryFiles(root: string): Promise<FileSnapshot[]> {
  const result = await repositoryGit(root, "ls-files", MAX_SOURCE_BYTES + 1);
  if (result.timedOut || result.code !== 0)
    throw new Error(`git file listing failed (${result.code ?? result.signal ?? "unknown"})`);
  if (Buffer.byteLength(result.stdout, "utf8") >= MAX_SOURCE_BYTES)
    throw new Error("repository file listing exceeds 100 MiB limit");
  const files: FileSnapshot[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const rawPath of result.stdout.split("\0")) {
    if (!rawPath) continue;
    const normalized = rawPath;
    if (normalized.split("/").includes(".git")) continue;
    if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error("repository file path contains control characters");
    const path = validRelativePath(normalized);
    if (seen.has(path)) continue;
    seen.add(path);
    const absolute = ensureWithin(root, join(root, path));
    const stat = await lstatNoFollow(absolute);
    if (!stat.isFile()) throw new Error(`repository entry is not a regular file: ${path}`);
    const bytes = await readNoFollow(absolute);
    total += bytes.byteLength;
    if (total > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
    files.push({ path, size: bytes.byteLength, digest: digestBytes(bytes), bytes });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
function sameIdentity(a: PhysicalIdentity, b: PhysicalIdentity): boolean {
  return (
    a.device === b.device && a.inode === b.inode && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs
  );
}
function ensureWithin(root: string, target: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel === "" || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path escapes vault");
  return targetAbs;
}
function safeChildPath(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target)).replaceAll("\\", "/");
  if (!rel || rel.startsWith("../") || isAbsolute(rel)) throw new Error("path escapes vault");
  return safeRelativePath(root, rel);
}
function inferKind(path: string, stat?: Stats): SourceKind {
  if (stat?.isDirectory()) return "directory";
  const ext = extname(path).toLowerCase();
  if (
    [".pdf", ".epub", ".docx", ".pptx", ".xlsx", ".html", ".htm", ".png", ".jpg", ".jpeg", ".tif", ".tiff"].includes(
      ext,
    )
  )
    return "document";
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".c",
      ".h",
      ".cpp",
      ".cc",
      ".sh",
      ".sql",
    ].includes(ext)
  )
    return "code";
  return "text";
}
function textualUrl(claim: SourceClaim, mediaType?: string): boolean {
  const media = mediaType?.toLowerCase().split(";", 1)[0];
  if (
    media &&
    [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "application/xml",
      "text/xml",
      "application/yaml",
      "text/yaml",
    ].includes(media)
  )
    return true;
  return [".md", ".markdown", ".txt", ".text", ".json", ".xml", ".csv", ".yaml", ".yml"].includes(
    extname(claim.entry.metadata?.originalName ?? claim.entry.relativePath).toLowerCase(),
  );
}
function treeDigest(files: FileSnapshot[], identity: PhysicalIdentity, revision?: string): string {
  return digestBytes(
    Buffer.from(
      canonical({ identity, revision, files: files.map(({ path, size, digest }) => ({ path, size, digest })) }),
    ),
  );
}
function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new Error(`invalid source manifest ${key}`);
  return value;
}
function parseMetadata(raw: string): StageMetadata {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid staged source metadata");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid staged source metadata");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.requestedKind !== "string" ||
    !INPUT_KINDS.includes(record.requestedKind as InputKind) ||
    typeof record.kind !== "string" ||
    !SOURCE_KINDS.includes(record.kind as SourceKind) ||
    typeof record.displayName !== "string" ||
    !record.displayName ||
    /[\u0000-\u001f\u007f]/u.test(record.displayName) ||
    record.payload !== "payload"
  )
    throw new Error("invalid staged source metadata");
  const requestedKind = record.requestedKind as InputKind;
  const kind = record.kind as SourceKind;
  const originalName = typeof record.originalName === "string" ? record.originalName : undefined;
  if (originalName !== undefined) validRelativePath(originalName);
  if (
    (requestedKind === "url" && kind !== "url") ||
    ((requestedKind === "text" || requestedKind === "pasted") && kind !== "text") ||
    (requestedKind === "upload" && kind !== inferKind(originalName ?? record.displayName)) ||
    (requestedKind === "repository" && kind !== "repository") ||
    (requestedKind !== "url" &&
      requestedKind !== "text" &&
      requestedKind !== "pasted" &&
      requestedKind !== "upload" &&
      requestedKind !== "repository")
  )
    throw new Error("staged source metadata kind is inconsistent");
  if (requestedKind === "url" && typeof record.sourceUri !== "string")
    throw new Error("staged URL source metadata is missing sourceUri");
  if (requestedKind === "upload" && originalName === undefined)
    throw new Error("staged upload metadata is missing originalName");
  if (
    kind === "repository" &&
    (typeof record.repositoryRevision !== "string" ||
      !record.repositoryRevision ||
      /[\u0000-\u001f\u007f]/u.test(record.repositoryRevision))
  )
    throw new Error("invalid staged repository revision");
  const metadata: StageMetadata = {
    version: 1,
    requestedKind,
    kind,
    displayName: record.displayName,
    payload: "payload",
  };
  for (const key of ["originalName", "sourceUri", "mediaType", "repositoryRevision"] as const) {
    const item = record[key];
    if (item !== undefined) {
      if (typeof item !== "string" || item.includes("\0") || /[\u0000-\u001f\u007f]/u.test(item))
        throw new Error("invalid staged source metadata");
      metadata[key] = key === "sourceUri" ? sanitizedSourceUri(item) : item;
    }
  }
  validRelativePath(metadata.payload);
  return metadata;
}
async function stagedMetadata(path: string): Promise<StageMetadata | undefined> {
  const stat = await lstatNoFollow(path);
  if (!stat.isDirectory()) return undefined;
  const envelope = join(path, ENVELOPE_NAME);
  try {
    const envelopeStat = await lstatNoFollow(envelope);
    if (!envelopeStat.isFile()) throw new Error("staged source metadata must be a file");
    const metadata = parseMetadata((await readNoFollow(envelope)).toString("utf8"));
    const payload = join(path, metadata.payload);
    const payloadStat = await lstatNoFollow(payload);
    if (metadata.kind === "repository" ? !payloadStat.isDirectory() : !payloadStat.isFile())
      throw new Error(
        `staged source payload must be a regular ${metadata.kind === "repository" ? "directory" : "file"}`,
      );
    return metadata;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  }
}
async function snapshotPath(
  path: string,
  relativePath: string,
  kind?: SourceKind,
  revision?: string,
  metadata?: StageMetadata,
): Promise<TreeSnapshot> {
  const stat = await lstatNoFollow(path);
  const identity = statIdentity(stat);
  const files = stat.isDirectory()
    ? kind === "repository" && !metadata
      ? await repositoryFiles(path)
      : await walkFiles(path)
    : [{ path: basename(path), size: 0, digest: "", bytes: Buffer.alloc(0) }];
  if (!stat.isDirectory()) {
    const first = files[0];
    if (!first) throw new Error("source file snapshot is empty");
    const bytes = await readNoFollow(path);
    first.bytes = bytes;
    first.size = bytes.byteLength;
    first.digest = digestBytes(bytes);
  }
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (bytes > MAX_SOURCE_BYTES) throw new Error("source exceeds 100 MiB limit");
  const finalKind = kind ?? (stat.isDirectory() ? "directory" : inferKind(path, stat));
  return {
    root: path,
    relativePath: validRelativePath(relativePath),
    kind: finalKind,
    identity,
    digest: treeDigest(files, identity, revision),
    bytes,
    files,
    revision,
    metadata,
  };
}
async function writeTree(root: string, files: FileSnapshot[]): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = ensureWithin(root, join(root, validRelativePath(file.path)));
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await openFile(target, "wx", 0o600);
    try {
      await handle.writeFile(file.bytes);
    } finally {
      await handle.close();
    }
  }
}
async function copyPathNoFollow(source: string, target: string): Promise<void> {
  const stat = await lstatNoFollow(source);
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink()) throw new Error(`symlink rejected: ${target}`);
    throw new Error(`staging target already exists: ${target}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: false, mode: 0o700 });
    for (const name of (await fs.readdir(source)).sort((left, right) => left.localeCompare(right))) {
      if (name === ".git") continue;
      validRelativePath(name);
      await copyPathNoFollow(join(source, name), join(target, name));
    }
    return;
  }
  const bytes = await readNoFollow(source);
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await openFile(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
async function copyRepositoryNoSecrets(target: string, files: FileSnapshot[], metadata: StageMetadata): Promise<void> {
  await fs.mkdir(target, { recursive: false, mode: 0o700 });
  await fs.writeFile(join(target, ENVELOPE_NAME), `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
  await writeTree(join(target, metadata.payload), files);
}

export {
  canonical,
  copyPathNoFollow,
  copyRepositoryNoSecrets,
  deterministicUuid,
  digestBytes,
  ensureWithin,
  inferKind,
  lstatNoFollow,
  measurePath,
  parseMetadata,
  pathFor,
  provenanceUrl,
  publicSourceUri,
  readNoFollow,
  repositoryFiles,
  repositoryRevision,
  requiredString,
  resolveWorkArtifact,
  safeChildPath,
  sameIdentity,
  sanitizedSourceUri,
  snapshotPath,
  stagedMetadata,
  statIdentity,
  textualUrl,
  treeDigest,
  validRelativePath,
  vaultRootFor,
  walkFiles,
  wikiPathFor,
  workArtifactRelative,
  writeTree,
};
