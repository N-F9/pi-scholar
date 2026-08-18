import type {
  HealthResult,
  JsonValue,
  PublicQuizDetailRecord,
  PublicQuizQuestionRecord,
  PublicQuizRecord,
  PublicSourceRecord,
  PublicWorkflowRecord,
  QuizAnswersResult,
  QuizListResult,
  QuizResult,
  QuizSubmissionResult,
  SettingsResult,
  SourceCreateResult,
  SourceListResult,
  SourceRemovalPreviewResult,
  SourceRemovalResult,
  WikiIssueListResult,
  WikiListResult,
  WikiPageResult,
  WorkflowListResult,
} from "../../../src/contracts";
export class ApiRequestError extends Error {
  readonly code: string;
  readonly details?: JsonValue;
  readonly status: number;

  constructor(message: string, code: string, status: number, details?: JsonValue) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export type ResultGuard<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
const QUESTION_KINDS = ["free-response", "multiple-choice"] as const;
const SOURCE_KINDS = ["document", "url", "text", "note", "code", "directory", "repository"] as const;
const SOURCE_STATUSES = ["pending", "claimed", "processing", "published", "failed", "removed"] as const;
const PAGE_STATUSES = ["active", "drifted", "retired"] as const;
const QUIZ_WORTHINESS = ["eligible", "skip", "unknown"] as const;
const QUIZ_STATUSES = ["open", "submitted", "expired", "skipped", "failed"] as const;
const ISSUE_KINDS = ["incorrect", "unclear", "missing", "bad-boundary"] as const;
const ISSUE_STATUSES = ["open", "resolved", "reopened"] as const;
const FSRS_STATES = ["New", "Learning", "Review", "Relearning"] as const;
const REVIEW_RATINGS = ["Again", "Hard", "Good", "Easy"] as const;
const RECOMMENDATION_REASONS = ["prerequisite", "related"] as const;
const RECOMMENDATION_GAP_KINDS = ["missing", "unclear", "drifted"] as const;
const WORKFLOW_KINDS = ["extract", "ingest", "lint", "daily", "quiz-grader", "sync"] as const;
const WORKFLOW_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
function isEnum(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isAnswer(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) => ["questionId", "answer"].includes(field)) &&
    typeof value.questionId === "string" &&
    (typeof value.answer === "string" || isStringArray(value.answer))
  );
}
function isQuestion(value: unknown): value is PublicQuizQuestionRecord {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) =>
      ["questionId", "quizId", "ordinal", "kind", "prompt", "choices"].includes(field),
    ) &&
    hasStrings(value, ["questionId", "quizId", "kind", "prompt"]) &&
    isEnum(value.kind, QUESTION_KINDS) &&
    typeof value.ordinal === "number" &&
    (value.choices === undefined || isStringArray(value.choices))
  );
}

function isReading(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) => ["pageId", "path", "heading", "href"].includes(field)) &&
    hasStrings(value, ["pageId", "path", "href"]) &&
    (value.heading === undefined || typeof value.heading === "string")
  );
}
function isRecommendations(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) => ["readings", "gaps"].includes(field)) &&
    Array.isArray(value.readings) &&
    value.readings.every(
      (reading) =>
        isRecord(reading) &&
        Object.keys(reading).every((field) => ["pageId", "path", "title", "href", "reason"].includes(field)) &&
        hasStrings(reading, ["pageId", "path", "title", "href", "reason"]) &&
        isEnum(reading.reason, RECOMMENDATION_REASONS),
    ) &&
    Array.isArray(value.gaps) &&
    value.gaps.every(
      (gap) =>
        isRecord(gap) &&
        Object.keys(gap).every((field) => ["pageId", "path", "title", "href", "kind"].includes(field)) &&
        hasStrings(gap, ["pageId", "path", "title", "href", "kind"]) &&
        isEnum(gap.kind, RECOMMENDATION_GAP_KINDS),
    )
  );
}

function isQuestionResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) =>
      ["resultId", "quizId", "questionId", "answerRevision", "feedback", "gradedAt"].includes(field),
    ) &&
    hasStrings(value, ["resultId", "quizId", "questionId", "feedback", "gradedAt"]) &&
    typeof value.answerRevision === "number"
  );
}

function isPageResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) =>
      ["resultId", "quizId", "pageId", "pageLink", "rating", "feedback", "reviewId", "evidence", "readings"].includes(
        field,
      ),
    ) &&
    hasStrings(value, ["resultId", "quizId", "pageId", "rating", "feedback", "reviewId"]) &&
    isReading(value.pageLink) &&
    isEnum(value.rating, REVIEW_RATINGS) &&
    isStringArray(value.evidence) &&
    Array.isArray(value.readings) &&
    value.readings.every(isReading)
  );
}

function isGrade(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) =>
      ["gradeId", "quizId", "pageId", "rating", "feedback", "gradedAt", "reviewId"].includes(field),
    ) &&
    hasStrings(value, ["gradeId", "quizId", "pageId", "rating", "feedback", "gradedAt"]) &&
    isEnum(value.rating, REVIEW_RATINGS) &&
    (value.reviewId === undefined || typeof value.reviewId === "string")
  );
}

function isLearning(value: unknown): value is WikiPageResult["learning"] {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((field) => ["schedule", "prerequisites"].includes(field)) ||
    !Array.isArray(value.prerequisites) ||
    !value.prerequisites.every(
      (edge) =>
        isRecord(edge) &&
        Object.keys(edge).every((field) => ["pageId", "prerequisitePageId"].includes(field)) &&
        hasStrings(edge, ["pageId", "prerequisitePageId"]),
    )
  )
    return false;
  if (value.schedule === undefined) return true;
  return (
    isRecord(value.schedule) &&
    Object.keys(value.schedule).every((field) =>
      [
        "pageId",
        "initialDueAt",
        "dueAt",
        "fsrsState",
        "stability",
        "difficulty",
        "reps",
        "lapses",
        "scheduledDays",
        "lastReviewAt",
        "revision",
        "createdAt",
        "updatedAt",
      ].includes(field),
    ) &&
    hasStrings(value.schedule, ["pageId", "initialDueAt", "dueAt", "fsrsState", "createdAt", "updatedAt"]) &&
    isEnum(value.schedule.fsrsState, FSRS_STATES) &&
    ["stability", "difficulty", "reps", "lapses", "scheduledDays", "revision"].every(
      (field) => typeof (value.schedule as Record<string, unknown>)[field] === "number",
    ) &&
    (value.schedule.lastReviewAt === undefined || typeof value.schedule.lastReviewAt === "string")
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isSource(value: unknown): value is PublicSourceRecord {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) =>
      [
        "sourceId",
        "kind",
        "status",
        "displayName",
        "originalName",
        "sourceUri",
        "mediaType",
        "repositoryRevision",
        "capturedAt",
        "digest",
        "errorCode",
        "createdAt",
        "updatedAt",
      ].includes(field),
    ) &&
    hasStrings(value, ["sourceId", "kind", "status", "displayName", "createdAt", "updatedAt"]) &&
    isEnum(value.kind, SOURCE_KINDS) &&
    isEnum(value.status, SOURCE_STATUSES)
  );
}

function isPage(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) =>
      ["pageId", "relativePath", "title", "digest", "revision", "status", "quizWorthiness", "updatedAt"].includes(
        field,
      ),
    ) &&
    hasStrings(value, ["pageId", "relativePath", "title", "digest", "status", "quizWorthiness", "updatedAt"]) &&
    isEnum(value.status, PAGE_STATUSES) &&
    isEnum(value.quizWorthiness, QUIZ_WORTHINESS) &&
    typeof value.revision === "number"
  );
}

