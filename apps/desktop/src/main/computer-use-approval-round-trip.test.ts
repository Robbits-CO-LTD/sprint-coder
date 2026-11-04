import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerUseApprovalRoundTripWire as Wire } from '@sprint-coder/contracts';
import { ApprovalRoundTrips } from './computer-use-approval-round-trip';

const binding = {
  version: 1,
  roundTripId: 'card-1',
  sessionId: 'session-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  helperGeneration: 1,
  cancelEpoch: 0,
} as const;
const begin = {
  ...binding,
  kind: 'begin',
  durationMs: 60_000,
  mainPid: 42,
  mainProcessStartTime: '123',
  mainImageIdentity: 'a'.repeat(64),
} as const;
const event = {
  ...binding,
  kind: 'event',
  sequence: 1,
  state: 'active',
  foreground: 'sprint_coder',
  failureReason: 'none',
  failureLatched: false,
} as const;
function acknowledgement(wire: Wire): Wire {
  return {
    ...binding,
    roundTripId: wire.roundTripId,
    kind: wire.kind === 'begin' ? 'begin_result' : 'end_result',
    accepted: true,
    failureReason: 'none',
    failureLatched: false,
  };
}
function fixture() {
  const send = vi.fn(async (wire: Wire): Promise<unknown> => acknowledgement(wire));
  const revoked = vi.fn();
  return { send, revoked, trips: new ApprovalRoundTrips(send, revoked) };
}
afterEach(() => vi.useRealTimers());

