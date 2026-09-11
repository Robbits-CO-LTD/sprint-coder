import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  EffectiveWorkspaceSet,
  GraphDocument,
  GraphMissionReview,
  GraphSourceCheckInput,
} from '@sprint-coder/contracts';
import type { AgentRecord, TeamRecord, PersistenceClient } from './persistence';
import {
  createPathGuard,
  revalidatePathGuard,
  workspaceMutationBinding,
  PathGuardError,
  type PathGuard,
} from './path-guard';
import { previewGraphSource } from './graph-source-preview';
import { canonicalGraphJson } from './graph-document';

export type GraphMissionReviewContext = {
  workspace: EffectiveWorkspaceSet;
  rootIdentities: ReadonlyMap<string, string>;
  policyEpoch: number;
  team: Pick<TeamRecord, 'id' | 'taskId' | 'state' | 'leaderAgentId'> | null;
  workers: readonly (Pick<
    AgentRecord,
    'id' | 'taskId' | 'teamId' | 'kind' | 'state' | 'writeCapable'
  > & { authorityDigest?: string })[];
  busyWorkerIds: readonly string[];
};
type Issue = GraphMissionReview['issues'][number];
export type GraphMissionClaimBinding = {
  stepKey: string;
  rootId: string;
  rootIdentityDigest: string;
  canonicalPath: string;
  /** Missing suffixes remain explicit: their alias/conflict rules must be resolved at admission. */
  missingSuffix: readonly string[];
  guard: PathGuard;
  semanticKeys: readonly string[];
};
export type GraphMissionResourceBinding = {
  stepKey: string;
  key: string;
  scope: 'machine' | 'workspace';
  rootIdentityDigest: string | null;
};

