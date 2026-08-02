import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
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
    it('defaults legacy calls to read-only and persists explicit workspace-write access', () => {
      const { persistence, path } = createPersistence();
      const { team, leader, worker, execution } = createExecutionFixture(persistence);
      expect(execution.accessMode).toBe('read-only');
      expect(() =>
        persistence.createTeamExecution({
          teamId: team.id,
          assigneeAgentId: worker.id,
          createdByAgentId: leader.id,
          instruction: 'must not write',
          accessMode: 'workspace-write',
          now: '2026-07-28T11:00:00.500Z',
        }),
      ).toThrow('write-capable Worker');
      const writable = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'writer',
        objective: 'write inside isolation',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'summary',
        writeCapable: true,
      });
      const writeExecution = persistence.createTeamExecution({
        teamId: team.id,
        assigneeAgentId: writable.id,
        createdByAgentId: leader.id,
        instruction: 'write safely',
        accessMode: 'workspace-write',
        now: '2026-07-28T11:00:01.000Z',
      });
      expect(writeExecution.accessMode).toBe('workspace-write');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getTeamExecution(execution.id).accessMode).toBe('read-only');
      expect(reopened.getTeamExecution(writeExecution.id).accessMode).toBe('workspace-write');
      reopened.close();
    });

    it('persists multi-repository isolation and leases every mutation key atomically', () => {
      const { persistence, path } = createPersistence();
      const { team, leader } = createExecutionFixture(persistence);
      const writer = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'writer',
        objective: 'write both repositories',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'summary',
        writeCapable: true,
      });
      const first = persistence.createTeamExecution({
        teamId: team.id,
        assigneeAgentId: writer.id,
        createdByAgentId: leader.id,
        instruction: 'first write',
        accessMode: 'workspace-write',
        now: '2026-08-02T00:00:00.000Z',
      });
      const second = persistence.createTeamExecution({
        teamId: team.id,
        assigneeAgentId: writer.id,
        createdByAgentId: leader.id,
        instruction: 'second write',
        accessMode: 'workspace-write',
        now: '2026-08-02T00:00:00.100Z',
      });
      const repositories = [
        {
          ordinal: 1,
          repoPath: '/repo/one',
          worktreePath: '/isolated/one',
          baseHead: 'a'.repeat(40),
          workerHead: null,
          integratedHead: null,
          state: 'active' as const,
          changedFiles: [],
        },
        {
          ordinal: 2,
          repoPath: '/repo/two',
          worktreePath: '/isolated/two',
          baseHead: 'b'.repeat(40),
          workerHead: null,
          integratedHead: null,
          state: 'active' as const,
          changedFiles: [],
        },
      ];
      const roots = [
        {
          rootId: '10000000-0000-4000-8000-000000000001',
          rootLabel: 'one',
          role: 'primary' as const,
          repositoryOrdinal: 1,
          sourcePath: '/repo/one',
          isolatedPath: '/isolated/one',
          identity: '1'.repeat(64),
          mutationKey: '3'.repeat(64),
        },
        {
          rootId: '10000000-0000-4000-8000-000000000002',
          rootLabel: 'two',
          role: 'secondary' as const,
          repositoryOrdinal: 2,
          sourcePath: '/repo/two',
          isolatedPath: '/isolated/two',
          identity: '2'.repeat(64),
          mutationKey: '4'.repeat(64),
        },
      ];
      const isolation = persistence.createTeamExecutionIsolation({
        executionId: first.id,
        repositories,
        roots,
        now: '2026-08-02T00:00:01.000Z',
      });
      expect(isolation).toMatchObject({ phase: 'preparing', revision: 1, repositories, roots });
      expect(
        persistence.updateTeamExecutionIsolation({
          executionId: first.id,
          phase: 'running',
          now: '2026-08-02T00:00:02.000Z',
        }),
      ).toMatchObject({ phase: 'running', revision: 2 });

      persistence.acquireTeamIntegrationRootLeases({
        executionId: first.id,
        roots,
        now: '2026-08-02T00:00:03.000Z',
      });
      expect(() =>
        persistence.acquireTeamIntegrationRootLeases({
          executionId: second.id,
          roots: [{ ...roots[0]!, rootId: 'different-project-root' }],
          now: '2026-08-02T00:00:03.100Z',
        }),
      ).toThrow('already leased');
      persistence.releaseTeamIntegrationRootLeases(first.id);
      expect(() =>
        persistence.acquireTeamIntegrationRootLeases({
          executionId: second.id,
          roots,
          now: '2026-08-02T00:00:04.000Z',
        }),
      ).not.toThrow();
      persistence.releaseTeamIntegrationRootLeases(second.id);
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getTeamExecutionIsolation(first.id)).toMatchObject({
        phase: 'running',
        revision: 2,
        repositories,
        roots,
      });
      reopened.close();
    });

    it('backfills v61 Mission access while leaving standalone executions read-only', () => {
      const { persistence, path } = createPersistence();
      const { team, leader, execution } = createExecutionFixture(persistence);
      const writer = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'migration writer',
        objective: 'migrate access',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'summary',
        writeCapable: true,
      });
      persistence.transitionTeamState(team.id, 'active');
      const mission = persistence.createTeamMission({
        teamId: team.id,
        createdByAgentId: leader.id,
        objective: 'migrate mission access',
        doneCriteria: ['done'],
        steps: [
          {
            workerId: writer.id,
            objective: 'write',
            doneCriteria: ['written'],
            access: 'workspace-write',
          },
          { workerId: writer.id, objective: 'read', doneCriteria: ['read'], access: 'read-only' },
        ],
        now: '2026-07-28T11:00:02.000Z',
      });
      persistence.close();
      const legacy = new Database(path);
      legacy.exec(`
        ALTER TABLE team_executions DROP COLUMN access_mode;
        DELETE FROM schema_migrations WHERE version = 62;
      `);
      legacy.close();

      const migrated = new SqlitePersistenceClient(path);
      expect(migrated.getTeamExecution(execution.id).accessMode).toBe('read-only');
      expect(migrated.getTeamExecution(mission.steps[0]!.executionId).accessMode).toBe(
        'workspace-write',
      );
      expect(migrated.getTeamExecution(mission.steps[1]!.executionId).accessMode).toBe('read-only');
      migrated.close();
    });

    it('inherits the immutable root Turn seal across Team execution retry reads', () => {
      const { persistence } = createPersistence();
      const project = persistence.createProject('Inherited context');
      const instruction = persistence.setProjectInstruction({
        projectId: project.id,
        expectedRevision: project.revision,
        instruction: 'Keep the sealed root instruction.',
      });
      const task = persistence.createTask('root', false, project.id);
      const root = persistence.startTurn(task.id, 'チームで実装して');
      const team = persistence.promoteTaskToTeam(task.id);
      const leader = persistence.getTaskLeader(task.id);
      persistence.transitionTeamState(team.id, 'forming');
      persistence.transitionTeamState(team.id, 'active');
      const worker = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'implementer',
        objective: 'inherit root context',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'summary',
      });
      const execution = persistence.createTeamExecution({
        teamId: team.id,
        assigneeAgentId: worker.id,
        createdByAgentId: leader.id,
        instruction: 'implement',
        now: '2026-07-31T00:00:00.000Z',
        contextOwner: { type: 'turn', id: root.turnId },
      });

      const rootManifest = persistence.getContextSealManifest('turn', root.turnId);
      const inherited = persistence.getContextSealManifest('team_execution', execution.id);
      expect(inherited).toMatchObject({
        projectId: project.id,
        projectRevision: instruction.revision,
        projectContextEpoch: instruction.contextEpoch,
        candidateSnapshotDigest: rootManifest.candidateSnapshotDigest,
        sealedDigest: rootManifest.sealedDigest,
      });
      expect(persistence.prepareTeamExecutionContext(task.id, execution.id).projectItems).toEqual(
        persistence.prepareContext(task.id, root.turnId).projectItems,
      );
      const mission = persistence.createTeamMission({
        teamId: team.id,
        createdByAgentId: leader.id,
        objective: 'inherit through every mission step',
        doneCriteria: ['both steps use the root seal'],
        steps: [
          {
            workerId: worker.id,
            objective: 'first inherited step',
            doneCriteria: ['first complete'],
            access: 'read-only',
          },
          {
            workerId: worker.id,
            objective: 'second inherited step',
            doneCriteria: ['second complete'],
            access: 'read-only',
          },
        ],
        now: '2026-07-31T00:00:01.000Z',
        contextOwner: { type: 'turn', id: root.turnId },
      });
      expect(
        mission.steps.map(({ executionId }) =>
          persistence.getContextSealManifest('team_execution', executionId),
        ),
      ).toEqual([
        expect.objectContaining({
          candidateSnapshotDigest: rootManifest.candidateSnapshotDigest,
          sealedDigest: rootManifest.sealedDigest,
        }),
        expect.objectContaining({
          candidateSnapshotDigest: rootManifest.candidateSnapshotDigest,
          sealedDigest: rootManifest.sealedDigest,
        }),
      ]);

      persistence.setProjectInstruction({
        projectId: project.id,
        expectedRevision: instruction.revision,
        instruction: 'Changed after assignment.',
      });
      expect(
        persistence.prepareTeamExecutionContext(task.id, execution.id).projectItems[0]?.content,
      ).toBe('Keep the sealed root instruction.');
      persistence.close();
    });

    it('seals a parentless manual execution from live Project state only at dispatch', () => {
      const { persistence } = createPersistence();
      const project = persistence.createProject('Manual context');
      const first = persistence.setProjectInstruction({
        projectId: project.id,
        expectedRevision: project.revision,
        instruction: 'Before dispatch.',
      });
      const task = persistence.createTask('manual', false, project.id);
      const prior = persistence.startTurn(task.id, 'Conversation before manual Team dispatch.');
      persistence.cancelTurn(task.id, prior.turnId);
      const team = persistence.promoteTaskToTeam(task.id);
      const leader = persistence.getTaskLeader(task.id);
      persistence.transitionTeamState(team.id, 'forming');
      const worker = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'manual worker',
        objective: 'seal at dispatch',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'none',
      });
      const execution = persistence.createTeamExecution({
        teamId: team.id,
        assigneeAgentId: worker.id,
        createdByAgentId: leader.id,
        instruction: 'manual work',
        now: '2026-07-31T00:00:00.000Z',
      });
      const second = persistence.setProjectInstruction({
        projectId: project.id,
        expectedRevision: first.revision,
        instruction: 'At dispatch.',
      });

      const prepared = persistence.prepareTeamExecutionContext(task.id, execution.id);
      expect(prepared.projectItems[0]?.content).toBe('At dispatch.');
      expect(prepared.fragments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'history',
            content: 'Conversation before manual Team dispatch.',
          }),
        ]),
      );
      persistence.setProjectInstruction({
        projectId: project.id,
        expectedRevision: second.revision,
        instruction: 'After dispatch.',
      });
      expect(persistence.prepareTeamExecutionContext(task.id, execution.id)).toEqual(prepared);
      persistence.close();
    });

    it('cancels and quarantines background work atomically when Project context changes', () => {
      const { persistence } = createPersistence();
      const project = persistence.createProject('Background context');
      const instruction = persistence.setProjectInstruction({
        projectId: project.id,
        expectedRevision: project.revision,
        instruction: 'Original background context.',
      });
      const completedTask = persistence.createTask('completed background', false, project.id);
      const completedOwner = persistence.startTurn(completedTask.id, 'start background');
      persistence.createBackgroundActivity({
        id: 'project-completed-activity',
        taskId: completedTask.id,
        ownerThreadId: completedTask.id,
        ownerTurnId: completedOwner.turnId,
        kind: 'command',
        wakePolicy: 'nextSafePoint',
        requiredCapabilities: [],
        volumeQuotaBytes: 10_000,
        createdAt: '2026-07-31T00:00:00.000Z',
      });
      persistence.transitionBackgroundActivity(
        'project-completed-activity',
        'running',
        '2026-07-31T00:00:01.000Z',
      );
      persistence.cancelTurn(completedTask.id, completedOwner.turnId);
      persistence.completeBackgroundActivity({
        activityId: 'project-completed-activity',
        completionId: 'project-completion',
        outcome: 'completed',
        payload: 'result from the old Project snapshot',
        outputCursor: 1,
        completedAt: '2026-07-31T00:00:02.000Z',
      });

      const runningTask = persistence.createTask('running background', false, project.id);
      const runningOwner = persistence.startTurn(runningTask.id, 'start monitor');
      persistence.createBackgroundActivity({
        id: 'project-running-activity',
        taskId: runningTask.id,
        ownerThreadId: runningTask.id,
        ownerTurnId: runningOwner.turnId,
        kind: 'monitor',
        wakePolicy: 'manual',
        requiredCapabilities: [],
        volumeQuotaBytes: 10_000,
        createdAt: '2026-07-31T00:00:03.000Z',
      });
      persistence.transitionBackgroundActivity(
        'project-running-activity',
        'running',
        '2026-07-31T00:00:04.000Z',
      );

      persistence.setProjectInstruction({
        projectId: project.id,
        expectedRevision: instruction.revision,
        instruction: 'New background context.',
      });

      expect(persistence.listBackgroundCompletions(completedTask.id)).toEqual([
        expect.objectContaining({
          state: 'quarantined',
          quarantineReason: 'project_context_epoch_changed',
        }),
      ]);
      expect(() =>
        persistence.transitionBackgroundActivity(
          'project-running-activity',
          'canceled',
          '2026-07-31T00:00:05.000Z',
        ),
      ).toThrow('Invalid background activity transition: canceled -> canceled');
      persistence.close();
    });

    it('quarantines a completion when its owner seal Project no longer matches the Task', () => {
      const { persistence } = createPersistence();
      const sourceProject = persistence.createProject('Source Project');
      const targetProject = persistence.createProject('Target Project');
      const task = persistence.createTask('moving background', false, sourceProject.id);
      const owner = persistence.startTurn(task.id, 'start background before moving');
      persistence.createBackgroundActivity({
        id: 'moving-activity',
        taskId: task.id,
        ownerThreadId: task.id,
        ownerTurnId: owner.turnId,
        kind: 'command',
        wakePolicy: 'nextSafePoint',
        requiredCapabilities: [],
        volumeQuotaBytes: 10_000,
        createdAt: '2026-07-31T00:00:00.000Z',
      });
      persistence.transitionBackgroundActivity(
        'moving-activity',
        'running',
        '2026-07-31T00:00:01.000Z',
      );
      persistence.cancelTurn(task.id, owner.turnId);
      persistence.completeBackgroundActivity({
        activityId: 'moving-activity',
        completionId: 'moving-completion',
        outcome: 'completed',
        payload: 'must not cross the Project boundary',
        outputCursor: 1,
        completedAt: '2026-07-31T00:00:02.000Z',
      });
      persistence.assignTaskToProject({
        taskId: task.id,
        projectId: targetProject.id,
        expectedProjectId: sourceProject.id,
      });

      const target = persistence.startTurn(task.id, 'use only the target Project context');
      expect(persistence.listBackgroundCompletions(task.id)).toEqual([
        expect.objectContaining({ state: 'quarantined', quarantineReason: 'project_changed' }),
      ]);
      expect(
        persistence
          .prepareContext(task.id, target.turnId)
          .fragments.some(({ id }) => id === 'moving-completion'),
      ).toBe(false);
      persistence.close();
    });

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
