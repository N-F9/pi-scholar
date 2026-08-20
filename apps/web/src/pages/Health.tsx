import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { HealthResult } from "../../../../src/contracts";
import { api, errorMessage, isHealthResult } from "../api";

const sectionLabelClass = "text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground";

export function HealthPage() {
  const query = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => api<HealthResult>("/healthz", { signal }, isHealthResult),
  });

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className={sectionLabelClass}>Local service</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">Health</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            A bounded view of the application and current vault checks.
          </p>
        </div>
        <Button className="min-h-11" variant="outline" type="button" onClick={() => void query.refetch()}>
          Check again
        </Button>
      </header>
      {query.isLoading ? (
        <div className="flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
          <Spinner aria-hidden="true" />
          <span>Checking service health</span>
        </div>
      ) : null}
      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle role="heading" aria-level={2}>
            Service could not be reached
          </AlertTitle>
          <AlertDescription>{errorMessage(query.error)}</AlertDescription>
        </Alert>
      ) : null}

      {query.data ? (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className={sectionLabelClass}>Application status</p>
              <CardTitle>
                <h2 className="mt-2 text-3xl font-semibold">
                  {query.data.status === "ok"
                    ? "Operating normally"
                    : query.data.status === "degraded"
                      ? "Needs attention"
                      : "Checks failed"}
                </h2>
              </CardTitle>
            </div>
            <Badge
              variant={
                query.data.status === "ok" ? "default" : query.data.status === "degraded" ? "secondary" : "destructive"
              }
            >
              {query.data.status}
            </Badge>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
              <div className="bg-card p-4">
                <dt className="text-sm text-muted-foreground">Version</dt>
                <dd className="mt-1 font-bold">{query.data.version}</dd>
              </div>
              <div className="bg-card p-4">
                <dt className="text-sm text-muted-foreground">Vault</dt>
                <dd className="mt-1 break-all font-mono text-sm">{query.data.vaultId ?? "No vault resolved"}</dd>
              </div>
              <div className="bg-card p-4">
                <dt className="text-sm text-muted-foreground">Doctor</dt>
                <dd className="mt-1 font-bold">{query.data.doctor ?? "Not reported"}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
