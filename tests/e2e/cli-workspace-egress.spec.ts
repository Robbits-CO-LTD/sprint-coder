import { expect, test } from '@playwright/test';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  assignCurrentTaskToProjectFolder,
  closeApp,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
} from './helpers';

test('real Codex dispatch succeeds with a composite Workspace root', async () => {
  test.skip(process.env['SPRINT_CODER_REAL_CLI_EGRESS'] !== '1', 'opt-in real Codex CLI request');
  test.setTimeout(120_000);
  const profile = createUserDataDir('cli-egress');
  const candidateRoot =
    process.env['SPRINT_CODER_REAL_CLI_EGRESS_WORKSPACE'] ??
    join(profile, 'sprint-coder-patrol-20260905', 'workspace');
  mkdirSync(candidateRoot, { recursive: true });
  const root = realpathSync(candidateRoot);
  const app = await launchApp(profile, undefined, {
    SPRINT_CODER_E2E_HIDDEN: '1',
    SPRINT_CODER_E2E_CLI_FIXTURES: '0',
  });
  try {
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await assignCurrentTaskToProjectFolder(page, 'Egress fixture', root);
    await page.getByTestId('model-picker-v2-trigger').click();
    await page.getByTestId('model-picker-v2-search').fill('gpt-5.5');
    await page.getByTestId('model-picker-v2-option-gpt-5.5').click();
    await page
      .getByTestId('composer-textarea')
      .fill('Reply exactly SC_EGRESS_OK. Do not use tools.');
    await page.getByTestId('composer-send-button').click();
    const card = page.getByTestId('run-card');
    await expect(card).toHaveAttribute('data-run-status', /completed|failed/, { timeout: 90_000 });
    await expect(card).toHaveAttribute('data-run-status', 'completed');
    await expect(page.getByTestId('assistant-message').locator('.bubble')).toHaveText(
      'SC_EGRESS_OK',
    );
    await page.screenshot({ path: test.info().outputPath('completed.png') });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.isVisible() || w.isFocused()),
      ),
    ).toBe(false);
  } finally {
    await closeApp(app);
    removeUserDataDir(profile);
  }
});
