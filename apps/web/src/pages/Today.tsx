import MDEditor, { commands } from "@uiw/react-md-editor/nohighlight";
import "@uiw/react-md-editor/markdown-editor.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
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

const ANSWER_EDITOR_COMMANDS = [
  commands.bold,
  commands.italic,
  commands.strikethrough,
  commands.link,
  commands.quote,
  commands.unorderedListCommand,
  commands.orderedListCommand,
  commands.checkedListCommand,
  commands.code,
  commands.codeBlock,
];

const quietOutcomes: Record<
  Exclude<QuizOutcome, "available" | "submitted" | "expired" | "failed">,
  { title: string; body: string }
> = {
  skipped: {
    title: "Nothing is due today",
    body: "No prerequisite-unblocked pages are due. Pi Scholar does not generate filler questions.",
  },
  "not-yet-run": {
    title: "No quiz invocation yet",
    body: "An outcome will appear after the quiz skill is invoked.",
  },
  "maintenance-day": {
    title: "Quiz publishing blocked",
    body: "Maintenance mode blocks quiz publishing until it is disabled.",
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
  const displayQuestions = [...quiz.questions].sort((left, right) => left.ordinal - right.ordinal);
  const questionPositions = new Map(
    displayQuestions.map((question, index) => [question.questionId, index + 1] as const),
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
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3"
        aria-live="polite"
      >
        <span
          className={
            saveDraft.isError || revisionConflict
              ? "text-sm font-bold text-destructive"
              : "text-sm text-muted-foreground"
          }
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
          <Button className="min-h-11" variant="outline" type="button" onClick={useNewerDraft}>
            Use newer saved draft
          </Button>
        ) : null}
        {saveDraft.isError && !revisionConflict ? (
          <Button
            className="min-h-11"
            variant="ghost"
            type="button"
            onClick={() => saveDraft.mutate({ expectedRevision: revision, answers: payload })}
          >
            Try draft save again
          </Button>
        ) : null}
      </div>

      <ol className="grid gap-5">
        {displayQuestions.map((question) => (
          <li key={question.questionId}>
            <Card className="shadow-none">
              <CardHeader>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Question {questionPositions.get(question.questionId)} of {displayQuestions.length} ·{" "}
                  {question.kind === "multiple-choice" ? "Multiple choice" : "Free response"}
                </p>
                <div className="mt-3">
                  <Markdown source={question.prompt} />
                </div>
              </CardHeader>
              <CardContent>
                <fieldset className="mt-1" disabled={saveDraft.isPending || submission.isPending || revisionConflict}>
                  <legend className="sr-only" id={`answer-legend-${question.questionId}`}>
                    Answer question {questionPositions.get(question.questionId)}: {question.prompt}
                  </legend>
                  {question.kind === "multiple-choice" && question.choices?.length ? (
                    <RadioGroup
                      aria-labelledby={`answer-legend-${question.questionId}`}
                      className="grid gap-3"
                      name={question.questionId}
                      onValueChange={(choice) =>
                        setAnswers((current) => ({ ...current, [question.questionId]: choice }))
                      }
                      value={
                        typeof answers[question.questionId] === "string"
                          ? (answers[question.questionId] as string)
                          : (answers[question.questionId]?.[0] ?? "")
                      }
                    >
                      {question.choices.map((choice, choiceIndex) => {
                        const value = answers[question.questionId];
                        const selected =
                          typeof value === "string" ? value === choice : (value?.includes(choice) ?? false);
                        const choiceId = `answer-${question.questionId}-choice-${choiceIndex}`;
                        return (
                          <label
                            className={
                              selected
                                ? "flex min-h-12 cursor-pointer items-start gap-3 rounded-md border-2 border-primary bg-primary/10 p-3 font-semibold"
                                : "flex min-h-12 cursor-pointer items-start gap-3 rounded-md border-2 border-border bg-card p-3 hover:border-foreground"
                            }
                            htmlFor={choiceId}
                            key={choice}
                          >
                            <RadioGroupItem className="mt-1" id={choiceId} value={choice} />
                            <Markdown inline source={choice} />
                          </label>
                        );
                      })}
                    </RadioGroup>
                  ) : question.kind === "multiple-choice" ? (
                    <Alert variant="destructive">
                      <AlertDescription>No selectable choices were provided for this question.</AlertDescription>
                    </Alert>
                  ) : (
                    <div className="space-y-3">
                      <label className="sr-only" htmlFor={`answer-${question.questionId}`}>
                        Answer to question {questionPositions.get(question.questionId)}
                      </label>
                      <MDEditor
                        autoFocus={false}
                        className="min-h-[240px] rounded-lg [--color-accent-fg:var(--foreground)] [--color-fg-default:var(--foreground)] [--color-neutral-muted:var(--muted)] [--md-editor-background-color:var(--background)] [--md-editor-box-shadow-color:var(--border)] [--md-editor-font-family:var(--font-sans)] focus-within:ring-3 focus-within:ring-ring/50 focus-within:ring-offset-2 focus-within:ring-offset-background [&_.w-md-editor-text-input]:text-foreground [&_.w-md-editor-toolbar_li>button]:min-h-11 [&_.w-md-editor-toolbar_li>button]:min-w-11 [&_.w-md-editor-toolbar_li>button]:text-foreground"
                        commands={ANSWER_EDITOR_COMMANDS}
                        defaultTabEnable={true}
                        extraCommands={[]}
                        height={240}
                        onChange={(value) =>
                          setAnswers((current) => ({ ...current, [question.questionId]: value ?? "" }))
                        }
                        preview="edit"
                        textareaProps={{
                          id: `answer-${question.questionId}`,
                          placeholder: "Recall from memory, then explain in your own words.",
                        }}
                        value={
                          typeof answers[question.questionId] === "string"
                            ? (answers[question.questionId] as string)
                            : ""
                        }
                        visibleDragbar={false}
                      />
                      <section
                        className="rounded-md border border-border bg-muted p-4"
                        aria-labelledby={`answer-preview-${question.questionId}`}
                      >
                        <p
                          className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground"
                          id={`answer-preview-${question.questionId}`}
                        >
                          Live preview
                        </p>
                        {typeof answers[question.questionId] === "string" &&
                        (answers[question.questionId] as string).trim() ? (
                          <div className="mt-2">
                            <Markdown source={answers[question.questionId] as string} />
                          </div>
                        ) : (
                          <p className="mt-2 text-sm text-muted-foreground">Your formatted answer will appear here.</p>
                        )}
                      </section>
                    </div>
                  )}
                </fieldset>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>

      <Card className="border-foreground bg-foreground text-background">
        <CardHeader className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
          <div>
            <CardTitle>
              <h2 className="text-2xl font-semibold">Finished?</h2>
            </CardTitle>
            <p className="mt-1 text-sm text-background/75">
              Final submission seals this answer revision. It cannot be edited or graded twice.
            </p>
          </div>
          <Button
            className="min-h-11 shrink-0 border-background bg-background text-foreground hover:bg-card hover:text-foreground"
            type="submit"
            disabled={!complete || saveDraft.isPending || submission.isPending || revisionConflict}
          >
            {submission.isPending ? "Submitting…" : "Submit final answers"}
          </Button>
        </CardHeader>
        {!complete || submission.isError ? (
          <CardContent className="pt-0">
            {!complete ? (
              <p className="text-sm text-background/75">Answer every displayed question before final submission.</p>
            ) : null}
            {submission.isError ? (
              <p className="mt-4 text-sm font-bold text-background" role="alert">
                {errorMessage(submission.error)}
              </p>
            ) : null}
          </CardContent>
        ) : null}
      </Card>
    </form>
  );
}

function TodayContent({ result }: { result: QuizResult }) {
  if (result.outcome === "failed")
    return (
      <Alert variant="destructive">
        <AlertTitle role="heading" aria-level={2}>
          Today’s quiz could not be generated
        </AlertTitle>
        <AlertDescription>
          <p>
            {result.message ?? "This quiz skill invocation published no partial quiz. Check Workflows for details."}
          </p>
          <Link
            className="mt-4 inline-block font-bold underline decoration-primary decoration-2 underline-offset-4"
            to="/workflows"
          >
            View workflows
          </Link>
        </AlertDescription>
      </Alert>
    );
  if (result.outcome === "expired")
    return (
      <Empty className="items-start rounded-lg border border-border bg-card p-6 text-left" role="status">
        <EmptyHeader className="items-start text-left">
          <EmptyTitle role="heading" aria-level={2}>
            This quiz has expired
          </EmptyTitle>
          <EmptyDescription>
            {result.message ?? "Expired quizzes remain read-only and do not change the review schedule."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="items-start max-w-prose">
          <Link
            className="font-bold underline decoration-primary decoration-2 underline-offset-4"
            to={result.quiz ? `/history/${result.quiz.date}` : "/history"}
          >
            Open in History
          </Link>
        </EmptyContent>
      </Empty>
    );
  if (result.outcome !== "available" && result.outcome !== "submitted") {
    const copy = quietOutcomes[result.outcome];
    return (
      <Empty className="items-start rounded-lg border border-border bg-card p-6 text-left" role="status">
        <EmptyHeader className="items-start text-left">
          <EmptyTitle role="heading" aria-level={2}>
            {copy.title}
          </EmptyTitle>
          <EmptyDescription>{result.message ?? copy.body}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (!result.quiz)
    return (
      <Alert variant="destructive">
        <AlertTitle role="heading" aria-level={2}>
          Quiz data is unavailable
        </AlertTitle>
        <AlertDescription>
          This quiz skill invocation did not include a quiz. Refresh or check Workflows.
        </AlertDescription>
      </Alert>
    );

  if (result.outcome === "available" && result.quiz.status === "open")
    return <QuizAnswerForm key={result.quiz.quizId} quiz={result.quiz} initialAnswers={result.answers} />;

  const grades = result.grades.length ? result.grades : result.quiz.grades;
  const readings = result.readings.length ? result.readings : result.quiz.readings;
  const settled = result.quiz.pageResults.length > 0 || grades.length > 0;
  return (
    <div className="space-y-8">
      <Empty className="items-start rounded-lg border border-border bg-card p-6 text-left" role="status">
        <EmptyHeader className="items-start text-left">
          <EmptyTitle role="heading" aria-level={2}>
            {settled ? "Review complete" : "Answers submitted"}
          </EmptyTitle>
          <EmptyDescription>
            {settled
              ? "Your results are settled below."
              : "Your sealed answers are being graded. This page updates when grading finishes."}
          </EmptyDescription>
        </EmptyHeader>
        {!settled ? (
          <EmptyContent className="items-start max-w-prose">
            <Link className="font-bold underline decoration-primary decoration-2 underline-offset-4" to="/workflows">
              View grading workflow
            </Link>
          </EmptyContent>
        ) : null}
      </Empty>
      <ReadOnlyQuestions
        questions={result.quiz.questions}
        answers={result.quiz.answers.length ? result.quiz.answers : result.answers}
      />
      <QuizResults
        questions={result.quiz.questions}
        questionResults={result.quiz.questionResults}
        pageResults={result.quiz.pageResults}
        grades={grades}
        readings={readings}
        recommendations={result.recommendations}
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
      state.data?.outcome === "submitted" &&
      !(state.data.quiz?.pageResults.length || state.data.grades.length || state.data.quiz?.grades.length)
        ? 5_000
        : false,
  });

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {date ? formatDate(date, { weekday: "long", month: "long", day: "numeric" }) : "Vault calendar"}
          {settings.data ? ` · ${settings.data.settings.timezone}` : ""}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Today</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          One bounded review, grounded in the exact pages you have collected.
        </p>
      </header>
      {settings.isLoading ? (
        <div className="flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
          <Spinner aria-hidden="true" />
          <span>Loading vault date</span>
        </div>
      ) : null}
      {settings.isError ? (
        <Alert variant="destructive">
          <AlertTitle role="heading" aria-level={2}>
            Could not load the vault date
          </AlertTitle>
          <AlertDescription>
            <p>{errorMessage(settings.error)}</p>
            <Button className="mt-4 min-h-11" variant="outline" type="button" onClick={() => void settings.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {date && query.isLoading ? (
        <div className="flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
          <Spinner aria-hidden="true" />
          <span>Loading today’s review</span>
        </div>
      ) : null}
      {date && query.isError ? (
        <Alert variant="destructive">
          <AlertTitle role="heading" aria-level={2}>
            Could not load today
          </AlertTitle>
          <AlertDescription>
            <p>{errorMessage(query.error)}</p>
            <Button className="mt-4 min-h-11" variant="outline" type="button" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {query.data ? <TodayContent result={query.data} /> : null}
    </div>
  );
}
