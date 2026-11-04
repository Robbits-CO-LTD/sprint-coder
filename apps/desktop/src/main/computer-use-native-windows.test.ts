import { describe, expect, it } from 'vitest';
import {
  WindowsInteractionEvents,
  parseWindowsInteractionEvent,
  type WindowsInteractionEvent,
} from './computer-use-windows-transport-events';
import { COMPUTER_USE_WINDOWS_BACKGROUND_INPUT_ENABLED } from './computer-use-native-protocol';

const binding = {
  sessionId: 'session-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  helperGeneration: 2,
  cancelEpoch: 3,
};
const event = {
  ...binding,
  version: 1,
  kind: 'background_event',
  interactionEpoch: 4,
  sequence: 2,
  state: 'takeover',
} as const;
const trip = {
  ...binding,
  version: 1,
  kind: 'event',
  roundTripId: 'trip-1',
  sequence: 1,
  state: 'active',
  foreground: 'target',
  failureReason: 'none',
  failureLatched: false,
} as const;

describe('P3d interaction authority', () => {
  it('BG03_lost_event_cannot_bypass_epoch: ignores an event older than the start authority', () => {
    const delivery = new WindowsInteractionEvents();
    delivery.bind(binding, 5);
    expect(delivery.receive(event, 2)).toBe(false);
    expect(delivery.receive({ ...event, interactionEpoch: 6 }, 2)).toBe(true);
  });
  it.each(['sessionId', 'taskId', 'turnId', 'helperGeneration', 'cancelEpoch'] as const)(
    'BG03_lost_event_cannot_bypass_epoch: rejects mismatched %s',
    (key) => {
      const delivery = new WindowsInteractionEvents();
      delivery.bind(binding);
      const changed = { ...event, [key]: typeof event[key] === 'number' ? 1 : 'stale' };
      expect(delivery.receive(changed, 2)).toBe(false);
      expect(delivery.blocked(binding.sessionId)).toBe(false);
      expect(delivery.receive(event, 2)).toBe(true);
      expect(delivery.blocked(binding.sessionId)).toBe(true);
    },
  );
  it('BG08_monitor_failure_requires_human_resume: rebind, retry and delayed success never clear failure', () => {
    const delivery = new WindowsInteractionEvents();
    delivery.bind(binding);
    delivery.begin(binding, 'trip-1');
    expect(delivery.receive(event, 1)).toBe(false);
    expect(delivery.receive({ ...event, state: 'monitor_failed' }, 2)).toBe(true);
    expect(delivery.receive(event, 2)).toBe(false);
    delivery.bind(binding);
    expect(delivery.receive({ ...trip, sequence: 100 }, 2)).toBe(false);
    expect(delivery.begin(binding, 'trip-2')).toBe(false);
    expect(delivery.blocked(binding.sessionId)).toBe(true);
    delivery.bind({ ...binding, sessionId: 'human-new-session', cancelEpoch: 0 });
    expect(delivery.blocked('human-new-session')).toBe(false);
    expect(COMPUTER_USE_WINDOWS_BACKGROUND_INPUT_ENABLED).toBe(false);
  });
  it('BG03_lost_event_cannot_bypass_epoch: a held queue that overflows before bind fails closed', () => {
    const delivery = new WindowsInteractionEvents();
    for (let sequence = 1; sequence <= 9; sequence += 1)
      delivery.hold({ ...event, sequence }, 2, true);
    expect(delivery.bind(binding)).toEqual([]);
    expect(delivery.blocked(binding.sessionId)).toBe(true);
  });
  it('BG03_lost_event_cannot_bypass_epoch: an event for a started but unbound session blocks it', () => {
    const delivery = new WindowsInteractionEvents();
    delivery.revokeUnbound(binding.sessionId);
    expect(delivery.blocked(binding.sessionId)).toBe(true);
    delivery.remove(binding.sessionId);
    expect(delivery.blocked(binding.sessionId)).toBe(false);
    delivery.bind(binding);
    delivery.revokeUnbound(binding.sessionId);
    expect(delivery.blocked(binding.sessionId)).toBe(false);
  });
  it('BG03_lost_event_cannot_bypass_epoch: a held event marks the session as waiting for a binding', () => {
    const delivery = new WindowsInteractionEvents();
    expect(delivery.waitsForBinding(binding.sessionId)).toBe(false);
    delivery.hold(event, 2, true);
    expect(delivery.waitsForBinding(binding.sessionId)).toBe(true);
    delivery.bind(binding);
    expect(delivery.waitsForBinding(binding.sessionId)).toBe(false);
  });
  it('BG03_lost_event_cannot_bypass_epoch: a start that ends unbound leaves no held event behind', () => {
    const delivery = new WindowsInteractionEvents();
    delivery.hold(event, 2, true);
    delivery.discardUnbound(binding.sessionId);
    expect(delivery.bind(binding)).toEqual([]);
    expect(delivery.blocked(binding.sessionId)).toBe(false);
  });
  it('RT_end_first_cannot_unlock_legacy_start: rejects unknown id, duplicates and reversed events', () => {
    const delivery = new WindowsInteractionEvents();
    delivery.bind(binding);
    expect(delivery.receive(trip, 2)).toBe(false);
    expect(delivery.begin(binding, 'trip-1')).toBe(true);
    delivery.settleBegin(binding.sessionId, 'trip-1', true);
    expect(delivery.receive({ ...trip, roundTripId: 'other' }, 2)).toBe(false);
    expect(delivery.receive({ ...trip, sequence: 3 }, 2)).toBe(true);
    expect(delivery.begin(binding, 'trip-1')).toBe(false);
    expect(delivery.receive({ ...trip, sequence: 3 }, 2)).toBe(false);
    expect(delivery.receive(trip, 2)).toBe(false);
    expect(
      delivery.receive(
        { ...trip, sequence: 4, state: 'failed', failureReason: 'expired', failureLatched: true },
        2,
      ),
    ).toBe(true);
    expect(delivery.receive({ ...trip, sequence: 5, state: 'ended' }, 2)).toBe(false);
    expect(delivery.blocked(binding.sessionId)).toBe(true);
  });
  it('reports ordering faults without accepting them or rolling back the sequence', () => {
    const delivery = new WindowsInteractionEvents();
    const faults: WindowsInteractionEvent[] = [];
    const receive = (event: WindowsInteractionEvent) =>
      delivery.receive(event, 2, (fault) => faults.push(fault));
    delivery.bind(binding);
    delivery.begin(binding, 'trip-1');
    delivery.settleBegin(binding.sessionId, 'trip-1', true);
    expect(receive({ ...trip, sequence: 3 })).toBe(true);
    expect(receive({ ...trip, roundTripId: 'unknown' })).toBe(false);
    expect(faults).toEqual([]);
    expect(receive(trip)).toBe(false);
    expect(receive({ ...trip, sequence: 3 })).toBe(false);
    expect(faults.map((event) => event.sequence)).toEqual([1, 3]);
    expect(receive({ ...trip, sequence: 4 })).toBe(true);
    delivery.completeTrip(binding.sessionId, 'trip-1');
    expect(delivery.begin(binding, 'trip-2')).toBe(true);
    delivery.settleBegin(binding.sessionId, 'trip-2', true);
    expect(receive({ ...trip, roundTripId: 'trip-2', sequence: 4 })).toBe(false);
    expect(receive({ ...trip, roundTripId: 'trip-2', sequence: 5 })).toBe(true);
  });
  it('replays held ordering faults for Main without rolling back transport authority', () => {
    const delivery = new WindowsInteractionEvents();
    delivery.bind(binding);
    delivery.begin(binding, 'trip-1');
    for (const sequence of [2, 1, 2]) delivery.hold({ ...trip, sequence }, 2, false);
    expect(
      delivery.settleBegin(binding.sessionId, 'trip-1', true).map((event) => event.sequence),
    ).toEqual([2, 1, 2]);
    expect(delivery.receive({ ...trip, sequence: 2 }, 2)).toBe(false);
    expect(delivery.receive({ ...trip, sequence: 3 }, 2)).toBe(true);
  });
  it('RT_id_binding: validates closed metadata without accepting unknown fields', () => {
    for (const valid of [event, trip]) {
      expect(parseWindowsInteractionEvent(valid)).toEqual(valid);
      expect(parseWindowsInteractionEvent({ ...valid, extra: true })).toBeNull();
      expect(parseWindowsInteractionEvent({ ...valid, sequence: 0 })).toBeNull();
      expect(
        parseWindowsInteractionEvent({ ...valid, helperGeneration: Number.MAX_SAFE_INTEGER + 1 }),
      ).toBeNull();
    }
    const failed: WindowsInteractionEvent = {
      ...trip,
      state: 'failed',
      failureReason: 'expired',
      failureLatched: true,
    };
    expect(parseWindowsInteractionEvent(failed)).toEqual(failed);
    expect(parseWindowsInteractionEvent({ ...failed, failureLatched: false })).toBeNull();
  });
  it('RT_end_first_cannot_unlock_legacy_start: failure after ended still revokes the exchanged ticket', () => {
    const delivery = new WindowsInteractionEvents();
    delivery.bind(binding);
    delivery.begin(binding, 'trip-1');
    delivery.settleBegin(binding.sessionId, 'trip-1', true);
    expect(delivery.receive({ ...trip, state: 'ended' }, 2)).toBe(true);
    expect(delivery.receive({ ...trip, sequence: 2 }, 2)).toBe(false);
    expect(
      delivery.receive(
        { ...trip, sequence: 3, state: 'failed', failureReason: 'expired', failureLatched: true },
        2,
      ),
    ).toBe(true);
    expect(delivery.blocked(binding.sessionId)).toBe(true);
  });
});
