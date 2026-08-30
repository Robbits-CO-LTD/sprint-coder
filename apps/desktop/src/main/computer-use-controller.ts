import { createHash, randomUUID } from 'node:crypto';
import {
  bindComputerUsePolicyLanguage,
  bindComputerUseMaximumMode,
  computerAppProfileSchema,
  computerUseActionSchema,
  computerUseActionResultSchema,
  computerUseApprovalSchema,
  computerUseAvailabilitySchema,
  computerUseModeSchema,
  computerUseObservationSchema,
  computerUsePolicyLanguageSchema,
  computerUseSessionStatusSchema,
  computerUseWindowCandidateSchema,
  COMPUTER_USE_LIMITS,
  type ComputerAppIdentity,
  type ComputerAppProfile,
  type ComputerUseAction,
  type ComputerUseActionResult,
  type ComputerUseApproval,
  type ComputerUseAvailability,
  type ComputerUseMode,
  type ComputerUseObservation,
  type ComputerUsePolicyLanguage,
  type ComputerUseSessionStatus,
  type ComputerUseStopReason,
  type ComputerUseWindowCandidate,
  type ComputerUseApprovalResolveInput,
} from '@sprint-coder/contracts';
import {
  ComputerUseToolRegistry,
  createToolDefinition,
  createToolId,
  isPlanEligibleComputerUseAction,
  type ToolExecutionContext,
} from '@sprint-coder/domain';
import {
  ToolBroker as MainToolBroker,
  type ToolAuthorizationRequest,
  type ToolAuthorizationDecision,
  type ManagedToolLifecycleEvent,
} from './tool-broker';
import type {
  ComputerActionAuditRecord,
  ComputerAppProfileInput,
  ComputerAppProfileRecord,
  ComputerActionAuditState,
  PersistenceClient,
} from './persistence';
import {
  computerUseActionDigest,
  computerUseActionKind,
  computerUseActionRoute,
} from './computer-use-action';
import type {
  ComputerUsePlannerObservation,
  ComputerUsePlannerPort,
} from './computer-use-planner-port';
import { COMPUTER_USE_ACCESSIBILITY_POLICY_VERSION } from './computer-use-accessibility-tree';

const COMPUTER_OBSERVE_TOOL = createToolDefinition({
  toolId: createToolId({
    provider: 'builtin',
    namespace: 'computer',
    name: 'observe',
    version: '1',
  }),
  providerName: 'computer_observe',
  kind: 'computer',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  sideEffect: 'control',
  risk: 'low',
  requiredCapabilities: ['computer.observe'],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 10,
  workspaceBinding: { kind: 'none' },
  providerCompatibility: ['computer-controller'],
  parallelism: 'serial',
  // Two 8 MiB images can expand to ~21.4 MiB as base64 before ToolBroker validates the
  // canonical observation. Keep the broker envelope bounded while accepting every valid V1
  // observation plus its 512 KiB tree and JSON metadata.
  maxOutputBytes: 32 * 1024 * 1024,
  supportsCancellation: true,
});

const COMPUTER_ACT_TOOL = createToolDefinition({
  toolId: createToolId({ provider: 'builtin', namespace: 'computer', name: 'act', version: '1' }),
  providerName: 'computer_act',
  kind: 'computer',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      action: { type: 'object' },
      requestId: { type: 'string' },
    },
    required: ['sessionId', 'action'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  sideEffect: 'control',
  risk: 'high',
  requiredCapabilities: ['computer.control'],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 10,
  workspaceBinding: { kind: 'none' },
  providerCompatibility: ['computer-controller'],
  parallelism: 'serial',
  supportsCancellation: true,
});
const COMPUTER_USE_WINDOW_CANDIDATE_TTL_MS = 5 * 60_000;
const COMPUTER_USE_PLANNER_CANCEL_CLEANUP_TIMEOUT_MS = 1_000;
export const COMPUTER_USE_MAIN_POLICY_VERSION = 1 as const;

export type ComputerUseNativeWindow = ComputerUseWindowCandidate &
  Readonly<{
    platform: 'darwin' | 'win32';
    /** Fresh native-only executable bytes binding; never exposed over IPC. */
    executableDigest?: string | null;
    screenBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  }>;
export type ComputerUseNativeSession = Readonly<{
  sessionId: string;
  platform: 'darwin' | 'win32';
  appIdentityDigest: string;
  windowIdentityDigest: string;
  windowId: string;
  profileRevision: number;
  cancelEpoch: number;
  policyLanguage: ComputerUsePolicyLanguage;
  maximumMode: ComputerUseMode;
  screenBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
}>;
export type ComputerUseNativeObservation = ComputerUseObservation;
export type ComputerUseNativeActionResult = Readonly<{
  result: ComputerUseActionResult['result'];
  reasonCode: string | null;
}>;

/** Native host contract. It has no model, policy, provider, or persistence authority. */
export interface ComputerUseNativeHost {
  availability(): ComputerUseAvailability;
  pickApplication(
    input: Readonly<{
      activationToken: string;
      pickerKind: 'application' | 'window';
    }>,
  ): Promise<ComputerAppIdentity | null>;
  listWindows(profile: ComputerAppProfileRecord): Promise<readonly ComputerUseNativeWindow[]>;
  startSession(
    input: Readonly<{
      profile: ComputerAppProfileRecord;
      windowId: string;
      sessionId: string;
      taskId: string;
      turnId: string;
      cancelEpoch: number;
      resume?: boolean;
    }>,
  ): Promise<ComputerUseNativeSession>;
  observe(
    session: ComputerUseNativeSession,
    input: Readonly<{ requestId: string; cancelEpoch: number }>,
  ): Promise<ComputerUseNativeObservation>;
  dispatch(
    input: Readonly<{
      session: ComputerUseNativeSession;
      requestId: string;
      action: ComputerUseAction;
      observationRevision: number;
      cancelEpoch: number;
      signal: AbortSignal;
    }>,
  ): Promise<ComputerUseNativeActionResult>;
  cancel(session: ComputerUseNativeSession, cancelEpoch: number): Promise<void>;
  close(session: ComputerUseNativeSession): Promise<void>;
}

export type ComputerUseControllerPersistence = Pick<
  PersistenceClient,
  | 'listComputerAppProfiles'
  | 'getComputerAppProfile'
  | 'createComputerAppProfile'
  | 'updateComputerAppProfile'
  | 'removeComputerAppProfile'
  | 'recordComputerActionAudit'
  | 'completeComputerActionAudit'
  | 'listComputerActionAudits'
  | 'getActiveTurnId'
> &
  Readonly<{
    getPermissionPolicy(taskId: string): Readonly<{ policyEpoch: number }>;
  }>;

export type ComputerUseStartRequest = Readonly<{
  taskId: string;
  turnId?: string | undefined;
  resumeSessionId?: string | undefined;
  profileId: string;
  windowId: string;
  mode: ComputerUseMode;
  connectionId: string;
  modelId: string;
  providerEgressConsent: boolean;
  providerEgressConsentBinding: Readonly<{ connectionId: string; modelId: string }>;
  remember: boolean;
  expectedPolicyEpoch: number;
  expectedWindowRevision: number;
  expectedProfileRevision: number;
}>;

export type ComputerUseAuthorizationRequest = Readonly<{
  capability: 'computer.observe' | 'computer.control';
  context: ToolExecutionContext;
  callId: string;
  entry: ToolAuthorizationRequest['entry'];
  input: unknown;
  sessionId: string;
  action?: ComputerUseAction;
  mode: ComputerUseMode;
  observation: ComputerUseNativeObservation | null;
}>;
export type ComputerUseAuthorization =
  ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;

export type ComputerUseControllerDeps = Readonly<{
  persistence: ComputerUseControllerPersistence;
  native: ComputerUseNativeHost;
  planner?: ComputerUsePlannerPort;
  plannerFactory?: (
    input: Readonly<{
      taskId: string;
      turnId: string;
      sessionId: string;
      connectionId: string;
      modelId: string;
      mode: ComputerUseMode;
      policyEpoch: number;
      signal: AbortSignal;
    }>,
  ) => Promise<ComputerUsePlannerPort> | ComputerUsePlannerPort;
  featureEnabled?: () => boolean;
  now?: () => number;
  currentPolicyEpoch?: (taskId: string) => number;
  canStartSession?: (taskId: string) => boolean;
  authorize?: (request: ComputerUseAuthorizationRequest) => ComputerUseAuthorization;
  publishApproval?: (approval: unknown) => void;
  publishStatus?: (status: ComputerUseSessionStatus) => void;
  emergencyStopReady?: () => boolean;
  armEmergencyStop?: (
    sessionId: string,
    targetBounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  ) => boolean | Promise<boolean>;
  disarmEmergencyStop?: (sessionId: string) => void | Promise<void>;
  repositionEmergencyStop: (
    sessionId: string,
    screenBounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  ) => boolean | Promise<boolean>;
  visualActionBlocked?: (sessionId: string, action: ComputerUseAction) => boolean;
  lifecycle?: (event: ManagedToolLifecycleEvent) => void;
}>;

type SessionRecord = {
  status: ComputerUseSessionStatus;
  profile: ComputerAppProfileRecord;
  native: ComputerUseNativeSession;
  screenBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  controller: AbortController;
  turnId: string;
  syntheticTurn: boolean;
  observation: ComputerUseNativeObservation | null;
  planGrant: PlanGrant | null;
  plannerExecutionId: string | null;
  planner: ComputerUsePlannerPort | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  stopPromise: Promise<void> | null;
};
type PlanGrant = {
  actionType: ComputerUseAction['type'];
  actionDigest: string;
  targetId: string;
  targetSignature: string;
  windowIdentityDigest: string;
  dialogSetRevision: number;
  dialogSetDigest: string;
  activeWindowIdentityDigest: string;
  activeWindowKind: 'application' | 'dialog';
  remaining: number;
  expiresAt: number;
  observationRevision: number;
};
type PlanGrantAuthority = Pick<
  PlanGrant,
  | 'windowIdentityDigest'
  | 'dialogSetRevision'
  | 'dialogSetDigest'
  | 'activeWindowIdentityDigest'
  | 'activeWindowKind'
>;

function computerUsePlanGrantAuthority(
  observation: ComputerUseObservation | null,
): PlanGrantAuthority | null {
  if (
    observation === null ||
    observation.dialogSetRevision === undefined ||
    typeof observation.dialogSetDigest !== 'string' ||
    typeof observation.activeWindowIdentityDigest !== 'string' ||
    observation.activeWindowKind === undefined
  )
    return null;
  return {
    windowIdentityDigest: observation.windowIdentityDigest,
    dialogSetRevision: observation.dialogSetRevision,
    dialogSetDigest: observation.dialogSetDigest,
    activeWindowIdentityDigest: observation.activeWindowIdentityDigest,
    activeWindowKind: observation.activeWindowKind,
  };
}

