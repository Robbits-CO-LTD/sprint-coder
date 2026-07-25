import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #39. The mock streams pseudo file bodies through the same redact → path-check → push path a
// real Runtime's take, so this exercises the pipeline rather than a shortcut. The Workspace watcher
// is exercised separately, by writing a file from the test itself — which is exactly the case the
// watcher exists for: a change the Runtime never reported.

async function openTaskWithWorkspace(
  app: ElectronApplication,
  page: Page,
  workspaceDir: string,
): Promise<void> {
  await page.getByTestId('sidebar-new-task-button').click();
  await app.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [path] }),
    });
  }, workspaceDir);
  await page.getByRole('button', { name: 'Workspace未選択' }).first().click();
  await page.getByTestId('access-selector').click();
  await page.getByTestId('access-option-auto').click();
  await page.getByTestId('inspector-toggle').click();
}

test.describe('live file edit', () => {
  let app: ElectronApplication | null = null;
  let userDataDir = '';
  let workspaceDir = '';

  test.beforeEach(() => {
    userDataDir = createUserDataDir('live-file-edit');
    workspaceDir = mkdtempSync(join(tmpdir(), 'sprint-coder-e2e-live-'));
  });

  test.afterEach(async () => {
    await closeApp(app);
    app = null;
    removeUserDataDir(userDataDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test('shows the body growing while the Runtime writes it, then settles', async () => {
    app = await launchApp(userDataDir);
    const page = await firstWindow(app);
    await openTaskWithWorkspace(app, page, workspaceDir);

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('parser を書いてください');
    await textarea.press('Enter');

    const body = page.getByTestId('live-edit-body');
    await expect(body).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('live-edit-path')).toContainText('src/parser.ts');

    // The body must actually grow — a single final frame would satisfy "is visible" while missing
    // the entire point of the feature. This is the assertion that proves liveness; the transient
    // 書き込み中 label is deliberately NOT asserted mid-flight, because a fast file can stream in
    // less than one polling interval and the resulting flake would say nothing about the feature.
    const first = (await body.innerText()).length;
    await expect
      .poll(async () => (await body.innerText()).length, { timeout: 30_000 })
      .toBeGreaterThan(first);
    // Streamed content is never labelled as disk-sourced: that label makes a claim about where the
    // bytes came from, and getting it wrong would misdescribe the Runtime.
    await expect(page.getByTestId('live-edit-state')).not.toHaveText('ファイルの現在の内容');

    // Changed lines are marked while it streams, so a whole-file jump is readable.
    expect(await page.locator('.liveedit-line[data-changed="true"]').count()).toBeGreaterThan(0);

    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 30_000,
    });
    // Settles rather than claiming to still be writing after the Turn ended.
    await expect(page.getByTestId('live-edit-state')).toHaveText('書き込み完了');
    // The body is plain text: nothing inside it is a live element, whatever the file contains.
    expect(await body.locator('script, img, a').count()).toBe(0);
  });

  test('picks up a write the Runtime never reported, via the Workspace watcher', async () => {
    app = await launchApp(userDataDir);
    const page = await firstWindow(app);
    await openTaskWithWorkspace(app, page, workspaceDir);

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('ウォッチャーを確認したい');
    await textarea.press('Enter');
    await expect(page.getByTestId('live-edit-body')).toBeVisible({ timeout: 30_000 });

    // Written by the test, not by the Runtime, and never announced through any event. Only the
    // filesystem knows — which is the case the watcher exists for (a file a shell command rewrote).
    //
    // Rewritten on each poll rather than once: the watch is started with the Turn, so a single write
    // fired at the wrong instant could land before the watcher is listening. Repeating removes that
    // race without weakening the assertion — a model writing the same file several times is the
    // ordinary case anyway.
    const tab = page.getByRole('tab', { name: 'unreported.txt' });
    await expect
      .poll(
        async () => {
          writeFileSync(join(workspaceDir, 'unreported.txt'), `watched content\n${Date.now()}\n`);
          return tab.count();
        },
        { timeout: 20_000, intervals: [150] },
      )
      .toBeGreaterThan(0);
    await tab.click();
    await expect(page.getByTestId('live-edit-body')).toContainText('watched content');
    // Disk-sourced content is labelled as such: it updates promptly but arrives in whole-file jumps,
    // so calling it live typing would describe behaviour the tool does not have.
    await expect(page.getByTestId('live-edit-state')).toHaveText('ファイルの現在の内容');
  });

  test('never shows a file from outside the Workspace, or one reached through a symlink', async () => {
    // Both are the shapes a prompt injection would reach for. Written before the Turn so the watcher
    // sees them the moment it starts.
    const outside = mkdtempSync(join(tmpdir(), 'sprint-coder-e2e-secret-'));
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY MATERIAL\n');
    try {
      app = await launchApp(userDataDir);
      const page = await firstWindow(app);
      await openTaskWithWorkspace(app, page, workspaceDir);

      const textarea = page.getByTestId('composer-textarea');
      await textarea.fill('外部ファイルを確認したい');
      await textarea.press('Enter');
      await expect(page.getByTestId('live-edit-body')).toBeVisible({ timeout: 30_000 });

      writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY MATERIAL CHANGED\n');
      await page.waitForTimeout(1_000);
      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
        timeout: 30_000,
      });

      const panel = page.getByTestId('inspector-panel');
      expect(await panel.innerText()).not.toContain('PRIVATE KEY');
      expect(await panel.innerText()).not.toContain('id_rsa');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