describe('P5b Main round-trip lifetime (no OS input)', () => {
  it('P5c2b-W ended permits the next offer without forgetting ids or sequence', async () => {
    vi.useFakeTimers();
    const { trips, revoked } = fixture();
    await trips.begin(begin);
    trips.receive(event);
    trips.returning(binding.sessionId, binding.roundTripId);
    trips.exchange(binding.sessionId);
    await trips.exchanged(binding.sessionId);
    expect(trips.offered(binding.sessionId)).toBeUndefined();
    await expect(trips.begin(begin)).rejects.toThrow();
    await trips.begin({ ...begin, roundTripId: 'card-2' });
    trips.receive({ ...event, roundTripId: 'card-2', sequence: 2 });
    expect(revoked).not.toHaveBeenCalled();
  });
  it('P5c2b-W offered cannot be offered twice', async () => {
    vi.useFakeTimers();
    const { trips } = fixture();
    await trips.begin(begin);
    trips.returning(binding.sessionId, binding.roundTripId);
    trips.exchange(binding.sessionId);
    expect(trips.offered(binding.sessionId)).toBe(binding.roundTripId);
    expect(() => trips.offered(binding.sessionId)).toThrow();
  });
  it('P5c2b-W accepts only the previous ended after the next begin', async () => {
    vi.useFakeTimers();
    const { trips, revoked } = fixture();
    await trips.begin(begin);
    trips.receive(event);
    trips.returning(binding.sessionId, binding.roundTripId);
    trips.exchange(binding.sessionId);
    trips.offered(binding.sessionId);
    await trips.begin({ ...begin, roundTripId: 'card-2' });
    trips.receive({ ...event, sequence: 2 });
    trips.receive({ ...event, sequence: 2, state: 'ended', turnId: 'foreign' });
    trips.receive({ ...event, sequence: 2, state: 'ended' });
    trips.receive({ ...event, sequence: 3, state: 'ended' });
    trips.receive({ ...event, roundTripId: 'card-2', sequence: 3 });
    expect(revoked).not.toHaveBeenCalled();
    expect(trips.returning(binding.sessionId, 'card-2')).toMatchObject({ roundTripId: 'card-2' });
  });
  it('Offer ends the first card without End; the second uses a fresh id and exchanges', async () => {
    vi.useFakeTimers();
    const { trips, send } = fixture();
    await trips.begin(begin);
    trips.returning(binding.sessionId, binding.roundTripId);
    trips.exchange(binding.sessionId);
    trips.receive({ ...event, state: 'ended' });
    trips.offered(binding.sessionId);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(trips.end(binding.sessionId, binding.roundTripId, 'approved')).rejects.toThrow();
    await expect(trips.begin(begin)).rejects.toThrow();
    await trips.begin({ ...begin, roundTripId: 'card-2' });
    trips.receive({ ...event, roundTripId: 'card-2', sequence: 2 });
    trips.returning(binding.sessionId, 'card-2');
    trips.exchange(binding.sessionId);
    await trips.exchanged(binding.sessionId);
    expect(send.mock.calls.map(([wire]) => [wire.kind, wire.roundTripId])).toEqual([
      ['begin', 'card-1'],
      ['begin', 'card-2'],
      ['end', 'card-2'],
    ]);
  });
  it('begin carries identity and duration; end follows return and exchange with the same id', async () => {
    vi.useFakeTimers();
    const { trips, send, revoked } = fixture();
    await trips.begin(begin);
    expect(send).toHaveBeenCalledWith(begin);
    trips.receive(event);
    expect(trips.returning(binding.sessionId, binding.roundTripId)).toMatchObject({
      roundTripId: binding.roundTripId,
      helperGeneration: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(trips.exchange(binding.sessionId)).toMatchObject({ roundTripId: binding.roundTripId });
    await trips.exchanged(binding.sessionId);
    expect(send).toHaveBeenLastCalledWith({ ...binding, kind: 'end', reason: 'approved' });
    expect(revoked).not.toHaveBeenCalled();
  });

  it('expires at 60 seconds even if native sends no events', async () => {
    vi.useFakeTimers();
    const { trips, revoked } = fixture();
    await trips.begin(begin);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(revoked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ failureReason: 'expired' }));
    expect(() => trips.returning(binding.sessionId, binding.roundTripId)).toThrow();
  });

  it.each(['other', 'gap', 'reversed', 'early end'] as const)(
    '%s revokes and cannot be undone by a later active event',
    async (fault) => {
      vi.useFakeTimers();
      const { trips, revoked } = fixture();
      await trips.begin(begin);
      trips.receive(event);
      if (fault === 'other')
        trips.receive({
          ...event,
          sequence: 2,
          state: 'failed',
          foreground: 'other',
          failureReason: 'third_window',
          failureLatched: true,
        });
      if (fault === 'gap') trips.receive({ ...event, sequence: 3 });
      if (fault === 'reversed') trips.receive(event);
      if (fault === 'early end') trips.receive({ ...event, sequence: 2, state: 'ended' });
      trips.receive({ ...event, sequence: 4 });
      expect(revoked).toHaveBeenCalledTimes(1);
      expect(() => trips.returning(binding.sessionId, binding.roundTripId)).toThrow();
    },
  );

  it('end wins over a delayed begin acknowledgement', async () => {
    vi.useFakeTimers();
    const { trips, send, revoked } = fixture();
    let release!: (wire: Wire) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const starting = trips.begin(begin);
    const rejected = expect(starting).rejects.toThrow();
    await trips.end(binding.sessionId, binding.roundTripId, 'stopped');
    release(acknowledgement(begin));
    await rejected;
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(() => trips.returning(binding.sessionId, binding.roundTripId)).toThrow();
  });

  it('refuses return without an id and never borrows a card for legacy resume', async () => {
    vi.useFakeTimers();
    const { trips, revoked } = fixture();
    await trips.begin(begin);
    expect(() => trips.returning(binding.sessionId, undefined)).toThrow();
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(() => trips.returning(binding.sessionId, binding.roundTripId)).toThrow();
  });

  it('Stop during return prevents exchange', async () => {
    vi.useFakeTimers();
    const { trips } = fixture();
    await trips.begin(begin);
    trips.returning(binding.sessionId, binding.roundTripId);
    await trips.end(binding.sessionId, binding.roundTripId, 'stopped');
    expect(() => trips.exchange(binding.sessionId)).toThrow();
    await expect(trips.exchanged(binding.sessionId)).rejects.toThrow();
  });

  it.each(['missing', 'refused', 'unbound'] as const)(
    'fails closed on %s begin acknowledgement',
    async (fault) => {
      vi.useFakeTimers();
      const { trips, send, revoked } = fixture();
      if (fault === 'missing') send.mockRejectedValueOnce(new Error('response lost'));
      if (fault === 'refused')
        send.mockResolvedValueOnce({
          ...acknowledgement(begin),
          accepted: false,
          failureReason: 'rejected',
          failureLatched: true,
        });
      if (fault === 'unbound')
        send.mockResolvedValueOnce({ ...acknowledgement(begin), turnId: 'other' });
      await expect(trips.begin(begin)).rejects.toThrow();
      expect(revoked).toHaveBeenCalledTimes(1);
      expect(() => trips.exchange(binding.sessionId)).toThrow();
    },
  );

  it('refuses an overlong duration before sending anything', async () => {
    const { trips, send } = fixture();
    await expect(trips.begin({ ...begin, durationMs: 60_001 })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
