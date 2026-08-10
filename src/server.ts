import { randomUUID } from "node:crypto";
import { createWriteStream, lstatSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { type IncomingMessage, createServer as nodeCreateServer, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import busboy from "busboy";
import { createApplication, type ScholarApplication } from "./application/application.js";
import type {
  ApiEnvelope,
  JsonValue,
  QuizAnswerInput,
  SettingsUpdateRequest,
  SourceRequest,
  WikiDriftResolutionRequest,
  WikiIssueCreateRequest,
  WikiIssueUpdateRequest,
} from "./contracts.js";
import { QuizConflictError } from "./quiz.js";
import { localDate, RevisionConflictError, ValidationError } from "./scheduler.js";
import { LockBusyError, resolveVault, type VaultPaths } from "./vault.js";

const MAX_JSON_BYTES = 1 * 1024 * 1024;
const MULTIPART_FIELD_BYTES = 64 * 1024;
const MULTIPART_FIELD_NAMES: Record<string, true> = {
  kind: true,
  displayName: true,
  mediaType: true,
  originalName: true,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SOURCE_KINDS = ["document", "url", "text", "note", "code", "directory", "repository"] as const;
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface ServerOptions {
  readonly application?: ScholarApplication;
  readonly app?: ScholarApplication;
  readonly paths?: VaultPaths | string;
  readonly staticRoot?: string;
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly version?: string;
  readonly maxJsonBytes?: number;
  readonly maxMultipartBytes?: number;
}

export interface ScholarServer extends Server {
  readonly application: ScholarApplication;
  readonly staticRoot: string;
  readonly closeGracefully: () => Promise<void>;
}

interface RequestOptions {
  readonly host: string;
  readonly maxJsonBytes: number;
  readonly maxMultipartBytes?: number;
}

interface MultipartUpload {
  readonly spoolRoot: string;
  readonly filePath: string;
  readonly name: string;
  readonly originalName: string;
  readonly displayName: string;
  readonly mediaType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysExactly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function booleanField(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") throw new ValidationError(`${key} must be boolean`);
  return value[key];
}
function stringField(value: Record<string, unknown>, key: string, required = false): string | undefined {
  const result = value[key];
  if (result === undefined && !required) return undefined;
  if (typeof result !== "string" || !result.trim()) throw new ValidationError(`${key} must be a nonempty string`);
  return result;
}
function integerField(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (!Number.isInteger(result)) throw new ValidationError(`${key} must be an integer`);
  return result as number;
}
function decodeJson<T>(raw: Buffer): T {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ValidationError("request body is malformed JSON");
  }
  if (!isRecord(value)) throw new ValidationError("request body must be a JSON object");
  return value as T;
}
function contentType(req: IncomingMessage): string {
  return String(req.headers["content-type"] ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLocaleLowerCase();
}
function requireContentType(req: IncomingMessage, expected: string): void {
  if (contentType(req) !== expected)
    throw Object.assign(new Error(`${expected} is required`), { code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
}
function assertRouteMethod(path: string, method: string): void {
  let allowed: readonly string[] | undefined;
  if (path === "/api/v1/sources") allowed = ["GET", "POST"];
  else if (/^\/api\/v1\/sources\/[^/]+\/(removal-preview|removal)$/u.test(path)) allowed = ["POST"];
  else if (
    path === "/api/v1/wiki" ||
    path === "/api/v1/wiki/page" ||
    path === "/api/v1/wiki/search" ||
    path === "/api/v1/quizzes" ||
    path === "/api/v1/workflows"
  )
    allowed = ["GET"];
  else if (path === "/api/v1/wiki/issues") allowed = ["GET", "POST"];
  else if (/^\/api\/v1\/wiki\/issues\/[^/]+$/u.test(path)) allowed = ["PATCH"];
  else if (/^\/api\/v1\/wiki\/pages\/[^/]+\/drift-resolution$/u.test(path)) allowed = ["POST"];
  else if (/^\/api\/v1\/quizzes\/[^/]+(?:\/(answers|submission))?$/u.test(path)) {
    const action = /^\/api\/v1\/quizzes\/[^/]+(?:\/(answers|submission))?$/u.exec(path)?.[1];
    allowed = action === undefined ? ["GET"] : action === "answers" ? ["PUT"] : ["POST"];
  } else if (path === "/api/v1/settings") allowed = ["GET", "PUT"];
  else if (/^\/api\/v1\/workflows\/[^/]+$/u.test(path)) allowed = ["GET"];
  if (allowed !== undefined && !allowed.includes(method))
    throw Object.assign(new Error("method is not supported for this route"), {
      code: "METHOD_NOT_ALLOWED",
      status: 405,
    });
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return "REQUEST_FAILED";
}
function errorStatus(error: unknown): number {
  if (
    error instanceof LockBusyError ||
    error instanceof RevisionConflictError ||
    error instanceof QuizConflictError ||
    /stale|conflict|already submitted|only the current/iu.test(errorText(error))
  )
    return 409;
  if (/not found|unknown page|no quiz for/iu.test(errorText(error))) return 404;
  if (error instanceof ValidationError) return 400;
  return 400;
}
function jsonSafe(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  return String(value);
}
function securityHeaders(res: ServerResponse): void {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
}
function sendJson<T>(res: ServerResponse, status: number, data: T, requestId: string): void {
  const envelope: ApiEnvelope<T> = { ok: true, data, requestId };
  const body = JSON.stringify(envelope);
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}
function sendError(res: ServerResponse, status: number, error: unknown, requestId: string): void {
  const body: ApiEnvelope<never> = {
    ok: false,
    error: {
      code: errorCode(error),
      message: error instanceof LockBusyError ? "Pi Scholar is busy; try again later." : errorText(error),
      ...(error instanceof Error && "details" in error && isRecord(error.details)
        ? { details: jsonSafe(error.details) }
        : {}),
      requestId,
    },
  };
  const encoded = JSON.stringify(body);
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(encoded));
  res.end(encoded);
}
async function bodyBuffer(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > limit)
      throw Object.assign(new Error("request body exceeds configured limit"), { code: "BODY_TOO_LARGE", status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}
function multipartFilename(value: string): string {
  const filename = value || "upload";
  if (
    filename.length > 255 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(filename)
  )
    throw new ValidationError("multipart filename is unsafe");
  return filename;
}

function multipartTooLarge(): Error {
  return Object.assign(new Error("request body exceeds configured limit"), {
    code: "BODY_TOO_LARGE",
    status: 413,
  });
}

async function receiveMultipartUpload(
  req: IncomingMessage,
  workRoot: string,
  maxFileBytes?: number,
): Promise<MultipartUpload> {
  const spoolRoot = await mkdtemp(join(workRoot, "http-upload-"));
  const filePath = join(spoolRoot, "upload");
  try {
    await chmod(spoolRoot, 0o700);
    const fields = new Map<string, string>();
    let fileSeen = false;
    let filename: string | undefined;
    let mediaType: string | undefined;
    let writePromise: Promise<void> | undefined;
    let failure: unknown;

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const parser = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        limits: {
          fieldSize: MULTIPART_FIELD_BYTES,
          fields: Object.keys(MULTIPART_FIELD_NAMES).length,
          ...(maxFileBytes === undefined ? {} : { fileSize: maxFileBytes + 1 }),
          parts: Object.keys(MULTIPART_FIELD_NAMES).length + 2,
        },
      });
      const fail = (error: unknown): void => {
        failure ??= error;
      };
      const requestError = (error: Error): void => {
        fail(error);
        parser.destroy(error);
      };
      req.once("error", requestError);
      parser.on("field", (name, value, info) => {
        if (failure) return;
        if (info.nameTruncated || info.valueTruncated)
          return fail(new ValidationError("multipart field exceeds configured limit"));
        if (!Object.hasOwn(MULTIPART_FIELD_NAMES, name))
          return fail(new ValidationError(`unsupported multipart field: ${name}`));
        if (fields.has(name)) return fail(new ValidationError("multipart field is repeated"));
        fields.set(name, value);
      });
      parser.on("file", (name, file, info) => {
        if (failure || name !== "file" || fileSeen) {
          file.resume();
          if (!failure)
            fail(
              name !== "file"
                ? new ValidationError(`unsupported multipart file field: ${name}`)
                : new ValidationError("multipart request contains multiple files"),
            );
          return;
        }
        fileSeen = true;
        try {
          filename = multipartFilename(info.filename);
        } catch (error) {
          fail(error);
          file.resume();
          return;
        }
        mediaType = info.mimeType || undefined;
        file.on("limit", () => fail(multipartTooLarge()));
        const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
        writePromise = new Promise<void>((resolveWrite) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            resolveWrite();
          };
          output.once("finish", finish);
          output.once("error", (error) => {
            fail(error);
            file.unpipe(output);
            file.resume();
            finish();
          });
          file.once("error", (error) => {
            fail(error);
            output.destroy();
            finish();
          });
          file.pipe(output);
        });
      });
      parser.on("filesLimit", () => fail(new ValidationError("multipart request contains multiple files")));
      parser.on("fieldsLimit", () => fail(new ValidationError("multipart request contains too many fields")));
      parser.on("partsLimit", () => fail(new ValidationError("multipart request contains too many parts")));
      parser.on("error", fail);
      parser.on("close", () => {
        req.off("error", requestError);
        void (async () => {
          try {
            await writePromise;
          } catch (error) {
            fail(error);
          }
          if (failure) rejectPromise(failure);
          else resolvePromise();
        })();
      });
      req.pipe(parser);
    });

    if (!fileSeen || !filename || fields.get("kind") !== "upload")
      throw new ValidationError("multipart upload requires kind=upload and file");
    const requestedMediaType = fields.get("mediaType") ?? mediaType;
    await chmod(filePath, 0o600);
    return {
      spoolRoot,
      filePath,
      name: filename,
      originalName: fields.get("originalName") ?? filename,
      displayName: fields.get("displayName") ?? filename,
      ...(requestedMediaType === undefined ? {} : { mediaType: requestedMediaType }),
    };
  } catch (error) {
    await rm(spoolRoot, { recursive: true, force: true });
    throw error;
  }
}
async function readStaticFile(path: string): Promise<Buffer> {
  const target = lstatSync(path);
  if (target.isSymbolicLink() || target.isDirectory()) throw new Error("static asset is unavailable");
  return readFile(path);
}
function pathSegment(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ValidationError(`${label} path is malformed`);
  }
  if (
    !decoded ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded === "." ||
    decoded === ".." ||
    /[\u0000-\u001f\u007f]/u.test(decoded)
  )
    throw new ValidationError(`${label} path is unsafe`);
  return decoded;
}
function queryOnly(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key)) throw new ValidationError(`unsupported query parameter: ${key}`);
}
function queryOne(url: URL, key: string, required = true): string | undefined {
  const values = url.searchParams.getAll(key);
  if (required && values.length !== 1) throw new ValidationError(`${key} query parameter is required`);
  if (!required && values.length > 1) throw new ValidationError(`${key} query parameter is repeated`);
  return values[0];
}
function publicSourceRecord(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.toLocaleLowerCase().endsWith("path")));
}
function publicSourceResponse(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(Array.isArray(value.sources) ? { sources: value.sources.map(publicSourceRecord) } : {}),
    ...(isRecord(value.source) ? { source: publicSourceRecord(value.source) } : {}),
  };
}
function sourceRequest(value: Record<string, unknown>): SourceRequest {
  if (!keysExactly(value, ["kind", "displayName", "url", "text", "mediaType"]))
    throw new ValidationError("source request has unsupported fields");
  const kindValue = stringField(value, "kind", true)!;
  if (!(SOURCE_KINDS as readonly string[]).includes(kindValue)) throw new ValidationError("source kind is invalid");
  if (kindValue !== "url" && kindValue !== "text") throw new ValidationError("browser source kind is unsupported");
  const kind = kindValue as SourceRequest["kind"];
  const hasUrl = value.url !== undefined;
  const hasText = value.text !== undefined;
  if (hasUrl === hasText || (kind === "url" ? !hasUrl : !hasText))
    throw new ValidationError("source kind and payload do not match");
  const request: SourceRequest = {
    kind,
    ...(value.displayName !== undefined ? { displayName: stringField(value, "displayName") } : {}),
    ...(value.url !== undefined ? { url: stringField(value, "url") } : {}),
    ...(value.text !== undefined
      ? {
          text:
            typeof value.text === "string"
              ? value.text
              : (() => {
                  throw new ValidationError("text must be a string");
                })(),
        }
      : {}),
    ...(value.mediaType !== undefined ? { mediaType: stringField(value, "mediaType") } : {}),
  };
  return request;
}
function issueStatusField(value: Record<string, unknown>): WikiIssueUpdateRequest["status"] {
  const status = stringField(value, "status", true)!;
  if (status !== "reopened" && status !== "resolved") throw new ValidationError("issue status is invalid");
  return status as WikiIssueUpdateRequest["status"];
}
function issueKindField(value: Record<string, unknown>): WikiIssueCreateRequest["kind"] {
  const kind = stringField(value, "kind", true);
  if (kind !== "incorrect" && kind !== "unclear" && kind !== "missing" && kind !== "bad-boundary")
    throw new ValidationError("issue kind is invalid");
  return kind;
}
function driftActionField(value: Record<string, unknown>): WikiDriftResolutionRequest["action"] {
  const action = stringField(value, "action", true);
  if (action !== "restore" && action !== "record-issue") throw new ValidationError("drift action is invalid");
  return action;
}
function quizDate(value: string): string {
  if (!DATE.test(value)) throw new ValidationError("quiz date is malformed");
  return localDate(value);
}
function answersRequest(value: Record<string, unknown>): { expectedRevision: number; answers: QuizAnswerInput[] } {
  if (!keysExactly(value, ["expectedRevision", "answers"]) || !Array.isArray(value.answers))
    throw new ValidationError("quiz answers request is malformed");
  const answers = (value.answers as unknown[]).flatMap((item): QuizAnswerInput[] => {
    if (!isRecord(item) || !keysExactly(item, ["questionId", "answer"]) || typeof item.questionId !== "string")
      throw new ValidationError("quiz answer is malformed");
    if (typeof item.answer === "string") return [{ questionId: item.questionId, answer: item.answer }];
    if (Array.isArray(item.answer) && item.answer.every((part) => typeof part === "string"))
      return [{ questionId: item.questionId, answer: [...item.answer] }];
    throw new ValidationError("quiz answer is malformed");
  });
  return { expectedRevision: integerField(value, "expectedRevision"), answers };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  app: ScholarApplication,
  staticRoot: string,
  options: RequestOptions,
): Promise<void> {
  const requestId = randomUUID();
  securityHeaders(res);
  const hostHeader = String(req.headers.host ?? "").trim();
  const host = hostHeader.replace(/:\d+$/u, "");
  if (host !== options.host) {
    sendError(
      res,
      403,
      Object.assign(new Error("request host is not allowed"), { code: "HOST_NOT_ALLOWED" }),
      requestId,
    );
    return;
  }
  if (
    req.method !== "GET" &&
    req.method !== "POST" &&
    req.method !== "PUT" &&
    req.method !== "PATCH" &&
    req.method !== "HEAD"
  ) {
    sendError(
      res,
      405,
      Object.assign(new Error("HTTP method is not supported"), { code: "METHOD_NOT_ALLOWED", status: 405 }),
      requestId,
    );
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (String(req.headers.origin ?? "").trim() !== `http://${hostHeader}`) {
      sendError(
        res,
        403,
        Object.assign(new Error("request origin is not allowed"), { code: "ORIGIN_NOT_ALLOWED" }),
        requestId,
      );
      return;
    }
    if (
      String(req.headers["sec-fetch-site"] ?? "")
        .trim()
        .toLocaleLowerCase() === "cross-site"
    ) {
      sendError(
        res,
        403,
        Object.assign(new Error("cross-site requests are not allowed"), { code: "CROSS_SITE_REQUEST" }),
        requestId,
      );
      return;
    }
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${options.host}`);
  } catch {
    sendError(res, 400, Object.assign(new Error("request path is malformed"), { code: "INVALID_PATH" }), requestId);
    return;
  }
  const method = req.method;
  if (
    url.pathname.startsWith("/api/v1/") &&
    method !== "GET" &&
    method !== "HEAD" &&
    String(req.headers["x-pi-scholar-request"] ?? "").trim() !== "1"
  ) {
    sendError(
      res,
      403,
      Object.assign(new Error("browser request marker is required"), { code: "REQUEST_MARKER_REQUIRED" }),
      requestId,
    );
    return;
  }
  try {
    if (url.pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
      sendJson(res, 200, await app.health(), requestId);
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      await serveStatic(req, res, url.pathname, staticRoot, requestId);
      return;
    }
    if (method === "HEAD")
      throw Object.assign(new Error("HEAD is not supported for API routes"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    await apiRoute(req, res, app, url, requestId, options);
  } catch (error) {
    const status =
      error instanceof Error && "status" in error && typeof error.status === "number"
        ? Number(error.status)
        : errorStatus(error);
    sendError(res, status, error, requestId);
  }
}

async function apiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  app: ScholarApplication,
  url: URL,
  requestId: string,
  options: RequestOptions,
): Promise<void> {
  const path = url.pathname;
  const method = req.method!;
  assertRouteMethod(path, method);
  if (method !== "GET") {
    const multipartUpload =
      path === "/api/v1/sources" && method === "POST" && contentType(req) === "multipart/form-data";
    if (!multipartUpload) requireContentType(req, "application/json");
  }
  if (path === "/api/v1/sources") {
    if (method === "GET") {
      queryOnly(url, []);
      sendJson(res, 200, publicSourceResponse(await app.listSources()), requestId);
      return;
    }
    if (method !== "POST")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    const type = contentType(req);
    if (type === "multipart/form-data") {
      const upload = await receiveMultipartUpload(req, app.paths.workRoot, options.maxMultipartBytes);
      const staged = await (async () => {
        try {
          return await app.stageSource(
            {
              kind: "upload",
              filePath: upload.filePath,
              name: upload.name,
              originalName: upload.originalName,
              displayName: upload.displayName,
              ...(upload.mediaType === undefined ? {} : { mediaType: upload.mediaType }),
            },
            { origin: "browser" },
          );
        } finally {
          await rm(upload.spoolRoot, { recursive: true, force: true });
        }
      })();
      sendJson(res, 200, publicSourceResponse(staged), requestId);
      return;
    }
    if (type !== "application/json" && type !== "application/json; charset=utf-8" && !type.endsWith("+json"))
      throw Object.assign(new Error("JSON or multipart/form-data is required"), {
        code: "UNSUPPORTED_MEDIA_TYPE",
        status: 415,
      });
    const value = sourceRequest(decodeJson<Record<string, unknown>>(await bodyBuffer(req, options.maxJsonBytes)));
    sendJson(res, 200, publicSourceResponse(await app.stageSource(value, { origin: "browser" })), requestId);
    return;
  }
  const sourceMatch = /^\/api\/v1\/sources\/([^/]+)\/(removal-preview|removal)$/u.exec(path);
  if (sourceMatch) {
    const sourceId = pathSegment(sourceMatch[1]!, "source");
    if (!UUID.test(sourceId)) throw new ValidationError("source ID is malformed");
    if (method !== "POST")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    const raw = decodeJson<Record<string, unknown>>(await bodyBuffer(req, options.maxJsonBytes));
    if (
      !keysExactly(raw, sourceMatch[2] === "removal-preview" ? ["sourceId"] : ["sourceId", "confirmationId"]) ||
      raw.sourceId !== sourceId
    )
      throw new ValidationError("source request identity is malformed");
    if (sourceMatch[2] === "removal-preview")
      sendJson(res, 200, publicSourceResponse(await app.removalPreview(sourceId)), requestId);
    else {
      if (typeof raw.confirmationId !== "string" || !raw.confirmationId)
        throw new ValidationError("confirmationId is required");
      sendJson(res, 200, await app.removeSource(sourceId, raw.confirmationId, { origin: "browser" }), requestId);
    }
    return;
  }
  if (path === "/api/v1/wiki") {
    if (method !== "GET")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    queryOnly(url, []);
    sendJson(res, 200, await app.listWiki(), requestId);
    return;
  }
  if (path === "/api/v1/wiki/page") {
    if (method !== "GET")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    queryOnly(url, ["pageId", "path"]);
    const pageId = queryOne(url, "pageId", false);
    const pagePath = queryOne(url, "path", false);
    if ((pageId ? 1 : 0) + (pagePath ? 1 : 0) !== 1)
      throw new ValidationError("exactly one of pageId or path is required");
    if (pageId && !UUID.test(pageId)) throw new ValidationError("page ID is malformed");
    sendJson(res, 200, await app.getWiki(pageId ?? pagePath!), requestId);
    return;
  }
  if (path === "/api/v1/wiki/search") {
    if (method !== "GET")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    queryOnly(url, ["q", "mode", "limit"]);
    const q = queryOne(url, "q")!;
    const mode = queryOne(url, "mode", false) as "semantic" | "lexical" | "exact" | undefined;
    if (mode !== undefined && mode !== "semantic" && mode !== "lexical" && mode !== "exact")
      throw new ValidationError("mode is invalid");
    const rawLimit = queryOne(url, "limit", false);
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
      throw new ValidationError("limit is invalid");
    sendJson(
      res,
      200,
      await app.searchWiki(q, { ...(mode ? { mode } : {}), ...(limit === undefined ? {} : { limit }) }),
      requestId,
    );
    return;
  }
  if (path === "/api/v1/wiki/issues") {
    if (method === "GET") {
      queryOnly(url, []);
      sendJson(res, 200, await app.listIssues(), requestId);
      return;
    }
    if (method === "POST") {
      const value = decodeJson<Record<string, unknown>>(await bodyBuffer(req, options.maxJsonBytes));
      if (!keysExactly(value, ["pageId", "heading", "pageDigest", "kind", "description"]))
        throw new ValidationError("issue request has unsupported fields");
      const input: WikiIssueCreateRequest = {
        ...(value.pageId === undefined ? {} : { pageId: stringField(value, "pageId") }),
        ...(value.heading === undefined ? {} : { heading: stringField(value, "heading") }),
        ...(value.pageDigest === undefined ? {} : { pageDigest: stringField(value, "pageDigest") }),
        kind: issueKindField(value),
        description: stringField(value, "description", true)!,
      };
      sendJson(res, 200, await app.reportIssue(input, { origin: "browser" }), requestId);
      return;
    }
    throw Object.assign(new Error("method is not supported for this route"), {
      code: "METHOD_NOT_ALLOWED",
      status: 405,
    });
  }
  const issueMatch = /^\/api\/v1\/wiki\/issues\/([^/]+)$/u.exec(path);
  if (issueMatch) {
    if (method !== "PATCH")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    const issueId = pathSegment(issueMatch[1]!, "issue");
    if (!UUID.test(issueId)) throw new ValidationError("issue ID is malformed");
    const value = decodeJson<Record<string, unknown>>(await bodyBuffer(req, options.maxJsonBytes));
    if (!keysExactly(value, ["status", "resolution"])) throw new ValidationError("issue update has unsupported fields");
    const input: WikiIssueUpdateRequest = {
      status: issueStatusField(value),
      ...(value.resolution === undefined ? {} : { resolution: stringField(value, "resolution") }),
    };
    sendJson(res, 200, await app.patchIssue(issueId, input, { origin: "browser" }), requestId);
    return;
  }
  const driftMatch = /^\/api\/v1\/wiki\/pages\/([^/]+)\/drift-resolution$/u.exec(path);
  if (driftMatch) {
    if (method !== "POST")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    const pageId = pathSegment(driftMatch[1]!, "page");
    if (!UUID.test(pageId)) throw new ValidationError("page ID is malformed");
    const value = decodeJson<Record<string, unknown>>(await bodyBuffer(req, options.maxJsonBytes));
    if (!keysExactly(value, ["action", "expectedDigest", "description"]))
      throw new ValidationError("drift request has unsupported fields");
    const input: WikiDriftResolutionRequest = {
      action: driftActionField(value),
      expectedDigest: stringField(value, "expectedDigest", true)!,
      ...(value.description === undefined ? {} : { description: stringField(value, "description") }),
    };
    sendJson(res, 200, await app.resolveDrift(pageId, input, { origin: "browser" }), requestId);
    return;
  }
  if (path === "/api/v1/quizzes") {
    if (method !== "GET")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    queryOnly(url, []);
    sendJson(res, 200, await app.listQuizzes(), requestId);
    return;
  }
  const quizMatch = /^\/api\/v1\/quizzes\/([^/]+)(?:\/(answers|submission))?$/u.exec(path);
  if (quizMatch) {
    const date = quizDate(pathSegment(quizMatch[1]!, "quiz date"));
    const action = quizMatch[2];
    if (!action && method === "GET") {
      queryOnly(url, []);
      sendJson(res, 200, await app.getQuiz(date), requestId);
      return;
    }
    if (action === "answers" && method === "PUT") {
      const value = answersRequest(decodeJson<Record<string, unknown>>(await bodyBuffer(req, options.maxJsonBytes)));
      sendJson(res, 200, await app.saveAnswers(date, value, { origin: "browser" }), requestId);
      return;
    }
    if (action === "submission" && method === "POST") {
      const value = decodeJson<Record<string, unknown>>(await bodyBuffer(req, options.maxJsonBytes));
      if (!keysExactly(value, ["expectedRevision"])) throw new ValidationError("quiz submission request is malformed");
      sendJson(
        res,
        200,
        await app.sealSubmission(
          date,
          { expectedRevision: integerField(value, "expectedRevision") },
          { origin: "browser" },
        ),
        requestId,
      );
      return;
    }
    throw Object.assign(new Error("method is not supported for this route"), {
      code: "METHOD_NOT_ALLOWED",
      status: 405,
    });
  }
  if (path === "/api/v1/workflows") {
    if (method !== "GET")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    queryOnly(url, []);
    sendJson(res, 200, await app.listWorkflows(), requestId);
    return;
  }
  const workflowMatch = /^\/api\/v1\/workflows\/([^/]+)$/u.exec(path);
  if (workflowMatch) {
    if (method !== "GET")
      throw Object.assign(new Error("method is not supported for this route"), {
        code: "METHOD_NOT_ALLOWED",
        status: 405,
      });
    const requestIdValue = pathSegment(workflowMatch[1]!, "workflow");
    if (!UUID.test(requestIdValue)) throw new ValidationError("workflow ID is malformed");
    sendJson(res, 200, { workflow: await app.getWorkflow(requestIdValue) }, requestId);
    return;
  }
  if (path === "/api/v1/settings") {
    if (method === "GET") {
      queryOnly(url, []);
      sendJson(res, 200, await app.getSettings(), requestId);
      return;
    }
    if (method === "PUT") {
      const value = decodeJson<Record<string, unknown>>(await bodyBuffer(req, options.maxJsonBytes));
      if (!keysExactly(value, ["initializationEnabled", "timezone", "port", "host"]))
        throw new ValidationError("settings request has unsupported fields");
      const input: SettingsUpdateRequest = {
        ...(value.initializationEnabled === undefined
          ? {}
          : { initializationEnabled: booleanField(value, "initializationEnabled") }),
        ...(value.timezone === undefined ? {} : { timezone: stringField(value, "timezone") }),
        ...(value.port === undefined ? {} : { port: integerField(value, "port") }),
        ...(value.host === undefined ? {} : { host: stringField(value, "host") }),
      };
      sendJson(res, 200, await app.updateSettings(input, { origin: "browser" }), requestId);
      return;
    }
    throw Object.assign(new Error("method is not supported for this route"), {
      code: "METHOD_NOT_ALLOWED",
      status: 405,
    });
  }
  throw Object.assign(new Error("route not found"), { code: "ROUTE_NOT_FOUND", status: 404 });
}

function staticTargetWithinRoot(root: string, target: string): boolean {
  let physicalRoot: string;
  try {
    physicalRoot = realpathSync(root);
  } catch {
    return false;
  }
  let cursor = resolve(root);
  for (const part of relative(root, target).split(sep)) {
    if (!part || part === ".") continue;
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return false;
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT";
    }
  }
  try {
    const physicalTarget = realpathSync(target);
    return physicalTarget === physicalRoot || physicalTarget.startsWith(`${physicalRoot}${sep}`);
  } catch (error) {
    return isRecord(error) && error.code === "ENOENT";
  }
}
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  root: string,
  requestId: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendError(
      res,
      405,
      Object.assign(new Error("HTTP method is not supported"), { code: "METHOD_NOT_ALLOWED", status: 405 }),
      requestId,
    );
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, Object.assign(new Error("request path is malformed"), { code: "INVALID_PATH" }), requestId);
    return;
  }
  if (decoded.includes("\u0000") || decoded.split("/").some((part) => part === "..")) {
    sendError(res, 400, Object.assign(new Error("request path is unsafe"), { code: "INVALID_PATH" }), requestId);
    return;
  }
  const staticRoot = resolve(root);
  let target = resolve(staticRoot, `.${decoded || "/"}`);
  try {
    const rootStat = lstatSync(staticRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("static root is unavailable");
    const targetStat = lstatSync(target);
    if (targetStat.isDirectory()) target = join(target, "index.html");
  } catch {
    if (decoded !== "/" && !decoded.includes(".")) target = join(staticRoot, "index.html");
    else {
      sendError(res, 404, Object.assign(new Error("static asset not found"), { code: "NOT_FOUND" }), requestId);
      return;
    }
  }
  if (!staticTargetWithinRoot(staticRoot, target)) {
    sendError(res, 400, Object.assign(new Error("request path is unsafe"), { code: "INVALID_PATH" }), requestId);
    return;
  }
  try {
    const bytes = await readStaticFile(target);
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", CONTENT_TYPES[extname(target).toLocaleLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", bytes.byteLength);
    if (req.method === "HEAD") res.end();
    else res.end(bytes);
  } catch {
    sendError(res, 404, Object.assign(new Error("static asset not found"), { code: "NOT_FOUND" }), requestId);
  }
}

export function createServer(options: ServerOptions = {}): ScholarServer {
  const application =
    options.application ??
    options.app ??
    createApplication({
      paths: options.paths ?? resolveVault(),
      ...(options.version ? { version: options.version } : {}),
    });
  const host = "127.0.0.1";
  const staticRoot = resolve(options.staticRoot ?? join(dirname(fileURLToPath(import.meta.url)), "../apps/web/dist"));
  const requestOptions: RequestOptions = {
    host,
    maxJsonBytes: options.maxJsonBytes ?? MAX_JSON_BYTES,
    ...(options.maxMultipartBytes === undefined ? {} : { maxMultipartBytes: options.maxMultipartBytes }),
  };
  const server = nodeCreateServer((req, res) => {
    void handleRequest(req, res, application, staticRoot, requestOptions);
  }) as ScholarServer;
  Object.defineProperty(server, "application", { value: application });
  Object.defineProperty(server, "staticRoot", { value: staticRoot });
  Object.defineProperty(server, "closeGracefully", {
    value: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await application.close();
    },
  });
  return server;
}
export async function startServer(options: ServerOptions = {}): Promise<ScholarServer> {
  const server = createServer(options);
  const port = options.port ?? 4816;
  const host = "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
export const serve = startServer;
