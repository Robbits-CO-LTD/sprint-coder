import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Waits until `.timeline`'s rendered content (a cheap outerHTML-length fingerprint, covering new
// messages/audit rows/diff cards — anything that could re-trigger Timeline's own
// scroll-to-bottom effect) stops changing for `stableMs`, instead of a fixed guess. Under heavier
// system load (e.g. the full E2E suite running back-to-back specs) a Turn's trailing store
// updates (diff/audit rows alongside `turn.completed`) can land later than a fixed short wait
// would assume, and any of them re-firing that effect after we pin a scroll position would
// silently clobber it — this is what actually needs to have quiesced, not just scrollHeight.
async function waitForTimelineQuiet(
  page: Page,
  { stableMs = 500, intervalMs = 100, timeoutMs = 10_000 } = {},
): Promise<void> {
  const timeline = page.locator('.timeline');
  const deadline = Date.now() + timeoutMs;
  let lastFingerprint = await timeline.evaluate((el) => el.outerHTML.length);
  let stableSince = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(intervalMs);
    // eslint-disable-next-line no-await-in-loop
    const fingerprint = await timeline.evaluate((el) => el.outerHTML.length);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince >= stableMs) return;
    if (Date.now() > deadline) return; // best-effort — proceed rather than hang the suite
  }
}

