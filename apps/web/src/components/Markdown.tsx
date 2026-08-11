import { type ComponentPropsWithoutRef, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { headingAnchor, imagePlaceholder } from "../../../../src/markdown";

export { headingAnchor };

type MarkdownImageProps = { alt?: string; node?: unknown };

function MarkdownImage({ alt }: MarkdownImageProps) {
  return <span className="text-sm italic text-muted">{imagePlaceholder(alt)}</span>;
}

function textFrom(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textFrom).join("");
  if (isValidElement<MarkdownImageProps & { children?: ReactNode }>(children)) {
    if (children.type === MarkdownImage) return imagePlaceholder(children.props.alt);
    return textFrom(children.props.children);
  }
  return "";
}

function safeHref(href: string | undefined, pagePath: string): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("#")) return href;
  try {
    const url = new URL(href, `https://vault.invalid/${pagePath}`);
    if (url.origin === "https://vault.invalid") {
      if (!url.pathname.endsWith(".md")) return undefined;
      const path = decodeURIComponent(url.pathname).replace(/^\//, "");
      const heading = url.hash ? decodeURIComponent(url.hash.slice(1)) : "";
      return `/notes?path=${encodeURIComponent(path)}${heading ? `&heading=${encodeURIComponent(heading)}` : ""}`;
    }
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & { node?: unknown };

function InertCode({ className, children, node: _node, ...props }: MarkdownCodeProps) {
  const mermaid = className?.split(" ").includes("language-mermaid");
  return (
    <code
      className={mermaid ? `${className} mermaid-source` : className}
      data-diagram={mermaid ? "inert" : undefined}
      {...props}
    >
      {children}
    </code>
  );
}

export function Markdown({
  source,
  pagePath = "",
  headings = [],
}: {
  source: string;
  pagePath?: string;
  headings?: readonly { readonly heading?: string; readonly anchor: string }[];
}) {
  const canonical = new Map<string, string[]>();
  for (const section of headings) {
    if (!section.heading) continue;
    const anchors = canonical.get(section.heading) ?? [];
    anchors.push(section.anchor.replace(/^#/, ""));
    canonical.set(section.heading, anchors);
  }
  const seen = new Map<string, number>();
  const idFor = (children: ReactNode) => {
    const text = textFrom(children);
    const index = seen.get(text) ?? 0;
    seen.set(text, index + 1);
    return canonical.get(text)?.[index] ?? `${headingAnchor(text)}${index ? `-${index + 1}` : ""}`;
  };

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children, node: _node, ...props }) => {
            const safe = safeHref(href, pagePath);
            return safe ? (
              <a href={safe} rel={safe.startsWith("http") ? "noreferrer" : undefined} {...props}>
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          code: InertCode,
          img: MarkdownImage,
          h1: ({ children, node: _node, ...props }) => (
            <h1 id={idFor(children)} {...props}>
              {children}
            </h1>
          ),
          h2: ({ children, node: _node, ...props }) => (
            <h2 id={idFor(children)} {...props}>
              {children}
            </h2>
          ),
          h3: ({ children, node: _node, ...props }) => (
            <h3 id={idFor(children)} {...props}>
              {children}
            </h3>
          ),
          h4: ({ children, node: _node, ...props }) => (
            <h4 id={idFor(children)} {...props}>
              {children}
            </h4>
          ),
          h5: ({ children, node: _node, ...props }) => (
            <h5 id={idFor(children)} {...props}>
              {children}
            </h5>
          ),
          h6: ({ children, node: _node, ...props }) => (
            <h6 id={idFor(children)} {...props}>
              {children}
            </h6>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
