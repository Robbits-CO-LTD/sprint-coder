import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeApp,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
  assignCurrentTaskToProjectFolder,
  REPO_ROOT,
} from './helpers';

// eslint-disable-next-line no-empty-pattern
test('binds an authorized file read and detects changed source bytes after restart', async ({}, testInfo) => {
  const profile = createUserDataDir('graph-source-proposal');
  const workspace = await mkdtemp(
    join(process.platform === 'win32' ? REPO_ROOT : tmpdir(), '.sc-graph-source-'),
  );
  await writeFile(
    join(workspace, 'graph-source.ts'),
    'export function readConfig() {\n  return "config";\n}\n',
  );
  let app = await launchApp(profile, undefined, {
    SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
    PATH: '',
    Path: '',
  });
  try {
    const page = await firstWindow(app);
    await page.addInitScript(() => {
      const clicks = { api: 0, trustedApi: 0 };
      Object.defineProperty(window, '__graphSourceClicks', { value: clicks });
      document.addEventListener(
        'click',
        (event) => {
          const target =
            event.target instanceof Element ? event.target.closest('[data-node-id="api"]') : null;
          if (target) {
            clicks.api++;
            if (event.isTrusted) clicks.trustedApi++;
          }
        },
        true,
      );
    });
    await page.getByTestId('sidebar-new-task-button').click();
    await assignCurrentTaskToProjectFolder(page, 'Graph sources', workspace);
    const taskId = await page.evaluate(async () => (await window.sprintCoder!.tasks.list())[0]!.id);
    await page.getByTestId('composer-textarea').fill('[fixture:graph-source-proposal]');
    await page.getByTestId('composer-send-button').click();
    await page.getByRole('button', { name: '今回のみ許可', exact: true }).click();
    await expect(page.getByTestId('assistant-message')).toContainText('GRAPH_TOOL_FLOW_OK', {
      timeout: 30000,
    });
    if (process.env['GITHUB_ACTIONS'] === 'true') {
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        nativeApp.focus({ steal: true });
        BrowserWindow.getAllWindows()[0]!.focus();
      });
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()),
        )
        .toBe(true);
    }
    await page.getByTestId('graph-toggle').click();
    const frame = page.frameLocator('[data-testid="graph-frame"]');
    await frame.locator('[data-node-id="api"]').first().click();
    const sources = page.getByTestId('graph-sources');
    await expect(sources.getByTestId('graph-evidence-kind'))
      .toHaveText('コード参照あり')
      .catch(async (error: unknown) => {
        const diagnostics = {
          nativeFocused: await app.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused() ?? false,
          ),
          frame: await frame
            .locator('html')
            .evaluate(() => {
              const clicks = Reflect.get(window, '__graphSourceClicks');
              return {
                readyState: document.readyState,
                focused: document.hasFocus(),
                apiClicks: Number.isSafeInteger(clicks?.api) ? clicks.api : null,
                trustedApiClicks: Number.isSafeInteger(clicks?.trustedApi)
                  ? clicks.trustedApi
                  : null,
              };
            })
            .catch(() => null),
        };
        await testInfo.attach('graph-source-selection-diagnostics', {
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(diagnostics)),
        });
        throw error;
      });
    await sources.locator('summary').click();
    await expect(page.getByTestId('graph-source-freshness')).toContainText(
      '根拠ファイルの内容は一致',
    );
    await sources.getByRole('button', { name: '現在の内容を確認' }).click();
    await expect(sources.getByTestId('graph-source-status')).toContainText('現在のファイルと一致');
    await writeFile(
      join(workspace, 'graph-source.ts'),
      'export function readConfig() {\n  return "changed";\n}\n',
    );
    await expect(page.getByTestId('graph-source-freshness')).toContainText('古い根拠');
    await expect(sources.getByTestId('graph-source-status')).toContainText('ファイルが変更');
    await sources.getByRole('button', { name: '現在の内容を確認' }).click();
    await expect(sources).toContainText('return "config"');
    await expect(sources).toContainText('return "changed"');
    await page.screenshot({ path: test.info().outputPath('source-changed.png') });
    await rename(join(workspace, 'graph-source.ts'), join(workspace, 'graph-source.saved.ts'));
    await expect(sources.getByTestId('graph-source-status')).toContainText(
      'ファイルが見つかりません',
    );
    await rename(join(workspace, 'graph-source.saved.ts'), join(workspace, 'graph-source.ts'));
    await expect(sources.getByTestId('graph-source-status')).toContainText('ファイルが変更');
    await closeApp(app);
    app = await launchApp(profile, undefined, {
      SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
      PATH: '',
      Path: '',
    });
    const reopened = await firstWindow(app);
    if (process.env['GITHUB_ACTIONS'] === 'true') {
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        nativeApp.focus({ steal: true });
        BrowserWindow.getAllWindows()[0]!.focus();
      });
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()),
        )
        .toBe(true);
    }
    await reopened.locator(`[data-task-id="${taskId}"] button.sb-item`).click();
    await reopened.getByTestId('graph-toggle').click();
    await reopened
      .frameLocator('[data-testid="graph-frame"]')
      .locator('[data-node-id="api"]')
      .first()
      .click();
    const restored = reopened.getByTestId('graph-sources');
    await restored.locator('summary').click();
    await expect(restored).toContainText('return "config"');
    await restored.getByRole('button', { name: '現在の内容を確認' }).click();
    await expect(restored.getByTestId('graph-source-status')).toContainText('ファイルが変更');
    const original = await reopened.evaluate(
      async (id) =>
        (
          await window.sprintCoder!.graphs.sources({
            taskId: id,
            renderRevision: 1,
            elementKind: 'node',
            elementId: 'api',
          })
        )[0]!,
      taskId,
    );
    await reopened
      .getByTestId('graph-panel')
      .getByRole('button', { name: '閉じる', exact: true })
      .click();
    await reopened.getByTestId('composer-textarea').fill('[fixture:graph-source-proposal]');
    await reopened.getByTestId('composer-send-button').click();
    await reopened.getByRole('button', { name: '今回のみ許可', exact: true }).click();
    await expect(reopened.getByTestId('assistant-message')).toHaveCount(2);
    await expect(reopened.getByTestId('assistant-message').last()).toContainText(
      'GRAPH_TOOL_FLOW_OK',
    );
    const updated = await reopened.evaluate(
      async (id) =>
        (
          await window.sprintCoder!.graphs.sources({
            taskId: id,
            renderRevision: 2,
            elementKind: 'node',
            elementId: 'api',
          })
        )[0]!,
      taskId,
    );
    expect(updated.id).toBe(original.id);
    expect(updated.contentHash).not.toBe(original.contentHash);
    await reopened.getByTestId('graph-toggle').click();
    await reopened.getByTestId('graph-history').locator('summary').click();
    await expect(reopened.getByTestId('graph-diff')).toContainText('参照コード');
    await expect(reopened.getByTestId('graph-diff')).toContainText('return "config"');
    await expect(reopened.getByTestId('graph-diff')).toContainText('return "changed"');
  } finally {
    await closeApp(app);
    removeUserDataDir(profile);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('the model tool path proposes and reads back a draft through the real Main service', async () => {
  const profile = createUserDataDir('graph-tool-proposal');
  let app = await launchApp(profile, undefined, {
    SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
    PATH: '',
    Path: '',
  });
  try {
    const page = await firstWindow(app);
    if (process.env['GITHUB_ACTIONS'] === 'true') {
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        nativeApp.focus({ steal: true });
        BrowserWindow.getAllWindows()[0]!.focus();
      });
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()),
        )
        .toBe(true);
    }
    await page.getByTestId('sidebar-new-task-button').click();
    const taskId = await page.evaluate(async () => (await window.sprintCoder!.tasks.list())[0]!.id);
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
    await frame.locator('[data-node-id="api"]').first().click();
    await expect(page.getByTestId('graph-evidence-kind')).toHaveText('推定');
    await expect(page.getByTestId('graph-sources')).toContainText('APIの役割は推定です。');
    await frame.locator('#btn-focus-clear').click();
    await expect(frame.locator('#focus-chip')).toBeHidden();
    await frame.locator('[data-node-id="store"]').first().click();
    await expect(page.getByTestId('graph-evidence-kind')).toHaveText('追加案');
    await frame.locator('#btn-focus-clear').click();
    await expect(frame.locator('#focus-chip')).toBeHidden();
    await frame.locator('[data-node-id="client"]').first().click();
    await expect(page.getByTestId('graph-evidence-kind')).toHaveText('未確認');
    await frame.locator('#btn-focus-clear').click();
    await expect(frame.locator('#focus-chip')).toBeHidden();
    // Use the viewer's keyboard navigation for its horizontal SVG relationship targets.
    await frame.locator('.relationship-hit-target[data-relationship-id="request"]').press('End');
    await expect(
      frame.locator('.relationship-hit-target[data-relationship-id="persist"]'),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      frame.locator('.relationship-hit-target[data-relationship-id="persist"]'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('graph-selection')).toContainText('persist');
    await expect(page.getByTestId('graph-evidence-kind')).toHaveText('追加案');
    await expect(page.getByTestId('graph-sources')).toContainText('保存処理を追加する案です。');
    await page.getByRole('textbox', { name: 'この箇所への指示' }).fill('この接続は追加案です');
    await page.getByRole('button', { name: 'チャット入力へ追加' }).click();
    await expect(page.getByTestId('composer-textarea')).toHaveValue(
      /persist[\s\S]*この接続は追加案です|この接続は追加案です[\s\S]*persist/u,
    );
    await page.screenshot({ path: test.info().outputPath('model-graph-proposal.png') });
    await closeApp(app);
    app = await launchApp(profile, undefined, { PATH: '', Path: '' });
    const reopened = await firstWindow(app);
    if (process.env['GITHUB_ACTIONS'] === 'true')
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        nativeApp.focus({ steal: true });
        BrowserWindow.getAllWindows()[0]!.focus();
      });
    await reopened.locator(`[data-task-id="${taskId}"] button.sb-item`).click();
    await reopened.getByTestId('graph-toggle').click();
    await reopened
      .frameLocator('[data-testid="graph-frame"]')
      .locator('[data-node-id="api"]')
      .first()
      .click();
    await expect(reopened.getByTestId('graph-evidence-kind')).toHaveText('推定');
    await expect(reopened.getByTestId('graph-sources')).toContainText('APIの役割は推定です。');
  } finally {
    await closeApp(app);
    removeUserDataDir(profile);
  }
});

