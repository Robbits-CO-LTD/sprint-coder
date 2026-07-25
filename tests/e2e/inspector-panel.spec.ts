import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #16. The edit stream has no producer in the running app (`prepareStructuredPatch` has no
// runtime caller — index.ts calls its own edit-saga wiring "dormant"), so what is asserted here is
// the panel container, the progress gauge, and the fact that the stream states its absence instead of
// showing a fake window.

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

function panelWidth(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.querySelector('[data-testid="inspector-panel"]')?.getBoundingClientRect().width ?? 0,
  );
}

/**
 * Width once the transition has settled.
 *
 * `width` animates over 240ms, so measuring right after a click reads a frame partway between the two
 * states — the first version of this spec compared 380 against 380 while the panel was on its way to
 * 560. Waits for the panel's own animations to drain rather than sleeping a guessed interval.
 */
async function settledPanelWidth(page: Page): Promise<number> {
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="inspector-panel"]');
    return panel !== null && panel.getAnimations().length === 0;
  });
  return panelWidth(page);
}

test.describe('inspector panel', () => {
  test('is hidden by default and cycles through every width, persisting each choice', async () => {
    const dir = createUserDataDir('inspector-cycle');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      let page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      // Default hidden, and rendered as nothing at all rather than a zero-width element — a
      // zero-width flex child can still report a scrollWidth to an overflow check.
      await expect(page.getByTestId('inspector-panel')).toHaveCount(0);
      const toggle = page.getByTestId('inspector-toggle');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await toggle.click();
      const panel = page.getByTestId('inspector-panel');
      await expect(panel).toHaveAttribute('data-inspector-state', 'panel');
      const panelPx = await settledPanelWidth(page);
      expect(panelPx).toBeGreaterThan(300);

      await page.getByTestId('inspector-cycle').click();
      await expect(panel).toHaveAttribute('data-inspector-state', 'wide');
      expect(await settledPanelWidth(page)).toBeGreaterThan(panelPx);

      await page.getByTestId('inspector-cycle').click();
      await expect(panel).toHaveAttribute('data-inspector-state', 'rail');
      expect(await settledPanelWidth(page)).toBeLessThan(80);

      // Persisted, so the choice survives a restart like the Team view preference does.
      await closeApp(app);
      app = await launchApp(dir);
      page = await firstWindow(app);
      await expect(page.getByTestId('inspector-panel')).toHaveAttribute(
        'data-inspector-state',
        'rail',
      );

      // And it can always get back to hidden — a cycle that trapped the user would be worse than no
      // cycle.
      await page.getByTestId('inspector-cycle').click();
      await expect(page.getByTestId('inspector-panel')).toHaveCount(0);
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });

  test('is never a descendant of the re-parented ChatSurface host', async () => {
    // ADR-002: SurfaceLayer moves `.surface-host` between anchors on every Chat<->Team morph.
    // Anything nested inside it would be torn out and re-inserted along with it, losing its own
    // state — so this is asserted mechanically rather than left to review.
    await withApp('inspector-not-nested', async (page) => {
      await page.getByTestId('inspector-toggle').click();
      await expect(page.getByTestId('inspector-panel')).toBeVisible();

      const nesting = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="inspector-panel"]');
        if (panel === null) return null;
        return {
          insideSurfaceHost: panel.closest('.surface-host') !== null,
          insideSurfaceAnchor: panel.closest('.surface-anchor') !== null,
          insideLeaderAnchor: panel.closest('.leader-anchor') !== null,
          isShellChild: panel.parentElement?.classList.contains('app-shell') === true,
        };
      });
      expect(nesting).not.toBeNull();
      expect(nesting?.insideSurfaceHost).toBe(false);
      expect(nesting?.insideSurfaceAnchor).toBe(false);
      expect(nesting?.insideLeaderAnchor).toBe(false);
      expect(nesting?.isShellChild).toBe(true);
    });
  });

  test('survives a Chat -> Team -> Chat round trip with its width intact', async () => {
    await withApp('inspector-morph', async (page) => {
      await page.getByTestId('inspector-toggle').click();
      await page.getByTestId('inspector-cycle').click();
      await expect(page.getByTestId('inspector-panel')).toHaveAttribute(
        'data-inspector-state',
        'wide',
      );

      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      await page.getByTestId('team-back').click();
      await expect(page.locator('.app-shell')).not.toHaveClass(/team-mode/);

      await expect(page.getByTestId('inspector-panel')).toHaveAttribute(
        'data-inspector-state',
        'wide',
      );
    });
  });

  test('drops to the rail while the Team List view is up, then restores', async () => {
    // The List view is 460px and the panel 380/560; both at once needs 840px+ of shell.
    await withApp('inspector-list-exclusive', async (page) => {
      await page.getByTestId('inspector-toggle').click();
      await expect(page.getByTestId('inspector-panel')).toHaveAttribute(
        'data-inspector-state',
        'panel',
      );

      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      await page.getByTestId('team-view-toggle').click();
      await expect(page.locator('.team-list-view')).toBeVisible();
      await expect(page.getByTestId('inspector-panel')).toHaveAttribute(
        'data-inspector-state',
        'rail',
      );

      // The stored preference was untouched, so leaving List view brings the width back.
      await page.getByTestId('team-back').click();
      await expect(page.locator('.team-list-view')).toHaveCount(0);
      await expect(page.getByTestId('inspector-panel')).toHaveAttribute(
        'data-inspector-state',
        'panel',
      );
    });
  });

  test('shows a five-segment gauge that advances, never retreats, and shows no percentage', async () => {
    await withApp('inspector-gauge', async (page) => {
      await page.getByTestId('inspector-toggle').click();
      const gauge = page.getByTestId('inspector-gauge');
      await expect(gauge).toBeVisible();
      await expect(page.locator('.insp-seg')).toHaveCount(5);

      // No turn yet: it says so rather than showing a plausible-looking empty bar.
      await expect(page.getByTestId('inspector-stage')).toContainText('まだ実行がありません');

      await page.getByTestId('composer-textarea').fill('ゲージの進行を確認したい');
      await page.getByTestId('composer-textarea').press('Enter');

      // Sample the gauge across the turn and assert monotonicity of "how far it got".
      const reached: number[] = [];
      for (let sample = 0; sample < 12; sample += 1) {
        // eslint-disable-next-line no-await-in-loop
        reached.push(
          // eslint-disable-next-line no-await-in-loop
          await page.evaluate(
            () =>
              Array.from(document.querySelectorAll('.insp-seg')).filter((segment) =>
                ['done', 'current', 'waiting', 'failed', 'complete'].includes(
                  segment.getAttribute('data-segment') ?? '',
                ),
              ).length,
          ),
        );
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(200);
      }
      for (let i = 1; i < reached.length; i += 1)
        expect(reached[i], `gauge retreated: ${JSON.stringify(reached)}`).toBeGreaterThanOrEqual(
          reached[i - 1] ?? 0,
        );

      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
        timeout: 30_000,
      });
      // Complete only once the turn completed — never before.
      await expect(page.locator('.insp-seg[data-segment="complete"]')).toHaveCount(5);

      // No percentage anywhere in the panel: the CLI settles no step count, so any number would be
      // invented (issue #16's "推定 % を演じない").
      expect(await page.getByTestId('inspector-panel').innerText()).not.toMatch(/\d+\s*%/);
    });
  });

  test('names the missing condition instead of showing an empty window', async () => {
    // Issue #37 gave the stream a real producer, so "not connected" is no longer the permanent
    // state — but it is still the state with no Workspace, and the panel has to say WHICH condition
    // is missing rather than showing an empty list. A window that never fills is the "偽の窓" the
    // issue forbids; a list that is empty for an unstated reason is the same mistake in a new shape.
    await withApp('inspector-stream', async (page) => {
      await page.getByTestId('inspector-toggle').click();
      const disconnected = page.getByTestId('inspector-stream-disconnected');
      await expect(disconnected).toBeVisible();
      await expect(disconnected).toContainText('Workspace');
      // No code window, no line numbers, no caret — nothing that implies content is coming.
      await expect(page.locator('.insp-panel pre')).toHaveCount(0);
    });
  });
});
