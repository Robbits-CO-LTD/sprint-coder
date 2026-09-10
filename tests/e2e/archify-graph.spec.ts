import { expect, test } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

for (const kind of ['architecture', 'workflow'] as const) {
  test(`renders pinned Archify ${kind} inside a sandboxed Task panel`, async ({}, testInfo) => {
    const profile = createUserDataDir(`archify-${kind}`);
    const app = await launchApp(profile);
    try {
      const page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      const taskId = await page.evaluate(
        async () => (await window.sprintCoder!.tasks.list())[0]!.id,
      );
      const nodes = ['client', 'api', 'store'].map((id, index) => ({
        id,
        type: 'backend',
        label: id,
        ...(kind === 'architecture'
          ? { pos: [40 + index * 220, 40] }
          : { lane: 'steps', col: index }),
      }));
      const edges = [
        { id: 'request', from: 'client', to: 'api' },
        { id: 'persist', from: 'api', to: 'store' },
      ];
      const diagram = {
        schema_version: kind === 'workflow' ? 2 : 1,
        diagram_type: kind,
        meta: { title: `Archify ${kind}` },
        cards: [],
        ...(kind === 'architecture'
          ? { components: nodes, connections: edges }
          : { nodes, edges, lanes: [{ id: 'steps', label: 'Steps' }] }),
      };
      const view = await page.evaluate(async (input) => window.sprintCoder!.graphs.render(input), {
        taskId,
        diagram,
      });
      await page.getByTestId('composer-textarea').fill('existing draft');
      await page.getByTestId('graph-toggle').click();
      const panel = page.getByTestId('graph-panel');
      const frame = page.frameLocator('[data-testid="graph-frame"]');
      await expect(frame.locator('svg[role="img"]')).toBeVisible();
      expect(await frame.locator('body').evaluate(() => typeof window.sprintCoder)).toBe(
        'undefined',
      );
      await expect(page.getByTestId('graph-frame')).toHaveAttribute('sandbox', 'allow-scripts');
      await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
      await frame.locator('#btn-theme').click();
      await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light');
      await frame.locator('#btn-theme').click();
      await frame.locator('[data-node-id="api"]').first().click();
      await expect(panel.getByTestId('graph-selection')).toContainText('api');
      await panel
        .getByRole('textbox', { name: 'この箇所への指示' })
        .fill('ここを独立した工程にして');
      await panel.getByRole('button', { name: 'チャット入力へ追加' }).click();
      await expect(page.getByTestId('composer-textarea')).toHaveValue(
        new RegExp(`existing draft[\\s\\S]*独立した工程[\\s\\S]*${view.id}`),
      );
      const screenshot = testInfo.outputPath(`${kind}.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`Archify ${kind} in Electron`, {
        path: screenshot,
        contentType: 'image/png',
      });
      const displayedUrl = await page.getByTestId('graph-frame').getAttribute('src');
      expect(
        await app.evaluate(async ({ net }, url) => (await net.fetch(url!)).status, displayedUrl),
      ).toBe(200);
      await panel.getByRole('button', { name: '閉じる', exact: true }).click();
      await expect(page.getByTestId('graph-toggle')).toBeFocused();
      await expect
        .poll(() =>
          app.evaluate(async ({ net }, url) => (await net.fetch(url!)).status, displayedUrl),
        )
        .toBe(404);
      if (kind === 'architecture') {
        const result = await page.evaluate(
          async (input) => {
            const pending = window.sprintCoder!.graphs.render(input).then(
              () => 'published',
              () => 'canceled',
            );
            await window.sprintCoder!.graphs.cancel(input.taskId);
            return {
              result: await pending,
              retained: await window.sprintCoder!.graphs.get(input.taskId),
            };
          },
          { taskId, diagram: { ...diagram, meta: { title: 'Canceled replacement' } } },
        );
        expect(result.result).toBe('canceled');
        expect(result.retained?.revision).toBe(view.revision);
      }
    } finally {
      await closeApp(app);
      removeUserDataDir(profile);
    }
  });
}
