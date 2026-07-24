import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Phase 6 Slice 6.1: Canvas base (layout persistence, LOD, list fallback).

type WorldPosition = { left: string; top: string };

async function readWorkerPosition(page: Page): Promise<WorldPosition> {
  return page
    .getByTestId('team-worker')
    .first()
    .evaluate((el: HTMLElement) => ({ left: el.style.left, top: el.style.top }));
}

async function readWorldTransform(page: Page): Promise<{ x: number; y: number; s: number }> {
  const transform = await page.locator('.team-world').evaluate((el: HTMLElement) => el.style.transform);
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`Unparseable transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), s: Number(match[3]) };
}

// Nudges the camera's zoom level (wheel over the canvas center) until `.team-canvas`'s data-lod
// attribute reaches `target`, correcting for overshoot past lod2 when aiming for lod1.
async function setLod(page: Page, target: '1' | '2'): Promise<void> {
  const canvasBox = await page.locator('.team-canvas').boundingBox();
  if (!canvasBox) throw new Error('team-canvas not found');
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  for (let i = 0; i < 60; i += 1) {
    const current = await page.locator('.team-canvas').getAttribute('data-lod');
    if (current === target) return;
    const overshot = target === '1' && current === '2';
    // eslint-disable-next-line no-await-in-loop
    await page.mouse.wheel(0, overshot ? -40 : 60);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(30);
  }
  throw new Error(`Could not reach data-lod="${target}"`);
}

test.describe('Phase 6 Slice 6.1: Canvas base', () => {
  test('persists a dragged node position and camera across restart, and LOD hides Worker body', async () => {
    const userDataDir = createUserDataDir('canvas-layout-persist');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      let page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      await page.getByLabel('役割').fill('実装');
      await page.getByLabel('目的').fill('機能を実装する');
      await page.getByTestId('team-hire').click();
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await page.getByTestId('team-canvas-fit').click();
      await page.waitForTimeout(700); // let the fit settle before reading a baseline position

      const before = await readWorkerPosition(page);

      // Drag the Worker card by its `.w-head` to a clearly different world position.
      const head = page.getByTestId('team-worker').locator('.w-head');
      const headBox = await head.boundingBox();
      if (!headBox) throw new Error('worker head not found');
      const startX = headBox.x + headBox.width / 2;
      const startY = headBox.y + headBox.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 170, startY + 95, { steps: 12 });
      await page.mouse.up();

      const afterDrag = await readWorkerPosition(page);
      expect(afterDrag).not.toEqual(before);

      // Zoom out to lod1 and assert the Worker body (message history + composer) is hidden while
      // the head (role/status/objective) stays put — FR-CAN-04.
      await setLod(page, '1');
      await expect(page.locator('.team-canvas')).toHaveAttribute('data-lod', '1');
      await expect(page.getByTestId('team-worker').locator('.w-body')).not.toBeVisible();
      await expect(page.getByTestId('team-worker').locator('.role-name')).toBeVisible();
      await expect(page.getByTestId('team-worker').locator('.w-status')).toBeVisible();

      const cameraBeforeRestart = await readWorldTransform(page);

      // Let the debounced autosave (drag end + zoom settle) actually flush before restarting.
      await page.waitForTimeout(1_500);

      const taskId: string = await page.evaluate(async () => {
        const tasks = await window.sprintCoder!.tasks.list();
        return tasks[0]!.id;
      });
      const savedBeforeRestart = await page.evaluate(
        (id) => window.sprintCoder!.teams.getCanvasView(id),
        taskId,
      );
      expect(savedBeforeRestart).not.toBeNull();
      // The drag-end and zoom-settle triggers land close together and debounce into however many
      // actual autosaves that coalesces to (implementation detail) — what matters is that at least
      // one save landed, moving the revision from "nothing saved yet" to a real value.
      expect(savedBeforeRestart!.revision).toBeGreaterThanOrEqual(1);

      await closeApp(app);
      app = await launchApp(userDataDir);
      page = await firstWindow(app);
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await page.waitForTimeout(1_200); // let the saved-view redirect settle (async load + fly)

      const afterRestart = await readWorkerPosition(page);
      expect(Math.abs(parseFloat(afterRestart.left) - parseFloat(afterDrag.left))).toBeLessThanOrEqual(5);
      expect(Math.abs(parseFloat(afterRestart.top) - parseFloat(afterDrag.top))).toBeLessThanOrEqual(5);

      const cameraAfterRestart = await readWorldTransform(page);
      expect(Math.abs(cameraAfterRestart.x - cameraBeforeRestart.x)).toBeLessThanOrEqual(5);
      expect(Math.abs(cameraAfterRestart.y - cameraBeforeRestart.y)).toBeLessThanOrEqual(5);
      expect(Math.abs(cameraAfterRestart.s - cameraBeforeRestart.s)).toBeLessThanOrEqual(0.05);

      const savedAfterRestart = await page.evaluate(
        (id) => window.sprintCoder!.teams.getCanvasView(id),
        taskId,
      );
      expect(savedAfterRestart!.revision).toBeGreaterThanOrEqual(savedBeforeRestart!.revision);
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });

  test('List表示 fallback hires and messages a Worker, and Canvas表示 shows it back', async () => {
    const userDataDir = createUserDataDir('canvas-list-fallback');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      await page.getByTestId('team-view-toggle').click();
      await expect(page.getByTestId('team-view-toggle')).toHaveText('Canvas表示');
      // Chat stays visible alongside the List panel (list mode = chat layout + a team panel).
      await expect(page.getByTestId('composer-textarea')).toBeVisible();

      await page.getByLabel('役割').fill('実装');
      await page.getByLabel('目的').fill('機能を実装する');
      await page.getByTestId('team-hire').click();
      await expect(page.getByTestId('team-worker')).toHaveCount(1);

      const card = page.getByTestId('team-worker').first();
      await card.getByLabel('依頼').fill('List表示からの依頼');
      await card.getByRole('button', { name: 'Leaderから送信' }).click();
      await expect(card.locator('.team-status')).toHaveText('done');

      await page.getByTestId('team-view-toggle').click();
      await expect(page.getByTestId('team-view-toggle')).toHaveText('List表示');
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await expect(page.locator('.team-canvas')).toBeVisible();
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });
});

// Phase 6 Slice 6.3: CameraDirector ownership + collision-aware placement.
test.describe('Phase 6 Slice 6.3: Camera director and placement', () => {
  test('camera ownership starts system, a manual pan claims user, and Fit view returns it to system', async () => {
    const userDataDir = createUserDataDir('camera-ownership');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      // Entering the canvas is system-owned (seed-then-fly) — let that settle first.
      await page.waitForTimeout(700);
      await expect(page.locator('.team-canvas')).toHaveAttribute('data-camera-owner', 'system');

      const canvasBox = await page.locator('.team-canvas').boundingBox();
      if (!canvasBox) throw new Error('team-canvas not found');
      const startX = canvasBox.x + canvasBox.width / 2;
      const startY = canvasBox.y + canvasBox.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 120, startY + 80, { steps: 8 });
      await page.mouse.up();
      await expect(page.locator('.team-canvas')).toHaveAttribute('data-camera-owner', 'user');

      // An explicit user view command (Fit view) always executes and hands ownership back.
      await page.getByTestId('team-canvas-fit').click();
      await expect(page.locator('.team-canvas')).toHaveAttribute('data-camera-owner', 'system');
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });

  test('a manually-repositioned Worker does not collide with a newly hired one', async () => {
    const userDataDir = createUserDataDir('placement-collision');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();

      await page.getByLabel('役割').fill('実装');
      await page.getByLabel('目的').fill('機能を実装する');
      await page.getByTestId('team-hire').click();
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await page.getByTestId('team-canvas-fit').click();
      await page.waitForTimeout(700);

      // Drag the first Worker directly onto the SECOND Worker's default slot (WORKER_SLOTS[1] in
      // TeamCanvas.tsx: {x:1000, y:420}), so hiring a second Worker next would collide with it if
      // placement were still a fixed, unconditional slot lookup. The screen-space drag delta is
      // computed from the CURRENT camera scale (read from `.team-world`'s transform) rather than
      // assumed — Fit view's scale depends on the actual window size, not always ~1.
      const beforeDrag = await readWorkerPosition(page);
      const cam = await readWorldTransform(page);
      const targetWorldPos = { x: 1000, y: 420 };
      const worldDx = targetWorldPos.x - parseFloat(beforeDrag.left);
      const worldDy = targetWorldPos.y - parseFloat(beforeDrag.top);

      const head = page.getByTestId('team-worker').locator('.w-head');
      const headBox = await head.boundingBox();
      if (!headBox) throw new Error('worker head not found');
      const startX = headBox.x + headBox.width / 2;
      const startY = headBox.y + headBox.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + worldDx * cam.s, startY + worldDy * cam.s, { steps: 12 });
      await page.mouse.up();

      const afterDrag = await readWorkerPosition(page);
      // Sanity check the drag actually landed near the intended world position — otherwise the
      // rest of this test wouldn't be exercising the intended collision scenario at all.
      expect(Math.abs(parseFloat(afterDrag.left) - targetWorldPos.x)).toBeLessThan(20);
      expect(Math.abs(parseFloat(afterDrag.top) - targetWorldPos.y)).toBeLessThan(20);

      // Re-fit: the drag itself only moves the Worker in world space, but the hire ghost may now
      // have relocated to avoid it (`recomputeHirePosition`), potentially outside the camera view
      // that was fit for the pre-drag layout — bring everything back into view before hiring.
      await page.getByTestId('team-canvas-fit').click();
      await page.waitForTimeout(700);

      await page.getByLabel('役割').fill('レビュー');
      await page.getByLabel('目的').fill('変更をレビューする');
      await page.getByTestId('team-hire').click();
      await expect(page.getByTestId('team-worker')).toHaveCount(2);
      await page.waitForTimeout(300);

      const cards = page.getByTestId('team-worker');
      const secondPos = await cards
        .nth(1)
        .evaluate((el: HTMLElement) => ({ left: el.style.left, top: el.style.top }));

      // No overlap between the manually-dragged first Worker and the newly placed second, in
      // WORLD coordinates (the same space `findFreePosition`/`rectsOverlap` operate in) — this is
      // what the app itself reasons about, independent of camera scale/viewport quirks.
      const first = { x: parseFloat(afterDrag.left), y: parseFloat(afterDrag.top), w: 480, h: 260 };
      const second = {
        x: parseFloat(secondPos.left),
        y: parseFloat(secondPos.top),
        w: 480,
        h: 260,
      };
      const overlaps =
        first.x < second.x + second.w &&
        first.x + first.w > second.x &&
        first.y < second.y + second.h &&
        first.y + first.h > second.y;
      expect(overlaps).toBe(false);
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });
});

// Gate-review fix (test gap): canvas keyboard navigation (Arrow/Tab select, Enter opens + camera-
// focuses, Escape returns focus to the canvas root, 'f' fits view). Robust to layout — no pixel
// assertions, only classes/attributes.
test.describe('Canvas keyboard navigation', () => {
  test('Arrow/Tab select nodes, Enter opens + camera-focuses, Escape returns focus, F fits', async () => {
    const userDataDir = createUserDataDir('canvas-keyboard-nav');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      await page.waitForTimeout(700); // let the system seed-then-fly settle first

      const canvas = page.locator('.team-canvas');
      const leaderNode = page.locator('.surface--node');

      // --- Manual pan claims 'user' ownership, and keyboard 'f' hands it back to 'system'. ---
      // Done now, before any Worker exists and before Enter camera-focuses a single node — only
      // the Leader + hire ghost are on screen, so the canvas center is empty background, not a
      // node (`.worker`/`.surface--node` pointerdowns are excluded from panning, see useCamera.ts).
      await expect(canvas).toHaveAttribute('data-camera-owner', 'system');
      const canvasBox = await canvas.boundingBox();
      if (!canvasBox) throw new Error('team-canvas not found');
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        canvasBox.x + canvasBox.width / 2 + 60,
        canvasBox.y + canvasBox.height / 2 + 40,
        { steps: 8 },
      );
      await page.mouse.up();
      await expect(canvas).toHaveAttribute('data-camera-owner', 'user');

      await canvas.focus();
      await expect(canvas).toBeFocused();
      await canvas.press('f');
      await expect(canvas).toHaveAttribute('data-camera-owner', 'system');

      // --- Hire a Worker, then exercise Arrow/Tab selection + Enter/Escape. ---
      await page.getByLabel('役割').fill('実装');
      await page.getByLabel('目的').fill('機能を実装する');
      await page.getByTestId('team-hire').click();
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await page.getByTestId('team-canvas-fit').click();
      await page.waitForTimeout(700); // let the fit settle before reading a baseline

      const workerNode = page.getByTestId('team-worker');
      const hireNode = page.locator('.worker--hire');

      await canvas.focus();
      await expect(canvas).toBeFocused();

      // nodeIds order is [Leader, Worker, hire ghost] — ArrowRight walks forward through it.
      await canvas.press('ArrowRight');
      await expect(leaderNode).toHaveClass(/node-selected/);
      await expect(workerNode).not.toHaveClass(/node-selected/);

      await canvas.press('ArrowRight');
      await expect(workerNode).toHaveClass(/node-selected/);
      await expect(leaderNode).not.toHaveClass(/node-selected/);

      // Tab (no shift) is equivalent to ArrowRight — moves selection to the hire ghost next.
      await canvas.press('Tab');
      await expect(hireNode).toHaveClass(/node-selected/);
      await expect(workerNode).not.toHaveClass(/node-selected/);

      // Shift+Tab walks backward — back onto the Worker.
      await canvas.press('Shift+Tab');
      await expect(workerNode).toHaveClass(/node-selected/);

      // Enter: focuses the selected Worker's first focusable (its message textarea) and hands
      // camera ownership to 'system' via the explicit view command.
      await canvas.press('Enter');
      const focusedInsideWorker = await page.evaluate(() => {
        const active = document.activeElement;
        return (
          active?.tagName === 'TEXTAREA' && active.closest('[data-testid="team-worker"]') !== null
        );
      });
      expect(focusedInsideWorker).toBe(true);
      await expect(canvas).toHaveAttribute('data-camera-owner', 'system');

      // Escape returns keyboard focus to the canvas root even though a descendant (the textarea)
      // currently holds it.
      await page.keyboard.press('Escape');
      await expect(canvas).toBeFocused();
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });
});
