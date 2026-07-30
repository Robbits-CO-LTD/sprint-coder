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

  // Issue #5 added the first modal in the app. A dialog is exactly where serious violations show
  // up (unlabelled dialog, unlabelled controls, an aria-hidden container holding focusable nodes),
  // so it gets its own pass with the dialog actually open.
  test('settings dialog open', async () => {
    const dir = createUserDataDir('a11y-axe-settings');
    let dialogApp: ElectronApplication | null = null;
    try {
      dialogApp = await launchApp(dir);
      const page: Page = await firstWindow(dialogApp);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('sidebar-settings-button').click();
      await expect(page.getByTestId('settings-dialog')).toBeVisible();
      // Wait for the open animation to finish before measuring. axe samples *computed* colours, so
      // mid-fade it reads every foreground at partial opacity and reports contrast failures for
      // text that is fine once settled — a false positive about a transient frame, not about the UI.
      await page.waitForFunction(() => {
        const dialogEl = document.querySelector('[data-testid="settings-dialog"]');
        return dialogEl !== null && dialogEl.getAnimations().length === 0;
      });

      const violations = await runAxeSerious(page);
      expect(violations, formatViolations(violations)).toEqual([]);
    } finally {
      await closeApp(dialogApp);
      removeUserDataDir(dir);
    }
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
      // Team mode fades the now-inert sidebar and task header out. On slower Linux runners that
      // transition can begin after the final Worker settles; axe would otherwise sample the
      // partially transparent text and report a contrast failure for a transient hidden frame.
      await page.waitForFunction(() => {
        const hiddenChrome = [
          document.querySelector('.sidebar'),
          document.querySelector('.task-header'),
        ];
        return hiddenChrome.every(
          (element) => element !== null && Number(getComputedStyle(element).opacity) <= 0.01,
        );
      });

      const canvasViolations = await runAxeSerious(page);
      expect(canvasViolations, formatViolations(canvasViolations)).toEqual([]);

      // --- Same settled Team, switched to List view. ---
      await page.getByTestId('team-view-toggle').click();
      await expect(page.locator('.team-list-view')).toBeVisible();
      await page.waitForFunction(() => {
        const hiddenChrome = [
          document.querySelector('.sidebar'),
          document.querySelector('.task-header'),
        ];
        return hiddenChrome.every(
          (element) => element !== null && Number(getComputedStyle(element).opacity) <= 0.01,
        );
      });

      const listViolations = await runAxeSerious(page);
      expect(listViolations, formatViolations(listViolations)).toEqual([]);
    } finally {
      await closeApp(canvasApp);
      removeUserDataDir(dir);
    }
  });
});
