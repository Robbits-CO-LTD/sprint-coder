import { describe, expect, it } from 'vitest';
import { retainedWorktreeCount, retainedWorktreesKey } from './team-retained-worktrees';
import type { TeamDetail, TeamExecutionSummary } from '../types/sprint-coder';

type Repository = NonNullable<TeamExecutionSummary['isolation']>['repositories'][number];

function repository(ordinal: number, state: Repository['state']): Repository {
  return {
    ordinal,
    repoPath: `/repo-${ordinal}`,
    worktreePath: `/worktrees/worktree-exec-${ordinal}`,
    baseHead: 'a'.repeat(40),
    workerHead: null,
    integratedHead: null,
    state,
    changedFiles: [],
  };
}

function execution(
  id: string,
  state: TeamExecutionSummary['state'],
  repositories: Repository[] | null,
): TeamExecutionSummary {
  return {
    id,
    teamId: 'team-1',
    assigneeAgentId: 'worker-1',
    createdByAgentId: 'leader-1',
    accessMode: 'workspace-write',
    state,
    instructionPreview: 'write',
    instructionRevision: 1,
    queueOrdinal: null,
    queueReason: null,
    connectionId: null,
    requestedModel: null,
    attemptStartReason: 'initial',
    lastProgressAt: null,
    terminalReason: null,
    missionId: null,
    missionStepOrdinal: null,
    missionStepCount: null,
    worktree: null,
    isolation:
      repositories === null
        ? null
        : { phase: 'quarantined', resumeKind: null, repositories, roots: [], reason: 'kept' },
    assignedAt: '2026-09-24T00:00:00.000Z',
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-09-24T00:00:00.000Z',
  };
}

function detail(executions: TeamExecutionSummary[]): TeamDetail {
  return { executions } as unknown as TeamDetail;
}

describe('retained worktree count (issue #544)', () => {
  it('counts only quarantined isolation repositories across executions', () => {
    expect(retainedWorktreeCount(undefined)).toBe(0);
    expect(retainedWorktreeCount(null)).toBe(0);
    expect(
      retainedWorktreeCount(
        detail([
          execution('a', 'failed', [repository(1, 'quarantined'), repository(2, 'cleaned')]),
          execution('b', 'completed', [repository(1, 'cleaned')]),
          execution('c', 'running', [repository(1, 'active')]),
          execution('d', 'canceled', [repository(1, 'quarantined')]),
          execution('e', 'completed', null),
        ]),
      ),
    ).toBe(2);
  });

  it('changes its refresh key only when something the discard rule reads changes', () => {
    const before = detail([execution('a', 'failed', [repository(1, 'quarantined')])]);
    const same = detail([
      { ...execution('a', 'failed', [repository(1, 'quarantined')]), instructionPreview: 'more' },
    ]);
    expect(retainedWorktreesKey(same)).toBe(retainedWorktreesKey(before));
    for (const changed of [
      detail([execution('a', 'failed', [repository(1, 'cleaned')])]),
      detail([execution('a', 'waiting_resume', [repository(1, 'quarantined')])]),
      detail([
        execution('a', 'failed', [repository(1, 'quarantined')]),
        execution('b', 'failed', [repository(1, 'quarantined')]),
      ]),
    ])
      expect(retainedWorktreesKey(changed)).not.toBe(retainedWorktreesKey(before));
  });
});