function computerUsePlanGrantObservationMatches(
  grant: PlanGrant,
  observation: ComputerUseObservation | null,
): boolean {
  const authority = computerUsePlanGrantAuthority(observation);
  const metadata = observation?.targetMetadata?.[grant.targetId];
  return (
    authority !== null &&
    authority.windowIdentityDigest === grant.windowIdentityDigest &&
    authority.dialogSetRevision === grant.dialogSetRevision &&
    authority.dialogSetDigest === grant.dialogSetDigest &&
    authority.activeWindowIdentityDigest === grant.activeWindowIdentityDigest &&
    authority.activeWindowKind === grant.activeWindowKind &&
    observation?.targetSignatures?.[grant.targetId] === grant.targetSignature &&
    metadata !== undefined &&
    metadata.secure !== true &&
    metadata.highImpact !== true
  );
}
type PendingComputerApproval = {
  approval: ComputerUseApproval;
  action: ComputerUseAction;
  resolve: (decision: ToolAuthorizationDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};
type WindowCandidatePermit = Readonly<{
  profileId: string;
  profileRevision: number;
  native: ComputerUseNativeWindow;
  expiresAt: number;
}>;

export class ComputerUseController {
  private readonly broker: MainToolBroker;
  private readonly registry: ComputerUseToolRegistry;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<(status: ComputerUseSessionStatus) => void>();
  private readonly planGrantAuthorizedCalls = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingComputerApproval>();
  private readonly windowCandidatePermits = new Map<string, WindowCandidatePermit>();
  private readonly statusRevisionBySession = new Map<string, number>();
  private readonly startingSessions = new Map<
    string,
    {
      controller: AbortController;
      reason: ComputerUseStopReason | null;
      taskId: string;
    }
  >();
  private readonly now: () => number;
  private disposed = false;
  private startInProgress = false;
  private startingController: AbortController | null = null;
  private startingTaskId: string | null = null;

  constructor(private readonly deps: ComputerUseControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.registry = new ComputerUseToolRegistry();
    this.registry.register(COMPUTER_OBSERVE_TOOL);
    this.registry.register(COMPUTER_ACT_TOOL);
    this.broker = new MainToolBroker(
      this.registry,
      (taskId) => deps.currentPolicyEpoch?.(taskId) ?? 0,
      this.authorizeTool.bind(this),
      deps.lifecycle,
    );
    this.broker.registerImplementation({
      toolId: COMPUTER_OBSERVE_TOOL.toolId,
      implementationKind: 'built-in',
      execute: (input, context, control) => this.executeObserve(input, context, control.signal),
    });
    this.broker.registerImplementation({
      toolId: COMPUTER_ACT_TOOL.toolId,
      implementationKind: 'built-in',
      authorizationDenied: (input, context) => this.recordDeniedAction(input, context),
      execute: (input, context, control) => this.executeAction(input, context, control.signal),
    });
  }

  availability(): ComputerUseAvailability {
    const native = this.deps.native.availability();
    const featureEnabled = this.deps.featureEnabled?.() ?? false;
    const packageReady = native.packageReady;
    const handshakeReady = native.handshakeReady;
    const observe = featureEnabled && native.observe;
    const control = observe && native.control;
    const available = observe;
    const state = !featureEnabled
      ? 'feature_disabled'
      : !packageReady
        ? 'unsigned_package'
        : !handshakeReady
          ? 'handshake_failed'
          : !native.observe
            ? 'native_unavailable'
            : 'ready';
    return computerUseAvailabilitySchema.parse({
      ...native,
      featureEnabled,
      packageReady,
      handshakeReady,
      observe,
      control,
      available,
      state,
      reasonCode: available ? null : (native.reasonCode ?? state),
    });
  }

  listProfiles(): ComputerAppProfile[] {
    return this.deps.persistence.listComputerAppProfiles().map((profile) => publicProfile(profile));
  }

  registerProfile(
    input: Readonly<{
      profileId?: string;
      label: string;
      identity: ComputerAppIdentity;
      mode: ComputerUseMode;
      connectionId: string;
      modelId: string;
      providerEgressConsent: boolean;
      remember: boolean;
      expectedRevision?: number;
    }>,
  ): ComputerAppProfile {
    const identity = input.identity;
    if (computerUseAppIdentityIsDenied(identity))
      throw new Error('Computer Use cannot register this application class');
    const kind =
      identity.platform === 'darwin'
        ? ('macos-bundle' as const)
        : identity.packageFamilyName !== null || identity.appUserModelId !== null
          ? ('windows-package' as const)
          : ('win32-executable' as const);
    const profileInput: ComputerAppProfileInput = {
      id: input.profileId ?? randomUUID(),
      platform: identity.platform,
      kind,
      label: safeUntrustedDisplayText(input.label),
      canonicalPath: identity.executablePath,
      appUrl: null,
      identity: identity as unknown as Record<string, unknown>,
      identityDigest: identity.identityDigest,
      version: null,
      executableDigest: identity.executableDigest,
      mode: bindComputerUseMaximumMode(input.mode, identity.maximumMode),
      connectionId: input.connectionId,
      modelId: input.modelId,
      providerEgressConsent: input.providerEgressConsent,
      remember: input.remember,
    };
    const existing =
      input.profileId === undefined
        ? this.deps.persistence
            .listComputerAppProfiles()
            .find((profile) => profile.identityDigest === identity.identityDigest)
        : this.deps.persistence.getComputerAppProfile(input.profileId);
    const saved =
      existing === undefined
        ? this.deps.persistence.createComputerAppProfile(profileInput)
        : this.deps.persistence.updateComputerAppProfile(
            existing.id,
            input.expectedRevision ?? existing.revision,
            { ...profileInput, id: existing.id },
          );
    return publicProfile(saved);
  }

  async registerProfileFromActivation(
    input: Readonly<{
      activationToken: string;
      pickerKind: 'application' | 'window';
      preferences: Readonly<{
        profileId?: string;
        label: string;
        mode: ComputerUseMode;
        connectionId: string;
        modelId: string;
        providerEgressConsent: boolean;
        remember: boolean;
        expectedRevision?: number;
      }>;
    }>,
  ): Promise<ComputerAppProfile | null> {
    const identity = await this.deps.native.pickApplication({
      activationToken: input.activationToken,
      pickerKind: input.pickerKind,
    });
    if (identity === null) return null;
    return this.registerProfile({ ...input.preferences, identity });
  }

  async listWindows(profileId: string): Promise<ComputerUseWindowCandidate[]> {
    let profile = this.deps.persistence.getComputerAppProfile(profileId);
    for (const [token, permit] of this.windowCandidatePermits)
      if (permit.profileId === profileId) this.windowCandidatePermits.delete(token);
    const windows = await this.listNativeWindows(profile);
    profile = this.refreshSignedWindowsProfile(profile, windows);
    return windows.map((native) => {
      const token = randomUUID();
      this.windowCandidatePermits.set(
        token,
        Object.freeze({
          profileId,
          profileRevision: profile.revision,
          native,
          expiresAt: this.now() + COMPUTER_USE_WINDOW_CANDIDATE_TTL_MS,
        }),
      );
      const {
        platform: _platform,
        executableDigest: _executableDigest,
        windowId: _nativeWindowId,
        screenBounds: _screenBounds,
        ...candidate
      } = native;
      return computerUseWindowCandidateSchema.parse({
        ...candidate,
        windowId: token,
        title: safeUntrustedDisplayText(candidate.title),
      });
    });
  }

  private async listNativeWindows(
    profile: ComputerAppProfileRecord,
  ): Promise<ComputerUseNativeWindow[]> {
    const profileMaximumMode = maximumModeForProfile(profile);
    return (await this.deps.native.listWindows(profile))
      .filter((window) => window.appIdentityDigest === profile.identityDigest)
      .map((window) => ({
        ...window,
        maximumMode: bindComputerUseMaximumMode(profileMaximumMode, window.maximumMode),
      }));
  }

  private refreshSignedWindowsProfile(
    profile: ComputerAppProfileRecord,
    windows: readonly ComputerUseNativeWindow[],
  ): ComputerAppProfileRecord {
    if (profile.platform !== 'win32' || windows.length === 0) return profile;
    const executableDigests = new Set(
      windows.map(({ executableDigest }) =>
        typeof executableDigest === 'string' && /^[a-f0-9]{64}$/u.test(executableDigest)
          ? executableDigest
          : null,
      ),
    );
    if (executableDigests.has(null) || executableDigests.size !== 1)
      throw new Error('Computer Use app identity changed');
    const freshExecutableDigest = [...(executableDigests as Set<string>)][0]!;
    if (freshExecutableDigest === profile.executableDigest) return profile;
    const identity = profile.identity;
    if (
      typeof identity['signerDigest'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(identity['signerDigest']) ||
      identity['identityDigest'] !== profile.identityDigest ||
      identity['executablePath'] !== profile.canonicalPath ||
      identity['executableDigest'] !== profile.executableDigest
    )
      throw new Error('Computer Use app identity changed');
    return this.deps.persistence.updateComputerAppProfile(profile.id, profile.revision, {
      ...profile,
      identity: { ...identity, executableDigest: freshExecutableDigest },
      executableDigest: freshExecutableDigest,
    });
  }

  async start(input: ComputerUseStartRequest): Promise<ComputerUseSessionStatus> {
    if (this.disposed) throw new Error('Computer Use controller is disposed');
    if (input.resumeSessionId !== undefined) return this.resume(input);
    if (this.sessions.size !== 0 || this.startingSessions.size !== 0 || this.startInProgress)
      throw new Error('Only one Computer Use session is allowed');
    this.startInProgress = true;
    const controller = new AbortController();
    this.startingController = controller;
    this.startingTaskId = input.taskId;
    try {
      return await this.startInternal(input, controller);
    } catch (error) {
      if (!controller.signal.aborted)
        controller.abort(error instanceof Error ? error : new Error('Computer Use start failed'));
      throw error;
    } finally {
      if (this.startingController === controller) this.startingController = null;
      if (this.startingTaskId === input.taskId) this.startingTaskId = null;
      this.startInProgress = false;
    }
  }

  private async resume(input: ComputerUseStartRequest): Promise<ComputerUseSessionStatus> {
    const sessionId = input.resumeSessionId!;
    const record = this.sessions.get(sessionId);
    if (
      record === undefined ||
      this.sessions.size !== 1 ||
      this.startingSessions.size !== 0 ||
      this.startInProgress ||
      record.status.state !== 'paused'
    )
      throw new Error('Computer Use session is not resumable');
    if (
      input.taskId !== record.status.taskId ||
      input.profileId !== record.status.profileId ||
      input.windowId !== record.status.windowId ||
      input.mode !== record.status.mode ||
      input.connectionId !== record.status.connectionId ||
      input.modelId !== record.status.modelId ||
      input.expectedPolicyEpoch !== record.status.policyEpoch ||
      input.expectedProfileRevision !== record.status.profileRevision ||
      input.remember !== record.profile.remember ||
      input.providerEgressConsent !== true ||
      input.providerEgressConsentBinding.connectionId !== record.status.connectionId ||
      input.providerEgressConsentBinding.modelId !== record.status.modelId
    )
      throw new Error('Computer Use resume binding changed');
    const availability = this.availability();
    if (!availability.available || (record.status.mode !== 'observe_only' && !availability.control))
      throw new Error('Computer Use native boundary is unavailable');
    if (this.deps.canStartSession?.(record.status.taskId) === false)
      throw new Error('Computer Use requires an idle Task without active Team work');
    if (record.status.round >= COMPUTER_USE_LIMITS.maxRounds)
      throw new Error('Computer Use round limit was reached');
    this.assertSessionLive(record);
    const persistedProfile = this.deps.persistence.getComputerAppProfile(record.profile.id);
    if (
      persistedProfile.revision !== record.profile.revision ||
      persistedProfile.identityDigest !== record.profile.identityDigest
    )
      throw new Error('Computer Use app profile changed');

    record.status = this.status(
      record,
      'starting',
      null,
      record.status.observationRevision,
      record.status.round,
      null,
    );
    record.observation = null;
    record.planGrant = null;
    this.emit(record.status);
    try {
      await record.planner?.revalidate?.(record.controller.signal);
      this.assertSessionLive(record);
      const focused = await this.deps.native.startSession({
        profile: record.profile,
        windowId: record.native.windowId,
        sessionId: record.status.sessionId,
        taskId: record.status.taskId,
        turnId: record.turnId,
        cancelEpoch: record.native.cancelEpoch,
        resume: true,
      });
      if (
        focused.sessionId !== record.native.sessionId ||
        focused.appIdentityDigest !== record.native.appIdentityDigest ||
        focused.windowIdentityDigest !== record.native.windowIdentityDigest ||
        focused.windowId !== record.native.windowId ||
        focused.profileRevision !== record.native.profileRevision
      )
        throw new Error('Computer Use resume focus binding changed');
      if (record.controller.signal.aborted || this.sessions.get(sessionId) !== record) {
        await this.deps.native.cancel(focused, focused.cancelEpoch + 1).catch(() => undefined);
        await this.deps.native.close(focused).catch(() => undefined);
        throw new Error('Computer Use resume was canceled');
      }
      record.native = focused;
      this.revalidateNativeAttestation(
        record,
        focused.policyLanguage,
        focused.maximumMode,
        focused.screenBounds,
      );
      if (!(await this.repositionEmergencyStop(sessionId, focused.screenBounds))) {
        await this.stop(sessionId, 'emergency_stop');
        throw new Error('Computer Use Stop overlay could not follow the native target');
      }
      record.status = this.status(
        record,
        'observing',
        null,
        record.status.observationRevision,
        record.status.round,
        null,
      );
      this.emit(record.status);
      void this.run(record, record.status.round + 1).catch((error) => {
        if (!record.controller.signal.aborted) void this.stop(sessionId, 'error');
        return error;
      });
      return record.status;
    } catch (error) {
      if (!record.controller.signal.aborted && this.sessions.get(sessionId) === record) {
        record.status = this.status(
          record,
          'paused',
          null,
          record.status.observationRevision,
          record.status.round,
          null,
        );
        this.emit(record.status);
      }
      throw error;
    }
  }

  private async startInternal(
    input: ComputerUseStartRequest,
    controller: AbortController,
  ): Promise<ComputerUseSessionStatus> {
    const availability = this.availability();
    if (!availability.available) throw new Error('Computer Use native boundary is unavailable');
    if (this.deps.emergencyStopReady?.() === false)
      throw new Error('Computer Use emergency stop is unavailable');
    if (this.deps.canStartSession?.(input.taskId) === false)
      throw new Error('Computer Use requires an idle Task without active Team work');
    computerUseModeSchema.parse(input.mode);
    const profile = this.deps.persistence.getComputerAppProfile(input.profileId);
    if (computerUseAppIdentityIsDenied(profile.identity))
      throw new Error('Computer Use cannot target this application class');
    if (profile.revision !== input.expectedProfileRevision)
      throw new Error('Computer Use app profile is stale');
    const syntheticTurn = input.turnId === undefined;
    if (syntheticTurn && this.deps.persistence.getActiveTurnId(input.taskId) !== null)
      throw new Error('Computer Use synthetic session requires an idle Task');
    const remember = input.remember === true;
    const profileMaximumMode = maximumModeForProfile(profile);
    const selectedMode = bindComputerUseMaximumMode(input.mode, profileMaximumMode);
    const selectedProfile =
      remember &&
      (profile.mode !== selectedMode ||
        profile.connectionId !== input.connectionId ||
        profile.modelId !== input.modelId ||
        profile.providerEgressConsent !== input.providerEgressConsent ||
        profile.remember !== remember)
        ? this.deps.persistence.updateComputerAppProfile(
            profile.id,
            input.expectedProfileRevision,
            {
              ...profile,
              mode: selectedMode,
              connectionId: input.connectionId,
              modelId: input.modelId,
              providerEgressConsent: input.providerEgressConsent,
              remember,
            },
          )
        : {
            ...profile,
            mode: selectedMode,
            connectionId: input.connectionId,
            modelId: input.modelId,
            providerEgressConsent: input.providerEgressConsent,
            remember,
          };
    if (
      selectedProfile.connectionId !== input.connectionId ||
      selectedProfile.modelId !== input.modelId ||
      input.providerEgressConsentBinding.connectionId !== input.connectionId ||
      input.providerEgressConsentBinding.modelId !== input.modelId ||
      !selectedProfile.providerEgressConsent ||
      !input.providerEgressConsent
    )
      throw new Error('Computer Use provider selection or consent changed');
    const policyEpoch = this.currentPolicyEpoch(input.taskId);
    if (policyEpoch !== input.expectedPolicyEpoch)
      throw new Error('Computer Use policy epoch changed');
    const permit = this.windowCandidatePermits.get(input.windowId);
    this.windowCandidatePermits.delete(input.windowId);
    if (
      permit === undefined ||
      permit.profileId !== input.profileId ||
      permit.profileRevision !== profile.revision ||
      permit.native.revision !== input.expectedWindowRevision ||
      this.now() >= permit.expiresAt
    )
      throw new Error('Computer Use window candidate is stale');
    const candidates = await this.listNativeWindows(profile);
    controller.signal.throwIfAborted();
    if (this.disposed) throw new Error('Computer Use controller is disposed');
    const candidate = candidates.find(
      (window) =>
        window.windowId === permit.native.windowId &&
        window.appIdentityDigest === permit.native.appIdentityDigest &&
        window.windowIdentityDigest === permit.native.windowIdentityDigest &&
        window.revision === permit.native.revision &&
        window.eligible,
    );
    if (candidate === undefined) throw new Error('Computer Use window candidate is stale');
    const preflightPolicyLanguage = bindComputerUsePolicyLanguage(
      profilePolicyLanguage(selectedProfile),
      permit.native.policyLanguage,
      candidate.policyLanguage,
    );
    const preflightMaximumMode = bindComputerUseMaximumMode(
      profileMaximumMode,
      permit.native.maximumMode,
      candidate.maximumMode,
    );
    const preflightMode = effectiveComputerUseMode(
      selectedMode,
      availability.control,
      preflightPolicyLanguage,
      preflightMaximumMode,
    );
    const sessionId = randomUUID();
    const turnId = input.turnId ?? `computer-turn:${sessionId}`;
    const starting = {
      controller,
      reason: null as ComputerUseStopReason | null,
      taskId: input.taskId,
    };
    this.startingSessions.set(sessionId, starting);
    if (
      this.deps.armEmergencyStop !== undefined &&
      !(await this.deps.armEmergencyStop(sessionId, candidate.screenBounds))
    ) {
      this.startingSessions.delete(sessionId);
      throw new Error('Computer Use emergency stop could not be armed');
    }
    if (controller.signal.aborted) {
      this.startingSessions.delete(sessionId);
      await this.deps.disarmEmergencyStop?.(sessionId);
      throw new Error(`Computer Use start canceled: ${starting.reason ?? 'emergency_stop'}`);
    }
    let native: ComputerUseNativeSession;
    try {
      native = await this.deps.native.startSession({
        profile: selectedProfile,
        windowId: candidate.windowId,
        sessionId,
        taskId: input.taskId,
        turnId,
        cancelEpoch: 0,
      });
    } catch (error) {
      this.startingSessions.delete(sessionId);
      await this.deps.disarmEmergencyStop?.(sessionId);
      throw error;
    }
    if (controller.signal.aborted) {
      this.startingSessions.delete(sessionId);
      await this.deps.native.cancel(native, native.cancelEpoch + 1).catch(() => undefined);
      await this.deps.native.close(native).catch(() => undefined);
      await this.deps.disarmEmergencyStop?.(sessionId);
      throw new Error(`Computer Use start canceled: ${starting.reason ?? 'emergency_stop'}`);
    }
    try {
      this.assertStartBinding(input.taskId, policyEpoch);
    } catch (error) {
      this.startingSessions.delete(sessionId);
      await this.deps.native.cancel(native, native.cancelEpoch + 1).catch(() => undefined);
      await this.deps.native.close(native).catch(() => undefined);
      await this.deps.disarmEmergencyStop?.(sessionId);
      throw error;
    }
    if (
      native.sessionId !== sessionId ||
      native.appIdentityDigest !== selectedProfile.identityDigest ||
      native.windowIdentityDigest !== candidate.windowIdentityDigest ||
      native.windowId !== candidate.windowId ||
      native.profileRevision !== selectedProfile.revision
    ) {
      await this.deps.native.close(native).catch(() => undefined);
      await this.deps.disarmEmergencyStop?.(sessionId);
      this.startingSessions.delete(sessionId);
      throw new Error('Computer Use native session identity mismatch');
    }
    if (!(await this.repositionEmergencyStop(sessionId, native.screenBounds))) {
      await this.deps.native.cancel(native, native.cancelEpoch + 1).catch(() => undefined);
      await this.deps.native.close(native).catch(() => undefined);
      await this.deps.disarmEmergencyStop?.(sessionId);
      this.startingSessions.delete(sessionId);
      throw new Error('Computer Use Stop overlay could not follow the native target');
    }
    const policyLanguage = bindComputerUsePolicyLanguage(
      preflightPolicyLanguage,
      native.policyLanguage,
    );
    const maximumMode = bindComputerUseMaximumMode(preflightMaximumMode, native.maximumMode);
    const effectiveMode = effectiveComputerUseMode(
      preflightMode,
      availability.control,
      policyLanguage,
      maximumMode,
    );
    let planner: ComputerUsePlannerPort | null;
    try {
      planner =
        this.deps.plannerFactory === undefined
          ? (this.deps.planner ?? null)
          : await this.deps.plannerFactory({
              taskId: input.taskId,
              turnId,
              sessionId,
              connectionId: input.connectionId,
              modelId: input.modelId,
              mode: effectiveMode,
              policyEpoch,
              signal: controller.signal,
            });
      controller.signal.throwIfAborted();
      if (this.disposed) throw new Error('Computer Use controller is disposed');
      this.assertStartBinding(input.taskId, policyEpoch);
    } catch (error) {
      this.startingSessions.delete(sessionId);
      await this.deps.native.cancel(native, native.cancelEpoch + 1).catch(() => undefined);
      await this.deps.native.close(native).catch(() => undefined);
      await this.deps.disarmEmergencyStop?.(sessionId);
      throw error;
    }
    const startedAt = new Date(this.now()).toISOString();
    const status = computerUseSessionStatusSchema.parse({
      sessionId,
      taskId: input.taskId,
      profileId: selectedProfile.id,
      windowId: input.windowId,
      connectionId: input.connectionId,
      modelId: input.modelId,
      appIdentityDigest: selectedProfile.identityDigest,
      windowIdentityDigest: candidate.windowIdentityDigest,
      mode: effectiveMode,
      maximumMode,
      policyLanguage,
      state: 'starting',
      statusRevision: 0,
      policyEpoch,
      observationRevision: 0,
      round: 0,
      maxRounds: COMPUTER_USE_LIMITS.maxRounds,
      profileRevision: selectedProfile.revision,
      startedAt,
      expiresAt: new Date(
        this.now() + COMPUTER_USE_LIMITS.maxSessionHours * 60 * 60 * 1_000 - 1_000,
      ).toISOString(),
      lastObservationAt: null,
      stopReason: null,
      pendingApproval: null,
    });
    const record: SessionRecord = {
      status,
      profile: selectedProfile,
      native,
      screenBounds: native.screenBounds,
      controller,
      turnId,
      syntheticTurn,
      observation: null,
      planGrant: null,
      plannerExecutionId: null,
      planner,
      expiryTimer: null,
      stopPromise: null,
    };
    this.sessions.set(sessionId, record);
    this.startingSessions.delete(sessionId);
    record.expiryTimer = setTimeout(
      () => void this.stop(sessionId, 'limit_reached'),
      Math.max(1, Date.parse(status.expiresAt) - this.now()),
    );
    record.expiryTimer.unref?.();
    try {
      this.broker.startTurn(
        {
          taskId: input.taskId,
          turnId,
          workspaceId: null,
          policyEpoch,
        },
        'computer-controller',
        [COMPUTER_OBSERVE_TOOL.toolId, COMPUTER_ACT_TOOL.toolId],
      );
    } catch (error) {
      this.sessions.delete(sessionId);
      if (record.expiryTimer !== null) clearTimeout(record.expiryTimer);
      record.expiryTimer = null;
      controller.abort();
      await this.deps.native.close(native).catch(() => undefined);
      await this.deps.disarmEmergencyStop?.(sessionId);
      throw error;
    }
    this.emit(status);
    void this.run(record).catch((error) => {
      if (!controller.signal.aborted) void this.stop(sessionId, 'error');
      return error;
    });
    return status;
  }

  async act(
    sessionId: string,
    action: ComputerUseAction,
    requestId: string = randomUUID(),
  ): Promise<ComputerUseActionResult> {
    const record = this.requireSession(sessionId);
    const parsed = computerUseActionSchema.parse(action);
    if (this.currentPolicyEpoch(record.status.taskId) !== record.status.policyEpoch) {
      void this.stop(sessionId, 'policy_changed');
      throw new Error('Computer Use policy epoch changed');
    }
    if (
      (record.syntheticTurn &&
        this.deps.persistence.getActiveTurnId(record.status.taskId) !== null) ||
      (!record.syntheticTurn &&
        this.deps.persistence.getActiveTurnId(record.status.taskId) !== record.turnId)
    ) {
      void this.stop(sessionId, 'turn_started');
      throw new Error('Computer Use Turn ownership changed');
    }
    const actionDigest = computerUseActionDigest(parsed);
    const sessionBinding = computerUseAuditBindingDigest(sessionId);
    const requestBinding = computerUseAuditBindingDigest(requestId);
    const existing = this.deps.persistence
      .listComputerActionAudits(record.status.taskId, 500)
      .find(
        (audit) => audit.sessionId === sessionBinding && audit.nativeRequestId === requestBinding,
      );
    if (existing !== undefined) {
      if (existing.actionDigest !== actionDigest)
        throw new Error('Computer Use request id was reused for another action');
      if (existing.state === 'pending') {
        const quarantined = this.deps.persistence.completeComputerActionAudit({
          auditId: existing.id,
          state: 'unknown_effect',
          reasonCode: 'duplicate_pending',
          updatedAt: new Date(this.now()).toISOString(),
        });
        return actionResultFromAudit(quarantined, sessionId, requestId);
      }
      return actionResultFromAudit(existing, sessionId, requestId);
    }
    return (await this.broker.dispatch({
      taskId: record.status.taskId,
      turnId: record.turnId,
      callId: requestId,
      providerName: COMPUTER_ACT_TOOL.providerName,
      input: { sessionId, action: parsed, requestId },
      signal: record.controller.signal,
    })) as ComputerUseActionResult;
  }

  async observe(
    sessionId: string,
    requestId: string = randomUUID(),
  ): Promise<ComputerUseNativeObservation> {
    const record = this.requireSession(sessionId);
    const observation = (await this.broker.dispatch({
      taskId: record.status.taskId,
      turnId: record.turnId,
      callId: requestId,
      providerName: COMPUTER_OBSERVE_TOOL.providerName,
      input: { sessionId },
      signal: record.controller.signal,
    })) as ComputerUseNativeObservation;
    record.observation = stripComputerUseObservationPayload(observation);
    record.status = this.status(
      record,
      'observing',
      null,
      observation.revision,
      record.status.round,
    );
    this.emit(record.status);
    return observation;
  }

  stop(sessionId: string, reason: ComputerUseStopReason = 'user_stop'): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      const starting = this.startingSessions.get(sessionId);
      if (starting !== undefined) {
        starting.reason = reason;
        starting.controller.abort(new Error(`Computer Use stopped while starting: ${reason}`));
      }
      return Promise.resolve();
    }
    if (record.stopPromise !== null) return record.stopPromise;
    let resolveStop!: () => void;
    let rejectStop!: (reason?: unknown) => void;
    const stopPromise = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    // Publish the session-owned completion before any status listener can re-enter stop(). Every
    // UI, emergency, reload, and shutdown caller then waits for the same native cancel + close.
    record.stopPromise = stopPromise;
    void this.completeStop(record, reason).then(resolveStop, rejectStop);
    return stopPromise;
  }

  private async completeStop(record: SessionRecord, reason: ComputerUseStopReason): Promise<void> {
    const sessionId = record.status.sessionId;
    if (record.expiryTimer !== null) {
      clearTimeout(record.expiryTimer);
      record.expiryTimer = null;
    }
    record.status = this.status(record, 'stopping', reason === 'error' ? null : reason);
    this.emit(record.status);
    record.controller.abort(new Error(`Computer Use stopped: ${reason}`));
    record.observation = null;
    this.cancelPendingApprovals(sessionId, 'computer_session_ended');
    try {
      await this.deps.native.cancel(record.native, record.native.cancelEpoch + 1);
    } catch {
      // Stop remains fail-closed even when native acknowledgement is unavailable.
    }
    await this.deps.native.close(record.native).catch(() => undefined);
    if (record.planner !== null && record.plannerExecutionId !== null) {
      const planner = record.planner;
      const executionId = record.plannerExecutionId;
      record.plannerExecutionId = null;
      runBoundedComputerUseCleanup(
        () => planner.cancel?.(executionId),
        COMPUTER_USE_PLANNER_CANCEL_CLEANUP_TIMEOUT_MS,
      );
    }
    this.broker.finishTurn(record.status.taskId, record.turnId);
    await Promise.resolve(this.deps.disarmEmergencyStop?.(sessionId)).catch(() => undefined);
    record.status = this.status(record, 'stopped', reason);
    this.emit(record.status);
    this.sessions.delete(sessionId);
    this.statusRevisionBySession.delete(sessionId);
  }

  async stopForTask(
    taskId: string,
    reason: Extract<ComputerUseStopReason, 'task_changed' | 'turn_started'>,
  ): Promise<void> {
    if (this.startingTaskId === taskId && this.startingController !== null)
      this.startingController.abort(new Error(`Computer Use stopped while starting: ${reason}`));
    for (const starting of this.startingSessions.values()) {
      if (starting.taskId !== taskId) continue;
      starting.reason = reason;
      starting.controller.abort(new Error(`Computer Use stopped while starting: ${reason}`));
    }
    await Promise.all(
      [...this.sessions.values()]
        .filter((record) => record.status.taskId === taskId)
        .map((record) => this.stop(record.status.sessionId, reason)),
    );
  }

  async stopOutsideTask(selectedTaskId: string): Promise<void> {
    if (this.startingTaskId !== null && this.startingTaskId !== selectedTaskId)
      this.startingController?.abort(new Error('Computer Use Task selection changed'));
    for (const starting of this.startingSessions.values()) {
      if (starting.taskId === selectedTaskId) continue;
      starting.reason = 'task_changed';
      starting.controller.abort(new Error('Computer Use Task selection changed'));
    }
    await Promise.all(
      [...this.sessions.values()]
        .filter((record) => record.status.taskId !== selectedTaskId)
        .map((record) => this.stop(record.status.sessionId, 'task_changed')),
    );
  }

  async resolveApproval(input: ComputerUseApprovalResolveInput): Promise<ComputerUseSessionStatus> {
    const pending = this.pendingApprovals.get(input.approvalId);
    if (pending === undefined) throw new Error('Computer Use approval not found');
    if (
      pending.approval.revision !== input.expectedRevision ||
      pending.approval.challenge !== input.challenge ||
      pending.approval.state !== 'pending'
    )
      throw new Error('Computer Use approval is stale');
    const record = this.sessions.get(pending.approval.sessionId);
    if (record === undefined) throw new Error('Computer Use session is no longer active');
    const decision = input.decision;
    if (!pending.approval.allowedDecisions.includes(decision))
      throw new Error('Computer Use approval decision is not allowed');
    if (decision === 'allow_plan' && !pending.approval.eligibleForPlan)
      throw new Error('Computer Use approval cannot create a plan grant');
    const next = computerUseApprovalSchema.parse({
      ...pending.approval,
      state: 'resolved',
      decision,
      revision: pending.approval.revision + 1,
      decidedAt: new Date(this.now()).toISOString(),
    });
    this.pendingApprovals.delete(input.approvalId);
    clearTimeout(pending.timer);
    this.deps.publishApproval?.(next);
    let approved = decision !== 'deny';
    let focusedSession: ComputerUseNativeSession | null = null;
    if (approved) {
      try {
        this.assertSessionLive(record);
        if (!this.observationIsFresh(record))
          throw new Error('Computer Use approval observation expired');
        focusedSession = await this.deps.native.startSession({
          profile: record.profile,
          windowId: record.native.windowId,
          sessionId: record.status.sessionId,
          taskId: record.status.taskId,
          turnId: record.turnId,
          cancelEpoch: record.native.cancelEpoch,
        });
        if (
          focusedSession.sessionId !== record.native.sessionId ||
          focusedSession.appIdentityDigest !== record.native.appIdentityDigest ||
          focusedSession.windowIdentityDigest !== record.native.windowIdentityDigest ||
          focusedSession.windowId !== record.native.windowId ||
          focusedSession.profileRevision !== record.native.profileRevision ||
          record.controller.signal.aborted ||
          this.sessions.get(record.status.sessionId) !== record
        )
          throw new Error('Computer Use approval focus binding changed');
        record.native = focusedSession;
        this.revalidateNativeAttestation(
          record,
          focusedSession.policyLanguage,
          focusedSession.maximumMode,
          focusedSession.screenBounds,
        );
        if (
          !(await this.repositionEmergencyStop(
            record.status.sessionId,
            focusedSession.screenBounds,
          ))
        ) {
          await this.stop(record.status.sessionId, 'emergency_stop');
          throw new Error('Computer Use Stop overlay could not follow the native target');
        }
        const previousObservation = record.observation;
        if (previousObservation === null)
          throw new Error('Computer Use approval observation is unavailable');
        const freshObservation = await this.acceptNativeObservation(
          record,
          await this.deps.native.observe(record.native, {
            requestId: `${record.status.sessionId}:approval:${randomUUID()}`,
            cancelEpoch: record.native.cancelEpoch,
          }),
        );
        if (
          !approvedObservationEquivalent(
            previousObservation,
            freshObservation,
            pending.action,
            this.now(),
          )
        )
          throw new Error('Computer Use approval observation changed');
        record.observation = stripComputerUseObservationPayload(freshObservation);
      } catch {
        approved = false;
      }
    }
    if (
      focusedSession !== null &&
      (record.controller.signal.aborted || this.sessions.get(record.status.sessionId) !== record)
    ) {
      await this.deps.native
        .cancel(focusedSession, focusedSession.cancelEpoch + 1)
        .catch(() => undefined);
      await this.deps.native.close(focusedSession).catch(() => undefined);
    }
    if (record.controller.signal.aborted || this.sessions.get(record.status.sessionId) !== record) {
      pending.resolve({ decision: 'deny', reason: 'computer_session_ended' });
      return record.status;
    }
    if (approved && decision === 'allow_plan') this.installPlanGrant(record, pending.action);
    record.status = this.status(
      record,
      approved ? 'acting' : 'paused',
      null,
      record.observation?.revision ?? record.status.observationRevision,
      record.status.round,
      null,
    );
    this.emit(record.status);
    pending.resolve(
      !approved
        ? {
            decision: 'deny',
            reason:
              decision === 'deny'
                ? 'computer_approval_deny'
                : 'computer_approval_focus_restore_failed',
          }
        : {
            decision: 'allow',
            reason: `computer_approval_${decision}`,
            approvalDecision: 'allow_once',
          },
    );
    // The current ToolAuthorizationDecision predates the computer plan decision. The controller
    // records the stronger decision in its plan state while the Broker receives allow_once.
    return record.status;
  }

  private cancelPendingApprovals(sessionId: string, reason: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.approval.sessionId !== sessionId) continue;
      this.pendingApprovals.delete(id);
      clearTimeout(pending.timer);
      const canceled = computerUseApprovalSchema.parse({
        ...pending.approval,
        state: 'canceled',
        decision: null,
        revision: pending.approval.revision + 1,
      });
      this.deps.publishApproval?.(canceled);
      pending.resolve({ decision: 'deny', reason });
    }
  }

  getStatus(sessionId: string): ComputerUseSessionStatus | null {
    return this.sessions.get(sessionId)?.status ?? null;
  }

  subscribe(listener: (status: ComputerUseSessionStatus) => void): () => void {
    this.listeners.add(listener);
    for (const session of this.sessions.values()) listener(session.status);
    return () => this.listeners.delete(listener);
  }

  turnEnded(taskId: string, turnId: string): void {
    for (const session of this.sessions.values())
      if (session.status.taskId === taskId && session.turnId === turnId)
        void this.stop(session.status.sessionId, 'turn_started');
  }

  policyEpochChanged(taskId: string): void {
    if (this.startingTaskId === taskId)
      this.startingController?.abort(new Error('Computer Use policy changed while starting'));
    for (const starting of this.startingSessions.values())
      if (starting.taskId === taskId) {
        starting.reason = 'policy_changed';
        starting.controller.abort(new Error('Computer Use policy changed while starting'));
      }
    for (const session of this.sessions.values())
      if (session.status.taskId === taskId)
        void this.stop(session.status.sessionId, 'policy_changed');
  }

  async rendererInvalidated(): Promise<void> {
    this.startingController?.abort(new Error('Computer Use renderer was reloaded'));
    for (const starting of this.startingSessions.values()) {
      starting.reason = 'renderer_reloaded';
      starting.controller.abort(new Error('Computer Use renderer was reloaded'));
    }
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) => this.stop(sessionId, 'renderer_reloaded')),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.startingController?.abort(new Error('Computer Use disposed while starting'));
    for (const [sessionId, starting] of this.startingSessions) {
      starting.reason = 'app_closed';
      starting.controller.abort(new Error('Computer Use disposed while starting'));
      this.startingSessions.delete(sessionId);
    }
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) => this.stop(sessionId, 'app_closed')),
    );
    await this.broker.dispose();
    this.listeners.clear();
    this.statusRevisionBySession.clear();
    this.windowCandidatePermits.clear();
  }

  private async run(record: SessionRecord, firstRound = 1): Promise<void> {
    const sessionId = record.status.sessionId;
    record.status = this.status(record, 'observing', null);
    this.emit(record.status);
    if (record.planner === null) return;
    for (let round = firstRound; round <= COMPUTER_USE_LIMITS.maxRounds; round += 1) {
      this.assertSessionLive(record);
      let observation: ComputerUseNativeObservation;
      try {
        observation = (await this.broker.dispatch({
          taskId: record.status.taskId,
          turnId: record.turnId,
          callId: `${sessionId}:observe:${round}`,
          providerName: COMPUTER_OBSERVE_TOOL.providerName,
          input: { sessionId },
          signal: record.controller.signal,
        })) as ComputerUseNativeObservation;
      } catch (error) {
        if (!computerUseNativeUserTakeover(error)) throw error;
        record.observation = null;
        record.planGrant = null;
        record.status = this.status(
          record,
          'paused',
          null,
          record.status.observationRevision,
          Math.max(record.status.round, round - 1),
          null,
        );
        this.emit(record.status);
        return;
      }
      record.observation = stripComputerUseObservationPayload(observation);
      record.status = this.status(record, 'planning', null, observation.revision, round);
      this.emit(record.status);
      const plannerObservation: ComputerUsePlannerObservation = observation;
      record.plannerExecutionId = `computer:${sessionId}:${observation.revision}:${round}`;
      const action = await record.planner.plan({
        observation: plannerObservation,
        round,
        signal: record.controller.signal,
      });
      this.assertSessionLive(record);
      if (!this.observationIsFresh(record)) continue;
      if (action.type === 'finish') {
        await this.stop(sessionId, 'user_stop');
        return;
      }
      if (record.status.mode === 'observe_only' && action.type !== 'wait') {
        this.completeNonNativeAction(
          record,
          action,
          `${sessionId}:action:${round}`,
          'rejected',
          'observe_only',
        );
        record.status = this.status(record, 'paused', null, observation.revision, round, null);
        this.emit(record.status);
        return;
      }
      if (this.actionMayNeedApproval(record, action)) {
        record.status = this.status(record, 'awaiting_approval', null, observation.revision, round);
        this.emit(record.status);
      }
      try {
        await this.act(sessionId, action, `${sessionId}:action:${round}`);
      } catch (error) {
        if (record.status.state === 'paused' || record.controller.signal.aborted) return;
        throw error;
      }
      if (action.type === 'wait') await waitBounded(action.milliseconds, record.controller.signal);
      if (record.status.state === 'paused') return;
    }
    await this.stop(sessionId, 'limit_reached');
  }

  private async authorizeTool(
    request: ToolAuthorizationRequest,
  ): Promise<ToolAuthorizationDecision> {
    const sessionId =
      typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input)
        ? (request.input as Record<string, unknown>)['sessionId']
        : undefined;
    if (typeof sessionId !== 'string')
      return { decision: 'deny', reason: 'computer_session_missing' };
    const record = this.sessions.get(sessionId);
    if (record === undefined) return { decision: 'deny', reason: 'computer_session_missing' };
    const action =
      request.entry.providerName === COMPUTER_ACT_TOOL.providerName
        ? computerUseActionSchema.safeParse((request.input as Record<string, unknown>)['action'])
        : null;
    if (action !== null && !action.success)
      return { decision: 'deny', reason: 'computer_action_invalid' };
    const capability = request.entry.requiredCapabilities[0];
    if (capability !== 'computer.observe' && capability !== 'computer.control')
      return { decision: 'deny', reason: 'computer_capability_invalid' };
    if (capability === 'computer.control')
      this.revalidateNativeAttestation(
        record,
        record.observation?.policyLanguage ?? 'unknown',
        record.observation?.maximumMode ?? record.native.maximumMode,
        record.observation?.screenBounds ?? record.native.screenBounds,
      );
    // wait/finish never call the native input executor. They remain valid in observe-only mode
    // even though they share the action schema and ToolBroker entry with controlled actions.
    if (action?.success && (action.data.type === 'wait' || action.data.type === 'finish'))
      return { decision: 'allow', reason: 'computer_non_input_action' };
    if (capability === 'computer.control' && record.status.mode === 'observe_only')
      return { decision: 'deny', reason: 'computer_observe_only' };
    const result = this.deps.authorize?.({
      capability,
      context: request.context,
      callId: request.callId,
      entry: request.entry,
      input: request.input,
      sessionId,
      ...(action?.success ? { action: action.data } : {}),
      mode: record.status.mode,
      observation: record.observation,
    });
    if (result !== undefined) {
      let authorized = await result;
      if (authorized.decision === 'approval_required' && action?.success) {
        if (this.isHardBoundary(action.data, record.observation))
          return this.userTakeover(record, 'computer_hard_boundary_user_takeover');
        if (this.planGrantMatches(record, action.data)) {
          this.planGrantAuthorizedCalls.add(`${sessionId}\0${request.callId}`);
          authorized = { decision: 'allow', reason: 'computer_bounded_plan_grant' };
        } else if (record.status.mode !== 'full_access_app') {
          authorized = await this.awaitApproval(record, request.callId, action.data);
        }
      }
      const approvalDecision = authorized.approvalDecision as string | undefined;
      if (
        approvalDecision === 'allow_task' ||
        (approvalDecision !== undefined &&
          approvalDecision !== 'allow_once' &&
          approvalDecision !== 'allow_plan')
      )
        return { decision: 'deny', reason: 'computer_task_grant_forbidden' };
      if (
        authorized.decision === 'approval_required' &&
        record.status.mode === 'full_access_app' &&
        action?.success &&
        !this.isHardBoundary(action.data, record.observation)
      )
        authorized = { decision: 'allow', reason: 'computer_full_access_app' };
      if (approvalDecision === 'allow_plan' && action?.success)
        this.installPlanGrant(record, action.data);
      if (
        approvalDecision === undefined &&
        action?.success &&
        this.planGrantMatches(record, action.data)
      )
        this.planGrantAuthorizedCalls.add(`${sessionId}\0${request.callId}`);
      if (authorized.decision === 'deny') {
        record.status = this.status(
          record,
          'paused',
          null,
          record.observation?.revision ?? record.status.observationRevision,
          record.status.round,
          null,
        );
        this.emit(record.status);
      }
      return authorized;
    }
    if (capability === 'computer.observe') return { decision: 'allow', reason: 'computer_observe' };
    if (action?.success && this.safeSessionAction(record, action.data, request.callId))
      return { decision: 'allow', reason: 'computer_session_grant' };
    if (action?.success && this.isHardBoundary(action.data, record.observation))
      return this.userTakeover(record, 'computer_hard_boundary_user_takeover');
    if (action?.success) return this.awaitApproval(record, request.callId, action.data);
    return { decision: 'deny', reason: 'computer_action_requires_approval' };
  }

  private awaitApproval(
    record: SessionRecord,
    callId: string,
    action: ComputerUseAction,
  ): Promise<ToolAuthorizationDecision> {
    const approvalId = randomUUID();
    const targetId = 'targetId' in action ? action.targetId : null;
    const targetSignature =
      targetId === null ? undefined : record.observation?.targetSignatures?.[targetId];
    const targetMetadata =
      targetId === null ? undefined : record.observation?.targetMetadata?.[targetId];
    const eligibleForPlan =
      isPlanEligibleComputerUseAction(action.type) &&
      targetId !== null &&
      targetSignature !== undefined &&
      targetSignature.length > 0 &&
      computerUsePlanGrantAuthority(record.observation) !== null &&
      targetMetadata !== undefined &&
      targetMetadata.secure !== true &&
      targetMetadata.highImpact !== true &&
      !this.isHardBoundary(action, record.observation);
    const challenge = `${randomUUID()}${randomUUID()}`;
    const preview = safeActionPreview(action);
    const approval = computerUseApprovalSchema.parse({
      id: approvalId,
      sessionId: record.status.sessionId,
      taskId: record.status.taskId,
      turnId: record.turnId,
      callId,
      actionType: action.type,
      actionDigest: computerUseActionDigest(action),
      targetLabel: actionTargetLabel(action),
      preview,
      risk: action.type === 'wait' || action.type === 'finish' ? 'low' : 'high',
      policyEpoch: record.status.policyEpoch,
      observationRevision: record.observation?.revision ?? record.status.observationRevision,
      eligibleForPlan,
      allowedDecisions: eligibleForPlan
        ? ['allow_once', 'allow_plan', 'deny']
        : ['allow_once', 'deny'],
      state: 'pending',
      decision: null,
      revision: 0,
      challenge,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + 60 * 60 * 1_000).toISOString(),
    });
    record.status = this.status(
      record,
      'awaiting_approval',
      null,
      record.observation?.revision ?? record.status.observationRevision,
      record.status.round,
      approval,
    );
    this.emit(record.status);
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          const current = this.pendingApprovals.get(approvalId);
          if (current === undefined) return;
          this.pendingApprovals.delete(approvalId);
          record.status = this.status(
            record,
            'paused',
            null,
            record.observation?.revision ?? record.status.observationRevision,
            record.status.round,
            null,
          );
          this.emit(record.status);
          this.deps.publishApproval?.(
            computerUseApprovalSchema.parse({
              ...current.approval,
              state: 'expired',
              decision: null,
              revision: current.approval.revision + 1,
            }),
          );
          resolve({ decision: 'deny', reason: 'computer_approval_expired' });
        },
        60 * 60 * 1_000,
      );
      timer.unref?.();
      this.pendingApprovals.set(approvalId, { approval, action, resolve, timer });
      this.deps.publishApproval?.(approval);
      // If Stop raced publication, do not leave an orphaned promise behind.
      if (record.controller.signal.aborted) {
        this.pendingApprovals.delete(approvalId);
        clearTimeout(timer);
        resolve({ decision: 'deny', reason: 'computer_session_ended' });
      }
    });
  }

  private userTakeover(record: SessionRecord, reason: string): ToolAuthorizationDecision {
    record.status = this.status(
      record,
      'paused',
      null,
      record.observation?.revision ?? record.status.observationRevision,
      record.status.round,
    );
    this.emit(record.status);
    return { decision: 'allow', reason };
  }

  private async executeObserve(
    input: unknown,
    context: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<ComputerUseNativeObservation> {
    const sessionId = readSessionId(input);
    const record = this.requireSession(sessionId);
    if (context.taskId !== record.status.taskId || context.turnId !== record.turnId)
      throw new Error('Computer Use context binding changed');
    this.assertSessionLive(record);
    signal?.throwIfAborted();
    const observation = await this.deps.native.observe(record.native, {
      requestId: `${sessionId}:observe:${randomUUID()}`,
      cancelEpoch: record.native.cancelEpoch,
    });
    return this.acceptNativeObservation(record, observation);
  }

  private async executeAction(
    input: unknown,
    context: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<ComputerUseActionResult> {
    const recordInput = input as Record<string, unknown>;
    const sessionId = readSessionId(input);
    const record = this.requireSession(sessionId);
    const action = computerUseActionSchema.parse(recordInput['action']);
    const requestId =
      typeof recordInput['requestId'] === 'string' ? recordInput['requestId'] : randomUUID();
    if (context.taskId !== record.status.taskId || context.turnId !== record.turnId)
      throw new Error('Computer Use context binding changed');
    this.assertSessionLive(record);
    if (record.observation === null) throw new Error('Computer Use requires a fresh observation');
    const observation = computerUseObservationSchema.parse(record.observation);
    if (!this.observationIsFresh(record))
      return this.completeNonNativeAction(
        record,
        action,
        requestId,
        'rejected',
        'stale_observation',
      );
    if (action.type === 'wait')
      return this.completeNonNativeAction(record, action, requestId, 'completed', null);
    if (action.type === 'finish')
      return this.completeNonNativeAction(record, action, requestId, 'completed', null);
    if (record.status.mode === 'observe_only') throw new Error('Computer Use is observe-only');
    if (this.isHardBoundary(action, record.observation)) {
      record.status = this.status(
        record,
        'paused',
        null,
        observation.revision,
        record.status.round,
      );
      this.emit(record.status);
      return this.completeNonNativeAction(record, action, requestId, 'paused', 'hard_boundary');
    }
    if (this.deps.visualActionBlocked?.(sessionId, action) === true) {
      record.status = this.status(
        record,
        'paused',
        null,
        observation.revision,
        record.status.round,
      );
      this.emit(record.status);
      return this.completeNonNativeAction(
        record,
        action,
        requestId,
        'paused',
        'stop_overlay_boundary',
      );
    }
    if (record.planner?.revalidate !== undefined) {
      try {
        await record.planner.revalidate(signal ?? record.controller.signal);
      } catch {
        if (record.controller.signal.aborted || signal?.aborted)
          throw new Error('Computer Use is canceled');
        record.status = this.status(
          record,
          'paused',
          null,
          observation.revision,
          record.status.round,
        );
        this.emit(record.status);
        return this.completeNonNativeAction(
          record,
          action,
          requestId,
          'rejected',
          'provider_binding_changed',
        );
      }
      this.assertSessionLive(record);
      if (!this.observationIsFresh(record))
        return this.completeNonNativeAction(
          record,
          action,
          requestId,
          'rejected',
          'stale_observation',
        );
    }
    record.status = this.status(
      record,
      'acting',
      null,
      observation.revision,
      record.status.round,
      null,
    );
    this.emit(record.status);
    if (computerUseActionRoute(action) === 'visual' && !this.visualActionInsideWindow(action))
      throw new Error('Computer Use visual action is outside the target window');
    const actionDigest = computerUseActionDigest(action);
    const route = computerUseActionRoute(action);
    const observationDigest = computerUseObservationAuditDigest(observation);
    const audit = this.deps.persistence.recordComputerActionAudit({
      taskId: record.status.taskId,
      turnId: computerUseAuditBindingDigest(record.turnId),
      sessionId: computerUseAuditBindingDigest(sessionId),
      profileId: record.profile.id,
      profileRevision: record.profile.revision,
      appIdentityDigest: record.status.appIdentityDigest,
      windowIdentityDigest: record.status.windowIdentityDigest,
      observationRevision: observation.revision,
      observationDigest,
      clientWidth: observation.clientWidth,
      clientHeight: observation.clientHeight,
      actionDigest,
      actionKind: computerUseActionKind(action),
      route,
      nativeRequestId: computerUseAuditBindingDigest(requestId),
      policyEpoch: record.status.policyEpoch,
    });
    if (audit.state !== 'pending') {
      this.planGrantAuthorizedCalls.delete(`${sessionId}\0${requestId}`);
      return actionResultFromAudit(audit, sessionId, requestId);
    }
    signal?.throwIfAborted();
    if (!this.observationIsFresh(record)) {
      this.planGrantAuthorizedCalls.delete(`${sessionId}\0${requestId}`);
      const completed = this.deps.persistence.completeComputerActionAudit({
        auditId: audit.id,
        state: 'rejected',
        reasonCode: 'stale_observation',
        updatedAt: new Date(this.now()).toISOString(),
      });
      record.status = this.status(
        record,
        'paused',
        null,
        observation.revision,
        record.status.round,
      );
      this.emit(record.status);
      return actionResultFromAudit(completed, sessionId, requestId);
    }
    let nativeResult: ComputerUseNativeActionResult;
    try {
      nativeResult = await this.dispatchNativeAction(
        record,
        action,
        requestId,
        observation.revision,
        signal ?? record.controller.signal,
      );
    } catch {
      this.planGrantAuthorizedCalls.delete(`${sessionId}\0${requestId}`);
      // The native boundary may have accepted the action before its promise rejected.  Once
      // dispatch has begun, classify every exception as unknown_effect and never retry it.
      const completed = this.deps.persistence.completeComputerActionAudit({
        auditId: audit.id,
        state: 'unknown_effect',
        reasonCode: 'native_ack_unknown',
        updatedAt: new Date(this.now()).toISOString(),
      });
      if (!record.controller.signal.aborted && this.sessions.has(sessionId)) {
        record.status = this.status(
          record,
          'paused',
          null,
          observation.revision,
          record.status.round,
        );
        this.emit(record.status);
      }
      return actionResultFromAudit(completed, sessionId, requestId);
    }
    const completed = this.deps.persistence.completeComputerActionAudit({
      auditId: audit.id,
      state: nativeResult.result === 'completed' ? 'applied' : mapAuditState(nativeResult.result),
      reasonCode: nativeResult.reasonCode,
      updatedAt: new Date(this.now()).toISOString(),
    });
    const planGrantUsed = this.planGrantAuthorizedCalls.delete(`${sessionId}\0${requestId}`);
    if (
      planGrantUsed &&
      this.planGrantMatches(record, action) &&
      (nativeResult.result === 'completed' || nativeResult.result === 'unknown_effect')
    )
      record.planGrant!.remaining -= 1;
    if (nativeResult.result === 'unknown_effect') {
      record.status = this.status(
        record,
        'paused',
        null,
        observation.revision,
        record.status.round,
      );
      this.emit(record.status);
    }
    if (nativeResult.result === 'rejected' || nativeResult.result === 'paused') {
      record.status = this.status(
        record,
        'paused',
        null,
        observation.revision,
        record.status.round,
      );
      this.emit(record.status);
    }
    const actionResult = actionResultFromAudit(completed, sessionId, requestId);
    return nativeResult.result === 'paused' ? { ...actionResult, result: 'paused' } : actionResult;
  }

  private recordDeniedAction(input: unknown, context: ToolExecutionContext): void {
    try {
      const value = input as Record<string, unknown>;
      const sessionId = readSessionId(input);
      const record = this.sessions.get(sessionId);
      if (
        record === undefined ||
        record.observation === null ||
        context.taskId !== record.status.taskId ||
        context.turnId !== record.turnId
      )
        return;
      const action = computerUseActionSchema.parse(value['action']);
      const requestId = typeof value['requestId'] === 'string' ? value['requestId'] : randomUUID();
      this.completeNonNativeAction(record, action, requestId, 'rejected', 'authorization_denied');
    } catch {
      // Denial remains fail-closed even if its best-effort privacy-safe audit cannot be recorded.
    }
  }

  private async dispatchNativeAction(
    record: SessionRecord,
    action: ComputerUseAction,
    requestId: string,
    observationRevision: number,
    signal: AbortSignal,
  ): Promise<ComputerUseNativeActionResult> {
    const atomicActions: readonly ComputerUseAction[] =
      action.type === 'type'
        ? [...action.text].map((text) => ({ type: 'type' as const, text }))
        : [action];
    let result: ComputerUseNativeActionResult = { result: 'completed', reasonCode: null };
    for (const [index, atomicAction] of atomicActions.entries()) {
      signal.throwIfAborted();
      if (!this.observationIsFresh(record))
        return index === 0
          ? { result: 'rejected', reasonCode: 'stale_observation' }
          : { result: 'unknown_effect', reasonCode: 'stale_observation_mid_action' };
      const atomicRequestId =
        atomicActions.length === 1
          ? requestId
          : createHash('sha256').update(`${requestId}\0${index}`).digest('hex');
      result = await this.deps.native.dispatch({
        session: record.native,
        requestId: atomicRequestId,
        action: atomicAction,
        observationRevision,
        cancelEpoch: record.native.cancelEpoch,
        signal,
      });
      // Once native returned a bounded result, that result is authoritative even if Stop won the
      // next microtask. Downgrading a confirmed completion/rejection to canceled corrupts the
      // durable audit. A partial multi-scalar type still reaches the next loop boundary, where the
      // abort becomes unknown_effect because the whole requested action did not complete.
      if (result.result !== 'completed') return result;
    }
    return result;
  }

  private completeNonNativeAction(
    record: SessionRecord,
    action: ComputerUseAction,
    requestId: string,
    result: ComputerUseActionResult['result'],
    reasonCode: string | null,
  ): ComputerUseActionResult {
    const observation = record.observation;
    if (observation === null) throw new Error('Computer Use requires a fresh observation');
    const observationRevision = observation.revision;
    const audit = this.deps.persistence.recordComputerActionAudit({
      taskId: record.status.taskId,
      turnId: computerUseAuditBindingDigest(record.turnId),
      sessionId: computerUseAuditBindingDigest(record.status.sessionId),
      profileId: record.profile.id,
      profileRevision: record.profile.revision,
      appIdentityDigest: record.status.appIdentityDigest,
      windowIdentityDigest: record.status.windowIdentityDigest,
      observationRevision,
      observationDigest: computerUseObservationAuditDigest(observation),
      clientWidth: observation.clientWidth,
      clientHeight: observation.clientHeight,
      actionDigest: computerUseActionDigest(action),
      actionKind: computerUseActionKind(action),
      route: computerUseActionRoute(action),
      nativeRequestId: computerUseAuditBindingDigest(requestId),
      policyEpoch: record.status.policyEpoch,
    });
    const completed =
      audit.state === 'pending'
        ? this.deps.persistence.completeComputerActionAudit({
            auditId: audit.id,
            state: result === 'completed' ? 'applied' : mapAuditState(result),
            reasonCode,
            updatedAt: new Date(this.now()).toISOString(),
          })
        : audit;
    const actionResult = actionResultFromAudit(completed, record.status.sessionId, requestId);
    return result === 'paused' ? { ...actionResult, result: 'paused' } : actionResult;
  }

  private safeSessionAction(
    record: SessionRecord,
    action: ComputerUseAction,
    callId: string,
  ): boolean {
    if (action.type === 'wait' || action.type === 'finish') return true;
    if (record.status.mode === 'observe_only') return false;
    if (
      record.status.mode === 'full_access_app' &&
      (!this.fullAccessLanguageAttested(record) || this.isHardBoundary(action, record.observation))
    )
      return false;
    if (
      record.status.mode === 'full_access_app' &&
      !this.isHardBoundary(action, record.observation)
    )
      return true;
    const allowed = this.planGrantMatches(record, action);
    if (allowed) this.planGrantAuthorizedCalls.add(`${record.status.sessionId}\0${callId}`);
    if (allowed) return true;
    return false;
  }

  private installPlanGrant(record: SessionRecord, action: ComputerUseAction): void {
    if (record.status.mode !== 'supervised') return;
    if (!isPlanEligibleComputerUseAction(action.type)) return;
    const targetId = 'targetId' in action ? action.targetId : null;
    const metadata = targetId === null ? undefined : record.observation?.targetMetadata?.[targetId];
    const authority = computerUsePlanGrantAuthority(record.observation);
    if (
      targetId === null ||
      record.observation?.targetSignatures?.[targetId] === undefined ||
      authority === null ||
      metadata === undefined ||
      metadata.secure === true ||
      metadata.highImpact === true ||
      this.isHardBoundary(action, record.observation)
    )
      return;
    record.planGrant = {
      actionType: action.type,
      actionDigest: computerUseActionDigest(action),
      targetId,
      targetSignature: record.observation.targetSignatures[targetId],
      ...authority,
      remaining: 16,
      expiresAt: this.now() + 60_000,
      observationRevision: record.observation.revision,
    };
  }

  private planGrantMatches(record: SessionRecord, action: ComputerUseAction): boolean {
    const grant = record.planGrant;
    if (grant === null || this.now() >= grant.expiresAt || grant.remaining <= 0) return false;
    if (!this.observationIsFresh(record)) return false;
    if (!computerUsePlanGrantObservationMatches(grant, record.observation)) {
      record.planGrant = null;
      return false;
    }
    if (!isPlanEligibleComputerUseAction(action.type)) return false;
    const targetId = 'targetId' in action ? action.targetId : null;
    const signature =
      targetId === null ? undefined : record.observation?.targetSignatures?.[targetId];
    const metadata = targetId === null ? undefined : record.observation?.targetMetadata?.[targetId];
    if (
      targetId !== grant.targetId ||
      computerUseActionDigest(action) !== grant.actionDigest ||
      signature !== grant.targetSignature ||
      metadata === undefined ||
      metadata.secure === true ||
      metadata.highImpact === true ||
      this.isHardBoundary(action, record.observation) ||
      action.type !== grant.actionType ||
      record.observation === null ||
      record.observation.revision < grant.observationRevision
    )
      return false;
    return true;
  }

  private isHardBoundary(
    action: ComputerUseAction,
    observation: ComputerUseNativeObservation | null,
  ): boolean {
    if (
      (action.type === 'invoke' ||
        action.type === 'set_text' ||
        action.type === 'select' ||
        action.type === 'toggle' ||
        action.type === 'expand_collapse') &&
      'targetId' in action
    )
      return (
        observation?.targetMetadata?.[action.targetId]?.secure === true ||
        observation?.targetMetadata?.[action.targetId]?.highImpact === true
      );
    if (action.type === 'type' || action.type === 'key')
      return (
        observation?.focusedElementSecure === true || observation?.focusedElementHighImpact === true
      );
    return false;
  }

  private observationIsFresh(record: SessionRecord): boolean {
    const observation = record.observation;
    return (
      observation !== null &&
      observation.revision === record.status.observationRevision &&
      Date.parse(observation.expiresAt) > this.now()
    );
  }

  private async acceptNativeObservation(
    record: SessionRecord,
    observation: ComputerUseNativeObservation,
  ): Promise<ComputerUseNativeObservation> {
    const parsed = computerUseObservationSchema.parse(observation);
    if (
      parsed.sessionId !== record.status.sessionId ||
      parsed.appIdentityDigest !== record.status.appIdentityDigest ||
      parsed.windowIdentityDigest !== record.status.windowIdentityDigest ||
      parsed.profileRevision !== record.status.profileRevision ||
      parsed.revision <= record.status.observationRevision
    )
      throw new Error('Computer Use observation binding is stale');
    if (
      record.planGrant !== null &&
      !computerUsePlanGrantObservationMatches(record.planGrant, parsed)
    )
      record.planGrant = null;
    this.revalidateNativeAttestation(
      record,
      parsed.policyLanguage,
      parsed.maximumMode,
      parsed.screenBounds,
    );
    if (!(await this.repositionEmergencyStop(record.status.sessionId, parsed.screenBounds))) {
      await this.stop(record.status.sessionId, 'emergency_stop');
      throw new Error('Computer Use Stop overlay could not follow the native target');
    }
    return parsed;
  }

  private async repositionEmergencyStop(
    sessionId: string,
    screenBounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  ): Promise<boolean> {
    try {
      return await this.deps.repositionEmergencyStop(sessionId, screenBounds);
    } catch {
      return false;
    }
  }

  private fullAccessLanguageAttested(record: SessionRecord): boolean {
    return (
      bindComputerUsePolicyLanguage(
        profilePolicyLanguage(record.profile),
        record.native.policyLanguage,
        record.status.policyLanguage,
        record.observation?.policyLanguage ?? 'unknown',
      ) !== 'unknown'
    );
  }

  /** Native authority is monotonic: changed or missing evidence can only narrow the session. */
  private revalidateNativeAttestation(
    record: SessionRecord,
    currentPolicyLanguage: ComputerUsePolicyLanguage,
    currentMaximumMode: ComputerUseMode,
    screenBounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  ): void {
    const policyLanguage = bindComputerUsePolicyLanguage(
      record.status.policyLanguage,
      profilePolicyLanguage(record.profile),
      record.native.policyLanguage,
      currentPolicyLanguage,
    );
    const maximumMode = bindComputerUseMaximumMode(
      record.status.maximumMode,
      maximumModeForProfile(record.profile),
      record.native.maximumMode,
      currentMaximumMode,
    );
    const mode = effectiveComputerUseMode(
      record.status.mode,
      this.availability().control,
      policyLanguage,
      maximumMode,
    );
    if (
      mode !== record.status.mode ||
      maximumMode !== record.status.maximumMode ||
      policyLanguage !== record.status.policyLanguage ||
      !sameComputerUseBounds(screenBounds, record.screenBounds)
    ) {
      record.planGrant = null;
      record.status = computerUseSessionStatusSchema.parse({
        ...record.status,
        mode,
        maximumMode,
        policyLanguage,
      });
      record.screenBounds = screenBounds;
    }
  }

  private actionMayNeedApproval(record: SessionRecord, action: ComputerUseAction): boolean {
    if (action.type === 'wait' || action.type === 'finish') return false;
    if (this.isHardBoundary(action, record.observation)) return false;
    if (record.status.mode === 'supervised') return true;
    if (record.status.mode === 'full_access_app') return false;
    return true;
  }

  private visualActionInsideWindow(action: ComputerUseAction): boolean {
    if (action.type !== 'click' && action.type !== 'scroll') return true;
    return action.x >= 0 && action.x <= 1 && action.y >= 0 && action.y <= 1;
  }

  private assertSessionLive(record: SessionRecord): void {
    if (record.controller.signal.aborted) throw new Error('Computer Use session is canceled');
    if (this.now() >= Date.parse(record.status.expiresAt))
      throw new Error('Computer Use session expired');
    if (this.currentPolicyEpoch(record.status.taskId) !== record.status.policyEpoch)
      throw new Error('Computer Use policy epoch changed');
    const activeTurnId = this.deps.persistence.getActiveTurnId(record.status.taskId);
    if (
      (record.syntheticTurn && activeTurnId !== null) ||
      (!record.syntheticTurn && activeTurnId !== record.turnId)
    ) {
      if (record.syntheticTurn && activeTurnId !== null)
        void this.stop(record.status.sessionId, 'turn_started');
      throw new Error('Computer Use Turn ownership changed');
    }
  }

  private currentPolicyEpoch(taskId: string): number {
    return (
      this.deps.currentPolicyEpoch?.(taskId) ??
      this.deps.persistence.getPermissionPolicy(taskId).policyEpoch
    );
  }

  private assertStartBinding(taskId: string, policyEpoch: number): void {
    if (this.deps.persistence.getActiveTurnId(taskId) !== null)
      throw new Error('Computer Use synthetic session requires an idle Task');
    if (this.currentPolicyEpoch(taskId) !== policyEpoch)
      throw new Error('Computer Use policy epoch changed');
    if (this.deps.canStartSession?.(taskId) === false)
      throw new Error('Computer Use requires an idle Task without active Team work');
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw new Error('Computer Use session not found');
    return record;
  }

  private status(
    record: SessionRecord,
    state: ComputerUseSessionStatus['state'],
    stopReason: ComputerUseStopReason | null,
    observationRevision = record.status.observationRevision,
    round = record.status.round,
    pendingApproval: ComputerUseApproval | null = null,
  ): ComputerUseSessionStatus {
    return computerUseSessionStatusSchema.parse({
      ...record.status,
      state,
      stopReason: state === 'stopped' ? stopReason : null,
      pendingApproval,
      observationRevision,
      round: Math.min(COMPUTER_USE_LIMITS.maxRounds, round),
      lastObservationAt:
        observationRevision > record.status.observationRevision
          ? new Date(this.now()).toISOString()
          : record.status.lastObservationAt,
    });
  }

  private emit(status: ComputerUseSessionStatus): void {
    const statusRevision = (this.statusRevisionBySession.get(status.sessionId) ?? 0) + 1;
    const parsed = computerUseSessionStatusSchema.parse({ ...status, statusRevision });
    this.statusRevisionBySession.set(status.sessionId, statusRevision);
    const record = this.sessions.get(status.sessionId);
    if (record !== undefined) record.status = parsed;
    this.deps.publishStatus?.(parsed);
    for (const listener of this.listeners) listener(parsed);
  }
}

function publicProfile(profile: ComputerAppProfileRecord): ComputerAppProfile {
  const identity = profile.identity;
  const maximumMode = maximumModeForProfile(profile);
  const ref = {
    platform: profile.platform,
    identityDigest: profile.identityDigest,
    displayName: profile.label,
    ...(typeof identity['bundleId'] === 'string' ? { bundleId: identity['bundleId'] } : {}),
    ...(typeof identity['packageFamilyName'] === 'string'
      ? { packageFamilyName: identity['packageFamilyName'] }
      : {}),
    ...(typeof identity['signerDigest'] === 'string'
      ? { signerDigest: identity['signerDigest'] }
      : {}),
    ...(typeof identity['teamId'] === 'string' ? { teamId: identity['teamId'] } : {}),
    policyLanguage: profilePolicyLanguage(profile),
    maximumMode,
  };
  return computerAppProfileSchema.parse({
    id: profile.id,
    label: profile.label,
    identity: ref,
    mode: bindComputerUseMaximumMode(profile.mode, maximumMode),
    connectionId: profile.connectionId,
    modelId: profile.modelId,
    providerEgressConsent: profile.providerEgressConsent,
    remember: profile.remember,
    profileRevision: profile.revision,
    policyLanguage: profilePolicyLanguage(profile),
    maximumMode,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  });
}

function computerUseAppIdentityIsDenied(identity: unknown): boolean {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) return true;
  const record = identity as Record<string, unknown>;
  const text = (key: string): string =>
    typeof record[key] === 'string' ? record[key].toLowerCase() : '';
  const bundleId = text('bundleId');
  const packageFamily = text('packageFamilyName');
  const appUserModelId = text('appUserModelId');
  const executablePath = text('executablePath').replaceAll('/', '\\');
  const displayName = text('displayName').trim();
  const deniedMacBundles = new Set([
    'com.apple.terminal',
    'com.apple.systempreferences',
    'com.apple.finder',
    'com.googlecode.iterm2',
    'dev.warp.warp-stable',
    'dev.warp.warp',
    'com.apple.remotedesktop',
    'com.microsoft.rdc.macos',
    'com.microsoft.windowsapp',
    'com.teamviewer.teamviewer',
    'com.anydesk.anydesk',
    'com.philandro.anydesk',
    'com.apple.screensharing',
    'com.carriez.rustdesk',
    'com.citrix.receiver.icaviewer.mac',
    'com.citrix.workspace',
    'com.parsecgaming.parsec',
    'com.splashtop.splashtop-remote-desktop',
    'com.vmware.horizon',
  ]);
  if (deniedMacBundles.has(bundleId)) return true;
  const deniedProductTokens = ['teamviewer', 'anydesk', 'rustdesk', 'remotedesktop'];
  if (
    ['windowsterminal', 'immersivecontrolpanel', ...deniedProductTokens].some((token) =>
      `${packageFamily}\n${appUserModelId}`.includes(token),
    )
  )
    return true;
  if (
    /\\(cmd|powershell|pwsh|wt|mstsc|msrdc|msrdcw|rdclient\.windows|quickassist|teamviewer|anydesk|rustdesk|parsec|explorer|regedit|mmc|msiexec|setup|installer)\.exe$/u.test(
      executablePath,
    )
  )
    return true;
  return /^(terminal|iterm2?|warp|command prompt|powershell|windows terminal|system settings|settings|finder|file explorer|remote desktop|microsoft remote desktop|windows app|quick assist|teamviewer|anydesk|rustdesk|parsec|splashtop remote desktop|screen sharing|citrix workspace|vmware horizon client)$/u.test(
    displayName,
  );
}

