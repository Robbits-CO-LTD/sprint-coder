import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphMissionPlan } from '@sprint-coder/contracts';
import { SqlitePersistenceClient } from './persistence';
import { nextGraphDocument } from './graph-document';
import { graphMissionContextFor, graphMissionContextDigest } from './graph-mission-review';
import { electronTestExecutablePath } from './electron-test-runtime';
import { workspaceMutationBinding } from './path-guard';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const now = '2026-09-11T00:00:00.000Z';
function fixture(
  existing?: { persistence: SqlitePersistenceClient; path: string },
  writeCapable = false,
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
  const workers = ['a', 'b'].map((role) => {
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
      key: ['a', 'b'][index]!,
      nodeId: ['a', 'b'][index]!,
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
    nodes: ['a', 'b'].map((id, col) => ({ id, col, lane: 'work', label: id, type: 'backend' })),
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
function reserve(f: ReturnType<typeof fixture>, missionId: string, stepKey = 'a', generation = 1) {
  const result = f.persistence.acquireGraphResources({
    missionId,
    stepKey,
    expectedGeneration: generation,
    now,
  });
  expect(result.acquired).toBe(true);
  if (!result.acquired) throw new Error('Expected resource acquisition');
  return result.reservation;
}

if (process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1')
  describe('durable graph Mission definitions', () => {
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
      const held = reserve(f, mission.id);
      const db = new Database(f.path);
      db.prepare("UPDATE team_executions SET state='running' WHERE id=?").run(held.executionId);
      const attempt = f.persistence.createTeamAttempt(held.executionId, now);
      f.persistence.bindGraphResourcesToAttempt({
        reservationId: held.id,
        executionId: held.executionId,
        generation: 1,
        attemptId: attempt.id,
      });
      f.persistence.transitionTeamAttempt({ attemptId: attempt.id, to: 'running', now });
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
      f.persistence.releaseGraphResources({
        reservationId: held.id,
        executionId: held.executionId,
        generation: 1,
        confirmation: { kind: 'attempt-stopped', attemptId: attempt.id },
        now,
      });
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
        'DROP TABLE team_graph_resource_leases; DROP TABLE team_graph_resource_reservations; DROP TABLE team_graph_mission_steps; DROP TABLE team_graph_missions; ALTER TABLE team_missions DROP COLUMN mode; DELETE FROM schema_migrations WHERE version IN (86, 87);',
      );
      old.close();
      const migrated = new SqlitePersistenceClient(f.path);
      expect(migrated.getTeamMission(legacy.id).mode).toBe('sequential');
      expect(migrated.getGraphTeamMission(legacy.id)).toBeNull();
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
    it('runs the graph Mission transaction suite with Electron', () => {
      const result = spawnSync(
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
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 65_000);
  });
