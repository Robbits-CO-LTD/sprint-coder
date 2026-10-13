import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  closeApp,
  completeSetupForFeatureTest,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
} from './helpers';

// Issue #754: switching Tasks while the Team List view is open must never strand the user on
// "Teamを準備しています", and every Team view must let them return to Chat. Mock provider only.
test.describe('Team view survives Task switching (issue #754)', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('team-task-switch');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('creating and re-selecting Tasks from the List view stays operable', async () => {
    // Hold the Mock stream after its first delta so every Send can be stopped deterministically.
    app = await launchApp(userDataDir, undefined, {
      SPRINT_CODER_E2E_HOLD_MOCK_STREAM_AFTER_FIRST_DELTA: '1',
    });
    const page: Page = await firstWindow(app);
    await completeSetupForFeatureTest(page);
    const preparing = page.getByText('Teamを準備しています');
    const composer = page.getByTestId('composer-textarea');
    const activeTaskId = () => page.locator('.sb-row.active').first().getAttribute('data-task-id');
    const sidebarInert = () =>
      page.getByTestId('sidebar').evaluate((el) => el.closest('[inert]') !== null);
    // One Mock Send, stopped mid-stream, driven to the terminal "canceled" state. Waits only on
    // observable state (no fixed sleeps).
    const sendAndStop = async (text: string) => {
      await composer.fill(text);
      await composer.press('Enter');
      const runCard = page.getByTestId('run-card').last();
      await expect(runCard).toBeVisible();
      await expect(page.getByTestId('streaming-assistant-message')).toBeVisible({
        timeout: 15_000,
      });
      const stop = page.getByTestId('composer-send-button');
      await expect(stop).toHaveAttribute('aria-label', '実行を停止');
      await stop.click();
      await expect(runCard).toHaveAttribute('data-run-status', 'canceled', { timeout: 15_000 });
      await expect(page.getByTestId('streaming-assistant-message')).toHaveCount(0);
      await expect(composer).toBeEnabled();
    };

    // Task A needs a real conversation, otherwise it leaves the sidebar once Task B is created.
    await page.getByTestId('sidebar-new-task-button').click();
    await expect(composer).toBeVisible();
    const taskA = await activeTaskId();
    expect(taskA).toBeTruthy();
    await sendAndStop('team task switch: task A');
    await expect(page.getByTestId('assistant-message').first()).toBeVisible();

    // Open the Team, then check both views: the sidebar is inert in Canvas only.
    await page.getByTestId('team-toggle').click();
    await expect(page.getByTestId('team-list')).toBeVisible();
    if ((await page.locator('.team-list-view').count()) === 0) {
      await page.getByTestId('team-view-toggle').click();
    }
    await expect(page.locator('.team-list-view')).toBeVisible();
    await page.getByTestId('team-view-toggle').click();
    await expect(page.locator('.team-canvas')).toBeVisible();
    expect(await sidebarInert()).toBe(true);
    await page.getByTestId('team-view-toggle').click();
    await expect(page.locator('.team-list-view')).toBeVisible();
    expect(await sidebarInert()).toBe(false);

    // A -> B from the List view without returning to Chat.
    await page.getByTestId('sidebar-new-task-button').click();
    await expect(preparing).toHaveCount(0);
    await expect(composer).toBeVisible();
    await sendAndStop('operable on task B');
    const taskB = await activeTaskId();
    expect(taskB).toBeTruthy();
    expect(taskB).not.toBe(taskA);

    // B -> A from the List view again.
    await page.getByTestId('team-toggle').click();
    await expect(page.locator('.team-list-view')).toBeVisible();
    await page.locator(`[data-task-id="${taskA}"] .sb-item`).click();
    await expect(page.locator('.sb-row.active').first()).toHaveAttribute('data-task-id', taskA!);
    await expect(preparing).toHaveCount(0);
    await expect(composer).toBeVisible();
    await sendAndStop('operable back on task A');

    // The Team view can still be left through its own control.
    await page.getByTestId('team-toggle').click();
    await expect(page.getByTestId('team-list')).toBeVisible();
    await page.getByTestId('team-back').click();
    await expect(page.getByTestId('team-list')).toHaveCount(0);
    await expect(composer).toBeVisible();
  });
});
