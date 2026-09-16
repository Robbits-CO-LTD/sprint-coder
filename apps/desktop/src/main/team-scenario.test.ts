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
// Measured on an M-series Mac (M5, Node 22), three consecutive runs of the Electron child: the
// three-hire scenario below costs 4.40 s / 4.40 s / 4.48 s, because the mock Runtime walks it
// through a long chain of 8-12 ms `pause` hops rather than any single slow call. Against that, the
// old 5 s non-Windows budget left ~11% of headroom on the fastest hardware this repo runs on, and
// main's job 104811263452 (macOS test shard 1/3) spent it: the scenario expired at the 5 s
// deadline. That is a budget shortfall, not a hang — the other two scenarios in the same child
// passed there (1.20 s and 1.02 s against 0.72 s and 0.69 s on this Mac) and the per-test ceiling
// was never reached. Every wait here is state-based (`waitFor` polls `published`, never a fixed
// sleep) and the pauses it waits on belong to the mock Runtime, so the allowance is the only lever
// this file has.
//
// The sibling SQLite bridge children of that same job degraded 2.9-4.0x against this Mac
// (user-file-save-saga 1.31 -> 3.91 s, team-persistence 1.60 -> 4.66 s,
// team-coordinator-persistence 1.69 -> 6.35 s, team-execution-persistence 1.78 -> 6.82 s,
// project-persistence 2.10 -> 8.38 s), inside the 3.7-7.3x that PR #483 measured for hosted macOS
// runners. 4.5 s at that worst observed 4.0x projects to 18 s, so 30 s covers the scenario at
// 6.7x: past the 5.1x #483 measured for the pure-SQLite children and into its 7.3x tail. Windows
// keeps the 15 s its own runs measured and have never exceeded; scaling that column by a factor
// measured on macOS runners would only blunt a real hang there.
//
// The 45 s per-test ceilings below must stay above this budget: a ceiling under it would make
// `scenarioWaitTimeoutMs` unreachable and report vitest's opaque timeout instead of
// `waitFor timed out`. 45 s leaves room for the SQLite setup and assertions around each wait.
const scenarioWaitTimeoutMs = process.platform === 'win32' ? 15_000 : 30_000;

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
    }, 45_000);

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
    }, 45_000);

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
    }, 45_000);
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
          // The child runs all three scenarios above, so this has to clear their 45 s ceilings
          // rather than the 14.2 s the child actually took in job 104811263452 (6.8 s on this
          // Mac). At 60 s a single hung scenario would be killed by the spawn before its own
          // ceiling could report which wait expired. 180 s is what `persistenceBridgeTimeoutMs`
          // and `graphBridgeTimeout` (PR #483) already allow the same class of child, and it
          // still bounds a genuine process-level hang.
          timeout: 180_000,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 185_000);
  });
