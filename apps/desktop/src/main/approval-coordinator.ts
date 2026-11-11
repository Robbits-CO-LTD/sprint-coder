import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalDecision } from '@sprint-coder/contracts';
import type {
  Capability,
  PermissionOperation,
  PermissionResource,
  ResourceSet,
  ExecutionSpec,
} from '@sprint-coder/domain';
import {
  PROJECT_MEMORY_RESOURCE_PREFIX,
  SKILL_DRAFT_RESOURCE_PREFIX,
  executionSpecDigest,
  requiresPerCallHumanApproval,
  validateExecutionSpec,
} from '@sprint-coder/domain';
import type {
  ApprovalWaitObserver,
  ToolAuthorizationControl,
  ToolAuthorizationDecision,
  ToolAuthorizationRequest,
} from './tool-broker';
import type {
  ApprovalCallCancellationInput,
  ApprovalRequestInput,
  ApprovalResolutionInput,
} from './persistence';
import {
  desktopControlArgvIsInert,
  desktopControlArgvMode,
  desktopControlExpectedWindowOwner,
  isDesktopControlExecutable,
} from './desktop-control';
import { desktopControlApprovalAction } from './desktop-control-display';
import {
  desktopAppGrantCovering,
  desktopAppGrantOffer,
  type DesktopAppGrantKey,
} from './desktop-control-app-grant';
import { APPROVAL_DISPLAY_UNDISPLAYABLE_CHARACTERS } from './approval-display-characters';
import { executionSpecContentDigest } from './command-runner';
import { pathGuardIdentityDigest, workspacePermissionResourceFromGuard } from './path-guard';
import { secureLogger } from './secure-logger';
import {
  projectMemoryAuthorizationFacts,
  providerDisclosureAuthorizationFacts,
  teamResultReadAuthorizationFacts,
  workspaceToolAuthorizationGuard,
  workspaceToolAuthorizationGuards,
  workspaceToolPermissionGuard,
} from './provider-workspace-tools';
import {
  managedStdinApprovalExecution,
  managedStdinApprovalTarget,
  managedStdinAuthorizationFacts,
  managedStdinEphemeralExecution,
} from './managed-command-stdin';

type ApprovalLike = {
  id: string;
  taskId: string;
  turnId: string;
  callId: string;
  policyEpoch: number;
  capability?: Capability;
  challenge: string;
  revision: number;
  state: string;
  decision: ApprovalDecision | null;
};

type ApprovalPersistencePort = {
  requestApproval(
    input: ApprovalRequestInput & {
      requestDigest?: string;
      capabilities?: readonly Capability[];
      challengeHash?: string;
    },
  ): { approval: ApprovalLike; event?: unknown };
  getApproval(taskId: string, approvalId: string): ApprovalLike | undefined;
  resolveApproval(input: ApprovalResolutionInput & { turnId?: string; challengeHash?: string }): {
    approval: ApprovalLike;
    event?: unknown;
    oneTimePermitToken?: string;
  };
  invalidatePendingApprovalsForTask?: (
    taskId: string,
    policyEpoch: number,
    invalidatedAt: string,
  ) => { approval: ApprovalLike; event?: unknown }[];
  cancelPendingApprovalForCall(
    input: ApprovalCallCancellationInput,
  ): { approval: ApprovalLike; event?: unknown } | null;
  endTurnApprovals?: (taskId: string, turnId: string, reason: 'canceled' | 'finished') => string[];
  hasTaskGrant?: (input: unknown) => boolean;
  saveTaskGrant?: (input: unknown) => void;
  consumePermissionOneTimeToken?: (
    taskId: string,
    token: string,
    policyEpoch: number,
    now: string,
    binding?: {
      approvalId: string;
      turnId: string;
      callId: string;
      subjectId: string;
      specDigest: string;
    },
  ) => boolean;
};

type ResolveCommand = {
  taskId: string;
  turnId: string;
  approvalId: string;
  decision: ApprovalDecision;
  userInputSelection?: number;
  expectedRevision: number;
  challenge: string;
  operationId: string;
  /** With `allow_task`: 「このアプリは Task 中許可」, accepted only when the card offered it. */
  grantScope?: 'app';
};

