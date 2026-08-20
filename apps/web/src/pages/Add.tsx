import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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

type StageInput =
  | { mode: "upload"; files: File[] }
  | { mode: "url"; url: string }
  | { mode: "paste"; displayName: string; text: string };

const sourceVariants: Record<SourceStatus, "outline" | "default" | "secondary" | "destructive"> = {
  pending: "secondary",
  claimed: "secondary",
  processing: "secondary",
  published: "default",
  failed: "destructive",
  removed: "outline",
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
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Inbox staging</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Add sources</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Stage files, a URL, or pasted source text. Each waits in the inbox for the next admission run.
        </p>
      </header>

      <Card>
        <CardContent>
          <form ref={stageForm} className="space-y-6" onSubmit={submitStage}>
            <FieldSet>
              <FieldLegend>Source type</FieldLegend>
              <RadioGroup
                aria-label="Source type"
                className="grid grid-cols-3 rounded-md border border-input bg-background p-1"
                name="sourceMode"
                onValueChange={(value) => setMode(value as StageInput["mode"])}
                value={mode}
              >
                {(["upload", "url", "paste"] as const).map((value) => {
                  const id = `source-mode-${value}`;
                  return (
                    <Field
                      className={cn(
                        "min-h-11 items-center justify-center rounded-sm px-2 text-sm font-medium focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                        mode === value ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                      key={value}
                      orientation="horizontal"
                    >
                      <RadioGroupItem className="sr-only" id={id} value={value} />
                      <FieldLabel
                        className="flex w-full cursor-pointer justify-center capitalize"
                        htmlFor={id}
                        onClick={() => setMode(value)}
                      >
                        {value}
                      </FieldLabel>
                    </Field>
                  );
                })}
              </RadioGroup>
            </FieldSet>

            {mode === "upload" ? (
              <Field>
                <FieldLabel htmlFor="source-files">Choose files</FieldLabel>
                <Input id="source-files" name="files" type="file" multiple required />
                <FieldDescription>
                  Files are copied into the inbox; selecting them does not admit them immediately.
                </FieldDescription>
              </Field>
            ) : null}
            {mode === "url" ? (
              <Field>
                <FieldLabel htmlFor="source-url">Source URL</FieldLabel>
                <Input
                  id="source-url"
                  name="url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/article"
                  required
                />
              </Field>
            ) : null}
            {mode === "paste" ? (
              <div className="grid gap-4">
                <Field>
                  <FieldLabel htmlFor="source-display-name">Source name</FieldLabel>
                  <Input id="source-display-name" name="displayName" placeholder="Meeting notes, chapter excerpt…" />
                  <FieldDescription>Optional; helps identify this source later.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="source-text">Source text</FieldLabel>
                  <Textarea
                    className="min-h-32 resize-y"
                    id="source-text"
                    name="text"
                    placeholder="Paste source material here"
                    required
                  />
                </Field>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button className="min-h-11" type="submit" disabled={stage.isPending}>
                {stage.isPending ? "Staging…" : "Stage in inbox"}
              </Button>
              <p
                className={stage.isError ? "text-sm text-destructive" : "text-sm text-primary"}
                role={stage.isError ? "alert" : "status"}
                aria-live="polite"
              >
                {stage.isError ? errorMessage(stage.error) : stageMessage}
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      <section aria-labelledby="current-sources-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Source ledger</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight" id="current-sources-heading">
              Current sources
            </h2>
          </div>
          <Button
            className="min-h-11"
            type="button"
            variant="ghost"
            onClick={() => void sources.refetch()}
            disabled={sources.isFetching}
          >
            Refresh
          </Button>
        </div>

        {sources.isLoading ? (
          <div className="mt-5 flex min-h-40 items-center justify-center gap-3 text-muted-foreground" role="status">
            <Spinner aria-hidden="true" />
            <span>Loading sources</span>
          </div>
        ) : null}
        {sources.isError ? (
          <div className="mt-5">
            <Alert variant="destructive">
              <AlertTitle aria-level={2} role="heading">
                Could not load sources
              </AlertTitle>
              <AlertDescription>{errorMessage(sources.error)}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {sources.data?.sources.length === 0 ? (
          <Empty className="mt-5 border border-border bg-card" role="status">
            <EmptyHeader>
              <EmptyTitle aria-level={2} role="heading">
                No sources yet
              </EmptyTitle>
              <EmptyDescription>Stage a source above, or copy files directly into the vault inbox.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        <ul className="mt-5 grid gap-3">
          {sources.data?.sources.map((source) => (
            <li key={source.sourceId}>
              <Card size="sm">
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-words font-semibold">{source.displayName}</h3>
                        <Badge variant={sourceVariants[source.status]}>{source.status}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {source.kind} · Updated{" "}
                        {formatDate(source.updatedAt, { dateStyle: "medium", timeStyle: "short" })}
                      </p>
                    </div>
                    {source.status === "published" ? (
                      <Button
                        className="min-h-11"
                        type="button"
                        variant="outline"
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
                    <div className="mt-5 border-t border-border pt-5" aria-live="polite">
                      <h4 className="text-xl font-semibold tracking-tight">Removal impact</h4>
                      <p className="mt-2 text-sm text-muted-foreground">
                        This updates {preview.dependentPageIds.length} dependent{" "}
                        {preview.dependentPageIds.length === 1 ? "page" : "pages"}. Ordinary removal does not erase
                        bytes from existing Git history.
                      </p>
                      {preview.dependentPageIds.length ? (
                        <p className="mt-3 break-words font-mono text-xs text-muted-foreground">
                          Pages: {preview.dependentPageIds.join(", ")}
                        </p>
                      ) : null}
                      {remove.isError ? (
                        <p className="mt-3 text-sm text-destructive" role="alert">
                          {errorMessage(remove.error)}
                          {remove.error instanceof ApiRequestError &&
                          remove.error.status === 409 &&
                          remove.error.code === "revision-conflict"
                            ? " The impact changed; review the refreshed preview before confirming."
                            : ""}
                        </p>
                      ) : null}
                      <div className="mt-4 flex flex-wrap gap-3">
                        <Button
                          className="min-h-11"
                          type="button"
                          variant="destructive"
                          onClick={() => remove.mutate(preview)}
                          disabled={remove.isPending}
                        >
                          {remove.isPending ? "Removing…" : "Confirm removal"}
                        </Button>
                        <Button
                          className="min-h-11"
                          type="button"
                          variant="ghost"
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
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
        {previewRemoval.isError ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {errorMessage(previewRemoval.error)}
          </p>
        ) : null}
      </section>
    </div>
  );
}
