import { describe, expect, it, vi } from 'vitest';
import {
  captureComputerUseRuntime,
  ComputerUseRuntimeCapture,
  computerUseCaptureDigest,
  type ComputerUseRuntimeEvent,
} from './computer-use-runtime-capture';

const sessionDigest = computerUseCaptureDigest('fixture-session');
const bindingDigest = '1'.repeat(64);
const appDigest = 'a'.repeat(64);
const windowDigest = 'b'.repeat(64);
const actionDigest = 'c'.repeat(64);
const observation = (revision: number): ComputerUseRuntimeEvent => ({
  type: 'observation',
  sessionDigest,
  appDigest,
  windowDigest,
  revision,
  imageDigest: 'd'.repeat(64),
  imageBytes: 68,
  treeDigest: 'e'.repeat(64),
  treeBytes: 32,
});

function captureFixture() {
  const capture = new ComputerUseRuntimeCapture();
  capture.start({
    type: 'session',
    sessionDigest,
    appDigest,
    windowDigest,
    manifestDigest: 'f'.repeat(64),
    platform: 'darwin',
  });
  capture.record({ type: 'preflight_started', sessionDigest, bindingDigest, isOpenRouter: false });
  capture.record({ type: 'preflight_passed', sessionDigest, bindingDigest });
  capture.record(observation(1));
  return capture;
}

function roundEvents(round: number): ComputerUseRuntimeEvent[] {
  const requestDigest = computerUseCaptureDigest(`fixture-request-${round}`);
  return [
    { type: 'round_started', sessionDigest, bindingDigest, round, revision: round },
    {
      type: 'parsed',
      sessionDigest,
      bindingDigest,
      round,
      revision: round,
      actionDigest,
      actionClass: 'click',
      responseDigest: '9'.repeat(64),
      responseBytes: 80,
      latencyMs: 15,
    },
    { type: 'native_started', sessionDigest, requestDigest, actionDigest, revision: round },
    {
      type: 'native_finished',
      sessionDigest,
      requestDigest,
      actionDigest,
      revision: round,
      result: 'completed',
    },
    {
      type: 'action_result',
      sessionDigest,
      revision: round,
      actionDigest,
      result: 'completed',
      reasonDigest: computerUseCaptureDigest(''),
    },
    observation(round + 1),
  ];
}

function stop(capture: ComputerUseRuntimeCapture) {
  capture.record({ type: 'stop_requested', sessionDigest, reasonDigest: '8'.repeat(64) });
  capture.record({ type: 'stop_acknowledged', sessionDigest, nativeAcknowledged: true });
}

