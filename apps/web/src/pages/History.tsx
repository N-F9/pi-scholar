import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { PublicQuizRecord, QuizListResult, QuizResult, QuizStatus } from "../../../../src/contracts";
import { api, errorMessage, formatDate, isQuizListResult, isQuizResult } from "../api";
import { QuizResults, ReadOnlyQuestions } from "../components/QuizPanel";

const sectionLabelClass = "text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground";

const statusVariants: Record<QuizStatus, "outline" | "default" | "secondary" | "destructive"> = {
  open: "secondary",
  submitted: "default",
  expired: "outline",
  skipped: "outline",
  failed: "destructive",
};

export function HistoryPage() {
  const query = useQuery({
    queryKey: ["quizzes"],
    queryFn: ({ signal }) => api<QuizListResult>("/api/v1/quizzes", { signal }, isQuizListResult),
  });

  return (
    <div className="space-y-8">
      <header>
        <p className={sectionLabelClass}>Dated sheets</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">History</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Past quiz skill invocations, sealed answers, results, exact readings, and current whole-wiki guidance.
        </p>
      </header>

      {query.isLoading ? (
        <div className="flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
          <Spinner aria-hidden="true" />
          <span>Loading quiz history</span>
        </div>
      ) : null}
      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle role="heading" aria-level={2}>
            Could not load history
          </AlertTitle>
          <AlertDescription>
            <p>{errorMessage(query.error)}</p>
            <Button className="mt-4 min-h-11" variant="outline" type="button" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {query.data?.quizzes.length === 0 ? (
        <Empty role="status" className="items-start border border-border bg-card p-6 text-left">
          <EmptyHeader className="items-start">
            <EmptyTitle className="text-2xl font-semibold" role="heading" aria-level={2}>
              No dated sheets yet
            </EmptyTitle>
            <EmptyDescription className="mt-2 max-w-prose">
              Dated sheets appear here when quiz skill invocations publish them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
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
        className="group flex min-h-20 items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 transition-colors duration-200 hover:border-foreground"
        to={`/history/${quiz.date}`}
      >
        <div>
          <p className="text-xl font-semibold">
            {formatDate(quiz.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {quiz.questions.length
              ? `${quiz.questions.length} ${quiz.questions.length === 1 ? "question" : "questions"}`
              : "No quiz sheet"}
            {quiz.status === "expired" ? " · read-only" : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={statusVariants[quiz.status]}>{quiz.status}</Badge>
          <span className="text-xl transition-transform duration-200 group-hover:translate-x-1" aria-hidden="true">
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
    refetchOnWindowFocus: true,
    refetchInterval: ({ state }) =>
      state.data?.outcome === "submitted" &&
      !(state.data.quiz?.pageResults.length || state.data.grades.length || state.data.quiz?.grades.length)
        ? 5_000
        : false,
  });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return (
      <Alert variant="destructive">
        <AlertTitle role="heading" aria-level={2}>
          Invalid history date
        </AlertTitle>
        <AlertDescription>Choose a dated sheet from History.</AlertDescription>
      </Alert>
    );

  const settled = Boolean(
    query.data?.quiz &&
      (query.data.quiz.pageResults.length || query.data.grades.length || query.data.quiz.grades.length),
  );
  const gradingPending = query.data?.outcome === "submitted" && !settled;

  return (
    <div className="space-y-8">
      <header>
        <Link
          className="inline-flex min-h-11 items-center font-bold text-muted-foreground hover:text-foreground"
          to="/history"
        >
          ← All history
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className={sectionLabelClass}>Dated sheet</p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">
              {formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            </h1>
          </div>
          {query.data?.quiz ? (
            <Badge variant={statusVariants[query.data.quiz.status]}>
              {query.data.quiz.status}
              {query.data.quiz.status === "expired" ? " · read-only" : ""}
            </Badge>
          ) : null}
        </div>
      </header>

      {query.isLoading ? (
        <div className="flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
          <Spinner aria-hidden="true" />
          <span>Loading dated sheet</span>
        </div>
      ) : null}
      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle role="heading" aria-level={2}>
            Could not load this sheet
          </AlertTitle>
          <AlertDescription>{errorMessage(query.error)}</AlertDescription>
        </Alert>
      ) : null}
      {query.data && (!query.data.quiz || query.data.quiz.questions.length === 0) ? (
        query.data.outcome === "failed" ? (
          <Alert variant="destructive">
            <AlertTitle role="heading" aria-level={2}>
              Quiz generation failed
            </AlertTitle>
            <AlertDescription>
              {query.data.message ?? "No question sheet was published for this date."}
            </AlertDescription>
          </Alert>
        ) : (
          <Empty role="status" className="items-start border border-border bg-card p-6 text-left">
            <EmptyHeader className="items-start">
              <EmptyTitle className="text-2xl font-semibold" role="heading" aria-level={2}>
                {query.data.outcome === "maintenance-day"
                  ? "Quiz publishing blocked"
                  : query.data.outcome === "skipped"
                    ? "No eligible pages"
                    : "No quiz sheet"}
              </EmptyTitle>
              <EmptyDescription className="mt-2 max-w-prose">
                {query.data.message ?? "No question sheet was published for this date."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      ) : null}
      {gradingPending ? (
        <Empty role="status" className="items-start border border-border bg-card p-6 text-left">
          <EmptyHeader className="items-start">
            <EmptyTitle className="text-2xl font-semibold" role="heading" aria-level={2}>
              Answers submitted
            </EmptyTitle>
            <EmptyDescription className="mt-2 max-w-prose">
              Your sealed answers are being graded. This page updates when grading finishes.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="mt-4 items-start">
            <Link className="font-bold underline decoration-primary decoration-2 underline-offset-4" to="/workflows">
              View grading workflow
            </Link>
          </EmptyContent>
        </Empty>
      ) : null}
      {query.data?.quiz && query.data.quiz.questions.length > 0 ? (
        <>
          {query.data.quiz.status === "expired" ? (
            <Empty role="status" className="items-start border border-border bg-card p-6 text-left">
              <EmptyHeader className="items-start">
                <EmptyTitle className="text-2xl font-semibold" role="heading" aria-level={2}>
                  Expired without submission
                </EmptyTitle>
                <EmptyDescription className="mt-2 max-w-prose">
                  This sheet is preserved read-only. It recorded no grade and changed no review schedule.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          <ReadOnlyQuestions
            questions={query.data.quiz.questions}
            answers={query.data.quiz.answers.length ? query.data.quiz.answers : query.data.answers}
          />
          <QuizResults
            questions={query.data.quiz.questions}
            questionResults={query.data.quiz.questionResults}
            pageResults={query.data.quiz.pageResults}
            grades={query.data.grades.length ? query.data.grades : query.data.quiz.grades}
            readings={query.data.readings.length ? query.data.readings : query.data.quiz.readings}
            recommendations={query.data.recommendations}
          />
        </>
      ) : null}
    </div>
  );
}
