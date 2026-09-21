import { createHash, randomUUID } from 'node:crypto';
import {
  bindComputerUsePolicyLanguage,
  bindComputerUseMaximumMode,
  computerAppGrantViewSchema,
  computerAppProfileSchema,
  computerUseActionSchema,
  computerUseActionResultSchema,
  computerUseApprovalSchema,
  computerUseAvailabilitySchema,
  computerUseModeSchema,
  computerUseObservationSchema,
  computerUsePolicyLanguageSchema,
  computerUseSessionStatusSchema,
  computerUseRoundLimitSchema,
  computerUseWindowCandidateSchema,
  computerListTargetsOutputSchema,
  computerAppGrantRequestSchema,
  computerAppAccessRequestViewSchema,
  computerRequestAccessOutputSchema,
  computerStartToolOutputSchema,
  computerUseSessionStateIsSettled,
  selectableComputerTargetSchema,
  COMPUTER_START_GOAL_MAX_CHARACTERS,
  COMPUTER_TARGET_LIST_LIMIT,
  COMPUTER_USE_GRANT_LIST_LIMIT,
  COMPUTER_USE_REQUESTED_APP_LIST_LIMIT,
  COMPUTER_USE_LIMITS,
  type ComputerAccessRequestReasonCode,
  type ComputerAppAccessRequestView,
  type ComputerAppGrantDecision,
  type ComputerAppGrantRequest,
  type ComputerAppGrantResolveInput,
  type ComputerAppGrantView,
  type ComputerAppIdentity,
  type ComputerListTargetsOutput,
  type ComputerRequestAccessOutput,
  type ComputerStartToolOutput,
  type ComputerUseGrantListResult,
  type ComputerUseGrantPurgeResult,
  type ComputerTarget,
  type SelectableComputerTarget,
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
  type ComputerUseNativeInputReceipt,
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
  computerTargetUntrustedLabel,
  sanitizeUntrustedTargetLabel,
  resolveComputerTargetAppToken,
  resolveComputerTargetToken,
  COMPUTER_USE_WINDOW_CANDIDATE_TTL_MS,
  type ComputerTargetAppTokenRecord,
  type ComputerTargetTokenBinding,
  type ComputerTargetTokenRecord,
} from './computer-use-target-model';
import {
  computerAppGrantIdentityFrom,
  computerAppGrantMismatch,
  type ComputerAppGrantIdentity,
} from './computer-use-grant-identity';
import {
  computerAppGrantAllowedDecisions,
  computerAppGrantCardFactsMatch,
  computerAppGrantIntentDigest,
  sanitizeComputerAccessReason,
  COMPUTER_ACCESS_REQUEST_TASK_LIMIT,
  COMPUTER_ACCESS_REQUEST_TIMEOUT_MS,
  COMPUTER_ACCESS_REQUEST_TURN_LIMIT,
  type ComputerAppGrantCardFacts,
} from './computer-use-access-request';
import { appGrantActivationIntent } from '../computer-use-activation-intent';
import {
  computerAppGrantStoredIdentity,
  type ComputerAppGrantRecord,
} from './computer-use-grant-record';
import {
  ToolBroker as MainToolBroker,
  type ToolAuthorizationRequest,
  type ToolAuthorizationDecision,
  type ManagedToolLifecycleEvent,
} from './tool-broker';
import type {
  ComputerActionAuditRecord,
  ComputerAppGrantListing,
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
import { COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT } from './computer-use-native-host';
import type {
  ComputerUsePlannerObservation,
  ComputerUsePlannerPort,
} from './computer-use-planner-port';
import { COMPUTER_USE_ACCESSIBILITY_POLICY_VERSION } from './computer-use-accessibility-tree';
import { secureLogger } from './secure-logger';
import {
  captureComputerUseRuntime,
  computerUseCaptureDigest,
  type ComputerUseRuntimeCapture,
} from './computer-use-runtime-capture';

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
  inputReceipt?: ComputerUseNativeInputReceipt;
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
  inputReceipt?: ComputerUseNativeInputReceipt;
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
  cancel(
    session: ComputerUseNativeSession,
    cancelEpoch: number,
  ): Promise<ComputerUseNativeInputReceipt | void>;
  close(session: ComputerUseNativeSession): Promise<void>;
}

export type ComputerUseControllerPersistence = Pick<
  PersistenceClient,
  | 'listComputerAppProfiles'
  | 'getComputerAppProfile'
  | 'createComputerAppProfile'
  | 'updateComputerAppProfile'
  | 'removeComputerAppProfile'
  | 'listComputerAppGrants'
  | 'findComputerAppGrantByIdentity'
  | 'getComputerAppGrant'
  | 'createComputerAppGrant'
  | 'touchComputerAppGrantUsed'
  | 'countComputerAppGrantAccessRequest'
  | 'setComputerAppGrantProviderEgress'
  | 'removeComputerAppGrant'
  | 'purgeUnauthenticatedComputerAppGrants'
  | 'recordComputerAppAccessRequest'
  | 'getComputerAppAccessRequest'
  | 'countComputerAppAccessRequestsForTask'
  | 'listComputerAppAccessRequestTotals'
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
  maxRounds?: number | undefined;
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
  /**
   * Set only by `computer_start` (ADR v2 §5.2), never by the panel.
   *
   * The IPC start schema is `.strict()`, so a Renderer cannot supply this field: it exists to tell
   * the shared start path that this session's authority is a grant rather than a trusted click on
   * the panel, which changes two things — where provider egress consent comes from (§6.4), and the
   * fact that the grant is re-checked every round for as long as the session lives.
   */
  agent?: ComputerUseAgentStartBinding | undefined;
}>;

export type ComputerUseAgentStartBinding = Readonly<{
  /** Model-authored, already normalised and bounded like a Task goal. */
  goal: string;
  /** Which kind of grant authorised this session, so each round can re-check the same one. */
  grantScope: ComputerAppGrantScopeKind;
  grantId: string | null;
  grantIdentityDigest: string;
  providerEgress: Readonly<{ connectionId: string; modelId: string }>;
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
  runtimeCapture?: ComputerUseRuntimeCapture;
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
      /** The agent's stated goal for this session, or null for a session a person started. */
      sessionGoal: string | null;
      signal: AbortSignal;
    }>,
  ) => Promise<ComputerUsePlannerPort> | ComputerUsePlannerPort;
  featureEnabled?: () => boolean;
  /**
   * The second, narrower gate for the agent-driven target tools (ADR v2 §9). Absent means off: a
   * controller wired without it answers `listTargets` and `stopForAgent` as unavailable, so a
   * mis-wiring cannot quietly expose desktop enumeration.
   */
  agentDrivenEnabled?: () => boolean;
  /**
   * Where the calling Turn actually sends, for the same egress consent test `start` already applies.
   *
   * Keyed by Turn, not by Task: the Task's model setting is mutable and can be repointed at a
   * different connection while a Turn is running, so consenting against it would let a label pass
   * the check for connection B and then travel to connection A. Null means unknown, which withholds
   * every app-authored label.
   */
  providerEgressBindingFor?: (
    taskId: string,
    turnId: string,
  ) => Readonly<{ connectionId: string; modelId: string }> | null;
  now?: () => number;
  currentPolicyEpoch?: (taskId: string) => number;
  /**
   * Whether the Task is in a state a session may begin in.
   *
   * `ownerTurnId` is null for a start a person made from the panel, which needs an idle Task, and
   * the calling Turn for `computer_start`, which by definition runs inside one.
   */
  canStartSession?: (taskId: string, ownerTurnId: string | null) => boolean;
  authorize?: (request: ComputerUseAuthorizationRequest) => ComputerUseAuthorization;
  publishApproval?: (approval: unknown) => void;
  /**
   * Pushes the in-conversation application approval card and every later state it reaches.
   *
   * Absent means the card cannot be shown, and `computer_request_access` then refuses rather than
   * waiting: a card nobody can see is a tool call that would hang until its timeout.
   */
  publishGrantRequest?: (request: ComputerAppGrantRequest) => void;
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

/**
 * Which agreement says an application may be driven (ADR v2 §6.1, §6.5).
 *
 * `grant` is a row in `computer_app_grants` — permanent and installation-wide. `task` is the "just
 * this once" answer: it lives in memory, inside one Task, and is gone on restart.
 *
 * A V1 profile's "remember" is deliberately *not* a third kind. The profile row carries no MAC, so
 * `remember`, its consent flag and its connection/model pair are whatever the database file says
 * (T14). The panel's start is safe to read them because it also needs a trusted click every time;
 * `computer_start` has no click, so the only things it may stand on are a row that authenticates
 * and an answer this process itself heard. A remembered V1 application therefore gets one card the
 * first time an agent asks for it, like any other.
 */
type ComputerAppGrantScopeKind = 'grant' | 'task';

/**
 * What one Task agreed to for one application, without writing anything down (ADR v2 §6.1, D14).
 *
 * "Allow once" must not outlive the reason the user said it, so this record carries the two facts
 * that would make it mean something different later: the policy epoch it was given under, and the
 * deny ruleset that was in force. Either moving makes the entry stop matching, which is the same
 * fail-closed answer as it never having existed. Nothing here is persisted, so a Main restart and a
 * Task deletion both end it.
 */
type TaskScopedAppGrant = Readonly<{
  platform: 'darwin' | 'win32';
  grantIdentityDigest: string;
  maxMode: ComputerUseMode;
  denyRulesetVersion: number;
  policyEpoch: number;
  providerEgress: Readonly<{ connectionId: string; modelId: string }> | null;
}>;

/**
 * The answer to "may this application be driven without a fresh card, and on what authority".
 *
 * One value rather than a bare boolean because every caller needs more than the boolean: the start
 * path needs the mode ceiling and the egress pair, the enumeration needs something stable to
 * compare a re-read against, and the card needs to know whether it is asking for the application or
 * only for the destination.
 */
type ComputerAppGrantState = Readonly<{
  granted: boolean;
  scope: ComputerAppGrantScopeKind | null;
  grantId: string | null;
  maxMode: ComputerUseMode | null;
  providerEgress: Readonly<{ connectionId: string; modelId: string }> | null;
}>;

const COMPUTER_APP_UNGRANTED: ComputerAppGrantState = Object.freeze({
  granted: false,
  scope: null,
  grantId: null,
  maxMode: null,
  providerEgress: null,
});

/**
 * One unresolved approval card, and everything the click has to be checked against (§6.1.1).
 *
 * The facts are held here rather than re-derived on the click because the comparison is between
 * what the user *read* and what is true *now*; re-deriving both sides would compare the present
 * against itself and pass every time.
 */
type PendingAppGrantRequest = {
  request: ComputerAppGrantRequest;
  facts: ComputerAppGrantCardFacts;
  identityDigest: string;
  taskId: string;
  turnId: string;
  policyEpoch: number;
  profileId: string;
  /** The identity as the card asserted it, so refusing never has to read the store again. */
  identity: ComputerAppGrantIdentity;
  displayName: string;
  providerEgress: Readonly<{ connectionId: string; modelId: string }>;
  grantId: string | null;
  /** The ceiling of the agreement already in force, for a card that only asks about a destination. */
  grantedMaxMode: ComputerUseMode | null;
  timer: ReturnType<typeof setTimeout>;
  settle: (outcome: ComputerRequestAccessOutput) => void;
};

