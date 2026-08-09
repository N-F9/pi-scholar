/** JSON values crossing a process, HTTP, or durable-artifact boundary. */
 
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type IsoDateTime = string;
export type LocalDate = string;

export type SourceKind =
  | "document"
  | "url"
  | "text"
  | "note"
  | "code"
  | "directory"
  | "repository";

export type SourceStatus =
  | "pending"
  | "claimed"
  | "processing"
  | "published"
  | "failed"
  | "removed";

export interface SourceRequest {
  readonly kind: SourceKind;
  readonly displayName?: string;
  readonly path?: string;
  readonly url?: string;
  readonly text?: string;
  readonly mediaType?: string;
}

export interface SourceFileEntry {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly mediaType?: string;
}

export interface SourceChunk {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly ordinal: number;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly atomStart: number;
  readonly atomEnd: number;
}

export interface SourceManifest {
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly displayName: string;
  readonly originalName?: string;
  readonly sourceUri?: string;
  readonly repositoryRevision?: string;
  readonly mediaType?: string;
  readonly capturedAt: IsoDateTime;
  readonly converter?: { readonly name: string; readonly version: string };
  readonly originalByteLength: number;
  readonly extractedByteLength: number;
  readonly originalDigest: string;
  readonly extractedDigest: string;
  readonly files: readonly SourceFileEntry[];
  readonly chunks: readonly SourceChunk[];
}

