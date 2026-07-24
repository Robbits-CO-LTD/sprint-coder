import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('runtime model and access settings', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('model-access-settings');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('selects and restores a Codex model and an Access preset', async () => {
    app = await launchApp(userDataDir);
    let page: Page = await firstWindow(app);
    if ((await page.getByTestId('runtime-selector').count()) === 0)
      await page.getByTestId('empty-state-create-task-button').click();

    await page.getByTestId('runtime-selector').click();
    const codexOption = page.getByTestId('runtime-option-codex');
    await expect(codexOption).toBeEnabled();
    await codexOption.click();

    await expect(page.getByTestId('model-selector')).toBeEnabled();
    await page.getByTestId('model-selector').click();
    await page.getByTestId('model-option-gpt-5.6-terra').click();
    await expect(page.getByTestId('model-selector')).toHaveText('GPT-5.6-Terra');

    await page.getByTestId('access-selector').click();
    await page.getByTestId('access-option-auto').click();
    await expect(page.getByTestId('access-selector')).toHaveText('安全時は自動');

    await closeApp(app);
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
    await expect(page.getByTestId('runtime-selector')).toHaveText('Codex');
    await expect(page.getByTestId('model-selector')).toHaveText('GPT-5.6-Terra');
    await expect(page.getByTestId('access-selector')).toHaveText('安全時は自動');
  });
});

test.describe('claude model clarity and effort settings', () => {
  // Own describe block with its own userDataDir/app: the sibling suite above never closes its
  // `app` after its final (re-)launch, so sharing state would race two Electron instances against
  // the same userDataDir (single-instance-lock collision) — see the fix history on this file.
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('claude-model-effort-settings');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('shows clarified Claude model labels and persists a selected effort level', async () => {
    app = await launchApp(userDataDir);
    let page: Page = await firstWindow(app);
    if ((await page.getByTestId('runtime-selector').count()) === 0)
      await page.getByTestId('empty-state-create-task-button').click();

    await page.getByTestId('runtime-selector').click();
    const claudeOption = page.getByTestId('runtime-option-claude');
    await expect(claudeOption).toBeEnabled();
    await claudeOption.click();
    await expect(page.getByTestId('runtime-selector')).toHaveText('Claude Code');

    // Task 1: the curated Claude model list now spells out the concrete resolved model id in
    // each entry's displayName rather than a bare "Sonnet"/"Opus"/"Haiku" label.
    await expect(page.getByTestId('model-selector')).toBeEnabled();
    await page.getByTestId('model-selector').click();
    await expect(page.getByTestId('model-option-sonnet')).toContainText('Sonnet 5');
    await expect(page.getByTestId('model-option-opus')).toContainText('Opus 4.8');
    await expect(page.getByTestId('model-option-haiku')).toContainText('Haiku 4.5');
    await expect(page.getByTestId('model-option-auto')).toContainText('claude-sonnet-5');
    await page.getByTestId('model-option-auto').click();

    // Task 2: the effort chip is a real interactive control for Claude (not the static
    // "effort: medium" placeholder), and the selection survives an app restart.
    await expect(page.getByTestId('effort-selector')).toBeEnabled();
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: Medium');
    await page.getByTestId('effort-selector').click();
    await page.getByTestId('effort-option-high').click();
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: High');

    await closeApp(app);
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
    await expect(page.getByTestId('runtime-selector')).toHaveText('Claude Code');
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: High');

    // Switching to mock disables the effort selector again (Claude-only control) without losing
    // the persisted preference.
    await page.getByTestId('runtime-selector').click();
    await page.getByTestId('runtime-option-mock').click();
    await expect(page.getByTestId('effort-selector')).toBeDisabled();
  });
});
