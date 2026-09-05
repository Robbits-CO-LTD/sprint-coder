import { expect, test } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test('hidden E2E accepts input and renders without showing or focusing its native window', async () => {
  const profile = createUserDataDir('hidden-window');
  const app = await launchApp(profile, undefined, { SPRINT_CODER_E2E_HIDDEN: '1' });
  try {
    const page = await firstWindow(app);
    const state = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
      );
    expect(await state()).toEqual([{ visible: false, focused: false }]);
    await page.getByTestId('sidebar-new-task-button').click();
    await page.getByTestId('composer-textarea').fill('Hidden window rendering test');
    await page.getByTestId('composer-send-button').click();
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed');
    await expect(page.getByTestId('user-message')).toHaveText('Hidden window rendering test');
    expect((await page.screenshot()).byteLength).toBeGreaterThan(1000);
    await app.evaluate(({ app }) => app.emit('activate'));
    expect(await state()).toEqual([{ visible: false, focused: false }]);
  } finally {
    await closeApp(app);
    removeUserDataDir(profile);
  }
});
