import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ComputerUseAction, ComputerUseObservation } from '@sprint-coder/contracts';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = { sessionDigest: digest };
const eventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('session'),
      inputAttemptCount: integer.optional(),
      cancelEpoch: integer.optional(),
      platform: z.enum(['darwin', 'win32']),
      appDigest: digest,
      windowDigest: digest,
      manifestDigest: digest,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('preflight_started'),
      bindingDigest: digest,
      isOpenRouter: z.boolean(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('preflight_passed'), bindingDigest: digest }).strict(),
  z
    .object({
      ...base,
      type: z.literal('round_started'),
      round: integer,
      revision: integer,
      bindingDigest: digest,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('parsed'),
      round: integer,
      revision: integer,
      bindingDigest: digest,
      actionDigest: digest,
      actionClass: z.enum([
        'invoke',
        'set_text',
        'select',
        'toggle',
        'expand_collapse',
        'scroll',
        'click',
        'type',
        'key',
        'wait',
        'finish',
      ]),
      responseDigest: digest,
      responseBytes: integer,
      latencyMs: integer,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('observation'),
      appDigest: digest,
      windowDigest: digest,
      revision: integer,
      imageDigest: digest,
      imageBytes: integer,
      treeDigest: digest,
      treeBytes: integer,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('action_result'),
      revision: integer,
      actionDigest: digest,
      result: z.enum(['completed', 'rejected', 'paused', 'unknown_effect', 'canceled']),
      reasonDigest: digest,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('native_started'),
      requestDigest: digest,
      actionDigest: digest,
      revision: integer,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('native_finished'),
      inputAttemptCount: integer.optional(),
      cancelEpoch: integer.optional(),
      requestDigest: digest,
      actionDigest: digest,
      revision: integer,
      result: z.enum(['completed', 'rejected', 'paused', 'unknown_effect', 'canceled']),
    })
    .strict(),
  z.object({ ...base, type: z.literal('stop_requested'), reasonDigest: digest }).strict(),
  z
    .object({
      ...base,
      type: z.literal('stop_acknowledged'),
      nativeAcknowledged: z.boolean(),
      inputAttemptCount: integer.optional(),
      cancelEpoch: integer.optional(),
    })
    .strict(),
]);

export type ComputerUseRuntimeEvent = z.infer<typeof eventSchema>;

export function computerUseCaptureDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Instrumentation must never acquire control over a product operation, including Stop. */
export function captureComputerUseRuntime(
  capture: ComputerUseRuntimeCapture | undefined,
  observe: (capture: ComputerUseRuntimeCapture) => void,
): void {
  if (capture === undefined) return;
  try {
    observe(capture);
  } catch {
    try {
      capture.invalidate();
    } catch {
      /* A broken observer has no product authority. */
    }
  }
}

/**
 * Main-only observation of actual planner/Broker/native calls. This is deliberately not an
 * attestation API: injected runtimes in tests can produce the same events. No import/replay,
 * disk writer, IPC endpoint, PASS setter, or machine-transcript conversion is provided.
 * The protected collector must still independently bind package bytes/signers/source and
 * inspect physical input and persistence surfaces before any final-gate claim is possible.
 */
export class ComputerUseRuntimeCapture {
  private events: ComputerUseRuntimeEvent[] = [];
  private invalid = false;
  private sessionDigest: string | null = null;
  private eventBytes = 0;

  invalidate(): void {
    this.invalid = true;
  }

