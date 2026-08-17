import type { Mermaid } from "mermaid";
import { type ComponentPropsWithoutRef, isValidElement, type ReactNode, useEffect, useId, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { headingAnchor, imagePlaceholder, parseManagedImageUri } from "../../../../src/markdown";

export { headingAnchor };

const INLINE_BLOCK_ELEMENTS = [
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown; pageId?: string };

function MarkdownImage({ alt, src, node: _node, pageId, ...props }: MarkdownImageProps) {
  const [failedSource, setFailedSource] = useState<string>();
  const managed = typeof src === "string" ? parseManagedImageUri(src) : undefined;
  if (!managed || !pageId) return <span className="text-sm italic text-muted">{imagePlaceholder(alt)}</span>;
  const attachment = `/api/v1/wiki/pages/${encodeURIComponent(pageId)}/attachments/${encodeURIComponent(managed.sourceId)}/${managed.digest}`;
  if (failedSource === attachment) return <span className="text-sm italic text-muted">{imagePlaceholder(alt)}</span>;
  return <img {...props} alt={alt ?? ""} loading="lazy" onError={() => setFailedSource(attachment)} src={attachment} />;
}

function textFrom(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textFrom).join("");
  if (isValidElement<MarkdownImageProps & { children?: ReactNode }>(children)) {
    if (children.type === MarkdownImage || ("alt" in children.props && "src" in children.props))
      return imagePlaceholder(children.props.alt);
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

let mermaidPromise: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        suppressErrorRendering: true,
        secure: [
          "secure",
          "securityLevel",
          "startOnLoad",
          "maxTextSize",
          "suppressErrorRendering",
          "maxEdges",
          "htmlLabels",
        ],
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

function MermaidDiagram({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/[^A-Za-z0-9_-]/gu, "")}`;
  const [result, setResult] = useState<{ source: string; svg?: string; failed?: boolean }>();

  useEffect(() => {
    let cancelled = false;
    void loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
      .then(({ svg }) => {
        if (!cancelled) setResult({ source, svg });
      })
      .catch(() => {
        if (!cancelled) setResult({ source, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  if (result?.source !== source) {
    return (
      <div aria-busy="true" className="mermaid-diagram">
        Rendering diagram…
      </div>
    );
  }
  if (result.failed) {
    return (
      <div className="code-block">
        <div className="code-toolbar">
          <span>mermaid</span>
          <span role="alert">Diagram unavailable</span>
        </div>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </div>
    );
  }
  // biome-ignore lint/security/noDangerouslySetInnerHtml: strict Mermaid output is DOMPurify-sanitized SVG.
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: result.svg ?? "" }} />;
}

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & { node?: unknown };

type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & { node?: unknown };

function CodeBlock({ children, node: _node, ...props }: MarkdownPreProps) {
  const [copied, setCopied] = useState(false);
  const code = isValidElement<MarkdownCodeProps>(children) ? children : undefined;
  const language = code?.props.className?.match(/(?:^|\s)language-([^\s]+)/u)?.[1] ?? "text";
  if (language === "mermaid") return <MermaidDiagram source={textFrom(code?.props.children ?? children)} />;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textFrom(code?.props.children ?? children));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <button aria-label={`Copy ${language} code`} aria-live="polite" onClick={copy} type="button">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

export function Markdown({
  source,
  pagePath = "",
  pageId,
  headings = [],
  inline = false,
}: {
  source: string;
  pagePath?: string;
  pageId?: string;
  inline?: boolean;
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

  const Wrapper = inline ? "span" : "div";
  return (
    <Wrapper className={inline ? "markdown markdown-inline" : "markdown"}>
      <ReactMarkdown
        disallowedElements={inline ? INLINE_BLOCK_ELEMENTS : undefined}
        unwrapDisallowed={inline}
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, trust: false }],
          [rehypeHighlight, { plainText: ["mermaid"] }],
        ]}
        urlTransform={(url, key, node) =>
          key === "src" && node.tagName === "img" && parseManagedImageUri(url) ? url : defaultUrlTransform(url)
        }
        skipHtml
        components={{
          a: ({ href, children, node: _node, ...props }) => {
            const safe = safeHref(href, pagePath);
            if (inline || !safe) return <span>{children}</span>;
            return (
              <a href={safe} rel={safe.startsWith("http") ? "noreferrer" : undefined} {...props}>
                {children}
              </a>
            );
          },
          img: (props) => <MarkdownImage {...props} pageId={pageId} />,
          pre: CodeBlock,
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
    </Wrapper>
  );
}
