import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceClient } from './persistence';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createPersistence(): { persistence: SqlitePersistenceClient; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-persistence-'));
  cleanup.push(directory);
  const path = join(directory, 'test.sqlite3');
  return { persistence: new SqlitePersistenceClient(path), path };
}

const emptyCeiling = {
  entries: [],
  maxWorkerDepth: 0,
  maxConcurrentWorkers: 0,
} as const;

if (runsWithElectronAbi)
  describe('team persistence', () => {
    it('promotes a Task without changing its Task or leader identity', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask('Team task');
      const leaderBefore = persistence.getTaskLeader(task.id);

      const team = persistence.promoteTaskToTeam(task.id);
      const replay = persistence.promoteTaskToTeam(task.id);
      expect(replay).toEqual(team);
      expect(team).toMatchObject({
        taskId: task.id,
        leaderAgentId: leaderBefore.id,
        state: 'draft',
      });
      expect(persistence.getTaskLeader(task.id)).toMatchObject({
        id: leaderBefore.id,
        threadId: leaderBefore.threadId,
        teamId: team.id,
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getTeamByTask(task.id)).toEqual(team);
      expect(reopened.getTaskLeader(task.id).id).toBe(leaderBefore.id);
      reopened.close();
    });

    it('stores a Worker as an Agent, AgentThread, and TeamMembership policy record', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const team = persistence.promoteTaskToTeam(task.id);
      persistence.transitionTeamState(team.id, 'forming');
      const worker = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'reviewer',
        objective: 'Review the bounded slice.',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'summary',
      });

      expect(worker).toMatchObject({
        teamId: team.id,
        taskId: task.id,
        kind: 'worker',
        role: 'reviewer',
        state: 'invited',
        objective: 'Review the bounded slice.',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'summary',
      });
      expect(persistence.getTeamSnapshot(team.id).agents).toHaveLength(2);
      expect(() => persistence.transitionWorkerState(worker.id, 'ready')).toThrow(
        'Invalid worker transition',
      );
      expect(persistence.transitionWorkerState(worker.id, 'spawning').state).toBe('spawning');
      expect(persistence.transitionWorkerState(worker.id, 'ready').state).toBe('ready');
      persistence.close();
    });

    it('persists ordered leader-routed delivery and rejects direct Worker messages', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const team = persistence.promoteTaskToTeam(task.id);
      const leader = persistence.getTaskLeader(task.id);
      persistence.transitionTeamState(team.id, 'forming');
      const firstWorker = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'implementer',
        objective: 'Implement.',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'selected_items',
      });
      const secondWorker = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'reviewer',
        objective: 'Review.',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'summary',
      });
      persistence.transitionTeamState(team.id, 'active');

      expect(() =>
        persistence.createTeamMessage({
          teamId: team.id,
          sourceAgentId: firstWorker.id,
          targetAgentId: secondWorker.id,
          content: 'Direct message',
        }),
      ).toThrow('must be routed between the leader and a worker');

      const first = persistence.createTeamMessage({
        teamId: team.id,
        sourceAgentId: leader.id,
        targetAgentId: firstWorker.id,
        content: 'Please implement.',
      });
      const second = persistence.createTeamMessage({
        teamId: team.id,
        sourceAgentId: secondWorker.id,
        targetAgentId: leader.id,
        content: 'Review complete.',
      });
      expect([first.seq, second.seq]).toEqual([1, 2]);
      expect(persistence.transitionTeamMessageState(first.id, 'dispatching').state).toBe(
        'dispatching',
      );
      expect(persistence.transitionTeamMessageState(first.id, 'delivered').state).toBe('delivered');
      expect(persistence.transitionTeamMessageState(first.id, 'acknowledged').state).toBe(
        'acknowledged',
      );
      expect(() => persistence.transitionTeamMessageState(second.id, 'delivered')).toThrow(
        'Invalid team message transition',
      );
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getTeamSnapshot(team.id).messages).toMatchObject([
        { id: first.id, seq: 1, state: 'acknowledged' },
        { id: second.id, seq: 2, state: 'persisted' },
      ]);
      reopened.close();
    });
  });
else
  describe('team persistence Electron ABI bridge', () => {
    it('runs the Team SQLite suite with Electron', () => {
      const result = spawnSync(
        join(process.cwd(), '../../node_modules/.bin/electron'),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/team-persistence.test.ts',
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
