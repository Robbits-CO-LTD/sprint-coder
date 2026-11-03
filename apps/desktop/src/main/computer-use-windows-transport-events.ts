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

/** Authority comes from a successful start/begin, never from an incoming notification. */
export class WindowsInteractionEvents {
  private readonly sessions = new Map<
    string,
    {
      binding: WindowsInteractionBinding;
      sequence: number;
      interactionEpoch: number;
      roundTripId?: string;
      usedTrips: Set<string>;
      tripSequence: number;
      tripEnded: boolean;
      revoked: boolean;
    }
  >();
  bind(binding: WindowsInteractionBinding, interactionEpoch = 0): void {
    const previous = this.sessions.get(binding.sessionId);
    if (
      previous &&
      binding.helperGeneration === previous.binding.helperGeneration &&
      binding.cancelEpoch <= previous.binding.cancelEpoch
    )
      return;
    this.sessions.set(binding.sessionId, {
      binding,
      sequence: 0,
      interactionEpoch,
      usedTrips: new Set(),
      tripSequence: 0,
      tripEnded: false,
      revoked: false,
    });
  }
  begin(binding: WindowsInteractionBinding, roundTripId: string): boolean {
    const current = this.sessions.get(binding.sessionId);
    if (
      !current ||
      current.revoked ||
      current.usedTrips.has(roundTripId) ||
      (current.roundTripId !== undefined && !current.tripEnded) ||
      !this.matches(current.binding, binding)
    )
      return false;
    current.usedTrips.add(roundTripId);
    current.roundTripId = roundTripId;
    current.tripSequence = 0;
    current.tripEnded = false;
    return true;
  }
  blocked(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.revoked === true;
  }
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
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
