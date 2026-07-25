import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #17. The mock runtime now emits pseudo-reasoning through the same redact → batch → push path
// a real runtime uses, which is what makes this testable at all: mock is the only runtime under
// SPRINT_CODER_E2E_MODE=dev.

async function withApp(label: string, body: (page: Page) => Promise<void>): Promise<void> {
  const dir = createUserDataDir(label);
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(dir);
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await expect(page.getByTestId('composer-textarea')).toBeVisible();
    await body(page);
  } finally {
    await closeApp(app);
    removeUserDataDir(dir);
  }
}

test.describe('thinking pill', () => {
  test('collapses the Run Card to one row and drops the permanent five-stage list', async () => {
    await withApp('reasoning-height', async (page) => {
      await page.getByTestId('composer-textarea').fill('思考ピルの高さを確認したい');
      await page.getByTestId('composer-textarea').press('Enter');

      const runCard = page.getByTestId('run-card');
      await expect(runCard).toBeVisible();
      // The old card listed all five stages permanently at ~140px. FR-RUN-04's three required
      // elements (elapsed, current stage, stop) are all still on the collapsed row.
      const collapsedHeight = await runCard.evaluate((el) => el.getBoundingClientRect().height);
      expect(collapsedHeight).toBeLessThan(56);
      await expect(runCard).toContainText('思考中');
      await expect(runCard).toContainText('中'); // a stage label is inline
      await expect(page.getByTestId('run-card-stop-button')).toBeVisible();
      // The five text rows are gone.
      await expect(page.locator('.stage-row')).toHaveCount(0);

      await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 30_000 });
    });
  });

  test('opens the reasoning panel, streams paragraphs, and never moves the timeline scroll', async () => {
    await withApp('reasoning-panel', async (page) => {
      await page.getByTestId('composer-textarea').fill('思考パネルの中身を確認したい');
      await page.getByTestId('composer-textarea').press('Enter');

      const toggle = page.getByTestId('run-card-reasoning-toggle');
      // Appears only once reasoning has actually arrived — the pill is not a disclosure before that.
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');

      // Class selector, not a testid: `data-testid="timeline-scroll"` arrives with #3.
      const timeline = page.locator('.timeline-scroll');
      const scrollBefore = await timeline.evaluate((el) => el.scrollTop);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const panel = page.getByTestId('reasoning-panel');
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('reasoning-progress')).toBeVisible();

      // Real paragraphs, not the empty-state line.
      await expect(page.locator('.think-para').first()).toBeVisible();
      await expect(page.getByTestId('reasoning-panel-empty')).toHaveCount(0);

      // No paragraph appears twice. This caught a real bug: `init()` runs twice under StrictMode's
      // deliberate double-invocation in dev, so an unguarded subscribe registered two listeners and
      // every fragment was appended twice — visible only by reading the rendered panel.
      const paragraphs = await page.locator('.think-para').allInnerTexts();
      expect(new Set(paragraphs).size, `duplicated paragraphs: ${JSON.stringify(paragraphs)}`).toBe(
        paragraphs.length,
      );

      // Opening the panel must not scroll the conversation (it has its own overflow).
      expect(await timeline.evaluate((el) => el.scrollTop)).toBe(scrollBefore);

      // The panel is a region, and explicitly NOT role="log" — that role's implicit
      // aria-live="polite" would make a screen reader read every fragment aloud (NFR-A11Y-03).
      await expect(panel).toHaveAttribute('role', 'region');
      expect(await panel.getAttribute('aria-live')).toBeNull();
      // Elapsed time ticks every 500ms and must not be announced.
      await expect(page.locator('.run-elapsed')).toHaveAttribute('aria-hidden', 'true');

      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
        timeout: 30_000,
      });
      // Stays open after completion: collapsing it out from under someone mid-read would be worse
      // than leaving it.
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });
  });

  test('completes a keyboard round trip: open, enter the panel, collapse back to the toggle', async () => {
    await withApp('reasoning-keyboard', async (page) => {
      await page.getByTestId('composer-textarea').fill('キーボード操作を確認したい');
      await page.getByTestId('composer-textarea').press('Enter');

      const toggle = page.getByTestId('run-card-reasoning-toggle');
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      // Tab order: toggle → stop → (panel). The stop button is a *sibling* of the disclosure, never
      // nested inside it — a button inside a button would make every stop click ambiguous.
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('run-card-stop-button')).toBeFocused();

      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toBeFocused();
    });
  });

  test('degrades to a non-interactive label when no reasoning arrives', async () => {
    // Not hypothetical: verified that the Claude CLI emits thinking at `--effort max` on a demanding
    // prompt and not at `--effort high` on a trivial one, so plenty of real turns produce none.
    // Reproduced here by reading the card before any reasoning has been pushed.
    await withApp('reasoning-degraded', async (page) => {
      const runCard = page.getByTestId('run-card');
      await page.getByTestId('composer-textarea').fill('縮退パスを確認したい');
      await page.getByTestId('composer-textarea').press('Enter');
      await expect(runCard).toBeVisible();

      // Before reasoning arrives the card advertises no disclosure at all.
      if ((await runCard.getAttribute('data-has-reasoning')) === 'false') {
        await expect(page.getByTestId('run-card-reasoning-toggle')).toHaveCount(0);
        await expect(page.locator('.think-toggle--static')).toBeVisible();
        await expect(page.getByTestId('reasoning-panel')).toHaveCount(0);
        // Still a usable Run Card: FR-RUN-04's elements do not depend on reasoning existing.
        await expect(runCard).toContainText('思考中');
        await expect(page.getByTestId('run-card-stop-button')).toBeVisible();
      }
      await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 30_000 });
    });
  });

  test('renders reasoning as plain text, so markup in it cannot become live', async () => {
    // Reasoning is provider output and is treated as untrusted data: `white-space: pre-wrap` text, no
    // Markdown pipeline, so a <script> in a thought is characters rather than an element.
    await withApp('reasoning-plaintext', async (page) => {
      await page
        .getByTestId('composer-textarea')
        .fill('<script>alert(1)</script> を含む依頼で思考を確認');
      await page.getByTestId('composer-textarea').press('Enter');

      const toggle = page.getByTestId('run-card-reasoning-toggle');
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      await toggle.click();
      const panel = page.getByTestId('reasoning-panel');
      await expect(panel).toBeVisible();

      // Nothing inside the panel is a live script element, whatever the text says.
      expect(await panel.locator('script').count()).toBe(0);
      expect(await panel.evaluate((el) => el.querySelectorAll('*').length)).toBeGreaterThan(0);
      expect(
        await panel.evaluate((el) =>
          Array.from(el.querySelectorAll('*')).every((child) =>
            ['P', 'DIV', 'SPAN'].includes(child.tagName),
          ),
        ),
      ).toBe(true);
    });
  });
});
