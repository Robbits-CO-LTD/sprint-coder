import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  test('writes nothing at the ask preset', async () => {
    app = await launchApp(userDataDir);
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await expect(page.getByRole('button', { name: 'Inspector' })).toHaveCount(0);
    await expect(page.locator('[data-testid="inspector-panel"]')).toHaveCount(0);

    await selectWorkspace(app, page, workspaceDir);
    // The Access control lives in the ContextBar; the header's read-only copy was removed as a
    // duplicate (issue #47), and the sandbox disclosure moved with the control rather than being
    // dropped.
    await expect(page.getByTestId('access-selector')).toHaveAttribute('data-access-preset', 'ask');
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

  test('keeps the manual file editor above the composer', async () => {
    const filePath = join(workspaceDir, '日本語 file #1.txt');
    writeFileSync(filePath, '初期内容です。\r\n二行目です。\r\n', 'utf8');

    app = await launchApp(userDataDir);
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await selectWorkspace(app, page, workspaceDir);
    await app.evaluate(({ dialog }, selectedFile) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [selectedFile] }),
      });
    }, filePath);

    await page.getByTestId('open-file-button').click();
    const editor = page.getByRole('dialog', { name: 'ファイルを編集' });
    await expect(editor).toBeVisible();
    await expect(editor.locator('.file-editor-footer')).toBeVisible();

    expect(
      await editor.evaluate((element) => element.parentElement === document.body),
      'a fixed dialog inside the ContextBar stacking context can be covered by the composer',
    ).toBe(true);

    const save = editor.getByRole('button', { name: '保存' });
    const textbox = editor.getByRole('textbox', { name: /の内容$/ });
    await textbox.fill('日本語の編集\n複数行');
    await expect(save).toBeEnabled();
    await editor.getByRole('button', { name: '再読み込み' }).click();
    const discard = editor.getByRole('alert');
    await expect(discard).toContainText('未保存の変更を破棄して再読み込みしますか？');
    await expect(textbox).toHaveValue('日本語の編集\n複数行');
    await discard.getByRole('button', { name: '編集に戻る' }).click();
    await expect(discard).toHaveCount(0);
    await save.click();
    await expect(editor.getByRole('status')).toHaveText('保存しました');
  });
});
