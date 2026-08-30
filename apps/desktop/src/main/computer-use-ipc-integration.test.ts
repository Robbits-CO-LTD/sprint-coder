import { describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  computerAppProfileSchema,
  computerUseAvailabilitySchema,
  computerUseProfileRegisterInputSchema,
  computerUseSessionStatusSchema,
  type ProviderModel,
} from '@sprint-coder/contracts';
import { computerUseProviderModelIsEligible, IpcRouter, toPublicError } from './ipc';
import {
  approvalActivationIntent,
  quickStartActivationIntent,
  startActivationIntent,
} from '../computer-use-activation-intent';

const electronMock = vi.hoisted(() => ({ ipcMainOn: vi.fn() }));
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  dialog: {},
  ipcMain: { on: electronMock.ipcMainOn },
  MessageChannelMain: class {},
}));

type CapturedHandler = (input: unknown, event: unknown, envelope: unknown) => unknown;

const available = computerUseAvailabilitySchema.parse({
  platform: 'darwin',
  state: 'ready',
  featureEnabled: true,
  packageReady: true,
  handshakeReady: true,
  observe: true,
  control: true,
  available: true,
  reasonCode: null,
  manifestDigest: '1'.repeat(64),
});

const identity = {
  platform: 'darwin' as const,
  identityDigest: 'a'.repeat(64),
  bundleId: 'com.example.Target',
  executablePath: '/Applications/Target.app/Contents/MacOS/Target',
  executableDigest: 'b'.repeat(64),
  teamId: null,
  signingIdentifier: null,
  cdHash: null,
  displayName: 'Target',
  policyLanguage: 'en' as const,
  maximumMode: 'full_access_app' as const,
};

const quickStartCandidate = {
  windowId: 'opaque-window-token',
  platform: 'darwin' as const,
  appIdentityDigest: identity.identityDigest,
  windowIdentityDigest: 'c'.repeat(64),
  title: 'Target window',
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: true,
  eligible: true,
  ownerKind: 'application' as const,
  modal: false,
  revision: 4,
  policyLanguage: 'en' as const,
  maximumMode: 'full_access_app' as const,
};

function quickStartInput(
  overrides: Partial<{
    taskId: string;
    profileId: string;
    windowId: string;
    expectedWindowRevision: number;
    expectedProfileRevision: number;
  }> = {},
) {
  return {
    taskId: 'task-1',
    profileId: 'profile-1',
    windowId: 'opaque-window-token',
    mode: 'full_access_app' as const,
    connectionId: 'builtin:codex-cli',
    modelId: 'auto',
    providerEgressConsent: true,
    providerEgressConsentBinding: {
      connectionId: 'builtin:codex-cli',
      modelId: 'auto',
    },
    remember: false,
    expectedPolicyEpoch: 1,
    expectedWindowRevision: 4,
    expectedProfileRevision: 1,
    ...overrides,
  };
}

function quickStartIntent(input = quickStartInput()): string {
  return quickStartActivationIntent({
    taskId: input.taskId,
    profileId: input.profileId,
    mode: input.mode,
    connectionId: input.connectionId,
    modelId: input.modelId,
    providerEgressConsent: input.providerEgressConsent,
    remember: input.remember,
    expectedPolicyEpoch: input.expectedPolicyEpoch,
    expectedProfileRevision: input.expectedProfileRevision,
  });
}

