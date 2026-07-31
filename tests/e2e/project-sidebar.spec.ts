import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('Project Context Hub sidebar (A2)', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;
  let page: Page;

  test.beforeAll(async () => {
    userDataDir = createUserDataDir('project-sidebar');
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('creates, moves, archives and restores Projects with keyboard-friendly controls', async () => {
    const addProject = page.getByRole('button', { name: 'Projectを作成' });
    await expect(addProject).toBeVisible();

    await addProject.click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Project名').fill('Alpha');
    await dialog.getByRole('button', { name: '作成' }).click();
    const alphaHeading = page.locator('[data-project-heading]').filter({ hasText: 'Alpha' });
    await expect(alphaHeading).toBeFocused();

    const alphaSection = page.locator('.sb-project').filter({ has: alphaHeading });
    const alphaMenu = alphaSection.getByLabel('Alphaのメニュー');
    await alphaMenu.focus();
    await alphaMenu.press('Enter');
    await alphaSection.getByRole('button', { name: '新しいTask' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('AlphaにTaskを作成');
    await dialog.getByRole('button', { name: '作成' }).click();

    const taskRow = alphaSection.locator('[data-task-id]');
    await expect(taskRow).toContainText('未開始');
    await expect(taskRow).toBeFocused();

    await addProject.click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Project名').fill('Beta');
    await dialog.getByRole('button', { name: '作成' }).click();
    const betaHeading = page.locator('[data-project-heading]').filter({ hasText: 'Beta' });
    await expect(betaHeading).toBeVisible();

    await taskRow.getByLabel('新しいタスクのメニュー').click();
    await taskRow.getByRole('button', { name: 'Projectを移動' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('移動先').selectOption({ label: 'Beta' });
    await dialog.getByRole('button', { name: '移動' }).click();
    const movedTask = page
      .locator('.sb-project')
      .filter({ has: betaHeading })
      .locator('[data-task-id]');
    await expect(movedTask).toContainText('新しいタスク');
    await expect(movedTask).toBeFocused();

    await alphaMenu.click();
    await alphaSection.getByRole('button', { name: 'アーカイブ' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'アーカイブ' }).click();
    await expect(page.getByRole('button', { name: /Archived Projects/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(alphaHeading).toBeFocused();

    await alphaSection.getByLabel('Alphaのメニュー').click();
    await alphaSection.getByRole('button', { name: '復元' }).click();
    await expect(alphaHeading).toBeFocused();

    await page.getByLabel('Project・Taskを検索').fill('Beta');
    await expect(betaHeading).toBeVisible();
    await expect(alphaHeading).toHaveCount(0);
  });
});