export interface SourceRecord {
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly status: SourceStatus;
  readonly displayName: string;
  readonly originalName?: string;
  readonly sourceUri?: string;
  readonly mediaType?: string;
  readonly repositoryRevision?: string;
  readonly capturedAt?: IsoDateTime;
  readonly digest?: string;
  readonly manifestPath?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export type SourceDependencyRecord =
  | {
      readonly sourceId: string;
      readonly pageId: string;
      readonly chunkId?: string;
      readonly relation: "citation" | "claim" | "question";
    }
  | {
      readonly sourceId: string;
      readonly pageId?: undefined;
      readonly chunkId: string;
      readonly relation: "citation" | "claim" | "question";
    };

export interface PageRecord {
  readonly pageId: string;
  readonly relativePath: string;
  readonly title: string;
  readonly digest: string;
  readonly revision: number;
  readonly status: "active" | "drifted" | "retired";
  readonly quizWorthiness: "eligible" | "skip" | "unknown";
  readonly updatedAt: IsoDateTime;
}

export type WikiPageRecord = PageRecord;

export interface WikiPageSection {
  readonly pageId: string;
  readonly heading?: string;
  readonly anchor: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly textDigest: string;
}

export type WikiIssueKind = "incorrect" | "unclear" | "missing" | "bad-boundary";
export type WikiIssueStatus = "open" | "resolved" | "reopened";

export interface WikiIssueRecord {
  readonly issueId: string;
  readonly pageId?: string;
  readonly heading?: string;
  readonly cardId?: string;
  readonly pageDigest?: string;
  readonly kind: WikiIssueKind;
  readonly description: string;
  readonly status: WikiIssueStatus;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly resolution?: string;
}

export type ReviewCardStatus = "active" | "retired";
export type FsrsState = "New" | "Learning" | "Review" | "Relearning";
export type CardRating = "Again" | "Hard" | "Good" | "Easy";

export interface ReviewCardRecord {
  readonly cardId: string;
  readonly status: ReviewCardStatus;
  readonly prompt?: string;
  readonly initialDueAt: IsoDateTime;
  readonly dueAt: IsoDateTime;
  readonly fsrsState: FsrsState;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly scheduledDays: number;
  readonly lastReviewAt?: IsoDateTime;
  readonly revision: number;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CardBindingRecord {
  readonly bindingId: string;
  readonly cardId: string;
  readonly pageId: string;
  readonly heading?: string;
  readonly anchor: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly textDigest: string;
  readonly revision: number;
  readonly active: boolean;
}

export type ReviewBinding = CardBindingRecord;

export interface CardPrerequisiteRecord {
  readonly cardId: string;
  readonly prerequisiteCardId: string;
}

export type PrerequisiteRecord = CardPrerequisiteRecord;

export type CardLineageEvent = "split" | "merge" | "retire" | "successor";

export interface CardLineageRecord {
  readonly lineageId: string;
  readonly event: CardLineageEvent;
  readonly parentCardIds: readonly string[];
  readonly childCardIds: readonly string[];
  readonly occurredAt: IsoDateTime;
  readonly metadata?: JsonValue;
}

export interface RawReviewRecord {
  readonly reviewId: string;
  readonly cardId: string;
  readonly quizId: string;
  readonly questionId: string;
  readonly answerRevision: number;
  readonly rating: CardRating;
  readonly reviewedAt: IsoDateTime;
  readonly stateBefore: JsonValue;
  readonly stateAfter: JsonValue;
  readonly settlementId: string;
}

export type QuizStatus = "open" | "submitted" | "expired" | "skipped" | "failed";
export type QuizQuestionKind = "short-answer" | "multiple-choice";

export interface QuizQuestionCardRecord {
  readonly cardId: string;
  readonly criterion: string;
  readonly weight: number;
}

export interface QuizQuestionRecord {
  readonly questionId: string;
  readonly quizId: string;
  readonly ordinal: number;
  readonly kind: QuizQuestionKind;
  readonly prompt: string;
  readonly choices?: readonly string[];
  readonly cardIds: readonly string[];
  readonly cards: readonly QuizQuestionCardRecord[];
  readonly sourceRefs: readonly string[];
}

export type QuizQuestion = QuizQuestionRecord;

export interface QuizAnswerInput {
  readonly questionId: string;
  readonly answer: string | readonly string[];
}

export interface QuizAnswerRecord extends QuizAnswerInput {
  readonly quizId: string;
  readonly revision: number;
  readonly savedAt: IsoDateTime;
}

export interface QuizQuestionResultRecord {
  readonly resultId: string;
  readonly quizId: string;
  readonly questionId: string;
  readonly answerRevision: number;
  readonly feedback: string;
  readonly gradedAt: IsoDateTime;
}

export interface QuizCardResultRecord {
  readonly resultId: string;
  readonly quizId: string;
  readonly questionId: string;
  readonly cardId: string;
  readonly rating: CardRating;
  readonly reviewId: string;
}

export interface QuizReadingRecord {
  readonly pageId: string;
  readonly path: string;
  readonly heading?: string;
  readonly href: string;
}

export interface QuizDraftRecord {
  readonly revision: number;
  readonly savedAt: IsoDateTime;
  readonly answers: readonly QuizAnswerInput[];
}

export interface QuizGradeRecord {
  readonly gradeId: string;
  readonly quizId: string;
  readonly questionId: string;
  readonly cardId: string;
  readonly rating: CardRating;
  readonly feedback: string;
  readonly gradedAt: IsoDateTime;
  readonly reviewId?: string;
}


export interface QuizRecord {
  readonly quizId: string;
  readonly date: LocalDate;
  readonly revision: number;
  readonly status: QuizStatus;
  readonly questions: readonly QuizQuestionRecord[];
  readonly answers?: readonly QuizAnswerInput[];
  readonly draft?: QuizDraftRecord;
  readonly questionResults?: readonly QuizQuestionResultRecord[];
  readonly cardResults?: readonly QuizCardResultRecord[];
  readonly grades?: readonly QuizGradeRecord[];
  readonly readings?: readonly QuizReadingRecord[];
  readonly sheetPath?: string;
  readonly generatedAt?: IsoDateTime;
  readonly submittedAt?: IsoDateTime;
}

export interface QuizDetailRecord extends QuizRecord {
  readonly answers: readonly QuizAnswerInput[];
  readonly questionResults: readonly QuizQuestionResultRecord[];
  readonly cardResults: readonly QuizCardResultRecord[];
  readonly grades: readonly QuizGradeRecord[];
  readonly readings: readonly QuizReadingRecord[];
}

export interface WorkflowRecord {
  readonly requestId: string;
  readonly kind: "source-admission" | "wiki-maintenance" | "daily-quiz" | "quiz-grader" | "sync";
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly startedAt?: IsoDateTime;
  readonly finishedAt?: IsoDateTime;
  readonly progress: number;
  readonly message?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface GitStateFacts {
  readonly branch?: string;
  readonly clean: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly diverged: boolean;
  readonly upstream?: string;
  readonly message?: string;
}

export interface SettingsFacts {
  readonly localDate: LocalDate;
  readonly pendingInboxCount: number;
  readonly openIssueCount: number;
  readonly lastMaintenanceAt?: IsoDateTime;
  readonly lastMaintenanceResult?: string;
  readonly recentChanges: readonly string[];
  readonly git: GitStateFacts;
}

export interface SettingsRecord {
  readonly initializationEnabled: boolean;
  readonly timezone: string;
  readonly port: number;
  readonly host: string;
  readonly updatedAt: IsoDateTime;
  readonly facts: SettingsFacts;
}
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
  readonly requestId?: string;
}

export interface ApiSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly requestId?: string;
}

export interface ApiFailure {
  readonly ok: false;
  readonly error: ApiError;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export interface HealthResult {
  readonly status: "ok" | "degraded" | "failed";
  readonly version: string;
  readonly vaultId?: string;
  readonly doctor?: "pass" | "fail";
}

export interface SourceListResult {
  readonly sources: readonly SourceRecord[];
}

export type SourceCreateRequest = SourceRequest;

export interface SourceCreateResult {
  readonly source: SourceRecord;
}

export interface SourceRemovalPreviewRequest {
  readonly sourceId: string;
}

export interface SourceRemovalRequest {
  readonly sourceId: string;
  readonly confirmationId: string;
}

export interface SourceRemovalPreviewResult {
  readonly source: SourceRecord;
  readonly dependentPageIds: readonly string[];
  readonly dependentCardIds: readonly string[];
  readonly confirmationId: string;
}

export interface SourceRemovalResult {
  readonly sourceId: string;
  readonly status: "removed";
  readonly dependentPageIds: readonly string[];
  readonly dependentCardIds: readonly string[];
}

export interface WikiListResult {
  readonly pages: readonly PageRecord[];
}

export interface WikiPageLearningProjection {
  readonly cards: readonly ReviewCardRecord[];
  readonly bindings: readonly CardBindingRecord[];
  readonly prerequisites: readonly CardPrerequisiteRecord[];
  readonly lineage: readonly CardLineageRecord[];
}

export interface WikiDriftResult {
  readonly expectedDigest: string;
  readonly actualDigest: string;
  readonly diff: string;
}

export interface WikiPageResult {
  readonly page: PageRecord;
  readonly markdown: string;
  readonly sections: readonly WikiPageSection[];
  readonly learning: WikiPageLearningProjection;
  readonly drift?: WikiDriftResult;
}

export interface WikiIssueCreateRequest {
  readonly pageId?: string;
  readonly heading?: string;
  readonly cardId?: string;
  readonly pageDigest?: string;
  readonly kind: WikiIssueKind;
  readonly description: string;
}

export interface WikiIssueUpdateRequest {
  readonly status: "resolved" | "reopened";
  readonly resolution?: string;
}

export interface WikiDriftResolutionRequest {
  readonly action: "restore" | "record-issue";
  readonly expectedDigest: string;
  readonly description?: string;
}

export interface WikiIssueListResult {
  readonly issues: readonly WikiIssueRecord[];
}

export type QuizOutcome = "available" | "submitted" | "expired" | "skipped" | "failed" | "not-yet-run" | "maintenance-day";

export interface QuizListResult {
  readonly quizzes: readonly QuizRecord[];
}
export interface QuizResult {
  readonly quiz?: QuizDetailRecord;
  readonly outcome: QuizOutcome;
  readonly answers: readonly QuizAnswerInput[];
  readonly grades: readonly QuizGradeRecord[];
  readonly readings: readonly QuizReadingRecord[];
  readonly message?: string;
}

export interface QuizAnswersRequest {
  readonly expectedRevision: number;
  readonly answers: readonly QuizAnswerInput[];
}

export interface QuizAnswersResult {
  readonly revision: number;
  readonly savedAt: IsoDateTime;
  readonly answers: readonly QuizAnswerInput[];
}

export interface QuizSubmissionRequest {
  readonly expectedRevision: number;
}

export interface QuizSubmissionResult {
  readonly status: "sealed";
  readonly workflow: WorkflowRecord;
  readonly quiz: QuizDetailRecord;
  readonly grades: readonly QuizGradeRecord[];
  readonly readings: readonly QuizReadingRecord[];
}

export interface WorkflowListResult {
  readonly workflows: readonly WorkflowRecord[];
}

export interface WorkflowSubmitRequest {
  readonly kind: WorkflowRecord["kind"];
}

export interface WorkflowResult {
  readonly workflow: WorkflowRecord;
}

export interface SettingsResult {
  readonly settings: SettingsRecord;
}

export interface SettingsUpdateRequest {
  readonly initializationEnabled?: boolean;
  readonly timezone?: string;
  readonly port?: number;
  readonly host?: string;
}

export interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly message: string;
  readonly details?: JsonValue;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checkedAt: IsoDateTime;
  readonly checks: readonly DoctorCheck[];
}

export const API_VERSION = "v1" as const;