  /** A new user-initiated session replaces the previous bounded, ephemeral capture. */
  start(event: Extract<ComputerUseRuntimeEvent, { type: 'session' }>): void {
    this.events = [];
    this.invalid = false;
    this.eventBytes = 0;
    this.sessionDigest = null;
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success || parsed.data.type !== 'session') {
      this.invalid = true;
      return;
    }
    this.sessionDigest = parsed.data.sessionDigest;
    this.record(event);
  }

  record(input: ComputerUseRuntimeEvent): void {
    const parsed = eventSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.sessionDigest !== this.sessionDigest ||
      this.events.length >= 128
    ) {
      this.invalid = true;
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
    if (this.eventBytes + bytes > 56 * 1024) {
      this.invalid = true;
      return;
    }
    this.eventBytes += bytes;
    // safeParse produces a detached, allowlisted object; never retain caller-owned payloads.
    this.events.push(parsed.data);
  }

  observe(observation: ComputerUseObservation): void {
    this.record({
      type: 'observation',
      sessionDigest: computerUseCaptureDigest(observation.sessionId),
      appDigest: observation.appIdentityDigest,
      windowDigest: observation.windowIdentityDigest,
      revision: observation.revision,
      imageDigest: observation.images[0]?.digest ?? '0'.repeat(64),
      imageBytes: observation.images[0]?.byteLength ?? 0,
      treeDigest: observation.treeDigest ?? '0'.repeat(64),
      treeBytes: observation.treeByteLength,
    });
  }

  actionResult(
    sessionId: string,
    revision: number,
    action: ComputerUseAction,
    result: Extract<ComputerUseRuntimeEvent, { type: 'action_result' }>['result'],
    reason: string | null,
  ): void {
    this.record({
      type: 'action_result',
      sessionDigest: computerUseCaptureDigest(sessionId),
      revision,
      actionDigest: computerUseCaptureDigest(JSON.stringify(action)),
      result,
      reasonDigest: computerUseCaptureDigest(reason ?? ''),
    });
  }

  snapshot() {
    const events = structuredClone(this.events);
    const session = events.find((event) => event.type === 'session');
    const preflights = events.filter((event) => event.type === 'preflight_started');
    const permits = events.filter((event) => event.type === 'preflight_passed');
    const starts = events.filter((event) => event.type === 'round_started');
    const binding = preflights[0]?.bindingDigest;
    let consistent =
      !this.invalid &&
      session !== undefined &&
      preflights.length === 1 &&
      permits.length === 1 &&
      !preflights[0]!.isOpenRouter &&
      permits[0]!.bindingDigest === binding;
    if (events.filter((event) => event.type === 'session').length !== 1) consistent = false;
    let stage: 'preflight' | 'observe' | 'plan' | 'action' | 'update' | 'stopped' = 'preflight';
    let revision = 0;
    let round = 0;
    let completed = 0;
    let actionDigest: string | null = null;
    let stopAcknowledged = false;
    let nativeInFlight = 0;
    let nativeCompletionsForAction = 0;
    let dispatchesAfterStop = 0;
    let stopping = false;
    let nativeAttemptCount: number | null = session?.inputAttemptCount ?? null;
    const nativeRequests = new Set<string>();
    const seenNativeRequests = new Set<string>();
    for (const event of events) {
      if ('bindingDigest' in event && event.bindingDigest !== binding) consistent = false;
      switch (event.type) {
        case 'preflight_started':
          if (stage !== 'preflight') consistent = false;
          break;
        case 'preflight_passed':
          if (stage !== 'preflight') consistent = false;
          stage = 'observe';
          break;
        case 'observation':
          if (
            event.appDigest !== session?.appDigest ||
            event.windowDigest !== session?.windowDigest ||
            event.revision <= revision ||
            event.imageBytes === 0 ||
            stopping
          )
            consistent = false;
          if (stage === 'update') {
            completed += 1;
            stage = 'observe';
          } else if (stage !== 'observe') consistent = false;
          revision = event.revision;
          break;
        case 'round_started':
          if (
            stage !== 'observe' ||
            revision === 0 ||
            event.revision !== revision ||
            event.round !== round + 1 ||
            event.round > 3 ||
            stopping
          )
            consistent = false;
          round = event.round;
          stage = 'plan';
          break;
        case 'parsed':
          if (
            stage !== 'plan' ||
            event.round !== round ||
            event.revision !== revision ||
            event.actionClass === 'wait' ||
            event.actionClass === 'finish' ||
            stopping
          )
            consistent = false;
          actionDigest = event.actionDigest;
          nativeCompletionsForAction = 0;
          stage = 'action';
          break;
        case 'action_result':
          if (
            stage !== 'action' ||
            event.revision !== revision ||
            event.actionDigest !== actionDigest ||
            event.result !== 'completed' ||
            nativeCompletionsForAction === 0 ||
            nativeInFlight !== 0 ||
            stopping
          )
            consistent = false;
          stage = 'update';
          break;
        case 'native_started':
          if (stopping) dispatchesAfterStop += 1;
          if (
            stage !== 'action' ||
            seenNativeRequests.has(event.requestDigest) ||
            event.actionDigest !== actionDigest ||
            event.revision !== revision
          )
            consistent = false;
          nativeRequests.add(event.requestDigest);
          seenNativeRequests.add(event.requestDigest);
          nativeInFlight += 1;
          break;
        case 'native_finished':
          if (event.inputAttemptCount !== undefined) {
            if (nativeAttemptCount !== null && event.inputAttemptCount < nativeAttemptCount)
              consistent = false;
            nativeAttemptCount = event.inputAttemptCount;
          }
          if (
            !nativeRequests.delete(event.requestDigest) ||
            nativeInFlight === 0 ||
            event.result !== 'completed' ||
            event.actionDigest !== actionDigest ||
            event.revision !== revision
          )
            consistent = false;
          nativeInFlight -= 1;
          if (event.result === 'completed') nativeCompletionsForAction += 1;
          break;
        case 'stop_requested':
          stopping = true;
          if (stage !== 'observe') consistent = false;
          stage = 'stopped';
          break;
        case 'stop_acknowledged':
          if (event.inputAttemptCount !== undefined) {
            if (nativeAttemptCount !== null && event.inputAttemptCount < nativeAttemptCount)
              consistent = false;
            nativeAttemptCount = event.inputAttemptCount;
          }
          if (!stopping || stopAcknowledged || !event.nativeAcknowledged || nativeInFlight !== 0)
            consistent = false;
          stopAcknowledged = true;
          break;
      }
    }
    return {
      schemaVersion: 1 as const,
      evidenceKind: 'runtime-observation-only' as const,
      finalGateEligible: false as const,
      exactThreeRoundJourneyObserved:
        consistent &&
        starts.length === 3 &&
        completed === 3 &&
        stopAcknowledged &&
        dispatchesAfterStop === 0,
      roundsAttempted: starts.length,
      roundsCompleted: completed,
      nativeDispatchesAfterStop: dispatchesAfterStop,
      physicalInputCount: null,
      osInputApiAttemptCount: nativeAttemptCount,
      packageSignerSourceVerified: false,
      persistenceSurfacesInspected: false,
      invalid: this.invalid,
      events,
      eventsDigest: computerUseCaptureDigest(JSON.stringify(events)),
    };
  }
}
