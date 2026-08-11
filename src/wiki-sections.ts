import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { WikiPageSection } from "./contracts.js";
import { okfRenderedText, parseOkfConcept } from "./okf.js";

type MarkdownNode = {
  readonly type: string;
  readonly children?: readonly MarkdownNode[];
  readonly position?: {
    readonly start?: { readonly offset?: number };
    readonly end?: { readonly offset?: number };
  };
};

function headingAnchor(heading: string, used: Set<string>): string {
  const slug = heading
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/gu, "-");
  if (!slug) return "";
  let candidate = slug;
  for (let suffix = 1; used.has(candidate); suffix += 1) candidate = `${slug}-${suffix}`;
  used.add(candidate);
  return `#${candidate}`;
}

function section(
  pageId: string,
  anchor: string,
  startOffset: number,
  endOffset: number,
  text: string,
  heading?: string,
): WikiPageSection {
  return {
    pageId,
    ...(heading === undefined ? {} : { heading }),
    anchor,
    startOffset,
    endOffset,
    textDigest: createHash("sha256").update(text).digest("hex"),
  };
}
type SectionHeading = { readonly startOffset: number; readonly heading: string };

function parseHeadings(markdown: string): SectionHeading[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MarkdownNode;
  const headings: SectionHeading[] = [];
  for (const node of tree.children ?? []) {
    if (node.type !== "heading") continue;
    const startOffset = node.position?.start?.offset;
    const endOffset = node.position?.end?.offset;
    if (startOffset === undefined || endOffset === undefined) continue;
    const source = markdown.slice(startOffset, endOffset).replace(/(?:\r?\n)+$/u, "");
    const lines = source.split("\n");
    const underline = lines.at(-1)?.replace(/\r$/u, "") ?? "";
    let heading: string | undefined;
    if (lines.length > 1 && /^( {0,3})(?:=+|-+)[ \t]*$/u.test(underline)) {
      heading = lines.slice(0, -1).join("\n").trim();
    } else {
      const line = lines[0]?.replace(/\r$/u, "") ?? "";
      const match = /^( {0,3})#{1,6}(?:[ \t]+|$)(.*)$/.exec(line);
      if (match) heading = match[2]!.replace(/[ \t]+#+[ \t]*$/u, "").trim();
    }
    if (heading) headings.push({ startOffset, heading });
  }
  return headings;
}

function parseBodySections(markdown: string, pageId: string, baseOffset: number): WikiPageSection[] {
  const output: WikiPageSection[] = [];
  const used = new Set<string>();
  for (const { startOffset, heading } of parseHeadings(markdown)) {
    const anchor = headingAnchor(heading, used);
    if (!anchor) continue;
    const previous = output.at(-1);
    if (previous) {
      const sectionText = markdown.slice(previous.startOffset - baseOffset, startOffset);
      output[output.length - 1] = {
        ...previous,
        endOffset: baseOffset + startOffset,
        textDigest: createHash("sha256").update(sectionText).digest("hex"),
      };
    } else if (okfRenderedText(markdown.slice(0, startOffset)).trim()) {
      output.push(section(pageId, "", baseOffset, baseOffset + startOffset, markdown.slice(0, startOffset)));
    }
    output.push(
      section(
        pageId,
        anchor,
        baseOffset + startOffset,
        baseOffset + markdown.length,
        markdown.slice(startOffset),
        heading,
      ),
    );
  }
  if (output.length) {
    const last = output.at(-1)!;
    const sectionText = markdown.slice(last.startOffset - baseOffset);
    output[output.length - 1] = {
      ...last,
      endOffset: baseOffset + markdown.length,
      textDigest: createHash("sha256").update(sectionText).digest("hex"),
    };
  } else if (okfRenderedText(markdown).trim()) {
    output.push(section(pageId, "", baseOffset, baseOffset + markdown.length, markdown));
  }
  return output;
}

/** Parse Markdown body text whose offsets are relative to the supplied string. */
export function parseWikiBodySections(markdown: string, pageId: string): WikiPageSection[] {
  return parseBodySections(markdown, pageId, 0);
}

/** Parse a complete OKF document while keeping section offsets in that document. */
export function parseWikiDocumentSections(markdown: string, pageId: string): WikiPageSection[] {
  const { body } = parseOkfConcept(markdown);
  return parseBodySections(body, pageId, markdown.length - body.length);
}
