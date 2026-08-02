import { describe, expect, it } from 'vitest';
import {
  createExecutionInstruction,
  nextTeamAttemptOrdinal,
  reviseQueuedExecutionInstruction,
  transitionTeamAttempt,
  transitionTeamExecution,
} from './team-execution';

const now = '2026-07-28T10:00:00.000Z';

describe('Team execution domain', () => {
  it('moves an execution through queue and running to a terminal state', () => {
    expect(transitionTeamExecution('assigned', 'queued')).toBe('queued');
    expect(transitionTeamExecution('queued', 'running')).toBe('running');
    expect(transitionTeamExecution('queued', 'failed')).toBe('failed');
    expect(transitionTeamExecution('running', 'completed')).toBe('completed');
    expect(() => transitionTeamExecution('completed', 'running')).toThrow(
      'Invalid Team execution transition',
    );
  });

  it('keeps waiting states outside running and supports recovery back to queue', () => {
    expect(transitionTeamExecution('queued', 'waiting_verification')).toBe('waiting_verification');
    expect(transitionTeamExecution('queued', 'waiting_rate_limit')).toBe('waiting_rate_limit');
    expect(transitionTeamExecution('running', 'waiting_rate_limit')).toBe('waiting_rate_limit');
    expect(transitionTeamExecution('running', 'queued')).toBe('queued');
  });

  it('reuses the same attempt across a rate-limit wait', () => {
    expect(transitionTeamAttempt('created', 'running')).toBe('running');
    expect(transitionTeamAttempt('running', 'waiting_rate_limit')).toBe('waiting_rate_limit');
    expect(transitionTeamAttempt('waiting_rate_limit', 'running')).toBe('running');
    expect(transitionTeamAttempt('running', 'completed')).toBe('completed');
  });

  it('interrupts a running attempt for steer without reopening that attempt', () => {
    expect(transitionTeamAttempt('running', 'interrupted')).toBe('interrupted');
    expect(() => transitionTeamAttempt('interrupted', 'running')).toThrow(
      'Invalid Team attempt transition',
    );
  });

  it('increments queued instruction revisions and rejects in-place running steer', () => {
    const original = createExecutionInstruction('Implement the bounded change.', now);
    expect(
      reviseQueuedExecutionInstruction({
        executionState: 'waiting_rate_limit',
        current: original,
        content: 'Implement it and add the focused regression test.',
        updatedAt: '2026-07-28T10:01:00.000Z',
      }),
    ).toEqual({
      revision: 2,
      content: 'Implement it and add the focused regression test.',
      updatedAt: '2026-07-28T10:01:00.000Z',
    });
    expect(() =>
      reviseQueuedExecutionInstruction({
        executionState: 'running',
        current: original,
        content: 'This requires interrupt-and-resume.',
        updatedAt: '2026-07-28T10:01:00.000Z',
      }),
    ).toThrow('Only a queued Team execution');
  });

  it('allocates stable one-based attempt ordinals', () => {
    expect(nextTeamAttemptOrdinal([])).toBe(1);
    expect(nextTeamAttemptOrdinal([1, 2])).toBe(3);
    expect(() => nextTeamAttemptOrdinal([1, 1])).toThrow('Duplicate');
    expect(() => nextTeamAttemptOrdinal([1, 3])).toThrow('contiguous');
    expect(() => nextTeamAttemptOrdinal([0])).toThrow('Invalid');
  });
});
