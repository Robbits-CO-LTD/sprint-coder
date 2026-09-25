import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  linkSync,
  lstatSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphMissionPlan, TeamDetail } from '@sprint-coder/contracts';
import { SqlitePersistenceClient } from './persistence';
import { nextGraphDocument } from './graph-document';
import {
  graphMissionContextFor,
  graphMissionContextDigest,
  reviewGraphMission,
} from './graph-mission-review';
import type { GraphWriteFootprint } from './graph-write-conflicts';
import { electronTestExecutablePath } from './electron-test-runtime';
import { workspaceMutationBinding } from './path-guard';
import { TeamExecutionScheduler } from './team-execution-scheduler';
import { WorkerWorktreeManager } from './worker-worktree';
import {
  TeamCoordinator,
  DeterministicTeamWorkerRuntime,
  WorkerRuntimeExitUnconfirmedError,
  type TeamWorkerRuntime,
} from './team-coordinator';
import { workerManagedCatalogOwner } from './ipc';
import { assertGraphWriteCoverage } from './graph-write-coverage';
import { loadNativeSafeFs, prepareNativeSafeFsLockDirectory } from './native-safe-fs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});
const now = '2026-09-11T00:00:00.000Z';
// mainpc: three real guarded Git/native-image reads take 25.4s; write continuation uses four
// images plus integration. These are fixture I/O allowances, not production lifecycle deadlines.
//
// Only the win32 column was ever measured; the rest were sized against a developer Mac, and that
// is what broke. Measured here on an M-series Mac: the two-root dispatch below waits 101-106 ms,
// the write-branch re-agreement case costs 616 ms and the two-repository integration case 2.21 s.
// The hosted macOS runners of jobs 104616511378 and 104603430488 ran this same child at 94.4 s and
// 106.9 s against 14.6 s locally — 6.5x and 7.3x — and degraded harder than the pure-SQLite bridge
// beside them in those same jobs (4.2x, 5.1x), because real `git` spawns and fsyncs lose the most
// under runner contention. Both CI failures were this margin and nothing else: the 1 s dispatch
// wait expired at line 512 with only `['a']` dispatched, and the 2.21 s case reached the 20 s
// ceiling at ~16 s of projected cost. Every wait here is already state-based (`vi.waitFor`, never a
// fixed sleep), so the allowance is the only lever. Each one now covers its measured local cost
// times that contention factor with room for the tail, and `graphBridgeTimeout` still bounds a
// genuine hang at 180 s — well above the 107 s this suite has actually needed.
const gitCheckpointTimeout = process.platform === 'win32' ? 60_000 : 30_000;
const gitPreflightTimeout = process.platform === 'win32' ? 60_000 : 15_000;
const gitScenarioTimeout = process.platform === 'win32' ? 120_000 : 60_000;
// The bridge child runs this whole suite, real Git worktrees and native image reads included, so
// its budget tracks hosted-runner speed rather than anything the suite itself decides. On an M-
// series Mac the child takes 14.6 s; on the hosted macOS runner of job 104595667383 the comparable
// SQLite bridge child needed 52.6 s for a suite that costs 14.2 s on that same Mac — a 3.7x
// contention factor that leaves a 60 s budget under 10% of headroom, which is why that run was
// killed at 60.1 s after a 38.4 s pass on a faster runner. `persistenceBridgeTimeoutMs` met this
// exact wall first and answered it with 180 s for every platform; a suite of the same measured
// cost gets the same allowance. Windows keeps its own larger measured budget.
const graphBridgeTimeout = process.platform === 'win32' ? 300_000 : 180_000;
function fixture(
  existing?: { persistence: SqlitePersistenceClient; path: string },
  writeCapable = false,
  keys: string[] = ['a', 'b'],
  projectId?: string,
) {
  const root = existing ? null : mkdtempSync(join(tmpdir(), 'sc-graph-mission-db-'));
  if (root) roots.push(root);
  const path = existing?.path ?? join(root!, 'state.sqlite3');
  const persistence = existing?.persistence ?? new SqlitePersistenceClient(path);
  persistence.setRuntime('codex');
  persistence.setModel('gpt-5.6-terra');
  const task = persistence.createTask('Graph Mission', false, projectId);
  const team = persistence.promoteTaskToTeam(task.id);
  persistence.transitionTeamState(team.id, 'forming');
  const workers = keys.map((role) => {
    const worker = persistence.registerTeamWorker({
      teamId: team.id,
      role,
      objective: role,
      contextInheritancePolicy: 'summary',
      parentCapabilityCeiling: { entries: [], maxWorkerDepth: 0, maxConcurrentWorkers: 0 },
      writeCapable,
    });
    persistence.transitionWorkerState(worker.id, 'spawning');
    persistence.transitionWorkerState(worker.id, 'ready');
    return worker;
  });
  persistence.transitionTeamState(team.id, 'active');
  const plan: GraphMissionPlan = {
    mode: 'graph',
    objective: 'Review',
    doneCriteria: ['Both reviewed'],
    steps: workers.map((worker, index) => ({
      key: keys[index]!,
      nodeId: keys[index]!,
      workerId: worker.id,
      objective: worker.role,
      doneCriteria: ['Reviewed'],
      access: 'read-only',
      dependsOn: index === 0 ? [] : ['a'],
      writeClaims: [],
      resourceClaims: [],
    })),
  };
  const diagram = {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: { title: 'Review' },
    lanes: [{ id: 'work', label: 'Work' }],
    nodes: keys.map((id, col) => ({ id, col, lane: 'work', label: id, type: 'backend' })),
    edges: [{ id: 'ab', from: 'a', to: 'b' }],
  };
  const document = nextGraphDocument(task.id, diagram, null, [], [], plan);
  persistence.saveGraphDocument(document, 0);
  const context = graphMissionContextFor(persistence, task.id);
  const input = {
    taskId: task.id,
    graphId: document.id,
    renderRevision: 1,
    semanticRevision: document.semanticRevision,
    semanticDigest: document.semanticDigest,
    workspaceDigest: context.workspace.digest,
    policyEpoch: context.policyEpoch,
    contextDigest: graphMissionContextDigest(context, new Set(workers.map((worker) => worker.id))),
    consentId: randomUUID(),
    now,
  };
  return { persistence, path, task, team, workers, plan, diagram, document, input };
}

function resourceMission(f: ReturnType<typeof fixture>, key = 'shared-db') {
  const plan = structuredClone(f.plan);
  plan.steps[0]!.resourceClaims = [{ scope: 'machine', key, rootId: null }];
  const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
  f.persistence.saveGraphDocument(document, 1);
  return f.persistence.createGraphTeamMission({
    ...f.input,
    renderRevision: document.renderRevision,
    semanticRevision: document.semanticRevision,
    semanticDigest: document.semanticDigest,
  });
}
function reserve(
  f: ReturnType<typeof fixture>,
  missionId: string,
  stepKey = 'a',
  generation = 1,
  writeFootprints?: readonly GraphWriteFootprint[],
) {
  const result = f.persistence.acquireGraphResources({
    missionId,
    stepKey,
    expectedGeneration: generation,
    ...(writeFootprints === undefined ? {} : { writeFootprints }),
    now,
  });
  expect(result.acquired).toBe(true);
  if (!result.acquired) throw new Error('Expected resource acquisition');
  return result.reservation;
}
function begin(
  f: ReturnType<typeof fixture>,
  missionId: string,
  key: string,
  writeFootprints?: readonly GraphWriteFootprint[],
) {
  const reservation = reserve(f, missionId, key, 1, writeFootprints);
  const result = f.persistence.beginGraphAttempt({
    missionId,
    stepKey: key,
    generation: 1,
    reservationId: reservation.id,
    now,
  });
  const dispatch = f.persistence.getTeamExecutionDispatch(result.execution.id);
  f.persistence.transitionTeamAttempt({ attemptId: result.attempt.id, to: 'running', now });
  f.persistence.transitionTeamTask(dispatch.teamTaskId, 'running', now);
  return { ...result, dispatch };
}
/** The flags the plan panel reads to decide which resume — if any — it may offer for a step. */
function stepResumeFlags(
  coordinator: TeamCoordinator,
  taskId: string,
  missionId: string,
  key: string,
) {
  const mission = coordinator.get(taskId)?.missions.find((item) => item.id === missionId);
  const step = mission?.steps.find((item) => item.graph?.key === key);
  if (!step?.graph) throw new Error('Expected a graph step summary');
  return step.graph;
}
function completion(missionId: string, key: string, run: ReturnType<typeof begin>) {
  const doneEvidence = [{ criterion: 'Reviewed', evidence: 'Main fixture verified the result' }];
  return {
    missionId,
    stepKey: key,
    generation: 1,
    reservationId: run.reservation.id,
    attemptId: run.attempt.id,
    agentId: run.execution.assigneeAgentId,
    teamTaskId: run.dispatch.teamTaskId,
    report: {
      status: 'completed',
      summary: key,
      findings: [],
      changedFiles: [],
      artifacts: [],
      verification: [{ name: 'fixture', outcome: 'pass' }],
      risks: [],
      nextActions: [],
      doneEvidence,
    },
    doneEvidence,
    checkpoint: {
      summary: key,
      changedFiles: [],
      gitHead: null,
      workspaceDigest: null,
      recordedAt: now,
    },
    confirmation: { kind: 'attempt-stopped' as const, attemptId: run.attempt.id },
    now,
  };
}

async function writeMission(
  f: ReturnType<typeof fixture>,
  workspace: string,
  paths: (string | null)[] = ['shared.ts'],
  resource?: string,
) {
  mkdirSync(workspace, { recursive: true });
  const binding = await workspaceMutationBinding(workspace);
  f.persistence.setWorkspaceBinding(f.task.id, {
    path: binding.canonicalPath,
    workspaceKey: binding.workspaceKey,
    rootIdentityDigest: binding.rootIdentityDigest,
  });
  const context = graphMissionContextFor(f.persistence, f.task.id);
  const plan = structuredClone(f.plan);
  plan.steps[0]!.access = 'workspace-write';
  plan.steps[0]!.writeClaims = paths.map((path) => ({
    rootId: context.workspace.primaryRootId!,
    path,
    semanticKeys: [],
  }));
  plan.steps[0]!.resourceClaims = resource
    ? [{ scope: 'machine', key: resource, rootId: null }]
    : [];
  const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
  f.persistence.saveGraphDocument(document, 1);
  const review = await reviewGraphMission(
    { taskId: f.task.id, instanceId: randomUUID(), renderRevision: document.renderRevision },
    document,
    () => graphMissionContextFor(f.persistence, f.task.id),
  );
  if (!review.summary.matched || review.writeFootprints === null)
    throw new Error('Expected prepared write Mission');
  const mission = f.persistence.createGraphTeamMission({
    ...f.input,
    renderRevision: document.renderRevision,
    semanticRevision: document.semanticRevision,
    semanticDigest: document.semanticDigest,
    workspaceDigest: context.workspace.digest,
    contextDigest: graphMissionContextDigest(
      context,
      new Set(f.workers.map((worker) => worker.id)),
    ),
  });
  const acquisition = {
    missionId: mission.id,
    stepKey: 'a',
    expectedGeneration: 1,
    writeFootprints: review.writeFootprints,
    now,
  };
  return { mission, acquisition, review, workspace: binding.canonicalPath };
}

async function retainedWriteFixture() {
  const f = fixture(undefined, true);
  const workspace = join(dirname(f.path), 'workspace');
  mkdirSync(workspace);
  expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0);
  writeFileSync(join(workspace, 'shared.ts'), 'base\n');
  expect(spawnSync('git', ['-C', workspace, 'add', 'shared.ts']).status).toBe(0);
  expect(
    spawnSync('git', [
      '-C',
      workspace,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-qm',
      'base',
    ]).status,
  ).toBe(0);
  const a = await writeMission(f, workspace);
  const run = begin(f, a.mission.id, 'a', a.acquisition.writeFootprints);
  const manager = new WorkerWorktreeManager({ worktreesRoot: join(dirname(f.path), 'worktrees') });
  const worker = {
    agentId: run.execution.assigneeAgentId,
    worktreeId: run.execution.id,
    repoPath: a.workspace,
  };
  const worktree = await manager.create(worker);
  f.persistence.recordTeamMissionWorktree({
    ...worktree,
    executionId: run.execution.id,
    agentId: worker.agentId,
    repoPath: a.workspace,
    now,
  });
  f.persistence.updateTeamMissionWorktree({ executionId: run.execution.id, to: 'active', now });
  writeFileSync(join(worktree.path, 'shared.ts'), 'integrated\n');
  return { f, a, run, manager, worker, worktree };
}

async function sealedWriteFixture() {
  const { f, a, run, manager, worker, worktree } = await retainedWriteFixture();
  const sealed = await manager.finalizeChanges({
    ...worker,
    baseHead: worktree.baseHead,
    commitMessage: 'write shared file',
  });
  f.persistence.updateTeamMissionWorktree({
    executionId: run.execution.id,
    to: 'ready',
    workerHead: sealed.workerHead,
    changedFiles: sealed.changedFiles,
    now,
  });
  return { f, a, run, manager, worker, worktree, sealed };
}

async function installNativeGraphObserver(persistence: SqlitePersistenceClient, directory: string) {
  const native = loadNativeSafeFs({
    lockDirectoryPath: await prepareNativeSafeFsLockDirectory(directory),
  });
  persistence.setSealedPostImageObserver((binding) => {
    const identity = lstatSync(binding.workspacePath, { bigint: true });
    const session = native.openReadSession({
      ...binding,
      rootDev: String(identity.dev),
      rootIno: String(identity.ino),
    });
    return {
      rootIdentityDigest: session.rootIdentityDigest,
      observe: (segments) => native.observeSealedPostImage(session, segments),
      close: () => native.closeReadSession(session),
    };
  });
}

