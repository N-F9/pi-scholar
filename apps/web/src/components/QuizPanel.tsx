import { Link } from "react-router-dom";
import type {
  PublicQuizQuestionRecord,
  QuizAnswerInput,
  QuizGradeRecord,
  QuizPageResultRecord,
  QuizQuestionResultRecord,
  QuizReadingRecord,
  QuizRecommendations,
} from "../../../../src/contracts";
import { headingAnchor, Markdown } from "./Markdown";
import { Badge, Card } from "./ui";

function answerText(value: QuizAnswerInput["answer"] | undefined): string {
  if (typeof value === "string") return value.trim() || "No answer recorded";
  return value?.join(", ") || "No answer recorded";
}

const ratingTones = {
  Again: "danger",
  Hard: "caution",
  Good: "positive",
  Easy: "positive",
} as const;
const recommendationLabels = {
  prerequisite: "Prerequisite",
  related: "Related",
} as const;
const gapLabels = {
  missing: "Missing coverage",
  unclear: "Unclear coverage",
  drifted: "Drifted page",
} as const;
function readingTarget(reading: QuizReadingRecord): string {
  const search = new URLSearchParams();
  let hash = "";
  try {
    const supplied = new URL(reading.href, "https://scholar.invalid");
    if (supplied.origin === "https://scholar.invalid") {
      if (supplied.pathname === "/notes") {
        supplied.searchParams.forEach((value, key) => {
          search.append(key, value);
        });
      }
      if (supplied.pathname === "/notes" || supplied.pathname.startsWith("/wiki/")) hash = supplied.hash;
    }
  } catch {
    // Fall through to the exact page and heading recorded with the reading.
  }
  search.set("pageId", reading.pageId);
  if (reading.heading) {
    search.set("heading", reading.heading);
    hash ||= `#${encodeURIComponent(headingAnchor(reading.heading))}`;
  } else {
    search.delete("heading");
  }
  return `/notes?${search.toString()}${hash}`;
}

