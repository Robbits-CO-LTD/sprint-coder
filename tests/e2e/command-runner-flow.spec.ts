import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  closeApp,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
  REPO_ROOT,
} from './helpers';

test.describe('command runner flow', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('command-runner-flow');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('denies safely and then executes the exact approved command once', async () => {
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await app.evaluate(({ dialog }, workspacePath) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [workspacePath] }),
      });
    }, REPO_ROOT);
    await page.getByRole('button', { name: 'Workspace未選択' }).first().click();
    await expect(page.getByRole('button', { name: 'vibe-editor3' }).first()).toBeVisible();

    const textarea = page.getByTestId('composer-textarea');
    const card = page.getByTestId('approval-card');
    await textarea.fill('コマンドテストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await expect(card).toContainText('run_command');
    await expect(card).toContainText(
      process.platform === 'win32' ? 'where.exe' : '/usr/bin/printf',
    );
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('approval-deny')).toBeFocused();
    await page.getByTestId('approval-deny').press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });

    await textarea.fill('コマンドテストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '今回のみ許可' })).toBeFocused();
    await page.getByRole('button', { name: '今回のみ許可' }).press('Enter');
    const commandCard = page.locator('[data-testid="command-card"].command-card--exited').last();
    await expect(commandCard).toBeVisible();
    await expect(commandCard).toContainText('変更の整合性を確認');
    await expect(commandCard).toContainText(
      process.platform === 'win32' ? 'where.exe' : '/usr/bin/printf',
    );
    await expect(commandCard).toContainText('高リスク');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });
    await expect(commandCard).toContainText('exit 0');
    await expect(commandCard).toContainText('command ok');
    await expect(commandCard.getByTestId('command-duration')).toContainText(/\d/);

    const outputApiProof = await page.evaluate(async () => {
      if (!window.vibe) throw new Error('vibe API unavailable');
      const task = (await window.vibe.tasks.list()).find((candidate) => !candidate.archived);
      if (!task) throw new Error('task unavailable');
      const command = (await window.vibe.commands.list(task.id)).find(
        (candidate) => candidate.state === 'exited',
      );
      if (!command) throw new Error('command unavailable');
      const output = await window.vibe.commands.outputPage({
        taskId: task.id,
        commandId: command.id,
        afterSeq: 0,
        limit: 200,
        maxBytes: 65_536,
      });
      const tail = await window.vibe.commands.outputTail({
        taskId: task.id,
        commandId: command.id,
        maxBytes: 65_536,
      });
      const other = await window.vibe.tasks.create({ title: 'ownership probe' });
      let crossTaskRejected = false;
      try {
        await window.vibe.commands.outputPage({
          taskId: other.id,
          commandId: command.id,
          afterSeq: 0,
          limit: 1,
          maxBytes: 65_536,
        });
      } catch {
        crossTaskRejected = true;
      }
      await window.vibe.tasks.setArchived(other.id, true);
      return {
        text: output.items.map((item) => item.text).join(''),
        eof: output.eof,
        cursor: output.nextAfterSeq,
        pageBytes: output.pageBytes,
        tailCursor: tail.nextAfterSeq,
        crossTaskRejected,
        envKeys: Object.keys(command.envDelta),
      };
    });
    expect(outputApiProof).toMatchObject({
      text: 'command ok\n',
      eof: true,
      crossTaskRejected: true,
    });
    expect(outputApiProof.cursor).toBeGreaterThan(0);
    expect(outputApiProof.tailCursor).toBe(outputApiProof.cursor);
    expect(outputApiProof.pageBytes).toBeLessThanOrEqual(65_536);
    expect(outputApiProof.envKeys).toContain('PATH');

    await commandCard.getByRole('button', { name: '出力を展開' }).press('Enter');
    await expect(commandCard.getByRole('button', { name: '出力を折り畳む' })).toBeVisible();
    await expect(commandCard).toContainText('environment');
    await expect(commandCard).toContainText('PATH');

    await closeApp(app);
    app = await launchApp(userDataDir);
    const restoredPage: Page = await firstWindow(app);
    const restoredCard = restoredPage
      .locator('[data-testid="command-card"].command-card--exited')
      .last();
    await expect(restoredCard).toBeVisible();
    await expect(restoredCard).toContainText('exit 0');
    await expect(restoredCard).toContainText('command ok');

    await restoredPage.getByTestId('access-selector').click();
    await restoredPage.getByTestId('access-option-auto').click();
    await expect(restoredPage.getByTestId('access-selector')).toContainText('安全時は自動');
    const restoredTextarea = restoredPage.getByTestId('composer-textarea');
    await restoredTextarea.fill('コマンドテストをしてください');
    await restoredTextarea.press('Enter');
    await expect(restoredPage.getByTestId('auto-decision-audit')).toContainText('拒否');
    await expect(restoredPage.getByTestId('auto-decision-audit')).toContainText('high_risk');
    await expect(restoredPage.getByTestId('approval-card')).toHaveCount(0);

    await closeApp(app);
    app = await launchApp(userDataDir);
    const auditRestoredPage: Page = await firstWindow(app);
    await expect(auditRestoredPage.getByTestId('auto-decision-audit')).toContainText('high_risk');
  });
});
