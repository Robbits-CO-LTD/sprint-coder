import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TurnEvent } from '@sprint-coder/contracts';
import { electronTestExecutablePath } from './electron-test-runtime';
import { SqlitePersistenceClient } from './persistence';
import { TeamCoordinator } from './team-coordinator';
import { MockRuntimeAdapter } from './runtime';
import { TEAM_SCENARIO_TRIGGER } from './team-tools';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
const scenarioWaitTimeoutMs = process.platform === 'win32' ? 15_000 : 5_000;

afterEach(() => {
  for (const directory of cleanup.splice(0))
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 5 : 0,
      retryDelay: 100,
    });
});

function createPersistence(): SqlitePersistenceClient {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-scenario-'));
  cleanup.push(directory);
  return new SqlitePersistenceClient(join(directory, 'test.sqlite3'));
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + scenarioWaitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

if (runsWithElectronAbi)
  describe('Deterministic mock team scenario', () => {
    it('one Leader Turn produces 3 hires + 3 formal assignments + 3 reports + a synthesized final answer', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team scenario');
      const coordinator = new TeamCoordinator(persistence);
      const published: TurnEvent[] = [];
      const runtime = new MockRuntimeAdapter(
        persistence,
        (event) => published.push(event),
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        coordinator,
      );

      // Starting Task has no Team at all — this exercises the auto-promotion path end to end,
      // not just the tool layer in isolation.
      expect(persistence.getTeamByTask(task.id)).toBeNull();
      const started = persistence.startTurn(
        task.id,
        `${TEAM_SCENARIO_TRIGGER}：障害調査をお願いします`,
      );
      runtime.start(task.id, started.turnId, `${TEAM_SCENARIO_TRIGGER}：障害調査をお願いします`);

      await waitFor(() => published.some((event) => event.type === 'turn.completed'));

      const completed = published.find((event) => event.type === 'turn.completed');
      expect(completed).toMatchObject({ state: 'completed' });

      const team = persistence.getTeamByTask(task.id);
      expect(team).not.toBeNull();
      const detail = coordinator.get(task.id);
      expect(detail).not.toBeNull();
      const workers = detail?.workers.filter(({ kind }) => kind === 'worker') ?? [];
      expect(workers).toHaveLength(3);
      expect(workers.every(({ state }) => state === 'done')).toBe(true);
      expect(new Set(workers.map(({ role }) => role))).toEqual(
        new Set(['調査', '実装', 'レビュー']),
      );
      expect(detail?.executions).toHaveLength(3);
      expect(detail?.activities.filter(({ type }) => type === 'task_assigned')).toHaveLength(3);

      // 3 Leader→Worker dispatches + 3 Worker→Leader reports, in strictly increasing seq order.
      const messages = detail?.messages ?? [];
      expect(messages).toHaveLength(6);
      expect(messages.map(({ seq }) => seq)).toEqual([...messages].map((_, index) => index + 1));
      expect(
        messages.filter(
          ({ sourceKind, targetKind }) => sourceKind === 'leader' && targetKind === 'worker',
        ),
      ).toHaveLength(3);
      expect(
        messages.filter(
          ({ sourceKind, targetKind }) => sourceKind === 'worker' && targetKind === 'leader',
        ),
      ).toHaveLength(3);

      const deltas = published.filter((event) => event.type === 'message.delta');
      const finalText = deltas.map((event) => (event as { delta: string }).delta).join('');
      expect(finalText).toContain('調査');
      expect(finalText).toContain('実装');
      expect(finalText).toContain('レビュー');
      persistence.close();
    }, 20_000);

    it('does not start the team scenario for ordinary input', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team scenario off');
      const coordinator = new TeamCoordinator(persistence);
      const published: TurnEvent[] = [];
      const runtime = new MockRuntimeAdapter(
        persistence,
        (event) => published.push(event),
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        coordinator,
      );
      const started = persistence.startTurn(task.id, '普通の質問です');
      runtime.start(task.id, started.turnId, '普通の質問です');
      await waitFor(() => published.some((event) => event.type === 'turn.completed'));
      expect(persistence.getTeamByTask(task.id)).toBeNull();
      persistence.close();
    }, 20_000);

    it('fails closed instead of running the fixed scenario for a natural Team continuation', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team continuation');
      const coordinator = new TeamCoordinator(persistence);
      const published: TurnEvent[] = [];
      const runtime = new MockRuntimeAdapter(
        persistence,
        (event) => published.push(event),
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        coordinator,
      );

      const failed = persistence.startTurn(task.id, 'チームで二人雇って挨拶して');
      persistence.completeTurn(task.id, failed.turnId, 'failed');
      expect(persistence.getTeamByTask(task.id)).toBeNull();

      const continued = persistence.startTurn(task.id, 'codex to ollamanisite');
      expect(continued.teamTurn).toBe(true);
      runtime.start(task.id, continued.turnId, continued.text, continued.teamTurn);

      await waitFor(() => published.some((event) => event.type === 'turn.completed'));
      expect(persistence.getTeamByTask(task.id)).toBeNull();
      const finalText = published
        .filter((event) => event.type === 'message.delta')
        .map((event) => (event as { delta: string }).delta)
        .join('');
      expect(finalText).toContain('組み込みTeam Skillを利用できない');
      expect(finalText).toContain('架空のメンバーや別のsubagentには置き換えていません');
      persistence.close();
    }, 20_000);
  });
else
  describe('Deterministic mock team scenario Electron ABI bridge', () => {
    it('runs the team scenario integration suite with Electron', () => {
      const result = spawnSync(
        electronTestExecutablePath(),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/team-scenario.test.ts',
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
