import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  closeApp,
  completeSetupForFeatureTest,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
} from './helpers';

// docs/PRODUCT_AND_TECHNICAL_DESIGN.md §15.5 golden path (queue):
// 送信直後にもう1件入力してEnter(キュー追加)→キュー表示→Turn1完了後にTurn2が自動開始され完了する。
test.describe('golden path 3: queued input auto-starts as the next turn', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('golden-3-queue');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('a message queued during Turn 1 auto-starts as Turn 2 and completes', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);
    await completeSetupForFeatureTest(page);

    await page.getByTestId('sidebar-new-task-button').click();
    const textarea = page.getByTestId('composer-textarea');
    await expect(textarea).toBeVisible();

    const firstText = 'Turn1: golden-path-3 の最初の依頼';
    const secondText = 'Turn2: golden-path-3 の2件目の依頼';

    await textarea.fill(firstText);
    await textarea.press('Enter');

    const runCard = page.getByTestId('run-card');
    await expect(runCard).toBeVisible();
    await expect(runCard).toHaveAttribute('data-run-status', 'running');

    // While Turn 1 is still running, type a second message and press Enter: the composer's
    // default send mode while a turn is active is "queue", so this must be queued, not steered.
    await textarea.fill(secondText);
    await textarea.press('Enter');

    const queuedItem = page.getByTestId('queued-item');
    await expect(queuedItem).toBeVisible({ timeout: 5_000 });
    await expect(queuedItem).toContainText(secondText);
    await expect(queuedItem).toContainText('#1');

    // Turn 1 completes, the queued input is dequeued, and Turn 2 starts automatically.
    await expect(page.getByTestId('queued-item')).toHaveCount(0, { timeout: 20_000 });

    // Turn 2 runs to completion.
    await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 20_000 });

    const userMessages = page.getByTestId('user-message');
    const assistantMessages = page.getByTestId('assistant-message');
    await expect(userMessages).toHaveCount(2, { timeout: 20_000 });
    await expect(assistantMessages).toHaveCount(2, { timeout: 20_000 });
    await expect(userMessages.nth(0)).toHaveText(firstText);
    await expect(userMessages.nth(1)).toHaveText(secondText);
    await expect(assistantMessages.nth(0)).toContainText('決定論的なモック応答です');
    await expect(assistantMessages.nth(1)).toContainText('決定論的なモック応答です');
  });
});

test.describe('Composer interrupt keeps the existing queue behind the replacement turn', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('composer-interrupt');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('cancels Turn 1, starts the interruption, then runs the preserved queue', async () => {
    app = await launchApp(userDataDir, undefined, {
      SPRINT_CODER_E2E_HOLD_MOCK_STREAM_AFTER_FIRST_DELTA: '1',
    });
    const page: Page = await firstWindow(app);
    await completeSetupForFeatureTest(page);

    await page.getByTestId('sidebar-new-task-button').click();
    const textarea = page.getByTestId('composer-textarea');
    const firstText = 'Turn1: 割り込み前の長い処理';
    const queuedText = 'Turn3: 既存キューに残す依頼';
    const interruptText = 'Turn2: 今すぐ優先する割り込み依頼';

    await textarea.fill(firstText);
    await textarea.press('Enter');
    const runCard = page.getByTestId('run-card');
    await expect(runCard).toHaveAttribute('data-run-status', 'running');
    await expect(page.getByTestId('streaming-assistant-message')).toBeVisible();

    await textarea.fill(queuedText);
    await textarea.press('Enter');
    await expect(page.getByTestId('queued-item')).toContainText(queuedText);

    await textarea.fill(interruptText);
    const interruptButton = page.getByTestId('composer-interrupt-button');
    await expect(interruptButton).toHaveAccessibleName('割り込んで送信');
    const userMessages = page.getByTestId('user-message');
    await expect(userMessages).toHaveCount(1);
    await interruptButton.click();

    // Keep Turn 1 alive until the real stop-and-send replaces it. Only then release the fixture:
    // releasing before the click could let the queued input win the same timing race again.
    await expect(userMessages).toHaveCount(2);
    await expect(userMessages.nth(1)).toHaveText(interruptText);
    await expect(page.getByTestId('queued-item')).toContainText(queuedText);
    await app.evaluate(() => {
      process.env['SPRINT_CODER_E2E_HOLD_MOCK_STREAM_AFTER_FIRST_DELTA'] = '0';
    });

    // stopAndSend starts the interruption before the pre-existing queue. Once both finish, the
    // history order proves that the queue was retained rather than dropped or run first.
    await expect(userMessages).toHaveCount(3, { timeout: 30_000 });
    await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 30_000 });
    await expect(userMessages.nth(0)).toHaveText(firstText);
    await expect(userMessages.nth(1)).toHaveText(interruptText);
    await expect(userMessages.nth(2)).toHaveText(queuedText);
    await expect(page.getByTestId('queued-item')).toHaveCount(0);
  });
});
