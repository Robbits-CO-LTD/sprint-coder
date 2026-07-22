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
