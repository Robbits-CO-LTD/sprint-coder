import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Phase 7 (tasks/IMPLEMENTATION_PLAN.md §10.3 / NFR-A11Y-02): the primary flow, start to finish,
// using ONLY page.keyboard — create a Task, message it, promote to Team, drive the Leader from the
// キームテスト mock scenario, navigate the Canvas by keyboard, switch to List view, and return to
// chat — with a mouse click never used anywhere in this spec.
//
// Bugs found and fixed while writing this spec (all renderer-only; see the referenced files for
// the full explanation at each fix site):
//   - Entering Team mode while the "⬡ Team" button was itself focused dropped keyboard focus to
//     `document.body` (that button's TaskHeader goes `inert` in the same commit TeamCanvas mounts)
//     — fixed with a mount-time focus effect in TeamCanvas.tsx.
//   - Switching Canvas -> List view (the "List表示" button lives INSIDE TeamCanvas, which unmounts
//     the instant that button is clicked) had the identical bug — fixed with the same pattern in
//     TeamListView.tsx.
//   - Fully exiting Team mode back to chat (both from Canvas's "Chatに戻る" and List's own) dropped
///    focus to `document.body` once the Team surface unmounted — fixed in App.tsx by restoring
//     focus to the "⬡ Team" button whenever `teamViewOpen` flips false while focus was lost to body.
//
// One pre-existing, deliberate design NOT changed here: while the bare Canvas root itself has
// focus, Tab/Shift+Tab move the logical node selection (same as Arrow keys) rather than leaving the
// Canvas — see TeamCanvas.tsx's `handleCanvasKeyDown` and the existing
// team-canvas-layout.spec.ts coverage of it. This is not a trap: Enter moves real DOM focus onto
// the selected node's interactive element (or, once selected, `l`+Enter into the Leader's
// composer), and from a descendant, Tab immediately resumes normal document-order traversal —
// this spec's own step 8 walks exactly that path. (A selected Worker that has already reached a
// terminal state — as every Worker has by the time this deterministic scenario settles — has no
// enabled interactive element of its own, so Enter there leaves focus on the Canvas root rather
// than moving it nowhere; still "somewhere sensible", asserted explicitly below.)

/** Presses Tab repeatedly (never clicking) until document.activeElement carries the given
 * data-testid. This doubles as the "no keyboard trap" proof for the elements it walks past: many
 * of them (sidebar rows, the search box, disclosure triangles, …) carry no data-testid of their
 * own, so a real trap would exhaust `maxPresses` without ever reaching the target — the same
 * failure a plain "Tab enough times and see" walk would hit, just made explicit here as a thrown
 * error instead of a silent timeout. */
async function focusByKeyboard(page: Page, testId: string, maxPresses = 100): Promise<void> {
  for (let attempt = 0; attempt <= maxPresses; attempt++) {
    const activeTestId = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? null,
    );
    if (activeTestId === testId) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(
    `Could not reach element with data-testid="${testId}" via Tab within ${maxPresses} presses ` +
      '(either a real keyboard trap, or the chain genuinely needs more presses than this bound)',
  );
}

async function activeElementInfo(
  page: Page,
): Promise<{ tag: string | undefined; testId: string | null; isBody: boolean }> {
  return page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    testId: document.activeElement?.getAttribute('data-testid') ?? null,
    isBody: document.activeElement === document.body,
  }));
}

async function assertFocusIsSensible(page: Page, label: string): Promise<void> {
  const info = await activeElementInfo(page);
  expect(info.isBody, `${label}: focus fell back to <body> (lost)`).toBe(false);
  expect(info.tag, `${label}: no element is focused at all`).toBeTruthy();
}

