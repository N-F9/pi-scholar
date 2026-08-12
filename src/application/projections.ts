import type {
  PageRecord,
  PublicQuizDetailRecord,
  PublicQuizRecord,
  PublicSourceRecord,
  QuizAnswerInput,
  QuizDetailRecord,
  QuizRecord,
  SourceRecord,
  WikiIssueRecord,
  WorkflowRecord,
} from "../contracts.js";
import type { WikiPage } from "../wiki.js";

export function sourceRecord(value: Record<string, unknown>): SourceRecord {
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

export function publicSource(source: SourceRecord): PublicSourceRecord {
  const { manifestPath: _manifestPath, errorMessage: _errorMessage, ...record } = source;
  return record;
}

export type PublicWorkflowRecord = Omit<WorkflowRecord, "message" | "errorMessage"> & { readonly message?: string };

export function publicWorkflow(workflow: WorkflowRecord): PublicWorkflowRecord {
  const { errorMessage: _errorMessage, ...withoutErrorMessage } = workflow;
  if (workflow.kind !== "quiz-grader") return withoutErrorMessage;
  const { message: _message, ...record } = withoutErrorMessage;
  return record;
}

export function pageRecord(value: WikiPage): PageRecord {
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

export function recordToIssue(row: Record<string, unknown>): WikiIssueRecord {
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

export function answersObject(answers: readonly QuizAnswerInput[]): Record<string, string | readonly string[]> {
  const result: Record<string, string | readonly string[]> = {};
  for (const answer of answers) result[answer.questionId] = answer.answer;
  return result;
}

export function quizOutcome(
  quiz: QuizRecord | undefined,
): "available" | "submitted" | "expired" | "skipped" | "failed" | "not-yet-run" | "maintenance-day" {
  if (!quiz) return "not-yet-run";
  return quiz.status === "open" ? "available" : quiz.status;
}

export function publicQuiz(quiz: QuizRecord): PublicQuizRecord {
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

export function publicQuizDetail(quiz: QuizDetailRecord): PublicQuizDetailRecord {
  return {
    ...publicQuiz(quiz),
    answers: quiz.answers,
    questionResults: quiz.questionResults,
    pageResults: quiz.pageResults,
    grades: quiz.grades,
    readings: quiz.readings,
  };
}
