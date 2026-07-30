import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #13: the Composer's only extra affordance was a permanently-`disabled` paperclip button —
// it advertised attachment support the app does not have and could not be acted on at all.
//
// Each test owns its app and userData dir. Sharing one across a describe block (as some older specs
// here do) means the first failure leaves `app` null for every test after it, so one real failure
// reports as four.
async function withApp(
  label: string,
  body: (page: Page, app: ElectronApplication) => Promise<void>,
): Promise<void> {
  const dir = createUserDataDir(label);
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(dir);
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await expect(page.getByTestId('composer-textarea')).toBeVisible();
    await body(page, app);
  } finally {
    await closeApp(app);
    removeUserDataDir(dir);
  }
}

test.describe('composer plus menu', () => {
  test('opens by keyboard, navigates with arrows and Home/End, and Escape returns focus', async () => {
    await withApp('composer-plus-keys', async (page) => {
      const plus = page.getByTestId('composer-plus');
      await expect(plus).toBeEnabled();
      await expect(plus).toHaveAttribute('aria-expanded', 'false');

      // ArrowDown on the trigger opens the menu and lands on the first item — the standard
      // menu-button keys the existing Runtime/Model/Effort chips do not implement.
      await plus.focus();
      await page.keyboard.press('ArrowDown');
      await expect(plus).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('composer-menu-attach')).toBeFocused();

      // Arrows move and wrap.
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('composer-menu-imagegen')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('composer-menu-attach')).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(page.getByTestId('composer-menu-imagegen')).toBeFocused();

      // Home/End jump to the ends.
      await page.keyboard.press('Home');
      await expect(page.getByTestId('composer-menu-attach')).toBeFocused();
      await page.keyboard.press('End');
      await expect(page.getByTestId('composer-menu-imagegen')).toBeFocused();

      // ArrowUp on the trigger opens onto the *last* item.
      await page.keyboard.press('Escape');
      await expect(plus).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(page.getByTestId('composer-menu-imagegen')).toBeFocused();

      // Escape closes and hands focus back to the trigger.
      await page.keyboard.press('Escape');
      await expect(plus).toHaveAttribute('aria-expanded', 'false');
      await expect(plus).toBeFocused();
    });
  });

  test('closes on an outside click without hijacking focus', async () => {
    await withApp('composer-plus-outside', async (page) => {
      await page.getByTestId('composer-plus').click();
      await expect(page.locator('.composer-plus-menu')).toBeVisible();
      // Click the timeline, not the textarea: the menu opens upward over the composer input (as the
      // three existing chip popovers do), so the input is not "outside" while it is open.
      await page.locator('.timeline-scroll').click({ position: { x: 20, y: 20 } });
      await expect(page.locator('.composer-plus-menu')).toHaveCount(0);
      await expect(page.getByTestId('composer-plus')).toHaveAttribute('aria-expanded', 'false');
    });
  });

  test('does not expose a separate Goal input or plus-menu control', async () => {
    await withApp('composer-no-separate-goal-input', async (page) => {
      await expect(page.getByTestId('task-goal-chip')).toHaveCount(0);
      const textarea = page.getByTestId('composer-textarea');
      await expect(textarea).toHaveAttribute(
        'placeholder',
        'メッセージを送信 (Enterで送信 / Shift+Enterで改行)',
      );

      await page.getByTestId('composer-plus').click();
      await expect(page.getByTestId('composer-menu-goal')).toHaveCount(0);
      await expect(page.getByTestId('composer-goal-input')).toHaveCount(0);
    });
  });

  test('unavailable items stay focusable and state their reason', async () => {
    await withApp('composer-plus-unavailable', async (page) => {
      await page.getByTestId('composer-plus').click();

      // `aria-disabled`, not the `disabled` attribute: a disabled attribute drops the item out of
      // the focus order and takes its explanation with it.
      for (const id of ['attach', 'imagegen']) {
        const item = page.getByTestId(`composer-menu-${id}`);
        await expect(item).toHaveAttribute('aria-disabled', 'true');
        // The `disabled` *attribute* must be absent — that is what would drop the item out of the
        // focus order and take its explanation with it. (Playwright's toBeEnabled() reports
        // aria-disabled as disabled too, so focusability is the property to assert directly.)
        expect(await item.evaluate((el) => (el as HTMLButtonElement).disabled)).toBe(false);
        await item.focus();
        await expect(item).toBeFocused();
      }

      // Mock runtime is selected, so image generation states the Runtime requirement rather than a
      // generic "unavailable".
      await expect(page.getByTestId('composer-menu-imagegen')).toContainText('Codex Runtime');
      await expect(page.getByTestId('composer-menu-attach')).toContainText('未実装');

      // Activating an unavailable item does nothing and the menu stays put.
      // `force` because Playwright's actionability check treats aria-disabled as disabled and would
      // refuse the click; the point here is precisely what happens when a user does click it.
      await page.getByTestId('composer-menu-attach').click({ force: true });
      await expect(page.getByTestId('composer-plus')).toHaveAttribute('aria-expanded', 'true');
    });
  });

  test('the menu stays inside the Leader node on the Team Canvas', async () => {
    // `.team-canvas` is `overflow: clip` and the Leader node is a fixed 720x620, so a popover that
    // opens downward or overflows would be silently cut off there.
    await withApp('composer-plus-canvas', async (page) => {
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      await page.getByTestId('composer-plus').click();
      await expect(page.locator('.composer-plus-menu')).toBeVisible();

      const fits = await page.evaluate(() => {
        const menuEl = document.querySelector('.composer-plus-menu');
        const node = document.querySelector('.surface--node');
        if (menuEl === null || node === null) return null;
        const m = menuEl.getBoundingClientRect();
        const n = node.getBoundingClientRect();
        return {
          topSlack: m.top - n.top,
          leftSlack: m.left - n.left,
          bottomSlack: n.bottom - m.bottom,
          rightSlack: n.right - m.right,
        };
      });
      expect(fits, 'menu and Leader node are both present').not.toBeNull();
      if (fits === null) return;
      // Every edge inside the node's box (1px tolerance for sub-pixel layout).
      expect(fits.topSlack).toBeGreaterThanOrEqual(-1);
      expect(fits.leftSlack).toBeGreaterThanOrEqual(-1);
      expect(fits.bottomSlack).toBeGreaterThanOrEqual(-1);
      expect(fits.rightSlack).toBeGreaterThanOrEqual(-1);
    });
  });
});