test('reviews and restores a proposed Mission without starting executions', async () => {
  const profile = createUserDataDir('graph-mission-plan');
  let app = await launchApp(profile, undefined, {
    SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
    PATH: '',
    Path: '',
  });
  try {
    const page = await firstWindow(app);
    if (process.env['GITHUB_ACTIONS'] === 'true')
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        nativeApp.focus({ steal: true });
        BrowserWindow.getAllWindows()[0]!.focus();
      });
    await page.getByTestId('sidebar-new-task-button').click();
    const taskId = await page.evaluate(async () => (await window.sprintCoder!.tasks.list())[0]!.id);
    await page.getByTestId('composer-textarea').fill('[fixture:graph-mission-proposal]');
    await page.getByTestId('composer-send-button').click();
    await expect(page.getByTestId('assistant-message')).toContainText('GRAPH_TOOL_FLOW_OK', {
      timeout: 30000,
    });
    await page.getByTestId('graph-toggle').click();
    await expect(
      page.frameLocator('[data-testid="graph-frame"]').locator('svg[role="img"]'),
    ).toBeVisible();
    const plan = page.getByTestId('graph-mission-plan');
    await plan.locator('summary').click();
    await expect(plan.getByTestId('graph-mission-review')).toContainText(
      '利用できるTeamを確認できません',
    );
    await expect(plan).toContainText('3工程');
    await expect(plan).toContainText('前提工程: client・api');
    await expect(plan).toContainText('src/api.ts');
    await expect(plan).toContainText('integration-db');
    await page
      .getByTestId('graph-panel')
      .getByRole('button', { name: '閉じる', exact: true })
      .click();
    await page.getByTestId('composer-textarea').fill('[fixture:graph-mission-proposal]');
    await page.getByTestId('composer-send-button').click();
    await expect(page.getByTestId('assistant-message')).toHaveCount(2);
    await expect(page.getByTestId('assistant-message').last()).toContainText('GRAPH_TOOL_FLOW_OK', {
      timeout: 30000,
    });
    await page.getByTestId('graph-toggle').click();
    await page.getByTestId('graph-history').locator('summary').click();
    await expect(page.getByTestId('graph-diff')).toContainText('完了条件');
    await expect(page.getByTestId('graph-diff')).toContainText('APIの互換性テストが成功');
    await expect(page.getByTestId('graph-diff')).toContainText('共有資源');
    await expect(page.getByTestId('graph-diff')).toContainText('integration-db-v2');
    expect(
      await page.evaluate(async (id) => {
        const team = await window.sprintCoder!.teams.get(id);
        return {
          missions: team?.missions.length ?? 0,
          executions: team?.executions.length ?? 0,
          workers: team?.workers.length ?? 0,
        };
      }, taskId),
    ).toEqual({ missions: 0, executions: 0, workers: 0 });
    await page.screenshot({ path: test.info().outputPath('mission-plan-diff.png') });
    await closeApp(app);
    app = await launchApp(profile, undefined, { PATH: '', Path: '' });
    const reopened = await firstWindow(app);
    if (process.env['GITHUB_ACTIONS'] === 'true')
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        nativeApp.focus({ steal: true });
        BrowserWindow.getAllWindows()[0]!.focus();
      });
    await reopened.locator(`[data-task-id="${taskId}"] button.sb-item`).click();
    await reopened.getByTestId('graph-toggle').click();
    await reopened.getByTestId('graph-mission-plan').locator('summary').click();
    await expect(reopened.getByTestId('graph-mission-plan')).toContainText(
      'APIの互換性テストが成功',
    );
    await expect(reopened.getByTestId('graph-mission-plan')).toContainText('integration-db-v2');
    await reopened.screenshot({ path: test.info().outputPath('mission-plan-restored.png') });
  } finally {
    await closeApp(app);
    removeUserDataDir(profile);
  }
});

