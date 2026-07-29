import { describe, expect, it } from 'vitest';
import { changedLineStats, summarizeRuntimeChanges } from './workspace-change-summary';

describe('changedLineStats', () => {
  it('counts net line additions and deletions against the Turn baseline', () => {
    expect(changedLineStats('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, deleted: 1 });
  });
});

describe('summarizeRuntimeChanges', () => {
  it('deduplicates Runtime reports and uses only matching completed Turn frames', () => {
    const summary = summarizeRuntimeChanges(
      'turn-1',
      [
        { changes: [{ path: 'src/a.ts', kind: 'update' }] },
        {
          changes: [
            { path: 'src/a.ts', kind: 'update' },
            { path: 'src/new.ts', kind: 'add' },
          ],
        },
      ],
      [
        {
          turnId: 'turn-1',
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

    expect(summary?.diff.entries.map(({ path }) => path)).toEqual(['src/a.ts', 'src/new.ts']);
    expect(summary?.lineStats).toEqual({ added: 3, deleted: 0, incomplete: false });
  });

  it('marks counts incomplete instead of attributing a missing baseline to the model', () => {
    const summary = summarizeRuntimeChanges(
      'turn-1',
      [{ changes: [{ path: 'dirty.ts', kind: 'update' }] }],
      [],
    );
    expect(summary?.lineStats).toEqual({ added: 0, deleted: 0, incomplete: true });
  });
});
