import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';
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
  completionStatus: 'succeeded' | 'failed' | 'partial' = 'succeeded';

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
        status: this.completionStatus,
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
      expect(workers.every(({ engine }) => engine === 'mock')).toBe(true);
      expect(
        persistence
          .getTeamBudgetStatus(workers[0]!.teamId)
          .find(({ scope, kind }) => scope === 'global' && kind === 'spawnSlots'),
      ).toMatchObject({ committed: 0, reserved: 0 });
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
      expect(detail?.team.state).toBe('completed');
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

    it('preserves a failed Worker report as failed instead of promoting it to completed', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      const runtime = new TestWorkerRuntime();
      runtime.completionStatus = 'failed';
      const coordinator = new TeamCoordinator(persistence, runtime);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'reviewer',
        objective: 'find a blocker',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });

      await coordinator.sendToWorker({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'report failure',
      });

      expect(coordinator.get(task.id)?.workers.find(({ id }) => id === worker.id)?.state).toBe(
        'failed',
      );
      persistence.close();
    });

    it('hasBusyWorkers reflects an in-flight dispatch and clears once it settles', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      let releaseExecute: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseExecute = resolve;
      });
      const runtime: TeamWorkerRuntime = {
        async start() {
          return { pid: null };
        },
        async execute(input) {
          await gate;
          return {
            claims: {
              deliveryId: input.envelope.deliveryId,
              sourceAgentId: input.envelope.sourceAgentId,
              targetAgentId: input.envelope.targetAgentId,
            },
            completion: {
              status: 'succeeded',
              summary: 'done',
              artifacts: [],
              verification: [],
              risks: [],
            },
          };
        },
        async stop() {
          /* not exercised in this test */
        },
      };
      const coordinator = new TeamCoordinator(persistence, runtime);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'worker',
        objective: 'work',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      expect(coordinator.hasBusyWorkers(task.id)).toBe(false);

      const dispatch = coordinator.sendToWorker({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'go',
      });
      // Give sendToWorker's synchronous prefix (queued via the Task mailbox) a tick to actually
      // transition the Worker to 'busy' before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(coordinator.hasBusyWorkers(task.id)).toBe(true);

      releaseExecute?.();
      await dispatch;
      expect(coordinator.hasBusyWorkers(task.id)).toBe(false);
      persistence.close();
    });

    it('pushes accepted, stage, reasoning, and batched output into the live Worker snapshot', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      let releaseExecute: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseExecute = resolve;
      });
      const runtime: TeamWorkerRuntime = {
        async start() {
          return { pid: null };
        },
        async execute(input) {
          input.onEvent?.({ type: 'accepted', at: '2026-07-26T00:00:00.000Z' });
          input.onEvent?.({
            type: 'activity',
            phase: 'planning',
            label: '方針を検討中',
            at: '2026-07-26T00:00:01.000Z',
          });
          input.onEvent?.({ type: 'reasoningPresence', active: true });
          input.onEvent?.({ type: 'outputDelta', text: '途中出力' });
          await gate;
          input.onEvent?.({ type: 'completed' });
          return {
            claims: {
              deliveryId: input.envelope.deliveryId,
              sourceAgentId: input.envelope.sourceAgentId,
              targetAgentId: input.envelope.targetAgentId,
            },
            completion: {
              status: 'succeeded',
              summary: '完了',
              artifacts: [],
              verification: [],
              risks: [],
            },
          };
        },
        async stop() {},
      };
      const snapshots: ReturnType<TeamCoordinator['get']>[] = [];
      const coordinator = new TeamCoordinator(persistence, runtime, (_taskId, detail) => {
        snapshots.push(detail);
      });
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'worker',
        objective: 'stream',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });

      const dispatch = coordinator.sendToWorker({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'go',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const live = snapshots.at(-1)?.workers.find(({ id }) => id === worker.id);
      expect(live).toMatchObject({
        state: 'busy',
        currentActivity: '方針を検討中',
        reasoningActive: true,
        liveOutput: '途中出力',
      });

      releaseExecute?.();
      await dispatch;
      expect(coordinator.get(task.id)?.workers.find(({ id }) => id === worker.id)).toMatchObject({
        state: 'done',
        reasoningActive: false,
        liveOutput: '',
      });
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
        electronTestExecutablePath(),
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