export function graphMissionContextSnapshot(
  context: GraphMissionReviewContext,
  workerIds: ReadonlySet<string>,
) {
  return {
    workspace: context.workspace,
    roots: [...context.rootIdentities].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    policyEpoch: context.policyEpoch,
    team: context.team,
    workers: context.workers
      .filter((worker) => workerIds.has(worker.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    busyWorkerIds: context.busyWorkerIds.filter((id) => workerIds.has(id)).sort(),
  };
}
export function graphMissionContextDigest(
  context: GraphMissionReviewContext,
  workerIds: ReadonlySet<string>,
): string {
  return createHash('sha256')
    .update(canonicalGraphJson(graphMissionContextSnapshot(context, workerIds)))
    .digest('hex');
}

/** Resolve declarations using only the Task's current roots. Never create missing directories. */
async function bindClaim(
  rootId: string,
  workspacePath: string,
  expectedRootIdentityDigest: string,
  path: string | null,
): Promise<Omit<GraphMissionClaimBinding, 'stepKey' | 'semanticKeys'>> {
  const parts = path?.split('/') ?? [];
  if (parts.length > 64) throw new PathGuardError('INVALID_PATH', 'Claim path is too deep');
  const guardFor = (targetPath: string) =>
    createPathGuard({
      rootId,
      workspacePath,
      expectedRootIdentityDigest,
      targetPath,
      operation: 'write',
    });
  const bound = (guard: PathGuard, missingSuffix: readonly string[] = []) => ({
    rootId,
    rootIdentityDigest: guard.rootIdentityDigest,
    canonicalPath: join(guard.resolvedPath, ...missingSuffix),
    missingSuffix,
    guard,
  });
  try {
    return bound(await guardFor(path ?? '.'));
  } catch (error) {
    if (!(error instanceof PathGuardError) || error.code !== 'PATH_NOT_FOUND' || path === null)
      throw error;
  }
  // Stop at the first proven missing entry. Never reinterpret a dangling/escaping symlink as
  // a missing parent by walking back past it.
  for (let length = 1; length <= parts.length; length++) {
    const guard = await guardFor(parts.slice(0, length).join('/'));
    if (guard.targetIdentity === null || length === parts.length)
      return bound(guard, parts.slice(length));
  }
  throw new PathGuardError('PATH_NOT_FOUND', 'Claim target could not be resolved');
}

/** Read-only preparation for human review. A matched review grants no execution permission;
 * agreement/start must perform fresh preparation and atomically bind the resulting state. */
export async function reviewGraphMission(
  input: GraphSourceCheckInput,
  document: GraphDocument,
  currentContext: () => GraphMissionReviewContext,
): Promise<{
  summary: GraphMissionReview;
  claims: GraphMissionClaimBinding[];
  resources: GraphMissionResourceBinding[];
  contextDigest: string;
}> {
  const context = currentContext();
  const workerIds = new Set(document.missionPlan?.steps.map((step) => step.workerId) ?? []);
  const initialDigest = graphMissionContextDigest(context, workerIds);
  const issues: Issue[] = [];
  const claims: GraphMissionClaimBinding[] = [];
  const resources: GraphMissionResourceBinding[] = [];
  const resourceGuards: PathGuard[] = [];
  const usedRoots = new Map<string, { path: string; identity: string }>();
  const add = (
    code: Issue['code'],
    stepKey: string | null = null,
    rootId: string | null = null,
    path: string | null = null,
  ) => issues.push({ code, stepKey, rootId, path });
  const resolveRoot = (id: string) =>
    context.workspace.roots.find(
      (root) => root.rootId === (id === 'legacy-primary' ? context.workspace.primaryRootId : id),
    );
  if (document.taskId !== input.taskId || document.renderRevision !== input.renderRevision)
    throw new Error('Graph review document mismatch');
  if (!document.missionPlan) add('plan_missing');
  else {
    if (!context.team || context.team.taskId !== input.taskId || context.team.state !== 'active')
      add('team_unavailable');
    for (const step of document.missionPlan.steps) {
      const worker = context.workers.find(
        (worker) =>
          worker.id === step.workerId &&
          worker.taskId === input.taskId &&
          worker.teamId === context.team?.id &&
          worker.kind === 'worker',
      );
      if (!worker) add('worker_unavailable', step.key);
      else if (
        !['ready', 'waiting'].includes(worker.state) ||
        context.busyWorkerIds.includes(worker.id)
      )
        add('worker_busy', step.key);
      else if (step.access === 'workspace-write' && !worker.writeCapable)
        add('write_denied', step.key);
      const writes =
        step.access === 'workspace-write' && step.writeClaims.length === 0
          ? context.workspace.roots.map((root) => ({
              rootId: root.rootId,
              path: null,
              semanticKeys: [],
            }))
          : step.writeClaims;
      if (step.access === 'workspace-write' && writes.length === 0)
        add('root_unavailable', step.key);
      for (const claim of writes) {
        const root = resolveRoot(claim.rootId);
        const identity = root ? context.rootIdentities.get(root.rootId) : undefined;
        if (!root || !identity) {
          add('root_unavailable', step.key, claim.rootId, claim.path);
          continue;
        }
        usedRoots.set(root.rootId, { path: root.path, identity });
        try {
          claims.push({
            stepKey: step.key,
            semanticKeys: claim.semanticKeys,
            ...(await bindClaim(root.rootId, root.path, identity, claim.path)),
          });
        } catch (error) {
          add(
            error instanceof PathGuardError && error.code === 'IDENTITY_CHANGED'
              ? 'root_changed'
              : 'path_unavailable',
            step.key,
            root.rootId,
            claim.path,
          );
        }
      }
      for (const resource of step.resourceClaims) {
        if (resource.scope === 'machine') {
          resources.push({
            stepKey: step.key,
            key: resource.key,
            scope: 'machine',
            rootIdentityDigest: null,
          });
          continue;
        }
        const root = resource.rootId === null ? undefined : resolveRoot(resource.rootId);
        const identity = root ? context.rootIdentities.get(root.rootId) : undefined;
        if (!root || !identity) {
          add('root_unavailable', step.key, resource.rootId);
          continue;
        }
        usedRoots.set(root.rootId, { path: root.path, identity });
        try {
          const bound = await bindClaim(root.rootId, root.path, identity, null);
          resourceGuards.push(bound.guard);
          resources.push({
            stepKey: step.key,
            key: resource.key,
            scope: 'workspace',
            rootIdentityDigest: bound.rootIdentityDigest,
          });
        } catch {
          add('root_changed', step.key, resource.rootId);
        }
      }
    }
    for (const source of document.sources) {
      const root = resolveRoot(source.rootId);
      const identity = root ? context.rootIdentities.get(root.rootId) : undefined;
      if (!root || !identity || identity !== source.rootIdentityDigest) {
        add('source_changed', null, source.rootId, source.path);
        continue;
      }
      usedRoots.set(root.rootId, { path: root.path, identity });
      const result = await previewGraphSource(source, root?.path ?? null, context.policyEpoch);
      if (result.status !== 'current') add('source_changed', null, source.rootId, source.path);
    }
    for (const claim of claims) {
      try {
        await revalidatePathGuard(claim.guard);
      } catch {
        add('state_changed', claim.stepKey, claim.rootId);
        break;
      }
    }
    for (const guard of resourceGuards) {
      try {
        await revalidatePathGuard(guard);
      } catch {
        add('state_changed', null, guard.rootId);
        break;
      }
    }
    // Recheck the configured spelling too: a Workspace alias may have been redirected since
    // its guard captured the canonical root, without changing the saved Workspace row.
    for (const [rootId, root] of usedRoots) {
      try {
        if ((await workspaceMutationBinding(root.path)).rootIdentityDigest !== root.identity)
          add('root_changed', null, rootId);
      } catch {
        add('root_unavailable', null, rootId);
      }
    }
  }
  if (graphMissionContextDigest(currentContext(), workerIds) !== initialDigest)
    add('state_changed');
  return {
    summary: {
      ...input,
      matched: issues.length === 0,
      checkedAt: new Date().toISOString(),
      issues,
    },
    claims,
    resources,
    contextDigest: initialDigest,
  };
}

export function graphMissionContextFor(
  persistence: Pick<
    PersistenceClient,
    | 'getTeamByTask'
    | 'getEffectiveWorkspaceSet'
    | 'getEffectiveWorkspaceRootIdentities'
    | 'getPermissionPolicy'
    | 'getTeamSnapshot'
    | 'listTeamExecutions'
  >,
  taskId: string,
): GraphMissionReviewContext {
  const team = persistence.getTeamByTask(taskId);
  return {
    workspace: persistence.getEffectiveWorkspaceSet(taskId),
    rootIdentities: persistence.getEffectiveWorkspaceRootIdentities(taskId),
    policyEpoch: persistence.getPermissionPolicy(taskId).policyEpoch,
    team: team
      ? { id: team.id, taskId: team.taskId, state: team.state, leaderAgentId: team.leaderAgentId }
      : null,
    workers: team
      ? persistence.getTeamSnapshot(team.id).agents.map((worker) => ({
          id: worker.id,
          taskId: worker.taskId,
          teamId: worker.teamId,
          kind: worker.kind,
          state: worker.state,
          writeCapable: worker.writeCapable,
          authorityDigest: createHash('sha256')
            .update(
              canonicalGraphJson({
                model: worker.modelSelection,
                runtime: worker.runtimeKind,
                parent: worker.parentAgentId,
                ceiling: worker.parentCapabilityCeiling,
                inheritance: worker.contextInheritancePolicy,
                teamPolicy: team.policy,
              }),
            )
            .digest('hex'),
        }))
      : [],
    busyWorkerIds: team
      ? persistence
          .listTeamExecutions(team.id)
          .filter((execution) => !['completed', 'failed', 'canceled'].includes(execution.state))
          .map((execution) => execution.assigneeAgentId)
      : [],
  };
}
