import type { QuizRecord, ReviewRating } from "../contracts.js";
import { isRecord } from "./decoders.js";

const QUIZ_GRADER_BINDING_PREFIX = "quiz-grader:";
const QUIZ_GRADER_BINDING_VERSION_PREFIX = `${QUIZ_GRADER_BINDING_PREFIX}v1:`;
// ponytail: fixed 15-minute lease; add heartbeats only when grader runtime needs longer work.
export const QUIZ_GRADER_LEASE_MS = 15 * 60 * 1000;

export type QuizGraderBinding = { readonly quizId: string; readonly ownerHash: string };
export type QuizGraderPayload = { readonly date: string; readonly revision: number; readonly submissionId: string };

export function gradingSubmissionId(quiz: Pick<QuizRecord, "quizId" | "revision">): string {
  return `${quiz.quizId}:r${quiz.revision}`;
}

export function quizGraderPayload(quiz: Pick<QuizRecord, "date" | "quizId" | "revision">): QuizGraderPayload {
  return { date: quiz.date, revision: quiz.revision, submissionId: gradingSubmissionId(quiz) };
}

export function quizGraderPayloadText(quiz: Pick<QuizRecord, "date" | "quizId" | "revision">): string {
  return JSON.stringify(quizGraderPayload(quiz));
}

export function parseQuizGraderPayload(value: unknown): QuizGraderPayload | undefined {
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

export function quizGraderBindingText(quizId: string, ownerHash: string): string {
  return `${QUIZ_GRADER_BINDING_VERSION_PREFIX}${JSON.stringify({ quizId, ownerHash })}`;
}

export function parseQuizGraderBinding(value: unknown): QuizGraderBinding | undefined {
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

type ReplayReading = {
  readonly pageId: string;
  readonly anchor: string;
  readonly heading?: string;
};

type ReplayPage = {
  readonly pageId: string;
  readonly rating: ReviewRating | string;
  readonly feedback?: string;
  readonly evidence?: readonly string[];
  readonly readings?: readonly ReplayReading[];
};

type ReplayQuestion = {
  readonly questionId: string;
  readonly feedback?: string;
};

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

export function gradingReplayKey(questions: readonly ReplayQuestion[], pages: readonly ReplayPage[]): string {
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
