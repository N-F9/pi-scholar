import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  ExtractContext,
  ExtractPublicationInput,
  ExtractPublicationResult,
  GradeSettlementInput,
  GradingContext,
  GradingResult,
  IngestContext,
  LintContext,
  QuizContext,
  QuizDetailRecord,
  QuizEvidenceRecord,
  QuizEvidenceRequest,
  QuizPublicationInput,
  SourceRequest,
  WikiChangeInput,
  WikiChangeResult,
} from "../src/contracts.js";

type WikiNoteInput = {
  readonly path: string;
  readonly title?: string;
  readonly body: string;
  readonly pageId?: string;
  readonly quizWorthiness?: "eligible" | "skip" | "unknown";
};
type WikiNoteUpdateInput = {
  readonly path?: string;
  readonly title?: string;
  readonly body?: string;
  readonly quizWorthiness?: "eligible" | "skip" | "unknown";
  readonly expectedDigest?: string;
};

type LifecycleKind = "extract" | "ingest" | "lint" | "daily" | "quiz-grader" | "sync";

type ExtractWorkflowState = {
  readonly requestId: string;
  readonly expectedClaimKeys: ReadonlySet<string>;
  readonly attemptedClaimKeys: ReadonlySet<string>;
  readonly completedClaimKeys: ReadonlySet<string>;
  readonly failed: boolean;
};

type WorkflowState =
  | {
      readonly requestId: string;
      readonly remaining: number;
    }
  | ExtractWorkflowState;

type WorkflowFinishOptions = {
  readonly progress?: number;
  readonly message?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

type VaultPaths = { readonly vaultRoot: string };

type ScholarApplication = {
  readonly paths: VaultPaths;
  readonly status: () => Promise<unknown>;
  readonly stageSource: (request: SourceRequest) => Promise<unknown>;
  readonly createNote: (input: WikiNoteInput) => Promise<unknown>;
  readonly updateNote: (pageId: string, input: WikiNoteUpdateInput) => Promise<unknown>;
  readonly removalPreview: (sourceId: string) => Promise<unknown>;
  readonly removeSource: (sourceId: string, confirmationId: string) => Promise<unknown>;
  readonly searchWiki: (
    query: string,
    options?: { readonly mode?: "semantic" | "lexical" | "exact"; readonly limit?: number },
  ) => Promise<unknown>;
  readonly reportIssue: (input: Record<string, unknown>) => Promise<unknown>;
  readonly beginWorkflow: (kind: LifecycleKind) => Promise<{ readonly workflow: { readonly requestId: string } }>;
  readonly updateWorkflow: (
    requestId: string,
    input: { readonly progress?: number; readonly message?: string },
  ) => Promise<unknown>;
  readonly finishWorkflow: (
    requestId: string,
    status: "succeeded" | "failed",
    options?: WorkflowFinishOptions,
  ) => Promise<unknown>;
  readonly getExtractContext: () => Promise<ExtractContext>;
  readonly publishExtraction: (input: ExtractPublicationInput) => Promise<ExtractPublicationResult>;
  readonly getIngestContext: () => Promise<IngestContext>;
  readonly getLintContext: (input?: { readonly description?: string }) => Promise<LintContext>;
  readonly applyWikiChange: (input: WikiChangeInput) => Promise<WikiChangeResult>;
  readonly getQuizEvidence: (input: QuizEvidenceRequest) => Promise<readonly QuizEvidenceRecord[]>;
  readonly getQuizContext: (input?: { readonly date?: string }) => Promise<QuizContext>;
  readonly publishQuiz: (input: QuizPublicationInput) => Promise<QuizDetailRecord>;
  readonly getGradingContext: (input?: { readonly date?: string }, ownerToken?: string) => Promise<GradingContext>;
  readonly settleGrade: (input: GradeSettlementInput, ownerToken?: string) => Promise<GradingResult>;
  readonly close?: () => Promise<void> | void;
};

const workflowStates = new Map<string, WorkflowState>();

interface RuntimeModule {
  readonly createApplication: (options: { readonly paths: VaultPaths }) => ScholarApplication;
  readonly resolveVault: (path?: string) => VaultPaths;
}

const sourceInput = Type.Object({
  kind: Type.Optional(
    Type.Union([
      Type.Literal("document"),
      Type.Literal("url"),
      Type.Literal("text"),
      Type.Literal("pasted"),
      Type.Literal("note"),
      Type.Literal("code"),
      Type.Literal("directory"),
      Type.Literal("repository"),
    ]),
  ),
  path: Type.Optional(Type.String()),
  filePath: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  displayName: Type.Optional(Type.String()),
  originalName: Type.Optional(Type.String()),
  mediaType: Type.Optional(Type.String()),
});
const noteInput = Type.Object({
  pageId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  body: Type.Optional(
    Type.String({
      description:
        "Complete Markdown body. Preserve user-authored prose; model-authored source notes must be self-contained textbook-style exposition with nearby source-chunk citations.",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Alias for body. Preserve user-authored prose; model-authored source notes must teach the topic in depth rather than summarize it.",
    }),
  ),
  quizWorthiness: Type.Optional(Type.Union([Type.Literal("eligible"), Type.Literal("skip"), Type.Literal("unknown")])),
});
const removalInput = Type.Object({
  sourceId: Type.String(),
  confirmationId: Type.Optional(Type.String()),
  confirm: Type.Optional(Type.Boolean()),
});
const searchInput = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const statusInput = Type.Object({});
const emptyInput = Type.Object({});

const extractionInput = Type.Object({
  claimId: Type.String({ minLength: 1 }),
  preparedId: Type.String({ minLength: 1 }),
  digest: Type.String({ minLength: 1 }),
  endpoints: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
});

const wikiChangeIssuePageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  expectedDigest: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  quizWorthiness: Type.Optional(Type.Union([Type.Literal("eligible"), Type.Literal("skip"), Type.Literal("unknown")])),
});

