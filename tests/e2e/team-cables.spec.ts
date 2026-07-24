import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Phase 6 Slice 6.4 acceptance (docs §9 "Slice 6.4" + Acceptance): cables only appear on an actual
// Team message (never on hire), connect the right source/target pair, glow only once acked, never
// auto-move the camera, and substitute a static highlight + textual event under reduced motion.

async function currentTaskId(page: Page): Promise<string> {
  return page.evaluate(async () => (await window.sprintCoder!.tasks.list())[0]!.id);
}

async function hireWorker(page: Page, role: string, objective: string): Promise<void> {
  await page.getByLabel('役割').fill(role);
  await page.getByLabel('目的').fill(objective);
  await page.getByTestId('team-hire').click();
}

async function readWorldTransform(page: Page): Promise<string> {
  return page.locator('.team-world').evaluate((el: HTMLElement) => el.style.transform);
}

test.describe('Phase 6 Slice 6.4: Communication cable', () => {
  test('no cable or glow appears while hiring a Worker', async () => {
    const userDataDir = createUserDataDir('cables-no-hire-glow');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      await hireWorker(page, '実装', '機能を実装する');
      await expect(page.getByTestId('team-worker')).toHaveCount(1);

      // Give any (incorrect) hire-triggered animation a moment to have appeared if it were going
      // to, then assert it never did.
      await page.waitForTimeout(300);
      await expect(page.locator('.cable-path')).toHaveCount(0);
      await expect(page.locator('.w-head.glow')).toHaveCount(0);
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });

  test('Leader send draws a cable between the correct pair and glows only after ack', async () => {
    const userDataDir = createUserDataDir('cables-send-glow');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await hireWorker(page, '実装', '機能を実装する');
      await expect(page.getByTestId('team-worker')).toHaveCount(1);

      const taskId = await currentTaskId(page);
      const workerAgentId = await page.getByTestId('team-worker').first().getAttribute('data-agent-id');
      const leaderAgentId: string = await page.evaluate(
        async (id) => (await window.sprintCoder!.teams.get(id))!.team.leaderAgentId,
        taskId,
      );

      const card = page.getByTestId('team-worker').first();
      await card.getByLabel('依頼').fill('cable pair test');
      await card.getByRole('button', { name: 'Leaderから送信' }).click();

      const cable = page.locator('.cable-path').first();
      await cable.waitFor({ state: 'attached', timeout: 2_000 });
      expect(await cable.getAttribute('data-source-id')).toBe(leaderAgentId);
      expect(await cable.getAttribute('data-target-id')).toBe(workerAgentId);

      // Glow only fires on the receiving Worker's head — with the mock backend's synchronous
      // ack this is the fast path (Slice 6.4 item 4), still gated through the same decision fn.
      await expect(page.locator('.w-head.glow')).toHaveCount(1, { timeout: 3_000 });

      // The delivery ack / visual causality: the request eventually completes (`.team-status`
      // becomes 'done'), which itself queues a Worker -> Leader report cable next.
      await expect(card.locator('.team-status')).toHaveText('done', { timeout: 20_000 });
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });

  test('two messages queued back-to-back to different Workers both play their cables', async () => {
    const userDataDir = createUserDataDir('cables-sequential-pump');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await hireWorker(page, '実装', '機能を実装する');
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await page.getByTestId('team-canvas-fit').click();
      await hireWorker(page, 'レビュー', '変更をレビューする');
      await expect(page.getByTestId('team-worker')).toHaveCount(2);

      const cards = page.getByTestId('team-worker');
      await cards.nth(0).getByLabel('依頼').fill('worker one');
      await cards.nth(0).getByRole('button', { name: 'Leaderから送信' }).click();
      await cards.nth(1).getByLabel('依頼').fill('worker two');
      await cards.nth(1).getByRole('button', { name: 'Leaderから送信' }).click();

      // Sequential pump (Slice 6.4 item 5a): both eventually glow, proving neither cable was
      // dropped even though they were queued back-to-back.
      await expect(cards.nth(0).locator('.w-head.glow')).toHaveCount(1, { timeout: 5_000 });
      await expect(cards.nth(1).locator('.w-head.glow')).toHaveCount(1, { timeout: 5_000 });
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });

  test('a message to an offscreen Worker still plays its cable without moving the camera', async () => {
    const userDataDir = createUserDataDir('cables-offscreen-no-follow');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await hireWorker(page, '実装', '機能を実装する');
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await page.getByTestId('team-canvas-fit').click();
      await page.waitForTimeout(700);

      // Pan the camera far away (drag an empty area of the canvas — its bottom-left corner,
      // clear of the top `.team-header-overlay`, the bottom-right `.team-canvas-controls`, and
      // any node, since Fit view centers the Leader/Worker cluster) so the Worker ends up clipped
      // outside the viewport.
      const canvasBox = await page.locator('.team-canvas').boundingBox();
      if (!canvasBox) throw new Error('team-canvas not found');
      const startX = canvasBox.x + 30;
      const startY = canvasBox.y + canvasBox.height - 30;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 2200, startY + 1600, { steps: 15 });
      await page.mouse.up();
      await expect(page.locator('.team-canvas')).toHaveAttribute('data-camera-owner', 'user');

      const transformBefore = await readWorldTransform(page);

      const taskId = await currentTaskId(page);
      const workerAgentId = await page
        .getByTestId('team-worker')
        .first()
        .getAttribute('data-agent-id');
      // Sent directly via the same API the UI uses — the Worker card itself is now clipped
      // outside `.team-canvas`'s viewport (overflow: clip), so a UI click is not a reliable way
      // to drive this without reintroducing the very camera move being asserted against.
      await page.evaluate(
        async ({ id, target }) => {
          await window.sprintCoder!.teams.sendToWorker({
            taskId: id,
            targetAgentId: target as string,
            content: 'offscreen delivery test',
          });
        },
        { id: taskId, target: workerAgentId },
      );

      await page.locator('.cable-path').first().waitFor({ state: 'attached', timeout: 2_000 });

      // No auto-follow of the delivery, and — per the 6.4 acceptance ("focus後に自動でLeaderへ
      // 戻らない") — no automatic return-to-Leader once the Worker's automatic report lands
      // either. Let both cables (dispatch + report) fully play out, then compare.
      await page.waitForTimeout(3_000);
      const transformAfter = await readWorldTransform(page);
      expect(transformAfter).toBe(transformBefore);
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });

  test('cable animation survives an active pan without throwing, and is eventually removed', async () => {
    const userDataDir = createUserDataDir('cables-pan-robustness');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => consoleErrors.push(String(err)));

      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await hireWorker(page, '実装', '機能を実装する');
      await expect(page.getByTestId('team-worker')).toHaveCount(1);
      await page.getByTestId('team-canvas-fit').click();
      await page.waitForTimeout(700);

      const card = page.getByTestId('team-worker').first();
      await card.getByLabel('依頼').fill('pan during cable');
      await card.getByRole('button', { name: 'Leaderから送信' }).click();

      // Immediately drag-pan while the cable is (most likely) mid-flight — bottom-left corner,
      // clear of the top header overlay, bottom-right controls, and the Leader/Worker cluster
      // Fit view centered.
      const canvasBox = await page.locator('.team-canvas').boundingBox();
      if (!canvasBox) throw new Error('team-canvas not found');
      const startX = canvasBox.x + 30;
      const startY = canvasBox.y + canvasBox.height - 30;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 300, startY - 200, { steps: 10 });
      await page.mouse.up();

      await expect(page.locator('.cable-path')).toHaveCount(0, { timeout: 5_000 });
      expect(consoleErrors).toEqual([]);
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });

  test('reduced motion: no path/packets — immediate highlight plus a mirrored textual event', async () => {
    const userDataDir = createUserDataDir('cables-reduced-motion');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page: Page = await firstWindow(app);
      await page.emulateMedia({ reducedMotion: 'reduce' });

      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await hireWorker(page, '実装', '機能を実装する');
      await expect(page.getByTestId('team-worker')).toHaveCount(1);

      const card = page.getByTestId('team-worker').first();
      await card.getByLabel('依頼').fill('reduced motion test');
      await card.getByRole('button', { name: 'Leaderから送信' }).click();

      // No path/packets at all under reduced motion.
      await expect(page.locator('.cable-path')).toHaveCount(0);
      // Immediate highlight on the receiving Worker's head.
      await expect(card.locator('.w-head.glow')).toHaveCount(1, { timeout: 2_000 });
      // Textual event for the Leader -> Worker dispatch. Under reduced motion this fires (and the
      // Worker's automatic completion report fires its OWN event right after) essentially
      // instantly, so the aria-live announcer's single slot may already have moved on to the
      // second ("...報告を受信 (ack)") text by the time this assertion runs — the transient visual
      // overlay is the reliable place to check since each event gets its OWN element that
      // persists independently for ~3s, so both can be asserted even after the fact.
      await expect(page.locator('.team-cable-event', { hasText: '依頼を送信' })).toBeVisible();
      await expect(page.locator('.team-cable-event', { hasText: '報告を受信' })).toBeVisible();
      // The aria-live mirror carries whichever event most recently fired, in every motion mode.
      await expect(page.getByTestId('team-cable-announcer')).not.toHaveText('');
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });
});
