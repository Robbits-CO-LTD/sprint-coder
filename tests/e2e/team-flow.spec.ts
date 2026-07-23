import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('Phase 5 Team flow', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('phase-5-team');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('promotes a Task, starts three Workers, returns results, and stops all', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await page.getByTestId('team-toggle').click();
    await expect(page.getByTestId('team-list')).toBeVisible();

    for (const [role, objective] of [
      ['実装', '機能を実装する'],
      ['レビュー', '変更をレビューする'],
      ['検証', '受け入れ条件を検証する'],
    ] as const) {
      await page.getByLabel('役割').fill(role);
      await page.getByLabel('目的').fill(objective);
      await page.getByTestId('team-hire').click();
      await expect(page.getByTestId('team-worker')).toHaveCount(
        role === '実装' ? 1 : role === 'レビュー' ? 2 : 3,
      );
      // The Canvas camera briefly flies to the newly spawned Worker card before settling back
      // to a view that fits everything; force it back to a known-good, fully-reachable layout
      // before the next hire/interaction so nothing is left off-screen mid-flight.
      await page.getByTestId('team-canvas-fit').click();
    }

    const cards = page.getByTestId('team-worker');
    for (let index = 0; index < 3; index += 1) {
      const card = cards.nth(index);
      await card.getByLabel('依頼').fill(`Worker ${index + 1} への依頼`);
      await card.getByRole('button', { name: 'Leaderから送信' }).click();
      await expect(card.locator('.team-status')).toHaveText('done');
    }

    await expect(page.locator('[data-testid="team-worker"] .w-line')).toHaveCount(6);
    await page.getByTestId('team-stop-all').click();
    await expect(page.getByText('completed · Worker 3/3')).toBeVisible();
  });

  test('restores an active Team as paused after restart', async () => {
    const restartDir = createUserDataDir('phase-5-team-restart');
    let restartApp: ElectronApplication | null = null;
    try {
      restartApp = await launchApp(restartDir);
      let page = await firstWindow(restartApp);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await page.getByLabel('役割').fill('復元確認');
      await page.getByLabel('目的').fill('再起動後の状態を確認する');
      await page.getByTestId('team-hire').click();
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await closeApp(restartApp);
      restartApp = await launchApp(restartDir);
      page = await firstWindow(restartApp);
      await page.getByTestId('team-toggle').click();
      await expect(page.getByText('paused · Worker 1/3')).toBeVisible();
      await expect(page.locator('.team-status')).toHaveText('stopped');
    } finally {
      await closeApp(restartApp);
      removeUserDataDir(restartDir);
    }
  });
});
