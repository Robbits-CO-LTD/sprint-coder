import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders preserved assistant-message boundaries as separate paragraphs', () => {
    const html = renderToStaticMarkup(
      <Markdown content={'調査を開始します。\n\n原因を確認しました。\n\n修正完了です。'} />,
    );

    expect(html.match(/<p>/g)).toHaveLength(3);
    expect(html).toContain('<p>調査を開始します。</p>\n<p>原因を確認しました。</p>');
  });

  it('renders GFM structure used by Leader and Chat assistant messages', () => {
    const html = renderToStaticMarkup(
      <Markdown
        content={[
          '# 調査結果',
          '',
          '- **重要:** 対応が必要',
          '',
          '| 項目 | 状態 |',
          '| --- | --- |',
          '| API | 完了 |',
          '',
          '```ts',
          'const ready = true;',
          '```',
        ].join('\n')}
      />,
    );

    expect(html).toContain('<h1>調査結果</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<strong>重要:</strong>');
    expect(html).toContain('class="md-table-wrap"');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre>');
    expect(html).toContain('const ready = true;');
  });

  it('keeps Mermaid source as copyable code while the response is streaming', () => {
    const html = renderToStaticMarkup(
      <Markdown content={'```mermaid\ngraph TD\nA-->B\n```'} isStreaming />,
    );

    expect(html).toContain('language-mermaid');
    expect(html).toContain('graph TD');
    expect(html).not.toContain('md-mermaid');
  });

  it('falls back to code without trying to render oversized Mermaid input', () => {
    const source = `graph TD\n${'A-->B\n'.repeat(301)}`;
    const html = renderToStaticMarkup(<Markdown content={`\`\`\`mermaid\n${source}\`\`\``} />);

    expect(html).toContain('language-mermaid');
    expect(html).not.toContain('md-mermaid');
  });
});

describe('Markdown graph anchor', () => {
  const reference = {
    graphId: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    renderRevision: 3,
    title: '注文フロー',
    kind: 'workflow',
    nodeCount: 3,
    edgeCount: 2,
  };

  it('renders the anchor Main appends at a graph render as an inline card, streaming or not', () => {
    const content = `調査しました。\n\n\`\`\`sprint-graph\n${JSON.stringify(reference)}\n\`\`\`\n\n次の段階へ進みます。`;
    for (const isStreaming of [false, true]) {
      const html = renderToStaticMarkup(<Markdown content={content} isStreaming={isStreaming} />);
      expect(html).toContain('data-testid="inline-graph-card"');
      expect(html).toContain('注文フロー');
      expect(html).toContain('作業フロー · 版 2 · ノード 3 · 接続 2');
      expect(html).toContain('data-testid="inline-graph-open"');
      expect(html).not.toContain('<pre>');
      expect(html).toContain('<p>調査しました。</p>');
      expect(html).toContain('<p>次の段階へ進みます。</p>');
    }
  });

  it('keeps a look-alike fence that is not a reference as ordinary code', () => {
    const html = renderToStaticMarkup(
      <Markdown content={'```sprint-graph\n{"graphId":"x"}\n```'} />,
    );
    expect(html).not.toContain('inline-graph-card');
    expect(html).toContain('<pre>');
    expect(html).toContain('&quot;graphId&quot;');
  });
});
