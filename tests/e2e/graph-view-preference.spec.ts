import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

for (const kind of ['architecture', 'workflow'] as const) {
  test(`restores ${kind} selection in the real viewer after reopen and restart`, async ({}, info) => {
    const profile = createUserDataDir(`graph-view-preference-${kind}`);
    let app = await launchApp(profile, undefined, {
      SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
      PATH: '',
      Path: '',
    });
    try {
      const page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      const taskId = await page.evaluate(
        async () => (await window.sprintCoder!.tasks.list())[0]!.id,
      );
      // The graph comes from the model's graph tool, as in use, and the panel opens on its own:
      // the architecture fixture is a plain proposal, the workflow one carries a Mission plan.
      await page
        .getByTestId('composer-textarea')
        .fill(
          kind === 'architecture' ? '[fixture:graph-proposal]' : '[fixture:graph-mission-proposal]',
        );
      await page.getByTestId('composer-send-button').click();
      await expect(page.getByTestId('assistant-message').last()).toContainText(
        'GRAPH_TOOL_FLOW_OK',
        { timeout: 30000 },
      );
      await expect(page.getByTestId('graph-panel')).toBeVisible();
      const frame = page.frameLocator('[data-testid="graph-frame"]');
      await expect(page.getByTestId('graph-frame')).toHaveAttribute('data-graph-ready', '1');
      await frame.locator('[data-node-id="api"]').first().click();
      await expect(page.getByTestId('graph-selection')).toContainText('api');
      await expect(frame.locator('[data-node-id="api"][data-focus-selected]')).toHaveCount(1);
      // Selecting a node fetches the evidence status; its line appears below the diagram a moment
      // later and shrinks the flexed frame above the history disclosure. Let that reflow land before
      // clicking the summary, or the click can arrive on a row that just moved.
      await expect(page.getByTestId('graph-source-freshness')).toBeVisible();
      await page.getByTestId('graph-history').locator('summary').click();
      await expect(page.getByTestId('graph-history')).toHaveAttribute('open', '');
      const before = await page.getByTestId('graph-frame').getAttribute('src');
      await page
        .getByTestId('graph-panel')
        .getByRole('button', { name: '閉じる', exact: true })
        .click();
      // Closed panels come back from the inline card in the reply that rendered the graph.
      await page.getByTestId('inline-graph-open').last().click();
      await expect(page.getByTestId('graph-selection')).toContainText('api');
      await expect(frame.locator('[data-node-id="api"][data-focus-selected]')).toHaveCount(1);
      await expect(page.getByTestId('graph-history')).toHaveAttribute('open', '');
      expect(await page.getByTestId('graph-frame').getAttribute('src')).not.toBe(before);
      await closeApp(app);
      app = await launchApp(profile, undefined, { PATH: '', Path: '' });
      const restarted = await firstWindow(app);
      await restarted.locator(`[data-task-id="${taskId}"] button.sb-item`).click();
      await restarted.getByTestId('inline-graph-open').last().click();
      await expect(restarted.getByTestId('graph-selection')).toContainText('api');
      await expect(
        restarted
          .frameLocator('[data-testid="graph-frame"]')
          .locator('[data-node-id="api"][data-focus-selected]'),
      ).toHaveCount(1);
      await expect(restarted.getByTestId('graph-history')).toHaveAttribute('open', '');
      await restarted
        .frameLocator('[data-testid="graph-frame"]')
        .locator('body')
        .evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
      const path = info.outputPath(`${kind}-restored.png`);
      await restarted.getByTestId('graph-panel').screenshot({ path });
      await info.attach('restored-selection', { path, contentType: 'image/png' });
      // Windows can capture a blank OOPIF in the first clipped image despite completed DOM
      // restoration. Keep that image and add the native surface without activating the window.
      const nativeImage = await app.evaluate(async ({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length !== 1) throw new Error('Expected one acceptance window');
        return (await windows[0]!.capturePage(undefined, { stayHidden: true, stayAwake: false }))
          .toPNG()
          .toString('base64');
      });
      const nativePath = info.outputPath(`${kind}-restored-native.png`);
      await writeFile(nativePath, Buffer.from(nativeImage, 'base64'));
      await info.attach('restored-native-surface', {
        path: nativePath,
        contentType: 'image/png',
      });
    } finally {
      await closeApp(app);
      removeUserDataDir(profile);
    }
  });
}
