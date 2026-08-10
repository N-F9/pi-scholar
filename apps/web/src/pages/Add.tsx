import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import type {
  SourceCreateResult,
  SourceListResult,
  SourceRecord,
  SourceRemovalPreviewRequest,
  SourceRemovalPreviewResult,
  SourceRemovalRequest,
  SourceRemovalResult,
  SourceRequest,
  SourceStatus,
} from "../../../../src/contracts";
import {
  ApiRequestError,
  api,
  errorMessage,
  formatDate,
  isSourceCreateResult,
  isSourceListResult,
  isSourceRemovalPreviewResult,
  isSourceRemovalResult,
} from "../api";
import { Badge, Button, Card, cx, Field, Input, Spinner, StateView, Textarea } from "../components/ui";

type StageInput =
  | { mode: "upload"; files: File[] }
  | { mode: "url"; url: string }
  | { mode: "paste"; displayName: string; text: string };

const sourceTones: Record<SourceStatus, "neutral" | "positive" | "caution" | "danger"> = {
  pending: "caution",
  claimed: "caution",
  processing: "caution",
  published: "positive",
  failed: "danger",
  removed: "neutral",
};

export function AddPage() {
  const queryClient = useQueryClient();
  const stageForm = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<StageInput["mode"]>("upload");
  const [preview, setPreview] = useState<SourceRemovalPreviewResult>();
  const [stageMessage, setStageMessage] = useState("");

  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: ({ signal }) => api<SourceListResult>("/api/v1/sources", { signal }, isSourceListResult),
  });

  const stage = useMutation({
    mutationFn: async (input: StageInput) => {
      if (input.mode === "upload") {
        const staged: SourceRecord[] = [];
        const failures: string[] = [];
        for (const file of input.files) {
          const form = new FormData();
          form.set("kind", "upload");
          form.set("displayName", file.name);
          form.set("file", file);
          try {
            const result = await api<SourceCreateResult>(
              "/api/v1/sources",
              { method: "POST", body: form },
              isSourceCreateResult,
            );
            staged.push(result.source);
          } catch (error) {
            failures.push(`${file.name}: ${errorMessage(error)}`);
          }
        }
        if (failures.length) {
          throw new Error(
            `${staged.length} ${staged.length === 1 ? "file was" : "files were"} staged before an upload failed. ${failures.join(" ")} Choose only the failed files before trying again.`,
          );
        }
        return staged;
      }
      const request: SourceRequest =
        input.mode === "url"
          ? { kind: "url", url: input.url }
          : {
              kind: "text",
              displayName: input.displayName || "Pasted source",
              text: input.text,
              mediaType: "text/plain",
            };
      const result = await api<SourceCreateResult>(
        "/api/v1/sources",
        { method: "POST", body: JSON.stringify(request) },
        isSourceCreateResult,
      );
      return [result.source];
    },
    onSuccess: async (created, input) => {
      if (input.mode === "upload") stageForm.current?.reset();
      setStageMessage(`${created.length} ${created.length === 1 ? "source" : "sources"} staged in the inbox.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sources"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
    onError: async (_error, input) => {
      if (input.mode === "upload") stageForm.current?.reset();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sources"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
  });

  const previewRemoval = useMutation({
    mutationFn: (sourceId: string) => {
      const request: SourceRemovalPreviewRequest = { sourceId };
      return api<SourceRemovalPreviewResult>(
        `/api/v1/sources/${encodeURIComponent(sourceId)}/removal-preview`,
        { method: "POST", body: JSON.stringify(request) },
        isSourceRemovalPreviewResult,
      );
    },
    onSuccess: setPreview,
  });

  const remove = useMutation({
    mutationFn: (value: SourceRemovalPreviewResult) => {
      const request: SourceRemovalRequest = { sourceId: value.source.sourceId, confirmationId: value.confirmationId };
      return api<SourceRemovalResult>(
        `/api/v1/sources/${encodeURIComponent(value.source.sourceId)}/removal`,
        {
          method: "POST",
          body: JSON.stringify(request),
        },
        isSourceRemovalResult,
      );
    },
    onSuccess: async () => {
      setPreview(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sources"] }),
        queryClient.invalidateQueries({ queryKey: ["wiki"] }),
        queryClient.invalidateQueries({ queryKey: ["quizzes"] }),
        queryClient.invalidateQueries({ queryKey: ["quiz"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["workflows"] }),
      ]);
    },
    onError: (error) => {
      const sourceId = preview?.source.sourceId;
      if (error instanceof ApiRequestError && error.status === 409 && error.code === "revision-conflict" && sourceId) {
        setPreview(undefined);
        previewRemoval.mutate(sourceId);
      }
    },
  });

  function submitStage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStageMessage("");
    const form = new FormData(event.currentTarget);
    if (mode === "upload") {
      const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
      if (files.length) stage.mutate({ mode, files });
    } else if (mode === "url") {
      stage.mutate({ mode, url: String(form.get("url") ?? "") });
    } else {
      stage.mutate({ mode, displayName: String(form.get("displayName") ?? ""), text: String(form.get("text") ?? "") });
    }
  }

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">Inbox staging</p>
        <h1 className="page-heading mt-2">Add sources</h1>
        <p className="mt-3 max-w-2xl text-muted">
          Stage files, a URL, or pasted source text. Each waits in the inbox for the next admission run.
        </p>
      </header>

      <Card>
        <form ref={stageForm} className="space-y-6" onSubmit={submitStage}>
          <fieldset>
            <legend className="text-sm font-bold">Source type</legend>
            <div className="mt-2 grid grid-cols-3 rounded-md border border-line bg-canvas p-1">
              {(["upload", "url", "paste"] as const).map((value) => (
                <label
                  className={cx(
                    "flex min-h-11 cursor-pointer items-center justify-center rounded-sm px-2 text-sm font-bold capitalize focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2",
                    mode === value ? "bg-paper text-ink shadow-sm" : "text-muted hover:text-ink",
                  )}
                  key={value}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="sourceMode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  {value}
                </label>
              ))}
            </div>
          </fieldset>

          {mode === "upload" ? (
            <Field
              label="Choose files"
              hint="Files are copied into the inbox; selecting them does not admit them immediately."
            >
              <Input name="files" type="file" multiple required />
            </Field>
          ) : null}
          {mode === "url" ? (
            <Field label="Source URL">
              <Input name="url" type="url" inputMode="url" placeholder="https://example.com/article" required />
            </Field>
          ) : null}
          {mode === "paste" ? (
            <div className="grid gap-4">
              <Field label="Source name" hint="Optional; helps identify this source later.">
                <Input name="displayName" placeholder="Meeting notes, chapter excerpt…" />
              </Field>
              <Field label="Source text">
                <Textarea name="text" placeholder="Paste source material here" required />
              </Field>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={stage.isPending}>
              {stage.isPending ? "Staging…" : "Stage in inbox"}
            </Button>
            <p
              className={stage.isError ? "text-sm text-danger" : "text-sm text-positive"}
              role={stage.isError ? "alert" : "status"}
              aria-live="polite"
            >
              {stage.isError ? errorMessage(stage.error) : stageMessage}
            </p>
          </div>
        </form>
      </Card>

      <section aria-labelledby="current-sources-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow">Source ledger</p>
            <h2 className="mt-2 font-serif text-3xl font-semibold" id="current-sources-heading">
              Current sources
            </h2>
          </div>
          <Button variant="quiet" onClick={() => void sources.refetch()} disabled={sources.isFetching}>
            Refresh
          </Button>
        </div>

        {sources.isLoading ? <Spinner label="Loading sources" /> : null}
        {sources.isError ? (
          <div className="mt-5">
            <StateView title="Could not load sources" tone="danger">
              <p>{errorMessage(sources.error)}</p>
            </StateView>
          </div>
        ) : null}
        {sources.data?.sources.length === 0 ? (
          <div className="mt-5">
            <StateView title="No sources yet">
              <p>Stage a source above, or copy files directly into the vault inbox.</p>
            </StateView>
          </div>
        ) : null}

        <ul className="mt-5 grid gap-3">
          {sources.data?.sources.map((source) => (
            <li className="rounded-lg border border-line bg-paper p-4" key={source.sourceId}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-words font-bold">{source.displayName}</h3>
                    <Badge tone={sourceTones[source.status]}>{source.status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {source.kind} · Updated {formatDate(source.updatedAt, { dateStyle: "medium", timeStyle: "short" })}
                  </p>
                  {source.errorMessage ? (
                    <p className="mt-2 text-sm text-danger" role="alert">
                      {source.errorMessage}
                    </p>
                  ) : null}
                </div>
                {source.status === "published" ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      remove.reset();
                      previewRemoval.mutate(source.sourceId);
                    }}
                    disabled={previewRemoval.isPending || remove.isPending}
                  >
                    Preview removal
                  </Button>
                ) : null}
              </div>

              {preview?.source.sourceId === source.sourceId ? (
                <div className="mt-5 border-t border-line pt-5" aria-live="polite">
                  <h4 className="font-serif text-xl font-semibold">Removal impact</h4>
                  <p className="mt-2 text-sm text-muted">
                    This updates {preview.dependentPageIds.length} dependent{" "}
                    {preview.dependentPageIds.length === 1 ? "page" : "pages"}. Ordinary removal does not erase bytes
                    from existing Git history.
                  </p>
                  {preview.dependentPageIds.length ? (
                    <p className="mt-3 break-words font-mono text-xs text-muted">
                      Pages: {preview.dependentPageIds.join(", ")}
                    </p>
                  ) : null}
                  {remove.isError ? (
                    <p className="mt-3 text-sm text-danger" role="alert">
                      {errorMessage(remove.error)}
                      {remove.error instanceof ApiRequestError &&
                      remove.error.status === 409 &&
                      remove.error.code === "revision-conflict"
                        ? " The impact changed; review the refreshed preview before confirming."
                        : ""}
                    </p>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Button variant="danger" onClick={() => remove.mutate(preview)} disabled={remove.isPending}>
                      {remove.isPending ? "Removing…" : "Confirm removal"}
                    </Button>
                    <Button
                      variant="quiet"
                      onClick={() => {
                        remove.reset();
                        setPreview(undefined);
                      }}
                      disabled={remove.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {previewRemoval.isError ? (
          <p className="mt-4 text-sm text-danger" role="alert">
            {errorMessage(previewRemoval.error)}
          </p>
        ) : null}
      </section>
    </div>
  );
}
