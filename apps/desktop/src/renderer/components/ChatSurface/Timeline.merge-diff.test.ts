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
  it('keeps an ambiguous legacy absolute path beside a rooted Runtime path', () => {
    const result = mergeWorkspaceDiffs(
      diff(entry('/a/project/smoke/codex.txt')),
      diff(entry('project › smoke/codex.txt')),
    );

    expect(result?.entries).toHaveLength(2);
  });

  it('deduplicates the exact canonical Main and Runtime display path', () => {
    const rooted = entry('project › smoke/codex.txt');
    expect(mergeWorkspaceDiffs(diff(rooted), diff(rooted))?.entries).toEqual([rooted]);
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

  it('keeps both persisted roots when only one Runtime row reports their shared relative path', () => {
    const left = entry('/private/tmp/left/src/index.ts');
    const right = entry('/private/tmp/right/src/index.ts', { ordinal: 2 });
    const result = mergeWorkspaceDiffs(diff(left, right), diff(entry('left › src/index.ts')));

    expect(result?.entries.map(({ path }) => path)).toEqual([
      'left › src/index.ts',
      left.path,
      right.path,
    ]);
  });

  it('keeps a one-to-one suffix match when the Runtime root label names another root', () => {
    const result = mergeWorkspaceDiffs(
      diff(entry('/private/tmp/right/src/index.ts')),
      diff(entry('left › src/index.ts')),
    );

    expect(result?.entries).toHaveLength(2);
  });

  it('does not treat a legal POSIX backslash as a path separator', () => {
    const result = mergeWorkspaceDiffs(
      diff(entry('/private/tmp/project/foo\\bar')),
      diff(entry('project › foo/bar')),
    );

    expect(result?.entries).toHaveLength(2);
  });

  it('keeps an ambiguous legacy absolute Windows drive path visible', () => {
    const result = mergeWorkspaceDiffs(
      diff(entry('C:\\private\\tmp\\project\\src\\index.ts')),
      diff(entry('project › src/index.ts')),
    );

    expect(result?.entries).toHaveLength(2);
  });

  it('does not hide persisted external drift behind a Runtime applied row', () => {
    const result = mergeWorkspaceDiffs(
      diff(entry('/private/tmp/project/src/index.ts', { status: 'external_drift' })),
      diff(entry('project › src/index.ts')),
    );

    expect(result?.entries).toHaveLength(2);
  });

  it('does not hide exact-path external drift behind a Runtime applied row', () => {
    const result = mergeWorkspaceDiffs(
      diff(entry('project › src/index.ts', { status: 'external_drift' })),
      diff(entry('project › src/index.ts')),
    );

    expect(result?.entries).toHaveLength(2);
  });
});
