import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedImageUri, markdownImages, parseManagedImageUri } from "../../../src/markdown";
import {
  api,
  isHealthResult,
  isQuizListResult,
  isQuizResult,
  isQuizSubmissionResult,
  isSettingsResult,
  isSourceListResult,
  isSourceRemovalPreviewResult,
  isWikiPageResult,
  isWorkflowListResult,
} from "./api";
import { Markdown } from "./components/Markdown";

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

  it("accepts only public settings metadata and valid simulated dates", () => {
    const result = {
      developerToolsEnabled: true,
      settings: {
        maintenanceEnabled: false,
        simulatedDate: "2026-08-15",
        timezone: "America/New_York",
        host: "127.0.0.1",
        port: 4816,
        updatedAt: new Date(0).toISOString(),
        facts: {
          localDate: "2026-08-15",
          pendingInboxCount: 1,
          openIssueCount: 2,
          recentChanges: [],
          git: { clean: true, ahead: 0, behind: 0, diverged: false },
        },
      },
    };
    assert.equal(isSettingsResult(result), true);
    const { simulatedDate: _simulatedDate, ...realSettings } = result.settings;
    assert.equal(isSettingsResult({ ...result, settings: realSettings }), true);
    assert.equal(isSettingsResult({ ...result, developerToolsEnabled: "yes" }), false);
    assert.equal(isSettingsResult({ ...result, settings: { ...result.settings, simulatedDate: null } }), false);
    assert.equal(isSettingsResult({ ...result, settings: { ...result.settings, simulatedDate: "2026-02-30" } }), false);
    assert.equal(isSettingsResult({ ...result, databasePath: "/private/state.sqlite" }), false);
    assert.equal(
      isSettingsResult({
        ...result,
        settings: { ...result.settings, facts: { ...result.settings.facts, workflowLease: "private" } },
      }),
      false,
    );
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
                kind: "free-response",
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
    const recommendations = {
      readings: [
        {
          pageId: "page-2",
          path: "reference.md",
          title: "Reference",
          href: "/notes?pageId=page-2",
          reason: "related",
        },
      ],
      gaps: [
        {
          pageId: "page-3",
          path: "gap.md",
          title: "Gap",
          href: "/notes?pageId=page-3",
          kind: "unclear",
        },
      ],
    };
    const result = {
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
            kind: "free-response",
            prompt: "Explain `x` and **why** it works.",
          },
        ],
        answers: [{ questionId: "question-1", answer: "An **explanation** with `code`." }],
        questionResults: [
          {
            resultId: "question-result-1",
            quizId: "quiz-1",
            questionId: "question-1",
            answerRevision: 2,
            feedback: "The answer addresses the **prompt**.",
            gradedAt: new Date(0).toISOString(),
          },
        ],
        pageResults: [
          {
            resultId: "page-result-1",
            quizId: "quiz-1",
            pageId: "page-1",
            pageLink: { pageId: "page-1", path: "guide.md", href: "/notes?pageId=page-1#note-content" },
            rating: "Good",
            feedback: "Clear **explanation**.",
            reviewId: "review-1",
            evidence: ["evidence-1"],
            readings: [reading],
          },
        ],
        grades: [grade],
        readings: [reading],
      },
      answers: [{ questionId: "question-1", answer: "An **explanation** with `code`." }],
      grades: [grade],
      readings: [reading],
      recommendations,
    };
    assert.equal(isQuizResult(result), true);
    const { pageLink: _pageLink, ...withoutPageLink } = result.quiz.pageResults[0]!;
    assert.equal(isQuizResult({ ...result, quiz: { ...result.quiz, pageResults: [withoutPageLink] } }), false);
    assert.equal(
      isQuizResult({
        ...result,
        quiz: {
          ...result.quiz,
          pageResults: [{ ...result.quiz.pageResults[0]!, sourceRefs: ["private-source"] }],
        },
      }),
      false,
    );
  });
  it("requires exact public recommendation metadata", () => {
    const result = {
      outcome: "not-yet-run",
      answers: [],
      grades: [],
      readings: [],
      recommendations: {
        readings: [
          {
            pageId: "page-1",
            path: "guide.md",
            title: "Guide",
            href: "/notes?pageId=page-1",
            reason: "prerequisite",
          },
        ],
        gaps: [
          {
            pageId: "page-2",
            path: "gap.md",
            title: "Gap",
            href: "/notes?pageId=page-2",
            kind: "missing",
          },
        ],
      },
    };
    assert.equal(isQuizResult(result), true);
    assert.equal(isQuizResult({ ...result, recommendations: undefined }), false);
    assert.equal(
      isQuizResult({
        ...result,
        recommendations: {
          ...result.recommendations,
          gaps: [{ ...result.recommendations.gaps[0], issueId: "private-issue" }],
        },
      }),
      false,
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
  it("accepts the six workflow kinds", () => {
    const kinds = ["extract", "ingest", "lint", "daily", "quiz-grader", "sync"] as const;
    assert.equal(
      isWorkflowListResult({
        workflows: kinds.map((kind, index) => ({
          requestId: `workflow-${index}`,
          kind,
          status: "queued",
          progress: 0,
        })),
      }),
      true,
    );
  });
  it("rejects workflow diagnostics in public guards", () => {
    const workflow = {
      requestId: "workflow-1",
      kind: "ingest",
      status: "failed",
      progress: 0,
      errorMessage: "private diagnostic",
    };
    assert.equal(isWorkflowListResult({ workflows: [workflow] }), false);
    const quiz = {
      quizId: "quiz-1",
      date: "2026-08-09",
      revision: 1,
      status: "submitted",
      questions: [],
      answers: [],
      questionResults: [],
      pageResults: [],
      grades: [],
      readings: [],
      recommendations: { readings: [], gaps: [] },
    };
    assert.equal(
      isQuizSubmissionResult({
        status: "sealed",
        workflow,
        quiz,
        grades: [],
        readings: [],
        recommendations: { readings: [], gaps: [] },
      }),
      false,
    );
  });
});

describe("managed image Markdown", () => {
  it("parses canonical inline and reference images while ignoring code examples", () => {
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const digest = "a".repeat(64);
    const uri = managedImageUri(sourceId, digest);
    assert.deepEqual(parseManagedImageUri(uri), { sourceId, digest });
    assert.equal(parseManagedImageUri(`${uri}/extra`), undefined);
    assert.throws(() => managedImageUri(sourceId, digest.toUpperCase()), /malformed/u);
    assert.deepEqual(
      markdownImages(
        `\`![Inline code](${uri})\`\n\n\`\`\`md\n![Fenced](${uri})\n\`\`\`\n\n![Inline](${uri})\n\n![Reference][figure]\n\n![Missing][absent]\n\n[figure]: ${uri}\n`,
      ),
      [
        { url: uri, alt: "Inline" },
        { url: uri, alt: "Reference" },
      ],
    );
  });
});

describe("Markdown rendering", () => {
  it("renders inline and display math with KaTeX", () => {
    const rendered = renderToStaticMarkup(
      createElement(Markdown, {
        source: "Inline $E = mc^2$; blocked $\\href{https://example.com}{link}$.\n\n$$\n\\int_0^1 x^2\\,dx\n$$\n",
      }),
    );

    assert.match(rendered, /class="katex"/u);
    assert.match(rendered, /class="katex-display"/u);
    assert.doesNotMatch(rendered, /<a\b/u);
  });

  it("highlights fenced code without changing its whitespace", () => {
    const rendered = renderToStaticMarkup(
      createElement(Markdown, {
        source: "```ts\nconst answer = 42;\n  console.log(answer);\n```\n",
      }),
    );

    assert.match(rendered, /class="code-toolbar"/u);
    assert.match(rendered, /<span>ts<\/span>/u);
    assert.match(rendered, /aria-label="Copy ts code"/u);
    assert.match(rendered, />Copy<\/button>/u);
    assert.match(rendered, /class="hljs-keyword"/u);

    const code = rendered.match(/<code[^>]*>([\s\S]*?)<\/code>/u)?.[1];
    assert.equal(code?.replace(/<[^>]+>/gu, ""), "const answer = 42;\n  console.log(answer);\n");
  });

  it("queues Mermaid rendering while keeping raw HTML inert", () => {
    const rendered = renderToStaticMarkup(
      createElement(Markdown, {
        source: '```mermaid\ngraph TD\nA-->B\n```\n\n<div onclick="alert(1)">unsafe</div>\n',
      }),
    );

    assert.match(rendered, /class="mermaid-diagram"/u);
    assert.match(rendered, /aria-busy="true"/u);
    assert.match(rendered, /Rendering diagram/u);
    assert.doesNotMatch(rendered, /<svg|onclick=|&lt;div/u);
  });

  it("uses the image placeholder when assigning image-only heading ids", () => {
    const rendered = renderToStaticMarkup(
      createElement(Markdown, {
        source: "# ![Architecture](diagram.png)\n",
        headings: [{ heading: "[Image: Architecture]", anchor: "#image-architecture" }],
      }),
    );
    assert.match(rendered, /<h1 id="image-architecture">.*\[Image: Architecture\].*<\/h1>/u);
    assert.doesNotMatch(rendered, /<img/u);
  });

  it("renders only page-authorized managed images as same-origin attachments", () => {
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const digest = "a".repeat(64);
    const uri = `pi-scholar://source/${sourceId}/attachment/${digest}`;
    const managed = renderToStaticMarkup(
      createElement(Markdown, {
        source: `![Managed diagram][figure]\n\n[figure]: ${uri}\n`,
        pageId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    assert.match(
      managed,
      new RegExp(
        `<img alt="Managed diagram" loading="lazy" src="/api/v1/wiki/pages/22222222-2222-4222-8222-222222222222/attachments/${sourceId}/${digest}"`,
        "u",
      ),
    );
    assert.doesNotMatch(managed, /pi-scholar:/u);

    const unavailable = renderToStaticMarkup(
      createElement(Markdown, {
        source: `![No page](${uri})\n\n![External](https://example.com/image.png)\n\n[Managed link](${uri})\n`,
      }),
    );
    assert.match(unavailable, /\[Image: No page\]/u);
    assert.match(unavailable, /\[Image: External\]/u);
    assert.doesNotMatch(unavailable, /<img|pi-scholar:|https:\/\/example\.com\/image\.png/u);
  });
});
