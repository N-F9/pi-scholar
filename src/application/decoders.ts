import type {
  ExtractPublicationInput,
  GradeSettlementInput,
  QuizAnswerInput,
  QuizPublicationInput,
  QuizQuestionProposal,
  ReviewRating,
  WikiChangeInput,
  WikiChangeIssuePageInput,
} from "../contracts.js";
import { ValidationError } from "../scheduler.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function asAnswers(value: unknown): QuizAnswerInput[] {
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

export function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ValidationError(`${label} has unsupported fields`);
}

export function requiredString(value: Record<string, unknown>, key: string, label = key): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) throw new ValidationError(`${label} must be a nonempty string`);
  return result;
}

export function optionalString(value: Record<string, unknown>, key: string, label = key): string | undefined {
  if (value[key] === undefined) return undefined;
  return requiredString(value, key, label);
}

export function requiredInteger(value: Record<string, unknown>, key: string, label = key): number {
  const result = value[key];
  if (!Number.isInteger(result)) throw new ValidationError(`${label} must be an integer`);
  return result as number;
}

function decodeWikiChangePage(value: unknown): WikiChangeIssuePageInput {
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

export function decodeExtractPublicationInput(value: unknown): ExtractPublicationInput {
  if (!isRecord(value)) throw new ValidationError("extract publication must be an object");
  exact(value, ["claimId", "preparedId", "digest", "endpoints"], "extract publication");
  const endpoints = value.endpoints;
  if (
    !Array.isArray(endpoints) ||
    endpoints.length === 0 ||
    endpoints.some((item) => !Number.isInteger(item) || Number(item) < 1)
  )
    throw new ValidationError("endpoints must be a non-empty array of positive line endpoints");
  return {
    claimId: requiredString(value, "claimId"),
    preparedId: requiredString(value, "preparedId"),
    digest: requiredString(value, "digest"),
    endpoints: endpoints.map((item) => Number(item)),
  };
}

export function decodeWikiChangeInput(value: unknown): WikiChangeInput {
  if (!isRecord(value)) throw new ValidationError("wiki change must be an object");
  const kind = requiredString(value, "kind") as WikiChangeInput["kind"];
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
    case "retire-page":
      exact(value, ["kind", "pageId", "expectedDigest"], "retire-page");
      return {
        kind,
        pageId: requiredString(value, "pageId"),
        expectedDigest: requiredString(value, "expectedDigest"),
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
        page: decodeWikiChangePage(value.page),
        resolution: requiredString(value, "resolution"),
      };
    default:
      throw new ValidationError(`unsupported wiki change kind: ${kind}`);
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

export function decodeQuizPublication(value: unknown): QuizPublicationInput {
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

export function decodeReading(value: unknown): { pageId: string; anchor: string; heading?: string } {
  if (!isRecord(value)) throw new ValidationError("reading must be an object");
  exact(value, ["pageId", "anchor", "heading"], "reading");
  const heading = optionalString(value, "heading");
  return {
    pageId: requiredString(value, "pageId"),
    anchor: requiredString(value, "anchor"),
    ...(heading === undefined ? {} : { heading }),
  };
}

export function decodeGrade(value: unknown): GradeSettlementInput {
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
