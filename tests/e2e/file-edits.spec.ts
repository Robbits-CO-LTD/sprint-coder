import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #37. Under SPRINT_CODER_E2E_MODE=dev the mock is the only runtime, and it now reports file
// changes through exactly the two gates a real Runtime is held to (a Workspace exists, and the
// Access preset is not `ask`) — so what these specs exercise is the real path, not a shortcut.

async function selectWorkspace(app: ElectronApplication, page: Page, path: string): Promise<void> {
  await app.evaluate(({ dialog }, workspacePath) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [workspacePath] }),
    });
  }, path);
  await page.getByRole('button', { name: 'Workspace未選択' }).first().click();
}

async function grantAuto(page: Page): Promise<void> {
  await page.getByTestId('access-selector').click();
  await page.getByTestId('access-option-auto').click();
}

test.describe('file edits', () => {
  let app: ElectronApplication | null = null;
  let userDataDir = '';
  let workspaceDir = '';

  test.beforeEach(() => {
    userDataDir = createUserDataDir('file-edits');
    workspaceDir = mkdtempSync(join(tmpdir(), 'sprint-coder-e2e-ws-'));
  });

  test.afterEach(async () => {
    await closeApp(app);
    app = null;
    removeUserDataDir(userDataDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test('writes nothing at the ask preset, and says which condition is missing', async () => {
    app = await launchApp(userDataDir);
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();

    // No Workspace yet: the Inspector must blame the folder, not the preset — they need different
    // actions from the user, so one generic "not connected" would leave them guessing.
    await page.getByTestId('inspector-toggle').click();
    await expect(page.getByTestId('inspector-stream-disconnected')).toContainText('Workspace');

    await selectWorkspace(app, page, workspaceDir);
    // Workspace present, preset still `ask` (the default): now the preset is the reason.
    await expect(page.getByTestId('inspector-stream-disconnected')).toContainText('確認する');
    await expect(page.getByTestId('access-chip')).toHaveAttribute('data-access-preset', 'ask');
    await expect(page.getByTestId('access-unmanaged')).toHaveCount(0);

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('readme を整えてください');
    await textarea.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 30_000,
    });
    // The Turn ran and produced an answer, and still nothing claims a file changed.
    await expect(page.getByTestId('file-change-card')).toHaveCount(0);
  });

  test('records the edits at the auto preset, in the Turn that made them, and replays after restart', async () => {
    app = await launchApp(userDataDir);
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await selectWorkspace(app, page, workspaceDir);
    await grantAuto(page);

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('parser を修正してください');
    await textarea.press('Enter');

    const card = page.getByTestId('file-change-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('src/parser.ts');
    await expect(card).toContainText('新規');
    await expect(card).toContainText('変更');
    // Every path is workspace-relative. An absolute path here would mean Main's root check let
    // something through that it should have dropped.
    for (const path of await card.locator('.filechange-path').allInnerTexts())
      expect(path.startsWith('/'), `absolute path leaked into the timeline: ${path}`).toBe(false);

    await page.getByTestId('inspector-toggle').click();
    // While a Turn is live the panel shows one row per file with its own state; the historical list
    // is suppressed so the same paths are not printed twice (issue #45).
    await expect(
      page.getByTestId('live-edit-file-row').filter({ hasText: 'parser.ts' }),
    ).toHaveCount(1);
    await expect(page.getByTestId('inspector-stream-disconnected')).toHaveCount(0);

    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 30_000,
    });

    // Persisted, not just streamed: "this Turn edited these files" is part of the conversation's
    // history and has to survive reopening the Task.
    await closeApp(app);
    app = await launchApp(userDataDir);
    const restored = await firstWindow(app);
    await expect(restored.getByTestId('file-change-card')).toContainText('src/parser.ts');
    // And it is not duplicated by the replay — the store de-duplicates on the event's seq.
    await expect(restored.getByTestId('file-change-card')).toHaveCount(1);
  });
});