type WaiterSettler = {
  resolve: (decision: ToolAuthorizationDecision) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type Waiter = {
  taskId: string;
  turnId: string;
  requestDigest: string;
  request: ToolAuthorizationRequest;
  capability: Capability;
  settlers: WaiterSettler[];
  /**
   * Set when the call waiting on this card was aborted. The waiter outlives that only while the
   * cancellation is not durable, so a late decision on the still-pending card cannot mint a permit
   * or grant for a call that is gone.
   */
  canceled: boolean;
  /** The app this desktop-control card offered the app-wide Task grant for, if it did. */
  desktopAppGrant: DesktopAppGrantKey | null;
};

type DesktopAppGrant = Readonly<{
  key: DesktopAppGrantKey;
  policyEpoch: number;
  expiresAt: string;
}>;
const DESKTOP_APP_GRANT_TASKS = 50;

/** Keep the sandbox profile recorded by an approval identical to the profile used by permission
 * evaluation and execution revalidation. A write recorded as read-only can be approved by the
 * user but will always fail closed before ToolBroker reaches its queued state. */
export function sandboxProfileForToolAuthorization(
  implementationKind: ToolAuthorizationRequest['entry']['implementationKind'],
  capability: Capability,
) {
  // `shell.execute` is recorded as `full` whoever implements it. A built-in that feeds a running
  // process (write_stdin, Issue #473) hands over the same authority the process already holds, and
  // an approval row claiming `read-only` would understate that in the audit.
  if (implementationKind === 'command-runner' || capability === 'shell.execute')
    return 'full' as const;
  return capability === 'workspace.write' || capability === 'filesystem.external.write'
    ? ('workspace-write' as const)
    : ('read-only' as const);
}

export class ApprovalCoordinator {
  private readonly waiters = new Map<string, Waiter>();
  /**
   * Per Task, the apps the person allowed on a desktop-control card for the rest of the Task
   * (「このアプリは Task 中許可」). Kept like a Task grant — bound to the Task, its policy epoch and
   * the grant's expiry — but only in memory, so a restart asks again.
   */
  private readonly desktopAppGrants = new Map<string, Map<string, DesktopAppGrant>>();

  constructor(
    private readonly options: {
      persistence: ApprovalPersistencePort;
      now: () => string;
      expiresAt: () => string;
      getCurrentPolicyEpoch: (taskId: string) => number;
      isTurnActive: (taskId: string, turnId: string) => boolean;
      evaluatePermission: (input: {
        capability: Capability;
        request: ToolAuthorizationRequest;
      }) =>
        | ToolAuthorizationDecision
        | 'allow'
        | 'deny'
        | 'approval_required'
        | Promise<ToolAuthorizationDecision | 'allow' | 'deny' | 'approval_required'>;
      revalidateTaskGrant?: (input: {
        capability: Capability;
        request: ToolAuthorizationRequest;
      }) => boolean;
      publish: {
        bivarianceHack(approval: ApprovalLike, event?: unknown): void;
      }['bivarianceHack'];
    },
  ) {}

  async authorizeTool(
    request: ToolAuthorizationRequest,
    control?: ToolAuthorizationControl,
  ): Promise<ToolAuthorizationDecision> {
    const signal = control?.signal;
    throwIfAborted(signal);
    const required = request.entry.requiredCapabilities;
    if (required.length === 0) return { decision: 'allow', reason: 'no_capability_required' };
    // A per-call approval is only as good as what its card shows (Issue #546). A call whose subject
    // cannot be bound, or whose content the card could not show in full, is refused before any
    // card exists: there would be nothing the person could meaningfully approve. The reason reaches
    // the model as its tool error, so it says what to change; it names no content, and the
    // diagnostic log keeps it because nothing has been evaluated or audited yet.
    for (const capability of required) {
      if (!requiresPerCallHumanApproval(capability)) continue;
      const subject = perCallApprovalSubject(request, capability);
      const reason =
        subject === null
          ? 'per_call_approval_subject_unbound'
          : perCallApprovalUndisplayableReason(subject);
      if (reason === undefined) continue;
      secureLogger.warn(
        'A per-call approval was refused before its card was raised',
        { toolName: request.entry.providerName, capability, callId: request.callId, reason },
        { taskId: request.context.taskId, turnId: request.context.turnId },
      );
      return { decision: 'deny', reason };
    }

    const evaluations: Array<{ capability: Capability; decision: ToolAuthorizationDecision }> = [];
    for (const capability of required) {
      const evaluated = await this.options.evaluatePermission({ capability, request });
      throwIfAborted(signal);
      evaluations.push({ capability, decision: normalizeAuthorization(evaluated) });
    }
    // The first refusal's reason reaches the model as its tool error, so a refusal that explains
    // itself (a Workspace in a protected place, Issue #836) is not reduced to a bare denial.
    const denied = evaluations.find(({ decision }) => decision.decision === 'deny');
    if (denied !== undefined) return { decision: 'deny', reason: denied.decision.reason };
    const revalidators: (() => boolean)[] = [];
    let approvalDecision: ToolAuthorizationDecision['approvalDecision'];
    let userInputSelection: number | undefined;
    let expectedWindowOwner: string | undefined;
    const desktopControl = isDesktopControlCall(request);
    // A desktop-control run that takes the foreground, the cursor or the keyboard is decided on its
    // own card every time: no Task grant covers it, including one given before this rule.
    const desktopForeground = desktopControl && isForegroundDesktopControlCall(request);
    for (const evaluation of evaluations) {
      // The policy engine never allows a per-call capability, and if it ever did, the person would
      // still be asked: only their decision on this call's card covers this call.
      // The bundled desktop-control binary runs outside the command sandbox, so it is never
      // covered by a preset or policy allow either: the person decides it on its own card. The one
      // allow that is their decision is the Task grant they gave on such a card, which the policy
      // engine matches only for the exact same ExecutionSpec (executable identity, argv, cwd, env).
      const desktopTaskGrant =
        desktopControl &&
        !desktopForeground &&
        evaluation.decision.decision === 'allow' &&
        evaluation.decision.reason === 'remembered_grant';
      // A desktop-control run that only prints the bundled guides, help, the version or its own
      // status touches no other app, window or file, so it runs without a card wherever the policy
      // allows or would ask; a deny was returned above. Judged on the sealed argv, as the run is.
      if (
        desktopControl &&
        !requiresPerCallHumanApproval(evaluation.capability) &&
        isInertDesktopControlCall(request)
      ) {
        const policyCheck = evaluation.decision.beforeExecute;
        revalidators.push(
          () =>
            this.options.isTurnActive(request.context.taskId, request.context.turnId) &&
            this.options.getCurrentPolicyEpoch(request.context.taskId) ===
              request.context.policyEpoch &&
            (policyCheck?.() ?? true),
        );
        continue;
      }
      if (
        evaluation.decision.decision === 'allow' &&
        !requiresPerCallHumanApproval(evaluation.capability) &&
        (!desktopControl || desktopTaskGrant)
      ) {
        revalidators.push(evaluation.decision.beforeExecute ?? (() => false));
        if (desktopTaskGrant) approvalDecision ??= 'allow_task';
        continue;
      }
      if (evaluation.decision.beforeExecute !== undefined)
        revalidators.push(evaluation.decision.beforeExecute);
      const decision = await this.requestCapabilityApproval(
        request,
        evaluation.capability,
        control,
      );
      if (decision.decision !== 'allow') return decision;
      if (
        approvalDecision !== undefined &&
        decision.approvalDecision !== undefined &&
        approvalDecision !== decision.approvalDecision
      )
        throw new Error('APPROVAL_DECISION_CONFLICT');
      approvalDecision ??= decision.approvalDecision;
      if (
        userInputSelection !== undefined &&
        decision.userInputSelection !== undefined &&
        userInputSelection !== decision.userInputSelection
      )
        throw new Error('APPROVAL_USER_INPUT_SELECTION_CONFLICT');
      userInputSelection ??= decision.userInputSelection;
      if (
        expectedWindowOwner !== undefined &&
        decision.desktopControlExpectedWindowOwner !== undefined &&
        expectedWindowOwner !== decision.desktopControlExpectedWindowOwner
      )
        throw new Error('APPROVAL_DESKTOP_WINDOW_OWNER_CONFLICT');
      expectedWindowOwner ??= decision.desktopControlExpectedWindowOwner;
      revalidators.push(decision.beforeExecute ?? (() => false));
    }
    return {
      decision: 'allow',
      reason: 'all_capabilities_allowed',
      beforeExecute: () => revalidators.every((revalidate) => revalidate()),
      ...(approvalDecision === undefined ? {} : { approvalDecision }),
      ...(userInputSelection === undefined ? {} : { userInputSelection }),
      ...(expectedWindowOwner === undefined
        ? {}
        : { desktopControlExpectedWindowOwner: expectedWindowOwner }),
    };
  }

  private async requestCapabilityApproval(
    request: ToolAuthorizationRequest,
    capability: Capability,
    control: ToolAuthorizationControl | undefined,
  ): Promise<ToolAuthorizationDecision> {
    const signal = control?.signal;
    // Before a Task grant is reused or a card is raised: an aborted call gets neither.
    throwIfAborted(signal);
    const requestDigest = digest({
      toolId: request.entry.toolId,
      schemaDigest: request.entry.schemaDigest,
      input: durableDigestInput(request.input),
      capability,
      policyEpoch: request.context.policyEpoch,
    });
    const perCall = requiresPerCallHumanApproval(capability);
    const perCallSubject = perCall ? perCallApprovalSubject(request, capability) : undefined;
    if (perCallSubject === null)
      return { decision: 'deny', reason: 'per_call_approval_subject_unbound' };
    const desktopControl = isDesktopControlCall(request);
    const desktopForeground = desktopControl && isForegroundDesktopControlCall(request);
    // A read or background run on an app the person allowed for the Task on an earlier card of
    // this Task, judged again from the executable's own records before it starts.
    // The executable checks each window id the run names against the granted process instance as
    // it runs (`desktopControlExpectedWindowOwner`), since a closed window's id can be reused by
    // another app's window while the records still name the granted one.
    const grantedApp =
      !perCall && desktopControl && !desktopForeground
        ? this.desktopAppGrantCovering(request)
        : null;
    const expectedWindowOwner =
      grantedApp === null ? null : desktopControlExpectedWindowOwner(grantedApp);
    if (grantedApp !== null && expectedWindowOwner !== null)
      return {
        decision: 'allow',
        reason: 'desktop_app_task_grant',
        approvalDecision: 'allow_task',
        desktopControlExpectedWindowOwner: expectedWindowOwner,
        beforeExecute: () =>
          this.options.isTurnActive(request.context.taskId, request.context.turnId) &&
          this.desktopAppGrantCovering(request)?.id === grantedApp.id,
      };
    // A per-call capability never reuses a Task grant, including one left by an earlier version,
    // and neither does a desktop-control run that uses the foreground.
    if (
      !perCall &&
      !desktopForeground &&
      this.options.persistence.hasTaskGrant?.({
        taskId: request.context.taskId,
        requestDigest,
        policyEpoch: request.context.policyEpoch,
        now: this.options.now(),
      })
    )
      return {
        decision: 'allow',
        reason: 'task_grant',
        // The person chose "allow for the Task" on a card for this exact request (the digest binds
        // the tool, its whole input and the policy epoch), so it counts as their decision.
        approvalDecision: 'allow_task',
        beforeExecute: () =>
          this.options.persistence.hasTaskGrant?.({
            taskId: request.context.taskId,
            requestDigest,
            policyEpoch: request.context.policyEpoch,
            now: this.options.now(),
          }) === true,
      };

    if (!this.options.isTurnActive(request.context.taskId, request.context.turnId))
      return { decision: 'deny', reason: 'turn_ended' };

    const approvalId = randomUUID();
    const challenge = `${randomUUID()}${randomUUID()}`;
    const facts = approvalFactsForTool(request, capability);
    const desktopAction =
      desktopControl && perCallSubject === undefined && validateExecutionSpec(request.input)
        ? desktopControlApprovalAction(request.input.argv, { taskId: request.context.taskId })
        : undefined;
    // Offered only beside 「Task中許可」, for a run the app-wide grant could cover.
    const desktopAppGrant =
      desktopAction?.allowTaskGrant === true &&
      !desktopForeground &&
      validateExecutionSpec(request.input) &&
      desktopAppGrantEnvironmentAllows(request.input)
        ? desktopAppGrantOffer(request.input.argv, { taskId: request.context.taskId })
        : null;
    const specDigest = facts.specDigest;
    const resource = facts.resourceSet;
    const operation = facts.operation;
    const persisted = this.options.persistence.requestApproval({
      id: approvalId,
      taskId: request.context.taskId,
      turnId: request.context.turnId,
      itemId: `approval:${approvalId}`,
      callId: request.callId,
      runtimeInstanceId: `runtime:${request.context.turnId}`,
      subjectId: facts.subjectId,
      providerName: request.entry.providerName,
      toolId: request.entry.toolId,
      toolCatalogDigest: digest(request.entry),
      schemaDigest: request.entry.schemaDigest,
      specDigest,
      requestDigest,
      policyEpoch: request.context.policyEpoch,
      capability,
      capabilities: [capability],
      resource,
      operation,
      providerEgress: 'none',
      sandboxProfile: sandboxProfileForToolAuthorization(
        request.entry.implementationKind,
        capability,
      ),
      risk: request.entry.risk,
      reasonUntrusted: `Tool ${request.entry.providerName} requests ${capability}`,
      display: {
        target: perCallSubject?.label ?? displayTarget(request.input),
        impact: request.entry.sideEffect,
        execution: perCallSubject?.execution ?? safeApprovalExecution(request),
        // What the run does, for the card only. Nothing decides on it: it is built after the
        // decisions above, and a part it cannot name is shown as not confirmed.
        ...(desktopAction === undefined
          ? {}
          : {
              desktopAction:
                desktopAppGrant === null
                  ? desktopAction
                  : { ...desktopAction, appGrant: { app: desktopAppGrant.label } },
            }),
      },
      ...ephemeralApprovalExecution(request),
      challenge,
      challengeHash: digest(challenge),
      expiresAt: this.options.expiresAt(),
      requestedAt: this.options.now(),
    });

    // A card is now pending, so the call waits on the user until the card settles, whichever way
    // it settles (issue #573).
    const endApprovalWait = beginApprovalWait(control?.onApprovalWait, request);
    return new Promise<ToolAuthorizationDecision>((resolve, reject) => {
      const persistedId = persisted.approval.id;
      const settler: WaiterSettler = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      const existing = this.waiters.get(persistedId);
      if (existing !== undefined) {
        if (existing.requestDigest !== requestDigest) throw new Error('APPROVAL_WAITER_CONFLICT');
        if (existing.canceled) {
          resolve({ decision: 'deny', reason: 'approval_canceled' });
          return;
        }
        this.attachSettler(persistedId, existing, settler);
      } else {
        const waiter: Waiter = {
          taskId: request.context.taskId,
          turnId: request.context.turnId,
          requestDigest,
          request,
          capability,
          settlers: [],
          canceled: false,
          desktopAppGrant,
        };
        this.waiters.set(persistedId, waiter);
        this.attachSettler(persistedId, waiter, settler);
        // Persistence commits before this notification; the waiter is installed before Renderer can reply.
        this.options.publish(persisted.approval, persisted.event);
      }
      // An abort that landed before the listener existed never fires it.
      if (signal?.aborted === true) this.cancelForAbortedCall(persistedId);
    }).finally(endApprovalWait);
  }

  private attachSettler(approvalId: string, waiter: Waiter, settler: WaiterSettler): void {
    waiter.settlers.push(settler);
    if (settler.signal === undefined) return;
    settler.onAbort = () => this.cancelForAbortedCall(approvalId);
    settler.signal.addEventListener('abort', settler.onAbort, { once: true });
  }

  /**
   * The call waiting on this card was aborted — for example a Team Worker released while its write
   * waited (issue #572). Only this card is canceled, without a decision: no permit or grant is
   * created, and other calls' cards on the same Turn stay pending. The cancellation commits and is
   * published before the waiter settles.
   */
  private cancelForAbortedCall(approvalId: string): void {
    const waiter = this.waiters.get(approvalId);
    if (waiter === undefined || waiter.canceled) return;
    // Marked before anything is attempted, so from here no decision can reach this call.
    waiter.canceled = true;
    let canceled: { approval: ApprovalLike; event?: unknown } | null;
    try {
      canceled = this.options.persistence.cancelPendingApprovalForCall({
        taskId: waiter.taskId,
        turnId: waiter.turnId,
        approvalId,
        callId: waiter.request.callId,
        canceledAt: this.options.now(),
      });
    } catch (error) {
      // Nothing durable changed: the card is still pending and the Turn still waits, and neither is
      // reported otherwise. The waiter stays behind marked canceled, so a late allow cannot grant
      // the call; Turn end, a policy change or restart recovery settles the card.
      secureLogger.warn(
        'The approval card of an aborted tool call could not be canceled',
        { approvalId, error },
        { taskId: waiter.taskId, turnId: waiter.turnId },
      );
      this.settleCanceled(waiter);
      return;
    }
    this.waiters.delete(approvalId);
    if (canceled !== null) {
      try {
        this.options.publish(canceled.approval, canceled.event);
      } catch (error) {
        secureLogger.warn(
          'The cancellation of an approval card could not be published',
          { approvalId, error },
          { taskId: waiter.taskId, turnId: waiter.turnId },
        );
      }
    }
    this.settleCanceled(waiter);
  }

  private settleCanceled(waiter: Waiter): void {
    for (const settler of waiter.settlers.splice(0)) {
      detachSettler(settler);
      // Canceled, not denied: the caller that aborted sees its own abort, not a user refusal.
      if (settler.signal?.aborted === true) settler.reject(abortReason(settler.signal));
      else settler.resolve({ decision: 'deny', reason: 'approval_canceled' });
    }
  }

  resolve(command: ResolveCommand): ApprovalLike {
    const current = this.options.persistence.getApproval(command.taskId, command.approvalId);
    if (current === undefined) throw new Error('APPROVAL_NOT_FOUND');
    if (current.turnId !== command.turnId) throw new Error('APPROVAL_TASK_OR_TURN_MISMATCH');
    const waiter = this.waiters.get(command.approvalId);
    // Its call was aborted and the card could not be canceled durably. Recording a decision now
    // would mint a permit or grant for a call that no longer exists.
    if (waiter?.canceled === true) throw new Error('APPROVAL_CANCELED');
    // 「このアプリは Task 中許可」 is accepted only from a card this process raised with that choice
    // on it, for a run the grant could cover. Refused before anything is recorded.
    if (
      command.grantScope !== undefined &&
      (command.grantScope !== 'app' ||
        command.decision !== 'allow_task' ||
        waiter === undefined ||
        waiter.desktopAppGrant === null ||
        !isDesktopControlCall(waiter.request) ||
        isForegroundDesktopControlCall(waiter.request))
    )
      throw new Error('APPROVAL_DECISION_NOT_ALLOWED');
    const appScope = command.grantScope === 'app';
    // Approved one call at a time (Issue #546). Refused before anything is recorded, whether or not
    // this process still holds the waiter, so no Task grant can come out of such a card.
    if (
      command.decision === 'allow_task' &&
      ((waiter !== undefined && requiresPerCallHumanApproval(waiter.capability)) ||
        (current.capability !== undefined && requiresPerCallHumanApproval(current.capability)) ||
        // A desktop-control run that uses the foreground is allowed one run at a time.
        (waiter !== undefined &&
          isDesktopControlCall(waiter.request) &&
          isForegroundDesktopControlCall(waiter.request)))
    )
      throw new Error('APPROVAL_DECISION_NOT_ALLOWED');
    const userInputRequest = waiter?.request.entry.providerName === 'request_user_input';
    if (userInputRequest) {
      const choices = (waiter.request.input as { choices?: unknown }).choices;
      if (
        !Array.isArray(choices) ||
        !Number.isInteger(command.userInputSelection) ||
        command.userInputSelection! < 0 ||
        command.userInputSelection! >= choices.length
      )
        throw new Error('APPROVAL_USER_INPUT_SELECTION_INVALID');
      const auditDecision =
        command.userInputSelection === 0
          ? 'allow_once'
          : command.userInputSelection === 1
            ? 'allow_task'
            : 'deny';
      if (command.decision !== auditDecision)
        throw new Error('APPROVAL_USER_INPUT_DECISION_MISMATCH');
    } else if (command.userInputSelection !== undefined)
      throw new Error('APPROVAL_USER_INPUT_SELECTION_UNEXPECTED');
    const selectedUserInput = userInputRequest ? command.userInputSelection! : undefined;
    const policyChanged =
      current.policyEpoch !== this.options.getCurrentPolicyEpoch(command.taskId);
    if (!this.options.isTurnActive(command.taskId, command.turnId)) {
      this.release(command.approvalId, { decision: 'deny', reason: 'turn_ended' });
      throw new Error('APPROVAL_TURN_STALE');
    }
    const result = this.options.persistence.resolveApproval({
      taskId: command.taskId,
      turnId: command.turnId,
      approvalId: command.approvalId,
      expectedTurnId: command.turnId,
      expectedRevision: command.expectedRevision,
      challenge: command.challenge,
      challengeHash: digest(command.challenge),
      decision: command.decision,
      operationId: command.operationId,
      decidedAt: this.options.now(),
      grantExpiresAt: this.options.expiresAt(),
      // The app-wide grant lives in memory only, so no grant for the exact command is stored.
      ...(appScope ? { saveTaskGrant: false as const } : {}),
    });
    if (policyChanged) {
      this.options.publish(result.approval, result.event);
      this.release(command.approvalId, { decision: 'deny', reason: 'policy_epoch_changed' });
      throw new Error('APPROVAL_POLICY_STALE');
    }
    if (result.approval.state !== 'resolved') {
      this.options.publish(result.approval, result.event);
      this.release(command.approvalId, { decision: 'deny', reason: result.approval.state });
      throw new Error(`APPROVAL_${result.approval.state.toUpperCase()}`);
    }

    if (
      command.decision === 'allow_task' &&
      !appScope &&
      waiter !== undefined &&
      waiter.request.entry.providerName !== 'request_user_input'
    )
      this.options.persistence.saveTaskGrant?.({
        taskId: command.taskId,
        requestDigest: waiter.requestDigest,
        policyEpoch: current.policyEpoch,
        expiresAt: this.options.expiresAt(),
      });
    if (appScope && waiter?.desktopAppGrant != null)
      this.saveDesktopAppGrant(command.taskId, {
        key: waiter.desktopAppGrant,
        policyEpoch: current.policyEpoch,
        expiresAt: this.options.expiresAt(),
      });
    this.release(command.approvalId, {
      decision: command.decision === 'deny' && !userInputRequest ? 'deny' : 'allow',
      reason: `approval_${command.decision}`,
      ...(selectedUserInput !== undefined
        ? { userInputSelection: selectedUserInput }
        : { approvalDecision: command.decision }),
      ...(userInputRequest && waiter !== undefined
        ? {
            beforeExecute: () =>
              this.options.isTurnActive(command.taskId, command.turnId) &&
              this.options.getCurrentPolicyEpoch(command.taskId) === current.policyEpoch,
          }
        : command.decision === 'deny' || waiter === undefined
          ? {}
          : {
              beforeExecute: () => {
                if (
                  !this.options.isTurnActive(command.taskId, command.turnId) ||
                  this.options.getCurrentPolicyEpoch(command.taskId) !== current.policyEpoch
                )
                  return false;
                if (command.decision === 'allow_once')
                  return (
                    result.oneTimePermitToken !== undefined &&
                    (this.options.persistence.consumePermissionOneTimeToken?.(
                      command.taskId,
                      result.oneTimePermitToken,
                      current.policyEpoch,
                      this.options.now(),
                      {
                        approvalId: command.approvalId,
                        turnId: command.turnId,
                        callId: waiter.request.callId,
                        subjectId: `tool:${waiter.request.entry.toolId}`,
                        specDigest: approvalFactsForTool(waiter.request, waiter.capability)
                          .specDigest,
                      },
                    ) ??
                      true)
                  );
                // The run this card was raised for, under the app-wide grant just given.
                if (appScope) return this.desktopAppGrantCovering(waiter.request) !== null;
                if (
                  this.options.revalidateTaskGrant?.({
                    capability: waiter.capability,
                    request: waiter.request,
                  }) === true
                )
                  return true;
                if (
                  this.options.persistence.hasTaskGrant?.({
                    taskId: command.taskId,
                    requestDigest: waiter.requestDigest,
                    policyEpoch: current.policyEpoch,
                    now: this.options.now(),
                  })
                )
                  return true;
                return false;
              },
            }),
    });
    return result.approval;
  }

  turnEnded(taskId: string, turnId: string, reason: 'canceled' | 'finished'): void {
    const ended = this.options.persistence.endTurnApprovals?.(taskId, turnId, reason);
    const ids =
      ended ??
      [...this.waiters.entries()]
        .filter(([, waiter]) => waiter.taskId === taskId && waiter.turnId === turnId)
        .map(([id]) => id);
    for (const id of ids) this.release(id, { decision: 'deny', reason: `turn_${reason}` });
  }

  private saveDesktopAppGrant(taskId: string, grant: DesktopAppGrant): void {
    const grants = this.desktopAppGrants.get(taskId) ?? new Map<string, DesktopAppGrant>();
    grants.set(grant.key.id, grant);
    this.desktopAppGrants.delete(taskId);
    this.desktopAppGrants.set(taskId, grants);
    if (this.desktopAppGrants.size > DESKTOP_APP_GRANT_TASKS)
      this.desktopAppGrants.delete(this.desktopAppGrants.keys().next().value!);
  }

  /**
   * The app-wide Task grant of this Task that covers this desktop-control run, or `null`: one given
   * under the current policy epoch, not expired, for the app the run is confined to by the
   * executable's own records (`desktopAppGrantCovering`).
   */
  private desktopAppGrantCovering(request: ToolAuthorizationRequest): DesktopAppGrantKey | null {
    const { taskId, policyEpoch } = request.context;
    const grants = this.desktopAppGrants.get(taskId);
    if (grants === undefined || !validateExecutionSpec(request.input)) return null;
    if (!desktopAppGrantEnvironmentAllows(request.input)) return null;
    const now = Date.parse(this.options.now());
    const current = this.options.getCurrentPolicyEpoch(taskId);
    const live = [...grants.values()].filter(
      (grant) =>
        grant.policyEpoch === policyEpoch &&
        grant.policyEpoch === current &&
        Date.parse(grant.expiresAt) > now,
    );
    return desktopAppGrantCovering(
      request.input.argv,
      live.map(({ key }) => key),
      { taskId },
    );
  }

  policyEpochChanged(taskId: string, policyEpoch: number): void {
    this.desktopAppGrants.delete(taskId);
    const invalidated =
      this.options.persistence.invalidatePendingApprovalsForTask?.(
        taskId,
        policyEpoch,
        this.options.now(),
      ) ?? [];
    for (const result of invalidated) this.options.publish(result.approval, result.event);
    for (const [id, waiter] of this.waiters) {
      if (waiter.taskId === taskId)
        this.release(id, { decision: 'deny', reason: 'policy_epoch_changed' });
    }
  }

  dispose(): void {
    for (const id of [...this.waiters.keys()])
      this.release(id, { decision: 'deny', reason: 'application_shutdown' });
  }

  private release(id: string, decision: ToolAuthorizationDecision): void {
    const waiter = this.waiters.get(id);
    if (waiter === undefined) return;
    this.waiters.delete(id);
    for (const settler of waiter.settlers.splice(0)) {
      detachSettler(settler);
      settler.resolve(decision);
    }
  }
}

function detachSettler(settler: WaiterSettler): void {
  if (settler.signal !== undefined && settler.onAbort !== undefined)
    settler.signal.removeEventListener('abort', settler.onAbort);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Tool authorization was canceled');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

/**
 * Tells the call's host that it now waits on the user, and returns what ends that wait. The host
 * only observes: whatever its observer does, including throwing, neither decides nor fails the
 * approval (issue #573).
 */
function beginApprovalWait(
  observe: ApprovalWaitObserver | undefined,
  request: ToolAuthorizationRequest,
): () => void {
  if (observe === undefined) return () => undefined;
  const warn = (error: unknown): void =>
    secureLogger.warn(
      'The observer of an approval wait failed',
      { callId: request.callId, error },
      { taskId: request.context.taskId, turnId: request.context.turnId },
    );
  let end: (() => void) | undefined;
  try {
    end = observe();
  } catch (error) {
    warn(error);
  }
  return () => {
    try {
      end?.();
    } catch (error) {
      warn(error);
    }
  };
}

function normalizeAuthorization(
  decision: ToolAuthorizationDecision | 'allow' | 'deny' | 'approval_required',
): ToolAuthorizationDecision {
  return typeof decision === 'string' ? { decision, reason: `permission_${decision}` } : decision;
}

function resourceFor(request: ToolAuthorizationRequest): ResourceSet {
  const input = request.input as Record<string, unknown>;
  if (typeof input.origin === 'string') return { kind: 'network-origin', origin: input.origin };
  return { kind: 'external-exact', target: displayTarget(request.input) };
}

function operationFor(capability: Capability): PermissionOperation {
  if (capability === 'network.fetch') return 'fetch';
  if (capability === 'external.open') return 'open';
  if (capability === 'shell.execute') return 'execute';
  if (capability === 'secret.use') return 'use';
  if (capability === 'provider.egress') return 'egress';
  return capability.endsWith('.write') ? 'write' : 'read';
}

export function approvalFactsForTool(
  request: ToolAuthorizationRequest,
  capability: Capability,
  workspaceAuthority?: 'sealed-team-isolation',
): {
  subjectId: string;
  specDigest: string;
  resourceSet: ResourceSet;
  resource: PermissionResource;
  operation: PermissionOperation;
} {
  const operation = operationFor(capability);
  if (requiresPerCallHumanApproval(capability)) {
    // An unbound subject gets a target the policy engine rejects, so it can never be approved.
    const subject = perCallApprovalSubject(request, capability);
    const target = subject?.target ?? 'per-call-approval:unbound';
    return {
      subjectId: `tool:${request.entry.toolId}`,
      specDigest: digest({
        toolId: request.entry.toolId,
        capability,
        subject: subject?.specInput ?? null,
      }),
      resourceSet: { kind: 'external-exact', target },
      resource: { kind: 'external', target },
      operation,
    };
  }
  const disclosure = providerDisclosureAuthorizationFacts(request.input);
  const workspaceGuards = workspaceToolAuthorizationGuards(
    request.input,
    operation === 'read' || operation === 'write' ? operation : undefined,
  );
  // A batch touches several paths: the request stands for all of them, so a protected one among
  // them is the resource that gets evaluated rather than whichever came first (issue #526).
  const workspaceGuard = workspaceToolPermissionGuard(
    request.input,
    operation === 'read' || operation === 'write' ? operation : undefined,
    workspaceAuthority,
  );
  const workspaceResource =
    workspaceGuard === undefined
      ? undefined
      : workspacePermissionResourceFromGuard(workspaceGuard, workspaceAuthority);
  const commandSpec =
    request.entry.implementationKind === 'command-runner' && validateExecutionSpec(request.input)
      ? (request.input as ExecutionSpec)
      : undefined;
  const commandResource =
    commandSpec === undefined
      ? undefined
      : { kind: 'external' as const, target: `command:${executionSpecDigest(commandSpec)}` };
  const resourceSet: ResourceSet =
    disclosure !== undefined
      ? {
          kind: 'provider-disclosure-exact',
          providerId: disclosure.providerId,
          canonicalPath: disclosure.canonicalPath,
          sourceDigest: disclosure.sourceDigest,
          disclosedDigest: disclosure.disclosedDigest,
          classifierVersion: disclosure.classifierVersion,
        }
      : workspaceResource !== undefined && workspaceGuards.length > 1
        ? { kind: 'workspace', workspaceId: workspaceResource.workspaceId }
        : workspaceResource !== undefined
          ? {
              kind: 'path-exact',
              workspaceId: workspaceResource.workspaceId,
              canonicalPath: workspaceResource.canonicalPath,
            }
          : commandResource === undefined
            ? resourceFor(request)
            : { kind: 'external-exact', target: commandResource.target };
  const resource: PermissionResource =
    disclosure !== undefined
      ? {
          kind: 'provider-disclosure',
          providerId: disclosure.providerId,
          canonicalPath: disclosure.canonicalPath,
          sourceDigest: disclosure.sourceDigest,
          disclosedDigest: disclosure.disclosedDigest,
          classification: disclosure.classification,
          // Carried from the issued guard so the immutable protected-path deny still reaches this
          // lane. A disclosure without a guard cannot be placed, so it is treated as unclassified.
          pathClassification: workspaceResource?.classification ?? 'unclassified',
          reasons: disclosure.reasons,
          classifierVersion: disclosure.classifierVersion,
        }
      : (workspaceResource ??
        commandResource ??
        (resourceSet.kind === 'network-origin'
          ? { kind: 'network', origin: resourceSet.origin }
          : resourceSet.kind === 'external-exact'
            ? { kind: 'external', target: resourceSet.target }
            : { kind: 'external', target: displayTarget(request.input) }));
  return {
    subjectId: `tool:${request.entry.toolId}`,
    specDigest:
      request.entry.implementationKind === 'command-runner' && validateExecutionSpec(request.input)
        ? executionSpecDigest(request.input as ExecutionSpec)
        : disclosure !== undefined
          ? digest({ toolId: request.entry.toolId, disclosure, operation })
          : workspaceGuard === undefined
            ? digest({ toolId: request.entry.toolId, input: durableDigestInput(request.input) })
            : workspaceGuards.length > 1
              ? digest({
                  toolId: request.entry.toolId,
                  input: durableDigestInput(request.input),
                  pathGuardDigests: workspaceGuards.map(pathGuardIdentityDigest),
                  operation,
                })
              : digest({
                  toolId: request.entry.toolId,
                  pathGuardDigest: pathGuardIdentityDigest(workspaceGuard),
                  operation,
                }),
    resourceSet,
    resource,
    operation,
  };
}

/**
 * What one per-call approval is about (Issue #546): the resource it binds, the card's target line,
 * the exact content the card shows, and what the approval digest covers.
 *
 * The Project comes from the prepared input, which Main resolved from the Turn's sealed context;
 * the Task comes from the trusted execution context. Neither is read from the model's arguments.
 * Null means the call does not carry what its capability needs.
 */
type PerCallApprovalSubject = Readonly<{
  target: string;
  label: string;
  execution: string;
  /** Every text the card shows as it is: the target line and the content being approved. */
  shown: readonly string[];
  specInput: unknown;
}>;

function perCallApprovalSubject(
  request: ToolAuthorizationRequest,
  capability: Capability,
): PerCallApprovalSubject | null {
  if (capability === 'project.memory.write') {
    const memory = projectMemoryAuthorizationFacts(request.input);
    if (request.entry.providerName !== 'project_memory_remember' || memory === undefined)
      return null;
    return {
      target: `${PROJECT_MEMORY_RESOURCE_PREFIX}${memory.projectId}`,
      label: `Project「${memory.projectName}」のメモリ`,
      execution: stableStringify({
        projectId: memory.projectId,
        projectName: memory.projectName,
        content: memory.content,
      }),
      shown: [memory.projectName, memory.content],
      specInput: { projectId: memory.projectId, content: memory.content },
    };
  }
  if (capability === 'skill.draft.write') {
    const draft = skillDraftApprovalInput(request.input);
    if (request.entry.providerName !== 'skill_draft_create' || draft === null) return null;
    return {
      target: `${SKILL_DRAFT_RESOURCE_PREFIX}${request.context.taskId}`,
      label: `Skill「${draft.skillId}」の下書き`,
      execution: stableStringify(draft),
      shown: [
        draft.kind,
        draft.skillId,
        ...draft.files.flatMap(({ path, content }) => [path, content]),
      ],
      specInput: { taskId: request.context.taskId, draft },
    };
  }
  return null;
}

function skillDraftApprovalInput(input: unknown): {
  kind: string;
  skillId: string;
  files: { path: string; content: string }[];
} | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const files = record['files'];
  if (
    typeof record['kind'] !== 'string' ||
    typeof record['skillId'] !== 'string' ||
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every(
      (file) =>
        typeof file === 'object' &&
        file !== null &&
        typeof (file as Record<string, unknown>)['path'] === 'string' &&
        typeof (file as Record<string, unknown>)['content'] === 'string',
    )
  )
    return null;
  return {
    kind: record['kind'],
    skillId: record['skillId'],
    files: (files as { path: string; content: string }[]).map(({ path, content }) => ({
      path,
      content,
    })),
  };
}

/**
 * Mirrors the bounds persistence keeps an approval display within: anything longer would reach the
 * card cut short.
 */
const APPROVAL_DISPLAY_TARGET_MAX_CHARACTERS = 500;
const APPROVAL_DISPLAY_EXECUTION_MAX_CHARACTERS = 100_000;
function perCallApprovalUndisplayableReason(subject: PerCallApprovalSubject): string | undefined {
  if (subject.label.length > APPROVAL_DISPLAY_TARGET_MAX_CHARACTERS)
    return `approval_content_not_displayable: the approval card target is longer than ${APPROVAL_DISPLAY_TARGET_MAX_CHARACTERS} characters`;
  if (subject.execution.length > APPROVAL_DISPLAY_EXECUTION_MAX_CHARACTERS)
    return `approval_content_not_displayable: the approval card shows at most ${APPROVAL_DISPLAY_EXECUTION_MAX_CHARACTERS} characters of serialized content, including every file path and content`;
  if (subject.shown.some((text) => APPROVAL_DISPLAY_UNDISPLAYABLE_CHARACTERS.test(text)))
    return 'approval_content_not_displayable: the content contains invisible control or format characters (for example zero-width, bidirectional, or Unicode Tag characters) that the approval card cannot show';
  return undefined;
}

function displayTarget(input: unknown): string {
  const stdin = managedStdinAuthorizationFacts(input);
  if (stdin !== undefined) return managedStdinApprovalTarget(stdin);
  const disclosure = providerDisclosureAuthorizationFacts(input);
  if (disclosure !== undefined) return disclosure.canonicalPath;
  const workspaceGuard = workspaceToolAuthorizationGuard(input);
  if (workspaceGuard !== undefined) return workspaceGuard.originalTargetPath;
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ['origin', 'target', 'path', 'absoluteExecutable', 'executable'])
      if (typeof record[key] === 'string') return record[key];
  }
  return 'requested resource';
}