function isQuiz(value: unknown): value is PublicQuizRecord {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) =>
      [
        "quizId",
        "date",
        "revision",
        "status",
        "questions",
        "answers",
        "draft",
        "questionResults",
        "pageResults",
        "grades",
        "readings",
        "generatedAt",
        "submittedAt",
      ].includes(field),
    ) &&
    hasStrings(value, ["quizId", "date", "status"]) &&
    isEnum(value.status, QUIZ_STATUSES) &&
    typeof value.revision === "number" &&
    Array.isArray(value.questions) &&
    value.questions.every(isQuestion) &&
    (value.answers === undefined || (Array.isArray(value.answers) && value.answers.every(isAnswer))) &&
    (value.questionResults === undefined ||
      (Array.isArray(value.questionResults) && value.questionResults.every(isQuestionResult))) &&
    (value.pageResults === undefined || (Array.isArray(value.pageResults) && value.pageResults.every(isPageResult))) &&
    (value.grades === undefined || (Array.isArray(value.grades) && value.grades.every(isGrade))) &&
    (value.readings === undefined || (Array.isArray(value.readings) && value.readings.every(isReading))) &&
    (value.draft === undefined ||
      (isRecord(value.draft) &&
        Object.keys(value.draft).every((field) => ["revision", "savedAt", "answers"].includes(field)) &&
        typeof value.draft.revision === "number" &&
        typeof value.draft.savedAt === "string" &&
        Array.isArray(value.draft.answers) &&
        value.draft.answers.every(isAnswer)))
  );
}

function isQuizDetail(value: unknown): value is PublicQuizDetailRecord {
  return (
    isQuiz(value) &&
    Array.isArray(value.answers) &&
    value.answers.every(isAnswer) &&
    Array.isArray(value.questionResults) &&
    value.questionResults.every(isQuestionResult) &&
    Array.isArray(value.pageResults) &&
    value.pageResults.every(isPageResult) &&
    Array.isArray(value.grades) &&
    value.grades.every(isGrade) &&
    Array.isArray(value.readings) &&
    value.readings.every(isReading)
  );
}

function isWorkflow(value: unknown): value is PublicWorkflowRecord {
  return (
    isRecord(value) &&
    Object.keys(value).every((field) =>
      ["requestId", "kind", "status", "startedAt", "finishedAt", "progress", "message", "errorCode"].includes(field),
    ) &&
    hasStrings(value, ["requestId", "kind", "status"]) &&
    isEnum(value.kind, WORKFLOW_KINDS) &&
    isEnum(value.status, WORKFLOW_STATUSES) &&
    typeof value.progress === "number" &&
    (value.startedAt === undefined || typeof value.startedAt === "string") &&
    (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.errorCode === undefined || typeof value.errorCode === "string")
  );
}

export const isHealthResult: ResultGuard<HealthResult> = (value): value is HealthResult =>
  isRecord(value) &&
  hasStrings(value, ["status", "version"]) &&
  ["ok", "degraded", "failed"].includes(String(value.status));

export const isSourceListResult: ResultGuard<SourceListResult> = (value): value is SourceListResult =>
  isRecord(value) && Array.isArray(value.sources) && value.sources.every(isSource);

export const isSourceCreateResult: ResultGuard<SourceCreateResult> = (value): value is SourceCreateResult =>
  isRecord(value) && isSource(value.source);

export const isSourceRemovalPreviewResult: ResultGuard<SourceRemovalPreviewResult> = (
  value,
): value is SourceRemovalPreviewResult =>
  isRecord(value) &&
  Object.keys(value).every((field) => ["source", "dependentPageIds", "confirmationId"].includes(field)) &&
  isSource(value.source) &&
  typeof value.confirmationId === "string" &&
  isStringArray(value.dependentPageIds);

export const isSourceRemovalResult: ResultGuard<SourceRemovalResult> = (value): value is SourceRemovalResult =>
  isRecord(value) &&
  Object.keys(value).every((field) => ["sourceId", "status", "dependentPageIds"].includes(field)) &&
  hasStrings(value, ["sourceId", "status"]) &&
  value.status === "removed" &&
  isStringArray(value.dependentPageIds);

export const isWikiListResult: ResultGuard<WikiListResult> = (value): value is WikiListResult =>
  isRecord(value) && Array.isArray(value.pages) && value.pages.every(isPage);

