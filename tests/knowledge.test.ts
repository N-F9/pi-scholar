import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScholarApplication } from "../src/application/application.js";
import { openDatabase } from "../src/database.js";
import { doctor } from "../src/doctor.js";
import { runChild } from "../src/external/process.js";
import {
  parseOkfConcept,
  removeOkfFootnoteDefinitions,
  serializeOkfConcept,
  validateOkfIndex,
  validateOkfLog,
} from "../src/okf.js";
import { SchedulerService, ValidationError } from "../src/scheduler.js";
import { validateFileEndpoints } from "../src/sources/source-chunks.js";
import { requestSourceToFile, SourceService, sha256, validateChunkEndpoints } from "../src/sources/source-service.js";
import { initVault } from "../src/vault.js";
import { isExecutableHtml, WikiService } from "../src/wiki.js";

const temporaryRoots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(join("/tmp", "pi-scholar-knowledge-"));
  temporaryRoots.push(root);
  const paths = initVault(root);
  const db = openDatabase(paths);
  return { root, paths, db, sources: new SourceService(db, paths), wiki: new WikiService(db, paths) };
}
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("source admission mechanics", () => {
  it("discovers every direct inbox entry in canonical order", async () => {
    const { paths, db, sources } = await fixture();
    for (let index = 0; index < 200; index++)
      await fs.writeFile(join(paths.inboxRoot, `entry-${String(index).padStart(3, "0")}.txt`), `entry ${index}\n`);
    const entries = await sources.discover();
    expect(entries).toHaveLength(200);
    expect(entries[0].relativePath).toBe("entry-000.txt");
    expect(entries.at(-1)?.relativePath).toBe("entry-199.txt");
    db.close();
  });

  it("isolates malformed siblings and publishes the valid claim", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "good.txt"), "valid\n");
    await fs.symlink("/etc/passwd", join(paths.inboxRoot, "bad.txt"));
    const results = await sources.admitClaims(await sources.discover());
    expect(results).toHaveLength(2);
    expect(results.filter((result) => result.result)).toHaveLength(1);
    expect(await fs.readdir(paths.sourcesRoot)).toHaveLength(1);
    db.close();
  });

  it("retains bounded planning atoms while publishing an exact long-source line boundary", async () => {
    const { paths, db, sources } = await fixture();
    const lineCount = 20_000;
    const boundary = 12_345;
    const lines = Array.from({ length: lineCount }, (_, index) =>
      index === boundary - 1 ? "# Meaningful boundary\n" : `line-${index}\n`,
    );
    const text = lines.join("");
    await fs.writeFile(join(paths.inboxRoot, "long.txt"), text);
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const prepared = await sources.prepareClaim(claim);
    expect(prepared.atoms.length).toBeLessThanOrEqual(2048);
    const containingAtom = prepared.atoms.find(({ startLine, endLine }) => startLine < boundary && boundary < endLine);
    expect(containingAtom).toBeDefined();
    const result = await sources.publishPreparedClaim({
      prepared,
      preparedId: prepared.preparedId,
      claimId: prepared.claimId,
      digest: prepared.digest,
      endpoints: [boundary, lineCount],
    });
    const extracted = await fs.readFile(join(result.packetPath, "extracted.md"));
    expect(extracted.toString()).toBe(text);
    const chunkBodies = await Promise.all(
      (await fs.readdir(join(result.packetPath, "chunks")))
        .sort()
        .map((name) => fs.readFile(join(result.packetPath, "chunks", name))),
    );
    const firstChunk = lines.slice(0, boundary).join("");
    expect(chunkBodies[0]?.toString()).toBe(firstChunk);
    expect(chunkBodies[1]?.toString()).toBe(lines.slice(boundary).join(""));
    expect(Buffer.concat(chunkBodies).equals(extracted)).toBe(true);
    db.close();
  });
  it("flushes a trailing-newline planning group without inventing an extra line", async () => {
    const { paths, db, sources } = await fixture();
    const lineCount = 2_051;
    const text = Array.from({ length: lineCount }, (_, index) => `line-${index}\n`).join("");
    await fs.writeFile(join(paths.inboxRoot, "odd-lines.txt"), text);
    const [entry] = await sources.discover();
    if (!entry) throw new Error("source entry was not discovered");
    const prepared = await sources.prepareClaim(await sources.claim(entry));
    expect(prepared.atoms).toHaveLength(1_026);
    expect(prepared.atoms.at(-1)).toMatchObject({
      startLine: lineCount,
      endLine: lineCount,
      startByte: text.length - `line-${lineCount - 1}\n`.length,
      endByte: text.length,
    });
    db.close();
  });

  it("validates newline-heavy files with metadata bounded by proposed chunks", async () => {
    const { root, db } = await fixture();
    const lineCount = 100_001;
    const path = join(root, "newline-heavy.txt");
    await fs.writeFile(path, "\n".repeat(lineCount));
    const validated = await validateFileEndpoints(path, [25_000, 50_000, 75_000, lineCount]);
    expect(Object.keys(validated)).toEqual(["chunks"]);
    expect(validated.chunks).toHaveLength(4);
    expect(validated.chunks.at(-1)).toMatchObject({
      startLine: 75_001,
      endLine: lineCount,
      startByte: 75_000,
      endByte: lineCount,
    });
    db.close();
  });

  it("preserves blank runs in native JavaScript and Python code", async () => {
    const cases = [
      ["literal.js", "const value = `first\n\n\nlast`;\n"],
      ["literal.py", "value = '''first\n\n\nlast'''\n"],
    ] as const;
    for (const [name, code] of cases) {
      const { paths, db, sources } = await fixture();
      await fs.writeFile(join(paths.inboxRoot, name), code);
      const [entry] = await sources.discover();
      if (!entry) throw new Error("source entry was not discovered");
      const result = await sources.admitClaim(await sources.claim(entry));
      expect(await fs.readFile(join(result.packetPath, "extracted.md"), "utf8")).toBe(code);
      db.close();
    }
  });
  it("preserves code blank runs inside native directory extraction", async () => {
    const { root, db, sources } = await fixture();
    const directory = join(root, "embedded");
    await fs.mkdir(directory);
    await fs.writeFile(join(directory, "example.js"), "const value = 1;\n\n\nconst next = 2;\n");
    await fs.writeFile(join(directory, "notes.md"), "before\n\n\nafter\n");
    const ruby = ["message = <<~TEXT", "first", "", "", "last", "TEXT", ""].join("\n");
    await fs.writeFile(join(directory, "example.rb"), ruby);
    const staged = await sources.stage({ path: directory });
    const [entry] = await sources.discover();
    if (!entry) throw new Error("embedded directory was not discovered");
    const result = await sources.admitClaim(await sources.claim(entry));
    const extracted = await fs.readFile(join(result.packetPath, "extracted.md"), "utf8");
    expect(extracted).toContain("--- FILE: example.js ---\nconst value = 1;\n\n\nconst next = 2;\n");
    expect(extracted).toContain(`--- FILE: example.rb ---\n${ruby}`);
    expect(extracted).toContain("--- FILE: notes.md ---\nbefore\n\nafter\n");
    expect(staged.kind).toBe("directory");
    db.close();
  });
  it("keeps prepared directory payloads out of the inbox until publication", async () => {
    const { root, paths, db, sources } = await fixture();
    const directory = join(root, "prepared-directory");
    await fs.mkdir(directory);
    await fs.writeFile(join(directory, "notes.txt"), "private\n");
    const prepared = await sources.prepareStage({ path: directory });
    expect(await sources.discover()).toEqual([]);
    expect(await fs.readdir(paths.inboxRoot)).toEqual([]);
    const published = await sources.publishPreparedStage(prepared);
    expect(published.kind).toBe("directory");
    expect((await sources.discover()).map((entry) => entry.relativePath)).toEqual([published.relativePath]);
    db.close();
  });
  it("rejects preexisting prepared targets without replacing direct bytes", async () => {
    const { root, paths, db, sources } = await fixture();
    const filePrepared = await sources.prepareStage({ kind: "text", text: "prepared\n", name: "race.txt" });
    const fileTarget = join(paths.inboxRoot, filePrepared.relativePath);
    await fs.writeFile(fileTarget, "direct-file\n");
    await expect(sources.publishPreparedStage(filePrepared)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(fileTarget, "utf8")).toBe("direct-file\n");

    const directory = join(root, "race-directory-source");
    await fs.mkdir(directory);
    await fs.writeFile(join(directory, "prepared.txt"), "prepared-directory\n");
    const directoryPrepared = await sources.prepareStage({ path: directory, name: "race-directory" });
    const directoryTarget = join(paths.inboxRoot, directoryPrepared.relativePath);
    await fs.mkdir(directoryTarget);
    await fs.writeFile(join(directoryTarget, "direct.txt"), "direct-directory\n");
    await expect(sources.publishPreparedStage(directoryPrepared)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(join(directoryTarget, "direct.txt"), "utf8")).toBe("direct-directory\n");
    expect(new Set((await sources.discover()).map((entry) => entry.relativePath))).toEqual(
      new Set([filePrepared.relativePath, directoryPrepared.relativePath]),
    );
    db.close();
  });
  it("resets Markdown fence normalization at native file boundaries", async () => {
    const { root, db, sources } = await fixture();
    const directory = join(root, "fence-boundaries");
    await fs.mkdir(directory);
    await fs.writeFile(join(directory, "first.md"), "before\n\n\n```\ninside\n");
    await fs.writeFile(join(directory, "second.md"), "before\n\n\nafter\n");
    await sources.stage({ path: directory });
    const [entry] = await sources.discover();
    if (!entry) throw new Error("fence-boundaries directory was not discovered");
    const result = await sources.admitClaim(await sources.claim(entry));
    const extracted = await fs.readFile(join(result.packetPath, "extracted.md"), "utf8");
    expect(extracted).toContain("--- FILE: first.md ---\nbefore\n\n```\ninside\n");
    expect(extracted).toContain("--- FILE: second.md ---\nbefore\n\nafter\n");
    db.close();
  });
  it("preserves code blank runs after marker-looking text inside a multiline body", async () => {
    const { root, db, sources } = await fixture();
    const directory = join(root, "marker-body");
    await fs.mkdir(directory);
    const code = ["const value = `first", "--- END FILE: notes.md ---", "", "", "last`;", ""].join("\n");
    await fs.writeFile(join(directory, "example.js"), code);
    await fs.writeFile(join(directory, "notes.md"), "notes\n");
    await sources.stage({ path: directory });
    const [entry] = await sources.discover();
    if (!entry) throw new Error("marker-body directory was not discovered");
    const result = await sources.admitClaim(await sources.claim(entry));
    const extracted = await fs.readFile(join(result.packetPath, "extracted.md"), "utf8");
    expect(extracted).toContain(`--- FILE: example.js ---\n${code}`);
    db.close();
  });
  it("normalizes blank runs outside fences while preserving original bytes and fenced content", async () => {
    const { paths, db, sources } = await fixture();
    const original = "before\n\n\n```\ninside\n\n\n```\n\n\nafter\n";
    await fs.writeFile(join(paths.inboxRoot, "normalize.md"), original);
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    expect((await fs.readFile(join(result.packetPath, "extracted.md"))).toString()).toBe(
      "before\n\n```\ninside\n\n\n```\n\nafter\n",
    );
    expect((await fs.readFile(join(result.packetPath, "original", "normalize.md"))).toString()).toBe(original);
    expect(result.manifest.normalizer).toEqual({ name: "markdown-blank-lines", version: "2" });
    db.close();
  });
  it("rejects packets with an obsolete normalizer declaration", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "obsolete-normalizer.txt"), "evidence\n");
    const [entry] = await sources.discover();
    if (!entry) throw new Error("source entry was not discovered");
    const claim = await sources.claim(entry);
    const result = await sources.admitClaim(claim);
    const manifestPath = join(result.packetPath, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.normalizer = { name: "markdown-blank-lines", version: "1" };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(sources.admitClaim(claim)).rejects.toThrow(/normalizer/iu);
    expect(doctor(paths.vaultRoot).checks.find((item) => item.name === "source-packets")?.status).toBe("fail");
    db.close();
  }, 15_000);

  it("prepares immutable work artifacts and publishes only the bound claim", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "prepared.txt"), "one\ntwo\n");
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const prepared = await sources.prepareClaim(claim);
    expect(prepared).toMatchObject({
      claimId: claim.claimId,
      kind: "text",
      digest: claim.snapshot.digest,
      atoms: [
        { index: 0, startByte: 0, endByte: 4, byteLength: 4 },
        { index: 1, startByte: 4, endByte: 8, byteLength: 4 },
      ],
    });
    expect(prepared).not.toHaveProperty("bytes");
    expect(prepared.snapshotPath).toMatch(/^\.pi-scholar\/work\//);
    expect((await fs.readFile(join(paths.vaultRoot, prepared.extractedPath))).toString()).toBe("one\ntwo\n");
    const result = await sources.publishPreparedClaim({
      prepared,
      preparedId: prepared.preparedId,
      claimId: prepared.claimId,
      digest: prepared.digest,
      endpoints: [2],
    });
    const retry = await sources.publishPreparedClaim({
      prepared,
      preparedId: prepared.preparedId,
      claimId: prepared.claimId,
      digest: prepared.digest,
      endpoints: [2],
    });
    expect(retry).toBe(result);
    expect(
      db.get<{ source_id: string }>("SELECT source_id FROM sources WHERE source_id = ?", [result.sourceId])?.source_id,
    ).toBe(result.sourceId);
    expect(
      db.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_files WHERE source_id = ?", [result.sourceId])
        ?.count,
    ).toBe(1);
    expect(
      db.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_chunks WHERE source_id = ?", [result.sourceId])
        ?.count,
    ).toBe(1);
    expect(result.manifest.extractedDigest).toBe(result.manifest.extractionDigest);
    expect(await fs.readdir(paths.inboxRoot)).toHaveLength(0);
    db.close();
  });

  it("rolls back a newly renamed packet when durable source recording fails", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "rollback.txt"), "rollback\n");
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const prepared = await sources.prepareClaim(claim);
    db.close();
    await expect(
      sources.publishPreparedClaim({
        prepared,
        preparedId: prepared.preparedId,
        claimId: prepared.claimId,
        digest: prepared.digest,
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(paths.sourcesRoot)).toHaveLength(0);
    expect(await fs.readdir(paths.inboxRoot)).toEqual(["rollback.txt"]);
    await sources.cleanupPrepared(prepared.preparedId);
  });

  it("strips URL secrets from staged and published provenance while fetching the full URL transiently", async () => {
    const { paths, db } = await fixture();
    let fetchedUrl = "";
    const sources = new SourceService(db, paths, {
      fetchUrl: async (url) => {
        fetchedUrl = url;
        return { bytes: Buffer.from("remote\n"), mediaType: "text/plain", name: "remote.txt" };
      },
    });
    await sources.stage({ url: "https://user:secret@example.com/path/remote.txt?token=abc#fragment" });
    expect(fetchedUrl).toContain("user:secret@example.com/path/remote.txt?token=abc#fragment");
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    expect(result.manifest.sourceUri).toBe("https://example.com/path/remote.txt");
    expect(result.manifest.normalizer).toEqual({ name: "markdown-blank-lines", version: "2" });
    expect(JSON.stringify(result.manifest)).not.toMatch(/secret|token|fragment/iu);
    expect(
      db.get<Record<string, unknown>>("SELECT source_uri FROM sources WHERE source_id = ?", [result.sourceId])
        ?.source_uri,
    ).toBe("https://example.com/path/remote.txt");
    db.close();
  });
  it("uses adapter URL names after fetch for metadata and textual extraction", async () => {
    const { paths, db } = await fixture();
    const sources = new SourceService(db, paths, {
      fetchUrl: async () => ({ bytes: Buffer.from("# fetched\n"), name: "fetched.md" }),
    });
    const explicit = await sources.prepareStage({
      url: "https://example.com/download",
      name: "ignored.txt",
      originalName: "requested.txt",
      displayName: "Shown",
    });
    expect(explicit.metadata).toMatchObject({ originalName: "requested.txt", displayName: "Shown" });
    await sources.cleanupPreparedStage(explicit);
    const staged = await sources.stage({ url: "https://example.com/download" });
    expect(staged.metadata).toMatchObject({ originalName: "fetched.md", displayName: "fetched.md" });
    const [entry] = await sources.discover();
    if (!entry) throw new Error("adapter URL entry was not discovered");
    const result = await sources.admitClaim(await sources.claim(entry));
    expect(result.manifest.originalName).toBe("fetched.md");
    expect(await fs.readFile(join(result.packetPath, "extracted.md"), "utf8")).toBe("# fetched\n");
    db.close();
  });
  it("uses the final redirect basename for textual URL extraction", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/remote.md" });
        response.end();
        return;
      }
      response.end("# redirected\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("redirect test server address is unavailable");
      const { paths, db } = await fixture();
      try {
        const sources = new SourceService(db, paths);
        const staged = await sources.stage({ url: `http://127.0.0.1:${address.port}/start` });
        expect(staged.metadata).toMatchObject({ originalName: "remote.md", displayName: "remote.md" });
        const [entry] = await sources.discover();
        if (!entry) throw new Error("redirect URL entry was not discovered");
        const result = await sources.admitClaim(await sources.claim(entry));
        expect(result.manifest.originalName).toBe("remote.md");
        expect(await fs.readFile(join(result.packetPath, "extracted.md"), "utf8")).toBe("# redirected\n");
      } finally {
        db.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects control-character display names from default URL staging", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("remote\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("URL test server address is unavailable");
      const { paths, db } = await fixture();
      try {
        const sources = new SourceService(db, paths);
        await expect(
          sources.stage({
            url: `http://127.0.0.1:${address.port}/remote.txt`,
            displayName: `remote${String.fromCharCode(10)}name`,
          }),
        ).rejects.toBeInstanceOf(ValidationError);
      } finally {
        db.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it("keeps streamed URL envelopes private until the payload is complete", async () => {
    const firstChunk = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.write("partial\n", () => firstChunk.resolve());
      void release.promise.then(() => response.end("complete\n"));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("URL test server address is unavailable");
    const { paths, db } = await fixture();
    const sources = new SourceService(db, paths);
    const pending = sources.stage({ url: `http://127.0.0.1:${address.port}/stream.txt` });
    try {
      await firstChunk.promise;
      expect(await sources.discover()).toEqual([]);
      expect(await fs.readdir(paths.inboxRoot)).toEqual([]);
      release.resolve();
      const staged = await pending;
      expect(await fs.readFile(join(staged.absolutePath, "payload"), "utf8")).toBe("partial\ncomplete\n");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      db.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it("enforces a wall-clock deadline for slow-drip URL responses", async () => {
    vi.useFakeTimers();
    const requestSeen = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      requestSeen.resolve();
      response.setHeader("content-type", "text/plain");
      response.write("partial\n");
      const interval = setInterval(() => response.write("drip\n"), 5);
      response.on("close", () => clearInterval(interval));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("URL timeout server address is unavailable");
      const root = await fs.mkdtemp(join("/tmp", "pi-scholar-url-timeout-"));
      try {
        const target = join(root, "payload");
        const pending = requestSourceToFile(new URL(`http://127.0.0.1:${address.port}/slow.txt`), target, 35);
        const rejection = expect(pending).rejects.toThrow(/timed out/iu);
        await requestSeen.promise;
        await vi.advanceTimersByTimeAsync(35);
        await rejection;
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      vi.useRealTimers();
    }
  });

  it("accepts loopback URLs and disk-backed uploads without a fixed size cap", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.setHeader("content-length", "9");
      response.end("loopback\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("loopback server address is unavailable");
      const { paths, db } = await fixture();
      try {
        const sources = new SourceService(db, paths);
        const stagedUrl = await sources.stage({ url: `http://127.0.0.1:${address.port}/loopback.txt` });
        expect((await fs.readFile(join(stagedUrl.absolutePath, "payload"))).toString()).toBe("loopback\n");
        const largePath = join(paths.workRoot, "large.txt");
        await fs.writeFile(largePath, "x");
        const largeSize = 100 * 1024 * 1024 + 1;
        await fs.truncate(largePath, largeSize);
        const stagedUpload = await sources.stage({ kind: "upload", filePath: largePath, originalName: "large.txt" });
        expect((await fs.stat(join(stagedUpload.absolutePath, "payload"))).size).toBe(largeSize);
        expect((await fs.stat(largePath)).size).toBe(largeSize);
      } finally {
        db.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("fetches bracketed IPv6 loopback URLs", async ({ skip }) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("ipv6-loopback\n");
    });
    const available = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") resolve(false);
        else reject(error);
      });
      server.listen(0, "::1", () => resolve(true));
    });
    if (!available) {
      skip();
      return;
    }
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("IPv6 loopback server address is unavailable");
      const { paths, db } = await fixture();
      try {
        const sources = new SourceService(db, paths);
        const staged = await sources.stage({ url: `http://[::1]:${address.port}/ipv6-loopback.txt` });
        expect((await fs.readFile(join(staged.absolutePath, "payload"))).toString()).toBe("ipv6-loopback\n");
      } finally {
        db.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("uses a unique exclusive work directory for concurrent prepares", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "concurrent.txt"), "same\n");
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const prepared = await Promise.all([sources.prepareClaim(claim), sources.prepareClaim(claim)]);
    expect(prepared[0]?.preparedId).not.toBe(prepared[1]?.preparedId);
    expect(await fs.stat(join(paths.workRoot, `admission-${prepared[0]?.preparedId}`))).toBeTruthy();
    expect(await fs.stat(join(paths.workRoot, `admission-${prepared[1]?.preparedId}`))).toBeTruthy();
    await Promise.all(prepared.map((item) => sources.cleanupPrepared(item.preparedId)));
    db.close();
  });

  it("rejects prepared metadata and attachment tampering before publication", async () => {
    const { paths, db } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "document.pdf"), "document\n");
    const sources = new SourceService(db, paths, {
      docling: async () => ({ extracted: "converted\n", attachments: [{ path: "figure.bin", bytes: "original" }] }),
    });
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const prepared = await sources.prepareClaim(claim);
    const root = join(paths.workRoot, `admission-${prepared.preparedId}`);
    const metadataPath = join(root, ".pi-scholar-prepared.json");
    const metadata = JSON.parse((await fs.readFile(metadataPath)).toString()) as Record<string, unknown>;
    metadata.displayName = "tampered";
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    await expect(
      sources.publishPreparedClaim({
        prepared,
        preparedId: prepared.preparedId,
        claimId: prepared.claimId,
        digest: prepared.digest,
      }),
    ).rejects.toThrow(/identity|retained/iu);
    await sources.cleanupPrepared(prepared.preparedId);
    const preparedAgain = await sources.prepareClaim(claim);
    await fs.writeFile(
      join(paths.workRoot, `admission-${preparedAgain.preparedId}`, "attachments", "figure.bin"),
      "tampered",
    );
    await expect(
      sources.publishPreparedClaim({
        prepared: preparedAgain,
        preparedId: preparedAgain.preparedId,
        claimId: preparedAgain.claimId,
        digest: preparedAgain.digest,
      }),
    ).rejects.toThrow(/attachment digest/iu);
    await sources.cleanupPrepared(preparedAgain.preparedId);
    db.close();
  });

  it("rejects incoherent source payload kinds and symlinked paths", async () => {
    const { root, paths, db, sources } = await fixture();
    await expect(sources.stage({ url: "https://example.com/source.txt", kind: "text" })).rejects.toThrow(
      /URL source kind/iu,
    );
    await expect(sources.stage({ text: "pasted", kind: "document" })).rejects.toThrow(/text source kind/iu);
    await expect(sources.stage({ bytes: new Uint8Array([1]), kind: "text" })).rejects.toThrow(/bytes source kind/iu);
    const outside = join(root, "outside.txt");
    await fs.writeFile(outside, "outside");
    await expect(sources.stage({ path: outside, kind: "note" })).rejects.toThrow(/path source kind/iu);
    const linkedDirectory = join(root, "linked-directory");
    await fs.symlink(root, linkedDirectory);
    await expect(sources.stage({ path: join(linkedDirectory, "outside.txt") })).rejects.toThrow(/symlink/iu);
    expect(await fs.readdir(paths.inboxRoot)).toHaveLength(0);
    db.close();
  });

  it("stages repository files from Git tracked and unignored paths only", async () => {
    const { root, paths, db } = await fixture();
    const repository = join(root, "repository");
    await fs.mkdir(repository);
    const git = (args: string[]) => runChild("git", args, { cwd: repository, timeoutMs: 10_000 });
    expect((await git(["init", "--quiet"])).code).toBe(0);
    await fs.writeFile(join(repository, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(join(repository, "tracked.txt"), "tracked\n");
    await fs.writeFile(join(repository, "ignored.txt"), "secret\n");
    await fs.mkdir(join(repository, "nested", ".git"), { recursive: true });
    await fs.writeFile(join(repository, "nested", ".git", "internal"), "internal\n");
    expect((await git(["add", "--", ".gitignore", "tracked.txt"])).code).toBe(0);
    expect(
      (
        await git([
          "-c",
          "user.name=Pi Scholar",
          "-c",
          "user.email=pi-scholar@example.com",
          "commit",
          "--quiet",
          "-m",
          "initial",
        ])
      ).code,
    ).toBe(0);
    expect((await git(["rev-parse", "HEAD"])).stdout.trim()).not.toBe("revision");
    const sources = new SourceService(db, paths, { gitRevision: () => "revision" });
    const staged = await sources.stage({ path: repository });
    expect(staged.kind).toBe("repository");
    expect(staged.relativePath).toMatch(/^[0-9a-f-]+\.pi-scholar$/iu);
    expect(staged.metadata).toMatchObject({
      requestedKind: "repository",
      kind: "repository",
      repositoryRevision: "revision",
      payload: "payload",
    });
    const payload = join(staged.absolutePath, "payload");
    expect((await fs.readFile(join(payload, "tracked.txt"))).toString()).toBe("tracked\n");
    await expect(fs.lstat(join(staged.absolutePath, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(join(staged.absolutePath, ".git", "config"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(join(staged.absolutePath, ".git", "hooks"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(join(payload, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(join(payload, "nested", ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    expect(claim.snapshot.revision).toBe("revision");
    expect(claim.snapshot.files.map((file) => file.path)).toEqual([".gitignore", "tracked.txt"]);
    db.close();
  });
  it("rejects repository staging when the revision changes after copying", async () => {
    const { root, paths, db } = await fixture();
    const repository = join(root, "changing-repository");
    await fs.mkdir(repository);
    const git = (args: string[]) => runChild("git", args, { cwd: repository, timeoutMs: 10_000 });
    expect((await git(["init", "--quiet"])).code).toBe(0);
    await fs.writeFile(join(repository, "tracked.txt"), "tracked\n");
    let revisionCalls = 0;
    const sources = new SourceService(db, paths, {
      gitRevision: () => {
        revisionCalls += 1;
        return revisionCalls < 3 ? "revision" : "changed";
      },
    });
    await expect(sources.stage({ path: repository })).rejects.toThrow(/repository changed/iu);
    expect(await fs.readdir(paths.inboxRoot)).toHaveLength(0);
    expect(revisionCalls).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it("rejects incomplete endpoint plans and unsafe staging", async () => {
    const { root, paths, db, sources } = await fixture();
    expect(() => validateChunkEndpoints("a\nb\n", [1])).toThrow();
    expect(() => validateChunkEndpoints("a\nb\n", [{ endAtom: 2 } as never])).toThrow();
    expect(() => validateChunkEndpoints("a\nb\n", [{ endLine: 2, index: 2 } as never])).toThrow();
    await fs.writeFile(join(root, "outside.txt"), "outside");
    await expect(sources.stage({ path: join(root, "outside.txt"), name: "../escape.txt" })).rejects.toThrow();
    await fs.symlink(join(root, "outside.txt"), join(paths.inboxRoot, "link.txt"));
    await expect(sources.stage({ path: join(paths.inboxRoot, "link.txt") })).rejects.toThrow();
    const controlDirectory = join(root, "control-directory");
    await fs.mkdir(controlDirectory);
    await fs.writeFile(join(controlDirectory, `bad${String.fromCharCode(10)}name.txt`), "bad");
    await expect(sources.stage({ path: controlDirectory })).rejects.toThrow(/invalid relative path/iu);
    const unicodeDirectory = join(root, "unicode-directory");
    const unicodeName = "résumé-文.txt";
    await fs.mkdir(unicodeDirectory);
    await fs.writeFile(join(unicodeDirectory, unicodeName), "unicode");
    const staged = await sources.stage({ path: unicodeDirectory });
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    expect(claim.snapshot.files.map((file) => file.path)).toEqual([unicodeName]);
    expect(staged.kind).toBe("directory");
    db.close();
  });

  it("does not recreate a missing inbox during discovery", async () => {
    const { paths, db, sources } = await fixture();
    await fs.rm(paths.inboxRoot, { recursive: true, force: true });
    await expect(sources.discover()).rejects.toThrow(/ENOENT|inbox/iu);
    await expect(fs.lstat(paths.inboxRoot)).rejects.toMatchObject({ code: "ENOENT" });
    db.close();
  });
  it("rejects tampered retained packets before re-admission", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "tampered.txt"), "evidence\n");
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const result = await sources.admitClaim(claim);
    await fs.writeFile(join(result.packetPath, "chunks", "0001.md"), "tampered\n");
    await expect(sources.admitClaim(claim)).rejects.toThrow(/chunk digest|chunk coverage|reconstruction/iu);
    expect(
      db.get<{ status: string }>("SELECT status FROM sources WHERE source_id = ?", [result.sourceId])?.status,
    ).toBe("published");
    db.close();
  });
  it("rejects metadata-only tampering in retained packet provenance", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "metadata-tamper.txt"), "evidence\n");
    const [entry] = await sources.discover();
    if (!entry) throw new Error("source entry was not discovered");
    const result = await sources.admitClaim(await sources.claim(entry));
    const manifestPath = join(result.packetPath, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.displayName = "forged display name";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(sources.publishedPackets()).rejects.toThrow(/unverified/iu);
    db.close();
  });
  it("rejects converter and future-field tampering in retained manifests", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "converter-tamper.txt"), "evidence\n");
    const [entry] = await sources.discover();
    if (!entry) throw new Error("source entry was not discovered");
    const claim = await sources.claim(entry);
    const result = await sources.admitClaim(claim);
    const manifestPath = join(result.packetPath, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.converter = { name: "forged-converter", version: "9" };
    manifest.futureProvenance = "forged";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(sources.publishedPackets()).rejects.toThrow(/unverified/iu);
    await expect(sources.admitClaim(claim)).rejects.toThrow(/manifest digest/iu);
    expect(doctor(paths.vaultRoot).checks.find((item) => item.name === "source-packets")?.status).toBe("fail");
    db.close();
  });
  it("rejects forged provenance before recovery can rewrite the source row", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "recovery-tamper.txt"), "evidence\n");
    const [entry] = await sources.discover();
    if (!entry) throw new Error("source entry was not discovered");
    const claim = await sources.claim(entry);
    const result = await sources.admitClaim(claim);
    const manifestPath = join(result.packetPath, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.displayName = "recovery forgery";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(sources.admitClaim(claim)).rejects.toThrow(/manifest digest|provenance|unverified/iu);
    expect(
      db.get<{ display_name: string }>("SELECT display_name FROM sources WHERE source_id = ?", [result.sourceId])
        ?.display_name,
    ).toBe(result.manifest.displayName);
    db.close();
  });
  it("recovers a retained packet whose catalog write was interrupted", async () => {
    const { paths, db, sources } = await fixture();
    const inboxPath = join(paths.inboxRoot, "interrupted-catalog.txt");
    await fs.writeFile(inboxPath, "evidence\n");
    const [entry] = await sources.discover();
    if (!entry) throw new Error("source entry was not discovered");
    const published = await sources.admitClaim(await sources.claim(entry));
    db.run("DELETE FROM sources WHERE source_id = ?", [published.sourceId]);

    await fs.writeFile(inboxPath, "evidence\n");
    const [replacement] = await sources.discover();
    if (!replacement) throw new Error("replacement source entry was not discovered");
    const recovered = await sources.admitClaim(await sources.claim(replacement));
    expect(recovered.sourceId).toBe(published.sourceId);
    expect(
      db.get<{ status: string }>("SELECT status FROM sources WHERE source_id = ?", [published.sourceId])?.status,
    ).toBe("published");
    db.close();
  });

  it("rejects file and attachment media types that disagree with manifest provenance", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "media-tamper.txt"), "evidence\n");
    const [entry] = await sources.discover();
    if (!entry) throw new Error("source entry was not discovered");
    const result = await sources.admitClaim(await sources.claim(entry));
    const manifestPath = join(result.packetPath, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const files = manifest.files as Array<Record<string, unknown>>;
    const file = files[0];
    if (!file) throw new Error("source manifest file is missing");
    file.mediaType = "application/forged";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(sources.publishedPackets()).rejects.toThrow(/unverified/iu);
    db.close();
  });

  it("rejects original-byte tampering when the manifest file entry is forged too", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "original-tamper.txt"), "evidence\n");
    const [entry] = await sources.discover();
    if (!entry) throw new Error("source entry was not discovered");
    const result = await sources.admitClaim(await sources.claim(entry));
    const manifestPath = join(result.packetPath, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const files = manifest.files as Array<Record<string, unknown>>;
    const file = files[0];
    if (!file || typeof file.relativePath !== "string") throw new Error("source manifest file is missing");
    const originalPath = join(result.packetPath, "original", file.relativePath);
    const tampered = await fs.readFile(originalPath);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    file.digest = sha256(tampered);
    file.bytes = tampered.byteLength;
    file.byteLength = tampered.byteLength;
    await fs.writeFile(originalPath, tampered);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(sources.publishedPackets()).rejects.toThrow(/unverified/iu);
    db.close();
  });
  it("reactivates a removed deterministic packet without replacing its history", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "reactivate.txt"), "evidence\n");
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const result = await sources.admitClaim(claim);
    const createdAt = db.get<{ created_at: string }>("SELECT created_at FROM sources WHERE source_id = ?", [
      result.sourceId,
    ])?.created_at;
    if (!createdAt) throw new Error("source created_at is missing");
    const preview = sources.removalPreview(result.sourceId);
    await sources.removeConfirmed(result.sourceId, preview.confirmationId);
    db.run("UPDATE sources SET error_code = ?, error_message = ? WHERE source_id = ?", [
      "ADMISSION_FAILED",
      "stale diagnostic",
      result.sourceId,
    ]);
    await fs.writeFile(join(paths.inboxRoot, "reactivate.txt"), "evidence\n");
    const [replacement] = await sources.discover();
    const reactivated = await sources.admitClaim(await sources.claim(replacement));
    const row = db.get<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      created_at: string;
      manifest_path: string;
    }>("SELECT status, error_code, error_message, created_at, manifest_path FROM sources WHERE source_id = ?", [
      result.sourceId,
    ]);
    expect(reactivated.sourceId).toBe(result.sourceId);
    expect(row).toMatchObject({
      status: "published",
      error_code: null,
      error_message: null,
      created_at: createdAt,
      manifest_path: result.packetPath,
    });
    db.close();
  });

  it("keeps published packets immutable and rejects stale removal consent", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "source.txt"), "evidence\n");
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const before = await fs.readFile(join(result.packetPath, "extracted.md"));
    const preview = sources.removalPreview(result.sourceId);
    db.run("INSERT INTO source_dependencies (source_id, page_id, chunk_id, relation) VALUES (?, NULL, ?, ?)", [
      result.sourceId,
      result.manifest.chunks[0]?.chunkId,
      "citation",
    ]);
    await expect(sources.removeConfirmed(result.sourceId, preview.confirmationId)).rejects.toThrow(/stale/i);
    expect((await fs.readFile(join(result.packetPath, "extracted.md"))).equals(before)).toBe(true);
    db.close();
  });
  it("derives source dependents only from keyed OKF provenance", async () => {
    const { paths, db, sources, wiki } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "source.txt"), "evidence\n");
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const chunkId = result.manifest.chunks[0]?.chunkId;
    if (!chunkId) throw new Error("source chunk is missing");
    await expect(
      wiki.create({
        path: "raw-id.md",
        body: `# Raw ID\n\nThis text contains ${chunkId} without a keyed claim.\n`,
      }),
    ).rejects.toThrow();
    const external = await wiki.create({
      path: "external-id.md",
      body: `# External ID\n\nThis text mentions ${result.sourceId} but does not cite it.\n`,
    });
    expect(sources.removalPreview(result.sourceId).dependentPageIds).not.toContain(external.page.pageId);
    db.close();
  });
  it("fails removal preview on mismatched managed OKF provenance", async () => {
    const { paths, db, sources, wiki } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "source.txt"), "evidence\n");
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const chunkId = result.manifest.chunks[0]?.chunkId;
    if (!chunkId) throw new Error("source chunk is missing");
    const page = await wiki.create({
      path: "mismatched-provenance.md",
      body: `# Grounded\n\nGrounded at [^${chunkId}].\n`,
    });
    const pagePath = join(paths.wikiRoot, page.page.relativePath);
    const markdown = await fs.readFile(pagePath, "utf8");
    const tampered = markdown.replace(/^(\s*source_digest:\s*).+$/mu, "$1mismatched");
    expect(tampered).not.toBe(markdown);
    await fs.writeFile(pagePath, tampered);
    expect(() => sources.removalPreview(result.sourceId)).toThrow(/provenance/i);
    db.close();
  });
  it("previews page and open-quiz dependents and restores the packet after a failed removal transaction", async () => {
    const { root, paths, db, sources, wiki } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "source.txt"), "evidence\n");
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const chunkId = result.manifest.chunks[0]?.chunkId;
    if (!chunkId) throw new Error("source chunk is missing");
    const page = await wiki.create({
      path: "grounded.md",
      description: "Grounded page removal behavior.",
      body: `# Grounded\n\nGrounded at [^${chunkId}].\n`,
      quizWorthiness: "eligible",
    });
    const pageId = page.page.pageId;
    const now = new Date().toISOString();
    const sheetPath = join(paths.quizzesRoot, "2099", "01", "2099-01-01.md");
    await fs.mkdir(join(paths.quizzesRoot, "2099", "01"), { recursive: true });
    const sheetBefore = Buffer.from("# canonical quiz\n");
    await fs.writeFile(sheetPath, sheetBefore);
    await fs.chmod(sheetPath, 0o640);
    const sheetBeforeMode = (await fs.stat(sheetPath)).mode & 0o777;
    expect(sheetBeforeMode).not.toBe(0o600);
    db.run(
      "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'open', ?, ?, NULL, NULL, NULL)",
      ["quiz-removal", "2099-01-01", sheetPath, now],
    );
    db.run(
      "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, source_refs_json) VALUES (?, ?, 0, ?, ?, NULL, NULL, ?)",
      ["question-removal", "quiz-removal", "free-response", "Explain", "[]"],
    );
    db.run("INSERT INTO question_pages (question_id, page_id, criterion_json, weight) VALUES (?, ?, ?, ?)", [
      "question-removal",
      pageId,
      JSON.stringify("Explain"),
      1,
    ]);
    db.run(
      "INSERT INTO quiz_evidence (quiz_id, reference, page_id, relative_path, anchor, heading, page_digest, page_revision, text_digest, excerpt, excerpt_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "quiz-removal",
        "evidence-removal",
        pageId,
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
    const preview = sources.removalPreview(result.sourceId);
    expect(preview.dependentPageIds).toContain(pageId);
    const originalRun = db.run.bind(db);
    db.run = ((sql: string, parameters?: readonly unknown[]) => {
      if (sql.startsWith("UPDATE sources SET status")) throw new Error("forced removal failure");
      return originalRun(sql, parameters);
    }) as typeof db.run;
    await expect(sources.removeConfirmed(result.sourceId, preview.confirmationId)).rejects.toThrow(
      "forced removal failure",
    );
    expect((await fs.readFile(sheetPath)).equals(sheetBefore)).toBe(true);
    expect((await fs.stat(sheetPath)).mode & 0o777).toBe(sheetBeforeMode);
    expect(
      db.get<{ status: string }>("SELECT status FROM sources WHERE source_id = ?", [result.sourceId])?.status,
    ).toBe("published");
    expect(db.get<{ status: string }>("SELECT status FROM quizzes WHERE quiz_id = ?", ["quiz-removal"])?.status).toBe(
      "open",
    );
    const outsidePath = join(root, "outside.md");
    const linkedSheetPath = join(paths.quizzesRoot, "linked-sheet.md");
    await fs.writeFile(outsidePath, "outside sentinel\n");
    await fs.symlink(outsidePath, linkedSheetPath);
    originalRun("UPDATE quizzes SET sheet_path = ? WHERE quiz_id = ?", [linkedSheetPath, "quiz-removal"]);
    await expect(sources.removeConfirmed(result.sourceId, preview.confirmationId)).rejects.toThrow(/path|symlink/u);
    expect((await fs.readFile(outsidePath)).toString()).toBe("outside sentinel\n");
    expect(await fs.stat(result.packetPath)).toBeDefined();
    db.close();
  });
  it("blocks removal while a cited page has an unsettled submitted quiz", async () => {
    const { paths, db, sources, wiki } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "source.txt"), "evidence\n");
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const chunkId = result.manifest.chunks[0]?.chunkId;
    if (!chunkId) throw new Error("source chunk is missing");
    const page = await wiki.create({
      path: "submitted-grounding.md",
      description: "Submitted quiz removal guard.",
      body: `# Grounded\n\nGrounded at [^${chunkId}].\n`,
      quizWorthiness: "eligible",
    });
    const pageId = page.page.pageId;
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'open', NULL, ?, NULL, NULL, NULL)",
      ["quiz-submitted-removal", "2099-01-02", now],
    );
    db.run(
      "INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, source_refs_json) VALUES (?, ?, 0, ?, ?, NULL, NULL, ?)",
      ["question-submitted-removal", "quiz-submitted-removal", "free-response", "Explain", "[]"],
    );
    db.run("INSERT INTO question_pages (question_id, page_id, criterion_json, weight) VALUES (?, ?, ?, ?)", [
      "question-submitted-removal",
      pageId,
      JSON.stringify("Explain"),
      1,
    ]);
    db.run(
      "INSERT INTO quiz_evidence (quiz_id, reference, page_id, relative_path, anchor, heading, page_digest, page_revision, text_digest, excerpt, excerpt_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "quiz-submitted-removal",
        "evidence-submitted-removal",
        pageId,
        page.page.relativePath,
        "#grounded",
        "Grounded",
        page.page.digest,
        1,
        "text-digest",
        `Grounded at [^${chunkId}].`,
        "excerpt-digest",
      ],
    );
    const openPreview = sources.removalPreview(result.sourceId);
    db.run("UPDATE quizzes SET status = 'submitted', submitted_at = ? WHERE quiz_id = ?", [
      now,
      "quiz-submitted-removal",
    ]);
    await expect(sources.removeConfirmed(result.sourceId, openPreview.confirmationId)).rejects.toThrow(/stale/iu);
    const preview = sources.removalPreview(result.sourceId);
    const packetBefore = await fs.readFile(join(result.packetPath, "extracted.md"));
    const sourceBefore = db.get<{ status: string }>("SELECT status FROM sources WHERE source_id = ?", [
      result.sourceId,
    ]);
    const pageBefore = db.get<{ status: string; revision: number }>(
      "SELECT status, revision FROM pages WHERE page_id = ?",
      [pageId],
    );
    const quizBefore = db.get<{ status: string }>("SELECT status FROM quizzes WHERE quiz_id = ?", [
      "quiz-submitted-removal",
    ]);
    const dependenciesBefore = db.all<Record<string, unknown>>(
      "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies WHERE source_id = ? ORDER BY page_id, chunk_id",
      [result.sourceId],
    );
    await expect(sources.removeConfirmed(result.sourceId, preview.confirmationId)).rejects.toThrow(
      /submitted quizzes without page settlement/iu,
    );
    expect((await fs.readFile(join(result.packetPath, "extracted.md"))).equals(packetBefore)).toBe(true);
    expect(await fs.lstat(result.packetPath)).toBeTruthy();
    expect(db.get("SELECT status FROM sources WHERE source_id = ?", [result.sourceId])).toEqual(sourceBefore);
    expect(db.get("SELECT status, revision FROM pages WHERE page_id = ?", [pageId])).toEqual(pageBefore);
    expect(db.get("SELECT status FROM quizzes WHERE quiz_id = ?", ["quiz-submitted-removal"])).toEqual(quizBefore);
    expect(
      db.all<Record<string, unknown>>(
        "SELECT source_id, page_id, chunk_id, relation FROM source_dependencies WHERE source_id = ? ORDER BY page_id, chunk_id",
        [result.sourceId],
      ),
    ).toEqual(dependenciesBefore);
    db.close();
  });
  it("restores an active packet from deterministic quarantine before recomputing removal confirmation", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "crash-active.txt"), "active\n");
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const preview = sources.removalPreview(result.sourceId);
    const quarantineRoot = join(paths.workRoot, "quarantine");
    const quarantine = join(quarantineRoot, `${result.sourceId}-${result.manifest.originalDigest.slice(0, 16)}`);
    await fs.mkdir(quarantineRoot, { recursive: true });
    await fs.rename(result.packetPath, quarantine);
    const removed = await sources.removeConfirmed(result.sourceId, preview.confirmationId);
    expect(removed.removed).toBe(true);
    await expect(fs.lstat(result.packetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    db.close();
  });
  it("cleans a removed source quarantine and makes retries idempotent without reapplying dependents", async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, "crash-removed.txt"), "removed\n");
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const preview = sources.removalPreview(result.sourceId);
    const quarantineRoot = join(paths.workRoot, "quarantine");
    const quarantine = join(quarantineRoot, `${result.sourceId}-${result.manifest.originalDigest.slice(0, 16)}`);
    await fs.mkdir(quarantineRoot, { recursive: true });
    await fs.rename(result.packetPath, quarantine);
    db.run("UPDATE sources SET status = ? WHERE source_id = ?", ["removed", result.sourceId]);
    const first = await sources.removeConfirmed(result.sourceId, "ignored-after-commit");
    const second = await sources.removeConfirmed(result.sourceId, preview.confirmationId);
    expect(first.removed).toBe(true);
    expect(second.removed).toBe(true);
    expect(second.dependentPageIds).toEqual([]);
    await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    db.close();
  });
});

