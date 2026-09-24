import { describe, expect, it } from 'vitest';
import {
  retainedWorktreeBlockedReason,
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
