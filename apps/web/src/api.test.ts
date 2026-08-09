import { strict as assert } from "node:assert";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, isHealthResult, isQuizListResult, isSourceListResult } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api response boundary", () => {
  it("returns data only after the route guard accepts it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { status: "ok", version: "0.1.0" },
    })));

    await expect(api("/healthz", undefined, isHealthResult)).resolves.toEqual({
      status: "ok",
      version: "0.1.0",
    });
  });

  it("rejects a successful envelope with malformed route data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { status: "ok" },
    })));

    await expect(api("/healthz", undefined, isHealthResult)).rejects.toMatchObject({
      code: "invalid-response",
      status: 200,
    });
  });

  it("rejects non-JSON responses before trusting the body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("service unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    })));

    await expect(api("/healthz", undefined, isHealthResult)).rejects.toMatchObject({
      code: "invalid-response",
      status: 503,
    });
  });
  it("marks unsafe browser requests while leaving multipart boundaries to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/api/v1/wiki/issues", { method: "POST", body: "{}" });
    const jsonRequest = fetchMock.mock.calls[0]![1] as RequestInit;
    const jsonHeaders = new Headers(jsonRequest.headers);
    assert.equal(jsonHeaders.get("X-Pi-Scholar-Request"), "1");
    assert.equal(jsonHeaders.get("Content-Type"), "application/json");

    const form = new FormData();
    form.set("kind", "upload");
    await api("/api/v1/sources", { method: "POST", body: form });
    const multipartRequest = fetchMock.mock.calls[1]![1] as RequestInit;
    const multipartHeaders = new Headers(multipartRequest.headers);
    assert.equal(multipartHeaders.get("X-Pi-Scholar-Request"), "1");
    assert.equal(multipartHeaders.get("Content-Type"), null);
  });


  it("rejects quiz responses carrying private grading fields", () => {
    assert.equal(isQuizListResult({
      quizzes: [{
        quizId: "quiz-1",
        date: "2026-08-09",
        revision: 1,
        status: "open",
        questions: [{
          questionId: "question-1",
          quizId: "quiz-1",
          ordinal: 1,
          kind: "short-answer",
          prompt: "Explain",
          cardIds: ["card-1"],
          sourceRefs: [],
          cards: [{ cardId: "card-1", criterion: "private", weight: 1 }],
        }],
      }],
    }), false);
  });

  it("rejects source responses carrying local manifest paths", () => {
    assert.equal(isSourceListResult({
      sources: [{
        sourceId: "source-1",
        kind: "upload",
        status: "pending",
        displayName: "notes",
        manifestPath: "/private/manifest.json",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }],
    }), false);
  });
});