const wikiChangeInput = Type.Union([
  Type.Object({
    kind: Type.Literal("create-page"),
    path: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String()),
    body: Type.String({
      description:
        "Complete Markdown body; model-authored source pages must teach at textbook depth and cite supporting source chunks.",
    }),
    quizWorthiness: Type.Optional(
      Type.Union([Type.Literal("eligible"), Type.Literal("skip"), Type.Literal("unknown")]),
    ),
  }),
  Type.Object({
    kind: Type.Literal("update-page"),
    pageId: Type.String({ minLength: 1 }),
    expectedDigest: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String()),
    body: Type.Optional(
      Type.String({
        description:
          "Complete replacement Markdown body; model-authored source pages must teach at textbook depth and cite supporting source chunks.",
      }),
    ),
    quizWorthiness: Type.Optional(
      Type.Union([Type.Literal("eligible"), Type.Literal("skip"), Type.Literal("unknown")]),
    ),
  }),
  Type.Object({
    kind: Type.Literal("rename-page"),
    pageId: Type.String({ minLength: 1 }),
    expectedDigest: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("prerequisites"),
    pageId: Type.String({ minLength: 1 }),
    prerequisitePageIds: Type.Array(Type.String({ minLength: 1 })),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  Type.Object({
    kind: Type.Literal("resolve-issue"),
    issueId: Type.String({ minLength: 1 }),
    page: wikiChangeIssuePageInput,
    resolution: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("retire-page"),
    pageId: Type.String({ minLength: 1 }),
    expectedDigest: Type.String({ minLength: 1 }),
  }),
]);

const quizQuestionPageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  criterion: Type.String({ minLength: 1 }),
  weight: Type.Number({ exclusiveMinimum: 0 }),
});

const quizQuestionProposal = Type.Object({
  kind: Type.Union([Type.Literal("free-response"), Type.Literal("multiple-choice")]),
  prompt: Type.String({ minLength: 1 }),
  choices: Type.Optional(Type.Array(Type.String())),
  pages: Type.Array(quizQuestionPageInput, { minItems: 1 }),
  sourceRefs: Type.Array(Type.String()),
  answerKey: Type.Optional(Type.Unknown()),
});
const quizInput = Type.Union([
  Type.Object({
    status: Type.Literal("published"),
    date: Type.String({ minLength: 1 }),
    questions: Type.Array(quizQuestionProposal),
  }),
  Type.Object({
    status: Type.Literal("skipped"),
    date: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
  }),
]);
const quizEvidenceInput = Type.Object({
  date: Type.String({ minLength: 1 }),
  pageIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});