/**
 * Whether this call runs the shipped desktop-control binary, judged on the executable bytes sealed
 * when its ExecutionSpec was prepared (against the shipped file's seal), not on its path.
 */
export function isDesktopControlCall(request: ToolAuthorizationRequest): boolean {
  return (
    request.entry.implementationKind === 'command-runner' &&
    validateExecutionSpec(request.input) &&
    isDesktopControlExecutable(
      request.input.absoluteExecutable,
      executionSpecContentDigest(request.input),
    )
  );
}

/**
 * Whether this desktop-control call only prints the bundled guides, help, the version or the
 * binary's own status (see `desktopControlArgvIsInert`), judged on the argv sealed into its
 * ExecutionSpec. The command tool judges the same sealed argv again before it starts the run.
 */
export function isInertDesktopControlCall(request: ToolAuthorizationRequest): boolean {
  return (
    isDesktopControlCall(request) &&
    validateExecutionSpec(request.input) &&
    desktopControlArgvIsInert(request.input.argv)
  );
}

/**
 * Whether the run's environment leaves the executable reading its refs where the app-wide grant
 * reads them: a session or agent id (`AGENT_DESKTOP_SESSION`, `AGENT_DESKTOP_AGENT_ID`) moves them
 * to a folder the grant does not read, so such a run is never offered or covered by one.
 */