if (process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1')
  describe('durable graph Mission definitions', () => {
    it('publishes a queued wait-reason change from dependencies to resources without requiring a UI refresh', async () => {
      const holder = fixture();
      const heldMission = resourceMission(holder, 'display-resource');
      const held = begin(holder, heldMission.id, 'a');
      const f = fixture({ persistence: holder.persistence, path: holder.path }, false, [
        'a',
        'b',
        'c',
      ]);
      const plan = structuredClone(f.plan);
      plan.steps[1]!.dependsOn = [];
      plan.steps[2]!.dependsOn = ['a', 'b'];
      plan.steps[2]!.resourceClaims = [{ scope: 'machine', rootId: null, key: 'display-resource' }];
      const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
      f.persistence.saveGraphDocument(document, 1);
      const runtime = new DeterministicTeamWorkerRuntime();
      const execute = runtime.execute.bind(runtime);
      const releases = new Map<string, () => void>();
      vi.spyOn(runtime, 'execute').mockImplementation(async (input) => {
        if (input.worker.role !== 'c')
          await new Promise<void>((resolve) => releases.set(input.worker.role, resolve));
        return execute(input);
      });
      const published: TeamDetail[] = [];
      const scheduler = new TeamExecutionScheduler(2);
      const coordinator = new TeamCoordinator(
        f.persistence,
        runtime,
        (taskId, detail) => {
          if (taskId === f.task.id) published.push(structuredClone(detail));
        },
        undefined,
        undefined,
        scheduler,
      );
      let missionId: string | undefined;
      const reason = (detail: TeamDetail | null | undefined) =>
        detail?.missions.find((mission) => mission.id === missionId)?.steps[2]?.graph?.waitReason;
      try {
        const mission = await coordinator.startGraphMission(f.task.id, async () => ({
          ...f.input,
          renderRevision: document.renderRevision,
          semanticRevision: document.semanticRevision,
          semanticDigest: document.semanticDigest,
        }));
        missionId = mission.id;
        await vi.waitFor(() => expect(releases.size).toBe(2));
        releases.get('a')!();
        await vi.waitFor(() => expect(reason(coordinator.get(f.task.id))).toBe('dependencies'));
        releases.get('b')!();
        await vi.waitFor(() => expect(reason(coordinator.get(f.task.id))).toBe('resources'));
        expect(reason(published.at(-1))).toBe('resources');
        const count = published.length;
        scheduler.notifyReadinessChanged();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(published).toHaveLength(count);
      } finally {
        for (const release of releases.values()) release();
        holder.persistence.completeGraphStep(completion(heldMission.id, 'a', held));
        scheduler.notifyReadinessChanged();
        if (missionId)
          await vi.waitFor(() =>
            expect(f.persistence.getTeamMission(missionId!).state).toBe('completed'),
          );
        await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
        f.persistence.close();
      }
    });
    it(
      'fails a WRITE step whose worktree did not change, whatever its Worker reported, and integrates nothing',
      async () => {
        const f = fixture(undefined, true);
        const workspace = join(dirname(f.path), 'workspace');
        mkdirSync(workspace);
        writeFileSync(join(workspace, 'a.ts'), 'before\n');
        for (const args of [
          ['init', '-q', workspace],
          ['-C', workspace, 'add', 'a.ts'],
          [
            '-C',
            workspace,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-qm',
            'base',
          ],
        ])
          expect(spawnSync('git', args).status).toBe(0);
        const binding = await workspaceMutationBinding(workspace);
        f.persistence.setWorkspaceBinding(f.task.id, {
          path: binding.canonicalPath,
          workspaceKey: binding.workspaceKey,
          rootIdentityDigest: binding.rootIdentityDigest,
        });
        const context = graphMissionContextFor(f.persistence, f.task.id);
        const plan = structuredClone(f.plan);
        plan.steps[0]!.access = 'workspace-write';
        plan.steps[0]!.writeClaims = [
          { rootId: context.workspace.primaryRootId!, path: 'a.ts', semanticKeys: [] },
        ];
        const initial = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
        f.persistence.saveGraphDocument(initial, 1);
        const runtime = new DeterministicTeamWorkerRuntime();
        const original = runtime.execute.bind(runtime);
        // A Worker that reports every criterion done but writes nothing, and is not the simulation
        // that Main exempts from the check.
        const execute = vi.spyOn(runtime, 'execute').mockImplementation(async (input) => {
          const { simulated: _simulated, ...result } = await original(input);
          return result;
        });
        const scheduler = new TeamExecutionScheduler(1);
        const coordinator = new TeamCoordinator(
          f.persistence,
          runtime,
          undefined,
          undefined,
          undefined,
          scheduler,
          undefined,
          undefined,
          new WorkerWorktreeManager({ worktreesRoot: join(dirname(f.path), 'worktrees') }),
        );
        const mission = await coordinator.startGraphMission(f.task.id, async () => ({
          ...f.input,
          renderRevision: initial.renderRevision,
          semanticRevision: initial.semanticRevision,
          semanticDigest: initial.semanticDigest,
          workspaceDigest: context.workspace.digest,
          policyEpoch: context.policyEpoch,
          contextDigest: graphMissionContextDigest(
            context,
            new Set(f.workers.map((worker) => worker.id)),
          ),
        }));
        const executionId = mission.steps[0]!.executionId;
        await vi.waitFor(
          () =>
            expect(f.persistence.listTeamAttempts(executionId).map(({ state }) => state)).toEqual([
              'failed',
            ]),
          { timeout: gitPreflightTimeout },
        );
        await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));

        expect(execute).toHaveBeenCalledTimes(1);
        const writer = f.persistence
          .getTeamSnapshot(f.persistence.getTeamByTask(f.task.id)!.id)
          .agents.find(({ id }) => id === f.workers[0]!.id);
        expect(writer?.currentActivity).toContain('ファイルが1つも変わらないまま');
        expect(f.persistence.getTeamExecution(executionId).state).not.toBe('completed');
        expect(f.persistence.getTeamMission(mission.id).state).not.toBe('completed');
        expect(readFileSync(join(workspace, 'a.ts'), 'utf8')).toBe('before\n');
        f.persistence.close();
      },
      gitScenarioTimeout,
    );
    it(
      'keeps a running independent WRITE branch on its original owner consent through sealed integration after re-agreement',
      async () => {
        const f = fixture(undefined, true, ['a', 'b', 'c']);
        const workspace = join(dirname(f.path), 'workspace');
        mkdirSync(workspace);
        writeFileSync(join(workspace, 'b.ts'), 'before\n');
        for (const args of [
          ['init', '-q', workspace],
          ['-C', workspace, 'add', 'b.ts'],
          [
            '-C',
            workspace,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-qm',
            'base',
          ],
        ])
          expect(spawnSync('git', args).status).toBe(0);
        const binding = await workspaceMutationBinding(workspace);
        f.persistence.setWorkspaceBinding(f.task.id, {
          path: binding.canonicalPath,
          workspaceKey: binding.workspaceKey,
          rootIdentityDigest: binding.rootIdentityDigest,
        });
        const context = graphMissionContextFor(f.persistence, f.task.id);
        const plan = structuredClone(f.plan);
        plan.steps[1]!.dependsOn = [];
        plan.steps[1]!.access = 'workspace-write';
        plan.steps[1]!.writeClaims = [
          { rootId: context.workspace.primaryRootId!, path: 'b.ts', semanticKeys: [] },
        ];
        plan.steps[2]!.dependsOn = ['a', 'b'];
        const initial = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
        f.persistence.saveGraphDocument(initial, 1);
        const runtime = new DeterministicTeamWorkerRuntime();
        const original = runtime.execute.bind(runtime);
        const starts: string[] = [];
        const releases = new Map<string, () => void>();
        let draining = false;
        const failures: unknown[] = [];
        vi.spyOn(runtime, 'execute').mockImplementation(async (input) => {
          const first = !starts.includes(input.worker.role);
          starts.push(input.worker.role);
          if (input.worker.role === 'b')
            writeFileSync(join(input.workspacePath!, 'b.ts'), 'sealed independent B\n');
          if (first && input.worker.role !== 'c' && !draining)
            await new Promise<void>((resolve) => releases.set(input.worker.role, resolve));
          return original(input);
        });
        const stop = vi
          .spyOn(runtime, 'stop')
          .mockImplementation(async (id) =>
            releases.get(f.workers.find((worker) => worker.id === id)!.role)?.(),
          );
        const scheduler = new TeamExecutionScheduler(2);
        const manager = new WorkerWorktreeManager({
          worktreesRoot: join(dirname(f.path), 'worktrees'),
        });
        const coordinator = new TeamCoordinator(
          f.persistence,
          runtime,
          undefined,
          undefined,
          undefined,
          scheduler,
          undefined,
          undefined,
          manager,
        );
        try {
          const mission = await coordinator.startGraphMission(f.task.id, async () => ({
            ...f.input,
            renderRevision: initial.renderRevision,
            semanticRevision: initial.semanticRevision,
            semanticDigest: initial.semanticDigest,
            workspaceDigest: context.workspace.digest,
            policyEpoch: context.policyEpoch,
            contextDigest: graphMissionContextDigest(
              context,
              new Set(f.workers.map((worker) => worker.id)),
            ),
          }));
          await vi.waitFor(() => expect(starts).toEqual(['a', 'b']), {
            timeout: gitPreflightTimeout,
          });
          const bExecution = mission.steps[1]!.executionId;
          const owner = f.persistence
            .listGraphResourceReservations(mission.id)
            .find((owner) => owner.executionId === bExecution)!;
          const originalConsent = f.persistence.getGraphStepAgreement(
            mission.id,
            'b',
            1,
            owner.id,
          ).consentId;
          const next = structuredClone(plan);
          next.steps[0]!.dependsOn = ['b'];
          const proposed = nextGraphDocument(f.task.id, f.diagram, initial, [], [], next);
          f.persistence.saveGraphDocument(proposed, initial.renderRevision);
          expect(stop).not.toHaveBeenCalled();
          const input = {
            taskId: f.task.id,
            missionId: mission.id,
            instanceId: randomUUID(),
            renderRevision: proposed.renderRevision,
            expectedSemanticRevision: initial.semanticRevision,
          };
          const review = await coordinator.requestGraphConstraintUpdate(
            input,
            randomUUID(),
            () => undefined,
          );
          await coordinator.agreeGraphConstraintUpdate(
            { ...input, requestId: review.requestId, contextDigest: review.contextDigest },
            randomUUID(),
            () => undefined,
          );
          expect(stop).toHaveBeenCalledExactlyOnceWith(f.workers[0]!.id);
          expect(f.persistence.getGraphTeamMission(mission.id)!.consentId).not.toBe(
            originalConsent,
          );
          expect(f.persistence.getGraphStepAgreement(mission.id, 'b', 1, owner.id).consentId).toBe(
            originalConsent,
          );
          expect(
            f.persistence
              .listGraphResourceReservations(mission.id)
              .find((row) => row.id === owner.id)?.state,
          ).toBe('active');
          releases.get('b')!();
          await vi.waitFor(
            () => expect(f.persistence.getTeamMission(mission.id).state).toBe('completed'),
            { timeout: gitCheckpointTimeout },
          );
          expect(readFileSync(join(binding.canonicalPath, 'b.ts'), 'utf8')).toBe(
            'sealed independent B\n',
          );
          expect(f.persistence.getTeamMissionWorktree(bExecution)?.workerHead).not.toBe(
            f.persistence.getTeamMissionWorktree(bExecution)?.baseHead,
          );
          expect(f.persistence.listTeamAttempts(bExecution)).toHaveLength(1);
          expect(
            f.persistence
              .listGraphResourceReservations(mission.id)
              .find((row) => row.id === owner.id),
          ).toMatchObject({ state: 'released', generation: 1 });
          expect(starts).toEqual(['a', 'b', 'a', 'c']);
          expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
        } catch (error) {
          failures.push(error);
        } finally {
          draining = true;
          for (const release of releases.values()) release();
          try {
            await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0), {
              timeout: gitCheckpointTimeout,
            });
          } catch (cleanupError) {
            failures.push(cleanupError);
          } finally {
            f.persistence.close();
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, 'Graph fixture and cleanup both failed', {
            cause: failures[0],
          });
      },
      gitScenarioTimeout,
    );

    it('migrates public v90 owner data to immutable consent bindings without changing its identity', () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const owner = reserve(f, mission.id);
      f.persistence.close();
      const legacy = new Database(f.path);
      legacy.exec(`DROP TRIGGER graph_owner_consent_immutable;
        ALTER TABLE team_graph_resource_reservations DROP COLUMN agreement_consent_id;
        DROP TABLE team_graph_pending_updates; DROP TABLE team_graph_agreement_history;
        DELETE FROM schema_migrations WHERE version=91;`);
      legacy.close();
      const restored = new SqlitePersistenceClient(f.path);
      try {
        expect(restored.listGraphResourceReservations(mission.id)[0]!.id).toBe(owner.id);
        expect(restored.getGraphStepAgreement(mission.id, 'a', 1, owner.id).consentId).toBe(
          f.input.consentId,
        );
        expect(() => restored.getGraphStepAgreement(mission.id, 'b', 1, owner.id)).toThrow(
          'unavailable',
        );
        const database = new Database(f.path);
        try {
          expect(() =>
            database
              .prepare(
                'UPDATE team_graph_resource_reservations SET agreement_consent_id=? WHERE id=?',
              )
              .run(randomUUID(), owner.id),
          ).toThrow('immutable');
        } finally {
          database.close();
        }
      } finally {
        restored.close();
      }
    });
    it('resolves the consent actually captured by an owner acquired after a constraint update', () => {
      const f = fixture();
      try {
        const plan = structuredClone(f.plan);
        plan.steps[1]!.dependsOn = [];
        const initial = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
        f.persistence.saveGraphDocument(initial, 1);
        const mission = f.persistence.createGraphTeamMission({
          ...f.input,
          renderRevision: initial.renderRevision,
          semanticRevision: initial.semanticRevision,
          semanticDigest: initial.semanticDigest,
        });
        const changed = structuredClone(plan);
        changed.steps[0]!.resourceClaims = [
          { scope: 'machine', rootId: null, key: 'new-resource' },
        ];
        const proposed = nextGraphDocument(f.task.id, f.diagram, initial, [], [], changed);
        f.persistence.saveGraphDocument(proposed, initial.renderRevision);
        const pending = f.persistence.stageGraphConstraintUpdate({
          taskId: f.task.id,
          missionId: mission.id,
          expectedSemanticRevision: initial.semanticRevision,
          renderRevision: proposed.renderRevision,
          requestId: randomUUID(),
          now,
        });
        f.persistence.transitionTeamExecution({
          executionId: mission.steps[0]!.executionId,
          to: 'waiting_resume',
          now,
        });
        const consentId = randomUUID();
        f.persistence.commitGraphConstraintUpdate({
          taskId: f.task.id,
          missionId: mission.id,
          requestId: pending.requestId,
          consentId,
          now,
        });
        const owner = reserve(f, mission.id, 'b');
        const agreement = f.persistence.getGraphStepAgreement(mission.id, 'b', 1, owner.id);
        expect(agreement.consentId).toBe(consentId);
      } finally {
        f.persistence.close();
      }
    });
    it.each(['agree', 'cancel', 'policy', 'proposal', 'delayed-stop'] as const)(
      'requests stopping only affected runtime steps before fresh re-agreement: %s',
      async (action) => {
        const f = fixture(undefined, false, ['a', 'b', 'c']);
        const plan = structuredClone(f.plan);
        plan.steps[1]!.dependsOn = [];
        plan.steps[2]!.dependsOn = ['a', 'b'];
        const initial = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
        f.persistence.saveGraphDocument(initial, 1);
        const runtime = new DeterministicTeamWorkerRuntime();
        const original = runtime.execute.bind(runtime);
        const starts: string[] = [];
        const releases = new Map<string, () => void>();
        vi.spyOn(runtime, 'execute').mockImplementation(async (input) => {
          const role = input.worker.role;
          const first = !starts.includes(role);
          starts.push(role);
          if (first && role !== 'c')
            await new Promise<void>((resolve) => releases.set(role, resolve));
          return original(input);
        });
        let acknowledgeStop: (() => void) | undefined;
        const stop = vi.spyOn(runtime, 'stop').mockImplementation(async (id) => {
          if (action === 'delayed-stop')
            await new Promise<void>((resolve) => {
              acknowledgeStop = resolve;
            });
          releases.get(f.workers.find((worker) => worker.id === id)!.role)?.();
        });
        const scheduler = new TeamExecutionScheduler(2);
        const coordinator = new TeamCoordinator(
          f.persistence,
          runtime,
          undefined,
          undefined,
          undefined,
          scheduler,
        );
        try {
          const mission = await coordinator.startGraphMission(f.task.id, async () => ({
            ...f.input,
            renderRevision: initial.renderRevision,
            semanticRevision: initial.semanticRevision,
            semanticDigest: initial.semanticDigest,
          }));
          await vi.waitFor(() => expect(starts).toEqual(['a', 'b']));
          const next = structuredClone(plan);
          next.steps[0]!.dependsOn = ['b'];
          const proposed = nextGraphDocument(f.task.id, f.diagram, initial, [], [], next);
          f.persistence.saveGraphDocument(proposed, initial.renderRevision);
          expect(stop).not.toHaveBeenCalled();
          expect(f.persistence.getTeamExecution(mission.steps[0]!.executionId).state).toBe(
            'running',
          );
          let input = {
            taskId: f.task.id,
            missionId: mission.id,
            instanceId: randomUUID(),
            renderRevision: proposed.renderRevision,
            expectedSemanticRevision: initial.semanticRevision,
          };
          const requested = coordinator.requestGraphConstraintUpdate(
            input,
            randomUUID(),
            () => undefined,
          );
          if (action === 'delayed-stop') {
            await vi.waitFor(() =>
              expect(f.persistence.getGraphPendingUpdate(mission.id)).not.toBeNull(),
            );
            await expect(coordinator.reviewGraphConstraintUpdate(input)).rejects.toThrow(
              'not confirmed stopping',
            );
            acknowledgeStop!();
          }
          let review = await requested;
          expect(review.affectedKeys).toEqual(['a', 'c']);
          expect(stop).toHaveBeenCalledExactlyOnceWith(f.workers[0]!.id);
          expect(f.persistence.getTeamExecution(mission.steps[1]!.executionId).state).toBe(
            'running',
          );
          expect(f.persistence.getGraphTeamMission(mission.id)!.semanticRevision).toBe(
            initial.semanticRevision,
          );
          if (action !== 'agree' && action !== 'delayed-stop') {
            if (action === 'cancel')
              await coordinator.cancelExecution(f.task.id, mission.steps[0]!.executionId);
            if (action === 'policy') f.persistence.setAccessPreset(f.task.id, 'ask');
            if (action === 'proposal') {
              const newer = nextGraphDocument(f.task.id, f.diagram, proposed, [], [], next);
              f.persistence.saveGraphDocument(newer, proposed.renderRevision);
            }
            await expect(
              coordinator.agreeGraphConstraintUpdate(
                { ...input, requestId: review.requestId, contextDigest: review.contextDigest },
                randomUUID(),
                () => undefined,
              ),
            ).rejects.toThrow();
            expect(f.persistence.getGraphTeamMission(mission.id)!.semanticRevision).toBe(
              initial.semanticRevision,
            );
            expect(starts).toEqual(['a', 'b']);
            if (action !== 'proposal') return;
            input = {
              ...input,
              renderRevision: f.persistence.getGraphDocument(f.task.id)!.renderRevision,
            };
            const oldRequest = review.requestId;
            review = await coordinator.requestGraphConstraintUpdate(
              input,
              randomUUID(),
              () => undefined,
            );
            expect(review.requestId).not.toBe(oldRequest);
          }
          await coordinator.agreeGraphConstraintUpdate(
            { ...input, requestId: review.requestId, contextDigest: review.contextDigest },
            randomUUID(),
            () => undefined,
          );
          const bOwner = f.persistence
            .listGraphResourceReservations(mission.id)
            .find((owner) => owner.executionId === mission.steps[1]!.executionId)!;
          expect(f.persistence.getGraphStepAgreement(mission.id, 'b', 1, bOwner.id).consentId).toBe(
            f.input.consentId,
          );
          expect(starts).toEqual(['a', 'b']);
          releases.get('b')!();
          await vi.waitFor(() =>
            expect(f.persistence.getTeamMission(mission.id).state).toBe('completed'),
          );
          expect(starts).toEqual(['a', 'b', 'a', 'c']);
          expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
        } finally {
          acknowledgeStop?.();
          for (const release of releases.values()) release();
          await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
          f.persistence.close();
        }
      },
    );

    it.each(['shrink', 'undeclared'] as const)(
      'holds a constraint update when retained writes violate %s coverage',
      async (mode) => {
        const { f, a, run, manager, worktree } = await retainedWriteFixture();
        const runtime = new DeterministicTeamWorkerRuntime();
        const execute = vi.spyOn(runtime, 'execute');
        const coordinator = new TeamCoordinator(
          f.persistence,
          runtime,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          manager,
        );
        try {
          await installNativeGraphObserver(f.persistence, dirname(f.path));
          f.persistence.interruptGraphStep({
            missionId: a.mission.id,
            stepKey: 'a',
            generation: 1,
            reservationId: run.reservation.id,
            attemptId: run.attempt.id,
            outcome: 'failed',
            reason: 'interrupted',
            confirmation: { kind: 'unconfirmed' },
            now,
          });
          f.persistence.updateTeamMissionWorktree({
            executionId: run.execution.id,
            to: 'quarantined',
            now,
          });
          const current = f.persistence.getGraphDocument(f.task.id)!;
          const plan = structuredClone(current.missionPlan!);
          plan.steps[0]!.writeClaims[0]!.path = mode === 'shrink' ? 'different.ts' : null;
          if (mode === 'undeclared') writeFileSync(join(worktree.path, 'outside.ts'), 'unapproved');
          const proposed = nextGraphDocument(f.task.id, f.diagram, current, [], [], plan);
          f.persistence.saveGraphDocument(proposed, current.renderRevision);
          const input = {
            taskId: f.task.id,
            missionId: a.mission.id,
            instanceId: randomUUID(),
            renderRevision: proposed.renderRevision,
            expectedSemanticRevision: current.semanticRevision,
          };
          await expect(
            coordinator.requestGraphConstraintUpdate(input, randomUUID(), () => undefined),
          ).rejects.toThrow('outside the declared');
          expect(execute).not.toHaveBeenCalled();
          expect(f.persistence.getGraphTeamMission(a.mission.id)!.semanticRevision).toBe(
            current.semanticRevision,
          );
          expect(f.persistence.getGraphPendingUpdate(a.mission.id)).not.toBeNull();
          expect(readFileSync(join(worktree.path, 'shared.ts'), 'utf8')).toBe('integrated\n');
        } finally {
          f.persistence.close();
        }
      },
    );

    // Re-agreement reads the retained workspace once to review it, then commits, then reads it
    // again to decide what to resume. Nothing in that second read re-checks the retained paths
    // against the write scope the owner actually held, so whatever lands in the window between the
    // two reads would be resumed unexamined: an edit nobody reviewed, or a file that only the
    // widened scope covers and the original owner was never allowed to touch.
    it.each(['edited', 'widened'] as const)(
      'refuses to resume a retained workspace %s between the reviewed agreement and its commit',
      async (tamper) => {
        const { f, a, run, manager, worktree } = await retainedWriteFixture();
        const runtime = new DeterministicTeamWorkerRuntime();
        const execute = vi.spyOn(runtime, 'execute');
        const coordinator = new TeamCoordinator(
          f.persistence,
          runtime,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          manager,
        );
        try {
          await installNativeGraphObserver(f.persistence, dirname(f.path));
          f.persistence.interruptGraphStep({
            missionId: a.mission.id,
            stepKey: 'a',
            generation: 1,
            reservationId: run.reservation.id,
            attemptId: run.attempt.id,
            outcome: 'failed',
            reason: 'interrupted',
            confirmation: { kind: 'unconfirmed' },
            now,
          });
          f.persistence.updateTeamMissionWorktree({
            executionId: run.execution.id,
            to: 'quarantined',
            now,
          });
          const current = f.persistence.getGraphDocument(f.task.id)!;
          const plan = structuredClone(current.missionPlan!);
          // A legitimate widening: the retained `shared.ts` stays covered by the scope the owner
          // held and by the proposed one, so the update itself passes every coverage check.
          plan.steps[0]!.writeClaims = [
            ...plan.steps[0]!.writeClaims,
            { ...plan.steps[0]!.writeClaims[0]!, path: 'widened.ts' },
          ];
          const proposed = nextGraphDocument(f.task.id, f.diagram, current, [], [], plan);
          f.persistence.saveGraphDocument(proposed, current.renderRevision);
          const input = {
            taskId: f.task.id,
            missionId: a.mission.id,
            instanceId: randomUUID(),
            renderRevision: proposed.renderRevision,
            expectedSemanticRevision: current.semanticRevision,
          };
          const review = await coordinator.requestGraphConstraintUpdate(
            input,
            randomUUID(),
            () => undefined,
          );
          expect(review.affectedKeys).toContain('a');
          // `agreeGraphConstraintUpdate` re-validates once the review is in hand and before it
          // commits, which is precisely the window an external editor would write into.
          let checks = 0;
          const editDuringCommit = () => {
            if (++checks !== 2) return;
            if (tamper === 'edited') writeFileSync(join(worktree.path, 'shared.ts'), 'tampered\n');
            else writeFileSync(join(worktree.path, 'widened.ts'), 'never reviewed\n');
          };
          await expect(
            coordinator.agreeGraphConstraintUpdate(
              { ...input, requestId: review.requestId, contextDigest: review.contextDigest },
              randomUUID(),
              editDuringCommit,
            ),
          ).rejects.toThrow('could not resume after the update: a');
          expect(checks).toBe(2);
          // Reaching the aggregated refusal at all proves the loop kept going after the step that
          // failed instead of abandoning the rest of the affected closure mid-way.
          expect(execute).not.toHaveBeenCalled();
          expect(f.persistence.getTeamExecution(run.execution.id).state).toBe('waiting_resume');
          expect(
            f.persistence
              .getTeamSnapshot(a.mission.teamId)
              .agents.find((agent) => agent.id === run.execution.assigneeAgentId)?.currentActivity,
          ).toContain('changed during re-agreement');
        } finally {
          f.persistence.close();
        }
      },
    );

    it.each([false, true])(
      'fences only a requested update and preserves independent completion (complete before commit: %s)',
      (completeBeforeCommit) => {
        const f = fixture(undefined, false, ['a', 'b', 'c']);
        try {
          const plan = structuredClone(f.plan);
          plan.steps[1]!.dependsOn = [];
          plan.steps[2]!.dependsOn = ['a', 'b'];
          const initial = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
          f.persistence.saveGraphDocument(initial, 1);
          const mission = f.persistence.createGraphTeamMission({
            ...f.input,
            renderRevision: initial.renderRevision,
            semanticRevision: initial.semanticRevision,
            semanticDigest: initial.semanticDigest,
          });
          const a = begin(f, mission.id, 'a');
          const b = begin(f, mission.id, 'b');
          const changed = structuredClone(plan);
          changed.steps[0]!.dependsOn = ['b'];
          const proposed = nextGraphDocument(f.task.id, f.diagram, initial, [], [], changed);
          f.persistence.saveGraphDocument(proposed, initial.renderRevision);
          expect(f.persistence.getGraphPendingUpdate(mission.id)).toBeNull();
          expect(f.persistence.getTeamExecution(a.execution.id).state).toBe('running');
          const request = f.persistence.stageGraphConstraintUpdate({
            taskId: f.task.id,
            missionId: mission.id,
            expectedSemanticRevision: initial.semanticRevision,
            renderRevision: proposed.renderRevision,
            requestId: randomUUID(),
            now,
          });
          expect(request.affectedKeys).toEqual(['a', 'c']);
          expect(() =>
            f.persistence.inspectGraphResources({
              missionId: mission.id,
              stepKey: 'c',
              expectedGeneration: 1,
            }),
          ).toThrow('awaiting');
          expect(() => f.persistence.completeGraphStep(completion(mission.id, 'a', a))).toThrow(
            'awaiting',
          );
          const commit = {
            taskId: f.task.id,
            missionId: mission.id,
            requestId: request.requestId,
            consentId: randomUUID(),
            now,
          };
          expect(() => f.persistence.commitGraphConstraintUpdate(commit)).toThrow('stop');
          f.persistence.interruptGraphStep({
            missionId: mission.id,
            stepKey: 'a',
            generation: 1,
            reservationId: a.reservation.id,
            attemptId: a.attempt.id,
            outcome: 'canceled',
            reason: 'requested update',
            confirmation: { kind: 'attempt-stopped', attemptId: a.attempt.id },
            now,
          });
          f.persistence.transitionTeamExecution({
            executionId: mission.steps[2]!.executionId,
            to: 'waiting_resume',
            now,
          });
          if (completeBeforeCommit) f.persistence.completeGraphStep(completion(mission.id, 'b', b));
          const checkpoint = f.persistence.getTeamMission(mission.id).steps[1]!.checkpoint;
          expect(() =>
            f.persistence.commitGraphConstraintUpdate({ ...commit, consentId: f.input.consentId }),
          ).toThrow();
          expect(f.persistence.getGraphTeamMission(mission.id)!.semanticRevision).toBe(
            initial.semanticRevision,
          );
          expect(f.persistence.getGraphPendingUpdate(mission.id)).not.toBeNull();
          const updated = f.persistence.commitGraphConstraintUpdate(commit);
          expect(updated.steps.map((step) => step.generation)).toEqual([2, 1, 2]);
          expect(
            f.persistence.getGraphStepAgreement(mission.id, 'b', 1, b.reservation.id).consentId,
          ).toBe(f.input.consentId);
          expect(() =>
            f.persistence.getGraphStepAgreement(mission.id, 'a', 1, a.reservation.id),
          ).toThrow('generation');
          expect(f.persistence.getTeamMission(mission.id).steps[1]!.checkpoint).toEqual(checkpoint);
          if (!completeBeforeCommit) {
            f.persistence.completeGraphStep(completion(mission.id, 'b', b));
            expect(f.persistence.getTeamExecution(b.execution.id).state).toBe('completed');
            expect(f.persistence.listTeamAttempts(b.execution.id)).toHaveLength(1);
          }
          expect(() => f.persistence.completeGraphStep(completion(mission.id, 'b', b))).toThrow(
            'owner mismatch',
          );
          expect(f.persistence.getGraphPendingUpdate(mission.id)).toBeNull();
          expect(() => f.persistence.commitGraphConstraintUpdate(commit)).toThrow('changed');
          expect(() => f.persistence.completeGraphStep(completion(mission.id, 'a', a))).toThrow(
            'generation',
          );
          expect(() =>
            f.persistence.releaseGraphResources({
              reservationId: a.reservation.id,
              executionId: a.execution.id,
              generation: 2,
              confirmation: { kind: 'attempt-stopped', attemptId: a.attempt.id },
              now,
            }),
          ).toThrow();
          expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
        } finally {
          f.persistence.close();
        }
      },
    );

    it('restores pending updates without treating a proposal or restart as re-agreement', () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const plan = structuredClone(f.plan);
      plan.steps[1]!.dependsOn = [];
      const proposed = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
      f.persistence.saveGraphDocument(proposed, 1);
      const pending = f.persistence.stageGraphConstraintUpdate({
        taskId: f.task.id,
        missionId: mission.id,
        expectedSemanticRevision: 1,
        renderRevision: proposed.renderRevision,
        requestId: randomUUID(),
        now,
      });
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      try {
        restored.recoverInterruptedTeamExecutions(now);
        expect(restored.getGraphPendingUpdate(mission.id)).toEqual(pending);
        expect(restored.getGraphTeamMission(mission.id)!.semanticRevision).toBe(1);
        expect(() =>
          restored.acquireGraphResources({
            missionId: mission.id,
            stepKey: 'b',
            expectedGeneration: 1,
            now,
          }),
        ).toThrow('awaiting');
        expect(
          restored.inspectGraphResources({
            missionId: mission.id,
            stepKey: 'a',
            expectedGeneration: 1,
          }).available,
        ).toBe(true);
      } finally {
        restored.close();
      }
    });
    it.each(['continue', 'changed', 'unconfirmed'] as const)(
      'reviews a retained write workspace before resume: %s',
      async (scenario) => {
        const { f, a, run, manager, worktree } = await retainedWriteFixture();
        f.persistence.interruptGraphStep({
          missionId: a.mission.id,
          stepKey: 'a',
          generation: 1,
          reservationId: run.reservation.id,
          attemptId: run.attempt.id,
          outcome: 'failed',
          reason: 'interrupted fixture',
          confirmation: { kind: 'unconfirmed' },
          now,
        });
        f.persistence.updateTeamMissionWorktree({
          executionId: run.execution.id,
          to: 'quarantined',
          now,
        });
        const native = loadNativeSafeFs({
          lockDirectoryPath: await prepareNativeSafeFsLockDirectory(dirname(f.path)),
        });
        f.persistence.setSealedPostImageObserver((binding) => {
          const identity = lstatSync(binding.workspacePath, { bigint: true });
          const session = native.openReadSession({
            ...binding,
            rootDev: String(identity.dev),
            rootIno: String(identity.ino),
          });
          return {
            rootIdentityDigest: session.rootIdentityDigest,
            observe: (segments) => native.observeSealedPostImage(session, segments),
            close: () => native.closeReadSession(session),
          };
        });
        const runtime = new DeterministicTeamWorkerRuntime();
        const execute = vi.spyOn(runtime, 'execute');
        const stop = vi.spyOn(runtime, 'stop');
        const scheduler = new TeamExecutionScheduler(2);
        const coordinator = new TeamCoordinator(
          f.persistence,
          runtime,
          undefined,
          undefined,
          undefined,
          scheduler,
          undefined,
          undefined,
          manager,
        );
        try {
          const review = await coordinator.reviewGraphPreservedWorkspace(
            f.task.id,
            a.mission.id,
            'a',
          );
          expect(review.files).toEqual([{ repository: 1, path: 'shared.ts' }]);
          expect(execute).not.toHaveBeenCalled();
          await expect(coordinator.resumeGraphStep(f.task.id, a.mission.id, 'a')).rejects.toThrow(
            'requires review',
          );
          if (scenario === 'changed')
            writeFileSync(join(worktree.path, 'shared.ts'), 'changed after review');
          if (scenario === 'unconfirmed') stop.mockRejectedValue(new Error('stop unconfirmed'));
          if (scenario !== 'continue') {
            await expect(
              coordinator.resumeGraphStep(f.task.id, a.mission.id, 'a', review.digest),
            ).rejects.toThrow(scenario === 'changed' ? 'workspace changed' : 'stop unconfirmed');
            expect(execute).not.toHaveBeenCalled();
            expect(f.persistence.listGraphResourceReservations(a.mission.id)[0]?.state).toBe(
              'quarantined',
            );
            expect(existsSync(worktree.path)).toBe(true);
            return;
          }
          await coordinator.resumeGraphStep(f.task.id, a.mission.id, 'a', review.digest);
          await expect(
            coordinator.resumeGraphStep(f.task.id, a.mission.id, 'a', review.digest),
          ).rejects.toThrow('not waiting');
          await vi.waitFor(
            () => expect(f.persistence.getTeamExecution(run.execution.id).state).toBe('completed'),
            { timeout: gitCheckpointTimeout },
          );
          expect(execute).toHaveBeenCalledTimes(1);
          expect(execute.mock.calls[0]?.[0].workspacePath).toBe(worktree.path);
          expect(stop).toHaveBeenCalledWith(run.execution.assigneeAgentId);
          expect(readFileSync(join(a.workspace, 'shared.ts'), 'utf8')).toBe('integrated\n');
          expect(f.persistence.listTeamAttempts(run.execution.id)).toHaveLength(2);
        } finally {
          await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0), {
            timeout: gitPreflightTimeout,
          });
          f.persistence.close();
        }
      },
      gitScenarioTimeout,
    );
    it.each([false, true])(
      'dispatches independent graph steps without serializing siblings (cancel first: %s)',
      async (cancelFirst) => {
        const f = fixture(undefined, false, ['a', 'b', 'c']);
        const plan = structuredClone(f.plan);
        plan.steps[1]!.dependsOn = [];
        plan.steps[2]!.dependsOn = ['a', 'b'];
        const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
        f.persistence.saveGraphDocument(document, 1);
        const scheduler = new TeamExecutionScheduler(2);
        const runtime = new DeterministicTeamWorkerRuntime();
        const execute = runtime.execute.bind(runtime);
        const started: string[] = [];
        const releases = new Map<string, () => void>();
        vi.spyOn(runtime, 'execute').mockImplementation(async (input) => {
          started.push(input.worker.role);
          await new Promise<void>((resolve) => releases.set(input.worker.role, resolve));
          return execute(input);
        });
        vi.spyOn(runtime, 'stop').mockImplementation(async (workerId) => {
          const worker = f.workers.find(({ id }) => id === workerId);
          if (worker) releases.get(worker.role)?.();
        });
        const coordinator = new TeamCoordinator(
          f.persistence,
          runtime,
          undefined,
          undefined,
          undefined,
          scheduler,
        );
        try {
          const mission = await coordinator.startGraphMission(f.task.id, async () => ({
            ...f.input,
            renderRevision: document.renderRevision,
            semanticRevision: document.semanticRevision,
            semanticDigest: document.semanticDigest,
          }));
          await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
          await expect(
            coordinator.steerExecution(f.task.id, mission.steps[0]!.executionId, 'different'),
          ).rejects.toThrow('require agreement');
          expect(runtime.stop).not.toHaveBeenCalled();
          if (cancelFirst) {
            await expect(
              coordinator.cancelExecution(f.task.id, mission.steps[0]!.executionId),
            ).resolves.toMatchObject({ state: 'canceled' });
          } else releases.get('a')!();
          await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(1));
          expect(started).toEqual(['a', 'b']);
          releases.get('b')!();
          if (cancelFirst) {
            await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
            expect(started).toEqual(['a', 'b']);
            expect(f.persistence.getTeamExecution(mission.steps[1]!.executionId).state).toBe(
              'completed',
            );
            await coordinator.cancelExecution(f.task.id, mission.steps[2]!.executionId);
            return;
          }
          await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
          releases.get('c')!();
          await vi.waitFor(() =>
            expect(f.persistence.getTeamMission(mission.id).state).toBe('completed'),
          );
          expect(
            f.persistence
              .listGraphResourceReservations(mission.id)
              .every(({ state }) => state === 'released'),
          ).toBe(true);
          expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
        } finally {
          for (const release of releases.values()) release();
          await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
          f.persistence.close();
        }
      },
    );

    it('runs every graph step through the real Worker catalog preflight without a chat Turn', async () => {
      const f = fixture(undefined, false, ['a', 'b', 'c']);
      const scheduler = new TeamExecutionScheduler(2);
      const runtime = new DeterministicTeamWorkerRuntime();
      const execute = runtime.execute.bind(runtime);
      const owners: string[] = [];
      // `RuntimeHostTeamWorkerRuntime` awaits `deps.catalogFor` before it spawns the CLI, and that
      // preflight is where a Graph Mission used to die: it demanded an active chat Turn that a
      // Mission started from a trusted control never has. Run the same resolution here so a
      // regression fails as a stalled Mission rather than only in a billed real-AI E2E.
      vi.spyOn(runtime, 'execute').mockImplementation(async (input) => {
        owners.push(
          workerManagedCatalogOwner(
            f.persistence,
            (taskId) => graphMissionContextFor(f.persistence, taskId),
            f.task.id,
            input.executionId,
          ).parentTurnId,
        );
        return execute(input);
      });
      const coordinator = new TeamCoordinator(
        f.persistence,
        runtime,
        undefined,
        undefined,
        undefined,
        scheduler,
      );
      try {
        expect(f.persistence.getActiveTurnId(f.task.id)).toBeNull();
        const mission = await coordinator.startGraphMission(f.task.id, async () => f.input);
        await vi.waitFor(() =>
          expect(f.persistence.getTeamMission(mission.id).state).toBe('completed'),
        );
        expect(owners).toEqual([
          `graph-mission:${mission.id}`,
          `graph-mission:${mission.id}`,
          `graph-mission:${mission.id}`,
        ]);
        // The Mission session Turn is durable but terminal, so it never becomes the Task's active
        // Turn and never blocks the composer.
        expect(f.persistence.getActiveTurnId(f.task.id)).toBeNull();
        expect(
          f.persistence.getTeamMission(mission.id).steps.map(({ executionId }) => executionId),
        ).toHaveLength(3);
        expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      } finally {
        await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
        f.persistence.close();
      }
    });

    it('refuses a sequential Mission Worker catalog while no chat Turn is active', async () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      try {
        expect(f.persistence.getTeamMissionForExecution('missing-execution')).toBeNull();
        expect(() =>
          workerManagedCatalogOwner(
            f.persistence,
            (taskId) => graphMissionContextFor(f.persistence, taskId),
            f.task.id,
            undefined,
          ),
        ).toThrow('no active parent Turn');
        expect(
          workerManagedCatalogOwner(
            f.persistence,
            (taskId) => graphMissionContextFor(f.persistence, taskId),
            f.task.id,
            f.persistence.getTeamMission(mission.id).steps[0]!.executionId,
          ).parentTurnId,
        ).toBe(`graph-mission:${mission.id}`);
      } finally {
        f.persistence.close();
      }
    });

    it('never mints an acceptance contract for the Mission session Turn on startup', () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const sessionTurnId = f.persistence.ensureGraphMissionSessionTurn(f.task.id, mission.id);
      const contractsFor = (turnId: string) => {
        const database = new Database(f.path, { readonly: true });
        const rows = database
          .prepare('SELECT 1 FROM acceptance_contracts WHERE turn_id = ?')
          .all(turnId);
        database.close();
        return rows.length;
      };
      try {
        f.persistence.close();
        // The session Turn is anchored to a `system` notice, not a user objective. Backfilling it
        // would append a fresh, meaningless contract revision on every single app start.
        for (let start = 0; start < 2; start += 1) new SqlitePersistenceClient(f.path).close();
        expect(contractsFor(sessionTurnId)).toBe(0);
      } finally {
        const reopened = new SqlitePersistenceClient(f.path);
        expect(reopened.getTeamMission(mission.id).mode).toBe('graph');
        reopened.close();
      }
    });

    it('restores interrupted graph steps without dispatch and resumes only the requested step', async () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const run = begin(f, mission.id, 'a');
      f.persistence.transitionTeamAttempt({ attemptId: run.attempt.id, to: 'running', now });
      f.persistence.interruptGraphStep({
        missionId: mission.id,
        stepKey: 'a',
        generation: 1,
        reservationId: run.reservation.id,
        attemptId: run.attempt.id,
        outcome: 'failed',
        reason: 'fixture interruption',
        confirmation: { kind: 'unconfirmed' },
        now,
      });
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      restored.recoverInterruptedTeamExecutions(now);
      const runtime = new DeterministicTeamWorkerRuntime();
      const execute = vi.spyOn(runtime, 'execute');
      const stop = vi.spyOn(runtime, 'stop');
      const scheduler = new TeamExecutionScheduler(2);
      const coordinator = new TeamCoordinator(
        restored,
        runtime,
        undefined,
        undefined,
        undefined,
        scheduler,
      );
      try {
        coordinator.recoverOnStartup();
        expect(execute).not.toHaveBeenCalled();
        // The Mission is parked next to its steps, and the UI offers the step resume — not the
        // integration one, because this Worker never sealed a result.
        expect(restored.getTeamMission(mission.id).state).toBe('waiting_resume');
        expect(stepResumeFlags(coordinator, f.task.id, mission.id, 'a')).toMatchObject({
          stepResumeAvailable: true,
          stepResumePending: false,
          integrationResumeAvailable: false,
        });
        await coordinator.resumeGraphStep(f.task.id, mission.id, 'a');
        await vi.waitFor(() =>
          expect(restored.getTeamExecution(run.execution.id).state).toBe('completed'),
        );
        expect(stop).toHaveBeenCalledWith(run.execution.assigneeAgentId);
        expect(execute).toHaveBeenCalledTimes(1);
        const second = restored.getTeamMission(mission.id).steps[1]!;
        expect(restored.getTeamExecution(second.executionId).state).toBe('waiting_resume');
        await coordinator.resumeGraphStep(f.task.id, mission.id, 'b');
        await vi.waitFor(() => expect(restored.getTeamMission(mission.id).state).toBe('completed'));
        expect(execute).toHaveBeenCalledTimes(2);
        expect(restored.listTeamAttempts(run.execution.id)).toHaveLength(2);
        expect(restored.checkTeamIntegrity().inconsistencies).toEqual([]);
      } finally {
        await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
        restored.close();
      }
    });

    it('keeps a manually resumed step waiting until its dependency completes', async () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const [first, second] = f.persistence.getTeamMission(mission.id).steps;
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      restored.recoverInterruptedTeamExecutions(now);
      const runtime = new DeterministicTeamWorkerRuntime();
      const execute = vi.spyOn(runtime, 'execute');
      const scheduler = new TeamExecutionScheduler(2);
      const coordinator = new TeamCoordinator(
        restored,
        runtime,
        undefined,
        undefined,
        undefined,
        scheduler,
      );
      try {
        coordinator.recoverOnStartup();
        // An agreement that never reached dispatch is parked too, so nothing restarts by itself.
        expect(restored.getTeamExecution(first!.executionId).state).toBe('waiting_resume');
        expect(restored.getTeamExecution(second!.executionId).state).toBe('waiting_resume');
        // A Mission that never admitted a step stays `queued`: `queued -> waiting_resume` is not a
        // legal Mission transition, and the steps already hold the restart on their own gate.
        expect(restored.getTeamMission(mission.id).state).toBe('queued');
        await coordinator.resumeGraphStep(f.task.id, mission.id, 'b');
        await expect(coordinator.resumeGraphStep(f.task.id, mission.id, 'b')).rejects.toThrow(
          'not waiting for manual resume',
        );
        expect(execute).not.toHaveBeenCalled();
        expect(restored.getTeamExecution(second!.executionId).state).toBe('waiting_resume');
        // Resumed but still behind its dependency: the UI says so instead of offering the button.
        await vi.waitFor(() =>
          expect(stepResumeFlags(coordinator, f.task.id, mission.id, 'b')).toMatchObject({
            stepResumePending: true,
            stepResumeAvailable: false,
            waitReason: 'dependencies',
          }),
        );
        await coordinator.resumeGraphStep(f.task.id, mission.id, 'a');
        await vi.waitFor(() => expect(restored.getTeamMission(mission.id).state).toBe('completed'));
        expect(execute).toHaveBeenCalledTimes(2);
        expect(restored.checkTeamIntegrity().inconsistencies).toEqual([]);
      } finally {
        await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
        restored.close();
      }
    });

    it('refuses to re-run a graph step whose sealed result is waiting on integration', async () => {
      const { f, a, run } = await sealedWriteFixture();
      const hold = f.persistence.holdGraphIntegration({
        ...completion(a.mission.id, 'a', run),
        reason: 'Integration requires retry',
      });
      const runtime = new DeterministicTeamWorkerRuntime();
      const execute = vi.spyOn(runtime, 'execute');
      const stop = vi.spyOn(runtime, 'stop');
      const coordinator = new TeamCoordinator(
        f.persistence,
        runtime,
        undefined,
        undefined,
        undefined,
        new TeamExecutionScheduler(2),
      );
      try {
        expect(f.persistence.getTeamExecution(run.execution.id).state).toBe('waiting_resume');
        // The UI offers only the integration resume, matching what the call below enforces.
        expect(stepResumeFlags(coordinator, f.task.id, a.mission.id, 'a')).toMatchObject({
          stepResumeAvailable: false,
          stepResumePending: false,
          integrationResumeAvailable: true,
        });
        await expect(coordinator.resumeGraphStep(f.task.id, a.mission.id, 'a')).rejects.toThrow(
          'Completed graph work must resume integration',
        );
        expect(execute).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(f.persistence.getTeamExecution(run.execution.id).state).toBe('waiting_resume');
        expect(f.persistence.getGraphIntegrationHold(hold.reservationId)).toMatchObject({
          integrationActive: false,
        });
      } finally {
        f.persistence.close();
      }
    });

    it('parks a graph step that was queued before any Attempt and resumes it by hand', async () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const [first, second] = f.persistence.getTeamMission(mission.id).steps;
      // `queueGraphStep` queues the step on its own; the crash lands before `beginGraphAttempt`
      // mints the Attempt, so no Attempt row exists for the recovery sweep to find.
      const queued = f.persistence.queueGraphStep(mission.id, 'a', 1, now);
      expect(queued.state).toBe('queued');
      expect(f.persistence.listTeamAttempts(first!.executionId)).toEqual([]);
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      expect(restored.recoverInterruptedTeamExecutions(now)).toBe(2);
      const runtime = new DeterministicTeamWorkerRuntime();
      const execute = vi.spyOn(runtime, 'execute');
      const stop = vi.spyOn(runtime, 'stop');
      const scheduler = new TeamExecutionScheduler(2);
      const coordinator = new TeamCoordinator(
        restored,
        runtime,
        undefined,
        undefined,
        undefined,
        scheduler,
      );
      try {
        coordinator.recoverOnStartup();
        expect(restored.getTeamExecution(first!.executionId).state).toBe('waiting_resume');
        expect(execute).not.toHaveBeenCalled();
        expect(stepResumeFlags(coordinator, f.task.id, mission.id, 'a')).toMatchObject({
          stepResumeAvailable: true,
          integrationResumeAvailable: false,
        });
        await coordinator.resumeGraphStep(f.task.id, mission.id, 'a');
        await vi.waitFor(() =>
          expect(restored.getTeamExecution(first!.executionId).state).toBe('completed'),
        );
        // Nothing was dispatched before the restart, so Main has no runner to stop.
        expect(stop).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledTimes(1);
        // The sibling stays parked: finishing a step never restarts the rest of the graph.
        expect(restored.getTeamExecution(second!.executionId).state).toBe('waiting_resume');
        expect(restored.checkTeamIntegrity().inconsistencies).toEqual([]);
      } finally {
        await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
        restored.close();
      }
    });

    it('refuses a step resume once its Mission is no longer resumable', async () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const [first] = f.persistence.getTeamMission(mission.id).steps;
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      restored.recoverInterruptedTeamExecutions(now);
      const runtime = new DeterministicTeamWorkerRuntime();
      const execute = vi.spyOn(runtime, 'execute');
      const scheduler = new TeamExecutionScheduler(2);
      const coordinator = new TeamCoordinator(
        restored,
        runtime,
        undefined,
        undefined,
        undefined,
        scheduler,
      );
      try {
        coordinator.recoverOnStartup();
        restored.transitionTeamMission(mission.id, 'canceled', now);
        await expect(coordinator.resumeGraphStep(f.task.id, mission.id, 'a')).rejects.toThrow(
          'Graph Mission is not resumable',
        );
        expect(execute).not.toHaveBeenCalled();
        expect(restored.getTeamExecution(first!.executionId).state).toBe('waiting_resume');
        expect(restored.listTeamAttempts(first!.executionId)).toEqual([]);
      } finally {
        await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
        restored.close();
      }
    });

    it('resumes a sealed graph integration without starting another Worker attempt', async () => {
      const { f, a, run, manager } = await sealedWriteFixture();
      const input = { ...completion(a.mission.id, 'a', run), reason: 'Integration requires retry' };
      const hold = f.persistence.holdGraphIntegration(input);
      expect(hold).toMatchObject({ integrationActive: false, resumeOrdinal: 0 });
      expect(f.persistence.getTeamAttempt(run.attempt.id).state).toBe('completed');
      expect(f.persistence.getTeamExecution(run.execution.id).state).toBe('waiting_resume');
      expect(() =>
        f.persistence.holdGraphIntegration({
          ...input,
          report: { ...input.report, summary: 'different result' },
        }),
      ).toThrow('immutable');
      const prepared = f.persistence.prepareGraphIntegrationResume(hold.reservationId, now);
      expect(prepared.resumeOrdinal).toBe(1);
      expect(() => f.persistence.prepareGraphIntegrationResume(hold.reservationId, now)).toThrow(
        'unconfirmed',
      );
      f.persistence.pauseGraphIntegrationResume(
        hold.reservationId,
        1,
        'Runner settled with a conflict',
        now,
      );
      const runtime = new DeterministicTeamWorkerRuntime();
      const execute = vi.spyOn(runtime, 'execute');
      const coordinator = new TeamCoordinator(
        f.persistence,
        runtime,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        manager,
      );
      vi.spyOn(manager, 'integrate').mockRejectedValueOnce(new Error('Integration conflict'));
      await expect(
        coordinator.resumeGraphIntegration(f.task.id, a.mission.id, 'a'),
      ).rejects.toThrow('Integration conflict');
      expect(f.persistence.getGraphIntegrationHold(hold.reservationId)).toMatchObject({
        integrationActive: false,
        resumeOrdinal: 2,
      });
      expect(f.persistence.getTeamExecution(run.execution.id).state).toBe('waiting_resume');
      expect(readFileSync(join(a.workspace, 'shared.ts'), 'utf8')).toBe('base\n');
      await coordinator.resumeGraphIntegration(f.task.id, a.mission.id, 'a');
      expect(execute).not.toHaveBeenCalled();
      expect(f.persistence.listTeamAttempts(run.execution.id)).toHaveLength(1);
      expect(f.persistence.getTeamExecution(run.execution.id).state).toBe('completed');
      expect(f.persistence.getGraphIntegrationHold(hold.reservationId)).toBeNull();
      expect(f.persistence.listGraphResourceReservations(a.mission.id)[0]?.state).toBe('released');
      expect(readFileSync(join(a.workspace, 'shared.ts'), 'utf8')).toBe('integrated\n');
      await coordinator.resumeGraphIntegration(f.task.id, a.mission.id, 'a');
      expect(execute).not.toHaveBeenCalled();
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      f.persistence.close();
    });

    it('does not treat restart as proof that an interrupted integration runner stopped', async () => {
      const { f, a, run } = await sealedWriteFixture();
      const hold = f.persistence.holdGraphIntegration({
        ...completion(a.mission.id, 'a', run),
        reason: 'Waiting integration',
      });
      f.persistence.prepareGraphIntegrationResume(hold.reservationId, now);
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      restored.recoverInterruptedTeamExecutions('2026-09-11T00:01:00.000Z');
      expect(restored.getGraphIntegrationHold(hold.reservationId)).toMatchObject({
        integrationActive: true,
        resumeOrdinal: 1,
      });
      expect(restored.getTeamExecution(run.execution.id).state).toBe('waiting_resume');
      expect(() => restored.prepareGraphIntegrationResume(hold.reservationId, now)).toThrow(
        'unconfirmed',
      );
      expect(() =>
        restored.pauseGraphIntegrationResume(hold.reservationId, 0, 'stale stop', now),
      ).toThrow('mismatch');
      restored.pauseGraphIntegrationResume(
        hold.reservationId,
        1,
        'Main observed the runner stopped',
        now,
      );
      expect(restored.prepareGraphIntegrationResume(hold.reservationId, now).resumeOrdinal).toBe(2);
      restored.close();
    });

    it('retains ownership when an active integration execution is marked canceled', async () => {
      const { f, a, run } = await sealedWriteFixture();
      const hold = f.persistence.holdGraphIntegration({
        ...completion(a.mission.id, 'a', run),
        reason: 'Waiting integration',
      });
      f.persistence.prepareGraphIntegrationResume(hold.reservationId, now);
      f.persistence.transitionTeamExecution({ executionId: run.execution.id, to: 'canceled', now });
      expect(() =>
        f.persistence.releaseGraphResources({
          reservationId: hold.reservationId,
          executionId: run.execution.id,
          generation: 1,
          confirmation: { kind: 'attempt-stopped', attemptId: run.attempt.id },
          now,
        }),
      ).toThrow();
      expect(f.persistence.listGraphResourceReservations(a.mission.id)[0]?.state).toBe('active');
      expect(f.persistence.getGraphIntegrationHold(hold.reservationId)?.integrationActive).toBe(
        true,
      );
      f.persistence.close();
    });

    it.each([false, true])(
      'checks sealed rename endpoints in the actual integration queue (declared=%s)',
      async (declared) => {
        const f = fixture(undefined, true);
        const workspace = join(dirname(f.path), 'workspace');
        mkdirSync(join(workspace, 'allowed'), { recursive: true });
        writeFileSync(join(workspace, 'outside.ts'), 'outside\n');
        writeFileSync(join(workspace, 'allowed/original.ts'), 'inside\n');
        expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0);
        expect(spawnSync('git', ['-C', workspace, 'add', '.']).status).toBe(0);
        expect(
          spawnSync('git', [
            '-C',
            workspace,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-qm',
            'base',
          ]).status,
        ).toBe(0);
        const a = await writeMission(f, workspace, ['allowed']);
        const run = begin(f, a.mission.id, 'a', a.acquisition.writeFootprints);
        const manager = new WorkerWorktreeManager({
          worktreesRoot: join(dirname(f.path), 'worktrees'),
        });
        const worker = {
          agentId: run.execution.assigneeAgentId,
          worktreeId: run.execution.id,
          repoPath: a.workspace,
        };
        const worktree = await manager.create(worker);
        f.persistence.recordTeamMissionWorktree({
          ...worktree,
          executionId: run.execution.id,
          agentId: worker.agentId,
          repoPath: a.workspace,
          now,
        });
        f.persistence.updateTeamMissionWorktree({
          executionId: run.execution.id,
          to: 'active',
          now,
        });
        renameSync(
          join(worktree.path, declared ? 'allowed/original.ts' : 'outside.ts'),
          join(worktree.path, 'allowed/moved.ts'),
        );
        const sealed = await manager.finalizeChanges({
          ...worker,
          baseHead: worktree.baseHead,
          commitMessage: 'rename',
        });
        const record = f.persistence.updateTeamMissionWorktree({
          executionId: run.execution.id,
          to: 'ready',
          workerHead: sealed.workerHead,
          // A incomplete report must not hide the undeclared deletion from the integration gate.
          changedFiles: ['allowed/moved.ts'],
          now,
        });
        const coordinator = new TeamCoordinator(
          f.persistence,
          new DeterministicTeamWorkerRuntime(),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          manager,
        );
        const integration = coordinator['queueMissionWorktreeIntegration'](record);
        if (declared) {
          await expect(integration).resolves.toMatchObject({ state: 'integrated' });
          expect(readFileSync(join(a.workspace, 'allowed/moved.ts'), 'utf8')).toBe('inside\n');
        } else {
          await expect(integration).rejects.toMatchObject({
            name: 'GraphWriteScopeError',
            undeclaredPaths: ['outside.ts'],
          });
          expect(
            spawnSync('git', ['-C', a.workspace, 'rev-parse', 'HEAD']).stdout.toString().trim(),
          ).toBe(worktree.baseHead);
          expect(existsSync(join(a.workspace, 'allowed/moved.ts'))).toBe(false);
          expect(f.persistence.getTeamMissionWorktree(run.execution.id)).toMatchObject({
            state: 'ready',
            workerHead: sealed.workerHead,
          });
        }
        expect(readFileSync(join(a.workspace, 'outside.ts'), 'utf8')).toBe('outside\n');
        expect(f.persistence.listGraphResourceReservations(a.mission.id)[0]?.state).toBe('active');
        f.persistence.close();
      },
    );

    it.each([false, true])(
      'checks every Project repository before integrating any of them (resume: %s)',
      async (resume) => {
        const base = fixture();
        const rootPaths = ['primary', 'secondary'].map((name) => join(dirname(base.path), name));
        const bindings = [];
        for (const root of rootPaths) {
          mkdirSync(join(root, 'allowed'), { recursive: true });
          writeFileSync(join(root, 'allowed/file.ts'), 'base\n');
          writeFileSync(join(root, 'outside.ts'), 'outside\n');
          expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
          expect(spawnSync('git', ['-C', root, 'add', '.']).status).toBe(0);
          expect(
            spawnSync('git', [
              '-C',
              root,
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@example.com',
              'commit',
              '-qm',
              'base',
            ]).status,
          ).toBe(0);
          bindings.push(await workspaceMutationBinding(root));
        }
        const project = base.persistence.createProject({
          name: 'Two repositories',
          folders: bindings.map((binding, i) => ({
            id: randomUUID(),
            path: binding.canonicalPath,
            canonicalPath: binding.canonicalPath,
            label: `root-${i}`,
            role: i === 0 ? ('primary' as const) : ('secondary' as const),
            workspaceKey: binding.workspaceKey,
            rootIdentityDigest: binding.rootIdentityDigest,
          })),
        });
        const f = fixture(
          { persistence: base.persistence, path: base.path },
          true,
          ['a', 'b'],
          project.id,
        );
        const context = graphMissionContextFor(f.persistence, f.task.id);
        const plan = structuredClone(f.plan);
        plan.steps[0]!.access = 'workspace-write';
        plan.steps[0]!.writeClaims = context.workspace.roots.map((root) => ({
          rootId: root.rootId,
          path: 'allowed',
          semanticKeys: [],
        }));
        const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
        f.persistence.saveGraphDocument(document, 1);
        const review = await reviewGraphMission(
          { taskId: f.task.id, instanceId: randomUUID(), renderRevision: document.renderRevision },
          document,
          () => graphMissionContextFor(f.persistence, f.task.id),
        );
        if (!review.writeFootprints) throw new Error('Expected Project claims');
        const mission = f.persistence.createGraphTeamMission({
          ...f.input,
          renderRevision: document.renderRevision,
          semanticRevision: document.semanticRevision,
          semanticDigest: document.semanticDigest,
        });
        const run = begin(f, mission.id, 'a', review.writeFootprints);
        const manager = new WorkerWorktreeManager({
          worktreesRoot: join(dirname(f.path), 'worktrees'),
        });
        const coordinator = new TeamCoordinator(
          f.persistence,
          new DeterministicTeamWorkerRuntime(),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          manager,
        );
        const isolation = await coordinator['prepareExecutionIsolation'](
          f.task.id,
          run.execution.id,
          run.execution.assigneeAgentId,
        );
        if (resume) {
          await installNativeGraphObserver(f.persistence, dirname(f.path));
          for (const repository of isolation.repositories)
            writeFileSync(
              join(repository.worktreePath, 'allowed/file.ts'),
              'retained project bytes\n',
            );
          f.persistence.interruptGraphStep({
            missionId: mission.id,
            stepKey: 'a',
            generation: 1,
            reservationId: run.reservation.id,
            attemptId: run.attempt.id,
            outcome: 'failed',
            reason: 'interrupted project fixture',
            confirmation: { kind: 'unconfirmed' },
            now,
          });
          coordinator['quarantineExecutionIsolation'](run.execution.id, new Error('interrupted'));
          const review = await coordinator.reviewGraphPreservedWorkspace(
            f.task.id,
            mission.id,
            'a',
          );
          expect(review.files).toHaveLength(2);
          await coordinator.resumeGraphStep(f.task.id, mission.id, 'a', review.digest);
          await vi.waitFor(
            () => expect(f.persistence.getTeamExecution(run.execution.id).state).toBe('completed'),
            { timeout: process.platform === 'win32' ? gitCheckpointTimeout : 15000 },
          );
          for (const repository of isolation.repositories)
            expect(readFileSync(join(repository.repoPath, 'allowed/file.ts'), 'utf8')).toBe(
              'retained project bytes\n',
            );
          expect(f.persistence.listTeamAttempts(run.execution.id)).toHaveLength(2);
          await vi.waitFor(
            () => expect(coordinator['executionScheduler'].snapshot().activeCount).toBe(0),
            { timeout: gitPreflightTimeout },
          );
          f.persistence.close();
          return;
        }
        for (const repository of isolation.repositories) {
          const primary = isolation.roots.some(
            (root) => root.role === 'primary' && root.repositoryOrdinal === repository.ordinal,
          );
          writeFileSync(
            join(repository.worktreePath, primary ? 'outside.ts' : 'allowed/file.ts'),
            'worker\n',
          );
        }
        const sealed = await coordinator['finalizeIsolation']({
          isolation,
          agentId: run.execution.assigneeAgentId,
          missionId: mission.id,
          stepOrdinal: 1,
        });
        await expect(coordinator['queueIsolationIntegration'](sealed.isolation)).rejects.toThrow(
          'outside the declared write scope',
        );
        for (const repository of isolation.repositories)
          expect(
            spawnSync('git', ['-C', repository.repoPath, 'rev-parse', 'HEAD'])
              .stdout.toString()
              .trim(),
          ).toBe(repository.baseHead);
        expect(f.persistence.getTeamExecutionIsolation(run.execution.id)?.phase).toBe(
          'waiting_resume',
        );
        expect(f.persistence.listGraphResourceReservations(mission.id)[0]?.state).toBe('active');
        f.persistence.close();
      },
      gitScenarioTimeout,
    );

    it('requires containment rather than mere overlap or hard-link identity for write permission', async () => {
      const f = fixture(undefined, true);
      const workspace = join(dirname(f.path), 'workspace');
      mkdirSync(workspace);
      writeFileSync(join(workspace, 'first.ts'), 'shared inode');
      linkSync(join(workspace, 'first.ts'), join(workspace, 'second.ts'));
      const a = await writeMission(f, workspace, ['first.ts']);
      const graph = f.persistence.getGraphTeamMission(a.mission.id);
      if (!graph) throw new Error('Expected graph');
      await expect(
        assertGraphWriteCoverage(graph, 'a', a.acquisition.writeFootprints, a.workspace, [
          { status: 'M', path: 'first.ts' },
        ]),
      ).resolves.toBeUndefined();
      for (const path of ['first.ts/child', 'second.ts'])
        await expect(
          assertGraphWriteCoverage(graph, 'a', a.acquisition.writeFootprints, a.workspace, [
            { status: 'M', path },
          ]),
        ).rejects.toMatchObject({ undeclaredPaths: [path] });
      f.persistence.close();
    });

    it('does not promote prospective case-expansion collisions to write permission', async () => {
      const f = fixture(undefined, true);
      const a = await writeMission(f, join(dirname(f.path), 'workspace'), ['\u00df.ts']);
      const graph = f.persistence.getGraphTeamMission(a.mission.id);
      if (!graph) throw new Error('Expected graph');
      await expect(
        assertGraphWriteCoverage(graph, 'a', a.acquisition.writeFootprints, a.workspace, [
          { status: 'A', path: 'SS.ts' },
        ]),
      ).rejects.toMatchObject({ undeclaredPaths: ['SS.ts'] });
      f.persistence.close();
    });

    it('rejects traversal, repository control data and replaced roots even under a whole-root claim', async () => {
      const f = fixture(undefined, true);
      const a = await writeMission(f, join(dirname(f.path), 'workspace'), [null]);
      const graph = f.persistence.getGraphTeamMission(a.mission.id);
      if (!graph) throw new Error('Expected graph');
      for (const path of ['../outside.ts', '.git/config', '.\u200cgit/config'])
        await expect(
          assertGraphWriteCoverage(graph, 'a', a.acquisition.writeFootprints, a.workspace, [
            { status: 'A', path },
          ]),
        ).rejects.toThrow();
      renameSync(a.workspace, `${a.workspace}-old`);
      mkdirSync(a.workspace);
      await expect(
        assertGraphWriteCoverage(graph, 'a', a.acquisition.writeFootprints, a.workspace, [
          { status: 'A', path: 'file.ts' },
        ]),
      ).rejects.toThrow('root changed');
      f.persistence.close();
    });

    it('acquires physical writes and resources atomically across Teams while allowing disjoint writers', async () => {
      const f = fixture(undefined, true);
      const second = fixture({ persistence: f.persistence, path: f.path }, true);
      const third = fixture({ persistence: f.persistence, path: f.path }, true);
      const workspace = join(dirname(f.path), 'workspace');
      const a = await writeMission(f, workspace, ['shared.ts'], 'first-device');
      const b = await writeMission(second, workspace, ['shared.ts'], 'second-device');
      const c = await writeMission(third, workspace, ['independent.ts'], 'second-device');
      const first = f.persistence.acquireGraphResources(a.acquisition);
      if (!first.acquired) throw new Error('Expected first write owner');
      expect(f.persistence.acquireGraphResources(b.acquisition)).toMatchObject({
        acquired: false,
        reason: 'write-conflicts',
        blockedKeys: [a.mission.steps[0]!.executionId],
      });
      expect(f.persistence.listGraphResourceReservations(b.mission.id)).toEqual([]);
      const independent = f.persistence.acquireGraphResources(c.acquisition);
      if (!independent.acquired) throw new Error('Independent write/resource should remain free');
      const running = begin(f, a.mission.id, 'a');
      f.persistence.interruptGraphStep({
        missionId: a.mission.id,
        stepKey: 'a',
        generation: 1,
        reservationId: running.reservation.id,
        attemptId: running.attempt.id,
        outcome: 'failed',
        reason: 'runtime_stop_unconfirmed',
        confirmation: { kind: 'unconfirmed' },
        now,
      });
      expect(f.persistence.listGraphResourceReservations(a.mission.id)[0]?.state).toBe(
        'quarantined',
      );
      expect(f.persistence.acquireGraphResources(b.acquisition)).toMatchObject({
        acquired: false,
        reason: 'write-conflicts',
      });
      expect(first.reservation.writeFootprints).toHaveLength(1);
      const db = new Database(f.path);
      expect(() =>
        db
          .prepare("UPDATE team_graph_resource_reservations SET write_claims_json='[]' WHERE id=?")
          .run(first.reservation.id),
      ).toThrow('immutable');
      expect(() =>
        db
          .prepare('DELETE FROM team_graph_resource_reservations WHERE id=?')
          .run(first.reservation.id),
      ).toThrow('not released');
      db.close();
      f.persistence.releaseGraphResources({
        reservationId: first.reservation.id,
        executionId: first.reservation.executionId,
        generation: 1,
        confirmation: { kind: 'attempt-stopped', attemptId: running.attempt.id },
        now,
      });
      expect(f.persistence.acquireGraphResources(b.acquisition)).toMatchObject({
        acquired: false,
        reason: 'resources',
      });
      expect(f.persistence.listGraphResourceReservations(b.mission.id)).toEqual([]);
      f.persistence.releaseGraphResources({
        reservationId: independent.reservation.id,
        executionId: independent.reservation.executionId,
        generation: 1,
        confirmation: { kind: 'not-dispatched' },
        now,
      });
      expect(f.persistence.acquireGraphResources(b.acquisition).acquired).toBe(true);
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      f.persistence.close();
    });

    it('retains write ownership after restart and target creation without promoting stored evidence to fresh admission', async () => {
      const f = fixture(undefined, true);
      const workspace = join(dirname(f.path), 'workspace');
      const a = await writeMission(f, workspace);
      const held = f.persistence.acquireGraphResources(a.acquisition);
      if (!held.acquired) throw new Error('Expected write owner');
      f.persistence.close();
      writeFileSync(join(workspace, 'shared.ts'), 'created after reservation');
      const restored = new SqlitePersistenceClient(f.path);
      restored.recoverInterruptedTeamExecutions('2026-09-11T00:01:00.000Z');
      const saved = restored.listGraphResourceReservations(a.mission.id)[0]!;
      expect(saved.state).toBe('quarantined');
      expect(saved.writeFootprints).toHaveLength(1);
      const second = fixture({ persistence: restored, path: f.path }, true);
      const b = await writeMission(second, workspace);
      expect(restored.acquireGraphResources(b.acquisition)).toMatchObject({
        acquired: false,
        reason: 'write-conflicts',
      });
      restored.releaseGraphResources({
        reservationId: held.reservation.id,
        executionId: held.reservation.executionId,
        generation: 1,
        confirmation: { kind: 'not-dispatched' },
        now,
      });
      expect(() =>
        restored.acquireGraphResources({
          ...b.acquisition,
          writeFootprints: saved.writeFootprints,
        }),
      ).toThrow('Fresh graph write preparation');
      expect(restored.acquireGraphResources(b.acquisition).acquired).toBe(true);
      expect(restored.checkTeamIntegrity().inconsistencies).toEqual([]);
      restored.close();
    });

    it('rejects missing claims and rolls write ownership back with resource insertion failure', async () => {
      const f = fixture(undefined, true);
      const a = await writeMission(
        f,
        join(dirname(f.path), 'workspace'),
        ['a.ts', 'b.ts'],
        'device',
      );
      expect(() =>
        f.persistence.acquireGraphResources({
          missionId: a.mission.id,
          stepKey: 'a',
          expectedGeneration: 1,
          now,
        }),
      ).toThrow('Fresh graph write preparation');
      expect(() =>
        f.persistence.acquireGraphResources({
          ...a.acquisition,
          writeFootprints: a.acquisition.writeFootprints.slice(0, 1),
        }),
      ).toThrow('declarations do not match');
      const db = new Database(f.path);
      db.exec(
        "CREATE TRIGGER fail_write_acquisition BEFORE INSERT ON team_graph_resource_leases WHEN NEW.scope='worker' BEGIN SELECT RAISE(ABORT,'simulated acquisition failure'); END;",
      );
      expect(() => f.persistence.acquireGraphResources(a.acquisition)).toThrow(
        'simulated acquisition failure',
      );
      expect(f.persistence.listGraphResourceReservations(a.mission.id)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM team_graph_resource_leases').get()).toEqual({
        count: 0,
      });
      db.exec('DROP TRIGGER fail_write_acquisition');
      db.close();
      expect(f.persistence.acquireGraphResources(a.acquisition).acquired).toBe(true);
      f.persistence.close();
    });

    it('holds a write scope until real Git integration and its durable checkpoint complete', async () => {
      const f = fixture(undefined, true);
      const workspace = join(dirname(f.path), 'workspace');
      mkdirSync(workspace);
      expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0);
      writeFileSync(join(workspace, 'shared.ts'), 'base\n');
      expect(spawnSync('git', ['-C', workspace, 'add', 'shared.ts']).status).toBe(0);
      expect(
        spawnSync('git', [
          '-C',
          workspace,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-qm',
          'base',
        ]).status,
      ).toBe(0);
      const a = await writeMission(f, workspace);
      const run = begin(f, a.mission.id, 'a', a.acquisition.writeFootprints);
      const manager = new WorkerWorktreeManager({
        worktreesRoot: join(dirname(f.path), 'worktrees'),
      });
      const worker = {
        agentId: run.execution.assigneeAgentId,
        worktreeId: run.execution.id,
        repoPath: a.workspace,
      };
      const worktree = await manager.create(worker);
      f.persistence.recordTeamMissionWorktree({
        ...worktree,
        executionId: run.execution.id,
        agentId: worker.agentId,
        repoPath: a.workspace,
        now,
      });
      f.persistence.updateTeamMissionWorktree({ executionId: run.execution.id, to: 'active', now });
      writeFileSync(join(worktree.path, 'shared.ts'), 'integrated\n');
      const sealed = await manager.finalizeChanges({
        ...worker,
        baseHead: worktree.baseHead,
        commitMessage: 'write shared file',
      });
      f.persistence.updateTeamMissionWorktree({
        executionId: run.execution.id,
        to: 'ready',
        workerHead: sealed.workerHead,
        changedFiles: sealed.changedFiles,
        now,
      });
      expect(() => f.persistence.completeGraphStep(completion(a.mission.id, 'a', run))).toThrow(
        'integration is not confirmed',
      );
      const integrated = await manager.integrate({
        repoPath: a.workspace,
        baseHead: worktree.baseHead,
        workerHead: sealed.workerHead,
      });
      expect(readFileSync(join(a.workspace, 'shared.ts'), 'utf8')).toBe('integrated\n');
      const second = fixture({ persistence: f.persistence, path: f.path }, true);
      const b = await writeMission(second, workspace);
      expect(f.persistence.acquireGraphResources(b.acquisition)).toMatchObject({
        acquired: false,
        reason: 'write-conflicts',
      });
      expect(() => f.persistence.completeGraphStep(completion(a.mission.id, 'a', run))).toThrow(
        'integration is not confirmed',
      );
      f.persistence.updateTeamMissionWorktree({
        executionId: run.execution.id,
        to: 'integrated',
        integratedHead: integrated.integratedHead,
        now,
      });
      const complete = completion(a.mission.id, 'a', run);
      f.persistence.completeGraphStep({
        ...complete,
        checkpoint: {
          ...complete.checkpoint,
          gitHead: integrated.integratedHead,
          changedFiles: [...sealed.changedFiles],
          workspaceDigest: f.persistence.getEffectiveWorkspaceSet(f.task.id).digest,
        },
      });
      expect(f.persistence.listGraphResourceReservations(a.mission.id)[0]?.state).toBe('released');
      expect(f.persistence.acquireGraphResources(b.acquisition).acquired).toBe(true);
      expect(await manager.cleanup(worker)).toMatchObject({ outcome: 'removed' });
      f.persistence.updateTeamMissionWorktree({
        executionId: run.execution.id,
        to: 'cleaned',
        now,
      });
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      f.persistence.close();
    });

    it('migrates older write reservations to recovery without inferring an empty write scope', async () => {
      const f = fixture(undefined, true);
      const workspace = join(dirname(f.path), 'workspace');
      const a = await writeMission(f, workspace);
      const held = f.persistence.acquireGraphResources(a.acquisition);
      if (!held.acquired) throw new Error('Expected write reservation');
      f.persistence.close();
      const old = new Database(f.path);
      old.exec(
        'DROP TRIGGER graph_write_inventory_immutable; ALTER TABLE team_graph_resource_reservations DROP COLUMN write_claims_digest; ALTER TABLE team_graph_resource_reservations DROP COLUMN write_claims_json; DELETE FROM schema_migrations WHERE version=88;',
      );
      old.close();
      const restored = new SqlitePersistenceClient(f.path);
      expect(restored.listGraphResourceReservations(a.mission.id)[0]).toMatchObject({
        state: 'quarantined',
        writeFootprints: [],
      });
      const second = fixture({ persistence: restored, path: f.path }, true);
      const b = await writeMission(second, workspace);
      expect(() => restored.acquireGraphResources(b.acquisition)).toThrow(
        'write owner requires recovery',
      );
      const reader = fixture({ persistence: restored, path: f.path });
      const readMission = resourceMission(reader);
      expect(reserve(reader, readMission.id).state).toBe('reserved');
      restored.releaseGraphResources({
        reservationId: held.reservation.id,
        executionId: held.reservation.executionId,
        generation: 1,
        confirmation: { kind: 'not-dispatched' },
        now,
      });
      expect(restored.acquireGraphResources(b.acquisition).acquired).toBe(true);
      restored.close();
      const again = new SqlitePersistenceClient(f.path);
      expect(again.checkTeamIntegrity().inconsistencies).toEqual([]);
      again.close();
    });

    it('uses real graph ownership to keep resource and dependency waiters out of Scheduler slots', async () => {
      const f = fixture(undefined, false, ['a', 'b', 'c']);
      const plan = structuredClone(f.plan);
      plan.steps[0]!.resourceClaims = [{ scope: 'machine', key: 'shared-db', rootId: null }];
      plan.steps[1]!.dependsOn = [];
      plan.steps[2]!.dependsOn = ['a', 'b'];
      const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
      f.persistence.saveGraphDocument(document, 1);
      const mission = f.persistence.createGraphTeamMission({
        ...f.input,
        renderRevision: document.renderRevision,
        semanticRevision: document.semanticRevision,
        semanticDigest: document.semanticDigest,
      });
      const other = fixture({ persistence: f.persistence, path: f.path });
      const ownerMission = resourceMission(other);
      expect(
        f.persistence.inspectGraphResources({
          missionId: mission.id,
          stepKey: 'a',
          expectedGeneration: 1,
        }),
      ).toEqual({ available: true, reservation: null });
      expect(f.persistence.listGraphResourceReservations(mission.id)).toEqual([]);
      const owner = begin(other, ownerMission.id, 'a');
      // Readiness is only an observation: acquisition must see the newly occupied resource.
      expect(
        f.persistence.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'a',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'resources' });
      const scheduler = new TeamExecutionScheduler(2);
      const started: string[] = [];
      const release = new Map<string, () => void>();
      const failures: unknown[] = [];
      for (const [index, step] of mission.steps.entries()) {
        const key = ['a', 'b', 'c'][index]!;
        scheduler.submit({
          executionId: step.executionId,
          workerId: plan.steps[index]!.workerId,
          teamId: f.team.id,
          teamLimit: 2,
          isReady: () =>
            f.persistence.inspectGraphResources({
              missionId: mission.id,
              stepKey: key,
              expectedGeneration: 1,
            }).available,
          onReadinessError: (error) => failures.push(error),
          run: async () => {
            try {
              const run = begin(f, mission.id, key);
              started.push(key);
              await new Promise<void>((resolve) => release.set(key, resolve));
              f.persistence.completeGraphStep(completion(mission.id, key, run));
            } catch (error) {
              failures.push(error);
            }
          },
        });
      }
      await vi.waitFor(() => expect(started).toEqual(['b']));
      expect(scheduler.snapshot().activeCount).toBe(1);
      expect(f.persistence.listGraphResourceReservations(mission.id)).toHaveLength(1);
      release.get('b')!();
      await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
      expect(started).toEqual(['b']);
      f.persistence.interruptGraphStep({
        missionId: ownerMission.id,
        stepKey: 'a',
        generation: 1,
        reservationId: owner.reservation.id,
        attemptId: owner.attempt.id,
        outcome: 'canceled',
        reason: 'user_canceled',
        confirmation: { kind: 'attempt-stopped', attemptId: owner.attempt.id },
        now,
      });
      scheduler.notifyReadinessChanged();
      await vi.waitFor(() => expect(started).toEqual(['b', 'a']));
      release.get('a')!();
      await vi.waitFor(() => expect(started).toEqual(['b', 'a', 'c']));
      release.get('c')!();
      await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
      expect(f.persistence.getTeamMission(mission.id).state).toBe('completed');
      expect(failures).toEqual([]);
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      f.persistence.close();
    });

    it.each([true, false])('pauses only the failed branch, with stop confirmed=%s', (stopped) => {
      const f = fixture(undefined, false, ['a', 'b', 'c']);
      const plan = structuredClone(f.plan);
      plan.steps[0]!.resourceClaims = [{ scope: 'machine', key: 'shared-db', rootId: null }];
      plan.steps[1]!.dependsOn = [];
      plan.steps[2]!.dependsOn = ['a', 'b'];
      const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
      f.persistence.saveGraphDocument(document, 1);
      const mission = f.persistence.createGraphTeamMission({
        ...f.input,
        renderRevision: document.renderRevision,
        semanticRevision: document.semanticRevision,
        semanticDigest: document.semanticDigest,
      });
      const a = begin(f, mission.id, 'a');
      const b = begin(f, mission.id, 'b');
      const interruption = {
        missionId: mission.id,
        stepKey: 'a',
        generation: 1,
        reservationId: a.reservation.id,
        attemptId: a.attempt.id,
        outcome: 'failed' as const,
        reason: 'runtime_failure',
        now,
        confirmation: stopped
          ? { kind: 'attempt-stopped' as const, attemptId: a.attempt.id }
          : { kind: 'unconfirmed' as const },
      };
      expect(f.persistence.interruptGraphStep(interruption).state).toBe(
        stopped ? 'released' : 'quarantined',
      );
      expect(f.persistence.getTeamExecution(a.execution.id).state).toBe('waiting_resume');
      expect(f.persistence.getTeamAttempt(a.attempt.id).state).toBe(
        stopped ? 'failed' : 'interrupted',
      );
      expect(f.persistence.getTeamExecution(b.execution.id).state).toBe('running');
      expect(f.persistence.getTeamTask(a.dispatch.teamTaskId).status).toBe('blocked');
      expect(f.persistence.getTeamMission(mission.id).steps[0]?.checkpoint).toBeNull();
      expect(f.persistence.completeGraphStep(completion(mission.id, 'b', b))).toMatchObject({
        mission: { state: 'running' },
        dependencyReadyStepKeys: [],
      });
      expect(
        f.persistence.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'c',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'dependencies' });
      const other = fixture({ persistence: f.persistence, path: f.path });
      const otherMission = resourceMission(other);
      const otherAcquired = f.persistence.acquireGraphResources({
        missionId: otherMission.id,
        stepKey: 'a',
        expectedGeneration: 1,
        now,
      });
      expect(otherAcquired.acquired).toBe(stopped);
      if (otherAcquired.acquired)
        f.persistence.releaseGraphResources({
          reservationId: otherAcquired.reservation.id,
          executionId: otherAcquired.reservation.executionId,
          generation: 1,
          confirmation: { kind: 'not-dispatched' },
          now,
        });
      else {
        expect(otherAcquired).toMatchObject({ reason: 'resources' });
        f.persistence.releaseGraphResources({
          reservationId: a.reservation.id,
          executionId: a.execution.id,
          generation: 1,
          confirmation: { kind: 'attempt-stopped', attemptId: a.attempt.id },
          now,
        });
      }
      const held = reserve(f, mission.id);
      const resumed = f.persistence.beginGraphAttempt({
        missionId: mission.id,
        stepKey: 'a',
        generation: 1,
        reservationId: held.id,
        reason: 'manual_resume',
        now,
      });
      expect(resumed.attempt.id).not.toBe(a.attempt.id);
      expect(() => f.persistence.interruptGraphStep(interruption)).toThrow('owner mismatch');
      expect(
        f.persistence.listGraphResourceReservations(mission.id).find((row) => row.id === held.id)
          ?.state,
      ).toBe('active');
      const dispatch = f.persistence.getTeamExecutionDispatch(a.execution.id);
      f.persistence.transitionTeamAttempt({ attemptId: resumed.attempt.id, to: 'running', now });
      f.persistence.transitionTeamTask(dispatch.teamTaskId, 'running', now);
      expect(
        f.persistence.completeGraphStep(completion(mission.id, 'a', { ...resumed, dispatch }))
          .dependencyReadyStepKeys,
      ).toEqual(['c']);
      const c = begin(f, mission.id, 'c');
      expect(f.persistence.completeGraphStep(completion(mission.id, 'c', c)).mission.state).toBe(
        'completed',
      );
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      f.persistence.close();
    });

    const unconfirmedExit = () =>
      new WorkerRuntimeExitUnconfirmedError(
        'Runtime process tree exit was not confirmed within 30 seconds',
        { originalError: new Error('runtime failed') },
      );
    it.each<[string, () => Error, boolean, 0 | 1, 'quarantined' | 'released']>([
      ['an unconfirmed Turn exit', unconfirmedExit, false, 0, 'quarantined'],
      [
        'an unconfirmed Turn exit the runtime still counts',
        unconfirmedExit,
        true,
        0,
        'quarantined',
      ],
      [
        'a failed Turn the runtime still counts',
        () => new Error('runtime failed'),
        true,
        1,
        'quarantined',
      ],
      [
        'a refusal before anything started',
        () =>
          new WorkerRuntimeExitUnconfirmedError('previous Turn exit is unconfirmed', {
            startRefused: true,
          }),
        false,
        1,
        'released',
      ],
      [
        'a failed Turn whose stop was confirmed',
        () => new Error('runtime failed'),
        false,
        1,
        'released',
      ],
    ])(
      'keeps a failed graph step resources reserved while its Worker may still run: %s',
      async (_label, failure, unsettled, stops, reservation) => {
        const f = fixture();
        const plan = structuredClone(f.plan);
        plan.steps[0]!.resourceClaims = [{ scope: 'machine', key: 'shared-db', rootId: null }];
        const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
        f.persistence.saveGraphDocument(document, 1);
        const executed: string[] = [];
        // Like `RuntimeHostTeamWorkerRuntime` after a Turn failed: that Turn has already left the
        // runtime, so a stop returns without stopping anything (issue #556). Only the runtime's own
        // record of the Turn says whether its CLI may still be running.
        const stop = vi.fn(async (_agentId: string) => undefined);
        const runtime: TeamWorkerRuntime = {
          async start() {
            return { pid: null };
          },
          async execute(input) {
            executed.push(input.executionId!);
            throw failure();
          },
          stop,
          hasUnsettledTurn: (_agentId, executionId) => unsettled && executed.includes(executionId),
        };
        const scheduler = new TeamExecutionScheduler(1);
        const coordinator = new TeamCoordinator(
          f.persistence,
          runtime,
          undefined,
          undefined,
          undefined,
          scheduler,
        );
        try {
          const mission = await coordinator.startGraphMission(f.task.id, async () => ({
            ...f.input,
            renderRevision: document.renderRevision,
            semanticRevision: document.semanticRevision,
            semanticDigest: document.semanticDigest,
          }));
          const executionId = mission.steps[0]!.executionId;
          await vi.waitFor(() =>
            expect(f.persistence.getTeamExecution(executionId).state).toBe('waiting_resume'),
          );
          await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
          expect(executed).toEqual([executionId]);
          expect(f.persistence.listTeamAttempts(executionId)).toMatchObject([
            { state: reservation === 'quarantined' ? 'interrupted' : 'failed' },
          ]);
          expect(f.persistence.listGraphResourceReservations(mission.id)).toMatchObject([
            { executionId, state: reservation },
          ]);
          // Another Mission's step that needs the same resource gets it only after a confirmed stop.
          const other = fixture({ persistence: f.persistence, path: f.path });
          expect(
            f.persistence.acquireGraphResources({
              missionId: resourceMission(other).id,
              stepKey: 'a',
              expectedGeneration: 1,
              now,
            }),
          ).toMatchObject(
            reservation === 'quarantined'
              ? { acquired: false, reason: 'resources' }
              : { acquired: true },
          );
          // No stop is asked for after an unconfirmed exit, since none could confirm it.
          expect(stop).toHaveBeenCalledTimes(stops);
        } finally {
          await vi.waitFor(() => expect(scheduler.snapshot().activeCount).toBe(0));
          f.persistence.close();
        }
      },
    );

    it('rejects stale interruption ownership and rolls back every row when release fails', () => {
      const f = fixture();
      const mission = resourceMission(f);
      const a = begin(f, mission.id, 'a');
      const input = {
        missionId: mission.id,
        stepKey: 'a',
        generation: 1,
        reservationId: a.reservation.id,
        attemptId: a.attempt.id,
        outcome: 'canceled' as const,
        reason: 'user_canceled',
        now,
        confirmation: { kind: 'attempt-stopped' as const, attemptId: a.attempt.id },
      };
      expect(() => f.persistence.interruptGraphStep({ ...input, generation: 2 })).toThrow(
        'generation mismatch',
      );
      expect(() =>
        f.persistence.interruptGraphStep({
          ...input,
          confirmation: { kind: 'attempt-stopped', attemptId: randomUUID() },
        }),
      ).toThrow('Invalid graph interruption');
      expect(() =>
        f.persistence.interruptGraphStep({ ...input, reservationId: randomUUID() }),
      ).toThrow('owner mismatch');
      const db = new Database(f.path);
      db.exec(
        "CREATE TRIGGER fail_graph_release BEFORE UPDATE OF state ON team_graph_resource_reservations WHEN NEW.state='released' BEGIN SELECT RAISE(ABORT,'simulated release failure'); END;",
      );
      expect(() => f.persistence.interruptGraphStep(input)).toThrow('simulated release failure');
      expect(f.persistence.getTeamExecution(a.execution.id).state).toBe('running');
      expect(f.persistence.getTeamAttempt(a.attempt.id).state).toBe('running');
      expect(f.persistence.getTeamTask(a.dispatch.teamTaskId).status).toBe('running');
      expect(f.persistence.listGraphResourceReservations(mission.id)[0]?.state).toBe('active');
      db.exec('DROP TRIGGER fail_graph_release');
      db.close();
      expect(f.persistence.interruptGraphStep(input).state).toBe('released');
      expect(f.persistence.getTeamAttempt(a.attempt.id).state).toBe('canceled');
      expect(f.persistence.getTeamExecution(mission.steps[1]!.executionId).state).toBe('assigned');
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      f.persistence.close();
    });

    it('holds an unconfirmed pre-dispatch Attempt without making a checkpoint', () => {
      const f = fixture();
      const mission = resourceMission(f);
      const reservation = reserve(f, mission.id);
      const run = f.persistence.beginGraphAttempt({
        missionId: mission.id,
        stepKey: 'a',
        generation: 1,
        reservationId: reservation.id,
        now,
      });
      expect(
        f.persistence.interruptGraphStep({
          missionId: mission.id,
          stepKey: 'a',
          generation: 1,
          reservationId: reservation.id,
          attemptId: run.attempt.id,
          outcome: 'failed',
          reason: 'runtime_start_unconfirmed',
          confirmation: { kind: 'unconfirmed' },
          now,
        }).state,
      ).toBe('quarantined');
      expect(f.persistence.getTeamAttempt(run.attempt.id).state).toBe('canceled');
      expect(f.persistence.getTeamMission(mission.id).steps[0]?.checkpoint).toBeNull();
      expect(
        f.persistence.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'a',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'owner-active' });
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      f.persistence.close();
    });

    it('starts independent A/B and confirms the join C only after both complete, without seeded execution rows', () => {
      const f = fixture(undefined, false, ['a', 'b', 'c']);
      const plan = structuredClone(f.plan);
      plan.steps[1]!.dependsOn = [];
      plan.steps[2]!.dependsOn = ['a', 'b'];
      const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
      f.persistence.saveGraphDocument(document, 1);
      const mission = f.persistence.createGraphTeamMission({
        ...f.input,
        renderRevision: document.renderRevision,
        semanticRevision: document.semanticRevision,
        semanticDigest: document.semanticDigest,
      });
      const a = begin(f, mission.id, 'a');
      const b = begin(f, mission.id, 'b');
      expect(
        f.persistence.listTeamExecutions(f.team.id).filter((row) => row.state === 'running'),
      ).toHaveLength(2);
      expect(
        f.persistence.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'c',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'dependencies' });
      expect(f.persistence.completeGraphStep(completion(mission.id, 'a', a))).toMatchObject({
        mission: { state: 'running' },
        dependencyReadyStepKeys: [],
      });
      expect(f.persistence.completeGraphStep(completion(mission.id, 'b', b))).toMatchObject({
        mission: { state: 'running' },
        dependencyReadyStepKeys: ['c'],
      });
      const c = begin(f, mission.id, 'c');
      expect(f.persistence.completeGraphStep(completion(mission.id, 'c', c))).toMatchObject({
        mission: { state: 'completed' },
        dependencyReadyStepKeys: [],
      });
      expect(
        f.persistence
          .listGraphResourceReservations(mission.id)
          .every((row) => row.state === 'released'),
      ).toBe(true);
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      expect(() => f.persistence.completeGraphStep(completion(mission.id, 'c', c))).toThrow(
        'owner mismatch',
      );
      f.persistence.close();
    });

    it('rolls back Attempt creation and completion as whole transactions', () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const reserved = reserve(f, mission.id);
      const db = new Database(f.path);
      db.exec(
        "CREATE TRIGGER fail_graph_attempt BEFORE INSERT ON team_attempts BEGIN SELECT RAISE(ABORT,'attempt insert failed'); END;",
      );
      expect(() =>
        f.persistence.beginGraphAttempt({
          missionId: mission.id,
          stepKey: 'a',
          generation: 1,
          reservationId: reserved.id,
          now,
        }),
      ).toThrow('attempt insert failed');
      expect(f.persistence.getTeamMission(mission.id).state).toBe('queued');
      expect(f.persistence.getTeamExecution(reserved.executionId).state).toBe('assigned');
      expect(f.persistence.listTeamAttempts(reserved.executionId)).toEqual([]);
      db.exec('DROP TRIGGER fail_graph_attempt;');
      const a = begin(f, mission.id, 'a');
      const input = completion(mission.id, 'a', a);
      expect(() => f.persistence.completeGraphStep({ ...input, generation: 2 })).toThrow(
        'generation mismatch',
      );
      expect(() =>
        f.persistence.completeGraphStep({
          ...input,
          confirmation: { kind: 'attempt-stopped', attemptId: randomUUID() },
        }),
      ).toThrow('acknowledgement mismatch');
      expect(() =>
        f.persistence.completeGraphStep({ ...input, agentId: f.workers[1]!.id }),
      ).toThrow('dispatch mismatch');
      expect(() => f.persistence.completeGraphStep({ ...input, doneEvidence: [] })).toThrow(
        'evidence',
      );
      db.exec(
        "CREATE TRIGGER fail_graph_checkpoint BEFORE UPDATE OF checkpoint_generation ON team_graph_mission_steps BEGIN SELECT RAISE(ABORT,'checkpoint failed'); END;",
      );
      expect(() => f.persistence.completeGraphStep(input)).toThrow('checkpoint failed');
      expect(f.persistence.getTeamExecution(a.execution.id).state).toBe('running');
      expect(f.persistence.getTeamAttempt(a.attempt.id).state).toBe('running');
      expect(f.persistence.listGraphResourceReservations(mission.id)[0]?.state).toBe('active');
      expect(db.prepare('SELECT COUNT(*) AS count FROM team_reports').get()).toEqual({ count: 0 });
      db.exec('DROP TRIGGER fail_graph_checkpoint;');
      db.close();
      expect(f.persistence.completeGraphStep(input).dependencyReadyStepKeys).toEqual(['b']);
      f.persistence.close();
    });

    it('quarantines a crash before runtime acceptance and resumes with a new Attempt only after release', () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const held = reserve(f, mission.id);
      const first = f.persistence.beginGraphAttempt({
        missionId: mission.id,
        stepKey: 'a',
        generation: 1,
        reservationId: held.id,
        now,
      });
      const oldTask = f.persistence.getTeamExecutionDispatch(first.execution.id).teamTaskId;
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      restored.recoverInterruptedTeamExecutions('2026-09-11T00:01:00.000Z');
      expect(restored.getTeamExecution(first.execution.id).state).toBe('waiting_resume');
      expect(restored.getTeamAttempt(first.attempt.id).state).toBe('canceled');
      expect(restored.listGraphResourceReservations(mission.id)[0]?.state).toBe('quarantined');
      expect(restored.getTeamTask(oldTask).status).toBe('canceled');
      expect(() =>
        restored.beginGraphAttempt({
          missionId: mission.id,
          stepKey: 'a',
          generation: 1,
          reservationId: held.id,
          reason: 'manual_resume',
          now,
        }),
      ).toThrow('reservation mismatch');
      restored.releaseGraphResources({
        reservationId: held.id,
        executionId: first.execution.id,
        generation: 1,
        confirmation: { kind: 'attempt-stopped', attemptId: first.attempt.id },
        now,
      });
      const acquired = restored.acquireGraphResources({
        missionId: mission.id,
        stepKey: 'a',
        expectedGeneration: 1,
        now,
      });
      if (!acquired.acquired) throw new Error('Expected reacquisition');
      const resumed = restored.beginGraphAttempt({
        missionId: mission.id,
        stepKey: 'a',
        generation: 1,
        reservationId: acquired.reservation.id,
        reason: 'manual_resume',
        now,
      });
      expect(resumed.attempt).toMatchObject({ ordinal: 2, startReason: 'manual_resume' });
      expect(resumed.attempt.id).not.toBe(first.attempt.id);
      expect(restored.getTeamExecutionDispatch(resumed.execution.id).teamTaskId).not.toBe(oldTask);
      expect(restored.checkTeamIntegrity().inconsistencies).toEqual([]);
      restored.close();
    });
    it('does not accept a never-dispatched release while an unbound Attempt is still awaiting verification', () => {
      const f = fixture();
      const mission = resourceMission(f);
      const held = reserve(f, mission.id);
      const db = new Database(f.path);
      db.prepare("UPDATE team_executions SET state='running' WHERE id=?").run(held.executionId);
      db.close();
      const attempt = f.persistence.createTeamAttempt(held.executionId, now);
      f.persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'waiting_verification',
        now,
      });
      f.persistence.transitionTeamExecution({
        executionId: held.executionId,
        to: 'waiting_resume',
        now,
      });
      const release = {
        reservationId: held.id,
        executionId: held.executionId,
        generation: 1,
        confirmation: { kind: 'not-dispatched' as const },
        now,
      };
      expect(() => f.persistence.releaseGraphResources(release)).toThrow('acknowledgement');
      f.persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'canceled',
        now,
        terminalReason: 'preflight_canceled',
      });
      expect(f.persistence.releaseGraphResources(release)).toBe(true);
      f.persistence.close();
    });
    it('does not unlock dependents of a write step before repository integration is confirmed', async () => {
      const f = fixture(undefined, true);
      const workspace = join(dirname(f.path), 'workspace');
      mkdirSync(workspace);
      const binding = await workspaceMutationBinding(workspace);
      f.persistence.setWorkspaceBinding(f.task.id, {
        path: binding.canonicalPath,
        workspaceKey: binding.workspaceKey,
        rootIdentityDigest: binding.rootIdentityDigest,
      });
      const context = graphMissionContextFor(f.persistence, f.task.id);
      const plan = structuredClone(f.plan);
      plan.steps[0]!.access = 'workspace-write';
      plan.steps[0]!.writeClaims = [
        { rootId: context.workspace.primaryRootId!, path: null, semanticKeys: [] },
      ];
      const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
      f.persistence.saveGraphDocument(document, 1);
      const review = await reviewGraphMission(
        { taskId: f.task.id, instanceId: randomUUID(), renderRevision: document.renderRevision },
        document,
        () => graphMissionContextFor(f.persistence, f.task.id),
      );
      if (!review.writeFootprints) throw new Error('Expected prepared writes');
      const mission = f.persistence.createGraphTeamMission({
        ...f.input,
        renderRevision: document.renderRevision,
        semanticRevision: document.semanticRevision,
        semanticDigest: document.semanticDigest,
        workspaceDigest: context.workspace.digest,
        contextDigest: graphMissionContextDigest(
          context,
          new Set(f.workers.map((worker) => worker.id)),
        ),
      });
      const run = begin(f, mission.id, 'a', review.writeFootprints);
      const held = run.reservation;
      const attempt = run.attempt;
      expect(() => f.persistence.completeGraphStep(completion(mission.id, 'a', run))).toThrow(
        'integration is not confirmed',
      );
      const db = new Database(f.path);
      f.persistence.transitionTeamAttempt({ attemptId: attempt.id, to: 'completed', now });
      const checkpoint = JSON.stringify({
        summary: 'not integrated',
        changedFiles: [],
        gitHead: null,
        workspaceDigest: context.workspace.digest,
        recordedAt: now,
      });
      db.prepare("UPDATE team_executions SET state='completed' WHERE id=?").run(held.executionId);
      db.prepare(
        'UPDATE team_mission_steps SET checkpoint_json=?,checkpoint_digest=? WHERE execution_id=?',
      ).run(checkpoint, createHash('sha256').update(checkpoint).digest('hex'), held.executionId);
      db.prepare(
        'UPDATE team_graph_mission_steps SET checkpoint_generation=generation,checkpoint_attempt_id=? WHERE execution_id=?',
      ).run(attempt.id, held.executionId);
      db.close();
      expect(() =>
        f.persistence.releaseGraphResources({
          reservationId: held.id,
          executionId: held.executionId,
          generation: 1,
          confirmation: { kind: 'attempt-stopped', attemptId: attempt.id },
          now,
        }),
      ).toThrow('integration is not confirmed');
      expect(
        f.persistence.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'b',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'dependencies' });
      f.persistence.close();
    });
    it('rolls back partial lease acquisition and release failures', () => {
      const f = fixture();
      const mission = resourceMission(f);
      const db = new Database(f.path);
      db.exec(
        "CREATE TRIGGER fail_resource_acquire BEFORE INSERT ON team_graph_resource_leases WHEN NEW.scope='worker' BEGIN SELECT RAISE(ABORT,'lease insert failed'); END;",
      );
      expect(() => reserve(f, mission.id)).toThrow('lease insert failed');
      expect(f.persistence.listGraphResourceReservations(mission.id)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM team_graph_resource_leases').get()).toEqual({
        count: 0,
      });
      db.exec('DROP TRIGGER fail_resource_acquire;');
      const held = reserve(f, mission.id);
      db.exec(
        "CREATE TRIGGER fail_resource_release BEFORE DELETE ON team_graph_resource_leases WHEN OLD.scope='worker' BEGIN SELECT RAISE(ABORT,'lease delete failed'); END;",
      );
      const release = {
        reservationId: held.id,
        executionId: held.executionId,
        generation: 1,
        confirmation: { kind: 'not-dispatched' as const },
        now,
      };
      expect(() => f.persistence.releaseGraphResources(release)).toThrow('lease delete failed');
      expect(f.persistence.listGraphResourceReservations(mission.id)[0]).toMatchObject({
        state: 'reserved',
        resources: held.resources,
      });
      db.exec('DROP TRIGGER fail_resource_release;');
      db.close();
      f.persistence.releaseGraphResources(release);
      f.persistence.close();
    });

    it('requires a current checkpoint generation and rechecks dependencies before Attempt binding', () => {
      const f = fixture();
      const mission = resourceMission(f);
      const predecessor = mission.steps[0]!.executionId;
      const previousLease = reserve(f, mission.id);
      const checkpoint = JSON.stringify({
        summary: 'verified',
        changedFiles: [],
        gitHead: null,
        workspaceDigest: null,
        recordedAt: now,
      });
      const db = new Database(f.path);
      db.prepare("UPDATE team_executions SET state='running' WHERE id=?").run(predecessor);
      const previousAttempt = f.persistence.createTeamAttempt(predecessor, now);
      f.persistence.bindGraphResourcesToAttempt({
        reservationId: previousLease.id,
        executionId: predecessor,
        generation: 1,
        attemptId: previousAttempt.id,
      });
      f.persistence.transitionTeamAttempt({ attemptId: previousAttempt.id, to: 'running', now });
      f.persistence.transitionTeamAttempt({ attemptId: previousAttempt.id, to: 'completed', now });
      db.prepare("UPDATE team_executions SET state='completed' WHERE id=?").run(predecessor);
      db.prepare(
        'UPDATE team_mission_steps SET checkpoint_json=?,checkpoint_digest=? WHERE execution_id=?',
      ).run(checkpoint, createHash('sha256').update(checkpoint).digest('hex'), predecessor);
      expect(
        f.persistence.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'b',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'dependencies' });
      db.prepare(
        'UPDATE team_graph_mission_steps SET checkpoint_generation=generation, checkpoint_attempt_id=? WHERE execution_id=?',
      ).run(previousAttempt.id, predecessor);
      expect(
        f.persistence.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'b',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'dependencies' });
      f.persistence.releaseGraphResources({
        reservationId: previousLease.id,
        executionId: predecessor,
        generation: 1,
        confirmation: { kind: 'attempt-stopped', attemptId: previousAttempt.id },
        now,
      });
      const held = reserve(f, mission.id, 'b');
      db.prepare(
        'UPDATE team_graph_mission_steps SET generation=generation+1 WHERE execution_id=?',
      ).run(predecessor);
      expect(
        f.persistence.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'b',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'dependencies' });
      db.prepare("UPDATE team_executions SET state='running' WHERE id=?").run(held.executionId);
      db.close();
      const attempt = f.persistence.createTeamAttempt(held.executionId, now);
      expect(() =>
        f.persistence.bindGraphResourcesToAttempt({
          reservationId: held.id,
          executionId: held.executionId,
          generation: 1,
          attemptId: attempt.id,
        }),
      ).toThrow('admission changed');
      f.persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'canceled',
        now,
        terminalReason: 'preflight_canceled',
      });
      f.persistence.transitionTeamExecution({
        executionId: held.executionId,
        to: 'waiting_resume',
        now,
      });
      f.persistence.releaseGraphResources({
        reservationId: held.id,
        executionId: held.executionId,
        generation: 1,
        confirmation: { kind: 'not-dispatched' },
        now,
      });
      f.persistence.close();
    });
    it('arbitrates resources across Teams atomically and keeps dependency waiters unreserved', () => {
      const first = fixture();
      const second = fixture(first);
      const a = resourceMission(first);
      const b = resourceMission(second);
      const held = reserve(first, a.id);
      expect(held.resources.map((resource) => resource.scope).sort()).toEqual([
        'machine',
        'worker',
      ]);
      expect(
        first.persistence.acquireGraphResources({
          missionId: b.id,
          stepKey: 'a',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'resources' });
      expect(first.persistence.listGraphResourceReservations(b.id)).toEqual([]);
      expect(
        first.persistence.acquireGraphResources({
          missionId: a.id,
          stepKey: 'b',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'dependencies', blockedKeys: ['a'] });
      expect(first.persistence.listGraphResourceReservations(a.id)).toHaveLength(1);
      const release = {
        reservationId: held.id,
        executionId: held.executionId,
        generation: held.generation,
        confirmation: { kind: 'not-dispatched' as const },
        now,
      };
      expect(first.persistence.releaseGraphResources(release)).toBe(true);
      const next = reserve(second, b.id);
      expect(next.id).not.toBe(held.id);
      expect(first.persistence.releaseGraphResources(release)).toBe(false);
      expect(second.persistence.listGraphResourceReservations(b.id)[0]?.state).toBe('reserved');
      second.persistence.releaseGraphResources({
        ...release,
        reservationId: next.id,
        executionId: next.executionId,
      });
      first.persistence.close();
    });

    it('quarantines reservations on restart and prevents deletion until explicit release', () => {
      const f = fixture();
      const mission = resourceMission(f);
      const held = reserve(f, mission.id);
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      restored.recoverInterruptedTeamExecutions('2099-01-01T00:00:00.000Z');
      expect(restored.listGraphResourceReservations(mission.id)[0]?.state).toBe('quarantined');
      expect(
        restored.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'a',
          expectedGeneration: 1,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'owner-active' });
      const db = new Database(f.path);
      db.pragma('foreign_keys = ON');
      expect(() =>
        db.prepare('DELETE FROM team_graph_resource_reservations WHERE id=?').run(held.id),
      ).toThrow('not released');
      expect(() =>
        db.prepare('DELETE FROM team_graph_resource_leases WHERE reservation_id=?').run(held.id),
      ).toThrow('not released');
      expect(() => db.prepare('DELETE FROM team_missions WHERE id=?').run(mission.id)).toThrow(
        'not released',
      );
      db.close();
      expect(() =>
        restored.releaseGraphResources({
          reservationId: held.id,
          executionId: held.executionId,
          generation: 2,
          confirmation: { kind: 'not-dispatched' },
          now,
        }),
      ).toThrow('owner mismatch');
      restored.releaseGraphResources({
        reservationId: held.id,
        executionId: held.executionId,
        generation: 1,
        confirmation: { kind: 'not-dispatched' },
        now,
      });
      expect(restored.listGraphResourceReservations(mission.id)[0]?.state).toBe('released');
      restored.close();
    });

    it('binds an Attempt before dispatch and refuses premature or stale generation releases', () => {
      const f = fixture();
      const mission = resourceMission(f);
      const held = reserve(f, mission.id);
      const db = new Database(f.path);
      db.prepare("UPDATE team_executions SET state='running' WHERE id=?").run(held.executionId);
      db.prepare("UPDATE team_missions SET state='running' WHERE id=?").run(mission.id);
      db.close();
      const attempt = f.persistence.createTeamAttempt(held.executionId, now);
      f.persistence.bindGraphResourcesToAttempt({
        reservationId: held.id,
        executionId: held.executionId,
        generation: 1,
        attemptId: attempt.id,
      });
      expect(() =>
        f.persistence.releaseGraphResources({
          reservationId: held.id,
          executionId: held.executionId,
          generation: 1,
          confirmation: { kind: 'not-dispatched' },
          now,
        }),
      ).toThrow('acknowledgement');
      expect(() =>
        f.persistence.releaseGraphResources({
          reservationId: held.id,
          executionId: held.executionId,
          generation: 1,
          confirmation: { kind: 'attempt-stopped', attemptId: attempt.id },
          now,
        }),
      ).toThrow('not stopped');
      f.persistence.transitionTeamAttempt({ attemptId: attempt.id, to: 'running', now });
      f.persistence.recoverInterruptedTeamExecutions(now);
      const update = new Database(f.path);
      update
        .prepare('UPDATE team_graph_mission_steps SET generation=2 WHERE execution_id=?')
        .run(held.executionId);
      update.close();
      expect(
        f.persistence.acquireGraphResources({
          missionId: mission.id,
          stepKey: 'a',
          expectedGeneration: 2,
          now,
        }),
      ).toMatchObject({ acquired: false, reason: 'owner-active' });
      const release = {
        reservationId: held.id,
        executionId: held.executionId,
        generation: 1,
        confirmation: { kind: 'attempt-stopped' as const, attemptId: attempt.id },
        now,
      };
      f.persistence.releaseGraphResources(release);
      const next = reserve(f, mission.id, 'a', 2);
      expect(next.id).not.toBe(held.id);
      expect(f.persistence.releaseGraphResources(release)).toBe(false);
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      f.persistence.releaseGraphResources({
        reservationId: next.id,
        executionId: next.executionId,
        generation: 2,
        confirmation: { kind: 'not-dispatched' },
        now,
      });
      f.persistence.close();
    });
    it('retains interrupted graph work for graph-aware recovery instead of automatically queueing it', () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const executionId = mission.steps[0]!.executionId;
      // Seed an interrupted graph run; the graph-aware dispatcher is a later implementation slice.
      const db = new Database(f.path);
      db.prepare("UPDATE team_missions SET state='running' WHERE id=?").run(mission.id);
      db.prepare(
        "UPDATE team_executions SET state='running', queued_at=?, started_at=? WHERE id=?",
      ).run(now, now, executionId);
      db.close();
      const attempt = f.persistence.createTeamAttempt(executionId, now);
      f.persistence.transitionTeamAttempt({ attemptId: attempt.id, to: 'running', now });
      f.persistence.transitionTeamTask(
        f.persistence.getTeamExecutionDispatch(executionId).teamTaskId,
        'running',
        now,
      );
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      restored.recoverInterruptedTeamExecutions('2026-09-11T00:01:00.000Z');
      expect(restored.getTeamExecution(executionId).state).toBe('waiting_resume');
      expect(restored.getTeamMission(mission.id).state).toBe('waiting_resume');
      expect(restored.getTeamAttempt(attempt.id).state).toBe('interrupted');
      expect(restored.getGraphTeamMission(mission.id)?.steps[0]?.generation).toBe(1);
      expect(restored.checkTeamIntegrity().inconsistencies).toEqual([]);
      restored.close();
    });
    it('atomically commits the agreement and existing Mission/Execution rows, then restores them', () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      expect(mission).toMatchObject({ mode: 'graph', state: 'queued' });
      expect(
        f.persistence.listTeamExecutions(f.team.id).map((execution) => execution.state),
      ).toEqual(['assigned', 'assigned']);
      const graph = f.persistence.getGraphTeamMission(mission.id)!;
      expect(graph).toMatchObject({
        graphId: f.document.id,
        semanticDigest: f.document.semanticDigest,
        contextDigest: f.input.contextDigest,
        consentId: f.input.consentId,
        plan: f.plan,
      });
      expect(graph.steps.map((step) => [step.key, step.generation])).toEqual([
        ['a', 1],
        ['b', 1],
      ]);
      expect(f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
      expect(() => f.persistence.createGraphTeamMission(f.input)).toThrow();
      expect(f.persistence.listTeamMissions(f.team.id)).toHaveLength(1);
      f.persistence.close();
      const restored = new SqlitePersistenceClient(f.path);
      expect(restored.getGraphTeamMission(mission.id)).toEqual(graph);
      expect(restored.getTeamMission(mission.id).mode).toBe('graph');
      expect(restored.checkTeamIntegrity().inconsistencies).toEqual([]);
      restored.close();
    });
    it('accepts presentation-only revisions but rejects semantic/context mismatches without partial rows', () => {
      const f = fixture();
      const redraw = nextGraphDocument(
        f.task.id,
        { ...f.diagram, meta: { title: 'Review', animation: 'none' } },
        f.document,
        [],
        [],
        f.plan,
      );
      expect(redraw.semanticRevision).toBe(f.document.semanticRevision);
      f.persistence.saveGraphDocument(redraw, 1);
      for (const input of [
        { ...f.input, semanticDigest: 'f'.repeat(64) },
        { ...f.input, contextDigest: 'f'.repeat(64) },
        { ...f.input, policyEpoch: f.input.policyEpoch + 1 },
        { ...f.input, graphId: randomUUID() },
      ]) {
        expect(() => f.persistence.createGraphTeamMission(input)).toThrow();
        expect(f.persistence.listTeamMissions(f.team.id)).toEqual([]);
        expect(f.persistence.listTeamExecutions(f.team.id)).toEqual([]);
      }
      expect(f.persistence.createGraphTeamMission(f.input).mode).toBe('graph');
      f.persistence.close();
    });
    it('refuses legacy queue, resume, instruction and checkpoint paths for graph records', () => {
      const f = fixture();
      const mission = f.persistence.createGraphTeamMission(f.input);
      const executionId = mission.steps[0]!.executionId;
      expect(() =>
        f.persistence.transitionTeamExecution({
          executionId,
          to: 'queued',
          queueReason: 'global_concurrency',
          now,
        }),
      ).toThrow('graph admission');
      expect(() => f.persistence.transitionTeamMission(mission.id, 'running', now)).toThrow(
        'graph admission',
      );
      expect(() =>
        f.persistence.prepareTeamMissionResume({ missionId: mission.id, executionId, now }),
      ).toThrow('graph admission');
      expect(() =>
        f.persistence.reviseQueuedTeamExecution({
          executionId,
          createdByAgentId: f.team.leaderAgentId,
          instruction: 'Bypass',
          now,
        }),
      ).toThrow('agreement');
      expect(() =>
        f.persistence.recordTeamMissionCheckpoint({
          executionId,
          checkpoint: {
            summary: 'Fake',
            changedFiles: [],
            gitHead: null,
            workspaceDigest: null,
            recordedAt: now,
          },
          now,
        }),
      ).toThrow('graph admission');
      expect(f.persistence.getTeamExecution(executionId).state).toBe('assigned');
      f.persistence.close();
    });
    it('rolls back the whole graph commit if a graph-step insert fails after base rows are written', () => {
      const f = fixture();
      const db = new Database(f.path);
      db.exec(
        "CREATE TRIGGER reject_graph_step BEFORE INSERT ON team_graph_mission_steps WHEN NEW.step_key = 'b' BEGIN SELECT RAISE(ABORT, 'test graph failure'); END;",
      );
      db.close();
      expect(() => f.persistence.createGraphTeamMission(f.input)).toThrow('test graph failure');
      expect(f.persistence.listTeamMissions(f.team.id)).toEqual([]);
      expect(f.persistence.listTeamExecutions(f.team.id)).toEqual([]);
      expect(f.persistence.getTeamSnapshot(f.team.id).messages).toEqual([]);
      f.persistence.close();
      const check = new Database(f.path);
      expect(check.prepare('SELECT COUNT(*) AS count FROM team_graph_missions').get()).toEqual({
        count: 0,
      });
      check.close();
    });
    it('migrates v85 sequential Missions without changing their mode, and detects corrupt graph bindings', () => {
      const f = fixture();
      const legacy = f.persistence.createTeamMission({
        teamId: f.team.id,
        createdByAgentId: f.team.leaderAgentId,
        objective: f.plan.objective,
        doneCriteria: f.plan.doneCriteria,
        steps: f.plan.steps,
        now,
      });
      f.persistence.close();
      const old = new Database(f.path);
      old.exec(
        'DROP TABLE team_graph_pending_updates; DROP TABLE team_graph_agreement_history; DROP TABLE team_graph_resource_leases; DROP TABLE team_graph_resource_reservations; DROP TABLE team_graph_mission_steps; DROP TABLE team_graph_missions; ALTER TABLE team_missions DROP COLUMN mode; DELETE FROM schema_migrations WHERE version IN (86, 87, 88, 91);',
      );
      old.close();
      const migrated = new SqlitePersistenceClient(f.path);
      expect(migrated.getTeamMission(legacy.id).mode).toBe('sequential');
      expect(migrated.getGraphTeamMission(legacy.id)).toBeNull();
      const added = fixture({ persistence: migrated, path: f.path });
      const graphMission = migrated.createGraphTeamMission(added.input);
      expect(reserve(added, graphMission.id).writeFootprints).toEqual([]);
      expect(migrated.checkTeamIntegrity().inconsistencies).toEqual([]);
      migrated.close();
      const clean = fixture();
      const mission = clean.persistence.createGraphTeamMission(clean.input);
      clean.persistence.close();
      const corrupt = new Database(clean.path);
      corrupt
        .prepare(
          "UPDATE team_graph_mission_steps SET node_id='missing' WHERE mission_id=? AND step_key='a'",
        )
        .run(mission.id);
      corrupt.close();
      const reopened = new SqlitePersistenceClient(clean.path);
      expect(() => reopened.getGraphTeamMission(mission.id)).toThrow('binding mismatch');
      expect(() =>
        reopened.cancelQueuedTeamExecution(mission.steps[0]!.executionId, now),
      ).not.toThrow();
      expect(reopened.checkTeamIntegrity().inconsistencies).toContain(
        `graph_mission_snapshot:${mission.id}`,
      );
      reopened.close();
    });
  });
else
  describe('graph Mission persistence Electron ABI bridge', () => {
    it(
      'runs the graph Mission transaction suite with Electron',
      async () => {
        await promisify(execFile)(
          electronTestExecutablePath(),
          [
            join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
            'run',
            'src/main/graph-mission-persistence.test.ts',
          ],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
            timeout: graphBridgeTimeout,
            maxBuffer: 10 * 1024 * 1024,
          },
        );
      },
      graphBridgeTimeout + 5_000,
    );
  });
