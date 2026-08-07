import { describe, expect, it, vi } from 'vitest';
import type { TeamEvent } from '@sprint-coder/contracts';
import { createTeamSubscriptionBuffer } from './team-subscription-buffer';

describe('createTeamSubscriptionBuffer', () => {
  it('delivers the snapshot before an update received while subscribe was pending', () => {
    const listener = vi.fn();
    const buffer = createTeamSubscriptionBuffer(listener);
    const update = { type: 'updated', seq: 1, detail: {} } as unknown as TeamEvent;

    buffer.push(update);
    buffer.activate({ type: 'snapshot', seq: 0, detail: null });

    expect(listener.mock.calls.map(([event]) => [event.type, event.seq])).toEqual([
      ['snapshot', 0],
      ['updated', 1],
    ]);
  });

  it('drops buffered updates already represented by the snapshot baseline', () => {
    const listener = vi.fn();
    const buffer = createTeamSubscriptionBuffer(listener);
    buffer.push({ type: 'updated', seq: 2, detail: {} } as unknown as TeamEvent);

    buffer.activate({ type: 'snapshot', seq: 2, detail: null });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'snapshot', seq: 2, detail: null });
  });

  it('does not deliver a late snapshot after disposal', () => {
    const listener = vi.fn();
    const buffer = createTeamSubscriptionBuffer(listener);
    buffer.dispose();

    buffer.activate({ type: 'snapshot', seq: 0, detail: null });

    expect(listener).not.toHaveBeenCalled();
  });
});
