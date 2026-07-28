import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #5: the sidebar's "設定" button had no onClick and was not disabled either, so it looked
// pressable and did nothing, and no settings screen existed in the renderer at all.

test.describe('settings dialog', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('settings-dialog');
    const skill = join(userDataDir, '.claude', 'skills', 'e2e-writer');
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: e2e-writer\ndescription: E2E fixture\n---\n',
    );
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

  test('never offers full access as an inherited default for a new Task', async () => {
    const page: Page = await firstWindow(app!);
    await page.getByTestId('sidebar-settings-button').click();
    const accessDefault = page.getByTestId('settings-access-default');
    await expect(accessDefault).toBeVisible();
    await expect(accessDefault.locator('option')).toHaveText([
      '前回選択した設定',
      '毎回確認',
      '安全時は自動',
    ]);
    await expect(accessDefault.locator('option[value="full"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('previews and imports a detected Skill using the typed settings bridge', async () => {
    const page: Page = await firstWindow(app!);
    await page.getByTestId('sidebar-settings-button').click();
    await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible();
    await expect(page.getByText('1件検出', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '候補を選択' }).click();
    const candidate = page.getByText('e2e-writer', { exact: true });
    await expect(candidate).toBeVisible();
    await candidate.locator('xpath=ancestor::label').locator('input').check();
    await page.getByRole('button', { name: '内容を確認' }).click();
    await expect(page.getByText(/含まれるファイル 1件/)).toBeVisible();
    await page.getByRole('button', { name: '1件を読み込む' }).click();
    await expect(page.getByText('読み込み済み', { exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
  });
});
