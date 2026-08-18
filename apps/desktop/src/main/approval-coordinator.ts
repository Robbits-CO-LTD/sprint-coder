import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalDecision } from '@sprint-coder/contracts';
import type {
  Capability,
  PermissionOperation,
  PermissionResource,
  ResourceSet,
  ExecutionSpec,
} from '@sprint-coder/domain';
import { executionSpecDigest, validateExecutionSpec } from '@sprint-coder/domain';
import type { ToolAuthorizationDecision, ToolAuthorizationRequest } from './tool-broker';
import type { ApprovalRequestInput, ApprovalResolutionInput } from './persistence';
import { pathGuardIdentityDigest, workspacePermissionResourceFromGuard } from './path-guard';
import {
  providerDisclosureAuthorizationFacts,
  workspaceToolAuthorizationGuard,
  workspaceToolAuthorizationGuards,
} from './provider-workspace-tools';

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
      }) =>
        | ToolAuthorizationDecision
        | 'allow'
        | 'deny'
        | 'approval_required'
        | Promise<ToolAuthorizationDecision | 'allow' | 'deny' | 'approval_required'>;
      publish: {
        bivarianceHack(approval: ApprovalLike, event?: unknown): void;
      }['bivarianceHack'];
    },
  ) {}

  async authorizeTool(request: ToolAuthorizationRequest): Promise<ToolAuthorizationDecision> {
    const required = request.entry.requiredCapabilities;
    if (required.length === 0) return { decision: 'allow', reason: 'no_capability_required' };

    const evaluations: Array<{ capability: Capability; decision: ToolAuthorizationDecision }> = [];
    for (const capability of required) {
      const evaluated = await this.options.evaluatePermission({ capability, request });
      evaluations.push({ capability, decision: normalizeAuthorization(evaluated) });
    }
    if (evaluations.some(({ decision }) => decision.decision === 'deny'))
      return { decision: 'deny', reason: 'permission_denied' };
    const revalidators: (() => boolean)[] = [];
    for (const evaluation of evaluations) {
      if (evaluation.decision.decision === 'allow') {
        revalidators.push(evaluation.decision.beforeExecute ?? (() => false));
        continue;
      }
      if (evaluation.decision.beforeExecute !== undefined)
        revalidators.push(evaluation.decision.beforeExecute);
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
      sandboxProfile: request.entry.implementationKind === 'command-runner' ? 'full' : 'read-only',
      risk: request.entry.risk,
      reasonUntrusted: `Tool ${request.entry.providerName} requests ${capability}`,
      display: {
        target: displayTarget(request.input),
        impact: request.entry.sideEffect,
        execution: safeApprovalExecution(request),
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
    for (const resolve of waiter.resolvers) resolve(decision);
  }
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
): {
  subjectId: string;
  specDigest: string;
  resourceSet: ResourceSet;
  resource: PermissionResource;
  operation: PermissionOperation;
} {
  const operation = operationFor(capability);
  const disclosure = providerDisclosureAuthorizationFacts(request.input);
  const workspaceGuards = workspaceToolAuthorizationGuards(
    request.input,
    operation === 'read' || operation === 'write' ? operation : undefined,
  );
  const workspaceGuard =
    workspaceGuards[0] ??
    workspaceToolAuthorizationGuard(
      request.input,
      operation === 'read' || operation === 'write' ? operation : undefined,
    );
  const workspaceResource =
    workspaceGuard === undefined ? undefined : workspacePermissionResourceFromGuard(workspaceGuard);
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
            ? digest({ toolId: request.entry.toolId, input: request.input })
            : workspaceGuards.length > 1
              ? digest({
                  toolId: request.entry.toolId,
                  input: request.input,
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

function displayTarget(input: unknown): string {
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

function safeApprovalExecution(request: ToolAuthorizationRequest): string {
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
