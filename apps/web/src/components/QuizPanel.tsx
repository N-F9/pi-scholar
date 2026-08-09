import { Link } from "react-router-dom";
import type {
  PublicQuizQuestionRecord,
  QuizAnswerInput,
  QuizGradeRecord,
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
              <p className="eyebrow">Question {question.ordinal}</p>
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
  grades,
  readings,
}: {
  questions: readonly PublicQuizQuestionRecord[];
  questionResults: readonly QuizQuestionResultRecord[];
  grades: readonly QuizGradeRecord[];
  readings: readonly QuizReadingRecord[];
}) {
  if (!questionResults.length && !grades.length && !readings.length) return null;
  const promptById = new Map(questions.map((question) => [question.questionId, question]));
  const questionIds = [
    ...new Set([...questionResults.map((result) => result.questionId), ...grades.map((grade) => grade.questionId)]),
  ];

  return (
    <section className="space-y-5" aria-labelledby="results-heading">
      <div>
        <p className="eyebrow">Settled review</p>
        <h2 className="mt-2 font-serif text-3xl font-semibold" id="results-heading">
          Results
        </h2>
      </div>
      {questionIds.map((questionId, index) => {
        const result = questionResults.find((item) => item.questionId === questionId);
        const cardGrades = grades.filter((grade) => grade.questionId === questionId);
        return (
          <Card className="shadow-none" key={result?.resultId ?? questionId}>
            <p className="eyebrow">Question {promptById.get(questionId)?.ordinal ?? index + 1}</p>
            {result?.feedback ? <p className="mt-3 leading-7">{result.feedback}</p> : null}
            <h3 className="mt-5 text-sm font-bold">Card results</h3>
            <ul className="mt-2 grid gap-2">
              {cardGrades.map((grade) => (
                <li
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-line bg-canvas p-3"
                  key={grade.gradeId}
                >
                  <div>
                    <p className="font-mono text-xs text-muted">{grade.cardId}</p>
                    <p className="mt-1 text-sm">{grade.feedback}</p>
                  </div>
                  <Badge tone={ratingTones[grade.rating]}>{grade.rating}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}

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
