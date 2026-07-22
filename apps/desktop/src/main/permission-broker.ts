import {
  evaluatePermissionPolicy,
  evaluateShellSegments,
  revalidateExecutionPermit,
  type AccessPreset,
  type Capability,
  type ExecutionPermit,
  type PermissionEvaluation,
  type PermissionPolicy,
  type PermissionRequest,
  type PermissionOperation,
} from '@vibe/domain';
import type { PermissionPolicyRecord, PersistenceClient } from './persistence';
import {
  pathGuardIdentityDigest,
  isIssuedPathGuard,
  workspacePermissionResourceFromGuard,
  type PathGuard,
} from './path-guard';

export type PermissionPolicyBase = Omit<
  PermissionPolicy,
  | 'rememberedGrants'
  | 'allowRules'
  | 'approvalPolicy'
  | 'approvalReason'
  | 'immutableDeny'
  | 'policyEpoch'
> & {
  allowRules?: PermissionPolicy['allowRules'];
  immutableDeny?: PermissionPolicy['immutableDeny'];
};

export interface PolicyRevocationCoordinator {
  policyEpochChanged(taskId: string, policyEpoch: number): Promise<void> | void;
}

class NoActivePolicySubjects implements PolicyRevocationCoordinator {
  policyEpochChanged(): void {
    // Slice 4.1 has no child/background/outbox entities yet. Phase 4.6 and Phase 5 must replace
    // this implementation before those subjects can be created.
  }
}

type PermissionPersistence = Pick<
  PersistenceClient,
  | 'getPermissionPolicy'
  | 'setAccessPreset'
  | 'listPermissionGrants'
  | 'revokePermissionCapability'
  | 'recordPermissionAudit'
  | 'listPendingPermissionPolicyEpochs'
  | 'markPermissionPolicyEpochDelivered'
  | 'getWorkspace'
  | 'registerPermissionOneTimeToken'
  | 'consumePermissionOneTimeToken'
  | 'commitPermissionEvaluation'
>;

export class PermissionBroker {
  private drainInFlight: Promise<void> | undefined;
  constructor(
    private readonly persistence: PermissionPersistence,
    private readonly coordinator: PolicyRevocationCoordinator = new NoActivePolicySubjects(),
  ) {}

  getPolicy(taskId: string): PermissionPolicyRecord {
    return this.persistence.getPermissionPolicy(taskId);
  }

  async setAccessPreset(
    taskId: string,
    preset: AccessPreset,
    expectedPolicyEpoch: number,
  ): Promise<PermissionPolicyRecord> {
    const policy = this.persistence.setAccessPreset(taskId, preset, expectedPolicyEpoch);
    await this.drainPolicyEpochOutbox().catch(() => undefined);
    return policy;
  }

  async notifyPolicyEpochChanged(taskId: string, policyEpoch: number): Promise<void> {
    await this.coordinator.policyEpochChanged(taskId, policyEpoch);
  }

  async drainPolicyEpochOutbox(): Promise<void> {
    if (this.drainInFlight !== undefined) return this.drainInFlight;
    this.drainInFlight = (async () => {
      for (const pending of this.persistence.listPendingPermissionPolicyEpochs()) {
        await this.notifyPolicyEpochChanged(pending.taskId, pending.policyEpoch);
        this.persistence.markPermissionPolicyEpochDelivered(pending.id, new Date().toISOString());
      }
    })();
    try {
      await this.drainInFlight;
    } finally {
      this.drainInFlight = undefined;
    }
  }

  async revokeCapability(
    taskId: string,
    capability: Capability,
    now: string,
  ): Promise<{ revokedGrants: number; policyEpoch: number }> {
    const revokedGrants = this.persistence.revokePermissionCapability(taskId, capability, now);
    const policyEpoch = this.persistence.getPermissionPolicy(taskId).policyEpoch;
    await this.drainPolicyEpochOutbox().catch(() => undefined);
    return { revokedGrants, policyEpoch };
  }

  evaluate(input: {
    taskId: string;
    request: PermissionRequest;
    basePolicy: PermissionPolicyBase;
    now: string;
    pathGuard?: PathGuard;
  }): PermissionEvaluation {
    if (input.request.capability === 'shell.execute')
      throw new Error('Shell requests must use evaluateShell so every segment is authorized');
    return this.evaluateSingle(input);
  }

