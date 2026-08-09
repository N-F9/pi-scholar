import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import type {
  AdmissionContext,
  AdmissionFailureRecord,
  AdmissionPublicationInput,
  AdmissionPublicationResult,
  ApiEnvelope,
  DoctorReport,
  GradeSettlementInput,
  GradingContext,
  GradingResult,
  HealthResult,
  MaintenanceContext,
  MaintenanceInput,
  MaintenanceIssuePageInput,
  MaintenanceResult,
  PageLearningRecord,
  PageRecord,
  PreparedAdmission,
  PublicQuizDetailRecord,
  PublicQuizRecord,
  PublicSourceRecord,
  QuizAnswerInput,
  QuizContext,
  QuizDetailRecord,
  QuizEvidenceRecord,
  QuizGradeRecord,
  QuizPageResultRecord,
  QuizPublicationInput,
  QuizQuestionProposal,
  QuizQuestionResultRecord,
  QuizReadingRecord,
  QuizRecord,
  ReviewRating,
  SettingsFacts,
  SettingsRecord,
  SettingsUpdateRequest,
  SourceManifest,
  SourceRecord,
  SourceRemovalResult,
  SourceRequest,
  WikiDriftResolutionRequest,
  WikiIssueCreateRequest,
  WikiIssueRecord,
  WikiIssueUpdateRequest,
  WikiPageLearningProjection,
  WikiPageResult,
  WorkflowRecord,
} from "./contracts.js";
import { openDatabase, type ScholarDatabase, transaction } from "./database.js";
import { doctor as runDoctor } from "./doctor.js";
import { convertWithDocling } from "./external/docling.js";
import { type GitCheckpointResult, type GitPushResult, localCheckpointCommit, safePush } from "./external/git.js";
import { qmdSearch, runQmd } from "./external/qmd.js";
import { evidenceReference, QuizConflictError, QuizService, type ReadingLink } from "./quiz.js";
import { localDate, RevisionConflictError, SchedulerService, ValidationError } from "./scheduler.js";
import {
  type SourceStageRequest as MechanicsSourceStageRequest,
  type SourceAdapters,
  type SourceClaim,
  SourceService,
} from "./sources.js";
import { readFileNoFollow, resolveVault, safeRelativePath, type VaultPaths, withWriterLock } from "./vault.js";
import { parseWikiMarkdown, type WikiAdapters, type WikiPage, WikiService } from "./wiki.js";
import { parseWikiSections } from "./wiki-sections.js";
import {
  BrowserMutationWorker,
  WorkflowCoordinator,
  type WorkflowFinishOptions,
  type WorkflowKind,
  type WorkflowUpdateInput,
} from "./workflows.js";

