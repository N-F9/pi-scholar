import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  WikiDriftResolutionRequest,
  WikiIssueCreateRequest,
  WikiIssueKind,
  WikiIssueListResult,
  WikiIssueRecord,
  WikiIssueUpdateRequest,
  WikiListResult,
  WikiPageResult,
} from "../../../../src/contracts";
import { api, errorMessage, formatDate, isWikiIssueListResult, isWikiListResult, isWikiPageResult } from "../api";
import { headingAnchor, Markdown } from "../components/Markdown";

const issueLabels: Record<WikiIssueKind, string> = {
  incorrect: "Incorrect",
  unclear: "Unclear",
  missing: "Missing information",
  "bad-boundary": "Bad learning boundary",
};

export function NotesPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const [searchText, setSearchText] = useState(search);
  const [reporting, setReporting] = useState(false);
  const pageId = params.get("pageId") ?? undefined;
  const path = params.get("path") ?? undefined;
  const heading = params.get("heading") ?? undefined;

  useEffect(() => {
    setSearchText(search);
  }, [search]);

  const pages = useQuery({
    queryKey: ["wiki", "list", search],
    queryFn: ({ signal }) =>
      api<WikiListResult>(
        search ? `/api/v1/wiki/search?q=${encodeURIComponent(search)}` : "/api/v1/wiki",
        { signal },
        isWikiListResult,
      ),
  });
  const page = useQuery({
    queryKey: ["wiki", "page", pageId ?? path],
    queryFn: ({ signal }) => {
      const query = pageId ? `pageId=${encodeURIComponent(pageId)}` : `path=${encodeURIComponent(path ?? "")}`;
      return api<WikiPageResult>(`/api/v1/wiki/page?${query}`, { signal }, isWikiPageResult);
    },
    enabled: Boolean(pageId || path),
  });
  const issues = useQuery({
    queryKey: ["wiki", "issues"],
    queryFn: ({ signal }) => api<WikiIssueListResult>("/api/v1/wiki/issues", { signal }, isWikiIssueListResult),
  });

  const reopen = useMutation({
    mutationFn: (issue: WikiIssueRecord) => {
      const request: WikiIssueUpdateRequest = { status: "reopened" };
      return api<unknown>(`/api/v1/wiki/issues/${encodeURIComponent(issue.issueId)}`, {
        method: "PATCH",
        body: JSON.stringify(request),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["wiki", "issues"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
  });

  const drift = useMutation({
    mutationFn: (request: WikiDriftResolutionRequest) =>
      api<unknown>(`/api/v1/wiki/pages/${encodeURIComponent(page.data?.page.pageId ?? "")}/drift-resolution`, {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["wiki"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["workflows"] }),
      ]);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["wiki", "page", pageId ?? path] });
    },
  });

  useEffect(() => {
    if (!page.data) return;
    let hash = location.hash.slice(1);
    try {
      hash = decodeURIComponent(hash);
    } catch {
      // A malformed fragment cannot identify a rendered heading.
    }
    const canonical = page.data.sections.find((section) => section.heading === heading)?.anchor.replace(/^#/, "");
    const candidates = [hash, canonical, heading, heading ? headingAnchor(heading) : undefined].filter(
      (value): value is string => Boolean(value),
    );
    if (!candidates.length) return;
    const frame = window.requestAnimationFrame(() => {
      for (const candidate of candidates) {
        const target = document.getElementById(candidate);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          break;
        }
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [heading, location.hash, page.data]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing the selected page must dismiss the issue form.
  useEffect(() => {
    setReporting(false);
  }, [pageId, path]);

  function commitSearch(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value);
    else next.delete("q");
    setSearchText(value);
    if (next.toString() !== params.toString()) setParams(next);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    commitSearch(searchText.trim());
  }

  const pageIssues = issues.data?.issues.filter((issue) => issue.pageId === page.data?.page.pageId) ?? [];

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Read-only wiki</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Notes</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Browse maintained knowledge, inspect its learning schedule and prerequisites, and report what needs
          correction.
        </p>
      </header>
      <div className="grid gap-6 xl:grid-cols-3">
        <aside
          className="self-start rounded-xl border border-border bg-card p-4 xl:sticky xl:top-8"
          aria-label="Wiki pages"
        >
          <search>
            <form className="flex gap-2" onSubmit={submitSearch}>
              <label className="min-w-0 flex-1" htmlFor="notes-search">
                <span className="sr-only">Search notes</span>
                <Input
                  id="notes-search"
                  type="search"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="Search notes"
                />
              </label>
              <Button className="min-h-11" type="submit" variant="outline">
                Search
              </Button>
            </form>
          </search>
          {search ? (
            <div className="mt-3 flex items-center justify-between gap-2 text-sm">
              <span className="truncate text-muted-foreground">Results for “{search}”</span>
              <Button className="min-h-9 px-2 py-1" type="button" variant="ghost" onClick={() => commitSearch("")}>
                Clear
              </Button>
            </div>
          ) : null}
          {pages.isLoading ? (
            <div className="mt-4 flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
              <Spinner aria-hidden="true" />
              <span>Loading notes</span>
            </div>
          ) : null}
          {pages.isError ? (
            <Alert className="mt-4" variant="destructive">
              <AlertDescription>{errorMessage(pages.error)}</AlertDescription>
            </Alert>
          ) : null}
          {pages.data?.pages.length === 0 ? (
            <Empty className="mt-4 border border-border p-4" role="status">
              <EmptyContent>
                <EmptyDescription>
                  {search ? "No notes match this search." : "No wiki pages have been published yet."}
                </EmptyDescription>
              </EmptyContent>
            </Empty>
          ) : null}
          <nav className="mt-4 max-h-96 overflow-y-auto" aria-label="Note list">
            <ul className="grid gap-1">
              {pages.data?.pages.map((item) => {
                const selected =
                  item.pageId === page.data?.page.pageId || item.pageId === pageId || item.relativePath === path;
                const next = new URLSearchParams();
                next.set("pageId", item.pageId);
                if (search) next.set("q", search);
                return (
                  <li key={item.pageId}>
                    <Link
                      className={cn(
                        "block min-h-11 rounded-lg px-3 py-2",
                        selected
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-background hover:text-foreground",
                      )}
                      to={`/notes?${next.toString()}#note-content`}
                    >
                      <span className="block truncate font-medium">{item.title}</span>
                      <span
                        className={cn(
                          "mt-0.5 block truncate text-xs",
                          selected ? "text-primary-foreground/70" : "text-muted-foreground",
                        )}
                      >
                        {item.relativePath}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        <article className="min-w-0 scroll-mt-24 xl:col-span-2" id="note-content">
          {!pageId && !path ? (
            <Empty className="border border-border" role="status">
              <EmptyHeader>
                <EmptyTitle role="heading" aria-level={2}>
                  Choose a note
                </EmptyTitle>
                <EmptyDescription>
                  Select a wiki page to read it here. Notes are maintained through Pi; the browser stays read-only.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {page.isLoading ? (
            <div className="flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
              <Spinner aria-hidden="true" />
              <span>Loading note</span>
            </div>
          ) : null}
          {page.isError ? (
            <Alert variant="destructive">
              <AlertTitle role="heading" aria-level={2}>
                Could not load this note
              </AlertTitle>
              <AlertDescription>{errorMessage(page.error)}</AlertDescription>
            </Alert>
          ) : null}
          {page.data ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {page.data.page.relativePath}
                  </p>
                  <h2 className="mt-2 text-4xl font-semibold tracking-tight">{page.data.page.title}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Updated {formatDate(page.data.page.updatedAt, { dateStyle: "medium", timeStyle: "short" })} ·
                    revision {page.data.page.revision}
                  </p>
                </div>
                <Button className="min-h-11" type="button" variant="outline" onClick={() => setReporting(true)}>
                  Report issue
                </Button>
              </div>

              {page.data.drift?.diff ? (
                <Card>
                  <CardHeader>
                    <Badge variant="secondary">Direct edit detected</Badge>
                    <CardTitle>
                      <h3 className="text-xl font-semibold">Restore the maintained page</h3>
                    </CardTitle>
                    <CardDescription>
                      The current bytes are preserved below. Direct edits cannot become canonical in this version.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-foreground p-4 font-mono text-xs text-background">
                      {page.data.drift.diff}
                    </pre>
                    {drift.isError ? (
                      <Alert variant="destructive">
                        <AlertDescription>{errorMessage(drift.error)}</AlertDescription>
                      </Alert>
                    ) : null}
                  </CardContent>
                  <CardFooter className="grid gap-3 sm:grid-cols-2">
                    <Button
                      className="min-h-11"
                      type="button"
                      onClick={() =>
                        drift.mutate({
                          action: "record-issue",
                          expectedDigest: page.data.drift!.actualDigest,
                          description: "Unsupported direct edit preserved as issue evidence.",
                        })
                      }
                      disabled={drift.isPending}
                    >
                      Save diff as issue evidence and restore
                    </Button>
                    <Button
                      className="min-h-11"
                      type="button"
                      variant="outline"
                      onClick={() => drift.mutate({ action: "restore", expectedDigest: page.data.drift!.actualDigest })}
                      disabled={drift.isPending}
                    >
                      Discard diff and restore
                    </Button>
                  </CardFooter>
                </Card>
              ) : page.data.page.status === "drifted" ? (
                <Card>
                  <CardHeader>
                    <Badge variant="secondary">Maintenance correction required</Badge>
                    <CardDescription>
                      This page is semantically stale and needs a guarded Pi maintenance correction before its learning
                      schedule can return.
                    </CardDescription>
                  </CardHeader>
                </Card>
              ) : null}

              {reporting ? <IssueForm page={page.data} onClose={() => setReporting(false)} /> : null}
              <Card className="py-7 sm:py-10">
                <CardContent className="px-5 sm:px-8">
                  <Markdown
                    source={page.data.markdown}
                    pageId={page.data.page.pageId}
                    pagePath={page.data.page.relativePath}
                    headings={page.data.sections}
                  />
                </CardContent>
              </Card>

              <Accordion type="single" collapsible className="rounded-xl border border-border bg-card">
                <AccordionItem className="border-0" value="learning">
                  <AccordionTrigger className="min-h-14 px-5 py-3 text-base hover:no-underline">
                    <span>
                      Learning{" "}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {page.data.learning.schedule?.fsrsState ?? "Not scheduled"} ·{" "}
                        {page.data.learning.prerequisites.length}{" "}
                        {page.data.learning.prerequisites.length === 1 ? "prerequisite" : "prerequisites"}
                      </span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-6 border-t border-border p-5">
                    <section>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3 className="text-xl font-semibold">Page schedule</h3>
                        {page.data.learning.schedule ? (
                          <Badge variant="outline">{page.data.learning.schedule.fsrsState}</Badge>
                        ) : null}
                      </div>
                      {page.data.learning.schedule ? (
                        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                          <div>
                            <dt className="text-muted-foreground">Next due</dt>
                            <dd className="mt-1 font-medium">{formatDate(page.data.learning.schedule.dueAt)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Revision</dt>
                            <dd className="mt-1 font-medium">{page.data.learning.schedule.revision}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Reviews</dt>
                            <dd className="mt-1 font-medium">{page.data.learning.schedule.reps}</dd>
                          </div>
                        </dl>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">This page has no learning schedule yet.</p>
                      )}
                    </section>
                    <section>
                      <h3 className="font-medium">Prerequisite pages</h3>
                      {page.data.learning.prerequisites.length ? (
                        <ul className="mt-2 grid gap-2">
                          {page.data.learning.prerequisites.map((edge, index) => {
                            const prerequisite = pages.data?.pages.find(
                              (item) => item.pageId === edge.prerequisitePageId,
                            );
                            return (
                              <li key={edge.prerequisitePageId}>
                                {prerequisite ? (
                                  <Link
                                    className="block rounded-lg border border-border bg-background px-3 py-2 no-underline hover:border-foreground"
                                    to={`/notes?pageId=${encodeURIComponent(prerequisite.pageId)}#note-content`}
                                  >
                                    <span className="block font-medium">{prerequisite.title}</span>
                                    <span className="mt-0.5 block text-xs text-muted-foreground">
                                      {prerequisite.relativePath}
                                    </span>
                                  </Link>
                                ) : (
                                  <Link
                                    className="block rounded-lg border border-border bg-background px-3 py-2 font-medium no-underline hover:border-foreground"
                                    to={`/notes?pageId=${encodeURIComponent(edge.prerequisitePageId)}#note-content`}
                                  >
                                    Prerequisite page {index + 1}
                                  </Link>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">This page has no prerequisites.</p>
                      )}
                    </section>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              {issues.isLoading ? (
                <Card>
                  <CardContent>
                    <div
                      className="flex min-h-40 items-center justify-center gap-3 text-muted-foreground"
                      role="status"
                    >
                      <Spinner aria-hidden="true" />
                      <span>Loading issues</span>
                    </div>
                  </CardContent>
                </Card>
              ) : null}
              {issues.isError ? (
                <Alert variant="destructive">
                  <AlertTitle role="heading" aria-level={2}>
                    Could not load issues
                  </AlertTitle>
                  <AlertDescription>{errorMessage(issues.error)}</AlertDescription>
                  <Button
                    className="mt-4 min-h-11 w-fit"
                    type="button"
                    variant="outline"
                    onClick={() => void issues.refetch()}
                  >
                    Try again
                  </Button>
                </Alert>
              ) : null}
              {issues.isSuccess && pageIssues.length ? (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <h3 className="text-xl font-semibold">Issues</h3>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ul className="grid gap-3">
                      {pageIssues.map((issue) => (
                        <li className="rounded-lg border border-border bg-background p-3" key={issue.issueId}>
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="font-medium">{issueLabels[issue.kind]}</p>
                              <p className="mt-1 text-sm text-muted-foreground">{issue.description}</p>
                            </div>
                            <Badge variant={issue.status === "resolved" ? "default" : "secondary"}>
                              {issue.status}
                            </Badge>
                          </div>
                          {issue.resolution ? <p className="mt-3 text-sm">Resolution: {issue.resolution}</p> : null}
                          {issue.status === "resolved" ? (
                            <Button
                              className="mt-3 min-h-11"
                              type="button"
                              variant="ghost"
                              onClick={() => reopen.mutate(issue)}
                              disabled={reopen.isPending}
                            >
                              Reopen issue
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {reopen.isError ? (
                      <Alert variant="destructive">
                        <AlertDescription>{errorMessage(reopen.error)}</AlertDescription>
                      </Alert>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}
              {issues.isSuccess && !pageIssues.length ? (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <h3 className="text-xl font-semibold">Issues</h3>
                    </CardTitle>
                    <CardDescription>No reported issues for this page.</CardDescription>
                  </CardHeader>
                </Card>
              ) : null}
            </div>
          ) : null}
        </article>
      </div>
    </div>
  );
}

function IssueForm({ page, onClose }: { page: WikiPageResult; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const create = useMutation({
    mutationFn: (request: WikiIssueCreateRequest) =>
      api<unknown>("/api/v1/wiki/issues", { method: "POST", body: JSON.stringify(request) }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["wiki", "issues"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
      onClose();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    create.mutate({
      pageId: page.page.pageId,
      pageDigest: page.drift?.actualDigest ?? page.page.digest,
      heading: params.get("heading") ?? undefined,
      kind: String(values.get("kind")) as WikiIssueKind,
      description: String(values.get("description") ?? ""),
    });
  }

  return (
    <Card role="region" aria-labelledby="report-issue-heading">
      <CardHeader>
        <CardTitle>
          <h3 className="text-xl font-semibold" id="report-issue-heading">
            Report an issue
          </h3>
        </CardTitle>
        <CardDescription>The report stays linked to this exact page revision.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor="issue-kind">What is wrong?</FieldLabel>
            <NativeSelect className="w-full" id="issue-kind" name="kind" defaultValue="incorrect">
              {Object.entries(issueLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="issue-description">Description</FieldLabel>
            <Textarea
              className="min-h-32 resize-y"
              id="issue-description"
              name="description"
              required
              aria-describedby="issue-description-help"
            />
            <FieldDescription id="issue-description-help">
              Describe the concrete correction or missing context.
            </FieldDescription>
          </Field>
          <div className="flex flex-wrap gap-3">
            <Button className="min-h-11" type="submit" disabled={create.isPending}>
              {create.isPending ? "Reporting…" : "Report issue"}
            </Button>
            <Button className="min-h-11" type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
          </div>
          {create.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(create.error)}</AlertDescription>
            </Alert>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