for (const starts of [false, true])
  test(`checks real Task agreement and ${starts ? 'starts only from a trusted control' : 'invalidates changed evidence'}`, async () => {
    // Opt-in real Workers (SPRINT_CODER_REAL_WORKERS=1 reaches Main through launchApp's env):
    // three real CLI turns plus integration take minutes, not the seconds the mock path needs.
    const realWorkers = starts && process.env['SPRINT_CODER_REAL_WORKERS'] === '1';
    if (realWorkers) test.setTimeout(900_000);
    const profile = createUserDataDir('graph-mission-review');
    const workspace = await mkdtemp(
      join(process.platform === 'win32' ? REPO_ROOT : tmpdir(), '.sc-graph-review-'),
    );
    await writeFile(
      join(workspace, 'graph-source.ts'),
      'export const ready = true;\nexport const version = 1;\n',
    );
    if (starts) {
      const git = promisify(execFile);
      await git('git', ['init', workspace]);
      await git('git', ['-C', workspace, 'add', 'graph-source.ts']);
      await git('git', [
        '-C',
        workspace,
        '-c',
        'user.name=Graph test',
        '-c',
        'user.email=graph-test@example.invalid',
        'commit',
        '-m',
        'fixture',
      ]);
    }
    const app = await launchApp(profile, undefined, {
      SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
      ...(starts ? {} : { PATH: '', Path: '' }),
    });
    try {
      const page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await assignCurrentTaskToProjectFolder(page, 'Mission review', workspace);
      const taskId = await page.evaluate(
        async () => (await window.sprintCoder!.tasks.list())[0]!.id,
      );
      await page.evaluate(async (id) => {
        for (const role of ['client', 'api', 'store'])
          await window.sprintCoder!.teams.hireWorker({
            taskId: id,
            role,
            objective: 'Review fixture worker',
            contextInheritancePolicy: 'summary',
            writeCapable: true,
          });
      }, taskId);
      await page.getByTestId('composer-textarea').fill('[fixture:graph-bound-mission-proposal]');
      await page.getByTestId('composer-send-button').click();
      await page.getByRole('button', { name: '今回のみ許可', exact: true }).click();
      await expect(page.getByTestId('assistant-message')).toContainText('GRAPH_TOOL_FLOW_OK', {
        timeout: 30000,
      });
      if (process.env['GITHUB_ACTIONS'] === 'true')
        await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
          nativeApp.focus({ steal: true });
          BrowserWindow.getAllWindows()[0]!.focus();
        });
      await page.getByTestId('team-back').click();
      await expect(page.getByTestId('team-list')).toHaveCount(0);
      await page.getByTestId('graph-toggle').click();
      await page.getByTestId('graph-mission-plan').locator('summary').click();
      await expect(page.getByTestId('graph-mission-review')).toContainText('参照先を確認しました');
      expect(
        await page.evaluate(async (id) => {
          const team = await window.sprintCoder!.teams.get(id);
          return {
            workers: team?.workers.filter((worker) => worker.kind === 'worker').length,
            missions: team?.missions.length,
            executions: team?.executions.length,
          };
        }, taskId),
      ).toEqual({ workers: 3, missions: 0, executions: 0 });
      if (starts) {
        const rejected = await page.evaluate(async (id) => {
          const button = document.querySelector<HTMLElement>(
            '[data-computer-use-activation="graph-start"]',
          );
          const input = JSON.parse(button!.dataset['computerUseIntent']!);
          delete input.operation;
          if (input.taskId !== id) throw new Error('Task mismatch');
          return window.sprintCoder!.graphs.startMission(input).then(
            () => false,
            () => true,
          );
        }, taskId);
        expect(rejected).toBe(true);
        await page.getByRole('button', { name: 'この計画で開始', exact: true }).click();
        await expect
          .poll(
            async () => {
              const failure = await page
                .getByTestId('graph-mission-review')
                .locator('[role=alert]')
                .allTextContents();
              if (failure.length) throw new Error(failure.join(' '));
              return page.evaluate(
                async (id) => (await window.sprintCoder!.teams.get(id))?.missions.length,
                taskId,
              );
            },
            { timeout: 10000 },
          )
          .toBe(1);
        await expect
          .poll(
            async () =>
              page.evaluate(async (id) => {
                const team = await window.sprintCoder!.teams.get(id);
                return team?.missions[0]?.state;
              }, taskId),
            { timeout: realWorkers ? 600_000 : 60000 },
          )
          .toBe('completed');
        const result = await page.evaluate(async (id) => {
          const team = await window.sprintCoder!.teams.get(id);
          return {
            missions: team?.missions.length,
            states: team?.executions.map(({ state }) => state),
          };
        }, taskId);
        expect(result).toEqual({ missions: 1, states: ['completed', 'completed', 'completed'] });
        await expect(page.getByTestId('graph-mission-state')).toContainText('すべての工程が完了');
        await expect(
          page.frameLocator('[data-testid="graph-frame"]').locator('g[data-node-id="client"]'),
        ).toHaveAttribute('data-execution-state', 'completed');
        await page.screenshot({ path: test.info().outputPath('mission-start-completed.png') });
      } else {
        await writeFile(
          join(workspace, 'graph-source.ts'),
          'export const ready = false;\nexport const version = 2;\n',
        );
        await expect(page.getByTestId('graph-mission-review')).toContainText(
          '根拠ファイルが変わった',
        );
        await page.screenshot({ path: test.info().outputPath('mission-review-stale.png') });
      }
    } finally {
      await closeApp(app);
      removeUserDataDir(profile);
      await rm(workspace, { recursive: true, force: true });
    }
  });