export function ReadOnlyQuestions({
  questions,
  answers,
}: {
  questions: readonly PublicQuizQuestionRecord[];
  answers: readonly QuizAnswerInput[];
}) {
  const byQuestion = new Map(answers.map((item) => [item.questionId, item.answer]));
  const displayQuestions = [...questions].sort((left, right) => left.ordinal - right.ordinal);
  const questionPositions = new Map(
    displayQuestions.map((question, index) => [question.questionId, index + 1] as const),
  );
  return (
    <ol className="grid gap-5">
      {displayQuestions.map((question) => (
        <li key={question.questionId}>
          <Card className="shadow-none">
            <p className="eyebrow">
              Question {questionPositions.get(question.questionId)} ·{" "}
              {question.kind === "multiple-choice" ? "Multiple choice" : "Free response"}
            </p>
            <div className="mt-3">
              <Markdown source={question.prompt} />
            </div>
            {question.kind === "multiple-choice" && question.choices?.length ? (
              <ul className="mt-4 grid gap-2">
                {question.choices.map((choice) => {
                  const answer = byQuestion.get(question.questionId);
                  const selected = typeof answer === "string" ? answer === choice : (answer?.includes(choice) ?? false);
                  return (
                    <li
                      className={
                        selected
                          ? "rounded-md border border-accent bg-accent/10 px-3 py-2 font-bold"
                          : "rounded-md border border-line px-3 py-2 text-muted"
                      }
                      key={choice}
                    >
                      <span>
                        <Markdown inline source={choice} />
                        {selected ? " — selected" : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : question.kind === "multiple-choice" ? (
              <p className="mt-4 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                Choices unavailable for this question.
              </p>
            ) : (
              <div className="mt-4 rounded-md border border-line bg-canvas p-4">
                <p className="eyebrow">Answer</p>
                <div className="mt-2">
                  <Markdown source={answerText(byQuestion.get(question.questionId))} />
                </div>
              </div>
            )}
          </Card>
        </li>
      ))}
    </ol>
  );
}

export function QuizResults({
  questions,
  questionResults,
  pageResults,
  grades,
  readings,
  recommendations,
}: {
  questions: readonly PublicQuizQuestionRecord[];
  questionResults: readonly QuizQuestionResultRecord[];
  pageResults: readonly QuizPageResultRecord[];
  grades: readonly QuizGradeRecord[];
  readings: readonly QuizReadingRecord[];
  recommendations: QuizRecommendations;
}) {
  if (
    !questionResults.length &&
    !pageResults.length &&
    !grades.length &&
    !readings.length &&
    !recommendations.readings.length &&
    !recommendations.gaps.length
  )
    return null;
  const displayQuestions = [...questions].sort((left, right) => left.ordinal - right.ordinal);
  const questionPositions = new Map(
    displayQuestions.map((question, index) => [question.questionId, index + 1] as const),
  );
  const pageIds = [...new Set([...pageResults.map((result) => result.pageId), ...grades.map((grade) => grade.pageId)])];

  return (
    <section className="space-y-8" aria-labelledby="results-heading">
      <div>
        <p className="eyebrow">Settled review</p>
        <h2 className="mt-2 font-serif text-3xl font-semibold" id="results-heading">
          Results
        </h2>
      </div>

      {questionResults.length ? (
        <section className="space-y-3" aria-labelledby="question-results-heading">
          <h3 className="font-serif text-2xl font-semibold" id="question-results-heading">
            Question feedback
          </h3>
          <ol className="grid gap-3">
            {questionResults.map((result, index) => (
              <li key={result.resultId}>
                <Card className="shadow-none">
                  <p className="eyebrow">Question {questionPositions.get(result.questionId) ?? index + 1}</p>
                  {result.feedback ? (
                    <div className="mt-3">
                      <Markdown source={result.feedback} />
                    </div>
                  ) : (
                    <p className="mt-3 text-muted">Feedback unavailable.</p>
                  )}
                </Card>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {pageIds.length ? (
        <section className="space-y-3" aria-labelledby="page-results-heading">
          <h3 className="font-serif text-2xl font-semibold" id="page-results-heading">
            Page results
          </h3>
          <ol className="grid gap-3">
            {pageIds.map((pageId, index) => {
              const result = pageResults.find((item) => item.pageId === pageId);
              const grade = grades.find((item) => item.pageId === pageId);
              const rating = result?.rating ?? grade?.rating;
              const feedback = result?.feedback ?? grade?.feedback;
              return (
                <li
                  className="rounded-lg border border-line bg-paper p-5 shadow-quiet sm:p-6"
                  key={result?.resultId ?? grade?.gradeId ?? pageId}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h4 className="font-bold">
                      {result?.pageLink ? (
                        <Link
                          className="underline decoration-accent decoration-2 underline-offset-4 hover:text-muted"
                          to={readingTarget(result.pageLink)}
                        >
                          {result.pageLink.path}
                        </Link>
                      ) : (
                        `Reviewed page ${index + 1} unavailable`
                      )}
                    </h4>
                    {rating ? (
                      <Badge tone={ratingTones[rating]}>{rating}</Badge>
                    ) : (
                      <Badge tone="danger">Unavailable</Badge>
                    )}
                  </div>
                  {feedback ? (
                    <div className="mt-3">
                      <Markdown source={feedback} />
                    </div>
                  ) : (
                    <p className="mt-3 text-muted">Feedback unavailable.</p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {readings.length ? (
        <Card className="border-accent/50 bg-accent/10 shadow-none">
          <h3 className="font-serif text-2xl font-semibold">Read next</h3>
          <p className="mt-2 text-sm text-muted">
            Exact pages and headings selected from the evidence used for this grade.
          </p>
          <ul className="mt-4 grid gap-2">
            {readings.map((reading) => (
              <li key={`${reading.pageId}:${reading.heading ?? ""}`}>
                <Link
                  className="flex min-h-11 items-center justify-between rounded-md border border-line bg-paper px-3 py-2 font-bold hover:border-ink"
                  to={readingTarget(reading)}
                >
                  <span>
                    {reading.path}
                    {reading.heading ? ` — ${reading.heading}` : ""}
                  </span>
                  <span aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {recommendations.readings.length ? (
        <Card className="shadow-none">
          <h3 className="font-serif text-2xl font-semibold">Continue learning</h3>
          <p className="mt-2 text-sm text-muted">
            Current whole-wiki guidance, separate from the grading evidence above.
          </p>
          <ul className="mt-4 grid gap-2">
            {recommendations.readings.map((reading) => (
              <li key={reading.pageId}>
                <Link
                  className="flex min-h-14 items-center justify-between gap-4 rounded-md border border-line bg-canvas px-3 py-2 hover:border-ink"
                  to={readingTarget(reading)}
                >
                  <span>
                    <span className="block font-bold">{reading.title}</span>
                    <span className="block text-sm text-muted">
                      {recommendationLabels[reading.reason]} · {reading.path}
                    </span>
                  </span>
                  <span aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {recommendations.gaps.length ? (
        <Card className="border-caution/40 bg-caution/10 shadow-none">
          <h3 className="font-serif text-2xl font-semibold">Knowledge gaps</h3>
          <p className="mt-2 text-sm text-muted">Current wiki gaps that may need maintenance or another source.</p>
          <ul className="mt-4 grid gap-2">
            {recommendations.gaps.map((gap) => (
              <li key={`${gap.pageId}:${gap.kind}`}>
                <Link
                  className="flex min-h-14 items-center justify-between gap-4 rounded-md border border-line bg-paper px-3 py-2 hover:border-ink"
                  to={readingTarget(gap)}
                >
                  <span>
                    <span className="block font-bold">{gap.title}</span>
                    <span className="block text-sm text-muted">
                      {gapLabels[gap.kind]} · {gap.path}
                    </span>
                  </span>
                  <span aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
