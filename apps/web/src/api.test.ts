import { strict as assert } from "node:assert";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  isHealthResult,
  isQuizListResult,
  isQuizResult,
  isSourceListResult,
  isSourceRemovalPreviewResult,
  isWikiPageResult,
} from "./api";

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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          data: { status: "ok", version: "0.1.0" },
        }),
      ),
    );

    await expect(api("/healthz", undefined, isHealthResult)).resolves.toEqual({
      status: "ok",
      version: "0.1.0",
    });
  });

  it("rejects a successful envelope with malformed route data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          data: { status: "ok" },
        }),
      ),
    );

    await expect(api("/healthz", undefined, isHealthResult)).rejects.toMatchObject({
      code: "invalid-response",
      status: 200,
    });
  });

  it("rejects non-JSON responses before trusting the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("service unavailable", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );

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

  it("rejects quiz responses carrying private quiz metadata", () => {
    assert.equal(
      isQuizListResult({
        quizzes: [
          {
            quizId: "quiz-1",
            date: "2026-08-09",
            revision: 1,
            status: "open",
            questions: [
              {
                questionId: "question-1",
                quizId: "quiz-1",
                ordinal: 1,
                kind: "short-answer",
                prompt: "Explain",
                pages: [{ pageId: "page-1", criterion: "Explain the page", weight: 1 }],
                sourceRefs: ["private-source"],
              },
            ],
          },
        ],
      }),
      false,
    );
  });

  it("accepts page-oriented quiz results", () => {
    const reading = { pageId: "page-1", path: "guide.md", heading: "Overview", href: "/notes?pageId=page-1" };
    const grade = {
      gradeId: "grade-1",
      quizId: "quiz-1",
      pageId: "page-1",
      rating: "Good",
      feedback: "Clear explanation.",
      gradedAt: new Date(0).toISOString(),
      reviewId: "review-1",
    };
    assert.equal(
      isQuizResult({
        outcome: "submitted",
        quiz: {
          quizId: "quiz-1",
          date: "2026-08-09",
          revision: 2,
          status: "submitted",
          questions: [
            {
              questionId: "question-1",
              quizId: "quiz-1",
              ordinal: 1,
              kind: "short-answer",
              prompt: "Explain",
            },
          ],
          answers: [{ questionId: "question-1", answer: "An explanation" }],
          questionResults: [
            {
              resultId: "question-result-1",
              quizId: "quiz-1",
              questionId: "question-1",
              answerRevision: 2,
              feedback: "The answer addresses the prompt.",
              gradedAt: new Date(0).toISOString(),
            },
          ],
          pageResults: [
            {
              resultId: "page-result-1",
              quizId: "quiz-1",
              pageId: "page-1",
              rating: "Good",
              feedback: "Clear explanation.",
              reviewId: "review-1",
              evidence: ["evidence-1"],
              readings: [reading],
            },
          ],
          grades: [grade],
          readings: [reading],
        },
        answers: [{ questionId: "question-1", answer: "An explanation" }],
        grades: [grade],
        readings: [reading],
      }),
      true,
    );
  });

  it("accepts page schedules and prerequisites", () => {
    assert.equal(
      isWikiPageResult({
        page: {
          pageId: "page-1",
          relativePath: "guide.md",
          title: "Guide",
          digest: "digest",
          revision: 2,
          status: "active",
          quizWorthiness: "eligible",
          updatedAt: new Date(0).toISOString(),
        },
        markdown: "# Guide",
        sections: [],
        learning: {
          schedule: {
            pageId: "page-1",
            initialDueAt: new Date(0).toISOString(),
            dueAt: new Date(0).toISOString(),
            fsrsState: "Review",
            stability: 1,
            difficulty: 5,
            reps: 2,
            lapses: 0,
            scheduledDays: 1,
            lastReviewAt: new Date(0).toISOString(),
            revision: 2,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          prerequisites: [{ pageId: "page-1", prerequisitePageId: "page-0" }],
        },
      }),
      true,
    );
  });

  it("accepts source removal previews with dependent pages only", () => {
    assert.equal(
      isSourceRemovalPreviewResult({
        source: {
          sourceId: "source-1",
          kind: "document",
          status: "published",
          displayName: "Guide",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        dependentPageIds: ["page-1"],
        confirmationId: "confirmation-1",
      }),
      true,
    );
  });

  it("rejects source responses carrying local manifest paths", () => {
    assert.equal(
      isSourceListResult({
        sources: [
          {
            sourceId: "source-1",
            kind: "document",
            status: "pending",
            displayName: "notes",
            manifestPath: "/private/manifest.json",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      }),
      false,
    );
  });
});
