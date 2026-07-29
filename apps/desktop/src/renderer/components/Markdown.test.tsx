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
});
