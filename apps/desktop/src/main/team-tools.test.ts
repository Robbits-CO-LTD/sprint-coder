import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';
import { SqlitePersistenceClient } from './persistence';
import { TeamCoordinator } from './team-coordinator';
import { createDefaultToolBroker, startMockTurnCatalog } from './default-tools';
import type { ToolBroker } from './tool-broker';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createPersistence(): SqlitePersistenceClient {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-tools-'));
  cleanup.push(directory);
  return new SqlitePersistenceClient(join(directory, 'test.sqlite3'));
}

function brokerFor(coordinator: TeamCoordinator): ToolBroker {
  return createDefaultToolBroker(() => 0, undefined, undefined, { coordinator });
}

function dispatch(
  broker: ToolBroker,
  toolContext: { taskId: string; turnId: string },
  providerName: string,
  input: unknown,
  callId = `${providerName}-${Math.random()}`,
) {
  return broker.dispatch({
    taskId: toolContext.taskId,
    turnId: toolContext.turnId,
    callId,
    providerName,
    input,
  });
}

if (runsWithElectronAbi)
  describe('Leader team tools', () => {
    it('auto-promotes the Task to a Team on the first team_hire_worker call', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team tools');
      const coordinator = new TeamCoordinator(persistence);
      const broker = brokerFor(coordinator);
      const toolContext = { taskId: task.id, turnId: 'turn-1', workspaceId: null, policyEpoch: 0 };
      startMockTurnCatalog(broker, toolContext);

      expect(persistence.getTeamByTask(task.id)).toBeNull();
      const result = (await dispatch(broker, toolContext, 'team_hire_worker', {
        role: '調査',
        objective: '調査してください',
      })) as { ok: true; workerId: string; role: string; state: string };

      expect(result.ok).toBe(true);
      expect(result.role).toBe('調査');
      expect(result.state).toBe('ready');
      const team = persistence.getTeamByTask(task.id);
      expect(team).not.toBeNull();
      expect(team?.state).toBe('active');
      await broker.dispose();
      persistence.close();
    });

    it('allows the Leader tool to hire more than the legacy three-Worker cap', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team tools cap');
      const coordinator = new TeamCoordinator(persistence);
      const broker = brokerFor(coordinator);
      const toolContext = { taskId: task.id, turnId: 'turn-1', workspaceId: null, policyEpoch: 0 };
      startMockTurnCatalog(broker, toolContext);

      const workers = [];
      for (const role of ['調査', '設計', '実装', 'レビュー', '検証'])
        workers.push(
          await dispatch(broker, toolContext, 'team_hire_worker', { role, objective: role }),
        );

      expect(workers).toHaveLength(5);
      expect(workers.every((worker) => (worker as { ok: boolean }).ok)).toBe(true);
      await broker.dispose();
      persistence.close();
    });

    it('rejects a forged identity field before it ever reaches TeamCoordinator', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team tools envelope');
      const coordinator = new TeamCoordinator(persistence);
      const broker = brokerFor(coordinator);
      const toolContext = { taskId: task.id, turnId: 'turn-1', workspaceId: null, policyEpoch: 0 };
      startMockTurnCatalog(broker, toolContext);
      const worker = (await dispatch(broker, toolContext, 'team_hire_worker', {
        role: '調査',
        objective: 'go',
      })) as { workerId: string };

      // The pinned schema has additionalProperties:false and no source-identity field at all, so
      // a runtime attempting to smuggle a leader/source identity is rejected at the schema gate —
      // TeamCoordinator.sendToWorker is never even invoked.
      await expect(
        dispatch(broker, toolContext, 'team_send_to_worker', {
          workerId: worker.workerId,
          content: 'hi',
          sourceAgentId: 'attacker-supplied-leader-id',
        }),
      ).rejects.toThrow('does not match the pinned schema');
      await broker.dispose();
      persistence.close();
    });

    it('delivers a message, persists the Worker report, and surfaces it via team_wait_reports once', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team tools reports');
      const coordinator = new TeamCoordinator(persistence);
      const broker = brokerFor(coordinator);
      const toolContext = { taskId: task.id, turnId: 'turn-1', workspaceId: null, policyEpoch: 0 };
      startMockTurnCatalog(broker, toolContext);
      const hired = (await dispatch(broker, toolContext, 'team_hire_worker', {
        role: '実装',
        objective: '実装してください',
      })) as { workerId: string };

      const sent = (await dispatch(broker, toolContext, 'team_send_to_worker', {
        workerId: hired.workerId,
        content: 'このタスクを実装してください',
      })) as { ok: true; deliveryState: string };
      expect(sent.ok).toBe(true);
      expect(sent.deliveryState).toBe('acked');

      const first = (await dispatch(broker, toolContext, 'team_wait_reports', {})) as {
        ok: true;
        reports: readonly { workerId: string; seq: number; content: string }[];
      };
      expect(first.reports).toHaveLength(1);
      expect(first.reports[0]?.workerId).toBe(hired.workerId);
      expect(JSON.parse(first.reports[0]?.content ?? '{}')).toMatchObject({ status: 'succeeded' });

      // Same Turn context: the cursor already advanced past this report, so a second call
      // returns nothing new — the tool never re-delivers the same report within a Turn.
      const second = (await dispatch(broker, toolContext, 'team_wait_reports', {})) as {
        reports: readonly unknown[];
      };
      expect(second.reports).toHaveLength(0);
      await broker.dispose();
      persistence.close();
    });

    it('maps stopWorker not-found to a tool-result error', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team tools stop');
      const coordinator = new TeamCoordinator(persistence);
      const broker = brokerFor(coordinator);
      const toolContext = { taskId: task.id, turnId: 'turn-1', workspaceId: null, policyEpoch: 0 };
      startMockTurnCatalog(broker, toolContext);

      const result = (await dispatch(broker, toolContext, 'team_stop_worker', {
        workerId: 'no-such-worker',
      })) as { ok: false; message: string };
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Team not found');
      await broker.dispose();
      persistence.close();
    });
  });
else
  describe('Leader team tools Electron ABI bridge', () => {
    it('runs the team tools integration suite with Electron', () => {
      const result = spawnSync(
        electronTestExecutablePath(),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/team-tools.test.ts',
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
