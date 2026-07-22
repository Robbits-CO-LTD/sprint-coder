import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  closeApp,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
  REPO_ROOT,
} from './helpers';

test.describe('command runner flow', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('command-runner-flow');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('denies safely and then executes the exact approved command once', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await app.evaluate(
      ({ dialog }, workspacePath) => {
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [workspacePath] }),
        });
      },
      REPO_ROOT,
    );
    await page.getByRole('button', { name: 'Workspace未選択' }).first().click();
    await expect(page.getByRole('button', { name: 'vibe-editor3' }).first()).toBeVisible();

    const textarea = page.getByTestId('composer-textarea');
    const card = page.getByTestId('approval-card');
    await textarea.fill('コマンドテストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    await expect(card).toContainText('run_command');
    await expect(card).toContainText(process.platform === 'win32' ? 'where.exe' : '/usr/bin/printf');
    await page.getByTestId('approval-deny').click();
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });

    await textarea.fill('コマンドテストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    await page.getByRole('button', { name: '今回のみ許可' }).click();
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });
  });
});
