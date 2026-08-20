import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type { PublicWorkflowRecord, WorkflowListResult } from "../../../../src/contracts";
import { api, errorMessage, formatDate, isWorkflowListResult } from "../api";

const sectionLabelClass = "text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground";

const workflowNames: Record<PublicWorkflowRecord["kind"], string> = {
  extract: "Extract",
  ingest: "Ingest",
  lint: "Lint",
  daily: "Daily",
  "quiz-grader": "Quiz grading",
  sync: "Git sync",
};

function workflowVariant(status: PublicWorkflowRecord["status"]): "outline" | "default" | "secondary" | "destructive" {
  if (status === "succeeded") return "default";
  if (status === "failed") return "destructive";
  if (status === "running" || status === "queued") return "secondary";
  return "outline";
}

export function WorkflowsPage() {
  const query = useQuery({
    queryKey: ["workflows"],
    queryFn: ({ signal }) => api<WorkflowListResult>("/api/v1/workflows", { signal }, isWorkflowListResult),
    refetchInterval: ({ state }) =>
      state.data?.workflows.some((item) => item.status === "queued" || item.status === "running") ? 5_000 : false,
  });

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className={sectionLabelClass}>Background activity</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">Workflows</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Recent skill invocations from your cron entries or direct actions.
          </p>
        </div>
        <Button
          className="min-h-11"
          variant="outline"
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          Refresh
        </Button>
      </header>

      {query.isLoading ? (
        <div className="flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
          <Spinner aria-hidden="true" />
          <span>Loading workflows</span>
        </div>
      ) : null}
      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle role="heading" aria-level={2}>
            Could not load workflows
          </AlertTitle>
          <AlertDescription>{errorMessage(query.error)}</AlertDescription>
        </Alert>
      ) : null}
      {query.data?.workflows.length === 0 ? (
        <Empty role="status" className="items-start border border-border bg-card p-6 text-left">
          <EmptyHeader className="items-start">
            <EmptyTitle className="text-2xl font-semibold" role="heading" aria-level={2}>
              No skill invocations yet
            </EmptyTitle>
            <EmptyDescription className="mt-2 max-w-prose">
              Invocations appear here after a cron entry or direct action runs a skill.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      <ol className="grid gap-4">
        {query.data?.workflows.map((workflow) => {
          const percentage = Math.min(100, Math.max(0, workflow.progress * 100));
          return (
            <li key={workflow.requestId}>
              <Card>
                <CardHeader className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>
                      <h2 className="text-xl font-semibold">{workflowNames[workflow.kind]}</h2>
                    </CardTitle>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{workflow.requestId}</p>
                  </div>
                  <Badge variant={workflowVariant(workflow.status)}>{workflow.status}</Badge>
                </CardHeader>
                <CardContent>
                  <Progress
                    className="mt-1"
                    value={percentage}
                    aria-label={`${workflowNames[workflow.kind]} progress`}
                  />
                  <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
                    <span>{workflow.message ?? `${Math.round(workflow.progress * 100)}% complete`}</span>
                    <span>
                      {workflow.finishedAt
                        ? `Finished ${formatDate(workflow.finishedAt, { dateStyle: "medium", timeStyle: "short" })}`
                        : workflow.startedAt
                          ? `Started ${formatDate(workflow.startedAt, { dateStyle: "medium", timeStyle: "short" })}`
                          : "Waiting to start"}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