function desktopAppGrantEnvironmentAllows(spec: ExecutionSpec): boolean {
  const scoped = (key: string) =>
    ['AGENT_DESKTOP_SESSION', 'AGENT_DESKTOP_AGENT_ID'].includes(key.toUpperCase());
  return (
    !Object.keys(spec.envDelta).some(scoped) &&
    !Object.entries(process.env).some(([key, value]) => scoped(key) && value !== undefined)
  );
}

/**
 * Whether this desktop-control call takes the foreground, the cursor or the keyboard, or may close
 * an app (see `desktopControlArgvMode`), judged on the argv sealed into its ExecutionSpec. Such a
 * run is decided on its own card every time.
 */
function isForegroundDesktopControlCall(request: ToolAuthorizationRequest): boolean {
  return (
    validateExecutionSpec(request.input) &&
    desktopControlArgvMode(request.input.argv) === 'foreground'
  );
}

/**
 * What a persisted digest over a Tool input may be taken from.
 *
 * Every digest this module produces is stored — `spec_digest` on the approval row, the permission
 * audit's `execution_spec_digest`, the `allow_task` request digest — so none of them may be
 * computable from a guess. For a stdin write that means the raw characters are replaced by the
 * same keyed MAC the audit record carries: equal bytes still produce equal digests, so a task
 * grant recognises a repeat, but nobody holding the database can confirm a candidate password
 * (Issue #473).
 */