function profilePolicyLanguage(profile: ComputerAppProfileRecord): ComputerUsePolicyLanguage {
  const parsed = computerUsePolicyLanguageSchema.safeParse(profile.identity['policyLanguage']);
  return parsed.success ? parsed.data : 'unknown';
}

function maximumModeForProfile(profile: ComputerAppProfileRecord): ComputerUseMode {
  const parsed = computerUseModeSchema.safeParse(profile.identity['maximumMode']);
  return parsed.success ? parsed.data : 'observe_only';
}

function effectiveComputerUseMode(
  requested: ComputerUseMode,
  controlAvailable: boolean,
  policyLanguage: ComputerUsePolicyLanguage,
  maximumMode: ComputerUseMode,
): ComputerUseMode {
  if (!controlAvailable) return 'observe_only';
  const bounded = bindComputerUseMaximumMode(requested, maximumMode);
  return bounded === 'full_access_app' && policyLanguage === 'unknown' ? 'supervised' : bounded;
}

function sameComputerUseBounds(
  left: Readonly<{ x: number; y: number; width: number; height: number }>,
  right: Readonly<{ x: number; y: number; width: number; height: number }>,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function readSessionId(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Computer Use session id is missing');
  const sessionId = (input as Record<string, unknown>)['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 128)
    throw new Error('Computer Use session id is invalid');
  return sessionId;
}

export function computerUseObservationAuditDigest(observation: ComputerUseObservation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        policyVersion: COMPUTER_USE_MAIN_POLICY_VERSION,
        accessibilityPolicyVersion: COMPUTER_USE_ACCESSIBILITY_POLICY_VERSION,
        sessionId: observation.sessionId,
        appIdentityDigest: observation.appIdentityDigest,
        windowIdentityDigest: observation.windowIdentityDigest,
        dialogSetRevision: observation.dialogSetRevision,
        dialogSetDigest: observation.dialogSetDigest,
        activeWindowIdentityDigest: observation.activeWindowIdentityDigest,
        activeWindowKind: observation.activeWindowKind,
        profileRevision: observation.profileRevision,
        revision: observation.revision,
        clientWidth: observation.clientWidth,
        clientHeight: observation.clientHeight,
        images: observation.images.map((image) => ({
          digest: image.digest,
          byteLength: image.byteLength,
          width: image.width,
          height: image.height,
        })),
        treeDigest: observation.treeDigest,
        treeByteLength: observation.treeByteLength,
        treeDepth: observation.treeDepth,
        treeNodeCount: observation.treeNodeCount,
        focusedElementSignature: observation.focusedElementSignature ?? null,
        policyLanguage: observation.policyLanguage,
        maximumMode: observation.maximumMode,
      }),
    )
    .digest('hex');
}

