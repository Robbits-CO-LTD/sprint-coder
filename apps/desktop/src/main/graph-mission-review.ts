import { dirname, join } from 'node:path';
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
import { directoryCaseSensitive } from './directory-name-rules';
import { secureLogger } from './secure-logger';
import {
  prepareGraphWriteFootprint,
  graphWriteConflictPairs,
  type GraphWriteFootprint,
} from './graph-write-conflicts';
import { graphMissionStoredContextSchema, type GraphMissionRecord } from './graph-mission-record';

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
  relativePath: string | null;
  canonicalPath: string;
  /** Missing suffixes remain explicit: their alias/conflict rules must be resolved at admission. */
  missingSuffix: readonly string[];
  /** Rules of the existing directory containing the first missing entry; null for existing targets. */
  missingNameCaseSensitive: boolean | null;
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

function failureCode(error: unknown): string {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : 'unknown';
}

/** Review folds every preparation failure into one of a few Issue codes, and an Issue is all the
 * renderer may learn — it must never describe the filesystem or the native layer to the user.
 * That leaves nobody able to tell a genuinely unusable path from a native layer that cannot
 * answer directory name rules at all (Issue #465: a native-safe-fs build predating
 * `directoryCaseSensitive` turned every not-yet-created write claim into `path_unavailable`).
 * Keep the failing error's own code in the local diagnostic log, beside the Issue it became. */
function logMissionReviewFailure(
  event: string,
  issue: Issue['code'],
  error: unknown,
  context: Readonly<{
    taskId: string;
    stepKey?: string | null;
    rootId?: string | null;
    path?: string | null;
  }>,
): void {
  secureLogger.warn(
    'Graph Mission review could not prepare a declaration',
    {
      issue,
      stepKey: context.stepKey ?? null,
      rootId: context.rootId ?? null,
      path: context.path ?? null,
      error: {
        name: error instanceof Error ? error.name : typeof error,
        code: failureCode(error),
        message: error instanceof Error ? error.message : String(error),
      },
    },
    { category: 'team', event, taskId: context.taskId },
  );
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
    relativePath: path,
    rootIdentityDigest: guard.rootIdentityDigest,
    canonicalPath: join(guard.resolvedPath, ...missingSuffix),
    missingSuffix,
    guard,
    missingNameCaseSensitive:
      guard.targetIdentity === null
        ? directoryCaseSensitive(dirname(guard.resolvedPath), guard.parentIdentity)
        : null,
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
  writeFootprints: readonly GraphWriteFootprint[] | null;
  writeConflicts: readonly { leftStepKey: string; rightStepKey: string }[] | null;
}> {
  const context = currentContext();
  const workerIds = new Set(document.missionPlan?.steps.map((step) => step.workerId) ?? []);
  const initialDigest = graphMissionContextDigest(context, workerIds);
  const issues: Issue[] = [];
  const claims: GraphMissionClaimBinding[] = [];
  const writeFootprints: GraphWriteFootprint[] = [];
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
          const issue =
            error instanceof PathGuardError && error.code === 'IDENTITY_CHANGED'
              ? 'root_changed'
              : 'path_unavailable';
          logMissionReviewFailure('graph_mission_write_claim_unbound', issue, error, {
            taskId: input.taskId,
            stepKey: step.key,
            rootId: root.rootId,
            path: claim.path,
          });
          add(issue, step.key, root.rootId, claim.path);
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
        } catch (error) {
          logMissionReviewFailure('graph_mission_resource_claim_unbound', 'root_changed', error, {
            taskId: input.taskId,
            stepKey: step.key,
            rootId: resource.rootId,
          });
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
        writeFootprints.push(await prepareGraphWriteFootprint(claim));
      } catch (error) {
        logMissionReviewFailure('graph_mission_write_footprint_failed', 'state_changed', error, {
          taskId: input.taskId,
          stepKey: claim.stepKey,
          rootId: claim.rootId,
          path: claim.relativePath,
        });
        add('state_changed', claim.stepKey, claim.rootId);
        break;
      }
    }
    for (const guard of resourceGuards) {
      try {
        await revalidatePathGuard(guard);
      } catch (error) {
        logMissionReviewFailure('graph_mission_resource_guard_stale', 'state_changed', error, {
          taskId: input.taskId,
          rootId: guard.rootId,
        });
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
      } catch (error) {
        logMissionReviewFailure('graph_mission_root_rebinding_failed', 'root_unavailable', error, {
          taskId: input.taskId,
          rootId,
        });
        add('root_unavailable', null, rootId);
      }
    }
  }
  // A later preparation may race an earlier claim; validate the full set before comparison.
  for (const claim of claims) {
    try {
      await revalidatePathGuard(claim.guard);
    } catch (error) {
      logMissionReviewFailure('graph_mission_claim_guard_stale', 'state_changed', error, {
        taskId: input.taskId,
        stepKey: claim.stepKey,
        rootId: claim.rootId,
        path: claim.relativePath,
      });
      add('state_changed', claim.stepKey, claim.rootId);
      break;
    }
  }
  if (graphMissionContextDigest(currentContext(), workerIds) !== initialDigest)
    add('state_changed');
  return {
    summary: {
      ...input,
      contextDigest: initialDigest,
      matched: issues.length === 0,
      checkedAt: new Date().toISOString(),
      issues,
    },
    claims,
    resources,
    contextDigest: initialDigest,
    writeFootprints: issues.length === 0 ? writeFootprints : null,
    writeConflicts: issues.length === 0 ? graphWriteConflictPairs(writeFootprints) : null,
  };
}

