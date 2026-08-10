/** JSON values crossing a process, HTTP, or durable-artifact boundary. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type IsoDateTime = string;
export type LocalDate = string;

export type SourceKind = "document" | "url" | "text" | "note" | "code" | "directory" | "repository";

export type SourceStatus = "pending" | "claimed" | "processing" | "published" | "failed" | "removed";

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

export interface IngestSourceChunk extends SourceChunk {
  readonly path: string;
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
  readonly normalizer: { readonly name: "markdown-blank-lines"; readonly version: "1" };
  readonly originalByteLength: number;
  readonly extractedByteLength: number;
  readonly originalDigest: string;
  readonly extractedDigest: string;
  readonly files: readonly SourceFileEntry[];
  readonly attachments: readonly SourceFileEntry[];
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
export type PublicSourceRecord = Omit<SourceRecord, "manifestPath">;
export interface PreparedAdmissionFile {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly digest: string;
}

export interface PreparedAdmissionAtom {
  readonly index: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly byteLength: number;
  readonly startLine: number;
  readonly endLine: number;
}

export interface PreparedAdmission {
  readonly preparedId: string;
  readonly claimId: string;
  readonly kind: SourceKind;
  readonly displayName: string;
  readonly digest: string;
  readonly snapshotPath: string;
  readonly extractedPath: string;
  readonly files: readonly PreparedAdmissionFile[];
  readonly atoms: readonly PreparedAdmissionAtom[];
}

export interface ExtractClaimRecord extends PreparedAdmission {
  readonly relativePath: string;
  readonly originalName?: string;
  readonly sourceUri?: string;
  readonly mediaType?: string;
  readonly revision?: string;
  readonly byteLength: number;
  readonly identity: {
    readonly device: string;
    readonly inode: string;
    readonly mode: number;
    readonly size: number;
    readonly mtimeNs: string;
  };
}
export interface ExtractFailureRecord {
  readonly relativePath: string;
  readonly errorCode: string;
  readonly errorMessage: string;
}
export interface ExtractContext {
  readonly claims: readonly PreparedAdmission[];
  readonly failures?: readonly ExtractFailureRecord[];
}
export interface ExtractPublicationInput {
  readonly claimId: string;
  readonly preparedId: string;
  readonly digest: string;
  readonly endpoints: readonly number[];
}
export interface ExtractPublicationResult {
  readonly sourceId: string;
  readonly manifest: SourceManifest;
  readonly removedInbox: boolean;
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
  readonly pageDigest?: string;
  readonly kind: WikiIssueKind;
  readonly description: string;
  readonly status: WikiIssueStatus;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly resolution?: string;
}

export type ReviewRating = "Again" | "Hard" | "Good" | "Easy";
export type FsrsState = "New" | "Learning" | "Review" | "Relearning";

export interface PageLearningRecord {
  readonly pageId: string;
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

export interface PagePrerequisiteRecord {
  readonly pageId: string;
  readonly prerequisitePageId: string;
}

export interface PageReviewRecord {
  readonly reviewId: string;
  readonly pageId: string;
  readonly quizId: string;
  readonly submissionId: string;
  readonly revision: number;
  readonly rating: ReviewRating;
  readonly reviewedAt: IsoDateTime;
  readonly stateBefore: JsonValue;
  readonly stateAfter: JsonValue;
  readonly settlementId: string;
}

export interface WikiChangeIssuePageInput {
  readonly pageId: string;
  readonly expectedDigest: string;
  readonly title?: string;
  readonly body?: string;
  readonly quizWorthiness?: PageRecord["quizWorthiness"];
}

export type WikiChangeInput =
  | {
      readonly kind: "create-page";
      readonly path: string;
      readonly title?: string;
      readonly body: string;
      readonly quizWorthiness?: PageRecord["quizWorthiness"];
    }
  | {
      readonly kind: "update-page";
      readonly pageId: string;
      readonly expectedDigest: string;
      readonly title?: string;
      readonly body?: string;
      readonly quizWorthiness?: PageRecord["quizWorthiness"];
    }
  | { readonly kind: "rename-page"; readonly pageId: string; readonly expectedDigest: string; readonly path: string }
  | { readonly kind: "retire-page"; readonly pageId: string; readonly expectedDigest: string }
  | {
      readonly kind: "prerequisites";
      readonly pageId: string;
      readonly expectedRevision?: number;
      readonly prerequisitePageIds: readonly string[];
    }
  | {
      readonly kind: "resolve-issue";
      readonly issueId: string;
      readonly page: WikiChangeIssuePageInput;
      readonly resolution: string;
    };

export interface IngestSourceContext {
  readonly source: SourceRecord;
  readonly manifest: SourceManifest;
  readonly packetPath: string;
  readonly chunks: readonly IngestSourceChunk[];
}

export interface IngestContext {
  readonly pages: readonly WikiPageResult[];
  readonly issues: readonly WikiIssueRecord[];
  readonly sources: readonly IngestSourceContext[];
}

export interface LintContext {
  readonly scope: { readonly kind: "full" } | { readonly kind: "targeted"; readonly description: string };
  readonly pages: readonly WikiPageResult[];
  readonly issues: readonly WikiIssueRecord[];
}

export interface WikiChangeResult {
  readonly kind: WikiChangeInput["kind"];
  readonly page?: PageRecord;
  readonly pageLearning?: PageLearningRecord;
  readonly prerequisites?: readonly PagePrerequisiteRecord[];
  readonly issue?: WikiIssueRecord;
  readonly checks?: { readonly lint: readonly string[]; readonly doctor: DoctorReport };
}

export type QuizStatus = "open" | "submitted" | "expired" | "skipped" | "failed";
export type QuizQuestionKind = "short-answer" | "multiple-choice";

export interface QuizQuestionPageRecord {
  readonly pageId: string;
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
  readonly pages: readonly QuizQuestionPageRecord[];
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

export interface QuizReadingRecord {
  readonly pageId: string;
  readonly path: string;
  readonly heading?: string;
  readonly href: string;
}

export interface QuizPageResultRecord {
  readonly resultId: string;
  readonly quizId: string;
  readonly pageId: string;
  readonly rating: ReviewRating;
  readonly feedback: string;
  readonly reviewId: string;
  readonly evidence: readonly string[];
  readonly readings: readonly QuizReadingRecord[];
}

export interface QuizDraftRecord {
  readonly revision: number;
  readonly savedAt: IsoDateTime;
  readonly answers: readonly QuizAnswerInput[];
}

export interface QuizGradeRecord {
  readonly gradeId: string;
  readonly quizId: string;
  readonly pageId: string;
  readonly rating: ReviewRating;
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
  readonly pageResults?: readonly QuizPageResultRecord[];
  readonly grades?: readonly QuizGradeRecord[];
  readonly readings?: readonly QuizReadingRecord[];
  readonly sheetPath?: string;
  readonly generatedAt?: IsoDateTime;
  readonly submittedAt?: IsoDateTime;
}

export interface QuizDetailRecord extends QuizRecord {
  readonly answers: readonly QuizAnswerInput[];
  readonly questionResults: readonly QuizQuestionResultRecord[];
  readonly pageResults: readonly QuizPageResultRecord[];
  readonly grades: readonly QuizGradeRecord[];
  readonly readings: readonly QuizReadingRecord[];
}

export interface PublicQuizQuestionRecord {
  readonly questionId: string;
  readonly quizId: string;
  readonly ordinal: number;
  readonly kind: QuizQuestionKind;
  readonly prompt: string;
  readonly choices?: readonly string[];
}

export type PublicQuizRecord = Omit<QuizRecord, "questions" | "sheetPath"> & {
  readonly questions: readonly PublicQuizQuestionRecord[];
};

export type PublicQuizDetailRecord = Omit<QuizDetailRecord, "questions" | "sheetPath"> & {
  readonly questions: readonly PublicQuizQuestionRecord[];
};

export interface QuizEvidenceRecord {
  readonly reference: string;
  readonly pageId: string;
  readonly path: string;
  readonly anchor: string;
  readonly heading?: string;
  readonly pageDigest: string;
  readonly pageRevision: number;
  readonly textDigest: string;
  readonly excerpt: string;
}

export interface QuizQuestionProposal {
  readonly kind: QuizQuestionKind;
  readonly prompt: string;
  readonly choices?: readonly string[];
  readonly pages: readonly QuizQuestionPageRecord[];
  readonly sourceRefs: readonly string[];
  readonly answerKey?: JsonValue;
}

export type QuizPublicationInput =
  | { readonly status: "published"; readonly date: LocalDate; readonly questions: readonly QuizQuestionProposal[] }
  | { readonly status: "skipped"; readonly date: LocalDate; readonly reason: string };

export interface QuizContext {
  readonly date: LocalDate;
  readonly initializationEnabled: boolean;
  readonly expiredCount: number;
  readonly eligiblePages: readonly PageLearningRecord[];
  readonly evidence: readonly QuizEvidenceRecord[];
  readonly quiz?: QuizDetailRecord;
  readonly message?: string;
}

export interface GradeReadingInput {
  readonly pageId: string;
  readonly anchor: string;
  readonly heading?: string;
}

export interface GradePageInput {
  readonly pageId: string;
  readonly rating: ReviewRating;
  readonly feedback?: string;
  readonly evidence: readonly string[];
  readonly readings?: readonly GradeReadingInput[];
}

export interface GradeQuestionInput {
  readonly questionId: string;
  readonly feedback?: string;
}

export interface GradeSettlementInput {
  readonly requestId: string;
  readonly date: LocalDate;
  readonly revision: number;
  readonly submissionId: string;
  readonly questions: readonly GradeQuestionInput[];
  readonly pages: readonly GradePageInput[];
}

export interface GradingContext {
  readonly date: LocalDate;
  readonly requestId?: string;
  readonly submissionId?: string;
  readonly quiz?: QuizDetailRecord;
  readonly revision?: number;
  readonly evidence?: readonly QuizEvidenceRecord[];
}

export interface GradingResult {
  readonly quiz: QuizDetailRecord;
  readonly questions: readonly {
    readonly questionId: string;
    readonly feedback: string;
  }[];
  readonly pages: readonly (QuizGradeRecord & {
    readonly evidence: readonly string[];
    readonly readings: readonly GradeReadingInput[];
  })[];
}

export interface WorkflowRecord {
  readonly requestId: string;
  readonly kind: "extract" | "ingest" | "lint" | "daily" | "quiz-grader" | "sync";
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
  readonly lastLintAt?: IsoDateTime;
  readonly lastLintResult?: string;
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
  readonly sources: readonly PublicSourceRecord[];
}

export type SourceCreateRequest = SourceRequest;

export interface SourceCreateResult {
  readonly source: PublicSourceRecord;
}

export interface SourceRemovalPreviewRequest {
  readonly sourceId: string;
}

export interface SourceRemovalRequest {
  readonly sourceId: string;
  readonly confirmationId: string;
}

export interface SourceRemovalPreviewResult {
  readonly source: PublicSourceRecord;
  readonly dependentPageIds: readonly string[];
  readonly confirmationId: string;
}

export interface SourceRemovalResult {
  readonly sourceId: string;
  readonly status: "removed";
  readonly dependentPageIds: readonly string[];
}

export interface WikiListResult {
  readonly pages: readonly PageRecord[];
}

export interface WikiPageLearningProjection {
  readonly schedule?: PageLearningRecord;
  readonly prerequisites: readonly PagePrerequisiteRecord[];
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

export type QuizOutcome =
  | "available"
  | "submitted"
  | "expired"
  | "skipped"
  | "failed"
  | "not-yet-run"
  | "maintenance-day";

export interface QuizListResult {
  readonly quizzes: readonly PublicQuizRecord[];
}
export interface QuizResult {
  readonly quiz?: PublicQuizDetailRecord;
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
  readonly quiz: PublicQuizDetailRecord;
  readonly grades: readonly QuizGradeRecord[];
  readonly readings: readonly QuizReadingRecord[];
}

export interface WorkflowListResult {
  readonly workflows: readonly WorkflowRecord[];
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
