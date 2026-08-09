import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  closeApp,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
} from './helpers';

// docs/PRODUCT_AND_TECHNICAL_DESIGN.md §15.5 golden path 7 (partial):
// reduced motionとkeyboard-only操作。This spec covers the keyboard-only half: create a Task,
// type a message, and send it — all via Tab/Enter/typing, with no mouse click of any kind.
test.describe('keyboard-only smoke: create task, type, send without a mouse', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('keyboard-smoke');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('Task creation, composing, and sending complete via keyboard alone', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);

    // This smoke covers the established-app keyboard flow; the first-run wizard has its own E2E.
    // Mark setup complete before exercising the sidebar, then reload through the normal startup path.
    await page.evaluate(() => window.localStorage.setItem('sprint-coder:setup-complete-v1', '1'));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Reach the "+ new Task" control purely by tabbing (no .click()).
    await focusByKeyboard(page, 'sidebar-new-task-button');
    await page.keyboard.press('Enter');

    // Tab forward until the composer textarea receives focus, then type + send with Enter.
    await focusByKeyboard(page, 'composer-textarea', 80);

    const messageText = 'キーボードだけで送信します (keyboard-smoke)';
    await page.keyboard.type(messageText);
    await page.keyboard.press('Enter');

    const runCard = page.getByTestId('run-card');
    await expect(runCard).toBeVisible();
    await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 20_000 });

    await expect(page.getByTestId('user-message')).toHaveText(messageText);
    await expect(page.getByTestId('assistant-message')).toContainText('決定論的なモック応答です');
  });
});

/** Presses Tab repeatedly (never clicking) until document.activeElement carries the given
 * data-testid, so keyboard-only flows don't depend on hardcoding the exact tab-stop count. */
async function focusByKeyboard(page: Page, testId: string, maxPresses = 40): Promise<void> {
  for (let attempt = 0; attempt <= maxPresses; attempt++) {
    const activeTestId = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? null,
    );
    if (activeTestId === testId) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(
    `Could not reach element with data-testid="${testId}" via Tab within ${maxPresses} presses`,
  );
}
