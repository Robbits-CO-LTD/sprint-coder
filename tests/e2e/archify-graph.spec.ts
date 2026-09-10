import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test('the model tool path proposes and reads back a draft through the real Main service', async () => {
  const profile = createUserDataDir('graph-tool-proposal');
  const app = await launchApp(profile, undefined, {
    SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
    PATH: '',
    Path: '',
  });
  try {
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await page.getByTestId('composer-textarea').fill('[fixture:graph-proposal]');
    await page.getByTestId('composer-send-button').click();
    await expect(page.getByTestId('assistant-message')).toContainText('GRAPH_TOOL_FLOW_OK', {
      timeout: 30000,
    });
    await expect(page.getByTestId('team-worker')).toHaveCount(0);
    const executionState = await page.evaluate(async () => {
      const task = (await window.sprintCoder!.tasks.list())[0]!;
      const team = await window.sprintCoder!.teams.get(task.id);
      return {
        workers: team?.workers.length ?? 0,
        missions: team?.missions.length ?? 0,
        executions: team?.executions.length ?? 0,
      };
    });
    expect(executionState).toEqual({ workers: 0, missions: 0, executions: 0 });
    await page.getByTestId('graph-toggle').click();
    const frame = page.frameLocator('[data-testid="graph-frame"]');
    await expect(frame.locator('svg[role="img"]')).toBeVisible();
    await expect(page.getByTestId('graph-panel')).toContainText('Graph tool proposal');
    await expect(frame.locator('[data-node-id="api"]').first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('model-graph-proposal.png') });
  } finally {
    await closeApp(app);
    removeUserDataDir(profile);
  }
});

