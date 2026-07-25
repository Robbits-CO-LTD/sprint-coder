import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #12: the sidebar was a fixed 264px with no way to collapse it, so at the 760px minimum
// window it took ~35% of the shell and the conversation column was left ~496px. These tests measure
// the conversation column rather than asserting on classes — the acceptance criterion is that the
// column keeps a usable width, not that a particular rule fired.

async function setZoomFactor(app: ElectronApplication, page: Page, factor: number): Promise<void> {
  const win = await app.browserWindow(page);
  await win.evaluate((browserWindow, z) => browserWindow.webContents.setZoomFactor(z), factor);
  await page.waitForTimeout(200);
}

async function setWindowSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const win = await app.browserWindow(page);
  await win.evaluate((browserWindow, size) => browserWindow.setSize(size.w, size.h), {
    w: width,
    h: height,
  });
  await page.waitForTimeout(250);
}

/** Width of the conversation column, i.e. what the sidebar is or is not taking from it. */
function mainWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('.main')?.getBoundingClientRect().width ?? 0);
}

function sidebarWidth(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0,
  );
}

test.describe('sidebar collapse', () => {
  test('collapsing gives the conversation column the sidebar width back, and the state persists', async () => {
    const dir = createUserDataDir('sidebar-collapse-wide');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      let page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      // A wide window still shows the Task history by default — the pre-issue behaviour.
      const toggle = page.getByTestId('sidebar-toggle');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(await sidebarWidth(page)).toBeGreaterThan(200);
      const expandedMain = await mainWidth(page);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // The point of collapsing: the width is *returned*, not just hidden.
      expect(await sidebarWidth(page)).toBe(0);
      expect(await mainWidth(page)).toBeGreaterThan(expandedMain + 200);

      // Persisted across a restart (localStorage, same as the Team view preference).
      await closeApp(app);
      app = await launchApp(dir);
      page = await firstWindow(app);
      await expect(page.getByTestId('composer-textarea')).toBeVisible();
      await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
      expect(await sidebarWidth(page)).toBe(0);

      // ...and reopening works and persists too, so the preference is not one-way.
      await page.getByTestId('sidebar-toggle').click();
      await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true');
      expect(await sidebarWidth(page)).toBeGreaterThan(200);
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });

  test('at the minimum window size the sidebar starts collapsed and opens as an overlay', async () => {
    const dir = createUserDataDir('sidebar-collapse-narrow');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      // main/index.ts pins the minimum window to 760x560.
      await setWindowSize(app, page, 760, 560);

      // Narrow starts collapsed, so the conversation gets the full shell instead of ~496px of it.
      const toggle = page.getByTestId('sidebar-toggle');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const viewport = await page.evaluate(() => document.documentElement.clientWidth);
      expect(await mainWidth(page)).toBeGreaterThan(viewport - 4);

      // Opening it overlays rather than shrinking the conversation — that is what makes it usable
      // at this size at all.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(await sidebarWidth(page)).toBeGreaterThan(100);
      expect(await mainWidth(page)).toBeGreaterThan(viewport - 4);

      // The scrim dismisses it, and focus/interaction returns to the conversation.
      await page.getByTestId('sidebar-scrim').click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('sidebar-scrim')).toHaveCount(0);
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });

  test('150% zoom keeps the conversation usable and free of horizontal scroll', async () => {
    // The existing a11y-zoom spec covers 200%; 150% is the other magnification the issue names, and
    // it is the more awkward one because it is a non-integer factor.
    const dir = createUserDataDir('sidebar-collapse-zoom150');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      await setZoomFactor(app, page, 1.5);

      const overflow = await page.evaluate(() => ({
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.docScrollWidth).toBeLessThanOrEqual(overflow.docClientWidth + 2);

      // Sending still works at this magnification, with the sidebar in whatever state the
      // breakpoint put it.
      await page.getByTestId('composer-textarea').fill('150%ズームでの送信確認');
      await page.getByTestId('composer-send-button').click();
      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
        timeout: 30_000,
      });
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });
});