describe('Computer Use runtime observation (unit fixtures are never acceptance)', () => {
  it('accepts multiple scalar dispatches in one canonical typing round', () => {
    const capture = captureFixture();
    for (let round = 1; round <= 3; round++) {
      const events = roundEvents(round);
      if (round === 1) {
        const parsed = events[1]!;
        if (parsed.type === 'parsed') parsed.actionClass = 'type';
        events.splice(
          4,
          0,
          {
            type: 'native_started',
            sessionDigest,
            requestDigest: '7'.repeat(64),
            actionDigest,
            revision: 1,
          },
          {
            type: 'native_finished',
            sessionDigest,
            requestDigest: '7'.repeat(64),
            actionDigest,
            revision: 1,
            result: 'completed',
          },
        );
      }
      events.forEach((event) => capture.record(event));
    }
    stop(capture);
    expect(capture.snapshot().exactThreeRoundJourneyObserved).toBe(true);
    expect(capture.snapshot().events.filter(({ type }) => type === 'native_started')).toHaveLength(
      4,
    );
    expect(capture.snapshot().roundsCompleted).toBe(3);
  });
  it('derives exact-three observations without granting package, privacy, or final-gate authority', () => {
    const capture = captureFixture();
    for (let round = 1; round <= 3; round++)
      roundEvents(round).forEach((event) => capture.record(event));
    stop(capture);
    expect(capture.snapshot()).toMatchObject({
      exactThreeRoundJourneyObserved: true,
      roundsAttempted: 3,
      roundsCompleted: 3,
      finalGateEligible: false,
      physicalInputCount: null,
      packageSignerSourceVerified: false,
      persistenceSurfacesInspected: false,
    });
  });

  it.each([
    'missing-update',
    'fourth-round',
    'repeated-round',
    'changed-binding',
    'changed-window',
    'rejected',
    'unknown-effect',
    'unparsed-action',
    'no-native-call',
    'wrong-native-action',
    'wrong-native-revision',
    'stop-before-update',
  ])('does not accept %s', (scenario) => {
    const capture = captureFixture();
    for (let round = 1; round <= 3; round++) {
      let events = roundEvents(round);
      if (round === 3) {
        if (scenario === 'missing-update') events = events.slice(0, -1);
        if (scenario === 'unparsed-action')
          events = events.filter((event) => event.type !== 'parsed');
        if (scenario === 'no-native-call')
          events = events.filter((event) => !event.type.startsWith('native_'));
        events = events.map((event): ComputerUseRuntimeEvent => {
          if (scenario === 'repeated-round' && event.type === 'round_started')
            return { ...event, round: 2 };
          if (scenario === 'changed-binding' && event.type === 'parsed')
            return { ...event, bindingDigest: '7'.repeat(64) };
          if (scenario === 'changed-window' && event.type === 'observation')
            return { ...event, windowDigest: '7'.repeat(64) };
          if (scenario === 'rejected' && event.type === 'action_result')
            return { ...event, result: 'rejected' };
          if (scenario === 'unknown-effect' && event.type === 'native_finished')
            return { ...event, result: 'unknown_effect' };
          if (scenario === 'wrong-native-action' && event.type === 'native_started')
            return { ...event, actionDigest: '7'.repeat(64) };
          if (scenario === 'wrong-native-revision' && event.type === 'native_finished')
            return { ...event, revision: 1 };
          return event;
        });
        if (scenario === 'stop-before-update') stop(capture);
      }
      events.forEach((event) => capture.record(event));
    }
    if (scenario === 'fourth-round') roundEvents(4).forEach((event) => capture.record(event));
    stop(capture);
    expect(capture.snapshot().exactThreeRoundJourneyObserved).toBe(false);
  });

  it('marks native calls after Stop and does not equate calls with physical input', () => {
    const capture = captureFixture();
    stop(capture);
    capture.record({
      type: 'native_started',
      sessionDigest,
      requestDigest: '2'.repeat(64),
      actionDigest,
      revision: 1,
    });
    expect(capture.snapshot()).toMatchObject({
      nativeDispatchesAfterStop: 1,
      physicalInputCount: null,
      exactThreeRoundJourneyObserved: false,
    });
  });

  it('records bounded egress consent and cost bound metadata but no policy body', () => {
    const capture = captureFixture();
    capture.record({ type: 'egress_authorized', sessionDigest, egressDigest: '5'.repeat(64) });
    capture.record({
      type: 'cost_limit_bound',
      sessionDigest,
      costLimitDigest: '6'.repeat(64),
      maxRounds: 25,
    });
    expect(capture.snapshot().invalid).toBe(false);
    expect(capture.snapshot().events.map(({ type }) => type)).toEqual([
      'session',
      'preflight_started',
      'preflight_passed',
      'observation',
      'egress_authorized',
      'cost_limit_bound',
    ]);
  });

  it.each(['missing-cost-limit', 'body-bearing-egress', 'unbounded-cost'])(
    'invalidates malformed consent and cost metadata: %s',
    (kind) => {
      const capture = captureFixture();
      capture.record(
        (kind === 'missing-cost-limit'
          ? { type: 'cost_limit_bound', sessionDigest, costLimitDigest: '6'.repeat(64) }
          : kind === 'body-bearing-egress'
            ? {
                type: 'egress_authorized',
                sessionDigest,
                egressDigest: '5'.repeat(64),
                prompt: 'PRIVATE_FIXTURE_PROMPT',
              }
            : {
                type: 'cost_limit_bound',
                sessionDigest,
                costLimitDigest: '6'.repeat(64),
                maxRounds: -1,
              }) as unknown as ComputerUseRuntimeEvent,
      );
      expect(capture.snapshot().invalid).toBe(true);
      expect(JSON.stringify(capture.snapshot())).not.toContain('PRIVATE_FIXTURE_PROMPT');
    },
  );

  it('accepts optional measured binding identity on preflight without requiring it', () => {
    const capture = new ComputerUseRuntimeCapture();
    capture.start({
      type: 'session',
      sessionDigest,
      appDigest,
      windowDigest,
      manifestDigest: 'f'.repeat(64),
      platform: 'darwin',
    });
    capture.record({
      type: 'preflight_started',
      sessionDigest,
      bindingDigest,
      isOpenRouter: false,
      connectionIdDigest: '1'.repeat(64),
      modelIdDigest: '2'.repeat(64),
      endpointDigest: '3'.repeat(64),
      catalogDigest: '4'.repeat(64),
      policyEpoch: 7,
      selectedFromCurrentTask: true,
      fallbackUsed: false,
      credentialChanged: false,
    });
    expect(capture.snapshot().invalid).toBe(false);
    // The existing emitter omits every identity field; that must stay valid until it is wired.
    const bare = captureFixture();
    expect(bare.snapshot().invalid).toBe(false);
  });

  it('detaches inputs/snapshots, rejects body-bearing fields, and stays bounded', () => {
    const capture = captureFixture();
    const event = observation(2);
    capture.record(event);
    event.sessionDigest = '0'.repeat(64);
    capture.snapshot().events.length = 0;
    expect(capture.snapshot().events.at(-1)?.sessionDigest).toBe(sessionDigest);
    const unexpected = { ...observation(3), rawBody: 'PRIVATE_FIXTURE_BODY' };
    capture.record(unexpected);
    expect(JSON.stringify(capture.snapshot())).not.toContain('PRIVATE_FIXTURE_BODY');
    for (let index = 0; index < 200; index++) capture.record(observation(index + 4));
    expect(capture.snapshot().events.length).toBeLessThanOrEqual(128);
    expect(capture.snapshot().events.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(JSON.stringify(capture.snapshot()))).toBeLessThan(64 * 1024);
    expect(capture.snapshot().invalid).toBe(true);
  });

  it('marks an observer exception invalid without propagating it, and erases previous session state', () => {
    const capture = captureFixture();
    const record = vi.spyOn(capture, 'record').mockImplementationOnce(() => {
      throw new Error('PRIVATE_FIXTURE_ERROR');
    });
    expect(() =>
      captureComputerUseRuntime(capture, (sink) => sink.record(observation(2))),
    ).not.toThrow();
    expect(capture.snapshot().invalid).toBe(true);
    expect(JSON.stringify(capture.snapshot())).not.toContain('PRIVATE_FIXTURE_ERROR');
    record.mockRestore();
    const next = computerUseCaptureDigest('next-session');
    capture.start({
      type: 'session',
      sessionDigest: next,
      appDigest,
      windowDigest,
      manifestDigest: 'f'.repeat(64),
      platform: 'darwin',
    });
    expect(capture.snapshot().events).toHaveLength(1);
    expect(JSON.stringify(capture.snapshot())).not.toContain(sessionDigest);
    expect(capture.snapshot().invalid).toBe(false);
  });
});
