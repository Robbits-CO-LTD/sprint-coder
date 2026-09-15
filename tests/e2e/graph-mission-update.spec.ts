import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  closeApp,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
  assignCurrentTaskToProjectFolder,
  REPO_ROOT,
} from './helpers';

async function openPlan(page: Page) {
  const plan = page.getByTestId('graph-mission-plan');
  if ((await plan.getAttribute('open')) === null) await plan.locator('summary').click();
  return plan;
}

async function startFixtureMission(page: Page, workspace: string, projectId?: string) {
  await page.getByTestId('sidebar-new-task-button').click();
  if (projectId) {
    await page.evaluate(async (id) => {
      const task = (await window.sprintCoder!.tasks.list())[0]!;
      await window.sprintCoder!.projects.assignTask({
        projectId: id,
        taskId: task.id,
        expectedProjectId: task.projectId,
      });
    }, projectId);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  } else await assignCurrentTaskToProjectFolder(page, 'Constraint update', workspace);
  const task = await page.evaluate(async () => (await window.sprintCoder!.tasks.list())[0]!);
  await page.evaluate(async (id) => {
    for (const role of ['client', 'api', 'store'])
      await window.sprintCoder!.teams.hireWorker({
        taskId: id,
        role,
        objective: 'Review fixture worker',
        contextInheritancePolicy: 'summary',
        writeCapable: true,
      });
  }, task.id);
  await page.getByTestId('composer-textarea').fill('[fixture:graph-bound-mission-proposal]');
  await page.getByTestId('composer-send-button').click();
  await page.getByRole('button', { name: '今回のみ許可', exact: true }).click();
  await expect(page.getByTestId('assistant-message').last()).toContainText('GRAPH_TOOL_FLOW_OK', {
    timeout: 30000,
  });
  await page.getByTestId('team-back').click();
  await page.getByTestId('graph-toggle').click();
  await openPlan(page);
  await expect(page.getByTestId('graph-mission-review')).toContainText('参照先を確認しました');
  await page.getByRole('button', { name: 'この計画で開始', exact: true }).click();
  return task;
}

