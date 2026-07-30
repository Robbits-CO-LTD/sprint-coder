import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

const LEGACY_PICKER_ENV = { SPRINT_CODER_MULTI_PROVIDER_MODEL_PICKER_V2: '0' };

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
    app = await launchApp(userDataDir, undefined, LEGACY_PICKER_ENV);
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

  test('keeps Runtime selection in the Composer instead of duplicating it in Settings', async () => {
    const page: Page = await firstWindow(app!);
    await page.getByTestId('sidebar-settings-button').click();
    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible();

    await expect(page.getByTestId('settings-nav-general')).toHaveCount(0);
    await expect(page.locator('[data-testid^="settings-runtime-"]')).toHaveCount(0);
    await expect(page.getByTestId('settings-nav-models')).toBeVisible();
    await expect(page.getByTestId('settings-model')).toBeVisible();
    await expect(page.getByTestId('settings-effort')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId('runtime-selector')).toBeVisible();
  });

  test('surfaces CLI detection status, which was previously only a tooltip', async () => {
    const page: Page = await firstWindow(app!);
    await page.getByTestId('sidebar-settings-button').click();
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await page.getByTestId('settings-nav-advanced').click();

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
    await page.getByTestId('settings-nav-skills').click();
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

  test('progressively reveals the add form, keeps optional fields folded, and clears the draft on cancel', async ({}, testInfo) => {
    const page: Page = await firstWindow(app!);
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
    });

    await page.getByTestId('sidebar-settings-button').click();
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await page.getByTestId('settings-nav-models').click();

    const addToggle = page.getByTestId('settings-provider-add-toggle');
    await expect(addToggle).toBeVisible();
    await expect(addToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('settings-provider-api-key')).toHaveCount(0);

    await addToggle.click();
    await expect(addToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('settings-provider-kind')).toBeVisible();
    await expect(page.getByTestId('settings-provider-name')).toBeVisible();
    const apiKey = page.getByTestId('settings-provider-api-key');
    await expect(apiKey).toBeVisible();
    await expect(apiKey).toHaveAttribute('type', 'password');

    await page
      .getByTestId('settings-provider-name')
      .fill(`日本語の検証用接続${'長い表示名'.repeat(12)}`);
    await apiKey.fill('dummy-key-not-submitted-0123456789');

    const reveal = page.getByTestId('settings-provider-api-key-reveal');
    await reveal.click();
    await expect(apiKey).toHaveAttribute('type', 'text');
    await expect(reveal).toHaveAttribute('aria-pressed', 'true');
    await reveal.click();
    await expect(apiKey).toHaveAttribute('type', 'password');

    const advanced = page.getByTestId('settings-provider-advanced');
    await expect(advanced).not.toHaveAttribute('open', '');
    await advanced.locator('summary').click();
    await expect(advanced).toHaveAttribute('open', '');
    await expect(page.getByText('組織ID（任意）', { exact: true })).toBeVisible();
    await expect(page.getByText('プロジェクトID（任意）', { exact: true })).toBeVisible();
    await expect(page.getByTestId('settings-provider-org')).toBeVisible();
    await expect(page.getByTestId('settings-provider-project')).toBeVisible();

    const badges = page.locator('.settings-connection-badge');
    await expect(badges.first()).toBeVisible();
    expect(await badges.first().evaluate((element) => element.tagName)).toBe('SPAN');

    await page.screenshot({
      path: testInfo.outputPath('provider-settings-open.png'),
      fullPage: true,
    });

    await page.getByTestId('settings-provider-cancel').click();
    await expect(page.getByTestId('settings-provider-api-key')).toHaveCount(0);
    await addToggle.click();
    await expect(page.getByTestId('settings-provider-name')).toHaveValue('');
    await expect(page.getByTestId('settings-provider-api-key')).toHaveValue('');

    await page.screenshot({
      path: testInfo.outputPath('provider-settings-reset.png'),
      fullPage: true,
    });
    expect(runtimeErrors).toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('shows one settings page at a time and persists a Team model restriction', async () => {
    const page: Page = await firstWindow(app!);
    await page.getByTestId('sidebar-settings-button').click();
    await expect(page.getByTestId('settings-page-models')).toBeVisible();
    await expect(page.getByTestId('settings-page-team')).toBeHidden();

    await page.getByTestId('settings-nav-team').click();
    await expect(page.getByTestId('settings-page-models')).toBeHidden();
    await expect(page.getByTestId('settings-page-team')).toBeVisible();

    const settings = page.getByTestId('settings-team-models');
    await settings.getByRole('radio', { name: '選択したモデルのみ' }).check();
    const modelChoices = settings.locator('.team-model-row input[type="checkbox"]');
    const count = await modelChoices.count();
    expect(count).toBeGreaterThan(1);
    for (let index = 0; index < count - 1; index += 1) await modelChoices.nth(index).uncheck();
    await settings.getByTestId('settings-team-models-save').click();
    await expect(settings.getByTestId('settings-team-models-save')).toBeDisabled();

    await page.keyboard.press('Escape');
    await page.getByTestId('sidebar-settings-button').click();
    await page.getByTestId('settings-nav-team').click();
    await expect(settings.locator('.team-model-row input[type="checkbox"]:checked')).toHaveCount(1);
    await page.keyboard.press('Escape');
  });
});
