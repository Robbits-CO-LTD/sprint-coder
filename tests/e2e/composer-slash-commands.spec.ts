import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('composer slash commands', () => {
  let app: ElectronApplication | null = null;
  let userDataDir: string;

  test.beforeEach(async () => {
    userDataDir = createUserDataDir('slash-commands');
    app = await launchApp(userDataDir);
  });

  test.afterEach(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('filters, navigates, dismisses, and runs commands from the composer', async () => {
    if (!app) throw new Error('app did not launch');
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    const textarea = page.getByTestId('composer-textarea');

    await textarea.fill('/');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible();
    await expect(page.getByTestId('slash-command-new')).toHaveAttribute('aria-selected', 'true');

    await textarea.press('ArrowDown');
    await expect(page.getByTestId('slash-command-goal')).toHaveAttribute('aria-selected', 'true');
    await textarea.press('Enter');
    await expect(page.getByTestId('composer-goal-armed')).toBeVisible();
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue('');
    await expect(textarea).toHaveAttribute(
      'placeholder',
      'Goalを入力（Enterで開始 / Escでキャンセル）',
    );

    await textarea.fill('認証まわりのリファクタを完了させる');
    await textarea.press('Enter');
    await expect(page.getByTestId('composer-goal-armed')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Goal: 完了' })).toContainText(
      '認証まわりのリファクタを完了させる',
    );
    await expect(page.getByTestId('composer-goal-input')).toHaveCount(0);

    await textarea.fill('/tea');
    await expect(page.getByTestId('slash-command-team')).toBeVisible();
    await expect(page.getByTestId('slash-command-goal')).toHaveCount(0);

    await textarea.press('Escape');
    await expect(page.getByTestId('slash-command-menu')).toHaveCount(0);
    await expect(textarea).toHaveValue('/tea');

    await textarea.fill('/team');
    await textarea.press('Tab');
    await expect(page.getByTestId('team-list')).toBeVisible();
    await expect(textarea).toHaveValue('');
  });

  test('does not send an unavailable command as a chat message', async () => {
    if (!app) throw new Error('app did not launch');
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    const textarea = page.getByTestId('composer-textarea');

    await textarea.fill('/image');
    const image = page.getByTestId('slash-command-image');
    await expect(image).toHaveAttribute('aria-disabled', 'true');
    await textarea.press('Enter');
    await expect(textarea).toHaveValue('/image');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible();
  });
});