export const isWikiPageResult: ResultGuard<WikiPageResult> = (value): value is WikiPageResult =>
  isRecord(value) &&
  Object.keys(value).every((field) => ["page", "markdown", "sections", "learning", "drift"].includes(field)) &&
  isPage(value.page) &&
  typeof value.markdown === "string" &&
  Array.isArray(value.sections) &&
  value.sections.every(
    (section) =>
      isRecord(section) &&
      typeof section.anchor === "string" &&
      (section.heading === undefined || typeof section.heading === "string"),
  ) &&
  isLearning(value.learning) &&
  (value.drift === undefined ||
    (isRecord(value.drift) && hasStrings(value.drift, ["expectedDigest", "actualDigest", "diff"])));

export const isWikiIssueListResult: ResultGuard<WikiIssueListResult> = (value): value is WikiIssueListResult =>
  isRecord(value) &&
  Array.isArray(value.issues) &&
  value.issues.every(
    (issue) =>
      isRecord(issue) &&
      Object.keys(issue).every((field) =>
        [
          "issueId",
          "pageId",
          "heading",
          "pageDigest",
          "kind",
          "description",
          "status",
          "createdAt",
          "updatedAt",
          "resolution",
        ].includes(field),
      ) &&
      hasStrings(issue, ["issueId", "kind", "description", "status", "createdAt", "updatedAt"]) &&
      isEnum(issue.kind, ISSUE_KINDS) &&
      isEnum(issue.status, ISSUE_STATUSES),
  );

export const isQuizListResult: ResultGuard<QuizListResult> = (value): value is QuizListResult =>
  isRecord(value) && Array.isArray(value.quizzes) && value.quizzes.every(isQuiz);

export const isQuizResult: ResultGuard<QuizResult> = (value): value is QuizResult =>
  isRecord(value) &&
  Object.keys(value).every((field) =>
    ["quiz", "outcome", "answers", "grades", "readings", "recommendations", "message"].includes(field),
  ) &&
  typeof value.outcome === "string" &&
  ["available", "submitted", "expired", "skipped", "failed", "not-yet-run", "maintenance-day"].includes(
    value.outcome,
  ) &&
  Array.isArray(value.answers) &&
  value.answers.every(isAnswer) &&
  Array.isArray(value.grades) &&
  value.grades.every(isGrade) &&
  Array.isArray(value.readings) &&
  value.readings.every(isReading) &&
  isRecommendations(value.recommendations) &&
  (value.quiz === undefined || isQuizDetail(value.quiz));

export const isQuizAnswersResult: ResultGuard<QuizAnswersResult> = (value): value is QuizAnswersResult =>
  isRecord(value) &&
  Object.keys(value).every((field) => ["revision", "savedAt", "answers"].includes(field)) &&
  typeof value.revision === "number" &&
  typeof value.savedAt === "string" &&
  Array.isArray(value.answers) &&
  value.answers.every(isAnswer);

export const isQuizSubmissionResult: ResultGuard<QuizSubmissionResult> = (value): value is QuizSubmissionResult =>
  isRecord(value) &&
  Object.keys(value).every((field) =>
    ["status", "workflow", "quiz", "grades", "readings", "recommendations"].includes(field),
  ) &&
  value.status === "sealed" &&
  isWorkflow(value.workflow) &&
  isQuizDetail(value.quiz) &&
  Array.isArray(value.grades) &&
  value.grades.every(isGrade) &&
  Array.isArray(value.readings) &&
  value.readings.every(isReading) &&
  isRecommendations(value.recommendations);

export const isWorkflowListResult: ResultGuard<WorkflowListResult> = (value): value is WorkflowListResult =>
  isRecord(value) && Array.isArray(value.workflows) && value.workflows.every(isWorkflow);

