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

// docs/PRODUCT_AND_TECHNICAL_DESIGN.md §15.5 golden path (cancel):
// 送信 → streaming中に「停止」→ 部分回答が保持され状態表示が中止系になる。
test.describe('golden path 2: cancel mid-stream keeps the partial answer', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('golden-2-cancel');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('stopping a running turn keeps the partial answer and shows a canceled state', async () => {
    app = await launchApp(userDataDir, undefined, {
      SPRINT_CODER_E2E_HOLD_MOCK_STREAM_AFTER_FIRST_DELTA: '1',
    });
    const page: Page = await firstWindow(app);
    await completeSetupForFeatureTest(page);

    await page.getByTestId('sidebar-new-task-button').click();
    const textarea = page.getByTestId('composer-textarea');
    await expect(textarea).toBeVisible();
    await textarea.fill('変更をテストして、結果を要約して (golden-path-2)');
    await textarea.press('Enter');

    const runCard = page.getByTestId('run-card');
    await expect(runCard).toBeVisible();

    // Wait until streaming has actually begun (the bubble only mounts once the first delta has
    // arrived, so its text is guaranteed non-empty as soon as it's visible) then stop immediately.
    const streamingBubble = page.getByTestId('streaming-assistant-message');
    await expect(streamingBubble).toBeVisible({ timeout: 15_000 });
    const partialTextAtStop = await streamingBubble.textContent();
    expect(partialTextAtStop?.length ?? 0).toBeGreaterThan(0);

    // The empty running Composer replaces its send arrow with the native stop control. This is
    // intentionally a separate entry point from RunCard's existing stop button.
    const composerStop = page.getByTestId('composer-send-button');
    await expect(composerStop).toHaveAttribute('aria-label', '実行を停止');
    await expect(composerStop).not.toBeDisabled();
    await composerStop.click();

    // Status transitions to a "canceled" terminal state (中止).
    await expect(runCard).toHaveAttribute('data-run-status', 'canceled', { timeout: 15_000 });
    await expect(runCard).toContainText('中止');

    // The partial answer is retained as a real message in the timeline, not discarded.
    const assistantMessage = page.getByTestId('assistant-message');
    await expect(assistantMessage).toBeVisible();
    const keptText = await assistantMessage.textContent();
    expect(keptText?.length ?? 0).toBeGreaterThan(0);

    // No streaming bubble should remain once the turn is terminal.
    await expect(page.getByTestId('streaming-assistant-message')).toHaveCount(0);
  });
});