describe("wiki mechanics", () => {
  it("rejects YAML keys that collide after string normalization", () => {
    expect(() => parseOkfConcept('---\ntrue: first\n"true": second\ntype: note\n---\n')).toThrow(/invalid OKF YAML/u);
    expect(() => parseOkfConcept('---\ntype: note\nmetadata:\n  1: number\n  "1": string\n---\n')).toThrow(
      /invalid OKF YAML/u,
    );
  });
  it("removes complete managed footnote definitions without following content", () => {
    const body = "[^managed]: first line\n    second line\n\n\tthird line\nFollowing content.\n[^keep]: ordinary\n";
    expect(removeOkfFootnoteDefinitions(body, ["managed"])).toBe("Following content.\n[^keep]: ordinary\n");
  });
  it("keeps a host page ID across guarded rename and refreshes projections", async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: "notes/one.md", title: "One", body: "# One\n\nText." });
    const renamed = await wiki.rename(created.page.pageId, "notes/two.md");
    expect(renamed.pageId).toBe(created.page.pageId);
    expect((await wiki.get(created.page.pageId)).relativePath).toBe("notes/two.md");
    const index = await fs.readFile(join(paths.wikiRoot, "index.md"), "utf8");
    const log = await fs.readFile(join(paths.wikiRoot, "log.md"), "utf8");
    validateOkfIndex(index, true);
    validateOkfLog(log);
    expect(index).toContain("notes/two.md");
    expect(index).not.toContain("notes/one.md");
    expect(log).toContain("notes/two.md");
    expect(log).not.toContain("notes/one.md");
    db.close();
  });
  it("retires a page without losing its authored snapshot or path history", async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({
      path: "notes/retire.md",
      description: "Retired page history.",
      body: "# Retire\n\nKeep this history.",
      quizWorthiness: "eligible",
    });
    const livePath = join(paths.wikiRoot, created.page.relativePath);
    const snapshotPath = join(paths.metadataRoot, "snapshots", "wiki", `${created.page.pageId}.md`);
    const snapshotBytes = await fs.readFile(snapshotPath);
    const snapshotRow = db.get<Record<string, unknown>>("SELECT * FROM authored_snapshots WHERE relative_path = ?", [
      created.page.relativePath,
    ]);
    const retired = await wiki.retire(created.page.pageId);
    expect(retired).toMatchObject({
      pageId: created.page.pageId,
      relativePath: created.page.relativePath,
      digest: created.page.digest,
      revision: created.page.revision + 1,
      status: "retired",
      quizWorthiness: "skip",
    });
    await expect(fs.lstat(livePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await wiki.list()).toEqual([]);
    const index = await fs.readFile(join(paths.wikiRoot, "index.md"), "utf8");
    const log = await fs.readFile(join(paths.wikiRoot, "log.md"), "utf8");
    expect(index).not.toContain(created.page.relativePath);
    expect(log).not.toContain(created.page.relativePath);
    expect((await fs.readFile(snapshotPath)).equals(snapshotBytes)).toBe(true);
    expect(
      db.get<Record<string, unknown>>("SELECT * FROM authored_snapshots WHERE relative_path = ?", [
        created.page.relativePath,
      ]),
    ).toEqual(snapshotRow);
    expect(
      db.get<Record<string, unknown>>("SELECT * FROM pages WHERE page_id = ?", [created.page.pageId]),
    ).toMatchObject({
      relative_path: created.page.relativePath,
      digest: created.page.digest,
      revision: created.page.revision + 1,
      status: "retired",
      quiz_worthiness: "skip",
    });
    await expect(wiki.create({ path: created.page.relativePath, body: "replacement" })).rejects.toThrow(
      /already exists/u,
    );
    db.close();
  });
  it("guards retirement of unknown, retired, and symlinked pages", async () => {
    const { root, paths, db, wiki } = await fixture();
    await expect(wiki.retire("11111111-1111-4111-8111-111111111111")).rejects.toThrow("page not found");
    const created = await wiki.create({ path: "notes/symlink-retire.md", body: "Keep the target safe." });
    await wiki.retire(created.page.pageId);
    await expect(wiki.retire(created.page.pageId)).rejects.toThrow("page is not active");
    const symlinked = await wiki.create({ path: "notes/symlink-guard.md", body: "Do not follow this link." });
    const livePath = join(paths.wikiRoot, symlinked.page.relativePath);
    const outsidePath = join(root, "outside.md");
    await fs.writeFile(outsidePath, "outside\n");
    await fs.rm(livePath);
    await fs.symlink(outsidePath, livePath);
    await expect(wiki.retire(symlinked.page.pageId)).rejects.toThrow(/symlink|regular file/u);
    expect(await fs.readFile(outsidePath, "utf8")).toBe("outside\n");
    db.close();
  });
  it("rejects rename after an unsupported direct edit", async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: "notes/drift-before-rename.md", body: "original" });
    await fs.appendFile(join(paths.wikiRoot, created.page.relativePath), "\nexternal edit\n");
    await expect(wiki.rename(created.page.pageId, "notes/renamed.md")).rejects.toThrow(/inspect drift/u);
    expect((await wiki.get(created.page.pageId)).relativePath).toBe(created.page.relativePath);
    await expect(fs.access(join(paths.wikiRoot, "notes", "renamed.md"))).rejects.toThrow();
    db.close();
  });

  it("seeds and preserves conformant empty projections", async () => {
    const { paths, db } = await fixture();
    const indexPath = join(paths.wikiRoot, "index.md");
    const logPath = join(paths.wikiRoot, "log.md");
    const indexBefore = await fs.readFile(indexPath, "utf8");
    const logBefore = await fs.readFile(logPath, "utf8");
    validateOkfIndex(indexBefore, true);
    validateOkfLog(logBefore);
    expect(indexBefore).toContain('okf_version: "0.2"');
    db.close();
    await initVault(paths.vaultRoot);
    expect(await fs.readFile(indexPath, "utf8")).toBe(indexBefore);
    expect(await fs.readFile(logPath, "utf8")).toBe(logBefore);
  });
  it("repairs the wiki snapshot directory when reopening an existing vault", async () => {
    const { paths, db } = await fixture();
    db.close();
    const snapshots = join(paths.metadataRoot, "snapshots", "wiki");
    await fs.rm(snapshots, { recursive: true });
    initVault(paths.vaultRoot);
    expect((await fs.lstat(snapshots)).isDirectory()).toBe(true);
  });

  it("defaults type and preserves unknown nested frontmatter through update", async () => {
    const { db, wiki } = await fixture();
    const created = await wiki.create({
      path: "nested.md",
      body: "original",
      frontmatter: { tags: ["one"], nested: { keep: true, values: ["a", "b"] } },
    });
    const updated = await wiki.update(created.page.pageId, { body: "updated", expectedDigest: created.page.digest });
    const parsed = parseOkfConcept(updated.content);
    expect(parsed.frontmatter.type).toBe("note");
    expect(parsed.frontmatter.nested).toEqual({ keep: true, values: ["a", "b"] });
    expect(parsed.frontmatter.tags).toEqual(["one"]);
    db.close();
  });
  it("grounds keyed citations in live chunks and rejects raw or fabricated IDs", async () => {
    const { paths, db, wiki } = await fixture();
    const sourceId = "11111111-1111-5111-8111-111111111111";
    const sourceDigest = "a".repeat(64);
    const chunkDigest = "b".repeat(64);
    const timestamp = new Date().toISOString();
    db.run(
      "INSERT INTO sources (source_id, kind, status, display_name, digest, created_at, updated_at) VALUES (?, 'text', 'published', ?, ?, ?, ?)",
      [sourceId, "Grounding source", sourceDigest, timestamp, timestamp],
    );
    db.run(
      "INSERT INTO source_chunks (chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end) VALUES (?, ?, 0, 'extracted.md', 7, ?, 0, 1)",
      [`${sourceId}:0`, sourceId, chunkDigest],
    );
    const created = await wiki.create({ path: "grounded.md", body: `Claim.[^${sourceId}:0]` });
    const parsed = parseOkfConcept(created.content);
    expect(parsed.frontmatter.sources).toEqual([
      {
        id: `${sourceId}:0`,
        resource: `pi-scholar://source/${sourceId}/chunk/0`,
        title: "Grounding source",
        pi_scholar: {
          managed_by: "pi-scholar",
          source_id: sourceId,
          chunk_id: `${sourceId}:0`,
          ordinal: 0,
          source_digest: sourceDigest,
          chunk_digest: chunkDigest,
        },
      },
    ]);
    expect(parsed.body).toContain(`[^${sourceId}:0]: Pi Scholar source evidence`);
    const punctuated = await wiki.create({
      path: "punctuated.md",
      body: `Claim with trailing punctuation.[^${sourceId}:0]: explanation.`,
    });
    expect(parseOkfConcept(punctuated.content).frontmatter.sources).toHaveLength(1);
    const containerBoundary = await wiki.create({
      path: "container-boundary.md",
      body: `> \`\`\`text\n> hidden\n\nClaim outside the blockquote.[^${sourceId}:0]`,
    });
    expect(parseOkfConcept(containerBoundary.content).frontmatter.sources).toHaveLength(1);
    const delimiterBoundary = await wiki.create({
      path: "delimiter-boundary.md",
      body: `\`Claim with unmatched delimiters.[^${sourceId}:0]\`\``,
    });
    expect(parseOkfConcept(delimiterBoundary.content).frontmatter.sources).toHaveLength(1);
    for (const ordinal of [2, 20])
      db.run(
        "INSERT INTO source_chunks (chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end) VALUES (?, ?, ?, ?, 7, ?, 0, 1)",
        [`${sourceId}:${ordinal}`, sourceId, ordinal, `chunk-${ordinal}.md`, String(ordinal).repeat(64).slice(0, 64)],
      );
    await expect(
      wiki.create({ path: "ordinal-prefix.md", body: `Ordinal ten.[^${sourceId}:20]` }),
    ).resolves.toBeDefined();
    const otherSourceId = "33333333-3333-5333-8333-333333333333";
    db.run(
      "INSERT INTO sources (source_id, kind, status, display_name, digest, created_at, updated_at) VALUES (?, 'text', 'published', ?, ?, ?, ?)",
      [otherSourceId, "Other source", "c".repeat(64), timestamp, timestamp],
    );
    db.run(
      "INSERT INTO source_chunks (chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end) VALUES (?, ?, 0, 'extracted.md', 7, ?, 0, 1)",
      [`${otherSourceId}:0`, otherSourceId, "d".repeat(64)],
    );
    db.run("UPDATE sources SET display_name = ? WHERE source_id = ?", [
      `Hostile [^${otherSourceId}:0] label`,
      sourceId,
    ]);
    const safeDefinition = await wiki.create({
      path: "safe-definition.md",
      body: `Grounded despite the source label.[^${sourceId}:0]`,
    });
    expect(parseOkfConcept(safeDefinition.content).body).not.toContain(otherSourceId);
    expect(doctor(paths.vaultRoot).checks.find((item) => item.name === "okf")?.status).toBe("pass");
    const ungrounded = parseOkfConcept(
      (
        await wiki.update(created.page.pageId, {
          body: "No citation remains.",
          expectedDigest: created.page.digest,
        })
      ).content,
    );
    expect(ungrounded.frontmatter.sources).toEqual([]);
    expect(ungrounded.body).not.toContain(sourceId);
    await expect(wiki.create({ path: "raw.md", body: `raw ${sourceId}:0` })).rejects.toThrow(/keyed footnote/u);
    await expect(wiki.create({ path: "fabricated.md", body: `fake.[^${sourceId}:1]` })).rejects.toThrow(
      /unknown source chunk citation/u,
    );
    db.close();
  });
  it("ignores source-shaped link and image destinations", async () => {
    const { db, wiki } = await fixture();
    const sourceId = "11111111-1111-5111-8111-111111111111";
    const timestamp = new Date().toISOString();
    db.run(
      "INSERT INTO sources (source_id, kind, status, display_name, digest, created_at, updated_at) VALUES (?, 'text', 'published', ?, ?, ?, ?)",
      [sourceId, "Destination source", "a".repeat(64), timestamp, timestamp],
    );
    db.run(
      "INSERT INTO source_chunks (chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end) VALUES (?, ?, 0, 'extracted.md', 7, ?, 0, 1)",
      [`${sourceId}:0`, sourceId, "b".repeat(64)],
    );
    const created = await wiki.create({
      path: "destination-literals.md",
      body: `[link](https://example.test/[^${sourceId}:0])\n\n![image](https://example.test/[^${sourceId}:0])`,
    });
    expect(parseOkfConcept(created.content).frontmatter.sources).toBeUndefined();
    const hiddenFootnote = await wiki.create({
      path: "hidden-footnote-markdown.md",
      body: `Claim.[^note]\n\n[^note]: [link](https://example.test/${sourceId}:0) and \`${sourceId}:0\``,
    });
    expect(parseOkfConcept(hiddenFootnote.content).frontmatter.sources).toBeUndefined();
    await expect(
      wiki.create({ path: "visible-autolink.md", body: `<https://example.test/${sourceId}:0>` }),
    ).rejects.toThrow(/keyed footnote/u);
    await expect(
      wiki.create({ path: "visible-image-alt.md", body: `![${sourceId}:0](https://example.test/image)` }),
    ).rejects.toThrow(/keyed footnote/u);
    await expect(
      wiki.create({
        path: "visible-footnote-body.md",
        body: `Claim.[^note]\n\n[^note]: visible ${sourceId}:0`,
      }),
    ).rejects.toThrow(/keyed footnote/u);
    for (const [path, body] of [
      ["destination-shaped-footnote-body.md", `Claim.[^destination]\n\n[^destination]: ${sourceId}:0`],
      ["spaced-footnote-body.md", `Claim.[^spaced]\n\n[^spaced]:    visible ${sourceId}:0`],
      [
        "continued-footnote-body.md",
        `Claim.[^continued]\n\n[^continued]: first paragraph\n\n    visible ${sourceId}:0`,
      ],
    ] as const)
      await expect(wiki.create({ path, body })).rejects.toThrow(/keyed footnote/u);
    db.close();
  });
  it("retains custom metadata while regenerating managed source identity", async () => {
    const { db, wiki } = await fixture();
    const sourceId = "11111111-1111-5111-8111-111111111111";
    const timestamp = new Date().toISOString();
    db.run(
      "INSERT INTO sources (source_id, kind, status, display_name, digest, created_at, updated_at) VALUES (?, 'text', 'published', ?, ?, ?, ?)",
      [sourceId, "Initial source", "a".repeat(64), timestamp, timestamp],
    );
    db.run(
      "INSERT INTO source_chunks (chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end) VALUES (?, ?, 0, 'extracted.md', 7, ?, 0, 1)",
      [`${sourceId}:0`, sourceId, "b".repeat(64)],
    );
    const created = await wiki.create({
      path: "managed-metadata.md",
      body: `Claim.[^${sourceId}:0]`,
      frontmatter: {
        sources: [
          {
            id: `${sourceId}:0`,
            resource: "https://author.example/source",
            title: "Author title",
            pi_scholar: {
              managed_by: "pi-scholar",
              source_id: "stale-source",
              chunk_id: "stale-chunk",
              ordinal: 99,
            },
            custom: "keep",
            nested: { keep: true, labels: ["author"] },
          },
        ],
      },
    });
    const initialSources = parseOkfConcept(created.content).frontmatter.sources as Array<Record<string, unknown>>;
    const initialSource = initialSources[0];
    expect(initialSource).toMatchObject({
      id: `${sourceId}:0`,
      resource: `pi-scholar://source/${sourceId}/chunk/0`,
      title: "Initial source",
      custom: "keep",
      nested: { keep: true, labels: ["author"] },
    });
    db.run("UPDATE sources SET display_name = ?, digest = ? WHERE source_id = ?", [
      "Updated source",
      "c".repeat(64),
      sourceId,
    ]);
    db.run("UPDATE source_chunks SET digest = ? WHERE chunk_id = ?", ["d".repeat(64), `${sourceId}:0`]);
    const updated = await wiki.update(created.page.pageId, {
      body: `Updated claim.[^${sourceId}:0]`,
      expectedDigest: created.page.digest,
    });
    const updatedSources = parseOkfConcept(updated.content).frontmatter.sources as Array<Record<string, unknown>>;
    const updatedSource = updatedSources[0];
    expect(updatedSource).toMatchObject({
      id: `${sourceId}:0`,
      resource: `pi-scholar://source/${sourceId}/chunk/0`,
      title: "Updated source",
      custom: "keep",
      nested: { keep: true, labels: ["author"] },
      pi_scholar: {
        managed_by: "pi-scholar",
        source_id: sourceId,
        chunk_id: `${sourceId}:0`,
        ordinal: 0,
        source_digest: "c".repeat(64),
        chunk_digest: "d".repeat(64),
      },
    });
    db.close();
  });
  it("ignores citation-shaped literals in Markdown code and accepts external UUID source IDs", async () => {
    const { paths, db, wiki } = await fixture();
    const sourceId = "11111111-1111-5111-8111-111111111111";
    const timestamp = new Date().toISOString();
    db.run(
      "INSERT INTO sources (source_id, kind, status, display_name, digest, created_at, updated_at) VALUES (?, 'text', 'published', ?, ?, ?, ?)",
      [sourceId, "Grounding source", "a".repeat(64), timestamp, timestamp],
    );
    db.run(
      "INSERT INTO source_chunks (chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end) VALUES (?, ?, 0, 'extracted.md', 7, ?, 0, 1)",
      [`${sourceId}:0`, sourceId, "b".repeat(64)],
    );
    const code = await wiki.create({
      path: "code-literals.md",
      body: `Ordinary footnote.[^note]\n\n[^note]: A normal Markdown footnote.\n\nEscaped \\[^${sourceId}:0].\n\nInline \`${sourceId}:0\`.\n\n    ${sourceId}:0\n\n\`\`\`text\n[^${sourceId}:9]\n\`\`\`\n\n> \`\`\`text\n> [^${sourceId}:9]\n> \`\`\`\n\n- \`\`\`text\n  ${sourceId}:0\n  \`\`\`\n`,
    });
    expect(parseOkfConcept(code.content).frontmatter.sources).toBeUndefined();
    const externalId = "22222222-2222-4222-8222-222222222222";
    await wiki.create({
      path: "external-source.md",
      body: `External claim.[^${externalId}]\n\n[^${externalId}]: External reference\n`,
      frontmatter: {
        sources: [{ id: externalId, resource: "https://example.test/reference" }],
      },
    });
    expect(doctor(paths.vaultRoot).checks.find((item) => item.name === "okf")?.status).toBe("pass");
    db.close();
  });

  it("ignores citation-shaped literals in HTML comments", async () => {
    const { db, wiki } = await fixture();
    const sourceId = "11111111-1111-5111-8111-111111111111";
    const created = await wiki.create({
      path: "comment-literals.md",
      body: `Visible.\n\n<!-- [^${sourceId}:0] -->\n<!-- [^${sourceId}:1]: invisible -->\n`,
    });
    const parsed = parseOkfConcept(created.content);
    expect(parsed.frontmatter.sources).toBeUndefined();
    expect(parsed.body).toContain(`<!-- [^${sourceId}:0] -->`);
    expect(parsed.body).toContain(`<!-- [^${sourceId}:1]: invisible -->`);
    db.close();
  });

  it("rejects blank page titles before mutating canonical state", async () => {
    const { paths, db, wiki } = await fixture();
    const indexPath = join(paths.wikiRoot, "index.md");
    const logPath = join(paths.wikiRoot, "log.md");
    const initialIndex = await fs.readFile(indexPath);
    const initialLog = await fs.readFile(logPath);
    await expect(wiki.create({ path: "blank-explicit.md", title: " \t", body: "should not persist" })).rejects.toThrow(
      /title/u,
    );
    await expect(wiki.create({ path: "_-_.md", body: "path-derived title is blank" })).rejects.toThrow(/title/u);
    expect(await wiki.list()).toEqual([]);
    expect((await fs.readFile(indexPath)).equals(initialIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(initialLog)).toBe(true);
    const created = await wiki.create({ path: "title-update.md", title: "Stable", body: "original" });
    const pagePath = join(paths.wikiRoot, created.page.relativePath);
    const snapshotPath = join(paths.metadataRoot, "snapshots", "wiki", `${created.page.pageId}.md`);
    const beforePage = await fs.readFile(pagePath);
    const beforeSnapshot = await fs.readFile(snapshotPath);
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const beforeCatalog = db.get<Record<string, unknown>>("SELECT * FROM pages WHERE page_id = ?", [
      created.page.pageId,
    ]);
    await expect(
      wiki.update(created.page.pageId, { title: " \n", expectedDigest: created.page.digest }),
    ).rejects.toThrow(/title/u);
    expect((await fs.readFile(pagePath)).equals(beforePage)).toBe(true);
    expect((await fs.readFile(snapshotPath)).equals(beforeSnapshot)).toBe(true);
    expect((await fs.readFile(indexPath)).equals(beforeIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
    expect(db.get<Record<string, unknown>>("SELECT * FROM pages WHERE page_id = ?", [created.page.pageId])).toEqual(
      beforeCatalog,
    );
    db.close();
  });
  it("repairs a directly drifted blank title through a guarded ingest update", async () => {
    const { paths, db } = await fixture();
    const wiki = new WikiService(db, paths, { qmd: { search: () => [], index: async () => undefined } });
    const app = new ScholarApplication({
      paths,
      db,
      wikiService: wiki,
      adapters: { wiki: { qmd: { search: () => [], index: async () => undefined } } },
      doctor,
      commit: (_paths, subject) => ({ committed: false, subject }),
    });
    try {
      const created = await wiki.create({ path: "drift-title.md", title: "Stable", body: "authored" });
      const pagePath = join(paths.wikiRoot, created.page.relativePath);
      const parsed = parseOkfConcept(await fs.readFile(pagePath, "utf8"));
      parsed.frontmatter.title = " \t";
      parsed.frontmatter.externallyAdded = "must not persist";
      const drifted = serializeOkfConcept(parsed.frontmatter, parsed.body);
      await fs.writeFile(pagePath, drifted);
      const result = await app.applyIngestChange({
        kind: "update-page",
        pageId: created.page.pageId,
        expectedDigest: sha256(drifted),
        title: "Repaired",
      });
      expect(result.page?.title).toBe("Repaired");
      const repaired = await wiki.get(created.page.pageId);
      expect(repaired.status).toBe("active");
      expect(parseOkfConcept(repaired.content).frontmatter.externallyAdded).toBeUndefined();
      const report = doctor(paths.vaultRoot);
      expect(report.ok).toBe(true);
      expect(report.checks.find((check) => check.name === "okf")?.status).toBe("pass");
    } finally {
      await app.close();
      db.close();
    }
  });
  it("rejects drift repair when the authored snapshot bytes are tampered", async () => {
    const { paths, db } = await fixture();
    const wiki = new WikiService(db, paths, { qmd: { search: () => [], index: async () => undefined } });
    const app = new ScholarApplication({
      paths,
      db,
      wikiService: wiki,
      adapters: { wiki: { qmd: { search: () => [], index: async () => undefined } } },
      doctor,
      commit: (_paths, subject) => ({ committed: false, subject }),
    });
    try {
      const created = await wiki.create({
        path: "tampered-snapshot.md",
        title: "Stable",
        body: "Authored baseline. \uFFFD",
      });
      const pagePath = join(paths.wikiRoot, created.page.relativePath);
      const snapshotPath = join(paths.metadataRoot, "snapshots", "wiki", `${created.page.pageId}.md`);
      const externalPage = created.content.replace("Authored baseline.", "External page.");
      const authoredBytes = Buffer.from(created.content);
      const replacementOffset = authoredBytes.indexOf(Buffer.from("\uFFFD"));
      if (replacementOffset < 0) throw new Error("replacement character is missing");
      const tamperedSnapshot = Buffer.concat([
        authoredBytes.subarray(0, replacementOffset),
        Buffer.from([0x80]),
        authoredBytes.subarray(replacementOffset + Buffer.byteLength("\uFFFD")),
      ]);
      await fs.writeFile(pagePath, externalPage);
      await fs.writeFile(snapshotPath, tamperedSnapshot);
      const repair = {
        body: "Explicit repair.",
        title: "Repaired",
        expectedDigest: sha256(externalPage),
      };

      await expect(wiki.prepareUpdate(created.page.pageId, repair)).rejects.toThrow(/product-authored snapshot/u);
      await expect(
        app.applyWikiChange({ kind: "update-page", pageId: created.page.pageId, ...repair }),
      ).rejects.toThrow(/product-authored snapshot/u);
      expect(await fs.readFile(pagePath, "utf8")).toBe(externalPage);
      expect((await fs.readFile(snapshotPath)).equals(tamperedSnapshot)).toBe(true);
      expect(
        db.get<{ status: string }>("SELECT status FROM pages WHERE page_id = ?", [created.page.pageId])?.status,
      ).toBe("active");
    } finally {
      await app.close();
      db.close();
    }
  });
  it("rejects a second edit to preexisting non-target drift during repair", async () => {
    const { paths, db } = await fixture();
    let mutateOther = false;
    let otherPath = "";
    const wiki = new WikiService(db, paths, {
      qmd: {
        search: () => [],
        index: async () => {
          if (!mutateOther) return;
          mutateOther = false;
          await fs.appendFile(otherPath, "\nsecond unsupported edit");
        },
      },
    });
    const app = new ScholarApplication({
      paths,
      db,
      wikiService: wiki,
      adapters: {
        wiki: {
          qmd: {
            search: () => [],
            index: async () => {
              if (!mutateOther) return;
              mutateOther = false;
              await fs.appendFile(otherPath, "\nsecond unsupported edit");
            },
          },
        },
      },
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: (_paths, subject) => ({ committed: false, subject }),
    });
    try {
      const target = await wiki.create({ path: "repair-target.md", body: "authored target" });
      const other = await wiki.create({ path: "repair-other.md", body: "authored other" });
      const targetPath = join(paths.wikiRoot, target.page.relativePath);
      otherPath = join(paths.wikiRoot, other.page.relativePath);
      await fs.appendFile(targetPath, "\nfirst unsupported edit");
      await fs.appendFile(otherPath, "\nfirst unsupported edit");
      const targetContent = await fs.readFile(targetPath, "utf8");
      mutateOther = true;
      await expect(
        app.applyWikiChange({
          kind: "update-page",
          pageId: target.page.pageId,
          expectedDigest: sha256(targetContent),
          body: "corrected target",
        }),
      ).rejects.toThrow(/Preexisting wiki drift changed during mutation/u);
      expect(await fs.readFile(targetPath, "utf8")).toBe(targetContent);
      expect(
        db.get<{ status: string }>("SELECT status FROM pages WHERE page_id = ?", [target.page.pageId])?.status,
      ).toBe("active");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects orphan managed footnote definitions before persistence", async () => {
    const { paths, db, wiki } = await fixture();
    const sourceId = "11111111-1111-5111-8111-111111111111";
    const timestamp = new Date().toISOString();
    db.run(
      "INSERT INTO sources (source_id, kind, status, display_name, digest, created_at, updated_at) VALUES (?, 'text', 'published', ?, ?, ?, ?)",
      [sourceId, "Grounding source", "a".repeat(64), timestamp, timestamp],
    );
    db.run(
      "INSERT INTO source_chunks (chunk_id, source_id, ordinal, relative_path, byte_length, digest, atom_start, atom_end) VALUES (?, ?, 0, 'extracted.md', 7, ?, 0, 1)",
      [`${sourceId}:0`, sourceId, "b".repeat(64)],
    );
    const indexPath = join(paths.wikiRoot, "index.md");
    const logPath = join(paths.wikiRoot, "log.md");
    const initialIndex = await fs.readFile(indexPath);
    const initialLog = await fs.readFile(logPath);
    const pagePath = join(paths.wikiRoot, "orphan-managed.md");
    await expect(
      wiki.create({ path: "orphan-managed.md", body: `[^${sourceId}:0]: orphan evidence\n` }),
    ).rejects.toThrow(/orphan managed footnote definition/u);
    expect(await wiki.list()).toEqual([]);
    await expect(fs.access(pagePath)).rejects.toThrow();
    expect((await fs.readFile(indexPath)).equals(initialIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(initialLog)).toBe(true);
    db.close();
  });

  it("escapes inline delimiters in generated projection labels", async () => {
    const { paths, db, wiki } = await fixture();
    const title = "*Title_ `code` ~[literal] <tag> &";
    const description = "_Description* `code` ~[literal] <tag> &";
    await wiki.create({
      path: "literal-labels.md",
      title,
      body: "Body.",
      frontmatter: { description },
    });
    const escapedTitle = ["\\*Title\\_", "\\`code\\`", "\\~&#91;literal&#93;", "&lt;tag&gt;", "&amp;"].join(" ");
    const escapedDescription = ["\\_Description\\*", "\\`code\\`", "\\~&#91;literal&#93;", "&lt;tag&gt;", "&amp;"].join(
      " ",
    );
    const index = await fs.readFile(join(paths.wikiRoot, "index.md"), "utf8");
    const log = await fs.readFile(join(paths.wikiRoot, "log.md"), "utf8");
    expect(index).toContain(`* [${escapedTitle}](literal-labels.md) - ${escapedDescription}`);
    expect(log).toContain(`* **Update**: [${escapedTitle}](literal-labels.md) - ${escapedDescription}`);
    db.close();
  });

  it("encodes generated links, resolves absolute bundle links, and validates UTC log dates", async () => {
    const { paths, db, wiki } = await fixture();
    const target = await wiki.create({
      path: "tables/customer metrics#1.md",
      title: "Customer ] <script> Metrics \\",
      body: "Metrics.",
    });
    await wiki.create({
      path: "guides/consumer.md",
      body: "[Metrics](/tables/customer%20metrics%231.md)",
    });
    const prepared = await wiki.prepareUpdate(
      target.page.pageId,
      { body: "Updated metrics.", expectedDigest: target.page.digest },
      "2026-01-01T23:30:00-05:00",
    );
    await wiki.update(target.page.pageId, { expectedDigest: target.page.digest }, prepared);
    const index = await fs.readFile(join(paths.wikiRoot, "index.md"), "utf8");
    const log = await fs.readFile(join(paths.wikiRoot, "log.md"), "utf8");
    expect(index).toContain("[Customer &#93; &lt;script&gt; Metrics \\\\](tables/customer%20metrics%231.md)");
    expect(log).toContain("## 2026-01-02");
    expect((await wiki.refreshProjections(false)).backlinks["tables/customer metrics#1.md"]).toEqual([
      "guides/consumer.md",
    ]);
    await fs.writeFile(join(paths.wikiRoot, "index.md"), index.replace("Wiki index", "Tampered index"));
    expect(doctor(paths.vaultRoot).checks.find((item) => item.name === "okf")?.status).toBe("fail");
    await fs.writeFile(join(paths.wikiRoot, "index.md"), index);
    expect(doctor(paths.vaultRoot).checks.find((item) => item.name === "okf")?.status).toBe("pass");
    db.close();
  });

  it("rejects create over an uncataloged filesystem entry without changing it", async () => {
    const { paths, db, wiki } = await fixture();
    const target = join(paths.wikiRoot, "untracked.md");
    const before = Buffer.from("untracked content\n");
    await fs.writeFile(target, before);
    await expect(wiki.create({ path: "untracked.md", body: "replacement" })).rejects.toThrow(/already exists/u);
    expect((await fs.readFile(target)).equals(before)).toBe(true);
    expect(await wiki.list()).toHaveLength(0);
    db.close();
  });

  it("rejects rename over an uncataloged filesystem entry without changing it", async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: "notes/source.md", body: "source" });
    const target = join(paths.wikiRoot, "notes", "untracked.md");
    const before = Buffer.from("untracked destination\n");
    await fs.writeFile(target, before);
    await expect(wiki.rename(created.page.pageId, "notes/untracked.md")).rejects.toThrow(/already exists/u);
    expect((await fs.readFile(target)).equals(before)).toBe(true);
    expect((await wiki.get(created.page.pageId)).relativePath).toBe("notes/source.md");
    db.close();
  });

  it("rolls back a failed create after projection refresh", async () => {
    const { paths, db, wiki } = await fixture();
    await wiki.create({ path: "stable.md", body: "stable" });
    const indexPath = join(paths.wikiRoot, "index.md");
    const logPath = join(paths.wikiRoot, "log.md");
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const target = join(paths.wikiRoot, "failed-create.md");
    wiki.refreshProjections = async () => {
      throw new Error("forced projection failure");
    };
    await expect(wiki.create({ path: "failed-create.md", body: "temporary" })).rejects.toThrow(
      "forced projection failure",
    );
    await expect(fs.access(target)).rejects.toThrow();
    expect((await fs.readFile(indexPath)).equals(beforeIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
    expect(await wiki.list()).toHaveLength(1);
    db.close();
  });

  it("rolls back a failed update after projection refresh", async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: "failed-update.md", body: "original" });
    const pagePath = join(paths.wikiRoot, "failed-update.md");
    const snapshotPath = join(paths.metadataRoot, "snapshots", "wiki", `${created.page.pageId}.md`);
    const indexPath = join(paths.wikiRoot, "index.md");
    const logPath = join(paths.wikiRoot, "log.md");
    const beforePage = await fs.readFile(pagePath);
    const beforeSnapshot = await fs.readFile(snapshotPath);
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const beforeCatalog = db.get<Record<string, unknown>>("SELECT * FROM pages WHERE page_id = ?", [
      created.page.pageId,
    ]);
    const beforeAuthored = db.get<Record<string, unknown>>("SELECT * FROM authored_snapshots WHERE relative_path = ?", [
      "failed-update.md",
    ]);
    wiki.refreshProjections = async () => {
      throw new Error("forced projection failure");
    };
    await expect(
      wiki.update(created.page.pageId, { body: "updated", expectedDigest: created.page.digest }),
    ).rejects.toThrow("forced projection failure");
    expect((await fs.readFile(pagePath)).equals(beforePage)).toBe(true);
    expect((await fs.readFile(snapshotPath)).equals(beforeSnapshot)).toBe(true);
    expect((await fs.readFile(indexPath)).equals(beforeIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
    expect(db.get<Record<string, unknown>>("SELECT * FROM pages WHERE page_id = ?", [created.page.pageId])).toEqual(
      beforeCatalog,
    );
    expect(
      db.get<Record<string, unknown>>("SELECT * FROM authored_snapshots WHERE relative_path = ?", ["failed-update.md"]),
    ).toEqual(beforeAuthored);
    db.close();
  });

  it("rolls back a failed rename after projection refresh", async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: "failed-rename.md", body: "original" });
    const sourcePath = join(paths.wikiRoot, "failed-rename.md");
    const targetPath = join(paths.wikiRoot, "renamed-after-failure.md");
    const snapshotPath = join(paths.metadataRoot, "snapshots", "wiki", `${created.page.pageId}.md`);
    const indexPath = join(paths.wikiRoot, "index.md");
    const logPath = join(paths.wikiRoot, "log.md");
    const beforePage = await fs.readFile(sourcePath);
    const beforeSnapshot = await fs.readFile(snapshotPath);
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const beforeCatalog = db.get<Record<string, unknown>>("SELECT * FROM pages WHERE page_id = ?", [
      created.page.pageId,
    ]);
    const beforeAuthored = db.get<Record<string, unknown>>("SELECT * FROM authored_snapshots WHERE relative_path = ?", [
      "failed-rename.md",
    ]);
    wiki.refreshProjections = async () => {
      throw new Error("forced projection failure");
    };
    await expect(wiki.rename(created.page.pageId, "renamed-after-failure.md")).rejects.toThrow(
      "forced projection failure",
    );
    expect((await fs.readFile(sourcePath)).equals(beforePage)).toBe(true);
    await expect(fs.access(targetPath)).rejects.toThrow();
    expect((await fs.readFile(snapshotPath)).equals(beforeSnapshot)).toBe(true);
    expect((await fs.readFile(indexPath)).equals(beforeIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
    expect(db.get<Record<string, unknown>>("SELECT * FROM pages WHERE page_id = ?", [created.page.pageId])).toEqual(
      beforeCatalog,
    );
    expect(
      db.get<Record<string, unknown>>("SELECT * FROM authored_snapshots WHERE relative_path = ?", ["failed-rename.md"]),
    ).toEqual(beforeAuthored);
    db.close();
  });

  it("keeps semantic drift unresolved and excludes it from live lexical search", async () => {
    const { db, wiki } = await fixture();
    const created = await wiki.create({ path: "semantic-drift.md", body: "authored text" });
    db.run("UPDATE pages SET status = 'drifted' WHERE page_id = ?", [created.page.pageId]);
    const report = await wiki.inspectDrift(created.page.pageId);
    expect(report.drifted).toBe(true);
    expect(report.page.status).toBe("drifted");
    expect(await wiki.lexicalSearch("authored")).toHaveLength(0);
    await expect(wiki.resolveDrift(created.page.pageId, "restore")).rejects.toThrow(
      /semantic drift requires maintenance correction/u,
    );
    db.close();
  });
  it("excludes catalogued drift from semantic qmd candidates", async () => {
    const { paths, db, wiki } = await fixture();
    await wiki.create({ path: "semantic-active.md", body: "active text" });
    const drifted = await wiki.create({ path: "[x].md", body: "drifted text" });
    await fs.appendFile(join(paths.wikiRoot, "[x].md"), "\nunsupported edit");
    db.run("UPDATE pages SET status = 'drifted' WHERE page_id = ?", [drifted.page.pageId]);
    let ignoredPaths: readonly string[] | undefined;
    const semantic = new WikiService(db, paths, {
      qmd: {
        search: (_query, options) => {
          ignoredPaths = options?.ignoredPaths;
          return [{ path: "[x].md" }, { path: "semantic-active.md" }];
        },
      },
    });
    expect(await semantic.semanticSearch("text")).toEqual([{ path: "semantic-active.md" }]);
    expect(ignoredPaths).toEqual(["[x].md"]);
    db.close();
  });

  it("detects direct drift and exposes exactly two restore choices", async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: "drift.md", body: "authored" });
    await fs.appendFile(join(paths.wikiRoot, "drift.md"), "\nunsupported edit");
    const report = await wiki.inspectDrift(created.page.pageId);
    expect(report.drifted).toBe(true);
    expect(report.choices).toEqual(["record-issue", "restore"]);
    await wiki.resolveDrift(created.page.pageId, "restore");
    expect((await wiki.inspectDrift(created.page.pageId)).drifted).toBe(false);
    db.close();
  });
  it("refuses to read a symlinked authored snapshot", async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: "unsafe-snapshot.md", body: "authored" });
    const snapshot = join(paths.metadataRoot, "snapshots", "wiki", `${created.page.pageId}.md`);
    await fs.rm(snapshot);
    await fs.symlink("/etc/passwd", snapshot);
    await expect(wiki.inspectDrift(created.page.pageId)).rejects.toThrow(/symlink|symbolic link|regular file|unsafe/u);
    db.close();
  });

  it("rolls back drift restoration, projections, snapshots, catalog, and issue on failure", async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: "rollback-drift.md", body: "authored" });
    await fs.appendFile(join(paths.wikiRoot, "rollback-drift.md"), "\nunsupported edit");
    const pagePath = join(paths.wikiRoot, "rollback-drift.md");
    const snapshotPath = join(paths.metadataRoot, "snapshots", "wiki", `${created.page.pageId}.md`);
    const indexPath = join(paths.wikiRoot, "index.md");
    const logPath = join(paths.wikiRoot, "log.md");
    const beforePage = await fs.readFile(pagePath);
    const beforeSnapshot = await fs.readFile(snapshotPath);
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const beforeCatalog = db.get<Record<string, unknown>>("SELECT * FROM pages WHERE page_id = ?", [
      created.page.pageId,
    ]);
    const beforeAuthored = db.get<Record<string, unknown>>("SELECT * FROM authored_snapshots WHERE relative_path = ?", [
      "rollback-drift.md",
    ]);
    wiki.refreshProjections = async () => {
      throw new Error("forced projection failure");
    };
    await expect(wiki.resolveDrift(created.page.pageId, "record-issue")).rejects.toThrow("forced projection failure");
    expect((await fs.readFile(pagePath)).equals(beforePage)).toBe(true);
    expect((await fs.readFile(snapshotPath)).equals(beforeSnapshot)).toBe(true);
    expect((await fs.readFile(indexPath)).equals(beforeIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
    expect(db.get<Record<string, unknown>>("SELECT * FROM pages WHERE page_id = ?", [created.page.pageId])).toEqual(
      beforeCatalog,
    );
    expect(
      db.get<Record<string, unknown>>("SELECT * FROM authored_snapshots WHERE relative_path = ?", [
        "rollback-drift.md",
      ]),
    ).toEqual(beforeAuthored);
    expect(db.all("SELECT * FROM wiki_issues WHERE page_id = ?", [created.page.pageId])).toHaveLength(0);
    db.close();
  });

  it("rejects standalone issue resolution and permits reopening only", async () => {
    const { db, wiki } = await fixture();
    const page = await wiki.create({ path: "issue.md", body: "text" });
    const issue = await wiki.report({ pageId: page.page.pageId, description: "unclear" });
    await expect(wiki.patchIssue(issue.issueId, { status: "resolved" })).rejects.toThrow();
    const reopened = await wiki.patchIssue(issue.issueId, {
      status: "reopened",
      resolution: "Needs a page correction.",
    });
    expect(reopened.status).toBe("reopened");
    db.close();
  });

  it("resolves an issue only after a corrected page passes together", async () => {
    const { db, paths } = await fixture();
    const wiki = new WikiService(db, paths, { qmd: { search: () => [], index: async () => undefined } });
    const scheduler = new SchedulerService(db, paths);
    const app = new ScholarApplication({
      paths,
      db,
      wikiService: wiki,
      schedulerService: scheduler,
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: (_paths, subject) => ({ committed: false, subject }),
    });
    try {
      const originalBody = "# Section\n\noriginal\n";
      const correctedBody = "# Section\n\ncorrected\n";
      const page = await wiki.create({
        path: "page-issue.md",
        description: "Issue correction behavior.",
        body: originalBody,
        quizWorthiness: "eligible",
      });
      const issue = await wiki.report({
        pageId: page.page.pageId,
        heading: "Section",
        description: "The section is wrong.",
      });
      const proposal = (body: string) => ({
        kind: "resolve-issue" as const,
        issueId: issue.issueId,
        page: { pageId: page.page.pageId, expectedDigest: page.page.digest, body },
        resolution: "Corrected the section.",
      });
      await expect(app.applyWikiChange(proposal(originalBody))).rejects.toThrow(/actual page correction/u);
      expect((await wiki.get(page.page.pageId)).content).toContain("original");
      expect((await app.listIssues()).issues.find((item) => item.issueId === issue.issueId)?.status).toBe("open");

      const applied = await app.applyWikiChange(proposal(correctedBody));
      expect(applied.issue?.status).toBe("resolved");
      expect((await wiki.get(page.page.pageId)).content).toContain("corrected");
      expect((await wiki.get(page.page.pageId)).revision).toBe(2);
      expect(scheduler.getPageLearning(page.page.pageId)?.pageId).toBe(page.page.pageId);

      const beforeRename = await wiki.get(page.page.pageId);
      const renamed = await app.applyWikiChange({
        kind: "rename-page",
        pageId: page.page.pageId,
        expectedDigest: beforeRename.digest,
        path: "page-issue-renamed.md",
      });
      expect(renamed.page?.relativePath).toBe("page-issue-renamed.md");
      expect((await wiki.get(page.page.pageId)).digest).toBe(beforeRename.digest);
      expect(scheduler.getPageLearning(page.page.pageId)?.pageId).toBe(page.page.pageId);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("scopes semantic qmd search to wiki and keeps exact reads separate", async () => {
    const { db, wiki } = await fixture();
    let seenScope = "";
    const semantic = new WikiService(db, wiki.paths, {
      qmd: {
        search: (_query, options) => {
          seenScope = options?.scope ?? "";
          return [{ path: "notes.md" }];
        },
      },
    });
    await semantic.create({ path: "notes.md", body: "semantic text" });
    expect(await semantic.semanticSearch("semantic")).toHaveLength(1);
    expect(seenScope).toBe("wiki/**/*.md");
    expect((await semantic.readExact("notes.md")).toString()).toContain("semantic text");
    await expect(semantic.readExact("../sources/secret.md")).rejects.toThrow();
    db.close();
  });
  it("accepts exact qmd collection file URIs, skips control docs, and rejects malformed results", async () => {
    const { paths, db } = await fixture();
    const collection = `pi-scholar-${paths.vaultId}`;
    const valid = `qmd://${collection}/notes.md`;
    const invalidResults: unknown[] = [
      { file: `qmd://${collection}/%2e%2e/encoded-secret.md` },
      { file: `qmd://${collection}/../secret.md` },
      { file: `qmd://${collection}/notes%2Fsecret.md` },
      { file: `qmd://pi-scholar-00000000-0000-4000-8000-000000000000/notes.md` },
      { file: `qmd://${collection}/%ZZ.md` },
      { file: `qmd://${collection}/notes.md?token=secret` },
      { file: `qmd://${collection}:4816/notes.md` },
      { path: "../secret.md" },
      {},
      null,
      "notes.md",
    ];
    const semantic = new WikiService(db, paths, { qmd: { search: () => [] } });
    await semantic.create({ path: "notes.md", body: "semantic text" });
    for (const invalid of invalidResults) {
      const unsafe = new WikiService(db, paths, { qmd: { search: () => [invalid] } });
      await expect(unsafe.semanticSearch("semantic")).rejects.toThrow();
    }
    const trusted = new WikiService(db, paths, {
      qmd: { search: () => [{ path: "index.md" }, { path: "log.md" }, { file: valid }] },
    });
    const found = await trusted.semanticSearch("semantic");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: valid, path: "notes.md" });
    const app = new ScholarApplication({ paths, db, wikiService: trusted });
    expect((await app.searchWiki("semantic", { mode: "semantic" })).pages).toHaveLength(1);
    await app.close();
    db.close();
  });

  it("rejects executable HTML rather than rendering imported markup", async () => {
    const { db, wiki } = await fixture();
    expect(isExecutableHtml("<script>alert(1)</script>")).toBe(true);
    await expect(wiki.create({ path: "unsafe.md", body: "<script>alert(1)</script>" })).rejects.toThrow();
    db.close();
  });
});
