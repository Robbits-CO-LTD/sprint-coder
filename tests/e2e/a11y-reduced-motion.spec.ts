import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Phase 7 (tasks/IMPLEMENTATION_PLAN.md §10.3 / NFR-A11Y-04): reduced motion must suppress Camera
// fly, packet pulse, and blur. team-cables.spec.ts already covers the cable/packet-pulse
// substitute; this spec covers the three other choreographed animations named in the Phase 7
// deliverable: (a) the Team-mode entry seed-then-fly camera move, (b) Worker spawn's `workerIn`
// transform animation, (c) the Chat<->Team morph's exit animation. All three are asserted via
// computed-style/frame-count heuristics (never pixel comparisons), each run once with
// `reducedMotion: 'reduce'` and once without, so a heuristic that could never fail (e.g. because
// nothing ever animates in this app) is ruled out by the contrasting case actually observing
// motion.

function parseCssTimeToMs(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed);
  if (trimmed.endsWith('s')) return Number.parseFloat(trimmed) * 1000;
  return Number.parseFloat(trimmed);
}

async function openTeamCanvasWithWorkers(page: Page): Promise<void> {
  await page.getByTestId('sidebar-new-task-button').click();
  await page.getByTestId('team-toggle').click();
  await expect(page.getByTestId('team-list')).toBeVisible();
  const composer = page.getByTestId('composer-textarea');
  await composer.fill('チームテスト：reduced motion確認');
  await composer.press('Enter');
  await expect(page.getByTestId('team-worker')).toHaveCount(3, { timeout: 20_000 });
}

