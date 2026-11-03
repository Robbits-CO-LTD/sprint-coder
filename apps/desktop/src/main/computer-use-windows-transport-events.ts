import { z } from 'zod';
import {
  computerUseApprovalRoundTripWireSchema,
  type ComputerUseApprovalRoundTripWire,
} from '@sprint-coder/contracts';

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:-]+$/u);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const backgroundEvent = z
  .object({
    version: z.literal(1),
    kind: z.literal('background_event'),
    sessionId: id,
    taskId: id,
    turnId: id,
    helperGeneration: counter.min(1),
    cancelEpoch: counter,
    interactionEpoch: counter.min(1),
    sequence: counter.min(1),
    state: z.enum(['paused', 'takeover', 'monitor_failed']),
  })
  .strict();
export type WindowsInteractionEvent =
  z.infer<typeof backgroundEvent> | Extract<ComputerUseApprovalRoundTripWire, { kind: 'event' }>;
export type WindowsInteractionListener = (event: WindowsInteractionEvent) => void;
export type WindowsInteractionBinding = Pick<
  WindowsInteractionEvent,
  'sessionId' | 'taskId' | 'turnId' | 'helperGeneration' | 'cancelEpoch'
>;

export function parseWindowsInteractionEvent(value: unknown): WindowsInteractionEvent | null {
  const background = backgroundEvent.safeParse(value);
  if (background.success) return background.data;
  const trip = computerUseApprovalRoundTripWireSchema.safeParse(value);
  return trip.success && trip.data.kind === 'event' ? trip.data : null;
}

type HeldInteractionEvent = Readonly<{ event: WindowsInteractionEvent; generation: number }>;
const MAX_HELD_EVENTS = 8;

