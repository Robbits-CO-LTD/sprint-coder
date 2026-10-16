import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  computerAppProfileSchema,
  computerAppGrantRequestSchema,
  computerUseAvailabilitySchema,
  computerAppGrantResolveInputSchema,
  computerStartToolOutputSchema,
  computerUseGrantRevokeInputSchema,
  type ComputerAppGrantRequest,
  computerUseProfileRegisterInputSchema,
  computerListTargetsOutputSchema,
  computerUseSessionStatusSchema,
  computerUseApprovalSchema,
  type ComputerUseAction,
  type ComputerUseApproval,
  type ComputerUseSessionStatus,
  type ProviderModel,
} from '@sprint-coder/contracts';
import type { ComputerUsePlannerInput } from './computer-use-planner-port';
import { computerUseProviderModelIsEligible, IpcRouter, toPublicError } from './ipc';
import {
  COMPUTER_LIST_TARGETS_TOOL,
  COMPUTER_REQUEST_ACCESS_TOOL,
  COMPUTER_START_TOOL,
  COMPUTER_STOP_TOOL,
} from './computer-use-target-tools';
import {
  COMPUTER_TARGET_SYSTEM_PROMPT,
  computerTargetSystemPromptFor,
} from './computer-use-target-model';
import { ComputerUseArtifactStore } from './computer-use-artifact';
import { ComputerUseController } from './computer-use-controller';
import {
  computerAppGrantIdentityFrom,
  computerAppNativeIdentityDigest,
} from './computer-use-grant-identity';
import { secureLogger } from './secure-logger';
import { createComputerAppGrantFixtureStore } from './computer-use-grant-fixture';
import { ManagedCodingHarness } from './provider-workspace-tools';
import { PermissionBroker } from './permission-broker';
import { expandAccessPreset } from '@sprint-coder/domain';
import type { PermissionPolicyRecord } from './persistence';
import {
  COMPUTER_USE_UI_ACTIVATION_KINDS,
  isComputerUseUiActivationKind,
} from '../computer-use-activation';
import {
  appGrantActivationIntent,
  approvalActivationIntent,
  quickStartActivationIntent,
  startActivationIntent,
} from '../computer-use-activation-intent';

const electronMock = vi.hoisted(() => ({ ipcMainOn: vi.fn(), ipcMainHandle: vi.fn() }));
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  dialog: {},
  ipcMain: { on: electronMock.ipcMainOn, handle: electronMock.ipcMainHandle },
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

/**
 * Runs `body` with the agent-driven gate forced on or off.
 *
 * Both flags, because the v2 gate is the master switch AND its own opt-in: setting only the second
 * would leave the gate off and the test would pass for the wrong reason.
 */