test.describe('Reduced motion (NFR-A11Y-04)', () => {
  test('(a) Team-mode entry camera fly is skipped — settles immediately, no rAF-driven transform churn', async () => {
    const dir = createUserDataDir('a11y-motion-camera-reduced');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page = await firstWindow(app);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.getByTestId('sidebar-new-task-button').click();
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      // Sample `.team-world`'s inline transform across ~20 animation frames right after entry.
      // useCamera's animateCamTo jumps straight to the target when `isReduced()` (see
      // useCamera.ts), so every sample should already be the same, settled value — no in-flight
      // rAF loop repainting it frame over frame.
      const samples = await page.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            const el = document.querySelector<HTMLElement>('.team-world');
            const out: string[] = [];
            let n = 0;
            function tick() {
              out.push(el?.style.transform ?? '');
              n += 1;
              if (n < 20) requestAnimationFrame(tick);
              else resolve(out);
            }
            requestAnimationFrame(tick);
          }),
      );

      const distinct = new Set(samples);
      expect(samples[0]).not.toBe('');
      expect(distinct.size, `expected a single settled transform, saw: ${[...distinct].join(' | ')}`).toBe(
        1,
      );
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });

  test('(a, contrast) without reduced motion, the same entry visibly animates the transform across frames', async () => {
    const dir = createUserDataDir('a11y-motion-camera-normal');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      const samples = await page.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            const el = document.querySelector<HTMLElement>('.team-world');
            const out: string[] = [];
            let n = 0;
            function tick() {
              out.push(el?.style.transform ?? '');
              n += 1;
              if (n < 20) requestAnimationFrame(tick);
              else resolve(out);
            }
            requestAnimationFrame(tick);
          }),
      );

      const distinct = new Set(samples);
      expect(distinct.size).toBeGreaterThan(1);
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });

  test('(b) Worker spawn animation is instant under reduced motion, full duration otherwise', async () => {
    const reducedDir = createUserDataDir('a11y-motion-worker-reduced');
    const normalDir = createUserDataDir('a11y-motion-worker-normal');
    let reducedApp: ElectronApplication | null = null;
    let normalApp: ElectronApplication | null = null;
    try {
      reducedApp = await launchApp(reducedDir);
      const reducedPage = await firstWindow(reducedApp);
      await reducedPage.emulateMedia({ reducedMotion: 'reduce' });
      await openTeamCanvasWithWorkers(reducedPage);
      const reducedDurationMs = await reducedPage
        .locator('[data-testid="team-worker"]')
        .first()
        .evaluate((el) => getComputedStyle(el).animationDuration);
      expect(parseCssTimeToMs(reducedDurationMs)).toBeLessThan(1);

      normalApp = await launchApp(normalDir);
      const normalPage = await firstWindow(normalApp);
      await openTeamCanvasWithWorkers(normalPage);
      const normalDurationMs = await normalPage
        .locator('[data-testid="team-worker"]')
        .first()
        .evaluate((el) => getComputedStyle(el).animationDuration);
      expect(parseCssTimeToMs(normalDurationMs)).toBeGreaterThan(50);
    } finally {
      await closeApp(reducedApp);
      await closeApp(normalApp);
      removeUserDataDir(reducedDir);
      removeUserDataDir(normalDir);
    }
  });

  test('(c) Chat<->Team morph exit animation is instant under reduced motion, full duration otherwise', async () => {
    const reducedDir = createUserDataDir('a11y-motion-exit-reduced');
    const normalDir = createUserDataDir('a11y-motion-exit-normal');
    let reducedApp: ElectronApplication | null = null;
    let normalApp: ElectronApplication | null = null;
    try {
      reducedApp = await launchApp(reducedDir);
      const reducedPage = await firstWindow(reducedApp);
      await reducedPage.emulateMedia({ reducedMotion: 'reduce' });
      await reducedPage.getByTestId('sidebar-new-task-button').click();
      await reducedPage.getByTestId('team-toggle').click();
      await expect(reducedPage.getByTestId('team-list')).toBeVisible();
      await reducedPage.waitForTimeout(200); // let entry settle before measuring exit

      // A MutationObserver captures the computed animation-duration the instant `.exiting` is
      // applied — robust regardless of how quickly the (near-0ms, under reduced motion) animation
      // itself then completes and the node unmounts.
      await reducedPage.evaluate(() => {
        (window as unknown as { __exitAnimDuration: string | null }).__exitAnimDuration = null;
        const el = document.querySelector('.team-canvas');
        if (!el) return;
        const observer = new MutationObserver(() => {
          if (
            el.classList.contains('exiting') &&
            (window as unknown as { __exitAnimDuration: string | null }).__exitAnimDuration === null
          ) {
            (window as unknown as { __exitAnimDuration: string | null }).__exitAnimDuration =
              getComputedStyle(el).animationDuration;
          }
        });
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
      await reducedPage.getByTestId('team-back').click();
      await reducedPage.waitForFunction(
        () => (window as unknown as { __exitAnimDuration: string | null }).__exitAnimDuration !== null,
        { timeout: 5_000 },
      );
      const reducedDuration = await reducedPage.evaluate(
        () => (window as unknown as { __exitAnimDuration: string }).__exitAnimDuration,
      );
      expect(parseCssTimeToMs(reducedDuration)).toBeLessThan(1);
      await expect(reducedPage.getByTestId('team-list')).not.toBeVisible();

      normalApp = await launchApp(normalDir);
      const normalPage = await firstWindow(normalApp);
      await normalPage.getByTestId('sidebar-new-task-button').click();
      await normalPage.getByTestId('team-toggle').click();
      await expect(normalPage.getByTestId('team-list')).toBeVisible();
      await normalPage.waitForTimeout(700); // let the (non-reduced) entry seed-fly fully settle

      await normalPage.evaluate(() => {
        (window as unknown as { __exitAnimDuration: string | null }).__exitAnimDuration = null;
        const el = document.querySelector('.team-canvas');
        if (!el) return;
        const observer = new MutationObserver(() => {
          if (
            el.classList.contains('exiting') &&
            (window as unknown as { __exitAnimDuration: string | null }).__exitAnimDuration === null
          ) {
            (window as unknown as { __exitAnimDuration: string | null }).__exitAnimDuration =
              getComputedStyle(el).animationDuration;
          }
        });
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
      await normalPage.getByTestId('team-back').click();
      await normalPage.waitForFunction(
        () => (window as unknown as { __exitAnimDuration: string | null }).__exitAnimDuration !== null,
        { timeout: 5_000 },
      );
      const normalDuration = await normalPage.evaluate(
        () => (window as unknown as { __exitAnimDuration: string }).__exitAnimDuration,
      );
      expect(parseCssTimeToMs(normalDuration)).toBeGreaterThan(50);
    } finally {
      await closeApp(reducedApp);
      await closeApp(normalApp);
      removeUserDataDir(reducedDir);
      removeUserDataDir(normalDir);
    }
  });
});
