import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

const DETERMINISTIC_ROLES = JSON.stringify(['調査', '実装', 'レビュー']);
const DETERMINISTIC_TEMPLATE = /が依頼「.*」を完了しました。/;

async function selectCodexRuntime(page: Page): Promise<void> {
  const unifiedPicker = page.getByTestId('model-picker-v2-trigger');
  await expect(unifiedPicker).toBeVisible({ timeout: 60_000 });
  await unifiedPicker.click();
  const search = page.getByTestId('model-picker-v2-search');
  await expect(search).toBeVisible();
  await search.fill('gpt-5.6-terra');
  const codexModel = page.getByTestId('model-picker-v2-option-gpt-5.6-terra');
  await expect(codexModel).toBeVisible({ timeout: 60_000 });
  await codexModel.click();
  await expect(unifiedPicker).toContainText(/GPT-5\.6-Terra/i);
}

test.describe('leader MCP smoke (real Codex CLI)', () => {
  test.skip(
    process.env['SPRINT_CODER_LEADER_MCP'] !== '1',
    'opt-in: SPRINT_CODER_LEADER_MCP=1 and SPRINT_CODER_REAL_WORKERS=1',
  );
  test.setTimeout(600_000);

  let app: ElectronApplication | null = null;
  let dir: string;

  test.beforeAll(() => {
    dir = createUserDataDir('leader-mcp-codex-smoke');
  });

  test.afterAll(async () => {
    await Promise.race([closeApp(app), new Promise((resolve) => setTimeout(resolve, 20_000))]);
    try {
      app?.process().kill('SIGKILL');
    } catch {
      /* already exited */
    }
    removeUserDataDir(dir);
  });

  // Playwright requires object destructuring when the second `testInfo` argument is used.
  // eslint-disable-next-line no-empty-pattern
  test('Codex drives two real Worker reports over MCP in the packaged app', async ({}, testInfo) => {
    const realRuntimeEnvironment = {
      SPRINT_CODER_TEAM_MCP_TRACE: '1',
      SPRINT_CODER_RUNTIME_ADOPT: '1',
      SPRINT_CODER_ALLOW_SIMULATED_TEAM_WORKERS: '0',
    };
    app = await launchApp(dir, undefined, realRuntimeEnvironment);
    const runtimeDiagnostics: string[] = [];
    app.process().stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('Team MCP tool received')) runtimeDiagnostics.push(text);
    });
    app.process().stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('Runtime event handling failed')) runtimeDiagnostics.push(text);
    });
    const page = await firstWindow(app);
    const rendererErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    await page.getByTestId('sidebar-new-task-button').click();
    await selectCodexRuntime(page);
    await expect(page.getByTestId('team-list')).toHaveCount(0);

    await page
      .getByTestId('composer-textarea')
      .fill(
        '「1+1の答え」を、数学の観点と実装の観点の2人体制で並行に検討して結論をまとめてください',
      );
    await page.getByTestId('composer-send-button').click();

    const teamOutcome = await Promise.race([
      page
        .getByTestId('team-list')
        .waitFor({ state: 'visible', timeout: 120_000 })
        .then(() => 'team' as const),
      page
        .locator('[data-testid="surface-footer-connection"][data-tone="failed"]')
        .waitFor({ state: 'visible', timeout: 120_000 })
        .then(() => 'runtime_error' as const),
    ]);
    expect(
      teamOutcome,
      runtimeDiagnostics.join('\n') || 'Codex Runtime failed before Team Canvas appeared',
    ).toBe('team');
    await expect(page.getByTestId('team-worker').first()).toBeVisible({ timeout: 300_000 });

    const reports = page.locator('.w-line:has(.tag.out)');
    await expect.poll(() => reports.count(), { timeout: 300_000 }).toBeGreaterThanOrEqual(2);
    const roles = await page.locator('.w-head .role-name').allTextContents();
    const reportTexts = await reports.allTextContents();
    console.info('[leader-mcp-codex] roles:', JSON.stringify(roles));
    console.info('[leader-mcp-codex] reports:', JSON.stringify(reportTexts));
    expect(JSON.stringify(roles)).not.toBe(DETERMINISTIC_ROLES);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    for (const text of reportTexts) expect(text).not.toMatch(DETERMINISTIC_TEMPLATE);

    await expect(page.locator('.msg-assistant .bubble').last()).toContainText(/2|１＋１|1\+1/, {
      timeout: 300_000,
    });
    const assistantMessage = page.getByTestId('assistant-message').last();
    const paragraphs = assistantMessage.locator('.md-body > p');
    await expect.poll(() => paragraphs.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    const paragraphTexts = (await paragraphs.allTextContents())
      .map((text) => text.trim())
      .filter((text) => text.length > 0);
    expect(paragraphTexts.length).toBeGreaterThanOrEqual(2);
    console.info('[leader-mcp-codex] assistant paragraphs:', JSON.stringify(paragraphTexts));
    await testInfo.attach('assistant-paragraphs', {
      body: Buffer.from(JSON.stringify(paragraphTexts, null, 2)),
      contentType: 'application/json',
    });

    // Real Team trace UX: settled tool work is one compact row before the final answer, can be
    // reopened, and returns collapsed after a production-app restart against the same SQLite DB.
    const summary = page.getByTestId('team-activity-summary');
    const group = page.getByTestId('team-activity-group');
    await expect(summary).toContainText(/作業しました/, { timeout: 30_000 });
    await expect(group).not.toHaveAttribute('open', '');
    expect(
      await summary.evaluate((node) => {
        const answers = document.querySelectorAll('.msg-assistant');
        const answer = answers.item(answers.length - 1);
        return (
          answer !== null &&
          (node.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        );
      }),
    ).toBe(true);
    await summary.click();
    await expect(group).toHaveAttribute('open', '');
    await expect(page.getByTestId('team-activity-card').first()).toBeVisible();
    await testInfo.attach('assistant-paragraphs-visible', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    await closeApp(app);
    app = await launchApp(dir, undefined, realRuntimeEnvironment);
    const restoredPage = await firstWindow(app);
    const restoredErrors: string[] = [];
    restoredPage.on('console', (message) => {
      if (message.type() === 'error') restoredErrors.push(message.text());
    });
    restoredPage.on('pageerror', (error) => restoredErrors.push(error.message));
    await expect(restoredPage.getByTestId('team-activity-summary')).toContainText(/作業しました/, {
      timeout: 30_000,
    });
    await expect(restoredPage.getByTestId('team-activity-group')).not.toHaveAttribute('open', '');
    const restoredParagraphs = restoredPage
      .getByTestId('assistant-message')
      .last()
      .locator('.md-body > p');
    await expect(restoredParagraphs).toHaveCount(paragraphTexts.length);
    expect((await restoredParagraphs.allTextContents()).map((text) => text.trim())).toEqual(
      paragraphTexts,
    );
    await testInfo.attach('assistant-paragraphs-restored', {
      body: await restoredPage.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    expect(rendererErrors).toEqual([]);
    expect(restoredErrors).toEqual([]);
  });
});
