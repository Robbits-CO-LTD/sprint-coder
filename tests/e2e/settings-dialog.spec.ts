import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #5: the sidebar's "設定" button had no onClick and was not disabled either, so it looked
// pressable and did nothing, and no settings screen existed in the renderer at all.

test.describe('settings dialog', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('settings-dialog');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('opens from the sidebar, closes by Escape and by the close button, and returns focus', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();

    const settingsButton = page.getByTestId('sidebar-settings-button');
    const dialog = page.getByTestId('settings-dialog');
    await expect(settingsButton).toBeEnabled();
    await expect(dialog).not.toBeVisible();

    await settingsButton.click();
    await expect(dialog).toBeVisible();

    // Escape closes it and focus lands back on the button that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(settingsButton).toBeFocused();

    // The close button closes it too, and also restores focus.
    await settingsButton.click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('settings-close').click();
    await expect(dialog).not.toBeVisible();
    await expect(settingsButton).toBeFocused();
  });

  test('traps focus inside the dialog while it is open', async () => {
    const page: Page = await firstWindow(app!);
    await page.getByTestId('sidebar-settings-button').click();
    await expect(page.getByTestId('settings-dialog')).toBeVisible();

    // Tab many times; focus must never leave the dialog subtree. This is what <dialog showModal>
    // buys over a hand-rolled overlay, and it is worth asserting rather than assuming.
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const dialogEl = document.querySelector('[data-testid="settings-dialog"]');
        return dialogEl !== null && dialogEl.contains(document.activeElement);
      });
      expect(inside, `focus escaped the dialog after ${i + 1} Tab presses`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).not.toBeVisible();
  });

  test('changes Runtime, model and effort by keyboard alone, and the change survives a restart', async () => {
    const page: Page = await firstWindow(app!);
    await page.getByTestId('sidebar-settings-button').click();
    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible();

    // Runtime is a real radio group: selecting Claude here is the same setting the Composer chip
    // edits, so the chip must follow.
    const claudeRadio = page.getByTestId('settings-runtime-claude').locator('input');
    await expect(claudeRadio).toBeEnabled();
    await claudeRadio.check();
    await expect(claudeRadio).toBeChecked();

    // Effort is Claude-only; with Claude selected it becomes usable, and the hint stops explaining
    // why it is not.
    const effort = page.getByTestId('settings-effort');
    await expect(effort).toBeEnabled();
    await effort.selectOption('xhigh');
    await expect(effort).toHaveValue('xhigh');

    const model = page.getByTestId('settings-model');
    await expect(model).toBeEnabled();
    await model.selectOption('sonnet');
    await expect(model).toHaveValue('sonnet');

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // The Composer chips reflect the same settings — one source of truth, not two.
    await expect(page.getByTestId('runtime-selector')).toHaveText('Claude Code');
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: X-High');
    await expect(page.getByTestId('model-selector')).toHaveText('Sonnet 5');

    // Durable: these go through the same persisted settings the chips use.
    await closeApp(app);
    app = await launchApp(userDataDir);
    const restarted: Page = await firstWindow(app);
    await restarted.getByTestId('sidebar-settings-button').click();
    await expect(restarted.getByTestId('settings-dialog')).toBeVisible();
    await expect(restarted.getByTestId('settings-runtime-claude').locator('input')).toBeChecked();
    await expect(restarted.getByTestId('settings-effort')).toHaveValue('xhigh');
    await expect(restarted.getByTestId('settings-model')).toHaveValue('sonnet');
  });

  test('surfaces CLI detection status, which was previously only a tooltip', async () => {
    const page: Page = await firstWindow(app!);
    // Dialog is still open from the previous test's restart.
    await expect(page.getByTestId('settings-dialog')).toBeVisible();

    for (const kind of ['codex', 'claude']) {
      const row = page.getByTestId(`settings-cli-${kind}`);
      await expect(row).toBeVisible();
      // Either detected or a stated reason — never blank, which is the failure mode a tooltip has.
      await expect(row).toHaveText(/検出済み|見つかりません|未検出/);
    }

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).not.toBeVisible();
  });
});
