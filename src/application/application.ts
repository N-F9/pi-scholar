import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import type {
  ApiEnvelope,
  DoctorReport,
  ExtractContext,
  ExtractFailureRecord,
  ExtractPublicationInput,
  ExtractPublicationResult,
  GradeSettlementInput,
  GradingContext,
  GradingResult,
  HealthResult,
  IngestContext,
  IngestSourceChunk,
  IngestSourceContext,
  LintContext,
  PageLearningRecord,
  PageRecord,
  PreparedAdmission,
  PublicQuizDetailRecord,
  PublicQuizRecord,
  PublicSourceRecord,
  QuizAnswerInput,
  QuizCandidateRecord,
  QuizContext,
  QuizDetailRecord,
  QuizEvidenceRecord,
  QuizEvidenceRequest,
  QuizGradeRecord,
  QuizPageResultRecord,
  QuizPublicationInput,
  QuizQuestionProposal,
  QuizQuestionResultRecord,
  QuizReadingRecord,
  QuizRecord,
  SettingsFacts,
  SettingsRecord,
  SettingsUpdateRequest,
  SourceManifest,
  SourceRecord,
  SourceRemovalResult,
  SourceRequest,
  WikiChangeInput,
  WikiChangeResult,
  WikiDriftResolutionRequest,
  WikiIssueCreateRequest,
  WikiIssueRecord,
  WikiIssueUpdateRequest,
  WikiPageLearningProjection,
  WikiPageResult,
  WorkflowRecord,
} from "../contracts.js";
import { openDatabase, type ScholarDatabase, transaction } from "../database.js";
import { doctor as runDoctor } from "../doctor.js";
import { convertWithDocling } from "../external/docling.js";
import {
  type GitCheckpointResult,
  type GitPushResult,
  gitStatus,
  localCheckpointCommit,
  safePush,
} from "../external/git.js";
import { qmdRefresh, qmdScopeCheck, qmdSearch } from "../external/qmd.js";
import { okfCitationText, okfFootnoteLabels, removeOkfFootnoteDefinitions } from "../okf.js";
import { evidenceReference, QuizConflictError, QuizService, type ReadingLink } from "../quiz.js";
import { localDate, RevisionConflictError, SchedulerService, ValidationError } from "../scheduler.js";
import {
  type SourceStageRequest as MechanicsSourceStageRequest,
  type SourceAdapters,
  type SourceClaim,
  SourceService,
} from "../sources/source-service.js";
import {
  assertNoSymlinkPath,
  atomicWriteFile,
  readFileNoFollow,
  resolveVault,
  safeRelativePath,
  type VaultPaths,
  withWriterLock,
} from "../vault.js";
import { parseWikiMarkdown, type WikiAdapters, WikiService } from "../wiki.js";
import { parseWikiSections } from "../wiki-sections.js";
import {
  BrowserMutationWorker,
  WorkflowCoordinator,
  type WorkflowFinishOptions,
  type WorkflowKind,
  type WorkflowUpdateInput,
} from "../workflows.js";
import {
  asAnswers,
  decodeExtractPublicationInput,
  decodeGrade,
  decodeQuizPublication,
  decodeReading,
  decodeWikiChangeInput,
  exact,
  isRecord,
  jsonValue,
  requiredString,
} from "./decoders.js";
import {
  gradingReplayKey,
  gradingSubmissionId,
  parseQuizGraderBinding,
  parseQuizGraderPayload,
  QUIZ_GRADER_LEASE_MS,
  quizGraderBindingText,
  quizGraderPayload,
  quizGraderPayloadText,
} from "./grader-binding.js";
import {
  answersObject,
  type PublicWorkflowRecord,
  pageRecord,
  publicQuiz,
  publicQuizDetail,
  publicSource,
  publicWorkflow,
  quizOutcome,
  recordToIssue,
  sourceRecord,
} from "./projections.js";

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
  readonly commit?: (paths: VaultPaths, subject: string, excludedPaths?: readonly string[]) => GitCheckpointResult;
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
const WIKI_CHANGE_ROLLBACK_TABLES = [
  { name: "pages", keys: ["page_id"] },
  { name: "page_learning", keys: ["page_id"] },
  { name: "page_prerequisites", keys: ["page_id", "prerequisite_page_id"] },
  { name: "authored_snapshots", keys: ["relative_path"] },
  { name: "wiki_issues", keys: ["issue_id"] },
] as const;
interface WikiChangeRollbackFile {
  readonly destination: string;
  readonly backup: string;
  readonly exists: boolean;
}
interface WikiChangeRollbackSnapshot {
  readonly workRoot: string;
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly files: readonly WikiChangeRollbackFile[];
  readonly snapshotRoot: string;
  readonly snapshotEntries: readonly string[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

type IngestSection = {
  readonly anchor: string;
  readonly startOffset: number;
  readonly endOffset: number;
};
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function extractionResultKey(input: Pick<ExtractPublicationInput, "claimId" | "preparedId" | "digest">): string {
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
function mutationFinalizationError(
  stage: "checkpoint" | "doctor" | "commit" | "projection" | "rollback",
  cause: unknown,
  retryable = false,
): Error {
  return Object.assign(new Error(`mutation applied but ${stage} failed: ${errorMessage(cause)}`), {
    code: "MUTATION_APPLIED_FINALIZATION_FAILED",
    details: { applied: true, retryable, stage },
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
      options?: {
        readonly collection?: string;
        readonly scope?: "wiki/**/*.md";
        readonly limit?: number;
        readonly ignoredPaths?: readonly string[];
      },
    ) => {
      const scope = qmdScopeCheck(paths, undefined, options?.ignoredPaths);
      if (!scope.ok) throw new Error(`qmd semantic index is unavailable: ${scope.message}`);
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
    index: async (options) => {
      const result = await qmdRefresh(paths, options);
      if (result.timedOut || result.signal || result.code !== 0)
        throw new Error(
          `qmd update failed: ${(result.stderr.trim() || result.stdout.trim() || result.signal || "unknown error").slice(0, 500)}`,
        );
    },
  };
  return { ...overrides, qmd };
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
  private readonly commitFn: (
    paths: VaultPaths,
    subject: string,
    excludedPaths?: readonly string[],
  ) => GitCheckpointResult;
  private readonly pushFn: (paths: VaultPaths) => GitPushResult;
  private readonly extractionClaims = new Map<
    string,
    { readonly claim: SourceClaim; readonly prepared: PreparedAdmission }
  >();
  private readonly completedExtractions = new Map<string, ExtractPublicationResult>();
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
          if (!report.ok) {
            const error = new Error("doctor checks failed");
            if (!rollback) throw mutationFinalizationError("doctor", error);
            throw error;
          }
        } catch (error) {
          if (!rollback) throw mutationFinalizationError("doctor", error);
          throw error;
        }
        try {
          const excludedPaths = this.catalogDriftExclusions();
          const result = (
            excludedPaths.length > 0
              ? this.commitFn(this.paths, subject, excludedPaths)
              : this.commitFn(this.paths, subject)
          ) as GitCheckpointResult & { readonly ok?: boolean };
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
  private async assertIngestCitation(body: string, authoredBody?: string): Promise<void> {
    const authorized = new Set<string>();
    for (const { manifest } of await this.sources.publishedPackets())
      for (const chunk of manifest.chunks) authorized.add(chunk.chunkId);
    if (
      [body, authoredBody].some(
        (markdown) =>
          markdown !== undefined && /^ {0,3}#{1,6}(?:[ \t]+#*[ \t]*)?\r?$/mu.test(okfCitationText(markdown)),
      )
    )
      throw new ValidationError("source-grounded ingest sections require non-empty headings");
    const sections = (markdown: string): IngestSection[] => {
      const parsed = parseWikiSections(markdown, "");
      const first = parsed[0];
      if (!first) return markdown.trim() ? [{ anchor: "", startOffset: 0, endOffset: markdown.length }] : [];
      return markdown.slice(0, first.startOffset).trim()
        ? [{ anchor: "", startOffset: 0, endOffset: first.startOffset }, ...parsed]
        : parsed;
    };
    const sectionText = (markdown: string, section: IngestSection): string =>
      markdown.slice(section.startOffset, section.endOffset);
    const withoutDefinitions = (text: string): string => {
      const managed = okfFootnoteLabels(text).definitions.filter((label) => authorized.has(label));
      return removeOkfFootnoteDefinitions(text, managed).trimEnd();
    };
    const substantive = (markdown: string, section: IngestSection): boolean => {
      const text = sectionText(markdown, section);
      const newline = text.indexOf("\n");
      const content = section.anchor === "" ? text : newline < 0 ? "" : text.slice(newline + 1);
      return withoutDefinitions(content).trim().length > 0;
    };
    const requireSectionCitation = (markdown: string, section: IngestSection): void => {
      const references = okfFootnoteLabels(sectionText(markdown, section)).references;
      if (!references.length)
        throw new ValidationError("source-grounded ingest changes require an immutable source chunk citation");
      if (!references.some((reference) => authorized.has(reference)))
        throw new ValidationError(
          "source-grounded ingest changes require an authorized immutable source chunk citation",
        );
    };
    const nextSections = sections(body);
    if (authoredBody === undefined) {
      for (const section of nextSections) if (substantive(body, section)) requireSectionCitation(body, section);
      return;
    }
    const priorSections = sections(authoredBody);
    const priorByAnchor = new Map(priorSections.map((section, index) => [section.anchor, { index, section }]));
    const nextByAnchor = new Map(nextSections.map((section, index) => [section.anchor, { index, section }]));
    const paired = new Map<number, IngestSection>();
    const usedPrior = new Set<number>();
    for (const [index, section] of nextSections.entries()) {
      const prior = priorByAnchor.get(section.anchor);
      if (prior) {
        paired.set(index, prior.section);
        usedPrior.add(prior.index);
      }
    }
    for (const [index] of nextSections.entries()) {
      if (paired.has(index)) continue;
      const prior = priorByAnchor.get(priorSections[index]?.anchor ?? "");
      if (prior && !usedPrior.has(prior.index) && !nextByAnchor.has(prior.section.anchor)) {
        paired.set(index, prior.section);
        usedPrior.add(prior.index);
      }
    }
    for (const [index, section] of nextSections.entries()) {
      const prior = paired.get(index);
      if (
        prior &&
        withoutDefinitions(sectionText(body, section)) === withoutDefinitions(sectionText(authoredBody, prior))
      )
        continue;
      if (substantive(body, section)) requireSectionCitation(body, section);
    }
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
  private async clearExtractionClaims(): Promise<void> {
    const tracked = [...this.extractionClaims.values()];
    this.extractionClaims.clear();
    for (const { prepared } of tracked) await this.sources.cleanupPrepared(prepared.preparedId);
  }
  async getExtractContext(): Promise<ExtractContext> {
    await this.clearExtractionClaims();
    const claims: PreparedAdmission[] = [];
    const failures: ExtractFailureRecord[] = [];
    let recordingError: unknown;
    for (const entry of await this.sources.discover()) {
      let claim: SourceClaim | undefined;
      try {
        claim = await this.sources.claim(entry);
        const prepared = await this.sources.prepareClaim(claim);
        this.extractionClaims.set(claim.claimId, { claim, prepared });
        claims.push(prepared);
      } catch (error) {
        try {
          await this.durableDirect(
            () => this.sources.recordExtractFailure(entry, error, claim),
            "source:extract-failed",
          );
        } catch (failureError) {
          recordingError ??= failureError;
        }
        if (claim) {
          const tracked = this.extractionClaims.get(claim.claimId);
          this.extractionClaims.delete(claim.claimId);
          if (tracked) await this.sources.cleanupPrepared(tracked.prepared.preparedId);
        }
        failures.push({
          relativePath: entry.relativePath,
          errorCode: "EXTRACT_FAILED",
          errorMessage: errorMessage(error).slice(0, 500),
        });
      }
    }
    if (recordingError) {
      await this.clearExtractionClaims();
      throw recordingError;
    }
    return { claims, ...(failures.length ? { failures } : {}) };
  }
  async publishExtraction(input: ExtractPublicationInput): Promise<ExtractPublicationResult> {
    const decoded = decodeExtractPublicationInput(input);
    const resultKey = extractionResultKey(decoded);
    const completed = this.completedExtractions.get(resultKey);
    if (completed) return completed;
    const pending = this.extractionClaims.get(decoded.claimId);
    if (!pending || pending.prepared.preparedId !== decoded.preparedId || pending.prepared.digest !== decoded.digest)
      throw new ValidationError("extract claim is unknown, stale, or expired");
    let appliedResult: ExtractPublicationResult | undefined;
    const cacheResult = (result: ExtractPublicationResult): void => {
      this.completedExtractions.set(resultKey, result);
      if (this.completedExtractions.size > 256) {
        const oldest = this.completedExtractions.keys().next().value;
        if (typeof oldest === "string") this.completedExtractions.delete(oldest);
      }
    };
    try {
      const result = await this.durableDirect(async () => {
        const published = await this.sources.publishPreparedClaim({
          prepared: pending.prepared,
          preparedId: decoded.preparedId,
          claimId: decoded.claimId,
          digest: decoded.digest,
          endpoints: [...decoded.endpoints],
        });
        const publication: ExtractPublicationResult = {
          sourceId: published.sourceId,
          manifest: published.manifest as SourceManifest,
          removedInbox: published.removedInbox,
        };
        appliedResult = publication;
        return publication;
      }, "source:extract");
      cacheResult(result);
      this.extractionClaims.delete(decoded.claimId);
      return result;
    } catch (error) {
      if (appliedResult && isAppliedFinalizationFailure(error)) {
        cacheResult(appliedResult);
        this.extractionClaims.delete(decoded.claimId);
        throw error;
      }
      let recordingError: unknown;
      try {
        await this.durableDirect(
          () => this.sources.recordExtractFailure(pending.claim.entry, error, pending.claim),
          "source:extract-failed",
        );
      } catch (failureError) {
        recordingError = failureError;
      }
      this.extractionClaims.delete(decoded.claimId);
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
    return this.mutate(context, () =>
      this.durableDirect(async () => {
        const staged = await this.sources.stage(request as MechanicsSourceStageRequest);
        const entry = (await this.sources.discover()).find(
          (candidate) => candidate.relativePath === staged.relativePath,
        );
        if (!entry) throw new Error("staged source disappeared");
        return { source: publicSource(this.pendingSource(entry)) };
      }, "source:stage"),
    );
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
        try {
          await this.wiki.refreshProjections();
          await this.wiki.refreshQmdIndex().catch(() => undefined);
        } catch (error) {
          throw mutationFinalizationError("projection", error, true);
        }
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
    const schedule =
      page.quizWorthiness === "eligible" ||
      this.db.get("SELECT page_id FROM page_learning WHERE page_id = ?", [page.pageId])
        ? this.scheduler.getPageLearning(page.pageId)
        : undefined;
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
    const lint = this.db.get<Record<string, unknown>>(
      "SELECT finished_at, status, message, error_code, error_message FROM workflows WHERE kind = 'lint' AND finished_at IS NOT NULL ORDER BY finished_at DESC, rowid DESC LIMIT 1",
    );
    const ingest = this.db.get<Record<string, unknown>>(
      "SELECT finished_at, status, message, error_code, error_message FROM workflows WHERE kind = 'ingest' AND finished_at IS NOT NULL ORDER BY finished_at DESC, rowid DESC LIMIT 1",
    );
    const workflowResult = (workflow: Record<string, unknown> | undefined): string | undefined => {
      if (!workflow) return undefined;
      const status = String(workflow.status ?? "unknown");
      if (status === "failed") {
        const errorCode = workflow.error_code ? ` (${String(workflow.error_code)})` : "";
        const detail = workflow.error_message
          ? String(workflow.error_message)
          : workflow.message
            ? String(workflow.message)
            : "Workflow failed";
        return `failed${errorCode}: ${detail}`;
      }
      return workflow.message ? String(workflow.message) : status;
    };
    const ingestResult = workflowResult(ingest);
    const lintResult = workflowResult(lint);
    let git: SettingsFacts["git"] = {
      clean: false,
      ahead: 0,
      behind: 0,
      diverged: false,
      message: "Git state unavailable",
    };
    try {
      const status = gitStatus(this.paths);
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
      ...(ingest?.finished_at ? { lastIngestAt: String(ingest.finished_at) } : {}),
      ...(ingestResult ? { lastIngestResult: ingestResult } : {}),
      ...(lint?.finished_at ? { lastLintAt: String(lint.finished_at) } : {}),
      ...(lintResult ? { lastLintResult: lintResult } : {}),
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
      await this.clearExtractionClaims();
    } catch (error) {
      closeError ??= error;
    }
    this.completedExtractions.clear();
    if (this.ownsDatabase) this.db.close();
    if (closeError) throw closeError;
  }
  async getIngestContext(): Promise<IngestContext> {
    const pages = await Promise.all(
      (await this.wiki.list()).filter((page) => page.status !== "retired").map((page) => this.wikiResult(page.pageId)),
    );
    const issues = (await this.listIssues()).issues.filter((issue) => issue.status !== "resolved");
    const sources = await this.sources.publishedPackets();
    return {
      pages,
      issues,
      sources: sources.map(
        ({ source, manifest, packetPath }): IngestSourceContext => ({
          source: { ...sourceRecord(source as unknown as Record<string, unknown>), manifestPath: packetPath },
          manifest,
          packetPath,
          chunks: manifest.chunks.map(
            (chunk): IngestSourceChunk => ({
              ...chunk,
              path: join(packetPath, "chunks", `${String(chunk.ordinal + 1).padStart(4, "0")}.md`),
            }),
          ),
        }),
      ),
    };
  }
  async getLintContext(input?: { readonly description?: string }): Promise<LintContext> {
    const pages = await Promise.all(
      (await this.wiki.list()).filter((page) => page.status !== "retired").map((page) => this.wikiResult(page.pageId)),
    );
    const issues = (await this.listIssues()).issues.filter((issue) => issue.status !== "resolved");
    const scope =
      input?.description === undefined
        ? ({ kind: "full" } as const)
        : ({ kind: "targeted", description: input.description } as const);
    return { scope, pages, issues };
  }
  private async liveDriftDigests(): Promise<Map<string, string>> {
    const reports = await Promise.all((await this.wiki.list()).map((page) => this.wiki.inspectDrift(page.pageId)));
    return new Map(
      reports.filter((report) => report.drifted).map((report) => [report.page.pageId, report.currentDigest]),
    );
  }
  private async liveDriftPageIds(): Promise<Set<string>> {
    return new Set((await this.liveDriftDigests()).keys());
  }
  private catalogDriftExclusions(): readonly string[] {
    return this.db
      .all<{ readonly relative_path: string }>("SELECT relative_path FROM pages WHERE status = 'drifted'")
      .map(({ relative_path }) => join(this.paths.wikiRoot, relative_path));
  }
  private assertDriftRepairFields(
    pageId: string,
    currentContent: string,
    proposed: {
      readonly body?: string;
      readonly title?: string;
      readonly quizWorthiness?: PageRecord["quizWorthiness"];
    },
  ): string {
    const authoredBytes = readFileNoFollow(join(this.paths.metadataRoot, "snapshots", "wiki", `${pageId}.md`));
    const recorded = this.db.get<{ readonly page_digest: string; readonly snapshot_digest: string }>(
      "SELECT pages.digest AS page_digest, authored_snapshots.digest AS snapshot_digest FROM pages JOIN authored_snapshots ON authored_snapshots.relative_path = pages.relative_path WHERE pages.page_id = ?",
      [pageId],
    );
    if (
      !recorded ||
      recorded.page_digest !== recorded.snapshot_digest ||
      sha256(authoredBytes) !== recorded.snapshot_digest
    )
      throw new ValidationError("product-authored snapshot failed verification");
    const authored = parseWikiMarkdown(authoredBytes.toString("utf8"));
    let missing: string[];
    try {
      const current = parseWikiMarkdown(currentContent);
      missing = [
        current.body !== authored.body && proposed.body === undefined ? "body" : undefined,
        current.frontmatter.title !== authored.frontmatter.title && proposed.title === undefined ? "title" : undefined,
        current.frontmatter["quiz-worthiness"] !== authored.frontmatter["quiz-worthiness"] &&
        proposed.quizWorthiness === undefined
          ? "quizWorthiness"
          : undefined,
      ].filter((field): field is string => field !== undefined);
    } catch {
      missing = [
        proposed.body === undefined ? "body" : undefined,
        proposed.title === undefined ? "title" : undefined,
        proposed.quizWorthiness === undefined ? "quizWorthiness" : undefined,
      ].filter((field): field is string => field !== undefined);
    }
    if (missing.length)
      throw new ValidationError(`drifted page repair must explicitly provide changed fields: ${missing.join(", ")}`);
    return authored.body;
  }
  private async filterLiveDriftPages(pages: readonly PageLearningRecord[]): Promise<PageLearningRecord[]> {
    const drifted = await this.liveDriftPageIds();
    return pages.filter((page) => !drifted.has(page.pageId));
  }
  private assertWikiChangeCoverage(
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
  private async wikiChangePreflight(allowedDrift: ReadonlyMap<string, string> = new Map()): Promise<void> {
    const drifted = await this.liveDriftDigests();
    if (!allowedDrift.size && drifted.size)
      throw new ValidationError(`Wiki pages have unresolved live drift: ${[...drifted.keys()].join(", ")}`);
    for (const [pageId, expectedDigest] of allowedDrift) {
      if (drifted.get(pageId) !== expectedDigest)
        throw new ValidationError(`Preexisting wiki drift changed before mutation: ${pageId}`);
    }
    const pages = (await this.wiki.list()).filter((page) => page.status === "active");
    const projection = await this.wiki.refreshProjections(false);
    const lint = this.wiki.lintSync(pages, projection.backlinks);
    if (lint.length) throw new ValidationError(`wiki lint failed: ${lint.join("; ")}`);
    if (!this.wiki.adapters.qmd || typeof this.wiki.adapters.qmd.index !== "function")
      throw new ValidationError("wiki maintenance requires qmd indexing");
    await this.wiki.refreshQmdIndex();
  }
  private async captureWikiChangeRollback(proposal: WikiChangeInput): Promise<WikiChangeRollbackSnapshot> {
    const destinations = new Set<string>([join(this.paths.wikiRoot, "index.md"), join(this.paths.wikiRoot, "log.md")]);
    const pageIds = new Set<string>();
    switch (proposal.kind) {
      case "create-page":
        destinations.add(safeRelativePath(this.paths.wikiRoot, proposal.path));
        break;
      case "update-page":
      case "rename-page":
      case "retire-page":
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
    const files: WikiChangeRollbackFile[] = [];
    try {
      for (const [index, destination] of [...destinations].entries()) {
        let content: Buffer | undefined;
        try {
          content = readFileNoFollow(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const exists = content !== undefined;
        const backup = join(workRoot, `${index}.bin`);
        if (content !== undefined) await fs.writeFile(backup, content, { flag: "wx", mode: 0o600 });
        files.push({ destination, backup, exists });
      }
      const tables = Object.fromEntries(
        WIKI_CHANGE_ROLLBACK_TABLES.map(({ name }) => [
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
  private async restoreWikiChangeRollback(snapshot: WikiChangeRollbackSnapshot): Promise<void> {
    const deleteOrder = ["wiki_issues", "page_prerequisites", "page_learning", "authored_snapshots", "pages"];
    const writeOrder = ["pages", "authored_snapshots", "page_learning", "page_prerequisites", "wiki_issues"];
    const specs = new Map<string, (typeof WIKI_CHANGE_ROLLBACK_TABLES)[number]>(
      WIKI_CHANGE_ROLLBACK_TABLES.map((spec): [string, (typeof WIKI_CHANGE_ROLLBACK_TABLES)[number]] => [
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
    const restoreFile = async (file: WikiChangeRollbackFile): Promise<void> => {
      if (!file.exists) {
        assertNoSymlinkPath(dirname(file.destination));
        await fs.rm(file.destination, { force: true });
        return;
      }
      const content = readFileNoFollow(file.backup);
      atomicWriteFile(file.destination, content);
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
      assertNoSymlinkPath(snapshot.snapshotRoot);
      const expectedSnapshots = new Set(snapshot.snapshotEntries);
      for (const entry of await fs.readdir(snapshot.snapshotRoot)) {
        if (!expectedSnapshots.has(entry))
          await fs.rm(join(snapshot.snapshotRoot, entry), { recursive: true, force: true });
      }
      try {
        await this.wiki.refreshQmdIndex();
      } finally {
        this.db.checkpoint();
      }
    } finally {
      await fs.rm(snapshot.workRoot, { recursive: true, force: true });
    }
  }
  private async wikiChangeChecks(
    allowedDrift: ReadonlyMap<string, string> = new Map(),
    targetPageId?: string,
  ): Promise<{ readonly lint: readonly string[]; readonly doctor: DoctorReport }> {
    const drifted = await this.liveDriftDigests();
    const introduced = [...drifted.keys()].filter((pageId) => !allowedDrift.has(pageId));
    if (introduced.length) throw new ValidationError(`Wiki mutation introduced live drift: ${introduced.join(", ")}`);
    for (const [pageId, expectedDigest] of allowedDrift) {
      if (pageId !== targetPageId && drifted.get(pageId) !== expectedDigest)
        throw new ValidationError(`Preexisting wiki drift changed during mutation: ${pageId}`);
    }
    if (targetPageId && drifted.has(targetPageId))
      throw new ValidationError(`Wiki mutation did not repair target drift: ${targetPageId}`);
    const pages = (await this.wiki.list()).filter((page) => page.status === "active");
    const projection = await this.wiki.refreshProjections();
    const lint = this.wiki.lintSync(pages, projection.backlinks);
    if (lint.length) throw new ValidationError(`wiki lint failed: ${lint.join("; ")}`);
    for (const page of pages) {
      if (page.status === "active" && page.quizWorthiness === "eligible")
        this.scheduler.ensurePageLearning(page.pageId);
    }
    this.assertWikiChangeCoverage(pages);
    const qmd = this.wiki.adapters.qmd;
    if (!qmd || typeof qmd.index !== "function") throw new ValidationError("wiki maintenance requires qmd indexing");
    await this.wiki.refreshQmdIndex();
    const doctor = this.doctorFn(this.paths.vaultRoot);
    if (!doctor.ok) throw new ValidationError("doctor checks failed");
    const finalDrifted = await this.liveDriftDigests();
    const introducedAfterChecks = [...finalDrifted.keys()].filter((pageId) => !allowedDrift.has(pageId));
    if (introducedAfterChecks.length)
      throw new ValidationError(`Wiki mutation introduced live drift: ${introducedAfterChecks.join(", ")}`);
    for (const [pageId, expectedDigest] of allowedDrift) {
      if (pageId !== targetPageId && finalDrifted.get(pageId) !== expectedDigest)
        throw new ValidationError(`Preexisting wiki drift changed during mutation: ${pageId}`);
    }
    if (targetPageId && finalDrifted.has(targetPageId))
      throw new ValidationError(`Wiki mutation did not repair target drift: ${targetPageId}`);
    return { lint, doctor };
  }
  private async applyWikiChangeDecoded(
    proposal: WikiChangeInput,
    requireIngestCitation: boolean,
  ): Promise<WikiChangeResult> {
    const rollback = {
      capture: () => this.captureWikiChangeRollback(proposal),
      restore: (snapshot: WikiChangeRollbackSnapshot) => this.restoreWikiChangeRollback(snapshot),
      dispose: (snapshot: WikiChangeRollbackSnapshot) => fs.rm(snapshot.workRoot, { recursive: true, force: true }),
    };
    let preexistingDrift: ReadonlyMap<string, string> = new Map();
    return this.durableDirect(
      async () => {
        const allowDrift = proposal.kind === "update-page" || proposal.kind === "resolve-issue";
        preexistingDrift = allowDrift ? await this.liveDriftDigests() : new Map();
        if (preexistingDrift.size)
          transaction(this.db, () => {
            for (const pageId of preexistingDrift.keys())
              this.db.run("UPDATE pages SET status = 'drifted' WHERE page_id = ?", [pageId]);
          });
        await this.wikiChangePreflight(preexistingDrift);
        switch (proposal.kind) {
          case "create-page": {
            if (requireIngestCitation) await this.assertIngestCitation(proposal.body);
            const created = await this.wiki.create(proposal);
            const pageLearning =
              created.page.quizWorthiness === "eligible"
                ? this.scheduler.ensurePageLearning(created.page.pageId)
                : undefined;
            const checks = await this.wikiChangeChecks(preexistingDrift);
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
            if (sha256(await this.wiki.readExact(current.relativePath)) !== proposal.expectedDigest)
              throw new RevisionConflictError("The wiki page digest is stale");
            const body = proposal.body;
            const authoredBody = preexistingDrift.has(proposal.pageId)
              ? this.assertDriftRepairFields(proposal.pageId, current.content, proposal)
              : parseWikiMarkdown(current.content).body;
            const bodyChanged = body !== undefined && body !== authoredBody;
            if (requireIngestCitation && bodyChanged) await this.assertIngestCitation(body, authoredBody);
            const updated = await this.wiki.update(proposal.pageId, proposal);
            const pageLearning =
              updated.page.quizWorthiness === "eligible"
                ? this.scheduler.ensurePageLearning(updated.page.pageId)
                : undefined;
            const checks = await this.wikiChangeChecks(preexistingDrift, proposal.pageId);
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
            const checks = await this.wikiChangeChecks(preexistingDrift);
            return { kind: proposal.kind, page: pageRecord(renamed), checks };
          }
          case "retire-page": {
            this.assertPageMutationAllowed(proposal.pageId, "skip");
            const current = await this.wiki.get(proposal.pageId);
            if (current.digest !== proposal.expectedDigest)
              throw new RevisionConflictError("The wiki page digest is stale");
            const retired = await this.wiki.retire(proposal.pageId);
            const checks = await this.wikiChangeChecks(preexistingDrift);
            return { kind: proposal.kind, page: pageRecord(retired), checks };
          }
          case "prerequisites": {
            this.assertPageMutationAllowed(proposal.pageId);
            const page = await this.wiki.get(proposal.pageId);
            const pageLearning =
              page.quizWorthiness === "eligible" ? this.scheduler.ensurePageLearning(page.pageId) : undefined;
            this.scheduler.setPrerequisites(proposal.pageId, proposal.prerequisitePageIds, proposal.expectedRevision);
            const checks = await this.wikiChangeChecks(preexistingDrift);
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
            const current = await this.wiki.get(issue.pageId);
            if (issue.pageDigest !== undefined && issue.pageDigest !== current.digest)
              throw new RevisionConflictError("The issue page version is stale");
            if (sha256(await this.wiki.readExact(current.relativePath)) !== proposal.page.expectedDigest)
              throw new RevisionConflictError("The issue page digest is stale");
            const body = proposal.page.body;
            const authoredBody = preexistingDrift.has(issue.pageId)
              ? this.assertDriftRepairFields(issue.pageId, current.content, proposal.page)
              : parseWikiMarkdown(current.content).body;
            const bodyChanged = body !== undefined && body !== authoredBody;
            const pageChanged =
              preexistingDrift.has(issue.pageId) ||
              bodyChanged ||
              (proposal.page.title !== undefined && proposal.page.title !== current.title) ||
              (proposal.page.quizWorthiness !== undefined && proposal.page.quizWorthiness !== current.quizWorthiness);
            if (!pageChanged) throw new ValidationError("resolve-issue requires an actual page correction");
            if (requireIngestCitation && bodyChanged) await this.assertIngestCitation(body, authoredBody);
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
            const checks = await this.wikiChangeChecks(preexistingDrift, proposal.page.pageId);
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
      "wiki:change",
      rollback,
    );
  }
  async applyWikiChange(input: WikiChangeInput): Promise<WikiChangeResult> {
    return this.applyWikiChangeDecoded(decodeWikiChangeInput(input), false);
  }
  async applyIngestChange(input: WikiChangeInput): Promise<WikiChangeResult> {
    return this.applyWikiChangeDecoded(decodeWikiChangeInput(input), true);
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
  private async quizCandidates(pages: readonly PageLearningRecord[]): Promise<readonly QuizCandidateRecord[]> {
    const candidates = await Promise.all(
      pages.map(async (learning) => {
        const result = await this.wikiResult(learning.pageId);
        if (
          result.drift ||
          result.page.status !== "active" ||
          result.page.quizWorthiness !== "eligible" ||
          sha256(result.markdown) !== result.page.digest ||
          result.page.pageId !== learning.pageId
        )
          return undefined;
        return {
          pageId: result.page.pageId,
          path: result.page.relativePath,
          title: result.page.title,
          dueAt: learning.dueAt,
          sections: result.sections.map((section) => ({
            anchor: section.anchor,
            ...(section.heading === undefined ? {} : { heading: section.heading }),
          })),
        };
      }),
    );
    return candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
  }
  async getQuizContext(input: { readonly date?: string } = {}): Promise<QuizContext> {
    if (!isRecord(input)) throw new ValidationError("quiz context must be an object");
    exact(input, ["date"], "quiz context");
    const date = input.date === undefined ? await this.currentLocalDate() : requiredString(input, "date");
    return this.durableDirect(async () => {
      if (date !== (await this.currentLocalDate()))
        throw new ValidationError("quiz context is limited to the current local date");
      const expiredCount = this.quiz.expirePrior(date);
      const settings = await this.getSettings();
      const duePages = await this.filterLiveDriftPages(this.scheduler.eligiblePages(date));
      const quiz = this.quiz.get(date);
      return {
        date,
        initializationEnabled: settings.settings.initializationEnabled,
        expiredCount,
        candidates: await this.quizCandidates(duePages),
        ...(quiz ? { quiz: await this.quizDetail(quiz) } : {}),
        ...(settings.settings.initializationEnabled
          ? { message: "Initialization maintenance is active; quiz publication is blocked." }
          : {}),
      };
    }, "quiz:context");
  }
  async getQuizEvidence(input: QuizEvidenceRequest): Promise<readonly QuizEvidenceRecord[]> {
    if (!isRecord(input)) throw new ValidationError("quiz evidence must be an object");
    exact(input, ["date", "pageIds"], "quiz evidence");
    const date = requiredString(input, "date");
    if (
      !Array.isArray(input.pageIds) ||
      input.pageIds.length === 0 ||
      input.pageIds.some((pageId) => typeof pageId !== "string" || !pageId.trim())
    )
      throw new ValidationError("pageIds must be a non-empty array of nonempty strings");
    const pageIds = input.pageIds.map((pageId) => String(pageId).trim());
    if (new Set(pageIds).size !== pageIds.length) throw new ValidationError("pageIds must be unique");
    return withWriterLock(this.paths, async () => {
      if (date !== (await this.currentLocalDate()))
        throw new ValidationError("quiz evidence is limited to the current local date");
      const duePages = await this.filterLiveDriftPages(this.scheduler.eligiblePages(date, false));
      const byId = new Map(duePages.map((page) => [page.pageId, page]));
      const selectedPages = pageIds.map((pageId) => {
        const page = byId.get(pageId);
        if (!page) throw new ValidationError(`Quiz page is not currently eligible: ${pageId}`);
        return page;
      });
      return this.quizEvidence(selectedPages);
    });
  }
  private async validateQuizEvidence(
    questions: readonly QuizQuestionProposal[],
    selectedPages: readonly PageLearningRecord[],
  ): Promise<void> {
    const selected = new Set(selectedPages.map((page) => page.pageId));
    const evidence = await this.quizEvidence(selectedPages);
    const known = new Set(evidence.map((item) => item.reference));
    const byPage = new Map<string, Set<string>>();
    for (const item of evidence) {
      const references = byPage.get(item.pageId) ?? new Set<string>();
      references.add(item.reference);
      byPage.set(item.pageId, references);
    }
    for (const question of questions) {
      if (!question.pages.length) throw new ValidationError("Every quiz question must cover a wiki page");
      if (!question.sourceRefs.length) throw new ValidationError("Every quiz question requires source evidence");
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
  }
  async publishQuiz(input: QuizPublicationInput): Promise<QuizDetailRecord> {
    const proposal = decodeQuizPublication(input);
    const date = proposal.date;
    let blocked = false;
    const result = await this.durableDirect(async () => {
      if (date !== (await this.currentLocalDate()))
        throw new ValidationError("quiz publication is limited to the current local date");
      const settings = await this.getSettings();
      if (settings.settings.initializationEnabled) {
        blocked = true;
        return undefined;
      }
      const duePages = await this.filterLiveDriftPages(this.scheduler.eligiblePages(date));
      if (proposal.status === "skipped") {
        if (duePages.length) throw new ValidationError("A quiz may be skipped only when no pages are eligible");
        return this.quizDetail(this.quiz.createDailyQuiz({ date, selectedPageIds: [], questionSpecs: [] }));
      }
      const selectedPageIds = [
        ...new Set(proposal.questions.flatMap((question) => question.pages.map((page) => page.pageId))),
      ];
      if (!selectedPageIds.length) throw new ValidationError("A published quiz must select at least one wiki page");
      const eligibleById = new Map(duePages.map((page) => [page.pageId, page]));
      const selectedPages = selectedPageIds.map((pageId) => {
        const page = eligibleById.get(pageId);
        if (!page) throw new ValidationError(`Quiz question references an ineligible page: ${pageId}`);
        return page;
      });
      await this.validateQuizEvidence(proposal.questions, selectedPages);
      return this.quizDetail(
        this.quiz.createDailyQuiz({
          date,
          selectedPageIds,
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