// Phase 6 Slice 6.2 (docs/PRODUCT_AND_TECHNICAL_DESIGN.md §4.6 / ADR-002): the Chat <-> Leader
// morph must reuse a single ChatSurface instance (SurfaceLayer) rather than unmount/remount it,
// preserving draft text, timeline scroll position, and mount identity across the toggle.
//
// `window.__sprintCoderChatSurfaceMounts` (ChatSurface.tsx, dev-only) is the mount counter. This
// app renders under <StrictMode>, which deliberately double-invokes mount effects in dev-mode
// E2E, so the baseline value after first load is 2, not 1 — see the comment there. The
// acceptance-relevant assertion is therefore that the counter does not advance *again* across
// the chat->team->chat (->team) cycle, i.e. no additional mount is ever caused by the morph.
test.describe('Phase 6 Slice 6.2: Chat <-> Leader morph', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('team-morph');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('preserves draft, scroll, and the ChatSurface instance across a chat<->team cycle', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();

    const textarea = page.getByTestId('composer-textarea');
    await expect(textarea).toBeVisible();

    // Build up enough timeline content that a non-zero scroll position is meaningful — keep
    // sending short exchanges until the timeline overflows its viewport by more than the
    // scroll-follow threshold (renderer/lib/scroll-follow.ts, 40px), so the position pinned below
    // can sit unambiguously *off* the live tail rather than a few pixels above it.
    const timelineScroll = page.locator('.timeline-scroll');
    for (let i = 0; i < 12; i += 1) {
      const overflowing = await timelineScroll.evaluate(
        (el) => el.scrollHeight > el.clientHeight + 240,
      );
      if (overflowing) break;
      await textarea.fill(`スクロール用のメッセージ ${i + 1}`);
      await textarea.press('Enter');
      // eslint-disable-next-line no-await-in-loop
      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
        timeout: 20_000,
      });
    }

    // Let any trailing store activity from the last turn (diff/audit rows arriving alongside
    // `turn.completed`) fully settle before pinning a scroll position — Timeline's own
    // scroll-to-bottom effect (unrelated to the morph) would otherwise race our explicit
    // `scrollTop` write below.
    await waitForTimelineQuiet(page);

    const draftText = 'Team切替後も残るはずのdraftテキスト (Slice 6.2)';
    await textarea.fill(draftText);

    // Pin a non-trivial (non-collapsed) selection range — SurfaceLayer's capture/restore
    // (captureSurfaceState/restoreSurfaceState) must carry this across the morph, not just the
    // draft text itself.
    await textarea.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 9));
    const selectionBefore = await textarea.evaluate((el: HTMLTextAreaElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
    }));
    expect(selectionBefore).toEqual({ start: 3, end: 9 });

    // Park mid-history, well clear of both ends. Anything within 40px of the bottom counts as
    // "following the live tail" (issue #3), and SurfaceLayer deliberately re-pins such a reader to
    // the bottom across the morph rather than replaying a raw scrollTop — the two variants have
    // different timeline heights, so the same offset is not the same reading position. Exact
    // scrollTop preservation, which is what this test is about, applies to a reader who has
    // genuinely scrolled away from the tail.
    await timelineScroll.evaluate((el) => {
      el.scrollTop = 80;
    });
    const scrollBefore = await timelineScroll.evaluate((el) => el.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);
    expect(
      await timelineScroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    ).toBeGreaterThan(40);

    const mountsBefore = await page.evaluate(() => window.__sprintCoderChatSurfaceMounts ?? 0);

    // --- (a) enter Team mode: draft + selection survive in the node-variant composer, no extra
    // mount. ---
    await page.getByTestId('team-toggle').click();
    await expect(page.getByTestId('team-list')).toBeVisible();
    await expect(textarea).toHaveValue(draftText);
    const selectionInTeam = await textarea.evaluate((el: HTMLTextAreaElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
    }));
    expect(selectionInTeam).toEqual(selectionBefore);
    const mountsInTeam = await page.evaluate(() => window.__sprintCoderChatSurfaceMounts ?? 0);
    expect(mountsInTeam).toBe(mountsBefore);

    // --- (b) exit Team mode: draft + scroll + selection survive, still no extra mount. ---
    await page.getByTestId('team-back').click();
    await expect(page.getByTestId('team-list')).not.toBeVisible();
    await expect(page.locator('.app-shell')).not.toHaveClass(/team-mode/);
    await expect(textarea).toHaveValue(draftText);
    const selectionAfterReturn = await textarea.evaluate((el: HTMLTextAreaElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
    }));
    expect(selectionAfterReturn).toEqual(selectionBefore);
    await waitForTimelineQuiet(page); // let any late Timeline update land before the final read
    const scrollAfterReturn = await timelineScroll.evaluate((el) => el.scrollTop);
    expect(scrollAfterReturn).toBe(scrollBefore);
    const mountsAfterReturn = await page.evaluate(() => window.__sprintCoderChatSurfaceMounts ?? 0);
    expect(mountsAfterReturn).toBe(mountsBefore);
  });

  test('rapid double-toggle (enter then exit quickly) ends in a consistent chat state', async () => {
    const dir = createUserDataDir('team-morph-rapid');
    let rapidApp: ElectronApplication | null = null;
    try {
      rapidApp = await launchApp(dir);
      const page = await firstWindow(rapidApp);
      await page.getByTestId('sidebar-new-task-button').click();
      await expect(page.getByTestId('composer-textarea')).toBeVisible();
      const mountsBefore = await page.evaluate(() => window.__sprintCoderChatSurfaceMounts ?? 0);

      // Click "back" the instant it appears — interrupts the ~560ms enter seed-then-fly
      // mid-flight (Slice 6.2 interruption requirement) rather than waiting for it to settle.
      await page.getByTestId('team-toggle').click();
      const backBtn = page.getByTestId('team-back');
      await backBtn.waitFor({ state: 'visible' });
      await backBtn.click();

      // Consistent end state: back in chat, chrome restored, no leftover Team DOM, and the
      // morph is left in a state where it can be entered again cleanly.
      await expect(page.getByTestId('team-list')).not.toBeVisible({ timeout: 5_000 });
      await expect(page.locator('.app-shell')).not.toHaveClass(/team-mode/, { timeout: 5_000 });
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      const mountsAfter = await page.evaluate(() => window.__sprintCoderChatSurfaceMounts ?? 0);
      expect(mountsAfter).toBe(mountsBefore);
    } finally {
      await closeApp(rapidApp);
      removeUserDataDir(dir);
    }
  });
});