/** Authority comes from a successful start/begin, never from an incoming notification. */
export class WindowsInteractionEvents {
  private readonly sessions = new Map<
    string,
    {
      binding: WindowsInteractionBinding;
      sequence: number;
      interactionEpoch: number;
      roundTripId?: string;
      /** Sent but not yet acknowledged; committed only by an accepted begin_result. */
      pendingTrip?: string | undefined;
      usedTrips: Set<string>;
      tripSequence: number;
      tripEnded: boolean;
      revoked: boolean;
    }
  >();
  /**
   * Events read before the acknowledgement they depend on was processed (the start response or a
   * begin_result coalesced in the same pipe read). Replayed through `receive` once it is.
   */
  private readonly held = new Map<string, HeldInteractionEvent[]>();
  /** Sessions whose held queue overflowed: one lost event must still fail them closed. */
  private readonly overflowed = new Set<string>();
  /** Returns the held events that the new binding accepted, in order, for the caller to deliver. */
  bind(binding: WindowsInteractionBinding, interactionEpoch = 0): WindowsInteractionEvent[] {
    const previous = this.sessions.get(binding.sessionId);
    if (
      !previous ||
      binding.helperGeneration !== previous.binding.helperGeneration ||
      binding.cancelEpoch > previous.binding.cancelEpoch
    )
      this.sessions.set(binding.sessionId, {
        binding,
        sequence: 0,
        interactionEpoch,
        usedTrips: new Set(),
        tripSequence: 0,
        tripEnded: false,
        revoked: false,
      });
    if (this.overflowed.delete(binding.sessionId)) {
      // An event was dropped before this binding existed; native will not resend it.
      this.held.delete(binding.sessionId);
      this.sessions.get(binding.sessionId)!.revoked = true;
      return [];
    }
    return this.replay(binding.sessionId, () => true);
  }
  begin(binding: WindowsInteractionBinding, roundTripId: string): boolean {
    const current = this.sessions.get(binding.sessionId);
    if (
      !current ||
      current.revoked ||
      current.pendingTrip !== undefined ||
      current.usedTrips.has(roundTripId) ||
      (current.roundTripId !== undefined && !current.tripEnded) ||
      !this.matches(current.binding, binding)
    )
      return false;
    current.pendingTrip = roundTripId;
    return true;
  }
  /**
   * Settles a `begin`: only an accepted acknowledgement records the id; a refusal or a failed call
   * rolls it back, so a later trip can begin and the previous trip's events stay bound.
   */
  settleBegin(
    sessionId: string,
    roundTripId: string,
    accepted: boolean,
  ): WindowsInteractionEvent[] {
    const current = this.sessions.get(sessionId);
    if (current?.pendingTrip !== roundTripId) return [];
    current.pendingTrip = undefined;
    if (accepted) {
      current.usedTrips.add(roundTripId);
      current.roundTripId = roundTripId;
      current.tripSequence = 0;
      current.tripEnded = false;
    }
    return this.replay(
      sessionId,
      (event) => event.kind !== 'event' || event.roundTripId === roundTripId,
      accepted,
    );
  }
  /**
   * Keeps an event that may precede its acknowledgement: for a start in flight (no binding yet) or
   * for the trip whose begin is in flight. Bounded; anything else is dropped.
   */
  hold(event: WindowsInteractionEvent, generation: number, startPending: boolean): void {
    const current = this.sessions.get(event.sessionId);
    const waiting =
      current === undefined
        ? startPending
        : event.kind === 'event' &&
          current.pendingTrip !== undefined &&
          event.roundTripId === current.pendingTrip;
    if (!waiting) return;
    const queue = this.held.get(event.sessionId) ?? [];
    if (queue.length >= MAX_HELD_EVENTS) {
      if (current === undefined) this.overflowed.add(event.sessionId);
      else current.revoked = true;
      return;
    }
    queue.push({ event, generation });
    this.held.set(event.sessionId, queue);
  }
  blocked(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.revoked === true;
  }
  /** Fail closed for one session (for example a listener that threw while delivering). */
  revoke(sessionId: string): void {
    const current = this.sessions.get(sessionId);
    if (current !== undefined) current.revoked = true;
  }
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.held.delete(sessionId);
    this.overflowed.delete(sessionId);
  }
  /** Whether an event is waiting for a binding that does not exist yet. */
  waitsForBinding(sessionId: string): boolean {
    return (
      !this.sessions.has(sessionId) && (this.held.has(sessionId) || this.overflowed.has(sessionId))
    );
  }
  /** A start that ended without a binding leaves nothing behind for a later start to replay. */
  discardUnbound(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.held.delete(sessionId);
    this.overflowed.delete(sessionId);
  }
  receive(event: WindowsInteractionEvent, generation: number): boolean {
    const current = this.sessions.get(event.sessionId);
    if (
      !current ||
      current.revoked ||
      event.helperGeneration !== generation ||
      !this.matches(current.binding, event)
    )
      return false;
    if (event.kind === 'background_event') {
      if (event.sequence <= current.sequence || event.interactionEpoch < current.interactionEpoch)
        return false;
      current.sequence = event.sequence;
      current.interactionEpoch = event.interactionEpoch;
      current.revoked = true;
    } else {
      if (event.roundTripId !== current.roundTripId || event.sequence <= current.tripSequence)
        return false;
      if (current.tripEnded && event.state === 'active') return false;
      current.tripSequence = event.sequence;
      current.revoked = event.state === 'failed';
      if (event.state === 'ended') current.tripEnded = true;
    }
    return true;
  }
  private replay(
    sessionId: string,
    selects: (event: WindowsInteractionEvent) => boolean,
    deliver = true,
  ): WindowsInteractionEvent[] {
    const queue = this.held.get(sessionId) ?? [];
    const kept = queue.filter((held) => !selects(held.event));
    if (kept.length === 0) this.held.delete(sessionId);
    else this.held.set(sessionId, kept);
    if (!deliver) return [];
    return queue
      .filter((held) => selects(held.event) && this.receive(held.event, held.generation))
      .map((held) => held.event);
  }
  private matches(a: WindowsInteractionBinding, b: WindowsInteractionBinding): boolean {
    return (
      a.sessionId === b.sessionId &&
      a.taskId === b.taskId &&
      a.turnId === b.turnId &&
      a.helperGeneration === b.helperGeneration &&
      a.cancelEpoch === b.cancelEpoch
    );
  }
}
