import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const MANAGED_IMAGE_URI =
  /^pi-scholar:\/\/source\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/attachment\/([0-9a-f]{64})$/u;

type MarkdownNode = {
  readonly type: string;
  readonly url?: unknown;
  readonly alt?: unknown;
  readonly identifier?: unknown;
  readonly children?: readonly MarkdownNode[];
};

export interface ManagedImageUri {
  readonly sourceId: string;
  readonly digest: string;
}

export interface MarkdownImage {
  readonly url: string;
  readonly alt?: string;
}

export function managedImageUri(sourceId: string, digest: string): string {
  const uri = `pi-scholar://source/${sourceId}/attachment/${digest}`;
  if (!MANAGED_IMAGE_URI.test(uri)) throw new Error("managed image identity is malformed");
  return uri;
}

export function parseManagedImageUri(value: string): ManagedImageUri | undefined {
  const match = MANAGED_IMAGE_URI.exec(value);
  return match ? { sourceId: match[1]!, digest: match[2]! } : undefined;
}

export function markdownImages(markdown: string): readonly MarkdownImage[] {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MarkdownNode;
  const definitions = new Map<string, string>();
  const visit = (node: MarkdownNode, action: (candidate: MarkdownNode) => void): void => {
    action(node);
    for (const child of node.children ?? []) visit(child, action);
  };
  visit(root, (node) => {
    if (node.type !== "definition" || typeof node.identifier !== "string" || typeof node.url !== "string") return;
    const identifier = node.identifier.toLowerCase();
    if (!definitions.has(identifier)) definitions.set(identifier, node.url);
  });
  const images: MarkdownImage[] = [];
  visit(root, (node) => {
    const url =
      node.type === "image" && typeof node.url === "string"
        ? node.url
        : node.type === "imageReference" && typeof node.identifier === "string"
          ? (definitions.get(node.identifier.toLowerCase()) ?? "")
          : undefined;
    if (url !== undefined)
      images.push({
        url,
        ...(typeof node.alt === "string" ? { alt: node.alt } : {}),
      });
  });
  return images;
}

export function headingAnchor(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/gu, "-");
}

export function imagePlaceholder(alt: string | undefined): string {
  return `[Image: ${alt || "illustration"}]`;
}