function stripComputerUseObservationPayload(
  observation: ComputerUseNativeObservation,
): ComputerUseNativeObservation {
  const { accessibilityTree: _tree, ...withoutTree } = observation;
  return computerUseObservationSchema.parse({
    ...withoutTree,
    images: observation.images.map(({ base64: _base64, ...image }) => image),
  });
}

function computerUseAuditBindingDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function approvedObservationEquivalent(
  previous: ComputerUseNativeObservation,
  current: ComputerUseNativeObservation,
  action: ComputerUseAction,
  now: number,
): boolean {
  if (
    current.sessionId !== previous.sessionId ||
    current.appIdentityDigest !== previous.appIdentityDigest ||
    current.windowIdentityDigest !== previous.windowIdentityDigest ||
    (current.dialogSetRevision ?? 0) !== (previous.dialogSetRevision ?? 0) ||
    current.dialogSetDigest !== previous.dialogSetDigest ||
    current.activeWindowIdentityDigest !== previous.activeWindowIdentityDigest ||
    current.activeWindowKind !== previous.activeWindowKind ||
    current.policyLanguage !== previous.policyLanguage ||
    current.profileRevision !== previous.profileRevision ||
    current.revision <= previous.revision ||
    current.clientWidth !== previous.clientWidth ||
    current.clientHeight !== previous.clientHeight ||
    Date.parse(current.expiresAt) <= now
  )
    return false;
  if ('targetId' in action) {
    const priorSignature = previous.targetSignatures?.[action.targetId];
    return (
      priorSignature !== undefined &&
      current.targetSignatures?.[action.targetId] === priorSignature &&
      current.targetMetadata?.[action.targetId]?.secure !== true &&
      current.targetMetadata?.[action.targetId]?.highImpact !== true
    );
  }
  if (action.type === 'type' || action.type === 'key')
    return (
      previous.focusedElementSignature !== undefined &&
      previous.focusedElementSignature !== null &&
      current.focusedElementSignature === previous.focusedElementSignature &&
      current.focusedElementSecure !== true &&
      current.focusedElementHighImpact !== true &&
      (previous.treeDigest === null
        ? current.images[0]?.digest === previous.images[0]?.digest
        : current.treeDigest === previous.treeDigest)
    );
  if (action.type === 'click' || action.type === 'scroll')
    return (
      current.treeDigest === previous.treeDigest &&
      current.images.length === previous.images.length &&
      current.images.every((image, index) => image.digest === previous.images[index]?.digest)
    );
  return false;
}

