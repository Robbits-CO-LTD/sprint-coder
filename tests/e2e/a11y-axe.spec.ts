import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';
import { formatViolations, runAxeSerious, stopAxeServer } from './a11y-helpers';

// Phase 7 accessibility gate (tasks/IMPLEMENTATION_PLAN.md §10.3): axe-core pass over the real
// running app instead of an isolated jsdom component harness — see a11y-helpers.ts's doc comment
// for why. Covers the four states the task calls out: chat view, team canvas (populated), list
// view, and a visible approval card.
test.describe('axe: no serious/critical violations', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('a11y-axe');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
    stopAxeServer();
  });

  test('chat view (empty + populated)', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await expect(page.getByTestId('composer-textarea')).toBeVisible();

    const emptyViolations = await runAxeSerious(page);
    expect(emptyViolations, formatViolations(emptyViolations)).toEqual([]);

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('axeチェック用のメッセージ');
    await textarea.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });

    const populatedViolations = await runAxeSerious(page);
    expect(populatedViolations, formatViolations(populatedViolations)).toEqual([]);
  });

  test('approval card visible state', async () => {
    const dir = createUserDataDir('a11y-axe-approval');
    let approvalApp: ElectronApplication | null = null;
    try {
      approvalApp = await launchApp(dir);
      const page = await firstWindow(approvalApp);
      await page.getByTestId('sidebar-new-task-button').click();
      const textarea = page.getByTestId('composer-textarea');
      await textarea.fill('承認テストをしてください');
      await textarea.press('Enter');
      await expect(page.getByTestId('approval-card')).toBeVisible();

      const violations = await runAxeSerious(page);
      expect(violations, formatViolations(violations)).toEqual([]);
    } finally {
      await closeApp(approvalApp);
      removeUserDataDir(dir);
    }
  });

  test('team canvas (populated with 3 workers)', async () => {
    const dir = createUserDataDir('a11y-axe-canvas');
    let canvasApp: ElectronApplication | null = null;
    try {
      canvasApp = await launchApp(dir);
      const page = await firstWindow(canvasApp);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      const composer = page.getByTestId('composer-textarea');
      await composer.fill('チームテスト：axeチェック用');
      await composer.press('Enter');
      await expect(page.getByTestId('team-worker')).toHaveCount(3, { timeout: 20_000 });
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await expect(page.getByTestId('team-worker').nth(i).locator('.team-status')).toHaveText(
          'done',
          { timeout: 20_000 },
        );
      }

      const canvasViolations = await runAxeSerious(page);
      expect(canvasViolations, formatViolations(canvasViolations)).toEqual([]);

      // --- Same settled Team, switched to List view. ---
      await page.getByTestId('team-view-toggle').click();
      await expect(page.locator('.team-list-view')).toBeVisible();

      const listViolations = await runAxeSerious(page);
      expect(listViolations, formatViolations(listViolations)).toEqual([]);
    } finally {
      await closeApp(canvasApp);
      removeUserDataDir(dir);
    }
  });
});
