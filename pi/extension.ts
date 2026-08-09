import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  AdmissionContext,
  AdmissionPublicationInput,
  AdmissionPublicationResult,
  GradeSettlementInput,
  GradingContext,
  GradingResult,
  MaintenanceContext,
  MaintenanceInput,
  MaintenanceResult,
  QuizContext,
  QuizDetailRecord,
  QuizPublicationInput,
  SourceRequest,
} from "../src/contracts.js";
type WikiNoteInput = { readonly path: string; readonly title?: string; readonly body: string; readonly pageId?: string; readonly quizWorthiness?: "eligible" | "skip" | "unknown" };
type WikiNoteUpdateInput = { readonly path?: string; readonly title?: string; readonly body?: string; readonly quizWorthiness?: "eligible" | "skip" | "unknown"; readonly expectedDigest?: string };


type LifecycleKind = "source-admission" | "wiki-maintenance" | "daily-quiz";

type WorkflowState = {
  readonly requestId: string;
  readonly remaining: number;
};

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
  readonly searchWiki: (query: string, options?: { readonly mode?: "semantic" | "lexical" | "exact"; readonly limit?: number }) => Promise<unknown>;
  readonly reportIssue: (input: Record<string, unknown>) => Promise<unknown>;
  readonly beginWorkflow: (kind: LifecycleKind) => Promise<{ readonly workflow: { readonly requestId: string } }>;
  readonly updateWorkflow: (requestId: string, input: { readonly progress?: number; readonly message?: string }) => Promise<unknown>;
  readonly finishWorkflow: (requestId: string, status: "succeeded" | "failed", options?: WorkflowFinishOptions) => Promise<unknown>;
  readonly getAdmissionContext: () => Promise<AdmissionContext>;
  readonly admitSource: (input: AdmissionPublicationInput) => Promise<AdmissionPublicationResult>;
  readonly getMaintenanceContext: () => Promise<MaintenanceContext>;
  readonly applyMaintenance: (input: MaintenanceInput) => Promise<MaintenanceResult>;
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
  kind: Type.Optional(Type.Union([Type.Literal("document"), Type.Literal("url"), Type.Literal("text"), Type.Literal("note"), Type.Literal("code"), Type.Literal("directory"), Type.Literal("repository")])),
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
  body: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
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

const admissionInput = Type.Object({
  claimId: Type.String({ minLength: 1 }),
  preparedId: Type.String({ minLength: 1 }),
  digest: Type.String({ minLength: 1 }),
  endpoints: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
});

const maintenanceBindingInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  heading: Type.Optional(Type.String()),
  anchor: Type.String({ minLength: 1 }),
  startOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  endOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  start: Type.Optional(Type.Integer({ minimum: 0 })),
  end: Type.Optional(Type.Integer({ minimum: 0 })),
  textDigest: Type.String({ minLength: 1 }),
  pageDigest: Type.String({ minLength: 1 }),
  pageRevision: Type.Integer({ minimum: 1 }),
  sectionText: Type.String(),
});
const maintenanceBindings = Type.Array(maintenanceBindingInput);
const maintenanceSplitChildInput = Type.Object({
  cardId: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  bindings: maintenanceBindings,
});
const maintenanceIssuePageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  expectedDigest: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  quizWorthiness: Type.Optional(Type.Union([Type.Literal("eligible"), Type.Literal("skip"), Type.Literal("unknown")])),
});
const maintenanceIssueCardInput = Type.Union([
  Type.Object({
    kind: Type.Literal("create-card"),
    cardId: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    initialDueAt: Type.Optional(Type.String()),
    dueAt: Type.Optional(Type.String()),
    bindings: maintenanceBindings,
  }),
  Type.Object({
    kind: Type.Literal("revise-card"),
    cardId: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
    prompt: Type.Optional(Type.String()),
    bindings: maintenanceBindings,
  }),
  Type.Object({
    kind: Type.Literal("retire-card"),
    cardId: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("split-card"),
    cardId: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
    children: Type.Array(maintenanceSplitChildInput),
  }),
  Type.Object({
    kind: Type.Literal("merge-card"),
    parentCardIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    expectedRevisions: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
    cardId: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    bindings: maintenanceBindings,
  }),
]);
const maintenanceInput = Type.Union([
  Type.Object({
    kind: Type.Literal("create-page"),
    path: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String()),
    body: Type.String(),
    quizWorthiness: Type.Optional(Type.Union([Type.Literal("eligible"), Type.Literal("skip"), Type.Literal("unknown")])),
  }),
  Type.Object({
    kind: Type.Literal("update-page"),
    pageId: Type.String({ minLength: 1 }),
    expectedDigest: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    quizWorthiness: Type.Optional(Type.Union([Type.Literal("eligible"), Type.Literal("skip"), Type.Literal("unknown")])),
  }),
  Type.Object({
    kind: Type.Literal("rename-page"),
    pageId: Type.String({ minLength: 1 }),
    expectedDigest: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("create-card"),
    cardId: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    initialDueAt: Type.Optional(Type.String()),
    dueAt: Type.Optional(Type.String()),
    bindings: maintenanceBindings,
  }),
  Type.Object({
    kind: Type.Literal("revise-card"),
    cardId: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
    prompt: Type.Optional(Type.String()),
    bindings: maintenanceBindings,
  }),
  Type.Object({
    kind: Type.Literal("retire-card"),
    cardId: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("split-card"),
    cardId: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
    children: Type.Array(maintenanceSplitChildInput),
  }),
  Type.Object({
    kind: Type.Literal("merge-card"),
    parentCardIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    expectedRevisions: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
    cardId: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    bindings: maintenanceBindings,
  }),
  Type.Object({
    kind: Type.Literal("prerequisites"),
    cardId: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
    prerequisiteCardIds: Type.Array(Type.String({ minLength: 1 })),
  }),
  Type.Object({
    kind: Type.Literal("resolve-issue"),
    issueId: Type.String({ minLength: 1 }),
    page: maintenanceIssuePageInput,
    card: maintenanceIssueCardInput,
    resolution: Type.String({ minLength: 1 }),
  }),
]);