function actionResultFromAudit(
  audit: ComputerActionAuditRecord,
  sessionId: string,
  actionId: string,
): ComputerUseActionResult {
  return computerUseActionResultSchema.parse({
    actionId,
    sessionId,
    observationRevision: audit.observationRevision,
    result:
      audit.state === 'applied'
        ? 'completed'
        : audit.state === 'unknown_effect'
          ? 'unknown_effect'
          : audit.state === 'canceled'
            ? 'canceled'
            : audit.state === 'rejected'
              ? 'rejected'
              : 'paused',
    reasonCode: audit.reasonCode,
  });
}

function mapAuditState(
  result: ComputerUseActionResult['result'],
): Exclude<ComputerActionAuditState, 'pending'> {
  if (result === 'completed') return 'applied';
  if (result === 'canceled') return 'canceled';
  if (result === 'unknown_effect') return 'unknown_effect';
  return 'rejected';
}

function computerUseNativeUserTakeover(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const record = error as Error & { code?: unknown; reasonCode?: unknown };
  const reason =
    typeof record.reasonCode === 'string'
      ? record.reasonCode
      : typeof record.code === 'string'
        ? record.code
        : record.message;
  return /(?:dialog|file_picker|os_prompt|admin|security).*user_takeover/iu.test(reason);
}

