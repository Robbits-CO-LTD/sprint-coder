import { describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  computerAppProfileSchema,
  computerUseAvailabilitySchema,
  computerUseProfileRegisterInputSchema,
  computerListTargetsOutputSchema,
  computerUseSessionStatusSchema,
  type ProviderModel,
} from '@sprint-coder/contracts';
import { computerUseProviderModelIsEligible, IpcRouter, toPublicError } from './ipc';
import { COMPUTER_LIST_TARGETS_TOOL, COMPUTER_STOP_TOOL } from './computer-use-target-tools';
import {
  COMPUTER_TARGET_SYSTEM_PROMPT,
  computerTargetSystemPromptFor,
} from './computer-use-target-model';
import { ComputerUseController } from './computer-use-controller';
import { ManagedCodingHarness } from './provider-workspace-tools';
import { PermissionBroker } from './permission-broker';
import { expandAccessPreset } from '@sprint-coder/domain';
import type { PermissionPolicyRecord } from './persistence';
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
  permissionSettings: { open: ReturnType<typeof vi.fn> };
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
  const permissionSettings = { open: vi.fn(async () => ({ opened: true })) };
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
    computerUsePermissionSettings: permissionSettings,
    computerUseStatusBySession: new Map(),
    computerUseApprovalSessionById: new Map([['approval-1', 'session-1']]),
    computerUseQuickStartLatches: new Map(),
    teamCoordinator: { hasBusyWorkers: vi.fn(() => false) },
    persistence,
  });
  router.register();
  return { router, handlers, activation, controller, native, permissionSettings, persistence };
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

  it('rejects changing a round limit after the trusted start gesture', async () => {
    const fixture = captureComputerUseHandlers();
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseStart)!;
    const input = { ...quickStartInput(), maxRounds: 3 };
    fixture.activation.consume.mockReturnValueOnce({
      token: 'bounded-start',
      intent: startActivationIntent(input),
    });
    await expect(handler({ ...input, maxRounds: 25 }, {}, {})).rejects.toBeTruthy();
    expect(fixture.controller.start).not.toHaveBeenCalled();
    fixture.activation.consume.mockReturnValueOnce({
      token: 'bounded-start',
      intent: startActivationIntent(input),
    });
    await handler(input, {}, {});
    expect(fixture.controller.start).toHaveBeenCalledWith(input);
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

  it('opens an OS permission pane only from a trusted Computer Use click, by enum', async () => {
    const fixture = captureComputerUseHandlers();
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseOpenPermissionSettings);
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    fixture.activation.consume.mockReturnValueOnce(null);
    await expect(handler({ permission: 'accessibility' }, {}, {})).rejects.toBeTruthy();
    expect(fixture.permissionSettings.open).not.toHaveBeenCalled();

    fixture.activation.consume.mockReturnValueOnce({
      token: 'permission-activation',
      intent: null,
    });
    await expect(handler({ permission: 'accessibility' }, {}, {})).resolves.toEqual({
      opened: true,
    });
    expect(fixture.activation.consume).toHaveBeenLastCalledWith(
      expect.anything(),
      'permission-settings',
    );
    // Main hands the opener the enum only; no URL or path ever crosses the boundary.
    expect(fixture.permissionSettings.open).toHaveBeenCalledWith('accessibility');
  });

  it('measures Computer Use egress consent against the Turn destination, not the Task setting', () => {
    const fixture = captureComputerUseHandlers();
    const router = fixture.router as unknown as {
      turnProviderBindingByTurn: Map<
        string,
        Readonly<{ taskId: string; connectionId: string; modelId: string }>
      >;
      computerUseProviderEgressBindingFor(
        taskId: string,
        turnId: string,
      ): Readonly<{ connectionId: string; modelId: string }> | null;
    };
    // The probe builds the router from the prototype, so class field initializers never ran.
    Object.assign(router, {
      turnProviderBindingByTurn: new Map([
        ['turn-1', { taskId: 'task-1', connectionId: 'connection-a', modelId: 'model-a' }],
      ]),
    });
    // The Task row is repointed at another connection mid-Turn. `modelsSetSelection` does not
    // refuse a running Turn, stop it, or advance the policy epoch, while the Turn keeps sending to
    // the connection it was dispatched with — so reading the Task row here would consent against B
    // and then transmit to A.
    const taskSelection = fixture.persistence['getTaskModelSelection']!;
    taskSelection.mockReturnValue({
      connectionId: 'connection-b',
      requestedProvider: 'openai',
      requestedModel: 'model-b',
    });
    expect(router.computerUseProviderEgressBindingFor('task-1', 'turn-1')).toEqual({
      connectionId: 'connection-a',
      modelId: 'model-a',
    });
    expect(taskSelection).not.toHaveBeenCalled();
    // Unknown Turn, finished Turn, and a Turn id owned by another Task all fail closed.
    expect(router.computerUseProviderEgressBindingFor('task-1', 'turn-unknown')).toBeNull();
    expect(router.computerUseProviderEgressBindingFor('task-9', 'turn-1')).toBeNull();
  });

  it('authorizes target discovery without a session while keeping the session binding for the rest', async () => {
    const fixture = captureComputerUseHandlers();
    const previewed: unknown[] = [];
    Object.assign(fixture.router, {
      permissionBroker: {
        getPolicy: () => ({ policyEpoch: 3 }),
        preview: (input: unknown) => {
          previewed.push(input);
          return { decision: 'allow', reason: 'computer_target_discovery', permit: { id: 'p' } };
        },
        revalidateEphemeral: () => ({ valid: true }),
      },
    });
    const evaluate = (
      entry: { toolId: string; providerName: string },
      input: unknown,
    ): Promise<{ decision: string; reason: string }> =>
      (
        fixture.router as unknown as {
          evaluateToolPermission(
            request: unknown,
            capability: string,
          ): Promise<{ decision: string; reason: string }>;
        }
      ).evaluateToolPermission(
        {
          entry: { ...entry, kind: 'computerTarget', sideEffect: 'control', risk: 'low' },
          input,
          callId: 'call-1',
          context: { taskId: 'task-1', turnId: 'turn-1', workspaceId: null, policyEpoch: 3 },
        },
        'computer.observe',
      );

    // `computer_list_targets` is the call that finds a session, so routing it through the
    // session-bound evaluation would deny every call as `computer_session_missing`.
    await expect(
      evaluate(
        { toolId: COMPUTER_LIST_TARGETS_TOOL.toolId, providerName: 'computer_list_targets' },
        {},
      ),
    ).resolves.toMatchObject({ decision: 'allow', reason: 'computer_target_discovery' });
    expect(previewed).toHaveLength(1);

    // Every other Computer Use tool keeps the live-session binding untouched.
    await expect(
      evaluate(
        { toolId: COMPUTER_STOP_TOOL.toolId, providerName: 'computer_stop' },
        {
          sessionId: 'session-unknown',
        },
      ),
    ).resolves.toMatchObject({ decision: 'deny', reason: 'computer_session_missing' });
    await expect(
      evaluate({ toolId: 'builtin:computer:observe@1', providerName: 'computer_observe' }, {}),
    ).resolves.toMatchObject({ decision: 'deny', reason: 'computer_session_missing' });
    expect(previewed).toHaveLength(1);
  });
});

