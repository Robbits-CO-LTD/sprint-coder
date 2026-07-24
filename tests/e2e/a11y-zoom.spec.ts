import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

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
  // Small tolerance for sub-pixel rounding under non-integer zoom factors.
  expect(
    overflow.docScrollWidth,
    `document overflows horizontally: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.docClientWidth + 2);
  expect(
    overflow.shellScrollWidth,
    `.app-shell overflows horizontally: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.shellClientWidth + 2);
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

  test('list view at 2.0x: no horizontal scroll, controls remain reachable', async () => {
    const dir = createUserDataDir('a11y-zoom-list');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page = await firstWindow(app);
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