async function withAgentDrivenGate(enabled: boolean, body: () => Promise<void>): Promise<void> {
  const previous = process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'];
  const previousMaster = process.env['SPRINT_CODER_COMPUTER_USE_DESKTOP_V1'];
  if (enabled) {
    process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'] = '1';
    process.env['SPRINT_CODER_COMPUTER_USE_DESKTOP_V1'] = '1';
  } else delete process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'];
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'];
    else process.env['SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2'] = previous;
    if (previousMaster === undefined) delete process.env['SPRINT_CODER_COMPUTER_USE_DESKTOP_V1'];
    else process.env['SPRINT_CODER_COMPUTER_USE_DESKTOP_V1'] = previousMaster;
  }
}

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
  /** The input and output schemas each channel was registered with (for the real outer wrapper). */
  schemas: Map<string, { input: unknown; output: unknown }>;
  activation: {
    consume: ReturnType<typeof vi.fn>;
    generation: ReturnType<typeof vi.fn>;
  };
  controller: Record<string, ReturnType<typeof vi.fn>>;
  native: { pickApplication: ReturnType<typeof vi.fn> };
  permissionSettings: { open: ReturnType<typeof vi.fn> };
  persistence: Record<string, ReturnType<typeof vi.fn>>;
  approvalCoordinator: { turnEnded: ReturnType<typeof vi.fn> };
} {
  const router = Object.create(IpcRouter.prototype) as IpcRouter & Record<string, unknown>;
  const handlers = new Map<string, CapturedHandler>();
  const schemas = new Map<string, { input: unknown; output: unknown }>();
  const capture = (...args: unknown[]): void => {
    const channel = args[0];
    const handler = args[3];
    if (typeof channel !== 'string' || typeof handler !== 'function')
      throw new Error('Unexpected IPC handler registration');
    handlers.set(channel, handler as CapturedHandler);
    schemas.set(channel, { input: args[1], output: args[2] });
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
    listAppGrantViews: vi.fn(() => ({ grants: [], discardedRecords: 0, requestedApps: [] })),
    revokeAppGrant: vi.fn(async () => undefined),
    purgeInvalidAppGrants: vi.fn(() => ({
      grants: [],
      discardedRecords: 0,
      requestedApps: [],
      removedRecords: 2,
    })),
    resolveAppGrantRequest: vi.fn(async () => undefined),
    turnEnded: vi.fn(),
    taskClosed: vi.fn(),
    resolveApproval: vi.fn(async () => undefined),
    getStatus: vi.fn(() => null),
    policyEpochChanged: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
  const approvalCoordinator = { turnEnded: vi.fn() };
  const native = { pickApplication: vi.fn(async () => identity) };
  const permissionSettings = { open: vi.fn(async () => ({ opened: true })) };
  const persistence = {
    getTask: vi.fn(() => ({ id: 'task-1' })),
    getTaskModelSelection: vi.fn(() => null),
    getRuntime: vi.fn(() => 'codex'),
    getModel: vi.fn(() => 'auto'),
    getActiveTurnId: vi.fn(() => null),
    getComputerAppProfile: vi.fn(() => ({ revision: 1 })),
    setArchived: vi.fn((taskId: string) => ({ id: taskId })),
  };
  Object.assign(router, {
    handle: capture,
    handleMutation: capture,
    window: { id: 42, webContents: { once: vi.fn() } },
    computerUseActivationGate: activation,
    approvalCoordinator,
    computerUseController: controller,
    computerUseNative: native,
    computerUsePermissionSettings: permissionSettings,
    computerUseStatusBySession: new Map(),
    computerUseApprovalSessionById: new Map([['approval-1', 'session-1']]),
    computerUseQuickStartLatches: new Map(),
    teamCoordinator: { hasBusyWorkers: vi.fn(() => false) },
    // The mutation envelope machinery — the install gate, the principal, the idempotency hash — is
    // covered where it lives. Stubbed here so a handler's own wiring is what the test observes.
    runMutation: (
      _event: unknown,
      _envelope: unknown,
      _taskId: string,
      _channel: string,
      action: () => unknown,
    ) => ({ value: action(), executed: true }),
    persistence,
  });
  router.register();
  return {
    router,
    handlers,
    schemas,
    activation,
    controller,
    native,
    permissionSettings,
    persistence,
    approvalCoordinator,
  };
}

describe('Computer Use Main IPC integration', () => {
  it('T15-9 (N19): an excerpt reaches the Renderer on the status channel and nowhere else', async () => {
    const fixture = captureComputerUseHandlers();
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const window = {
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      showInactive: vi.fn(),
      focus: vi.fn(),
      flashFrame: vi.fn(),
      webContents: {
        isDestroyed: vi.fn(() => false),
        send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })),
      },
    };
    Object.assign(fixture.router, {
      window,
      computerUsePendingApprovalBySession: new Map(),
      computerUsePendingGrantRequestIds: new Set(),
      computerUseAttentionFlashing: false,
      computerUseSessionByTask: new Map(),
    });
    // Everything the logger is asked to write, at any level.
    const logged: unknown[][] = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const)
      vi.spyOn(secureLogger, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    const marker = 'MARKER-EXCERPT-4242';
    const status = computerUseSessionStatusSchema.parse({
      ...(await fixture.controller.start!()),
      state: 'awaiting_approval',
      copied: [{ sizeClass: 'le_256', excerpt: marker }],
    });
    const router = fixture.router as unknown as {
      publishComputerUseStatus(status: ComputerUseSessionStatus): void;
      publishComputerUseApproval(approval: unknown): void;
    };
    router.publishComputerUseStatus(status);
    router.publishComputerUseApproval(
      computerUseApprovalSchema.parse({
        id: 'approval-1',
        sessionId: status.sessionId,
        taskId: status.taskId,
        actionType: 'set_text',
        actionDigest: 'a'.repeat(64),
        targetLabel: 'control:field',
        preview: '{"type":"set_text","artifactRef":"artifact-1"}',
        transfer: {
          sourceLabel: 'Notes',
          destinationLabel: 'Form',
          sizeClass: 'le_256',
          excerpt: marker,
        },
        risk: 'high',
        policyEpoch: 0,
        observationRevision: 0,
        eligibleForPlan: false,
        allowedDecisions: ['allow_once', 'deny'],
        state: 'pending',
        decision: null,
        revision: 0,
        challenge: 'challenge-1',
        createdAt: '2026-08-29T12:00:00.000Z',
        expiresAt: '2026-08-29T13:00:00.000Z',
      }),
    );
    const withoutExcerpts = (key: string, value: unknown) =>
      key === 'excerpt' ? undefined : value;
    // The Renderer is told, on the status channel, and gets the excerpt there...
    const events = sent.filter((entry) => entry.channel === IPC_CHANNELS.computerUseStatusEvent);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events.at(-1)!.payload)).toContain(marker);
    // ...and nothing else leaves: every other channel, and every other field, is clean.
    for (const entry of sent) {
      const body = JSON.stringify(entry.payload, withoutExcerpts);
      expect(body, entry.channel).not.toContain(marker);
      if (entry.channel !== IPC_CHANNELS.computerUseStatusEvent)
        expect(JSON.stringify(entry.payload), entry.channel).not.toContain(marker);
    }
    // Nothing reached the logger, whole status or part.
    expect(JSON.stringify(logged)).not.toContain(marker);
    vi.restoreAllMocks();
  });

  it('announces an asynchronous action approval without taking keyboard focus', async () => {
    const fixture = captureComputerUseHandlers();
    let visible = false;
    const window = {
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => visible),
      show: vi.fn(),
      showInactive: vi.fn(() => {
        visible = true;
      }),
      focus: vi.fn(),
      flashFrame: vi.fn(),
      webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
    };
    Object.assign(fixture.router, {
      window,
      computerUsePendingApprovalBySession: new Map(),
      computerUsePendingGrantRequestIds: new Set(),
      computerUseAttentionFlashing: false,
      computerUseSessionByTask: new Map(),
    });
    const status = computerUseSessionStatusSchema.parse({
      ...(await fixture.controller.start!()),
      state: 'awaiting_approval',
    });

    const router = fixture.router as unknown as {
      publishComputerUseStatus(status: ComputerUseSessionStatus): void;
      publishComputerUseApproval(approval: unknown): void;
      publishComputerUseGrantRequest(request: unknown): void;
    };
    router.publishComputerUseStatus(status);
    const approval = computerUseApprovalSchema.parse({
      id: 'approval-1',
      sessionId: status.sessionId,
      taskId: status.taskId,
      actionType: 'invoke',
      actionDigest: 'a'.repeat(64),
      targetLabel: '保存',
      preview: '',
      risk: 'medium',
      policyEpoch: 0,
      observationRevision: 0,
      eligibleForPlan: false,
      allowedDecisions: ['allow_once', 'deny'],
      state: 'pending',
      decision: null,
      revision: 0,
      challenge: 'challenge-1',
      createdAt: '2026-08-29T12:00:00.000Z',
      expiresAt: '2026-08-29T13:00:00.000Z',
    });
    router.publishComputerUseApproval(approval);

    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.flashFrame).toHaveBeenCalledWith(true);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.computerUseStatusEvent,
      expect.objectContaining({ state: 'awaiting_approval' }),
    );
    const grantRequest = computerAppGrantRequestSchema.parse({
      id: 'request-1',
      taskId: status.taskId,
      kind: 'app-grant',
      state: 'pending',
      revision: 1,
      decision: null,
      noticeCode: null,
      verified: {
        platform: 'darwin',
        identityKind: 'verified-signed',
        publisher: 'TEAMID1234',
        appId: 'com.example.notes',
        maxMode: 'full_access_app',
      },
      untrustedAppName: 'Notes',
      untrustedReason: null,
      providerEgressModelId: null,
      allowedDecisions: ['deny'],
      activationIntents: {},
      expiresAt: '2026-08-29T13:00:00.000Z',
    });
    router.publishComputerUseGrantRequest(grantRequest);
    router.publishComputerUseApproval({
      ...approval,
      state: 'resolved',
      decision: 'deny',
      revision: 1,
      decidedAt: '2026-08-29T12:01:00.000Z',
    });
    expect(window.flashFrame).toHaveBeenLastCalledWith(true);
    router.publishComputerUseGrantRequest({
      ...grantRequest,
      state: 'resolved',
      decision: 'deny',
      revision: 2,
    });
    expect(window.flashFrame).toHaveBeenLastCalledWith(false);
  });

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

  it('serves the grant list only under the agent-driven gate', async () => {
    const fixture = captureComputerUseHandlers();
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseGrantsList);
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    // The Renderer hides the section from `appInfo`, but hiding is not refusing: with the gate off
    // the channel itself must fail, or a compromised Renderer would still read the grants.
    await withAgentDrivenGate(false, async () => {
      // The handler refuses synchronously, so the call itself throws rather than returning a
      // rejected promise. Asserting on the call keeps that distinction honest.
      expect(() => handler({}, {}, {})).toThrow();
      expect(fixture.controller['listAppGrantViews']).not.toHaveBeenCalled();
    });
    await withAgentDrivenGate(true, async () => {
      expect(await handler({}, {}, {})).toEqual({
        grants: [],
        discardedRecords: 0,
        requestedApps: [],
      });
    });
  });

  it('revokes one grant only from a trusted click, by id and revision', async () => {
    const fixture = captureComputerUseHandlers();
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseGrantRevoke);
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    const input = { grantId: 'grant-1', expectedRevision: 3 };

    await withAgentDrivenGate(true, async () => {
      // No click: a model that reaches the Renderer cannot revoke, and — more to the point — cannot
      // use this channel at all.
      fixture.activation.consume.mockReturnValueOnce(null);
      await expect(handler(input, {}, {})).rejects.toBeTruthy();
      expect(fixture.controller['revokeAppGrant']).not.toHaveBeenCalled();

      fixture.activation.consume.mockReturnValueOnce({ token: 'revoke-activation', intent: null });
      await expect(handler(input, {}, {})).resolves.toEqual({
        grants: [],
        discardedRecords: 0,
        requestedApps: [],
      });
      // Its own activation kind, so a click on Start or on an approval cannot be spent here.
      expect(fixture.activation.consume).toHaveBeenLastCalledWith(
        expect.anything(),
        'app-grant-revoke',
      );
      expect(fixture.controller['revokeAppGrant']).toHaveBeenCalledWith('grant-1', 3);
    });

    // And with the gate off, the trusted click is not enough either.
    await withAgentDrivenGate(false, async () => {
      fixture.activation.consume.mockReturnValueOnce({ token: 'revoke-activation', intent: null });
      await expect(handler(input, {}, {})).rejects.toBeTruthy();
    });
  });

  it('removes unauthenticated grant rows only from its own trusted click', async () => {
    const fixture = captureComputerUseHandlers();
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseGrantPurge);
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    await withAgentDrivenGate(true, async () => {
      fixture.activation.consume.mockReturnValueOnce(null);
      await expect(handler({}, {}, {})).rejects.toBeTruthy();
      expect(fixture.controller['purgeInvalidAppGrants']).not.toHaveBeenCalled();

      fixture.activation.consume.mockReturnValueOnce({ token: 'purge-activation', intent: null });
      await expect(handler({}, {}, {})).resolves.toEqual({
        grants: [],
        discardedRecords: 0,
        requestedApps: [],
        removedRecords: 2,
      });
      // Its own kind: a click on a row's revoke button cannot be spent as "remove those rows".
      expect(fixture.activation.consume).toHaveBeenLastCalledWith(
        expect.anything(),
        'app-grant-purge',
      );
    });

    await withAgentDrivenGate(false, async () => {
      fixture.activation.consume.mockReturnValueOnce({ token: 'purge-activation', intent: null });
      await expect(handler({}, {}, {})).rejects.toBeTruthy();
    });
  });

  it('answers an approval card only from a trusted click, and hands Main the intent', async () => {
    const fixture = captureComputerUseHandlers();
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseGrantRequestResolve);
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    const input = { requestId: 'request-1', expectedRevision: 1, decision: 'allow_always' };

    await withAgentDrivenGate(true, async () => {
      // No click at all: this is the shape model output would arrive in, and it cannot approve.
      fixture.activation.consume.mockReturnValueOnce(null);
      await expect(handler(input, {}, {})).rejects.toBeTruthy();
      expect(fixture.controller['resolveAppGrantRequest']).not.toHaveBeenCalled();

      const intent = appGrantActivationIntent({
        requestId: 'request-1',
        expectedRevision: 1,
        decision: 'allow_always',
        identityDigest: 'a'.repeat(64),
      });
      fixture.activation.consume.mockReturnValueOnce({ token: 'grant-activation', intent });
      await expect(handler(input, {}, {})).resolves.toBeUndefined();
      expect(fixture.activation.consume).toHaveBeenLastCalledWith(expect.anything(), 'app-grant');
      // Main forwards the intent rather than judging it: the card it belongs to lives in the
      // controller, which is also where deny is exempted from the comparison.
      expect(fixture.controller['resolveAppGrantRequest']).toHaveBeenCalledWith(input, intent);
    });

    await withAgentDrivenGate(false, async () => {
      fixture.activation.consume.mockReturnValueOnce({ token: 'grant-activation', intent: null });
      await expect(handler(input, {}, {})).rejects.toBeTruthy();
    });
  });

  it('rejects a card answer that names anything other than a card Main published', () => {
    for (const rejected of [
      { requestId: 'request-1', expectedRevision: 1 },
      { requestId: 'request-1', expectedRevision: 1, decision: 'allow' },
      { requestId: 'request-1', expectedRevision: 0, decision: 'deny' },
      { requestId: '', expectedRevision: 1, decision: 'deny' },
      // No identity, mode, or app token: the Renderer can only name a row Main already showed it.
      { requestId: 'request-1', expectedRevision: 1, decision: 'deny', maxMode: 'full_access_app' },
    ])
      expect(computerAppGrantResolveInputSchema.safeParse(rejected).success).toBe(false);
  });

  it('tells Computer Use about every Turn that ends, through the one fan-out', () => {
    const fixture = captureComputerUseHandlers();
    const router = fixture.router as unknown as {
      notifyTurnEnded(taskId: string, turnId: string, outcome: 'finished' | 'canceled'): void;
    };
    router.notifyTurnEnded('task-1', 'turn-1', 'finished');
    expect(fixture.controller['turnEnded']).toHaveBeenCalledWith('task-1', 'turn-1');
    router.notifyTurnEnded('task-1', 'turn-2', 'canceled');
    expect(fixture.controller['turnEnded']).toHaveBeenCalledWith('task-1', 'turn-2');
    // Both coordinators, always together: the approval coordinator's list of sites is the map, and
    // the reason this is one method is that the second list was once simply never written.
    expect(fixture.approvalCoordinator.turnEnded).toHaveBeenCalledTimes(2);
    expect(fixture.controller['turnEnded']).toHaveBeenCalledTimes(2);
  });

  it('routes every Turn ending through that fan-out and nowhere else', () => {
    // A source check, because the wiring is only as good as the call sites: a future site that
    // calls the approval coordinator directly would leave Computer Use's card, its per-Turn count,
    // and any session bound to that Turn behind.
    const source = readFileSync(resolve(process.cwd(), 'src/main/ipc.ts'), 'utf8');
    // Exactly one of each, and both inside `notifyTurnEnded`: that is what makes the two lists one.
    expect(source.match(/this\.approvalCoordinator\.turnEnded\(/gu)).toHaveLength(1);
    expect(source.match(/this\.computerUseController\.turnEnded\(/gu)).toHaveLength(1);
    const fanOut = source.slice(
      source.indexOf('private notifyTurnEnded('),
      source.indexOf('private readonly handleComputerUseActivationIntent'),
    );
    expect(fanOut).toContain('this.approvalCoordinator.turnEnded(taskId, turnId, outcome)');
    expect(fanOut).toContain('this.computerUseController.turnEnded(taskId, turnId)');
    // Eight call sites today; the number matters less than all of them going through one place.
    expect((source.match(/this\.notifyTurnEnded\(/gu) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it('ends a Task-scoped permission when the conversation is archived', async () => {
    const fixture = captureComputerUseHandlers();
    const handler = fixture.handlers.get(IPC_CHANNELS.tasksSetArchived);
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    await handler({ taskId: 'task-1', archived: true }, {}, {});
    expect(fixture.controller['taskClosed']).toHaveBeenCalledWith('task-1');
    // Un-archiving is the user opening the conversation again, not re-granting anything.
    fixture.controller['taskClosed']?.mockClear();
    await handler({ taskId: 'task-1', archived: false }, {}, {});
    expect(fixture.controller['taskClosed']).not.toHaveBeenCalled();
  });

  it('keeps the card click kinds in the one list every activation seam reads', () => {
    for (const kind of ['app-grant', 'app-grant-purge'] as const) {
      expect(isComputerUseUiActivationKind(kind)).toBe(true);
      expect(COMPUTER_USE_UI_ACTIVATION_KINDS).toContain(kind);
    }
  });

  it('keeps the revoke click kind in the one list every activation seam reads', () => {
    // Three seams have to agree: the Renderer gate that records the click, Main's intent channel
    // that binds the recorded kind, and the handler that consumes it. A kind one of them omits does
    // not fail loudly — `consume` compares against a kind that was never bound, so the control is
    // silently dead. They now read this list, so membership is the whole check.
    expect(isComputerUseUiActivationKind('app-grant-revoke')).toBe(true);
    expect(COMPUTER_USE_UI_ACTIVATION_KINDS).toContain('app-grant-revoke');
    for (const rejected of ['app-grant-revoke-but-not-really', '', undefined, null, 0])
      expect(isComputerUseUiActivationKind(rejected)).toBe(false);
  });

  it('rejects a revoke that names anything other than a row Main already showed', () => {
    for (const rejected of [
      { grantId: 'grant-1' },
      { grantId: 'grant-1', expectedRevision: 0 },
      { grantId: 'grant-1', expectedRevision: 1, maxMode: 'full_access_app' },
      { grantId: '', expectedRevision: 1 },
    ])
      expect(computerUseGrantRevokeInputSchema.safeParse(rejected).success).toBe(false);
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
      entry: { toolId: string; providerName: string; kind?: string },
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
          entry: {
            kind: 'computerTarget',
            sideEffect: 'control',
            risk: 'low',
            ...entry,
          },
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
      evaluate(
        {
          toolId: 'builtin:computer:observe@1',
          providerName: 'computer_observe',
          // Its real kind: `computer_observe` belongs to the in-session surface, not the Task one.
          kind: 'computer',
        },
        {},
      ),
    ).resolves.toMatchObject({ decision: 'deny', reason: 'computer_session_missing' });

    // A `computerTarget` tool nobody has assigned a lane to is denied at the door rather than
    // falling into whichever evaluation happens to be last.
    await expect(
      evaluate({ toolId: 'builtin:computer:invented@1', providerName: 'computer_invented' }, {}),
    ).resolves.toMatchObject({ decision: 'deny', reason: 'computer_target_tool_unknown' });
    expect(previewed).toHaveLength(1);
  });
});

const endToEndIdentityFacts = {
  platform: 'darwin',
  identityDigest: '',
  bundleId: 'com.example.notes',
  executablePath: '/Applications/Notes.app/Contents/MacOS/Notes',
  executableDigest: 'b'.repeat(64),
  teamId: 'TEAMID1234',
  signingIdentifier: 'com.example.notes',
  cdHash: null,
  displayName: 'Notes',
  policyLanguage: 'en',
  maximumMode: 'full_access_app',
};
const endToEndIdentity = {
  ...endToEndIdentityFacts,
  identityDigest: computerAppNativeIdentityDigest(
    endToEndIdentityFacts,
    computerAppGrantIdentityFrom(endToEndIdentityFacts)!,
  )!,
};

const endToEndImageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
const endToEndImageDigest = createHash('sha256').update(endToEndImageBytes).digest('hex');

/** The minimum an observation must be for a session to take a round through the real controller. */
function endToEndObservation(sessionId: string, revision: number, appIdentityDigest: string) {
  const now = Date.now();
  return {
    sessionId,
    appIdentityDigest,
    windowIdentityDigest: 'd'.repeat(64),
    profileRevision: 3,
    maximumMode: 'full_access_app',
    policyLanguage: 'en',
    screenBounds: { x: 0, y: 0, width: 800, height: 600 },
    revision,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 20_000).toISOString(),
    clientWidth: 800,
    clientHeight: 600,
    images: [
      {
        mimeType: 'image/png',
        digest: endToEndImageDigest,
        byteLength: endToEndImageBytes.byteLength,
        width: 1,
        height: 1,
        base64: endToEndImageBytes.toString('base64'),
      },
    ],
    treeDigest: null,
    treeByteLength: 0,
    treeDepth: 0,
    treeNodeCount: 0,
    focusedElementSignature: 'f'.repeat(64),
    dialogSetRevision: 1,
    dialogSetDigest: '1'.repeat(64),
    activeWindowIdentityDigest: 'd'.repeat(64),
    activeWindowKind: 'application',
  };
}

describe('Computer Use target tools end to end', () => {
  /**
   * The whole route a real call takes, with only the Provider missing: harness catalog →
   * published tool definition → system prompt sentence → tool call → permission evaluation through
   * a real PermissionBroker and the real policy evaluator → resource claim → controller →
   * output schema. Each review round has found a break in a different one of these links, so they
   * are pinned together rather than one at a time.
   */
  function endToEnd(
    options: {
      preset?: 'ask' | 'auto' | 'full';
      revoked?: boolean;
      revokedCapabilities?: ('computer.observe' | 'computer.control')[];
      policyEpoch?: number;
      /** V1's "remember" flag on the profile row. Never a grant: the row is unauthenticated. */
      remembered?: boolean;
      /** The inner planner. The default finishes the first round. */
      plan?: (input: ComputerUsePlannerInput) => Promise<ComputerUseAction>;
    } = {},
  ) {
    const preset = options.preset ?? 'full';
    let policyEpoch = options.policyEpoch ?? 0;
    const audits = new Map<string, unknown>();
    const cards: ComputerAppGrantRequest[] = [];
    const grantStore = createComputerAppGrantFixtureStore();
    let observationRevision = 0;
    const policy: PermissionPolicyRecord = {
      preset,
      get policyEpoch() {
        return policyEpoch;
      },
      expandedPolicy: expandAccessPreset(preset),
      revokedCapabilities:
        options.revokedCapabilities ?? (options.revoked === true ? ['computer.observe'] : []),
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
      identity: endToEndIdentity,
      // The digest native would have produced, not an invented one: the controller binds the two
      // halves of a profile together (T14), so a chosen digest describes a row that cannot exist.
      identityDigest: endToEndIdentity.identityDigest,
      version: null,
      executableDigest: 'b'.repeat(64),
      mode: 'full_access_app' as const,
      connectionId: 'connection-1',
      modelId: 'model-1',
      providerEgressConsent: true,
      remember: options.remembered !== false,
      revision: 3,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
    };
    const controller = new ComputerUseController({
      persistence: {
        listComputerAppProfiles: () => [profile],
        getComputerAppProfile: () => profile,
        // A real `computer_start` runs inside the calling Turn, so the Task has to look busy with
        // exactly that Turn — the same thing production sees while a tool call is in flight.
        getActiveTurnId: () => 'turn-1',
        getPermissionPolicy: () => ({ policyEpoch }),
        listComputerActionAudits: () => [],
        recordComputerActionAudit: (input: Record<string, unknown>) => {
          const record = { ...input, id: `audit-${audits.size + 1}`, state: 'pending' };
          audits.set(record.id, record);
          return record;
        },
        completeComputerActionAudit: ({ auditId }: { auditId: string }) => audits.get(auditId),
        ...grantStore.api,
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
        startSession: async (input: { sessionId: string; windowId: string }) => ({
          sessionId: input.sessionId,
          platform: 'darwin',
          appIdentityDigest: profile.identityDigest,
          windowIdentityDigest: 'd'.repeat(64),
          windowId: input.windowId,
          profileRevision: profile.revision,
          cancelEpoch: 0,
          policyLanguage: 'en',
          maximumMode: 'full_access_app',
          screenBounds: { x: 0, y: 0, width: 800, height: 600 },
        }),
        observe: async (session: { sessionId: string }) => {
          observationRevision += 1;
          return endToEndObservation(
            session.sessionId,
            observationRevision,
            profile.identityDigest,
          );
        },
        dispatch: async () => ({ result: 'completed', reasonCode: null }),
        cancel: async () => undefined,
        close: async () => undefined,
      } as unknown as ConstructorParameters<typeof ComputerUseController>[0]['native'],
      featureEnabled: () => true,
      agentDrivenEnabled: () => true,
      providerEgressBindingFor: () => ({ connectionId: 'connection-1', modelId: 'model-1' }),
      currentPolicyEpoch: () => policyEpoch,
      repositionEmergencyStop: () => true,
      publishGrantRequest: (request) => cards.push(request),
      // One round and done, so a real `computer_start` reaches a terminal state without a Provider.
      planner: { plan: options.plan ?? (async () => ({ type: 'finish' })) },
    });
    const router = Object.create(IpcRouter.prototype) as IpcRouter & Record<string, unknown>;
    Object.assign(router, { permissionBroker, computerUseController: controller });
    const harness = new ManagedCodingHarness({
      workspaceFor: () => null,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => policyEpoch,
      authorizer: (request) =>
        (
          router as unknown as {
            evaluateToolPermission(request: unknown, capability: string): Promise<unknown>;
          }
        ).evaluateToolPermission(request, request.entry.requiredCapabilities[0]!) as never,
      computerTargets: {
        listTargets: (input, context) => controller.listTargets(input, context),
        requestAccess: (input, context, signal) => controller.requestAccess(input, context, signal),
        start: (input, context, signal) => controller.startForAgent(input, context, signal),
        stop: (sessionId, context) => controller.stopForAgent(sessionId, context),
      },
    });
    return {
      harness,
      controller,
      permissionBroker,
      router,
      cards,
      profile,
      grantStore,
      /** Moves the policy under a Turn that was already dispatched, as a settings change does. */
      movePolicyEpoch: (next: number) => {
        policyEpoch = next;
      },
    };
  }

  const turnContext = { taskId: 'task-1', turnId: 'turn-1', workspaceId: null, policyEpoch: 0 };

  it('publishes, guards, authorizes, and executes computer_list_targets with no Workspace', async () => {
    const { harness, controller, profile } = endToEnd();
    // A Task with no Workspace at all: the surface carries the desktop tools and nothing else.
    const snapshot = harness.startTurn(turnContext, 'codex', {
      computerTargets: true,
      toolSurface: 'computer-targets-only',
    });
    expect(snapshot.entries.map((entry) => entry.providerName).sort()).toEqual([
      'computer_list_targets',
      'computer_request_access',
      'computer_start',
      'computer_stop',
    ]);
    // The catalog carries a target tool, so the warning sentence must accompany it.
    expect(computerTargetSystemPromptFor(snapshot.entries)).toBe(COMPUTER_TARGET_SYSTEM_PROMPT);
    // The window title travels only under a grant whose egress consent names this destination.
    controller.createAppGrant(computerAppGrantIdentityFrom(profile.identity)!, {
      maxMode: 'full_access_app',
      providerEgress: { connectionId: 'connection-1', modelId: 'model-1' },
    });
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

  /**
   * The two calls that carry `computer.control` before a session exists.
   *
   * These reached the controller in unit tests and were denied in production: both require
   * `computer.control`, neither carries a `sessionId`, and the session-bound lane answers
   * `computer_session_missing` without one. Dispatched here through the real authorizer, which is
   * the only place that would have caught it.
   */
  async function raiseCard(fixture: ReturnType<typeof endToEnd>): Promise<{
    outcome: Promise<unknown>;
    card: ComputerAppGrantRequest;
  }> {
    const targets = (await fixture.harness.broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-list',
      providerName: 'computer_list_targets',
      input: {},
    })) as { targets: readonly { kind: string; appToken?: string }[] };
    const appToken = targets.targets.find((target) => target.kind === 'selectable')?.appToken;
    expect(appToken).toBeDefined();
    const outcome = fixture.harness.broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-access',
      providerName: 'computer_request_access',
      input: { appToken, reason: 'Copy the table' },
    });
    // The card is published from inside the dispatch, a few ticks in.
    for (let tick = 0; tick < 50 && fixture.cards.length === 0; tick += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    const card = fixture.cards.at(0);
    expect(card).toBeDefined();
    return { outcome, card: card as ComputerAppGrantRequest };
  }

  it('authorizes computer_request_access and reaches the card', async () => {
    // No grant exists, so a card is actually needed — whatever the V1 row remembers.
    const fixture = endToEnd({ preset: 'ask', remembered: false });
    fixture.harness.startTurn(turnContext, 'codex', {
      computerTargets: true,
      toolSurface: 'computer-targets-only',
    });
    const { outcome, card } = await raiseCard(fixture);
    expect(card.state).toBe('pending');
    // A human click on that card, and the tool call answers.
    await fixture.controller.resolveAppGrantRequest(
      { requestId: card.id, expectedRevision: card.revision, decision: 'deny' },
      null,
    );
    expect(await outcome).toEqual({ granted: false, reasonCode: 'access_request_denied' });
  });

  describe('computer_start with a closed question, through the broker (T15-2)', () => {
    // The real route: the tool boundary parses the strict input schema, the controller hands the
    // question to the planner, and the broker checks the result against the pinned output schema.
    async function ask(
      question: unknown,
      answer: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const fixture = endToEnd({
        plan: async (input) =>
          (input.question === undefined
            ? { type: 'finish' }
            : { type: 'finish', ...answer }) as ComputerUseAction,
      });
      fixture.harness.startTurn(turnContext, 'codex', {
        computerTargets: true,
        toolSurface: 'computer-targets-only',
      });
      fixture.controller.createAppGrant(computerAppGrantIdentityFrom(fixture.profile.identity)!, {
        maxMode: 'full_access_app',
        providerEgress: { connectionId: 'connection-1', modelId: 'model-1' },
      });
      const targets = (await fixture.harness.broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-list',
        providerName: 'computer_list_targets',
        input: {},
      })) as { targets: readonly { kind: string; targetToken?: string }[] };
      const targetToken = targets.targets.find(
        (target) => target.kind === 'selectable',
      )?.targetToken;
      return (await fixture.harness.broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-start',
        providerName: 'computer_start',
        input: { targetToken, goal: 'Did the build pass?', question },
      })) as Record<string, unknown>;
    }

    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    it.each([
      [{ kind: 'boolean' }, { answerBoolean: true }, { kind: 'boolean', value: true }],
      [{ kind: 'boolean' }, { answerBoolean: false }, { kind: 'boolean', value: false }],
      [{ kind: 'choice', choices: eight }, { answerChoice: 7 }, { kind: 'choice', value: 7 }],
      [{ kind: 'choice', choices: eight }, { answerChoice: 0 }, { kind: 'choice', value: 0 }],
      [
        { kind: 'number', maxFractionDigits: 1 },
        { answerNumber: '-12.5' },
        { kind: 'number', value: '-12.5' },
      ],
      [
        { kind: 'number', maxFractionDigits: 0 },
        { answerNumber: 'x' },
        { kind: 'number', value: null },
      ],
      [{ kind: 'boolean' }, { answerChoice: 0 }, { kind: 'boolean', value: null }],
    ])('asks %o and returns %o as %o', async (question, answer, expected) => {
      const output = await ask(question, answer);
      expect(computerStartToolOutputSchema.parse(output)).toEqual(output);
      expect(output).toMatchObject({
        state: 'stopped',
        stopReason: 'agent_finish',
        answer: expected,
      });
    });
  });

  describe('computer_start carry, through the broker, on a host that cannot read or paste (T15-8)', () => {
    // The real route in production while the capability flags are off: nothing can have been
    // copied, so a carry names nothing, and the result is the one it always was.
    async function targetFor(fixture: ReturnType<typeof endToEnd>): Promise<string | undefined> {
      fixture.harness.startTurn(turnContext, 'codex', {
        computerTargets: true,
        toolSurface: 'computer-targets-only',
      });
      fixture.controller.createAppGrant(computerAppGrantIdentityFrom(fixture.profile.identity)!, {
        maxMode: 'full_access_app',
        providerEgress: { connectionId: 'connection-1', modelId: 'model-1' },
      });
      const targets = (await fixture.harness.broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-list',
        providerName: 'computer_list_targets',
        input: {},
      })) as { targets: readonly { kind: string; targetToken?: string }[] };
      return targets.targets.find((target) => target.kind === 'selectable')?.targetToken;
    }
    let calls = 0;
    const start = (fixture: ReturnType<typeof endToEnd>, input: Record<string, unknown>) =>
      fixture.harness.broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: `call-start-${(calls += 1)}`,
        providerName: 'computer_start',
        input,
      });

    it('refuses a carry of four at the boundary and a carry of one without telling why, and lists no artifacts', async () => {
      const fixture = endToEnd();
      const targetToken = await targetFor(fixture);
      const item = (artifactId: string) => ({ artifactId });
      await expect(
        start(fixture, {
          targetToken,
          goal: 'x',
          carry: ['a', 'b', 'c', 'd'].map(item),
        }),
      ).rejects.toThrow();
      await expect(start(fixture, { targetToken, goal: 'x', carry: [item('a')] })).rejects.toThrow(
        /carry is not valid/u,
      );
      // Neither spent the token: the same call without a carry runs the session.
      const output = (await start(fixture, { targetToken, goal: 'x' })) as Record<string, unknown>;
      expect(computerStartToolOutputSchema.parse(output)).toEqual(output);
      expect(output).toMatchObject({ state: 'stopped', stopReason: 'agent_finish' });
      expect(output).not.toHaveProperty('artifacts');
    });
  });

  it('authorizes computer_start and runs a session to its end', async () => {
    const fixture = endToEnd({ preset: 'ask' });
    fixture.harness.startTurn(turnContext, 'codex', {
      computerTargets: true,
      toolSurface: 'computer-targets-only',
    });
    fixture.controller.createAppGrant(computerAppGrantIdentityFrom(fixture.profile.identity)!, {
      maxMode: 'full_access_app',
      providerEgress: { connectionId: 'connection-1', modelId: 'model-1' },
    });
    const targets = (await fixture.harness.broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-list',
      providerName: 'computer_list_targets',
      input: {},
    })) as { targets: readonly { kind: string; targetToken?: string }[] };
    const targetToken = targets.targets.find((target) => target.kind === 'selectable')?.targetToken;
    const output = await fixture.harness.broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-start',
      providerName: 'computer_start',
      input: { targetToken, goal: 'Copy the table into Numbers' },
    });
    // Through the broker, which validates the reduced projection against the tool's own output
    // schema — including `stopReason: null`, which an `enum` with no `type` has to accept.
    expect(computerStartToolOutputSchema.parse(output)).toEqual(output);
    expect(output).toMatchObject({ state: 'stopped', stopReason: 'agent_finish', round: 1 });
  });

  it('stops both control calls when computer.control is revoked, and leaves enumeration alone', async () => {
    const fixture = endToEnd({ revokedCapabilities: ['computer.control'], remembered: false });
    fixture.harness.startTurn(turnContext, 'codex', {
      computerTargets: true,
      toolSurface: 'computer-targets-only',
    });
    // Enumeration only needs `computer.observe`, so it still works.
    const targets = (await fixture.harness.broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-list',
      providerName: 'computer_list_targets',
      input: {},
    })) as { targets: readonly { kind: string; appToken?: string; targetToken?: string }[] };
    const selectable = targets.targets.find((target) => target.kind === 'selectable');
    expect(selectable).toBeDefined();
    // The lane supplies its own allow rule, but a revoked capability is folded into projectDeny,
    // which runs first. Nothing reaches the controller, so no card is ever raised.
    for (const call of [
      {
        providerName: 'computer_request_access',
        input: { appToken: selectable?.appToken, reason: 'ask' },
      },
      {
        providerName: 'computer_start',
        input: { targetToken: selectable?.targetToken, goal: 'x' },
      },
    ])
      await expect(
        fixture.harness.broker.dispatch({
          taskId: 'task-1',
          turnId: 'turn-1',
          callId: `call-${call.providerName}`,
          ...call,
        }),
      ).rejects.toThrow(/capability_revoked/u);
    expect(fixture.cards).toHaveLength(0);
  });

  it('denies both control calls when the policy epoch has moved', async () => {
    const fixture = endToEnd({ policyEpoch: 7, remembered: false });
    fixture.harness.startTurn({ ...turnContext, policyEpoch: 7 }, 'codex', {
      computerTargets: true,
      toolSurface: 'computer-targets-only',
    });
    // The user changes a permission after the Turn was dispatched. The catalog is bound to the
    // epoch it started with; the lane reads the current one.
    fixture.movePolicyEpoch(8);
    for (const call of [
      { providerName: 'computer_request_access', input: { appToken: 'x', reason: 'ask' } },
      { providerName: 'computer_start', input: { targetToken: 'x', goal: 'x' } },
    ])
      // The broker refuses first — a catalog bound to an epoch that has moved cannot dispatch at
      // all — so this is the outer of the two guards.
      await expect(
        fixture.harness.broker.dispatch({
          taskId: 'task-1',
          turnId: 'turn-1',
          callId: `call-${call.providerName}`,
          ...call,
        }),
      ).rejects.toThrow(/policy epoch/iu);
    expect(fixture.cards).toHaveLength(0);

    // And the lane's own check, which is what answers if a call ever arrives past the broker.
    const evaluate = (toolId: string): Promise<{ decision: string; reason: string }> =>
      (
        fixture.router as unknown as {
          evaluateToolPermission(
            request: unknown,
            capability: string,
          ): Promise<{ decision: string; reason: string }>;
        }
      ).evaluateToolPermission(
        {
          entry: {
            toolId,
            providerName: 'x',
            kind: 'computerTarget',
            sideEffect: 'control',
            risk: 'high',
          },
          input: {},
          callId: 'call-direct',
          context: { taskId: 'task-1', turnId: 'turn-1', workspaceId: null, policyEpoch: 7 },
        },
        'computer.control',
      );
    for (const toolId of [COMPUTER_REQUEST_ACCESS_TOOL.toolId, COMPUTER_START_TOOL.toolId])
      await expect(evaluate(toolId)).resolves.toMatchObject({
        decision: 'deny',
        reason: 'policy_epoch_changed',
      });
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

/**
 * #785 T15-10 J21(e): the card of a paste, answered through the trusted Renderer intent path.
 *
 * The real controller, the real `ComputerUseArtifactStore` and the router's own publishing code
 * (`publishComputerUseApproval` / `publishComputerUseStatus`, so the status channel is what a
 * Renderer would be sent); only the native host, the planner and the click's activation are
 * stand-ins. A value is copied in session A, carried into session B and pasted there: the click
 * that answers B's card has to carry an intent that names this card and this decision.
 */
describe('a paste card answered through the trusted intent path (T15-10 J21(e))', () => {
  const body = 'Total 42 qzx-7f3a-Mk';
  const visible = 'qzx-7f3a-Mk';
  const turnContext = {
    taskId: 'task-1',
    turnId: 'turn-1',
    workspaceId: null,
    policyEpoch: 0,
  } as const;
  const taskBinding = { taskId: 'task-1', turnId: 'turn-1', policyEpoch: 0 } as const;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-21T00:00:00.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function settle<T>(pending: Promise<T>, steps = 200): Promise<T> {
    const sentinel = Symbol('pending');
    const race = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    for (let step = 0; step < steps; step += 1) {
      const outcome = await Promise.race([race, Promise.resolve(sentinel)]);
      if (outcome !== sentinel) {
        if ('error' in outcome) throw outcome.error;
        return outcome.value;
      }
      await vi.advanceTimersByTimeAsync(1_000);
    }
    throw new Error('the session never settled');
  }

  function trusted() {
    const fixture = captureComputerUseHandlers();
    const router = fixture.router as unknown as Record<string, (...args: unknown[]) => unknown> &
      Record<string, unknown>;
    const sent: { channel: string; payload: unknown }[] = [];
    Object.assign(router, {
      window: {
        id: 42,
        webContents: {
          id: 42,
          once: vi.fn(),
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
        isDestroyed: () => false,
        isVisible: () => true,
        showInactive: vi.fn(),
        flashFrame: vi.fn(),
      },
      computerUseStatusBySession: new Map(),
      computerUseApprovalSessionById: new Map(),
      computerUsePendingApprovalBySession: new Map<string, { id: string }>(),
      computerUseSessionByTask: new Map(),
      computerUsePendingGrantRequestIds: new Set(),
      computerUseAttentionFlashing: false,
      trustedRendererOrigin: 'app://bundle',
    });
    const logged: unknown[][] = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const)
      vi.spyOn(secureLogger, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });

    const profile = {
      id: 'profile-1',
      platform: 'darwin' as const,
      kind: 'macos-bundle' as const,
      label: 'Notes',
      canonicalPath: '/Applications/Notes.app/Contents/MacOS/Notes',
      appUrl: null,
      identity: endToEndIdentity,
      identityDigest: endToEndIdentity.identityDigest,
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
    const audits = new Map<string, Record<string, unknown>>();
    const dispatched: ComputerUseAction[] = [];
    const plans: Record<string, unknown>[] = [];
    let observationRevision = 0;
    const store = new ComputerUseArtifactStore({ now: () => performance.now() });
    const grantStore = createComputerAppGrantFixtureStore();
    const controller = new ComputerUseController({
      persistence: {
        listComputerAppProfiles: () => [profile],
        getComputerAppProfile: () => profile,
        getActiveTurnId: () => 'turn-1',
        getPermissionPolicy: () => ({ policyEpoch: 0 }),
        listComputerActionAudits: () => [...audits.values()],
        recordComputerActionAudit: (input: Record<string, unknown>) => {
          const record = { ...input, id: `audit-${audits.size + 1}`, state: 'pending' };
          audits.set(record.id, record);
          return record;
        },
        completeComputerActionAudit: ({ auditId, state }: { auditId: string; state: string }) => {
          const next = { ...audits.get(auditId), state };
          audits.set(auditId, next);
          return next;
        },
        ...grantStore.api,
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
        startSession: async (input: { sessionId: string; windowId: string }) => ({
          sessionId: input.sessionId,
          platform: 'darwin',
          appIdentityDigest: profile.identityDigest,
          windowIdentityDigest: 'd'.repeat(64),
          windowId: input.windowId,
          profileRevision: profile.revision,
          cancelEpoch: 0,
          policyLanguage: 'en',
          maximumMode: 'full_access_app',
          screenBounds: { x: 0, y: 0, width: 800, height: 600 },
        }),
        observe: async (session: { sessionId: string }) => {
          observationRevision += 1;
          return {
            ...endToEndObservation(session.sessionId, observationRevision, profile.identityDigest),
            targetSignatures: { 'node-1': 'a'.repeat(64) },
            targetMetadata: { 'node-1': {} },
          };
        },
        artifactReadSupported: () => true,
        readNodeValue: async () => ({ ok: true as const, text: body }),
        artifactPasteSupported: () => true,
        dispatch: async (input: { action: ComputerUseAction }) => {
          dispatched.push(input.action);
          return { result: 'completed', reasonCode: null };
        },
        cancel: async () => undefined,
        close: async () => undefined,
      } as unknown as ConstructorParameters<typeof ComputerUseController>[0]['native'],
      featureEnabled: () => true,
      agentDrivenEnabled: () => true,
      artifactStore: store,
      providerEgressBindingFor: () => ({ connectionId: 'connection-1', modelId: 'model-1' }),
      currentPolicyEpoch: () => 0,
      repositionEmergencyStop: () => true,
      publishGrantRequest: () => undefined,
      publishApproval: (approval) => router['publishComputerUseApproval']!(approval),
      publishStatus: (status) => router['publishComputerUseStatus']!(status),
      planner: {
        plan: async () => (plans.shift() as ComputerUseAction | undefined) ?? { type: 'finish' },
      },
    });
    Object.assign(router, { computerUseController: controller });
    controller.createAppGrant(computerAppGrantIdentityFrom(endToEndIdentity)!, {
      maxMode: 'full_access_app',
      providerEgress: { connectionId: 'connection-1', modelId: 'model-1' },
    });
    const handler = fixture.handlers.get(IPC_CHANNELS.computerUseApprovalResolve)!;
    // The real outer wrapper of `IpcRouter.handle` (sender check, envelope parse, output schema)
    // around the real registered handler body and the schemas it was registered with.
    const registration = fixture.schemas.get(IPC_CHANNELS.computerUseApprovalResolve)!;
    electronMock.ipcMainHandle.mockClear();
    (IpcRouter.prototype as unknown as { handle: (...args: unknown[]) => void }).handle.call(
      router,
      IPC_CHANNELS.computerUseApprovalResolve,
      registration.input,
      registration.output,
      handler,
    );
    const outer = electronMock.ipcMainHandle.mock.calls.at(-1)![1] as (
      event: unknown,
      raw: unknown,
    ) => Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>;
    const senderEvent = (id: number, url: string) => {
      const frame: { url: string; top?: unknown } = { url };
      frame.top = frame;
      return { sender: { id }, senderFrame: frame };
    };
    const rendererEvent = senderEvent(42, 'app://bundle/index.html');

    const targetToken = async (context: typeof turnContext = turnContext): Promise<string> => {
      const row = (await controller.listTargets({}, context)).targets.find(
        (target) => (target as { kind?: string }).kind === 'selectable',
      ) as { targetToken: string } | undefined;
      if (row === undefined) throw new Error('no selectable target');
      return row.targetToken;
    };

    /** A copies the value; B is started with it carried, and stops at the paste's card. */
    async function reachCard(
      exclude: readonly string[] = [],
      context: typeof turnContext = turnContext,
    ) {
      plans.push({ type: 'copy', targetId: 'node-1' });
      const outA = await settle(
        controller.startForAgent(
          { targetToken: await targetToken(context), goal: 'copy' },
          context,
        ),
      );
      const artifactId = (outA as { artifacts: { artifactId: string }[] }).artifacts[0]!.artifactId;
      plans.push({ type: 'set_text', targetId: 'node-1', artifactRef: artifactId });
      const running = controller.startForAgent(
        { targetToken: await targetToken(context), goal: 'paste', carry: [{ artifactId }] },
        turnContext,
      );
      const pending = router['computerUsePendingApprovalBySession'] as unknown as Map<
        string,
        ComputerUseApproval
      >;
      const fresh = () => [...pending.values()].find((entry) => !exclude.includes(entry.id));
      for (let step = 0; step < 100 && fresh() === undefined; step += 1)
        await vi.advanceTimersByTimeAsync(10);
      const card = fresh();
      if (card === undefined) throw new Error('no card was raised');
      return { outA, artifactId, running, card };
    }

    /** What the Renderer's click carries: the decision it was given and the card it is on. */
    const clickInput = (card: ComputerUseApproval, decision: string) =>
      ({
        approvalId: card.id,
        expectedRevision: card.revision,
        decision,
        challenge: card.challenge,
      }) as const;
    const click = (
      input: ReturnType<typeof clickInput>,
      intent: { decision?: string; approvalId?: string; challenge?: string } | null,
      event: unknown = rendererEvent,
    ) => {
      fixture.activation.consume.mockReturnValueOnce(
        intent === null
          ? null
          : {
              token: 'approval-activation',
              intent: approvalActivationIntent({ ...input, ...intent } as never),
            },
      );
      return outer(event, { requestId: 'request-1', operationId: 'operation-1', payload: input });
    };

    return {
      controller,
      store,
      dispatched,
      sent,
      logged,
      reachCard,
      clickInput,
      click,
      senderEvent,
      activation: fixture.activation,
      handler,
      settle,
    };
  }

  const stillPending = (t: ReturnType<typeof trusted>, card: ComputerUseApproval): boolean =>
    t.controller.getStatus(card.sessionId)?.pendingApproval?.id === card.id;

  it('raises a card that can only be allowed once or denied, with the excerpt in it', async () => {
    const t = trusted();
    const { card } = await t.reachCard();
    expect(card.allowedDecisions).toEqual(['allow_once', 'deny']);
    expect(card.transfer?.excerpt).toBe(body);
    expect(card.transfer?.sourceLabel).toBe('Notes');
    expect(t.dispatched).toEqual([]);
  });

  const codeOf = (result: { ok: boolean; error?: { code: string } }): string | undefined =>
    result.ok ? undefined : result.error?.code;
  /** Everything a log call was given, Errors included (their message and stack), as one string. */
  const loggedText = (t: ReturnType<typeof trusted>): string =>
    inspect(t.logged, { depth: null, maxStringLength: null, maxArrayLength: null });

  it.each([
    ['another decision', { decision: 'deny' }],
    ['another card', { approvalId: 'approval-other' }],
    ['another challenge', { challenge: 'b'.repeat(64) }],
    ['no trusted activation at all', null],
  ] as const)(
    'refuses a click whose intent names %s, and nothing is typed',
    async (_name, intent) => {
      const t = trusted();
      const { card } = await t.reachCard();
      const result = await t.click(t.clickInput(card, 'allow_once'), intent);
      expect(codeOf(result)).toBe('FORBIDDEN');
      expect(t.dispatched).toEqual([]);
      expect(stillPending(t, card)).toBe(true);
    },
  );

  it('refuses a click from a sender that is not the trusted Renderer, whatever the intent', async () => {
    const t = trusted();
    const { card } = await t.reachCard();
    const input = t.clickInput(card, 'allow_once');
    const foreignOrigin = t.senderEvent(42, 'https://example.invalid/index.html');
    const otherWebContents = t.senderEvent(7, 'app://bundle/index.html');
    for (const event of [foreignOrigin, otherWebContents]) {
      const result = await t.click(input, {}, event);
      expect(codeOf(result)).toBe('FORBIDDEN');
    }
    // It never got as far as the activation, the controller or the native host.
    expect(t.activation.consume).not.toHaveBeenCalled();
    expect(t.dispatched).toEqual([]);
    expect(stillPending(t, card)).toBe(true);
  });

  it('refuses allow_plan on a paste card even with an intent that names it', async () => {
    const t = trusted();
    const { card } = await t.reachCard();
    expect(card.eligibleForPlan).toBe(false);
    const result = await t.click(t.clickInput(card, 'allow_plan'), {});
    expect(result.ok).toBe(false);
    expect(loggedText(t)).toContain('decision is not allowed');
    expect(t.dispatched).toEqual([]);
    expect(stillPending(t, card)).toBe(true);
  });

  it('refuses an old challenge of a card that is still pending, and the right one still works', async () => {
    const t = trusted();
    const { card, running } = await t.reachCard();
    // The intent names the (old) challenge the click carries, so only the controller can refuse it.
    const old = { ...t.clickInput(card, 'allow_once'), challenge: 'c'.repeat(64) };
    const result = await t.click(old, {});
    expect(result.ok).toBe(false);
    expect(loggedText(t)).toContain('approval is stale');
    expect(t.dispatched).toEqual([]);
    expect(stillPending(t, card)).toBe(true);
    expect((await t.click(t.clickInput(card, 'allow_once'), {})).ok).toBe(true);
    await t.settle(running);
    expect(t.dispatched).toHaveLength(1);
  });

  it('refuses a revision that is not the card current one while the session goes on', async () => {
    const t = trusted();
    const { card, running } = await t.reachCard();
    const old = { ...t.clickInput(card, 'allow_once'), expectedRevision: card.revision + 1 };
    const result = await t.click(old, {});
    expect(result.ok).toBe(false);
    expect(loggedText(t)).toContain('approval is stale');
    expect(t.dispatched).toEqual([]);
    expect(stillPending(t, card)).toBe(true);
    expect((await t.click(t.clickInput(card, 'allow_once'), {})).ok).toBe(true);
    await t.settle(running);
    expect(t.dispatched).toHaveLength(1);
  });

  it('refuses the card of an earlier session while a later session has its own card', async () => {
    const t = trusted();
    // Only one Computer Use session lives at a time, so session 1 is ended before session 2 starts.
    const first = await t.reachCard();
    await t.controller.stop(first.card.sessionId);
    await t.settle(first.running);
    const second = await t.reachCard([first.card.id]);
    expect(second.card.sessionId).not.toBe(first.card.sessionId);
    expect(second.card.id).not.toBe(first.card.id);
    // Session 1's own, once valid, click is for a card this Renderer is no longer waiting on.
    const result = await t.click(t.clickInput(first.card, 'allow_once'), {});
    expect(result.ok).toBe(false);
    expect(t.dispatched).toEqual([]);
    expect(stillPending(t, second.card)).toBe(true);
    // And session 2's decision aimed at session 1's id does not reach session 2's card either.
    const crossed = { ...t.clickInput(second.card, 'allow_once'), approvalId: first.card.id };
    expect((await t.click(crossed, {})).ok).toBe(false);
    expect(t.dispatched).toEqual([]);
    expect(stillPending(t, second.card)).toBe(true);
  });

  it('refuses a card id that was never raised (unknown card id) as not found', async () => {
    const t = trusted();
    const { card } = await t.reachCard();
    const unknown = {
      ...t.clickInput(card, 'allow_once'),
      approvalId: 'approval-never-raised',
    };
    const result = await t.click(unknown, {});
    expect(codeOf(result)).toBe('NOT_FOUND');
    expect(t.dispatched).toEqual([]);
    expect(stillPending(t, card)).toBe(true);
  });

  it('keeps the artifact when the card is denied, and discards it when the session ends', async () => {
    const t = trusted();
    const { card, artifactId, running } = await t.reachCard();
    expect((await t.click(t.clickInput(card, 'deny'), {})).ok).toBe(true);
    expect(t.dispatched).toEqual([]);
    // Denying uses nothing up: what was carried in is still there while the session lives.
    expect(t.store.describeReference([artifactId], taskBinding)).not.toBeNull();
    await t.controller.stop(card.sessionId);
    await t.settle(running);
    expect(t.store.describeReference([artifactId], taskBinding)).toBeNull();
    expect(t.dispatched).toEqual([]);
  });

  it('types once for allow_once, and a second click on the same card does nothing', async () => {
    const t = trusted();
    const { card, artifactId, running } = await t.reachCard();
    const input = t.clickInput(card, 'allow_once');
    expect((await t.click(input, {})).ok).toBe(true);
    // The session is still going: the answered card is not a pending one any more.
    const again = await t.click(input, {});
    expect(again.ok).toBe(false);
    expect(loggedText(t)).toContain('approval not found');
    expect(stillPending(t, card)).toBe(false);
    await t.settle(running);
    expect(t.dispatched).toEqual([{ type: 'set_text', targetId: 'node-1', text: body }]);
    // The value is used up by the paste, and the same click after the session ended is refused too.
    expect(t.store.describeReference([artifactId], taskBinding)).toBeNull();
    expect((await t.click(input, {})).ok).toBe(false);
    expect(t.dispatched).toHaveLength(1);
  });

  it('puts the excerpt on the status channel only, never on another channel or in a log', async () => {
    const t = trusted();
    const { card, outA, running } = await t.reachCard();
    expect((await t.click(t.clickInput(card, 'allow_once'), {})).ok).toBe(true);
    const outB = await t.settle(running);
    // The excerpt did travel the way it is meant to: in a status the Renderer was sent.
    const statusSends = t.sent.filter(
      (entry) => entry.channel === IPC_CHANNELS.computerUseStatusEvent,
    );
    expect(JSON.stringify(statusSends)).toContain(visible);
    expect(t.sent.length).toBeGreaterThan(0);
    // And nowhere else. A log argument may be an Error (JSON.stringify gives `{}` for one), so it is
    // read as `util.inspect` does, message and stack included; and a leak need not be the whole
    // text, so every 8-character window of the body, and its distinctive parts, are looked for.
    const fragments = [
      body,
      visible,
      'qzx',
      '7f3a',
      ...Array.from({ length: body.length - 7 }, (_unused, at) => body.slice(at, at + 8)),
    ];
    const elsewhere = t.sent.filter(
      (entry) => entry.channel !== IPC_CHANNELS.computerUseStatusEvent,
    );
    const searched = {
      'another channel': inspect(elsewhere, { depth: null, maxStringLength: null }),
      'a log line': loggedText(t),
      'a tool result': inspect([outA, outB], { depth: null, maxStringLength: null }),
    };
    for (const [where, text] of Object.entries(searched))
      for (const fragment of fragments)
        expect({ where, fragment, found: text.includes(fragment) }).toEqual({
          where,
          fragment,
          found: false,
        });
    expect(computerStartToolOutputSchema.parse(outB)).toEqual(outB);
  });
});

/**
 * #785 T15-10 J18, the provider API route: the fixed sentence (a copied value is a content-less
 * reference, do not guess it, pass it with `carry`, a paste needs a person each time) rides along
 * only when the tools it speaks of are in the catalog that route sends. `ipc.ts` assembles that
 * route's messages and tools by itself, so the wiring is pinned at the source as well as the
 * helper it calls.
 */
describe('the artifact sentence on the provider API route (T15-10 J18)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main/ipc.ts'), 'utf8').replace(
    /\s+/gu,
    ' ',
  );
  const turn = { taskId: 'task-1', turnId: 'turn-1', workspaceId: null, policyEpoch: 0 };

  it('derives the guidance from the catalog it sends, and adds it only when there is some', () => {
    const start = source.indexOf('const computerTargetGuidance = computerTargetSystemPromptFor(');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, start + 420);
    expect(block).toContain('workspaceToolSnapshot?.entries ?? []');
    expect(block).toContain('if (computerTargetGuidance !== null)');
    expect(block).toContain(
      "messages.unshift({ role: 'system', content: computerTargetGuidance })",
    );
    // One site, and no second way to put the sentence in: the helper is the only source of it.
    expect(source.match(/computerTargetSystemPromptFor\(/gu)).toHaveLength(1);
    expect(source).not.toContain('COMPUTER_TARGET_SYSTEM_PROMPT');
  });

  it('gives the sentence, with the artifact rule once, exactly when the tools are in the catalog', () => {
    const { harness } = (() => {
      const fixtureHarness = new ManagedCodingHarness({
        workspaceFor: () => null,
        rootIdentityFor: () => undefined,
        policyEpochFor: () => 0,
        authorizer: async () => ({ decision: 'allow' }) as never,
        computerTargets: {
          listTargets: async () => ({ targets: [] }) as never,
          requestAccess: async () => ({}) as never,
          start: async () => ({}) as never,
          stop: async () => undefined,
        },
      });
      return { harness: fixtureHarness };
    })();
    const visible = harness.startTurn(turn, 'openai', {
      computerTargets: true,
      toolSurface: 'computer-targets-only',
    });
    const hidden = harness.startTurn({ ...turn, turnId: 'turn-2' }, 'openai', {
      computerTargets: false,
    });
    const sentence = computerTargetSystemPromptFor(visible.entries);
    expect(sentence).toBe(COMPUTER_TARGET_SYSTEM_PROMPT);
    expect(sentence?.split('`artifacts`').length).toBe(2);
    expect(sentence).toContain('`carry`');
    // No computer tool in the catalog, no catalog at all, or an empty one: no sentence.
    expect(computerTargetSystemPromptFor(hidden.entries)).toBeNull();
    expect(computerTargetSystemPromptFor([])).toBeNull();
  });
});
