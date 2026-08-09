import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  PublicQuizRecord,
  QuizAnswerInput,
  QuizAnswersRequest,
  QuizAnswersResult,
  QuizOutcome,
  QuizResult,
  QuizSubmissionRequest,
  QuizSubmissionResult,
  SettingsResult,
} from "../../../../src/contracts";
import {
  api,
  errorMessage,
  formatDate,
  isQuizAnswersResult,
  isQuizResult,
  isQuizSubmissionResult,
  isSettingsResult,
} from "../api";
import { Markdown } from "../components/Markdown";
import { QuizResults, ReadOnlyQuestions } from "../components/QuizPanel";
import { Badge, Button, Card, Spinner, StateView, Textarea } from "../components/ui";

const quietOutcomes: Record<
  Exclude<QuizOutcome, "available" | "submitted" | "expired" | "failed">,
  { title: string; body: string }
> = {
  skipped: {
    title: "Nothing is due today",
    body: "No prerequisite-unblocked review cards are due. Pi Scholar does not generate filler questions.",
  },
  "not-yet-run": {
    title: "No quiz invocation yet",
    body: "An outcome will appear after the quiz skill is invoked.",
  },
  "maintenance-day": {
    title: "Quiz publishing blocked",
    body: "Initialization blocks quiz publishing until it is disabled.",
  },
};
function normalizeAnswers(quiz: PublicQuizRecord, values: readonly QuizAnswerInput[]): QuizAnswerInput[] {
  const byQuestion = new Map(values.map((item) => [item.questionId, item.answer]));
  return quiz.questions.map((question) => ({
    questionId: question.questionId,
    answer: byQuestion.get(question.questionId) ?? "",
  }));
}

function answerRecord(values: readonly QuizAnswerInput[]): Record<string, QuizAnswerInput["answer"]> {
  return Object.fromEntries(values.map((item) => [item.questionId, item.answer])) as Record<
    string,
    QuizAnswerInput["answer"]
  >;
}