const quizQuestionProposal = Type.Object({
  questionId: Type.Optional(Type.String()),
  kind: Type.Union([Type.Literal("short-answer"), Type.Literal("multiple-choice")]),
  prompt: Type.String({ minLength: 1 }),
  choices: Type.Optional(Type.Array(Type.String())),
  cardIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  cards: Type.Array(Type.Object({
    cardId: Type.String({ minLength: 1 }),
    criterion: Type.String({ minLength: 1 }),
    weight: Type.Number({ exclusiveMinimum: 0 }),
  }), { minItems: 1 }),
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
const contextDateInput = Type.Object({ date: Type.Optional(Type.String({ minLength: 1 })) });
const gradeReadingInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  anchor: Type.String({ minLength: 1 }),
  heading: Type.Optional(Type.String()),
});
const gradeCardInput = Type.Object({
  cardId: Type.String({ minLength: 1 }),
  rating: Type.Union([Type.Literal("Again"), Type.Literal("Hard"), Type.Literal("Good"), Type.Literal("Easy")]),
  feedback: Type.Optional(Type.String()),
  evidence: Type.Array(Type.String()),
  readings: Type.Optional(Type.Array(gradeReadingInput)),
});
const gradeQuestionInput = Type.Object({
  questionId: Type.String({ minLength: 1 }),
  feedback: Type.Optional(Type.String()),
  cards: Type.Array(gradeCardInput, { minItems: 1 }),
  readings: Type.Optional(Type.Array(gradeReadingInput)),
});
const gradeInput = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  date: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  submissionId: Type.String({ minLength: 1 }),
  questions: Type.Array(gradeQuestionInput),
});

const appCache = new Map<string, ScholarApplication>();
const gradingClaimOwner = randomUUID();

async function loadRuntimeModule(): Promise<RuntimeModule> {
  const application = await import("../dist/application.js") as unknown as Pick<RuntimeModule, "createApplication">;
  const vault = await import("../dist/vault.js") as unknown as Pick<RuntimeModule, "resolveVault">;
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
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null) ?? String(value);
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
    errorCode: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "PI_WORKFLOW_FAILED",
    errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}

function contextRemaining(kind: LifecycleKind, result: unknown): number {
  if (kind === "daily-quiz" && (result as QuizContext).initializationEnabled) return 0;
  if (kind !== "source-admission") return 1;
  const claims = (result as AdmissionContext).claims;
  return Array.isArray(claims) ? claims.length : 0;
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
  try {
    const started = await app.beginWorkflow(kind);
    state = { requestId: started.workflow.requestId, remaining: 1 };
    const result = await operation(app);
    const remaining = contextRemaining(kind, result);
    if (remaining === 0) {
      await app.finishWorkflow(state.requestId, "succeeded", { progress: 1, message: "Workflow completed" });
      workflowStates.delete(key);
    } else {
      await app.updateWorkflow(state.requestId, { progress: 0.25, message: "Context loaded" });
      workflowStates.set(key, { requestId: state.requestId, remaining });
    }
    progress(onUpdate, "Pi Scholar completed");
    return jsonResult(result);
  } catch (error) {
    if (state) {
      workflowStates.delete(key);
      try {
        await app.finishWorkflow(state.requestId, "failed", workflowError(error));
      } catch {
        // Preserve the tool error if lifecycle persistence is unavailable.
      }
    }
    throw error;
  }
}

