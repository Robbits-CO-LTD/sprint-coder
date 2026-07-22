import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('approval flow', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('approval-flow');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('denial is persisted and returned to the runtime without failing the Turn', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('承認テストをしてください');
    await textarea.press('Enter');

    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await expect(card).toContainText('approval_probe');
    await expect(card).toContainText('https://example.test');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('assistant-message')).toContainText('決定論的なモック応答です');

    await page.getByTestId('sidebar-new-task-button').click();
    await textarea.fill('承認テストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed');
    await textarea.fill('承認テストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed');

    await page.getByTestId('sidebar-new-task-button').click();
    await textarea.fill('承認テストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed');
    await textarea.fill('承認テストをしてください');
    await textarea.press('Enter');
    await page.waitForTimeout(1_000);
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed');

    await page.getByTestId('sidebar-new-task-button').click();
    await textarea.fill('承認テストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    const runningApp = app;
    await Promise.race([
      runningApp.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('app shutdown stalled on pending approval')), 8_000),
      ),
    ]);
    app = null;
  });
});