describe('Computer Use target tools end to end', () => {
  /**
   * The whole route a real call takes, with only the Provider missing: harness catalog →
   * published tool definition → system prompt sentence → tool call → permission evaluation through
   * a real PermissionBroker and the real policy evaluator → resource claim → controller →
   * output schema. Each review round has found a break in a different one of these links, so they
   * are pinned together rather than one at a time.
   */
  function endToEnd(options: { preset?: 'ask' | 'auto' | 'full'; revoked?: boolean } = {}) {
    const preset = options.preset ?? 'full';
    const policy: PermissionPolicyRecord = {
      preset,
      policyEpoch: 0,
      expandedPolicy: expandAccessPreset(preset),
      revokedCapabilities: options.revoked === true ? ['computer.observe'] : [],
    };
    const permissionBroker = new PermissionBroker({
      getPermissionPolicy: () => policy,
      setAccessPreset: () => policy,
      listPermissionGrants: () => [],
      revokePermissionCapability: () => 0,
      getEffectiveWorkspaceSet: () => null,
      readTurnWorkspaceSetForTask: () => null,
      getTurnWorkspaceRootIdentities: () => new Map(),
      commitPermissionEvaluation: () => undefined,
    } as unknown as ConstructorParameters<typeof PermissionBroker>[0]);
    const profile = {
      id: 'profile-1',
      platform: 'darwin' as const,
      kind: 'macos-bundle' as const,
      label: 'Notes',
      canonicalPath: '/Applications/Notes.app/Contents/MacOS/Notes',
      appUrl: null,
      identity: {
        platform: 'darwin',
        identityDigest: 'a'.repeat(64),
        bundleId: 'com.example.notes',
        executablePath: '/Applications/Notes.app/Contents/MacOS/Notes',
        executableDigest: 'b'.repeat(64),
        teamId: 'TEAMID1234',
        signingIdentifier: 'com.example.notes',
        cdHash: null,
        displayName: 'Notes',
        policyLanguage: 'en',
        maximumMode: 'full_access_app',
      },
      identityDigest: 'a'.repeat(64),
      version: null,
      executableDigest: 'b'.repeat(64),
      mode: 'full_access_app' as const,
      connectionId: 'connection-1',
      modelId: 'model-1',
      providerEgressConsent: true,
      remember: true,
      revision: 3,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
    };
    const controller = new ComputerUseController({
      persistence: {
        listComputerAppProfiles: () => [profile],
        getComputerAppProfile: () => profile,
        getActiveTurnId: () => null,
        getPermissionPolicy: () => ({ policyEpoch: 0 }),
        listComputerActionAudits: () => [],
      } as unknown as ConstructorParameters<typeof ComputerUseController>[0]['persistence'],
      native: {
        availability: () => available,
        pickApplication: async () => null,
        listWindows: async () => [
          {
            platform: 'darwin',
            windowId: 'native-window-1',
            appIdentityDigest: profile.identityDigest,
            windowIdentityDigest: 'd'.repeat(64),
            title: 'Meeting notes',
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            screenBounds: { x: 0, y: 0, width: 800, height: 600 },
            focused: true,
            eligible: true,
            ownerKind: 'application',
            modal: false,
            revision: 1,
            policyLanguage: 'en',
            maximumMode: 'full_access_app',
          },
        ],
        startSession: async () => ({}) as never,
        observe: async () => ({}) as never,
        dispatch: async () => ({ result: 'completed', reasonCode: null }),
        cancel: async () => undefined,
        close: async () => undefined,
      } as unknown as ConstructorParameters<typeof ComputerUseController>[0]['native'],
      featureEnabled: () => true,
      agentDrivenEnabled: () => true,
      providerEgressBindingFor: () => ({ connectionId: 'connection-1', modelId: 'model-1' }),
      currentPolicyEpoch: () => 0,
      repositionEmergencyStop: () => true,
    });
    const router = Object.create(IpcRouter.prototype) as IpcRouter & Record<string, unknown>;
    Object.assign(router, { permissionBroker, computerUseController: controller });
    const harness = new ManagedCodingHarness({
      workspaceFor: () => null,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 0,
      authorizer: (request) =>
        (
          router as unknown as {
            evaluateToolPermission(request: unknown, capability: string): Promise<unknown>;
          }
        ).evaluateToolPermission(request, request.entry.requiredCapabilities[0]!) as never,
      computerTargets: {
        listTargets: (input, context) => controller.listTargets(input, context),
        stop: (sessionId, context) => controller.stopForAgent(sessionId, context),
      },
    });
    return { harness, controller, permissionBroker };
  }

  const turnContext = { taskId: 'task-1', turnId: 'turn-1', workspaceId: null, policyEpoch: 0 };

  it('publishes, guards, authorizes, and executes computer_list_targets with no Workspace', async () => {
    const { harness } = endToEnd();
    // A Task with no Workspace at all: the surface carries the desktop tools and nothing else.
    const snapshot = harness.startTurn(turnContext, 'codex', {
      computerTargets: true,
      toolSurface: 'computer-targets-only',
    });
    expect(snapshot.entries.map((entry) => entry.providerName).sort()).toEqual([
      'computer_list_targets',
      'computer_stop',
    ]);
    // The catalog carries a target tool, so the warning sentence must accompany it.
    expect(computerTargetSystemPromptFor(snapshot.entries)).toBe(COMPUTER_TARGET_SYSTEM_PROMPT);
    const result = (await harness.broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-1',
      providerName: 'computer_list_targets',
      input: {},
    })) as { targets: readonly { kind: string; untrustedLabel: { windowTitle: string } | null }[] };
    expect(computerListTargetsOutputSchema.parse(result)).toEqual(result);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.untrustedLabel?.windowTitle).toBe('Meeting notes');
  });

  it('reaches the enumeration under every access preset and stops at a revoked capability', async () => {
    for (const preset of ['ask', 'auto', 'full'] as const) {
      const { harness } = endToEnd({ preset });
      harness.startTurn(turnContext, 'codex', {
        computerTargets: true,
        toolSurface: 'computer-targets-only',
      });
      await expect(
        harness.broker.dispatch({
          taskId: 'task-1',
          turnId: 'turn-1',
          callId: 'call-1',
          providerName: 'computer_list_targets',
          input: {},
        }),
      ).resolves.toMatchObject({ truncated: false });
    }
    const revoked = endToEnd({ revoked: true });
    revoked.harness.startTurn(turnContext, 'codex', {
      computerTargets: true,
      toolSurface: 'computer-targets-only',
    });
    await expect(
      revoked.harness.broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        providerName: 'computer_list_targets',
        input: {},
      }),
    ).rejects.toThrow(/capability_revoked/u);
  });

  it('refuses computer_stop for a session this Task does not own', async () => {
    const { harness } = endToEnd();
    harness.startTurn(turnContext, 'codex', {
      computerTargets: true,
      toolSurface: 'computer-targets-only',
    });
    // No live session exists, so the session-bound permission lane denies before the controller
    // is reached — the same answer a session owned by another Task would get.
    await expect(
      harness.broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        providerName: 'computer_stop',
        input: { sessionId: 'session-elsewhere' },
      }),
    ).rejects.toThrow(/computer_session_missing/u);
  });
});

