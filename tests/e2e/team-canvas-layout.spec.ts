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