function durableDigestInput(input: unknown): unknown {
  const stdin = managedStdinAuthorizationFacts(input);
  return stdin === undefined ? input : managedStdinApprovalExecution(stdin);
}

/**
 * Detail the user needs in full to decide, which must not outlive the decision.
 *
 * A stdin write is the one approval whose subject *is* the bytes, and those bytes can be a
 * password, a Bearer token, or a private key. `safeApprovalExecution` above therefore keeps only
 * the digest and a redacted preview in the durable record, and the exact characters travel on this
 * live-only channel that persistence drops before writing anything (Issue #473).
 */
function ephemeralApprovalExecution(request: ToolAuthorizationRequest): {
  ephemeralExecution?: string;
} {
  const stdin = managedStdinAuthorizationFacts(request.input);
  return stdin === undefined ? {} : { ephemeralExecution: managedStdinEphemeralExecution(stdin) };
}

function safeApprovalExecution(request: ToolAuthorizationRequest): string {
  // The bytes are the execution here, so they belong on the card. Long input is summarised, and
  // the byte count and digest always identify exactly what was approved (Issue #473).
  const stdin = managedStdinAuthorizationFacts(request.input);
  if (stdin !== undefined) return stableStringify(managedStdinApprovalExecution(stdin));
  const resultSource = teamResultReadAuthorizationFacts(
    request.input,
    request.context,
    request.callId,
  );
  const source =
    resultSource === undefined
      ? undefined
      : {
          kind: 'team-result',
          executionId: resultSource.executionId,
          integratedHead: resultSource.integratedHead,
          contents: 'current-workspace',
        };
  const disclosure = providerDisclosureAuthorizationFacts(request.input);
  if (disclosure !== undefined)
    return stableStringify({
      tool: request.entry.providerName,
      ...(source === undefined ? {} : { source }),
      providerId: disclosure.providerId,
      path: disclosure.canonicalPath,
      classification: disclosure.classification,
      reasons: disclosure.reasons,
      sourceDigest: disclosure.sourceDigest,
      disclosedDigest: disclosure.disclosedDigest,
      classifierVersion: disclosure.classifierVersion,
      // Approval execution text is persisted for audit, so content previews never belong here.
      // Classification, reasons, and both digests retain a useful tamper-evident audit record.
      preview: '[CONTENT PREVIEW NOT PERSISTED]',
    });
  const workspaceGuard = workspaceToolAuthorizationGuard(request.input);
  if (workspaceGuard !== undefined) {
    const prepared = request.input as { raw?: unknown };
    const raw =
      typeof prepared.raw === 'object' && prepared.raw !== null
        ? (prepared.raw as Record<string, unknown>)
        : {};
    const content = typeof raw['content'] === 'string' ? raw['content'] : undefined;
    const edits = Array.isArray(raw['edits']) ? raw['edits'] : undefined;
    const operations = Array.isArray(raw['operations']) ? raw['operations'] : undefined;
    return stableStringify({
      tool: request.entry.providerName,
      ...(source === undefined ? {} : { source }),
      rootId: workspaceGuard.rootId,
      path: workspaceGuard.originalTargetPath,
      ...(content === undefined
        ? {}
        : { contentBytes: Buffer.byteLength(content, 'utf8'), contentDigest: digest(content) }),
      ...(edits === undefined ? {} : { editCount: edits.length, editsDigest: digest(edits) }),
      ...(operations === undefined
        ? {}
        : { operationCount: operations.length, operationsDigest: digest(operations) }),
    });
  }
  if (
    request.entry.implementationKind === 'command-runner' &&
    validateExecutionSpec(request.input)
  ) {
    const spec = request.input as ExecutionSpec;
    return stableStringify({
      executable: spec.absoluteExecutable,
      argv: spec.argv,
      cwd: spec.cwdIdentity.canonicalPath,
      shell: spec.shell,
      stdinMode: spec.stdinMode,
    });
  }
  return stableStringify(request.input);
}
function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
