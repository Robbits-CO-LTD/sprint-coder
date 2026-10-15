import { describe, expect, it, vi } from 'vitest';
import type { ComputerUseNativeBinding } from './computer-use-native';
import type { ComputerAppProfileRecord } from './persistence';
import { createComputerUseNativeHost } from './computer-use-native-host';
import type { ComputerUseNativeHost, ComputerUseNativeSession } from './computer-use-controller';

// The Main adapter side of the native approval path (ADR v2 S4-4 addendum, sections 0, 4 and 6),
// driven through a fake macOS addon. The path is closed unless the handshake confirmed classifier
// v2, which no production host does yet.

const zero = (digit: string): string => digit.repeat(64);
const identityDigest = zero('a');
const ticket = 'ab'.repeat(32);

const profile = {
  id: 'profile-1',
  platform: 'darwin',
  kind: 'macos-bundle',
  label: 'Target',
  canonicalPath: '/Applications/Target.app/Contents/MacOS/Target',
  appUrl: null,
  identity: {
    platform: 'darwin',
    kind: 'macos-bundle',
    displayName: 'Target',
    canonicalPath: '/Applications/Target.app/Contents/MacOS/Target',
    identityDigest,
    executableDigest: zero('b'),
    policyLanguage: 'en',
    maximumMode: 'full_access_app',
  },
  identityDigest,
  version: null,
  executableDigest: zero('b'),
  mode: 'full_access_app',
  connectionId: 'connection-1',
  modelId: 'model-1',
  providerEgressConsent: true,
  remember: false,
  revision: 1,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
} as unknown as ComputerAppProfileRecord;

type Calls = Record<string, ReturnType<typeof vi.fn>>;

