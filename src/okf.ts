import { fromMarkdown } from "mdast-util-from-markdown";
import { parseDocument, stringify } from "yaml";

export interface OkfConcept {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface OkfPiScholarIdentity {
  managedBy: "pi-scholar";
  sourceId: string;
  chunkId: string;
  ordinal: number;
  sourceDigest?: string;
  chunkDigest?: string;
}

export interface OkfSourceReference {
  readonly id?: string;
  readonly resource: string;
  readonly title?: string;
  readonly piScholar?: OkfPiScholarIdentity;
  readonly metadata: Record<string, unknown>;
}

export interface OkfProjectionPage {
  readonly title: string;
  readonly path: string;
  readonly description?: string;
  readonly updatedAt?: string;
  readonly digest?: string;
}

const SOURCE_ID = /^[^\s[\]]+$/u;
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/gu;
const FOOTNOTE_DEFINITION = /^[ \t]{0,3}\[\^([^\]\s]+)\]:/gmu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function frontmatterBlock(markdown: string): { yaml: string; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(markdown);
  if (!match) throw new Error("OKF concept requires YAML frontmatter");
  return { yaml: match[1] ?? "", body: markdown.slice(match[0].length) };
}

function parseMapping(yaml: string): Record<string, unknown> {
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`invalid OKF YAML: ${document.errors[0]?.message ?? "parse error"}`);
  const value = document.toJS({ mapAsMap: false }) as unknown;
  if (!isRecord(value)) throw new Error("OKF frontmatter must be a YAML mapping");
  return value;
}

function validateFrontmatter(frontmatter: Record<string, unknown>): void {
  if (typeof frontmatter.type !== "string" || !frontmatter.type.trim())
    throw new Error("OKF concept requires a non-empty string type");
  const sources = frontmatter.sources;
  if (sources === undefined) return;
  if (!Array.isArray(sources)) throw new Error("OKF sources must be a YAML sequence");
  const ids = new Set<string>();
  for (const source of sources) {
    if (!isRecord(source)) throw new Error("OKF source entries must be YAML mappings");
    if (typeof source.resource !== "string" || !source.resource.trim())
      throw new Error("OKF source entries require a non-empty resource");
    if (source.id !== undefined) {
      if (typeof source.id !== "string" || !source.id.trim() || !SOURCE_ID.test(source.id))
        throw new Error("OKF source IDs must be non-empty strings");
      if (ids.has(source.id)) throw new Error(`duplicate OKF source ID: ${source.id}`);
      ids.add(source.id);
    }
  }
}

type MarkdownNode = {
  readonly type: string;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
  readonly children?: readonly MarkdownNode[];
};

function blankMarkdown(value: string): string {
  return value.replace(/[^\r\n]/gu, " ");
}

export function okfMarkdownEscapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

export function okfCitationText(body: string): string {
  const ranges: Array<readonly [number, number]> = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(body) as MarkdownNode);
  let visible = body;
  for (const [start, end] of ranges.sort((left, right) => right[0] - left[0]))
    visible = `${visible.slice(0, start)}${blankMarkdown(visible.slice(start, end))}${visible.slice(end)}`;
  return visible;
}

