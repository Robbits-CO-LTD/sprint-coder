import { beforeEach, describe, expect, it } from 'vitest';
import { applyFileEditFrame, clearFileEdits, readFileEdits } from './file-edit-buffer';

describe('file edit buffer multi-root identity', () => {
  beforeEach(() => clearFileEdits());

  it('does not collapse identical relative paths from different roots', () => {
    for (const [rootId, rootLabel, text] of [
      ['root-a', 'test1', 'from a'],
      ['root-b', 'test2', 'from b'],
    ] as const)
      applyFileEditFrame({
        taskId: 'task-1',
        turnId: 'turn-1',
        rootId,
        rootLabel,
        path: 'src/index.ts',
        text,
        complete: true,
        source: 'disk',
        baseline: null,
      });

    expect(readFileEdits()).toMatchObject([
      { rootId: 'root-b', rootLabel: 'test2', text: 'from b' },
      { rootId: 'root-a', rootLabel: 'test1', text: 'from a' },
    ]);
  });
});
