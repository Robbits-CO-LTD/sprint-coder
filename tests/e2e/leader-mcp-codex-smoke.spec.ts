import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

const DETERMINISTIC_ROLES = JSON.stringify(['調査', '実装', 'レビュー']);
const DETERMINISTIC_TEMPLATE = /が依頼「.*」を完了しました。/;

async function selectCodexRuntime(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByTestId('runtime-selector').click();
    await expect(page.getByRole('menuitemradio', { name: /^Codex/ })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });
  await page.getByRole('menuitemradio', { name: /^Codex/ }).click();
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

  test('Codex drives two real Worker reports over MCP in the packaged app', async () => {
    app = await launchApp(dir);
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await selectCodexRuntime(page);
    await expect(page.getByTestId('team-list')).toHaveCount(0);

    await page
      .getByTestId('composer-textarea')
      .fill('「1+1の答え」を、数学の観点と実装の観点の2人体制で並行に検討して結論をまとめてください');
    await page.getByTestId('composer-send-button').click();

    await expect(page.getByTestId('team-list')).toBeVisible({ timeout: 300_000 });
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
  });
});
