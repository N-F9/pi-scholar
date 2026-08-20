import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { SettingsResult, SettingsUpdateRequest } from "../../../../src/contracts";
import { api, errorMessage, formatDate, isSettingsResult } from "../api";

const sectionLabelClass = "text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground";

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [dateInput, setDateInput] = useState<string>();
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api<SettingsResult>("/api/v1/settings", { signal }, isSettingsResult),
  });
  const update = useMutation({
    mutationFn: (request: SettingsUpdateRequest) =>
      api<SettingsResult>("/api/v1/settings", { method: "PUT", body: JSON.stringify(request) }, isSettingsResult),
    onSuccess: async (_result, request) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["quiz"] }),
        queryClient.invalidateQueries({ queryKey: ["workflows"] }),
      ]);
      if ("simulatedDate" in request) setDateInput(undefined);
    },
  });
  const developerDate = query.data
    ? (dateInput ?? query.data.settings.simulatedDate ?? query.data.settings.facts.localDate)
    : "";
  const moveDate = (days: number) => {
    const next = shiftDate(developerDate, days);
    setDateInput(next);
    update.mutate({ simulatedDate: next });
  };

  return (
    <div className="space-y-8">
      <header>
        <p className={sectionLabelClass}>Vault facts</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">Inspect maintenance and synchronization facts.</p>
      </header>

      {query.isLoading ? (
        <div className="flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
          <Spinner aria-hidden="true" />
          <span>Loading settings</span>
        </div>
      ) : null}
      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle role="heading" aria-level={2}>
            Could not load settings
          </AlertTitle>
          <AlertDescription>{errorMessage(query.error)}</AlertDescription>
        </Alert>
      ) : null}
      {query.data ? (
        <div className="grid gap-6">
          {update.isError ? (
            <Alert variant="destructive">
              <AlertDescription>Could not save settings. {errorMessage(update.error)}</AlertDescription>
            </Alert>
          ) : null}
          <Card>
            <CardHeader className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className={sectionLabelClass}>Quiz publishing</p>
                <CardTitle>
                  <h2 className="mt-2 text-3xl font-semibold">
                    Maintenance mode {query.data.settings.maintenanceEnabled ? "enabled" : "disabled"}
                  </h2>
                </CardTitle>
                <p className="mt-3 max-w-2xl text-muted-foreground">
                  {query.data.settings.maintenanceEnabled
                    ? "Maintenance mode blocks quiz publishing until you turn it off."
                    : "Quiz publishing is enabled. Skills run independently according to your cron entries."}
                </p>
              </div>
              <Badge variant={query.data.settings.maintenanceEnabled ? "secondary" : "outline"}>
                {query.data.settings.maintenanceEnabled ? "quiz publishing blocked" : "quiz publishing enabled"}
              </Badge>
            </CardHeader>
            <CardContent>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Change this vault-level setting from a terminal with{" "}
                <code className="font-mono text-foreground">
                  {`pi-scholar maintenance ${query.data.settings.maintenanceEnabled ? "off" : "on"} --vault /path/to/vault`}
                </code>
                .
              </p>
            </CardContent>
          </Card>

          {query.data.developerToolsEnabled || query.data.settings.simulatedDate ? (
            <Card>
              <CardHeader>
                <p className={sectionLabelClass}>Developer tools</p>
                <CardTitle>
                  <h2 className="mt-2 text-2xl font-semibold">Simulated learning date</h2>
                </CardTitle>
              </CardHeader>
              {query.data.developerToolsEnabled ? (
                <CardContent>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Rehearse learning in a disposable vault. Operational timestamps continue to use real time.
                  </p>
                  <div className="mt-5 grid max-w-xl gap-4">
                    <Field>
                      <FieldLabel htmlFor="simulated-date">Effective learning date</FieldLabel>
                      <Input
                        id="simulated-date"
                        type="date"
                        value={developerDate}
                        onChange={(event) => setDateInput(event.currentTarget.value)}
                        disabled={update.isPending}
                        required
                      />
                    </Field>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        className="min-h-11"
                        type="button"
                        onClick={() => update.mutate({ simulatedDate: developerDate })}
                        disabled={update.isPending || !developerDate}
                      >
                        Apply
                      </Button>
                      <Button
                        className="min-h-11"
                        variant="outline"
                        type="button"
                        onClick={() => moveDate(-1)}
                        disabled={update.isPending || !developerDate}
                      >
                        Previous day
                      </Button>
                      <Button
                        className="min-h-11"
                        variant="outline"
                        type="button"
                        onClick={() => moveDate(1)}
                        disabled={update.isPending || !developerDate}
                      >
                        Next day
                      </Button>
                      <Button
                        className="min-h-11"
                        variant="ghost"
                        type="button"
                        onClick={() => update.mutate({ simulatedDate: null })}
                        disabled={update.isPending}
                      >
                        Use real date
                      </Button>
                    </div>
                  </div>
                </CardContent>
              ) : (
                <CardContent>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Simulation is active for {query.data.settings.simulatedDate}. Restart the server with{" "}
                    <code className="font-mono text-foreground">pi-scholar serve --dev-tools</code> to change or clear
                    it.
                  </p>
                </CardContent>
              )}
            </Card>
          ) : null}

          <section aria-labelledby="current-facts-heading">
            <p className={sectionLabelClass}>Current facts</p>
            <h2 className="mt-2 text-3xl font-semibold" id="current-facts-heading">
              Vault activity
            </h2>
            <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
              <div className="bg-card p-5">
                <dt className="text-sm text-muted-foreground">Pending inbox entries</dt>
                <dd className="mt-2 text-3xl font-semibold">{query.data.settings.facts.pendingInboxCount}</dd>
              </div>
              <div className="bg-card p-5">
                <dt className="text-sm text-muted-foreground">Open issues</dt>
                <dd className="mt-2 text-3xl font-semibold">{query.data.settings.facts.openIssueCount}</dd>
              </div>
              <div className="bg-card p-5">
                <dt className="text-sm text-muted-foreground">Last ingest</dt>
                <dd className="mt-2 font-bold">
                  {query.data.settings.facts.lastIngestAt
                    ? formatDate(query.data.settings.facts.lastIngestAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "No run recorded"}
                </dd>
                {query.data.settings.facts.lastIngestResult ? (
                  <dd className="mt-2 text-sm text-muted-foreground">{query.data.settings.facts.lastIngestResult}</dd>
                ) : null}
              </div>
              <div className="bg-card p-5">
                <dt className="text-sm text-muted-foreground">Last lint</dt>
                <dd className="mt-2 font-bold">
                  {query.data.settings.facts.lastLintAt
                    ? formatDate(query.data.settings.facts.lastLintAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "No run recorded"}
                </dd>
                {query.data.settings.facts.lastLintResult ? (
                  <dd className="mt-2 text-sm text-muted-foreground">{query.data.settings.facts.lastLintResult}</dd>
                ) : null}
              </div>
              <div className="bg-card p-5">
                <dt className="text-sm text-muted-foreground">Settings updated</dt>
                <dd className="mt-2 font-bold">
                  {formatDate(query.data.settings.updatedAt, { dateStyle: "medium", timeStyle: "short" })}
                </dd>
              </div>
            </dl>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2 className="text-2xl font-semibold">Recent changes</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {query.data.settings.facts.recentChanges.length ? (
                  <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
                    {query.data.settings.facts.recentChanges.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No recent changes reported.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>
                  <h2 className="text-2xl font-semibold">Git synchronization</h2>
                </CardTitle>
                <Badge
                  variant={
                    query.data.settings.facts.git.diverged
                      ? "destructive"
                      : query.data.settings.facts.git.clean &&
                          query.data.settings.facts.git.ahead === 0 &&
                          query.data.settings.facts.git.behind === 0
                        ? "default"
                        : "secondary"
                  }
                >
                  {query.data.settings.facts.git.diverged
                    ? "diverged"
                    : query.data.settings.facts.git.clean
                      ? "clean"
                      : "changes present"}
                </Badge>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Branch</dt>
                    <dd className="mt-1 break-all font-mono">
                      {query.data.settings.facts.git.branch ?? "Not reported"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Upstream</dt>
                    <dd className="mt-1 break-all font-mono">
                      {query.data.settings.facts.git.upstream ?? "Not configured"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Ahead</dt>
                    <dd className="mt-1 font-bold">{query.data.settings.facts.git.ahead}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Behind</dt>
                    <dd className="mt-1 font-bold">{query.data.settings.facts.git.behind}</dd>
                  </div>
                </dl>
                {query.data.settings.facts.git.message ? (
                  <p className="mt-4 text-sm text-muted-foreground">{query.data.settings.facts.git.message}</p>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-2xl font-semibold">Service facts</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Timezone</dt>
                  <dd className="mt-1 font-bold">{query.data.settings.timezone}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Host</dt>
                  <dd className="mt-1 font-mono">{query.data.settings.host}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Port</dt>
                  <dd className="mt-1 font-mono">{query.data.settings.port}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
