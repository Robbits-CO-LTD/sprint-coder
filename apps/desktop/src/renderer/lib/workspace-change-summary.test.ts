import { describe, expect, it } from 'vitest';
import { changedLineStats, summarizeRuntimeChanges } from './workspace-change-summary';

describe('changedLineStats', () => {
  it('counts net line additions and deletions against the Turn baseline', () => {
    expect(changedLineStats('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, deleted: 1 });
  });
});

describe('summarizeRuntimeChanges', () => {
  const rooted = { rootId: 'root-a', rootLabel: 'test1' } as const;

  it('deduplicates Runtime reports and uses only matching completed Turn frames', () => {
    const summary = summarizeRuntimeChanges(
      'turn-1',
      [
        { changes: [{ ...rooted, path: 'src/a.ts', kind: 'update' }] },
        {
          changes: [
            { ...rooted, path: 'src/a.ts', kind: 'update' },
            { ...rooted, path: 'src/new.ts', kind: 'add' },
          ],
        },
      ],
      [
        {
          turnId: 'turn-1',
          ...rooted,
          path: 'src/a.ts',
          text: 'before\nafter\n',
          baseline: 'before\n',
          complete: true,
          source: 'disk',
          changed: new Set(),
          order: 1,
        },
        {
          turnId: 'turn-1',
          ...rooted,
          path: 'src/new.ts',
          text: 'one\ntwo\n',
          baseline: null,
          complete: true,
          source: 'disk',
          changed: new Set(),
          order: 2,
        },
      ],
    );

    expect(summary?.diff.entries.map(({ path }) => path)).toEqual([
      'test1 › src/a.ts',
      'test1 › src/new.ts',
    ]);
    expect(summary?.lineStats).toEqual({ added: 3, deleted: 0, incomplete: false });
  });

  it('marks counts incomplete instead of attributing a missing baseline to the model', () => {
    const summary = summarizeRuntimeChanges(
      'turn-1',
      [{ changes: [{ ...rooted, path: 'dirty.ts', kind: 'update' }] }],
      [],
    );
    expect(summary?.lineStats).toEqual({ added: 0, deleted: 0, incomplete: true });
  });

  it('keeps identical relative paths from different roots as separate entries', () => {
    const summary = summarizeRuntimeChanges(
      'turn-1',
      [
        {
          changes: [
            { rootId: 'root-a', rootLabel: 'test1', path: 'src/index.ts', kind: 'update' },
            { rootId: 'root-b', rootLabel: 'test2', path: 'src/index.ts', kind: 'update' },
          ],
        },
      ],
      [],
    );

    expect(summary?.diff.entries.map(({ path }) => path)).toEqual([
      'test1 › src/index.ts',
      'test2 › src/index.ts',
    ]);
  });
});