function build(
  options: { attested?: boolean; omit?: readonly string[]; platform?: 'darwin' | 'win32' } = {},
  overrides: Record<string, (input: Record<string, unknown>) => unknown> = {},
) {
  const calls: Calls = {};
  const fn = (name: string, impl: (input: Record<string, unknown>) => unknown) => {
    calls[name] = vi.fn((input: unknown) => impl(input as Record<string, unknown>));
    return calls[name]!;
  };
  const baseReceipt = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    decision: 'ordinary',
    reasonCode: null,
    deniedResult: null,
    ticket,
    classifierVersion: 1,
    inputAttemptCount: 0,
    requestId: input['requestId'],
    sessionId: input['sessionId'],
    cancelEpoch: input['cancelEpoch'],
    observationRevision: input['observationRevision'],
    ...extra,
  });
  const result = (input: Record<string, unknown>) => ({
    result: 'completed',
    reasonCode: null,
    accepted: true,
    effectStarted: true,
    requestId: input['requestId'],
    sessionId: input['sessionId'],
    observationRevision: input['observationRevision'],
    actionDigest: input['actionDigest'],
    cancelEpoch: input['cancelEpoch'],
    inputAttemptCount: 1,
  });
  const methods: Record<string, unknown> = {
    probe: () => ({}),
    pickApplication: () => null,
    listWindows: fn('listWindows', () => [
      {
        pid: 42,
        windowId: 'window-1',
        platform: 'darwin',
        appIdentityDigest: identityDigest,
        windowIdentityDigest: zero('d'),
        executableDigest: zero('b'),
        title: 'Target',
        bounds: { x: 0, y: 0, width: 100, height: 80 },
        screenBounds: { x: 0, y: 0, width: 100, height: 80 },
        focused: true,
        eligible: true,
        ownerKind: 'application',
        modal: false,
        revision: 1,
        policyLanguage: 'en',
        maximumMode: 'full_access_app',
      },
    ]),
    startSession: fn('startSession', (input) => ({
      inputAttemptCount: 0,
      sessionId: input['sessionId'],
      platform: 'darwin',
      appIdentityDigest: identityDigest,
      windowIdentityDigest: zero('d'),
      windowId: 'window-1',
      profileRevision: 1,
      cancelEpoch: 0,
      policyLanguage: 'en',
      maximumMode: 'full_access_app',
      screenBounds: { x: 0, y: 0, width: 100, height: 80 },
      pid: 42,
    })),
    observe: () => ({}),
    preflight: fn('preflight', (input) => (overrides['preflight'] ?? baseReceipt)(input)),
    approvalApprove: fn('approvalApprove', (input) =>
      (
        overrides['approvalApprove'] ??
        ((i) => ({
          ok: true,
          reasonCode: null,
          deniedResult: null,
          sessionId: i['sessionId'],
          requestId: i['requestId'],
          cancelEpoch: i['cancelEpoch'],
          observationRevision: i['observationRevision'],
          approvalGeneration: i['approvalGeneration'],
          inputAttemptCount: 0,
        }))
      )(input),
    ),
    approvalDiscard: fn('approvalDiscard', (input) =>
      (overrides['approvalDiscard'] ?? ((i) => ({ discarded: true, ...i })))(input),
    ),
    dispatchApproved: fn('dispatchApproved', (input) =>
      (overrides['dispatchApproved'] ?? result)(input),
    ),
    dispatch: fn('dispatch', (input) => (overrides['dispatch'] ?? result)(input)),
    cancel: () => undefined,
    close: fn('close', (i) => ({
      result: 'closed',
      drained: true,
      sessionId: i['sessionId'],
      cancelEpoch: i['cancelEpoch'],
      inputAttemptCount: 0,
    })),
  };
  // A test may replace how the fake native starts or closes a session.
  for (const name of ['startSession', 'close'] as const) {
    const replacement = overrides[name];
    if (replacement !== undefined) methods[name] = fn(name, replacement);
  }
  for (const name of options.omit ?? []) delete methods[name];
  const platform = options.platform ?? 'darwin';
  const binding = {
    manifest: {
      version: 1,
      sourceCommit: 'f'.repeat(40),
      platform,
      architecture: 'arm64',
      protocolVersion: 1,
      apiVersion: 2,
      nativeVersion: 'test-native',
      moduleDigest: zero('1'),
      binaryDigest: zero('2'),
      signerDigest: zero('3'),
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
    },
    probe: {
      available: true,
      protocolVersion: 1,
      apiVersion: 2,
      backend: 'test-native',
      reason: '',
      artifactPath: '/Resources/sprint_coder_computer_use_native.node',
      artifactDigest: zero('1'),
      capabilities: { observe: true, control: true },
    },
    artifactPath: '/Resources/sprint_coder_computer_use_native.node',
    addon: methods,
  } as unknown as ComputerUseNativeBinding;
  const host = createComputerUseNativeHost(binding, platform, {
    ...(options.attested === undefined ? {} : { classifierV2Attested: options.attested }),
  });
  return { host, calls, baseReceipt };
}

async function sessionOf(host: ComputerUseNativeHost): Promise<ComputerUseNativeSession> {
  await host.listWindows(profile);
  return host.startSession({
    profile,
    windowId: 'window-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    cancelEpoch: 0,
    // C5-1: an approval is asked about a session bound to route v2 (the attest decides whether the
    // native is bound to it); a session with no binding has none.
    classifierRoute: 'v2',
  });
}

const action = { type: 'click', x: 0.5, y: 0.5, button: 'left' } as const;
const request = (session: ComputerUseNativeSession, requestId: string, extra = {}) => ({
  session,
  requestId,
  action,
  observationRevision: 1,
  cancelEpoch: 0,
  signal: new AbortController().signal,
  ...extra,
});