  preview(input: {
    taskId: string;
    request: PermissionRequest;
    basePolicy: PermissionPolicyBase;
    now: string;
    pathGuard?: PathGuard;
  }): PermissionEvaluation {
    if (input.request.capability === 'shell.execute')
      throw new Error('Shell requests must use previewExecutionSpec');
    this.assertTrustedRequestFacts(input);
    return this.evaluateCurrentPolicy(input);
  }

  previewExecutionSpec(input: {
    taskId: string;
    request: PermissionRequest;
    basePolicy: PermissionPolicyBase;
    now: string;
    pathGuard?: PathGuard;
  }): PermissionEvaluation {
    if (input.request.capability !== 'shell.execute')
      throw new Error('ExecutionSpec preview requires shell.execute');
    this.assertTrustedRequestFacts(input);
    return this.evaluateCurrentPolicy(input);
  }

  commitEvaluation(
    input: {
      taskId: string;
      request: PermissionRequest;
      basePolicy: PermissionPolicyBase;
      now: string;
      pathGuard?: PathGuard;
    },
    evaluation: PermissionEvaluation,
    autoDecision?: Parameters<PermissionPersistence['commitPermissionEvaluation']>[3],
  ) {
    this.assertTrustedRequestFacts(input);
    if (this.persistence.getPermissionPolicy(input.taskId).policyEpoch !== evaluation.policyEpoch)
      throw new Error('Permission policy epoch changed before commit');
    return this.persistence.commitPermissionEvaluation(
      input.taskId,
      input.request,
      evaluation,
      autoDecision,
    );
  }

  evaluateExecutionSpec(input: {
    taskId: string;
    request: PermissionRequest;
    basePolicy: PermissionPolicyBase;
    now: string;
    pathGuard?: PathGuard;
  }): PermissionEvaluation {
    if (input.request.capability !== 'shell.execute')
      throw new Error('ExecutionSpec evaluation requires shell.execute');
    return this.evaluateSingle(input);
  }

  evaluateShell(input: {
    taskId: string;
    command: string;
    requestForSegment: (
      segment: { executable: string; argv: readonly string[] },
      index: number,
    ) => PermissionRequest;
    basePolicy: PermissionPolicyBase;
    now: string;
    pathGuard?: PathGuard;
  }): ReturnType<typeof evaluateShellSegments> {
    return evaluateShellSegments(input.command, (segment, index) => {
      const request = input.requestForSegment(segment, index);
      if (request.capability !== 'shell.execute')
        throw new Error('Shell segment request must require shell.execute');
      return this.evaluateSingle({
        taskId: input.taskId,
        request,
        basePolicy: {
          ...input.basePolicy,
          managedDeny: [
            ...input.basePolicy.managedDeny,
            {
              capability: 'shell.execute',
              resourceSet: { kind: 'all' },
              operations: ['execute'],
              auditReason: 'shell_execution_boundary_unavailable',
            },
          ],
        },
        now: input.now,
        ...(input.pathGuard === undefined ? {} : { pathGuard: input.pathGuard }),
      });
    });
  }

  private evaluateSingle(input: {
    taskId: string;
    request: PermissionRequest;
    basePolicy: PermissionPolicyBase;
    now: string;
    pathGuard?: PathGuard;
  }): PermissionEvaluation {
    this.assertTrustedRequestFacts(input);
    const evaluation = this.evaluateCurrentPolicy(input);
    this.commitEvaluation(input, evaluation);
    return evaluation;
  }

  private evaluateCurrentPolicy(input: {
    taskId: string;
    request: PermissionRequest;
    basePolicy: PermissionPolicyBase;
    now: string;
    pathGuard?: PathGuard;
  }): PermissionEvaluation {
    const stored = this.persistence.getPermissionPolicy(input.taskId);
    const grants = this.persistence.listPermissionGrants(
      input.taskId,
      input.request.subjectId,
      input.now,
    );
    const expanded = stored.expandedPolicy;
    return evaluatePermissionPolicy({
      request: input.request,
      now: input.now,
      policy: {
        ...input.basePolicy,
        projectDeny: [
          ...input.basePolicy.projectDeny,
          ...stored.revokedCapabilities.map((capability) => ({
            capability,
            resourceSet: { kind: 'all' as const },
            operations: [operationForCapability(capability)],
            auditReason: 'capability_revoked',
          })),
        ],
        rememberedGrants: grants,
        allowRules: [...(input.basePolicy.allowRules ?? []), ...expanded.allowRules],
        immutableDeny: [
          ...(input.basePolicy.immutableDeny ?? []),
          ...(expanded.immutableDeny ?? []),
        ],
        approvalPolicy: expanded.approvalPolicy,
        ...(expanded.approvalReason === undefined
          ? {}
          : { approvalReason: expanded.approvalReason }),
        policyEpoch: stored.policyEpoch,
      },
    });
  }

