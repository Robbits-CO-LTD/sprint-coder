import { createHash } from 'node:crypto';
import { COMPUTER_USE_ARTIFACT_LIMITS } from '@sprint-coder/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ComputerUseNativeBinding } from './computer-use-native';
import { projectComputerUseAccessibilityTree } from './computer-use-accessibility-tree';
import {
  COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE,
  NATIVE_PREFLIGHT_REFUSALS,
  classifyComputerUseNativeDispatchFailure,
  createComputerUseNativeHost,
  parseNativeApprovalApproveReceipt,
} from './computer-use-native-host';

const digest = (digit: string): string => digit.repeat(64);

function binding(
  addon: NonNullable<ComputerUseNativeBinding['addon']>,
  probeOverrides: Partial<ComputerUseNativeBinding['probe']> = {},
  platform: 'darwin' | 'win32' = 'darwin',
): ComputerUseNativeBinding {
  return {
    manifest: {
      version: 1,
      sourceCommit: 'f'.repeat(40),
      platform,
      architecture: platform === 'win32' ? 'x64' : 'arm64',
      protocolVersion: 1,
      apiVersion: 2,
      nativeVersion: 'test-native',
      moduleDigest: digest('1'),
      binaryDigest: digest('2'),
      signerDigest: digest('3'),
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
    },
    probe: {
      available: true,
      protocolVersion: 1,
      apiVersion: 2,
      backend: 'test-native',
      reason: '',
      artifactPath: '/Resources/sprint_coder_computer_use_native.node',
      artifactDigest: digest('1'),
      capabilities: { observe: true, control: true },
      ...probeOverrides,
    },
    artifactPath:
      platform === 'win32'
        ? '/Resources/sprint-coder-computer-use-host.exe'
        : '/Resources/sprint_coder_computer_use_native.node',
    addon,
  };
}

