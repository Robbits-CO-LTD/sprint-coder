import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  closeApp,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
} from './helpers';

// docs/PRODUCT_AND_TECHNICAL_DESIGN.md §15.5 golden path 1:
// 新規Task → message → streaming answer → restart → 復元。
test.describe('golden path 1: new task, streaming answer, restart, restore', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('golden-1');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('message and streamed answer survive an app restart', async () => {
    const messageText = 'このリポジトリの構成を教えて (golden-path-1)';

    // --- First launch: create a task, send a message, watch it stream, then complete. ---
    app = await launchApp(userDataDir);
    let page: Page = await firstWindow(app);

    await page.getByTestId('sidebar-new-task-button').click();

    const textarea = page.getByTestId('composer-textarea');
    await expect(textarea).toBeVisible();
    await textarea.fill(messageText);
    await textarea.press('Enter');

    // Run Card appears and progresses through the mock runtime's 4 stages.
    const runCard = page.getByTestId('run-card');
    await expect(runCard).toBeVisible();
    await expect(runCard).toHaveAttribute('data-run-status', 'running');

    // Streaming body text appears before the turn finishes.
    const streamingBubble = page.getByTestId('streaming-assistant-message');
    await expect(streamingBubble).toBeVisible({ timeout: 15_000 });
    await expect(streamingBubble).not.toHaveText('', { timeout: 5_000 });

    // Turn completes.
    await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 20_000 });

    const userMessage = page.getByTestId('user-message');
    const assistantMessage = page.getByTestId('assistant-message');
    await expect(userMessage).toHaveText(messageText);
    await expect(assistantMessage).toContainText('決定論的なモック応答です');
    const assistantTextBeforeRestart = await assistantMessage.textContent();

    // --- Restart the app against the SAME userData dir. ---
    await closeApp(app);
    app = await launchApp(userDataDir);
    page = await firstWindow(app);

    // The task is auto-selected (it's the only one) and both messages are restored from SQLite.
    await expect(page.getByTestId('user-message')).toHaveText(messageText, { timeout: 15_000 });
    await expect(page.getByTestId('assistant-message')).toHaveText(
      assistantTextBeforeRestart ?? '',
    );
  });
});
