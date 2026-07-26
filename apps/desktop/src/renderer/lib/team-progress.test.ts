import { describe, expect, it } from 'vitest';
import type { TeamDetail, WorkerSummary } from '../types/sprint-coder';
import { teamRunProgress } from './team-progress';

function worker(
  id: string,
  role: string,
  state: WorkerSummary['state'],
): WorkerSummary {
  return {
    id,
    teamId: 'team-1',
    threadId: `thread-${id}`,
    taskId: 'task-1',
    kind: 'worker',
    role,
    state,
    objective: 'objective',
    writeCapable: false,
    currentActivity: null,
    usage: { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 },
    createdAt: '',
    updatedAt: '',
  };
}

function detail(
  workers: WorkerSummary[],
  reports: Array<{ id: string; workerId: string }> = [],
): TeamDetail {
  return {
    team: {
      id: 'team-1',
      taskId: 'task-1',
      state: 'active',
      leaderAgentId: 'leader-1',
      budget: {},
      revision: 1,
      createdAt: '',
      updatedAt: '',
    },
    workers,
    messages: reports.map(({ id, workerId }, index) => ({
      id,
      teamId: 'team-1',
      sourceAgentId: workerId,
      targetAgentId: 'leader-1',
      sourceKind: 'worker',
      targetKind: 'leader',
      seq: index + 1,
      state: 'acknowledged',
      content: 'report',
      deliveryState: 'acked',
      attempt: 1,
      createdAt: '',
      updatedAt: '',
    })),
    budgets: [],
  };
}

describe('teamRunProgress', () => {
  it('keeps ordinary non-Team turns on the generic Run Card status', () => {
    expect(teamRunProgress(null)).toBeNull();
  });

  it('shows the active Worker role instead of a generic thinking label', () => {
    expect(
      teamRunProgress(
        detail([
          worker('w1', '技術担当', 'done'),
          worker('w2', '倫理担当', 'busy'),
          worker('w3', '実務担当', 'ready'),
        ]),
      ),
    ).toEqual({ label: 'Team実行中', detail: '倫理担当が作業中' });
  });

  it('shows real report progress and final synthesis', () => {
    const workers = [
      worker('w1', '技術担当', 'done'),
      worker('w2', '倫理担当', 'ready'),
      worker('w3', '実務担当', 'ready'),
    ];
    expect(teamRunProgress(detail(workers, [{ id: 'r1', workerId: 'w1' }]))).toEqual({
      label: 'Team実行中',
      detail: '報告を受信中（1/3）',
    });
    expect(
      teamRunProgress(
        detail(workers, [
          { id: 'r1', workerId: 'w1' },
          { id: 'r2', workerId: 'w2' },
          { id: 'r3', workerId: 'w3' },
        ]),
      ),
    ).toEqual({ label: 'Team実行中', detail: '報告を統合中（3/3）' });
  });
});