describe('Computer Use native Main adapter', () => {
  it('maps only proven pre-dispatch native refusals to rejected/canceled', () => {
    expect(
      classifyComputerUseNativeDispatchFailure(
        Object.assign(new Error('blocked'), { code: 'SECURE_FIELD_BLOCKED', accepted: false }),
      ),
    ).toEqual({ result: 'rejected', reasonCode: 'native_secure_field_blocked' });
    expect(
      classifyComputerUseNativeDispatchFailure(
        Object.assign(new Error('stopped'), { code: 'CANCELED', accepted: false }),
      ),
    ).toEqual({ result: 'canceled', reasonCode: 'native_canceled_pre_dispatch' });
    expect(
      classifyComputerUseNativeDispatchFailure(
        Object.assign(new Error('partial'), { code: 'INPUT_NOT_CONFIRMED' }),
      ),
    ).toBeNull();
    expect(
      classifyComputerUseNativeDispatchFailure(
        Object.assign(new Error('missing'), { code: 'session_missing', accepted: false }),
      ),
    ).toEqual({ result: 'rejected', reasonCode: 'native_session_missing' });
    expect(
      classifyComputerUseNativeDispatchFailure(
        Object.assign(new Error('accepted'), { code: 'STALE_TARGET', accepted: true }),
      ),
    ).toBeNull();
    // #820: a V1 target that did not answer. Before any input (accepted false) it is a typed rejection
    // that a new observation can answer; once the action was sent (accepted true) a pattern call that
    // timed out is unconfirmed and stays an exception for the controller to book as an unknown effect,
    // exactly like input_not_confirmed (the agent decides whether to repeat it).
    expect(
      classifyComputerUseNativeDispatchFailure(
        Object.assign(new Error('timeout'), { code: 'ACCESSIBILITY_TIMEOUT', accepted: false }),
      ),
    ).toEqual({ result: 'rejected', reasonCode: 'native_accessibility_timeout' });
    expect(
      classifyComputerUseNativeDispatchFailure(
        Object.assign(new Error('unconfirmed'), {
          code: 'INPUT_TIMEOUT_UNCONFIRMED',
          accepted: true,
        }),
      ),
    ).toBeNull();
    expect(
      classifyComputerUseNativeDispatchFailure(
        Object.assign(new Error('unconfirmed'), { code: 'INPUT_TIMEOUT_UNCONFIRMED' }),
      ),
    ).toBeNull();
  });

  it('maps the three v2 interlock dispatch codes to the result of their preflight row (#500 S5-c-2 PR-5)', () => {
    const refusal = (code: string, accepted: boolean | undefined = false) =>
      classifyComputerUseNativeDispatchFailure(
        Object.assign(new Error('refused'), {
          code,
          ...(accepted === undefined ? {} : { accepted }),
        }),
      );
    // The result is the one of the same row of the receipt table: a block is rejected, an execution
    // trigger is paused for a person.
    expect(refusal('SHELL_SURFACE_BLOCKED')).toEqual({
      result: 'rejected',
      reasonCode: 'native_shell_surface_blocked',
    });
    expect(refusal('EXECUTION_TRIGGER_BLOCKED')).toEqual({
      result: 'paused',
      reasonCode: 'native_execution_trigger_blocked',
    });
    expect(refusal('APPROVAL_NOT_ENABLED')).toEqual({
      result: 'rejected',
      reasonCode: 'native_approval_not_enabled',
    });
    // The native spells the code in lower case: the same.
    expect(refusal('execution_trigger_blocked')).toMatchObject({ result: 'paused' });
    // Every mapped code has a row in the table, with the same result (a table change cannot leave the
    // mapping behind).
    for (const code of [
      'SHELL_SURFACE_BLOCKED',
      'EXECUTION_TRIGGER_BLOCKED',
      'APPROVAL_NOT_ENABLED',
    ]) {
      const mapped = refusal(code)!;
      expect(
        NATIVE_PREFLIGHT_REFUSALS.some(
          (entry) => entry.reasonCode === mapped.reasonCode && entry.deniedResult === mapped.result,
        ),
        code,
      ).toBe(true);
    }
    // The V1 codes keep their plain rejection (the mapping of V1 is unchanged).
    for (const code of [
      'HIGH_IMPACT_BLOCKED',
      'SECURE_FIELD_BLOCKED',
      'STALE_TARGET',
      'TARGET_UNCLASSIFIED',
    ])
      expect(refusal(code)).toEqual({
        result: 'rejected',
        reasonCode: `native_${code.toLowerCase()}`,
      });
    // An interlock code that is not marked as refused before input is not taken as a pre-dispatch
    // refusal unless the native says accepted:false.
    expect(refusal('EXECUTION_TRIGGER_BLOCKED', true)).toBeNull();
    expect(refusal('EXECUTION_TRIGGER_BLOCKED', undefined)).toMatchObject({ result: 'paused' });
  });

  it('does not read node values: a production host offers no copy until T15-4m / T15-4w and C5', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const host = createComputerUseNativeHost(binding({ probe: () => ({}) }), platform);
      expect(host.artifactReadSupported?.() ?? false).toBe(false);
      expect(host.readNodeValue).toBeUndefined();
    }
  });

  it('keeps Gate 0 registration unavailable when the signed probe has no picker seam', async () => {
    const host = createComputerUseNativeHost(binding({ probe: () => ({}) }), 'darwin');

    expect(host.availability()).toMatchObject({
      state: 'handshake_failed',
      available: false,
      reasonCode: COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE,
    });
    await expect(
      host.pickApplication({ activationToken: 'activation', pickerKind: 'application' }),
    ).rejects.toMatchObject({ reasonCode: COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE });
  });

  it('keeps signed ABI handshake ready while TCC/native permissions remain unavailable', () => {
    const surface = {
      probe: () => ({}),
      pickApplication: () => null,
      listWindows: () => [],
      startSession: () => ({}),
      observe: () => ({}),
      dispatch: () => ({}),
      cancel: () => undefined,
      close: () => undefined,
    };
    const host = createComputerUseNativeHost(
      binding(surface, {
        available: false,
        reason: 'ACCESSIBILITY_PERMISSION_REQUIRED',
        capabilities: { observe: false, control: false },
      }),
      'darwin',
    );

    expect(host.availability()).toMatchObject({
      // A probe that names a TCC permission is reported as such; the gates below it are unchanged.
      state: 'permission_required',
      packageReady: true,
      handshakeReady: true,
      observe: false,
      control: false,
      available: false,
      reasonCode: 'accessibility_permission_required',
    });
  });

  it('maps an absent native policy language to unknown and rejects malformed language claims', async () => {
    const baseSurface = {
      probe: () => ({}),
      listWindows: () => [],
      startSession: () => ({}),
      observe: () => ({}),
      dispatch: () => ({}),
      cancel: () => undefined,
      close: () => undefined,
    };
    const nativeIdentity = {
      platform: 'darwin',
      identityDigest: digest('a'),
      executablePath: '/Applications/Target.app/Contents/MacOS/Target',
      executableDigest: digest('b'),
      bundleId: 'com.example.Target',
      teamId: null,
      signingIdentifier: null,
      cdHash: null,
      displayName: 'Target',
    };
    const absent = createComputerUseNativeHost(
      binding({ ...baseSurface, pickApplication: () => nativeIdentity }),
      'darwin',
    );
    await expect(
      absent.pickApplication({ activationToken: 'token', pickerKind: 'application' }),
    ).resolves.toMatchObject({ policyLanguage: 'unknown', maximumMode: 'observe_only' });

    const malformed = createComputerUseNativeHost(
      binding({
        ...baseSurface,
        pickApplication: () => ({ ...nativeIdentity, policyLanguage: 'fr' }),
      }),
      'darwin',
    );
    await expect(
      malformed.pickApplication({ activationToken: 'token', pickerKind: 'application' }),
    ).rejects.toMatchObject({ reasonCode: 'native_policy_language_invalid' });

    const malformedMode = createComputerUseNativeHost(
      binding({
        ...baseSurface,
        pickApplication: () => ({
          ...nativeIdentity,
          policyLanguage: 'en',
          maximumMode: 'unbounded',
        }),
      }),
      'darwin',
    );
    await expect(
      malformedMode.pickApplication({ activationToken: 'token', pickerKind: 'application' }),
    ).resolves.toMatchObject({ maximumMode: 'observe_only' });
  });

  it('converts Windows physical client bounds to Electron DIP before returning candidates', async () => {
    const appIdentityDigest = digest('a');
    const executableDigest = digest('b');
    const updatedExecutableDigest = digest('e');
    const windowIdentityDigest = digest('c');
    const surface = {
      probe: () => ({}),
      pickApplication: () => null,
      listWindows: () => [
        {
          pid: 42,
          windowHandle: '100',
          boundsUnit: 'physical_px',
          windowId: '100',
          appIdentityDigest,
          executableDigest: updatedExecutableDigest,
          windowIdentityDigest,
          title: 'Target',
          bounds: { x: 300, y: 150, width: 1_200, height: 900 },
          screenBounds: { x: 300, y: 150, width: 1_200, height: 900 },
          focused: false,
          eligible: true,
          ownerKind: 'application',
          modal: false,
          revision: 1,
          maximumMode: 'full_access_app',
        },
      ],
      startSession: () => ({}),
      observe: () => ({}),
      dispatch: () => ({}),
      cancel: () => undefined,
      close: () => undefined,
    };
    const host = createComputerUseNativeHost(binding(surface, {}, 'win32'), 'win32', {
      windowsPhysicalBoundsToDip: ({ x, y, width, height }) => ({
        x: x / 1.5,
        y: y / 1.5,
        width: width / 1.5,
        height: height / 1.5,
      }),
    });

    await expect(
      host.listWindows({
        id: 'profile-1',
        platform: 'win32',
        kind: 'win32-executable',
        label: 'Target',
        canonicalPath: 'C:\\Target\\Target.exe',
        appUrl: null,
        identity: {
          platform: 'win32',
          identityDigest: appIdentityDigest,
          executablePath: 'C:\\Target\\Target.exe',
          executableDigest,
          signerDigest: digest('d'),
          packageFamilyName: null,
          appUserModelId: null,
          displayName: 'Target',
          maximumMode: 'full_access_app',
        },
        identityDigest: appIdentityDigest,
        version: null,
        executableDigest,
        mode: 'full_access_app',
        connectionId: 'connection-1',
        modelId: 'model-1',
        providerEgressConsent: true,
        remember: true,
        revision: 1,
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
      }),
    ).resolves.toMatchObject([
      {
        bounds: { x: 200, y: 100, width: 800, height: 600 },
        screenBounds: { x: 200, y: 100, width: 800, height: 600 },
        maximumMode: 'full_access_app',
        executableDigest: updatedExecutableDigest,
      },
    ]);
  });

  const win32TicketScenario = async (
    withPreflight: boolean,
    classifierRoute?: 'v1' | 'v2',
    extraSurface: Record<string, unknown> = {},
  ) => {
    const startSession = vi.fn((_input: unknown) => ({
      sessionId: 'session-w',
      windowId: '100',
      appIdentityDigest: digest('a'),
      windowIdentityDigest: digest('c'),
      profileRevision: 1,
      cancelEpoch: 0,
      screenBounds: { x: 300, y: 150, width: 1_200, height: 900 },
      maximumMode: 'full_access_app',
      inputAttemptCount: 0,
    }));
    const appIdentityDigest = digest('a');
    const windowIdentityDigest = digest('c');
    const screen = { x: 300, y: 150, width: 1_200, height: 900 };
    const winTicket = 'cd'.repeat(32);
    const preflight = vi.fn((input: unknown) => {
      const request = input as Record<string, unknown>;
      return {
        decision: 'ordinary',
        reasonCode: null,
        deniedResult: null,
        ticket: winTicket,
        classifierVersion: 1,
        inputAttemptCount: 0,
        requestId: request['requestId'],
        sessionId: request['sessionId'],
        cancelEpoch: request['cancelEpoch'],
        observationRevision: request['observationRevision'],
      };
    });
    const dispatch = vi.fn((input: unknown) => {
      const request = input as Record<string, unknown>;
      return {
        result: 'completed',
        reasonCode: null,
        sessionId: request['sessionId'],
        cancelEpoch: request['cancelEpoch'],
        inputAttemptCount: 1,
      };
    });
    const surface = {
      probe: () => ({}),
      pickApplication: () => null,
      listWindows: () => [
        {
          pid: 42,
          windowHandle: '100',
          boundsUnit: 'physical_px',
          windowId: '100',
          appIdentityDigest,
          executableDigest: digest('b'),
          windowIdentityDigest,
          title: 'Target',
          bounds: screen,
          screenBounds: screen,
          focused: false,
          eligible: true,
          ownerKind: 'application',
          modal: false,
          revision: 1,
          maximumMode: 'full_access_app',
        },
      ],
      startSession,
      observe: () => ({}),
      ...(withPreflight ? { preflight } : {}),
      dispatch,
      cancel: () => undefined,
      close: () => undefined,
      ...extraSurface,
    };
    const host = createComputerUseNativeHost(binding(surface, {}, 'win32'), 'win32', {
      windowsPhysicalBoundsToDip: (bounds) => bounds,
    });
    const profile = {
      id: 'profile-1',
      platform: 'win32' as const,
      kind: 'win32-executable' as const,
      label: 'Target',
      canonicalPath: 'C:\\Target\\Target.exe',
      appUrl: null,
      identity: {
        platform: 'win32' as const,
        identityDigest: appIdentityDigest,
        executablePath: 'C:\\Target\\Target.exe',
        executableDigest: digest('b'),
        signerDigest: digest('d'),
        packageFamilyName: null,
        appUserModelId: null,
        displayName: 'Target',
        maximumMode: 'full_access_app' as const,
      },
      identityDigest: appIdentityDigest,
      version: null,
      executableDigest: digest('b'),
      mode: 'full_access_app' as const,
      connectionId: 'connection-1',
      modelId: 'model-1',
      providerEgressConsent: true,
      remember: false,
      revision: 1,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const session = await host.startSession({
      profile,
      windowId: '100',
      sessionId: 'session-w',
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
      ...(classifierRoute === undefined ? {} : { classifierRoute }),
    });
    await expect(
      host.dispatch({
        session,
        requestId: 'request-w',
        action: { type: 'click', x: 0.5, y: 0.5, button: 'left' },
        observationRevision: 1,
        cancelEpoch: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ result: 'completed' });
    return { preflight, dispatch, winTicket, startSession, host, session };
  };

  // #785 T15-4w: the Windows read of one node's value. It travels as the native's own method and is
  // answered in one shape; it is not a capability (`artifactReadSupported` stays undefined).
  it('reads one node value through the win32 addon, in one shape, and is not a capability (T15-4w)', async () => {
    const answers: unknown[] = [];
    const readNodeValue = vi.fn((_input: unknown): unknown => answers.shift());
    const { host, session } = await win32TicketScenario(true, undefined, { readNodeValue });
    expect(host.artifactReadSupported).toBeUndefined();
    expect(host.readNodeValue).toBeTypeOf('function');
    const read = () =>
      host.readNodeValue!({
        session,
        requestId: 'copy-1',
        targetId: '1001',
        targetSignature: 'signature',
        observationRevision: 1,
        cancelEpoch: 0,
        signal: new AbortController().signal,
      });
    answers.push({ ok: true, text: 'Fixture text' });
    await expect(read()).resolves.toEqual({ ok: true, text: 'Fixture text' });
    // What the native is asked: a copy of one target under the observation it was shown.
    expect(readNodeValue.mock.calls[0]![0]).toMatchObject({
      type: 'copy',
      requestId: 'copy-1',
      sessionId: 'session-w',
      targetId: '1001',
      targetSignature: 'signature',
      observationRevision: 1,
      cancelEpoch: 0,
    });
    // Every other answer is the same refusal: not ok, an extra key, an empty or a non-string text, a
    // text over the contracts' byte bound, a throw, or not even an object.
    const over = 'a'.repeat(COMPUTER_USE_ARTIFACT_LIMITS.maxBytes + 1);
    const exact = 'a'.repeat(COMPUTER_USE_ARTIFACT_LIMITS.maxBytes);
    for (const bad of [
      { ok: false },
      { ok: true },
      { ok: true, text: '' },
      { ok: true, text: 7 },
      { ok: true, text: over },
      { ok: true, text: 'x', title: 'a title' },
      { ok: 'true', text: 'x' },
      null,
      'text',
      [],
    ]) {
      answers.push(bad);
      await expect(read()).resolves.toEqual({ ok: false });
    }
    answers.push({ ok: true, text: exact });
    await expect(read()).resolves.toEqual({ ok: true, text: exact });
    readNodeValue.mockImplementationOnce(() => {
      throw new Error('helper gone');
    });
    await expect(read()).resolves.toEqual({ ok: false });
    // A multi-byte text is judged in bytes, not characters.
    answers.push({
      ok: true,
      text: 'あ'.repeat(Math.floor(COMPUTER_USE_ARTIFACT_LIMITS.maxBytes / 3) + 1),
    });
    await expect(read()).resolves.toEqual({ ok: false });
    // Without the native method there is no read at all.
    const without = await win32TicketScenario(true);
    expect(without.host.readNodeValue).toBeUndefined();
  });

  // C4-0: the Windows helper does not know the key until S5, so the route is bound in Main and
  // never sent there, whichever route was asked for.
  it.each(['v1', 'v2'] as const)(
    'does not send the classifier route (%s) to a win32 addon (C4-0)',
    async (route) => {
      const { startSession } = await win32TicketScenario(true, route);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(startSession.mock.calls[0]![0]).not.toHaveProperty('classifierRoute');
    },
  );

  it('preflights on win32 and dispatches with the ordinary ticket it returns (S5-a)', async () => {
    const { preflight, dispatch, winTicket } = await win32TicketScenario(true);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(preflight.mock.calls[0]![0]).toMatchObject({ requestId: 'request-w' });
    expect(preflight.mock.calls[0]![0]).not.toHaveProperty('ticket');
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ requestId: 'request-w', ticket: winTicket });
  });

  it('keeps the legacy dispatch path for a win32 addon that does not export preflight', async () => {
    const { preflight, dispatch } = await win32TicketScenario(false);
    expect(preflight).not.toHaveBeenCalled();
    expect(dispatch.mock.calls[0]![0]).not.toHaveProperty('ticket');
  });

  it('rejects a changed executable digest for an unsigned Windows profile', async () => {
    const appIdentityDigest = digest('a');
    const registeredExecutableDigest = digest('b');
    const surface = {
      probe: () => ({}),
      pickApplication: () => null,
      listWindows: () => [
        {
          pid: 42,
          windowHandle: '100',
          boundsUnit: 'physical_px',
          windowId: '100',
          appIdentityDigest,
          executableDigest: digest('e'),
          windowIdentityDigest: digest('c'),
          title: 'Unsigned target',
          bounds: { x: 0, y: 0, width: 100, height: 80 },
          screenBounds: { x: 0, y: 0, width: 100, height: 80 },
          focused: false,
          eligible: true,
          ownerKind: 'application',
          modal: false,
          revision: 1,
          policyLanguage: 'en',
          maximumMode: 'full_access_app',
        },
      ],
      startSession: () => ({}),
      observe: () => ({}),
      dispatch: () => ({}),
      cancel: () => undefined,
      close: () => undefined,
    };
    const host = createComputerUseNativeHost(binding(surface, {}, 'win32'), 'win32', {
      windowsPhysicalBoundsToDip: (bounds) => bounds,
    });

    await expect(
      host.listWindows({
        id: 'profile-unsigned',
        platform: 'win32',
        kind: 'win32-executable',
        label: 'Unsigned target',
        canonicalPath: 'C:\\Target\\Unsigned.exe',
        appUrl: null,
        identity: {
          platform: 'win32',
          identityDigest: appIdentityDigest,
          executablePath: 'C:\\Target\\Unsigned.exe',
          executableDigest: registeredExecutableDigest,
          signerDigest: null,
          packageFamilyName: null,
          appUserModelId: null,
          displayName: 'Unsigned target',
          policyLanguage: 'en',
          maximumMode: 'full_access_app',
        },
        identityDigest: appIdentityDigest,
        version: null,
        executableDigest: registeredExecutableDigest,
        mode: 'full_access_app',
        connectionId: 'connection-1',
        modelId: 'model-1',
        providerEgressConsent: true,
        remember: true,
        revision: 1,
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ reasonCode: 'native_app_identity_changed' });
  });

  it('keeps OS handles inside Main while adapting a complete native controller seam', async () => {
    const appIdentityDigest = digest('a');
    const executableDigest = digest('b');
    const windowIdentityDigest = digest('c');
    const screenshot = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const tree = JSON.stringify({
      role: 'AXWindow',
      title: 'Target',
      identifier: '',
      children: [
        {
          role: 'AXSecureTextField',
          title: 'Never expose this password',
          identifier: 'secret-field',
          value: 'example-sensitive-input',
          children: [],
        },
        {
          role: 'AXButton',
          title: 'Purchase contract now',
          identifier: 'checkout-contract',
          children: [],
        },
      ],
    });
    const listWindows = vi.fn(() => [
      {
        pid: 42,
        windowId: 'window-1',
        platform: 'darwin' as const,
        appIdentityDigest,
        windowIdentityDigest,
        title: 'Target',
        bounds: { x: 0, y: 0, width: 100, height: 80 },
        screenBounds: { x: 0, y: 0, width: 100, height: 80 },
        focused: true,
        eligible: true,
        ownerKind: 'application' as const,
        modal: false,
        revision: 4,
        policyLanguage: 'ja',
        maximumMode: 'full_access_app',
      },
    ]);
    const dispatch = vi.fn((input: unknown): Record<string, unknown> => {
      const request = input as Record<string, unknown>;
      return {
        result: 'completed',
        reasonCode: null,
        accepted: true,
        effectStarted: true,
        requestId: request['requestId'],
        sessionId: request['sessionId'],
        observationRevision: request['observationRevision'],
        actionDigest: request['actionDigest'],
        cancelEpoch: request['cancelEpoch'],
        inputAttemptCount: 2,
      };
    });
    const startSession = vi.fn(() => ({
      inputAttemptCount: 0,
      sessionId: 'session-1',
      platform: 'darwin' as const,
      appIdentityDigest,
      windowIdentityDigest,
      windowId: 'window-1',
      profileRevision: 3,
      cancelEpoch: 0,
      policyLanguage: 'ja',
      maximumMode: 'full_access_app',
      screenBounds: { x: 0, y: 0, width: 100, height: 80 },
      pid: 42,
    }));
    const addon = {
      probe: () => ({}),
      pickApplication: () => ({
        platform: 'darwin' as const,
        identityDigest: appIdentityDigest,
        executablePath: '/Applications/Target.app/Contents/MacOS/Target',
        executableDigest,
        bundleId: 'com.example.Target',
        teamId: null,
        signingIdentifier: null,
        cdHash: null,
        displayName: 'Target',
        policyLanguage: 'ja',
        maximumMode: 'full_access_app',
        pid: 42,
      }),
      listWindows,
      startSession,
      observe: () => ({
        pid: 42,
        windowId: 'window-1',
        captureWidth: 100,
        captureHeight: 80,
        screenshot,
        screenshotMimeType: 'image/png',
        tree,
        // Main recomputes shape metadata from the redacted projection instead of trusting native.
        treeNodeCount: 1,
        treeDepth: 0,
        dialogSetRevision: 2,
        dialogSetDigest: digest('d'),
        activeWindowIdentityDigest: digest('e'),
        activeWindowKind: 'dialog',
        policyLanguage: 'ja',
        maximumMode: 'full_access_app',
        screenBounds: { x: 0, y: 0, width: 100, height: 80 },
      }),
      dispatch,
      cancel: vi.fn((input: unknown): unknown => {
        const request = input as Record<string, unknown>;
        return {
          result: 'canceled',
          drained: true,
          sessionId: request['sessionId'],
          cancelEpoch: request['cancelEpoch'],
          inputAttemptCount: 2,
        };
      }),
      close: vi.fn((input: unknown): unknown => {
        const request = input as Record<string, unknown>;
        return {
          result: 'closed',
          drained: true,
          sessionId: request['sessionId'],
          cancelEpoch: request['cancelEpoch'],
          inputAttemptCount: 2,
        };
      }),
    };
    const host = createComputerUseNativeHost(binding(addon), 'darwin', { stopTimeoutMs: 10 });
    expect(host.availability()).toMatchObject({
      state: 'ready',
      available: true,
      observe: true,
      control: true,
      manifestDigest: digest('1'),
    });

    const identity = await host.pickApplication({
      activationToken: 'main-issued-token',
      pickerKind: 'application',
    });
    expect(identity).toMatchObject({
      displayName: 'Target',
      identityDigest: appIdentityDigest,
      policyLanguage: 'ja',
      maximumMode: 'full_access_app',
    });
    expect(identity).not.toHaveProperty('pid');
    const profile = {
      id: 'profile-1',
      platform: 'darwin' as const,
      kind: 'macos-bundle' as const,
      label: 'Target',
      canonicalPath: '/Applications/Target.app/Contents/MacOS/Target',
      appUrl: null,
      identity: identity!,
      identityDigest: appIdentityDigest,
      version: null,
      executableDigest,
      mode: 'full_access_app' as const,
      connectionId: 'connection-1',
      modelId: 'model-1',
      providerEgressConsent: true,
      remember: false,
      revision: 3,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    };
    await expect(host.listWindows(profile)).resolves.toMatchObject([{ policyLanguage: 'ja' }]);
    const startInput = {
      profile,
      windowId: 'window-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
    } as const;
    const session = await host.startSession(startInput);
    expect(session).not.toHaveProperty('pid');
    expect(session.policyLanguage).toBe('ja');
    expect(session.maximumMode).toBe('full_access_app');
    expect(session.screenBounds).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    const observation = await host.observe(session, {
      requestId: 'request-1',
      cancelEpoch: 0,
    });
    expect(observation).toMatchObject({
      sessionId: 'session-1',
      appIdentityDigest,
      windowIdentityDigest,
      profileRevision: 3,
      revision: 1,
      dialogSetRevision: 2,
      dialogSetDigest: digest('d'),
      activeWindowIdentityDigest: digest('e'),
      activeWindowKind: 'dialog',
      policyLanguage: 'ja',
      maximumMode: 'full_access_app',
      screenBounds: { x: 0, y: 0, width: 100, height: 80 },
      treeDepth: 1,
      treeNodeCount: 3,
      targetMetadata: {
        'secret-field': { secure: true, highImpact: true },
        'checkout-contract': { secure: false, highImpact: true },
      },
    });
    expect(observation.accessibilityTree).not.toContain('Never expose this password');
    expect(observation.accessibilityTree).not.toContain('example-sensitive-input');
    expect(observation.accessibilityTree).not.toContain('Purchase contract now');
    expect(observation.accessibilityTree).not.toContain('checkout-contract');
    expect(observation.accessibilityTree).toContain('[redacted]');
    expect(observation.treeByteLength).toBe(
      Buffer.byteLength(observation.accessibilityTree!, 'utf8'),
    );
    expect(observation.treeDigest).toBe(
      createHash('sha256').update(observation.accessibilityTree!, 'utf8').digest('hex'),
    );
    const listCallsBeforeResume = listWindows.mock.calls.length;
    await expect(host.startSession({ ...startInput, resume: true })).resolves.toMatchObject({
      sessionId: 'session-1',
      windowId: 'window-1',
    });
    expect(listWindows).toHaveBeenCalledTimes(listCallsBeforeResume);
    expect(startSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        windowId: 'window-1',
        resume: true,
        pid: 42,
        expectedBoundsX: 0,
        expectedBoundsY: 0,
        expectedBoundsWidth: 100,
        expectedBoundsHeight: 80,
      }),
    );
    const result = await host.dispatch({
      session,
      requestId: 'request-2',
      action: { type: 'click', x: 0.5, y: 0.5, button: 'left' },
      observationRevision: observation.revision,
      cancelEpoch: 0,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      result: 'completed',
      reasonCode: null,
      inputReceipt: { sessionId: session.sessionId, cancelEpoch: 0, inputAttemptCount: 2 },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-2',
        sessionId: 'session-1',
        observationRevision: 1,
        actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
    // N2b-1: a macOS native that exports preflight gets a preflight and a single-use ticket first.
    const ticket = 'ab'.repeat(32);
    const receipt = (input: unknown, overrides: Record<string, unknown> = {}) => {
      const request = input as Record<string, unknown>;
      return {
        decision: 'ordinary',
        reasonCode: null,
        deniedResult: null,
        ticket,
        classifierVersion: 1,
        inputAttemptCount: 2,
        requestId: request['requestId'],
        sessionId: request['sessionId'],
        cancelEpoch: request['cancelEpoch'],
        observationRevision: request['observationRevision'],
        ...overrides,
      };
    };
    const preflight = vi.fn((input: unknown): unknown => receipt(input));
    const withPreflight = addon as unknown as { preflight?: typeof preflight };
    withPreflight.preflight = preflight;
    const preflightAction = (requestId: string) =>
      host.dispatch({
        session,
        requestId,
        action: { type: 'click', x: 0.5, y: 0.5, button: 'left' },
        observationRevision: observation.revision,
        cancelEpoch: 0,
        signal: new AbortController().signal,
      });
    const dispatchCalls = (): number => dispatch.mock.calls.length;
    await expect(preflightAction('pf-ok')).resolves.toMatchObject({ result: 'completed' });
    expect(preflight).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 'pf-ok', sessionId: 'session-1' }),
    );
    expect(preflight.mock.calls.at(-1)![0]).not.toHaveProperty('ticket');
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 'pf-ok', ticket }),
    );
    // replay: answered from the native cache, so dispatch carries no ticket.
    preflight.mockImplementationOnce((input) =>
      receipt(input, { decision: 'replay', ticket: null }),
    );
    await preflightAction('pf-replay');
    expect(dispatch.mock.calls.at(-1)![0]).not.toHaveProperty('ticket');
    // blocked / takeover / denied never dispatch and keep the native result and reason.
    for (const [decision, reasonCode, deniedResult] of [
      ['blocked', 'native_secure_field_blocked', 'rejected'],
      ['takeover', 'native_high_impact_user_takeover', 'paused'],
      ['denied', 'native_stale_observation', 'rejected'],
      // Interlock refusals (S4-1a): nothing returns them yet, but the receipt table knows them.
      ['blocked', 'native_shell_surface_blocked', 'rejected'],
      ['blocked', 'native_approval_not_enabled', 'rejected'],
      ['takeover', 'native_execution_trigger_blocked', 'paused'],
    ] as const) {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) =>
        receipt(input, { decision, reasonCode, deniedResult, ticket: null }),
      );
      await expect(preflightAction('pf-' + decision)).resolves.toEqual({
        result: deniedResult,
        reasonCode,
        inputReceipt: { sessionId: session.sessionId, cancelEpoch: 0, inputAttemptCount: 2 },
      });
      expect(dispatchCalls()).toBe(before);
    }
    // A blocked or takeover receipt is one of the closed pairs and no other: the decision, the reason
    // and the result agree, so a reason cannot be carried into a decision it does not belong to.
    for (const [decision, reasonCode, deniedResult] of [
      ['blocked', 'native_high_impact_user_takeover', 'paused'],
      ['blocked', 'native_execution_trigger_blocked', 'paused'],
      ['blocked', 'native_shell_surface_blocked', 'paused'],
      ['blocked', 'native_approval_not_enabled', 'paused'],
      ['takeover', 'native_secure_field_blocked', 'rejected'],
      ['takeover', 'native_shell_surface_blocked', 'rejected'],
      ['takeover', 'native_execution_trigger_blocked', 'rejected'],
      ['takeover', 'native_approval_not_enabled', 'rejected'],
      ['takeover', 'native_target_unclassified', 'paused'],
      ['blocked', 'native_unlisted_reason', 'rejected'],
      ['takeover', 'native_unlisted_reason', 'paused'],
      ['blocked', 'native_shell_surface_blocked', 'canceled'],
      // A refusal reason is only valid in its own decision: not in a denied receipt either.
      ['denied', 'native_secure_field_blocked', 'rejected'],
      ['denied', 'native_shell_surface_blocked', 'rejected'],
      ['denied', 'native_approval_not_enabled', 'rejected'],
      ['denied', 'native_high_impact_user_takeover', 'paused'],
      ['denied', 'native_target_unclassified', 'rejected'],
      ['denied', 'native_execution_trigger_blocked', 'paused'],
    ] as const) {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) =>
        receipt(input, { decision, reasonCode, deniedResult, ticket: null }),
      );
      await expect(preflightAction('pf-bad-pair')).resolves.toEqual({
        result: 'rejected',
        reasonCode: 'native_preflight_invalid',
      });
      expect(dispatchCalls()).toBe(before);
    }
    // N2b-2: single_use_approval has no approval path yet, so it is a closed no-input pause with a
    // fixed Main-owned reason; the native reason (null only) never reaches the caller.
    {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) =>
        receipt(input, {
          decision: 'single_use_approval',
          reasonCode: null,
          deniedResult: null,
          ticket: null,
        }),
      );
      await expect(preflightAction('pf-approval')).resolves.toEqual({
        result: 'paused',
        reasonCode: 'native_single_use_approval_unavailable',
        inputReceipt: { sessionId: session.sessionId, cancelEpoch: 0, inputAttemptCount: 2 },
      });
      expect(dispatchCalls()).toBe(before);
    }
    // N2b-4 PR 1: version 2 receipts carry `receiptVersion: 2`, independent of `classifierVersion`.
    const v2Receipt = (input: unknown, overrides: Record<string, unknown> = {}) => {
      const value = receipt(input, { receiptVersion: 2, ...overrides }) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(value)) if (entry === undefined) delete value[key];
      return value;
    };
    const approvalV2 = {
      decision: 'single_use_approval',
      reasonCode: null,
      deniedResult: null,
      ticket: null,
      classifierVersion: 2,
      approvalGeneration: 1,
      remainingMs: 60_000,
      effect: 'supervised_action',
    };
    const pausedUnavailable = {
      result: 'paused',
      reasonCode: 'native_single_use_approval_unavailable',
      inputReceipt: { sessionId: session.sessionId, cancelEpoch: 0, inputAttemptCount: 2 },
    };
    // Version 2 ordinary / replay / refusals behave exactly like version 1 at classifier version 1.
    {
      preflight.mockImplementationOnce((input) => v2Receipt(input));
      await expect(preflightAction('pf-v2-ordinary')).resolves.toMatchObject({
        result: 'completed',
      });
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: 'pf-v2-ordinary', ticket }),
      );
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) =>
        v2Receipt(input, {
          decision: 'blocked',
          reasonCode: 'native_secure_field_blocked',
          deniedResult: 'rejected',
          ticket: null,
        }),
      );
      await expect(preflightAction('pf-v2-blocked')).resolves.toMatchObject({
        result: 'rejected',
        reasonCode: 'native_secure_field_blocked',
      });
      expect(dispatchCalls()).toBe(before);
    }
    // The approval offer is the only version 2 shape with extra keys, and only at classifier 2.
    for (const effect of [
      'download_open',
      'file_manager_open',
      'high_impact_confirmation',
      'supervised_action',
    ]) {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) => v2Receipt(input, { ...approvalV2, effect }));
      const outcome = await preflightAction('pf-v2-approval');
      expect(outcome).toEqual({
        ...pausedUnavailable,
        approvalOffer: {
          kind: 'approval_required',
          approvalGeneration: 1,
          remainingMs: 60_000,
          effect,
        },
      });
      expect(dispatchCalls()).toBe(before);
    }
    // Boundaries of the accepted shape, and the other version 2 decisions at classifier version 1.
    for (const [overrides, offer] of [
      [{ remainingMs: 1 }, { remainingMs: 1 }],
      [
        { approvalGeneration: Number.MAX_SAFE_INTEGER },
        { approvalGeneration: Number.MAX_SAFE_INTEGER },
      ],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      preflight.mockImplementationOnce((input) =>
        v2Receipt(input, { ...approvalV2, ...overrides }),
      );
      await expect(preflightAction('pf-v2-boundary')).resolves.toMatchObject({
        result: 'paused',
        approvalOffer: { kind: 'approval_required', ...offer },
      });
    }
    {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) =>
        v2Receipt(input, {
          decision: 'replay',
          ticket: null,
          reasonCode: null,
          deniedResult: null,
        }),
      );
      await preflightAction('pf-v2-replay');
      expect(dispatch.mock.calls.at(-1)![0]).not.toHaveProperty('ticket');
      for (const [decision, reasonCode, deniedResult] of [
        ['takeover', 'native_high_impact_user_takeover', 'paused'],
        ['denied', 'native_stale_observation', 'rejected'],
      ] as const) {
        const calls = dispatchCalls();
        preflight.mockImplementationOnce((input) =>
          v2Receipt(input, { decision, reasonCode, deniedResult, ticket: null }),
        );
        await expect(preflightAction('pf-v2-' + decision)).resolves.toMatchObject({
          result: deniedResult,
          reasonCode,
        });
        expect(dispatchCalls()).toBe(calls);
      }
      expect(dispatchCalls()).toBe(before + 1);
    }
    const invalidV2: Array<Record<string, unknown>> = [
      { effect: 'invalid' },
      { effect: 'open_anything' },
      { effect: null },
      { effect: undefined },
      { approvalGeneration: 0 },
      { approvalGeneration: -1 },
      { approvalGeneration: 1.5 },
      { approvalGeneration: '1' },
      { approvalGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { remainingMs: 0 },
      { remainingMs: 60_001 },
      { remainingMs: -5 },
      { remainingMs: 1.5 },
      { remainingMs: '1000' },
      { remainingMs: Number.NaN },
      { approvalGeneration: undefined },
      { remainingMs: undefined },
      // single_use_approval is accepted only at classifier version 2.
      { classifierVersion: 1 },
      { classifierVersion: 3 },
      { ticket },
      { reasonCode: 'native_x' },
      { deniedResult: 'paused' },
      { extra: true },
      { receiptVersion: 1 },
      { receiptVersion: 3 },
      { receiptVersion: '2' },
      { requestId: 'other' },
      { sessionId: 'other' },
      { cancelEpoch: 9 },
      { observationRevision: 99 },
    ];
    for (const overrides of invalidV2) {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) =>
        v2Receipt(input, { ...approvalV2, ...overrides }),
      );
      await expect(preflightAction('pf-v2-bad')).resolves.toEqual({
        result: 'rejected',
        reasonCode: 'native_preflight_invalid',
      });
      expect(dispatchCalls()).toBe(before);
    }
    // Approval-offer keys never appear on another decision or on a version 1 receipt, and version 2
    // other decisions never use classifier version 2.
    for (const overrides of [
      { receiptVersion: undefined, ...approvalV2 },
      { decision: 'ordinary', approvalGeneration: 1 },
      { decision: 'ordinary', remainingMs: 1000 },
      { decision: 'ordinary', effect: 'supervised_action' },
      { decision: 'ordinary', classifierVersion: 2 },
      { decision: 'replay', ticket: null, effect: 'supervised_action' },
      {
        decision: 'blocked',
        reasonCode: 'native_x',
        deniedResult: 'rejected',
        ticket: null,
        classifierVersion: 2,
      },
    ] as Array<Record<string, unknown>>) {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) => v2Receipt(input, overrides));
      await expect(preflightAction('pf-v2-shape')).resolves.toEqual({
        result: 'rejected',
        reasonCode: 'native_preflight_invalid',
      });
      expect(dispatchCalls()).toBe(before);
    }
    // A version 2 approval offer missing one of its three added keys is not a version 2 shape.
    for (const missing of ['approvalGeneration', 'remainingMs', 'effect', 'receiptVersion']) {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) => {
        const value = v2Receipt(input, approvalV2);
        delete value[missing];
        return value;
      });
      await expect(preflightAction('pf-v2-missing')).resolves.toEqual({
        result: 'rejected',
        reasonCode: 'native_preflight_invalid',
      });
      expect(dispatchCalls()).toBe(before);
    }
    // Malformed receipts fail closed before any dispatch and never echo the ticket.
    const malformed: Array<Record<string, unknown>> = [
      // N2b-2: single_use_approval is accepted only as the exact closed no-input tuple.
      { decision: 'single_use_approval', ticket, reasonCode: null, deniedResult: null },
      {
        decision: 'single_use_approval',
        ticket: null,
        reasonCode: 'native_x',
        deniedResult: null,
      },
      {
        decision: 'single_use_approval',
        ticket: null,
        reasonCode: null,
        deniedResult: 'paused',
      },
      {
        decision: 'single_use_approval',
        ticket: null,
        reasonCode: null,
        deniedResult: null,
        classifierVersion: 2,
      },
      {
        decision: 'single_use_approval',
        ticket: null,
        reasonCode: null,
        deniedResult: null,
        extra: true,
      },
      ...[
        { requestId: 'other' },
        { sessionId: 'other' },
        { cancelEpoch: 9 },
        { observationRevision: 99 },
      ].map((mismatch) => ({
        decision: 'single_use_approval',
        ticket: null,
        reasonCode: null,
        deniedResult: null,
        ...mismatch,
      })),
      { decision: 'ordinary', ticket: 'short' },
      { decision: 'ordinary', ticket: null },
      { decision: 'ordinary', reasonCode: 'native_x' },
      { decision: 'blocked', ticket },
      { decision: 'denied', reasonCode: null, deniedResult: 'rejected', ticket: null },
      { decision: 'denied', reasonCode: 'x', deniedResult: 'completed', ticket: null },
      { requestId: 'other' },
      { sessionId: 'other' },
      { cancelEpoch: 9 },
      { observationRevision: 99 },
      { classifierVersion: 2 },
      { extra: true },
    ];
    for (const overrides of malformed) {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) => receipt(input, overrides));
      // N2b-4 PR 1: an invalid receipt happens before any input, so it is a typed rejection and
      // never an exception that the controller would record as unknown_effect.
      const failure = await preflightAction('pf-bad');
      expect(failure).toEqual({ result: 'rejected', reasonCode: 'native_preflight_invalid' });
      expect(JSON.stringify(failure)).not.toContain(ticket);
      expect(dispatchCalls()).toBe(before);
    }
    preflight.mockReturnValueOnce('not-an-object');
    await expect(preflightAction('pf-bad')).resolves.toEqual({
      result: 'rejected',
      reasonCode: 'native_preflight_invalid',
    });
    // A receipt whose input count regresses is not trusted.
    {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) => receipt(input, { inputAttemptCount: 1 }));
      await expect(preflightAction('pf-regress')).rejects.toMatchObject({
        reasonCode: 'native_input_receipt_unconfirmed',
      });
      expect(dispatchCalls()).toBe(before);
    }
    // A refused reason outside the contract format is not trusted either.
    {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) =>
        receipt(input, {
          decision: 'denied',
          reasonCode: 'Not A Valid Reason',
          deniedResult: 'rejected',
          ticket: null,
        }),
      );
      await expect(preflightAction('pf-reason')).resolves.toEqual({
        result: 'rejected',
        reasonCode: 'native_preflight_invalid',
      });
      expect(dispatchCalls()).toBe(before);
    }
    // Pre-dispatch failures raised by preflight map like dispatch failures.
    preflight.mockImplementationOnce(() => {
      throw Object.assign(new Error('canceled'), { code: 'CANCELED' });
    });
    await expect(preflightAction('pf-throw')).resolves.toEqual({
      result: 'canceled',
      reasonCode: 'native_canceled_pre_dispatch',
    });
    // A preflight that throws, times out or never answers has no input capability, so it is a typed
    // pre-input rejection as well, never an exception the controller would book as unknown_effect.
    for (const failure of [
      new Error('preflight blew up'),
      Object.assign(new Error('timeout'), { code: 'TIMEOUT' }),
      Object.assign(new Error('addon unavailable'), { reasonCode: 'native_unavailable' }),
    ]) {
      const before = dispatchCalls();
      preflight.mockImplementationOnce(() => {
        throw failure;
      });
      await expect(preflightAction('pf-throw-generic')).resolves.toEqual({
        result: 'rejected',
        reasonCode: 'native_preflight_failed',
      });
      expect(dispatchCalls()).toBe(before);
    }
    // An input count that went backwards may mean input happened, so that one still throws.
    {
      const before = dispatchCalls();
      preflight.mockImplementationOnce((input) => receipt(input, { inputAttemptCount: 1 }));
      await expect(preflightAction('pf-regress-2')).rejects.toMatchObject({
        reasonCode: 'native_input_receipt_unconfirmed',
      });
      expect(dispatchCalls()).toBe(before);
    }
    delete withPreflight.preflight;
    await preflightAction('pf-legacy');
    expect(dispatch.mock.calls.at(-1)![0]).not.toHaveProperty('ticket');
    dispatch.mockReturnValueOnce({
      result: 'completed',
      reasonCode: null,
      accepted: true,
      effectStarted: true,
      requestId: 'different-request',
      sessionId: 'session-1',
      observationRevision: 1,
      actionDigest: digest('f'),
    });
    await expect(
      host.dispatch({
        session,
        requestId: 'request-3',
        action: { type: 'click', x: 0.5, y: 0.5, button: 'left' },
        observationRevision: observation.revision,
        cancelEpoch: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ reasonCode: 'native_action_envelope_invalid' });
    dispatch.mockImplementationOnce((input: unknown) => {
      const request = input as Record<string, unknown>;
      return {
        result: 'unknown_effect',
        reasonCode: 'native_input_effect_unknown',
        accepted: true,
        effectStarted: false,
        requestId: request['requestId'],
        sessionId: request['sessionId'],
        observationRevision: request['observationRevision'],
        actionDigest: request['actionDigest'],
      };
    });
    await expect(
      host.dispatch({
        session,
        requestId: 'request-4',
        action: { type: 'click', x: 0.5, y: 0.5, button: 'left' },
        observationRevision: observation.revision,
        cancelEpoch: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ reasonCode: 'native_action_effect_invalid' });
    addon.cancel.mockReturnValueOnce({
      result: 'canceled',
      drained: true,
      sessionId: session.sessionId,
      cancelEpoch: 1,
    });
    await expect(host.cancel(session, 1)).rejects.toMatchObject({
      reasonCode: 'native_input_receipt_unconfirmed',
    });
    expect(host.availability().control).toBe(false);
    const assertQuarantined = async () => {
      expect(host.availability()).toMatchObject({
        state: 'native_unavailable',
        observe: false,
        control: false,
        reasonCode: 'native_stop_unconfirmed',
      });
      const starts = startSession.mock.calls.length;
      const inputs = dispatch.mock.calls.length;
      await expect(
        host.startSession({ ...startInput, sessionId: 'new-session' }),
      ).rejects.toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      await expect(
        host.observe(session, { requestId: 'quarantined-observe', cancelEpoch: 0 }),
      ).rejects.toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      await expect(
        host.dispatch({
          session,
          requestId: 'quarantined-input',
          action: { type: 'click', x: 0.5, y: 0.5, button: 'left' },
          observationRevision: 1,
          cancelEpoch: 0,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      expect(startSession).toHaveBeenCalledTimes(starts);
      expect(dispatch).toHaveBeenCalledTimes(inputs);
    };
    await assertQuarantined();
    addon.cancel.mockReturnValueOnce({
      result: 'canceled',
      drained: true,
      sessionId: session.sessionId,
      cancelEpoch: 1,
      inputAttemptCount: 1,
    });
    await expect(host.cancel(session, 1)).rejects.toMatchObject({
      reasonCode: 'native_input_receipt_unconfirmed',
    });
    addon.cancel.mockImplementationOnce(() => {
      throw new Error('native drain worker failed');
    });
    await expect(host.cancel(session, 1)).rejects.toThrow('native drain worker failed');
    let lateResolve!: (value: unknown) => void;
    addon.cancel.mockReturnValueOnce(
      new Promise((resolve) => {
        lateResolve = resolve;
      }),
    );
    await expect(host.cancel(session, 1)).rejects.toMatchObject({
      reasonCode: 'native_stop_unconfirmed',
    });
    await assertQuarantined();
    lateResolve({
      result: 'canceled',
      drained: true,
      sessionId: session.sessionId,
      cancelEpoch: 1,
      inputAttemptCount: 2,
    });
    await Promise.resolve();
    await assertQuarantined();
    await expect(host.cancel(session, 1)).resolves.toEqual({
      sessionId: session.sessionId,
      cancelEpoch: 1,
      inputAttemptCount: 2,
    });
    for (const override of [
      null,
      { result: 'unknown_effect' },
      { drained: false },
      { sessionId: 'other-session' },
      { cancelEpoch: 0 },
      { inputAttemptCount: -1 },
      { inputAttemptCount: 1 },
      { inputAttemptCount: undefined },
      { rawInput: 'fixture' },
    ]) {
      addon.close.mockImplementationOnce((input: unknown) => {
        const request = input as Record<string, unknown>;
        return override === null
          ? {}
          : {
              result: 'closed',
              drained: true,
              sessionId: request['sessionId'],
              cancelEpoch: request['cancelEpoch'],
              inputAttemptCount: 2,
              ...override,
            };
      });
      await expect(host.close(session)).rejects.toBeInstanceOf(Error);
      await assertQuarantined();
    }
    let lateClose!: () => void;
    addon.close.mockImplementationOnce(
      (input: unknown) =>
        new Promise((resolve) => {
          const request = input as Record<string, unknown>;
          lateClose = () =>
            resolve({
              result: 'closed',
              drained: true,
              sessionId: request['sessionId'],
              cancelEpoch: request['cancelEpoch'],
              inputAttemptCount: 2,
            });
        }),
    );
    await expect(host.close(session)).rejects.toMatchObject({
      reasonCode: 'native_stop_unconfirmed',
    });
    await assertQuarantined();
    lateClose();
    await Promise.resolve();
    await assertQuarantined();
    await host.close(session);
    expect(addon.cancel).toHaveBeenCalledTimes(5);
    expect(addon.close).toHaveBeenCalledTimes(11);
    await host.close(session);
    expect(addon.close).toHaveBeenCalledTimes(11);
    expect(host.availability().control).toBe(true);
  });

  it('lets a slow native close drain instead of quarantining the host after one second', async () => {
    const appIdentityDigest = digest('a');
    const executableDigest = digest('b');
    const windowIdentityDigest = digest('c');
    const cancel = vi.fn();
    const close = vi.fn();
    const addon = {
      probe: () => ({}),
      pickApplication: () => ({
        platform: 'darwin' as const,
        identityDigest: appIdentityDigest,
        executablePath: '/Applications/Target.app/Contents/MacOS/Target',
        executableDigest,
        bundleId: 'com.example.Target',
        teamId: null,
        signingIdentifier: null,
        cdHash: null,
        displayName: 'Target',
        policyLanguage: 'ja',
        maximumMode: 'full_access_app',
        pid: 42,
      }),
      listWindows: () => [
        {
          pid: 42,
          windowId: 'window-1',
          platform: 'darwin' as const,
          appIdentityDigest,
          windowIdentityDigest,
          title: 'Target',
          bounds: { x: 0, y: 0, width: 100, height: 80 },
          screenBounds: { x: 0, y: 0, width: 100, height: 80 },
          focused: true,
          eligible: true,
          ownerKind: 'application' as const,
          modal: false,
          revision: 4,
          policyLanguage: 'ja',
          maximumMode: 'full_access_app',
        },
      ],
      startSession: () => ({
        inputAttemptCount: 0,
        sessionId: 'session-1',
        platform: 'darwin' as const,
        appIdentityDigest,
        windowIdentityDigest,
        windowId: 'window-1',
        profileRevision: 3,
        cancelEpoch: 0,
        policyLanguage: 'ja',
        maximumMode: 'full_access_app',
        screenBounds: { x: 0, y: 0, width: 100, height: 80 },
        pid: 42,
      }),
      observe: () => ({}),
      dispatch: () => ({}),
      cancel,
      close,
    };

    vi.useFakeTimers();
    try {
      const host = createComputerUseNativeHost(binding(addon), 'darwin');
      const identity = await host.pickApplication({
        activationToken: 'main-issued-token',
        pickerKind: 'application',
      });
      const profile = {
        id: 'profile-1',
        platform: 'darwin' as const,
        kind: 'macos-bundle' as const,
        label: 'Target',
        canonicalPath: '/Applications/Target.app/Contents/MacOS/Target',
        appUrl: null,
        identity: identity!,
        identityDigest: appIdentityDigest,
        version: null,
        executableDigest,
        mode: 'full_access_app' as const,
        connectionId: 'connection-1',
        modelId: 'model-1',
        providerEgressConsent: true,
        remember: false,
        revision: 3,
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      };
      const session = await host.startSession({
        profile,
        windowId: 'window-1',
        sessionId: 'session-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        cancelEpoch: 0,
      });

      // Emergency cancel only waits for the native input epoch to be invalidated, so it keeps the
      // short acknowledgement deadline.
      cancel.mockImplementationOnce(() => new Promise(() => {}));
      const canceled = host.cancel(session, 1);
      const cancelSettled = vi.fn();
      void canceled.then(cancelSettled, cancelSettled);
      await vi.advanceTimersByTimeAsync(999);
      expect(cancelSettled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(canceled).rejects.toMatchObject({ reasonCode: 'native_stop_unconfirmed' });

      // Close additionally waits for the native stop lane to drain. Declaring that unconfirmed
      // after a second would keep the whole host quarantined for an ordinary drain, because only a
      // verified close releases the quarantine and the Controller drops the session handle.
      let resolveClose!: () => void;
      close.mockImplementationOnce(
        (input: unknown) =>
          new Promise((resolve) => {
            const request = input as Record<string, unknown>;
            resolveClose = () =>
              resolve({
                result: 'closed',
                drained: true,
                sessionId: request['sessionId'],
                cancelEpoch: request['cancelEpoch'],
                inputAttemptCount: 0,
              });
          }),
      );
      const closed = host.close(session);
      const closeSettled = vi.fn();
      void closed.then(closeSettled, closeSettled);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(closeSettled).not.toHaveBeenCalled();
      expect(host.availability()).toMatchObject({
        observe: false,
        control: false,
        reasonCode: 'native_stop_unconfirmed',
      });

      resolveClose();
      await expect(closed).resolves.toBeUndefined();
      expect(host.availability()).toMatchObject({
        state: 'ready',
        observe: true,
        control: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the quarantine only once a re-sent close is answered as confirmed', async () => {
    const appIdentityDigest = digest('a');
    const executableDigest = digest('b');
    const windowIdentityDigest = digest('c');
    // Model the native close bookkeeping. The first close takes the session out of the native
    // active map and its drain outlives the Main-side deadline, so Main never sees that receipt.
    // Everything after it depends on how native answers a close re-sent for the same session id:
    // an id native cannot confirm stays quarantined, and only a confirmed receipt reopens the host.
    const closeEpochs: unknown[] = [];
    let nativeCloseConfirmed = false;
    let closesInFlight = 0;
    let releaseFirstClose!: () => void;
    const close = vi.fn((input: unknown): unknown => {
      const request = input as Record<string, unknown>;
      closeEpochs.push(request['cancelEpoch']);
      if (closeEpochs.length === 1) {
        closesInFlight += 1;
        return new Promise((resolve) => {
          releaseFirstClose = () => {
            closesInFlight -= 1;
            resolve(undefined);
          };
        });
      }
      if (!nativeCloseConfirmed)
        throw Object.assign(new Error('Native close is unconfirmed'), { code: 'SESSION_MISSING' });
      return {
        result: 'closed',
        drained: true,
        sessionId: request['sessionId'],
        cancelEpoch: request['cancelEpoch'],
        inputAttemptCount: 0,
      };
    });
    const addon = {
      probe: () => ({}),
      pickApplication: () => ({
        platform: 'darwin' as const,
        identityDigest: appIdentityDigest,
        executablePath: '/Applications/Target.app/Contents/MacOS/Target',
        executableDigest,
        bundleId: 'com.example.Target',
        teamId: null,
        signingIdentifier: null,
        cdHash: null,
        displayName: 'Target',
        policyLanguage: 'ja',
        maximumMode: 'full_access_app',
        pid: 42,
      }),
      listWindows: () => [
        {
          pid: 42,
          windowId: 'window-1',
          platform: 'darwin' as const,
          appIdentityDigest,
          windowIdentityDigest,
          title: 'Target',
          bounds: { x: 0, y: 0, width: 100, height: 80 },
          screenBounds: { x: 0, y: 0, width: 100, height: 80 },
          focused: true,
          eligible: true,
          ownerKind: 'application' as const,
          modal: false,
          revision: 4,
          policyLanguage: 'ja',
          maximumMode: 'full_access_app',
        },
      ],
      startSession: () => ({
        inputAttemptCount: 0,
        sessionId: 'session-1',
        platform: 'darwin' as const,
        appIdentityDigest,
        windowIdentityDigest,
        windowId: 'window-1',
        profileRevision: 3,
        cancelEpoch: 0,
        policyLanguage: 'ja',
        maximumMode: 'full_access_app',
        screenBounds: { x: 0, y: 0, width: 100, height: 80 },
        pid: 42,
      }),
      observe: () => ({}),
      dispatch: () => ({}),
      cancel: vi.fn(),
      close,
    };
    const host = createComputerUseNativeHost(binding(addon), 'darwin', { stopTimeoutMs: 10 });
    const identity = await host.pickApplication({
      activationToken: 'main-issued-token',
      pickerKind: 'application',
    });
    const profile = {
      id: 'profile-1',
      platform: 'darwin' as const,
      kind: 'macos-bundle' as const,
      label: 'Target',
      canonicalPath: '/Applications/Target.app/Contents/MacOS/Target',
      appUrl: null,
      identity: identity!,
      identityDigest: appIdentityDigest,
      version: null,
      executableDigest,
      mode: 'full_access_app' as const,
      connectionId: 'connection-1',
      modelId: 'model-1',
      providerEgressConsent: true,
      remember: false,
      revision: 3,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    };
    const session = await host.startSession({
      profile,
      windowId: 'window-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
    });

    await expect(host.close(session)).rejects.toMatchObject({
      reasonCode: 'native_stop_unconfirmed',
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(host.close(session)).rejects.toBeInstanceOf(Error);
      expect(host.availability()).toMatchObject({
        observe: false,
        control: false,
        reasonCode: 'native_stop_unconfirmed',
      });
      await expect(
        host.startSession({
          profile,
          windowId: 'window-1',
          sessionId: 'session-2',
          taskId: 'task-1',
          turnId: 'turn-2',
          cancelEpoch: 0,
        }),
      ).rejects.toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
    }

    // Re-send from the rejection handler, the way ComputerUseController answers an unconfirmed
    // close, and let native confirm the drain by the time that re-send arrives. The first attempt
    // is still on the wire throughout, which is what keeps a Windows helper that only ends once no
    // stop is pending reachable for the re-send.
    await expect(
      host.close(session).then(null, async () => {
        nativeCloseConfirmed = true;
        return await host.close(session);
      }),
    ).resolves.toBeUndefined();
    expect(closesInFlight).toBe(1);
    expect(host.availability()).toMatchObject({ state: 'ready', observe: true, control: true });
    // Every re-sent close carries a strictly higher epoch, which is what lets native tell a repeat
    // close apart from a stale one.
    expect(closeEpochs).toEqual([1, 2, 3, 4, 5]);
    releaseFirstClose();
    expect(closesInFlight).toBe(0);
    // A confirmed session id stays idempotent without reaching native again.
    await expect(host.close(session)).resolves.toBeUndefined();
    expect(closeEpochs).toHaveLength(5);
  });

  it('fails closed when an API1 manifest is mixed with an API2 helper', () => {
    const native = binding({
      probe: () => ({}),
      pickApplication: () => ({}),
      listWindows: () => [],
      startSession: () => ({}),
      observe: () => ({}),
      dispatch: () => ({}),
      cancel: () => undefined,
      close: () => undefined,
    });
    native.manifest.apiVersion = 1;
    expect(createComputerUseNativeHost(native, 'darwin').availability()).toMatchObject({
      handshakeReady: false,
      observe: false,
      control: false,
    });
  });

  it('fails closed for unknown, too-deep, and over-node-limit tree shapes', () => {
    expect(() =>
      projectComputerUseAccessibilityTree(
        JSON.stringify({
          role: 'AXWindow',
          title: '',
          identifier: '',
          unexpected: 'raw text',
          children: [],
        }),
      ),
    ).toThrow();

    let tooDeep: unknown = { role: 'AXButton', title: '', identifier: '', children: [] };
    for (let depth = 0; depth < 17; depth += 1)
      tooDeep = { role: 'AXGroup', title: '', identifier: '', children: [tooDeep] };
    expect(() => projectComputerUseAccessibilityTree(JSON.stringify(tooDeep))).toThrow();

    const tooManyNodes = {
      role: 'AXWindow',
      title: '',
      identifier: '',
      children: Array.from({ length: 5_000 }, () => ({
        role: 'AXButton',
        title: '',
        identifier: '',
        children: [],
      })),
    };
    expect(() => projectComputerUseAccessibilityTree(JSON.stringify(tooManyNodes))).toThrow();
  });

  it('produces an idempotent canonical projection', () => {
    const first = projectComputerUseAccessibilityTree(
      JSON.stringify({
        role: 'AXWindow',
        title: 'Document',
        identifier: 'main',
        children: [
          {
            role: 'AXButton',
            title: 'Purchase',
            identifier: 'checkout',
            children: [],
          },
        ],
      }),
    );
    const second = projectComputerUseAccessibilityTree(first.serialized);

    expect(second.serialized).toBe(first.serialized);
    expect(second.digest).toBe(first.digest);
    expect(second.byteLength).toBe(first.byteLength);
    expect(second.depth).toBe(first.depth);
    expect(second.nodeCount).toBe(first.nodeCount);
  });

  it('treats integrated terminal and shell controls as redacted high-impact targets', () => {
    const projection = projectComputerUseAccessibilityTree(
      JSON.stringify({
        role: 'AXWindow',
        title: 'Editor',
        identifier: 'main',
        children: [
          {
            role: 'AXTextArea',
            title: 'Integrated Terminal',
            identifier: 'terminal-input',
            children: [],
          },
        ],
      }),
    );
    expect(projection.metadata['terminal-input']).toMatchObject({ highImpact: true });
    expect(projection.serialized).not.toContain('Integrated Terminal');
    expect(projection.serialized).not.toContain('terminal-input');
  });
});

describe('Computer Use native OS permission availability', () => {
  const controllerAddon = {
    probe: () => ({}),
    pickApplication: () => ({}),
    listWindows: () => [],
    startSession: () => ({}),
    observe: () => ({}),
    dispatch: () => ({}),
    cancel: () => undefined,
    close: () => undefined,
  };

  it('reports each missing macOS permission by name and stays fail-closed', () => {
    const host = createComputerUseNativeHost(
      binding(controllerAddon, {
        available: false,
        reason: 'ACCESSIBILITY_PERMISSION_REQUIRED',
        capabilities: {
          observe: false,
          control: false,
          accessibility: false,
          screenCapture: true,
          screenCaptureKit: true,
        },
      }),
      'darwin',
    );

    expect(host.availability()).toMatchObject({
      state: 'permission_required',
      packageReady: true,
      handshakeReady: true,
      observe: false,
      control: false,
      available: false,
      reasonCode: 'accessibility_permission_required',
      missingPermissions: ['accessibility'],
    });
  });

  it('reports both missing macOS permissions when neither is granted', () => {
    const host = createComputerUseNativeHost(
      binding(controllerAddon, {
        available: false,
        reason: 'SCREEN_RECORDING_PERMISSION_REQUIRED',
        capabilities: {
          observe: false,
          control: false,
          accessibility: false,
          screenCapture: false,
          screenCaptureKit: true,
        },
      }),
      'darwin',
    );

    expect(host.availability().missingPermissions).toEqual(['accessibility', 'screen_recording']);
  });

  it('never names a permission when the native probe did not measure one', () => {
    const host = createComputerUseNativeHost(
      binding(controllerAddon, {
        available: false,
        reason: 'UI_AUTOMATION_UNAVAILABLE',
        capabilities: { observe: false, control: false },
      }),
      'win32',
    );

    expect(
      createComputerUseNativeHost(
        binding(controllerAddon, {
          available: false,
          reason: 'UI_AUTOMATION_UNAVAILABLE',
          capabilities: { observe: false, control: false },
        }),
        'win32',
        { windowsPhysicalBoundsToDip: (bounds) => bounds },
      ).availability(),
    ).toMatchObject({
      state: 'native_unavailable',
      reasonCode: 'ui_automation_unavailable',
      missingPermissions: [],
    });
    expect(host.availability().missingPermissions).toEqual([]);
  });

  it('keeps a ready host free of any permission guidance', () => {
    const host = createComputerUseNativeHost(binding(controllerAddon), 'darwin');

    expect(host.availability()).toMatchObject({
      state: 'ready',
      available: true,
      missingPermissions: [],
    });
  });

  it('validates the nine-key approvalApprove receipt as typed pre-input results', () => {
    const expected = {
      sessionId: 'session-1',
      requestId: 'request-2',
      cancelEpoch: 3,
      observationRevision: 11,
      approvalGeneration: 7,
    };
    const ok = {
      ok: true,
      reasonCode: null,
      deniedResult: null,
      ...expected,
      inputAttemptCount: 4,
    };
    const invalid = {
      kind: 'invalid',
      result: 'rejected',
      reasonCode: 'native_approval_receipt_invalid',
    };
    expect(parseNativeApprovalApproveReceipt(ok, expected)).toEqual({
      kind: 'approved',
      inputAttemptCount: 4,
    });
    for (const [result, reasonCode] of [
      ['rejected', 'native_approval_expired'],
      ['paused', 'native_approval_revalidation_failed'],
      ['canceled', 'native_canceled_pre_dispatch'],
    ] as const)
      expect(
        parseNativeApprovalApproveReceipt(
          { ...ok, ok: false, reasonCode, deniedResult: result },
          expected,
        ),
      ).toEqual({ kind: 'refused', result, reasonCode, inputAttemptCount: 4 });
    const bad: Array<Record<string, unknown>> = [
      { sessionId: 'other' },
      { requestId: 'other' },
      { cancelEpoch: 9 },
      { observationRevision: 99 },
      { approvalGeneration: 8 },
      { ok: 'true' },
      { ok: 1 },
      { ok: undefined },
      { inputAttemptCount: -1 },
      { inputAttemptCount: 1.5 },
      { inputAttemptCount: '4' },
      { inputAttemptCount: Number.MAX_SAFE_INTEGER + 1 },
      { extra: true },
      // ok / reasonCode / deniedResult combinations
      { reasonCode: 'native_x' },
      { deniedResult: 'rejected' },
      { ok: false },
      { ok: false, reasonCode: 'native_x' },
      { ok: false, deniedResult: 'rejected' },
      { ok: false, reasonCode: 'native_x', deniedResult: 'completed' },
      { ok: false, reasonCode: 'Not A Valid Reason', deniedResult: 'rejected' },
      { ok: false, reasonCode: 5, deniedResult: 'rejected' },
    ];
    for (const overrides of bad) {
      const value: Record<string, unknown> = { ...ok, ...overrides };
      for (const [key, entry] of Object.entries(value)) if (entry === undefined) delete value[key];
      expect(parseNativeApprovalApproveReceipt(value, expected), JSON.stringify(overrides)).toEqual(
        invalid,
      );
    }
    for (const key of Object.keys(ok)) {
      const value: Record<string, unknown> = { ...ok };
      delete value[key];
      expect(parseNativeApprovalApproveReceipt(value, expected), key).toEqual(invalid);
    }
    for (const notAnObject of [null, undefined, 'ok', 7, [], [ok]])
      expect(parseNativeApprovalApproveReceipt(notAnObject, expected)).toEqual(invalid);
  });
});

describe('Main surface structure words (S4-1c)', () => {
  const tree = (...nodes: Array<[string, string]>): string => {
    let node: unknown = { role: 'AXButton', title: 'Run', identifier: 'run', children: [] };
    for (const [role, identifier] of [...nodes].reverse())
      node = { role, title: '', identifier, children: [node] };
    return JSON.stringify(node);
  };

  it('marks a target under a terminal structure word, by its ancestors too', () => {
    for (const identifier of [
      'terminal',
      'integratedTerminal',
      'workbench.panel.terminal',
      'xterm-screen',
      'PowerShell',
      'XTerm',
      'XTermView',
      'Terminal2',
      'PWSH7',
      'TermControl',
      'TermControlView',
      'power-shell-script',
      'Power Shell',
      'power_shell',
      'power.shell',
      'workbench.XTermView',
      'long-terminal-panel',
      'x.TermControl',
      'ｔｅｒｍｉｎａｌ',
    ]) {
      const projection = projectComputerUseAccessibilityTree(
        tree(['AXWindow', 'main'], ['AXGroup', identifier]),
      );
      expect(projection.metadata['run'], identifier).toMatchObject({ surface: true });
    }
    expect(
      projectComputerUseAccessibilityTree(tree(['AXTerminalView', 'x'])).metadata['run'],
    ).toMatchObject({ surface: true });
  });

  it('is a positive match only: titles, other words and an ordinary editor never match', () => {
    for (const identifier of [
      'editor',
      'app-shell',
      'terminalbank',
      'terminalbank2',
      'long-term-control',
      'shortTermControl',
      'LongTermControl',
      'axis-x-term',
      'x_term_count',
      'console',
      'command-palette',
      'CommandPalette',
      'quick-command-palette',
      'workbench.parts.editor',
    ]) {
      const projection = projectComputerUseAccessibilityTree(
        tree(['AXWindow', 'main'], ['AXTextArea', identifier]),
      );
      expect(projection.metadata['run'], identifier).not.toHaveProperty('surface');
    }
    // A title is not evidence (v1 and the high-impact words handle labels).
    const titled = projectComputerUseAccessibilityTree(
      JSON.stringify({
        role: 'AXWindow',
        title: 'Terminal notes',
        identifier: '',
        children: [{ role: 'AXButton', title: 'Save', identifier: 'save', children: [] }],
      }),
    );
    expect(titled.metadata['save']).not.toHaveProperty('surface');
  });
});

describe('Main surface evidence reaches the observation (S4-1c wiring)', () => {
  const appIdentityDigest = digest('a');
  const windowIdentityDigest = digest('c');
  const screenshot = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const treeUnder = (identifier: string): string =>
    JSON.stringify({
      role: 'AXWindow',
      title: 'Target',
      identifier: '',
      children: [
        {
          role: 'AXGroup',
          title: '',
          identifier,
          children: [{ role: 'AXButton', title: 'Run', identifier: 'run', children: [] }],
        },
      ],
    });

  async function observeThrough(payloads: Array<() => Record<string, unknown>>) {
    const screenBounds = { x: 0, y: 0, width: 100, height: 80 };
    let call = 0;
    const addon = {
      probe: () => ({}),
      pickApplication: () => ({
        platform: 'darwin' as const,
        identityDigest: appIdentityDigest,
        executablePath: '/Applications/Target.app/Contents/MacOS/Target',
        executableDigest: digest('b'),
        bundleId: 'com.example.Target',
        teamId: null,
        signingIdentifier: null,
        cdHash: null,
        displayName: 'Target',
        policyLanguage: 'en',
        maximumMode: 'full_access_app',
        pid: 42,
      }),
      listWindows: () => [
        {
          pid: 42,
          windowId: 'window-1',
          platform: 'darwin' as const,
          appIdentityDigest,
          windowIdentityDigest,
          title: 'Target',
          bounds: screenBounds,
          screenBounds,
          focused: true,
          eligible: true,
          ownerKind: 'application' as const,
          modal: false,
          revision: 4,
          policyLanguage: 'en',
          maximumMode: 'full_access_app',
        },
      ],
      startSession: () => ({
        inputAttemptCount: 0,
        sessionId: 'session-1',
        platform: 'darwin' as const,
        appIdentityDigest,
        windowIdentityDigest,
        windowId: 'window-1',
        profileRevision: 3,
        cancelEpoch: 0,
        policyLanguage: 'en',
        maximumMode: 'full_access_app',
        screenBounds,
        pid: 42,
      }),
      observe: () => payloads[Math.min(call++, payloads.length - 1)]!(),
      dispatch: () => ({}),
      cancel: () => ({}),
      close: () => ({}),
    };
    const host = createComputerUseNativeHost(binding(addon), 'darwin', { stopTimeoutMs: 10 });
    const identity = await host.pickApplication({
      activationToken: 'main-issued-token',
      pickerKind: 'application',
    });
    const profile = {
      id: 'profile-1',
      platform: 'darwin' as const,
      kind: 'macos-bundle' as const,
      label: 'Target',
      canonicalPath: '/Applications/Target.app/Contents/MacOS/Target',
      appUrl: null,
      identity: identity!,
      identityDigest: appIdentityDigest,
      version: null,
      executableDigest: digest('b'),
      mode: 'full_access_app' as const,
      connectionId: 'connection-1',
      modelId: 'model-1',
      providerEgressConsent: true,
      remember: false,
      revision: 3,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    };
    const session = await host.startSession({
      profile,
      windowId: 'window-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
    });
    const observe = () => host.observe(session, { requestId: `r-${call}`, cancelEpoch: 0 });
    return { observe };
  }

  const lowLevel = (tree: string) => () => ({
    pid: 42,
    windowId: 'window-1',
    captureWidth: 100,
    captureHeight: 80,
    screenshot,
    screenshotMimeType: 'image/png',
    tree,
    treeNodeCount: 1,
    treeDepth: 0,
    policyLanguage: 'en',
    maximumMode: 'full_access_app',
    screenBounds: { x: 0, y: 0, width: 100, height: 80 },
  });

  it('(a) the low-level native payload carries surface for a target under a terminal ancestor', async () => {
    const { observe } = await observeThrough([
      lowLevel(treeUnder('xterm-screen')),
      lowLevel(treeUnder('editor-pane')),
    ]);
    expect((await observe()).targetMetadata?.['run']).toMatchObject({ surface: true });
    expect((await observe()).targetMetadata?.['run']).not.toHaveProperty('surface');
  });

  it('(b) a canonical native payload cannot clear it: native saying surface:false keeps Main true', async () => {
    const first = lowLevel(treeUnder('xterm-screen'));
    let canonical: Record<string, unknown> = {};
    const { observe } = await observeThrough([first, () => canonical]);
    const seen = await observe();
    canonical = {
      ...seen,
      revision: seen.revision + 1,
      targetMetadata: { run: { secure: false, highImpact: false, surface: false } },
    };
    const again = await observe();
    expect(again.targetMetadata?.['run']).toMatchObject({ surface: true });
  });
});