function QuizAnswerForm({
  quiz,
  initialAnswers,
}: {
  quiz: PublicQuizRecord;
  initialAnswers: readonly QuizAnswerInput[];
}) {
  const queryClient = useQueryClient();
  const seed = normalizeAnswers(quiz, quiz.draft?.answers ?? initialAnswers);
  const [answers, setAnswers] = useState<Record<string, QuizAnswerInput["answer"]>>(() => answerRecord(seed));
  const [revision, setRevision] = useState(quiz.draft?.revision ?? quiz.revision);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [saveLabel, setSaveLabel] = useState(
    quiz.draft?.savedAt ? `Saved ${formatDate(quiz.draft.savedAt, { timeStyle: "short" })}` : "Draft not saved yet",
  );
  const timer = useRef<number | undefined>(undefined);
  const payload = useMemo<QuizAnswerInput[]>(
    () =>
      quiz.questions.map((question) => ({
        questionId: question.questionId,
        answer: answers[question.questionId] ?? "",
      })),
    [answers, quiz.questions],
  );
  const serialized = JSON.stringify(payload);
  const saved = useRef(JSON.stringify(seed));
  const failed = useRef<string | undefined>(undefined);

  const saveDraft = useMutation({
    mutationFn: (request: QuizAnswersRequest) =>
      api<QuizAnswersResult>(
        `/api/v1/quizzes/${encodeURIComponent(quiz.date)}/answers`,
        {
          method: "PUT",
          body: JSON.stringify(request),
        },
        isQuizAnswersResult,
      ),
    onSuccess: (result, variables) => {
      saved.current = JSON.stringify(variables.answers);
      failed.current = undefined;
      setRevision(result.revision);
      setRevisionConflict(false);
      setSaveLabel(`Saved ${formatDate(result.savedAt, { timeStyle: "short" })}`);
      void queryClient.invalidateQueries({ queryKey: ["quiz", quiz.date] });
    },
    onError: (_error, variables) => {
      failed.current = JSON.stringify(variables.answers);
      setSaveLabel("Draft not saved");
      void queryClient.invalidateQueries({ queryKey: ["quiz", quiz.date] });
    },
  });

  const submission = useMutation({
    mutationFn: (request: QuizSubmissionRequest) =>
      api<QuizSubmissionResult>(
        `/api/v1/quizzes/${encodeURIComponent(quiz.date)}/submission`,
        {
          method: "POST",
          body: JSON.stringify(request),
        },
        isQuizSubmissionResult,
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["quiz", quiz.date] }),
        queryClient.invalidateQueries({ queryKey: ["quizzes"] }),
        queryClient.invalidateQueries({ queryKey: ["workflows"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["quiz", quiz.date] });
    },
  });

  useEffect(() => {
    if (
      serialized === saved.current ||
      serialized === failed.current ||
      revisionConflict ||
      saveDraft.isPending ||
      submission.isPending
    )
      return;
    setSaveLabel("Unsaved changes");
    timer.current = window.setTimeout(() => saveDraft.mutate({ expectedRevision: revision, answers: payload }), 800);
    return () => window.clearTimeout(timer.current);
  }, [payload, revision, revisionConflict, saveDraft.isPending, saveDraft.mutate, serialized, submission.isPending]);

  useEffect(() => {
    const serverRevision = quiz.draft?.revision ?? quiz.revision;
    if (serverRevision <= revision) return;
    const remote = normalizeAnswers(quiz, quiz.draft?.answers ?? quiz.answers ?? []);
    const remoteSerialized = JSON.stringify(remote);
    if (serialized === saved.current) {
      setAnswers(answerRecord(remote));
      saved.current = remoteSerialized;
      failed.current = undefined;
      setRevision(serverRevision);
      setRevisionConflict(false);
      setSaveLabel(
        quiz.draft?.savedAt
          ? `Saved ${formatDate(quiz.draft.savedAt, { timeStyle: "short" })}`
          : "Loaded newer saved answers",
      );
    } else {
      failed.current = serialized;
      setRevisionConflict(true);
      setSaveLabel("A newer saved draft exists");
    }
  }, [quiz, revision, serialized]);

  function useNewerDraft() {
    const remote = normalizeAnswers(quiz, quiz.draft?.answers ?? quiz.answers ?? []);
    const remoteSerialized = JSON.stringify(remote);
    setAnswers(answerRecord(remote));
    saved.current = remoteSerialized;
    failed.current = undefined;
    setRevision(quiz.draft?.revision ?? quiz.revision);
    setRevisionConflict(false);
    setSaveLabel(
      quiz.draft?.savedAt
        ? `Saved ${formatDate(quiz.draft.savedAt, { timeStyle: "short" })}`
        : "Loaded newer saved answers",
    );
  }

  const complete = payload.every((item) =>
    typeof item.answer === "string" ? item.answer.trim().length > 0 : item.answer.length > 0,
  );

  async function submitFinal() {
    if (revisionConflict) return;
    window.clearTimeout(timer.current);
    let expectedRevision = revision;
    try {
      if (serialized !== saved.current) {
        const result = await saveDraft.mutateAsync({ expectedRevision, answers: payload });
        expectedRevision = result.revision;
      }
      await submission.mutateAsync({ expectedRevision });
    } catch {
      // Mutation state renders the actionable API error without losing the local answers.
    }
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void submitFinal();
      }}
    >
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-paper px-4 py-3"
        aria-live="polite"
      >
        <span
          className={saveDraft.isError || revisionConflict ? "text-sm font-bold text-danger" : "text-sm text-muted"}
          role={revisionConflict ? "alert" : undefined}
        >
          {saveDraft.isPending
            ? "Saving draft…"
            : revisionConflict
              ? "A newer draft was saved elsewhere. Load it before continuing."
              : saveDraft.isError
                ? `Draft not saved: ${errorMessage(saveDraft.error)}`
                : saveLabel}
        </span>
        {revisionConflict ? (
          <Button variant="secondary" onClick={useNewerDraft}>
            Use newer saved draft
          </Button>
        ) : null}
        {saveDraft.isError && !revisionConflict ? (
          <Button variant="quiet" onClick={() => saveDraft.mutate({ expectedRevision: revision, answers: payload })}>
            Try draft save again
          </Button>
        ) : null}
      </div>

      <ol className="grid gap-5">
        {[...quiz.questions]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((question) => (
            <li key={question.questionId}>
              <Card className="shadow-none">
                <p className="eyebrow">
                  Question {question.ordinal} of {quiz.questions.length}
                </p>
                <div className="mt-3">
                  <Markdown source={question.prompt} />
                </div>
                <ul className="mt-4 flex flex-wrap gap-2" aria-label="Review cards tested">
                  {question.cardIds.map((cardId) => (
                    <li key={cardId}>
                      <Badge>{cardId}</Badge>
                    </li>
                  ))}
                </ul>
                <fieldset className="mt-5" disabled={saveDraft.isPending || submission.isPending || revisionConflict}>
                  <legend className="sr-only">
                    Answer question {question.ordinal}: {question.prompt}
                  </legend>
                  {question.kind === "multiple-choice" && question.choices?.length ? (
                    <div className="grid gap-3">
                      {question.choices.map((choice) => {
                        const value = answers[question.questionId];
                        const selected =
                          typeof value === "string" ? value === choice : (value?.includes(choice) ?? false);
                        return (
                          <label
                            className={
                              selected
                                ? "flex min-h-12 cursor-pointer items-start gap-3 rounded-md border-2 border-accent bg-accent/10 p-3 font-semibold"
                                : "flex min-h-12 cursor-pointer items-start gap-3 rounded-md border-2 border-line bg-paper p-3 hover:border-ink"
                            }
                            key={choice}
                          >
                            <input
                              className="mt-1 size-5 shrink-0 accent-accent"
                              type="radio"
                              name={question.questionId}
                              value={choice}
                              checked={selected}
                              onChange={() => setAnswers((current) => ({ ...current, [question.questionId]: choice }))}
                            />
                            <span>{choice}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : question.kind === "multiple-choice" ? (
                    <p className="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger" role="alert">
                      No selectable choices were provided for this question.
                    </p>
                  ) : (
                    <label className="block" htmlFor={`answer-${question.questionId}`}>
                      <span className="sr-only">Answer to question {question.ordinal}</span>
                      <Textarea
                        id={`answer-${question.questionId}`}
                        rows={6}
                        value={
                          typeof answers[question.questionId] === "string"
                            ? (answers[question.questionId] as string)
                            : ""
                        }
                        onChange={(event) =>
                          setAnswers((current) => ({ ...current, [question.questionId]: event.target.value }))
                        }
                        placeholder="Recall from memory, then explain in your own words."
                      />
                    </label>
                  )}
                </fieldset>
              </Card>
            </li>
          ))}
      </ol>

      <Card className="border-ink bg-ink text-paper">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-serif text-2xl font-semibold">Finished?</h2>
            <p className="mt-1 text-sm text-paper/75">
              Final submission seals this answer revision. It cannot be edited or graded twice.
            </p>
          </div>
          <Button
            className="shrink-0 border-accent bg-accent text-accent-ink hover:bg-paper hover:text-ink"
            type="submit"
            disabled={!complete || saveDraft.isPending || submission.isPending || revisionConflict}
          >
            {submission.isPending ? "Submitting…" : "Submit final answers"}
          </Button>
        </div>
        {!complete ? (
          <p className="mt-4 text-sm text-paper/75">Answer every displayed question before final submission.</p>
        ) : null}
        {submission.isError ? (
          <p className="mt-4 text-sm font-bold text-paper" role="alert">
            {errorMessage(submission.error)}
          </p>
        ) : null}
      </Card>
    </form>
  );
}

function TodayContent({ result }: { result: QuizResult }) {
  if (result.outcome === "failed")
    return (
      <StateView title="Today’s quiz could not be generated" tone="danger">
        <p>{result.message ?? "This quiz skill invocation published no partial quiz. Check Workflows for details."}</p>
        <Link
          className="mt-4 inline-block font-bold underline decoration-accent decoration-2 underline-offset-4"
          to="/workflows"
        >
          View workflows
        </Link>
      </StateView>
    );
  if (result.outcome === "expired")
    return (
      <StateView title="This quiz has expired">
        <p>{result.message ?? "Expired quizzes remain read-only and do not change the review schedule."}</p>
        <Link
          className="mt-4 inline-block font-bold underline decoration-accent decoration-2 underline-offset-4"
          to={result.quiz ? `/history/${result.quiz.date}` : "/history"}
        >
          Open in History
        </Link>
      </StateView>
    );
  if (result.outcome !== "available" && result.outcome !== "submitted") {
    const copy = quietOutcomes[result.outcome];
    return (
      <StateView title={copy.title}>
        <p>{result.message ?? copy.body}</p>
      </StateView>
    );
  }
  if (!result.quiz)
    return (
      <StateView title="Quiz data is unavailable" tone="danger">
        <p>This quiz skill invocation did not include a quiz. Refresh or check Workflows.</p>
      </StateView>
    );

  if (result.outcome === "available" && result.quiz.status === "open")
    return <QuizAnswerForm key={result.quiz.quizId} quiz={result.quiz} initialAnswers={result.answers} />;

  const grades = result.grades.length ? result.grades : result.quiz.grades;
  const readings = result.readings.length ? result.readings : result.quiz.readings;
  return (
    <div className="space-y-8">
      <StateView title={grades.length ? "Review complete" : "Answers submitted"}>
        <p>
          {grades.length
            ? "Your results are settled below."
            : "Your sealed answers are being graded. This page updates when grading finishes."}
        </p>
        {!grades.length ? (
          <Link
            className="mt-4 inline-block font-bold underline decoration-accent decoration-2 underline-offset-4"
            to="/workflows"
          >
            View grading workflow
          </Link>
        ) : null}
      </StateView>
      <ReadOnlyQuestions
        questions={result.quiz.questions}
        answers={result.quiz.answers.length ? result.quiz.answers : result.answers}
      />
      <QuizResults
        questions={result.quiz.questions}
        questionResults={result.quiz.questionResults}
        grades={grades}
        readings={readings}
      />
    </div>
  );
}

export function TodayPage() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api<SettingsResult>("/api/v1/settings", { signal }, isSettingsResult),
  });
  const date = settings.data?.settings.facts.localDate;
  const query = useQuery({
    queryKey: ["quiz", date],
    queryFn: ({ signal }) =>
      api<QuizResult>(`/api/v1/quizzes/${encodeURIComponent(date ?? "")}`, { signal }, isQuizResult),
    enabled: Boolean(date),
    refetchOnWindowFocus: true,
    refetchInterval: ({ state }) =>
      state.data?.outcome === "submitted" && !(state.data.grades.length || state.data.quiz?.grades.length)
        ? 5_000
        : false,
  });

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">
          {date ? formatDate(date, { weekday: "long", month: "long", day: "numeric" }) : "Vault calendar"}
          {settings.data ? ` · ${settings.data.settings.timezone}` : ""}
        </p>
        <h1 className="page-heading mt-2">Today</h1>
        <p className="mt-3 max-w-2xl text-muted">One bounded review, grounded in the exact pages you have collected.</p>
      </header>
      {settings.isLoading ? <Spinner label="Loading vault date" /> : null}
      {settings.isError ? (
        <StateView title="Could not load the vault date" tone="danger">
          <p>{errorMessage(settings.error)}</p>
          <Button className="mt-4" variant="secondary" onClick={() => void settings.refetch()}>
            Try again
          </Button>
        </StateView>
      ) : null}
      {date && query.isLoading ? <Spinner label="Loading today’s review" /> : null}
      {date && query.isError ? (
        <StateView title="Could not load today" tone="danger">
          <p>{errorMessage(query.error)}</p>
          <Button className="mt-4" variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </StateView>
      ) : null}
      {query.data ? <TodayContent result={query.data} /> : null}
    </div>
  );
}
