import {
  computerUseApprovalRoundTripWireSchema,
  type ComputerUseApprovalRoundTripWire as Wire,
} from '@sprint-coder/contracts';
import type { WindowsInteractionEvent } from './computer-use-windows-transport-events';

type Begin = Extract<Wire, { kind: 'begin' }>;
type End = Extract<Wire, { kind: 'end' }>;
export type ApprovalRoundTripIdentity = Pick<
  Begin,
  'mainPid' | 'mainProcessStartTime' | 'mainImageIdentity'
>;
type Trip = {
  begin: Begin;
  deadline: number;
  phase:
    'pending' | 'active' | 'returned' | 'exchanging' | 'offered' | 'ending' | 'ended' | 'failed';
  sequence: number;
  previousBegin?: Begin | undefined;
  endedNotified: boolean;
  timer: ReturnType<typeof setTimeout>;
};

/** Main-only lifetime. No OS calls; production admission is owned by the host's closed gate. */
export class ApprovalRoundTrips {
  private readonly trips = new Map<string, Trip>();
  private readonly usedIds = new Set<string>();
  constructor(
    private readonly send: (wire: Wire) => Promise<unknown>,
    private readonly revoked: (event: WindowsInteractionEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  async begin(input: Begin): Promise<void> {
    const wire = computerUseApprovalRoundTripWireSchema.parse(input);
    if (wire.kind !== 'begin') throw new Error('Invalid round trip begin');
    const previous = this.trips.get(input.sessionId);
    if (
      this.usedIds.has(input.roundTripId) ||
      (previous && previous.phase !== 'ended' && previous.phase !== 'offered')
    )
      throw new Error('Round trip already used or pending');
    this.usedIds.add(input.roundTripId);
    const trip: Trip = {
      begin: wire,
      deadline: this.now() + wire.durationMs,
      phase: 'pending',
      sequence: previous?.sequence ?? 0,
      previousBegin: previous && !previous.endedNotified ? previous.begin : undefined,
      endedNotified: false,
      timer: setTimeout(() => {
        void this.cancel(wire.sessionId, 'expired').catch(() => undefined);
        this.fail(trip, 'expired');
      }, wire.durationMs),
    };
    trip.timer.unref?.();
    this.trips.set(wire.sessionId, trip);
    try {
      this.ack(await this.send(wire), trip, 'begin_result');
      if (trip.phase !== 'pending')
        throw new Error('Round trip ended before begin acknowledgement');
      trip.phase = 'active';
      this.live(trip);
    } catch (error) {
      this.fail(trip, 'monitor_failed');
      throw error;
    }
  }

  private ack(value: unknown, trip: Trip, kind: 'begin_result' | 'end_result'): void {
    const ack = computerUseApprovalRoundTripWireSchema.parse(value);
    if (ack.kind !== kind || !this.matches(trip, ack) || !ack.accepted)
      throw new Error('Round trip acknowledgement refused');
  }

  private matches(trip: Pick<Trip, 'begin'>, wire: Wire): boolean {
    return (
      ['roundTripId', 'sessionId', 'taskId', 'turnId', 'helperGeneration', 'cancelEpoch'] as const
    ).every((key) => wire[key] === trip.begin[key]);
  }

  private live(trip: Trip): void {
    if (this.now() >= trip.deadline) this.fail(trip, 'expired');
    if (!['active', 'returned', 'exchanging'].includes(trip.phase))
      throw new Error('Round trip is not live');
  }

  /** A return must explicitly name the live card; legacy resume cannot borrow its authority. */
  returning(sessionId: string, id: string | undefined): Record<string, unknown> {
    const trip = this.trips.get(sessionId);
    if (!trip) {
      if (id !== undefined) throw new Error('Unknown round trip');
      return {};
    }
    this.live(trip);
    if (id !== trip.begin.roundTripId || trip.phase !== 'active') {
      this.fail(trip, 'rejected');
      throw new Error('Missing or reused round trip id');
    }
    trip.phase = 'returned';
    return this.metadata(trip);
  }

  exchange(sessionId: string): Record<string, unknown> {
    const trip = this.trips.get(sessionId);
    if (!trip || trip.phase === 'ended') return {};
    this.live(trip);
    if (trip.phase !== 'returned') {
      this.fail(trip, 'rejected');
      throw new Error('Round trip has not returned');
    }
    trip.phase = 'exchanging';
    return this.metadata(trip);
  }

  /** Only the validated, re-observation-bound native offer may close the first card. */
  offered(sessionId: string): string | undefined {
    const trip = this.trips.get(sessionId);
    if (!trip || trip.phase === 'ended') return;
    this.live(trip);
    if (trip.phase !== 'exchanging') throw new Error('Round trip offer out of order');
    trip.phase = 'offered';
    clearTimeout(trip.timer);
    return trip.begin.roundTripId;
  }

  private metadata(trip: Trip): Record<string, unknown> {
    const { roundTripId, taskId, turnId, helperGeneration } = trip.begin;
    return { roundTripId, taskId, turnId, helperGeneration };
  }

  async cancel(sessionId: string, reason: End['reason']): Promise<void> {
    const trip = this.trips.get(sessionId);
    if (!trip || ['offered', 'ended', 'failed', 'ending'].includes(trip.phase)) return;
    await this.end(sessionId, trip.begin.roundTripId, reason);
  }

  async exchanged(sessionId: string): Promise<void> {
    const trip = this.trips.get(sessionId);
    if (!trip || trip.phase === 'ended') return;
    this.live(trip);
    if (trip.phase !== 'returned' && trip.phase !== 'exchanging')
      throw new Error('Round trip exchange out of order');
    await this.end(sessionId, trip.begin.roundTripId, 'approved');
  }

  async end(sessionId: string, id: string, reason: End['reason']): Promise<void> {
    const trip = this.trips.get(sessionId);
    if (!trip || trip.begin.roundTripId !== id) throw new Error('Unknown round trip end');
    if (trip.phase === 'offered') throw new Error('Offered round trip cannot send End');
    if (trip.phase === 'failed') throw new Error('Round trip failed');
    if (trip.phase === 'ended' || trip.phase === 'ending') return;
    const wasReturned = trip.phase === 'returned' || trip.phase === 'exchanging';
    trip.phase = 'ending'; // End wins synchronously, including against a delayed begin/return.
    if (reason !== 'approved') this.fail(trip, reason === 'expired' ? 'expired' : 'rejected');
    const {
      durationMs: _duration,
      mainPid: _pid,
      mainProcessStartTime: _start,
      mainImageIdentity: _image,
      ...binding
    } = trip.begin;
    try {
      const response = await this.send({ ...binding, kind: 'end', reason });
      if (reason !== 'approved') return; // Native keeps refusal/Stop latched, not accepted.
      this.ack(response, trip, 'end_result');
      if (trip.phase !== 'ending') throw new Error('Round trip revoked during end');
      trip.phase = 'ended';
      clearTimeout(trip.timer);
      if (!wasReturned) this.fail(trip, 'rejected');
    } catch (error) {
      this.fail(trip, 'monitor_failed');
      throw error;
    }
  }

  receive(event: WindowsInteractionEvent): void {
    if (event.kind !== 'event') return;
    const trip = this.trips.get(event.sessionId);
    if (!trip || trip.phase === 'failed') return;
    if (!this.matches(trip, event)) {
      // Only the previous card's successful terminal notification may fill this sequence slot.
      if (
        !trip.previousBegin ||
        !this.matches({ begin: trip.previousBegin }, event) ||
        event.state !== 'ended' ||
        event.failureLatched ||
        event.failureReason !== 'none' ||
        event.foreground === 'other'
      )
        return;
      if (event.sequence !== trip.sequence + 1) {
        this.fail(trip, 'monitor_failed');
        return;
      }
      trip.sequence = event.sequence;
      trip.previousBegin = undefined;
      return;
    }
    if (event.state === 'failed' || event.foreground === 'other') {
      this.fail(trip, event.failureReason === 'none' ? 'third_window' : event.failureReason);
      return;
    }
    // The native counter is per session, including the next card of a two-card flow.
    if (
      event.sequence !== trip.sequence + 1 ||
      (event.state === 'ended' &&
        !['exchanging', 'offered', 'ending', 'ended'].includes(trip.phase))
    ) {
      this.fail(trip, 'monitor_failed');
      return;
    }
    trip.sequence = event.sequence;
    if (event.state === 'ended') trip.endedNotified = true;
  }

  private fail(trip: Trip, reason: Extract<Wire, { kind: 'event' }>['failureReason']): void {
    if (trip.phase === 'failed') return;
    trip.phase = 'failed';
    clearTimeout(trip.timer);
    const {
      durationMs: _duration,
      mainPid: _pid,
      mainProcessStartTime: _start,
      mainImageIdentity: _image,
      ...binding
    } = trip.begin;
    this.revoked({
      ...binding,
      kind: 'event',
      sequence: trip.sequence + 1,
      state: 'failed',
      foreground: reason === 'third_window' ? 'other' : 'target',
      failureReason: reason,
      failureLatched: true,
    });
  }
}