describe('Computer Use target tool exposure decision', () => {
  function decide(
    input: Readonly<{ teamTurn: boolean; toolCalling: boolean | null | undefined }>,
    options: { flag?: boolean; available?: boolean } = {},
  ): boolean {
    const router = Object.create(IpcRouter.prototype) as IpcRouter & Record<string, unknown>;
    Object.assign(router, {
      computerUseController: {
        availability: () => ({ ...available, available: options.available !== false }),
      },
    });
    const previous = process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'];
    const previousMaster = process.env['SPRINT_CODER_COMPUTER_USE_DESKTOP_V1'];
    if (options.flag === false) delete process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'];
    else {
      process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'] = '1';
      process.env['SPRINT_CODER_COMPUTER_USE_DESKTOP_V1'] = '1';
    }
    try {
      return (
        router as unknown as {
          computerTargetsExposedForTurn(value: typeof input): boolean;
        }
      ).computerTargetsExposedForTurn(input);
    } finally {
      if (previous === undefined) delete process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'];
      else process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'] = previous;
      if (previousMaster === undefined) delete process.env['SPRINT_CODER_COMPUTER_USE_DESKTOP_V1'];
      else process.env['SPRINT_CODER_COMPUTER_USE_DESKTOP_V1'] = previousMaster;
    }
  }

  it('withholds the tools from a model that does not accept tools at all', () => {
    // Attaching tools to such a model breaks the request itself, so an ordinary chat Turn would
    // start failing the moment both flags were on.
    expect(decide({ teamTurn: false, toolCalling: false })).toBe(false);
    // Unknown capability keeps the previous behaviour rather than guessing the model cannot.
    expect(decide({ teamTurn: false, toolCalling: null })).toBe(true);
    expect(decide({ teamTurn: false, toolCalling: undefined })).toBe(true);
    expect(decide({ teamTurn: false, toolCalling: true })).toBe(true);
  });

  it('withholds the tools when the native boundary cannot serve them, on every route', () => {
    // The CLI route passes `toolCalling: true`; without this check it exposed two tools that could
    // only answer "Computer Use native boundary is unavailable".
    expect(decide({ teamTurn: false, toolCalling: true }, { available: false })).toBe(false);
    expect(decide({ teamTurn: false, toolCalling: undefined }, { available: false })).toBe(false);
  });

  it('withholds the tools from a Team Turn and with the flag off', () => {
    expect(decide({ teamTurn: true, toolCalling: true })).toBe(false);
    expect(decide({ teamTurn: false, toolCalling: true }, { flag: false })).toBe(false);
  });
});
