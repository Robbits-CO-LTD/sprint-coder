import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from './persistence';
import { SqlitePersistenceClient } from './persistence';
import {
  TeamCoordinator,
  type TeamWorkerRuntime,
  type WorkerRuntimeResult,
} from './team-coordinator';
import type { TeamEnvelope } from '@sprint-coder/domain';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createPersistence(): SqlitePersistenceClient {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-coordinator-'));
  cleanup.push(directory);
  return new SqlitePersistenceClient(join(directory, 'test.sqlite3'));
}

class TestWorkerRuntime implements TeamWorkerRuntime {
  activeStarts = 0;
  maxActiveStarts = 0;
  readonly stopped: string[] = [];
  spoofClaims = false;

  async start(_worker: AgentRecord): Promise<{ pid: null }> {
    this.activeStarts += 1;
    this.maxActiveStarts = Math.max(this.maxActiveStarts, this.activeStarts);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.activeStarts -= 1;
    return { pid: null };
  }

  async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
  }): Promise<WorkerRuntimeResult> {
    return {
      claims: {
        deliveryId: input.envelope.deliveryId,
        sourceAgentId: input.envelope.sourceAgentId,
        targetAgentId: this.spoofClaims ? 'spoofed-worker' : input.envelope.targetAgentId,
      },
      completion: {
        status: 'succeeded',
        summary: `${input.worker.role}: ${input.content}`,
        artifacts: [],
        verification: [{ name: 'test-runtime', outcome: 'pass' }],
        risks: [],
      },
      usage: { costCents: 1, tokens: 2, timeMs: 3, toolCalls: 4 },
    };
  }

  async stop(agentId: string): Promise<void> {
    this.stopped.push(agentId);
  }
}

if (runsWithElectronAbi)
  describe('TeamCoordinator', () => {
    it('starts exactly three Workers sequentially and returns each result to the Leader', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team');
      const runtime = new TestWorkerRuntime();
      const events: number[] = [];
      const coordinator = new TeamCoordinator(persistence, runtime, (_taskId, detail) => {
        events.push(detail.workers.length);
      });

      const workers = await Promise.all(
        ['implementer', 'reviewer', 'verifier'].map((role) =>
          coordinator.hireWorker({
            taskId: task.id,
            role,
            objective: `${role} objective`,
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          }),
        ),
      );
      expect(runtime.maxActiveStarts).toBe(1);
      expect(workers.map(({ state }) => state)).toEqual(['ready', 'ready', 'ready']);
      await expect(
        coordinator.hireWorker({
          taskId: task.id,
          role: 'fourth',
          objective: 'must fail',
          contextInheritancePolicy: 'none',
          writeCapable: false,
        }),
      ).rejects.toThrow('hard cap');

      for (const worker of workers)
        await coordinator.sendToWorker({
          taskId: task.id,
          targetAgentId: worker.id,
          content: `request for ${worker.role}`,
        });

      const detail = coordinator.get(task.id);
      expect(detail?.team.state).toBe('active');
      expect(
        detail?.workers.filter(({ kind }) => kind === 'worker').map(({ state }) => state),
      ).toEqual(['done', 'done', 'done']);
      expect(detail?.messages).toHaveLength(6);
      expect(
        detail?.messages.filter(
          ({ sourceKind, targetKind }) => sourceKind === 'worker' && targetKind === 'leader',
        ),
      ).toHaveLength(3);
      expect(events.length).toBeGreaterThanOrEqual(6);
      persistence.close();
    });

    it('rejects runtime identity spoofing and fails the delivery closed', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      const runtime = new TestWorkerRuntime();
      const coordinator = new TeamCoordinator(persistence, runtime);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'worker',
        objective: 'work',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      runtime.spoofClaims = true;

      await expect(
        coordinator.sendToWorker({
          taskId: task.id,
          targetAgentId: worker.id,
          content: 'spoof attempt',
        }),
      ).rejects.toThrow('identity mismatch');
      const detail = coordinator.get(task.id);
      expect(detail?.workers.find(({ id }) => id === worker.id)?.state).toBe('failed');
      expect(detail?.messages[0]?.deliveryState).toBe('failed');
      persistence.close();
    });

    it('stops every owned Worker through the runtime and completes the Team', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      const runtime = new TestWorkerRuntime();
      const coordinator = new TeamCoordinator(persistence, runtime);
      const workers = [];
      for (const role of ['one', 'two', 'three'])
        workers.push(
          await coordinator.hireWorker({
            taskId: task.id,
            role,
            objective: role,
            contextInheritancePolicy: 'none',
            writeCapable: false,
          }),
        );

      const detail = await coordinator.stopAll(task.id);
      expect(new Set(runtime.stopped)).toEqual(new Set(workers.map(({ id }) => id)));
      expect(detail.team.state).toBe('completed');
      expect(
        detail.workers
          .filter(({ kind }) => kind === 'worker')
          .every(({ state }) => state === 'stopped'),
      ).toBe(true);
      persistence.close();
    });
  });
else
  describe('TeamCoordinator Electron ABI bridge', () => {
    it('runs the TeamCoordinator integration suite with Electron', () => {
      const result = spawnSync(
        join(process.cwd(), '../../node_modules/.bin/electron'),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/team-coordinator.test.ts',
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
