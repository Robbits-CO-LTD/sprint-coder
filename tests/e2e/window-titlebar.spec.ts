import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test('uses platform-owned traffic lights on macOS and product-owned controls on Windows', async () => {
  const userDataDir = createUserDataDir('window-titlebar');
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    const page = await firstWindow(app);
    const titlebar = page.getByTestId('app-titlebar');

    if (process.platform === 'linux') {
      await expect(titlebar).toHaveCount(0);
      return;
    }

    await expect(titlebar).toBeVisible();
    await expect(titlebar).toContainText('Sprint Coder');

    if (process.platform === 'darwin') {
      await expect(titlebar).toHaveAttribute('data-platform', 'darwin');
      await expect(page.getByRole('group', { name: 'ウィンドウ操作' })).toHaveCount(0);
      const trafficLights = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
      );
      expect(trafficLights).toEqual({ x: 14, y: 13 });
      return;
    }

    await expect(titlebar).toHaveAttribute('data-platform', 'win32');
    const minimize = page.getByRole('button', { name: '最小化' });
    const toggleMaximize = page.getByTestId('window-toggle-maximize');
    const close = page.getByRole('button', { name: '閉じる' });
    await expect(minimize).toBeVisible();
    await expect(toggleMaximize).toHaveAccessibleName('最大化');
    await expect(close).toBeVisible();

    const regions = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="app-titlebar"]');
      const control = document.querySelector<HTMLElement>('[data-testid="window-minimize"]');
      return {
        bar: bar === null ? null : getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
        control:
          control === null
            ? null
            : getComputedStyle(control).getPropertyValue('-webkit-app-region'),
      };
    });
    expect(regions).toEqual({ bar: 'drag', control: 'no-drag' });

    await toggleMaximize.click();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          Boolean(BrowserWindow.getAllWindows()[0]?.isMaximized()),
        ),
      )
      .toBe(true);
    await expect(toggleMaximize).toHaveAttribute('data-window-state', 'maximized');
    await expect(toggleMaximize).toHaveAccessibleName('元に戻す');

    await toggleMaximize.click();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          Boolean(BrowserWindow.getAllWindows()[0]?.isMaximized()),
        ),
      )
      .toBe(false);
    await expect(toggleMaximize).toHaveAttribute('data-window-state', 'restored');
    await expect(toggleMaximize).toHaveAccessibleName('最大化');

    await minimize.click();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          Boolean(BrowserWindow.getAllWindows()[0]?.isMinimized()),
        ),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
    await expect(titlebar).toBeVisible();

    const closed = app.waitForEvent('close');
    await close.click();
    await closed;
    app = null;
  } finally {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  }
});
