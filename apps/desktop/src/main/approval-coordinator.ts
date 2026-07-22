import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalDecision } from '@vibe/contracts';
import type {
  Capability,
  PermissionOperation,
  PermissionResource,
  ResourceSet,
} from '@vibe/domain';
import type { ToolAuthorizationDecision, ToolAuthorizationRequest } from './tool-broker';
import type { ApprovalRequestInput, ApprovalResolutionInput } from './persistence';

type ApprovalLike = {
  id: string;
  taskId: string;
  turnId: string;
  callId: string;
  policyEpoch: number;
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
  expectedRevision: number;
  challenge: string;
  operationId: string;
};

type Waiter = {
  taskId: string;
  turnId: string;
  requestDigest: string;
  request: ToolAuthorizationRequest;
  capability: Capability;
  resolvers: ((decision: ToolAuthorizationDecision) => void)[];
};

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
      }) => 'allow' | 'deny' | 'approval_required';
      publish: {
        bivarianceHack(approval: ApprovalLike, event?: unknown): void;
      }['bivarianceHack'];
    },
  ) {}

  async authorizeTool(request: ToolAuthorizationRequest): Promise<ToolAuthorizationDecision> {
    const required = request.entry.requiredCapabilities;
    if (required.length === 0) return { decision: 'allow', reason: 'no_capability_required' };

    const evaluations = required.map((capability) => ({
      capability,
      decision: this.options.evaluatePermission({ capability, request }),
    }));
    if (evaluations.some(({ decision }) => decision === 'deny'))
      return { decision: 'deny', reason: 'permission_denied' };
    const revalidators: (() => boolean)[] = [];
    for (const evaluation of evaluations) {
      if (evaluation.decision === 'allow') {
        revalidators.push(
          () =>
            this.options.evaluatePermission({
              capability: evaluation.capability,
              request,
            }) === 'allow',
        );
        continue;
      }
      const decision = await this.requestCapabilityApproval(request, evaluation.capability);
      if (decision.decision !== 'allow') return decision;
      revalidators.push(decision.beforeExecute ?? (() => false));
    }
    return {
      decision: 'allow',
      reason: 'all_capabilities_allowed',
      beforeExecute: () => revalidators.every((revalidate) => revalidate()),
    };
  }

  private async requestCapabilityApproval(
    request: ToolAuthorizationRequest,
    capability: Capability,
  ): Promise<ToolAuthorizationDecision> {
    const requestDigest = digest({
      toolId: request.entry.toolId,
      schemaDigest: request.entry.schemaDigest,
      input: request.input,
      capability,
      policyEpoch: request.context.policyEpoch,
    });
    if (
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
      sandboxProfile: 'read-only',
      risk: request.entry.risk,
      reasonUntrusted: `Tool ${request.entry.providerName} requests ${capability}`,
      display: {
        target: displayTarget(request.input),
        impact: request.entry.sideEffect,
        execution: stableStringify(request.input),
      },
      challenge,
      challengeHash: digest(challenge),
      expiresAt: this.options.expiresAt(),
      requestedAt: this.options.now(),
    });

    return new Promise<ToolAuthorizationDecision>((resolve) => {
      const persistedId = persisted.approval.id;
      const existing = this.waiters.get(persistedId);
      if (existing !== undefined) {
        if (existing.requestDigest !== requestDigest) throw new Error('APPROVAL_WAITER_CONFLICT');
        existing.resolvers.push(resolve);
        return;
      }
      this.waiters.set(persistedId, {
        taskId: request.context.taskId,
        turnId: request.context.turnId,
        requestDigest,
        request,
        capability,
        resolvers: [resolve],
      });
      // Persistence commits before this notification; the waiter is installed before Renderer can reply.
      this.options.publish(persisted.approval, persisted.event);
    });
  }

  resolve(command: ResolveCommand): ApprovalLike {
    const current = this.options.persistence.getApproval(command.taskId, command.approvalId);
    if (current === undefined) throw new Error('APPROVAL_NOT_FOUND');
    if (current.turnId !== command.turnId) throw new Error('APPROVAL_TASK_OR_TURN_MISMATCH');
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

    const waiter = this.waiters.get(command.approvalId);
    if (command.decision === 'allow_task' && waiter !== undefined)
      this.options.persistence.saveTaskGrant?.({
        taskId: command.taskId,
        requestDigest: waiter.requestDigest,
        policyEpoch: current.policyEpoch,
        expiresAt: this.options.expiresAt(),
      });
    this.release(command.approvalId, {
      decision: command.decision === 'deny' ? 'deny' : 'allow',
      reason: `approval_${command.decision}`,
      ...(command.decision === 'deny' || waiter === undefined
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
                this.options.persistence.hasTaskGrant?.({
                  taskId: command.taskId,
                  requestDigest: waiter.requestDigest,
                  policyEpoch: current.policyEpoch,
                  now: this.options.now(),
                })
              )
                return true;
              return (
                this.options.evaluatePermission({
                  capability: waiter.capability,
                  request: waiter.request,
                }) === 'allow'
              );
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

  private release(id: string, decision: ToolAuthorizationDecision): void {
    const waiter = this.waiters.get(id);
    if (waiter === undefined) return;
    this.waiters.delete(id);
    for (const resolve of waiter.resolvers) resolve(decision);
  }
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
): {
  subjectId: string;
  specDigest: string;
  resourceSet: ResourceSet;
  resource: PermissionResource;
  operation: PermissionOperation;
} {
  const resourceSet = resourceFor(request);
  const resource: PermissionResource =
    resourceSet.kind === 'network-origin'
      ? { kind: 'network', origin: resourceSet.origin }
      : resourceSet.kind === 'external-exact'
        ? { kind: 'external', target: resourceSet.target }
        : { kind: 'external', target: displayTarget(request.input) };
  return {
    subjectId: `tool:${request.entry.toolId}`,
    specDigest: digest({ toolId: request.entry.toolId, input: request.input }),
    resourceSet,
    resource,
    operation: operationFor(capability),
  };
}

function displayTarget(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ['origin', 'target', 'path', 'executable'])
      if (typeof record[key] === 'string') return record[key];
  }
  return 'requested resource';
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
