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
