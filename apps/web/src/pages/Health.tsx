import { useQuery } from "@tanstack/react-query";
import type { HealthResult } from "../../../../src/contracts";
import { api, errorMessage, isHealthResult } from "../api";
import { Badge, Button, Card, Spinner, StateView } from "../components/ui";

export function HealthPage() {
  const query = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => api<HealthResult>("/healthz", { signal }, isHealthResult),
  });

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Local service</p>
          <h1 className="page-heading mt-2">Health</h1>
          <p className="mt-3 max-w-2xl text-muted">A bounded view of the application and current vault checks.</p>
        </div>
        <Button variant="secondary" onClick={() => void query.refetch()} disabled={query.isFetching}>
          Check again
        </Button>
      </header>

      {query.isLoading ? <Spinner label="Checking service health" /> : null}
      {query.isError ? (
        <StateView title="Service could not be reached" tone="danger">
          <p>{errorMessage(query.error)}</p>
        </StateView>
      ) : null}
      {query.data ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="eyebrow">Application status</p>
              <h2 className="mt-2 font-serif text-3xl font-semibold">
                {query.data.status === "ok"
                  ? "Operating normally"
                  : query.data.status === "degraded"
                    ? "Needs attention"
                    : "Checks failed"}
              </h2>
            </div>
            <Badge
              tone={query.data.status === "ok" ? "positive" : query.data.status === "degraded" ? "caution" : "danger"}
            >
              {query.data.status}
            </Badge>
          </div>
          <dl className="mt-8 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3">
            <div className="bg-paper p-4">
              <dt className="text-sm text-muted">Version</dt>
              <dd className="mt-1 font-bold">{query.data.version}</dd>
            </div>
            <div className="bg-paper p-4">
              <dt className="text-sm text-muted">Vault</dt>
              <dd className="mt-1 break-all font-mono text-sm">{query.data.vaultId ?? "No vault resolved"}</dd>
            </div>
            <div className="bg-paper p-4">
              <dt className="text-sm text-muted">Doctor</dt>
              <dd className="mt-1 font-bold">{query.data.doctor ?? "Not reported"}</dd>
            </div>
          </dl>
        </Card>
      ) : null}
    </div>
  );
}
