import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphMissionPlan } from '@sprint-coder/contracts';
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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const now = '2026-09-11T00:00:00.000Z';
function fixture(
  existing?: { persistence: SqlitePersistenceClient; path: string },
  writeCapable = false,
  keys: string[] = ['a', 'b'],
) {
  const root = existing ? null : mkdtempSync(join(tmpdir(), 'sc-graph-mission-db-'));
  if (root) roots.push(root);
  const path = existing?.path ?? join(root!, 'state.sqlite3');
  const persistence = existing?.persistence ?? new SqlitePersistenceClient(path);
  persistence.setRuntime('codex');
  persistence.setModel('gpt-5.6-terra');
  const task = persistence.createTask('Graph Mission');
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

if (process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1')
  describe('durable graph Mission definitions', () => {
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
        'DROP TABLE team_graph_resource_leases; DROP TABLE team_graph_resource_reservations; DROP TABLE team_graph_mission_steps; DROP TABLE team_graph_missions; ALTER TABLE team_missions DROP COLUMN mode; DELETE FROM schema_migrations WHERE version IN (86, 87, 88);',
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
    it('runs the graph Mission transaction suite with Electron', async () => {
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
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    }, 65_000);
  });
