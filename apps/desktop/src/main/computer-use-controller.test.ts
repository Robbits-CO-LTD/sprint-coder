import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  computerUseAvailabilitySchema,
  type ComputerAppIdentity,
  type ComputerUseAction,
  type ComputerUseApproval,
  type ComputerUseAvailability,
  type ComputerUseObservation,
  type ComputerUseSessionStatus,
} from '@sprint-coder/contracts';
import type {
  ComputerActionAuditInput,
  ComputerActionAuditRecord,
  ComputerAppProfileInput,
  ComputerAppProfileRecord,
} from './persistence';
import {
  ComputerUseController,
  type ComputerUseNativeActionResult,
  type ComputerUseNativeHost,
  type ComputerUseNativeObservation,
  type ComputerUseNativeSession,
  type ComputerUseNativeWindow,
} from './computer-use-controller';

const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const imageDigest = createHash('sha256').update(imageBytes).digest('hex');
const appIdentity: ComputerAppIdentity = {
  platform: 'darwin',
  identityDigest: 'a'.repeat(64),
  bundleId: 'com.example.sprint-coder-computer-use-fixture',
  executablePath: '/Applications/Fixture.app/Contents/MacOS/Fixture',
  executableDigest: 'b'.repeat(64),
  teamId: 'TEAMID',
  signingIdentifier: 'com.example.sprint-coder-computer-use-fixture',
  cdHash: null,
  displayName: 'Fixture',
  policyLanguage: 'en',
  maximumMode: 'full_access_app',
};
const profile: ComputerAppProfileRecord = {
  id: 'profile-1',
  platform: 'darwin',
  kind: 'macos-bundle',
  label: 'Fixture',
  canonicalPath: appIdentity.executablePath,
  appUrl: null,
  identity: appIdentity as unknown as Record<string, unknown>,
  identityDigest: appIdentity.identityDigest,
  version: null,
  executableDigest: appIdentity.executableDigest,
  mode: 'full_access_app',
  connectionId: 'connection-1',
  modelId: 'model-1',
  providerEgressConsent: true,
  remember: true,
  revision: 1,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

const availability: ComputerUseAvailability = computerUseAvailabilitySchema.parse({
  platform: 'darwin',
  state: 'ready',
  featureEnabled: true,
  packageReady: true,
  handshakeReady: true,
  observe: true,
  control: true,
  available: true,
  reasonCode: null,
  manifestDigest: 'c'.repeat(64),
});

function observation(
  revision: number,
  overrides: Partial<ComputerUseObservation> = {},
): ComputerUseNativeObservation {
  return {
    sessionId: 'session-placeholder',
    appIdentityDigest: profile.identityDigest,
    windowIdentityDigest: 'd'.repeat(64),
    profileRevision: profile.revision,
    maximumMode: 'full_access_app',
    screenBounds: { x: 0, y: 0, width: 800, height: 600 },
    revision,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
    clientWidth: 800,
    clientHeight: 600,
    images: [
      {
        mimeType: 'image/png',
        digest: imageDigest,
        byteLength: imageBytes.byteLength,
        width: 1,
        height: 1,
        base64: imageBytes.toString('base64'),
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
    ...overrides,
  } as ComputerUseNativeObservation;
}

function createFixture(
  options: {
    mode?: 'observe_only' | 'supervised' | 'full_access_app';
    observationOverrides?: Partial<ComputerUseObservation>;
    observationOverridesForRevision?: (revision: number) => Partial<ComputerUseObservation>;
    policyEpoch?: number;
    planner?: {
      plan: (input: unknown) => Promise<ComputerUseAction>;
      revalidate?: (signal: AbortSignal) => Promise<void>;
      cancel?: (executionId: string) => Promise<void>;
    };
    dispatch?: (input: {
      requestId: string;
      action: ComputerUseAction;
    }) => Promise<ComputerUseNativeActionResult>;
    authorizationRequired?: boolean;
    startSessionGate?: Promise<void>;
    revalidateWindowsGate?: Promise<void>;
    failFocusRestore?: boolean;
    focusRestoreGate?: Promise<void>;
    changeVisualObservationOnApproval?: boolean;
    changeFocusedElementOnApproval?: boolean;
    changeDialogSetOnApproval?: boolean;
    advanceDialogRevisionOnApproval?: boolean;
    bundleId?: string;
    profilePolicyLanguage?: 'en' | 'ja' | 'unknown';
    windowPolicyLanguage?: 'en' | 'ja' | 'unknown';
    sessionPolicyLanguage?: 'en' | 'ja' | 'unknown';
    resumeSessionPolicyLanguage?: 'en' | 'ja' | 'unknown';
    observationPolicyLanguage?: 'en' | 'ja' | 'unknown';
    profileMaximumMode?: 'observe_only' | 'supervised' | 'full_access_app';
    firstWindowMaximumMode?: 'observe_only' | 'supervised' | 'full_access_app';
    relistWindowMaximumMode?: 'observe_only' | 'supervised' | 'full_access_app';
    sessionMaximumMode?: 'observe_only' | 'supervised' | 'full_access_app';
    resumeSessionMaximumMode?: 'observe_only' | 'supervised' | 'full_access_app';
    observationMaximumMode?: 'observe_only' | 'supervised' | 'full_access_app';
    armEmergencyStop?: (sessionId: string, controller: ComputerUseController) => Promise<boolean>;
    repositionEmergencyStop?: (
      sessionId: string,
      screenBounds: Readonly<{ x: number; y: number; width: number; height: number }>,
    ) => boolean | Promise<boolean>;
    visualActionBlocked?: boolean;
    cancelGate?: Promise<void>;
    closeGate?: Promise<void>;
    now?: () => number;
    profileRecord?: ComputerAppProfileRecord;
    windowExecutableDigest?: string | null;
  } = {},
) {
  let activeTurn: string | null = null;
  let policyEpoch = options.policyEpoch ?? 0;
  const defaultBundleId =
    typeof profile.identity['bundleId'] === 'string'
      ? profile.identity['bundleId']
      : 'com.example.sprint-coder-computer-use-fixture';
  let currentProfile: ComputerAppProfileRecord = {
    ...(options.profileRecord ?? profile),
    mode: options.mode ?? profile.mode,
    identity: {
      ...(options.profileRecord?.identity ?? profile.identity),
      bundleId: options.bundleId ?? defaultBundleId,
      policyLanguage: options.profilePolicyLanguage ?? 'en',
      maximumMode: options.profileMaximumMode ?? 'full_access_app',
    },
  };
  let revision = 0;
  const audits = new Map<string, ComputerActionAuditRecord>();
  const statuses: ComputerUseSessionStatus[] = [];
  const approvals: ComputerUseApproval[] = [];
  let dispatchCount = 0;
  const dispatchedActions: ComputerUseAction[] = [];
  const nativeStartWindowIds: string[] = [];
  let profileUpdates = 0;
  const managedLifecycle = vi.fn();
  let listWindowsCount = 0;
  let startSessionCount = 0;
  let nativeCancelCount = 0;
  let nativeCloseCount = 0;
  const nativeSession: ComputerUseNativeSession = {
    sessionId: 'session-1',
    platform: currentProfile.platform,
    appIdentityDigest: currentProfile.identityDigest,
    windowIdentityDigest: 'd'.repeat(64),
    windowId: 'window-1',
    profileRevision: profile.revision,
    cancelEpoch: 0,
    policyLanguage: options.sessionPolicyLanguage ?? 'en',
    maximumMode: options.sessionMaximumMode ?? 'full_access_app',
    screenBounds: { x: 0, y: 0, width: 800, height: 600 },
  };
  const native: ComputerUseNativeHost = {
    availability: () => availability,
    pickApplication: async () => appIdentity,
    listWindows: async () => {
      listWindowsCount += 1;
      if (listWindowsCount > 1) await options.revalidateWindowsGate;
      return [
        {
          platform: currentProfile.platform,
          windowId: 'window-1',
          appIdentityDigest: currentProfile.identityDigest,
          ...(options.windowExecutableDigest === undefined
            ? {}
            : { executableDigest: options.windowExecutableDigest }),
          windowIdentityDigest: nativeSession.windowIdentityDigest,
          title: 'Fixture',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          screenBounds: { x: 0, y: 0, width: 800, height: 600 },
          focused: true,
          eligible: true,
          ownerKind: 'application',
          modal: false,
          revision: 1,
          policyLanguage: options.windowPolicyLanguage ?? 'en',
          maximumMode:
            listWindowsCount > 1
              ? (options.relistWindowMaximumMode ??
                options.firstWindowMaximumMode ??
                'full_access_app')
              : (options.firstWindowMaximumMode ?? 'full_access_app'),
        },
      ] satisfies readonly ComputerUseNativeWindow[];
    },
    startSession: async (input) => {
      await options.startSessionGate;
      startSessionCount += 1;
      if (startSessionCount > 1) await options.focusRestoreGate;
      if (options.failFocusRestore === true && startSessionCount > 1)
        throw new Error('focus unavailable');
      nativeStartWindowIds.push(input.windowId);
      return {
        ...nativeSession,
        sessionId: input.sessionId,
        profileRevision: input.profile.revision,
        policyLanguage:
          startSessionCount > 1
            ? (options.resumeSessionPolicyLanguage ?? nativeSession.policyLanguage)
            : nativeSession.policyLanguage,
        maximumMode:
          startSessionCount > 1
            ? (options.resumeSessionMaximumMode ?? nativeSession.maximumMode)
            : nativeSession.maximumMode,
      };
    },
    observe: async (session) => {
      const nextRevision = ++revision;
      const observed = observation(nextRevision, {
        sessionId: session.sessionId,
        windowIdentityDigest: session.windowIdentityDigest,
        policyLanguage: options.observationPolicyLanguage ?? session.policyLanguage,
        maximumMode: options.observationMaximumMode ?? session.maximumMode,
        screenBounds: session.screenBounds,
        ...(options.observationOverrides ?? {}),
        ...(options.observationOverridesForRevision?.(nextRevision) ?? {}),
      });
      return options.changeDialogSetOnApproval === true && nextRevision > 1
        ? {
            ...observed,
            dialogSetRevision: (observed.dialogSetRevision ?? 0) + 1,
            dialogSetDigest: '9'.repeat(64),
            activeWindowIdentityDigest: '8'.repeat(64),
            activeWindowKind: 'dialog' as const,
          }
        : options.advanceDialogRevisionOnApproval === true && nextRevision > 1
          ? {
              ...observed,
              dialogSetRevision: (observed.dialogSetRevision ?? 0) + 1,
            }
          : options.changeVisualObservationOnApproval === true && nextRevision > 1
            ? {
                ...observed,
                images: observed.images.map((image) => ({ ...image, digest: 'f'.repeat(64) })),
              }
            : options.changeFocusedElementOnApproval === true && nextRevision > 1
              ? { ...observed, focusedElementSignature: 'e'.repeat(64) }
              : observed;
    },
    dispatch: async ({ requestId, action }) => {
      dispatchCount += 1;
      dispatchedActions.push(action);
      if (options.dispatch !== undefined) return options.dispatch({ requestId, action });
      return { result: 'completed', reasonCode: null };
    },
    cancel: async () => {
      nativeCancelCount += 1;
      await options.cancelGate;
    },
    close: async () => {
      nativeCloseCount += 1;
      await options.closeGate;
    },
  };
  const persistence = {
    listComputerAppProfiles: () => [currentProfile],
    getComputerAppProfile: () => currentProfile,
    createComputerAppProfile: (input: ComputerAppProfileInput) => {
      currentProfile = {
        ...input,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as ComputerAppProfileRecord;
      return currentProfile;
    },
    updateComputerAppProfile: (_id: string, expected: number, input: ComputerAppProfileInput) => {
      if (expected !== currentProfile.revision) throw new Error('profile conflict');
      profileUpdates += 1;
      currentProfile = {
        ...input,
        revision: currentProfile.revision + 1,
        createdAt: currentProfile.createdAt,
        updatedAt: new Date().toISOString(),
      } as ComputerAppProfileRecord;
      return currentProfile;
    },
    removeComputerAppProfile: () => undefined,
    recordComputerActionAudit: (input: ComputerActionAuditInput) => {
      const existing = [...audits.values()].find(
        (audit) =>
          audit.sessionId === input.sessionId && audit.nativeRequestId === input.nativeRequestId,
      );
      if (existing !== undefined) return existing;
      const createdAt = input.createdAt ?? new Date().toISOString();
      const record: ComputerActionAuditRecord = {
        id: input.id ?? `audit-${audits.size + 1}`,
        taskId: input.taskId,
        turnId: input.turnId,
        sessionId: input.sessionId,
        profileId: input.profileId,
        profileRevision: input.profileRevision,
        appIdentityDigest: input.appIdentityDigest,
        windowIdentityDigest: input.windowIdentityDigest,
        observationRevision: input.observationRevision,
        observationDigest: input.observationDigest,
        clientWidth: input.clientWidth,
        clientHeight: input.clientHeight,
        actionDigest: input.actionDigest,
        actionKind: input.actionKind,
        route: input.route,
        state: input.state ?? 'pending',
        reasonCode: input.reasonCode ?? null,
        nativeRequestId: input.nativeRequestId,
        policyEpoch: input.policyEpoch,
        createdAt,
        updatedAt: createdAt,
      };
      audits.set(record.id, record);
      return record;
    },
    completeComputerActionAudit: (input: {
      auditId: string;
      state: Exclude<ComputerActionAuditRecord['state'], 'pending'>;
      reasonCode?: string | null;
      updatedAt: string;
    }) => {
      const current = audits.get(input.auditId);
      if (current === undefined) throw new Error('audit missing');
      const next = {
        ...current,
        state: input.state,
        reasonCode: input.reasonCode ?? null,
        updatedAt: input.updatedAt,
      };
      audits.set(input.auditId, next);
      return next;
    },
    listComputerActionAudits: () => [...audits.values()],
    recordManagedToolLifecycle: managedLifecycle,
    getTask: () => ({ id: 'task-1' }),
    getActiveTurnId: () => activeTurn,
    getPermissionPolicy: () => ({ policyEpoch: 0 }),
  };
  let controllerRef: ComputerUseController | null = null;
  const controller = new ComputerUseController({
    persistence,
    native,
    ...(options.planner === undefined ? {} : { planner: options.planner }),
    featureEnabled: () => true,
    ...(options.now === undefined ? {} : { now: options.now }),
    currentPolicyEpoch: () => policyEpoch,
    publishStatus: (status) => statuses.push(status),
    publishApproval: (approval) => approvals.push(approval as ComputerUseApproval),
    ...(options.authorizationRequired === true
      ? {
          authorize: async (request: { capability: string }) =>
            request.capability === 'computer.observe'
              ? { decision: 'allow' as const, reason: 'computer_observe_session' }
              : {
                  decision: 'approval_required' as const,
                  reason: 'computer_control_requires_approval',
                },
        }
      : {}),
    ...(options.armEmergencyStop === undefined
      ? {}
      : {
          armEmergencyStop: (sessionId: string): Promise<boolean> =>
            options.armEmergencyStop!(sessionId, controllerRef!),
        }),
    repositionEmergencyStop: options.repositionEmergencyStop ?? (() => true),
    ...(options.visualActionBlocked === true ? { visualActionBlocked: () => true } : {}),
  });
  controllerRef = controller;
  return {
    controller,
    statuses,
    approvals,
    audits,
    nativeSession,
    setActiveTurn: (turnId: string | null) => {
      activeTurn = turnId;
    },
    setPolicyEpoch: (next: number) => {
      policyEpoch = next;
    },
    dispatchCount: () => dispatchCount,
    dispatchedActions: () => dispatchedActions,
    nativeStartWindowIds: () => nativeStartWindowIds,
    nativeCancelCount: () => nativeCancelCount,
    nativeCloseCount: () => nativeCloseCount,
    profileUpdates: () => profileUpdates,
    currentProfile: () => currentProfile,
    managedLifecycle,
  };
}

async function start(
  fixture: ReturnType<typeof createFixture>,
  mode: 'observe_only' | 'supervised' | 'full_access_app' = 'full_access_app',
  remember = false,
  expectedProfileRevision?: number,
) {
  const candidate = (await fixture.controller.listWindows(profile.id))[0]!;
  return fixture.controller.start({
    taskId: 'task-1',
    profileId: profile.id,
    windowId: candidate.windowId,
    mode,
    connectionId: profile.connectionId,
    modelId: profile.modelId,
    providerEgressConsent: true,
    providerEgressConsentBinding: {
      connectionId: profile.connectionId,
      modelId: profile.modelId,
    },
    remember,
    expectedPolicyEpoch: 0,
    expectedWindowRevision: candidate.revision,
    expectedProfileRevision: expectedProfileRevision ?? profile.revision,
  });
}

const click: ComputerUseAction = { type: 'click', x: 0.5, y: 0.5, button: 'left' };
const plainType: ComputerUseAction = { type: 'type', text: 'hello' };

describe('ComputerUseController', () => {
  it('refreshes a same-path same-signer Notepad profile before issuing its window permit', async () => {
    const registeredDigest = '1'.repeat(64);
    const updatedDigest = '2'.repeat(64);
    const signerDigest = '3'.repeat(64);
    const identityDigest = '4'.repeat(64);
    const windowsProfile: ComputerAppProfileRecord = {
      ...profile,
      platform: 'win32',
      kind: 'win32-executable',
      label: 'Notepad',
      canonicalPath: 'C:\\Windows\\System32\\notepad.exe',
      identityDigest,
      executableDigest: registeredDigest,
      identity: {
        platform: 'win32',
        identityDigest,
        executablePath: 'C:\\Windows\\System32\\notepad.exe',
        executableDigest: registeredDigest,
        signerDigest,
        packageFamilyName: null,
        appUserModelId: null,
        displayName: 'Notepad',
        policyLanguage: 'en',
        maximumMode: 'full_access_app',
      },
    };
    const fixture = createFixture({
      profileRecord: windowsProfile,
      windowExecutableDigest: updatedDigest,
    });

    const candidate = (await fixture.controller.listWindows(windowsProfile.id))[0]!;
    const refreshed = fixture.controller.listProfiles()[0]!;
    expect(refreshed.profileRevision).toBe(2);
    expect(fixture.profileUpdates()).toBe(1);
    expect(fixture.currentProfile()).toMatchObject({
      executableDigest: updatedDigest,
      revision: 2,
      identity: { executableDigest: updatedDigest, signerDigest },
    });

    const started = await fixture.controller.start({
      taskId: 'task-1',
      profileId: windowsProfile.id,
      windowId: candidate.windowId,
      mode: 'full_access_app',
      connectionId: windowsProfile.connectionId,
      modelId: windowsProfile.modelId,
      providerEgressConsent: true,
      providerEgressConsentBinding: {
        connectionId: windowsProfile.connectionId,
        modelId: windowsProfile.modelId,
      },
      remember: true,
      expectedPolicyEpoch: 0,
      expectedWindowRevision: candidate.revision,
      expectedProfileRevision: refreshed.profileRevision,
    });
    expect(started.profileRevision).toBe(2);
    await fixture.controller.stop(started.sessionId);
  });

  it('does not route synthetic lifecycle events to the generic persisted Turn table', async () => {
    const fixture = createFixture();
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    expect(fixture.managedLifecycle).not.toHaveBeenCalled();
    await fixture.controller.stop(started.sessionId);
  });

  it('accepts a valid observation whose base64 envelope exceeds the generic 1 MiB tool default', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    const fixture = createFixture({
      observationOverrides: {
        images: [
          {
            mimeType: 'image/png',
            digest: createHash('sha256').update(bytes).digest('hex'),
            byteLength: bytes.byteLength,
            width: 1,
            height: 1,
            base64: bytes.toString('base64'),
          },
        ],
      },
    });
    const started = await start(fixture);
    await expect(fixture.controller.observe(started.sessionId)).resolves.toMatchObject({
      images: [expect.objectContaining({ byteLength: bytes.byteLength })],
    });
    await fixture.controller.stop(started.sessionId);
  });

  it('allows wait as a non-input action in observe-only mode', async () => {
    const fixture = createFixture({ mode: 'observe_only' });
    const started = await start(fixture, 'observe_only');
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, { type: 'wait', milliseconds: 0 }, 'wait-1'),
    ).resolves.toMatchObject({ result: 'completed' });
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('keeps the displayed observation time bound to capture rather than a later action', async () => {
    let now = Date.now();
    const fixture = createFixture({ now: () => now });
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    const observedAt = fixture.controller.getStatus(started.sessionId)?.lastObservationAt;
    now += 1_000;
    await fixture.controller.act(started.sessionId, click, 'later-action');
    expect(fixture.controller.getStatus(started.sessionId)?.lastObservationAt).toBe(observedAt);
    await fixture.controller.stop(started.sessionId);
  });

  it('requires an idle Task for a synthetic session and allows a second session after stop', async () => {
    const fixture = createFixture();
    fixture.setActiveTurn('chat-turn');
    await expect(start(fixture)).rejects.toThrow('idle Task');
    fixture.setActiveTurn(null);
    const first = await start(fixture);
    await fixture.controller.stop(first.sessionId);
    const second = await start(fixture);
    expect(second.sessionId).not.toBe(first.sessionId);
    await fixture.controller.stop(second.sessionId);
    await fixture.controller.dispose();
  });

  it('stops every ephemeral session when the trusted Renderer is reloaded', async () => {
    const fixture = createFixture();
    const started = await start(fixture);
    await fixture.controller.rendererInvalidated();
    expect(fixture.controller.getStatus(started.sessionId)).toBeNull();
    expect(fixture.statuses.at(-1)).toMatchObject({
      state: 'stopped',
      stopReason: 'renderer_reloaded',
    });
  });

  it('makes UI, emergency, and Renderer-reload Stop callers await one native completion', async () => {
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const fixture = createFixture({ cancelGate });
    const started = await start(fixture);

    const uiStop = fixture.controller.stop(started.sessionId, 'user_stop');
    const emergencyStop = fixture.controller.stop(started.sessionId, 'emergency_stop');
    const reloadStop = fixture.controller.rendererInvalidated();
    expect(emergencyStop).toBe(uiStop);
    expect(fixture.nativeCancelCount()).toBe(1);

    let reentrantSettled = false;
    void Promise.all([emergencyStop, reloadStop]).then(() => {
      reentrantSettled = true;
    });
    await Promise.resolve();
    expect(reentrantSettled).toBe(false);
    expect(fixture.nativeCloseCount()).toBe(0);

    releaseCancel();
    await Promise.all([uiStop, emergencyStop, reloadStop]);
    expect(fixture.nativeCancelCount()).toBe(1);
    expect(fixture.nativeCloseCount()).toBe(1);
    expect(fixture.statuses.filter(({ state }) => state === 'stopping')).toHaveLength(1);
    expect(fixture.statuses.filter(({ state }) => state === 'stopped')).toHaveLength(1);
  });

  it('closes native and settles reentrant Stop even when planner cleanup never resolves', async () => {
    let planEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      planEntered = resolve;
    });
    const plannerCancel = vi.fn(() => new Promise<void>(() => undefined));
    const fixture = createFixture({
      planner: {
        plan: async () => {
          planEntered();
          return { type: 'wait', milliseconds: 10_000 };
        },
        cancel: plannerCancel,
      },
    });
    const started = await start(fixture);
    await entered;

    const uiStop = fixture.controller.stop(started.sessionId, 'user_stop');
    const emergencyStop = fixture.controller.stop(started.sessionId, 'emergency_stop');
    expect(emergencyStop).toBe(uiStop);
    await viWait();

    expect(fixture.nativeCancelCount()).toBe(1);
    expect(fixture.nativeCloseCount()).toBe(1);
    await expect(uiStop).resolves.toBeUndefined();
    expect(plannerCancel).toHaveBeenCalledTimes(1);
    expect(fixture.controller.getStatus(started.sessionId)).toBeNull();
  });

  it('accepts only a one-use opaque Main window token and keeps the native handle internal', async () => {
    const fixture = createFixture();
    const candidate = (await fixture.controller.listWindows(profile.id))[0]!;
    expect(candidate.windowId).not.toBe('window-1');
    const input = {
      taskId: 'task-1',
      profileId: profile.id,
      windowId: candidate.windowId,
      mode: 'full_access_app' as const,
      connectionId: profile.connectionId,
      modelId: profile.modelId,
      providerEgressConsent: true,
      providerEgressConsentBinding: {
        connectionId: profile.connectionId,
        modelId: profile.modelId,
      },
      remember: false,
      expectedPolicyEpoch: 0,
      expectedWindowRevision: candidate.revision,
      expectedProfileRevision: profile.revision,
    };
    const started = await fixture.controller.start(input);
    expect(started.windowId).toBe(candidate.windowId);
    expect(fixture.nativeStartWindowIds()).toEqual(['window-1']);
    await fixture.controller.stop(started.sessionId);
    await expect(fixture.controller.start(input)).rejects.toThrow('window candidate is stale');
  });

  it('rejects an egress consent binding that names another Provider or Model', async () => {
    const fixture = createFixture();
    const candidate = (await fixture.controller.listWindows(profile.id))[0]!;
    await expect(
      fixture.controller.start({
        taskId: 'task-1',
        profileId: profile.id,
        windowId: candidate.windowId,
        mode: 'full_access_app',
        connectionId: profile.connectionId,
        modelId: profile.modelId,
        providerEgressConsent: true,
        providerEgressConsentBinding: {
          connectionId: 'different-connection',
          modelId: profile.modelId,
        },
        remember: false,
        expectedPolicyEpoch: 0,
        expectedWindowRevision: candidate.revision,
        expectedProfileRevision: profile.revision,
      }),
    ).rejects.toThrow('provider selection or consent changed');
  });

  it('rejects terminal, OS-settings, and remote-desktop application identities at registration', () => {
    const fixture = createFixture();
    for (const identity of [
      { ...appIdentity, bundleId: 'com.apple.Terminal', displayName: 'Terminal' },
      { ...appIdentity, bundleId: 'com.apple.systempreferences', displayName: 'System Settings' },
      { ...appIdentity, bundleId: 'com.teamviewer.TeamViewer', displayName: 'TeamViewer' },
      { ...appIdentity, bundleId: 'com.carriez.RustDesk', displayName: 'RustDesk' },
      { ...appIdentity, bundleId: 'com.parsecgaming.parsec', displayName: 'Parsec' },
    ])
      expect(() =>
        fixture.controller.registerProfile({
          label: identity.displayName,
          identity,
          mode: 'full_access_app',
          connectionId: profile.connectionId,
          modelId: profile.modelId,
          providerEgressConsent: false,
          remember: false,
        }),
      ).toThrow('cannot register');

    for (const identity of [
      { ...appIdentity, bundleId: 'com.microsoft.VSCode', displayName: 'Visual Studio Code' },
      { ...appIdentity, bundleId: 'com.apple.TextEdit', displayName: 'TextEdit' },
    ])
      expect(() =>
        fixture.controller.registerProfile({
          label: identity.displayName,
          identity,
          mode: 'full_access_app',
          connectionId: profile.connectionId,
          modelId: profile.modelId,
          providerEgressConsent: false,
          remember: false,
        }),
      ).not.toThrow();

    const windowsIdentity: ComputerAppIdentity = {
      platform: 'win32',
      identityDigest: '9'.repeat(64),
      executablePath: 'C:\\Program Files\\RustDesk\\rustdesk.exe',
      executableDigest: '8'.repeat(64),
      signerDigest: '7'.repeat(64),
      packageFamilyName: null,
      appUserModelId: null,
      displayName: 'RustDesk',
      policyLanguage: 'en',
      maximumMode: 'observe_only',
    };
    expect(() =>
      fixture.controller.registerProfile({
        label: windowsIdentity.displayName,
        identity: windowsIdentity,
        mode: 'full_access_app',
        connectionId: profile.connectionId,
        modelId: profile.modelId,
        providerEgressConsent: false,
        remember: false,
      }),
    ).toThrow('cannot register');
    expect(() =>
      fixture.controller.registerProfile({
        label: 'Notepad',
        identity: {
          ...windowsIdentity,
          identityDigest: '6'.repeat(64),
          executablePath: 'C:\\Windows\\System32\\notepad.exe',
          displayName: 'Notepad',
        },
        mode: 'full_access_app',
        connectionId: profile.connectionId,
        modelId: profile.modelId,
        providerEgressConsent: false,
        remember: false,
      }),
    ).not.toThrow();
  });

  it('downgrades full access when the target profile, window, or native session language is not attested', async () => {
    for (const options of [
      { profilePolicyLanguage: 'unknown' as const },
      { windowPolicyLanguage: 'unknown' as const },
      { sessionPolicyLanguage: 'unknown' as const },
      { windowPolicyLanguage: 'ja' as const },
    ]) {
      const fixture = createFixture(options);
      await expect(start(fixture, 'full_access_app')).resolves.toMatchObject({
        mode: 'supervised',
        policyLanguage: expect.any(String),
      });
      const status = fixture.statuses.at(-1);
      if (status !== undefined) await fixture.controller.stop(status.sessionId);
    }
  });

  it('binds app, candidate permit, relist, and native session maximumMode to least privilege', async () => {
    for (const options of [
      { profileMaximumMode: 'supervised' as const },
      { firstWindowMaximumMode: 'supervised' as const },
      { relistWindowMaximumMode: 'supervised' as const },
      { sessionMaximumMode: 'supervised' as const },
    ]) {
      const fixture = createFixture(options);
      await expect(start(fixture, 'full_access_app')).resolves.toMatchObject({
        mode: 'supervised',
        maximumMode: 'supervised',
      });
      const status = fixture.statuses.at(-1);
      if (status !== undefined) await fixture.controller.stop(status.sessionId);
    }
    const observeOnly = createFixture({ profileMaximumMode: 'observe_only' });
    await expect(start(observeOnly, 'full_access_app')).resolves.toMatchObject({
      mode: 'observe_only',
      maximumMode: 'observe_only',
    });
    const status = observeOnly.statuses.at(-1);
    if (status !== undefined) await observeOnly.controller.stop(status.sessionId);
  });

  it('revalidates policy language on every observation before a no-approval dispatch', async () => {
    const fixture = createFixture({ observationPolicyLanguage: 'unknown' });
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    expect(fixture.controller.getStatus(started.sessionId)).toMatchObject({ mode: 'supervised' });
    const pending = fixture.controller.act(started.sessionId, click, 'language-change');
    await viWait();
    expect(fixture.approvals.at(-1)?.allowedDecisions).toEqual(['allow_once', 'deny']);
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.resolveApproval({
      approvalId: fixture.approvals.at(-1)!.id,
      expectedRevision: fixture.approvals.at(-1)!.revision,
      decision: 'deny',
      challenge: fixture.approvals.at(-1)!.challenge,
    });
    await expect(pending).rejects.toThrow();
    await fixture.controller.stop(started.sessionId);
  });

  it('monotonically downgrades maximumMode on every observation before authorization', async () => {
    const fixture = createFixture({ observationMaximumMode: 'observe_only' });
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    expect(fixture.controller.getStatus(started.sessionId)).toMatchObject({
      mode: 'observe_only',
      maximumMode: 'observe_only',
    });
    await expect(
      fixture.controller.act(started.sessionId, click, 'maximum-changed'),
    ).rejects.toThrow('computer_observe_only');
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('downgrades a paused full-access session when resume cannot re-attest its language', async () => {
    const fixture = createFixture({
      visualActionBlocked: true,
      resumeSessionPolicyLanguage: 'unknown',
    });
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, click, 'pause-for-language-resume'),
    ).resolves.toMatchObject({ result: 'paused' });

    await expect(
      fixture.controller.start({
        taskId: started.taskId,
        resumeSessionId: started.sessionId,
        profileId: started.profileId,
        windowId: started.windowId,
        mode: 'full_access_app',
        connectionId: started.connectionId,
        modelId: started.modelId,
        providerEgressConsent: true,
        providerEgressConsentBinding: {
          connectionId: started.connectionId,
          modelId: started.modelId,
        },
        remember: false,
        expectedPolicyEpoch: started.policyEpoch,
        expectedWindowRevision: 1,
        expectedProfileRevision: started.profileRevision,
      }),
    ).resolves.toMatchObject({ mode: 'supervised', policyLanguage: 'unknown' });
    await fixture.controller.stop(started.sessionId);
  });

  it('cannot upgrade a paused session and accepts a lower native resume maximumMode', async () => {
    const fixture = createFixture({
      visualActionBlocked: true,
      resumeSessionMaximumMode: 'observe_only',
    });
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    await fixture.controller.act(started.sessionId, click, 'pause-for-maximum-resume');

    await expect(
      fixture.controller.start({
        taskId: started.taskId,
        resumeSessionId: started.sessionId,
        profileId: started.profileId,
        windowId: started.windowId,
        mode: started.mode,
        connectionId: started.connectionId,
        modelId: started.modelId,
        providerEgressConsent: true,
        providerEgressConsentBinding: {
          connectionId: started.connectionId,
          modelId: started.modelId,
        },
        remember: false,
        expectedPolicyEpoch: started.policyEpoch,
        expectedWindowRevision: 1,
        expectedProfileRevision: started.profileRevision,
      }),
    ).resolves.toMatchObject({ mode: 'observe_only', maximumMode: 'observe_only' });
    await fixture.controller.stop(started.sessionId);
  });

  it('reserves the single-session slot before asynchronous native startup completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({ startSessionGate: gate });
    const candidate = (await fixture.controller.listWindows(profile.id))[0]!;
    const input = {
      taskId: 'task-1',
      profileId: profile.id,
      windowId: candidate.windowId,
      mode: 'full_access_app' as const,
      connectionId: profile.connectionId,
      modelId: profile.modelId,
      providerEgressConsent: true,
      providerEgressConsentBinding: {
        connectionId: profile.connectionId,
        modelId: profile.modelId,
      },
      remember: false,
      expectedPolicyEpoch: 0,
      expectedWindowRevision: candidate.revision,
      expectedProfileRevision: profile.revision,
    };
    const first = fixture.controller.start(input);
    await expect(fixture.controller.start(input)).rejects.toThrow('Only one');
    release();
    const started = await first;
    await fixture.controller.stop(started.sessionId);
  });

  it('cancels an in-progress start when the selected Task changes before native attach', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({ revalidateWindowsGate: gate });
    const candidate = (await fixture.controller.listWindows(profile.id))[0]!;
    const pending = fixture.controller.start({
      taskId: 'task-1',
      profileId: profile.id,
      windowId: candidate.windowId,
      mode: 'full_access_app',
      connectionId: profile.connectionId,
      modelId: profile.modelId,
      providerEgressConsent: true,
      providerEgressConsentBinding: {
        connectionId: profile.connectionId,
        modelId: profile.modelId,
      },
      remember: false,
      expectedPolicyEpoch: 0,
      expectedWindowRevision: candidate.revision,
      expectedProfileRevision: profile.revision,
    });
    await Promise.resolve();
    await fixture.controller.stopOutsideTask('task-2');
    release();
    await expect(pending).rejects.toThrow();
    expect(fixture.nativeStartWindowIds()).toEqual([]);
  });

  it('lets full-access ordinary typing proceed one Unicode scalar at a time without approval', async () => {
    const fixture = createFixture();
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, plainType, 'raw-request-private'),
    ).resolves.toMatchObject({ result: 'completed' });
    expect(fixture.approvals).toHaveLength(0);
    expect(fixture.dispatchCount()).toBe(5);
    expect(fixture.dispatchedActions()).toEqual(
      [...'hello'].map((text) => ({ type: 'type', text })),
    );
    const durableAudit = JSON.stringify([...fixture.audits.values()]);
    expect(durableAudit).not.toContain('hello');
    expect(durableAudit).not.toContain(started.sessionId);
    expect(durableAudit).not.toContain('raw-request-private');
    expect([...fixture.audits.values()][0]).toMatchObject({
      appIdentityDigest: profile.identityDigest,
      clientWidth: 800,
      clientHeight: 600,
    });
    await fixture.controller.stop(started.sessionId);
  });

  it('stops a multi-scalar type as unknown_effect when its observation expires mid-action', async () => {
    let now = Date.now();
    const fixture = createFixture({
      now: () => now,
      observationOverrides: {
        observedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 100).toISOString(),
      },
      dispatch: async () => {
        now += 200;
        return { result: 'completed', reasonCode: null };
      },
    });
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, { type: 'type', text: 'ab' }, 'ttl-type'),
    ).resolves.toMatchObject({
      result: 'unknown_effect',
      reasonCode: 'stale_observation_mid_action',
    });
    expect(fixture.dispatchCount()).toBe(1);
    expect(fixture.controller.getStatus(started.sessionId)?.state).toBe('paused');
    await fixture.controller.stop(started.sessionId);
  });

  it('resumes the exact paused session through the start consent lane with a fresh observation', async () => {
    const fixture = createFixture({
      dispatch: async () => ({ result: 'paused', reasonCode: 'native_dialog_user_takeover' }),
    });
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, click, 'pause-before-resume'),
    ).resolves.toMatchObject({
      result: 'paused',
    });
    const resumed = await fixture.controller.start({
      resumeSessionId: started.sessionId,
      taskId: started.taskId,
      profileId: started.profileId,
      windowId: started.windowId,
      mode: started.mode,
      connectionId: started.connectionId,
      modelId: started.modelId,
      providerEgressConsent: true,
      providerEgressConsentBinding: {
        connectionId: started.connectionId,
        modelId: started.modelId,
      },
      remember: false,
      expectedPolicyEpoch: started.policyEpoch,
      expectedWindowRevision: 1,
      expectedProfileRevision: started.profileRevision,
    });
    expect(resumed).toMatchObject({ sessionId: started.sessionId, state: 'observing' });
    expect(fixture.nativeStartWindowIds()).toEqual(['window-1', 'window-1']);
    await fixture.controller.stop(started.sessionId);
  });

  it('keeps planner-proposed input side-effect free in observe-only mode', async () => {
    const fixture = createFixture({
      mode: 'observe_only',
      planner: { plan: async () => click },
    });
    const started = await start(fixture, 'observe_only');
    await viWait();
    await viWait();
    expect(fixture.controller.getStatus(started.sessionId)?.state).toBe('paused');
    expect(fixture.dispatchCount()).toBe(0);
    expect([...fixture.audits.values()]).toEqual([
      expect.objectContaining({ state: 'rejected', reasonCode: 'observe_only' }),
    ]);
    await fixture.controller.stop(started.sessionId);
  });

  it('keeps supplementary Unicode characters atomic for native type dispatch', async () => {
    const fixture = createFixture();
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, { type: 'type', text: 'A😀B' }),
    ).resolves.toMatchObject({ result: 'completed' });
    expect(fixture.dispatchedActions()).toEqual([
      { type: 'type', text: 'A' },
      { type: 'type', text: '😀' },
      { type: 'type', text: 'B' },
    ]);
    await fixture.controller.stop(started.sessionId);
  });

  it('records partial text as unknown_effect when a later scalar is rejected', async () => {
    let calls = 0;
    const fixture = createFixture({
      dispatch: async () =>
        ++calls === 1
          ? { result: 'completed', reasonCode: null }
          : { result: 'rejected', reasonCode: 'native_focus_changed' },
    });
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, { type: 'type', text: 'ab' }),
    ).resolves.toMatchObject({ result: 'unknown_effect', reasonCode: 'native_focus_changed' });
    expect([...fixture.audits.values()][0]?.state).toBe('unknown_effect');
    await fixture.controller.stop(started.sessionId);
  });

  it.each(['unknown_effect', 'rejected', 'paused'] as const)(
    'does not publish a resumable session after Stop and a late %s acknowledgement',
    async (result) => {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fixture = createFixture({
        dispatch: async () => {
          enter();
          await gate;
          return { result, reasonCode: 'native_ack_late' };
        },
      });
      const started = await start(fixture, 'full_access_app');
      await fixture.controller.observe(started.sessionId);
      const action = fixture.controller.act(started.sessionId, click);
      await entered;
      await fixture.controller.stop(started.sessionId, 'emergency_stop');
      release();
      await action;
      expect(fixture.controller.getStatus(started.sessionId)).toBeNull();
      expect(fixture.statuses.at(-1)?.state).toBe('stopped');
    },
  );

  it('sends no later type scalar and reports a confirmed partial effect after Stop', async () => {
    let enteredFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fixture = createFixture({
      dispatch: async () => {
        enteredFirst();
        await firstRelease;
        return { result: 'completed', reasonCode: null };
      },
    });
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    const acting = fixture.controller.act(started.sessionId, { type: 'type', text: 'abc' });
    await firstEntered;
    await fixture.controller.stop(started.sessionId, 'emergency_stop');
    releaseFirst();
    await expect(acting).resolves.toMatchObject({ result: 'unknown_effect' });
    expect(fixture.dispatchCount()).toBe(1);
    expect([...fixture.audits.values()]).toEqual([
      expect.objectContaining({ state: 'unknown_effect', reasonCode: 'native_ack_unknown' }),
    ]);
    expect(fixture.controller.getStatus(started.sessionId)).toBeNull();
  });

  it('allows all five ordinary in-scope semantic actions in full access without approval', async () => {
    const fixture = createFixture({
      observationOverrides: {
        targetSignatures: { button: 'a'.repeat(64), field: 'b'.repeat(64) },
      },
    });
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    const actions: ComputerUseAction[] = [
      { type: 'invoke', targetId: 'button', name: 'activate', arguments: {} },
      { type: 'set_text', targetId: 'field', text: 'ordinary text' },
      { type: 'select', targetId: 'button', value: 'option' },
      { type: 'toggle', targetId: 'button', value: true },
      { type: 'expand_collapse', targetId: 'button', expanded: true },
    ];
    for (const [index, action] of actions.entries())
      await expect(
        fixture.controller.act(started.sessionId, action, `ordinary-${index}`),
      ).resolves.toMatchObject({
        result: 'completed',
      });
    expect(fixture.approvals).toHaveLength(0);
    expect(fixture.dispatchCount()).toBe(5);
    await fixture.controller.stop(started.sessionId);
  });

  it('creates an ephemeral allow_plan grant only for an exact semantic target', async () => {
    const fixture = createFixture({
      mode: 'supervised',
      authorizationRequired: true,
      observationOverrides: {
        targetSignatures: { button: 'c'.repeat(64) },
        targetMetadata: { button: { secure: false, highImpact: false } },
      },
    });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const action: ComputerUseAction = {
      type: 'invoke',
      targetId: 'button',
      name: 'activate',
      arguments: {},
    };
    const pending = fixture.controller.act(started.sessionId, action, 'plan-first');
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending');
    expect(approval?.eligibleForPlan).toBe(true);
    await fixture.controller.resolveApproval({
      approvalId: approval!.id,
      expectedRevision: approval!.revision,
      decision: 'allow_plan',
      challenge: approval!.challenge,
    });
    await expect(pending).resolves.toMatchObject({ result: 'completed' });
    // A plan grant is useful across rounds only when a fresh observation still resolves the exact
    // same native target signature. It must not be tied forever to the approval-time revision.
    await fixture.controller.observe(started.sessionId, 'plan-refresh');
    await expect(
      fixture.controller.act(started.sessionId, action, 'plan-second'),
    ).resolves.toMatchObject({
      result: 'completed',
    });
    expect(fixture.controller.getStatus(started.sessionId)?.pendingApproval).toBeNull();
    await fixture.controller.stop(started.sessionId);
  });

  it('does not reuse an allow_plan grant for the same semantic target in a new dialog', async () => {
    const initialDialogBinding = {
      dialogSetRevision: 1,
      dialogSetDigest: '7'.repeat(64),
      activeWindowIdentityDigest: '6'.repeat(64),
      activeWindowKind: 'application' as const,
    };
    const fixture = createFixture({
      mode: 'supervised',
      authorizationRequired: true,
      observationOverrides: {
        targetSignatures: { button: 'c'.repeat(64) },
        targetMetadata: { button: { secure: false, highImpact: false } },
      },
      observationOverridesForRevision: (revision) =>
        revision < 3
          ? initialDialogBinding
          : {
              dialogSetRevision: 2,
              dialogSetDigest: '9'.repeat(64),
              activeWindowIdentityDigest: '8'.repeat(64),
              activeWindowKind: 'dialog' as const,
            },
    });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const action: ComputerUseAction = {
      type: 'invoke',
      targetId: 'button',
      name: 'activate',
      arguments: {},
    };
    const firstPending = fixture.controller.act(started.sessionId, action, 'dialog-plan-first');
    await viWait();
    const firstApproval = fixture.approvals.find(
      (value) => value.state === 'pending' && value.callId === 'dialog-plan-first',
    )!;
    await fixture.controller.resolveApproval({
      approvalId: firstApproval.id,
      expectedRevision: firstApproval.revision,
      decision: 'allow_plan',
      challenge: firstApproval.challenge,
    });
    await expect(firstPending).resolves.toMatchObject({ result: 'completed' });

    // The new dialog deliberately reuses the same target id and native target signature. The
    // dialog authority, rather than semantic resemblance, must force another approval.
    await fixture.controller.observe(started.sessionId, 'dialog-plan-new-observation');
    const secondPending = fixture.controller.act(started.sessionId, action, 'dialog-plan-second');
    await viWait();
    const secondApproval = fixture.approvals.find(
      (value) => value.state === 'pending' && value.callId === 'dialog-plan-second',
    );
    expect(secondApproval).toBeDefined();
    await fixture.controller.resolveApproval({
      approvalId: secondApproval!.id,
      expectedRevision: secondApproval!.revision,
      decision: 'deny',
      challenge: secondApproval!.challenge,
    });
    await expect(secondPending).rejects.toThrow();
    expect(fixture.dispatchCount()).toBe(1);
    await fixture.controller.stop(started.sessionId);
  });

  it('offers allow_plan for set_text but never for coordinate scroll', async () => {
    const fixture = createFixture({
      mode: 'supervised',
      authorizationRequired: true,
      observationOverrides: {
        targetSignatures: { field: 'c'.repeat(64) },
        targetMetadata: { field: { secure: false, highImpact: false } },
      },
    });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);

    const textPending = fixture.controller.act(
      started.sessionId,
      { type: 'set_text', targetId: 'field', text: 'safe text' },
      'plan-set-text',
    );
    await viWait();
    const textApproval = fixture.approvals.find(
      (approval) => approval.state === 'pending' && approval.callId === 'plan-set-text',
    )!;
    expect(textApproval.allowedDecisions).toContain('allow_plan');
    await fixture.controller.resolveApproval({
      approvalId: textApproval.id,
      expectedRevision: textApproval.revision,
      decision: 'deny',
      challenge: textApproval.challenge,
    });
    await expect(textPending).rejects.toThrow();

    const scrollPending = fixture.controller.act(
      started.sessionId,
      { type: 'scroll', x: 0.5, y: 0.5, deltaX: 0, deltaY: 100 },
      'plan-scroll',
    );
    await viWait();
    const scrollApproval = fixture.approvals.find(
      (approval) => approval.state === 'pending' && approval.callId === 'plan-scroll',
    )!;
    expect(scrollApproval.allowedDecisions).toEqual(['allow_once', 'deny']);
    await fixture.controller.resolveApproval({
      approvalId: scrollApproval.id,
      expectedRevision: scrollApproval.revision,
      decision: 'deny',
      challenge: scrollApproval.challenge,
    });
    await expect(scrollPending).rejects.toThrow();
    await fixture.controller.stop(started.sessionId);
  });

  it('does not reuse an allow_plan grant when semantic action arguments change', async () => {
    const fixture = createFixture({
      mode: 'supervised',
      authorizationRequired: true,
      observationOverrides: {
        targetSignatures: { button: 'c'.repeat(64) },
        targetMetadata: { button: { secure: false, highImpact: false } },
      },
    });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const first: ComputerUseAction = {
      type: 'select',
      targetId: 'button',
      value: 'safe-option',
    };
    const firstPending = fixture.controller.act(started.sessionId, first, 'plan-args-first');
    await viWait();
    const firstApproval = fixture.approvals.find((value) => value.state === 'pending');
    await fixture.controller.resolveApproval({
      approvalId: firstApproval!.id,
      expectedRevision: firstApproval!.revision,
      decision: 'allow_plan',
      challenge: firstApproval!.challenge,
    });
    await expect(firstPending).resolves.toMatchObject({ result: 'completed' });
    await fixture.controller.observe(started.sessionId, 'plan-args-refresh');

    const second: ComputerUseAction = { ...first, value: 'different-option' };
    const secondPending = fixture.controller.act(started.sessionId, second, 'plan-args-second');
    await viWait();
    const secondApproval = fixture.approvals.find(
      (value) => value.state === 'pending' && value.callId === 'plan-args-second',
    );
    expect(secondApproval).toBeDefined();
    await fixture.controller.resolveApproval({
      approvalId: secondApproval!.id,
      expectedRevision: secondApproval!.revision,
      decision: 'deny',
      challenge: secondApproval!.challenge,
    });
    await expect(secondPending).rejects.toThrow();
    expect(fixture.dispatchCount()).toBe(1);
    await fixture.controller.stop(started.sessionId);
  });

  it('never offers a plan or approval card for supervised hard-boundary semantic actions', async () => {
    for (const metadata of [
      { secure: true, highImpact: false },
      { secure: false, highImpact: true },
    ]) {
      const fixture = createFixture({
        mode: 'supervised',
        authorizationRequired: true,
        observationOverrides: {
          targetSignatures: { sink: 'e'.repeat(64) },
          targetMetadata: { sink: metadata },
        },
      });
      const started = await start(fixture, 'supervised');
      await fixture.controller.observe(started.sessionId);
      await expect(
        fixture.controller.act(
          started.sessionId,
          { type: 'invoke', targetId: 'sink', name: 'activate', arguments: {} },
          `hard-boundary-${metadata.secure ? 'secure' : 'impact'}`,
        ),
      ).resolves.toMatchObject({ result: 'paused', reasonCode: 'hard_boundary' });
      expect(fixture.approvals).toHaveLength(0);
      expect(fixture.statuses.some((status) => status.state === 'awaiting_approval')).toBe(false);
      expect(fixture.dispatchCount()).toBe(0);
      await fixture.controller.stop(started.sessionId);
    }
  });

  it('keeps ordinary actions card-free for any registered signed application in full access', async () => {
    const fixture = createFixture({
      bundleId: 'com.example.SignedEditor',
      observationOverrides: {
        targetSignatures: { button: 'a'.repeat(64) },
        targetMetadata: { button: { secure: false, highImpact: false } },
      },
    });
    const started = await start(fixture, 'full_access_app');
    await fixture.controller.observe(started.sessionId);
    const actions: ComputerUseAction[] = [
      { type: 'click', x: 0.2, y: 0.2, button: 'left' },
      { type: 'scroll', x: 0.2, y: 0.2, deltaX: 0, deltaY: 120 },
      { type: 'type', text: 'ordinary text' },
      { type: 'key', key: 'Enter' },
      { type: 'invoke', targetId: 'button', name: 'activate', arguments: {} },
    ];
    for (const [index, action] of actions.entries())
      await expect(
        fixture.controller.act(started.sessionId, action, `full-access-${index}`),
      ).resolves.toMatchObject({
        result: 'completed',
      });
    expect(fixture.approvals).toHaveLength(0);
    // `type` is intentionally split into one native dispatch per Unicode scalar.
    expect(fixture.dispatchCount()).toBeGreaterThanOrEqual(actions.length);
    await fixture.controller.stop(started.sessionId);
  });

  it('keeps control approval ephemeral and resolves it through the controller', async () => {
    const fixture = createFixture({ mode: 'supervised' });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const pending = fixture.controller.act(started.sessionId, click, 'action-1');
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending');
    expect(approval).toBeDefined();
    expect(fixture.controller.getStatus(started.sessionId)?.pendingApproval?.id).toBe(approval!.id);
    const status = await fixture.controller.resolveApproval({
      approvalId: approval!.id,
      expectedRevision: approval!.revision,
      decision: 'allow_once',
      challenge: approval!.challenge,
    });
    expect(status.pendingApproval).toBeNull();
    await expect(pending).resolves.toMatchObject({ result: 'completed' });
    expect(fixture.nativeStartWindowIds()).toEqual(['window-1', 'window-1']);
    await fixture.controller.stop(started.sessionId);
  });

  it('revalidates the provider permit after approval before native dispatch', async () => {
    const revalidate = vi.fn(async () => {
      throw new Error('catalog changed');
    });
    const fixture = createFixture({
      mode: 'supervised',
      planner: {
        plan: () => new Promise<ComputerUseAction>(() => undefined),
        revalidate,
      },
    });
    const started = await start(fixture, 'supervised');
    await viWait();
    const pending = fixture.controller.act(started.sessionId, click, 'provider-changed');
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending')!;
    await fixture.controller.resolveApproval({
      approvalId: approval.id,
      expectedRevision: approval.revision,
      decision: 'allow_once',
      challenge: approval.challenge,
    });
    await expect(pending).resolves.toMatchObject({
      result: 'rejected',
      reasonCode: 'provider_binding_changed',
    });
    expect(revalidate).toHaveBeenCalledOnce();
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('pauses without dispatch when an approved target cannot be safely refocused', async () => {
    const fixture = createFixture({ mode: 'supervised', failFocusRestore: true });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const pending = fixture.controller.act(started.sessionId, click, 'focus-lost');
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending');
    const status = await fixture.controller.resolveApproval({
      approvalId: approval!.id,
      expectedRevision: approval!.revision,
      decision: 'allow_once',
      challenge: approval!.challenge,
    });
    expect(status.state).toBe('paused');
    await expect(pending).rejects.toThrow();
    expect(fixture.dispatchCount()).toBe(0);
    expect([...fixture.audits.values()]).toEqual([
      expect.objectContaining({ state: 'rejected', reasonCode: 'authorization_denied' }),
    ]);
    await fixture.controller.stop(started.sessionId);
  });

  it('does not resurrect a focus restore that loses a race with emergency Stop', async () => {
    let release!: () => void;
    const focusGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({ mode: 'supervised', focusRestoreGate: focusGate });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const acting = fixture.controller.act(started.sessionId, click, 'focus-stop-race');
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending');
    const resolving = fixture.controller.resolveApproval({
      approvalId: approval!.id,
      expectedRevision: approval!.revision,
      decision: 'allow_once',
      challenge: approval!.challenge,
    });
    await Promise.resolve();
    await fixture.controller.stop(started.sessionId, 'emergency_stop');
    release();
    await expect(resolving).resolves.toMatchObject({ state: 'stopped' });
    await expect(acting).rejects.toThrow();
    expect(fixture.dispatchCount()).toBe(0);
    expect(fixture.controller.getStatus(started.sessionId)).toBeNull();
    expect(fixture.statuses.at(-1)?.state).toBe('stopped');
  });

  it('rejects an approved visual action when a fresh refocus observation changed', async () => {
    const fixture = createFixture({
      mode: 'supervised',
      changeVisualObservationOnApproval: true,
    });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const acting = fixture.controller.act(started.sessionId, click, 'changed-after-approval');
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending');
    const status = await fixture.controller.resolveApproval({
      approvalId: approval!.id,
      expectedRevision: approval!.revision,
      decision: 'allow_once',
      challenge: approval!.challenge,
    });
    expect(status.state).toBe('paused');
    await expect(acting).rejects.toThrow();
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('invalidates a pending approval when the same-owner dialog set changes', async () => {
    const fixture = createFixture({
      mode: 'supervised',
      changeDialogSetOnApproval: true,
      observationOverrides: {
        dialogSetRevision: 1,
        dialogSetDigest: '7'.repeat(64),
        activeWindowIdentityDigest: '6'.repeat(64),
        activeWindowKind: 'application',
      },
    });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const acting = fixture.controller.act(started.sessionId, click, 'dialog-changed');
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending')!;
    const status = await fixture.controller.resolveApproval({
      approvalId: approval.id,
      expectedRevision: approval.revision,
      decision: 'allow_once',
      challenge: approval.challenge,
    });
    expect(status.state).toBe('paused');
    await expect(acting).rejects.toThrow();
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('invalidates a pending approval after a dialog ABA even when final bindings match', async () => {
    const fixture = createFixture({
      mode: 'supervised',
      advanceDialogRevisionOnApproval: true,
      observationOverrides: {
        dialogSetRevision: 1,
        dialogSetDigest: '7'.repeat(64),
        activeWindowIdentityDigest: '6'.repeat(64),
        activeWindowKind: 'application',
      },
    });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const acting = fixture.controller.act(started.sessionId, click, 'dialog-aba');
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending')!;
    const status = await fixture.controller.resolveApproval({
      approvalId: approval.id,
      expectedRevision: approval.revision,
      decision: 'allow_once',
      challenge: approval.challenge,
    });
    expect(status.state).toBe('paused');
    await expect(acting).rejects.toThrow();
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('rejects approved typing when the focused control changes before approval dispatch', async () => {
    const fixture = createFixture({
      mode: 'supervised',
      authorizationRequired: true,
      changeFocusedElementOnApproval: true,
    });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const acting = fixture.controller.act(started.sessionId, plainType, 'focused-control-changed');
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending');
    const status = await fixture.controller.resolveApproval({
      approvalId: approval!.id,
      expectedRevision: approval!.revision,
      decision: 'allow_once',
      challenge: approval!.challenge,
    });
    expect(status.state).toBe('paused');
    await expect(acting).rejects.toThrow();
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('normalizes control and bidi characters in transient approval display fields', async () => {
    const fixture = createFixture({ mode: 'supervised' });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const pending = fixture.controller.act(
      started.sessionId,
      { type: 'set_text', targetId: 'field\u202e', text: 'line one\nline two' },
      'safe-preview',
    );
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending');
    expect(approval?.targetLabel).not.toContain('\u202e');
    expect(approval?.targetLabel).toContain('\\u202e');
    expect(approval?.preview).not.toContain('\n');
    await fixture.controller.resolveApproval({
      approvalId: approval!.id,
      expectedRevision: approval!.revision,
      decision: 'deny',
      challenge: approval!.challenge,
    });
    await expect(pending).rejects.toThrow();
    await fixture.controller.stop(started.sessionId);
  });

  it('keeps a planner session paused after the user denies a supervised action', async () => {
    const fixture = createFixture({
      mode: 'supervised',
      planner: { plan: async () => click },
    });
    const started = await start(fixture, 'supervised');
    await viWait();
    await viWait();
    const approval = fixture.approvals.find((value) => value.state === 'pending');
    expect(approval).toBeDefined();
    await fixture.controller.resolveApproval({
      approvalId: approval!.id,
      expectedRevision: approval!.revision,
      decision: 'deny',
      challenge: approval!.challenge,
    });
    await viWait();
    expect(fixture.controller.getStatus(started.sessionId)?.state).toBe('paused');
    expect(fixture.dispatchCount()).toBe(0);
    expect([...fixture.audits.values()]).toEqual([
      expect.objectContaining({ state: 'rejected', reasonCode: 'authorization_denied' }),
    ]);
    await fixture.controller.stop(started.sessionId);
  });

  it('classifies any post-dispatch exception as unknown_effect and never retries', async () => {
    const fixture = createFixture({
      dispatch: async () => {
        throw new Error('host crashed');
      },
    });
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, click, 'action-unknown'),
    ).resolves.toMatchObject({
      result: 'unknown_effect',
    });
    expect(fixture.controller.getStatus(started.sessionId)?.state).toBe('paused');
    expect(fixture.dispatchCount()).toBe(1);
    await expect(
      fixture.controller.act(started.sessionId, click, 'action-unknown'),
    ).resolves.toMatchObject({
      result: 'unknown_effect',
    });
    expect(fixture.dispatchCount()).toBe(1);
    await fixture.controller.stop(started.sessionId);
  });

  it('keeps a confirmed native completion and applied audit when Stop wins continuation', async () => {
    let activeSessionId = '';
    let stopPromise: Promise<void> | null = null;
    const fixture = createFixture({
      dispatch: async () => {
        queueMicrotask(() => {
          stopPromise = fixture.controller.stop(activeSessionId, 'emergency_stop');
        });
        return { result: 'completed', reasonCode: null };
      },
    });
    const started = await start(fixture);
    activeSessionId = started.sessionId;
    await fixture.controller.observe(started.sessionId);

    await expect(
      fixture.controller.act(started.sessionId, click, 'completed-before-stop'),
    ).resolves.toMatchObject({ result: 'completed' });
    expect([...fixture.audits.values()]).toEqual([
      expect.objectContaining({ state: 'applied', reasonCode: null }),
    ]);
    expect(stopPromise).not.toBeNull();
    await stopPromise;
    expect(fixture.controller.getStatus(started.sessionId)).toBeNull();
  });

  it('stops a synthetic session when a real Turn starts later', async () => {
    const fixture = createFixture();
    const started = await start(fixture);
    fixture.setActiveTurn('chat-turn');
    await expect(fixture.controller.observe(started.sessionId)).rejects.toThrow(
      'ownership changed',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.controller.getStatus(started.sessionId)).toBeNull();
  });

  it('stops on a policy epoch change before native dispatch', async () => {
    const fixture = createFixture();
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    fixture.setPolicyEpoch(1);
    await expect(
      fixture.controller.act(started.sessionId, click, 'policy-stale'),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.controller.getStatus(started.sessionId)).toBeNull();
    expect(fixture.dispatchCount()).toBe(0);
  });

  it('pauses secure focused typing without sending it to native input', async () => {
    const fixture = createFixture({
      observationOverrides: { focusedElementSecure: true },
    });
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, plainType, 'secure-type'),
    ).resolves.toMatchObject({
      result: 'paused',
    });
    expect(fixture.controller.getStatus(started.sessionId)?.state).toBe('paused');
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('never posts a visual action through the persistent Stop overlay rectangle', async () => {
    const fixture = createFixture({ visualActionBlocked: true });
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    await expect(
      fixture.controller.act(started.sessionId, click, 'overlay-click'),
    ).resolves.toMatchObject({ result: 'paused', reasonCode: 'stop_overlay_boundary' });
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('blocks every semantic action class bound to high-impact native metadata', async () => {
    const fixture = createFixture({
      observationOverrides: {
        targetSignatures: { sink: 'e'.repeat(64) },
        targetMetadata: { sink: { secure: false, highImpact: true } },
      },
    });
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    const actions: ComputerUseAction[] = [
      { type: 'invoke', targetId: 'sink', name: 'activate', arguments: {} },
      { type: 'set_text', targetId: 'sink', text: 'value' },
      { type: 'select', targetId: 'sink', value: 'choice' },
      { type: 'toggle', targetId: 'sink', value: true },
      { type: 'expand_collapse', targetId: 'sink', expanded: true },
    ];
    for (const [index, action] of actions.entries()) {
      await expect(
        fixture.controller.act(started.sessionId, action, `blocked-${index}`),
      ).resolves.toMatchObject({ result: 'paused' });
    }
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('rejects an observation that expires after planning but before dispatch', async () => {
    const observedAt = Date.now() - 1_000;
    const fixture = createFixture({
      observationOverrides: {
        observedAt: new Date(observedAt).toISOString(),
        expiresAt: new Date(Date.now() + 5).toISOString(),
      },
    });
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      fixture.controller.act(started.sessionId, click, 'stale-action'),
    ).resolves.toMatchObject({ result: 'rejected', reasonCode: 'stale_observation' });
    expect(fixture.dispatchCount()).toBe(0);
    await fixture.controller.stop(started.sessionId);
  });

  it('does not persist remembered profile settings when remember is false', async () => {
    const fixture = createFixture();
    const first = await start(fixture, 'supervised', false);
    expect(fixture.profileUpdates()).toBe(0);
    await fixture.controller.stop(first.sessionId);
    const second = await start(fixture, 'supervised', true, 1);
    expect(fixture.profileUpdates()).toBe(1);
    await fixture.controller.stop(second.sessionId);
  });

  it('cancels an in-memory approval and never dispatches after stop', async () => {
    const fixture = createFixture({ mode: 'supervised' });
    const started = await start(fixture, 'supervised');
    await fixture.controller.observe(started.sessionId);
    const pending = fixture.controller.act(started.sessionId, click, 'cancel-pending');
    await viWait();
    expect(fixture.controller.getStatus(started.sessionId)?.pendingApproval).not.toBeNull();
    await fixture.controller.stop(started.sessionId);
    await expect(pending).rejects.toThrow();
    expect(fixture.dispatchCount()).toBe(0);
    expect(fixture.statuses.slice(-2).map(({ state }) => state)).toEqual(['stopping', 'stopped']);
  });

  it('latches an emergency stop that races native session startup', async () => {
    const fixture = createFixture({
      armEmergencyStop: async (sessionId, controller) => {
        await controller.stop(sessionId, 'emergency_stop');
        return true;
      },
    });
    await expect(start(fixture)).rejects.toThrow('start canceled');
    expect(fixture.controller.getStatus('session-1')).toBeNull();
    expect(fixture.dispatchCount()).toBe(0);
  });

  it('repositions Stop after native start and every observation, then stops before action on failure', async () => {
    const repositions: Array<Readonly<{ x: number; y: number; width: number; height: number }>> =
      [];
    const fixture = createFixture({
      repositionEmergencyStop: (_sessionId, screenBounds) => {
        repositions.push(screenBounds);
        return repositions.length < 3;
      },
    });
    const started = await start(fixture);
    await fixture.controller.observe(started.sessionId);
    await expect(fixture.controller.observe(started.sessionId)).rejects.toThrow('Stop overlay');
    expect(repositions).toEqual([
      { x: 0, y: 0, width: 800, height: 600 },
      { x: 0, y: 0, width: 800, height: 600 },
      { x: 0, y: 0, width: 800, height: 600 },
    ]);
    expect(fixture.dispatchCount()).toBe(0);
    expect(fixture.statuses.at(-1)).toMatchObject({
      state: 'stopped',
      stopReason: 'emergency_stop',
    });
  });
});

async function viWait(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
