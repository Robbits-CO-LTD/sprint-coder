import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #863 reproduction without a real model. A long real Team run makes Main record thousands
// of Auto permission decisions on the Leader's Task (about 17 per second, 4000 in one run), and
// each one used to re-sort the whole list, re-render the whole Timeline and force a layout, so the
// renderer fell minutes behind. Mock never asks the reviewer, so an E2E-only flag makes the mock
// Leader record FLOOD_COUNT decisions at FLOOD_PER_SECOND through the same persistence + turn event
// path, and this spec measures the renderer while they arrive: animation-frame gaps and the sum
// of long tasks. Values are printed for the record; the ceilings are CI-safe.
const FLOOD_COUNT = 3000;
const FLOOD_PER_SECOND = 100;

type FloodMetrics = {
  frames: number;
  maxFrameGapMs: number;
  frameGaps: { atMs: number; gapMs: number }[];
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  elapsedMs: number;
};

test.describe('Auto decision flood on the Leader Timeline (issue #863)', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('auto-decision-flood');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('keeps frames flowing and groups the decisions per Turn', async () => {
    test.setTimeout(300_000);
    app = await launchApp(userDataDir, undefined, {
      SPRINT_CODER_E2E_MOCK_AUTO_DECISION_FLOOD: String(FLOOD_COUNT),
      SPRINT_CODER_E2E_MOCK_AUTO_DECISION_FLOOD_PER_SECOND: String(FLOOD_PER_SECOND),
    });
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await page.getByTestId('team-toggle').click();
    await expect(page.getByTestId('team-list')).toBeVisible();

    // Recorded inside the page and read once at the end, so the measurement itself never waits on
    // a renderer that is behind. The window opens when the first decision reaches the Timeline
    // (the Workers have been hired by then) and closes when the final answer shows.
    await page.evaluate(() => {
      const w = window as typeof window & { __flood?: FloodState };
      type FloodState = {
        frames: number;
        maxFrameGapMs: number;
        frameGaps: { atMs: number; gapMs: number }[];
        longTaskCount: number;
        longTaskTotalMs: number;
        longTaskMaxMs: number;
        startedAt: number;
        lastFrameAt: number;
        running: boolean;
      };
      const state: FloodState = {
        frames: 0,
        maxFrameGapMs: 0,
        frameGaps: [],
        longTaskCount: 0,
        longTaskTotalMs: 0,
        longTaskMaxMs: 0,
        startedAt: performance.now(),
        lastFrameAt: performance.now(),
        running: true,
      };
      w.__flood = state;
      const tick = (at: number): void => {
        const gap = at - state.lastFrameAt;
        state.frames += 1;
        state.maxFrameGapMs = Math.max(state.maxFrameGapMs, gap);
        if (gap > 250 && state.frameGaps.length < 50)
          state.frameGaps.push({
            atMs: Math.round(state.lastFrameAt - state.startedAt),
            gapMs: Math.round(gap),
          });
        state.lastFrameAt = at;
        if (state.running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime < state.startedAt) continue;
          state.longTaskCount += 1;
          state.longTaskTotalMs += entry.duration;
          state.longTaskMaxMs = Math.max(state.longTaskMaxMs, entry.duration);
        }
      }).observe({ type: 'longtask', buffered: false });
    });

    const composer = page.getByTestId('composer-textarea');
    await composer.fill('チームテスト：Auto判定を大量に記録する');
    await composer.press('Enter');
    await expect(page.getByTestId('team-worker')).toHaveCount(3, { timeout: 30_000 });
    await expect(
      page
        .locator('[data-testid="auto-decision-group"], [data-testid="auto-decision-audit"]')
        .first(),
    ).toBeAttached({ timeout: 60_000 });
    const beforeFlood = await page.evaluate(() => {
      const w = window as typeof window & {
        __flood?: {
          frames: number;
          maxFrameGapMs: number;
          frameGaps: unknown[];
          longTaskCount: number;
          longTaskTotalMs: number;
          longTaskMaxMs: number;
          startedAt: number;
          lastFrameAt: number;
        };
      };
      const state = w.__flood!;
      const now = performance.now();
      const previous = {
        maxFrameGapMs: Math.round(state.maxFrameGapMs),
        frameGaps: state.frameGaps,
        longTaskTotalMs: Math.round(state.longTaskTotalMs),
        elapsedMs: Math.round(now - state.startedAt),
      };
      Object.assign(state, {
        frames: 0,
        maxFrameGapMs: 0,
        frameGaps: [],
        longTaskCount: 0,
        longTaskTotalMs: 0,
        longTaskMaxMs: 0,
        startedAt: now,
        lastFrameAt: Math.max(now, state.lastFrameAt),
      });
      return previous;
    });
    // Hiring the Workers before the flood, for the record only (issue #863's frame stall right
    // after hiring is a separate, still open question).
    console.info(`[perf] before the flood (hiring): ${JSON.stringify(beforeFlood)}`);

    // Main's own responsiveness during the flood, so a frame gap can be told apart from Main
    // being busy recording decisions.
    const floodStartedAt = Date.now();
    const mainSlowest = { ms: 0, atMs: 0 };
    let polling = true;
    const mainPoller = (async () => {
      while (polling) {
        const pollStarted = Date.now();
        await app!.evaluate(() => 1).catch(() => undefined);
        const ms = Date.now() - pollStarted;
        if (ms > mainSlowest.ms)
          Object.assign(mainSlowest, { ms, atMs: pollStarted - floodStartedAt });
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();

    // The mock records every decision before it writes the final answer, so the answer showing up
    // means the renderer has processed the whole flood.
    await expect(page.getByText('以上の報告を統合した結論です。')).toBeVisible({
      timeout: 240_000,
    });
    polling = false;
    await mainPoller;
    console.info(`[perf] slowest Main round trip during the flood: ${JSON.stringify(mainSlowest)}`);
    const metrics = await page.evaluate((): FloodMetrics => {
      const w = window as typeof window & {
        __flood?: FloodMetrics & { startedAt: number; running: boolean };
      };
      const state = w.__flood!;
      state.running = false;
      return {
        frames: state.frames,
        maxFrameGapMs: Math.round(state.maxFrameGapMs),
        frameGaps: state.frameGaps,
        longTaskCount: state.longTaskCount,
        longTaskTotalMs: Math.round(state.longTaskTotalMs),
        longTaskMaxMs: Math.round(state.longTaskMaxMs),
        elapsedMs: Math.round(performance.now() - state.startedAt),
      };
    });
    console.info(
      `[perf] auto-decision flood ${FLOOD_COUNT}@${FLOOD_PER_SECOND}/s: ${JSON.stringify(metrics)}`,
    );

    // One summary line for the Turn instead of one row per decision. It counts every decision of
    // the Turn, says how many rows are not kept, and opening it shows the newest ones.
    const group = page.getByTestId('auto-decision-group');
    await expect(group).toHaveCount(1);
    await expect(page.getByTestId('auto-decision-audit')).toHaveCount(0);
    const summary = page.getByTestId('auto-decision-summary');
    const omitted = FLOOD_COUNT - 200;
    await expect(summary).toContainText('Auto');
    await expect(summary).toContainText(`自動許可 ${FLOOD_COUNT}件`);
    await expect(summary).toContainText(`${omitted}件は省略、最新200件を表示`);
    await expect(summary).toHaveAttribute(
      'aria-label',
      `Auto判定 ${FLOOD_COUNT}件。自動許可 ${FLOOD_COUNT}件（${omitted}件は省略、最新200件を表示）`,
    );
    await summary.click();
    await expect(page.getByTestId('auto-decision-audit')).toHaveCount(200);
    await expect(page.getByTestId('auto-decision-audit').last()).toContainText(
      `e2e flood ${FLOOD_COUNT}/${FLOOD_COUNT}`,
    );

    // Before the fix the renderer spent most of the flood in long tasks and fell far behind Main,
    // so the answer arrived long after the last decision was recorded. CI runners are slower and
    // noisier than a desktop, so the ceilings only catch a regression back to per-decision
    // whole-Timeline work. Frame gaps are printed but not asserted: a multi-second gap with no
    // long task at all shows up both before and after the fix, so it is not this JS work (it is
    // the separate frame stall still open in issue #863).
    const ci = process.env['CI'] === 'true';
    const floodMs = (FLOOD_COUNT / FLOOD_PER_SECOND) * 1000;
    expect(metrics.longTaskTotalMs).toBeLessThan(ci ? 15_000 : 5_000);
    expect(metrics.elapsedMs).toBeLessThan(floodMs + (ci ? 60_000 : 20_000));
  });
});
