import { expect, test } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test('local AI search keeps its controls visible and keyboard-accessible across settings widths', async ({}, testInfo) => {
  const userDataDir = createUserDataDir('local-ai-settings-ui');
  const app = await launchApp(userDataDir);
  try {
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-settings-button').click();
    await page.getByTestId('settings-nav-local-ai').click();
    await page.getByRole('button', { name: 'モデルを探す', exact: true }).click();
    const section = page.getByTestId('settings-page-local-ai');
    const input = section.getByRole('textbox', { name: 'モデル名' });
    for (const width of [1200, 720, 560]) {
      await app.evaluate(({ BrowserWindow }, nextWidth) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setMinimumSize(360, 500);
        window.setContentSize(nextWidth, 900);
      }, width);
      await expect(input).toBeVisible();
      await expect(section.getByLabel('取得元', { exact: true })).toBeVisible();
      await expect(section.getByLabel('用途', { exact: true })).toBeVisible();
      await expect(section.getByLabel('互換モデルのみ')).toBeVisible();
      await expect(section.locator('.local-ai-selector-detail')).toBeHidden();
      await expect
        .poll(() => section.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
      await expect
        .poll(() =>
          section
            .locator('.local-ai-selector-toolbar')
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        )
        .toBe(true);
      await input.focus();
      await page.keyboard.press('Tab');
      await expect(section.getByRole('button', { name: '検索', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(section.getByLabel('取得元', { exact: true })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`local-ai-${width}.png`) });
    }
    await section.getByRole('button', { name: 'モデル管理に戻る' }).click();
    await expect(section.getByRole('heading', { name: '端末とモデル' })).toBeVisible();
  } finally {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  }
});
