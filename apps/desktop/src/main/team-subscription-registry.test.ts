import { describe, expect, it } from 'vitest';
import { TeamSubscriptionRegistry } from './team-subscription-registry';

describe('TeamSubscriptionRegistry', () => {
  it('keeps a newer A subscription when an older A subscription is removed', () => {
    const registry = new TeamSubscriptionRegistry();
    registry.subscribe('task-a', 'subscription-old');
    registry.subscribe('task-a', 'subscription-new');

    registry.unsubscribe('task-a', 'subscription-old');

    expect(registry.hasSubscribers('task-a')).toBe(true);
    expect(registry.nextSequence('task-a')).toBe(1);
  });

  it('returns the current sequence as the subscription snapshot baseline', () => {
    const registry = new TeamSubscriptionRegistry();
    registry.subscribe('task-a', 'subscription-first');
    expect(registry.nextSequence('task-a')).toBe(1);
    registry.unsubscribe('task-a', 'subscription-first');

    expect(registry.subscribe('task-a', 'subscription-second')).toBe(1);
    expect(registry.nextSequence('task-a')).toBe(2);
  });
});
