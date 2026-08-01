import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('composer input boundaries', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('composer-input-boundaries');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('preserves Shift+Enter, committed Japanese text, and long-input scrolling', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);

    await page.getByTestId('sidebar-new-task-button').click();
    const textarea = page.getByTestId('composer-textarea');
    await textarea.focus();

    const firstLine = '第一行：日本語入力テスト';
    const secondLine = `第二行：${'長文入力でも欠落や二重化を起こさない。'.repeat(20)}`;
    await page.keyboard.insertText(firstLine);
    await page.keyboard.press('Shift+Enter');
    // insertText follows the same committed-text path used after an IME confirms Japanese text.
    await page.keyboard.insertText(secondLine);

    const messageText = `${firstLine}\n${secondLine}`;
    await expect(textarea).toHaveValue(messageText);
    const geometry = await textarea.evaluate((element) => {
      const node = element as HTMLTextAreaElement;
      const composer = node.closest('.composer')?.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      return {
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        insideComposer:
          composer !== undefined && rect.left >= composer.left && rect.right <= composer.right,
      };
    });
    expect(geometry.clientHeight).toBeLessThanOrEqual(140);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.insideComposer).toBe(true);

    await textarea.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('user-message')).toHaveText(messageText);
  });
});
