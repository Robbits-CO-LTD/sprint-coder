import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test('first launch moves through setup once and lands in a usable Task', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  const userDataDir = createUserDataDir('setup-wizard');
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    let page = await firstWindow(app);

    const wizard = page.getByTestId('setup-wizard');
    await expect(wizard).toBeVisible();
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /アイデアから/ })).toBeVisible();
    await expect(wizard.locator('.setup-animation svg')).toBeVisible();
    await testInfo.attach('setup-welcome', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    await page.getByRole('button', { name: 'セットアップを始める' }).click();
    await expect(page.getByRole('heading', { name: '使うAIを確認' })).toBeVisible();
    await expect(wizard.getByText('Codex', { exact: true })).toBeVisible();
    await expect(wizard.getByText('Claude Code', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '続ける' }).click();
    await expect(page.getByRole('heading', { name: '作業場所を選ぶ' })).toBeVisible();
    await page.getByRole('button', { name: 'あとで設定' }).click();

    await expect(page.getByRole('heading', { name: '準備できました。' })).toBeVisible();
    await testInfo.attach('setup-ready', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.getByRole('button', { name: '最初のTaskを始める' }).click();
    await expect(wizard).not.toBeVisible();
    await expect(page.locator('.app-shell')).toHaveClass(/setup-reveal/);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('composer-textarea')).toBeVisible();
    await expect(page.locator('.app-shell')).not.toHaveClass(/setup-reveal/);

    await closeApp(app);
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
    await expect(page.getByTestId('setup-wizard')).toHaveCount(0);
    await expect(page.getByTestId('composer-textarea')).toBeVisible();
  } finally {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  }
});
