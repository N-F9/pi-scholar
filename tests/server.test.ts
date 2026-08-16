import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { type ClientRequest, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay, setImmediate } from "node:timers/promises";
import { describe, it } from "vitest";
import { ScholarApplication } from "../src/application/application.js";
import type { QuizRecord, WikiPageResult } from "../src/contracts.js";
import { type ServerOptions, startServer } from "../src/server.js";
import { initVault, LockBusyError } from "../src/vault.js";

async function withServer(
  application: ScholarApplication,
  run: (base: string) => Promise<void>,
  staticRoot?: string,
  serverOptions: Pick<ServerOptions, "maxMultipartBytes" | "developerTools"> = {},
): Promise<void> {
  const server = await startServer({
    application,
    port: 0,
    ...(staticRoot ? { staticRoot } : {}),
    ...serverOptions,
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${(address as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await server.closeGracefully();
  }
}
function sameOriginHeaders(base: string, headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, Origin: base };
}

const issue = {
  issueId: "11111111-1111-4111-8111-111111111111",
  kind: "contradiction",
  description: "A reported issue",
  status: "open",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function publicQuizFixture(): QuizRecord {
  return {
    quizId: "quiz-1",
    date: "2026-08-09",
    revision: 1,
    status: "open",
    sheetPath: "/private/sheet.md",
    questions: [
      {
        questionId: "question-1",
        quizId: "quiz-1",
        ordinal: 1,
        kind: "free-response",
        prompt: "Explain the idea.",
        pages: [{ pageId: "page-1", criterion: "secret rubric", weight: 9 }],
        sourceRefs: ["private-source"],
        answerKey: "secret answer",
      } as QuizRecord["questions"][number],
    ],
  };
}

describe("server browser boundary", () => {
  it("projects full OKF only at the wiki HTTP response boundaries", async () => {
    const pageId = "11111111-1111-4111-8111-111111111111";
    const result: WikiPageResult = {
      page: {
        pageId,
        relativePath: "public.md",
        title: "Public",
        digest: "page-digest",
        revision: 1,
        status: "active",
        quizWorthiness: "skip",
        updatedAt: new Date(0).toISOString(),
      },
      markdown: "---\ntype: note\ntitle: Public\n---\n# Public body\n\nText.\n",
      sections: [],
      learning: { prerequisites: [] },
      drift: { expectedDigest: "expected", actualDigest: "actual", diff: "diff" },
    };
    let pageReads = 0;
    let driftResolutions = 0;
    const application = {
      getWiki: async () => {
        pageReads += 1;
        return result;
      },
      resolveDrift: async () => {
        driftResolutions += 1;
        return result;
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const pageResponse = await fetch(`${base}/api/v1/wiki/page?pageId=${pageId}`);
      assert.equal(pageResponse.status, 200);
      const pagePayload = (await pageResponse.json()) as { data: WikiPageResult };
      assert.equal(pagePayload.data.markdown, "# Public body\n\nText.\n");
      assert.equal(pagePayload.data.markdown.includes("type:"), false);
      assert.deepEqual(
        pagePayload.data.sections.map((section) => section.heading),
        ["Public body"],
      );
      assert.deepEqual(pagePayload.data.drift?.diff, result.drift?.diff);

      const driftResponse = await fetch(`${base}/api/v1/wiki/pages/${pageId}/drift-resolution`, {
        method: "POST",
        headers: sameOriginHeaders(base, { "Content-Type": "application/json", "X-Pi-Scholar-Request": "1" }),
        body: JSON.stringify({ action: "restore", expectedDigest: "expected" }),
      });
      assert.equal(driftResponse.status, 200);
      const driftPayload = (await driftResponse.json()) as { data: WikiPageResult };
      assert.equal(driftPayload.data.markdown, "# Public body\n\nText.\n");
      assert.deepEqual(
        driftPayload.data.sections.map((section) => section.heading),
        ["Public body"],
      );
      assert.equal(driftPayload.data.drift?.diff, "diff");
    });
    assert.equal(pageReads, 1);
    assert.equal(driftResolutions, 1);
  });

  it("serves only the page attachment response shape", async () => {
    const pageId = "a1111111-1111-4111-8111-111111111111";
    const sourceId = "b2222222-2222-4222-8222-222222222222";
    const digest = "a".repeat(64);
    const bytes = Buffer.from([1, 2, 3]);
    const application = {
      getWikiAttachment: async (requestedPage: string, requestedSource: string, requestedDigest: string) => {
        assert.deepEqual([requestedPage, requestedSource, requestedDigest], [pageId, sourceId, digest]);
        return { bytes, byteLength: bytes.byteLength, contentType: "image/png" };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;
    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/v1/wiki/pages/${pageId}/attachments/${sourceId}/${digest}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("content-security-policy")?.includes("img-src 'self'"), true);
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytes]);
      const malformed = await fetch(
        `${base}/api/v1/wiki/pages/${pageId.toUpperCase()}/attachments/${sourceId}/${digest}`,
      );
      assert.equal(malformed.status, 400);
    });
  });
  it("keeps malformed full OKF on the existing internal-error path", async () => {
    const pageId = "11111111-1111-4111-8111-111111111111";
    const application = {
      getWiki: async () => ({
        page: {
          pageId,
          relativePath: "malformed.md",
          title: "Malformed",
          digest: "page-digest",
          revision: 1,
          status: "active",
          quizWorthiness: "skip",
          updatedAt: new Date(0).toISOString(),
        },
        markdown: "# missing OKF\n",
        sections: [],
        learning: { prerequisites: [] },
      }),
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/v1/wiki/page?pageId=${pageId}`);
      assert.equal(response.status, 500);
      const payload = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(payload.error.code, "INTERNAL_ERROR");
      assert.equal(payload.error.message, "Internal server error");
    });
  });
  it("rejects route-disallowed methods before application dispatch", async () => {
    const unexpectedDispatch = () => assert.fail("route method policy allowed application dispatch");
    const application = {
      listSources: unexpectedDispatch,
      stageSource: unexpectedDispatch,
      removalPreview: unexpectedDispatch,
      removeSource: unexpectedDispatch,
      listWiki: unexpectedDispatch,
      getWiki: unexpectedDispatch,
      searchWiki: unexpectedDispatch,
      listIssues: unexpectedDispatch,
      reportIssue: unexpectedDispatch,
      patchIssue: unexpectedDispatch,
      resolveDrift: unexpectedDispatch,
      listQuizzes: unexpectedDispatch,
      getQuiz: unexpectedDispatch,
      saveAnswers: unexpectedDispatch,
      sealSubmission: unexpectedDispatch,
      listWorkflows: unexpectedDispatch,
      getWorkflow: unexpectedDispatch,
      getSettings: unexpectedDispatch,
      updateSettings: unexpectedDispatch,
      close: async () => undefined,
    } as unknown as ScholarApplication;
    const id = "11111111-1111-4111-8111-111111111111";
    const date = "2026-08-09";
    const cases = [
      ["PUT", "/api/v1/sources"],
      ["GET", `/api/v1/sources/${id}/removal-preview`],
      ["GET", `/api/v1/sources/${id}/removal`],
      ["POST", "/api/v1/wiki"],
      ["POST", "/api/v1/wiki/page"],
      ["POST", "/api/v1/wiki/search"],
      ["PUT", "/api/v1/wiki/issues"],
      ["GET", `/api/v1/wiki/issues/${id}`],
      ["GET", `/api/v1/wiki/pages/${id}/drift-resolution`],
      ["POST", "/api/v1/quizzes"],
      ["POST", `/api/v1/quizzes/${date}`],
      ["GET", `/api/v1/quizzes/${date}/answers`],
      ["GET", `/api/v1/quizzes/${date}/submission`],
      ["POST", "/api/v1/workflows"],
      ["POST", `/api/v1/workflows/${id}`],
      ["POST", "/api/v1/settings"],
    ] as const;

    await withServer(application, async (base) => {
      for (const [method, path] of cases) {
        const response = await fetch(`${base}${path}`, {
          method,
          ...(method === "GET" ? {} : { headers: sameOriginHeaders(base, { "X-Pi-Scholar-Request": "1" }) }),
        });
        assert.equal(response.status, 405, `${method} ${path}`);
        const payload = (await response.json()) as { error: { code: string } };
        assert.equal(payload.error.code, "METHOD_NOT_ALLOWED", `${method} ${path}`);
      }
    });
  });

  it("rejects cross-site unsafe requests before invoking application mutations", async () => {
    let calls = 0;
    const application = {
      reportIssue: async () => {
        calls += 1;
        return issue;
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/v1/wiki/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", "X-Pi-Scholar-Request": "1" },
        body: JSON.stringify({ kind: "contradiction", description: "attack" }),
      });
      assert.equal(response.status, 403);
      const wrongPort = new URL(base);
      wrongPort.port = String(Number(wrongPort.port) + 1);
      const sameSiteWrongPort = await fetch(`${base}/api/v1/wiki/issues`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: wrongPort.origin,
          "Sec-Fetch-Site": "same-site",
          "X-Pi-Scholar-Request": "1",
        },
        body: JSON.stringify({ kind: "contradiction", description: "wrong port" }),
      });
      assert.equal(sameSiteWrongPort.status, 403);
      assert.equal(calls, 0);
    });
  });
  it("accepts only reopened or resolved issue status values", async () => {
    const statuses: string[] = [];
    const application = {
      patchIssue: async (_issueId: string, input: { readonly status: string }) => {
        statuses.push(input.status);
        return issue;
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      for (const status of ["open", "reopened", "resolved"]) {
        const response = await fetch(`${base}/api/v1/wiki/issues/${issue.issueId}`, {
          method: "PATCH",
          headers: sameOriginHeaders(base, { "Content-Type": "application/json", "X-Pi-Scholar-Request": "1" }),
          body: JSON.stringify({ status }),
        });
        assert.equal(response.status, status === "open" ? 400 : 200);
      }
      assert.deepEqual(statuses, ["reopened", "resolved"]);
    });
  });

  it("rejects same-site and metadata-free unsafe requests without the browser marker", async () => {
    let calls = 0;
    const application = {
      reportIssue: async () => {
        calls += 1;
        return issue;
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      for (const headers of [
        { "Content-Type": "application/json", "Sec-Fetch-Site": "same-site" },
        { "Content-Type": "application/json" },
      ]) {
        const response = await fetch(`${base}/api/v1/wiki/issues`, {
          method: "POST",
          headers,
          body: JSON.stringify({ kind: "contradiction", description: "missing marker" }),
        });
        assert.equal(response.status, 403);
      }
      assert.equal(calls, 0);
    });
  });

  it("requires JSON for mutations while allowing same-origin JSON and multipart uploads", async () => {
    let issueCalls = 0;
    let sourceCalls = 0;
    let receivedFilePath: string | undefined;
    const workRoot = mkdtempSync(join(tmpdir(), "pi-scholar-server-"));
    const application = {
      paths: { workRoot },
      reportIssue: async () => {
        issueCalls += 1;
        return issue;
      },
      stageSource: async (request: {
        readonly filePath: string;
        readonly name: string;
        readonly originalName: string;
        readonly displayName: string;
        readonly mediaType?: string;
      }) => {
        sourceCalls += 1;
        receivedFilePath = request.filePath;
        assert.equal(request.name, "notes.txt");
        assert.equal(request.originalName, "notes.txt");
        assert.equal(request.displayName, "notes");
        assert.equal(request.mediaType, "text/plain");
        assert.equal(readFileSync(request.filePath, "utf8"), "notes");
        assert.equal(statSync(request.filePath).mode & 0o777, 0o600);
        return { source: {} };
      },
      listSources: async () => ({
        sources: [
          {
            sourceId: "source-1",
            kind: "upload",
            status: "failed",
            displayName: "notes",
            manifestPath: "/private/manifest.json",
            errorCode: "EXTRACT_FAILED",
            errorMessage: "/private/diagnostic",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      }),
      close: async () => undefined,
    } as unknown as ScholarApplication;

    try {
      await withServer(application, async (base) => {
        const textResponse = await fetch(`${base}/api/v1/wiki/issues`, {
          method: "POST",
          headers: sameOriginHeaders(base, {
            "Content-Type": "text/plain",
            "Sec-Fetch-Site": "same-origin",
            "X-Pi-Scholar-Request": "1",
          }),
          body: JSON.stringify({ kind: "incorrect", description: "wrong type" }),
        });
        assert.equal(textResponse.status, 415);
        assert.equal(issueCalls, 0);

        const jsonResponse = await fetch(`${base}/api/v1/wiki/issues`, {
          method: "POST",
          headers: sameOriginHeaders(base, {
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
            "X-Pi-Scholar-Request": "1",
          }),
          body: JSON.stringify({ kind: "incorrect", description: "valid" }),
        });
        assert.equal(jsonResponse.status, 200);
        assert.equal(issueCalls, 1);
        const sourceListResponse = await fetch(`${base}/api/v1/sources`);
        const sourceListEnvelope = (await sourceListResponse.json()) as {
          data: { sources: Array<Record<string, unknown>> };
        };
        assert.equal("manifestPath" in sourceListEnvelope.data.sources[0]!, false);
        assert.equal("errorMessage" in sourceListEnvelope.data.sources[0]!, false);

        const form = new FormData();
        form.set("kind", "upload");
        form.set("displayName", "notes");
        form.set("mediaType", "text/plain");
        form.set("originalName", "notes.txt");
        form.append("file", new Blob(["notes"], { type: "text/plain" }), "notes.txt");
        const multipartResponse = await fetch(`${base}/api/v1/sources`, {
          method: "POST",
          headers: sameOriginHeaders(base, { "Sec-Fetch-Site": "same-origin", "X-Pi-Scholar-Request": "1" }),
          body: form,
        });
        assert.equal(multipartResponse.status, 200);
        assert.equal(sourceCalls, 1);

        const extraPart = new FormData();
        extraPart.set("kind", "upload");
        extraPart.set("displayName", "notes");
        extraPart.set("mediaType", "text/plain");
        extraPart.set("originalName", "notes.txt");
        extraPart.append("file", new Blob(["notes"], { type: "text/plain" }), "notes.txt");
        extraPart.set("extra", "unexpected");
        const extraPartResponse = await fetch(`${base}/api/v1/sources`, {
          method: "POST",
          headers: sameOriginHeaders(base, { "Sec-Fetch-Site": "same-origin", "X-Pi-Scholar-Request": "1" }),
          body: extraPart,
        });
        assert.equal(extraPartResponse.status, 400);
        assert.equal(sourceCalls, 1);
      });
      assert.ok(receivedFilePath);
      assert.equal(existsSync(receivedFilePath), false);
      assert.deepEqual(readdirSync(workRoot), []);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });
  it("redacts workflow diagnostics at every exposed workflow boundary", async () => {
    const workflow = {
      requestId: "11111111-1111-4111-8111-111111111111",
      kind: "ingest",
      status: "failed",
      progress: 0,
      errorCode: "INGEST_FAILED",
      errorMessage: "/private/workflow",
      error_message: "/private/legacy-workflow",
    };
    const application = {
      listWorkflows: async () => ({ workflows: [workflow] }),
      getWorkflow: async () => workflow,
      sealSubmission: async () => ({ status: "sealed", workflow }),
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const responses = [
        await fetch(`${base}/api/v1/workflows`),
        await fetch(`${base}/api/v1/workflows/${workflow.requestId}`),
        await fetch(`${base}/api/v1/quizzes/2026-08-09/submission`, {
          method: "POST",
          headers: sameOriginHeaders(base, { "Content-Type": "application/json", "X-Pi-Scholar-Request": "1" }),
          body: JSON.stringify({ expectedRevision: 1 }),
        }),
      ];
      for (const response of responses) {
        assert.equal(response.status, 200);
        const payload = await response.text();
        assert.equal(payload.includes("/private/workflow"), false);
        assert.equal(payload.includes("/private/legacy-workflow"), false);
        const envelope = JSON.parse(payload) as {
          data: { workflow?: Record<string, unknown>; workflows?: Array<Record<string, unknown>> };
        };
        const records = envelope.data.workflows ?? (envelope.data.workflow ? [envelope.data.workflow] : []);
        assert.equal(records.length, 1);
        assert.equal("errorMessage" in records[0]!, false);
        assert.equal("error_message" in records[0]!, false);
      }
    });
  });
  it("decodes quoted multipart filenames as UTF-8", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "pi-scholar-server-"));
    let observedName = "";
    let observedOriginalName = "";
    const application = {
      paths: { workRoot },
      stageSource: async (request: {
        readonly filePath: string;
        readonly name: string;
        readonly originalName: string;
      }) => {
        observedName = request.name;
        observedOriginalName = request.originalName;
        assert.equal(readFileSync(request.filePath, "utf8"), "résumé");
        return { source: {} };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;
    const boundary = "pi-scholar-utf8";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nupload\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="résumé.pdf"\r\n` +
        "Content-Type: application/pdf\r\n\r\nrésumé\r\n" +
        `--${boundary}--\r\n`,
      "utf8",
    );
    try {
      await withServer(application, async (base) => {
        const response = await fetch(`${base}/api/v1/sources`, {
          method: "POST",
          headers: sameOriginHeaders(base, {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Sec-Fetch-Site": "same-origin",
            "X-Pi-Scholar-Request": "1",
          }),
          body,
        });
        assert.equal(response.status, 200);
      });
      assert.equal(observedName, "résumé.pdf");
      assert.equal(observedOriginalName, "résumé.pdf");
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("accepts a streamed multipart file beyond the former default cap", async () => {
    let observedSize = 0;
    const workRoot = mkdtempSync(join(tmpdir(), "pi-scholar-server-"));
    const application = {
      paths: { workRoot },
      stageSource: async (request: { readonly filePath: string }) => {
        observedSize = statSync(request.filePath).size;
        return { source: {} };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;
    const boundary = "pi-scholar-stream";
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nupload\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payloadSize = 101 * 1024 * 1024 + 1;
    const chunk = new Uint8Array(1024 * 1024);
    chunk.fill(65);
    let remaining = payloadSize;
    let suffixSent = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
      },
      pull(controller) {
        if (remaining > 0) {
          const size = Math.min(remaining, chunk.byteLength);
          controller.enqueue(chunk.subarray(0, size));
          remaining -= size;
          return;
        }
        if (!suffixSent) {
          suffixSent = true;
          controller.enqueue(suffix);
          controller.close();
        }
      },
    });
    try {
      await withServer(application, async (base) => {
        const response = await fetch(`${base}/api/v1/sources`, {
          method: "POST",
          headers: sameOriginHeaders(base, {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Sec-Fetch-Site": "same-origin",
            "X-Pi-Scholar-Request": "1",
          }),
          body,
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        assert.equal(response.status, 200);
      });
      assert.equal(observedSize, payloadSize);
      assert.deepEqual(readdirSync(workRoot), []);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed, repeated, and multiple multipart parts without retaining spools", async () => {
    let calls = 0;
    const workRoot = mkdtempSync(join(tmpdir(), "pi-scholar-server-"));
    const application = {
      paths: { workRoot },
      stageSource: async () => {
        calls += 1;
        return { source: {} };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;
    try {
      await withServer(application, async (base) => {
        const post = (body: BodyInit, contentType?: string) =>
          fetch(`${base}/api/v1/sources`, {
            method: "POST",
            headers: sameOriginHeaders(base, {
              ...(contentType ? { "Content-Type": contentType } : {}),
              "Sec-Fetch-Site": "same-origin",
              "X-Pi-Scholar-Request": "1",
            }),
            body,
          });
        const unknown = new FormData();
        unknown.set("kind", "upload");
        unknown.set("unexpected", "no");
        unknown.append("file", new Blob(["notes"], { type: "text/plain" }), "notes.txt");
        assert.equal((await post(unknown)).status, 400);
        const repeated = new FormData();
        repeated.append("kind", "upload");
        repeated.append("kind", "upload");
        repeated.append("file", new Blob(["notes"], { type: "text/plain" }), "notes.txt");
        assert.equal((await post(repeated)).status, 400);
        const multiple = new FormData();
        multiple.set("kind", "upload");
        multiple.append("file", new Blob(["notes"], { type: "text/plain" }), "one.txt");
        multiple.append("file", new Blob(["notes"], { type: "text/plain" }), "two.txt");
        assert.equal((await post(multiple)).status, 400);
        assert.equal((await post("not multipart", "multipart/form-data; boundary=broken")).status, 400);
      });
      assert.equal(calls, 0);
      assert.deepEqual(readdirSync(workRoot), []);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("enforces an explicitly configured multipart file limit and cleans failed uploads", async () => {
    let calls = 0;
    const workRoot = mkdtempSync(join(tmpdir(), "pi-scholar-server-"));
    const application = {
      paths: { workRoot },
      stageSource: async () => {
        calls += 1;
        return { source: {} };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;
    try {
      await withServer(
        application,
        async (base) => {
          const form = new FormData();
          form.set("kind", "upload");
          form.append("file", new Blob(["1234"], { type: "text/plain" }), "large.txt");
          const response = await fetch(`${base}/api/v1/sources`, {
            method: "POST",
            headers: sameOriginHeaders(base, {
              "Sec-Fetch-Site": "same-origin",
              "X-Pi-Scholar-Request": "1",
            }),
            body: form,
          });
          assert.equal(response.status, 413);
        },
        undefined,
        { maxMultipartBytes: 3 },
      );
      assert.equal(calls, 0);
      assert.deepEqual(readdirSync(workRoot), []);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });
  it("returns an HTTP error and removes the spool when output fails before multipart completion", async () => {
    let calls = 0;
    const workRoot = mkdtempSync(join(tmpdir(), "pi-scholar-server-"));
    const application = {
      paths: { workRoot },
      stageSource: async () => {
        calls += 1;
        return { source: {} };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;
    const boundary = "pi-scholar-output-failure";
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nupload\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\n` +
        "Content-Type: text/plain\r\n\r\n",
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const spoolCreated = Promise.withResolvers<void>();
    const watcher = watch(workRoot, (_event, filename) => {
      if (!filename?.toString().startsWith("http-upload-")) return;
      try {
        mkdirSync(join(workRoot, filename.toString(), "upload"));
        spoolCreated.resolve();
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) spoolCreated.reject(error);
      }
    });
    process.on("unhandledRejection", onUnhandled);
    let request: ClientRequest | undefined;
    try {
      await withServer(application, async (base) => {
        const responseStatus = new Promise<number>((resolve, reject) => {
          request = httpRequest(
            `${base}/api/v1/sources`,
            {
              method: "POST",
              headers: sameOriginHeaders(base, {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                Connection: "close",
                "Sec-Fetch-Site": "same-origin",
                "X-Pi-Scholar-Request": "1",
              }),
            },
            (response) => {
              response.resume();
              response.once("end", () => resolve(response.statusCode ?? 0));
            },
          );
          request.once("error", reject);
          request.flushHeaders();
          request.write(prefix.subarray(0, 2));
        });
        await Promise.race([
          spoolCreated.promise,
          delay(2_000).then(() => {
            throw new Error("multipart spool was not created");
          }),
        ]);
        watcher.close();
        request.write(prefix.subarray(2));
        request.write("notes");
        await setImmediate();
        await setImmediate();
        assert.deepEqual(unhandled, []);
        request.end(suffix);
        assert.equal(
          await Promise.race([
            responseStatus,
            delay(2_000).then(() => {
              throw new Error("multipart failure response was not received");
            }),
          ]),
          500,
        );
        await setImmediate();
        assert.deepEqual(unhandled, []);
        request.destroy();
      });
      assert.equal(calls, 0);
      assert.deepEqual(readdirSync(workRoot), []);
    } finally {
      request?.destroy();
      watcher.close();
      process.off("unhandledRejection", onUnhandled);
      rmSync(workRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects unknown and mismatched source payload kinds before staging", async () => {
    let calls = 0;
    const application = {
      stageSource: async () => {
        calls += 1;
        return { source: {} };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      for (const body of [
        { kind: "unknown", text: "payload" },
        { kind: "url", text: "not a URL payload" },
        { kind: "document", path: "/etc/passwd" },
      ]) {
        const response = await fetch(`${base}/api/v1/sources`, {
          method: "POST",
          headers: sameOriginHeaders(base, { "Content-Type": "application/json", "X-Pi-Scholar-Request": "1" }),
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
      }
      assert.equal(calls, 0);
    });
  });

  it("returns source URL validation failures as actionable client errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-source-url-"));
    const application = new ScholarApplication({
      paths: initVault(join(root, "vault")),
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: (_paths, subject) => ({ committed: true, subject }),
    });
    try {
      await withServer(application, async (base) => {
        const response = await fetch(`${base}/api/v1/sources`, {
          method: "POST",
          headers: sameOriginHeaders(base, { "Content-Type": "application/json", "X-Pi-Scholar-Request": "1" }),
          body: JSON.stringify({ kind: "url", url: "ftp://example.com/source.txt" }),
        });
        const body = (await response.json()) as {
          readonly error: { readonly code: string; readonly message: string };
        };
        assert.equal(response.status, 400);
        assert.equal(body.error.code, "validation-error");
        assert.equal(body.error.message, "only HTTP(S) URLs are accepted");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes lock diagnostics at the HTTP boundary", async () => {
    const application = {
      stageSource: async () => {
        throw new LockBusyError("/private/vault/.pi-scholar/writer.lock");
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/v1/sources`, {
        method: "POST",
        headers: sameOriginHeaders(base, { "Content-Type": "application/json", "X-Pi-Scholar-Request": "1" }),
        body: JSON.stringify({ kind: "text", text: "valid source text" }),
      });
      const payload = await response.text();
      const body = JSON.parse(payload) as {
        readonly error: { readonly code: string; readonly message: string };
      };
      assert.equal(response.status, 409);
      assert.equal(body.error.code, "LOCK_BUSY");
      assert.equal(body.error.message, "Pi Scholar is busy; try again later.");
      assert.equal(payload.includes("/private"), false);
      assert.equal(payload.includes("writer.lock"), false);
    });
  });
  it("hides unexpected internal failures while preserving validation errors", async () => {
    const sensitiveMessage = "SQLITE_ERROR: unable to open /private/vault/.pi-scholar/vault.sqlite";
    const application = {
      listSources: async () => {
        throw Object.assign(new Error(sensitiveMessage), {
          code: "SQLITE_ERROR",
          details: { path: "/private/vault/.pi-scholar/vault.sqlite", query: "SELECT * FROM sources" },
        });
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/v1/sources`);
      const payload = await response.text();
      const body = JSON.parse(payload) as {
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly requestId: string;
          readonly details?: unknown;
        };
      };
      assert.equal(response.status, 500);
      assert.equal(body.error.code, "INTERNAL_ERROR");
      assert.equal(body.error.message, "Internal server error");
      assert.ok(body.error.requestId);
      assert.equal("details" in body.error, false);
      assert.equal(payload.includes(sensitiveMessage), false);
      assert.equal(payload.includes("vault.sqlite"), false);
      assert.equal(payload.includes("SELECT * FROM sources"), false);

      const validationResponse = await fetch(`${base}/api/v1/sources`, {
        method: "POST",
        headers: sameOriginHeaders(base, { "Content-Type": "application/json", "X-Pi-Scholar-Request": "1" }),
        body: JSON.stringify({ kind: "invalid", text: "payload" }),
      });
      const validationBody = (await validationResponse.json()) as {
        readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
      };
      assert.equal(validationResponse.status, 400);
      assert.equal(validationBody.error.code, "validation-error");
      assert.equal(validationBody.error.message, "source kind is invalid");
      assert.ok(validationBody.error.requestId);
    });
  });

  it("retains only safe metadata for applied finalization failures", async () => {
    const secretCause = "projection not found: SQLITE_ERROR: unable to open /private/vault/.pi-scholar/vault.sqlite";
    const application = {
      listSources: async () => {
        throw Object.assign(new Error(`mutation applied but projection failed: ${secretCause}`), {
          code: "MUTATION_APPLIED_FINALIZATION_FAILED",
          details: {
            applied: true,
            retryable: true,
            stage: "projection",
            secret: secretCause,
          },
        });
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/v1/sources`);
      const payload = await response.text();
      const body = JSON.parse(payload) as {
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly details: Record<string, unknown>;
        };
      };
      assert.equal(response.status, 500);
      assert.equal(body.error.code, "MUTATION_APPLIED_FINALIZATION_FAILED");
      assert.equal(body.error.message, "Internal server error");
      assert.deepEqual(body.error.details, { applied: true, retryable: true, stage: "projection" });
      assert.equal(payload.includes(secretCause), false);
      assert.equal(payload.includes("secret"), false);
    });
  });

  it("accepts deterministic RFC v5 source IDs for removal preview", async () => {
    const sourceId = "886313e1-3b8a-5372-9b90-0c9aee199e5d";
    let received: string | undefined;
    const application = {
      removalPreview: async (value: string) => {
        received = value;
        return {
          source: { sourceId: value },
          dependentPageIds: [],
          confirmationId: "confirmation",
        };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/v1/sources/${sourceId}/removal-preview`, {
        method: "POST",
        headers: sameOriginHeaders(base, { "Content-Type": "application/json", "X-Pi-Scholar-Request": "1" }),
        body: JSON.stringify({ sourceId }),
      });
      assert.equal(response.status, 200);
      assert.equal(received, sourceId);
    });
  });

  it("rejects unsupported wiki search modes", async () => {
    let calls = 0;
    const application = {
      searchWiki: async () => {
        calls += 1;
        return { results: [] };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/v1/wiki/search?q=term&mode=bogus`);
      assert.equal(response.status, 400);
      assert.equal(calls, 0);
    });
  });

  it("rejects blank wiki searches before application dispatch", async () => {
    let calls = 0;
    const application = {
      searchWiki: async () => {
        calls += 1;
        return { results: [] };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      const response = await fetch(`${base}/api/v1/wiki/search?q=`);
      assert.equal(response.status, 400);
      assert.equal(calls, 0);
    });
  });

  it("does not serve files through a symlinked static ancestor", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-scholar-static-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-scholar-outside-"));
    writeFileSync(join(outside, "secret.txt"), "private");
    symlinkSync(outside, join(root, "escape"), "dir");
    const application = { close: async () => undefined } as unknown as ScholarApplication;

    try {
      await withServer(
        application,
        async (base) => {
          const response = await fetch(`${base}/escape/secret.txt`);
          assert.notEqual(response.status, 200);
          assert.notEqual(await response.text(), "private");
        },
        root,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("projects quiz list and detail responses without rubric or answer material", async () => {
    const internal = publicQuizFixture();
    const detail = {
      ...internal,
      answers: [{ questionId: "question-1", answer: "A **Markdown** answer." }],
      questionResults: [
        {
          resultId: "question-result-1",
          quizId: internal.quizId,
          questionId: "question-1",
          answerRevision: 1,
          feedback: "Question **feedback**.",
          gradedAt: new Date(0).toISOString(),
        },
      ],
      pageResults: [
        {
          resultId: "page-result-1",
          quizId: internal.quizId,
          pageId: "page-1",
          pageLink: {
            pageId: "page-1",
            path: "guide.md",
            href: "/notes?pageId=page-1#note-content",
          },
          rating: "Good",
          feedback: "Page **feedback**.",
          reviewId: "review-1",
          evidence: ["evidence-1"],
          readings: [{ pageId: "page-1", path: "guide.md", href: "/notes?pageId=page-1" }],
        },
      ],
      grades: [],
      readings: [{ pageId: "page-1", path: "guide.md", href: "/notes?pageId=page-1" }],
    };
    const recommendations = {
      readings: [
        {
          pageId: "page-2",
          path: "related.md",
          title: "Related",
          href: "/notes?pageId=page-2#note-content",
          reason: "related",
        },
      ],
      gaps: [
        {
          pageId: "page-3",
          path: "gap.md",
          title: "Gap",
          href: "/notes?pageId=page-3#note-content",
          kind: "missing",
        },
      ],
    };
    const target = {
      quiz: { list: () => [internal], get: () => internal, readSettledResult: () => undefined },
      quizDetail: async () => detail,
      quizRecommendations: async () => recommendations,
      db: { all: () => [], get: () => undefined },
    };
    const application = {
      listQuizzes: ScholarApplication.prototype.listQuizzes.bind(target),
      getQuiz: ScholarApplication.prototype.getQuiz.bind(target),
      close: async () => undefined,
    } as unknown as ScholarApplication;

    await withServer(application, async (base) => {
      for (const path of ["/api/v1/quizzes", "/api/v1/quizzes/2026-08-09"]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 200);
        const envelope = (await response.json()) as {
          data: {
            quizzes?: Array<{ questions: Array<Record<string, unknown>> }>;
            quiz?: {
              questions: Array<Record<string, unknown>>;
              pageResults?: Array<Record<string, unknown>>;
            };
            recommendations?: typeof recommendations;
          };
        };
        const questions = envelope.data.quizzes?.[0]?.questions ?? envelope.data.quiz?.questions ?? [];
        const quiz = envelope.data.quizzes?.[0] ?? envelope.data.quiz;
        assert.equal("sheetPath" in quiz!, false);
        assert.equal(questions.length, 1);
        assert.equal("pages" in questions[0]!, false);
        assert.equal("criterion" in questions[0]!, false);
        assert.equal("weight" in questions[0]!, false);
        assert.equal("answerKey" in questions[0]!, false);
        assert.equal("sourceRefs" in questions[0]!, false);
        if (path.endsWith("/2026-08-09")) {
          assert.deepEqual(envelope.data.quiz?.pageResults?.[0]?.pageLink, detail.pageResults[0]!.pageLink);
          assert.deepEqual(envelope.data.recommendations, recommendations);
        }
      }
      assert.equal(internal.questions[0]!.pages[0]!.criterion, "secret rubric");
    });
  });
  it("gates simulated-date settings behind developer tools and reports capability", async () => {
    const settings = {
      maintenanceEnabled: true,
      simulatedDate: "2026-08-15",
      timezone: "local",
      port: 4816,
      host: "127.0.0.1",
      updatedAt: "2026-08-15T12:00:00.000Z",
      facts: {
        localDate: "2026-08-15",
        pendingInboxCount: 0,
        openIssueCount: 0,
        recentChanges: [],
        git: { clean: true, ahead: 0, behind: 0, diverged: false },
      },
    };
    const updates: Array<{ readonly input: unknown; readonly context: unknown }> = [];
    const application = {
      getSettings: async () => ({ settings }),
      updateSettings: async (input: unknown, context: unknown) => {
        updates.push({ input, context });
        return { settings: { ...settings, ...(input as object) } };
      },
      close: async () => undefined,
    } as unknown as ScholarApplication;
    const put = (base: string, body: unknown) =>
      fetch(`${base}/api/v1/settings`, {
        method: "PUT",
        headers: sameOriginHeaders(base, { "Content-Type": "application/json", "X-Pi-Scholar-Request": "1" }),
        body: JSON.stringify(body),
      });

    await withServer(application, async (base) => {
      const get = await fetch(`${base}/api/v1/settings`);
      assert.equal(get.status, 200);
      const payload = (await get.json()) as { data: { developerToolsEnabled: boolean; settings: typeof settings } };
      assert.equal(payload.data.developerToolsEnabled, false);
      assert.equal(payload.data.settings.simulatedDate, "2026-08-15");

      const denied = await put(base, { simulatedDate: "2026-08-16" });
      assert.equal(denied.status, 403);
      assert.equal(updates.length, 0);

      const ordinary = await put(base, { maintenanceEnabled: false });
      assert.equal(ordinary.status, 200);
      assert.deepEqual(updates[0]?.context, { origin: "browser" });
      const ordinaryPayload = (await ordinary.json()) as { data: { developerToolsEnabled: boolean } };
      assert.equal(ordinaryPayload.data.developerToolsEnabled, false);
    });

    await withServer(
      application,
      async (base) => {
        const get = await fetch(`${base}/api/v1/settings`);
        const payload = (await get.json()) as { data: { developerToolsEnabled: boolean } };
        assert.equal(payload.data.developerToolsEnabled, true);

        const date = await put(base, { simulatedDate: "2026-08-16" });
        assert.equal(date.status, 200);
        assert.deepEqual(updates[1], {
          input: { simulatedDate: "2026-08-16" },
          context: { origin: "browser", developerToolsEnabled: true },
        });

        const cleared = await put(base, { simulatedDate: null });
        assert.equal(cleared.status, 200);
        assert.deepEqual(updates[2], {
          input: { simulatedDate: null },
          context: { origin: "browser", developerToolsEnabled: true },
        });

        for (const body of [{ simulatedDate: "2026-02-29" }, { simulatedDate: 42 }, { unexpected: true }]) {
          const response = await put(base, body);
          assert.equal(response.status, 400);
        }
        assert.equal(updates.length, 3);
      },
      undefined,
      { developerTools: true },
    );
  });
});
