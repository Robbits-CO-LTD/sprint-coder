import { spawnSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphMissionPlan } from '@sprint-coder/contracts';
import { SqlitePersistenceClient } from './persistence';
import { nextGraphDocument } from './graph-document';
import { graphMissionContextFor, graphMissionContextDigest } from './graph-mission-review';
import { electronTestExecutablePath } from './electron-test-runtime';
import { workspaceMutationBinding } from './path-guard';
import { TeamExecutionScheduler } from './team-execution-scheduler';
import { WorkerWorktreeManager } from './worker-worktree';
import { TeamCoordinator, DeterministicTeamWorkerRuntime } from './team-coordinator';

// Issue #661. Real SQLite needs the Electron ABI (better-sqlite3 is rebuilt for Electron), so
// under plain vitest this file only runs the bridge that re-runs it inside Electron. It is a
// separate file, with its own bridge, so these cases do not spend the budget of the much larger
// graph-mission-persistence bridge.
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
const gitCheckpointTimeout = process.platform === 'win32' ? 60_000 : 30_000;
const gitScenarioTimeout = process.platform === 'win32' ? 120_000 : 60_000;
const wholeRootBridgeTimeout = process.platform === 'win32' ? 300_000 : 180_000;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});
const now = '2026-09-11T00:00:00.000Z';

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

