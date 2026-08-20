import { Link } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
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

function answerText(value: QuizAnswerInput["answer"] | undefined): string {
  if (typeof value === "string") return value.trim() || "No answer recorded";
  return value?.join(", ") || "No answer recorded";
}

const ratingTones = {
  Again: "destructive",
  Hard: "secondary",
  Good: "default",
  Easy: "default",
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
          <Card>
            <CardHeader>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Question {questionPositions.get(question.questionId)} ·{" "}
                {question.kind === "multiple-choice" ? "Multiple choice" : "Free response"}
              </p>
            </CardHeader>
            <CardContent>
              <div>
                <Markdown source={question.prompt} />
              </div>
              {question.kind === "multiple-choice" && question.choices?.length ? (
                <ul className="mt-4 grid gap-2">
                  {question.choices.map((choice) => {
                    const answer = byQuestion.get(question.questionId);
                    const selected =
                      typeof answer === "string" ? answer === choice : (answer?.includes(choice) ?? false);
                    return (
                      <li
                        className={cn(
                          "rounded-md border px-3 py-2",
                          selected ? "border-primary bg-primary/10 font-bold" : "border-border text-muted-foreground",
                        )}
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
                <Alert className="mt-4" variant="destructive">
                  <AlertDescription>Choices unavailable for this question.</AlertDescription>
                </Alert>
              ) : (
                <div className="mt-4 rounded-md border border-border bg-muted p-4">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Answer</p>
                  <div className="mt-2">
                    <Markdown source={answerText(byQuestion.get(question.questionId))} />
                  </div>
                </div>
              )}
            </CardContent>
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
  const settled = Boolean(questionResults.length || pageResults.length || grades.length);
  const displayQuestions = [...questions].sort((left, right) => left.ordinal - right.ordinal);
  const questionPositions = new Map(
    displayQuestions.map((question, index) => [question.questionId, index + 1] as const),
  );
  const pageIds = [...new Set([...pageResults.map((result) => result.pageId), ...grades.map((grade) => grade.pageId)])];

  return (
    <section className="space-y-8" aria-labelledby="results-heading">
      <div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {settled ? "Settled review" : "Submitted guidance"}
        </p>
        <h2 className="mt-2 text-3xl font-semibold" id="results-heading">
          {settled ? "Results" : "While grading is pending"}
        </h2>
      </div>

      {questionResults.length ? (
        <section className="space-y-3" aria-labelledby="question-results-heading">
          <h3 className="text-2xl font-semibold" id="question-results-heading">
            Question feedback
          </h3>
          <ol className="grid gap-3">
            {questionResults.map((result, index) => (
              <li key={result.resultId}>
                <Card>
                  <CardHeader>
                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      Question {questionPositions.get(result.questionId) ?? index + 1}
                    </p>
                  </CardHeader>
                  <CardContent>
                    {result.feedback ? (
                      <Markdown source={result.feedback} />
                    ) : (
                      <p className="text-muted-foreground">Feedback unavailable.</p>
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {pageIds.length ? (
        <section className="space-y-3" aria-labelledby="page-results-heading">
          <h3 className="text-2xl font-semibold" id="page-results-heading">
            Page results
          </h3>
          <ol className="grid gap-3">
            {pageIds.map((pageId, index) => {
              const result = pageResults.find((item) => item.pageId === pageId);
              const grade = grades.find((item) => item.pageId === pageId);
              const rating = result?.rating ?? grade?.rating;
              const feedback = result?.feedback ?? grade?.feedback;
              return (
                <li key={result?.resultId ?? grade?.gradeId ?? pageId}>
                  <Card>
                    <CardContent>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <h4 className="font-bold">
                          {result?.pageLink ? (
                            <Link
                              className="underline decoration-2 decoration-primary underline-offset-4 hover:text-muted-foreground"
                              to={readingTarget(result.pageLink)}
                            >
                              {result.pageLink.path}
                            </Link>
                          ) : (
                            `Reviewed page ${index + 1} unavailable`
                          )}
                        </h4>
                        {rating ? (
                          <Badge variant={ratingTones[rating]}>{rating}</Badge>
                        ) : (
                          <Badge variant="destructive">Unavailable</Badge>
                        )}
                      </div>
                      {feedback ? (
                        <div className="mt-3">
                          <Markdown source={feedback} />
                        </div>
                      ) : (
                        <p className="mt-3 text-muted-foreground">Feedback unavailable.</p>
                      )}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {readings.length ? (
        <Card className="border border-primary/50 bg-primary/10">
          <CardHeader>
            <CardTitle>
              <h3 className="text-2xl font-semibold">{settled ? "Review these sections" : "Pages in this quiz"}</h3>
            </CardTitle>
            <CardDescription>
              {settled
                ? "Exact pages and headings selected from the evidence used for this grade."
                : "These are the pages used by your submitted quiz."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {readings.map((reading) => (
                <li key={`${reading.pageId}:${reading.heading ?? ""}`}>
                  <Link
                    className="flex min-h-11 items-center justify-between rounded-md border border-border bg-card px-3 py-2 font-bold hover:border-primary"
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
          </CardContent>
        </Card>
      ) : null}

      {recommendations.readings.length ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h3 className="text-2xl font-semibold">Continue learning</h3>
            </CardTitle>
            <CardDescription>
              {settled
                ? "Current whole-wiki guidance, separate from the grading evidence above."
                : "Current whole-wiki guidance related to these quiz pages while grading is pending."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {recommendations.readings.map((reading) => (
                <li key={reading.pageId}>
                  <Link
                    className="flex min-h-14 items-center justify-between gap-4 rounded-md border border-border bg-muted px-3 py-2 hover:border-primary"
                    to={readingTarget(reading)}
                  >
                    <span>
                      <span className="block font-bold">{reading.title}</span>
                      <span className="block text-sm text-muted-foreground">
                        {recommendationLabels[reading.reason]} · {reading.path}
                      </span>
                    </span>
                    <span aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {recommendations.gaps.length ? (
        <Card className="border border-secondary/40 bg-secondary/10">
          <CardHeader>
            <CardTitle>
              <h3 className="text-2xl font-semibold">Knowledge gaps</h3>
            </CardTitle>
            <CardDescription>Current wiki gaps that may need maintenance or another source.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {recommendations.gaps.map((gap) => (
                <li key={`${gap.pageId}:${gap.kind}`}>
                  <Link
                    className="flex min-h-14 items-center justify-between gap-4 rounded-md border border-border bg-card px-3 py-2 hover:border-primary"
                    to={readingTarget(gap)}
                  >
                    <span>
                      <span className="block font-bold">{gap.title}</span>
                      <span className="block text-sm text-muted-foreground">
                        {gapLabels[gap.kind]} · {gap.path}
                      </span>
                    </span>
                    <span aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