  revalidate(input: {
    taskId: string;
    permit: ExecutionPermit;
    request: PermissionRequest;
    basePolicy: PermissionPolicyBase;
    now: string;
    pathGuard?: PathGuard;
  }): ReturnType<typeof revalidateExecutionPermit> {
    try {
      this.assertTrustedRequestFacts(input);
    } catch {
      return { valid: false, reason: 'task_or_path_binding_mismatch' };
    }
    const currentEvaluation = this.evaluateCurrentPolicy(input);
    const permitResult = revalidateExecutionPermit({
      permit: input.permit,
      request: input.request,
      policyEpoch: this.persistence.getPermissionPolicy(input.taskId).policyEpoch,
      now: input.now,
      consumeOneTimeToken: (token) =>
        input.permit.source !== 'reviewer_allow_once' ||
        input.permit.reviewRequestId === undefined ||
        input.permit.turnId === undefined ||
        input.permit.callId === undefined
          ? false
          : this.persistence.consumePermissionOneTimeToken(
              input.taskId,
              token,
              input.permit.policyEpoch,
              input.now,
              {
                reviewRequestId: input.permit.reviewRequestId,
                turnId: input.permit.turnId,
                callId: input.permit.callId,
                subjectId: input.permit.subjectId,
                specDigest: input.permit.executionSpecDigest,
              },
            ),
    });
    const result =
      currentEvaluation.decision === 'allow' || currentEvaluation.decision === 'allow_once'
        ? permitResult
        : ({ valid: false, reason: 'current_policy_rejected' } as const);
    this.persistence.recordPermissionAudit(input.taskId, input.request, {
      decision: result.valid ? 'allow' : 'deny',
      reason: result.valid ? 'execution_revalidation_valid' : result.reason,
      policyEpoch: currentEvaluation.policyEpoch,
      evaluationTrace: [...currentEvaluation.evaluationTrace, 'execution-revalidation'],
      ...(result.valid ? { permit: input.permit } : {}),
    });
    return result;
  }

  private assertTrustedRequestFacts(input: {
    taskId: string;
    request: PermissionRequest;
    pathGuard?: PathGuard;
  }): void {
    if (input.taskId !== input.request.taskId) throw new Error('Permission Task binding mismatch');
    const resource = input.request.resource;
    if (resource.kind === 'external-path')
      throw new Error('External path execution boundary is not available');
    if (resource.kind !== 'workspace-path') return;
    const guard = input.pathGuard;
    const workspacePath = this.persistence.getWorkspace(input.taskId);
    if (
      guard === undefined ||
      !isIssuedPathGuard(guard) ||
      workspacePath === null ||
      guard.workspacePath !== workspacePath
    )
      throw new Error('Permission path guard is not bound to the selected workspace');
    const trusted = workspacePermissionResourceFromGuard(guard);
    if (
      trusted.workspaceId !== resource.workspaceId ||
      trusted.canonicalPath !== resource.canonicalPath ||
      trusted.identityDigest !== resource.identityDigest ||
      trusted.classification !== resource.classification ||
      pathGuardIdentityDigest(guard) !== resource.identityDigest ||
      (input.request.operation === 'read' && guard.operation !== 'read') ||
      (input.request.operation === 'write' && guard.operation !== 'write')
    )
      throw new Error('Permission path facts are not derived from the supplied guard');
    if (resource.classification !== 'workspace' && input.request.risk !== 'high')
      throw new Error('Unclassified or protected paths must be treated as high risk');
  }
}

function operationForCapability(capability: Capability): PermissionOperation {
  if (capability === 'workspace.read' || capability === 'filesystem.external.read') return 'read';
  if (capability === 'workspace.write' || capability === 'filesystem.external.write')
    return 'write';
  if (capability === 'shell.execute') return 'execute';
  if (capability === 'network.fetch') return 'fetch';
  if (capability === 'external.open') return 'open';
  if (capability === 'secret.use') return 'use';
  return 'egress';
}
