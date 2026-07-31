import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #9: SurfaceFooter was the only §4.2 ChatSurface element never built. Recovery and Runtime
// liveness both existed in main and both were thrown away before reaching the renderer.

test.describe('surface footer', () => {
  test('stays hidden during ordinary idle and running states', async () => {
    const dir = createUserDataDir('surface-footer-connection');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      const footer = page.getByTestId('surface-footer');
      await expect(footer).toHaveCount(0);

      await page.getByTestId('composer-textarea').fill('フッタの接続表示を確認');
      await page.getByTestId('composer-textarea').press('Enter');
      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'running', {
        timeout: 20_000,
      });
      await expect(footer).toHaveCount(0);

      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
        timeout: 30_000,
      });
      await expect(footer).toHaveCount(0);
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });

  test('reports Runs that were interrupted by a crash, and the notice can be dismissed', async () => {
    // The acceptance criterion is "復元が起きた起動時に、その旨がフッタに表示される". Reproduced for
    // real rather than mocked: start a Turn, kill the app mid-flight, and relaunch — the startup
    // sweep finalises the in-flight Turn as `interrupted`, which is exactly the state the footer
    // exists to surface.
    const dir = createUserDataDir('surface-footer-recovery');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      let page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('composer-textarea').fill('クラッシュ復元の確認用に長めの依頼');
      await page.getByTestId('composer-textarea').press('Enter');
      // Wait until the Turn is genuinely in flight before pulling the plug.
      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'running', {
        timeout: 20_000,
      });

      await closeApp(app);
      app = await launchApp(dir);
      page = await firstWindow(app);

      const notice = page.getByTestId('surface-footer-recovery');
      await expect(notice).toBeVisible({ timeout: 20_000 });
      await expect(notice).toContainText('中断として確定');
      await expect(notice).toContainText('1件');

      // Dismissible, since it is a launch-scoped fact rather than a standing condition.
      await page.getByTestId('surface-footer-recovery-dismiss').click();
      await expect(notice).toHaveCount(0);
      // With no remaining abnormal state, dismissing the notice removes the whole footer.
      await expect(page.getByTestId('surface-footer')).toHaveCount(0);
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });

  test('stays hidden on the Canvas Leader node while the Runtime is healthy', async () => {
    const dir = createUserDataDir('surface-footer-canvas');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      await expect(page.getByTestId('surface-footer')).toHaveCount(0);
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });
});
