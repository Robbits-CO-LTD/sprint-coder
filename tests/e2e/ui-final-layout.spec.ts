import { expect, test } from '@playwright/test';
import type { ConsoleMessage, ElectronApplication, Page, TestInfo } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

type BrowserErrors = {
  consoleErrors: string[];
  pageErrors: string[];
};

function collectBrowserErrors(page: Page): BrowserErrors {
  const errors: BrowserErrors = { consoleErrors: [], pageErrors: [] };
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => errors.pageErrors.push(error.message));
  return errors;
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function withFreshApp(
  label: string,
  testInfo: TestInfo,
  body: (page: Page, errors: BrowserErrors) => Promise<void>,
): Promise<void> {
  const userDataDir = createUserDataDir(label);
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    const page = await firstWindow(app);
    const errors = collectBrowserErrors(page);
    await page.getByTestId('sidebar-new-task-button').click();
    await expect(page.getByTestId('composer-textarea')).toBeVisible();
    await body(page, errors);
    await attachScreenshot(page, testInfo, label);
    expect(errors.pageErrors, 'uncaught renderer errors').toEqual([]);
    expect(errors.consoleErrors, 'renderer console errors').toEqual([]);
  } finally {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  }
}

test.describe('final UI layout gate', () => {
  test('keeps Composer controls ordered, visible, and interactive', async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBe('chromium');
    await withFreshApp('composer-final-layout', testInfo, async (page) => {
      const plus = page.getByTestId('composer-plus');
      const access = page.getByTestId('access-selector');
      const runControls = page.getByTestId('composer-run-controls');
      const model = page
        .getByTestId('model-picker-v2-trigger')
        .or(page.getByTestId('model-selector'));
      const effort = page.getByTestId('effort-selector');
      const send = page.getByTestId('composer-send-button');

      await expect(plus).toBeVisible();
      await expect(access).toBeVisible();
      await expect(runControls).toBeVisible();
      await expect(model).toBeVisible();
      await expect(effort).toBeVisible();
      await expect(send).toBeVisible();

      const layout = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>('.composer-row');
        const composer = document.querySelector<HTMLElement>('.composer');
        const byTestId = (id: string) =>
          document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.getBoundingClientRect();
        if (!row || !composer) return null;
        const rowBox = row.getBoundingClientRect();
        const composerBox = composer.getBoundingClientRect();
        const plusBox = byTestId('composer-plus');
        const accessBox = byTestId('access-selector');
        const controlsBox = byTestId('composer-run-controls');
        const modelBox = byTestId('model-picker-v2-trigger') ?? byTestId('model-selector');
        const effortBox = byTestId('effort-selector');
        const sendBox = byTestId('composer-send-button');
        if (!plusBox || !accessBox || !controlsBox || !modelBox || !effortBox || !sendBox)
          return null;
        return {
          plusBeforeAccess: plusBox.right <= accessBox.left + 1,
          accessBeforeControls: accessBox.right <= controlsBox.left + 1,
          modelBeforeEffort: modelBox.right <= effortBox.left + 1,
          controlsBeforeSend: controlsBox.right <= sendBox.left + 1,
          plusAtLeftEdge: Math.abs(plusBox.left - rowBox.left) <= 1,
          rowOverflow: row.scrollWidth - row.clientWidth,
          leftSlack: plusBox.left - composerBox.left,
          rightSlack: composerBox.right - sendBox.right,
        };
      });
      expect(layout).not.toBeNull();
      expect(layout).toMatchObject({
        plusBeforeAccess: true,
        accessBeforeControls: true,
        modelBeforeEffort: true,
        controlsBeforeSend: true,
        plusAtLeftEdge: true,
      });
      if (layout === null) return;
      expect(layout.rowOverflow).toBeLessThanOrEqual(1);
      expect(layout.leftSlack).toBeGreaterThanOrEqual(0);
      expect(layout.rightSlack).toBeGreaterThanOrEqual(0);

      await plus.click();
      await expect(plus).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.composer-plus-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(plus).toHaveAttribute('aria-expanded', 'false');

      await access.click();
      await expect(access).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('menu', { name: 'Access mode選択' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(access).toHaveAttribute('aria-expanded', 'false');

      await expect(model).toBeEnabled();
      await model.click();
      await expect(model).toHaveAttribute('aria-expanded', 'true');
      await expect(
        page.getByTestId('model-picker-v2').or(page.getByRole('menu', { name: /Model/ })),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(model).toHaveAttribute('aria-expanded', 'false');
    });
  });

  test('keeps the custom titlebar separate from content and Team policy visible', async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBe('chromium');
    await withFreshApp('titlebar-team-list-layout', testInfo, async (page) => {
      if (process.platform === 'darwin' || process.platform === 'win32') {
        const titlebar = page.getByTestId('app-titlebar');
        await expect(titlebar).toBeVisible();
        await expect(titlebar).toContainText('Sprint Coder');
        const titlebarLayout = await page.evaluate(() => {
          const bar = document.querySelector<HTMLElement>('[data-testid="app-titlebar"]');
          const shell = document.querySelector<HTMLElement>('.app-shell');
          if (!bar || !shell) return null;
          const b = bar.getBoundingClientRect();
          const s = shell.getBoundingClientRect();
          return {
            height: b.height,
            shellStartsAfterBar: s.top >= b.bottom - 1,
            dragRegion: getComputedStyle(bar).getPropertyValue('-webkit-app-region').trim(),
          };
        });
        expect(titlebarLayout).not.toBeNull();
        if (titlebarLayout !== null) {
          expect(titlebarLayout.height).toBeGreaterThanOrEqual(36);
          expect(titlebarLayout.shellStartsAfterBar).toBe(true);
          expect(titlebarLayout.dragRegion).toBe('drag');
        }
      }

      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      await page.getByTestId('team-view-toggle').click();
      await expect(page.getByTestId('team-list')).toHaveAttribute('aria-label', 'Team list');

      const headerFit = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>('[data-testid="team-list-header"]');
        const policy = document.querySelector<HTMLElement>('[data-testid="team-policy-open"]');
        if (!header || !policy) return null;
        const h = header.getBoundingClientRect();
        const p = policy.getBoundingClientRect();
        return {
          leftSlack: p.left - h.left,
          rightSlack: h.right - p.right,
          horizontalOverflow: header.scrollWidth - header.clientWidth,
        };
      });
      expect(headerFit).not.toBeNull();
      if (headerFit !== null) {
        expect(headerFit.leftSlack).toBeGreaterThanOrEqual(-1);
        expect(headerFit.rightSlack).toBeGreaterThanOrEqual(-1);
        expect(headerFit.horizontalOverflow).toBeLessThanOrEqual(1);
      }

      await page.getByTestId('team-policy-open').click();
      await expect(page.getByTestId('team-policy-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('team-policy-dialog')).toHaveCount(0);
    });
  });
});