const contextDateInput = Type.Object({ date: Type.Optional(Type.String({ minLength: 1 })) });
const lintContextInput = Type.Object({ description: Type.Optional(Type.String()) });
const gradeReadingInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  anchor: Type.String({ minLength: 1 }),
  heading: Type.Optional(Type.String()),
});
const gradePageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  rating: Type.Union([Type.Literal("Again"), Type.Literal("Hard"), Type.Literal("Good"), Type.Literal("Easy")]),
  feedback: Type.Optional(Type.String()),
  evidence: Type.Array(Type.String()),
  readings: Type.Optional(Type.Array(gradeReadingInput)),
});
const gradeQuestionInput = Type.Object({
  questionId: Type.String({ minLength: 1 }),
  feedback: Type.Optional(Type.String()),
});
const gradeInput = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  date: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  submissionId: Type.String({ minLength: 1 }),
  questions: Type.Array(gradeQuestionInput),
  pages: Type.Array(gradePageInput),
});

const appCache = new Map<string, ScholarApplication>();
const gradingClaimOwner = randomUUID();

async function loadRuntimeModule(): Promise<RuntimeModule> {
  const application = (await import("../dist/application/application.js")) as unknown as Pick<
    RuntimeModule,
    "createApplication"
  >;
  const vault = (await import("../dist/vault.js")) as unknown as Pick<RuntimeModule, "resolveVault">;
  return { ...application, ...vault };
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool input must be an object");
  return value as Record<string, unknown>;
}

function jsonResult(value: unknown): AgentToolResult<unknown> {
  const text = typeof value === "string" ? value : (JSON.stringify(value ?? null) ?? String(value));
  return { content: [{ type: "text", text }], details: value };
}

async function applicationFor(ctx: ExtensionContext): Promise<ScholarApplication> {
  const module = await loadRuntimeModule();
  const paths = module.resolveVault(ctx.cwd);
  const cached = appCache.get(paths.vaultRoot);
  if (cached) return cached;
  const app = module.createApplication({ paths });
  appCache.set(paths.vaultRoot, app);
  return app;
}

function progress(onUpdate: AgentToolUpdateCallback<unknown> | undefined, message: string): void {
  onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
}

async function call<T>(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  message: string,
  operation: (app: ScholarApplication) => Promise<T> | T,
): Promise<AgentToolResult<unknown>> {
  cancelled(signal);
  progress(onUpdate, message);
  const app = await applicationFor(ctx);
  cancelled(signal);
  const result = await operation(app);
  progress(onUpdate, "Pi Scholar completed");
  return jsonResult(result);
}

function workflowKey(app: ScholarApplication, kind: LifecycleKind): string {
  return `${app.paths.vaultRoot}:${kind}`;
}

function workflowError(error: unknown): WorkflowFinishOptions {
  return {
    errorCode:
      error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "PI_WORKFLOW_FAILED",
    errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}

function extractClaimKey(input: Pick<ExtractPublicationInput, "claimId" | "preparedId">): string {
  return `${input.claimId}\u0000${input.preparedId}`;
}

function extractWorkflowFailure(): WorkflowFinishOptions {
  return {
    progress: 1,
    message: "Workflow completed with extraction failures",
    errorCode: "PI_WORKFLOW_FAILED",
    errorMessage: "One or more extraction entries failed",
  };
}

function recordExtractAttempt(
  state: ExtractWorkflowState,
  claimKey: string | undefined,
  succeeded: boolean,
): { readonly state: ExtractWorkflowState; readonly accepted: boolean; readonly finished: boolean } {
  if (!claimKey || !state.expectedClaimKeys.has(claimKey)) return { state, accepted: false, finished: false };
  if (state.attemptedClaimKeys.has(claimKey))
    return {
      state,
      accepted: true,
      finished: state.attemptedClaimKeys.size === state.expectedClaimKeys.size,
    };
  const attemptedClaimKeys = new Set(state.attemptedClaimKeys);
  attemptedClaimKeys.add(claimKey);
  const completedClaimKeys = new Set(state.completedClaimKeys);
  if (succeeded) completedClaimKeys.add(claimKey);
  const next = {
    ...state,
    attemptedClaimKeys,
    completedClaimKeys,
    failed: state.failed || !succeeded,
  };
  return {
    state: next,
    accepted: true,
    finished: attemptedClaimKeys.size === state.expectedClaimKeys.size,
  };
}

function workflowFinalizationApplied(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("details" in error)) return false;
  const details = error.details;
  return details !== null && typeof details === "object" && "applied" in details && details.applied === true;
}

