// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown, sanitizeMermaidSvg } from './Markdown';

const renderMermaid = vi.fn(async () => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>safe diagram</text></svg>',
}));
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: renderMermaid,
  },
}));

describe('Mermaid SVG security boundary', () => {
  beforeEach(() => {
    renderMermaid.mockClear();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  it('removes executable, external-fetch, and event-bearing SVG content', () => {
    const sanitized = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <script>alert(1)</script>
        <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>
        <image href="https://attacker.invalid/pixel" />
        <a href="javascript:alert(1)" onclick="alert(1)"><text>link</text></a>
        <rect style="fill:url(https://attacker.invalid/a)" />
        <style>@import url(https://attacker.invalid/style)</style>
        <filter id="f"><feImage href="https://attacker.invalid/filter" /></filter>
        <rect filter="url(https://attacker.invalid/filter)" />
        <rect fill="url(https://attacker.invalid/fallback) red" />
        <set attributeName="href" to="https://attacker.invalid/later" />
        <animate attributeName="href" values="#safe;https://attacker.invalid/later" />
        <SCRIPT>alert(2)</SCRIPT>
        <use href="#safe-local-shape" />
      </svg>
    `);

    expect(sanitized).not.toMatch(
      /script|foreignObject|<image|<style|<filter|<set|<animate|attacker|javascript:|onclick/i,
    );
    expect(sanitized).toContain('href="#safe-local-shape"');
  });

  it('rejects malformed or non-SVG documents', () => {
    expect(() => sanitizeMermaidSvg('<div>not svg</div>')).toThrow('Invalid Mermaid SVG');
  });

  it('rejects resource-bearing Mermaid source before the renderer can fetch it', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <Markdown
          content={
            '```mermaid\nflowchart TD\nA@{ img: "https://attacker.invalid/pixel", label: "x" }\n```'
          }
        />,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));

    expect(renderMermaid).not.toHaveBeenCalled();
    expect(container.querySelector('code.language-mermaid')).not.toBeNull();
    expect(container.querySelector('.md-mermaid')).toBeNull();
    await act(async () => root.unmount());
  });

  it('renders a completed valid diagram inside the conversation', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<Markdown content={'```mermaid\ngraph TD\nA-->B\n```'} />);
    });
    await waitFor(async () => {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      return container.querySelector('.md-mermaid svg') !== null;
    });

    expect(container.querySelector('.md-mermaid')?.getAttribute('aria-label')).toBe('会話内の図');
    expect(container.querySelector('.md-mermaid script')).toBeNull();
    await act(async () => root.unmount());
  });

  it('falls back to code when one message exceeds the aggregate diagram budget', async () => {
    const content = Array.from(
      { length: 5 },
      (_, index) => `\`\`\`mermaid\ngraph TD\nA${index}-->B${index}\n\`\`\``,
    ).join('\n\n');
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Markdown content={content} />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(container.querySelectorAll('.md-mermaid').length).toBeLessThanOrEqual(4);
    expect(container.querySelectorAll('code.language-mermaid-fallback')).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('counts tilde-fenced Mermaid blocks against the aggregate budget', async () => {
    const content = Array.from(
      { length: 5 },
      (_, index) => `~~~mermaid\ngraph TD\nA${index}-->B${index}\n~~~`,
    ).join('\n\n');
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Markdown content={content} />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(container.querySelectorAll('.md-mermaid').length).toBeLessThanOrEqual(4);
    expect(container.querySelectorAll('code.language-mermaid-fallback')).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('counts indented fences with longer closers exactly as CommonMark parses them', async () => {
    const content = Array.from(
      { length: 5 },
      (_, index) => `  ~~~mermaid\ngraph TD\nA${index}-->B${index}\n   ~~~~`,
    ).join('\n\n');
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Markdown content={content} />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(container.querySelectorAll('.md-mermaid').length).toBeLessThanOrEqual(4);
    expect(container.querySelectorAll('code.language-mermaid-fallback')).toHaveLength(1);
    await act(async () => root.unmount());
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Mermaid render');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
