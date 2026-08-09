import { randomUUID } from "node:crypto";
import type { WorkflowRecord } from "./contracts.js";
import { type ScholarDatabase, transaction } from "./database.js";

export type WorkflowKind = WorkflowRecord["kind"];

export interface MutationWorkerTaskOptions {
  readonly signal?: AbortSignal;
}

interface QueueTask<T> {
  readonly run: () => T | PromiseLike<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

/** One FIFO is enough: browser mutations have one observable order. */
export class BrowserMutationWorker {
  private readonly queue: QueueTask<unknown>[] = [];
  private running = false;
  private closing = false;
  private idleWaiters: (() => void)[] = [];

  enqueue<T>(run: () => T | PromiseLike<T>, _options?: MutationWorkerTaskOptions): Promise<T> {
    if (this.closing) return Promise.reject(new Error("browser mutation worker is closed"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve: resolve as (value: unknown) => void, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift();
        if (!task) continue;
        try {
          task.resolve(await task.run());
        } catch (error) {
          task.reject(error);
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  async close(options: { readonly drain?: boolean } = {}): Promise<void> {
    this.closing = true;
    if (!options.drain) {
      const error = new Error("browser mutation worker is closing");
      for (const task of this.queue.splice(0)) task.reject(error);
    }
    if (this.running || this.queue.length) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }
}

export interface WorkflowCoordinatorOptions {
  readonly worker?: BrowserMutationWorker;
}
export interface WorkflowUpdateInput {
  readonly progress?: number;
  readonly message?: string;
}

export interface WorkflowFinishOptions extends WorkflowUpdateInput {
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

const WORKFLOW_MESSAGE_BYTES = 500;
const WORKFLOW_ERROR_CODE_BYTES = 100;
const WORKFLOW_ERROR_MESSAGE_BYTES = 500;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function boundedUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}

function boundedText(value: string | undefined, maxBytes: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return boundedUtf8(value, maxBytes);
}

function workflowProgress(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("workflow progress must be a finite number between 0 and 1");
  }
  return value;
}

function workflowRequestId(value: string): string {
  if (!UUID_V4.test(value)) throw new Error("invalid workflow request ID");
  return value;
}

function rowToWorkflow(row: Record<string, unknown>): WorkflowRecord {
  return {
    requestId: String(row.request_id),
    kind: String(row.kind) as WorkflowKind,
    status: String(row.status) as WorkflowRecord["status"],
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
    progress: Number(row.progress ?? 0),
    ...(row.message ? { message: String(row.message) } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
  };
}

function cleanIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error("invalid workflow idempotency key");
  return value;
}

export class WorkflowCoordinator {
  readonly db: ScholarDatabase;
  readonly worker: BrowserMutationWorker;

  constructor(db: ScholarDatabase, options: WorkflowCoordinatorOptions = {}) {
    this.db = db;
    this.worker = options.worker ?? new BrowserMutationWorker();
  }

  get(requestId: string): WorkflowRecord | undefined {
    const row = this.db.get<Record<string, unknown>>("SELECT * FROM workflows WHERE request_id = ?", [requestId]);
    return row ? rowToWorkflow(row) : undefined;
  }

  list(): WorkflowRecord[] {
    return this.db
      .all<Record<string, unknown>>("SELECT * FROM workflows ORDER BY rowid DESC, request_id")
      .map(rowToWorkflow);
  }
  /** Insert a queued workflow inside a caller-owned SQLite transaction. */
  queueInTransaction(kind: WorkflowKind, requestId: string, idempotencyKey?: string): WorkflowRecord {
    const key = cleanIdempotencyKey(idempotencyKey);
    workflowRequestId(requestId);
    if (key) {
      const prior = this.db.get<Record<string, unknown>>("SELECT * FROM workflows WHERE idempotency_key = ?", [key]);
      if (prior) {
        if (String(prior.kind) !== kind || String(prior.request_id) !== requestId)
          throw new Error("workflow idempotency key is already bound");
        return rowToWorkflow(prior);
      }
    }
    this.db.run(
      "INSERT INTO workflows (request_id, kind, status, started_at, finished_at, progress, message, error_code, error_message, idempotency_key) VALUES (?, ?, 'queued', NULL, NULL, 0, NULL, NULL, NULL, ?)",
      [requestId, kind, key ?? null],
    );
    const workflow = this.get(requestId);
    if (!workflow) throw new Error("queued workflow disappeared");
    return workflow;
  }

  beginWorkflow(kind: WorkflowKind, idempotencyKey?: string): WorkflowRecord {
    const key = cleanIdempotencyKey(idempotencyKey);
    return transaction(this.db, () => {
      if (key) {
        const prior = this.db.get<Record<string, unknown>>("SELECT * FROM workflows WHERE idempotency_key = ?", [key]);
        if (prior) {
          if (String(prior.kind) !== kind) throw new Error("workflow idempotency key is already bound");
          const existing = rowToWorkflow(prior);
          if (existing.status !== "queued") return existing;
          const startedAt = new Date().toISOString();
          const result = this.db.run(
            "UPDATE workflows SET status = 'running', started_at = ?, error_code = NULL, error_message = NULL WHERE request_id = ? AND status = 'queued'",
            [startedAt, existing.requestId],
          );
          if (Number(result.changes) !== 1) throw new Error("workflow could not be started");
          const running = this.get(existing.requestId);
          if (!running) throw new Error("started workflow disappeared");
          return running;
        }
      }
      const requestId = randomUUID();
      this.queueInTransaction(kind, requestId, key);
      const startedAt = new Date().toISOString();
      const result = this.db.run(
        "UPDATE workflows SET status = 'running', started_at = ?, error_code = NULL, error_message = NULL WHERE request_id = ? AND status = 'queued'",
        [startedAt, requestId],
      );
      if (Number(result.changes) !== 1) throw new Error("workflow could not be started");
      const running = this.get(requestId);
      if (!running) throw new Error("started workflow disappeared");
      return running;
    });
  }

  updateWorkflow(requestId: string, input: WorkflowUpdateInput = {}): WorkflowRecord {
    workflowRequestId(requestId);
    const progress = workflowProgress(input.progress);
    const message = boundedText(input.message, WORKFLOW_MESSAGE_BYTES, "workflow message");
    return transaction(this.db, () => {
      const current = this.get(requestId);
      if (!current) throw new Error("workflow not found");
      if (current.status !== "running") throw new Error("workflow is not running");
      const result = this.db.run(
        "UPDATE workflows SET progress = ?, message = ? WHERE request_id = ? AND status = 'running'",
        [progress ?? current.progress, message ?? current.message ?? null, requestId],
      );
      if (Number(result.changes) !== 1) throw new Error("workflow is no longer running");
      const updated = this.get(requestId);
      if (!updated) throw new Error("updated workflow disappeared");
      return updated;
    });
  }

  finishWorkflow(
    requestId: string,
    status: "succeeded" | "failed",
    options: WorkflowFinishOptions = {},
  ): WorkflowRecord {
    workflowRequestId(requestId);
    if (status !== "succeeded" && status !== "failed") throw new Error("workflow finish status is invalid");
    const progress = workflowProgress(options.progress);
    const message = boundedText(options.message, WORKFLOW_MESSAGE_BYTES, "workflow message");
    const errorCode = boundedText(options.errorCode, WORKFLOW_ERROR_CODE_BYTES, "workflow error code");
    const errorMessage = boundedText(options.errorMessage, WORKFLOW_ERROR_MESSAGE_BYTES, "workflow error message");
    return transaction(this.db, () => {
      const current = this.get(requestId);
      if (!current) throw new Error("workflow not found");
      if (current.status === status) return current;
      if (current.status !== "running") throw new Error("workflow is not running");
      const result = this.db.run(
        "UPDATE workflows SET status = ?, finished_at = ?, progress = ?, message = ?, error_code = ?, error_message = ? WHERE request_id = ? AND status = 'running'",
        [
          status,
          new Date().toISOString(),
          progress ?? (status === "succeeded" ? 1 : current.progress),
          message ?? current.message ?? null,
          status === "failed" ? (errorCode ?? null) : null,
          status === "failed" ? (errorMessage ?? null) : null,
          requestId,
        ],
      );
      if (Number(result.changes) !== 1) throw new Error("workflow is no longer running");
      const finished = this.get(requestId);
      if (!finished) throw new Error("finished workflow disappeared");
      return finished;
    });
  }

  succeedWorkflow(requestId: string, options: WorkflowFinishOptions = {}): WorkflowRecord {
    return this.finishWorkflow(requestId, "succeeded", options);
  }

  failWorkflow(requestId: string, options: WorkflowFinishOptions = {}): WorkflowRecord {
    return this.finishWorkflow(requestId, "failed", options);
  }

  async close(options: { readonly drain?: boolean } = {}): Promise<void> {
    await this.worker.close({ drain: options.drain ?? true });
  }
}

export function workflowFromRow(row: Record<string, unknown>): WorkflowRecord {
  return rowToWorkflow(row);
}
