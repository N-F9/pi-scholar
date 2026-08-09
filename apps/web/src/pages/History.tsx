import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import type { PublicQuizRecord, QuizListResult, QuizResult, QuizStatus } from "../../../../src/contracts";
import { api, errorMessage, formatDate, isQuizListResult, isQuizResult } from "../api";
import { QuizResults, ReadOnlyQuestions } from "../components/QuizPanel";
import { Badge, Button, Spinner, StateView } from "../components/ui";

const statusTones: Record<QuizStatus, "neutral" | "positive" | "caution" | "danger"> = {
  open: "caution",
  submitted: "positive",
  expired: "neutral",
  skipped: "neutral",
  failed: "danger",
};

export function HistoryPage() {
  const query = useQuery({
    queryKey: ["quizzes"],
    queryFn: ({ signal }) => api<QuizListResult>("/api/v1/quizzes", { signal }, isQuizListResult),
  });

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Dated sheets</p>
        <h1 className="page-heading mt-2">History</h1>
        <p className="mt-3 max-w-2xl text-muted">
          Past quiz skill invocations, sealed answers, results, and exact follow-up readings.
        </p>
      </header>

      {query.isLoading ? <Spinner label="Loading quiz history" /> : null}
      {query.isError ? (
        <StateView title="Could not load history" tone="danger">
          <p>{errorMessage(query.error)}</p>
          <Button className="mt-4" variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </StateView>
      ) : null}
      {query.data?.quizzes.length === 0 ? (
        <StateView title="No dated sheets yet">
          <p>Dated sheets appear here when quiz skill invocations publish them.</p>
        </StateView>
      ) : null}

      <ol className="grid gap-3">
        {query.data?.quizzes.map((quiz) => (
          <HistoryRow key={quiz.quizId} quiz={quiz} />
        ))}
      </ol>
    </div>
  );
}

function HistoryRow({ quiz }: { quiz: PublicQuizRecord }) {
  return (
    <li>
      <Link
        className="group flex min-h-20 items-center justify-between gap-4 rounded-lg border border-line bg-paper p-4 shadow-quiet transition-colors duration-200 ease-expo hover:border-ink"
        to={`/history/${quiz.date}`}
      >
        <div>
          <p className="font-serif text-xl font-semibold">
            {formatDate(quiz.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </p>
          <p className="mt-1 text-sm text-muted">
            {quiz.questions.length
              ? `${quiz.questions.length} ${quiz.questions.length === 1 ? "question" : "questions"}`
              : "No quiz sheet"}
            {quiz.status === "expired" ? " · read-only" : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={statusTones[quiz.status]}>{quiz.status}</Badge>
          <span
            className="text-xl transition-transform duration-200 ease-expo group-hover:translate-x-1"
            aria-hidden="true"
          >
            →
          </span>
        </div>
      </Link>
    </li>
  );
}

export function HistoryDetailPage() {
  const { date = "" } = useParams();
  const query = useQuery({
    queryKey: ["quiz", date],
    queryFn: ({ signal }) => api<QuizResult>(`/api/v1/quizzes/${encodeURIComponent(date)}`, { signal }, isQuizResult),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
  });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return (
      <StateView title="Invalid history date" tone="danger">
        <p>Choose a dated sheet from History.</p>
      </StateView>
    );

  return (
    <div className="space-y-8">
      <header>
        <Link className="inline-flex min-h-11 items-center font-bold text-muted hover:text-ink" to="/history">
          ← All history
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Dated sheet</p>
            <h1 className="page-heading mt-2">
              {formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            </h1>
          </div>
          {query.data?.quiz ? (
            <Badge tone={statusTones[query.data.quiz.status]}>
              {query.data.quiz.status}
              {query.data.quiz.status === "expired" ? " · read-only" : ""}
            </Badge>
          ) : null}
        </div>
      </header>

      {query.isLoading ? <Spinner label="Loading dated sheet" /> : null}
      {query.isError ? (
        <StateView title="Could not load this sheet" tone="danger">
          <p>{errorMessage(query.error)}</p>
        </StateView>
      ) : null}
      {query.data && (!query.data.quiz || query.data.quiz.questions.length === 0) ? (
        <StateView
          title={
            query.data.outcome === "maintenance-day"
              ? "Quiz publishing blocked"
              : query.data.outcome === "skipped"
                ? "No eligible cards"
                : query.data.outcome === "failed"
                  ? "Quiz generation failed"
                  : "No quiz sheet"
          }
          tone={query.data.outcome === "failed" ? "danger" : "neutral"}
        >
          <p>{query.data.message ?? "No question sheet was published for this date."}</p>
        </StateView>
      ) : null}
      {query.data?.quiz && query.data.quiz.questions.length > 0 ? (
        <>
          {query.data.quiz.status === "expired" ? (
            <StateView title="Expired without submission">
              <p>This sheet is preserved read-only. It recorded no grade and changed no review schedule.</p>
            </StateView>
          ) : null}
          <ReadOnlyQuestions
            questions={query.data.quiz.questions}
            answers={query.data.quiz.answers.length ? query.data.quiz.answers : query.data.answers}
          />
          <QuizResults
            questions={query.data.quiz.questions}
            questionResults={query.data.quiz.questionResults}
            grades={query.data.grades.length ? query.data.grades : query.data.quiz.grades}
            readings={query.data.readings.length ? query.data.readings : query.data.quiz.readings}
          />
        </>
      ) : null}
    </div>
  );
}
