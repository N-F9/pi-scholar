import { createHash } from "node:crypto";
import type { WikiPageSection } from "./contracts.js";
import { okfRenderedText, parseOkfConcept } from "./okf.js";

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

function parseBodySections(markdown: string, pageId: string, baseOffset: number): WikiPageSection[] {
  const output: WikiPageSection[] = [];
  const used = new Set<string>();
  let fence: { readonly marker: string; readonly length: number } | undefined;
  let offset = 0;
  while (offset <= markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const end = newline < 0 ? markdown.length : newline + 1;
    const rawLine = markdown.slice(offset, end);
    const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})/.exec(content);
    if (fenceMatch) {
      const marker = fenceMatch[2]![0]!;
      const length = fenceMatch[2]!.length;
      if (!fence) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length) fence = undefined;
    } else if (!fence) {
      const headingMatch = /^( {0,3})#{1,6}(?:[ \t]+|$)(.*)$/.exec(content);
      if (headingMatch) {
        const heading = headingMatch[2]!.replace(/[ \t]+#+[ \t]*$/u, "").trim();
        const anchor = headingAnchor(heading, used);
        if (heading && anchor) {
          const previous = output.at(-1);
          if (previous) {
            const sectionText = markdown.slice(previous.startOffset - baseOffset, offset);
            output[output.length - 1] = {
              ...previous,
              endOffset: baseOffset + offset,
              textDigest: createHash("sha256").update(sectionText).digest("hex"),
            };
          } else if (okfRenderedText(markdown.slice(0, offset)).trim()) {
            output.push(section(pageId, "", baseOffset, baseOffset + offset, markdown.slice(0, offset)));
          }
          output.push(
            section(pageId, anchor, baseOffset + offset, baseOffset + markdown.length, markdown.slice(offset), heading),
          );
        }
      }
    }
    offset = end;
    if (newline < 0) break;
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
