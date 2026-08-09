import { useQuery } from "@tanstack/react-query";
import type { WorkflowListResult, WorkflowRecord } from "../../../../src/contracts";
import { api, errorMessage, formatDate, isWorkflowListResult } from "../api";
import { Badge, Button, Card, Spinner, StateView } from "../components/ui";

const workflowNames: Record<WorkflowRecord["kind"], string> = {
  "source-admission": "Source admission",
  "wiki-maintenance": "Wiki maintenance",
  "daily-quiz": "Quiz publishing",
  "quiz-grader": "Quiz grading",
  sync: "Git sync",
};

function workflowTone(status: WorkflowRecord["status"]): "neutral" | "positive" | "caution" | "danger" {
  if (status === "succeeded") return "positive";
  if (status === "failed") return "danger";
  if (status === "running" || status === "queued") return "caution";
  return "neutral";
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
          <p className="eyebrow">Background activity</p>
          <h1 className="page-heading mt-2">Workflows</h1>
          <p className="mt-3 max-w-2xl text-muted">
            Recent skill invocations from your cron entries or direct actions.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void query.refetch()} disabled={query.isFetching}>
          Refresh
        </Button>
      </header>

      {query.isLoading ? <Spinner label="Loading workflows" /> : null}
      {query.isError ? (
        <StateView title="Could not load workflows" tone="danger">
          <p>{errorMessage(query.error)}</p>
        </StateView>
      ) : null}
      {query.data?.workflows.length === 0 ? (
        <StateView title="No skill invocations yet">
          <p>Invocations appear here after a cron entry or direct action runs a skill.</p>
        </StateView>
      ) : null}

      <ol className="grid gap-4">
        {query.data?.workflows.map((workflow) => (
          <li key={workflow.requestId}>
            <Card className="shadow-none">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-serif text-xl font-semibold">{workflowNames[workflow.kind]}</h2>
                  <p className="mt-1 font-mono text-xs text-muted">{workflow.requestId}</p>
                </div>
                <Badge tone={workflowTone(workflow.status)}>{workflow.status}</Badge>
              </div>
              <progress
                className="mt-5 h-2 w-full accent-accent"
                max={100}
                value={Math.min(100, Math.max(0, workflow.progress * 100))}
                aria-label={`${workflowNames[workflow.kind]} progress`}
              />
              <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm text-muted">
                <span>{workflow.message ?? `${Math.round(workflow.progress * 100)}% complete`}</span>
                <span>
                  {workflow.finishedAt
                    ? `Finished ${formatDate(workflow.finishedAt, { dateStyle: "medium", timeStyle: "short" })}`
                    : workflow.startedAt
                      ? `Started ${formatDate(workflow.startedAt, { dateStyle: "medium", timeStyle: "short" })}`
                      : "Waiting to start"}
                </span>
              </div>
              {workflow.errorMessage ? (
                <p
                  className="mt-4 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
                  role="alert"
                >
                  {workflow.errorMessage}
                </p>
              ) : null}
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}
