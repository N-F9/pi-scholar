import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { ScholarApplication } from "../src/application/application.js";
import type { QuizRecord } from "../src/contracts.js";
import { type ServerOptions, startServer } from "../src/server.js";

async function withServer(
  application: ScholarApplication,
  run: (base: string) => Promise<void>,
  staticRoot?: string,
  serverOptions: Pick<ServerOptions, "maxMultipartBytes"> = {},
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
        kind: "short-answer",
        prompt: "Explain the idea.",
        pages: [{ pageId: "page-1", criterion: "secret rubric", weight: 9 }],
        sourceRefs: ["private-source"],
        answerKey: "secret answer",
      } as QuizRecord["questions"][number],
    ],
  };
}

describe("server browser boundary", () => {
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
      stageSource: async (request: { readonly filePath: string; readonly name: string }) => {
        sourceCalls += 1;
        receivedFilePath = request.filePath;
        assert.equal(request.name, "notes.txt");
        assert.equal(readFileSync(request.filePath, "utf8"), "notes");
        assert.equal(statSync(request.filePath).mode & 0o777, 0o600);
        return { source: {} };
      },
      listSources: async () => ({
        sources: [
          {
            sourceId: "source-1",
            kind: "upload",
            status: "pending",
            displayName: "notes",
            manifestPath: "/private/manifest.json",
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
        assert.equal(sourceListResponse.status, 200);
        assert.equal("manifestPath" in sourceListEnvelope.data.sources[0]!, false);

        const form = new FormData();
        form.set("kind", "upload");
        form.set("displayName", "notes");
        form.append("file", new Blob(["notes"], { type: "text/plain" }), "notes.txt");
        const multipartResponse = await fetch(`${base}/api/v1/sources`, {
          method: "POST",
          headers: sameOriginHeaders(base, { "Sec-Fetch-Site": "same-origin", "X-Pi-Scholar-Request": "1" }),
          body: form,
        });
        assert.equal(multipartResponse.status, 200);
        assert.equal(sourceCalls, 1);
      });
      assert.ok(receivedFilePath);
      assert.equal(existsSync(receivedFilePath), false);
      assert.deepEqual(readdirSync(workRoot), []);
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
    const target = {
      quiz: { list: () => [internal], get: () => internal, readSettledResult: () => undefined },
      quizDetail: async () => internal,
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
            quiz?: { questions: Array<Record<string, unknown>> };
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
      }
      assert.equal(internal.questions[0]!.pages[0]!.criterion, "secret rubric");
    });
  });
});
