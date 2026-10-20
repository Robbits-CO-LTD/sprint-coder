import { describe, expect, it } from 'vitest';
import type { TeamExecutionSummary, TeamMessageSummary } from '../types/sprint-coder';
import {
  executionNeedsAttention,
  workerThread,
  workStepIcon,
  workStepLabel,
} from './worker-thread';

function message(id: string, createdAt: string): TeamMessageSummary {
  return {
    id,
    teamId: 'team',
    sourceAgentId: 'leader',
    targetAgentId: 'worker',
    sourceKind: 'leader',
    targetKind: 'worker',
    seq: 1,
    state: 'delivered',
    content: id,
    executionId: null,
    attemptId: null,
    deliveryState: null,
    attempt: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('workerThread', () => {
  it('merges messages and steps by time, the request before a step recorded in the same instant', () => {
    const thread = workerThread(
      [
        message('request', '2026-10-20T10:00:00.000Z'),
        message('report', '2026-10-20T10:00:09.000Z'),
      ],
      [
        { kind: 'activity', label: 'read_file', at: '2026-10-20T10:00:00.000Z' },
        { kind: 'fileChange', label: '編集 a.ts', at: '2026-10-20T10:00:05.000Z' },
      ],
    );
    expect(
      thread.map((item) => (item.kind === 'message' ? item.message.id : item.step.label)),
    ).toEqual(['request', 'read_file', '編集 a.ts', 'report']);
  });
});

describe('work step presentation', () => {
  it('names a tool call by the tool, and keeps any other label as written', () => {
    expect(workStepLabel('Workerがread_fileを実行中')).toBe('read_file');
    expect(workStepLabel('Managerがteam_hire_workerを実行中')).toBe('team_hire_worker');
    expect(workStepLabel('依頼を処理中')).toBe('依頼を処理中');
  });

  it('picks an icon from what the step did', () => {
    const at = '2026-10-20T10:00:00.000Z';
    expect(workStepIcon({ kind: 'fileChange', label: '編集 a.ts', at })).toBe('edit');
    expect(workStepIcon({ kind: 'activity', label: 'Workerがgrepを実行中', at })).toBe('search');
    expect(workStepIcon({ kind: 'activity', label: 'Workerがread_fileを実行中', at })).toBe('read');
    expect(workStepIcon({ kind: 'activity', label: 'Workerがrun_commandを実行中', at })).toBe(
      'tool',
    );
    expect(workStepIcon({ kind: 'activity', label: '依頼を処理中', at })).toBe('status');
  });
});

describe('executionNeedsAttention', () => {
  const base = { state: 'running', isolation: null } as unknown as TeamExecutionSummary;

  it('keeps an ordinary run behind the details', () => {
    expect(executionNeedsAttention(null)).toBe(false);
    expect(executionNeedsAttention(base)).toBe(false);
    expect(executionNeedsAttention({ ...base, state: 'completed' })).toBe(false);
  });

  it('surfaces waits, failures and resumes on the card', () => {
    for (const state of ['waiting_resume', 'waiting_rate_limit', 'queued', 'failed'] as const)
      expect(executionNeedsAttention({ ...base, state })).toBe(true);
  });
});