export function okfFootnoteLabels(body: string): { readonly references: string[]; readonly definitions: string[] } {
  const visible = okfCitationText(body);
  const definitionMatches = [...visible.matchAll(FOOTNOTE_DEFINITION)];
  const definitionStarts = new Set(definitionMatches.map((match) => match.index! + match[0].indexOf("[^")));
  return {
    references: [...visible.matchAll(FOOTNOTE_REFERENCE)]
      .filter((match) => !definitionStarts.has(match.index!) && !okfMarkdownEscapedAt(visible, match.index!))
      .map((match) => match[1]!)
      .filter(Boolean),
    definitions: definitionMatches.map((match) => match[1]!).filter(Boolean),
  };
}
export function removeOkfFootnoteDefinitions(body: string, ids: Iterable<string>): string {
  const labels = [...new Set(ids)].filter(Boolean).map((id) => id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (!labels.length) return body;
  const visible = okfCitationText(body);
  const pattern = new RegExp(`^[ \\t]{0,3}\\[\\^(?:${labels.join("|")})\\]:[^\\n]*(?:\\n|$)`, "gmu");
  const ranges = [...visible.matchAll(pattern)]
    .map((match) => [match.index!, match.index! + match[0].length] as const)
    .reverse();
  let result = body;
  for (const [start, end] of ranges) result = `${result.slice(0, start)}${result.slice(end)}`;
  return result;
}

export function parseOkfConcept(markdown: string): OkfConcept {
  if (typeof markdown !== "string") throw new Error("OKF concept must be Markdown text");
  const { yaml, body } = frontmatterBlock(markdown);
  const frontmatter = parseMapping(yaml);
  validateFrontmatter(frontmatter);
  return { frontmatter, body };
}

export function serializeOkfConcept(frontmatter: Record<string, unknown>, body: string): string {
  if (!isRecord(frontmatter)) throw new Error("OKF frontmatter must be a YAML mapping");
  if (typeof body !== "string") throw new Error("OKF concept body must be a string");
  validateFrontmatter(frontmatter);
  const yaml = stringify(frontmatter);
  const yamlBlock = yaml.endsWith("\n") ? yaml : `${yaml}\n`;
  return `---\n${yamlBlock}---\n${body.endsWith("\n") ? body : `${body}\n`}`;
}

export function validateOkfConcept(markdown: string): void {
  parseOkfConcept(markdown);
}

function normalizePiScholar(value: unknown): OkfPiScholarIdentity | undefined {
  if (!isRecord(value) || value.managed_by !== "pi-scholar") return undefined;
  if (
    typeof value.source_id !== "string" ||
    typeof value.chunk_id !== "string" ||
    typeof value.ordinal !== "number" ||
    !Number.isInteger(value.ordinal) ||
    value.ordinal < 0
  )
    throw new Error("malformed pi_scholar source identity");
  return {
    managedBy: "pi-scholar",
    sourceId: value.source_id,
    chunkId: value.chunk_id,
    ordinal: value.ordinal,
    ...(typeof value.source_digest === "string" ? { sourceDigest: value.source_digest } : {}),
    ...(typeof value.chunk_digest === "string" ? { chunkDigest: value.chunk_digest } : {}),
  };
}

export function okfSourceReferences(markdown: string): OkfSourceReference[] {
  const { frontmatter } = parseOkfConcept(markdown);
  if (frontmatter.sources === undefined) return [];
  if (!Array.isArray(frontmatter.sources)) throw new Error("OKF sources must be a YAML sequence");
  return frontmatter.sources.map((source) => {
    if (!isRecord(source) || typeof source.resource !== "string" || !source.resource.trim())
      throw new Error("OKF source entries require a non-empty resource");
    const piScholar = normalizePiScholar(source.pi_scholar);
    const metadata = { ...source };
    delete metadata.id;
    delete metadata.resource;
    delete metadata.title;
    if (piScholar) delete metadata.pi_scholar;
    return {
      ...(typeof source.id === "string" ? { id: source.id } : {}),
      resource: source.resource,
      ...(typeof source.title === "string" ? { title: source.title } : {}),
      ...(piScholar ? { piScholar } : {}),
      metadata,
    };
  });
}

function markdownLabel(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll("\\", "\\\\")
    .replaceAll(">", "&gt;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replace(/[\r\n]+/gu, " ");
}

function markdownUrl(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/gu,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function projectionDescription(page: OkfProjectionPage): string {
  return markdownLabel(page.description?.replace(/\s+/gu, " ").trim() || page.title);
}
function renderIndexBody(pages: readonly OkfProjectionPage[]): string {
  const lines = ["# Wiki index", ""];
  for (const page of pages)
    lines.push(`* [${markdownLabel(page.title)}](${markdownUrl(page.path)}) - ${projectionDescription(page)}`);
  lines.push("");
  return lines.join("\n");
}

export function renderOkfIndex(pages: readonly OkfProjectionPage[], root = true): string {
  const body = renderIndexBody(pages);
  return root ? `---\nokf_version: "0.2"\n---\n${body}` : body;
}

export function okfDate(value: string | undefined): string {
  if (!value) return "1970-01-01";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`invalid OKF projection timestamp: ${value}`);
  return date.toISOString().slice(0, 10);
}

export function renderOkfLog(pages: readonly OkfProjectionPage[]): string {
  const groups = new Map<string, OkfProjectionPage[]>();
  for (const page of pages) {
    const date = okfDate(page.updatedAt);
    const group = groups.get(date) ?? [];
    group.push(page);
    groups.set(date, group);
  }
  const lines = ["# Directory Update Log", ""];
  for (const date of [...groups.keys()].sort((left, right) => right.localeCompare(left))) {
    lines.push(`## ${date}`);
    for (const page of groups.get(date)!.sort((left, right) => left.path.localeCompare(right.path)))
      lines.push(
        `* **Update**: [${markdownLabel(page.title)}](${markdownUrl(page.path)}) - ${projectionDescription(page)}`,
      );
    lines.push("");
  }
  return lines.join("\n");
}

function projectionBody(markdown: string, root: boolean): string {
  if (!root) {
    if (/^---[ \t]*\r?\n/u.test(markdown)) throw new Error("nested OKF index must not have frontmatter");
    return markdown;
  }
  const { yaml, body } = frontmatterBlock(markdown);
  const frontmatter = parseMapping(yaml);
  if (Object.keys(frontmatter).length !== 1 || frontmatter.okf_version !== "0.2")
    throw new Error('root OKF index requires exact okf_version: "0.2" frontmatter');
  return body;
}

export function validateOkfIndex(markdown: string, root = true): void {
  const body = projectionBody(markdown, root);
  let headings = 0;
  for (const line of body.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (/^#{1,6}\s+\S/u.test(line)) {
      headings += 1;
      continue;
    }
    if (/^\* \[[^\]]+\]\([^\s)]+\)(?: - \S.*)?$/u.test(line)) continue;
    throw new Error(`invalid OKF index line: ${line}`);
  }
  if (!headings) throw new Error("OKF index requires at least one section heading");
}

export function validateOkfLog(markdown: string): void {
  if (/^---[ \t]*\r?\n/u.test(markdown)) throw new Error("OKF log must not have frontmatter");
  const lines = markdown.split(/\r?\n/u);
  let h1 = 0;
  let lastDate: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^#\s+\S/u.test(line)) {
      if (lastDate) throw new Error("OKF log H1 must precede date groups");
      h1++;
      continue;
    }
    const date = /^##\s+(\d{4}-\d{2}-\d{2})$/u.exec(line)?.[1];
    if (date) {
      if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
        throw new Error(`invalid OKF log date: ${date}`);
      if (lastDate !== undefined && date > lastDate) throw new Error("OKF log dates must be newest first");
      lastDate = date;
      continue;
    }
    if (/^#{1,6}\s/u.test(line)) throw new Error(`invalid OKF log heading: ${line}`);
    if (/^\*\s+\S.*$/u.test(line) && lastDate) continue;
    throw new Error(`invalid OKF log line: ${line}`);
  }
  if (h1 > 1) throw new Error("OKF log permits at most one H1 heading");
}