async function waitBounded(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > COMPUTER_USE_LIMITS.maxWaitMs
  )
    throw new Error('Computer Use wait duration is invalid');
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Computer Use wait canceled'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function runBoundedComputerUseCleanup(
  cleanup: () => void | Promise<void>,
  timeoutMs: number,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  const work = Promise.resolve()
    .then(cleanup)
    .catch(() => undefined);
  void Promise.race([work, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function actionTargetLabel(action: ComputerUseAction): string {
  if ('targetId' in action) return `control:${safeUntrustedDisplayText(action.targetId, 128)}`;
  if ('x' in action && 'y' in action) return `target:${action.x.toFixed(3)},${action.y.toFixed(3)}`;
  return action.type;
}

function safeActionPreview(action: ComputerUseAction): string {
  const value = action as unknown as Record<string, unknown>;
  const redacted = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      if ((key === 'text' || key === 'value') && typeof nested === 'string') {
        const escaped = safeUntrustedDisplayText(nested, 128);
        return [key, escaped.slice(0, 128)];
      }
      return [key, nested];
    }),
  );
  return JSON.stringify(redacted, (_key, nested) =>
    typeof nested === 'string' ? safeUntrustedDisplayText(nested, 256) : nested,
  ).slice(0, COMPUTER_USE_LIMITS.maxApprovalPreviewBytes);
}

function safeUntrustedDisplayText(value: string, maximum = 256): string {
  const normalized = value
    .normalize('NFKC')
    .replace(
      /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,
      (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
    );
  return [...normalized].slice(0, maximum).join('') || 'unnamed';
}