async function persistExtractAttempt(
  app: ScholarApplication,
  key: string,
  attempt: { readonly state: ExtractWorkflowState; readonly finished: boolean },
): Promise<void> {
  if (attempt.finished) {
    await app.finishWorkflow(
      attempt.state.requestId,
      attempt.state.failed ? "failed" : "succeeded",
      attempt.state.failed ? extractWorkflowFailure() : { progress: 1, message: "Workflow completed" },
    );
    workflowStates.delete(key);
  } else {
    const remaining = attempt.state.expectedClaimKeys.size - attempt.state.attemptedClaimKeys.size;
    await app.updateWorkflow(attempt.state.requestId, {
      progress: 0.5,
      message: `${remaining} extraction(s) remaining`,
    });
  }
}

async function lifecycleContext<T>(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  message: string,
  kind: LifecycleKind,
  operation: (app: ScholarApplication) => Promise<T>,
): Promise<AgentToolResult<unknown>> {
  cancelled(signal);
  progress(onUpdate, message);
  const app = await applicationFor(ctx);
  const key = workflowKey(app, kind);
  if (workflowStates.has(key)) throw new Error(`${kind} workflow is already running`);
  let state: WorkflowState | undefined;
  let result: T;
  try {
    const started = await app.beginWorkflow(kind);
    const requestId = started.workflow.requestId;
    state =
      kind === "extract"
        ? {
            requestId,
            expectedClaimKeys: new Set<string>(),
            attemptedClaimKeys: new Set<string>(),
            completedClaimKeys: new Set<string>(),
            failed: false,
          }
        : { requestId, remaining: 1 };
    result = await operation(app);
  } catch (error) {
    if (state) {
      workflowStates.set(key, state);
      try {
        await app.finishWorkflow(state.requestId, "failed", workflowError(error));
        workflowStates.delete(key);
      } catch (persistenceError) {
        if (workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
        else workflowStates.set(key, state);
      }
    }
    throw error;
  }

  if (!state) throw new Error("workflow state unavailable");
  const requestId = state.requestId;
  if (kind === "extract") {
    const context = result as ExtractContext;
    const expectedClaimKeys = new Set(
      (Array.isArray(context.claims) ? context.claims : []).map((claim) => extractClaimKey(claim)),
    );
    const extractState: ExtractWorkflowState = {
      requestId,
      expectedClaimKeys,
      attemptedClaimKeys: new Set(),
      completedClaimKeys: new Set(),
      failed: Array.isArray(context.failures) && context.failures.length > 0,
    };
    workflowStates.set(key, extractState);
    try {
      if (expectedClaimKeys.size === 0) {
        await app.finishWorkflow(
          requestId,
          extractState.failed ? "failed" : "succeeded",
          extractState.failed ? extractWorkflowFailure() : { progress: 1, message: "Workflow completed" },
        );
        workflowStates.delete(key);
      } else {
        await app.updateWorkflow(requestId, { progress: 0.25, message: "Context loaded" });
      }
    } catch (persistenceError) {
      if (expectedClaimKeys.size === 0 && workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
      else workflowStates.set(key, extractState);
      throw persistenceError;
    }
  } else {
    const remaining = kind === "daily" && (result as QuizContext).initializationEnabled ? 0 : 1;
    const nextState = { requestId, remaining };
    workflowStates.set(key, nextState);
    try {
      if (remaining === 0) {
        await app.finishWorkflow(requestId, "succeeded", { progress: 1, message: "Workflow completed" });
        workflowStates.delete(key);
      } else {
        await app.updateWorkflow(requestId, { progress: 0.25, message: "Context loaded" });
      }
    } catch (persistenceError) {
      if (remaining === 0 && workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
      else workflowStates.set(key, nextState);
      throw persistenceError;
    }
  }
  progress(onUpdate, "Pi Scholar completed");
  return jsonResult(result);
}

async function lifecycleFinal<T>(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  message: string,
  kind: LifecycleKind,
  operation: (app: ScholarApplication) => Promise<T>,
  claimKey?: string,
): Promise<AgentToolResult<unknown>> {
  cancelled(signal);
  progress(onUpdate, message);
  const app = await applicationFor(ctx);
  const key = workflowKey(app, kind);
  const state = workflowStates.get(key);
  if (!state) throw new Error(`${kind} context is required before the final tool`);

  let result: T;
  try {
    cancelled(signal);
    result = await operation(app);
  } catch (error) {
    if (kind === "ingest" || kind === "lint") {
      try {
        await app.updateWorkflow(state.requestId, {
          progress: 0.5,
          message: "Wiki change rejected; submit another or finish",
        });
      } catch {
        // Preserve the tool error if progress persistence is unavailable.
      }
      workflowStates.set(key, state);
    } else if (kind === "extract") {
      const attempt = recordExtractAttempt(state as ExtractWorkflowState, claimKey, false);
      if (attempt.accepted) {
        workflowStates.set(key, attempt.state);
        try {
          await persistExtractAttempt(app, key, attempt);
        } catch (persistenceError) {
          if (attempt.finished && workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
          else workflowStates.set(key, attempt.state);
        }
      }
    } else {
      workflowStates.set(key, state);
      try {
        await app.finishWorkflow(state.requestId, "failed", workflowError(error));
        workflowStates.delete(key);
      } catch (persistenceError) {
        if (workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
        else workflowStates.set(key, state);
      }
    }
    throw error;
  }

  if (kind === "ingest" || kind === "lint") {
    await app.updateWorkflow(state.requestId, {
      progress: 0.5,
      message: "Wiki change applied; submit another or finish",
    });
    workflowStates.set(key, state);
  } else if (kind === "extract") {
    const attempt = recordExtractAttempt(state as ExtractWorkflowState, claimKey, true);
    if (attempt.accepted) {
      workflowStates.set(key, attempt.state);
      try {
        await persistExtractAttempt(app, key, attempt);
      } catch (persistenceError) {
        if (attempt.finished && workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
        else workflowStates.set(key, attempt.state);
        throw persistenceError;
      }
    }
  } else {
    const remaining = (state as { readonly requestId: string; readonly remaining: number }).remaining - 1;
    if (remaining <= 0) {
      try {
        await app.finishWorkflow(state.requestId, "succeeded", { progress: 1, message: "Workflow completed" });
        workflowStates.delete(key);
      } catch (persistenceError) {
        if (workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
        else workflowStates.set(key, state);
        throw persistenceError;
      }
    } else {
      await app.updateWorkflow(state.requestId, { progress: 0.5, message: `${remaining} extraction(s) remaining` });
      workflowStates.set(key, { requestId: state.requestId, remaining });
    }
  }
  progress(onUpdate, "Pi Scholar completed");
  return jsonResult(result);
}

async function lifecycleFinish<T>(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  message: string,
  kind: LifecycleKind,
  operation: (app: ScholarApplication) => Promise<T>,
): Promise<AgentToolResult<unknown>> {
  cancelled(signal);
  progress(onUpdate, message);
  const app = await applicationFor(ctx);
  const key = workflowKey(app, kind);
  const state = workflowStates.get(key);
  if (!state) throw new Error(`${kind} context is required before finishing`);

  let result: T;
  try {
    cancelled(signal);
    result = await operation(app);
  } catch (error) {
    workflowStates.set(key, state);
    try {
      await app.finishWorkflow(state.requestId, "failed", workflowError(error));
      workflowStates.delete(key);
    } catch (persistenceError) {
      if (workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
      else workflowStates.set(key, state);
    }
    throw error;
  }

  try {
    await app.finishWorkflow(state.requestId, "succeeded", { progress: 1, message: "Workflow completed" });
    workflowStates.delete(key);
  } catch (persistenceError) {
    if (workflowFinalizationApplied(persistenceError)) workflowStates.delete(key);
    else workflowStates.set(key, state);
    throw persistenceError;
  }
  progress(onUpdate, "Pi Scholar completed");
  return jsonResult(result);
}

async function stage(app: ScholarApplication, params: Record<string, unknown>): Promise<unknown> {
  const input = { ...params };
  for (const key of ["path", "filePath", "url", "name", "displayName", "originalName", "mediaType"] as const)
    if (input[key] === "") delete input[key];
  if (typeof input.kind !== "string") {
    if (typeof input.url === "string") input.kind = "url";
    else if (typeof input.text === "string") input.kind = "pasted";
  }
  return app.stageSource(input as unknown as SourceRequest);
}

async function note(app: ScholarApplication, params: Record<string, unknown>): Promise<unknown> {
  const body =
    typeof params.body === "string" ? params.body : typeof params.content === "string" ? params.content : undefined;
  const title = typeof params.title === "string" ? params.title : undefined;
  const quizWorthinessValue = params.quizWorthiness;
  const quizWorthiness =
    quizWorthinessValue === "eligible" || quizWorthinessValue === "skip" || quizWorthinessValue === "unknown"
      ? quizWorthinessValue
      : undefined;
  const path = typeof params.path === "string" ? params.path : undefined;
  if (typeof params.pageId === "string") {
    if (body === undefined && title === undefined && quizWorthiness === undefined && path === undefined)
      throw new Error("an update is required");
    const update: WikiNoteUpdateInput = {
      ...(body === undefined ? {} : { body }),
      ...(title === undefined ? {} : { title }),
      ...(quizWorthiness === undefined ? {} : { quizWorthiness }),
      ...(path === undefined ? {} : { path }),
    };
    return app.updateNote(params.pageId, update);
  }
  if (typeof body !== "string" || !body.trim()) throw new Error("body or content is required");
  const input: WikiNoteInput = { path: path ?? "", title, body, quizWorthiness };
  return app.createNote(input);
}

async function report(app: ScholarApplication, params: Record<string, unknown>): Promise<unknown> {
  return app.reportIssue(params);
}

async function removalPreview(app: ScholarApplication, sourceId: string): Promise<unknown> {
  return app.removalPreview(sourceId);
}

async function remove(app: ScholarApplication, sourceId: string, confirmationId: string): Promise<unknown> {
  return app.removeSource(sourceId, confirmationId);
}

async function handleAddCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const raw = args.trim() || (ctx.hasUI ? await ctx.ui.input("Add source", "URL, path, or pasted text") : undefined);
  if (!raw) return;
  await call(ctx, ctx.signal, undefined, "Staging source", (app) =>
    stage(
      app,
      /^https?:\/\//iu.test(raw) ? { url: raw } : raw.startsWith("text:") ? { text: raw.slice(5) } : { path: raw },
    ),
  );
  ctx.ui.notify("Source staged in inbox", "info");
}

async function handleIssueCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const raw =
    args.trim() ||
    (ctx.hasUI
      ? await ctx.ui.input("Report wiki issue", "kind:description (incorrect, unclear, missing, or bad-boundary)")
      : undefined);
  if (!raw) return;
  const match = /^(incorrect|unclear|missing|bad-boundary)\s*:\s*(.+)$/iu.exec(raw);
  const kind = match?.[1]?.toLowerCase() ?? "unclear";
  const description = match?.[2]?.trim() ?? raw;
  await call(ctx, ctx.signal, undefined, "Recording wiki issue", (app) => report(app, { kind, description }));
  ctx.ui.notify("Wiki issue recorded", "info");
}

async function handleStatusCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const result = await call(ctx, ctx.signal, undefined, "Reading Scholar status", (app) => app.status());
  const text = result.content.find((part) => part.type === "text");
  ctx.ui.notify(text && text.type === "text" ? text.text : "Pi Scholar status loaded", "info");
}

async function handleLintCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const command = pi.getCommands().find((entry) => entry.source === "skill" && entry.name === "skill:lint");
  if (!command) throw new Error("lint skill is unavailable");
  const location = command.sourceInfo.path;
  const baseDir = command.sourceInfo.baseDir ?? dirname(location);
  const body = stripFrontmatter(readFileSync(location, "utf8")).trim();
  const skillBlock = `<skill name="lint" location="${location}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
  const description = args.trim();
  await ctx.waitForIdle();
  pi.sendUserMessage(description ? `${skillBlock}\n\n${description}` : skillBlock);
}

export default function piScholarExtension(pi: ExtensionAPI): void {
  pi.registerCommand("scholar-add", {
    description: "Stage a URL, pasted source, file, directory, or repository",
    handler: handleAddCommand,
  });
  pi.registerCommand("scholar-issue", {
    description: "Report an incorrect, unclear, missing, or badly bounded wiki item",
    handler: handleIssueCommand,
  });
  pi.registerCommand("scholar-status", {
    description: "Show Pi Scholar vault, workflow, learning, doctor, and Git facts",
    handler: handleStatusCommand,
  });
  pi.registerCommand("scholar-lint", {
    description: "Inspect the final wiki and propose guarded repairs",
    handler: async (args, ctx) => handleLintCommand(pi, args, ctx),
  });

  pi.registerTool({
    name: "scholar_add",
    label: "scholar_add",
    description: "Stage a typed source in the Pi Scholar inbox.",
    executionMode: "sequential",
    parameters: sourceInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return call(ctx, _signal, onUpdate, "Staging source", (app) => stage(app, asRecord(params)));
    },
  });
  pi.registerTool({
    name: "scholar_note",
    label: "scholar_note",
    description:
      "Create or update a guarded wiki note. Preserve user prose; model-authored source notes must teach at textbook depth, not merely summarize.",
    executionMode: "sequential",
    parameters: noteInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return call(ctx, _signal, onUpdate, "Writing guarded note", (app) => note(app, asRecord(params)));
    },
  });
  pi.registerTool({
    name: "scholar_remove_source",
    label: "scholar_remove_source",
    executionMode: "sequential",
    description: "Preview source dependents, then remove only after explicit confirmation.",
    parameters: removalInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const input = asRecord(params);
      const sourceId = String(input.sourceId ?? "").trim();
      if (!sourceId) throw new Error("sourceId is required");
      return call(ctx, _signal, onUpdate, "Inspecting source dependencies", async (app) => {
        const preview = await removalPreview(app, sourceId);
        if (input.confirm !== true) return preview;
        const confirmationId = String(input.confirmationId ?? asRecord(preview).confirmationId ?? "");
        if (!confirmationId) throw new Error("A current removal confirmation is required");
        if (!ctx.hasUI) throw new Error("Source removal requires interactive confirmation");
        const accepted = await ctx.ui.confirm(
          "Remove source",
          "This removes current dependent artifacts and does not erase Git history.",
        );
        if (!accepted) return { cancelled: true, preview };
        const current = await removalPreview(app, sourceId);
        if (String(asRecord(current).confirmationId ?? "") !== confirmationId) return { stale: true, preview: current };
        return remove(app, sourceId, confirmationId);
      });
    },
  });
  pi.registerTool({
    name: "scholar_search",
    label: "scholar_search",
    description: "Search trusted wiki content with qmd semantic ranking.",
    parameters: searchInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return call(ctx, _signal, onUpdate, "Searching wiki", (app) =>
        app.searchWiki(params.query, { mode: "semantic", limit: params.limit }),
      );
    },
  });
  pi.registerTool({
    name: "scholar_status",
    label: "scholar_status",
    description: "Read bounded Pi Scholar status facts.",
    parameters: statusInput,
    async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
      return call(ctx, _signal, onUpdate, "Reading Scholar status", (app) => app.status());
    },
  });

  pi.registerTool({
    name: "scholar_get_extract_context",
    label: "scholar_get_extract_context",
    executionMode: "sequential",
    description: "List and claim the current stable extract context.",
    parameters: emptyInput,
    async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
      return lifecycleContext(ctx, _signal, onUpdate, "Loading extract context", "extract", (app) =>
        app.getExtractContext(),
      );
    },
  });
  pi.registerTool({
    name: "scholar_publish_extraction",
    label: "scholar_publish_extraction",
    executionMode: "sequential",
    description: "Publish one claimed source extraction with validated 1-based line endpoints.",
    parameters: extractionInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const input = params as ExtractPublicationInput;
      return lifecycleFinal(
        ctx,
        _signal,
        onUpdate,
        "Publishing extraction",
        "extract",
        (app) => app.publishExtraction(input),
        extractClaimKey(input),
      );
    },
  });
  pi.registerTool({
    name: "scholar_get_ingest_context",
    label: "scholar_get_ingest_context",
    executionMode: "sequential",
    description: "Read the current wiki and only published, verified source packets for ingest.",
    parameters: emptyInput,
    async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
      return lifecycleContext(ctx, _signal, onUpdate, "Loading ingest context", "ingest", (app) =>
        app.getIngestContext(),
      );
    },
  });
  pi.registerTool({
    name: "scholar_apply_ingest",
    label: "scholar_apply_ingest",
    executionMode: "sequential",
    description: "Apply one guarded source-grounded wiki change during ingest.",
    parameters: wikiChangeInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return lifecycleFinal(ctx, _signal, onUpdate, "Applying guarded ingest change", "ingest", (app) =>
        app.applyWikiChange(params as WikiChangeInput),
      );
    },
  });
  pi.registerTool({
    name: "scholar_finish_ingest",
    label: "scholar_finish_ingest",
    executionMode: "sequential",
    description: "Finish an ingest context after submitting all bounded changes, including none.",
    parameters: emptyInput,
    async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
      return lifecycleFinish(ctx, _signal, onUpdate, "Finishing ingest", "ingest", async () => ({
        status: "completed" as const,
      }));
    },
  });
  pi.registerTool({
    name: "scholar_get_lint_context",
    label: "scholar_get_lint_context",
    executionMode: "sequential",
    description: "Read the final wiki for a full or targeted lint scope.",
    parameters: lintContextInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const input = asRecord(params);
      const description = typeof input.description === "string" ? input.description.trim() : "";
      return lifecycleContext(ctx, _signal, onUpdate, "Loading lint context", "lint", (app) =>
        app.getLintContext(description ? { description } : undefined),
      );
    },
  });
  pi.registerTool({
    name: "scholar_apply_lint",
    label: "scholar_apply_lint",
    executionMode: "sequential",
    description: "Apply one guarded wiki change during lint; split and merge use composed operations.",
    parameters: wikiChangeInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return lifecycleFinal(ctx, _signal, onUpdate, "Applying guarded lint change", "lint", (app) =>
        app.applyWikiChange(params as WikiChangeInput),
      );
    },
  });
  pi.registerTool({
    name: "scholar_finish_lint",
    label: "scholar_finish_lint",
    executionMode: "sequential",
    description: "Finish a lint context after submitting all bounded changes, including none.",
    parameters: emptyInput,
    async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
      return lifecycleFinish(ctx, _signal, onUpdate, "Finishing lint", "lint", async () => ({
        status: "completed" as const,
      }));
    },
  });
  pi.registerTool({
    name: "scholar_get_daily_context",
    label: "scholar_get_daily_context",
    executionMode: "sequential",
    description: "Read the current local-date daily quiz context and initialization guard.",
    parameters: contextDateInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return lifecycleContext(ctx, _signal, onUpdate, "Loading daily context", "daily", (app) =>
        app.getQuizContext(params),
      );
    },
  });
  pi.registerTool({
    name: "scholar_get_daily_evidence",
    label: "scholar_get_daily_evidence",
    executionMode: "sequential",
    description: "Read authoritative evidence for a selected, currently eligible daily page subset.",
    parameters: quizEvidenceInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return call(ctx, _signal, onUpdate, "Loading daily evidence", (app) =>
        app.getQuizEvidence(params as QuizEvidenceRequest),
      );
    },
  });
  pi.registerTool({
    name: "scholar_publish_daily",
    label: "scholar_publish_daily",
    executionMode: "sequential",
    description: "Publish one validated daily quiz proposal or explicit skip.",
    parameters: quizInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return lifecycleFinal(ctx, _signal, onUpdate, "Publishing daily quiz", "daily", (app) =>
        app.publishQuiz(params as QuizPublicationInput),
      );
    },
  });
  pi.registerTool({
    name: "scholar_get_grading_context",
    label: "scholar_get_grading_context",
    executionMode: "sequential",
    description: "Read the current sealed quiz revision and submission context.",
    parameters: contextDateInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return call(ctx, _signal, onUpdate, "Loading grading context", (app) =>
        app.getGradingContext(params, gradingClaimOwner),
      );
    },
  });
  pi.registerTool({
    name: "scholar_settle_grade",
    label: "scholar_settle_grade",
    executionMode: "sequential",
    description: "Settle one validated sealed quiz grading result.",
    parameters: gradeInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return call(ctx, _signal, onUpdate, "Settling quiz grade", (app) =>
        app.settleGrade(params as GradeSettlementInput, gradingClaimOwner),
      );
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...appCache.values()].map((app) => app.close?.()));
    appCache.clear();
    workflowStates.clear();
  });
}