describe('Computer Use native host: approval path', () => {
  it('opens only for an attested classifier v2, a complete addon, on macOS', async () => {
    // Production never attests (there is no D7), so the path is closed however complete the addon.
    const opens = async (options: Parameters<typeof build>[0]): Promise<boolean> => {
      const built = build(options);
      const session = await sessionOf(built.host);
      return built.host.nativeApprovalPathEnabled?.(session.sessionId) === true;
    };
    expect(await opens({})).toBe(false);
    expect(await opens({ attested: false })).toBe(false);
    expect(await opens({ attested: true })).toBe(true);
    for (const missing of ['preflight', 'approvalApprove', 'approvalDiscard', 'dispatchApproved'])
      expect(await opens({ attested: true, omit: [missing] }), missing).toBe(false);
    // A session the host knows nothing about is closed, whatever the build attests.
    expect(build({ attested: true }).host.nativeApprovalPathEnabled?.('no-such-session')).toBe(
      false,
    );
  });

  it('answers approvalApprove with typed results and never throws for a pre-input failure', async () => {
    const open = build({ attested: true });
    const session = await sessionOf(open.host);
    await expect(
      open.host.approvalApprove!({ ...request(session, 'r-1'), approvalGeneration: 5 }),
    ).resolves.toEqual({ kind: 'approved' });
    expect(open.calls['approvalApprove']).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'r-1', approvalGeneration: 5, sessionId: 'session-1' }),
    );
    expect(open.calls['approvalApprove']!.mock.calls[0]![0]).not.toHaveProperty('ticket');
    // A refusal keeps the native result and reason; Main maps them to fixed codes later.
    const refusing = build(
      { attested: true },
      {
        approvalApprove: (i) => ({
          ok: false,
          reasonCode: 'native_target_unclassified',
          deniedResult: 'paused',
          sessionId: i['sessionId'],
          requestId: i['requestId'],
          cancelEpoch: i['cancelEpoch'],
          observationRevision: i['observationRevision'],
          approvalGeneration: i['approvalGeneration'],
          inputAttemptCount: 0,
        }),
      },
    );
    await expect(
      refusing.host.approvalApprove!({
        ...request(await sessionOf(refusing.host), 'r-2'),
        approvalGeneration: 5,
      }),
    ).resolves.toEqual({
      kind: 'refused',
      result: 'paused',
      reasonCode: 'native_target_unclassified',
    });
    // A receipt that cannot be trusted, a throw and a closed path are all values, not exceptions.
    const invalid = build({ attested: true }, { approvalApprove: () => ({ ok: true }) });
    await expect(
      invalid.host.approvalApprove!({
        ...request(await sessionOf(invalid.host), 'r-3'),
        approvalGeneration: 5,
      }),
    ).resolves.toMatchObject({ kind: 'invalid', reasonCode: 'native_approval_receipt_invalid' });
    const throwing = build(
      { attested: true },
      {
        approvalApprove: () => {
          throw new Error('boom');
        },
      },
    );
    await expect(
      throwing.host.approvalApprove!({
        ...request(await sessionOf(throwing.host), 'r-4'),
        approvalGeneration: 5,
      }),
    ).resolves.toMatchObject({ kind: 'refused', reasonCode: 'native_approval_approve_failed' });
    const closed = build({});
    await expect(
      closed.host.approvalApprove!({
        ...request(await sessionOf(closed.host), 'r-5'),
        approvalGeneration: 5,
      }),
    ).resolves.toMatchObject({ kind: 'refused', result: 'rejected' });
    expect(closed.calls['approvalApprove']).not.toHaveBeenCalled();
  });

  it('answers a regressed count or a missing session as a pre-input result, never an exception', async () => {
    let count = 5;
    const open = build(
      { attested: true },
      {
        approvalApprove: (i) => ({
          ok: true,
          reasonCode: null,
          deniedResult: null,
          sessionId: i['sessionId'],
          requestId: i['requestId'],
          cancelEpoch: i['cancelEpoch'],
          observationRevision: i['observationRevision'],
          approvalGeneration: i['approvalGeneration'],
          inputAttemptCount: count,
        }),
      },
    );
    const session = await sessionOf(open.host);
    await expect(
      open.host.approvalApprove!({ ...request(session, 'g-1'), approvalGeneration: 5 }),
    ).resolves.toEqual({ kind: 'approved' });
    count = 2;
    await expect(
      open.host.approvalApprove!({ ...request(session, 'g-2'), approvalGeneration: 5 }),
    ).resolves.toMatchObject({ kind: 'invalid', reasonCode: 'native_approval_receipt_invalid' });
    await expect(
      open.host.approvalApprove!({
        ...request({ ...session, sessionId: 'unknown-session' }, 'g-3'),
        approvalGeneration: 5,
      }),
    ).resolves.toMatchObject({ kind: 'refused', result: 'rejected' });
  });

  it('discards exactly the named generation and swallows every failure', async () => {
    const open = build({ attested: true });
    const session = await sessionOf(open.host);
    await expect(
      open.host.approvalDiscard!({ session, approvalGeneration: 9 }),
    ).resolves.toBeUndefined();
    expect(open.calls['approvalDiscard']).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', approvalGeneration: 9 }),
    );
    const throwing = build(
      { attested: true },
      {
        approvalDiscard: () => {
          throw new Error('gone');
        },
      },
    );
    await expect(
      throwing.host.approvalDiscard!({
        session: await sessionOf(throwing.host),
        approvalGeneration: 9,
      }),
    ).resolves.toBeUndefined();
  });

  it('sends dispatchApproved the generation and no ticket, and validates its result like dispatch', async () => {
    const open = build({ attested: true });
    const session = await sessionOf(open.host);
    await expect(
      open.host.dispatchApproved!({ ...request(session, 'r-6'), approvalGeneration: 5 }),
    ).resolves.toMatchObject({ result: 'completed' });
    const sent = open.calls['dispatchApproved']!.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ requestId: 'r-6', approvalGeneration: 5 });
    expect(sent).not.toHaveProperty('ticket');
    expect(open.calls['preflight']).not.toHaveBeenCalled();
    expect(open.calls['dispatch']).not.toHaveBeenCalled();
    // An envelope that does not echo the request is an exception (the caller books unknown_effect).
    const wrong = build(
      { attested: true },
      { dispatchApproved: (i) => ({ ...(i as object), result: 'completed', reasonCode: null }) },
    );
    await expect(
      wrong.host.dispatchApproved!({
        ...request(await sessionOf(wrong.host), 'r-7'),
        approvalGeneration: 5,
      }),
    ).rejects.toThrow();
    // Closed path: refuses before native is called.
    const closed = build({});
    await expect(
      closed.host.dispatchApproved!({
        ...request(await sessionOf(closed.host), 'r-8'),
        approvalGeneration: 5,
      }),
    ).rejects.toThrow();
    expect(closed.calls['dispatchApproved']).not.toHaveBeenCalled();
  });

  it('refuses an ordinary preflight for a target Main judged high-impact, with no input', async () => {
    // A session bound to route v2 expects classifier 2 in every receipt.
    const ordinaryAtTwo = (input: Record<string, unknown>) => ({
      decision: 'ordinary',
      reasonCode: null,
      deniedResult: null,
      ticket,
      classifierVersion: 2,
      inputAttemptCount: 0,
      requestId: input['requestId'],
      sessionId: input['sessionId'],
      cancelEpoch: input['cancelEpoch'],
      observationRevision: input['observationRevision'],
    });
    const open = build({ attested: true }, { preflight: ordinaryAtTwo });
    const session = await sessionOf(open.host);
    await expect(
      open.host.dispatch(request(session, 'd-1', { mainHighImpact: true })),
    ).resolves.toMatchObject({ result: 'paused', reasonCode: 'hard_boundary' });
    expect(open.calls['preflight']).toHaveBeenCalledTimes(1);
    expect(open.calls['dispatch']).not.toHaveBeenCalled();
    // Without the flag an ordinary receipt still dispatches with its ticket.
    await expect(open.host.dispatch(request(session, 'd-2'))).resolves.toMatchObject({
      result: 'completed',
    });
    expect(open.calls['dispatch']).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'd-2', ticket }),
    );
    // Closed path: the flag is never set by Main, and a host that is not attested ignores it.
    const closed = build({});
    await expect(
      closed.host.dispatch(request(await sessionOf(closed.host), 'd-3', { mainHighImpact: true })),
    ).resolves.toMatchObject({ result: 'completed' });
  });
});