// Electron owns the browser; Playwright still requires its fixture argument before testInfo.
// eslint-disable-next-line no-empty-pattern
test('resumes one interrupted graph step by hand after a relaunch', async ({}, testInfo) => {
  const profile = createUserDataDir('graph-mission-relaunch');
  const workspace = await mkdtemp(
    join(process.platform === 'win32' ? REPO_ROOT : tmpdir(), '.sc-graph-relaunch-'),
  );
  await writeFile(
    join(workspace, 'graph-source.ts'),
    'export const ready = true;\nexport const version = 1;\n',
  );
  const git = promisify(execFile);
  await git('git', ['init', workspace]);
  await git('git', ['-C', workspace, 'add', 'graph-source.ts']);
  await git('git', [
    '-C',
    workspace,
    '-c',
    'user.name=Graph test',
    '-c',
    'user.email=graph-test@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
  // Only the read-only integration step ("store") is held. The two independent steps write to the
  // Workspace, and an interrupted write step keeps its worktree/isolation on purpose: Main refuses
  // to re-run it ("Interrupted write work requires review of its preserved workspace") and the
  // panel therefore never offers 「この工程を再開」 for it. The step this control can finish after
  // a restart is the one that owns no preserved workspace, so that is the one interrupted here.
  let app = await launchApp(profile, undefined, {
    SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
    SPRINT_CODER_E2E_HOLD_TEAM_WORKER_AFTER_FIRST_EVENT: 'store',
  });
  try {
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await assignCurrentTaskToProjectFolder(page, 'Mission relaunch', workspace);
    const taskId = await page.evaluate(async () => (await window.sprintCoder!.tasks.list())[0]!.id);
    await page.evaluate(async (id) => {
      for (const role of ['client', 'api', 'store'])
        await window.sprintCoder!.teams.hireWorker({
          taskId: id,
          role,
          objective: 'Relaunch fixture worker',
          contextInheritancePolicy: 'summary',
          writeCapable: true,
        });
    }, taskId);
    const readMission = (
      target: typeof page,
    ): Promise<{
      mission: string | null;
      executions: number;
      workers: number;
      steps: [string, string][];
    }> =>
      target.evaluate(async (id) => {
        const team = await window.sprintCoder!.teams.get(id);
        return {
          mission: team?.missions[0]?.state ?? null,
          executions: team?.executions.length ?? 0,
          workers: team?.workers.filter((worker) => worker.kind === 'worker').length ?? 0,
          steps: (team?.missions[0]?.steps ?? []).map(
            (step) => [step.graph?.key ?? '?', step.state] as [string, string],
          ),
        };
      }, taskId);
    await page.getByTestId('composer-textarea').fill('[fixture:graph-bound-mission-proposal]');
    await page.getByTestId('composer-send-button').click();
    await page.getByRole('button', { name: '今回のみ許可', exact: true }).click();
    await expect(page.getByTestId('assistant-message')).toContainText('GRAPH_TOOL_FLOW_OK', {
      timeout: 30000,
    });
    if (process.env['GITHUB_ACTIONS'] === 'true')
      await app.evaluate(({ app: nativeApp, BrowserWindow }) => {
        nativeApp.focus({ steal: true });
        BrowserWindow.getAllWindows()[0]!.focus();
      });
    await page.getByTestId('team-back').click();
    await expect(page.getByTestId('team-list')).toHaveCount(0);
    await page.getByTestId('graph-toggle').click();
    await page.getByTestId('graph-mission-plan').locator('summary').click();
    await expect(page.getByTestId('graph-mission-review')).toContainText('参照先を確認しました');
    await page.getByRole('button', { name: 'この計画で開始', exact: true }).click();
    await expect
      .poll(async () => (await readMission(page)).steps, { timeout: 60000 })
      .toEqual([
        ['client', 'completed'],
        ['api', 'completed'],
        ['store', 'running'],
      ]);
    // The held Worker must not finish on its own while the app is still up: without this the
    // relaunch below would be observing an already-completed Mission.
    await page.waitForTimeout(2000);
    expect((await readMission(page)).steps).toEqual([
      ['client', 'completed'],
      ['api', 'completed'],
      ['store', 'running'],
    ]);
    // `closeApp` asks Electron to quit first and only escalates to SIGKILL when that stalls, so
    // both endings are exercised by whichever the shutdown takes. Either way Main records no
    // completion for the held step: the interruption path parks it on `waiting_resume`, and a
    // killed process leaves the running Attempt for restart recovery to park.
    await closeApp(app);
    // The resumed step still records a Workspace checkpoint, so git must stay reachable here; the
    // hold flag is deliberately absent so a step that did restart by itself would be visible.
    app = await launchApp(profile, undefined, {});
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
    await expect
      .poll(async () => (await readMission(restarted)).steps, { timeout: 30000 })
      .toEqual([
        ['client', 'completed'],
        ['api', 'completed'],
        ['store', 'waiting_resume'],
      ]);
    // Nothing may move on its own after the relaunch: no dispatch, no extra Worker, no Mission
    // completion.
    await restarted.waitForTimeout(3000);
    const parked = await readMission(restarted);
    expect(parked).toEqual({
      mission: parked.mission,
      executions: 3,
      workers: 3,
      steps: [
        ['client', 'completed'],
        ['api', 'completed'],
        ['store', 'waiting_resume'],
      ],
    });
    expect(parked.mission).not.toBe('completed');
    await restarted.getByTestId('graph-toggle').click();
    await restarted.getByTestId('graph-mission-plan').locator('summary').click();
    await expect(restarted.getByTestId('graph-step-state').nth(2)).toHaveText('再開待ち');
    const resumeStep = restarted.getByRole('button', { name: 'この工程を再開', exact: true });
    await expect(resumeStep).toHaveCount(1);
    // The already-rendered view owns the instance/render revision; re-reading the document through
    // `graphs.get` would invalidate the viewer that is on screen.
    const rejected = await restarted.evaluate(async (id) => {
      const button = document.querySelector<HTMLElement>(
        '[data-computer-use-activation="graph-resume-step"]',
      );
      const input = JSON.parse(button!.dataset['computerUseIntent']!);
      delete input.operation;
      if (input.taskId !== id) throw new Error('Task mismatch');
      return window.sprintCoder!.graphs.resumeStep(input).then(
        () => false,
        () => true,
      );
    }, taskId);
    expect(rejected).toBe(true);
    expect((await readMission(restarted)).steps[2]).toEqual(['store', 'waiting_resume']);
    await resumeStep.click();
    await expect
      .poll(async () => (await readMission(restarted)).mission, { timeout: 60000 })
      .toBe('completed');
    expect(await readMission(restarted)).toEqual({
      mission: 'completed',
      executions: 3,
      workers: 3,
      steps: [
        ['client', 'completed'],
        ['api', 'completed'],
        ['store', 'completed'],
      ],
    });
    await expect(restarted.getByTestId('graph-mission-state')).toContainText('すべての工程が完了');
    await restarted.screenshot({ path: testInfo.outputPath('mission-relaunch-resumed.png') });
  } finally {
    await closeApp(app);
    removeUserDataDir(profile);
    await rm(workspace, { recursive: true, force: true });
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