test.describe('Keyboard-only golden path: Task -> message -> Team -> Canvas nav -> List -> back', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('a11y-golden-path');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('completes entirely via page.keyboard, focus never lost, Tab never traps', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);

    // --- 1. Create a Task via Tab traversal + Enter. ---
    await focusByKeyboard(page, 'sidebar-new-task-button');
    await page.keyboard.press('Enter');
    await assertFocusIsSensible(page, 'after creating the Task');

    // --- 2. Tab to the composer, type, Enter to send. ---
    await focusByKeyboard(page, 'composer-textarea');
    const firstMessage = 'キーボードのみでのgolden path (a11y)';
    await page.keyboard.type(firstMessage);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('assistant-message')).toContainText('決定論的なモック応答です');
    await assertFocusIsSensible(page, 'after sending the first chat message');

    // --- 3. Tab to "⬡ Team", Enter — promotes to Team. Focus must land on the Canvas, not body
    // (see file header: this used to drop to <body>). ---
    await focusByKeyboard(page, 'team-toggle');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('team-list')).toBeVisible();
    let info = await activeElementInfo(page);
    expect(info.isBody).toBe(false);
    expect(info.testId).toBe('team-list');

    // --- 4. Select the Leader ('l') and Enter into its composer — the SAME composer instance
    // (SurfaceLayer), now re-parented into the Canvas. Send the チームテスト scenario trigger. ---
    await page.keyboard.press('l');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-textarea')).toBeFocused();
    await page.keyboard.type('チームテスト：golden path確認');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('team-worker')).toHaveCount(3, { timeout: 20_000 });
    const workerCards = page.getByTestId('team-worker');
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(workerCards.nth(i).locator('.team-status')).toHaveText('done', { timeout: 20_000 });
    }
    await assertFocusIsSensible(page, 'after the Leader hires/dispatches/reports (チームテスト)');

    // --- 5. Escape returns focus to the Canvas root from anywhere inside it (here: the composer). ---
    await page.keyboard.press('Escape');
    info = await activeElementInfo(page);
    expect(info.isBody).toBe(false);
    expect(info.testId).toBe('team-list');

    // --- 6. Arrow-key selection cycles Leader + 3 Workers (order-agnostic here: step 4 already
    // left the Leader selected via 'l', so the very next ArrowRight moves on from there rather
    // than starting fresh — team-canvas-layout.spec.ts already covers the exact cycle order from
    // a clean start). Enter "opens" the selection: every Worker is already terminal (`done`) by
    // now, so its only interactive element (停止) is disabled and cannot itself take focus — focus
    // staying on the Canvas root is the correct, sensible outcome here (asserted explicitly, not
    // just "not body"). ---
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.node-selected')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.node-selected')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await assertFocusIsSensible(page, 'after Enter on a terminal Worker');
    info = await activeElementInfo(page);
    expect(info.testId).toBe('team-list');

    // --- 7. 'f' fits the view (camera ownership hands back to 'system' — no assertion needed
    // beyond "no crash, focus still sensible": team-canvas-layout.spec.ts already covers the
    // ownership transition itself). ---
    await page.keyboard.press('f');
    await assertFocusIsSensible(page, "after 'f' (fit view)");

    // --- 8. 'l' + Enter re-enters the Leader's composer — moving DOM focus off the Canvas root
    // means Tab now resumes normal document-order traversal (see file header comment). Tab forward
    // to "List表示" and activate it with Enter. ---
    await page.keyboard.press('l');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-textarea')).toBeFocused();
    await focusByKeyboard(page, 'team-view-toggle');
    await page.keyboard.press('Enter');
    await expect(page.locator('.team-list-view')).toBeVisible();
    await expect(page.getByTestId('team-list')).toHaveCount(1); // Canvas unmounted, List mounted
    info = await activeElementInfo(page);
    expect(info.isBody).toBe(false);

    // List View must show the same settled Team (parity is machine-diffed in its own spec;
    // this just confirms the view actually switched to real content, not an empty shell).
    await expect(page.getByTestId('team-worker')).toHaveCount(3);

    // --- 9. Tab to "戻る", Enter — back to plain chat. Focus must return to "⬡ Team", not body
    // (file header: this also used to drop to <body>). ---
    await focusByKeyboard(page, 'team-back');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('team-list')).not.toBeVisible();
    await expect(page.locator('.app-shell')).not.toHaveClass(/team-mode/);
    info = await activeElementInfo(page);
    expect(info.isBody).toBe(false);
    expect(info.testId).toBe('team-toggle');

    // --- 10. Chat is still fully keyboard-reachable and usable afterward: Tab back to the
    // composer, type, and confirm it actually accepted the input. (Not sending it: once a Task has
    // ever had a Team, this mock backend's turn sampler stays routed as "team scenario" for every
    // later turn on that Task regardless of content — a separate, out-of-scope backend routing
    // issue in apps/desktop/src/main/runtime.ts, flagged separately, not an accessibility concern
    // and not something this renderer/e2e-scoped spec should depend on or paper over.) ---
    await focusByKeyboard(page, 'composer-textarea');
    const finalDraft = 'Teamから戻った後もchatは使えます';
    await page.keyboard.type(finalDraft);
    await expect(page.getByTestId('composer-textarea')).toHaveValue(finalDraft);
    await expect(page.getByTestId('composer-textarea')).toBeEnabled();
    await expect(page.getByTestId('composer-send-button')).toBeEnabled();
  });
});
