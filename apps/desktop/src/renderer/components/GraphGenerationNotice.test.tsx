// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GraphGenerationNotice } from './GraphGenerationNotice';
import { beginGraphGeneration, finishGraphGeneration } from '../../main/graph-generation';

describe('graph generation notice', () => {
  it('distinguishes a failed new proposal without reporting the old diagram as the new result', () => {
    const failed = finishGraphGeneration(
      beginGraphGeneration('task-a', '<script>bad</script>', 1, null),
      'failed',
      'check',
    );
    const html = renderToStaticMarkup(
      createElement(GraphGenerationNotice, {
        generation: failed,
        view: null,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain('新しい図を作成できませんでした');
    expect(html).toContain('検証を通りませんでした');
    expect(html).not.toContain('<script>');
    expect(html).toContain('role="alert"');
  });
});
