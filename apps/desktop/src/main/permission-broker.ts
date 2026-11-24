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
} from '@sprint-coder/domain';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  matchProjectPermissionRules,
  projectRuleAllowsReadTree,
  type ProjectPermissionSettings,
  type ProjectPermissionTarget,
} from './project-permission-settings';
import type { PermissionPolicyRecord, PersistenceClient } from './persistence';
import { LocalGithubPushError, readLocalGithubPush } from './local-github-push';
import {
  pathGuardIdentityDigest,
  isIssuedPathGuard,
  currentWorkspaceRootIdentityDigest,
  protectedWorkspaceRootClassification,
  protectedWorkspaceRootLabel,
  protectedWorkspaceRootLocationUnknown,
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

type PermissionEvaluationInput = {
  taskId: string;
  /** Ask the selected AI about a managed read unless an explicit rule or grant already covers it. */
  reviewWorkspaceRead?: boolean;
  turnId?: string;
  request: PermissionRequest;
  basePolicy: PermissionPolicyBase;
  now: string;
  pathGuard?: PathGuard;
  projectGuards?: readonly PathGuard[];
  projectReadTree?: boolean;
  projectCommand?: { guard: PathGuard; target: Extract<ProjectPermissionTarget, { tool: 'Bash' }> };
  projectStdin?: {
    rootId: string | undefined;
    target: Extract<ProjectPermissionTarget, { tool: 'Bash' }>;
  };
  /** A sealed, execution-specific Workspace such as a Team Worker isolation root. */
  workspace?: EffectiveWorkspaceSet;
  /** The sealed Workspace is an app-created Team isolation root, not app-private data. */
  workspaceAuthority?: 'sealed-team-isolation';
};

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
  | 'getEffectiveWorkspaceSet'
  | 'readTurnWorkspaceSetForTask'
  | 'getTurnWorkspaceRootIdentities'
  | 'registerPermissionOneTimeToken'
  | 'consumePermissionOneTimeToken'
  | 'commitPermissionEvaluation'
>;

function fileRuleDecision(
  settings: ProjectPermissionSettings,
  tool: 'Read' | 'Edit',
  root: string,
  path: string,
) {
  const name = relative(root, path);
  if (isAbsolute(name) || name === '..' || name.startsWith('..' + sep)) return 'deny';
  return matchProjectPermissionRules(settings, { tool, relativePath: name });
}

export class PermissionBroker {
  private readonly notificationsInFlight = new Map<string, Promise<void>>();
  constructor(
    private readonly persistence: PermissionPersistence,
    private readonly coordinator: PolicyRevocationCoordinator = new NoActivePolicySubjects(),
    private readonly projectPermissions?: {
      snapshot(workspacePath: string, expectedRootIdentity?: string): ProjectPermissionSettings;
    },
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
    await this.drainPolicyEpochOutbox(taskId).catch(() => undefined);
    return policy;
  }

  async notifyPolicyEpochChanged(taskId: string, policyEpoch: number): Promise<void> {
    const key = JSON.stringify([taskId, policyEpoch]);
    const existing = this.notificationsInFlight.get(key);
    if (existing !== undefined) return existing;
    const notification = Promise.resolve(this.coordinator.policyEpochChanged(taskId, policyEpoch));
    this.notificationsInFlight.set(key, notification);
    try {
      await notification;
    } finally {
      if (this.notificationsInFlight.get(key) === notification)
        this.notificationsInFlight.delete(key);
    }
  }

  async drainPolicyEpochOutbox(taskId?: string): Promise<void> {
    const pending = this.persistence
      .listPendingPermissionPolicyEpochs()
      .filter((entry) => taskId === undefined || entry.taskId === taskId);
    const taskIds = [...new Set(pending.map((entry) => entry.taskId))];
    const results = await Promise.allSettled(
      taskIds.map(async (pendingTaskId) => {
        // Older rows must never invalidate approvals or background work admitted at the current epoch.
        const epoch = this.persistence.getPermissionPolicy(pendingTaskId).policyEpoch;
        await this.notifyPolicyEpochChanged(pendingTaskId, epoch);
        for (const entry of pending) {
          if (entry.taskId === pendingTaskId && entry.policyEpoch <= epoch)
            this.persistence.markPermissionPolicyEpochDelivered(entry.id, new Date().toISOString());
        }
      }),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Permission cleanup incomplete',
      );
  }

  async revokeCapability(
    taskId: string,
    capability: Capability,
    now: string,
  ): Promise<{ revokedGrants: number; policyEpoch: number }> {
    const revokedGrants = this.persistence.revokePermissionCapability(taskId, capability, now);
    const policyEpoch = this.persistence.getPermissionPolicy(taskId).policyEpoch;
    await this.drainPolicyEpochOutbox(taskId).catch(() => undefined);
    return { revokedGrants, policyEpoch };
  }

  evaluate(input: PermissionEvaluationInput): PermissionEvaluation {
    if (input.request.capability === 'shell.execute')
      throw new Error('Shell requests must use evaluateShell so every segment is authorized');
    return this.evaluateSingle(input);
  }

  preview(input: PermissionEvaluationInput): PermissionEvaluation {
    if (input.request.capability === 'shell.execute')
      throw new Error('Shell requests must use previewExecutionSpec');
    this.assertTrustedRequestFacts(input);
    return this.evaluateCurrentPolicy(input);
  }

  previewExecutionSpec(input: PermissionEvaluationInput): PermissionEvaluation {
    if (input.request.capability !== 'shell.execute')
      throw new Error('ExecutionSpec preview requires shell.execute');
    this.assertTrustedRequestFacts(input);
    return this.evaluateCurrentPolicy(input);
  }

  commitEvaluation(
    input: PermissionEvaluationInput,
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

  evaluateExecutionSpec(input: PermissionEvaluationInput): PermissionEvaluation {
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

  private evaluateSingle(input: PermissionEvaluationInput): PermissionEvaluation {
    this.assertTrustedRequestFacts(input);
    const evaluation = this.evaluateCurrentPolicy(input);
    this.commitEvaluation(input, evaluation);
    return evaluation;
  }

  private policyWorkspace(taskId: string, turnId?: string) {
    return turnId === undefined
      ? this.persistence.getEffectiveWorkspaceSet(taskId)
      : this.persistence.readTurnWorkspaceSetForTask(taskId, turnId);
  }

  private settingsForRoot(
    workspace: EffectiveWorkspaceSet | null,
    issuedRootId: string | undefined,
  ) {
    const rootId = issuedRootId === 'legacy-primary' ? workspace?.primaryRootId : issuedRootId;
    const root = workspace?.roots.find((entry) => entry.rootId === rootId);
    // Team isolation preserves root IDs. The original root, not a worker-editable worktree,
    // supplies the rules even when the actual guarded read/write takes place under isolation.
    return root === undefined ? undefined : this.projectPermissions?.snapshot(root.path);
  }

  async prepareLocalGithubPush(input: {
    taskId: string;
    turnId: string;
    rootId: string;
    commitOid: string;
    signal: AbortSignal;
  }) {
    const { taskId, turnId, rootId, commitOid, signal } = input;
    signal.throwIfAborted();
    const workspace = this.persistence.readTurnWorkspaceSetForTask(taskId, turnId);
    const root = workspace?.roots.find((entry) => entry.rootId === rootId);
    const expectedRootIdentity = this.persistence
      .getTurnWorkspaceRootIdentities(turnId)
      .get(rootId);
    if (!workspace || !root || root.status !== 'available' || !expectedRootIdentity)
      throw new LocalGithubPushError('workspace_changed');
    if (currentWorkspaceRootIdentityDigest(root.path) !== expectedRootIdentity)
      throw new LocalGithubPushError('workspace_changed');
    if (protectedWorkspaceRootClassification(root.path) !== null)
      throw new LocalGithubPushError('protected_path');
    const snapshot = this.projectPermissions?.snapshot(root.path, expectedRootIdentity);
    const policy = this.persistence.getPermissionPolicy(taskId);
    if (!snapshot?.valid || policy.revokedCapabilities.includes('workspace.read'))
      throw new LocalGithubPushError('protected_path');
    const isCurrent = () => {
      const current = this.persistence.getPermissionPolicy(taskId);
      return (
        current.policyEpoch === policy.policyEpoch &&
        !current.revokedCapabilities.includes('workspace.read') &&
        this.persistence.getEffectiveWorkspaceSet(taskId).digest === workspace.digest &&
        this.persistence.readTurnWorkspaceSetForTask(taskId, turnId)?.digest === workspace.digest &&
        this.persistence.getTurnWorkspaceRootIdentities(turnId).get(rootId) === expectedRootIdentity
      );
    };
    const prepared = await readLocalGithubPush({
      workspacePath: root.path,
      expectedRootIdentity,
      commitOid,
      signal,
      isCurrent,
      allowsPath: (path) => fileRuleDecision(snapshot, 'Read', root.path, path) !== 'deny',
    });
    const isStillAuthorized = () => {
      if (signal.aborted || !isCurrent() ||
        currentWorkspaceRootIdentityDigest(root.path) !== expectedRootIdentity)
        return false;
      const latest = this.projectPermissions?.snapshot(root.path, expectedRootIdentity);
      return !!latest?.valid &&
        latest.digest === snapshot.digest &&
        latest.deny.length === snapshot.deny.length &&
        latest.deny.every((rule, index) => rule === snapshot.deny[index]);
    };
    if (!isStillAuthorized()) throw new LocalGithubPushError('workspace_changed');
    return Object.freeze({ prepared, isStillAuthorized });
  }

  workspaceReadFilter(
    taskId: string,
    turnId: string,
    guard: PathGuard,
  ): (absolutePath: string) => boolean {
    if (!this.projectPermissions) return () => true;
    const settings = this.settingsForRoot(this.policyWorkspace(taskId, turnId), guard.rootId);
    if (!settings?.valid) return () => false;
    // The directory action was authorized separately. Searching many files only needs to
    // exclude names denied by this snapshot.
    const readDenials = settings.deny.filter((rule) => rule === 'Read' || rule.startsWith('Read('));
    if (!readDenials.length) return () => true;
    const restrictions = { ...settings, allow: [], deny: readDenials };
    return (path) => fileRuleDecision(restrictions, 'Read', guard.workspacePath, path) !== 'deny';
  }

  projectDecision(input: PermissionEvaluationInput): 'deny' | 'allow' | null {
    if (!this.projectPermissions) return null;
    const { request, projectCommand, projectStdin } = input;
    const guards = input.projectGuards ?? (input.pathGuard ? [input.pathGuard] : []);
    if (!projectCommand && !projectStdin && guards.length === 0) return null;
    const workspace = this.policyWorkspace(input.taskId, input.turnId);
    if (projectCommand) {
      const settings = this.settingsForRoot(workspace, projectCommand.guard.rootId);
      if (!settings || !workspace) return 'deny';
      const target = projectCommand.target;
      // A PATH entry can be a Workspace folder on Windows. A project-built namesake must not
      // inherit an allow written for an installed program on the machine.
      const inWorkspace = workspace.roots.some((root) => {
        const name = relative(root.path, target.executable);
        return !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep);
      });
      return matchProjectPermissionRules(
        settings,
        inWorkspace ? { ...target, trustedExecutableName: undefined } : target,
      );
    }
    if (projectStdin) {
      // stdin carries new instructions for an existing process. Its parent's allow never grants it.
      const settings = this.settingsForRoot(workspace, projectStdin.rootId);
      return !settings || matchProjectPermissionRules(settings, projectStdin.target) === 'deny'
        ? 'deny'
        : null;
    }
    if (request.capability !== 'workspace.read' && request.capability !== 'workspace.write')
      return null;
    const tool = request.capability === 'workspace.read' ? 'Read' : 'Edit';
    let allAllowed = guards.length > 0;
    const snapshots = new Map<string, ProjectPermissionSettings>();
    for (const guard of guards) {
      if (!isIssuedPathGuard(guard)) return 'deny';
      const settings = snapshots.get(guard.rootId) ?? this.settingsForRoot(workspace, guard.rootId);
      if (!settings) return 'deny';
      // A hard-linked image may also be named by a denied path; its other names are not sealed.
      if (
        tool === 'Read' &&
        guard.targetIdentity?.kind === 'file' &&
        guard.targetIdentity.nlink > 1 &&
        settings.deny.some((rule) => rule === 'Read' || rule.startsWith('Read('))
      )
        return 'deny';
      snapshots.set(guard.rootId, settings);
      const paths = new Set([
        guard.resolvedPath,
        resolve(guard.workspacePath, guard.originalTargetPath),
      ]);
      for (const path of paths) {
        const decision = fileRuleDecision(settings, tool, guard.workspacePath, path);
        if (decision === 'deny') return 'deny';
        if (decision !== 'allow') allAllowed = false;
        if (
          input.projectReadTree &&
          !projectRuleAllowsReadTree(settings, relative(guard.workspacePath, path))
        )
          allAllowed = false;
      }
    }
    return allAllowed && request.resource.kind === 'workspace-path' ? 'allow' : null;
  }

  private evaluateCurrentPolicy(input: PermissionEvaluationInput): PermissionEvaluation {
    const stored = this.persistence.getPermissionPolicy(input.taskId);
    const grants = this.persistence.listPermissionGrants(
      input.taskId,
      input.request.subjectId,
      input.now,
    );
    const expanded = stored.expandedPolicy;
    const projectDecision = this.projectDecision(input);
    const projectRule = {
      capability: input.request.capability,
      resourceSet: { kind: 'all' as const },
      operations: [input.request.operation],
      auditReason: projectDecision === 'allow' ? 'project_settings_allow' : 'project_settings_deny',
    };
    return evaluatePermissionPolicy({
      request: input.request,
      now: input.now,
      policy: {
        ...input.basePolicy,
        projectDeny: [
          ...input.basePolicy.projectDeny,
          ...(projectDecision === 'deny' ? [projectRule] : []),
          ...stored.revokedCapabilities.map((capability) => ({
            capability,
            resourceSet: { kind: 'all' as const },
            operations: [operationForCapability(capability)],
            auditReason: 'capability_revoked',
          })),
        ],
        rememberedGrants: grants,
        allowRules: [
          ...(input.basePolicy.allowRules ?? []),
          ...expanded.allowRules.filter(
            (rule) =>
              !(
                stored.preset === 'auto' &&
                input.reviewWorkspaceRead &&
                rule.auditReason === 'preset_auto_safe'
              ),
          ),
          ...(projectDecision === 'allow' ? [projectRule] : []),
        ],
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

  revalidate(
    input: PermissionEvaluationInput & { permit: ExecutionPermit },
  ): ReturnType<typeof revalidateExecutionPermit> {
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
    turnId?: string;
    request: PermissionRequest;
    pathGuard?: PathGuard;
    workspace?: EffectiveWorkspaceSet;
    workspaceAuthority?: 'sealed-team-isolation';
  }): void {
    if (input.taskId !== input.request.taskId) throw new Error('Permission Task binding mismatch');
    const resource = input.request.resource;
    if (resource.kind === 'external-path')
      throw new Error('External path execution boundary is not available');
    if (resource.kind !== 'workspace-path') return;
    const guard = input.pathGuard;
    const workspace =
      input.workspace ??
      (input.turnId === undefined
        ? this.persistence.getEffectiveWorkspaceSet(input.taskId)
        : this.persistence.readTurnWorkspaceSetForTask(input.taskId, input.turnId));
    if (workspace === null) throw new Error('Permission Turn Workspace snapshot is unavailable');
    const rootId = guard?.rootId === 'legacy-primary' ? workspace.primaryRootId : guard?.rootId;
    const root = workspace.roots.find((candidate) => candidate.rootId === rootId);
    if (
      guard === undefined ||
      !isIssuedPathGuard(guard) ||
      root === undefined ||
      guard.workspacePath !== root.path
    )
      throw new Error('Permission path guard is not bound to an effective Workspace root');
    const trusted = workspacePermissionResourceFromGuard(guard, input.workspaceAuthority);
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
      throw new Error(
        protectedWorkspaceRootDenialReason(guard, input.workspaceAuthority) ??
          'Unclassified or protected paths must be treated as high risk',
      );
  }
}

/**
 * What a refused request is told when its Workspace root itself sits in a protected place (Issues
 * #830, #836). Every path under such a root classifies as protected, so the same reason applies
 * whether the trusted-facts check above refuses a low-risk request or the immutable protected-path
 * deny refuses a high-risk one. `undefined` for an ordinary root: a protected file inside it keeps
 * the policy's own reason.
 */
export function protectedWorkspaceRootDenialReason(
  guard: PathGuard | undefined,
  workspaceAuthority?: 'sealed-team-isolation',
): string | undefined {
  if (guard === undefined) return undefined;
  const protectedRoot = protectedWorkspaceRootClassification(
    guard.workspacePath,
    workspaceAuthority,
  );
  return protectedRoot === null
    ? undefined
    : protectedWorkspaceRootMessage(
        protectedRoot,
        protectedWorkspaceRootLocationUnknown(guard.workspacePath, workspaceAuthority),
      );
}

/**
 * `locationUnknown`: the protected folder itself could not be located, so the Workspace is
 * protected only because a folder above it has that folder's name (#838), and the reason says so.
 */
export function protectedWorkspaceRootMessage(
  classification: NonNullable<ReturnType<typeof protectedWorkspaceRootClassification>>,
  locationUnknown = false,
): string {
  const place = `保護された場所（${protectedWorkspaceRootLabel(classification)}）`;
  const where = locationUnknown
    ? `${place}にある可能性があるため（保護フォルダの実際の場所を特定できず、同じ名前のフォルダを保護しています）`
    : `${place}にあるため`;
  return `このWorkspaceは${where}、AIはここでファイルの読み書きができません（コマンドの実行はほかの場所と同じ扱いで、承認の要否は権限の設定に従います）。ドキュメントなど通常のフォルダへ移動してから、Projectのフォルダに設定し直してください。`;
}

function operationForCapability(capability: Capability): PermissionOperation {
  if (capability === 'workspace.read' || capability === 'filesystem.external.read') return 'read';
  if (
    capability === 'workspace.write' ||
    capability === 'filesystem.external.write' ||
    capability === 'project.memory.write' ||
    capability === 'skill.draft.write'
  )
    return 'write';
  if (capability === 'shell.execute') return 'execute';
  if (capability === 'network.fetch') return 'fetch';
  if (capability === 'external.open') return 'open';
  if (capability === 'secret.use') return 'use';
  return 'egress';
}
