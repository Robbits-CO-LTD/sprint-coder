import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Fixed mock scenario roles (main/team-tools.ts's TEAM_SCENARIO_ROLES) — hired in this exact
// order by the deterministic mock sampler, independent of message content.
const SCENARIO_ROLES = ['調査', '実装', 'レビュー'] as const;
// Matches main/team-tools.ts's TEAM_SCENARIO_TRIGGER. Any message triggers the scenario once a
// Team already exists for the Task (see runtime.ts's `teamScenarioActive`), but this keyword is
// what a real user would type to ask the Leader to bring in a Team.
const TEAM_TRIGGER = 'チームテスト';

test.describe('Phase 5/6 Team flow: Leader hires and dispatches autonomously', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('phase-5-team');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('promotes a Task, and the Leader hires, dispatches, and completes three Workers', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await page.getByTestId('team-toggle').click();
    await expect(page.getByTestId('team-list')).toBeVisible();

    // No manual hire UI exists anymore (FR-TEAM-06/13): with 0 Workers, the Canvas explains the
    // new model instead of offering a hire form.
    await expect(
      page.getByText('Leaderに依頼すると、必要に応じてWorkerを雇用します'),
    ).toBeVisible();
    await expect(page.getByTestId('team-hire')).toHaveCount(0);

    // The user only ever talks to the Leader — through the exact same composer a normal chat
    // uses, now re-parented into the Canvas (SurfaceLayer/App.tsx's morph).
    const composer = page.getByTestId('composer-textarea');
    await composer.fill(`${TEAM_TRIGGER}：新機能を進めてください`);
    await composer.press('Enter');

    // Three Worker nodes appear WITHOUT any user hire action, in the scenario's fixed role order.
    await expect(page.getByTestId('team-worker')).toHaveCount(3, { timeout: 20_000 });
    const cards = page.getByTestId('team-worker');
    for (const [index, role] of SCENARIO_ROLES.entries()) {
      await expect(cards.nth(index).locator('.role-name')).toHaveText(role);
    }

    // Hiring visibility (FR-TEAM-03): each hire fires a terse transient event line, in every
    // motion mode, complementing the spawn animation.
    await expect(page.getByTestId('team-cable-announcer')).toContainText('を雇用しました', {
      timeout: 20_000,
    });
    await expect(
      page.locator('.team-cable-event', { hasText: 'を雇用しました' }).first(),
    ).toBeVisible();

    // Each Worker shows exactly one Leaderから dispatch line and one 報告 line (6 total) — the
    // Leader dispatched to and received a report from every Worker on its own.
    await expect(page.locator('[data-testid="team-worker"] .w-line')).toHaveCount(6, {
      timeout: 20_000,
    });
    for (let index = 0; index < 3; index += 1) {
      await expect(cards.nth(index).locator('.team-status')).toHaveText('done', {
        timeout: 20_000,
      });
    }

    // The Leader's own timeline carries the synthesized final answer (main/team-tools.ts's
    // createTeamScenarioSampler final text).
    await expect(page.getByText('以上の報告を統合した結論です。')).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText('completed · Worker 3人')).toBeVisible();
    await expect(page.getByTestId('team-stop-all')).toBeDisabled();
  });

  test('restores an active Team as paused after restart', async () => {
    const restartDir = createUserDataDir('phase-5-team-restart');
    let restartApp: ElectronApplication | null = null;
    try {
      restartApp = await launchApp(restartDir);
      let page = await firstWindow(restartApp);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();

      // Setup note: this hires directly through the same TeamCoordinator.hireWorker the Leader's
      // own team_hire_worker tool call invokes (main/team-tools.ts registerTeamTools), rather than
      // driving the full チームテスト scenario end-to-end. The deterministic mock scenario hires
      // and dispatches to all three Workers within a single, effectively synchronous Leader Turn
      // (no artificial delay between "hired" and "dispatched" — see team-coordinator.ts's
      // sendToWorker/dispatchWithRetry), so there is no reliable, non-flaky window in which to
      // restart mid-scenario with a Worker still `ready` (never dispatched) rather than `done`.
      // Calling the coordinator method directly reproduces exactly that "hired, never dispatched"
      // state deterministically, which is what this test's restart/recovery assertion needs — the
      // recovery logic itself (persistence.recoverTeamsOnStartup) has no notion of who called
      // hireWorker.
      const taskId: string = await page.evaluate(
        async () => (await window.sprintCoder!.tasks.list())[0]!.id,
      );
      await page.evaluate(
        async (id) =>
          window.sprintCoder!.teams.hireWorker({
            taskId: id,
            role: '復元確認',
            objective: '再起動後の状態を確認する',
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          }),
        taskId,
      );
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await closeApp(restartApp);
      restartApp = await launchApp(restartDir);
      page = await firstWindow(restartApp);
      await page.getByTestId('team-toggle').click();
      await expect(page.getByText('paused · Worker 1人')).toBeVisible();
      await expect(page.locator('.team-status')).toHaveText('stopped');
    } finally {
      await closeApp(restartApp);
      removeUserDataDir(restartDir);
    }
  });

  test('natural team intent auto-promotes and auto-opens the canvas', async () => {
    const dir = createUserDataDir('phase-5-team-intent');
    let intentApp: ElectronApplication | null = null;
    try {
      intentApp = await launchApp(dir);
      const page = await firstWindow(intentApp);
      await page.getByTestId('sidebar-new-task-button').click();
      // No ⬡ Team click: saying 「チームで…」 must promote, open the canvas, and hire on its own.
      await page.getByTestId('composer-textarea').fill('チームでこの仕事を進めてください');
      await page.getByTestId('composer-send-button').click();
      await expect(page.getByTestId('team-list')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('team-worker')).toHaveCount(3, { timeout: 20_000 });
    } finally {
      await closeApp(intentApp);
      removeUserDataDir(dir);
    }
  });
});
