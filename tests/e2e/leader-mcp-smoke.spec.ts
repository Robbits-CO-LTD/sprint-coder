import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Permanent opt-in smoke (real Claude CLI + real cost — same convention as claude-smoke.test.ts):
//   SPRINT_CODER_LEADER_MCP=1 SPRINT_CODER_REAL_WORKERS=1 SPRINT_CODER_E2E_MODE=dev \
//     npx playwright test tests/e2e/leader-mcp-smoke.spec.ts
//
// Proves, mechanically, that the leader's team actions go through the MCP bridge and that the
// UI transitions on its own:
//  - The ONLY non-MCP team path is the deterministic mock scenario, which always hires exactly
//    調査/実装/レビュー (3, in that order) and reports with a fixed template. Observing a
//    self-chosen role set / count and non-template reports on the Claude runtime therefore
//    uniquely identifies the MCP path (bridge auth + JSON-RPC handshake are unit-tested).
//  - The canvas must appear WITHOUT any ⬡ Team click (auto-promotion → auto-open).
//  - A trivial question must NOT create a team (restraint guidance).
const DETERMINISTIC_ROLES = JSON.stringify(['調査', '実装', 'レビュー']);
const DETERMINISTIC_TEMPLATE = /が依頼「.*」を完了しました。/;

async function selectClaudeRuntime(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByTestId('runtime-selector').click();
    await expect(page.getByRole('menuitemradio', { name: /Claude Code/ })).toBeVisible({
      timeout: 2000,
    });
  }).toPass({ timeout: 60_000 });
  await page.getByRole('menuitemradio', { name: /Claude Code/ }).click();
}

test.describe('leader MCP smoke (real CLI)', () => {
  test.skip(
    process.env['SPRINT_CODER_LEADER_MCP'] !== '1',
    'opt-in: SPRINT_CODER_LEADER_MCP=1 (+ SPRINT_CODER_REAL_WORKERS=1 recommended)',
  );
  test.setTimeout(600_000);

  let app: ElectronApplication | null = null;
  let dir: string;
  test.beforeAll(() => {
    dir = createUserDataDir('leader-mcp-smoke');
  });
  test.afterAll(async () => {
    // App shutdown after a leader-MCP turn can exceed Playwright's default close patience
    // (recorded follow-up: quit path should not wait on runtime-host child reaping). Close is
    // best-effort here; the OS reaps the isolated userData dir's process tree regardless.
    await Promise.race([
      closeApp(app),
      new Promise((resolve) => setTimeout(resolve, 20_000)),
    ]);
    try {
      app?.process().kill('SIGKILL');
    } catch {
      /* already exited */
    }
    removeUserDataDir(dir);
  });

  test('team actions run over MCP and the canvas opens by itself', async () => {
    app = await launchApp(dir);
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await selectClaudeRuntime(page);

    // Screen-transition precondition: no canvas before the leader decides to hire.
    await expect(page.getByTestId('team-list')).toHaveCount(0);

    await page
      .getByTestId('composer-textarea')
      .fill('「1+1の答え」を、数学の観点と実装の観点の2人体制で並行に検討して結論をまとめてください');
    await page.getByTestId('composer-send-button').click();

    // 1) Screen transition happens with no ⬡ Team click.
    await expect(page.getByTestId('team-list')).toBeVisible({ timeout: 300_000 });
    await expect(page.getByTestId('team-worker').first()).toBeVisible({ timeout: 300_000 });

    // 2) MCP-path proof: the role set must NOT be the deterministic trio, and at least one
    //    report must exist that does not match the simulator template.
    const reports = page.locator('.w-line:has(.tag.out)');
    await expect(reports.first()).toBeVisible({ timeout: 300_000 });
    const roles = await page.locator('.w-head .role-name').allTextContents();
    const reportTexts = await reports.allTextContents();
    console.info('[leader-mcp] roles:', JSON.stringify(roles));
    console.info('[leader-mcp] reports:', JSON.stringify(reportTexts));
    expect(JSON.stringify(roles)).not.toBe(DETERMINISTIC_ROLES);
    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(roles.length).toBeLessThanOrEqual(3);
    for (const text of reportTexts) expect(text).not.toMatch(DETERMINISTIC_TEMPLATE);

    // 3) The leader synthesizes a final chat answer after the reports.
    await expect(page.locator('.msg-assistant .bubble').last()).toContainText(/2|１＋１|1\+1/, {
      timeout: 300_000,
    });
  });

  test('a trivial question does not create a team (restraint)', async () => {
    const trivialDir = createUserDataDir('leader-mcp-restraint');
    let trivialApp: ElectronApplication | null = null;
    try {
      trivialApp = await launchApp(trivialDir);
      const page = await firstWindow(trivialApp);
      await page.getByTestId('sidebar-new-task-button').click();
      await selectClaudeRuntime(page);
      await page.getByTestId('composer-textarea').fill('1+1は?数字のみで答えてください');
      await page.getByTestId('composer-send-button').click();
      await expect(page.locator('.msg-assistant .bubble').last()).toContainText(/2/, {
        timeout: 300_000,
      });
      // No canvas, no workers, no team persisted.
      await expect(page.getByTestId('team-list')).toHaveCount(0);
      const team = await page.evaluate(async () => {
        const tasks = await window.sprintCoder.tasks.list();
        return window.sprintCoder.teams.get(tasks[0]!.id);
      });
      expect(team).toBeNull();
    } finally {
      await Promise.race([
        closeApp(trivialApp),
        new Promise((resolve) => setTimeout(resolve, 20_000)),
      ]);
      try {
        trivialApp?.process().kill('SIGKILL');
      } catch {
        /* already exited */
      }
      removeUserDataDir(trivialDir);
    }
  });
});