function captureComputerUseHandlers(): {
  router: IpcRouter & Record<string, unknown>;
  handlers: Map<string, CapturedHandler>;
  activation: {
    consume: ReturnType<typeof vi.fn>;
    generation: ReturnType<typeof vi.fn>;
  };
  controller: Record<string, ReturnType<typeof vi.fn>>;
  native: { pickApplication: ReturnType<typeof vi.fn> };
  persistence: Record<string, ReturnType<typeof vi.fn>>;
} {
  const router = Object.create(IpcRouter.prototype) as IpcRouter & Record<string, unknown>;
  const handlers = new Map<string, CapturedHandler>();
  const capture = (...args: unknown[]): void => {
    const channel = args[0];
    const handler = args[3];
    if (typeof channel !== 'string' || typeof handler !== 'function')
      throw new Error('Unexpected IPC handler registration');
    handlers.set(channel, handler as CapturedHandler);
  };
  const activation = {
    consume: vi.fn(() => null),
    generation: vi.fn(() => 0),
  };
  const controller = {
    availability: vi.fn(() => available),
    listProfiles: vi.fn(() => []),
    registerProfile: vi.fn(() =>
      computerAppProfileSchema.parse({
        id: 'profile-1',
        label: 'Target',
        identity: {
          platform: 'darwin',
          identityDigest: identity.identityDigest,
          displayName: identity.displayName,
          bundleId: identity.bundleId,
          signerDigest: null,
          teamId: null,
          policyLanguage: 'en',
          maximumMode: 'full_access_app',
        },
        mode: 'full_access_app',
        connectionId: 'builtin:codex-cli',
        modelId: 'auto',
        providerEgressConsent: false,
        remember: true,
        profileRevision: 1,
        policyLanguage: 'en',
        maximumMode: 'full_access_app',
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      }),
    ),
    listWindows: vi.fn(async () => []),
    start: vi.fn(async () =>
      computerUseSessionStatusSchema.parse({
        sessionId: 'session-1',
        taskId: 'task-1',
        profileId: 'profile-1',
        windowId: 'window-1',
        connectionId: 'builtin:codex-cli',
        modelId: 'auto',
        appIdentityDigest: identity.identityDigest,
        windowIdentityDigest: 'c'.repeat(64),
        profileRevision: 1,
        mode: 'full_access_app',
        maximumMode: 'full_access_app',
        state: 'starting',
        policyEpoch: 1,
        observationRevision: 0,
        round: 0,
        maxRounds: 25,
        startedAt: '2026-08-29T00:00:00.000Z',
        expiresAt: '2026-08-29T01:00:00.000Z',
        lastObservationAt: null,
        stopReason: null,
        pendingApproval: null,
        policyLanguage: 'en',
      }),
    ),
    stop: vi.fn(async () => undefined),
    stopOutsideTask: vi.fn(async () => undefined),
    resolveApproval: vi.fn(async () => undefined),
    getStatus: vi.fn(() => null),
    policyEpochChanged: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
  const native = { pickApplication: vi.fn(async () => identity) };
  const persistence = {
    getTask: vi.fn(() => ({ id: 'task-1' })),
    getTaskModelSelection: vi.fn(() => null),
    getRuntime: vi.fn(() => 'codex'),
    getModel: vi.fn(() => 'auto'),
    getActiveTurnId: vi.fn(() => null),
    getComputerAppProfile: vi.fn(() => ({ revision: 1 })),
  };
  Object.assign(router, {
    handle: capture,
    handleMutation: capture,
    window: { id: 42, webContents: { once: vi.fn() } },
    computerUseActivationGate: activation,
    computerUseController: controller,
    computerUseNative: native,
    computerUseStatusBySession: new Map(),
    computerUseApprovalSessionById: new Map([['approval-1', 'session-1']]),
    computerUseQuickStartLatches: new Map(),
    teamCoordinator: { hasBusyWorkers: vi.fn(() => false) },
    persistence,
  });
  router.register();
  return { router, handlers, activation, controller, native, persistence };
}

describe('Computer Use Main IPC integration', () => {
  it('requires an available exact catalog model while allowing unknown multimodal capability', () => {
    const model = {
      connectionId: 'connection-1',
      providerId: 'provider-1',
      modelId: 'model-1',
      available: true,
      multimodalInput: { value: null, source: 'unknown' },
    } as unknown as ProviderModel;
    expect(
      computerUseProviderModelIsEligible({
        connectionId: 'connection-1',
        providerId: 'provider-1',
        modelId: 'model-1',
        model,
      }),
    ).toBe(true);
    expect(
      computerUseProviderModelIsEligible({
        connectionId: 'connection-1',
        providerId: 'provider-1',
        modelId: 'model-2',
        model,
      }),
    ).toBe(false);
    expect(
      computerUseProviderModelIsEligible({
        connectionId: 'connection-1',
        providerId: 'provider-1',
        modelId: 'model-1',
        model: { ...model, available: false },
      }),
    ).toBe(false);
    expect(
      computerUseProviderModelIsEligible({
        connectionId: 'connection-1',
        providerId: 'provider-1',
        modelId: 'model-1',
        model: { ...model, multimodalInput: { value: false, source: 'provider_api' } },
      }),
    ).toBe(false);
  });

  it('keeps registration input identity-free and fails closed before picker access', async () => {
    expect(() =>
      computerUseProfileRegisterInputSchema.parse({
        taskId: 'task-1',
        identity,
      }),
    ).toThrow();
    const fixture = captureComputerUseHandlers();
    fixture.activation.consume.mockReturnValue({ token: 'activation-1' });
    fixture.controller.availability!.mockReturnValue({
      ...available,
      state: 'native_unavailable',
      featureEnabled: false,
      packageReady: false,
      handshakeReady: false,
      observe: false,
      control: false,
      available: false,
      reasonCode: 'feature_disabled',
    });
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseProfileRegister)!;
    await expect(handler({ taskId: 'task-1' }, {}, {})).rejects.toBeTruthy();
    expect(fixture.native.pickApplication).not.toHaveBeenCalled();
    try {
      await handler({ taskId: 'task-1' }, {}, {});
    } catch (error) {
      expect(toPublicError(error)).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    }
  });

  it('consumes application activation and persists only the Main-resolved identity', async () => {
    const fixture = captureComputerUseHandlers();
    fixture.activation.consume.mockReturnValue({ token: 'activation-2' });
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseProfileRegister)!;
    await handler({ taskId: 'task-1' }, {}, {});
    expect(fixture.activation.consume).toHaveBeenCalledWith(expect.anything(), 'application');
    expect(fixture.native.pickApplication).toHaveBeenCalledWith({
      activationToken: 'activation-2',
      pickerKind: 'application',
    });
    expect(fixture.controller.registerProfile).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Target', identity }),
    );
  });

  it('keeps window metadata read-only while binding start to one-shot Main activation', async () => {
    const fixture = captureComputerUseHandlers();
    const windowHandler = fixture.handlers.get(IPC_CHANNELS.computerUseWindowCandidates)!;
    const startHandler = fixture.handlers.get(IPC_CHANNELS.computerUseStart)!;
    await expect(
      windowHandler({ taskId: 'task-1', profileId: 'profile-1' }, {}, {}),
    ).resolves.toMatchObject({
      profileId: 'profile-1',
    });
    expect(fixture.controller.listWindows).toHaveBeenCalledWith('profile-1');
    const startInput = quickStartInput({
      windowId: 'window-1',
      expectedWindowRevision: 1,
    });
    fixture.activation.consume.mockReturnValueOnce(null);
    await expect(startHandler(startInput, {}, {})).rejects.toBeTruthy();
    expect(fixture.controller.start).not.toHaveBeenCalled();
    fixture.activation.consume.mockReturnValueOnce({
      token: 'wrong-start',
      intent: startActivationIntent({ ...startInput, mode: 'supervised' }),
    });
    await expect(startHandler(startInput, {}, {})).rejects.toBeTruthy();
    expect(fixture.controller.start).not.toHaveBeenCalled();
    fixture.activation.consume.mockReturnValueOnce({
      token: 'start-1',
      intent: startActivationIntent(startInput),
    });
    await startHandler(startInput, {}, {});
    expect(fixture.activation.consume).toHaveBeenLastCalledWith(expect.anything(), 'start');
    expect(fixture.controller.start).toHaveBeenCalledWith(
      expect.objectContaining({ remember: false }),
    );
  });

  it('does not authorize target full access from the Sprint Coder application locale', async () => {
    const fixture = captureComputerUseHandlers();
    const startHandler = fixture.handlers.get(IPC_CHANNELS.computerUseStart)!;
    const input = quickStartInput();
    fixture.activation.consume.mockReturnValueOnce({
      token: 'start-unsupported-locale',
      intent: startActivationIntent(input),
    });
    await expect(startHandler(input, {}, {})).resolves.toBeDefined();
    expect(fixture.controller.start).toHaveBeenCalledWith(input);
  });

  it('latches a single Quick Start window to the exact returned token and consumes it once', async () => {
    const fixture = captureComputerUseHandlers();
    const windowHandler = fixture.handlers.get(IPC_CHANNELS.computerUseWindowCandidates)!;
    const startHandler = fixture.handlers.get(IPC_CHANNELS.computerUseStart)!;
    const event = {
      sender: { id: 7 },
      senderFrame: { processId: 11, routingId: 13 },
    };
    fixture.controller.listWindows!.mockResolvedValue([quickStartCandidate]);
    fixture.activation.generation.mockReturnValue(3);
    fixture.activation.consume.mockReturnValueOnce({
      token: 'quick-start-activation',
      generation: 3,
      intent: quickStartIntent(),
    });

    await windowHandler({ taskId: 'task-1', profileId: 'profile-1' }, event, {});
    fixture.activation.consume.mockReturnValueOnce(null);
    await startHandler(quickStartInput(), event, {});
    expect(fixture.controller.start).toHaveBeenCalledTimes(1);

    fixture.activation.consume.mockReturnValueOnce(null);
    await expect(startHandler(quickStartInput(), event, {})).rejects.toBeTruthy();
    expect(fixture.controller.start).toHaveBeenCalledTimes(1);
  });

  it('binds Quick Start activation to the pre-update profile and starts only the refreshed revision', async () => {
    const fixture = captureComputerUseHandlers();
    const windowHandler = fixture.handlers.get(IPC_CHANNELS.computerUseWindowCandidates)!;
    const startHandler = fixture.handlers.get(IPC_CHANNELS.computerUseStart)!;
    const event = {
      sender: { id: 7 },
      senderFrame: { processId: 11, routingId: 13 },
    };
    fixture.controller.listWindows!.mockResolvedValue([quickStartCandidate]);
    fixture.persistence
      .getComputerAppProfile!.mockReturnValueOnce({ revision: 1 })
      .mockReturnValue({ revision: 2 });
    fixture.activation.generation.mockReturnValue(3);
    fixture.activation.consume.mockReturnValueOnce({
      token: 'signed-update-activation',
      generation: 3,
      intent: quickStartIntent(quickStartInput({ expectedProfileRevision: 1 })),
    });

    await windowHandler({ taskId: 'task-1', profileId: 'profile-1' }, event, {});
    fixture.activation.consume.mockReturnValueOnce(null);
    const refreshedInput = quickStartInput({ expectedProfileRevision: 2 });
    await startHandler(refreshedInput, event, {});
    expect(fixture.controller.start).toHaveBeenCalledWith(refreshedInput);

    fixture.activation.consume.mockReturnValueOnce(null);
    await expect(startHandler(refreshedInput, event, {})).rejects.toBeTruthy();
    expect(fixture.controller.start).toHaveBeenCalledTimes(1);
  });

  it('does not latch an arbitrary profile revision jump during Quick Start enumeration', async () => {
    const fixture = captureComputerUseHandlers();
    const windowHandler = fixture.handlers.get(IPC_CHANNELS.computerUseWindowCandidates)!;
    const startHandler = fixture.handlers.get(IPC_CHANNELS.computerUseStart)!;
    const event = {
      sender: { id: 7 },
      senderFrame: { processId: 11, routingId: 13 },
    };
    fixture.controller.listWindows!.mockResolvedValue([quickStartCandidate]);
    fixture.persistence
      .getComputerAppProfile!.mockReturnValueOnce({ revision: 1 })
      .mockReturnValue({ revision: 3 });
    fixture.activation.generation.mockReturnValue(3);
    fixture.activation.consume.mockReturnValueOnce({
      token: 'stale-signed-update-activation',
      generation: 3,
      intent: quickStartIntent(quickStartInput({ expectedProfileRevision: 1 })),
    });

    await windowHandler({ taskId: 'task-1', profileId: 'profile-1' }, event, {});
    fixture.activation.consume.mockReturnValueOnce(null);
    await expect(
      startHandler(quickStartInput({ expectedProfileRevision: 3 }), event, {}),
    ).rejects.toBeTruthy();
    expect(fixture.controller.start).not.toHaveBeenCalled();
  });

  it('rejects a deferred Quick Start after a newer gesture changes the Main generation', async () => {
    const fixture = captureComputerUseHandlers();
    const windowHandler = fixture.handlers.get(IPC_CHANNELS.computerUseWindowCandidates)!;
    const startHandler = fixture.handlers.get(IPC_CHANNELS.computerUseStart)!;
    const event = {
      sender: { id: 7 },
      senderFrame: { processId: 11, routingId: 13 },
    };
    fixture.controller.listWindows!.mockResolvedValue([quickStartCandidate]);
    fixture.activation.generation.mockReturnValue(3);
    fixture.activation.consume.mockReturnValueOnce({
      token: 'quick-start-activation',
      generation: 3,
      intent: quickStartIntent(),
    });
    await windowHandler({ taskId: 'task-1', profileId: 'profile-1' }, event, {});

    fixture.activation.generation.mockReturnValue(4);
    fixture.activation.consume.mockReturnValueOnce(null);
    await expect(startHandler(quickStartInput(), event, {})).rejects.toBeTruthy();
    expect(fixture.controller.start).not.toHaveBeenCalled();
  });

  it('rejects deferred Quick Start from another sender and after switching away and back', async () => {
    const fixture = captureComputerUseHandlers();
    const windowHandler = fixture.handlers.get(IPC_CHANNELS.computerUseWindowCandidates)!;
    const startHandler = fixture.handlers.get(IPC_CHANNELS.computerUseStart)!;
    const event = {
      sender: { id: 7 },
      senderFrame: { processId: 11, routingId: 13 },
    };
    const otherSenderEvent = {
      sender: { id: 8 },
      senderFrame: { processId: 11, routingId: 13 },
    };
    fixture.controller.listWindows!.mockResolvedValue([quickStartCandidate]);
    fixture.activation.generation.mockReturnValue(3);
    fixture.activation.consume.mockReturnValueOnce({
      token: 'quick-start-activation',
      generation: 3,
      intent: quickStartIntent(),
    });
    await windowHandler({ taskId: 'task-1', profileId: 'profile-1' }, event, {});

    fixture.activation.consume.mockReturnValueOnce(null);
    await expect(startHandler(quickStartInput(), otherSenderEvent, {})).rejects.toBeTruthy();
    expect(fixture.controller.start).not.toHaveBeenCalled();

    const stopOutsideTask = (
      fixture.router as unknown as {
        stopComputerUseOutsideTask: (taskId: string) => Promise<void>;
      }
    ).stopComputerUseOutsideTask.bind(fixture.router);
    await stopOutsideTask('task-2');
    await stopOutsideTask('task-1');
    fixture.activation.consume.mockReturnValueOnce(null);
    await expect(startHandler(quickStartInput(), event, {})).rejects.toBeTruthy();
    expect(fixture.controller.start).not.toHaveBeenCalled();
  });

  it('replays the latest transient status after Renderer subscribes', async () => {
    const fixture = captureComputerUseHandlers();
    const current = await fixture.controller.start!();
    fixture.controller.getStatus!.mockReturnValue(current);
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseStatusGet)!;

    expect(handler({ sessionId: 'session-1' }, {}, {})).toEqual(current);
    expect(fixture.controller.getStatus).toHaveBeenCalledWith('session-1');

    fixture.controller.getStatus!.mockReturnValue(null);
    expect(handler({ sessionId: 'missing' }, {}, {})).toBeNull();
  });

  it('requires a separately bound trusted activation for an approval decision', async () => {
    const fixture = captureComputerUseHandlers();
    const current = await fixture.controller.start!();
    fixture.controller.getStatus!.mockReturnValue(current);
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseApprovalResolve)!;
    const input = {
      approvalId: 'approval-1',
      expectedRevision: 0,
      decision: 'allow_once',
      challenge: 'a'.repeat(64),
    } as const;
    fixture.activation.consume.mockReturnValueOnce(null);
    await expect(handler(input, {}, {})).rejects.toBeTruthy();
    expect(fixture.controller.resolveApproval).not.toHaveBeenCalled();
    fixture.activation.consume.mockReturnValueOnce({
      token: 'wrong-approval',
      intent: approvalActivationIntent({ ...input, decision: 'deny' }),
    });
    await expect(handler(input, {}, {})).rejects.toBeTruthy();
    expect(fixture.controller.resolveApproval).not.toHaveBeenCalled();
    fixture.activation.consume.mockReturnValueOnce({
      token: 'approval-activation',
      intent: approvalActivationIntent(input),
    });
    await handler(input, {}, {});
    expect(fixture.activation.consume).toHaveBeenLastCalledWith(expect.anything(), 'approval');
    expect(fixture.controller.resolveApproval).toHaveBeenCalledWith(input);
  });
});
