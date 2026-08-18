import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeApp,
  completeSetupForFeatureTest,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
} from './helpers';

test.describe('Project Context Hub sidebar (A2)', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;
  let page: Page;
  let rootsDir: string;
  let test1: string;
  let test2: string;

  test.beforeAll(async () => {
    userDataDir = createUserDataDir('project-sidebar');
    rootsDir = mkdtempSync(join(tmpdir(), 'sprint-coder-project-roots-'));
    test1 = join(rootsDir, 'test1');
    test2 = join(rootsDir, 'test2');
    mkdirSync(test1);
    mkdirSync(test2);
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
    await completeSetupForFeatureTest(page);
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
    rmSync(rootsDir, { recursive: true, force: true });
  });

  test('creates, moves, archives and restores Projects with keyboard-friendly controls', async () => {
    await page.getByTestId('sidebar-new-task-button').click();
    const projectPicker = page.locator('.context-bar .project-picker-trigger');
    await projectPicker.click();
    const addProject = page.getByRole('button', { name: '新しいProject' });
    await expect(addProject).toBeVisible();

    await addProject.click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Project名').fill('Alpha');
    if (!app) throw new Error('app did not launch');
    await app.evaluate(
      ({ dialog: nativeDialog }, paths) => {
        Object.defineProperty(nativeDialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: paths }),
        });
      },
      [test1, test2],
    );
    await dialog.getByRole('button', { name: 'フォルダを選択' }).click();
    const folderRows = dialog.locator('.project-folder-list li');
    await expect(folderRows).toHaveCount(2);
    await expect(folderRows.nth(0).getByRole('radio')).toBeChecked();
    await folderRows.nth(1).getByRole('radio').check();
    await dialog.getByRole('button', { name: '作成' }).click();
    const alphaHeading = page.locator('[data-project-heading]').filter({ hasText: 'Alpha' });
    await expect(alphaHeading).toBeVisible();
    await expect(projectPicker).toBeFocused();

    const alphaSection = page.locator('.sb-project').filter({ has: alphaHeading });
    const alphaMenu = alphaSection.getByLabel('Alphaのメニュー');
    await alphaSection.getByRole('button', { name: 'AlphaにTaskを作成' }).click();

    const taskRow = alphaSection.locator('[data-task-id].active');
    await expect(taskRow).toContainText('未開始');
    await expect(taskRow).toBeFocused();

    await projectPicker.click();
    await addProject.click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Project名').fill('Beta');
    await dialog.getByRole('button', { name: '作成' }).click();
    const betaHeading = page.locator('[data-project-heading]').filter({ hasText: 'Beta' });
    await expect(betaHeading).toBeVisible();

    await projectPicker.click();
    const projectSearch = page.getByLabel('Projectを検索');
    await projectSearch.fill(test2);
    await expect(page.getByRole('option', { name: /Alpha/ })).toBeVisible();
    await projectSearch.fill('Beta');
    await projectSearch.press('ArrowDown');
    const betaOption = page.getByRole('option', { name: /Beta/ });
    await expect(betaOption).toBeFocused();
    await betaOption.press('Escape');
    await expect(projectPicker).toBeFocused();
    await projectPicker.click();
    await page.getByRole('option', { name: /Beta/ }).click();
    const movedTask = page
      .locator('.sb-project')
      .filter({ has: betaHeading })
      .locator('[data-task-id]');
    await expect(movedTask).toContainText('新しいタスク');
    await expect(projectPicker).toContainText('Beta');

    await projectPicker.click();
    await page.getByRole('button', { name: /Projectなしで作業/ }).click();
    await expect(projectPicker).toContainText('プロジェクトを選択');
    await projectPicker.click();
    await page.getByRole('option', { name: /Beta/ }).click();

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('Project picker started-task test');
    await textarea.press('Enter');
    await expect(page.getByText('Project picker started-task test').first()).toBeVisible();
    await expect(textarea).toBeEnabled();
    await projectPicker.click();
    await page.getByRole('option', { name: /Alpha/ }).click();
    await expect(projectPicker).toContainText('Alpha');
    await expect(alphaSection.locator('[data-task-id]')).toHaveCount(2);

    await textarea.fill('/new');
    await textarea.press('Enter');
    await expect(alphaSection.locator('[data-task-id]')).toHaveCount(3);

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
    // Search keeps the currently selected Task's Project navigable even when its name does not
    // match, so the Alpha task created by `/new` remains visible alongside the Beta result.
    await expect(alphaHeading).toBeVisible();

    await closeApp(app);
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
    await expect(page.locator('[data-project-heading]').filter({ hasText: 'Alpha' })).toBeVisible();
    const restoredAlpha = page
      .locator('.sb-project')
      .filter({ has: page.locator('[data-project-heading]').filter({ hasText: 'Alpha' }) });
    await restoredAlpha.getByLabel('Alphaのメニュー').click();
    await restoredAlpha.getByRole('button', { name: '名前を変更' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.locator('.project-folder-list li')).toHaveCount(2);
    await expect(dialog.locator('.project-folder-list li').nth(1).getByRole('radio')).toBeChecked();
    await dialog.getByRole('button', { name: 'キャンセル' }).click();
  });
});
