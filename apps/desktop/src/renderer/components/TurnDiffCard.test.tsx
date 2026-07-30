import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PREVIEW_COUNT, TurnDiffCard, formatWorkDuration } from './TurnDiffCard';
import type { TurnDiff, TurnDiffEntry } from '../types/sprint-coder';

// The renderer suite runs on react-dom/server and has no jsdom, so what is covered here is the
// card's first paint plus the two pure rules behind its one truth-sensitive line, the duration.
// Expanding is a `useState` toggle; its label and aria wiring are asserted in the collapsed markup,
// which is the state a reader actually arrives at.

function entry(overrides: Partial<TurnDiffEntry> = {}): TurnDiffEntry {
  return {
    ordinal: 1,
    kind: 'update',
    path: 'src/app.ts',
    destination: null,
    preHash: null,
    postHash: null,
    provenance: 'agent_edit',
    status: 'applied',
    actualHash: null,
    ...overrides,
  };
}

function diffOf(entries: TurnDiffEntry[]): TurnDiff {
  return { turnId: 'turn-1', entries };
}

function manyEntries(count: number): TurnDiffEntry[] {
  return Array.from({ length: count }, (_, i) => entry({ ordinal: i + 1, path: `src/f${i}.ts` }));
}

describe('formatWorkDuration', () => {
  it('reads as a finished duration, not as a clock', () => {
    expect([0, 12_400, 60_000, 65_000, 3_600_000, 7_380_000].map(formatWorkDuration)).toEqual([
      '0秒',
      '12秒',
      '1分',
      '1分5秒',
      '1時間',
      '2時間3分',
    ]);
  });

  it('has nothing to say about a duration that was never measured', () => {
    for (const value of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatWorkDuration(value)).toBeNull();
    }
  });
});

describe('<TurnDiffCard />', () => {
  it('counts the files, states the passed duration, and shows only supplied line evidence', () => {
    const html = renderToStaticMarkup(
      <TurnDiffCard
        diff={diffOf(manyEntries(5))}
        elapsedMs={12_000}
        lineStats={{ added: 14, deleted: 3, incomplete: false }}
      />,
    );
    expect(html).toContain('5件のファイルを編集');
    expect(html).toContain('12秒作業しました');
    expect(html).toContain('+14');
    expect(html).toContain('-3');
    expect(html).not.toContain('元に戻す');
  });

  it('labels partial line counts and renders a Team breakdown', () => {
    const html = renderToStaticMarkup(
      <TurnDiffCard
        diff={diffOf(manyEntries(1))}
        lineStats={{ added: 2, deleted: 0, incomplete: true }}
        workerBreakdown={[{ role: '実装担当', status: '完了' }]}
      />,
    );
    expect(html).toContain('一部不明');
    expect(html).toContain('Team内訳');
    expect(html).toContain('実装担当');
  });

  it('drops the duration instead of inventing one when none was measured', () => {
    const html = renderToStaticMarkup(<TurnDiffCard diff={diffOf(manyEntries(2))} />);
    expect(html).toContain('作業しました');
    expect(html).not.toMatch(/[0-9]+(秒|分|時間)/);
  });

  it('shows the first three rows and offers the rest behind one labelled control', () => {
    const html = renderToStaticMarkup(<TurnDiffCard diff={diffOf(manyEntries(5))} />);
    expect(html).toContain('src/f0.ts');
    expect(html).toContain(`src/f${PREVIEW_COUNT - 1}.ts`);
    expect(html).not.toContain(`src/f${PREVIEW_COUNT}.ts`);
    expect(html).toContain('あと2件のファイルを表示');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('レビューする');
  });

  it('offers no expand control when every row is already on screen', () => {
    const html = renderToStaticMarkup(<TurnDiffCard diff={diffOf(manyEntries(PREVIEW_COUNT))} />);
    expect(html).not.toContain('data-testid="turn-diff-toggle"');
    expect(html).not.toContain('を表示');
  });

  it('names a rename by both paths, each isolated from the bidi algorithm', () => {
    const html = renderToStaticMarkup(
      <TurnDiffCard
        diff={diffOf([entry({ kind: 'rename', path: 'src/a.ts', destination: 'src/b.ts' })])}
      />,
    );
    expect(html).toContain('名前変更');
    expect(html).toContain('<bdi class="turn-diff-path" dir="ltr" title="src/a.ts">src/a.ts</bdi>');
    expect(html).toContain('title="src/b.ts"');
  });

  it('warns about external drift on the card, not only on a row still collapsed away', () => {
    const entries = manyEntries(5);
    entries[4] = entry({ ordinal: 5, path: 'src/f4.ts', status: 'external_drift' });
    const html = renderToStaticMarkup(<TurnDiffCard diff={diffOf(entries)} />);
    expect(html).toContain('1件のファイルがこのターンの記録と一致しません');
  });

  it('renders nothing at all for a Turn that wrote no files', () => {
    expect(renderToStaticMarkup(<TurnDiffCard diff={diffOf([])} />)).toBe('');
  });
});
