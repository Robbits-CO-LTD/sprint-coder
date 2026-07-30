import { test, expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #3: reading back through the history while a response streams must not yank the reader to
// the bottom on every token. Autoscroll follows the tail only while the reader is parked there;
// scrolling up parks the view and offers an explicit "最新へ" affordance to opt back in.

// Long enough that the timeline is definitely taller than the scrollport in both the packaged and
// the dev window size, so `scrollTop` has somewhere to go.
const TALL_MESSAGE = Array.from(
  { length: 40 },
  (_, index) => `行${index + 1}: スクロール可能な高さを作るための埋め草テキストです。`,
).join('\n');

/** Pixels of content below the bottom edge — mirrors renderer/lib/scroll-follow.ts. */
async function distanceFromBottom(scroll: Locator): Promise<number> {
  return scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
}

test.describe('timeline scroll follow', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('timeline-scroll-follow');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('scrolling up mid-stream holds position, and 最新へ resumes following', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);

    await page.getByTestId('sidebar-new-task-button').click();
    const textarea = page.getByTestId('composer-textarea');
    await expect(textarea).toBeVisible();

    // First turn: fills the timeline so there is history to scroll back through.
    await textarea.fill(TALL_MESSAGE);
    await textarea.press('Enter');
    const runCard = page.getByTestId('run-card');
    await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 30_000 });

    const scroll = page.getByTestId('timeline-scroll');
    // Sanity check for the fixture itself: without a scrollable timeline this test proves nothing.
    expect(await scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
    // A completed turn leaves the reader following, so no jump affordance is offered.
    await expect(page.getByTestId('timeline-jump-latest')).toHaveCount(0);

    // Second turn: scroll up while it streams.
    await textarea.fill('2通目です (timeline-scroll-follow)');
    await textarea.press('Enter');
    await expect(page.getByTestId('streaming-assistant-message')).toBeVisible({ timeout: 30_000 });

    const jumpButton = page.getByTestId('timeline-jump-latest');
    await expect
      .poll(
        async () => {
          await scroll.evaluate((el) => {
            el.scrollTop = 0;
            // Setting scrollTop and the stream's own follow-to-bottom effect can race in one frame.
            // Dispatch the user-observable event explicitly so React records that following ended.
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
          return jumpButton.count();
        },
        { timeout: 15_000 },
      )
      .toBe(1);
    await expect(jumpButton).toBeVisible();

    // Tokens keep arriving; the reader must stay exactly where they parked.
    const parkedDistance = await distanceFromBottom(scroll);
    for (let sample = 0; sample < 4; sample += 1) {
      await page.waitForTimeout(250);
      expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
    }
    // The content really did grow underneath — otherwise "held position" would be vacuous.
    expect(await distanceFromBottom(scroll)).toBeGreaterThan(parkedDistance);

    // Opting back in re-pins to the bottom and dismisses the affordance.
    await jumpButton.click();
    await expect(jumpButton).toHaveCount(0);
    expect(await distanceFromBottom(scroll)).toBeLessThanOrEqual(40);

    // ...and stays pinned as the rest of the response arrives.
    await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 30_000 });
    expect(await distanceFromBottom(scroll)).toBeLessThanOrEqual(40);
  });
});
