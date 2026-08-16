import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { SettingsResult, SettingsUpdateRequest } from "../../../../src/contracts";
import { api, errorMessage, formatDate, isSettingsResult } from "../api";
import { Badge, Button, Card, Field, Input, Spinner, StateView } from "../components/ui";

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [dateInput, setDateInput] = useState<string>();
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api<SettingsResult>("/api/v1/settings", { signal }, isSettingsResult),
  });
  const update = useMutation({
    mutationFn: (request: SettingsUpdateRequest) =>
      api<SettingsResult>("/api/v1/settings", { method: "PUT", body: JSON.stringify(request) }, isSettingsResult),
    onSuccess: async (_result, request) => {
      setConfirming(false);
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
        <p className="eyebrow">Vault facts</p>
        <h1 className="page-heading mt-2">Settings</h1>
        <p className="mt-3 max-w-2xl text-muted">Inspect maintenance and synchronization facts.</p>
      </header>

      {query.isLoading ? <Spinner label="Loading settings" /> : null}
      {query.isError ? (
        <StateView title="Could not load settings" tone="danger">
          <p>{errorMessage(query.error)}</p>
        </StateView>
      ) : null}
      {query.data ? (
        <div className="grid gap-6">
          {update.isError ? (
            <p
              className="rounded-md border border-danger/40 bg-danger/10 p-4 text-sm font-bold text-danger"
              role="alert"
            >
              Could not save settings. {errorMessage(update.error)}
            </p>
          ) : null}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="eyebrow">Quiz publishing</p>
                <h2 className="mt-2 font-serif text-3xl font-semibold">
                  Maintenance mode {query.data.settings.maintenanceEnabled ? "enabled" : "disabled"}
                </h2>
                <p className="mt-3 max-w-2xl text-muted">
                  {query.data.settings.maintenanceEnabled
                    ? "Maintenance mode blocks quiz publishing until you turn it off."
                    : "Quiz publishing is enabled. Skills run independently according to your cron entries."}
                </p>
              </div>
              <Badge tone={query.data.settings.maintenanceEnabled ? "caution" : "neutral"}>
                {query.data.settings.maintenanceEnabled ? "quiz publishing blocked" : "quiz publishing enabled"}
              </Badge>
            </div>

            {query.data.settings.maintenanceEnabled && !confirming ? (
              <Button className="mt-6" variant="secondary" onClick={() => setConfirming(true)}>
                Turn off maintenance mode
              </Button>
            ) : null}
            {!query.data.settings.maintenanceEnabled ? (
              <Button
                className="mt-6"
                variant="secondary"
                onClick={() => update.mutate({ maintenanceEnabled: true })}
                disabled={update.isPending}
              >
                Turn on maintenance mode
              </Button>
            ) : null}
            {query.data.settings.maintenanceEnabled && confirming ? (
              <div className="mt-6 rounded-md border border-caution/40 bg-caution/10 p-4">
                <h3 className="font-bold">Turn off maintenance mode?</h3>
                <p className="mt-2 text-sm text-muted">
                  Quiz publishing will be enabled. Skills will run independently according to your cron entries.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button onClick={() => update.mutate({ maintenanceEnabled: false })} disabled={update.isPending}>
                    {update.isPending ? "Saving…" : "Turn off maintenance mode"}
                  </Button>
                  <Button variant="quiet" onClick={() => setConfirming(false)} disabled={update.isPending}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>

          {query.data.developerToolsEnabled || query.data.settings.simulatedDate ? (
            <Card className="shadow-none">
              <p className="eyebrow">Developer tools</p>
              <h2 className="mt-2 font-serif text-2xl font-semibold">Simulated learning date</h2>
              {query.data.developerToolsEnabled ? (
                <>
                  <p className="mt-3 max-w-2xl text-sm text-muted">
                    Rehearse learning in a disposable vault. Operational timestamps continue to use real time.
                  </p>
                  <div className="mt-5 grid max-w-xl gap-4">
                    <Field label="Effective learning date">
                      <Input
                        type="date"
                        value={developerDate}
                        onChange={(event) => setDateInput(event.currentTarget.value)}
                        disabled={update.isPending}
                        required
                      />
                    </Field>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        onClick={() => update.mutate({ simulatedDate: developerDate })}
                        disabled={update.isPending || !developerDate}
                      >
                        Apply
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => moveDate(-1)}
                        disabled={update.isPending || !developerDate}
                      >
                        Previous day
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => moveDate(1)}
                        disabled={update.isPending || !developerDate}
                      >
                        Next day
                      </Button>
                      <Button
                        variant="quiet"
                        onClick={() => update.mutate({ simulatedDate: null })}
                        disabled={update.isPending}
                      >
                        Use real date
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <p className="mt-3 max-w-2xl text-sm text-muted">
                  Simulation is active for {query.data.settings.simulatedDate}. Restart the server with{" "}
                  <code className="font-mono text-ink">pi-scholar serve --dev-tools</code> to change or clear it.
                </p>
              )}
            </Card>
          ) : null}

          <section aria-labelledby="current-facts-heading">
            <p className="eyebrow">Current facts</p>
            <h2 className="mt-2 font-serif text-3xl font-semibold" id="current-facts-heading">
              Vault activity
            </h2>
            <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
              <div className="bg-paper p-5">
                <dt className="text-sm text-muted">Pending inbox entries</dt>
                <dd className="mt-2 font-serif text-3xl font-semibold">
                  {query.data.settings.facts.pendingInboxCount}
                </dd>
              </div>
              <div className="bg-paper p-5">
                <dt className="text-sm text-muted">Open issues</dt>
                <dd className="mt-2 font-serif text-3xl font-semibold">{query.data.settings.facts.openIssueCount}</dd>
              </div>
              <div className="bg-paper p-5">
                <dt className="text-sm text-muted">Last ingest</dt>
                <dd className="mt-2 font-bold">
                  {query.data.settings.facts.lastIngestAt
                    ? formatDate(query.data.settings.facts.lastIngestAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "No run recorded"}
                </dd>
                {query.data.settings.facts.lastIngestResult ? (
                  <dd className="mt-2 text-sm text-muted">{query.data.settings.facts.lastIngestResult}</dd>
                ) : null}
              </div>
              <div className="bg-paper p-5">
                <dt className="text-sm text-muted">Last lint</dt>
                <dd className="mt-2 font-bold">
                  {query.data.settings.facts.lastLintAt
                    ? formatDate(query.data.settings.facts.lastLintAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "No run recorded"}
                </dd>
                {query.data.settings.facts.lastLintResult ? (
                  <dd className="mt-2 text-sm text-muted">{query.data.settings.facts.lastLintResult}</dd>
                ) : null}
              </div>
              <div className="bg-paper p-5">
                <dt className="text-sm text-muted">Settings updated</dt>
                <dd className="mt-2 font-bold">
                  {formatDate(query.data.settings.updatedAt, { dateStyle: "medium", timeStyle: "short" })}
                </dd>
              </div>
            </dl>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="shadow-none">
              <h2 className="font-serif text-2xl font-semibold">Recent changes</h2>
              {query.data.settings.facts.recentChanges.length ? (
                <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-muted">
                  {query.data.settings.facts.recentChanges.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-muted">No recent changes reported.</p>
              )}
            </Card>

            <Card className="shadow-none">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-serif text-2xl font-semibold">Git synchronization</h2>
                <Badge
                  tone={
                    query.data.settings.facts.git.diverged
                      ? "danger"
                      : query.data.settings.facts.git.clean &&
                          query.data.settings.facts.git.ahead === 0 &&
                          query.data.settings.facts.git.behind === 0
                        ? "positive"
                        : "caution"
                  }
                >
                  {query.data.settings.facts.git.diverged
                    ? "diverged"
                    : query.data.settings.facts.git.clean
                      ? "clean"
                      : "changes present"}
                </Badge>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted">Branch</dt>
                  <dd className="mt-1 break-all font-mono">{query.data.settings.facts.git.branch ?? "Not reported"}</dd>
                </div>
                <div>
                  <dt className="text-muted">Upstream</dt>
                  <dd className="mt-1 break-all font-mono">
                    {query.data.settings.facts.git.upstream ?? "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Ahead</dt>
                  <dd className="mt-1 font-bold">{query.data.settings.facts.git.ahead}</dd>
                </div>
                <div>
                  <dt className="text-muted">Behind</dt>
                  <dd className="mt-1 font-bold">{query.data.settings.facts.git.behind}</dd>
                </div>
              </dl>
              {query.data.settings.facts.git.message ? (
                <p className="mt-4 text-sm text-muted">{query.data.settings.facts.git.message}</p>
              ) : null}
            </Card>
          </div>

          <Card className="shadow-none">
            <h2 className="font-serif text-2xl font-semibold">Service facts</h2>
            <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted">Timezone</dt>
                <dd className="mt-1 font-bold">{query.data.settings.timezone}</dd>
              </div>
              <div>
                <dt className="text-muted">Host</dt>
                <dd className="mt-1 font-mono">{query.data.settings.host}</dd>
              </div>
              <div>
                <dt className="text-muted">Port</dt>
                <dd className="mt-1 font-mono">{query.data.settings.port}</dd>
              </div>
            </dl>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
