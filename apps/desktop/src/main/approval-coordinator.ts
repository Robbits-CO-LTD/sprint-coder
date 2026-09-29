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
import { pathGuardIdentityDigest, workspacePermissionResourceFromGuard } from './path-guard';
import { secureLogger } from './secure-logger';
import {
  projectMemoryAuthorizationFacts,
  providerDisclosureAuthorizationFacts,
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
};

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
    if (evaluations.some(({ decision }) => decision.decision === 'deny'))
      return { decision: 'deny', reason: 'permission_denied' };
    const revalidators: (() => boolean)[] = [];
    let approvalDecision: ToolAuthorizationDecision['approvalDecision'];
    let userInputSelection: number | undefined;
    for (const evaluation of evaluations) {
      // The policy engine never allows a per-call capability, and if it ever did, the person would
      // still be asked: only their decision on this call's card covers this call.
      if (
        evaluation.decision.decision === 'allow' &&
        !requiresPerCallHumanApproval(evaluation.capability)
      ) {
        revalidators.push(evaluation.decision.beforeExecute ?? (() => false));
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
      revalidators.push(decision.beforeExecute ?? (() => false));
    }
    return {
      decision: 'allow',
      reason: 'all_capabilities_allowed',
      beforeExecute: () => revalidators.every((revalidate) => revalidate()),
      ...(approvalDecision === undefined ? {} : { approvalDecision }),
      ...(userInputSelection === undefined ? {} : { userInputSelection }),
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
    // A per-call capability never reuses a Task grant, including one left by an earlier version.
    if (
      !perCall &&
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
    // Approved one call at a time (Issue #546). Refused before anything is recorded, whether or not
    // this process still holds the waiter, so no Task grant can come out of such a card.
    if (
      command.decision === 'allow_task' &&
      ((waiter !== undefined && requiresPerCallHumanApproval(waiter.capability)) ||
        (current.capability !== undefined && requiresPerCallHumanApproval(current.capability)))
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
      waiter !== undefined &&
      waiter.request.entry.providerName !== 'request_user_input'
    )
      this.options.persistence.saveTaskGrant?.({
        taskId: command.taskId,
        requestDigest: waiter.requestDigest,
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

  policyEpochChanged(taskId: string, policyEpoch: number): void {
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
  if (capability === 'computer.observe') return 'observe';
  if (capability === 'computer.control') return 'control';
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
/**
 * Characters the card would not show as themselves, so the person would approve text they did not
 * read. Control characters (other than tab, line feed, and carriage return) and format characters
 * draw as nothing or reorder what is drawn; line and paragraph separators, private-use, and
 * unassigned codepoints have no reliable glyph.
 *
 * `\p{Cf}` rather than a hand-picked list, for the reason `computerUseUntrustedTextSchemaOf` in the
 * contracts gives: the Unicode Tag block (U+E0000-U+E007F) spells a whole sentence in invisible
 * codepoints, which would then sit in Project memory and be read by every later Turn, and a single
 * U+200B inside a token is enough to hide it from the secret scanner. ZWJ is a format character, so
 * an emoji joined by it is refused, which is accepted.
 *
 * Unlike the contracts, combining marks as a whole stay allowed, since NFD Japanese depends on them.
 * The ones that never draw are refused through Unicode's Default_Ignorable_Code_Point rather than a
 * list of names, which kept missing some (the Khmer inherent vowels U+17B4 and U+17B5, for one):
 * each hides a token from the secret scanner as U+200B does, and a run of variation selectors
 * carries one byte apiece. Only the two a card needs to draw are allowed, and only where they draw
 * something: one U+FE0E or U+FE0F choosing an emoji or text form, and one ideographic variation
 * selector after a Han character, which Japanese names need. Either repeated, or an ideographic
 * selector after anything else, is refused.
 */
const APPROVAL_DISPLAY_UNDISPLAYABLE_CHARACTERS =
  /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]|(?![\t\n\r])\p{Cc}|(?![\uFE0E\uFE0F\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}|(?<=[\uFE00-\uFE0F\u{E0100}-\u{E01EF}])[\uFE0E\uFE0F]|(?<!\p{Script=Han})[\u{E0100}-\u{E01EF}]/u;

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
  const disclosure = providerDisclosureAuthorizationFacts(request.input);
  if (disclosure !== undefined)
    return stableStringify({
      tool: request.entry.providerName,
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
