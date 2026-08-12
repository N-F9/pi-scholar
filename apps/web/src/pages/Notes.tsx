import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
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
import { Badge, Button, Card, cx, Field, Input, Spinner, StateView, Textarea } from "../components/ui";

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
        <p className="eyebrow">Read-only wiki</p>
        <h1 className="page-heading mt-2">Notes</h1>
        <p className="mt-3 max-w-2xl text-muted">
          Browse maintained knowledge, inspect its learning schedule and prerequisites, and report what needs
          correction.
        </p>
      </header>
      <div className="grid gap-6 xl:grid-cols-3">
        <aside
          className="self-start rounded-lg border border-line bg-paper p-4 xl:sticky xl:top-8"
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
              <Button type="submit" variant="secondary">
                Search
              </Button>
            </form>
          </search>
          {search ? (
            <div className="mt-3 flex items-center justify-between gap-2 text-sm">
              <span className="truncate text-muted">Results for “{search}”</span>
              <Button className="min-h-9 px-2 py-1" variant="quiet" onClick={() => commitSearch("")}>
                Clear
              </Button>
            </div>
          ) : null}
          {pages.isLoading ? <Spinner label="Loading notes" /> : null}
          {pages.isError ? (
            <p className="mt-4 text-sm text-danger" role="alert">
              {errorMessage(pages.error)}
            </p>
          ) : null}
          {pages.data?.pages.length === 0 ? (
            <p className="mt-6 text-sm text-muted">
              {search ? "No notes match this search." : "No wiki pages have been published yet."}
            </p>
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
                      className={cx(
                        "block min-h-11 rounded-md px-3 py-2",
                        selected ? "bg-ink text-paper" : "text-muted hover:bg-canvas hover:text-ink",
                      )}
                      to={`/notes?${next.toString()}#note-content`}
                    >
                      <span className="block truncate font-bold">{item.title}</span>
                      <span className={cx("mt-0.5 block truncate text-xs", selected ? "text-paper/70" : "text-muted")}>
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
            <StateView title="Choose a note">
              <p>Select a wiki page to read it here. Notes are maintained through Pi; the browser stays read-only.</p>
            </StateView>
          ) : null}
          {page.isLoading ? <Spinner label="Loading note" /> : null}
          {page.isError ? (
            <StateView title="Could not load this note" tone="danger">
              <p>{errorMessage(page.error)}</p>
            </StateView>
          ) : null}
          {page.data ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-6">
                <div>
                  <p className="eyebrow">{page.data.page.relativePath}</p>
                  <h2 className="mt-2 font-serif text-4xl font-semibold tracking-tight">{page.data.page.title}</h2>
                  <p className="mt-2 text-sm text-muted">
                    Updated {formatDate(page.data.page.updatedAt, { dateStyle: "medium", timeStyle: "short" })} ·
                    revision {page.data.page.revision}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => setReporting(true)}>
                  Report issue
                </Button>
              </div>

              {page.data.drift?.diff ? (
                <Card className="border-caution/50 bg-caution/10 shadow-none">
                  <Badge tone="caution">Direct edit detected</Badge>
                  <h3 className="mt-3 font-serif text-2xl font-semibold">Restore the maintained page</h3>
                  <p className="mt-2 text-sm text-muted">
                    The current bytes are preserved below. Direct edits cannot become canonical in this version.
                  </p>
                  <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-ink p-4 font-mono text-xs text-paper">
                    {page.data.drift.diff}
                  </pre>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <Button
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
                      variant="secondary"
                      onClick={() => drift.mutate({ action: "restore", expectedDigest: page.data.drift!.actualDigest })}
                      disabled={drift.isPending}
                    >
                      Discard diff and restore
                    </Button>
                  </div>
                  {drift.isError ? (
                    <p className="mt-4 text-sm font-bold text-danger" role="alert">
                      {errorMessage(drift.error)}
                    </p>
                  ) : null}
                </Card>
              ) : page.data.page.status === "drifted" ? (
                <Card className="border-caution/50 bg-caution/10 shadow-none">
                  <Badge tone="caution">Maintenance correction required</Badge>
                  <p className="mt-3 text-sm text-muted">
                    This page is semantically stale and needs a guarded Pi maintenance correction before its learning
                    schedule can return.
                  </p>
                </Card>
              ) : null}

              {reporting ? <IssueForm page={page.data} onClose={() => setReporting(false)} /> : null}
              <Card className="px-5 py-7 sm:px-8 sm:py-10">
                <Markdown
                  source={page.data.markdown}
                  pagePath={page.data.page.relativePath}
                  headings={page.data.sections}
                />
              </Card>

              <details className="group rounded-lg border border-line bg-paper">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 font-bold marker:content-none">
                  <span>
                    Learning{" "}
                    <span className="ml-2 font-normal text-muted">
                      {page.data.learning.schedule?.fsrsState ?? "Not scheduled"} ·{" "}
                      {page.data.learning.prerequisites.length}{" "}
                      {page.data.learning.prerequisites.length === 1 ? "prerequisite" : "prerequisites"}
                    </span>
                  </span>
                  <span
                    className="text-xl transition-transform duration-200 ease-expo group-open:rotate-45"
                    aria-hidden="true"
                  >
                    +
                  </span>
                </summary>
                <div className="space-y-6 border-t border-line p-5">
                  <section>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="font-serif text-2xl font-semibold">Page schedule</h3>
                      {page.data.learning.schedule ? (
                        <Badge tone="neutral">{page.data.learning.schedule.fsrsState}</Badge>
                      ) : null}
                    </div>
                    {page.data.learning.schedule ? (
                      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                        <div>
                          <dt className="text-muted">Next due</dt>
                          <dd className="mt-1 font-bold">{formatDate(page.data.learning.schedule.dueAt)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted">Revision</dt>
                          <dd className="mt-1 font-bold">{page.data.learning.schedule.revision}</dd>
                        </div>
                        <div>
                          <dt className="text-muted">Reviews</dt>
                          <dd className="mt-1 font-bold">{page.data.learning.schedule.reps}</dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="mt-2 text-sm text-muted">This page has no learning schedule yet.</p>
                    )}
                  </section>
                  <section>
                    <h3 className="font-bold">Prerequisite pages</h3>
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
                                  className="block rounded-md border border-line bg-canvas px-3 py-2 hover:border-ink"
                                  to={`/notes?pageId=${encodeURIComponent(prerequisite.pageId)}#note-content`}
                                >
                                  <span className="block font-bold">{prerequisite.title}</span>
                                  <span className="mt-0.5 block text-xs text-muted">{prerequisite.relativePath}</span>
                                </Link>
                              ) : (
                                <Link
                                  className="block rounded-md border border-line bg-canvas px-3 py-2 font-bold hover:border-ink"
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
                      <p className="mt-2 text-sm text-muted">This page has no prerequisites.</p>
                    )}
                  </section>
                </div>
              </details>

              {issues.isLoading ? (
                <Card className="shadow-none">
                  <Spinner label="Loading issues" />
                </Card>
              ) : null}
              {issues.isError ? (
                <StateView title="Could not load issues" tone="danger">
                  <p>{errorMessage(issues.error)}</p>
                  <Button className="mt-4" variant="secondary" onClick={() => void issues.refetch()}>
                    Try again
                  </Button>
                </StateView>
              ) : null}
              {issues.isSuccess && pageIssues.length ? (
                <Card className="shadow-none">
                  <h3 className="font-serif text-2xl font-semibold">Issues</h3>
                  <ul className="mt-4 grid gap-3">
                    {pageIssues.map((issue) => (
                      <li className="rounded-md border border-line bg-canvas p-3" key={issue.issueId}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="font-bold">{issueLabels[issue.kind]}</p>
                            <p className="mt-1 text-sm text-muted">{issue.description}</p>
                          </div>
                          <Badge tone={issue.status === "resolved" ? "positive" : "caution"}>{issue.status}</Badge>
                        </div>
                        {issue.resolution ? <p className="mt-3 text-sm">Resolution: {issue.resolution}</p> : null}
                        {issue.status === "resolved" ? (
                          <Button
                            className="mt-3"
                            variant="quiet"
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
                    <p className="mt-3 text-sm text-danger" role="alert">
                      {errorMessage(reopen.error)}
                    </p>
                  ) : null}
                </Card>
              ) : null}
              {issues.isSuccess && !pageIssues.length ? (
                <Card className="shadow-none">
                  <h3 className="font-serif text-2xl font-semibold">Issues</h3>
                  <p className="mt-3 text-sm text-muted">No reported issues for this page.</p>
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
    <Card className="border-accent shadow-none" aria-labelledby="report-issue-heading">
      <h3 className="font-serif text-2xl font-semibold" id="report-issue-heading">
        Report an issue
      </h3>
      <p className="mt-2 text-sm text-muted">The report stays linked to this exact page revision.</p>
      <form className="mt-5 grid gap-4" onSubmit={submit}>
        <Field label="What is wrong?">
          <select className="control" name="kind" defaultValue="incorrect">
            {Object.entries(issueLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description" hint="Describe the concrete correction or missing context.">
          <Textarea name="description" required />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Reporting…" : "Report issue"}
          </Button>
          <Button variant="quiet" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
        </div>
        {create.isError ? (
          <p className="text-sm text-danger" role="alert">
            {errorMessage(create.error)}
          </p>
        ) : null}
      </form>
    </Card>
  );
}