/** Fresh per-step admission. Worker activity is checked by the shared Scheduler; authority and
 * root bindings must still match the agreed plan after filesystem preparation completes. */
export async function prepareGraphStepWriteFootprints(
  graph: GraphMissionRecord,
  stepKey: string,
  currentContext: () => GraphMissionReviewContext,
): Promise<readonly GraphWriteFootprint[]> {
  const step = graph.plan.steps.find((step) => step.key === stepKey);
  if (!step) throw new Error('Graph step not found');
  const agreed = graphMissionStoredContextSchema.parse(JSON.parse(graph.contextJson));
  const validate = () => {
    const context = currentContext();
    const worker = context.workers.find((worker) => worker.id === step.workerId);
    const previous = agreed.workers.find((worker) => worker.id === step.workerId);
    if (
      context.policyEpoch !== graph.policyEpoch ||
      context.workspace.digest !== graph.workspaceDigest ||
      context.team?.id !== agreed.team.id ||
      context.team.state !== 'active' ||
      !worker ||
      !previous ||
      worker.authorityDigest !== previous.authorityDigest ||
      worker.taskId !== graph.taskId ||
      worker.teamId !== agreed.team.id ||
      worker.kind !== 'worker' ||
      (step.access === 'workspace-write' && !worker.writeCapable)
    )
      throw new Error('Graph step authority changed');
    return context;
  };
  const context = validate();
  const rootFor = (id: string) => {
    const root = context.workspace.roots.find(
      (root) => root.rootId === (id === 'legacy-primary' ? context.workspace.primaryRootId : id),
    );
    if (!root || root.status !== 'available') throw new Error('Graph root is unavailable');
    const expected = agreed.roots.find(([key]) => key === root.rootId)?.[1];
    if (!expected || context.rootIdentities.get(root.rootId) !== expected)
      throw new Error('Graph root binding changed');
    return { root, expected };
  };
  const footprints: GraphWriteFootprint[] = [];
  for (const claim of step.writeClaims) {
    const { root, expected } = rootFor(claim.rootId);
    const bound = await bindClaim(root.rootId, root.path, expected, claim.path);
    footprints.push(
      await prepareGraphWriteFootprint({ ...bound, stepKey, semanticKeys: claim.semanticKeys }),
    );
  }
  for (const resource of step.resourceClaims) {
    if (resource.scope !== 'workspace') continue;
    if (resource.rootId === null) throw new Error('Graph resource root is missing');
    const { root, expected } = rootFor(resource.rootId);
    if ((await workspaceMutationBinding(root.path)).rootIdentityDigest !== expected)
      throw new Error('Graph resource root changed');
  }
  validate();
  return footprints;
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