export const isSettingsResult: ResultGuard<SettingsResult> = (value): value is SettingsResult =>
  isRecord(value) &&
  Object.keys(value).every((field) => ["settings", "developerToolsEnabled"].includes(field)) &&
  typeof value.developerToolsEnabled === "boolean" &&
  isRecord(value.settings) &&
  Object.keys(value.settings).every((field) =>
    ["maintenanceEnabled", "simulatedDate", "timezone", "host", "port", "updatedAt", "facts"].includes(field),
  ) &&
  typeof value.settings.maintenanceEnabled === "boolean" &&
  (value.settings.simulatedDate === undefined || isLocalDate(value.settings.simulatedDate)) &&
  hasStrings(value.settings, ["timezone", "host", "updatedAt"]) &&
  typeof value.settings.port === "number" &&
  isRecord(value.settings.facts) &&
  Object.keys(value.settings.facts).every((field) =>
    [
      "localDate",
      "pendingInboxCount",
      "openIssueCount",
      "lastIngestAt",
      "lastIngestResult",
      "lastLintAt",
      "lastLintResult",
      "recentChanges",
      "git",
    ].includes(field),
  ) &&
  isLocalDate(value.settings.facts.localDate) &&
  typeof value.settings.facts.pendingInboxCount === "number" &&
  typeof value.settings.facts.openIssueCount === "number" &&
  (value.settings.facts.lastIngestAt === undefined || typeof value.settings.facts.lastIngestAt === "string") &&
  (value.settings.facts.lastIngestResult === undefined || typeof value.settings.facts.lastIngestResult === "string") &&
  (value.settings.facts.lastLintAt === undefined || typeof value.settings.facts.lastLintAt === "string") &&
  (value.settings.facts.lastLintResult === undefined || typeof value.settings.facts.lastLintResult === "string") &&
  isStringArray(value.settings.facts.recentChanges) &&
  isRecord(value.settings.facts.git) &&
  Object.keys(value.settings.facts.git).every((field) =>
    ["branch", "clean", "ahead", "behind", "diverged", "upstream", "message"].includes(field),
  ) &&
  (value.settings.facts.git.branch === undefined || typeof value.settings.facts.git.branch === "string") &&
  typeof value.settings.facts.git.clean === "boolean" &&
  typeof value.settings.facts.git.ahead === "number" &&
  typeof value.settings.facts.git.behind === "number" &&
  typeof value.settings.facts.git.diverged === "boolean" &&
  (value.settings.facts.git.upstream === undefined || typeof value.settings.facts.git.upstream === "string") &&
  (value.settings.facts.git.message === undefined || typeof value.settings.facts.git.message === "string");

export async function api<T>(
  path: `/api/v1/${string}` | "/healthz",
  init?: RequestInit,
  guard?: ResultGuard<T>,
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (method !== "GET" && method !== "HEAD") headers.set("X-Pi-Scholar-Request", "1");
  const response = await fetch(path, { ...init, headers });
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
    throw new ApiRequestError("The server returned a non-JSON response.", "invalid-response", response.status);
  }

  let envelope: unknown;
  try {
    envelope = await response.clone().json();
  } catch {
    throw new ApiRequestError("The server returned malformed JSON.", "invalid-response", response.status);
  }
  if (
    !isRecord(envelope) ||
    typeof envelope.ok !== "boolean" ||
    (envelope.requestId !== undefined && typeof envelope.requestId !== "string")
  ) {
    throw new ApiRequestError("The server returned a malformed API envelope.", "invalid-response", response.status);
  }
  if (!envelope.ok) {
    if (
      !isRecord(envelope.error) ||
      typeof envelope.error.code !== "string" ||
      typeof envelope.error.message !== "string" ||
      (envelope.error.requestId !== undefined && typeof envelope.error.requestId !== "string") ||
      (envelope.error.details !== undefined && !isJsonValue(envelope.error.details))
    ) {
      throw new ApiRequestError("The server returned a malformed API error.", "invalid-response", response.status);
    }
    throw new ApiRequestError(
      envelope.error.message,
      envelope.error.code,
      response.status,
      isJsonValue(envelope.error.details) ? envelope.error.details : undefined,
    );
  }
  if (!response.ok)
    throw new ApiRequestError(`Request failed with status ${response.status}`, "http-error", response.status);
  if (!("data" in envelope) || (guard && !guard(envelope.data))) {
    throw new ApiRequestError("The server returned malformed route data.", "invalid-response", response.status);
  }
  return envelope.data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function formatDate(value: string, options?: Intl.DateTimeFormatOptions): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, options ?? { dateStyle: "medium" }).format(date);
}
