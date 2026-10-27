import { describe, expect, it } from 'vitest';
import {
  retainedWorktreeBlockedReason,
  retainedWorktreePage,
  type RetainedWorktreeFacts,
} from './team-retained-worktrees';

const discardable: RetainedWorktreeFacts = {
  managerAvailable: true,
  owned: true,
  executionState: 'failed',
  isolationPhase: 'quarantined',
  resumeKind: null,
  graphMissionState: null,
  runtimeUnsettled: false,
};

describe('retainedWorktreeBlockedReason (issue #544)', () => {
  it.each(['completed', 'failed', 'canceled'] as const)(
    'lets a %s execution discard its quarantined worktree',
    (executionState) => {
      expect(retainedWorktreeBlockedReason({ ...discardable, executionState })).toBeNull();
      // An integration that finished before its cleanup failed is just as finished.
      expect(
        retainedWorktreeBlockedReason({
          ...discardable,
          executionState,
          isolationPhase: 'completed',
        }),
      ).toBeNull();
    },
  );

  it.each([
    'assigned',
    'queued',
    'waiting_verification',
    'waiting_rate_limit',
    'running',
    'waiting_resume',
  ] as const)('keeps the worktree of a %s execution', (executionState) => {
    expect(retainedWorktreeBlockedReason({ ...discardable, executionState })).toContain(
      'まだ終わっていない',
    );
  });

  it.each([
    'preparing',
    'running',
    'finalizing',
    'waiting_integration',
    'integrating',
    'waiting_resume',
  ] as const)('keeps a worktree whose isolation is still %s', (isolationPhase) => {
    expect(retainedWorktreeBlockedReason({ ...discardable, isolationPhase })).toContain(
      '統合や再開の途中',
    );
  });

  it.each(['worker', 'integration'] as const)(
    'keeps a worktree that can still be resumed as %s',
    (resumeKind) => {
      expect(retainedWorktreeBlockedReason({ ...discardable, resumeKind })).toContain(
        '統合や再開の途中',
      );
    },
  );

  it('keeps the worktree of a Graph Mission step until the Mission ends', () => {
    for (const graphMissionState of ['queued', 'running', 'waiting_resume'] as const)
      expect(retainedWorktreeBlockedReason({ ...discardable, graphMissionState })).toContain(
        'Graph Mission',
      );
    for (const graphMissionState of ['completed', 'failed', 'canceled'] as const)
      expect(retainedWorktreeBlockedReason({ ...discardable, graphMissionState })).toBeNull();
  });

  it('keeps a worktree the Worker CLI may still be writing into', () => {
    expect(retainedWorktreeBlockedReason({ ...discardable, runtimeUnsettled: true })).toContain(
      '終了したことをまだ確認できていない',
    );
  });

  it('refuses a path Sprint Coder does not own and an app without a worktree manager', () => {
    expect(retainedWorktreeBlockedReason({ ...discardable, owned: false })).toContain('一致しない');
    expect(retainedWorktreeBlockedReason({ ...discardable, managerAvailable: false })).toContain(
      '管理できない',
    );
  });
});

describe('retained worktree keyset paging (#966)', () => {
  const rows = Array.from({ length: 401 }, (_, i) => ({
    taskId: 'task',
    teamId: 'team',
    assignedAt: '2026-10-27T00:00:00.000Z',
    executionId: `execution-${String(i).padStart(4, '0')}`,
    repositoryOrdinal: 1,
  }));
  it('reaches all 401 entries without deleting the first 200', () => {
    const first = retainedWorktreePage(rows, null);
    expect(first.items).toHaveLength(200);
    expect(first.nextCursor).toEqual(rows[199]);
    const second = retainedWorktreePage(rows, first.nextCursor);
    expect(second.items).toHaveLength(200);
    const last = retainedWorktreePage(rows, second.nextCursor);
    expect(last.items).toEqual([rows[400]]);
    expect(last.nextCursor).toBeNull();
  });
  it('uses SQLite binary ordering for non-ASCII cursor IDs', () => {
    const a = { ...rows[0]!, executionId: '\uE000' };
    const b = { ...rows[0]!, executionId: '😀' };
    expect(retainedWorktreePage([b, a], null).items).toEqual([a, b]);
  });

  it('keeps tuple boundaries after the cursor record is deleted, with deterministic ordinal ordering', () => {
    const first = retainedWorktreePage(rows, null);
    const surviving = rows.filter((_, i) => i !== 0 && i !== 199);
    expect(retainedWorktreePage(surviving, first.nextCursor).items[0]).toEqual(rows[200]);
    const same = rows[0]!;
    const mixed = [
      { ...same, repositoryOrdinal: 3 },
      { ...same, repositoryOrdinal: 1 },
      { ...same, repositoryOrdinal: 2 },
    ];
    expect(
      retainedWorktreePage(mixed, { ...same, repositoryOrdinal: 1 }).items.map(
        (x) => x.repositoryOrdinal,
      ),
    ).toEqual([2, 3]);
  });
});
