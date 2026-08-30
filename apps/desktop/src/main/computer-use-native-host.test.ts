import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ComputerUseNativeBinding } from './computer-use-native';
import { projectComputerUseAccessibilityTree } from './computer-use-accessibility-tree';
import {
  COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE,
  classifyComputerUseNativeDispatchFailure,
  createComputerUseNativeHost,
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
      apiVersion: 1,
      nativeVersion: 'test-native',
      moduleDigest: digest('1'),
      binaryDigest: digest('2'),
      signerDigest: digest('3'),
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
    },
    probe: {
      available: true,
      protocolVersion: 1,
      apiVersion: 1,
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
      state: 'native_unavailable',
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
      };
    });
    const startSession = vi.fn(() => ({
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
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const host = createComputerUseNativeHost(binding(addon), 'darwin');
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
    expect(result).toEqual({ result: 'completed', reasonCode: null });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-2',
        sessionId: 'session-1',
        observationRevision: 1,
        actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
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
    await host.cancel(session, 1);
    await host.close(session);
    expect(addon.cancel).toHaveBeenCalledTimes(1);
    expect(addon.close).toHaveBeenCalledTimes(1);
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
