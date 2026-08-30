import { describe, expect, it } from 'vitest';
import type { TurnDiff, TurnDiffEntry } from '../../types/sprint-coder';
import { mergeWorkspaceDiffs } from './Timeline';

function entry(path: string, overrides: Partial<TurnDiffEntry> = {}): TurnDiffEntry {
  return {
    ordinal: 1,
    kind: 'add',
    path,
    destination: null,
    preHash: null,
    postHash: null,
    provenance: 'agent_edit',
    status: 'applied',
    actualHash: null,
    ...overrides,
  };
}

function diff(...entries: TurnDiffEntry[]): TurnDiff {
  return { turnId: 'turn-1', entries };
}

describe('mergeWorkspaceDiffs', () => {
  it('deduplicates one Edit Saga absolute path against its unique rooted Runtime path', () => {
    const result = mergeWorkspaceDiffs(
      diff(entry('/private/tmp/project/smoke/codex.txt')),
      diff(entry('project › smoke/codex.txt')),
    );

    expect(result?.entries).toEqual([entry('project › smoke/codex.txt')]);
  });

  it('keeps an absolute entry when two Runtime roots share the same relative path', () => {
    const persisted = entry('/private/tmp/right/src/index.ts');
    const result = mergeWorkspaceDiffs(
      diff(persisted),
      diff(entry('left › src/index.ts'), entry('right › src/index.ts', { ordinal: 2 })),
    );

    expect(result?.entries.map(({ path }) => path)).toEqual([
      'left › src/index.ts',
      'right › src/index.ts',
      persisted.path,
    ]);
  });

  it('does not hide persisted external drift behind a Runtime applied row', () => {
    const result = mergeWorkspaceDiffs(
      diff(entry('/private/tmp/project/src/index.ts', { status: 'external_drift' })),
      diff(entry('project › src/index.ts')),
    );

    expect(result?.entries).toHaveLength(2);
  });
});
