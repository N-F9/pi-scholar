import { createHash } from "node:crypto";
import type { WikiPageSection } from "./contracts.js";

function headingAnchor(heading: string, used: Map<string, number>): string {
  const slug = heading
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/gu, "-");
  if (!slug) return "";
  const suffix = used.get(slug) ?? 0;
  used.set(slug, suffix + 1);
  return `#${slug}${suffix ? `-${suffix}` : ""}`;
}

export function parseWikiSections(markdown: string, pageId: string): WikiPageSection[] {
  const output: WikiPageSection[] = [];
  const used = new Map<string, number>();
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
            const sectionText = markdown.slice(previous.startOffset, offset);
            output[output.length - 1] = {
              ...previous,
              endOffset: offset,
              textDigest: createHash("sha256").update(sectionText).digest("hex"),
            };
          }
          output.push({ pageId, heading, anchor, startOffset: offset, endOffset: markdown.length, textDigest: "" });
        }
      }
    }
    offset = end;
    if (newline < 0) break;
  }
  if (output.length) {
    const last = output.at(-1)!;
    const sectionText = markdown.slice(last.startOffset);
    output[output.length - 1] = {
      ...last,
      endOffset: markdown.length,
      textDigest: createHash("sha256").update(sectionText).digest("hex"),
    };
  }
  return output;
}