if (runsWithElectronAbi)
  describe('graph Mission whole-root write claims', () => {
    // #661: a workspace-write step that omits its write claims means "every agreed root". Review,
    // dispatch preparation and the persisted inventory must agree on that, so the same step has to
    // start, resume, conflict and be refused through the real Coordinator and Scheduler.
    describe('workspace-write steps with omitted write claims (#661)', () => {
      async function wholeRootGraph(rootCount: 1 | 2, keys = ['a', 'b'], writers = [0]) {
        const base = fixture();
        const bindings: Awaited<ReturnType<typeof workspaceMutationBinding>>[] = [];
        for (const name of ['primary', 'secondary'].slice(0, rootCount)) {
          const root = join(dirname(base.path), name);
          mkdirSync(root, { recursive: true });
          writeFileSync(join(root, 'file.ts'), 'base\n');
          for (const args of [
            ['init', '-q', root],
            ['-C', root, 'add', '.'],
            [
              '-C',
              root,
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
          bindings.push(await workspaceMutationBinding(root));
        }
        const folderIds = [randomUUID(), randomUUID(), randomUUID()];
        const folderOf = (binding: (typeof bindings)[number], i: number) => ({
          id: folderIds[i]!,
          path: binding.canonicalPath,
          canonicalPath: binding.canonicalPath,
          label: `root-${i}`,
          role: i === 0 ? ('primary' as const) : ('secondary' as const),
          workspaceKey: binding.workspaceKey,
          rootIdentityDigest: binding.rootIdentityDigest,
        });
        const project = base.persistence.createProject({
          name: 'Omitted write claims',
          folders: bindings.map(folderOf),
        });
        const f = fixture(
          { persistence: base.persistence, path: base.path },
          true,
          keys,
          project.id,
        );
        const context = graphMissionContextFor(f.persistence, f.task.id);
        const plan = structuredClone(f.plan);
        // Every step is independent; the caller picks which ones write.
        for (const step of plan.steps) step.dependsOn = [];
        for (const index of writers) {
          plan.steps[index]!.access = 'workspace-write';
          expect(plan.steps[index]!.writeClaims).toEqual([]);
        }
        const document = nextGraphDocument(f.task.id, f.diagram, f.document, [], [], plan);
        f.persistence.saveGraphDocument(document, 1);
        const manager = new WorkerWorktreeManager({
          worktreesRoot: join(dirname(f.path), 'worktrees'),
        });
        const start = (coordinator: TeamCoordinator) =>
          coordinator.startGraphMission(f.task.id, async () => ({
            ...f.input,
            renderRevision: document.renderRevision,
            semanticRevision: document.semanticRevision,
            semanticDigest: document.semanticDigest,
            workspaceDigest: context.workspace.digest,
            policyEpoch: context.policyEpoch,
            contextDigest: graphMissionContextDigest(
              context,
              new Set(plan.steps.map(({ workerId }) => workerId)),
            ),
          }));
        const coordinatorFor = (
          runtime: DeterministicTeamWorkerRuntime,
          concurrency = 1,
          verifyWorkspace?: (taskId: string) => Promise<void>,
        ) =>
          new TeamCoordinator(
            f.persistence,
            runtime,
            undefined,
            undefined,
            undefined,
            new TeamExecutionScheduler(concurrency),
            undefined,
            undefined,
            manager,
            verifyWorkspace,
          );
        const finish = async (coordinator: TeamCoordinator) => {
          await vi.waitFor(
            () => expect(coordinator['executionScheduler'].snapshot().activeCount).toBe(0),
            { timeout: gitCheckpointTimeout },
          );
          f.persistence.close();
        };
        return {
          f,
          project,
          bindings,
          folderOf,
          context,
          plan,
          document,
          start,
          coordinatorFor,
          finish,
        };
      }
      /**
       * Parks step `a` in `waiting_resume` before any Attempt or isolation exists: the workspace
       * check made once the scheduled step is admitted (the third: eligibility and start come first)
       * fails until the caller unblocks it.
       */
      const parkedFirstStep = async (g: Awaited<ReturnType<typeof wholeRootGraph>>) => {
        const runtime = new DeterministicTeamWorkerRuntime();
        const execute = vi.spyOn(runtime, 'execute');
        let checks = 0;
        let blocked = true;
        const coordinator = g.coordinatorFor(runtime, 1, async () => {
          if (++checks >= 3 && blocked) throw new Error('Controlled workspace check failure');
        });
        const mission = await g.start(coordinator);
        const executionId = mission.steps[0]!.executionId;
        await vi.waitFor(
          () => expect(g.f.persistence.getTeamExecution(executionId).state).toBe('waiting_resume'),
          { timeout: gitCheckpointTimeout },
        );
        await vi.waitFor(() =>
          expect(coordinator['executionScheduler'].snapshot().activeCount).toBe(0),
        );
        expect(execute).not.toHaveBeenCalled();
        return {
          coordinator,
          mission,
          executionId,
          execute,
          unblock: () => {
            blocked = false;
          },
        };
      };

      it.each([1, 2] as const)(
        'starts the step and holds one footprint per agreed root (%i root)',
        async (rootCount) => {
          const g = await wholeRootGraph(rootCount);
          const runtime = new DeterministicTeamWorkerRuntime();
          const execute = vi.spyOn(runtime, 'execute');
          const coordinator = g.coordinatorFor(runtime);
          const mission = await g.start(coordinator);
          const executionId = mission.steps[0]!.executionId;
          await vi.waitFor(
            () => expect(g.f.persistence.getTeamMission(mission.id).state).toBe('completed'),
            { timeout: gitCheckpointTimeout },
          );
          expect(execute).toHaveBeenCalled();
          expect(g.f.persistence.listTeamAttempts(executionId).map(({ state }) => state)).toEqual([
            'completed',
          ]);
          const held = g.f.persistence
            .listGraphResourceReservations(mission.id)
            .find((owner) => owner.executionId === executionId)!;
          expect(held.writeFootprints.map(({ rootId }) => rootId).sort()).toEqual(
            g.context.workspace.roots.map(({ rootId }) => rootId).sort(),
          );
          expect(g.f.persistence.checkTeamIntegrity().inconsistencies).toEqual([]);
          await g.finish(coordinator);
        },
        gitScenarioTimeout,
      );

      it.each([1, 2] as const)(
        'resumes only the interrupted step from waiting_resume (%i root)',
        async (rootCount) => {
          const g = await wholeRootGraph(rootCount);
          const { coordinator, mission, executionId, execute, unblock } = await parkedFirstStep(g);
          unblock();
          await coordinator.resumeGraphStep(g.f.task.id, mission.id, 'a');
          await vi.waitFor(
            () =>
              expect(
                g.f.persistence.listTeamAttempts(executionId).map(({ state }) => state),
              ).toEqual(['completed']),
            { timeout: gitCheckpointTimeout },
          );
          expect(execute).toHaveBeenCalledTimes(1);
          expect(
            g.f.persistence
              .listGraphResourceReservations(mission.id)
              .filter((owner) => owner.executionId === executionId)
              .at(-1)!.writeFootprints,
          ).toHaveLength(rootCount);
          await g.finish(coordinator);
        },
        gitScenarioTimeout,
      );

      it(
        'makes another step wait for the implicit whole-root claim while an unrelated read-only step runs',
        async () => {
          const g = await wholeRootGraph(2, ['a', 'b', 'c'], [0, 1]);
          const runtime = new DeterministicTeamWorkerRuntime();
          const original = runtime.execute.bind(runtime);
          const starts: string[] = [];
          let releaseA: () => void = () => undefined;
          vi.spyOn(runtime, 'execute').mockImplementation(async (input) => {
            starts.push(input.worker.role);
            if (input.worker.role === 'a')
              await new Promise<void>((resolve) => {
                releaseA = resolve;
              });
            return original(input);
          });
          const coordinator = g.coordinatorFor(runtime, 3);
          const mission = await g.start(coordinator);
          const bExecution = mission.steps[1]!.executionId;
          try {
            // `a` holds every root and `c` shares none of it, so both run while `b` is parked.
            await vi.waitFor(() => expect(starts.slice().sort()).toEqual(['a', 'c']), {
              timeout: gitCheckpointTimeout,
            });
            await vi.waitFor(
              () => expect(coordinator['graphWaitReasons'].get(bExecution)).toBeDefined(),
              { timeout: gitCheckpointTimeout },
            );
            expect(starts).toContain('a');
            expect(starts).not.toContain('b');
            expect(
              g.f.persistence
                .listGraphResourceReservations(mission.id)
                .filter((owner) => owner.executionId === bExecution && owner.state === 'active'),
            ).toEqual([]);
          } finally {
            releaseA();
          }
          await vi.waitFor(() => expect(starts).toContain('b'), { timeout: gitCheckpointTimeout });
          await vi.waitFor(
            () => expect(g.f.persistence.getTeamMission(mission.id).state).toBe('completed'),
            { timeout: gitCheckpointTimeout },
          );
          expect(starts.indexOf('b')).toBeGreaterThan(starts.indexOf('a'));
          await g.finish(coordinator);
        },
        gitScenarioTimeout,
      );

      it.each([
        ['removed', 'Graph step authority changed'],
        ['added', 'Graph step authority changed'],
        ['replaced', 'Workspace root identity changed'],
      ] as const)(
        'refuses to resume once an agreed root was %s after the agreement',
        async (change, message) => {
          const g = await wholeRootGraph(2);
          const { coordinator, mission, executionId, execute, unblock } = await parkedFirstStep(g);
          unblock();
          // The Project folder API refuses edits while work is active, so change the roots the
          // way an external edit would: directly in the stored rows or on disk.
          const db = new Database(g.f.path);
          try {
            if (change === 'removed')
              db.prepare(
                "DELETE FROM project_workspace_roots WHERE project_id=? AND role='secondary'",
              ).run(g.project.id);
            if (change === 'added') {
              const extra = join(dirname(g.f.path), 'third');
              mkdirSync(extra);
              const binding = await workspaceMutationBinding(extra);
              db.prepare(
                `INSERT INTO project_workspace_roots(id, project_id, canonical_path, label, role, ordinal,
                   workspace_key, root_identity_digest, created_at, updated_at)
                 VALUES (?, ?, ?, 'third', 'secondary', 2, ?, ?, ?, ?)`,
              ).run(
                randomUUID(),
                g.project.id,
                binding.canonicalPath,
                binding.workspaceKey,
                binding.rootIdentityDigest,
                now,
                now,
              );
            }
          } finally {
            db.close();
          }
          if (change === 'replaced') {
            const secondary = g.bindings[1]!.canonicalPath;
            await rm(secondary, { recursive: true, force: true, maxRetries: 3 });
            mkdirSync(secondary);
          }
          await expect(coordinator.resumeGraphStep(g.f.task.id, mission.id, 'a')).rejects.toThrow(
            message,
          );
          expect(execute).not.toHaveBeenCalled();
          expect(g.f.persistence.getTeamExecution(executionId).state).toBe('waiting_resume');
          expect(g.f.persistence.listTeamAttempts(executionId)).toEqual([]);
          await g.finish(coordinator);
        },
        gitScenarioTimeout,
      );
    });
  });
else
  describe('graph Mission whole-root write claims Electron ABI bridge', () => {
    it(
      'runs the whole-root write claim suite with the bundled Electron Node ABI',
      async () => {
        try {
          await promisify(execFile)(
            electronTestExecutablePath(),
            [
              join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
              'run',
              'src/main/graph-mission-whole-root.test.ts',
            ],
            {
              cwd: process.cwd(),
              encoding: 'utf8',
              env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                SPRINT_CODER_ELECTRON_DB_TEST: '1',
              },
              timeout: wholeRootBridgeTimeout,
              maxBuffer: 10 * 1024 * 1024,
            },
          );
        } catch (error) {
          const { stdout, stderr } = error as { stdout?: string; stderr?: string };
          throw new Error(`whole-root bridge failed\n${stdout ?? ''}\n${stderr ?? ''}`, {
            cause: error,
          });
        }
      },
      wholeRootBridgeTimeout + 5_000,
    );
  });