for (const kind of ['architecture', 'workflow'] as const) {
  // Electron owns the browser; Playwright still requires its fixture argument before testInfo.
  // eslint-disable-next-line no-empty-pattern
  test(`renders pinned Archify ${kind} inside a sandboxed Task panel`, async ({}, testInfo) => {
    const profile = createUserDataDir(`archify-${kind}`);
    // The bundled worker must work without discovering an external Node on PATH.
    // Set both spellings because Windows environment keys are case-insensitive.
    let app = await launchApp(profile, undefined, { PATH: '', Path: '' });
    try {
      const page = await firstWindow(app);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 740);
      });
      // Hosted runners have no user's foreground application to preserve. Their
      // showInactive window needs focus for native pointer delivery; local tests
      // keep their hidden/non-focus presentation and never take this path.
      if (process.env['GITHUB_ACTIONS'] === 'true') {
        await app.evaluate(({ app: electronApp, BrowserWindow }) => {
          electronApp.focus({ steal: true });
          BrowserWindow.getAllWindows()[0]!.focus();
        });
        await expect
          .poll(() =>
            app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()),
          )
          .toBe(true);
      }
      await page.addInitScript(() => {
        const diagnostics = {
          errors: [] as string[],
          blockedDirectives: [] as string[],
          clicks: [] as { id: string; trusted: boolean }[],
        };
        Object.defineProperty(window, '__graphDiagnostics', { value: diagnostics });
        window.addEventListener('error', (event) => {
          if (diagnostics.errors.length < 10) diagnostics.errors.push(event.message.slice(0, 200));
        });
        document.addEventListener('securitypolicyviolation', (event) => {
          if (diagnostics.blockedDirectives.length < 10)
            diagnostics.blockedDirectives.push(event.effectiveDirective);
        });
        document.addEventListener(
          'click',
          (event) => {
            if (diagnostics.clicks.length < 10)
              diagnostics.clicks.push({
                id: event.target instanceof Element ? (event.target.closest('[id]')?.id ?? '') : '',
                trusted: event.isTrusted,
              });
          },
          true,
        );
      });
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
      await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true');
      await page.getByTestId('graph-toggle').click();
      const panel = page.getByTestId('graph-panel');
      const frame = page.frameLocator('[data-testid="graph-frame"]');
      await expect(frame.locator('svg[role="img"]')).toBeVisible();
      await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
      await expect
        .poll(async () => (await page.getByTestId('composer-textarea').boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(350);
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
      await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true');
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
              generation: await window.sprintCoder!.graphs.generation(input.taskId),
            };
          },
          { taskId, diagram: { ...diagram, meta: { title: 'Canceled replacement' } } },
        );
        expect(result.result).toBe('canceled');
        expect(result.retained?.revision).toBe(view.revision);
        expect(result.generation?.state).toBe('canceled');
      }
      const nodeKey = kind === 'architecture' ? 'components' : 'nodes';
      const revisedNodes = nodes.map((node) => ({
        ...node,
        label: node.id === 'api' ? 'API boundary' : node.label,
      }));
      const revisedDiagram = { ...diagram, [nodeKey]: revisedNodes };
      const changed = await page.evaluate(
        async (input) => window.sprintCoder!.graphs.render(input),
        { taskId, diagram: revisedDiagram },
      );
      expect(changed.revision).toBe(view.revision + 1);
      await page.getByTestId('graph-toggle').click();
      const history = page.getByTestId('graph-history');
      await expect(history).toHaveAttribute('data-render-revision', String(changed.renderRevision));
      await history.locator('summary').click();
      await expect(page.getByTestId('graph-diff')).toBeVisible();
      await expect(page.getByTestId('graph-diff')).toContainText('API boundary');
      const movedNodes = revisedNodes.map((node, index) => ({
        ...node,
        ...(kind === 'architecture' ? { pos: [60 + index * 220, 80] } : { col: index + 1 }),
      }));
      const redrawn = await page.evaluate(
        async (input) => window.sprintCoder!.graphs.render(input),
        {
          taskId,
          diagram: { ...revisedDiagram, [nodeKey]: movedNodes },
        },
      );
      expect(redrawn.revision).toBe(changed.revision);
      await expect(history).toHaveAttribute('data-render-revision', String(redrawn.renderRevision));
      await history.locator('summary').click();
      await expect(page.getByTestId('graph-diff')).toContainText('配置・表示のみ変わっています');
      await history
        .getByRole('combobox', { name: '比較する保存版' })
        .selectOption(String(view.renderRevision));
      await expect(page.getByTestId('graph-diff')).toContainText('API boundary');
      await page.screenshot({ path: testInfo.outputPath(`comparison-${kind}.png`) });
      await page
        .getByTestId('graph-panel')
        .getByRole('button', { name: '閉じる', exact: true })
        .click();
      await page.getByTestId('graph-toggle').click();
      await expect(
        page.frameLocator('[data-testid="graph-frame"]').locator('svg[role="img"]'),
      ).toBeVisible();
      const retainedUrl = await page.getByTestId('graph-frame').getAttribute('src');
      const rejection = await page.evaluate(
        async (input) =>
          window.sprintCoder!.graphs.render(input).then(
            () => 'published',
            () => 'rejected',
          ),
        {
          taskId,
          diagram: {
            ...revisedDiagram,
            meta: { title: 'Rejected proposal', output: '/outside.html' },
          },
        },
      );
      expect(rejection).toBe('rejected');
      await expect(page.getByTestId('graph-generation')).toHaveAttribute('data-state', 'failed');
      await expect(page.getByTestId('graph-generation')).toContainText(
        '新しい図を作成できませんでした',
      );
      await expect(page.getByTestId('graph-generation')).toContainText(
        `保存済みの版 ${redrawn.revision}`,
      );
      await expect(page.getByTestId('graph-frame')).toHaveAttribute('src', retainedUrl!);
      await page.screenshot({ path: testInfo.outputPath(`failed-proposal-${kind}.png`) });
      await page
        .getByTestId('graph-panel')
        .getByRole('button', { name: '閉じる', exact: true })
        .click();
      const savedDraft = await page.getByTestId('composer-textarea').inputValue();
      await expect
        .poll(() => page.evaluate(async (id) => window.sprintCoder!.tasks.getDraft(id), taskId))
        .toBe(savedDraft);
      await closeApp(app);
      app = await launchApp(profile, undefined, { PATH: '', Path: '' });
      const restarted = await firstWindow(app);
      if (process.env['GITHUB_ACTIONS'] === 'true') {
        await app.evaluate(({ app: electronApp, BrowserWindow }) => {
          electronApp.focus({ steal: true });
          BrowserWindow.getAllWindows()[0]!.focus();
        });
        await expect
          .poll(() =>
            app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()),
          )
          .toBe(true);
      }
      await restarted.locator(`[data-task-id="${taskId}"] button.sb-item`).click();
      await expect(restarted.getByTestId('composer-textarea')).toHaveValue(savedDraft);
      await restarted.getByTestId('graph-toggle').click();
      const restoredFrame = restarted.frameLocator('[data-testid="graph-frame"]');
      await expect(restoredFrame.locator('svg[role="img"]')).toBeVisible();
      await expect(restarted.getByTestId('graph-generation')).toHaveAttribute(
        'data-state',
        'failed',
      );
      await expect(restarted.getByTestId('graph-generation')).toContainText('Rejected proposal');
      await expect(restoredFrame.locator('html')).toHaveAttribute('data-graph-id', view.id);
      await expect(restoredFrame.locator('html')).toHaveAttribute(
        'data-graph-revision',
        String(redrawn.revision),
      );
      expect(await restarted.getByTestId('graph-frame').getAttribute('src')).not.toBe(displayedUrl);
      expect(
        await app.evaluate(async ({ net }, url) => (await net.fetch(url!)).status, displayedUrl),
      ).toBe(404);
      await restarted.screenshot({ path: testInfo.outputPath(`restored-${kind}.png`) });
      await restarted
        .getByTestId('graph-panel')
        .getByRole('button', { name: '閉じる', exact: true })
        .click();
    } finally {
      const graphFrame = app
        .windows()
        .flatMap((page) => page.frames())
        .find((frame) => frame.url().startsWith('app://graph/'));
      if (graphFrame) {
        const diagnostics = await graphFrame
          .evaluate(() => ({
            readyState: document.readyState,
            theme: document.documentElement.getAttribute('data-theme'),
            observations: Reflect.get(window, '__graphDiagnostics'),
          }))
          .catch(() => ({ unavailable: true }));
        const diagnosticsPath = testInfo.outputPath('viewer-diagnostics.json');
        await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2));
        await testInfo.attach('graph-viewer-diagnostics', {
          path: diagnosticsPath,
          contentType: 'application/json',
        });
        // Test status is finalized after this finally block, so capture any still-open
        // graph here (successful tests already closed it). This also flushes an image
        // of the actual failing window into the CI artifact, not just its DOM snapshot.
        await graphFrame.page().screenshot({ path: testInfo.outputPath('viewer-at-cleanup.png') });
      }
      await closeApp(app);
      removeUserDataDir(profile);
    }
  });
}
