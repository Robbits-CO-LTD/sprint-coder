import { describe, expect, it } from 'vitest';
import {
  backgroundDeliveryId,
  backgroundEpochMismatch,
  transitionBackgroundActivity,
} from './background-activity';

describe('background activity domain', () => {
  it('uses a deterministic delivery id and binds it to the owner and activity', () => {
    const input = {
      completionId: 'completion-1',
      activityId: 'activity-1',
      ownerThreadId: 'thread-1',
    };
    expect(backgroundDeliveryId(input)).toBe(backgroundDeliveryId(input));
    expect(backgroundDeliveryId(input)).not.toBe(
      backgroundDeliveryId({ ...input, ownerThreadId: 'thread-2' }),
    );
  });

  it('allows only forward activity lifecycle transitions', () => {
    expect(transitionBackgroundActivity('registered', 'running')).toBe('running');
    expect(transitionBackgroundActivity('running', 'completed')).toBe('completed');
    expect(() => transitionBackgroundActivity('completed', 'running')).toThrow(
      'Invalid background activity transition',
    );
  });

  it('fails closed on branch, policy, and context epoch changes', () => {
    const current = { branchEpoch: 2, policyEpoch: 3, contextEpoch: 4 };
    expect(backgroundEpochMismatch(current, current)).toBeNull();
    expect(backgroundEpochMismatch({ ...current, branchEpoch: 1 }, current)).toBe(
      'branch_epoch_changed',
    );
    expect(backgroundEpochMismatch({ ...current, policyEpoch: 2 }, current)).toBe(
      'policy_epoch_changed',
    );
    expect(backgroundEpochMismatch({ ...current, contextEpoch: 3 }, current)).toBe(
      'context_epoch_changed',
    );
  });
});
