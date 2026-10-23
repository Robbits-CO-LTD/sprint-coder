import { expect, test } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

for (const workspace of [true, false]) {
  const layout = workspace ? 'workspace' : 'legacy';

  test(`local model settings opens external Provider connections (${layout})`, async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBe('chromium');
    const userDataDir = createUserDataDir(`local-provider-settings-${layout}`);
    const app = await launchApp(userDataDir, undefined, {
      SPRINT_CODER_MULTI_PROVIDER_MODEL_PICKER_V2: '1',
      SPRINT_CODER_SETTINGS_WORKSPACE_V2: workspace ? '1' : '0',
    });
    try {
      const page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      const trigger = page.getByTestId('model-picker-v2-trigger');
      const dialog = page.getByTestId('settings-dialog');
      const addConnection = page.getByTestId('settings-provider-add-toggle');
      await expect(trigger).toBeVisible();
      const initialConnections = await page.evaluate(async () =>
        (await window.sprintCoder!.providers.listConnections()).map(({ id }) => id).sort(),
      );

      for (const width of [1200, 720, 560]) {
        await app.evaluate(({ BrowserWindow }, nextWidth) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.setMinimumSize(360, 500);
          window.setContentSize(nextWidth, 900);
        }, width);

        // The shell keeps its existing dark palette. Exercise native controls under both OS
        // preferences without injecting a new application theme or changing application styles.
        for (const colorScheme of ['light', 'dark'] as const) {
          await app.evaluate(({ nativeTheme }, scheme) => {
            nativeTheme.themeSource = scheme;
          }, colorScheme);
          await trigger.focus();
          await page.keyboard.press('Enter');
          const localFilter = page.getByTestId('model-picker-v2-access-local');
          await expect(localFilter).toBeVisible();
          await localFilter.focus();
          await page.keyboard.press('Enter');
          await expect(localFilter).toHaveAttribute('aria-pressed', 'true');
          const providerSettings = page.getByRole('button', {
            name: 'プロバイダー接続を追加',
            exact: true,
          });
          await expect(providerSettings).toBeVisible();
          await expect(
            page.getByText('Local AI Selectorでモデルを追加', { exact: true }),
          ).toHaveCount(0);
          await providerSettings.focus();
          await page.keyboard.press('Enter');

          await expect(dialog).toBeVisible();
          await expect(addConnection).toBeFocused();
          await expect(addConnection).toBeInViewport();
          await expect(page.getByTestId('settings-nav-local-ai')).toHaveCount(0);
          await expect(dialog.locator('.settings-local-ai')).toHaveCount(0);
          expect(await page.evaluate(() => 'localAI' in window.sprintCoder!)).toBe(false);
          if (workspace) {
            await expect(page.getByTestId('settings-nav-models')).toHaveAttribute(
              'aria-current',
              'true',
            );
            await expect(page.getByTestId('settings-page-models')).toBeVisible();
          } else {
            await expect(dialog.locator('.settings-body')).toBeVisible();
            await expect(dialog.locator('.settings-nav')).toHaveCount(0);
          }

          await page.keyboard.press('Enter');
          const providerKind = page.getByTestId('settings-provider-kind');
          await expect(providerKind).toBeVisible();
          for (const [id, label] of [
            ['localai', 'LocalAI'],
            ['lm-studio', 'LM Studio'],
            ['ollama', 'Ollama'],
          ] as const) {
            await expect(providerKind.locator(`option[value="profile:${id}"]`)).toHaveText(label);
            await providerKind.selectOption(`profile:${id}`);
            await expect(providerKind).toHaveValue(`profile:${id}`);
            // Inspect the form only: no credentials, connection creation, verification, or AI.
            await expect(page.getByTestId('settings-provider-submit')).toBeDisabled();
          }
          await providerKind.focus();
          await page.keyboard.press('Tab');
          const name = page.getByTestId('settings-provider-name');
          await expect(name).toBeFocused();
          await expect(name).toBeInViewport();
          await expect
            .poll(() =>
              dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
            )
            .toBe(true);
          const screenshot = testInfo.outputPath(
            `local-provider-${layout}-${width}-${colorScheme}.png`,
          );
          await page.screenshot({ path: screenshot });
          await testInfo.attach(`Provider settings ${layout} ${width}px native-${colorScheme}`, {
            path: screenshot,
            contentType: 'image/png',
          });

          await page.keyboard.press('Escape');
          await expect(dialog).not.toBeVisible();
          await expect(trigger).toBeFocused();
        }
      }
      expect(
        await page.evaluate(async () =>
          (await window.sprintCoder!.providers.listConnections()).map(({ id }) => id).sort(),
        ),
      ).toEqual(initialConnections);
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });
}