type SessionRecord = {
  status: ComputerUseSessionStatus;
  profile: ComputerAppProfileRecord;
  /** Present for a session `computer_start` created; null for one a person started. */
  agent: ComputerUseAgentStartBinding | null;
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
  maxRounds: number;
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
/**
 * What one application contributed to an in-flight enumeration, and what that contribution assumed.
 *
 * Kept together so the re-read on the return path compares like with like: the row's `granted` flag
 * came from the grant state captured here, and re-deriving it from the profile alone would compare
 * the answer against itself.
 */
type TargetEnumerationSnapshot = Readonly<{
  profile: ComputerAppProfileRecord;
  grantState: ComputerAppGrantState;
}>;

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
  /** Agent-facing tokens (ADR v2 §5.3). Never persisted, and rotated on every list call. */
  private readonly targetTokens = new Map<string, ComputerTargetTokenRecord>();
  private readonly targetAppTokens = new Map<string, ComputerTargetAppTokenRecord>();
  /**
   * "Allow once" grants, by Task then by `${platform}:${grantIdentityDigest}` (ADR v2 §6.1).
   *
   * In memory on purpose: the whole meaning of the button is that nothing is written down.
   */
  private readonly taskScopedGrants = new Map<string, Map<string, TaskScopedAppGrant>>();
  /** At most one unresolved card exists at a time, globally (§6.1). */
  private pendingAppGrantRequest: PendingAppGrantRequest | null = null;
  /** Cards raised per Turn, for the T8 ceiling. A Turn does not outlive the process. */
  private readonly accessRequestsByTurn = new Map<string, number>();
  private readonly statusRevisionBySession = new Map<string, number>();
  private readonly startingSessions = new Map<
    string,
    {
      controller: AbortController;
      reason: ComputerUseStopReason | null;
      taskId: string;
      /** Which application this start is for, so a revoked grant can cancel it (ADR v2 §6.5). */
      profileId: string;
    }
  >();
  private readonly now: () => number;
  private disposed = false;
  private startInProgress = false;
  private startingController: AbortController | null = null;
  private startingTaskId: string | null = null;
  /**
   * The application a start in flight is for, so revoking its grant can cancel it (ADR v2 §6.5).
   *
   * Without it, revoking would only reach `sessions`, and a start that is still awaiting native
   * would go on to become a live session for an application whose permission was just withdrawn.
   */
  private startingProfileId: string | null = null;

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
    // The feature gate is Main's, so a disabled feature names no OS permission to grant.
    const missingPermissions = featureEnabled ? native.missingPermissions : [];
    const state = !featureEnabled
      ? 'feature_disabled'
      : !packageReady
        ? 'unsigned_package'
        : !handshakeReady
          ? 'handshake_failed'
          : !native.observe
            ? missingPermissions.length > 0
              ? 'permission_required'
              : 'native_unavailable'
            : 'ready';
    return computerUseAvailabilitySchema.parse({
      ...native,
      missingPermissions,
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

  /**
   * The grant model (ADR v2 §6.2–§6.5).
   *
   * Everything below is the store plus the pure rules in `computer-use-grant-identity`; no route
   * here creates a session, and none of it is reachable from model output. S3b's approval card is
   * what will call `createAppGrant`, from a trusted click.
   */

  /**
   * The grant identity for a stored application profile, or null when no grant is possible.
   *
   * The single place "may this application be granted at all?" is decided. Null covers an identity
   * that cannot be pinned down (§6.2) and an application the current deny ruleset forbids (§3),
   * because every caller does the same thing with both: treat the application as ungranted.
   */
  appGrantIdentityFor(identity: unknown): ComputerAppGrantIdentity | null {
    return computerUseAppIdentityIsDenied(identity) ? null : computerAppGrantIdentityFrom(identity);
  }

  /**
   * The live grant for an application, applying §6.3 on the way out.
   *
   * A stored row is not the answer on its own: a row whose signing class or normalised path has
   * moved since it was written describes a different application, and a row whose class the ruleset
   * now forbids is revoked here rather than being allowed to survive until something asks again.
   */
  appGrantFor(identity: unknown): ComputerAppGrantRecord | null {
    const derived = computerAppGrantIdentityFrom(identity);
    if (derived === null) return null;
    const stored = this.deps.persistence.findComputerAppGrantByIdentity(
      derived.platform,
      derived.grantIdentityDigest,
    );
    if (stored === null) return null;
    const mismatch = computerAppGrantMismatch(
      computerAppGrantStoredIdentity(stored),
      derived,
      computerUseAppIdentityIsDenied(identity),
    );
    if (mismatch === null) return stored;
    // A newly denied class is revoked outright — the user is not asked again (§6.3, T3). Every
    // other mismatch leaves the row alone: it simply stops matching, and the next request raises a
    // card whose approval writes the new identity.
    //
    // Fire-and-forget with its own catch: this runs on the synchronous path that builds an
    // enumeration, and the answer — "not granted" — does not depend on the removal succeeding. A
    // concurrent revoke of the same row makes it throw, and that is already the outcome we wanted.
    if (mismatch === 'denied_class')
      void this.revokeAppGrant(stored.id, stored.revision).catch(() => undefined);
    return null;
  }

  /** Every grant, for the settings screen, with the count of rows that failed their MAC (T14). */
  listAppGrants(): ComputerAppGrantListing {
    return this.deps.persistence.listComputerAppGrants();
  }

  /**
   * The settings screen's view of every grant (ADR v2 §6.1, §6.5).
   *
   * The single place a stored grant becomes something a person reads, so the sanitising of the
   * application's own name happens once — the same function, and therefore the same character set,
   * the agent-facing labels go through. A row that still fails the contract after sanitising is
   * dropped and counted rather than thrown, so one strange name cannot blank the list the user
   * revokes from.
   */
  listAppGrantViews(): ComputerUseGrantListResult {
    const listing = this.deps.persistence.listComputerAppGrants();
    const grants: ComputerAppGrantView[] = [];
    let discardedRecords = listing.discarded;
    for (const grant of listing.grants) {
      const view = computerAppGrantViewSchema.safeParse({
        id: grant.id,
        revision: grant.revision,
        platform: grant.platform,
        identityKind: grant.identityKind,
        publisher: grant.publisher,
        appId: grant.appId,
        untrustedDisplayName: sanitizeUntrustedTargetLabel(grant.displayName),
        maxMode: grant.maxMode,
        grantedAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
        codeChangedAt: grant.cdHashChangedAt,
        requestCount: grant.requestCount,
        denialCount: grant.denialCount,
      });
      if (view.success) grants.push(view.data);
      else discardedRecords += 1;
    }
    const granted = new Set(
      listing.grants.map((grant) => `${grant.platform}:${grant.grantIdentityDigest}`),
    );
    const requestedApps: ComputerAppAccessRequestView[] = [];
    // Only the applications that never became a grant: a granted one already has a row above with
    // its own counters, and listing it twice would read as two different applications.
    //
    // Truncated to what the envelope allows, most recent first. This envelope also carries the
    // grant list and is what revoking and the cleanup answer with, so an auxiliary history that
    // outgrew its bound must not be able to make the whole thing fail to parse — that would take
    // away the screen the user revokes permissions from.
    for (const totals of this.deps.persistence.listComputerAppAccessRequestTotals()) {
      if (requestedApps.length >= COMPUTER_USE_REQUESTED_APP_LIST_LIMIT) break;
      if (granted.has(`${totals.platform}:${totals.grantIdentityDigest}`)) continue;
      const view = computerAppAccessRequestViewSchema.safeParse({
        platform: totals.platform,
        appId: totals.appId,
        untrustedDisplayName: sanitizeUntrustedTargetLabel(totals.displayName),
        requestCount: totals.requestCount,
        denialCount: totals.denialCount,
        lastRequestedAt: totals.lastRequestedAt,
      });
      if (view.success) requestedApps.push(view.data);
    }
    // The store refuses to create more grants than this, so the slice is the belt: raising that
    // ceiling without raising the contract's would otherwise break the list rather than shorten it.
    if (grants.length > COMPUTER_USE_GRANT_LIST_LIMIT)
      grants.length = COMPUTER_USE_GRANT_LIST_LIMIT;
    return { grants, discardedRecords, requestedApps };
  }

  /**
   * Removes grant rows that no longer authenticate, at the user's request (T14).
   *
   * Never automatic. A row whose MAC fails is already treated as absent, so nothing is gained by
   * deleting it behind the user's back — and the count of such rows is the only evidence that
   * something rewrote the database, which a silent cleanup would erase. The usual cause is benign
   * (the per-install key was regenerated, so every row fails at once), and without this those rows
   * would stay forever: the ordinary revoke path refuses to delete a row it cannot read.
   */
  purgeInvalidAppGrants(): ComputerUseGrantPurgeResult {
    const removedRecords = this.deps.persistence.purgeUnauthenticatedComputerAppGrants();
    return { ...this.listAppGrantViews(), removedRecords };
  }

  /**
   * Records a permanent grant for one verified identity (ADR v2 §6.2, §6.5).
   *
   * Internal in this slice: the only intended caller is S3b's approval card, after a trusted click
   * whose intent digest already matched a freshly re-taken identity. It refuses an identity it
   * cannot derive or that the ruleset denies, so a mis-wired caller cannot widen the deny list.
   */
  createAppGrant(
    identity: unknown,
    input: Readonly<{
      displayName?: string | undefined;
      maxMode: ComputerUseMode;
      providerEgress: Readonly<{ connectionId: string; modelId: string }> | null;
    }>,
  ): ComputerAppGrantRecord {
    const derived = this.appGrantIdentityFor(identity);
    if (derived === null) throw new Error('Computer Use application cannot be granted');
    return this.deps.persistence.createComputerAppGrant({
      identity: derived,
      // Sanitised before it is stored as well as before it is shown. Storing the raw string would
      // put app-authored control characters in the database, where the next reader is whichever
      // surface forgets to sanitise; the verified app id is the fallback when nothing is left.
      displayName: sanitizeUntrustedTargetLabel(
        typeof input.displayName === 'string' && input.displayName.trim() !== ''
          ? input.displayName
          : derived.appId,
      ),
      maxMode: input.maxMode,
      denyRulesetVersion: COMPUTER_USE_DENY_RULESET_VERSION,
      providerEgress: input.providerEgress,
    });
  }

  /**
   * Revokes one grant and stops whatever was using it (ADR v2 §6.5).
   *
   * The store write happens first. If stopping a session threw, a grant that the user asked to
   * remove would otherwise still be in the table — the stop is best-effort cleanup of something
   * already forbidden, not a precondition for forbidding it.
   */
  async revokeAppGrant(grantId: string, expectedRevision: number): Promise<void> {
    const grant = this.deps.persistence.getComputerAppGrant(grantId);
    this.deps.persistence.removeComputerAppGrant(grantId, expectedRevision);
    // Tokens naming this application are worthless now, and a live session must not keep driving an
    // application whose permission was just withdrawn.
    const revoked = (profileId: string): boolean =>
      this.profileGrantIdentityDigest(profileId) === grant.grantIdentityDigest;
    // A Task-scoped "allow once" for the same application goes too. The user asked for this
    // application to stop being permitted, and leaving the weaker agreement standing would mean the
    // revoke button removed a row while the application kept running.
    const scopedKey = `${grant.platform}:${grant.grantIdentityDigest}`;
    for (const [taskId, scoped] of this.taskScopedGrants) {
      scoped.delete(scopedKey);
      if (scoped.size === 0) this.taskScopedGrants.delete(taskId);
    }
    for (const [token, record] of this.targetTokens)
      if (revoked(record.profileId)) this.targetTokens.delete(token);
    for (const [token, record] of this.targetAppTokens)
      if (revoked(record.profileId)) this.targetAppTokens.delete(token);
    // Starts in flight, before anything reaches `sessions`. A start that is waiting on native or on
    // the planner would otherwise finish and become a live session for an application the user has
    // just revoked — the same hole `policyEpochChanged` closes for a permission change.
    if (this.startingProfileId !== null && revoked(this.startingProfileId))
      this.startingController?.abort(new Error('Computer Use application grant was revoked'));
    for (const starting of this.startingSessions.values())
      if (revoked(starting.profileId)) {
        starting.reason = 'policy_changed';
        starting.controller.abort(new Error('Computer Use application grant was revoked'));
      }
    await Promise.all(
      [...this.sessions.values()]
        .filter(
          (session) =>
            computerAppGrantIdentityFrom(session.profile.identity)?.grantIdentityDigest ===
            grant.grantIdentityDigest,
        )
        .map((session) => this.stop(session.status.sessionId, 'policy_changed')),
    );
  }

  /** Marks a grant used now, and records a signed application having been updated (§6.2.1). */
  touchAppGrantUsed(identity: unknown): void {
    const derived = computerAppGrantIdentityFrom(identity);
    if (derived === null) return;
    const stored = this.deps.persistence.findComputerAppGrantByIdentity(
      derived.platform,
      derived.grantIdentityDigest,
    );
    if (stored === null) return;
    this.deps.persistence.touchComputerAppGrantUsed(
      stored.id,
      new Date(this.now()).toISOString(),
      derived,
    );
  }

  private profileGrantIdentityDigest(profileId: string): string | null {
    try {
      return (
        computerAppGrantIdentityFrom(
          this.deps.persistence.getComputerAppProfile(profileId).identity,
        )?.grantIdentityDigest ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * Whether an application may be driven without a fresh card, and on whose authority.
   *
   * **The single decision point.** `computer_start` asks this and nothing else; the enumeration's
   * `granted` flag is this; the card asks it to decide whether it is needed at all. Two ways to be
   * granted: a v2 grant row that authenticates, or a Task-scoped "allow once" from this Task's own
   * card. A V1 profile's "remember" is not one — see `ComputerAppGrantScopeKind`.
   *
   * Provider egress consent is reported but never gates `granted`: §6.4 keeps the two agreements
   * apart, so a granted application whose screen may not yet go to this model is granted, and it is
   * the *destination* that gets re-asked.
   */
  private appGrantState(
    profile: ComputerAppProfileRecord,
    taskId: string | null,
  ): ComputerAppGrantState {
    // A denied class is never granted, whatever a V1 registration or an earlier card says.
    // `listTargets` already filters these out before asking, so this is the belt rather than the
    // braces — but a future caller that forgets the filter must not be handed a granted terminal.
    if (computerUseAppIdentityIsDenied(profile.identity)) return COMPUTER_APP_UNGRANTED;
    const grant = this.appGrantFor(profile.identity);
    if (grant !== null)
      return Object.freeze({
        granted: true,
        scope: 'grant' as const,
        grantId: grant.id,
        maxMode: grant.maxMode,
        providerEgress:
          grant.providerEgressConnectionId === null || grant.providerEgressModelId === null
            ? null
            : Object.freeze({
                connectionId: grant.providerEgressConnectionId,
                modelId: grant.providerEgressModelId,
              }),
      });
    const scoped = taskId === null ? null : this.taskScopedGrantFor(taskId, profile);
    if (scoped !== null)
      return Object.freeze({
        granted: true,
        scope: 'task' as const,
        grantId: null,
        maxMode: scoped.maxMode,
        providerEgress: scoped.providerEgress,
      });
    return COMPUTER_APP_UNGRANTED;
  }

  /** The key a Task-scoped grant is filed under. Platform included: a digest alone is not an app. */
  private taskScopedGrantKey(identity: ComputerAppGrantIdentity): string {
    return `${identity.platform}:${identity.grantIdentityDigest}`;
  }

  /**
   * This Task's "allow once" for an application, if it still means what it meant.
   *
   * A stale entry is dropped rather than ignored: leaving it in the map would let it come back if
   * the epoch happened to return to its old value, and the map is the only record of it.
   */
  private taskScopedGrantFor(
    taskId: string,
    profile: ComputerAppProfileRecord,
  ): TaskScopedAppGrant | null {
    const scoped = this.taskScopedGrants.get(taskId);
    if (scoped === undefined) return null;
    const identity = computerAppGrantIdentityFrom(profile.identity);
    if (identity === null) return null;
    const key = this.taskScopedGrantKey(identity);
    const entry = scoped.get(key);
    if (entry === undefined) return null;
    if (
      entry.platform !== identity.platform ||
      entry.grantIdentityDigest !== identity.grantIdentityDigest ||
      entry.denyRulesetVersion !== COMPUTER_USE_DENY_RULESET_VERSION ||
      entry.policyEpoch !== this.currentPolicyEpoch(taskId)
    ) {
      scoped.delete(key);
      if (scoped.size === 0) this.taskScopedGrants.delete(taskId);
      return null;
    }
    return entry;
  }

  /** Whether two readings of the grant state describe the same agreement. */
  private static grantStateMatches(
    left: ComputerAppGrantState,
    right: ComputerAppGrantState,
  ): boolean {
    return (
      left.granted === right.granted &&
      left.scope === right.scope &&
      left.grantId === right.grantId &&
      left.maxMode === right.maxMode &&
      left.providerEgress?.connectionId === right.providerEgress?.connectionId &&
      left.providerEgress?.modelId === right.providerEgress?.modelId
    );
  }

  /**
   * The agent-facing enumeration (ADR v2 §5.2).
   *
   * S2 does not change native, so the only windows that can be enumerated are those of applications
   * a person already registered — the V1 allow-list. The shape, the tokens, and the privacy rules
   * are the v2 ones, so S4/S5 can widen the source without widening what crosses the boundary.
   *
   * Every call rotates this Task's tokens. That is not tidiness: a token names one window at one
   * policy epoch and one profile revision, and letting an older set survive a re-enumeration would
   * leave the agent holding a reference to a window the list no longer describes.
   */
  async listTargets(
    input: Readonly<{ appToken?: string | undefined; refresh?: boolean | undefined }>,
    context: ToolExecutionContext,
  ): Promise<ComputerListTargetsOutput> {
    if (this.disposed) throw new Error('Computer Use controller is disposed');
    if (this.deps.agentDrivenEnabled?.() !== true)
      throw new Error('Computer Use agent-driven targets are unavailable');
    if (!this.availability().available)
      throw new Error('Computer Use native boundary is unavailable');
    const policyEpoch = this.currentPolicyEpoch(context.taskId);
    if (context.policyEpoch !== policyEpoch) throw new Error('Computer Use policy epoch changed');
    // `refresh` is accepted for the ADR's tool shape; every call re-enumerates from native anyway,
    // and a cached answer would be a second source of truth for a security decision.
    const profiles = this.deps.persistence
      .listComputerAppProfiles()
      .filter((profile) => !computerUseAppIdentityIsDenied(profile.identity))
      .sort((left, right) => left.id.localeCompare(right.id));
    const selectedProfileId =
      input.appToken === undefined
        ? null
        : this.resolveTargetAppProfileId(input.appToken, context, policyEpoch, profiles);
    this.revokeTargetTokens(context.taskId);
    const egressBinding =
      this.deps.providerEgressBindingFor?.(context.taskId, context.turnId) ?? null;
    const expiresAt = this.now() + COMPUTER_USE_WINDOW_CANDIDATE_TTL_MS;
    // Held with the profile that produced each row, because the last thing this method does is ask
    // the store whether those profiles still say what they said when the row was built.
    const pending: {
      profileId: string;
      appToken: string;
      targetToken: string;
      labelled: boolean;
      target: SelectableComputerTarget;
    }[] = [];
    const snapshots = new Map<string, TargetEnumerationSnapshot>();
    let truncated = false;
    let dropped = 0;
    for (const profile of profiles) {
      if (selectedProfileId !== null && profile.id !== selectedProfileId) continue;
      // One unreachable application must not blank the whole list; the agent still needs the rest.
      const windows = await this.listNativeWindows(profile).catch(() => []);
      // Native took time to answer. A permission revoked meanwhile has already cleared this Task's
      // tokens, so minting new ones — or returning titles that were read under the old policy —
      // would let this call outlive the revocation. Nothing after this point awaits again.
      if (this.disposed || this.currentPolicyEpoch(context.taskId) !== policyEpoch) {
        this.revokeTargetTokens(context.taskId);
        throw new Error('Computer Use policy epoch changed');
      }
      const appToken = randomUUID();
      const appBinding = {
        taskId: context.taskId,
        turnId: context.turnId,
        policyEpoch,
        platform: profile.platform,
        appIdentityDigest: profile.identityDigest,
        profileRevision: profile.revision,
      } as const;
      const grantState = this.appGrantState(profile, context.taskId);
      snapshots.set(profile.id, { profile, grantState });
      let issued = false;
      let windowIndex = 0;
      for (const window of windows.filter(({ eligible }) => eligible !== false)) {
        windowIndex += 1;
        if (pending.length >= COMPUTER_TARGET_LIST_LIMIT) {
          truncated = true;
          break;
        }
        const targetToken = randomUUID();
        // From the grant, not from the profile row: the row is unauthenticated (T14), and a
        // rewritten consent flag must not be what sends an application's window title out.
        const labelled = ComputerUseController.egressAgreed(grantState, egressBinding);
        // Validated per row rather than only in the final envelope. A single malformed profile —
        // one with no app id, or a path the leaf name cannot be taken from — would otherwise throw
        // from the envelope parse and take every other application's windows down with it.
        const row = selectableComputerTargetSchema.safeParse({
          kind: 'selectable',
          targetToken,
          appToken,
          verified: computerTargetVerifiedIdentity(profile),
          windowIndex,
          // A v2 grant, or a V1 profile the user registered and asked to remember (see
          // `appGrantState`). Only this flag changes shape under the new gate; the V1 UI route
          // reads neither this method nor the grant table.
          granted: grantState.granted,
          mode: bindComputerUseMaximumMode(profile.mode, window.maximumMode),
          untrustedLabel: labelled
            ? computerTargetUntrustedLabel(profile.label, window.title)
            : null,
        });
        if (!row.success) {
          dropped += 1;
          continue;
        }
        this.targetTokens.set(
          targetToken,
          Object.freeze({
            binding: Object.freeze({
              ...appBinding,
              windowIdentityDigest: window.windowIdentityDigest,
              nativeWindowId: window.windowId,
            }),
            profileId: profile.id,
            expiresAt,
          }),
        );
        issued = true;
        pending.push({
          profileId: profile.id,
          appToken,
          targetToken,
          labelled,
          target: row.data,
        });
      }
      if (issued)
        this.targetAppTokens.set(
          appToken,
          Object.freeze({ binding: appBinding, profileId: profile.id, expiresAt }),
        );
      if (truncated) break;
    }
    // Re-read every contributing application as the store has it now.
    //
    // The epoch check above only catches a *permission* change. Re-registering an application takes
    // a different route: it updates the row in place, moves its revision, and puts its provider
    // egress consent back to false — all without touching the Task's policy epoch. A long
    // enumeration can straddle that, so a row built from the first application can be handed back
    // carrying a window title the user has just withdrawn consent for. A stale row is dropped whole,
    // token included, rather than merely stripped of its label: the revision is part of the token
    // binding, so keeping the token would hand S3 a reference to a revision that no longer exists.
    //
    // Revoking a grant is the third route that changes a row without moving the policy epoch, so
    // the grant a row was built against is re-read here too (ADR v2 §6.5: revoking stops what was
    // using it, and must not hand back a token minted a moment earlier).
    //
    // Nothing below awaits, so this is the state the caller receives.
    const stale = new Set<string>();
    for (const [profileId, snapshot] of snapshots)
      if (!this.targetProfileUnchanged(snapshot, context.taskId)) stale.add(profileId);
    const targets: ComputerTarget[] = [];
    for (const row of pending) {
      if (!stale.has(row.profileId)) {
        targets.push(row.target);
        continue;
      }
      dropped += 1;
      this.targetTokens.delete(row.targetToken);
      this.targetAppTokens.delete(row.appToken);
    }
    if (dropped > 0)
      // Counted, never quoted: the reason a row failed is derived from app-authored text, and the
      // agent is not told that some windows exist but could not be described.
      secureLogger.warn('Computer Use omitted target rows that could not be described', {
        taskId: context.taskId,
        dropped,
      });
    return computerListTargetsOutputSchema.parse({ targets, truncated });
  }

  /**
   * `computer_stop` (ADR v2 §5.2), restricted to the calling Task's own sessions.
   *
   * An unknown session id and another Task's session id fail identically, so a tool call cannot be
   * used to probe which sessions exist elsewhere.
   */
  async stopForAgent(sessionId: string, context: ToolExecutionContext): Promise<void> {
    if (this.deps.agentDrivenEnabled?.() !== true)
      throw new Error('Computer Use agent-driven targets are unavailable');
    const ownerTaskId =
      this.sessions.get(sessionId)?.status.taskId ??
      this.startingSessions.get(sessionId)?.taskId ??
      null;
    if (ownerTaskId === null || ownerTaskId !== context.taskId)
      throw new Error('Computer Use session is not owned by this Task');
    await this.stop(sessionId, 'agent_stop');
  }

  /**
   * What a live `targetToken` currently names, or null when it is unknown or expired.
   *
   * S3's `computer_start` reads this to build the expected binding it then re-verifies against
   * native. It answers null rather than a stale record, so a caller that forgets to re-check a
   * single field still cannot spend a token issued under a different epoch.
   */
  targetTokenBinding(token: string): ComputerTargetTokenBinding | null {
    const record = this.targetTokens.get(token);
    if (record === undefined) return null;
    return (
      resolveComputerTargetToken(this.targetTokens, token, record.binding, this.now())?.binding ??
      null
    );
  }

  /**
   * Whether an application still says what it said when its rows were built.
   *
   * Synchronous and total: a removed row, a moved revision, a changed identity, an application that
   * has since become a denied class, or consent that no longer covers this Turn's destination all
   * answer false. It never throws, because it runs on the return path where a throw would discard a
   * whole enumeration over one application that simply went away.
   */
  private targetProfileUnchanged(snapshot: TargetEnumerationSnapshot, taskId: string): boolean {
    let current: ComputerAppProfileRecord;
    try {
      current = this.deps.persistence.getComputerAppProfile(snapshot.profile.id);
    } catch {
      return false;
    }
    if (
      current.revision !== snapshot.profile.revision ||
      current.identityDigest !== snapshot.profile.identityDigest ||
      computerUseAppIdentityIsDenied(current.identity)
    )
      return false;
    // The grant as it reads now, compared against the one the row was built on. Compared field by
    // field rather than by the store row's `revision`, which also moves when a counter is touched:
    // dropping a valid row because the agent's request count went up would be a denial of service
    // dressed as caution. A revoke, an approval, and an egress consent change all move a field.
    if (
      !ComputerUseController.grantStateMatches(
        this.appGrantState(current, taskId),
        snapshot.grantState,
      )
    )
      return false;
    // The label's consent is part of the grant state compared above, so an agreement that moved has
    // already dropped the row.
    return true;
  }

  /** Whether the agreement in force covers sending this application's screen to this destination. */
  private static egressAgreed(
    state: ComputerAppGrantState,
    egressBinding: Readonly<{ connectionId: string; modelId: string }> | null,
  ): boolean {
    return (
      egressBinding !== null &&
      state.granted &&
      state.providerEgress !== null &&
      state.providerEgress.connectionId === egressBinding.connectionId &&
      state.providerEgress.modelId === egressBinding.modelId
    );
  }

  private resolveTargetAppProfileId(
    appToken: string,
    context: ToolExecutionContext,
    policyEpoch: number,
    profiles: readonly ComputerAppProfileRecord[],
  ): string {
    // The stored profile id only selects which profile to validate against; the binding check below
    // is what decides whether this token is usable, and it covers the Task, Turn, and epoch.
    const claimed = this.targetAppTokens.get(appToken);
    const profile =
      claimed === undefined
        ? undefined
        : profiles.find((candidate) => candidate.id === claimed.profileId);
    const resolved =
      profile === undefined
        ? null
        : resolveComputerTargetAppToken(
            this.targetAppTokens,
            appToken,
            {
              taskId: context.taskId,
              turnId: context.turnId,
              policyEpoch,
              platform: profile.platform,
              appIdentityDigest: profile.identityDigest,
              profileRevision: profile.revision,
            },
            this.now(),
          );
    if (resolved === null) throw new Error('Computer Use target token is not valid');
    return resolved.profileId;
  }

  /**
   * Drops this Task's tokens, and every expired token of any Task.
   *
   * An expired token is already unresolvable, so the sweep is about memory rather than authority: a
   * Task that lists once and never lists again would otherwise leave its entries in the map for the
   * lifetime of the process.
   */
  private revokeTargetTokens(taskId: string): void {
    const now = this.now();
    for (const [token, record] of this.targetTokens)
      if (record.binding.taskId === taskId || now >= record.expiresAt)
        this.targetTokens.delete(token);
    for (const [token, record] of this.targetAppTokens)
      if (record.binding.taskId === taskId || now >= record.expiresAt)
        this.targetAppTokens.delete(token);
  }

  /**
   * `computer_request_access` (ADR v2 §5.2, §6.1).
   *
   * The only route from a tool call to a card, and the card is the only route to a grant. Nothing
   * here can approve: every path either answers from an agreement that already exists, refuses with
   * a fixed reason code, or parks until a person clicks. The reason codes are deliberately coarse —
   * an unknown token, another Task's token, an expired token and a forbidden class all answer the
   * same thing, so the tool cannot be used to enumerate what exists elsewhere.
   */
  async requestAccess(
    input: Readonly<{ appToken: string; reason: string }>,
    context: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<ComputerRequestAccessOutput> {
    if (this.disposed || this.deps.agentDrivenEnabled?.() !== true)
      return this.accessRefused('access_request_unavailable');
    if (!this.availability().available) return this.accessRefused('access_request_unavailable');
    // Without a surface to show the card on, waiting would park the call until its timeout.
    if (this.deps.publishGrantRequest === undefined)
      return this.accessRefused('access_request_unavailable');
    const policyEpoch = this.currentPolicyEpoch(context.taskId);
    if (context.policyEpoch !== policyEpoch)
      return this.accessRefused('access_request_invalid_token');
    const profiles = this.deps.persistence
      .listComputerAppProfiles()
      .filter((profile) => !computerUseAppIdentityIsDenied(profile.identity));
    let profileId: string;
    try {
      profileId = this.resolveTargetAppProfileId(input.appToken, context, policyEpoch, profiles);
    } catch {
      return this.accessRefused('access_request_invalid_token');
    }
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (profile === undefined) return this.accessRefused('access_request_invalid_token');
    const identity = this.appGrantIdentityFor(profile.identity);
    if (identity === null) return this.accessRefused('access_request_invalid_token');
    const egressBinding =
      this.deps.providerEgressBindingFor?.(context.taskId, context.turnId) ?? null;
    // Without knowing where this Turn sends, there is no sentence to put on the card and no pair to
    // record consent against, so there is nothing a click could agree to.
    if (egressBinding === null) return this.accessRefused('access_request_unavailable');
    const state = this.appGrantState(profile, context.taskId);
    const egressAgreed =
      state.providerEgress !== null &&
      state.providerEgress.connectionId === egressBinding.connectionId &&
      state.providerEgress.modelId === egressBinding.modelId;
    // Already agreed, in full: the second and later requests cost the user nothing (§7.2).
    if (state.granted && egressAgreed) return { granted: true, reasonCode: null };
    const kind = state.granted ? ('provider-egress' as const) : ('app-grant' as const);
    const denial = this.deps.persistence.getComputerAppAccessRequest(
      identity.platform,
      identity.grantIdentityDigest,
      context.taskId,
    );
    // A refusal is final for this Task, and a different Task may ask again (§6.1).
    if (denial?.denied === true) return this.accessRefused('access_request_denied_in_task');
    if (this.pendingAppGrantRequest !== null) return this.accessRefused('access_request_pending');
    if (
      (this.accessRequestsByTurn.get(context.turnId) ?? 0) >= COMPUTER_ACCESS_REQUEST_TURN_LIMIT ||
      this.deps.persistence.countComputerAppAccessRequestsForTask(context.taskId) >=
        COMPUTER_ACCESS_REQUEST_TASK_LIMIT
    )
      return this.accessRefused('access_request_rate_limited');
    // The same live enumeration the click will re-run, so both sides compute the ceiling from
    // native rather than one from native and one from the store.
    const observed = await this.refetchAppGrantFacts(profile.id);
    if (observed === null || observed.identity.grantIdentityDigest !== identity.grantIdentityDigest)
      return this.accessRefused('access_request_invalid_token');
    // `policyEpochChanged` withdraws the card that exists; while native was answering there was no
    // card to withdraw, and a policy change does not abort this dispatch either. Raising now would
    // put a card bound to the old epoch on screen, so the epoch is read again on this side of the
    // await — the same answer a token from before the change gets.
    if (this.currentPolicyEpoch(context.taskId) !== policyEpoch)
      return this.accessRefused('access_request_invalid_token');
    // A Turn that is already gone has nobody left to click, and the card holds the single global
    // slot for two minutes. Checked before raising, and again through the listener below.
    if (signal?.aborted === true) return this.accessRefused('access_request_withdrawn');
    if (this.pendingAppGrantRequest !== null) return this.accessRefused('access_request_pending');
    return await this.raiseAppGrantCard({
      context,
      kind,
      profile: observed.profile,
      identity: observed.identity,
      facts: observed.facts,
      policyEpoch,
      appToken: input.appToken,
      reason: input.reason,
      providerEgress: egressBinding,
      grantId: state.grantId,
      grantedMaxMode: state.granted ? state.maxMode : null,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private accessRefused(reasonCode: ComputerAccessRequestReasonCode): ComputerRequestAccessOutput {
    return computerRequestAccessOutputSchema.parse({ granted: false, reasonCode });
  }

  /**
   * The verified facts the card asserts, and that the click must still find true (§6.1.1).
   *
   * `maximumMode` is the ceiling the grant would actually carry: the profile's stored attestation
   * bound by what native says *now* about the windows it is offering. It is taken from a live
   * enumeration on both sides — when the card is raised and again when it is clicked — because a
   * value read from the store on one side and from native on the other would compare two different
   * questions and always agree.
   *
   * **The weakest eligible window wins.** A session binds one window, and which one is not known
   * until `computer_start`; promising the strongest and then binding a window native attests lower
   * would mean the user read a ceiling the grant does not have. The stored grant is a ceiling for
   * every future session with this application, so it has to be one that all of them can honour.
   */
  private appGrantCardFacts(
    profile: ComputerAppProfileRecord,
    identity: ComputerAppGrantIdentity,
    windows: readonly ComputerUseNativeWindow[],
  ): ComputerAppGrantCardFacts | null {
    const eligible = windows.filter((window) => window.eligible !== false);
    if (eligible.length === 0) return null;
    const attested = eligible.reduce<ComputerUseMode>(
      (weakest, window) => bindComputerUseMaximumMode(weakest, window.maximumMode),
      maximumModeForProfile(profile),
    );
    return Object.freeze({
      platform: identity.platform,
      identityKind: identity.identityKind,
      publisher: identity.publisher,
      appId: identity.appId,
      grantIdentityDigest: identity.grantIdentityDigest,
      denied: computerUseAppIdentityIsDenied(profile.identity),
      maximumMode: attested,
    });
  }

  /**
   * Re-takes the application's identity from the native boundary (ADR v2 §6.1.1, §6.2.1).
   *
   * S3b adds no native call: re-enumerating the application's windows is the dynamic check this
   * slice can make, and it is a real one. `listWindows` answers from the running processes, filters
   * on the identity digest the store holds, re-derives the mode ceiling per window, and — on
   * Windows — refreshes the executable digest, which throws outright when the running image is not
   * the one the profile was written for. An application that has exited, been replaced, or lost
   * every eligible window therefore cannot pass. S4/S5 replace this with a pid-based signature
   * check without changing what the caller compares.
   */
  private async refetchAppGrantFacts(profileId: string): Promise<Readonly<{
    profile: ComputerAppProfileRecord;
    identity: ComputerAppGrantIdentity;
    facts: ComputerAppGrantCardFacts;
  }> | null> {
    let profile: ComputerAppProfileRecord;
    let windows: readonly ComputerUseNativeWindow[];
    try {
      profile = this.deps.persistence.getComputerAppProfile(profileId);
      windows = await this.listNativeWindows(profile);
      profile = this.refreshSignedWindowsProfile(profile, windows);
    } catch {
      return null;
    }
    const identity = computerAppGrantIdentityFrom(profile.identity);
    if (identity === null) return null;
    // From this enumeration, not from the store: the attested ceiling is one of the facts, and a
    // native boundary that has lowered it since the card was raised has to stop the grant.
    const facts = this.appGrantCardFacts(profile, identity, windows);
    return facts === null ? null : Object.freeze({ profile, identity, facts });
  }

  /** Builds one card, publishes it, and resolves when a person answers or the card lapses. */
  private async raiseAppGrantCard(
    input: Readonly<{
      context: ToolExecutionContext;
      kind: 'app-grant' | 'provider-egress';
      profile: ComputerAppProfileRecord;
      identity: ComputerAppGrantIdentity;
      facts: ComputerAppGrantCardFacts;
      policyEpoch: number;
      appToken: string;
      reason: string;
      providerEgress: Readonly<{ connectionId: string; modelId: string }>;
      grantId: string | null;
      grantedMaxMode: ComputerUseMode | null;
      signal?: AbortSignal | undefined;
    }>,
  ): Promise<ComputerRequestAccessOutput> {
    const requestId = randomUUID();
    const identityDigest = computerAppGrantIntentDigest({
      appToken: input.appToken,
      grantIdentityDigest: input.identity.grantIdentityDigest,
      denyRulesetVersion: COMPUTER_USE_DENY_RULESET_VERSION,
      policyEpoch: input.policyEpoch,
      taskId: input.context.taskId,
    });
    const allowedDecisions = computerAppGrantAllowedDecisions(input.kind);
    const activationIntents: Record<string, string> = {};
    for (const decision of allowedDecisions)
      if (decision !== 'deny')
        activationIntents[decision] = appGrantActivationIntent({
          requestId,
          expectedRevision: 1,
          decision,
          identityDigest,
        });
    const displayName = sanitizeUntrustedTargetLabel(input.profile.label);
    const request = computerAppGrantRequestSchema.parse({
      id: requestId,
      taskId: input.context.taskId,
      kind: input.kind,
      state: 'pending',
      revision: 1,
      decision: null,
      noticeCode: null,
      verified: {
        platform: input.facts.platform,
        identityKind: input.facts.identityKind,
        publisher: input.facts.publisher,
        appId: input.facts.appId,
        // A destination-only card describes the agreement that already exists, so it shows that
        // agreement's ceiling rather than everything native could attest.
        maxMode:
          input.grantedMaxMode === null
            ? input.facts.maximumMode
            : bindComputerUseMaximumMode(input.grantedMaxMode, input.facts.maximumMode),
      },
      untrustedAppName: displayName,
      untrustedReason: sanitizeComputerAccessReason(input.reason),
      providerEgressModelId: input.providerEgress.modelId,
      allowedDecisions,
      activationIntents,
      expiresAt: new Date(this.now() + COMPUTER_ACCESS_REQUEST_TIMEOUT_MS).toISOString(),
    });
    // Counted before the card is shown, and only for a card that is actually shown (T8). Both
    // stores are written: the grant row carries the counters for an application the user already
    // granted, and the Task-scoped table carries them for one that has no row yet.
    this.deps.persistence.recordComputerAppAccessRequest({
      platform: input.identity.platform,
      grantIdentityDigest: input.identity.grantIdentityDigest,
      taskId: input.context.taskId,
      appId: input.identity.appId,
      displayName,
      outcome: 'requested',
    });
    if (input.grantId !== null)
      try {
        this.deps.persistence.countComputerAppGrantAccessRequest(input.grantId, 'requested');
      } catch {
        // A grant revoked between the read above and here is not this call's problem: the card is
        // still correct, and the counter is a display fact.
      }
    this.accessRequestsByTurn.set(
      input.context.turnId,
      (this.accessRequestsByTurn.get(input.context.turnId) ?? 0) + 1,
    );
    return await new Promise<ComputerRequestAccessOutput>((resolve) => {
      let settled = false;
      const abandon = (): void =>
        this.closeAppGrantCard(requestId, 'access_request_withdrawn', 'withdrawn');
      const settle = (outcome: ComputerRequestAccessOutput): void => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', abandon);
        resolve(computerRequestAccessOutputSchema.parse(outcome));
      };
      const timer = setTimeout(
        () => this.closeAppGrantCard(requestId, 'access_request_timed_out', 'timed_out'),
        COMPUTER_ACCESS_REQUEST_TIMEOUT_MS,
      );
      timer.unref?.();
      this.pendingAppGrantRequest = {
        request,
        facts: input.facts,
        identityDigest,
        taskId: input.context.taskId,
        turnId: input.context.turnId,
        policyEpoch: input.policyEpoch,
        profileId: input.profile.id,
        // Held here rather than re-read from the store on the click: §6.1 requires the refusal to
        // be recorded, and a profile that went away while the card was up must not turn "no" into
        // a card that can never be answered.
        identity: input.identity,
        displayName,
        providerEgress: input.providerEgress,
        grantId: input.grantId,
        grantedMaxMode: input.grantedMaxMode,
        timer,
        settle,
      };
      this.deps.publishGrantRequest?.(request);
      // The Turn can be cancelled while the card is on screen. Withdrawing at once frees the single
      // global slot instead of holding it for the rest of the two minutes.
      input.signal?.addEventListener('abort', abandon, { once: true });
    });
  }

  /**
   * Withdraws the card without a decision (ADR v2 §5.2).
   *
   * Every way a card can stop being answerable ends here: the timeout, the Turn being cancelled,
   * the Task being switched away from, and a policy epoch change. All of them fail the tool call
   * closed — the model is told the request did not succeed, never that it did.
   */
  private closeAppGrantCard(
    requestId: string,
    reasonCode: ComputerAccessRequestReasonCode,
    noticeCode: 'timed_out' | 'withdrawn' | 'identity_changed',
  ): void {
    const pending = this.pendingAppGrantRequest;
    if (pending === null || pending.request.id !== requestId) return;
    this.pendingAppGrantRequest = null;
    clearTimeout(pending.timer);
    const canceled = computerAppGrantRequestSchema.parse({
      ...pending.request,
      state: 'canceled',
      decision: null,
      noticeCode,
      revision: pending.request.revision + 1,
    });
    this.deps.publishGrantRequest?.(canceled);
    pending.settle({ granted: false, reasonCode });
  }

  /** Withdraws a card that belongs to a Task or Turn that is no longer the one that raised it. */
  private withdrawAppGrantCardFor(predicate: (pending: PendingAppGrantRequest) => boolean): void {
    const pending = this.pendingAppGrantRequest;
    if (pending !== null && predicate(pending))
      this.closeAppGrantCard(pending.request.id, 'access_request_withdrawn', 'withdrawn');
  }

  /**
   * A person's answer to one card (ADR v2 §6.1.1).
   *
   * The activation is verified by the caller; what is verified here is that the click belongs to
   * *this* card and *this* decision, and then that the application in front of us is still the one
   * whose facts the user read. Deny is exempt from the intent check on purpose: refusing must never
   * be blocked by an intent that went stale while the card was on screen.
   */
  async resolveAppGrantRequest(
    input: ComputerAppGrantResolveInput,
    activationIntent: string | null,
  ): Promise<void> {
    const pending = this.pendingAppGrantRequest;
    if (pending === null || pending.request.id !== input.requestId)
      throw new Error('Computer Use approval card not found');
    if (
      pending.request.revision !== input.expectedRevision ||
      pending.request.state !== 'pending' ||
      !pending.request.allowedDecisions.includes(input.decision)
    )
      throw new Error('Computer Use approval card is stale');
    if (
      input.decision !== 'deny' &&
      activationIntent !==
        appGrantActivationIntent({
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          decision: input.decision,
          identityDigest: pending.identityDigest,
        })
    )
      throw new Error('Computer Use approval card intent does not match');
    if (input.decision === 'deny') {
      this.recordAppGrantDenial(pending);
      this.settleAppGrantCard(pending, input.decision, {
        granted: false,
        reasonCode: 'access_request_denied',
      });
      return;
    }
    const observed = await this.refetchAppGrantFacts(pending.profileId);
    // The card may have been withdrawn while native was answering; nothing below may resurrect it.
    if (this.pendingAppGrantRequest !== pending) return;
    // Checked against the present rather than trusted to the withdrawal above: the intent digest
    // only proves the click matches the card, and a grant must never be written under permissions
    // other than the ones the card was raised under (§6.5).
    if (this.currentPolicyEpoch(pending.taskId) !== pending.policyEpoch) {
      this.closeAppGrantCard(pending.request.id, 'access_request_withdrawn', 'withdrawn');
      return;
    }
    if (observed === null || !computerAppGrantCardFactsMatch(pending.facts, observed.facts)) {
      this.closeAppGrantCard(pending.request.id, 'app_grant_identity_changed', 'identity_changed');
      return;
    }
    if (pending.request.kind === 'provider-egress') {
      // The application's own agreement went away while the card was up. The card only asked about
      // a destination, so it is withdrawn rather than allowed to stand in for the missing grant.
      if (!this.agreeProviderEgress(pending, observed.identity)) {
        this.closeAppGrantCard(pending.request.id, 'access_request_withdrawn', 'withdrawn');
        return;
      }
    } else if (input.decision === 'allow_always')
      this.createAppGrant(observed.profile.identity, {
        displayName: pending.displayName,
        maxMode: observed.facts.maximumMode,
        providerEgress: pending.providerEgress,
      });
    else this.createTaskScopedAppGrant(pending, observed);
    this.settleAppGrantCard(pending, input.decision, { granted: true, reasonCode: null });
  }

  private settleAppGrantCard(
    pending: PendingAppGrantRequest,
    decision: ComputerAppGrantDecision,
    outcome: ComputerRequestAccessOutput,
  ): void {
    if (this.pendingAppGrantRequest !== pending) return;
    this.pendingAppGrantRequest = null;
    clearTimeout(pending.timer);
    this.deps.publishGrantRequest?.(
      computerAppGrantRequestSchema.parse({
        ...pending.request,
        state: 'resolved',
        decision,
        revision: pending.request.revision + 1,
      }),
    );
    pending.settle(outcome);
  }

  /**
   * Writes down that the user said no (ADR v2 §6.1).
   *
   * Every write here is best-effort, and the identity comes from the card rather than from the
   * store. Refusing is the fail-closed answer: it must settle the card whatever else has happened —
   * a profile removed while the card was up, a grant revoked underneath it, a store that throws —
   * because a refusal that fails leaves the card pending and the single global slot taken.
   */
  private recordAppGrantDenial(pending: PendingAppGrantRequest): void {
    try {
      this.deps.persistence.recordComputerAppAccessRequest({
        platform: pending.identity.platform,
        grantIdentityDigest: pending.identity.grantIdentityDigest,
        taskId: pending.taskId,
        appId: pending.identity.appId,
        displayName: pending.displayName,
        outcome: 'denied',
      });
    } catch (error) {
      // The Task itself may be gone, which is the one case the foreign key refuses. Nothing here
      // grants anything, so the count is the only casualty.
      secureLogger.warn('Computer Use could not record an application refusal', {
        taskId: pending.taskId,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (pending.grantId !== null)
      try {
        this.deps.persistence.countComputerAppGrantAccessRequest(pending.grantId, 'denied');
      } catch {
        // See `raiseAppGrantCard`: a counter on a row that has gone away is a display fact.
      }
  }

  /**
   * Records "just this once" (ADR v2 §6.1, D14).
   *
   * Nothing is written to the store. The entry carries the policy epoch and the deny ruleset it was
   * given under, so `appGrantState` — still the single decision point — stops seeing it the moment
   * either moves, without a second code path deciding when an in-memory grant expires.
   */
  private createTaskScopedAppGrant(
    pending: PendingAppGrantRequest,
    observed: Readonly<{ identity: ComputerAppGrantIdentity; facts: ComputerAppGrantCardFacts }>,
  ): void {
    const scoped =
      this.taskScopedGrants.get(pending.taskId) ?? new Map<string, TaskScopedAppGrant>();
    scoped.set(
      this.taskScopedGrantKey(observed.identity),
      Object.freeze({
        platform: observed.identity.platform,
        grantIdentityDigest: observed.identity.grantIdentityDigest,
        maxMode: observed.facts.maximumMode,
        denyRulesetVersion: COMPUTER_USE_DENY_RULESET_VERSION,
        policyEpoch: pending.policyEpoch,
        providerEgress: pending.providerEgress,
      }),
    );
    this.taskScopedGrants.set(pending.taskId, scoped);
  }

  /**
   * Records consent for a new destination, leaving the application's own grant alone (§6.4).
   *
   * The smaller half of the split: A — may this application be driven — is already agreed, and only
   * B — may its screen go to this connection and model — is being asked. Writing A again here would
   * re-ask a question the user already answered.
   */
  private agreeProviderEgress(
    pending: PendingAppGrantRequest,
    identity: ComputerAppGrantIdentity,
  ): boolean {
    if (pending.grantId !== null) {
      try {
        this.deps.persistence.setComputerAppGrantProviderEgress(
          pending.grantId,
          pending.providerEgress,
        );
        return true;
      } catch {
        return false;
      }
    }
    const scoped = this.taskScopedGrants.get(pending.taskId);
    const key = this.taskScopedGrantKey(identity);
    const entry = scoped?.get(key);
    if (scoped !== undefined && entry !== undefined) {
      scoped.set(key, Object.freeze({ ...entry, providerEgress: pending.providerEgress }));
      return true;
    }
    // Neither agreement is there any more — revoked, or its epoch moved — so there is nothing for
    // this consent to attach to. Recording it on its own would manufacture a grant out of a card
    // that only asked about a destination.
    return false;
  }

  /**
   * `computer_start` (ADR v2 §5.2, §5.4).
   *
   * Everything a target token promised is re-verified against the present before native is asked to
   * do anything: the token is spent, the binding is compared against the live Task, Turn and policy
   * epoch, the grant is read through the one decision point, the destination is compared against
   * where this Turn actually sends, and the window identity is re-taken from native. The session
   * itself is then created by the same path the panel uses — one session, one window, one Stop
   * overlay, one cancel epoch.
   *
   * **The call then waits for the session to end**, and this is structural rather than a
   * convenience. The session is bound to the calling Turn: `assertSessionLive` requires that Turn
   * to still be the active one, so returning early would let the Turn finish the moment the model
   * answered and the next round would kill the session it had just started. The tool call in flight
   * is what keeps the Turn open. Everything that could interrupt — an approval, a user takeover, the
   * Stop overlay, the emergency shortcut, the round limit, the session's own expiry — still works;
   * each simply leads to a state the session cannot leave, which is what this returns.
   */
  async startForAgent(
    input: Readonly<{ targetToken: string; goal: string }>,
    context: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<ComputerStartToolOutput> {
    if (this.disposed) throw new Error('Computer Use controller is disposed');
    if (this.deps.agentDrivenEnabled?.() !== true)
      throw new Error('Computer Use agent-driven targets are unavailable');
    // Spent before the first await. Two calls racing with the same token must not both reach
    // native: whichever deletes the entry owns it, and the other sees an unknown token.
    const binding = this.targetTokenBinding(input.targetToken);
    const record = this.targetTokens.get(input.targetToken);
    this.targetTokens.delete(input.targetToken);
    if (binding === null || record === undefined)
      throw new Error('Computer Use target token is not valid');
    const policyEpoch = this.currentPolicyEpoch(context.taskId);
    if (
      binding.taskId !== context.taskId ||
      binding.turnId !== context.turnId ||
      binding.policyEpoch !== policyEpoch ||
      context.policyEpoch !== policyEpoch
    )
      throw new Error('Computer Use target token is not valid');
    // §5.4: stop, list, start. A second session would put two windows under control at once.
    for (const session of this.sessions.values())
      if (session.status.taskId === context.taskId)
        throw new Error('Computer Use session is already running for this Task');
    const profile = this.deps.persistence.getComputerAppProfile(record.profileId);
    if (
      computerUseAppIdentityIsDenied(profile.identity) ||
      profile.revision !== binding.profileRevision ||
      profile.identityDigest !== binding.appIdentityDigest ||
      profile.platform !== binding.platform
    )
      throw new Error('Computer Use target token is not valid');
    const state = this.appGrantState(profile, context.taskId);
    // The single decision point, and the only one. The model is expected to call
    // `computer_request_access` and try again.
    if (!state.granted)
      throw new Error('Computer Use application is not granted: access_not_granted');
    const egressBinding =
      this.deps.providerEgressBindingFor?.(context.taskId, context.turnId) ?? null;
    // Grant-derived, not profile-derived (§6.4): the pair recorded on the agreement has to be the
    // pair this Turn actually sends to, or the screen would travel somewhere nobody consented to.
    if (
      egressBinding === null ||
      state.providerEgress === null ||
      state.providerEgress.connectionId !== egressBinding.connectionId ||
      state.providerEgress.modelId !== egressBinding.modelId
    )
      throw new Error('Computer Use provider egress consent is missing for this model');
    const identity = computerAppGrantIdentityFrom(profile.identity);
    if (identity === null) throw new Error('Computer Use target token is not valid');
    // Checked around every await from here on, not only once the session exists. Native enumeration
    // is the slow part of this path, and a Turn cancelled during it must not go on to focus a
    // window and start driving it.
    signal?.throwIfAborted();
    const observed = await this.refetchAppGrantFacts(profile.id);
    signal?.throwIfAborted();
    if (
      observed === null ||
      observed.identity.grantIdentityDigest !== identity.grantIdentityDigest ||
      observed.profile.revision !== profile.revision
    )
      throw new Error('Computer Use app identity changed');
    const windows = await this.listNativeWindows(observed.profile);
    signal?.throwIfAborted();
    const candidate = windows.find(
      (window) =>
        window.windowId === binding.nativeWindowId &&
        window.windowIdentityDigest === binding.windowIdentityDigest &&
        window.appIdentityDigest === binding.appIdentityDigest &&
        window.eligible !== false,
    );
    if (candidate === undefined) throw new Error('Computer Use window identity changed');
    // Minted here rather than threaded through as a second kind of permit: the shared start path
    // consumes exactly one window candidate, and giving the agent route its own permit type would
    // mean two code paths deciding which window a session binds.
    const windowToken = randomUUID();
    this.windowCandidatePermits.set(
      windowToken,
      Object.freeze({
        profileId: observed.profile.id,
        profileRevision: observed.profile.revision,
        native: candidate,
        expiresAt: this.now() + COMPUTER_USE_WINDOW_CANDIDATE_TTL_MS,
      }),
    );
    const maxMode = state.maxMode ?? 'observe_only';
    // Installed before `start`, so no status published while the session is coming up can be
    // missed — including a session that ends before `start` has even returned. Only one session
    // exists at a time, and this call is holding that slot, so every status seen here is ours.
    const seen = new Map<string, ComputerUseSessionStatus>();
    let onSettled: ((status: ComputerUseSessionStatus) => void) | null = null;
    const unsubscribe = this.subscribe((status) => {
      seen.set(status.sessionId, status);
      if (onSettled !== null && computerUseSessionStateIsSettled(status.state)) onSettled(status);
    });
    try {
      const status = await this.start(
        {
          taskId: context.taskId,
          turnId: context.turnId,
          profileId: observed.profile.id,
          windowId: windowToken,
          // min(grant ceiling, native attestation). `startInternal` binds again against the window
          // and the session, so this can only ever be the weaker of the two.
          mode: bindComputerUseMaximumMode(maxMode, candidate.maximumMode),
          connectionId: egressBinding.connectionId,
          modelId: egressBinding.modelId,
          providerEgressConsent: true,
          providerEgressConsentBinding: egressBinding,
          // Never writes the agreement back onto the V1 profile row: the grant is the record.
          remember: false,
          expectedPolicyEpoch: policyEpoch,
          expectedWindowRevision: candidate.revision,
          expectedProfileRevision: observed.profile.revision,
          agent: {
            goal: computerUseAgentGoal(input.goal),
            grantScope: state.scope ?? 'grant',
            grantId: state.grantId,
            grantIdentityDigest: identity.grantIdentityDigest,
            providerEgress: egressBinding,
          },
        },
        // Carried into the start path so an abort during start-up reaches native's cleanup, the
        // provider preflight and the first planner call, rather than being noticed only afterwards.
        signal,
      );
      // Only a session that actually started counts as use (§6.2.1).
      if (state.scope === 'grant') this.touchAppGrantUsed(observed.profile.identity);
      // Nothing runs between `start` resolving and this line, so anything the session has already
      // published is in `seen`, and anything later arrives through `onSettled`.
      const already = seen.get(status.sessionId) ?? status;
      if (computerUseSessionStateIsSettled(already.state)) return computerStartToolOutput(already);
      return await new Promise<ComputerStartToolOutput>((resolve, reject) => {
        const abandon = (): void => {
          onSettled = null;
          // The same reason `turnEnded` already uses for "the Turn that owned this session is
          // gone". A cancelled Turn is that event, reaching the controller through the broker.
          void this.stop(status.sessionId, 'turn_started').catch(() => undefined);
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error('Computer Use session was canceled with its Turn'),
          );
        };
        onSettled = (settled) => {
          // The single-session rule makes a foreign status here unexpected, not impossible: a late
          // publish for the session that held the slot before this one must not answer this call.
          if (settled.sessionId !== status.sessionId) return;
          onSettled = null;
          signal?.removeEventListener('abort', abandon);
          resolve(computerStartToolOutput(settled));
        };
        if (signal?.aborted === true) {
          abandon();
          return;
        }
        signal?.addEventListener('abort', abandon, { once: true });
      });
    } finally {
      unsubscribe();
      this.windowCandidatePermits.delete(windowToken);
    }
  }

  /**
   * Re-reads the agreement a running agent session depends on (ADR v2 §6.4, §6.5).
   *
   * Called from `assertSessionLive`, so it runs before every round, every action, and every
   * approval — the same cadence the per-round provider egress check runs at. A revoked grant, a
   * ruleset change that forbids the class, or the Task being pointed at a different model all stop
   * the session instead of letting the next round send a screenshot under an agreement that has
   * gone away.
   */
  private assertAgentGrantStillHolds(record: SessionRecord): void {
    const agent = record.agent;
    if (agent === null) return;
    const state = this.appGrantState(
      this.deps.persistence.getComputerAppProfile(record.profile.id),
      record.status.taskId,
    );
    if (
      !state.granted ||
      state.scope !== agent.grantScope ||
      state.grantId !== agent.grantId ||
      state.providerEgress === null ||
      state.providerEgress.connectionId !== agent.providerEgress.connectionId ||
      state.providerEgress.modelId !== agent.providerEgress.modelId
    ) {
      void this.stop(record.status.sessionId, 'policy_changed');
      throw new Error('Computer Use application grant changed');
    }
  }

  /**
   * `externalSignal` is the calling Turn's, supplied only by `computer_start`. The panel's own
   * start has no caller to be cancelled by; its session is cancelled through Stop and the overlay.
   */
  async start(
    input: ComputerUseStartRequest,
    externalSignal?: AbortSignal,
  ): Promise<ComputerUseSessionStatus> {
    if (this.disposed) throw new Error('Computer Use controller is disposed');
    input = {
      ...input,
      maxRounds: computerUseRoundLimitSchema.parse(
        input.maxRounds ?? COMPUTER_USE_LIMITS.maxRounds,
      ),
    };
    if (input.resumeSessionId !== undefined) return this.resume(input);
    if (this.sessions.size !== 0 || this.startingSessions.size !== 0 || this.startInProgress)
      throw new Error('Only one Computer Use session is allowed');
    this.startInProgress = true;
    const controller = new AbortController();
    this.startingController = controller;
    this.startingTaskId = input.taskId;
    this.startingProfileId = input.profileId;
    // Linked to *this* start's own controller, never the other way round: an abort of the caller
    // cancels this start-up — the native session handshake's cleanup, the provider preflight, the
    // first planner call — and nothing here can abort anybody else's.
    const forward = (): void =>
      controller.abort(
        externalSignal?.reason instanceof Error
          ? externalSignal.reason
          : new Error('Computer Use start was canceled'),
      );
    if (externalSignal?.aborted === true) forward();
    else externalSignal?.addEventListener('abort', forward, { once: true });
    try {
      return await this.startInternal(input, controller);
    } catch (error) {
      if (!controller.signal.aborted)
        controller.abort(error instanceof Error ? error : new Error('Computer Use start failed'));
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', forward);
      if (this.startingController === controller) this.startingController = null;
      if (this.startingTaskId === input.taskId) {
        this.startingTaskId = null;
        this.startingProfileId = null;
      }
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
      input.maxRounds !== record.status.maxRounds ||
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
    if (
      this.deps.canStartSession?.(
        record.status.taskId,
        record.syntheticTurn ? null : record.turnId,
      ) === false
    )
      throw new Error('Computer Use requires an idle Task without active Team work');
    if (record.status.round >= record.status.maxRounds)
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
    // Null for the panel's synthetic Turn, and the calling Turn for `computer_start`. The whole
    // start path is checked against this one value, so a session started from inside a Turn is
    // bound to that Turn rather than to "no Turn is running".
    const ownerTurnId = input.turnId ?? null;
    if (this.deps.canStartSession?.(input.taskId, ownerTurnId) === false)
      throw new Error('Computer Use requires an idle Task without active Team work');
    computerUseModeSchema.parse(input.mode);
    const profile = this.deps.persistence.getComputerAppProfile(input.profileId);
    if (computerUseAppIdentityIsDenied(profile.identity))
      throw new Error('Computer Use cannot target this application class');
    if (profile.revision !== input.expectedProfileRevision)
      throw new Error('Computer Use app profile is stale');
    const syntheticTurn = ownerTurnId === null;
    if (syntheticTurn && this.deps.persistence.getActiveTurnId(input.taskId) !== null)
      throw new Error('Computer Use synthetic session requires an idle Task');
    if (!syntheticTurn && this.deps.persistence.getActiveTurnId(input.taskId) !== ownerTurnId)
      throw new Error('Computer Use Turn ownership changed');
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
      profileId: input.profileId,
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
      this.assertStartBinding(input.taskId, policyEpoch, ownerTurnId);
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
    captureComputerUseRuntime(this.deps.runtimeCapture, (capture) =>
      capture.start({
        type: 'session',
        sessionDigest: computerUseCaptureDigest(sessionId),
        platform: native.platform,
        appDigest: native.appIdentityDigest,
        windowDigest: native.windowIdentityDigest,
        manifestDigest: availability.manifestDigest ?? '0'.repeat(64),
        ...(native.inputReceipt === undefined
          ? {}
          : {
              inputAttemptCount: native.inputReceipt.inputAttemptCount,
              cancelEpoch: native.inputReceipt.cancelEpoch,
            }),
      }),
    );
    try {
      // Before the factory, not only after it: the factory is where the provider preflight and the
      // model-capability check happen, and a start that is already cancelled must not make them.
      controller.signal.throwIfAborted();
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
              sessionGoal: input.agent?.goal ?? null,
              signal: controller.signal,
            });
      controller.signal.throwIfAborted();
      if (this.disposed) throw new Error('Computer Use controller is disposed');
      this.assertStartBinding(input.taskId, policyEpoch, ownerTurnId);
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
      maxRounds: input.maxRounds ?? COMPUTER_USE_LIMITS.maxRounds,
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
      agent: input.agent ?? null,
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
    // Bound before any round can start. Digest of the limits only; no policy body or identifier.
    captureComputerUseRuntime(this.deps.runtimeCapture, (capture) =>
      capture.record({
        type: 'cost_limit_bound',
        sessionDigest: computerUseCaptureDigest(sessionId),
        costLimitDigest: computerUseCaptureDigest(
          JSON.stringify([
            status.maxRounds,
            COMPUTER_USE_LIMITS.maxRounds,
            COMPUTER_USE_LIMITS.maxSessionHours,
            status.policyEpoch,
          ]),
        ),
        maxRounds: status.maxRounds,
      }),
    );
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
    const result = (await this.broker.dispatch({
      taskId: record.status.taskId,
      turnId: record.turnId,
      callId: requestId,
      providerName: COMPUTER_ACT_TOOL.providerName,
      input: { sessionId, action: parsed, requestId },
      signal: record.controller.signal,
    })) as ComputerUseActionResult;
    captureComputerUseRuntime(this.deps.runtimeCapture, (capture) =>
      capture.actionResult(
        sessionId,
        result.observationRevision,
        parsed,
        result.result,
        result.reasonCode,
      ),
    );
    return result;
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
    captureComputerUseRuntime(this.deps.runtimeCapture, (capture) =>
      capture.record({
        type: 'stop_requested',
        sessionDigest: computerUseCaptureDigest(sessionId),
        reasonDigest: computerUseCaptureDigest(reason),
      }),
    );
    if (record.expiryTimer !== null) {
      clearTimeout(record.expiryTimer);
      record.expiryTimer = null;
    }
    record.status = this.status(record, 'stopping', reason === 'error' ? null : reason);
    this.emit(record.status);
    record.controller.abort(new Error(`Computer Use stopped: ${reason}`));
    record.observation = null;
    this.cancelPendingApprovals(sessionId, 'computer_session_ended');
    let nativeAcknowledged = true;
    let inputReceipt: ComputerUseNativeInputReceipt | void = undefined;
    try {
      inputReceipt = await this.deps.native.cancel(record.native, record.native.cancelEpoch + 1);
    } catch {
      nativeAcknowledged = false;
      // Stop remains fail-closed even when native acknowledgement is unavailable.
    }
    // An unconfirmed close keeps the whole native host quarantined, and the session handle is
    // dropped at the end of this method, so this is the only place that can still re-send the
    // close. Native answers a repeat close for the same session id: it replays the receipt of a
    // drain that completed and re-runs a drain that did not. One bounded re-send therefore turns a
    // close receipt that was lost or arrived late back into a usable host, instead of leaving
    // Computer Use disabled until the process restarts. A second unconfirmed answer stays
    // fail-closed and is reported as `native_unavailable`.
    let nativeClosed = false;
    for (
      let attempt = 0;
      attempt < COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT && !nativeClosed;
      attempt += 1
    )
      nativeClosed = await this.deps.native.close(record.native).then(
        () => true,
        () => false,
      );
    if (!nativeClosed) nativeAcknowledged = false;
    captureComputerUseRuntime(this.deps.runtimeCapture, (capture) =>
      capture.record({
        type: 'stop_acknowledged',
        sessionDigest: computerUseCaptureDigest(sessionId),
        nativeAcknowledged,
        ...(inputReceipt === undefined
          ? {}
          : {
              inputAttemptCount: inputReceipt.inputAttemptCount,
              cancelEpoch: inputReceipt.cancelEpoch,
            }),
      }),
    );
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
    record.status = this.status(
      record,
      'stopped',
      nativeAcknowledged ? reason : 'native_unavailable',
    );
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
    // The card lives in one Task's conversation. Once the user is looking somewhere else it is no
    // longer in front of them, and a card nobody can see must not keep a tool call waiting.
    this.withdrawAppGrantCardFor((pending) => pending.taskId !== selectedTaskId);
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
    // The Turn that asked is gone, so there is nobody left to answer to. The card is withdrawn
    // rather than left for the next Turn to inherit a decision it never asked for.
    this.withdrawAppGrantCardFor(
      (pending) => pending.taskId === taskId && pending.turnId === turnId,
    );
    this.accessRequestsByTurn.delete(turnId);
    for (const session of this.sessions.values())
      if (session.status.taskId === taskId && session.turnId === turnId)
        void this.stop(session.status.sessionId, 'turn_started');
  }

  /**
   * Drops everything a Task was holding in memory (ADR v2 §6.1).
   *
   * Called when a Task is archived, which is the only way a conversation goes away in this product
   * today — and the hook a delete path would use if one is ever added, which is why the store's
   * access-request rows cascade on `tasks`.
   *
   * "Allow once" is scoped to the conversation the user said it in, so putting that conversation
   * away ends it: un-archiving later must not silently carry a permission given in a context the
   * user has since closed. A card raised in that Task cannot be answered any more either, so it is
   * withdrawn rather than left holding the single global slot.
   *
   * The stored refusal is deliberately *not* dropped: "the user said no in this Task" is about the
   * conversation, and archiving is not the user changing their mind.
   */
  taskClosed(taskId: string): void {
    this.withdrawAppGrantCardFor((pending) => pending.taskId === taskId);
    this.taskScopedGrants.delete(taskId);
    this.revokeTargetTokens(taskId);
  }

  policyEpochChanged(taskId: string): void {
    // Tokens are bound to the epoch they were issued under, so they are already unusable; dropping
    // them here keeps the map from holding references the agent can no longer spend.
    this.revokeTargetTokens(taskId);
    // The card's intent digest covers the epoch, so a click would be refused anyway — withdrawing
    // says so while the user is still looking at it instead of after they press a button.
    this.withdrawAppGrantCardFor((pending) => pending.taskId === taskId);
    // "Allow once" was given under the permissions that were in force; a change to those is exactly
    // the event §6.5 says must invalidate what is bound to the epoch.
    this.taskScopedGrants.delete(taskId);
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
    // The window that was showing the card is gone, so the click it was waiting for can never come.
    this.withdrawAppGrantCardFor(() => true);
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
    this.withdrawAppGrantCardFor(() => true);
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
    this.targetTokens.clear();
    this.targetAppTokens.clear();
    this.taskScopedGrants.clear();
    this.accessRequestsByTurn.clear();
  }

  private async run(record: SessionRecord, firstRound = 1): Promise<void> {
    const sessionId = record.status.sessionId;
    record.status = this.status(record, 'observing', null);
    this.emit(record.status);
    if (record.planner === null) return;
    for (let round = firstRound; round <= record.status.maxRounds; round += 1) {
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
      let result: ComputerUseActionResult;
      try {
        result = await this.act(sessionId, action, `${sessionId}:action:${round}`);
      } catch (error) {
        if (record.status.state === 'paused' || record.controller.signal.aborted) return;
        throw error;
      }
      if (action.type === 'wait') await waitBounded(action.milliseconds, record.controller.signal);
      if (record.status.state === 'paused') return;
      if (round === record.status.maxRounds && result.result === 'completed') {
        // Complete the same observation/action journey at the bound, without a further plan.
        // Normal Broker/session checks still deny the read if Stop or policy revocation won.
        this.assertSessionLive(record);
        await this.observe(sessionId, `${sessionId}:observe:final`);
        this.assertSessionLive(record);
        if (!this.observationIsFresh(record)) {
          await this.stop(sessionId, 'stale_observation');
          return;
        }
      }
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
    signal?.throwIfAborted();
    this.assertSessionLive(record);
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
    if (
      !record.controller.signal.aborted &&
      this.sessions.has(sessionId) &&
      (nativeResult.result === 'unknown_effect' ||
        nativeResult.result === 'rejected' ||
        nativeResult.result === 'paused')
    ) {
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
      captureComputerUseRuntime(this.deps.runtimeCapture, (capture) =>
        capture.record({
          type: 'native_started',
          cancelEpoch: record.native.cancelEpoch,
          ttlVerified: this.observationIsFresh(record),
          sessionDigest: computerUseCaptureDigest(record.status.sessionId),
          requestDigest: computerUseCaptureDigest(atomicRequestId),
          actionDigest: computerUseCaptureDigest(JSON.stringify(action)),
          revision: observationRevision,
        }),
      );
      try {
        result = await this.deps.native.dispatch({
          session: record.native,
          requestId: atomicRequestId,
          action: atomicAction,
          observationRevision,
          cancelEpoch: record.native.cancelEpoch,
          signal,
        });
      } catch (error) {
        captureComputerUseRuntime(this.deps.runtimeCapture, (capture) =>
          capture.record({
            type: 'native_finished',
            sessionDigest: computerUseCaptureDigest(record.status.sessionId),
            requestDigest: computerUseCaptureDigest(atomicRequestId),
            result: 'unknown_effect',
            actionDigest: computerUseCaptureDigest(JSON.stringify(action)),
            revision: observationRevision,
          }),
        );
        throw error;
      }
      captureComputerUseRuntime(this.deps.runtimeCapture, (capture) =>
        capture.record({
          type: 'native_finished',
          sessionDigest: computerUseCaptureDigest(record.status.sessionId),
          requestDigest: computerUseCaptureDigest(atomicRequestId),
          result: result.result,
          ...(result.inputReceipt === undefined
            ? {}
            : {
                inputAttemptCount: result.inputReceipt.inputAttemptCount,
                cancelEpoch: result.inputReceipt.cancelEpoch,
              }),
          actionDigest: computerUseCaptureDigest(JSON.stringify(action)),
          revision: observationRevision,
        }),
      );
      // Once native returned a bounded result, that result is authoritative even if Stop won the
      // next microtask. Downgrading a confirmed completion/rejection to canceled corrupts the
      // durable audit. A partial multi-scalar type still reaches the next loop boundary, where the
      // abort becomes unknown_effect because the whole requested action did not complete.
      if (result.result !== 'completed')
        return index === 0
          ? result
          : {
              result: 'unknown_effect',
              reasonCode: result.reasonCode ?? 'partial_type',
            };
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
      maxRounds: record.status.maxRounds,
      actionType: action.type,
      actionDigest: computerUseActionDigest(action),
      targetId,
      targetSignature: record.observation.targetSignatures[targetId],
      ...authority,
      // The approval authorizes the current action; the grant covers only later rounds.
      remaining: Math.min(16, record.status.maxRounds - Math.max(1, record.status.round)),
      expiresAt: this.now() + 60_000,
      observationRevision: record.observation.revision,
    };
  }

  private planGrantMatches(record: SessionRecord, action: ComputerUseAction): boolean {
    const grant = record.planGrant;
    if (grant === null || this.now() >= grant.expiresAt || grant.remaining <= 0) return false;
    if (grant.maxRounds !== record.status.maxRounds) return false;
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
    this.assertSessionLive(record);
    captureComputerUseRuntime(this.deps.runtimeCapture, (capture) => capture.observe(parsed));
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
    // For an agent-started session the grant is part of being live: it authorised the session, so
    // losing it must stop the session at the same cadence a policy change does.
    this.assertAgentGrantStillHolds(record);
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

  /**
   * Re-checks, after each await in the start path, that the Task still belongs to this start.
   *
   * `ownerTurnId` is null for the session a person starts from the panel: that one owns a synthetic
   * Turn, so any Turn appearing means something else took the Task. `computer_start` is the
   * opposite case — it runs *inside* a Turn, and the requirement is that the Turn that called is
   * still the active one. The two are the same check with a different expected value, which is also
   * how `assertSessionLive` phrases it once the session exists.
   */
  private assertStartBinding(
    taskId: string,
    policyEpoch: number,
    ownerTurnId: string | null = null,
  ): void {
    const activeTurnId = this.deps.persistence.getActiveTurnId(taskId);
    if (ownerTurnId === null ? activeTurnId !== null : activeTurnId !== ownerTurnId)
      throw new Error('Computer Use synthetic session requires an idle Task');
    if (this.currentPolicyEpoch(taskId) !== policyEpoch)
      throw new Error('Computer Use policy epoch changed');
    if (this.deps.canStartSession?.(taskId, ownerTurnId) === false)
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
      round: Math.min(record.status.maxRounds, round),
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

/**
 * The only facts the agent may weigh when choosing a target (ADR v2 §5.2).
 *
 * Derived from the stored identity rather than from any display string, and deliberately missing the
 * executable path, the cdHash, and the digests: those are re-verification inputs for Main and
 * native, not selection criteria for a model. On Windows the ADR's publisher CN is not part of the
 * V1 identity, so this answers null rather than passing off a digest as a publisher name.
 */
function computerTargetVerifiedIdentity(
  profile: ComputerAppProfileRecord,
): SelectableComputerTarget['verified'] {
  const identity = profile.identity;
  const text = (key: string): string | null => {
    const value = identity[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  if (profile.platform === 'darwin')
    return {
      platform: 'darwin',
      identityKind:
        text('teamId') !== null || text('signingIdentifier') !== null
          ? 'verified-signed'
          : 'unverified',
      publisher: text('teamId'),
      appId: text('bundleId') ?? COMPUTER_TARGET_UNKNOWN_APP_ID,
    };
  return {
    platform: 'win32',
    identityKind: text('signerDigest') !== null ? 'verified-signed' : 'unverified',
    publisher: null,
    // The leaf name, never the directory that holds it: ADR v2 §5.2 names the leaf as the app id,
    // and the V1 invariant keeps paths inside Main.
    appId: text('packageFamilyName') ?? executableLeafName(text('executablePath')),
  };
}

/**
 * The stand-in when a profile carries no app id at all.
 *
 * It must not be the identity digest. The digest is a re-verification input Main and native own; the
 * row above promises the agent only selection criteria, and a digest handed to the model travels to
 * the Provider and stays in the conversation history. An app with no usable id is still selectable
 * by its `windowIndex` and its signing class, which is all the agent needs.
 */
const COMPUTER_TARGET_UNKNOWN_APP_ID = 'unknown';

/**
 * The last path segment, or the stand-in.
 *
 * A path ending in a separator splits to a trailing empty string, which fails the output schema's
 * `min(1)` — and that exception would take down the whole enumeration over one malformed profile.
 */
function executableLeafName(executablePath: string | null): string {
  const leaf = executablePath
    ?.split(/[\\/]/u)
    .filter((segment) => segment !== '')
    .at(-1);
  return leaf === undefined || leaf.trim() === '' ? COMPUTER_TARGET_UNKNOWN_APP_ID : leaf.trim();
}

/**
 * The version of the deny ruleset this build applies (ADR v2 §3.0, T3).
 *
 * Stored on every grant so that raising it can be told from "this grant was written under the
 * current rules". ADR v2 §9 makes the eligibility mode and its ruleset version compile-time
 * constants rather than environment variables, and this is that constant for the V1 allow-list era:
 * S4/S5 replace the list below and bump it, at which point grants written under version 1 are
 * re-evaluated and any that now fall in a denied class are revoked rather than re-confirmed.
 */
export const COMPUTER_USE_DENY_RULESET_VERSION = 1;

/**
 * The session status, reduced to what may be written into the conversation.
 *
 * A tool result is durable; a session status is not. `pendingApproval` carries a live-only excerpt
 * of the target's screen, and the identity digests, profile id, window token and connection id are
 * either re-verification inputs or V1 privacy boundaries (§8). Named field by field rather than
 * destructured with a rest, so a field added to the status is absent here until somebody decides it
 * belongs — the opposite of a spread, which would publish it by default.
 */
export function computerStartToolOutput(status: ComputerUseSessionStatus): ComputerStartToolOutput {
  return computerStartToolOutputSchema.parse({
    sessionId: status.sessionId,
    state: status.state,
    stopReason: status.stopReason,
    mode: status.mode,
    round: status.round,
    maxRounds: status.maxRounds,
  });
}

/**
 * The agent's session goal, normalised the way a human-typed Task goal already is.
 *
 * `plannerInstruction` NFKC-normalises and truncates the Task objective before it reaches a
 * provider; a model-authored goal goes through the same treatment at its own smaller budget rather
 * than through a second, looser rule. It is a purpose statement, never an instruction the inner
 * planner can act on beyond the fixed `computer_use_action_v1` grammar (§5.1).
 */
function computerUseAgentGoal(goal: string): string {
  const normalized = goal
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const capped = [...normalized].slice(0, COMPUTER_START_GOAL_MAX_CHARACTERS).join('').trim();
  if (capped === '') throw new Error('Computer Use session goal is empty');
  return capped;
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
