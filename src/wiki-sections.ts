import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { WikiPageSection } from "./contracts.js";
import { imagePlaceholder, headingAnchor as normalizeHeadingAnchor } from "./markdown.js";
import { okfRenderedText, parseOkfConcept } from "./okf.js";

type MarkdownNode = {
  readonly type: string;
  readonly value?: string;
  readonly alt?: string;
  readonly children?: readonly MarkdownNode[];
  readonly position?: {
    readonly start?: { readonly offset?: number };
    readonly end?: { readonly offset?: number };
  };
};

function parseMarkdown(markdown: string): MarkdownNode {
  return fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MarkdownNode;
}

function renderedHeading(heading: MarkdownNode): string {
  const text: string[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "text" || node.type === "inlineCode") {
      if (node.value) text.push(node.value);
      return;
    }
    if (node.type === "image" || node.type === "imageReference") {
      text.push(imagePlaceholder(node.alt));
      return;
    }
    if (node.type === "break") {
      text.push("\n");
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of heading.children ?? []) visit(child);
  return text.join("");
}

export function hasRenderedEmptyHeading(markdown: string): boolean {
  return (parseMarkdown(markdown).children ?? []).some(
    (node) => node.type === "heading" && !renderedHeading(node).trim(),
  );
}

function headingAnchor(heading: string, used: Set<string>): string {
  const slug = normalizeHeadingAnchor(heading);
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
  const tree = parseMarkdown(markdown);
  const headings: SectionHeading[] = [];
  for (const node of tree.children ?? []) {
    if (node.type !== "heading") continue;
    const sourceStartOffset = node.position?.start?.offset;
    const endOffset = node.position?.end?.offset;
    if (sourceStartOffset === undefined || endOffset === undefined) continue;
    const startOffset = markdown.lastIndexOf("\n", sourceStartOffset - 1) + 1;
    const heading = renderedHeading(node);
    if (heading) headings.push({ startOffset, heading });
  }
  return headings;
}
/** Remove the first root heading, including its complete source syntax. */
export function stripFirstHeading(markdown: string): string {
  const first = parseMarkdown(markdown).children?.[0];
  const endOffset = first?.type === "heading" ? first.position?.end?.offset : undefined;
  return endOffset === undefined ? markdown : markdown.slice(endOffset);
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