// Acceptance uses the explicitly opted-in deterministic model/runtime, with real Main, SQLite,
// NativeSafeFs, Git worktrees, Archify and trusted Electron controls. It is not real-provider proof.
// eslint-disable-next-line no-empty-pattern
test('discusses a selected graph node, stops affected write work, re-agrees and restores the completed Mission', async ({}, testInfo) => {
  test.setTimeout(180000);
  const profile = createUserDataDir('graph-constraint-update');
  const workspace = await mkdtemp(
    join(process.platform === 'win32' ? REPO_ROOT : tmpdir(), '.sc-graph-update-'),
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
  let app = await launchApp(profile, undefined, {
    SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
    SPRINT_CODER_REAL_WORKERS: '0',
    SPRINT_CODER_E2E_HOLD_TEAM_WORKER_AFTER_FIRST_EVENT: 'store',
  });
  let evidencePage: Page | undefined;
  try {
    const page = await firstWindow(app);
    evidencePage = page;
    // A real background Mission holds the same declared machine resource. Its identity does not
    // grant this Task ownership; the tested Mission must visibly wait before its join step.
    const holder = await startFixtureMission(page, workspace);
    await expect
      .poll(
        () =>
          page.evaluate(
            async (id) =>
              (await window.sprintCoder!.teams.get(id))?.missions[0]?.steps.map(
                (step) => step.state,
              ),
            holder.id,
          ),
        { timeout: 30000 },
      )
      .toEqual(['completed', 'completed', 'running']);
    await page
      .getByTestId('graph-panel')
      .getByRole('button', { name: '閉じる', exact: true })
      .click();
    await app.evaluate((_electron, flag) => {
      process.env[flag] = '1';
    }, 'SPRINT_CODER_E2E_HOLD_TEAM_WORKER_AFTER_FIRST_EVENT');
    const taskId = (await startFixtureMission(page, workspace, holder.projectId!)).id;
    const mission = (target: Page) =>
      target.evaluate(
        async (id) => (await window.sprintCoder!.teams.get(id))!.missions[0]!,
        taskId,
      );
    await expect
      .poll(async () => (await mission(page))?.steps.map((step) => step.state), { timeout: 30000 })
      .toEqual(['running', 'running', 'queued']);
    const initial = await mission(page);
    const plan = page.getByTestId('graph-mission-plan');
    await expect(plan).toHaveAttribute('open', '');
    await plan.locator('summary').click();
    const frame = page.frameLocator('[data-testid="graph-frame"]');
    await expect(page.getByTestId('graph-frame')).toHaveAttribute('data-graph-ready', '1');
    await frame.locator('[data-node-id="client"]').first().click();
    await expect(page.getByTestId('graph-selection')).toContainText('client');
    await expect(page.getByRole('textbox', { name: 'この箇所への指示' })).toBeVisible();
    await page
      .getByRole('textbox', { name: 'この箇所への指示' })
      .fill('[fixture:graph-update-mission]');
    await page.getByRole('button', { name: 'チャット入力へ追加', exact: true }).click();
    await expect(page.getByTestId('composer-textarea')).toHaveValue(
      /graph-update-mission[\s\S]*"id":"client"/u,
    );
    await page.getByTestId('composer-send-button').click();
    await page.getByRole('button', { name: '今回のみ許可', exact: true }).click();
    await expect(page.getByTestId('assistant-message').last()).toContainText('GRAPH_TOOL_FLOW_OK', {
      timeout: 30000,
    });
    await expect(page.getByTestId('graph-mission-plan').locator('summary')).toContainText(
      '実行計画の変更案',
    );
    await openPlan(page);
    const update = page.getByTestId('graph-mission-update');
    await expect(update).toContainText('未合意');
    expect((await mission(page)).steps[0]!.state).toBe('running');
    const requestInput = await update
      .locator('[data-computer-use-activation]')
      .first()
      .evaluate((button) => {
        const value = JSON.parse((button as HTMLElement).dataset['computerUseIntent']!);
        delete value.operation;
        return value;
      });
    expect(
      await page.evaluate(
        async (input) =>
          window.sprintCoder!.graphs.requestUpdate(input).then(
            () => false,
            () => true,
          ),
        requestInput,
      ),
    ).toBe(true);
    await update
      .getByRole('button', { name: '影響する工程を停止して変更を確認', exact: true })
      .click();
    // This fixture holds normal completion; an abort can acknowledge stopping immediately.
    // Delayed stop acknowledgement is covered separately by the Coordinator delayed-stop test.
    await expect
      .poll(async () => (await mission(page)).steps.map((step) => step.state))
      .toEqual(['waiting_resume', 'running', 'waiting_resume']);
    expect((await mission(page)).graph!.semanticRevision).toBe(initial.graph!.semanticRevision);
    await app.evaluate((_electron, flag) => {
      process.env[flag] = 'store';
    }, 'SPRINT_CODER_E2E_HOLD_TEAM_WORKER_AFTER_FIRST_EVENT');
    await expect(update.getByTestId('graph-diff')).toContainText('前提工程', { timeout: 30000 });
    await expect(update).toContainText('client・store');
    expect((await mission(page)).graph!.semanticRevision).toBe(initial.graph!.semanticRevision);
    await expect
      .poll(async () => (await mission(page)).steps.map((step) => step.state))
      .toEqual(['waiting_resume', 'completed', 'waiting_resume']);
    const agreementInput = await update
      .getByRole('button', { name: 'この変更に再合意して再開' })
      .evaluate((button) => {
        const value = JSON.parse((button as HTMLElement).dataset['computerUseIntent']!);
        delete value.operation;
        return value;
      });
    expect(
      await page.evaluate(
        async (input) =>
          window.sprintCoder!.graphs.agreeUpdate(input).then(
            () => false,
            () => true,
          ),
        agreementInput,
      ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('graph-update-awaiting-agreement.png') });
    await update.getByRole('button', { name: 'この変更に再合意して再開', exact: true }).click();
    await expect
      .poll(async () => (await mission(page)).steps[2]?.graph?.waitReason, { timeout: 60000 })
      .toBe('resources');
    const resourceWait = page.getByTestId('graph-step-state').nth(2);
    await expect(resourceWait).toContainText('共有資源待ち');
    expect((await mission(page)).steps.map((step) => step.state)).toEqual([
      'completed',
      'completed',
      'waiting_resume',
    ]);
    expect((await mission(page)).steps[2]!.graph).toMatchObject({
      stepResumePending: true,
      stepResumeAvailable: false,
      integrationResumeAvailable: false,
      waitReason: 'resources',
    });
    await expect(plan.getByRole('button', { name: 'この工程を再開', exact: true })).toHaveCount(0);
    await expect(
      plan.getByRole('button', { name: '変更を保持して工程を再開', exact: true }),
    ).toHaveCount(0);
    await resourceWait.scrollIntoViewIfNeeded();
    await expect(resourceWait).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('graph-update-resource-wait.png') });
    await app.evaluate((_electron, flag) => {
      delete process.env[flag];
    }, 'SPRINT_CODER_E2E_HOLD_TEAM_WORKER_AFTER_FIRST_EVENT');
    await expect
      .poll(async () => (await mission(page)).state, { timeout: 60000 })
      .toBe('completed');
    const completed = await mission(page);
    expect(completed.steps.map((step) => step.graph!.generation)).toEqual([2, 1, 2]);
    await expect(frame.locator('[data-node-id="client"]').first()).toHaveAttribute(
      'data-execution-state',
      'completed',
    );
    await page.getByTestId('graph-mission-state').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('graph-mission-state')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('graph-update-completed.png') });
    await closeApp(app);
    app = await launchApp(profile, undefined, { SPRINT_CODER_REAL_WORKERS: '0' });
    const reopened = await firstWindow(app);
    evidencePage = reopened;
    await reopened.locator(`[data-task-id="${taskId}"] button.sb-item`).click();
    await reopened.getByTestId('graph-toggle').click();
    await expect.poll(async () => (await mission(reopened)).state).toBe('completed');
    expect(
      (await mission(reopened)).steps.map((step) => [
        step.executionId,
        step.state,
        step.graph!.generation,
      ]),
    ).toEqual(
      completed.steps.map((step) => [step.executionId, 'completed', step.graph!.generation]),
    );
    await expect(reopened.getByTestId('graph-mission-plan')).toHaveAttribute('open', '');
    await expect(reopened.getByTestId('graph-mission-state')).toContainText('すべての工程が完了');
    await reopened.getByTestId('graph-mission-state').scrollIntoViewIfNeeded();
    await expect(reopened.getByTestId('graph-mission-state')).toBeInViewport();
    await reopened.screenshot({ path: testInfo.outputPath('graph-update-restored.png') });
  } catch (error) {
    if (evidencePage && !evidencePage.isClosed()) {
      const metadata = await evidencePage
        .evaluate(() => {
          const panel = document.querySelector('[data-testid="graph-panel"]');
          const input = panel?.querySelector<HTMLTextAreaElement>('textarea[id^="graph-comment-"]');
          const comment = panel?.querySelector('.graph-comment');
          const label = input
            ? document.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)
            : null;
          const box = input?.getBoundingClientRect();
          const style = input ? getComputedStyle(input) : null;
          const over =
            box && box.width && box.height
              ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              : null;
          return {
            graphPanel: Boolean(panel),
            commentDisplay: comment ? getComputedStyle(comment).display : null,
            inputPresent: Boolean(input),
            labelPresent: Boolean(label),
            labelForMatches: Boolean(input && label?.htmlFor === input.id),
            disabled: input?.disabled ?? null,
            ariaHidden: input?.getAttribute('aria-hidden'),
            display: style?.display,
            visibility: style?.visibility,
            box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
            coveringTag: over?.tagName,
            coveringTestId: over?.getAttribute('data-testid'),
            coveringInput: over === input,
            details: Array.from(panel?.querySelectorAll('details') ?? [])
              .slice(0, 8)
              .map((detail) => ({
                testId: detail.getAttribute('data-testid'),
                open: detail.open,
              })),
          };
        })
        .catch(() => ({ diagnosticUnavailable: true }));
      const metadataPath = testInfo.outputPath('graph-update-pre-cleanup-dom.json');
      await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
      await testInfo.attach('graph-update-pre-cleanup-dom', {
        path: metadataPath,
        contentType: 'application/json',
      });
      const screenshot = testInfo.outputPath('graph-update-before-cleanup.png');
      await evidencePage
        .screenshot({ path: screenshot })
        .then(() =>
          testInfo.attach('graph-update-before-cleanup', {
            path: screenshot,
            contentType: 'image/png',
          }),
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await closeApp(app);
    removeUserDataDir(profile);
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
});