async function lifecycleFinal<T>(
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
  if (!state) throw new Error(`${kind} context is required before the final tool`);
  try {
    cancelled(signal);
    const result = await operation(app);
    if (kind === "wiki-maintenance") {
      await app.updateWorkflow(state.requestId, { progress: 0.5, message: "Maintenance proposal applied; submit another or finish" });
      workflowStates.set(key, state);
    } else {
      const remaining = state.remaining - 1;
      if (remaining <= 0) {
        await app.finishWorkflow(state.requestId, "succeeded", { progress: 1, message: "Workflow completed" });
        workflowStates.delete(key);
      } else {
        await app.updateWorkflow(state.requestId, { progress: 0.5, message: `${remaining} admission(s) remaining` });
        workflowStates.set(key, { requestId: state.requestId, remaining });
      }
    }
    progress(onUpdate, "Pi Scholar completed");
    return jsonResult(result);
  } catch (error) {
    if (kind === "wiki-maintenance") {
      try {
        await app.updateWorkflow(state.requestId, { progress: 0.5, message: "Maintenance proposal rejected; submit another or finish" });
      } catch {
        // Preserve the tool error if progress persistence is unavailable.
      }
      workflowStates.set(key, state);
    } else if (kind === "source-admission") {
      const remaining = state.remaining - 1;
      if (remaining > 0) {
        try { await app.updateWorkflow(state.requestId, { progress: 0.5, message: `${remaining} admission(s) remaining` }); } catch { /* Preserve the source failure if progress persistence is unavailable. */ }
        workflowStates.set(key, { requestId: state.requestId, remaining });
      } else {
        workflowStates.delete(key);
        try { await app.finishWorkflow(state.requestId, "failed", workflowError(error)); } catch { /* Preserve the tool error if lifecycle persistence is unavailable. */ }
      }
    } else {
      workflowStates.delete(key);
      try {
        await app.finishWorkflow(state.requestId, "failed", workflowError(error));
      } catch {
        // Preserve the tool error if lifecycle persistence is unavailable.
      }
    }
    throw error;
  }
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
  try {
    cancelled(signal);
    const result = await operation(app);
    await app.finishWorkflow(state.requestId, "succeeded", { progress: 1, message: "Workflow completed" });
    workflowStates.delete(key);
    progress(onUpdate, "Pi Scholar completed");
    return jsonResult(result);
  } catch (error) {
    workflowStates.delete(key);
    try {
      await app.finishWorkflow(state.requestId, "failed", workflowError(error));
    } catch {
      // Preserve the tool error if lifecycle persistence is unavailable.
    }
    throw error;
  }
}

async function stage(app: ScholarApplication, params: Record<string, unknown>): Promise<unknown> {
  const input = { ...params };
  if (typeof input.kind !== "string") {
    if (typeof input.url === "string") input.kind = "url";
    else if (typeof input.text === "string") input.kind = "pasted";
  }
  return app.stageSource(input as unknown as SourceRequest);
}