export interface ApplicationMutationContext {
  readonly origin?: "browser" | "pi" | "cli" | "internal";
}
export interface ApplicationAdapters {
  readonly sources?: SourceAdapters;
  readonly wiki?: WikiAdapters;
}
export interface ApplicationOptions {
  readonly paths: VaultPaths | string;
  readonly db?: ScholarDatabase;
  readonly sourceService?: SourceService;
  readonly wikiService?: WikiService;
  readonly schedulerService?: SchedulerService;
  readonly quizService?: QuizService;
  readonly adapters?: ApplicationAdapters;
  readonly worker?: BrowserMutationWorker;
  readonly doctor?: (explicitPath?: string) => DoctorReport;
  readonly commit?: (paths: VaultPaths, subject: string) => GitCheckpointResult;
  readonly push?: (paths: VaultPaths) => GitPushResult;
  readonly version?: string;
}
export interface ApplicationStatus extends HealthResult {
  readonly settings: SettingsRecord;
  readonly workflows: readonly WorkflowRecord[];
}
export interface SourceStageResult {
  readonly source: PublicSourceRecord;
}
export interface WikiSearchResult {
  readonly pages: readonly PageRecord[];
}
export interface WikiIssueListResult {
  readonly issues: readonly WikiIssueRecord[];
}
export interface WikiNoteInput {
  readonly path: string;
  readonly title?: string;
  readonly body: string;
  readonly pageId?: string;
  readonly quizWorthiness?: "eligible" | "skip" | "unknown";
}
export interface WikiNoteUpdateInput {
  readonly body?: string;
  readonly title?: string;
  readonly quizWorthiness?: "eligible" | "skip" | "unknown";
  readonly expectedDigest?: string;
  readonly path?: string;
}
type DurableRollback<T> = {
  readonly capture: () => T | PromiseLike<T>;
  readonly restore: (snapshot: T) => void | PromiseLike<void>;
  readonly dispose?: (snapshot: T) => void | PromiseLike<void>;
};
const MAINTENANCE_ROLLBACK_TABLES = [
  { name: "pages", keys: ["page_id"] },
  { name: "page_learning", keys: ["page_id"] },
  { name: "page_prerequisites", keys: ["page_id", "prerequisite_page_id"] },
  { name: "authored_snapshots", keys: ["relative_path"] },
  { name: "wiki_issues", keys: ["issue_id"] },
] as const;
interface MaintenanceRollbackFile {
  readonly destination: string;
  readonly backup: string;
  readonly exists: boolean;
}
interface MaintenanceRollbackSnapshot {
  readonly workRoot: string;
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly files: readonly MaintenanceRollbackFile[];
  readonly snapshotRoot: string;
  readonly snapshotEntries: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function admissionResultKey(input: Pick<AdmissionPublicationInput, "claimId" | "preparedId" | "digest">): string {
  return `${input.claimId}\u0000${input.preparedId}\u0000${input.digest}`;
}
function boundedUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}
interface ReplayReading {
  readonly pageId: string;
  readonly anchor: string;
  readonly heading?: string;
}
interface ReplayPage {
  readonly pageId: string;
  readonly rating: ReviewRating | string;
  readonly feedback?: string;
  readonly evidence?: readonly string[];
  readonly readings?: readonly ReplayReading[];
}
interface ReplayQuestion {
  readonly questionId: string;
  readonly feedback?: string;
}
function replayReadings(values: readonly ReplayReading[]): ReplayReading[] {
  const seen = new Set<string>();
  return [...values]
    .filter((reading) => {
      const key = `${reading.pageId}#${reading.anchor}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => `${left.pageId}#${left.anchor}`.localeCompare(`${right.pageId}#${right.anchor}`));
}
function gradingReplayKey(questions: readonly ReplayQuestion[], pages: readonly ReplayPage[]): string {
  return JSON.stringify({
    questions: questions
      .map((question) => ({
        questionId: question.questionId,
        feedback: (question.feedback ?? "").trim(),
      }))
      .sort((left, right) => left.questionId.localeCompare(right.questionId)),
    pages: pages
      .map((page) => ({
        pageId: page.pageId,
        rating: page.rating,
        feedback: (page.feedback ?? "").trim(),
        evidence: (page.evidence ?? [])
          .map((item) => item.trim())
          .filter(Boolean)
          .sort(),
        readings: replayReadings(page.readings ?? []),
      }))
      .sort((left, right) => left.pageId.localeCompare(right.pageId)),
  });
}
function mutationFinalizationError(stage: "checkpoint" | "doctor" | "commit" | "rollback", cause: unknown): Error {
  return Object.assign(new Error(`mutation applied but ${stage} failed: ${errorMessage(cause)}`), {
    code: "MUTATION_APPLIED_FINALIZATION_FAILED",
    details: { applied: true, retryable: false, stage },
  });
}
function isAppliedFinalizationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; details?: unknown };
  return (
    candidate.code === "MUTATION_APPLIED_FINALIZATION_FAILED" &&
    isRecord(candidate.details) &&
    candidate.details.applied === true
  );
}
function sourceRecord(value: Record<string, unknown>): SourceRecord {
  return {
    sourceId: String(value.sourceId ?? value.source_id),
    kind: String(value.kind) as SourceRecord["kind"],
    status: String(value.status) as SourceRecord["status"],
    displayName: String(value.displayName ?? value.display_name),
    ...((value.originalName ?? value.original_name)
      ? { originalName: String(value.originalName ?? value.original_name) }
      : {}),
    ...((value.sourceUri ?? value.source_uri) ? { sourceUri: String(value.sourceUri ?? value.source_uri) } : {}),
    ...((value.mediaType ?? value.media_type) ? { mediaType: String(value.mediaType ?? value.media_type) } : {}),
    ...((value.repositoryRevision ?? value.repository_revision)
      ? { repositoryRevision: String(value.repositoryRevision ?? value.repository_revision) }
      : {}),
    ...((value.capturedAt ?? value.captured_at) ? { capturedAt: String(value.capturedAt ?? value.captured_at) } : {}),
    ...(value.digest ? { digest: String(value.digest) } : {}),
    ...((value.manifestPath ?? value.manifest_path)
      ? { manifestPath: String(value.manifestPath ?? value.manifest_path) }
      : {}),
    ...((value.errorCode ?? value.error_code) ? { errorCode: String(value.errorCode ?? value.error_code) } : {}),
    ...((value.errorMessage ?? value.error_message)
      ? { errorMessage: String(value.errorMessage ?? value.error_message) }
      : {}),
    createdAt: String(value.createdAt ?? value.created_at),
    updatedAt: String(value.updatedAt ?? value.updated_at),
  };
}
function publicSource(source: SourceRecord): PublicSourceRecord {
  const { manifestPath: _manifestPath, ...record } = source;
  return record;
}
type PublicWorkflowRecord = Omit<WorkflowRecord, "message"> & { readonly message?: string };
function publicWorkflow(workflow: WorkflowRecord): PublicWorkflowRecord {
  if (workflow.kind !== "quiz-grader") return workflow;
  const { message: _message, ...record } = workflow;
  return record;
}
function pageRecord(value: WikiPage): PageRecord {
  return {
    pageId: value.pageId,
    relativePath: value.relativePath,
    title: value.title,
    digest: value.digest,
    revision: value.revision,
    status: value.status,
    quizWorthiness: value.quizWorthiness,
    updatedAt: value.updatedAt,
  };
}
function defaultSourceAdapters(paths: VaultPaths, overrides?: SourceAdapters): SourceAdapters {
  const docling =
    overrides?.docling ??
    (async ({ originalPath }: { readonly originalPath: string }) => {
      const inputRelativePath = relative(paths.workRoot, originalPath).replaceAll("\\", "/");
      const originalMarker = "/original/";
      const marker = inputRelativePath.indexOf(originalMarker);
      if (marker <= 0) throw new ValidationError("Docling input is outside prepared admission work");
      const preparedRelativeRoot = inputRelativePath.slice(0, marker);
      return convertWithDocling(paths, {
        inputRelativePath,
        outputRelativeDirectory: join(preparedRelativeRoot, "docling-output"),
      });
    });
  return { ...overrides, docling };
}
function defaultWikiAdapters(paths: VaultPaths, overrides?: WikiAdapters): WikiAdapters {
  const qmd = overrides?.qmd ?? {
    search: async (
      query: string,
      options?: { readonly collection?: string; readonly scope?: "wiki/**/*.md"; readonly limit?: number },
    ) => {
      const result = await qmdSearch(paths, query, options?.limit);
      if (result.timedOut || result.signal || result.code !== 0)
        throw new Error(
          `qmd search failed: ${(result.stderr.trim() || result.stdout.trim() || result.signal || "unknown error").slice(0, 500)}`,
        );
      const text = result.stdout.trim();
      if (!text) throw new Error("qmd search returned malformed JSON");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("qmd search returned malformed JSON");
      }
      if (Array.isArray(parsed)) return parsed;
      if (isRecord(parsed) && Array.isArray(parsed.results)) return parsed.results;
      throw new Error("qmd search returned malformed results");
    },
    index: async () => {
      const result = await runQmd(paths, ["update"]);
      if (result.timedOut || result.signal || result.code !== 0)
        throw new Error(
          `qmd update failed: ${(result.stderr.trim() || result.stdout.trim() || result.signal || "unknown error").slice(0, 500)}`,
        );
    },
  };
  return { ...overrides, qmd };
}
const QUIZ_GRADER_BINDING_PREFIX = "quiz-grader:";
const QUIZ_GRADER_BINDING_VERSION_PREFIX = `${QUIZ_GRADER_BINDING_PREFIX}v1:`;
// ponytail: fixed 15-minute lease; add heartbeats only when grader runtime needs longer work.
const QUIZ_GRADER_LEASE_MS = 15 * 60 * 1000;
type QuizGraderBinding = { readonly quizId: string; readonly ownerHash: string };
type QuizGraderPayload = { readonly date: string; readonly revision: number; readonly submissionId: string };
function gradingSubmissionId(quiz: Pick<QuizRecord, "quizId" | "revision">): string {
  return `${quiz.quizId}:r${quiz.revision}`;
}
function quizGraderPayload(quiz: Pick<QuizRecord, "date" | "quizId" | "revision">): QuizGraderPayload {
  return { date: quiz.date, revision: quiz.revision, submissionId: gradingSubmissionId(quiz) };
}
function quizGraderPayloadText(quiz: Pick<QuizRecord, "date" | "quizId" | "revision">): string {
  return JSON.stringify(quizGraderPayload(quiz));
}
function parseQuizGraderPayload(value: unknown): QuizGraderPayload | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 3 ||
    !Object.keys(parsed).every((key) => ["date", "revision", "submissionId"].includes(key))
  )
    return undefined;
  const date = parsed.date;
  const revision = parsed.revision;
  const submissionId = parsed.submissionId;
  return typeof date === "string" &&
    typeof revision === "number" &&
    Number.isInteger(revision) &&
    revision > 0 &&
    typeof submissionId === "string" &&
    submissionId
    ? { date, revision, submissionId }
    : undefined;
}
function quizGraderBindingText(quizId: string, ownerHash: string): string {
  return `${QUIZ_GRADER_BINDING_VERSION_PREFIX}${JSON.stringify({ quizId, ownerHash })}`;
}
function parseQuizGraderBinding(value: unknown): QuizGraderBinding | undefined {
  if (typeof value !== "string" || !value.startsWith(QUIZ_GRADER_BINDING_VERSION_PREFIX)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(QUIZ_GRADER_BINDING_VERSION_PREFIX.length));
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !Object.keys(parsed).every((key) => ["quizId", "ownerHash"].includes(key))
  )
    return undefined;
  return typeof parsed.quizId === "string" &&
    parsed.quizId &&
    typeof parsed.ownerHash === "string" &&
    /^[0-9a-f]{64}$/u.test(parsed.ownerHash)
    ? { quizId: parsed.quizId, ownerHash: parsed.ownerHash }
    : undefined;
}
function recordToIssue(row: Record<string, unknown>): WikiIssueRecord {
  return {
    issueId: String(row.issue_id),
    ...(row.page_id ? { pageId: String(row.page_id) } : {}),
    ...(row.heading ? { heading: String(row.heading) } : {}),
    ...(row.page_digest ? { pageDigest: String(row.page_digest) } : {}),
    kind: String(row.kind) as WikiIssueRecord["kind"],
    description: String(row.description),
    status: String(row.status) as WikiIssueRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.resolution ? { resolution: String(row.resolution) } : {}),
  };
}
function answersObject(answers: readonly QuizAnswerInput[]): Record<string, string | readonly string[]> {
  const result: Record<string, string | readonly string[]> = {};
  for (const answer of answers) result[answer.questionId] = answer.answer;
  return result;
}
function quizOutcome(
  quiz: QuizRecord | undefined,
): "available" | "submitted" | "expired" | "skipped" | "failed" | "not-yet-run" | "maintenance-day" {
  if (!quiz) return "not-yet-run";
  return quiz.status === "open" ? "available" : quiz.status;
}
function publicQuiz(quiz: QuizRecord): PublicQuizRecord {
  const { sheetPath: _sheetPath, ...withoutSheetPath } = quiz;
  return {
    ...withoutSheetPath,
    questions: quiz.questions.map(
      ({ pages: _pages, sourceRefs: _sourceRefs, ...question }) =>
        Object.fromEntries(
          Object.entries(question).filter(([key]) => key !== "answerKey" && key !== "criterion" && key !== "weight"),
        ) as unknown as PublicQuizRecord["questions"][number],
    ),
  };
}
function publicQuizDetail(quiz: QuizDetailRecord): PublicQuizDetailRecord {
  return {
    ...publicQuiz(quiz),
    answers: quiz.answers,
    questionResults: quiz.questionResults,
    pageResults: quiz.pageResults,
    grades: quiz.grades,
    readings: quiz.readings,
  };
}
function asAnswers(value: unknown): QuizAnswerInput[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((item): QuizAnswerInput[] => {
    if (!isRecord(item) || typeof item.questionId !== "string") return [];
    const answer = item.answer;
    if (typeof answer === "string") return [{ questionId: item.questionId, answer }];
    if (Array.isArray(answer) && answer.every((part) => typeof part === "string"))
      return [{ questionId: item.questionId, answer: [...answer] }];
    return [];
  });
}
function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ValidationError(`${label} has unsupported fields`);
}
function requiredString(value: Record<string, unknown>, key: string, label = key): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) throw new ValidationError(`${label} must be a nonempty string`);
  return result;
}
function optionalString(value: Record<string, unknown>, key: string, label = key): string | undefined {
  if (value[key] === undefined) return undefined;
  return requiredString(value, key, label);
}
function requiredInteger(value: Record<string, unknown>, key: string, label = key): number {
  const result = value[key];
  if (!Number.isInteger(result)) throw new ValidationError(`${label} must be an integer`);
  return result as number;
}
function decodeMaintenancePage(value: unknown): MaintenanceIssuePageInput {
  if (!isRecord(value)) throw new ValidationError("resolve-issue page must be an object");
  exact(value, ["pageId", "expectedDigest", "title", "body", "quizWorthiness"], "resolve-issue page");
  const quizWorthiness = value.quizWorthiness === undefined ? undefined : requiredString(value, "quizWorthiness");
  if (quizWorthiness !== undefined && !["eligible", "skip", "unknown"].includes(quizWorthiness))
    throw new ValidationError("quizWorthiness is invalid");
  return {
    pageId: requiredString(value, "pageId"),
    expectedDigest: requiredString(value, "expectedDigest"),
    ...(value.title === undefined ? {} : { title: requiredString(value, "title") }),
    ...(value.body === undefined
      ? {}
      : {
          body:
            typeof value.body === "string"
              ? value.body
              : (() => {
                  throw new ValidationError("body must be a string");
                })(),
        }),
    ...(quizWorthiness === undefined ? {} : { quizWorthiness: quizWorthiness as "eligible" | "skip" | "unknown" }),
  };
}
function optionalInteger(value: Record<string, unknown>, key: string, label = key): number | undefined {
  if (value[key] === undefined) return undefined;
  return requiredInteger(value, key, label);
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    throw new ValidationError(`${label} must be an array of nonempty strings`);
  return value.map((item) => String(item));
}
function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item)))
    throw new ValidationError(`${label} must be an array of objects`);
  return value as Record<string, unknown>[];
}
function decodeAdmissionInput(value: unknown): AdmissionPublicationInput {
  if (!isRecord(value)) throw new ValidationError("admission publication must be an object");
  exact(value, ["claimId", "preparedId", "digest", "endpoints"], "admission publication");
  const endpoints =
    value.endpoints === undefined
      ? undefined
      : Array.isArray(value.endpoints) && value.endpoints.every((item) => Number.isInteger(item) && Number(item) >= 0)
        ? value.endpoints.map((item) => Number(item))
        : (() => {
            throw new ValidationError("endpoints must be an array of nonnegative integers");
          })();
  return {
    claimId: requiredString(value, "claimId"),
    preparedId: requiredString(value, "preparedId"),
    digest: requiredString(value, "digest"),
    ...(endpoints ? { endpoints } : {}),
  };
}
function decodeMaintenanceInput(value: unknown): MaintenanceInput {
  if (!isRecord(value)) throw new ValidationError("maintenance proposal must be an object");
  const kind = requiredString(value, "kind") as MaintenanceInput["kind"];
  switch (kind) {
    case "create-page": {
      exact(value, ["kind", "path", "title", "body", "quizWorthiness"], "create-page");
      const quizWorthiness = value.quizWorthiness === undefined ? undefined : requiredString(value, "quizWorthiness");
      if (quizWorthiness !== undefined && !["eligible", "skip", "unknown"].includes(quizWorthiness))
        throw new ValidationError("quizWorthiness is invalid");
      return {
        kind,
        path: requiredString(value, "path"),
        ...(value.title === undefined ? {} : { title: requiredString(value, "title") }),
        body:
          typeof value.body === "string"
            ? value.body
            : (() => {
                throw new ValidationError("body must be a string");
              })(),
        ...(quizWorthiness === undefined ? {} : { quizWorthiness: quizWorthiness as "eligible" | "skip" | "unknown" }),
      };
    }
    case "update-page": {
      exact(value, ["kind", "pageId", "expectedDigest", "title", "body", "quizWorthiness"], "update-page");
      const quizWorthiness = value.quizWorthiness === undefined ? undefined : requiredString(value, "quizWorthiness");
      if (quizWorthiness !== undefined && !["eligible", "skip", "unknown"].includes(quizWorthiness))
        throw new ValidationError("quizWorthiness is invalid");
      return {
        kind,
        pageId: requiredString(value, "pageId"),
        expectedDigest: requiredString(value, "expectedDigest"),
        ...(value.title === undefined ? {} : { title: requiredString(value, "title") }),
        ...(value.body === undefined
          ? {}
          : {
              body:
                typeof value.body === "string"
                  ? value.body
                  : (() => {
                      throw new ValidationError("body must be a string");
                    })(),
            }),
        ...(quizWorthiness === undefined ? {} : { quizWorthiness: quizWorthiness as "eligible" | "skip" | "unknown" }),
      };
    }
    case "rename-page":
      exact(value, ["kind", "pageId", "expectedDigest", "path"], "rename-page");
      return {
        kind,
        pageId: requiredString(value, "pageId"),
        expectedDigest: requiredString(value, "expectedDigest"),
        path: requiredString(value, "path"),
      };
    case "prerequisites": {
      exact(value, ["kind", "pageId", "expectedRevision", "prerequisitePageIds"], "prerequisites");
      const expectedRevision = optionalInteger(value, "expectedRevision");
      return {
        kind,
        pageId: requiredString(value, "pageId"),
        prerequisitePageIds: stringArray(value.prerequisitePageIds, "prerequisitePageIds"),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      };
    }
    case "resolve-issue":
      exact(value, ["kind", "issueId", "page", "resolution"], "resolve-issue");
      return {
        kind,
        issueId: requiredString(value, "issueId"),
        page: decodeMaintenancePage(value.page),
        resolution: requiredString(value, "resolution"),
      };
    default:
      throw new ValidationError(`unsupported maintenance kind: ${kind}`);
  }
}
function decodeQuestion(value: unknown): QuizQuestionProposal {
  if (!isRecord(value)) throw new ValidationError("quiz question must be an object");
  exact(value, ["kind", "prompt", "choices", "pages", "sourceRefs", "answerKey"], "quiz question");
  const pages = objectArray(value.pages, "pages").map((item) => {
    exact(item, ["pageId", "criterion", "weight"], "quiz question page");
    const weight = item.weight;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0)
      throw new ValidationError("quiz page weight must be a positive number");
    return { pageId: requiredString(item, "pageId"), criterion: requiredString(item, "criterion"), weight };
  });
  const choices = value.choices === undefined ? undefined : stringArray(value.choices, "choices");
  const kind = requiredString(value, "kind") as QuizQuestionProposal["kind"];
  if (kind !== "short-answer" && kind !== "multiple-choice") throw new ValidationError("quiz question kind is invalid");
  return {
    kind,
    prompt: requiredString(value, "prompt"),
    pages,
    sourceRefs: stringArray(value.sourceRefs, "sourceRefs"),
    ...(choices ? { choices } : {}),
    ...(value.answerKey === undefined ? {} : { answerKey: value.answerKey as QuizQuestionProposal["answerKey"] }),
  };
}
function decodeQuizPublication(value: unknown): QuizPublicationInput {
  if (!isRecord(value)) throw new ValidationError("quiz publication must be an object");
  const status = requiredString(value, "status");
  if (status === "published") {
    exact(value, ["status", "date", "questions"], "quiz publication");
    return {
      status,
      date: requiredString(value, "date"),
      questions: objectArray(value.questions, "questions").map(decodeQuestion),
    };
  }
  if (status === "skipped") {
    exact(value, ["status", "date", "reason"], "quiz skip");
    return { status, date: requiredString(value, "date"), reason: requiredString(value, "reason") };
  }
  throw new ValidationError("quiz publication status is invalid");
}
function decodeReading(value: unknown): { pageId: string; anchor: string; heading?: string } {
  if (!isRecord(value)) throw new ValidationError("reading must be an object");
  exact(value, ["pageId", "anchor", "heading"], "reading");
  const heading = optionalString(value, "heading");
  return {
    pageId: requiredString(value, "pageId"),
    anchor: requiredString(value, "anchor"),
    ...(heading === undefined ? {} : { heading }),
  };
}
function decodeGrade(value: unknown): GradeSettlementInput {
  if (!isRecord(value)) throw new ValidationError("grade settlement must be an object");
  exact(value, ["requestId", "date", "revision", "submissionId", "questions", "pages"], "grade settlement");
  const questions = objectArray(value.questions, "questions").map((question) => {
    exact(question, ["questionId", "feedback"], "graded question");
    const feedback = optionalString(question, "feedback");
    return {
      questionId: requiredString(question, "questionId"),
      ...(feedback === undefined ? {} : { feedback }),
    };
  });
  const pages = objectArray(value.pages, "pages").map((page) => {
    exact(page, ["pageId", "rating", "feedback", "evidence", "readings"], "graded page");
    const feedback = optionalString(page, "feedback");
    const readings =
      page.readings === undefined ? undefined : objectArray(page.readings, "readings").map(decodeReading);
    const rating = requiredString(page, "rating") as ReviewRating;
    if (rating !== "Again" && rating !== "Hard" && rating !== "Good" && rating !== "Easy")
      throw new ValidationError("rating is invalid");
    return {
      pageId: requiredString(page, "pageId"),
      rating,
      feedback,
      evidence: stringArray(page.evidence, "evidence"),
      ...(readings === undefined ? {} : { readings }),
    };
  });
  return {
    requestId: requiredString(value, "requestId"),
    date: requiredString(value, "date"),
    revision: requiredInteger(value, "revision"),
    submissionId: requiredString(value, "submissionId"),
    questions,
    pages,
  };
}
export class ScholarApplication {
  readonly paths: VaultPaths;
  readonly db: ScholarDatabase;
  readonly sources: SourceService;
  readonly wiki: WikiService;
  readonly scheduler: SchedulerService;
  readonly quiz: QuizService;
  readonly workflows: WorkflowCoordinator;
  readonly worker: BrowserMutationWorker;
  readonly version: string;
  private readonly ownsDatabase: boolean;
  private readonly doctorFn: (explicitPath?: string) => DoctorReport;
  private readonly commitFn: (paths: VaultPaths, subject: string) => GitCheckpointResult;
  private readonly pushFn: (paths: VaultPaths) => GitPushResult;
  private readonly admissionClaims = new Map<
    string,
    { readonly claim: SourceClaim; readonly prepared: PreparedAdmission }
  >();
  private readonly completedAdmissions = new Map<string, AdmissionPublicationResult>();
  constructor(input: ApplicationOptions) {
    this.paths = typeof input.paths === "string" ? resolveVault(input.paths) : input.paths;
    this.db = input.db ?? openDatabase(this.paths);
    this.ownsDatabase = !input.db;
    this.sources =
      input.sourceService ??
      new SourceService(this.db, this.paths, defaultSourceAdapters(this.paths, input.adapters?.sources));
    this.wiki =
      input.wikiService ?? new WikiService(this.db, this.paths, defaultWikiAdapters(this.paths, input.adapters?.wiki));
    this.scheduler = input.schedulerService ?? new SchedulerService(this.db, this.paths);
    this.quiz = input.quizService ?? new QuizService(this.db, this.paths, this.scheduler);
    this.worker = input.worker ?? new BrowserMutationWorker();
    this.version = input.version ?? "0.1.0";
    this.doctorFn = input.doctor ?? runDoctor;
    this.commitFn = input.commit ?? localCheckpointCommit;
    this.pushFn = input.push ?? ((paths) => safePush(paths));
    this.workflows = new WorkflowCoordinator(this.db, { worker: this.worker });
  }
  private async durableDirect<T, R = never>(
    operation: () => T | PromiseLike<T>,
    subject: string,
    rollback?: DurableRollback<R>,
  ): Promise<T> {
    return withWriterLock(this.paths, async () => {
      let snapshot: R | undefined;
      let captured = false;
      let committed = false;
      try {
        if (rollback) {
          snapshot = await rollback.capture();
          captured = true;
        }
        const value = await operation();
        try {
          this.db.checkpoint();
        } catch (error) {
          if (!rollback) throw mutationFinalizationError("checkpoint", error);
          throw error;
        }
        let report: DoctorReport;
        try {
          report = this.doctorFn(this.paths.vaultRoot);
        } catch (error) {
          if (!rollback) throw mutationFinalizationError("doctor", error);
          throw error;
        }
        if (!report.ok) {
          const error = new Error("doctor checks failed");
          if (!rollback) throw mutationFinalizationError("doctor", error);
          throw error;
        }
        try {
          const result = this.commitFn(this.paths, subject) as GitCheckpointResult & { readonly ok?: boolean };
          if (result.ok === false) throw new Error("Git checkpoint failed");
        } catch (error) {
          if (!rollback) throw mutationFinalizationError("commit", error);
          throw error;
        }
        committed = true;
        if (rollback && captured) {
          try {
            await rollback.dispose?.(snapshot as R);
          } catch (error) {
            throw mutationFinalizationError("rollback", error);
          }
        }
        return value;
      } catch (error) {
        if (rollback && captured && !committed) {
          try {
            await rollback.restore(snapshot as R);
          } catch (restoreError) {
            throw mutationFinalizationError("rollback", restoreError);
          }
        }
        throw error;
      }
    });
  }
  private async mutate<T>(
    context: ApplicationMutationContext | undefined,
    operation: () => T | PromiseLike<T>,
  ): Promise<T> {
    return context?.origin === "browser" ? this.worker.enqueue(operation) : await operation();
  }
  private assertPageMutationAllowed(
    pageId: string,
    proposedQuizWorthiness?: WikiNoteUpdateInput["quizWorthiness"],
  ): void {
    const unresolved = this.db.get<{ readonly quiz_id: string }>(
      `SELECT q.quiz_id
       FROM quizzes q
       JOIN quiz_questions qq ON qq.quiz_id = q.quiz_id
       JOIN question_pages qp ON qp.question_id = qq.question_id
       WHERE qp.page_id = ?
         AND (
           q.status = 'open'
           OR (
             q.status = 'submitted'
             AND NOT EXISTS (
               SELECT 1 FROM page_results pr WHERE pr.quiz_id = q.quiz_id AND pr.page_id = qp.page_id
             )
           )
         )
       LIMIT 1`,
      [pageId],
    );
    if (unresolved) throw new QuizConflictError(`Page ${pageId} is covered by an unresolved quiz`);
    if (
      (proposedQuizWorthiness === "skip" || proposedQuizWorthiness === "unknown") &&
      this.db.get("SELECT 1 FROM page_prerequisites WHERE page_id = ? OR prerequisite_page_id = ? LIMIT 1", [
        pageId,
        pageId,
      ])
    )
      throw new ValidationError("Pages participating in prerequisites must remain quiz-eligible");
  }
  private async readSetting<T>(key: string, fallback: T): Promise<T> {
    const row = this.db.get<Record<string, unknown>>("SELECT value_json FROM settings WHERE key = ?", [key]);
    if (!row) return fallback;
    return jsonValue(row.value_json) as T;
  }
  private async currentLocalDate(): Promise<string> {
    const timezone = await this.readSetting("timezone", "local");
    if (timezone === "local") return localDate(new Date());
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch {
      return localDate(new Date());
    }
  }
  private pendingSource(entry: Awaited<ReturnType<SourceService["discover"]>>[number]): SourceRecord {
    const sourceId = `pending-${sha256(`${entry.relativePath}:${JSON.stringify(entry.identity)}`).slice(0, 32)}`;
    const now = new Date().toISOString();
    return {
      sourceId,
      kind: entry.kind,
      status: "pending",
      displayName: entry.metadata?.displayName ?? entry.relativePath,
      ...(entry.metadata?.originalName ? { originalName: entry.metadata.originalName } : {}),
      ...(entry.metadata?.sourceUri ? { sourceUri: entry.metadata.sourceUri } : {}),
      ...(entry.metadata?.mediaType ? { mediaType: entry.metadata.mediaType } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }
  private async sourceList(): Promise<SourceRecord[]> {
    return [
      ...this.sources.list().map(sourceRecord),
      ...(await this.sources.discover()).map((entry) => this.pendingSource(entry)),
    ];
  }
  private async clearAdmissionClaims(): Promise<void> {
    const tracked = [...this.admissionClaims.values()];
    this.admissionClaims.clear();
    for (const { prepared } of tracked) await this.sources.cleanupPrepared(prepared.preparedId);
  }
  async getAdmissionContext(): Promise<AdmissionContext> {
    await this.clearAdmissionClaims();
    const claims: PreparedAdmission[] = [];
    const failures: AdmissionFailureRecord[] = [];
    let recordingError: unknown;
    for (const entry of await this.sources.discover()) {
      let claim: SourceClaim | undefined;
      try {
        claim = await this.sources.claim(entry);
        const prepared = await this.sources.prepareClaim(claim);
        this.admissionClaims.set(claim.claimId, { claim, prepared });
        claims.push(prepared);
      } catch (error) {
        try {
          await this.durableDirect(
            () => this.sources.recordAdmissionFailure(entry, error, claim),
            "source:admission-failed",
          );
        } catch (failureError) {
          recordingError ??= failureError;
        }
        if (claim) {
          const tracked = this.admissionClaims.get(claim.claimId);
          this.admissionClaims.delete(claim.claimId);
          if (tracked) await this.sources.cleanupPrepared(tracked.prepared.preparedId);
        }
        failures.push({
          relativePath: entry.relativePath,
          errorCode: "ADMISSION_FAILED",
          errorMessage: errorMessage(error).slice(0, 500),
        });
      }
    }
    if (recordingError) {
      await this.clearAdmissionClaims();
      throw recordingError;
    }
    return { claims, ...(failures.length ? { failures } : {}) };
  }
  async admitSource(input: AdmissionPublicationInput): Promise<AdmissionPublicationResult> {
    const decoded = decodeAdmissionInput(input);
    const resultKey = admissionResultKey(decoded);
    const completed = this.completedAdmissions.get(resultKey);
    if (completed) return completed;
    const pending = this.admissionClaims.get(decoded.claimId);
    if (!pending || pending.prepared.preparedId !== decoded.preparedId || pending.prepared.digest !== decoded.digest)
      throw new ValidationError("admission claim is unknown, stale, or expired");
    let appliedResult: AdmissionPublicationResult | undefined;
    const cacheResult = (result: AdmissionPublicationResult): void => {
      this.completedAdmissions.set(resultKey, result);
      if (this.completedAdmissions.size > 256) {
        const oldest = this.completedAdmissions.keys().next().value;
        if (typeof oldest === "string") this.completedAdmissions.delete(oldest);
      }
    };
    try {
      const result = await this.durableDirect(async () => {
        const published = await this.sources.publishPreparedClaim({
          prepared: pending.prepared,
          preparedId: decoded.preparedId,
          claimId: decoded.claimId,
          digest: decoded.digest,
          ...(decoded.endpoints ? { endpoints: [...decoded.endpoints] } : {}),
        });
        const publication: AdmissionPublicationResult = {
          sourceId: published.sourceId,
          manifest: published.manifest as SourceManifest,
          removedInbox: published.removedInbox,
        };
        appliedResult = publication;
        return publication;
      }, "source:admit");
      cacheResult(result);
      this.admissionClaims.delete(decoded.claimId);
      return result;
    } catch (error) {
      if (appliedResult && isAppliedFinalizationFailure(error)) {
        cacheResult(appliedResult);
        this.admissionClaims.delete(decoded.claimId);
        throw error;
      }
      let recordingError: unknown;
      try {
        await this.durableDirect(
          () => this.sources.recordAdmissionFailure(pending.claim.entry, error, pending.claim),
          "source:admission-failed",
        );
      } catch (failureError) {
        recordingError = failureError;
      }
      this.admissionClaims.delete(decoded.claimId);
      await this.sources.cleanupPrepared(pending.prepared.preparedId);
      if (recordingError) throw recordingError;
      throw error;
    }
  }

  async listSources(): Promise<{ readonly sources: readonly PublicSourceRecord[] }> {
    return { sources: (await this.sourceList()).map(publicSource) };
  }
  async stageSource(
    request: SourceRequest | MechanicsSourceStageRequest,
    context?: ApplicationMutationContext,
  ): Promise<SourceStageResult> {
    return this.mutate(context, async () => {
      const staged = await this.sources.stage(request as MechanicsSourceStageRequest);
      const entry = (await this.sources.discover()).find((candidate) => candidate.relativePath === staged.relativePath);
      if (!entry) throw new Error("staged source disappeared");
      return { source: publicSource(this.pendingSource(entry)) };
    });
  }
  async removalPreview(sourceId: string): Promise<{
    readonly source: PublicSourceRecord;
    readonly dependentPageIds: readonly string[];
    readonly confirmationId: string;
  }> {
    const preview = this.sources.removalPreview(sourceId);
    const source = this.sources
      .list()
      .map(sourceRecord)
      .find((item) => item.sourceId === sourceId);
    if (!source) throw new Error("source not found");
    return {
      source: publicSource(source),
      dependentPageIds: preview.dependentPageIds,
      confirmationId: preview.confirmationId,
    };
  }
  async removeSource(
    sourceId: string,
    confirmationId: string,
    context?: ApplicationMutationContext,
  ): Promise<SourceRemovalResult> {
    return this.mutate(context, () =>
      this.durableDirect(async () => {
        const removed = await this.sources.removeConfirmed(sourceId, confirmationId);
        return { sourceId, status: "removed", dependentPageIds: removed.dependentPageIds };
      }, "source:remove"),
    );
  }
  private async quizDetail(quiz: QuizRecord): Promise<QuizDetailRecord> {
    const answers = this.db
      .all<Record<string, unknown>>(
        "SELECT question_id, answer_json FROM quiz_answers WHERE quiz_id = ? ORDER BY question_id",
        [quiz.quizId],
      )
      .flatMap((row) => {
        const answer = jsonValue(row.answer_json);
        return typeof answer === "string" || (Array.isArray(answer) && answer.every((item) => typeof item === "string"))
          ? [{ questionId: String(row.question_id), answer: answer as string | readonly string[] }]
          : [];
      });
    const answerSaved = this.db.get<Record<string, unknown>>(
      "SELECT saved_at FROM quiz_answers WHERE quiz_id = ? ORDER BY saved_at DESC LIMIT 1",
      [quiz.quizId],
    );
    const draft =
      answers.length && answerSaved?.saved_at
        ? { revision: quiz.revision, savedAt: String(answerSaved.saved_at), answers }
        : undefined;
    const settled = this.quiz.readSettledResult(quiz);
    const settledByQuestion = new Map((settled?.questions ?? []).map((question) => [question.questionId, question]));
    const settledByPage = new Map((settled?.pages ?? []).map((page) => [page.pageId, page]));
    const questionResults: QuizQuestionResultRecord[] = this.db
      .all<Record<string, unknown>>("SELECT * FROM question_results WHERE quiz_id = ? ORDER BY question_id", [
        quiz.quizId,
      ])
      .map((row) => ({
        resultId: String(row.result_id),
        quizId: String(row.quiz_id),
        questionId: String(row.question_id),
        answerRevision: Number(row.answer_revision),
        feedback: settledByQuestion.get(String(row.question_id))?.feedback ?? "",
        gradedAt: String(row.graded_at),
      }));
    const publicReading = (reading: ReadingLink): QuizReadingRecord => {
      const page = this.db.get<Record<string, unknown>>("SELECT relative_path FROM pages WHERE page_id = ?", [
        reading.pageId,
      ]);
      if (!page) throw new ValidationError(`Committed grade reading page is missing: ${reading.pageId}`);
      return {
        pageId: reading.pageId,
        path: String(page.relative_path),
        ...(reading.heading === undefined ? {} : { heading: reading.heading }),
        href: this.quiz.readingHref(reading),
      };
    };
    const internalPageResults = this.db
      .all<Record<string, unknown>>("SELECT * FROM page_results WHERE quiz_id = ? ORDER BY page_id", [quiz.quizId])
      .map((row) => {
        const pageId = String(row.page_id);
        const settledPage = settledByPage.get(pageId);
        const evidenceValue = jsonValue(row.evidence_json);
        const readingsValue = jsonValue(row.readings_json);
        const evidence =
          settledPage?.evidence ??
          (Array.isArray(evidenceValue)
            ? evidenceValue.filter((item): item is string => typeof item === "string")
            : []);
        const readings: readonly ReadingLink[] =
          settledPage?.readings ?? (Array.isArray(readingsValue) ? readingsValue.map(decodeReading) : []);
        return {
          resultId: String(row.result_id),
          quizId: String(row.quiz_id),
          pageId,
          rating: String(row.rating) as QuizPageResultRecord["rating"],
          feedback: settledPage?.feedback ?? String(row.feedback ?? ""),
          reviewId: String(row.review_id),
          evidence,
          readings,
        };
      });
    const pageResults: QuizPageResultRecord[] = internalPageResults.map((page) => ({
      ...page,
      readings: page.readings.map(publicReading),
    }));
    const grades: QuizGradeRecord[] = pageResults.map((row) => ({
      gradeId: row.reviewId,
      quizId: row.quizId,
      pageId: row.pageId,
      rating: row.rating,
      feedback: row.feedback,
      gradedAt: String(
        this.db.get<Record<string, unknown>>("SELECT reviewed_at FROM page_reviews WHERE review_id = ?", [row.reviewId])
          ?.reviewed_at ?? new Date().toISOString(),
      ),
      reviewId: row.reviewId,
    }));
    const readings = [
      ...new Map(
        internalPageResults
          .flatMap((page) => page.readings)
          .map((reading): readonly [string, ReadingLink] => [`${reading.pageId}#${reading.anchor}`, reading]),
      ).values(),
    ].map(publicReading);
    return { ...quiz, answers, ...(draft ? { draft } : {}), questionResults, pageResults, grades, readings };
  }

  async listWiki(): Promise<{ readonly pages: readonly PageRecord[] }> {
    return { pages: (await this.wiki.list()).map(pageRecord) };
  }
  private async wikiResult(pageIdOrPath: string): Promise<WikiPageResult> {
    const inspected = await this.wiki.inspectDrift(pageIdOrPath);
    const value = await this.wiki.get(inspected.page.pageId);
    const page = pageRecord(inspected.page);
    const markdown = value.content;
    const pageSections = parseWikiSections(markdown, page.pageId);
    let schedule: PageLearningRecord | undefined;
    if (page.quizWorthiness === "eligible") schedule = this.scheduler.ensurePageLearning(page.pageId);
    else if (this.db.get("SELECT page_id FROM page_learning WHERE page_id = ?", [page.pageId]))
      schedule = this.scheduler.getPageLearning(page.pageId);
    const prerequisites = this.scheduler.listPrerequisites(page.pageId);
    const learning: WikiPageLearningProjection = { ...(schedule ? { schedule } : {}), prerequisites };
    const drift = inspected.drifted
      ? { expectedDigest: inspected.authoredDigest, actualDigest: inspected.currentDigest, diff: inspected.diff }
      : undefined;
    return { page, markdown, sections: pageSections, learning, ...(drift ? { drift } : {}) };
  }
  async getWiki(pageIdOrPath: string): Promise<WikiPageResult> {
    return this.wikiResult(pageIdOrPath);
  }
  async searchWiki(
    query: string,
    options: { readonly mode?: "semantic" | "lexical" | "exact"; readonly limit?: number } = {},
  ): Promise<WikiSearchResult> {
    const values: unknown[] =
      options.mode === "semantic"
        ? await this.wiki.semanticSearch(query, options.limit)
        : options.mode === "exact"
          ? await this.exactSearch(query)
          : await this.wiki.lexicalSearch(query, options.limit);
    const pages: PageRecord[] = [];
    for (const value of values) {
      const candidate = isRecord(value) && isRecord(value.page) ? value.page : value;
      if (!isRecord(candidate)) continue;
      const pageId = typeof candidate.pageId === "string" ? candidate.pageId : undefined;
      const path =
        typeof candidate.relativePath === "string"
          ? candidate.relativePath
          : typeof candidate.path === "string"
            ? candidate.path.replace(/^wiki\//u, "")
            : undefined;
      if (!pageId && !path) continue;
      try {
        pages.push(pageRecord(await this.wiki.get(pageId ?? path!)));
      } catch {
        /* stale search result */
      }
    }
    return { pages };
  }
  private async exactSearch(query: string): Promise<unknown[]> {
    try {
      return [await this.wiki.get(query)];
    } catch {
      return [];
    }
  }
  async listIssues(): Promise<WikiIssueListResult> {
    return {
      issues: this.db
        .all<Record<string, unknown>>("SELECT * FROM wiki_issues ORDER BY updated_at DESC, issue_id")
        .map(recordToIssue),
    };
  }
  async reportIssue(input: WikiIssueCreateRequest, context?: ApplicationMutationContext): Promise<WikiIssueRecord> {
    return this.mutate(context, () => this.durableDirect(() => this.wiki.report(input), "wiki:issue"));
  }
  async patchIssue(
    issueId: string,
    input: WikiIssueUpdateRequest,
    context?: ApplicationMutationContext,
  ): Promise<WikiIssueRecord> {
    if (input.status !== "reopened" && input.status !== "resolved")
      throw new ValidationError("issue status is invalid");
    if (input.status === "resolved") throw new ValidationError("issue resolution requires a guarded page correction");
    return this.mutate(context, () =>
      this.durableDirect(
        () => this.wiki.patchIssue(issueId, { status: input.status, resolution: input.resolution }),
        "wiki:issue-patch",
      ),
    );
  }
  async resolveDrift(
    pageId: string,
    input: WikiDriftResolutionRequest,
    context?: ApplicationMutationContext,
  ): Promise<WikiPageResult> {
    return this.mutate(context, () =>
      this.durableDirect(async () => {
        this.assertPageMutationAllowed(pageId);
        const before = await this.wiki.inspectDrift(pageId);
        if (before.currentDigest !== input.expectedDigest)
          throw new RevisionConflictError("The wiki page digest is stale");
        const resolved = await this.wiki.resolveDrift(pageId, input.action);
        return this.wikiResult(resolved.page.pageId);
      }, "wiki:drift"),
    );
  }
  async createNote(input: WikiNoteInput, context?: ApplicationMutationContext): Promise<WikiPageResult> {
    return this.mutate(context, () =>
      this.durableDirect(async () => {
        const created = await this.wiki.create(input);
        if (created.page.quizWorthiness === "eligible") this.scheduler.ensurePageLearning(created.page.pageId);
        return this.wikiResult(created.page.pageId);
      }, "wiki:create"),
    );
  }
  async updateNote(
    pageId: string,
    input: WikiNoteUpdateInput,
    context?: ApplicationMutationContext,
  ): Promise<WikiPageResult> {
    return this.mutate(context, () =>
      this.durableDirect(async () => {
        this.assertPageMutationAllowed(pageId, input.quizWorthiness);
        const updated = await this.wiki.update(pageId, input);
        if (updated.page.quizWorthiness === "eligible") this.scheduler.ensurePageLearning(updated.page.pageId);
        return this.wikiResult(updated.page.pageId);
      }, "wiki:update"),
    );
  }
  async renameNote(
    pageId: string,
    requestedPath: string,
    context?: ApplicationMutationContext,
  ): Promise<WikiPageResult> {
    return this.mutate(context, () =>
      this.durableDirect(async () => {
        this.assertPageMutationAllowed(pageId);
        const updated = await this.wiki.rename(pageId, requestedPath);
        return this.wikiResult(updated.pageId);
      }, "wiki:rename"),
    );
  }

  async listQuizzes(): Promise<{ readonly quizzes: readonly PublicQuizRecord[] }> {
    return { quizzes: this.quiz.list().map(publicQuiz) };
  }
  async getQuiz(date: string): Promise<{
    readonly quiz?: PublicQuizDetailRecord;
    readonly outcome: "available" | "submitted" | "expired" | "skipped" | "failed" | "not-yet-run" | "maintenance-day";
    readonly answers: readonly QuizAnswerInput[];
    readonly grades: readonly QuizGradeRecord[];
    readonly readings: readonly QuizReadingRecord[];
    readonly message?: string;
  }> {
    const quiz = this.quiz.get(date);
    if (!quiz) {
      const settings = await this.getSettings();
      const maintenance = settings.settings.initializationEnabled && date === settings.settings.facts.localDate;
      return {
        outcome: maintenance ? "maintenance-day" : "not-yet-run",
        answers: [],
        grades: [],
        readings: [],
        message: maintenance
          ? "Initialization maintenance is active; no quiz is generated today."
          : "No quiz has been generated for this date.",
      };
    }
    const detail = await this.quizDetail(quiz);
    return {
      quiz: publicQuizDetail(detail),
      outcome: quizOutcome(quiz),
      answers: detail.answers,
      grades: detail.grades,
      readings: detail.readings,
      ...(quiz.status === "failed" ? { message: "Quiz generation failed." } : {}),
    };
  }
  async saveAnswers(
    date: string,
    input: { readonly expectedRevision: number; readonly answers: readonly QuizAnswerInput[] },
    context?: ApplicationMutationContext,
  ): Promise<{ readonly revision: number; readonly savedAt: string; readonly answers: readonly QuizAnswerInput[] }> {
    return this.mutate(context, () =>
      withWriterLock(this.paths, async () => {
        const answers = asAnswers(input.answers);
        if (
          answers.length !== input.answers.length ||
          new Set(answers.map((answer) => answer.questionId)).size !== answers.length
        )
          throw new ValidationError("answers must contain each question at most once");
        const result = this.quiz.saveDraft({ date, revision: input.expectedRevision, answers: answersObject(answers) });
        const savedAt = this.db.get<Record<string, unknown>>(
          "SELECT saved_at FROM quiz_answers WHERE quiz_id = ? ORDER BY saved_at DESC LIMIT 1",
          [result.quizId],
        )?.saved_at;
        return { revision: result.revision, savedAt: String(savedAt ?? new Date().toISOString()), answers };
      }),
    );
  }
  async sealSubmission(
    date: string,
    input: { readonly expectedRevision: number },
    context?: ApplicationMutationContext,
  ): Promise<{
    readonly status: "sealed";
    readonly workflow: PublicWorkflowRecord;
    readonly quiz: PublicQuizDetailRecord;
    readonly grades: readonly QuizGradeRecord[];
    readonly readings: readonly QuizReadingRecord[];
  }> {
    const requestId = randomUUID();
    return this.mutate(context, () =>
      this.durableDirect(async () => {
        if (date !== (await this.currentLocalDate()))
          throw new ValidationError("Daily quiz submissions may only target the current local date");
        const sealed = this.quiz.sealSubmissionAndQueue(
          { date, revision: input.expectedRevision },
          requestId,
          (workflowRequestId, quiz) => {
            const workflow = this.workflows.queueInTransaction(
              "quiz-grader",
              workflowRequestId,
              gradingSubmissionId(quiz),
            );
            this.db.run(
              "UPDATE workflows SET message = ? WHERE request_id = ? AND kind = 'quiz-grader' AND status = 'queued'",
              [quizGraderPayloadText(quiz), workflowRequestId],
            );
            return this.workflows.get(workflowRequestId) ?? workflow;
          },
        );
        const detail = await this.quizDetail(sealed.quiz);
        return {
          status: "sealed",
          workflow: publicWorkflow(sealed.workflow),
          quiz: publicQuizDetail(detail),
          grades: detail.grades,
          readings: detail.readings,
        };
      }, "quiz:seal"),
    );
  }
  async beginWorkflow(kind: WorkflowKind, idempotencyKey?: string): Promise<{ readonly workflow: WorkflowRecord }> {
    return this.durableDirect(
      async () => {
        const workflow = this.workflows.beginWorkflow(kind, idempotencyKey);
        return { workflow };
      },
      `workflow:${kind}:begin`,
      {
        capture: () =>
          this.db.all<Record<string, unknown>>(
            "SELECT request_id, kind, status, started_at, finished_at, progress, message, error_code, error_message, idempotency_key FROM workflows ORDER BY request_id",
          ),
        restore: (rows) =>
          transaction(this.db, () => {
            this.db.run("DELETE FROM workflows");
            for (const row of rows)
              this.db.run(
                "INSERT INTO workflows (request_id, kind, status, started_at, finished_at, progress, message, error_code, error_message, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                  row.request_id,
                  row.kind,
                  row.status,
                  row.started_at ?? null,
                  row.finished_at ?? null,
                  row.progress,
                  row.message ?? null,
                  row.error_code ?? null,
                  row.error_message ?? null,
                  row.idempotency_key ?? null,
                ],
              );
          }),
      },
    );
  }
  async updateWorkflow(
    requestId: string,
    input: WorkflowUpdateInput = {},
  ): Promise<{ readonly workflow: WorkflowRecord }> {
    return this.durableDirect(
      () => ({ workflow: this.workflows.updateWorkflow(requestId, input) }),
      `workflow:${requestId}:update`,
    );
  }
  async finishWorkflow(
    requestId: string,
    status: "succeeded" | "failed",
    options: WorkflowFinishOptions = {},
  ): Promise<{ readonly workflow: WorkflowRecord }> {
    return this.durableDirect(
      () => ({ workflow: this.workflows.finishWorkflow(requestId, status, options) }),
      `workflow:${requestId}:${status}`,
    );
  }

  async listWorkflows(): Promise<{ readonly workflows: readonly PublicWorkflowRecord[] }> {
    return { workflows: this.workflows.list().map(publicWorkflow) };
  }
  async getWorkflow(requestId: string): Promise<PublicWorkflowRecord> {
    const workflow = this.workflows.get(requestId);
    if (!workflow) throw new Error("workflow not found");
    return publicWorkflow(workflow);
  }
  async getSettings(): Promise<{ readonly settings: SettingsRecord }> {
    const initializationEnabled = await this.readSetting("initializationEnabled", true);
    const timezone = await this.readSetting("timezone", "local");
    const port = await this.readSetting("port", 4816);
    const host = await this.readSetting("host", "127.0.0.1");
    const pendingInboxCount = (await this.sources.discover()).length;
    const openIssueCount = Number(
      this.db.get<Record<string, unknown>>(
        "SELECT COUNT(*) AS count FROM wiki_issues WHERE status IN ('open','reopened')",
      )?.count ?? 0,
    );
    const maintenance = this.db.get<Record<string, unknown>>(
      "SELECT finished_at, message FROM workflows WHERE kind = 'wiki-maintenance' AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1",
    );
    let git: SettingsFacts["git"] = {
      clean: false,
      ahead: 0,
      behind: 0,
      diverged: false,
      message: "Git state unavailable",
    };
    try {
      const status = (await import("./external/git.js")).gitStatus(this.paths);
      git = {
        branch: status.branch,
        upstream: status.upstream,
        clean: status.clean,
        ahead: status.ahead,
        behind: status.behind,
        diverged: status.diverged,
      };
    } catch (error) {
      git = { ...git, message: errorMessage(error) };
    }
    const facts: SettingsFacts = {
      localDate: await this.currentLocalDate(),
      pendingInboxCount,
      openIssueCount,
      ...(maintenance?.finished_at ? { lastMaintenanceAt: String(maintenance.finished_at) } : {}),
      ...(maintenance?.message ? { lastMaintenanceResult: String(maintenance.message) } : {}),
      recentChanges: [],
      git,
    };
    return {
      settings: {
        initializationEnabled: Boolean(initializationEnabled),
        timezone: String(timezone),
        port: Number(port),
        host: String(host),
        updatedAt: String(
          this.db.get<Record<string, unknown>>("SELECT MAX(updated_at) AS updated_at FROM settings")?.updated_at ??
            new Date().toISOString(),
        ),
        facts,
      },
    };
  }
  async updateSettings(
    input: SettingsUpdateRequest,
    context?: ApplicationMutationContext,
  ): Promise<{ readonly settings: SettingsRecord }> {
    return this.mutate(context, () =>
      this.durableDirect(async () => {
        const now = new Date().toISOString();
        const updates: [string, unknown][] = [];
        if (input.initializationEnabled !== undefined) {
          if (typeof input.initializationEnabled !== "boolean")
            throw new ValidationError("initializationEnabled must be boolean");
          updates.push(["initializationEnabled", input.initializationEnabled]);
        }
        if (input.timezone !== undefined) {
          if (typeof input.timezone !== "string" || !input.timezone.trim() || input.timezone.length > 100)
            throw new ValidationError("timezone is invalid");
          if (input.timezone !== "local") {
            try {
              new Intl.DateTimeFormat("en-CA", { timeZone: input.timezone }).format();
            } catch {
              throw new ValidationError("timezone is invalid");
            }
          }
          updates.push(["timezone", input.timezone]);
        }
        if (input.port !== undefined) {
          if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
            throw new ValidationError("port is invalid");
          updates.push(["port", input.port]);
        }
        if (input.host !== undefined && input.host !== "127.0.0.1") throw new ValidationError("host must be 127.0.0.1");
        if (input.host !== undefined) updates.push(["host", input.host]);
        transaction(this.db, () => {
          for (const [key, value] of updates)
            this.db.run(
              "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
              [key, JSON.stringify(value), now],
            );
        });
        return this.getSettings();
      }, "settings:update"),
    );
  }
  async status(): Promise<ApplicationStatus> {
    const settings = await this.getSettings();
    const health = await this.health();
    return { ...health, settings: settings.settings, workflows: this.workflows.list().map(publicWorkflow) };
  }
  async health(): Promise<HealthResult> {
    try {
      const report = this.doctorFn(this.paths.vaultRoot);
      return {
        status: report.ok ? "ok" : "degraded",
        version: this.version,
        vaultId: this.paths.vaultId,
        doctor: report.ok ? "pass" : "fail",
      };
    } catch {
      return { status: "failed", version: this.version, vaultId: this.paths.vaultId, doctor: "fail" };
    }
  }
  async sync(): Promise<GitPushResult> {
    return withWriterLock(this.paths, () => this.pushFn(this.paths));
  }
  async close(): Promise<void> {
    let closeError: unknown;
    try {
      await this.workflows.close({ drain: true });
    } catch (error) {
      closeError = error;
    }
    try {
      await this.clearAdmissionClaims();
    } catch (error) {
      closeError ??= error;
    }
    this.completedAdmissions.clear();
    if (this.ownsDatabase) this.db.close();
    if (closeError) throw closeError;
  }
  async getMaintenanceContext(): Promise<MaintenanceContext> {
    const pages = await Promise.all((await this.wiki.list()).map((page) => this.wikiResult(page.pageId)));
    return {
      pages,
      issues: (await this.listIssues()).issues,
      sources: this.sources.list().map(sourceRecord),
    };
  }
  private async liveDriftPageIds(): Promise<Set<string>> {
    const reports = await Promise.all((await this.wiki.list()).map((page) => this.wiki.inspectDrift(page.pageId)));
    return new Set(reports.filter((report) => report.drifted).map((report) => report.page.pageId));
  }
  private async filterLiveDriftPages(pages: readonly PageLearningRecord[]): Promise<PageLearningRecord[]> {
    const drifted = await this.liveDriftPageIds();
    return pages.filter((page) => !drifted.has(page.pageId));
  }
  private async assertNoLiveWikiDrift(): Promise<void> {
    const drifted = await this.liveDriftPageIds();
    if (drifted.size) throw new ValidationError(`Wiki pages have unresolved live drift: ${[...drifted].join(", ")}`);
  }
  private assertMaintenanceCoverage(
    pages?: readonly {
      readonly pageId: string;
      readonly status?: "active" | "drifted" | "retired";
      readonly quizWorthiness?: "eligible" | "skip" | "unknown";
    }[],
  ): void {
    const coverage = this.scheduler.validateCoverage(pages);
    if (!coverage.ok)
      throw new ValidationError(`Eligible wiki pages lack learning rows: ${coverage.missingPageIds.join(", ")}`);
  }
  private async maintenancePreflight(allowDrift = false): Promise<void> {
    if (!allowDrift) await this.assertNoLiveWikiDrift();
    const pages = await this.wiki.list();
    const projection = await this.wiki.refreshProjections(false);
    const lint = this.wiki.lintSync(pages, projection.backlinks);
    if (lint.length) throw new ValidationError(`wiki lint failed: ${lint.join("; ")}`);
    const qmd = this.wiki.adapters.qmd;
    if (!qmd || typeof qmd.index !== "function") throw new ValidationError("wiki maintenance requires qmd indexing");
    await qmd.index();
  }
  private async captureMaintenanceRollback(proposal: MaintenanceInput): Promise<MaintenanceRollbackSnapshot> {
    const destinations = new Set<string>([join(this.paths.wikiRoot, "index.md"), join(this.paths.wikiRoot, "log.md")]);
    const pageIds = new Set<string>();
    switch (proposal.kind) {
      case "create-page":
        destinations.add(safeRelativePath(this.paths.wikiRoot, proposal.path));
        break;
      case "update-page":
      case "rename-page":
        pageIds.add(proposal.pageId);
        if (proposal.kind === "rename-page") destinations.add(safeRelativePath(this.paths.wikiRoot, proposal.path));
        break;
      case "resolve-issue":
        pageIds.add(proposal.page.pageId);
        break;
      default:
        break;
    }
    for (const pageId of pageIds) {
      const page = await this.wiki.get(pageId);
      destinations.add(join(this.paths.wikiRoot, page.relativePath));
      destinations.add(join(this.paths.metadataRoot, "snapshots", "wiki", `${page.pageId}.md`));
    }
    const snapshotRoot = join(this.paths.metadataRoot, "snapshots", "wiki");
    const snapshotEntries = await fs.readdir(snapshotRoot);
    const workRoot = join(this.paths.workRoot, `maintenance-rollback-${randomUUID()}`);
    await fs.mkdir(workRoot, { recursive: false, mode: 0o700 });
    const files: MaintenanceRollbackFile[] = [];
    try {
      for (const [index, destination] of [...destinations].entries()) {
        let content: Buffer | undefined;
        try {
          content = await fs.readFile(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const exists = content !== undefined;
        const backup = join(workRoot, `${index}.bin`);
        if (content !== undefined) await fs.writeFile(backup, content, { flag: "wx", mode: 0o600 });
        files.push({ destination, backup, exists });
      }
      const tables = Object.fromEntries(
        MAINTENANCE_ROLLBACK_TABLES.map(({ name }) => [
          name,
          this.db.all<Record<string, unknown>>(`SELECT * FROM ${name}`),
        ]),
      );
      return { workRoot, tables, files, snapshotRoot, snapshotEntries };
    } catch (error) {
      await fs.rm(workRoot, { recursive: true, force: true });
      throw error;
    }
  }
  private async restoreMaintenanceRollback(snapshot: MaintenanceRollbackSnapshot): Promise<void> {
    const deleteOrder = ["wiki_issues", "page_prerequisites", "page_learning", "authored_snapshots", "pages"];
    const writeOrder = ["pages", "authored_snapshots", "page_learning", "page_prerequisites", "wiki_issues"];
    const specs = new Map<string, (typeof MAINTENANCE_ROLLBACK_TABLES)[number]>(
      MAINTENANCE_ROLLBACK_TABLES.map((spec): [string, (typeof MAINTENANCE_ROLLBACK_TABLES)[number]] => [
        spec.name,
        spec,
      ]),
    );
    const keyOf = (row: Record<string, unknown>, keys: readonly string[]): string =>
      keys.map((key) => String(row[key] ?? "")).join("\u0000");
    const restoreTable = (name: string): void => {
      const spec = specs.get(name);
      if (!spec) throw new Error(`unknown rollback table: ${name}`);
      const rows = snapshot.tables[name] ?? [];
      const keys: readonly string[] = spec.keys;
      const where = keys.map((key) => `${key} = ?`).join(" AND ");
      const wanted = new Set(rows.map((row) => keyOf(row, keys)));
      for (const row of rows) {
        const columns = Object.keys(row);
        const values = columns.map((column) => row[column] ?? null);
        const keyValues = keys.map((key) => row[key] ?? null);
        const exists = this.db.get(`SELECT 1 FROM ${name} WHERE ${where}`, keyValues);
        if (exists) {
          const updates = columns.filter((column) => !keys.includes(column));
          if (updates.length)
            this.db.run(`UPDATE ${name} SET ${updates.map((column) => `${column} = ?`).join(", ")} WHERE ${where}`, [
              ...updates.map((column) => row[column] ?? null),
              ...keyValues,
            ]);
        } else {
          this.db.run(
            `INSERT INTO ${name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            values,
          );
        }
      }
      for (const row of this.db.all<Record<string, unknown>>(`SELECT * FROM ${name}`)) {
        if (!wanted.has(keyOf(row, keys)))
          this.db.run(
            `DELETE FROM ${name} WHERE ${where}`,
            keys.map((key) => row[key] ?? null),
          );
      }
    };
    const restoreFile = async (file: MaintenanceRollbackFile): Promise<void> => {
      if (!file.exists) {
        await fs.rm(file.destination, { force: true });
        return;
      }
      const content = await fs.readFile(file.backup);
      await fs.mkdir(dirname(file.destination), { recursive: true, mode: 0o700 });
      const temporary = join(dirname(file.destination), `.${randomUUID()}.rollback`);
      try {
        await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, file.destination);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    };
    try {
      transaction(this.db, () => {
        for (const name of deleteOrder) {
          const spec = specs.get(name);
          if (!spec) throw new Error(`unknown rollback table: ${name}`);
          const rows = snapshot.tables[name] ?? [];
          const keys: readonly string[] = spec.keys;
          const where = keys.map((key) => `${key} = ?`).join(" AND ");
          const wanted = new Set(rows.map((row) => keyOf(row, keys)));
          for (const row of this.db.all<Record<string, unknown>>(`SELECT * FROM ${name}`)) {
            if (!wanted.has(keyOf(row, keys)))
              this.db.run(
                `DELETE FROM ${name} WHERE ${where}`,
                keys.map((key) => row[key] ?? null),
              );
          }
        }
        for (const name of writeOrder) restoreTable(name);
      });
      for (const file of snapshot.files) await restoreFile(file);
      const expectedSnapshots = new Set(snapshot.snapshotEntries);
      for (const entry of await fs.readdir(snapshot.snapshotRoot)) {
        if (!expectedSnapshots.has(entry))
          await fs.rm(join(snapshot.snapshotRoot, entry), { recursive: true, force: true });
      }
      const qmd = this.wiki.adapters.qmd;
      try {
        if (typeof qmd?.index === "function") await qmd?.index();
      } finally {
        this.db.checkpoint();
      }
    } finally {
      await fs.rm(snapshot.workRoot, { recursive: true, force: true });
    }
  }
  private async maintenanceChecks(): Promise<{ readonly lint: readonly string[]; readonly doctor: DoctorReport }> {
    await this.assertNoLiveWikiDrift();
    const pages = await this.wiki.list();
    const projection = await this.wiki.refreshProjections();
    const lint = this.wiki.lintSync(pages, projection.backlinks);
    if (lint.length) throw new ValidationError(`wiki lint failed: ${lint.join("; ")}`);
    for (const page of pages) {
      if (page.status === "active" && page.quizWorthiness === "eligible")
        this.scheduler.ensurePageLearning(page.pageId);
    }
    this.assertMaintenanceCoverage(pages);
    const qmd = this.wiki.adapters.qmd;
    if (!qmd || typeof qmd.index !== "function") throw new ValidationError("wiki maintenance requires qmd indexing");
    await qmd.index();
    const doctor = this.doctorFn(this.paths.vaultRoot);
    if (!doctor.ok) throw new ValidationError("doctor checks failed");
    return { lint, doctor };
  }
  async applyMaintenance(input: MaintenanceInput): Promise<MaintenanceResult> {
    const proposal = decodeMaintenanceInput(input);
    const rollback = {
      capture: () => this.captureMaintenanceRollback(proposal),
      restore: (snapshot: MaintenanceRollbackSnapshot) => this.restoreMaintenanceRollback(snapshot),
      dispose: (snapshot: MaintenanceRollbackSnapshot) => fs.rm(snapshot.workRoot, { recursive: true, force: true }),
    };
    return this.durableDirect(
      async () => {
        await this.maintenancePreflight(proposal.kind === "update-page" || proposal.kind === "resolve-issue");
        switch (proposal.kind) {
          case "create-page": {
            const created = await this.wiki.create(proposal);
            const pageLearning =
              created.page.quizWorthiness === "eligible"
                ? this.scheduler.ensurePageLearning(created.page.pageId)
                : undefined;
            const checks = await this.maintenanceChecks();
            return {
              kind: proposal.kind,
              page: pageRecord(created.page),
              ...(pageLearning ? { pageLearning } : {}),
              checks,
            };
          }
          case "update-page": {
            this.assertPageMutationAllowed(proposal.pageId, proposal.quizWorthiness);
            const current = await this.wiki.get(proposal.pageId);
            if (current.digest !== proposal.expectedDigest)
              throw new RevisionConflictError("The wiki page digest is stale");
            const updated = await this.wiki.update(proposal.pageId, proposal);
            const pageLearning =
              updated.page.quizWorthiness === "eligible"
                ? this.scheduler.ensurePageLearning(updated.page.pageId)
                : undefined;
            const checks = await this.maintenanceChecks();
            return {
              kind: proposal.kind,
              page: pageRecord(updated.page),
              ...(pageLearning ? { pageLearning } : {}),
              checks,
            };
          }
          case "rename-page": {
            this.assertPageMutationAllowed(proposal.pageId);
            const current = await this.wiki.get(proposal.pageId);
            if (current.digest !== proposal.expectedDigest)
              throw new RevisionConflictError("The wiki page digest is stale");
            const renamed = await this.wiki.rename(proposal.pageId, proposal.path);
            const checks = await this.maintenanceChecks();
            return { kind: proposal.kind, page: pageRecord(renamed), checks };
          }
          case "prerequisites": {
            const page = await this.wiki.get(proposal.pageId);
            const pageLearning =
              page.quizWorthiness === "eligible" ? this.scheduler.ensurePageLearning(page.pageId) : undefined;
            this.scheduler.setPrerequisites(proposal.pageId, proposal.prerequisitePageIds, proposal.expectedRevision);
            const checks = await this.maintenanceChecks();
            return {
              kind: proposal.kind,
              prerequisites: this.scheduler.listPrerequisites(page.pageId),
              ...(pageLearning ? { pageLearning } : {}),
              checks,
            };
          }
          case "resolve-issue": {
            const row = this.db.get<Record<string, unknown>>("SELECT * FROM wiki_issues WHERE issue_id = ?", [
              proposal.issueId,
            ]);
            if (!row) throw new Error("issue not found");
            const issue = recordToIssue(row);
            if (issue.status === "resolved") throw new RevisionConflictError("The issue is already resolved");
            if (!issue.pageId || proposal.page.pageId !== issue.pageId)
              throw new ValidationError("resolve-issue page must match the issue page");
            if (issue.pageDigest !== undefined && issue.pageDigest !== proposal.page.expectedDigest)
              throw new RevisionConflictError("The issue page version is stale");
            const current = await this.wiki.get(issue.pageId);
            if (current.digest !== proposal.page.expectedDigest)
              throw new RevisionConflictError("The issue page digest is stale");
            const parsed = parseWikiMarkdown(current.content);
            const pageChanged =
              (proposal.page.body !== undefined && proposal.page.body !== parsed.body) ||
              (proposal.page.title !== undefined && proposal.page.title !== current.title) ||
              (proposal.page.quizWorthiness !== undefined && proposal.page.quizWorthiness !== current.quizWorthiness);
            if (!pageChanged) throw new ValidationError("resolve-issue requires an actual page correction");
            this.assertPageMutationAllowed(proposal.page.pageId, proposal.page.quizWorthiness);
            const prepared = await this.wiki.prepareUpdate(issue.pageId, {
              expectedDigest: proposal.page.expectedDigest,
              ...(proposal.page.body === undefined ? {} : { body: proposal.page.body }),
              ...(proposal.page.title === undefined ? {} : { title: proposal.page.title }),
              ...(proposal.page.quizWorthiness === undefined ? {} : { quizWorthiness: proposal.page.quizWorthiness }),
            });
            const updatedPage = await this.wiki.update(
              issue.pageId,
              {
                expectedDigest: proposal.page.expectedDigest,
                ...(proposal.page.body === undefined ? {} : { body: proposal.page.body }),
                ...(proposal.page.title === undefined ? {} : { title: proposal.page.title }),
                ...(proposal.page.quizWorthiness === undefined ? {} : { quizWorthiness: proposal.page.quizWorthiness }),
              },
              prepared,
            );
            const pageLearning =
              updatedPage.page.quizWorthiness === "eligible"
                ? this.scheduler.ensurePageLearning(updatedPage.page.pageId)
                : undefined;
            const checks = await this.maintenanceChecks();
            const resolved = await this.wiki.resolveIssueAfterCorrection(proposal.issueId, proposal.resolution);
            return {
              kind: proposal.kind,
              page: pageRecord(updatedPage.page),
              issue: resolved,
              ...(pageLearning ? { pageLearning } : {}),
              checks,
            };
          }
        }
      },
      "wiki:maintenance",
      rollback,
    );
  }
  private async quizEvidence(pages: readonly PageLearningRecord[]): Promise<QuizEvidenceRecord[]> {
    const contents = new Map<string, Buffer>();
    const evidence: QuizEvidenceRecord[] = [];
    const seenPages = new Set<string>();
    for (const learning of pages) {
      if (seenPages.has(learning.pageId)) continue;
      seenPages.add(learning.pageId);
      const catalog = this.db.get<Record<string, unknown>>(
        "SELECT relative_path, digest, revision, status, quiz_worthiness FROM pages WHERE page_id = ?",
        [learning.pageId],
      );
      const path = String(catalog?.relative_path ?? "");
      const pageDigest = String(catalog?.digest ?? "");
      const pageRevision = Number(catalog?.revision ?? 0);
      if (
        !catalog ||
        String(catalog.status) !== "active" ||
        String(catalog.quiz_worthiness) !== "eligible" ||
        !path ||
        !pageDigest ||
        !Number.isInteger(pageRevision) ||
        pageRevision < 1
      )
        throw new ValidationError(`Learning page is stale or unavailable: ${learning.pageId}`);
      let bytes = contents.get(learning.pageId);
      if (bytes === undefined) {
        try {
          bytes = readFileNoFollow(safeRelativePath(this.paths.wikiRoot, path));
        } catch {
          throw new ValidationError(`Learning page is stale or unavailable: ${learning.pageId}`);
        }
        contents.set(learning.pageId, bytes);
      }
      if (sha256(bytes) !== pageDigest)
        throw new ValidationError(`Learning page is stale or unavailable: ${learning.pageId}`);
      const content = bytes.toString("utf8");
      for (const section of parseWikiSections(content, learning.pageId)) {
        const sectionText = content.slice(section.startOffset, section.endOffset);
        if (!sectionText || sha256(sectionText) !== section.textDigest)
          throw new ValidationError(`Learning section is stale: ${learning.pageId}${section.anchor}`);
        evidence.push({
          reference: evidenceReference(learning.pageId, section.anchor, pageDigest, pageRevision, section.textDigest),
          pageId: learning.pageId,
          path,
          anchor: section.anchor,
          ...(section.heading === undefined ? {} : { heading: section.heading }),
          pageDigest,
          pageRevision,
          textDigest: section.textDigest,
          excerpt: boundedUtf8(sectionText, 8192),
        });
      }
    }
    return evidence;
  }
  async getQuizContext(input: { readonly date?: string } = {}): Promise<QuizContext> {
    if (!isRecord(input)) throw new ValidationError("quiz context must be an object");
    exact(input, ["date"], "quiz context");
    const date = input.date === undefined ? await this.currentLocalDate() : requiredString(input, "date");
    const currentDate = await this.currentLocalDate();
    if (date !== currentDate) throw new ValidationError("quiz context is limited to the current local date");
    return this.durableDirect(async () => {
      const expiredCount = this.quiz.expirePrior(date);
      const settings = await this.getSettings();
      const eligiblePages = await this.filterLiveDriftPages(this.scheduler.selectDuePages(date));
      const quiz = this.quiz.get(date);
      return {
        date,
        initializationEnabled: settings.settings.initializationEnabled,
        expiredCount,
        eligiblePages,
        evidence: await this.quizEvidence(eligiblePages),
        ...(quiz ? { quiz: await this.quizDetail(quiz) } : {}),
        ...(settings.settings.initializationEnabled
          ? { message: "Initialization maintenance is active; quiz publication is blocked." }
          : {}),
      };
    }, "quiz:context");
  }
  private async validateQuizEvidence(
    questions: readonly QuizQuestionProposal[],
    selectedPages: readonly PageLearningRecord[],
  ): Promise<void> {
    if (questions.length > 4) throw new ValidationError("A quiz may contain at most four questions");
    if (questions.filter((question) => question.pages.length > 1).length > 2)
      throw new ValidationError("A quiz may contain at most two synthesis questions");
    const selected = new Set(selectedPages.map((page) => page.pageId));
    const evidence = await this.quizEvidence(selectedPages);
    const known = new Set(evidence.map((item) => item.reference));
    const byPage = new Map<string, Set<string>>();
    for (const item of evidence) {
      const references = byPage.get(item.pageId) ?? new Set<string>();
      references.add(item.reference);
      byPage.set(item.pageId, references);
    }
    const singlePageCoverage = new Map<string, number>();
    for (const question of questions) {
      if (!question.pages.length) throw new ValidationError("Every quiz question must cover a wiki page");
      if (!question.sourceRefs.length) throw new ValidationError("Every quiz question requires source evidence");
      if (question.pages.length === 1) {
        const pageId = question.pages[0]!.pageId.trim();
        singlePageCoverage.set(pageId, (singlePageCoverage.get(pageId) ?? 0) + 1);
      }
      for (const page of question.pages) {
        if (!selected.has(page.pageId))
          throw new ValidationError(`Quiz question references an ineligible page: ${page.pageId}`);
        const references = byPage.get(page.pageId) ?? new Set<string>();
        if (!question.sourceRefs.some((reference) => references.has(reference)))
          throw new ValidationError(`Quiz question lacks source evidence for page: ${page.pageId}`);
      }
      if (question.sourceRefs.some((reference) => !known.has(reference)))
        throw new ValidationError("Quiz question references unknown source evidence");
    }
    for (const page of selectedPages) {
      if (singlePageCoverage.get(page.pageId) !== 1)
        throw new ValidationError(`Every selected page requires exactly one single-page question: ${page.pageId}`);
    }
  }
  async publishQuiz(input: QuizPublicationInput): Promise<QuizDetailRecord> {
    const proposal = decodeQuizPublication(input);
    const date = proposal.date;
    const currentDate = await this.currentLocalDate();
    if (date !== currentDate) throw new ValidationError("quiz publication is limited to the current local date");
    let blocked = false;
    const result = await this.durableDirect(async () => {
      const settings = await this.getSettings();
      if (settings.settings.initializationEnabled) {
        blocked = true;
        return undefined;
      }
      const selectedPages = await this.filterLiveDriftPages(this.scheduler.selectDuePages(date));
      if (proposal.status === "skipped") {
        if (selectedPages.length) throw new ValidationError("A quiz may be skipped only when pages are eligible");
        return this.quizDetail(this.quiz.createDailyQuiz({ date, selectedPageIds: [], questionSpecs: [] }));
      }
      await this.validateQuizEvidence(proposal.questions, selectedPages);
      return this.quizDetail(
        this.quiz.createDailyQuiz({
          date,
          selectedPageIds: selectedPages.map((page) => page.pageId),
          questionSpecs: proposal.questions,
        }),
      );
    }, "quiz:publish");
    if (blocked || !result)
      throw new ValidationError("Initialization maintenance is active; quiz publication is blocked");
    return result;
  }
  private async gradingContextFor(date: string, requestId: string, quiz: QuizRecord): Promise<GradingContext> {
    return {
      date,
      requestId,
      submissionId: gradingSubmissionId(quiz),
      revision: quiz.revision,
      quiz: await this.quizDetail(quiz),
      evidence: this.quiz.gradingEvidence(quiz),
    };
  }
  private claimGradingWorkflow(
    date: string | undefined,
    ownerHash: string,
  ): { requestId: string; quizId: string } | undefined {
    return transaction(this.db, () => {
      const occupiedQuizIds = new Set<string>();
      const now = new Date().toISOString();
      const nowMs = Date.parse(now);
      const running = this.db.all<Record<string, unknown>>(
        "SELECT request_id, message, started_at FROM workflows WHERE kind = 'quiz-grader' AND status = 'running' ORDER BY rowid",
      );
      for (const row of running) {
        const binding = parseQuizGraderBinding(row.message);
        if (!binding)
          throw new RevisionConflictError(`Quiz grader workflow ${String(row.request_id)} has an invalid claim`);
        const quiz = this.quiz.get(binding.quizId);
        if (
          !quiz ||
          (date !== undefined && quiz.date !== date) ||
          quiz.status !== "submitted" ||
          this.db.get("SELECT 1 FROM page_results WHERE quiz_id = ? LIMIT 1", [binding.quizId])
        )
          continue;
        if (binding.ownerHash === ownerHash) {
          const renewed = this.db.run(
            "UPDATE workflows SET started_at = ? WHERE request_id = ? AND kind = 'quiz-grader' AND status = 'running' AND message = ?",
            [now, row.request_id, row.message],
          );
          if (Number(renewed.changes) !== 1) throw new RevisionConflictError("The quiz grader workflow claim is stale");
          return { requestId: String(row.request_id), quizId: binding.quizId };
        }
        const startedMs = typeof row.started_at === "string" ? Date.parse(row.started_at) : Number.NaN;
        if (!Number.isFinite(startedMs) || nowMs - startedMs >= QUIZ_GRADER_LEASE_MS) {
          const expected = quizGraderPayload(quiz);
          const reclaimed = this.db.run(
            "UPDATE workflows SET status = 'queued', started_at = NULL, finished_at = NULL, progress = 0, message = ?, error_code = NULL, error_message = NULL WHERE request_id = ? AND kind = 'quiz-grader' AND status = 'running' AND message = ?",
            [JSON.stringify(expected), row.request_id, row.message],
          );
          if (Number(reclaimed.changes) !== 1)
            throw new RevisionConflictError("The stale quiz grader workflow claim is stale");
        } else {
          occupiedQuizIds.add(binding.quizId);
        }
      }
      const quizzes = this.db.all<Record<string, unknown>>(
        date
          ? "SELECT q.quiz_id, q.date, q.revision FROM quizzes q WHERE q.date = ? AND q.status = 'submitted' AND NOT EXISTS (SELECT 1 FROM page_results p WHERE p.quiz_id = q.quiz_id) ORDER BY q.submitted_at, q.quiz_id"
          : "SELECT q.quiz_id, q.date, q.revision FROM quizzes q WHERE q.status = 'submitted' AND NOT EXISTS (SELECT 1 FROM page_results p WHERE p.quiz_id = q.quiz_id) ORDER BY q.submitted_at, q.quiz_id",
        date ? [date] : [],
      );
      const quiz = quizzes.find((candidate) => !occupiedQuizIds.has(String(candidate.quiz_id)));
      if (!quiz) return undefined;
      const quizId = String(quiz.quiz_id);
      const quizDate = String(quiz.date);
      const revision = Number(quiz.revision);
      const expected = quizGraderPayload({ date: quizDate, quizId, revision });
      const workflow = this.db
        .all<Record<string, unknown>>(
          "SELECT request_id, message FROM workflows WHERE kind = 'quiz-grader' AND status = 'queued' ORDER BY rowid",
        )
        .find((row) => {
          const payload = parseQuizGraderPayload(row.message);
          return (
            payload?.date === expected.date &&
            payload.revision === expected.revision &&
            payload.submissionId === expected.submissionId
          );
        });
      const requestId = workflow ? String(workflow.request_id) : randomUUID();
      if (!workflow) {
        this.workflows.queueInTransaction("quiz-grader", requestId, `${expected.submissionId}:retry:${requestId}`);
        this.db.run(
          "UPDATE workflows SET message = ? WHERE request_id = ? AND kind = 'quiz-grader' AND status = 'queued'",
          [JSON.stringify(expected), requestId],
        );
      }
      const result = this.db.run(
        "UPDATE workflows SET status = 'running', started_at = ?, progress = 0, message = ?, error_code = NULL, error_message = NULL WHERE request_id = ? AND kind = 'quiz-grader' AND status = 'queued'",
        [now, quizGraderBindingText(quizId, ownerHash), requestId],
      );
      if (Number(result.changes) !== 1) throw new RevisionConflictError("The quiz grader workflow claim is stale");
      return { requestId, quizId };
    });
  }
  private async failGradingWorkflow(requestId: string, error: unknown, ownerHash: string): Promise<void> {
    const message = errorMessage(error).slice(0, 500);
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "QUIZ_GRADING_FAILED";
    await this.durableDirect(() => {
      transaction(this.db, () => {
        const workflow = this.db.get<Record<string, unknown>>(
          "SELECT message FROM workflows WHERE request_id = ? AND kind = 'quiz-grader' AND status = 'running'",
          [requestId],
        );
        const binding = parseQuizGraderBinding(workflow?.message);
        if (!binding || binding.ownerHash !== ownerHash) return;
        this.db.run(
          "UPDATE workflows SET status = 'failed', finished_at = ?, progress = 0, message = NULL, error_code = ?, error_message = ? WHERE request_id = ? AND kind = 'quiz-grader' AND status = 'running' AND message = ?",
          [new Date().toISOString(), code, message, requestId, quizGraderBindingText(binding.quizId, ownerHash)],
        );
      });
    }, "quiz:grade-failure");
  }
  async getGradingContext(input: { readonly date?: string } = {}, ownerToken?: string): Promise<GradingContext> {
    if (!isRecord(input)) throw new ValidationError("grading context must be an object");
    exact(input, ["date"], "grading context");
    const date = input.date === undefined ? undefined : localDate(requiredString(input, "date"));
    const ownerHash = sha256(ownerToken ?? randomUUID());
    let binding: { requestId: string; quizId: string } | undefined;
    try {
      binding = await this.durableDirect(() => this.claimGradingWorkflow(date, ownerHash), "quiz:grade-claim");
      if (!binding) return { date: date ?? (await this.currentLocalDate()) };
      const quiz = this.quiz.get(binding.quizId);
      if (!quiz || (date !== undefined && quiz.date !== date) || quiz.status !== "submitted")
        throw new QuizConflictError("The sealed quiz disappeared before grading");
      return this.gradingContextFor(quiz.date, binding.requestId, quiz);
    } catch (error) {
      if (binding) await this.failGradingWorkflow(binding.requestId, error, ownerHash);
      throw error;
    }
  }
  async settleGrade(input: GradeSettlementInput, ownerToken?: string): Promise<GradingResult> {
    const decoded = decodeGrade(input);
    const proposal = { ...decoded, date: localDate(decoded.date) };
    let owned = false;
    try {
      return await this.durableDirect(async () => {
        const workflow = this.db.get<Record<string, unknown>>("SELECT * FROM workflows WHERE request_id = ?", [
          proposal.requestId,
        ]);
        if (!workflow || String(workflow.kind) !== "quiz-grader")
          throw new QuizConflictError("The grading workflow is unknown");
        const status = String(workflow.status);
        const binding = parseQuizGraderBinding(workflow.message);
        if (!binding) throw new QuizConflictError("The grading workflow is not bound to a sealed submission");
        const ownerHash = sha256(ownerToken ?? "");
        if (binding.ownerHash !== ownerHash)
          throw new QuizConflictError("The grading workflow belongs to another grader");
        const quizId = binding.quizId;
        const quiz = this.quiz.get(quizId);
        if (!quiz || quiz.date !== proposal.date || quiz.status !== "submitted")
          throw new QuizConflictError("The sealed quiz is not available for grading");
        if (proposal.submissionId !== gradingSubmissionId(quiz))
          throw new RevisionConflictError("The sealed submission identity is stale");
        if (proposal.revision !== quiz.revision) throw new RevisionConflictError("The sealed quiz revision is stale");
        if (status === "succeeded") {
          const settled = this.quiz.readSettledResult(quiz);
          if (!settled) throw new QuizConflictError("The succeeded grading workflow has no committed result");
          if (
            gradingReplayKey(proposal.questions, proposal.pages) !== gradingReplayKey(settled.questions, settled.pages)
          )
            throw new QuizConflictError("The grading replay does not match the committed result");
          const detail = await this.quizDetail(settled.quiz);
          return { quiz: detail, questions: settled.questions, pages: settled.pages };
        }
        if (status !== "running") throw new QuizConflictError("The grading workflow is not running");
        owned = true;
        const settled = this.quiz.settleGrade(
          {
            date: proposal.date,
            revision: proposal.revision,
            submissionId: proposal.submissionId,
            questions: proposal.questions,
            pages: proposal.pages,
          },
          (persisted) => {
            const result = this.db.run(
              "UPDATE workflows SET status = 'succeeded', finished_at = ?, progress = 1, error_code = NULL, error_message = NULL WHERE request_id = ? AND kind = 'quiz-grader' AND status = 'running' AND message = ?",
              [new Date().toISOString(), proposal.requestId, quizGraderBindingText(quiz.quizId, ownerHash)],
            );
            if (Number(result.changes) !== 1) throw new RevisionConflictError("The grading workflow claim is stale");
            if (persisted.quiz.quizId !== quiz.quizId || persisted.quiz.revision !== quiz.revision)
              throw new RevisionConflictError("The sealed quiz identity changed during grading");
          },
        );
        const detail = await this.quizDetail(settled.quiz);
        return { quiz: detail, questions: settled.questions, pages: settled.pages };
      }, "quiz:grade");
    } catch (error) {
      if (owned) await this.failGradingWorkflow(proposal.requestId, error, sha256(ownerToken ?? ""));
      throw error;
    }
  }
}

export function createApplication(input: ApplicationOptions | VaultPaths | string): ScholarApplication {
  if (typeof input === "string") return new ScholarApplication({ paths: input });
  if ("vaultRoot" in input && "databasePath" in input) return new ScholarApplication({ paths: input });
  return new ScholarApplication(input);
}
export function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return isRecord(value) && typeof value.ok === "boolean";
}
