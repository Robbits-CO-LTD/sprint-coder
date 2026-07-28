import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';
import { SqlitePersistenceClient } from './persistence';

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
      persistence.transitionTeamAttempt({
        attemptId: first.id,
        to: 'waiting_rate_limit',
        now: '2026-07-28T11:02:02.000Z',
      });
      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'waiting_rate_limit',
        now: '2026-07-28T11:02:02.000Z',
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
