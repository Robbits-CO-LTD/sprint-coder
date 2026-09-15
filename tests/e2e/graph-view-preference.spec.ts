import { expect, test } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

for (const kind of ['architecture', 'workflow'] as const) {
  test(`restores ${kind} selection in the real viewer after reopen and restart`, async ({}, info) => {
    const profile = createUserDataDir(`graph-view-preference-${kind}`);
    let app = await launchApp(profile, undefined, { PATH: '', Path: '' });
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
      await page.evaluate(async (input) => window.sprintCoder!.graphs.render(input), {
        taskId,
        diagram: {
          schema_version: kind === 'workflow' ? 2 : 1,
          diagram_type: kind,
          meta: { title: `Selection restoration ${kind}` },
          cards: [],
          ...(kind === 'architecture'
            ? { components: nodes, connections: edges }
            : { nodes, edges, lanes: [{ id: 'steps', label: 'Steps' }] }),
        },
      });
      await page.getByTestId('graph-toggle').click();
      const frame = page.frameLocator('[data-testid="graph-frame"]');
      await expect(page.getByTestId('graph-frame')).toHaveAttribute('data-graph-ready', '1');
      await frame.locator('[data-node-id="api"]').first().click();
      await expect(page.getByTestId('graph-selection')).toContainText('api');
      await expect(frame.locator('[data-node-id="api"][data-focus-selected]')).toHaveCount(1);
      await page.getByTestId('graph-history').locator('summary').click();
      await expect(page.getByTestId('graph-history')).toHaveAttribute('open', '');
      const before = await page.getByTestId('graph-frame').getAttribute('src');
      await page
        .getByTestId('graph-panel')
        .getByRole('button', { name: '閉じる', exact: true })
        .click();
      await page.getByTestId('graph-toggle').click();
      await expect(page.getByTestId('graph-selection')).toContainText('api');
      await expect(frame.locator('[data-node-id="api"][data-focus-selected]')).toHaveCount(1);
      await expect(page.getByTestId('graph-history')).toHaveAttribute('open', '');
      expect(await page.getByTestId('graph-frame').getAttribute('src')).not.toBe(before);
      await closeApp(app);
      app = await launchApp(profile, undefined, { PATH: '', Path: '' });
      const restarted = await firstWindow(app);
      await restarted.locator(`[data-task-id="${taskId}"] button.sb-item`).click();
      await restarted.getByTestId('graph-toggle').click();
      await expect(restarted.getByTestId('graph-selection')).toContainText('api');
      await expect(
        restarted
          .frameLocator('[data-testid="graph-frame"]')
          .locator('[data-node-id="api"][data-focus-selected]'),
      ).toHaveCount(1);
      await expect(restarted.getByTestId('graph-history')).toHaveAttribute('open', '');
      const path = info.outputPath(`${kind}-restored.png`);
      await restarted.getByTestId('graph-panel').screenshot({ path });
      await info.attach('restored-selection', { path, contentType: 'image/png' });
    } finally {
      await closeApp(app);
      removeUserDataDir(profile);
    }
  });
}
