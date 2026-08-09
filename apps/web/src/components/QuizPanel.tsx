import { Link } from "react-router-dom";
import type {
  PublicQuizQuestionRecord,
  QuizAnswerInput,
  QuizGradeRecord,
  QuizPageResultRecord,
  QuizQuestionResultRecord,
  QuizReadingRecord,
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
  return (
    <ol className="grid gap-5">
      {[...questions]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((question) => (
          <li key={question.questionId}>
            <Card className="shadow-none">
              <p className="eyebrow">
                Question {question.ordinal} · {question.kind === "multiple-choice" ? "Multiple choice" : "Short answer"}
              </p>
              <div className="mt-3">
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
                        className={
                          selected
                            ? "rounded-md border border-accent bg-accent/10 px-3 py-2 font-bold"
                            : "rounded-md border border-line px-3 py-2 text-muted"
                        }
                        key={choice}
                      >
                        {choice}
                        {selected ? " — selected" : ""}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="mt-4 rounded-md border border-line bg-canvas p-4">
                  <p className="eyebrow">Answer</p>
                  <p className="mt-2 whitespace-pre-wrap">{answerText(byQuestion.get(question.questionId))}</p>
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
}: {
  questions: readonly PublicQuizQuestionRecord[];
  questionResults: readonly QuizQuestionResultRecord[];
  pageResults: readonly QuizPageResultRecord[];
  grades: readonly QuizGradeRecord[];
  readings: readonly QuizReadingRecord[];
}) {
  if (!questionResults.length && !pageResults.length && !grades.length && !readings.length) return null;
  const promptById = new Map(questions.map((question) => [question.questionId, question]));
  const pageIds = [...new Set([...pageResults.map((result) => result.pageId), ...grades.map((grade) => grade.pageId)])];

  return (
    <section className="space-y-5" aria-labelledby="results-heading">
      <div>
        <p className="eyebrow">Settled review</p>
        <h2 className="mt-2 font-serif text-3xl font-semibold" id="results-heading">
          Results
        </h2>
      </div>

      {questionResults.map((result, index) => (
        <Card className="shadow-none" key={result.resultId}>
          <p className="eyebrow">Question {promptById.get(result.questionId)?.ordinal ?? index + 1}</p>
          <p className="mt-3 leading-7">{result.feedback}</p>
        </Card>
      ))}

      {pageIds.length ? (
        <section className="space-y-3" aria-labelledby="page-results-heading">
          <h3 className="font-serif text-2xl font-semibold" id="page-results-heading">
            Page results
          </h3>
          <ul className="grid gap-3">
            {pageIds.map((pageId, index) => {
              const result = pageResults.find((item) => item.pageId === pageId);
              const grade = grades.find((item) => item.pageId === pageId);
              const rating = result?.rating ?? grade?.rating;
              const feedback = result?.feedback ?? grade?.feedback;
              const reading = readings.find((item) => item.pageId === pageId) ?? result?.readings[0];
              if (!rating) return null;
              return (
                <li
                  className="rounded-lg border border-line bg-paper p-5 shadow-quiet sm:p-6"
                  key={result?.resultId ?? grade?.gradeId ?? pageId}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h4 className="font-bold">
                      {reading ? (
                        <Link
                          className="underline decoration-accent decoration-2 underline-offset-4 hover:text-muted"
                          to={readingTarget(reading)}
                        >
                          {reading.path}
                          {reading.heading ? ` — ${reading.heading}` : ""}
                        </Link>
                      ) : (
                        `Reviewed page ${index + 1}`
                      )}
                    </h4>
                    <Badge tone={ratingTones[rating]}>{rating}</Badge>
                  </div>
                  {feedback ? <p className="mt-3 leading-7">{feedback}</p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {readings.length ? (
        <Card className="border-accent/50 bg-accent/10 shadow-none">
          <h3 className="font-serif text-2xl font-semibold">Read next</h3>
          <p className="mt-2 text-sm text-muted">Return to the exact pages and headings connected to these results.</p>
          <ul className="mt-4 grid gap-2">
            {readings.map((reading) => {
              const target = readingTarget(reading);
              return (
                <li key={`${reading.pageId}:${reading.heading ?? ""}`}>
                  <Link
                    className="flex min-h-11 items-center justify-between rounded-md border border-line bg-paper px-3 py-2 font-bold hover:border-ink"
                    to={target}
                  >
                    <span>
                      {reading.path}
                      {reading.heading ? ` — ${reading.heading}` : ""}
                    </span>
                    <span aria-hidden="true">→</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