// C3: the classifier route a session is bound to decides which classifierVersion Main accepts.
describe('Computer Use native host: classifier route (C3)', () => {
  type Route = 'v1' | 'v2';
  const startWith = async (host: ComputerUseNativeHost, route?: Route, sessionId = 'session-1') => {
    await host.listWindows(profile);
    return host.startSession({
      profile,
      windowId: 'window-1',
      sessionId,
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
      ...(route === undefined ? {} : { classifierRoute: route }),
    });
  };
  const withClassifier =
    (classifierVersion: number, extra: Record<string, unknown> = {}) =>
    (input: Record<string, unknown>) => ({
      decision: 'ordinary',
      reasonCode: null,
      deniedResult: null,
      ticket,
      classifierVersion,
      inputAttemptCount: 0,
      requestId: input['requestId'],
      sessionId: input['sessionId'],
      cancelEpoch: input['cancelEpoch'],
      observationRevision: input['observationRevision'],
      ...extra,
    });
  const offerReceipt = (input: Record<string, unknown>) => ({
    ...withClassifier(2, { receiptVersion: 2 })(input),
    decision: 'single_use_approval',
    ticket: null,
    approvalGeneration: 3,
    remainingMs: 30_000,
    effect: 'supervised_action',
  });
  const run = async (
    options: { attested?: boolean },
    route: Route | undefined,
    preflight: (input: Record<string, unknown>) => unknown,
  ) => {
    const built = build(options, { preflight });
    const session = await startWith(built.host, route);
    return { built, session, result: await built.host.dispatch(request(session, 'c-1')) };
  };
  const invalid = { result: 'rejected', reasonCode: 'native_preflight_invalid' };

  it('keeps a v1 route exactly as before: classifier 1 passes, anything else is invalid', async () => {
    const ok = await run({ attested: true }, 'v1', withClassifier(1));
    expect(ok.result).toMatchObject({ result: 'completed' });
    expect(ok.built.calls['dispatch']).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'c-1', ticket }),
    );
    // Golden: the same receipt on an unbound session gives the same outcome.
    const unbound = await run({ attested: true }, undefined, withClassifier(1));
    expect(unbound.result).toEqual(ok.result);
    // A receipt that claims classifier 2 is not what this route expects, even when well formed.
    const wrong = await run({ attested: true }, 'v1', withClassifier(2));
    expect(wrong.result).toMatchObject(invalid);
    expect(wrong.built.calls['dispatch']).not.toHaveBeenCalled();
    // And a v2 approval offer never reaches a v1-route session.
    const offer = await run({ attested: true }, 'v1', offerReceipt);
    expect(offer.result).toMatchObject(invalid);
    expect(offer.result).not.toHaveProperty('approvalOffer');
  });

  it('expects classifier 2 on a v2 route only when the build attested classifier 2', async () => {
    const ok = await run({ attested: true }, 'v2', withClassifier(2));
    expect(ok.result).toMatchObject({ result: 'completed' });
    const offer = await run({ attested: true }, 'v2', offerReceipt);
    expect(offer.result).toMatchObject({ approvalOffer: { approvalGeneration: 3 } });
    // A classifier 1 receipt on a v2 route is a mismatch.
    const old = await run({ attested: true }, 'v2', withClassifier(1));
    expect(old.result).toMatchObject(invalid);
    expect(old.built.calls['dispatch']).not.toHaveBeenCalled();
    // Without the attest the route falls back to v1: classifier 1 only.
    const unattested = await run({ attested: false }, 'v2', withClassifier(1));
    expect(unattested.result).toMatchObject({ result: 'completed' });
    const unattestedV2 = await run({ attested: false }, 'v2', withClassifier(2));
    expect(unattestedV2.result).toMatchObject(invalid);
    expect(unattestedV2.built.calls['dispatch']).not.toHaveBeenCalled();
  });

  it('cannot change the route of a session after it was bound', async () => {
    const built = build({ attested: true }, { preflight: withClassifier(1) });
    await startWith(built.host, 'v1');
    // Another route for the same session is refused; the same route, or none, is fine (resume).
    await expect(startWith(built.host, 'v2')).rejects.toThrow(/route/u);
    await expect(startWith(built.host, 'v1')).resolves.toBeDefined();
    await expect(startWith(built.host)).resolves.toBeDefined();
  });

  it('keeps the bound route through a start that names none (a resume)', async () => {
    // An approval offer is only acceptable to a session that is not bound to v1. If a start that
    // names no route dropped or replaced the binding, the offer would be accepted again.
    const built = build({ attested: true }, { preflight: offerReceipt });
    const session = await startWith(built.host, 'v1');
    await startWith(built.host);
    const result = await built.host.dispatch(request(session, 'c-2'));
    expect(result).toMatchObject(invalid);
    expect(result).not.toHaveProperty('approvalOffer');
    // The same offer is accepted by a session that was never bound, so the case does tell them apart.
    const unbound = build({ attested: true }, { preflight: offerReceipt });
    const free = await startWith(unbound.host);
    await expect(unbound.host.dispatch(request(free, 'c-3'))).resolves.toHaveProperty(
      'approvalOffer',
    );
  });

  it('binds before it awaits, so two racing starts cannot end with two routes', async () => {
    const built = build({ attested: true });
    await built.host.listWindows(profile);
    const base = {
      profile,
      windowId: 'window-1',
      sessionId: 'session-race',
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
    } as const;
    const results = await Promise.allSettled([
      built.host.startSession({ ...base, classifierRoute: 'v1' }),
      built.host.startSession({ ...base, classifierRoute: 'v2' }),
    ]);
    expect(results.map((entry) => entry.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('leaves no binding behind when the native start fails', async () => {
    let fail = true;
    const built = build(
      { attested: true },
      {
        startSession: (i) => {
          if (fail) throw new Error('native start failed');
          return {
            inputAttemptCount: 0,
            sessionId: i['sessionId'],
            platform: 'darwin',
            appIdentityDigest: identityDigest,
            windowIdentityDigest: zero('d'),
            windowId: 'window-1',
            profileRevision: 1,
            cancelEpoch: 0,
            policyLanguage: 'en',
            maximumMode: 'full_access_app',
            screenBounds: { x: 0, y: 0, width: 100, height: 80 },
            pid: 42,
          };
        },
      },
    );
    await expect(startWith(built.host, 'v1')).rejects.toThrow();
    fail = false;
    await expect(startWith(built.host, 'v2')).resolves.toBeDefined();
  });

  it('forgets the route when the session is closed, so the id can be bound again', async () => {
    const built = build({ attested: true });
    const session = await startWith(built.host, 'v1');
    await built.host.close(session);
    await expect(startWith(built.host, 'v2')).resolves.toBeDefined();
  });

  it('binds only at the start that creates the session: a later route on an unbound session is ignored', async () => {
    const built = build({ attested: true });
    const first = await startWith(built.host, undefined);
    await built.host.startSession({
      profile,
      windowId: 'window-1',
      sessionId: first.sessionId,
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
      resume: true,
      classifierRoute: 'v2',
    });
    for (const call of built.calls['startSession']!.mock.calls)
      expect(call[0]).not.toHaveProperty('classifierRoute');
    // Still unbound: a later start with another route is not refused either.
    await expect(
      built.host.startSession({
        profile,
        windowId: 'window-1',
        sessionId: first.sessionId,
        taskId: 'task-1',
        turnId: 'turn-1',
        cancelEpoch: 0,
        resume: true,
        classifierRoute: 'v1',
      }),
    ).resolves.toBeDefined();
  });

  it('keeps the route when the close is not confirmed', async () => {
    const built = build(
      { attested: true },
      { close: () => ({ result: 'closed', drained: false }) },
    );
    const session = await startWith(built.host, 'v1');
    await expect(built.host.close(session)).rejects.toThrow();
    await expect(startWith(built.host, 'v2')).rejects.toThrow(/route/u);
  });

  it('refuses the approval calls to a session bound to a route that does not expect classifier 2', async () => {
    // Bound to v1: even with the path open, approvalApprove and dispatchApproved are refused here,
    // before the native is called; approvalDiscard (no input capability) is still allowed.
    const v1 = build({ attested: true });
    const bound = await startWith(v1.host, 'v1');
    await expect(
      v1.host.approvalApprove!({ ...request(bound, 'a-1'), approvalGeneration: 4 }),
    ).resolves.toMatchObject({ kind: 'refused', reasonCode: 'native_approval_route_forbidden' });
    await expect(
      v1.host.dispatchApproved!({ ...request(bound, 'a-2'), approvalGeneration: 4 }),
    ).rejects.toThrow();
    await v1.host.approvalDiscard!({ session: bound, approvalGeneration: 4 });
    expect(v1.calls['approvalApprove']).not.toHaveBeenCalled();
    expect(v1.calls['dispatchApproved']).not.toHaveBeenCalled();
    expect(v1.calls['approvalDiscard']).toHaveBeenCalledTimes(1);
    // A v2 route on a build that did not attest 2 expects v1, so it is refused the same way.
    const unattested = build({ attested: false });
    const fallback = await startWith(unattested.host, 'v2');
    await expect(
      unattested.host.approvalApprove!({ ...request(fallback, 'a-3'), approvalGeneration: 4 }),
    ).resolves.toMatchObject({ kind: 'refused' });
    // A v2 route on an attested build, and a session never bound, may use them.
    const v2 = build({ attested: true });
    const open = await startWith(v2.host, 'v2');
    await expect(
      v2.host.approvalApprove!({ ...request(open, 'a-4'), approvalGeneration: 4 }),
    ).resolves.toEqual({ kind: 'approved' });
    await expect(
      v2.host.dispatchApproved!({ ...request(open, 'a-5'), approvalGeneration: 4 }),
    ).resolves.toMatchObject({ result: 'completed' });
  });

  // C4-0: the bound route is handed to the native, so it can pick its classifier by it later.
  it('hands the effective route to the native on every start of a session, and omits it when unbound', async () => {
    const sent = async (options: Parameters<typeof build>[0], route: Route | undefined) => {
      const built = build(options);
      await startWith(built.host, route);
      return built.calls['startSession']!.mock.calls[0]![0] as Record<string, unknown>;
    };
    // The route asks; the attest decides: v2 reaches the native only from a build that attested 2.
    expect((await sent({ attested: true }, 'v2'))['classifierRoute']).toBe('v2');
    expect((await sent({ attested: false }, 'v2'))['classifierRoute']).toBe('v1');
    expect((await sent({}, 'v2'))['classifierRoute']).toBe('v1');
    expect((await sent({ attested: true }, 'v1'))['classifierRoute']).toBe('v1');
    // Main always binds a route; a session that was never bound sends nothing (the pre-C3 shape).
    expect(await sent({ attested: true }, undefined)).not.toHaveProperty('classifierRoute');
  });

  it('repeats the same route on a later start of the same session', async () => {
    const built = build({ attested: true });
    const first = await startWith(built.host, 'v2');
    await built.host.startSession({
      profile,
      windowId: 'window-1',
      sessionId: first.sessionId,
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
      resume: true,
      classifierRoute: 'v2',
    });
    const routes = built.calls['startSession']!.mock.calls.map(
      (call) => (call[0] as Record<string, unknown>)['classifierRoute'],
    );
    expect(routes).toEqual(['v2', 'v2']);
    // A different route for the bound session is refused before the native is asked.
    await expect(
      built.host.startSession({
        profile,
        windowId: 'window-1',
        sessionId: first.sessionId,
        taskId: 'task-1',
        turnId: 'turn-1',
        cancelEpoch: 0,
        classifierRoute: 'v1',
      }),
    ).rejects.toThrow(/route/u);
    expect(built.calls['startSession']).toHaveBeenCalledTimes(2);
  });

  // C4-0: a failed start takes the route binding back only when no other start of the session
  // is still in flight or has produced the session.
  it('keeps the binding when the start that created it fails before a racing start of the same route finishes', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const built = build(
      { attested: true },
      {
        preflight: offerReceipt,
        startSession: async (i) => {
          call += 1;
          // The first start (the one that created the binding) fails at once; the second waits.
          if (call === 1) throw new Error('native start failed');
          await gate;
          return {
            inputAttemptCount: 0,
            sessionId: i['sessionId'],
            platform: 'darwin',
            appIdentityDigest: identityDigest,
            windowIdentityDigest: zero('d'),
            windowId: 'window-1',
            profileRevision: 1,
            cancelEpoch: 0,
            policyLanguage: 'en',
            maximumMode: 'full_access_app',
            screenBounds: { x: 0, y: 0, width: 100, height: 80 },
            pid: 42,
          };
        },
      },
    );
    await built.host.listWindows(profile);
    const base = {
      profile,
      windowId: 'window-1',
      sessionId: 'session-race',
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
      classifierRoute: 'v1',
    } as const;
    const first = built.host.startSession(base);
    const second = built.host.startSession(base);
    await expect(first).rejects.toThrow(/native start failed/u);
    release!();
    const session = await second;
    // The session is still bound to v1: a receipt that offers an approval is invalid for it (an
    // unbound session would accept the same offer), and another route is still refused.
    await expect(built.host.dispatch(request(session, 'r-1'))).resolves.toMatchObject({
      result: 'rejected',
      reasonCode: 'native_preflight_invalid',
    });
    await expect(built.host.startSession({ ...base, classifierRoute: 'v2' })).rejects.toThrow(
      /route/u,
    );
  });

  it('still takes the binding back when the only start of a session fails', async () => {
    const built = build(
      { attested: true },
      {
        startSession: () => {
          throw new Error('native start failed');
        },
      },
    );
    await expect(startWith(built.host, 'v1')).rejects.toThrow();
    // Nothing is left bound, so the id may be bound to another route.
    await expect(startWith(built.host, 'v2')).rejects.toThrow(/native start failed/u);
  });

  it('leaves no binding behind when every concurrent start of a session fails', async () => {
    // Two starts of one new session and route are in flight; both fail, so the binding goes with
    // the last one and a later start with another route is not refused by a stale binding. What
    // protects a binding that a racing start still needs is the test above (the one where the
    // start that created it fails first); this one only pins that nothing is left over.
    const built = build(
      { attested: true },
      {
        startSession: () => {
          throw new Error('native start failed');
        },
      },
    );
    await built.host.listWindows(profile);
    const base = {
      profile,
      windowId: 'window-1',
      sessionId: 'session-two',
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
      classifierRoute: 'v1',
    } as const;
    await Promise.allSettled([built.host.startSession(base), built.host.startSession(base)]);
    await expect(built.host.startSession({ ...base, classifierRoute: 'v2' })).rejects.toThrow(
      /native start failed/u,
    );
  });
});