async function note(app: ScholarApplication, params: Record<string, unknown>): Promise<unknown> {
  const body = typeof params.body === "string" ? params.body : typeof params.content === "string" ? params.content : undefined;
  const title = typeof params.title === "string" ? params.title : undefined;
  const quizWorthinessValue = params.quizWorthiness;
  const quizWorthiness = quizWorthinessValue === "eligible" || quizWorthinessValue === "skip" || quizWorthinessValue === "unknown" ? quizWorthinessValue : undefined;
  const path = typeof params.path === "string" ? params.path : undefined;
  if (typeof params.pageId === "string") {
    if (body === undefined && title === undefined && quizWorthiness === undefined && path === undefined) throw new Error("an update is required");
    const update: WikiNoteUpdateInput = { ...(body === undefined ? {} : { body }), ...(title === undefined ? {} : { title }), ...(quizWorthiness === undefined ? {} : { quizWorthiness }), ...(path === undefined ? {} : { path }) };
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
  await call(ctx, ctx.signal, undefined, "Staging source", (app) => stage(app, /^https?:\/\//iu.test(raw) ? { url: raw } : raw.startsWith("text:") ? { text: raw.slice(5) } : { path: raw }));
  ctx.ui.notify("Source staged in inbox", "info");
}

async function handleIssueCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const raw = args.trim() || (ctx.hasUI ? await ctx.ui.input("Report wiki issue", "kind:description (incorrect, unclear, missing, or bad-boundary)") : undefined);
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

export default function piScholarExtension(pi: ExtensionAPI): void {
  pi.registerCommand("add", {
    description: "Stage a URL, pasted source, file, directory, or repository",
    handler: handleAddCommand,
  });
  pi.registerCommand("issue", {
    description: "Report an incorrect, unclear, missing, or badly bounded wiki item",
    handler: handleIssueCommand,
  });
  pi.registerCommand("scholar-status", {
    description: "Show Pi Scholar vault, workflow, learning, doctor, and Git facts",
    handler: handleStatusCommand,
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
    description: "Create a guarded product-authored wiki note.",
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
        const accepted = await ctx.ui.confirm("Remove source", "This removes current dependent artifacts and does not erase Git history.");
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
      return call(ctx, _signal, onUpdate, "Searching wiki", (app) => app.searchWiki(params.query, { mode: "semantic", limit: params.limit }));
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
    name: "scholar_get_admission_context",
    label: "scholar_get_admission_context",
    executionMode: "sequential",
    description: "List and claim the current stable source-admission context.",
    parameters: emptyInput,
    async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
      return lifecycleContext(ctx, _signal, onUpdate, "Loading admission context", "source-admission", (app) => app.getAdmissionContext());
    },
  });
  pi.registerTool({
    name: "scholar_admit_source",
    label: "scholar_admit_source",
    executionMode: "sequential",
    description: "Publish one claimed source packet with validated chunk endpoints.",
    parameters: admissionInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return lifecycleFinal(ctx, _signal, onUpdate, "Publishing source admission", "source-admission", (app) => app.admitSource(params as AdmissionPublicationInput));
    },
  });
  pi.registerTool({
    name: "scholar_get_maintenance_context",
    label: "scholar_get_maintenance_context",
    executionMode: "sequential",
    description: "Read the current bounded wiki-maintenance context.",
    parameters: emptyInput,
    async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
      return lifecycleContext(ctx, _signal, onUpdate, "Loading maintenance context", "wiki-maintenance", (app) => app.getMaintenanceContext());
    },
  });

  pi.registerTool({
    name: "scholar_apply_maintenance",
    label: "scholar_apply_maintenance",
    executionMode: "sequential",
    description: "Apply one guarded wiki/card maintenance proposal.",
    parameters: maintenanceInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return lifecycleFinal(ctx, _signal, onUpdate, "Applying guarded maintenance", "wiki-maintenance", (app) => app.applyMaintenance(params as MaintenanceInput));
    },
  });
  pi.registerTool({
    name: "scholar_finish_maintenance",
    label: "scholar_finish_maintenance",
    executionMode: "sequential",
    description: "Finish a wiki-maintenance context after submitting all bounded proposals, including none.",
    parameters: emptyInput,
    async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
      return lifecycleFinish(ctx, _signal, onUpdate, "Finishing wiki maintenance", "wiki-maintenance", async () => ({ status: "completed" as const }));
    },
  });
  pi.registerTool({
    name: "scholar_get_quiz_context",
    label: "scholar_get_quiz_context",
    executionMode: "sequential",
    description: "Read the current local-date quiz context and initialization guard.",
    parameters: contextDateInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return lifecycleContext(ctx, _signal, onUpdate, "Loading quiz context", "daily-quiz", (app) => app.getQuizContext(params));
    },
  });
  pi.registerTool({
    name: "scholar_publish_quiz",
    label: "scholar_publish_quiz",
    description: "Publish one validated daily quiz proposal or explicit skip.",
    executionMode: "sequential",
    parameters: quizInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return lifecycleFinal(ctx, _signal, onUpdate, "Publishing daily quiz", "daily-quiz", (app) => app.publishQuiz(params as QuizPublicationInput));
    },
  });
  pi.registerTool({
    name: "scholar_get_grading_context",
    label: "scholar_get_grading_context",
    executionMode: "sequential",
    description: "Read the current sealed quiz revision and submission context.",
    parameters: contextDateInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return call(ctx, _signal, onUpdate, "Loading grading context", (app) => app.getGradingContext(params, gradingClaimOwner));
    },
  });
  pi.registerTool({
    name: "scholar_settle_grade",
    label: "scholar_settle_grade",
    executionMode: "sequential",
    description: "Settle one validated sealed quiz grading result.",
    parameters: gradeInput,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return call(ctx, _signal, onUpdate, "Settling quiz grade", (app) => app.settleGrade(params as GradeSettlementInput, gradingClaimOwner));
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...appCache.values()].map((app) => app.close?.()));
    appCache.clear();
    workflowStates.clear();
  });
}
