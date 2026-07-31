import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';
import { SqlitePersistenceClient } from './persistence';
import { TeamCoordinator } from './team-coordinator';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
const emptyCeiling = {
  entries: [],
  maxWorkerDepth: 0,
  maxConcurrentWorkers: 0,
} as const;

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createPersistence(): { persistence: SqlitePersistenceClient; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-execution-'));
  cleanup.push(directory);
  const path = join(directory, 'test.sqlite3');
  return { persistence: new SqlitePersistenceClient(path), path };
}

function createExecutionFixture(persistence: SqlitePersistenceClient) {
  persistence.setRuntime('codex');
  persistence.setModel('gpt-5.6-terra');
  const task = persistence.createTask();
  const team = persistence.promoteTaskToTeam(task.id);
  const leader = persistence.getTaskLeader(task.id);
  persistence.transitionTeamState(team.id, 'forming');
  const worker = persistence.registerTeamWorker({
    teamId: team.id,
    role: 'implementer',
    objective: 'Implement the bounded execution.',
    parentCapabilityCeiling: emptyCeiling,
    contextInheritancePolicy: 'summary',
  });
  const execution = persistence.createTeamExecution({
    teamId: team.id,
    assigneeAgentId: worker.id,
    createdByAgentId: leader.id,
    instruction: 'Implement the bounded execution.',
    now: '2026-07-28T11:00:00.000Z',
  });
  return { team, leader, worker, execution };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

if (runsWithElectronAbi)
  describe('Team execution persistence', () => {
    it('persists queue order and queued instruction revisions across restart', () => {
      const { persistence, path } = createPersistence();
      const { team, leader, worker, execution } = createExecutionFixture(persistence);
      const second = persistence.createTeamExecution({
        teamId: team.id,
        assigneeAgentId: worker.id,
        createdByAgentId: leader.id,
        instruction: 'Review the first execution.',
        now: '2026-07-28T11:02:00.000Z',
      });
      const secondQueued = persistence.transitionTeamExecution({
        executionId: second.id,
        to: 'queued',
        now: '2026-07-28T11:03:00.000Z',
        queueReason: 'budget',
      });
      const first = persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'queued',
        now: '2026-07-28T11:03:01.000Z',
        queueReason: 'global_concurrency',
      });
      expect([secondQueued.queueOrdinal, first.queueOrdinal]).toEqual([1, 2]);

      const steered = persistence.reviseQueuedTeamExecution({
        executionId: execution.id,
        createdByAgentId: leader.id,
        instruction: 'Implement the bounded execution and add a focused test.',
        now: '2026-07-28T11:04:00.000Z',
      });
      expect(steered.instruction).toMatchObject({
        revision: 2,
        content: 'Implement the bounded execution and add a focused test.',
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(
        reopened.listQueuedTeamExecutions(team.id).map((item) => ({
          id: item.id,
          queueOrdinal: item.queueOrdinal,
          queueReason: item.queueReason,
          instructionRevision: item.instruction.revision,
        })),
      ).toEqual([
        {
          id: second.id,
          queueOrdinal: 1,
          queueReason: 'budget',
          instructionRevision: 1,
        },
        {
          id: execution.id,
          queueOrdinal: 2,
          queueReason: 'global_concurrency',
          instructionRevision: 2,
        },
      ]);
      const firstPage = reopened.listTeamV2Activity(team.id, 0, 3);
      const secondPage = reopened.listTeamV2Activity(team.id, firstPage.at(-1)?.seq ?? 0, 10);
      expect([...firstPage, ...secondPage].map(({ seq, type }) => ({ seq, type }))).toEqual([
        { seq: 1, type: 'worker_hired' },
        { seq: 2, type: 'task_assigned' },
        { seq: 3, type: 'task_assigned' },
        { seq: 4, type: 'execution_queued' },
        { seq: 5, type: 'execution_queued' },
        { seq: 6, type: 'steered' },
      ]);
      expect([...firstPage, ...secondPage].at(-1)).toMatchObject({
        executionId: execution.id,
        actorAgentId: leader.id,
        subjectAgentId: worker.id,
      });
      expect(reopened.listLatestTeamV2Activity(team.id, 2)).toMatchObject([
        { seq: 5, type: 'execution_queued' },
        { seq: 6, type: 'steered' },
      ]);
      reopened.close();
    });

    it('keeps a 429 wait on the same attempt and creates a new attempt only after steer', () => {
      const { persistence } = createPersistence();
      const { leader, execution } = createExecutionFixture(persistence);
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'queued',
        now: '2026-07-28T11:01:00.000Z',
        queueReason: 'global_concurrency',
      });
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'running',
        now: '2026-07-28T11:02:00.000Z',
      });
      const first = persistence.createTeamAttempt(execution.id, '2026-07-28T11:02:00.000Z');
      persistence.transitionTeamAttempt({
        attemptId: first.id,
        to: 'running',
        now: '2026-07-28T11:02:01.000Z',
      });
      expect(
        persistence.recordTeamAttemptRateLimited(first.id, '2026-07-28T11:02:02.000Z'),
      ).toMatchObject({
        id: first.id,
        state: 'waiting_rate_limit',
        providerCallOrdinal: 1,
      });
      persistence.transitionTeamAttempt({
        attemptId: first.id,
        to: 'running',
        now: '2026-07-28T11:02:03.000Z',
      });
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'running',
        now: '2026-07-28T11:02:03.000Z',
      });
      expect(persistence.listTeamAttempts(execution.id)).toHaveLength(1);

      persistence.transitionTeamAttempt({
        attemptId: first.id,
        to: 'interrupted',
        now: '2026-07-28T11:03:00.000Z',
        terminalReason: 'interrupted_by_steer',
      });
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'queued',
        now: '2026-07-28T11:03:00.000Z',
        queueReason: 'global_concurrency',
      });
      persistence.reviseQueuedTeamExecution({
        executionId: execution.id,
        createdByAgentId: leader.id,
        instruction: 'Continue with the corrected scope.',
        now: '2026-07-28T11:03:01.000Z',
      });
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'running',
        now: '2026-07-28T11:03:02.000Z',
      });
      const second = persistence.createTeamAttempt(execution.id, '2026-07-28T11:03:02.000Z');
      expect(second).toMatchObject({ ordinal: 2, instructionRevision: 2 });
      persistence.close();
    });

    it('interrupts running attempts and requeues their execution during restart recovery', () => {
      const { persistence, path } = createPersistence();
      const { execution } = createExecutionFixture(persistence);
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'queued',
        now: '2026-07-28T11:01:00.000Z',
        queueReason: 'global_concurrency',
      });
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'running',
        now: '2026-07-28T11:02:00.000Z',
      });
      const attempt = persistence.createTeamAttempt(execution.id, '2026-07-28T11:02:00.000Z');
      persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'running',
        now: '2026-07-28T11:02:01.000Z',
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      reopened.initializeMutationRecovery('team-execution-restart', '2026-07-28T11:05:00.000Z');
      expect(reopened.getTeamAttempt(attempt.id)).toMatchObject({
        state: 'interrupted',
        terminalReason: 'app_restart',
      });
      expect(reopened.getTeamExecution(execution.id)).toMatchObject({
        state: 'queued',
        queueOrdinal: 1,
        queueReason: 'recovery',
      });
      expect(reopened.recoverInterruptedTeamExecutions('2026-07-28T11:06:00.000Z')).toBe(0);
      reopened.close();
    });

    it('does not automatically restart the same read-only execution twice', () => {
      const { persistence, path } = createPersistence();
      const { execution } = createExecutionFixture(persistence);
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'queued',
        now: '2026-07-28T11:01:00.000Z',
        queueReason: 'recovery',
      });
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'running',
        now: '2026-07-28T11:02:00.000Z',
      });
      const attempt = persistence.createTeamAttempt(
        execution.id,
        '2026-07-28T11:02:00.000Z',
        'app_restart',
      );
      persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'running',
        now: '2026-07-28T11:02:01.000Z',
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      reopened.initializeMutationRecovery('second-restart', '2026-07-28T11:05:00.000Z');
      expect(reopened.getTeamAttempt(attempt.id)).toMatchObject({
        state: 'interrupted',
        terminalReason: 'app_restart',
      });
      expect(reopened.getTeamExecution(execution.id).state).toBe('failed');
      reopened.close();
    });

    it('atomically checkpoints a Mission step and skips it after restart', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask('Mission checkpoint recovery');
      const team = persistence.promoteTaskToTeam(task.id);
      persistence.transitionTeamState(team.id, 'forming');
      persistence.transitionTeamState(team.id, 'active');
      const leader = persistence.getTaskLeader(task.id);
      const worker = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'mission worker',
        objective: 'complete two steps',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'none',
      });
      persistence.transitionWorkerState(worker.id, 'spawning');
      persistence.transitionWorkerState(worker.id, 'ready');
      const mission = persistence.createTeamMission({
        teamId: team.id,
        createdByAgentId: leader.id,
        objective: 'two durable steps',
        doneCriteria: ['both complete'],
        steps: [
          {
            workerId: worker.id,
            objective: 'first',
            doneCriteria: ['first done'],
            access: 'read-only',
          },
          {
            workerId: worker.id,
            objective: 'second',
            doneCriteria: ['second done'],
            access: 'read-only',
          },
        ],
        now: '2026-07-28T12:00:00.000Z',
      });
      persistence.transitionTeamMission(mission.id, 'running', '2026-07-28T12:00:01.000Z');
      const first = mission.steps[0]!;
      persistence.transitionTeamExecution({
        executionId: first.executionId,
        to: 'queued',
        now: '2026-07-28T12:00:02.000Z',
        queueReason: 'global_concurrency',
      });
      persistence.transitionTeamExecution({
        executionId: first.executionId,
        to: 'running',
        now: '2026-07-28T12:00:03.000Z',
      });
      const dispatch = persistence.getTeamExecutionDispatch(first.executionId);
      persistence.transitionTeamTask(dispatch.teamTaskId, 'running', '2026-07-28T12:00:03.000Z');
      const attempt = persistence.createTeamAttempt(first.executionId, '2026-07-28T12:00:03.000Z');
      persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'running',
        now: '2026-07-28T12:00:04.000Z',
      });
      persistence.completeTeamMissionStep({
        executionId: first.executionId,
        attemptId: attempt.id,
        teamTaskId: dispatch.teamTaskId,
        agentId: worker.id,
        report: {
          status: 'completed',
          summary: 'first completed',
          findings: [],
          changedFiles: [],
          artifacts: [],
          verification: [{ name: 'unit', outcome: 'pass' }],
          risks: [],
          nextActions: [],
          doneEvidence: [{ criterion: 'first done', evidence: 'verified' }],
        },
        doneEvidence: [{ criterion: 'first done', evidence: 'verified' }],
        checkpoint: {
          summary: 'first completed',
          changedFiles: [],
          gitHead: null,
          workspaceDigest: 'a'.repeat(64),
          recordedAt: '2026-07-28T12:00:05.000Z',
        },
        now: '2026-07-28T12:00:05.000Z',
      });
      const secondExecutionId = mission.steps[1]!.executionId;
      expect(persistence.getTeamExecution(first.executionId).state).toBe('completed');
      expect(persistence.getTeamExecution(secondExecutionId).state).toBe('queued');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      reopened.initializeMutationRecovery('mission-restart', '2026-07-28T12:01:00.000Z');
      const coordinator = new TeamCoordinator(reopened);
      coordinator.recoverOnStartup();
      await waitFor(() => reopened.getTeamMission(mission.id).state === 'completed');
      expect(reopened.listTeamAttempts(first.executionId)).toHaveLength(1);
      expect(reopened.listTeamAttempts(secondExecutionId)).toMatchObject([
        { ordinal: 1, state: 'completed', startReason: 'app_restart' },
      ]);
      reopened.close();
    });

    it('moves an interrupted writable Mission step to waiting_resume on restart', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask('Writable Mission recovery');
      const team = persistence.promoteTaskToTeam(task.id);
      persistence.transitionTeamState(team.id, 'forming');
      persistence.transitionTeamState(team.id, 'active');
      const leader = persistence.getTaskLeader(task.id);
      const worker = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'writer',
        objective: 'write safely',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      persistence.transitionWorkerState(worker.id, 'spawning');
      persistence.transitionWorkerState(worker.id, 'ready');
      const mission = persistence.createTeamMission({
        teamId: team.id,
        createdByAgentId: leader.id,
        objective: 'writable recovery',
        doneCriteria: ['complete'],
        steps: [
          {
            workerId: worker.id,
            objective: 'write',
            doneCriteria: ['written'],
            access: 'workspace-write',
          },
          {
            workerId: worker.id,
            objective: 'verify',
            doneCriteria: ['verified'],
            access: 'read-only',
          },
        ],
        now: '2026-07-28T13:00:00.000Z',
      });
      persistence.transitionTeamMission(mission.id, 'running', '2026-07-28T13:00:01.000Z');
      const firstExecutionId = mission.steps[0]!.executionId;
      persistence.transitionTeamExecution({
        executionId: firstExecutionId,
        to: 'queued',
        now: '2026-07-28T13:00:02.000Z',
        queueReason: 'global_concurrency',
      });
      persistence.transitionTeamExecution({
        executionId: firstExecutionId,
        to: 'running',
        now: '2026-07-28T13:00:03.000Z',
      });
      const attempt = persistence.createTeamAttempt(firstExecutionId, '2026-07-28T13:00:03.000Z');
      persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'running',
        now: '2026-07-28T13:00:04.000Z',
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      reopened.initializeMutationRecovery('write-restart', '2026-07-28T13:01:00.000Z');
      const coordinator = new TeamCoordinator(reopened);
      coordinator.recoverOnStartup();
      expect(reopened.getTeamAttempt(attempt.id)).toMatchObject({
        state: 'interrupted',
        terminalReason: 'app_restart',
      });
      expect(reopened.getTeamExecution(firstExecutionId).state).toBe('waiting_resume');
      expect(reopened.getTeamMission(mission.id).state).toBe('waiting_resume');
      expect(reopened.listTeamAttempts(firstExecutionId)).toHaveLength(1);
      reopened.close();
    });
  });
else
  describe('Team execution persistence Electron ABI bridge', () => {
    it('runs the Team execution SQLite suite with Electron', () => {
      const result = spawnSync(
        electronTestExecutablePath(),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/team-execution-persistence.test.ts',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
          timeout: 30_000,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 35_000);
  });
