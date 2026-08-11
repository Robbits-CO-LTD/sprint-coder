import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  closeApp,
  completeSetupForFeatureTest,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
} from './helpers';

// Phase 7 (tasks/IMPLEMENTATION_PLAN.md §10.3): 200% zoom must not introduce horizontal scrolling
// on the app shell, and the composer/send controls must stay visible and clickable. Uses the real
// Electron `webContents.setZoomFactor` (page-zoom semantics, like Ctrl/Cmd-+ in a browser — shrinks
// the effective CSS-pixel viewport rather than just scaling text) via Playwright's
// `electronApp.browserWindow(page)` main-process handle, not a CSS transform stand-in.
async function setZoomFactor(app: ElectronApplication, page: Page, factor: number): Promise<void> {
  const win = await app.browserWindow(page);
  await win.evaluate((browserWindow, z) => browserWindow.webContents.setZoomFactor(z), factor);
  // Zoom is applied asynchronously; give layout a moment to settle before measuring.
  await page.waitForTimeout(150);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const shell = document.querySelector('.app-shell');
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      shellScrollWidth: shell?.scrollWidth ?? 0,
      shellClientWidth: shell?.clientWidth ?? 0,
    };
  });
  // Chromium can round the same 200% layout up by two physical pixels differently across macOS
  // runners (three CSS pixels at this viewport). Composer visibility/clickability is asserted
  // separately below, so this tolerance covers raster rounding rather than a clipped control.
  const roundingTolerance = 4;
  expect(
    overflow.docScrollWidth,
    `document overflows horizontally: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.docClientWidth + roundingTolerance);
  expect(
    overflow.shellScrollWidth,
    `.app-shell overflows horizontally: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.shellClientWidth + roundingTolerance);
}

async function assertComposerUsable(page: Page): Promise<void> {
  const textarea = page.getByTestId('composer-textarea');
  const sendButton = page.getByTestId('composer-send-button');
  await expect(textarea).toBeVisible();
  await expect(sendButton).toBeVisible();

  const viewport = await page.evaluate(() => ({
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  }));
  for (const locator of [textarea, sendButton]) {
    const box = await locator.boundingBox();
    expect(box, 'element has a bounding box (is laid out, not collapsed)').not.toBeNull();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.w + 2);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.h + 2);
  }

  // "clickable" — not just visible: type + send actually works at this zoom level.
  await textarea.fill('200%ズームでの送信確認');
  await sendButton.click();
  await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
    timeout: 20_000,
  });
}

test.describe('200% zoom (NFR-A11Y-01 adjacent)', () => {
  test('chat view at 2.0x: no horizontal scroll, composer usable', async () => {
    const dir = createUserDataDir('a11y-zoom-chat');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page = await firstWindow(app);
      await completeSetupForFeatureTest(page);
      await page.getByTestId('sidebar-new-task-button').click();
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      await setZoomFactor(app, page, 2.0);

      await assertNoHorizontalOverflow(page);
      await assertComposerUsable(page);
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });

  test('running Composer actions reflow at 150%, 200%, and a 320px effective viewport', async () => {
    const dir = createUserDataDir('a11y-zoom-composer-actions');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page = await firstWindow(app);
      await completeSetupForFeatureTest(page);
      await page.getByTestId('sidebar-new-task-button').click();
      const textarea = page.getByTestId('composer-textarea');
      await textarea.fill('承認テストをしてください');
      await textarea.press('Enter');
      await expect(page.getByTestId('approval-card')).toBeVisible();
      await textarea.fill('割り込んで送信する入力');

      const win = await app.browserWindow(page);
      for (const factor of [1.5, 2.0]) {
        await setZoomFactor(app, page, factor);
        await assertNoHorizontalOverflow(page);
        for (const control of [
          page.getByTestId('composer-interrupt-button'),
          page.getByTestId('composer-send-button'),
        ]) {
          await expect(control).toBeVisible();
          const box = await control.boundingBox();
          expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
        }
      }

      // Electron's product minimum width is 760 physical pixels. At 200% this already exercises
      // 380 CSS px; lower only the test window's minimum to cover WCAG's exact 320 CSS px reflow.
      await win.evaluate((browserWindow) => {
        browserWindow.setMinimumSize(640, 480);
        browserWindow.setSize(640, 800);
      });
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => document.documentElement.clientWidth)).toBeLessThanOrEqual(
        320,
      );
      await assertNoHorizontalOverflow(page);
      await expect(page.getByTestId('composer-interrupt-button')).toBeVisible();
      await expect(page.getByTestId('composer-send-button')).toBeVisible();
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });

  test('list view at 2.0x: no horizontal scroll, controls remain reachable', async () => {
    const dir = createUserDataDir('a11y-zoom-list');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page = await firstWindow(app);
      await completeSetupForFeatureTest(page);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      await page.getByTestId('team-view-toggle').click();
      await expect(page.locator('.team-list-view')).toBeVisible();

      await setZoomFactor(app, page, 2.0);

      await assertNoHorizontalOverflow(page);

      const viewport = await page.evaluate(() => ({
        w: document.documentElement.clientWidth,
        h: document.documentElement.clientHeight,
      }));
      const backButton = page.getByTestId('team-back');
      await expect(backButton).toBeVisible();
      const box = await backButton.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.w + 2);
      }
      await backButton.click();
      await expect(page.locator('.team-list-view')).not.toBeVisible();
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });
});
