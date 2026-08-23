import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  assignCurrentTaskToProjectFolder,
  closeApp,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
  REPO_ROOT,
} from './helpers';

/**
 * Presses Tab until the named approval-card button has focus, returning everything it passed through.
 *
 * Counting Tabs is what issue #34 was: the card's focusable count is conditional. `ApprovalCard`
 * only renders its "実行内容をすべて表示" disclosure when `approval.execution.length > 512`, and the
 * execution string embeds the workspace path — so on a short checkout the card has three focusables
 * and on a deeper one it has four. A hardcoded count therefore passed or failed based on where the
 * repository happened to live, not on whether the UI worked.
 *
 * Walking to the target instead keeps what the test is actually for — the approval choices are
 * reachable by keyboard alone, without focus escaping the card — and stays correct however many
 * focusables the card has.
 */
async function tabToApprovalButton(page: Page, testId: string): Promise<string[]> {
  const visited: string[] = [];
  // Generous bound: the card has three or four focusables today, and this only needs to stop a
  // runaway loop if focus somehow cycles.
  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      const card = document.querySelector('[data-testid="approval-card"]');
      return {
        testId: active?.getAttribute('data-testid') ?? null,
        label: active instanceof HTMLElement ? active.innerText.trim().slice(0, 40) : '',
        insideCard: card !== null && active !== null && card.contains(active),
      };
    });
    visited.push(focused.testId ?? focused.label ?? '(unknown)');
    if (!focused.insideCard)
      throw new Error(
        `focus left the approval card before reaching ${testId}; visited ${visited.join(' -> ')}`,
      );
    if (focused.testId === testId) return visited;
  }
  throw new Error(`never reached ${testId}; visited ${visited.join(' -> ')}`);
}

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
    await assignCurrentTaskToProjectFolder(page, 'Command runner', REPO_ROOT);
    await expect(page.getByRole('button', { name: 'Command runner' }).first()).toBeVisible();

    const textarea = page.getByTestId('composer-textarea');
    const card = page.getByTestId('approval-card');
    await textarea.fill('コマンドテストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    await expect(card).toContainText('run_command');
    await expect(card).toContainText(
      process.platform === 'win32' ? 'cmd.exe' : '/usr/bin/printf',
    );
    const toDeny = await tabToApprovalButton(page, 'approval-deny');
    // The three decisions are the last stops and keep their order, whether or not the disclosure
    // button precedes them.
    expect(toDeny.slice(-3)).toEqual([
      'approval-allow-once',
      'approval-allow-task',
      'approval-deny',
    ]);
    await expect(page.getByTestId('approval-deny')).toBeFocused();
    // `page.keyboard`, not `locator.press` — the latter focuses the element first, which would mask
    // exactly the focus bug this walk exists to catch.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });

    await textarea.fill('コマンドテストをしてください');
    await textarea.press('Enter');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    // Same fix here. This one was worse than a failure waiting to happen: with three focusables, two
    // Tabs land on 「Task中許可」 — a *broader* grant than the test means to give.
    const toAllowOnce = await tabToApprovalButton(page, 'approval-allow-once');
    expect(toAllowOnce.at(-1)).toBe('approval-allow-once');
    await expect(page.getByRole('button', { name: '今回のみ許可' })).toBeFocused();
    await page.keyboard.press('Enter');
    const commandCard = page.locator('[data-testid="command-card"].command-card--exited').last();
    await expect(commandCard).toBeVisible();
    await expect(commandCard).toContainText('変更の整合性を確認');
    await expect(commandCard).toContainText(
      process.platform === 'win32' ? 'cmd.exe' : '/usr/bin/printf',
    );
    await expect(commandCard).toContainText('高リスク');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });
    await expect(commandCard).toContainText('exit 0');
    await expect(commandCard).toContainText('command ok');
    await expect(commandCard.getByTestId('command-duration')).toContainText(/\d/);

    const outputApiProof = await page.evaluate(async () => {
      if (!window.sprintCoder) throw new Error('Sprint Coder API unavailable');
      const task = (await window.sprintCoder.tasks.list()).find((candidate) => !candidate.archived);
      if (!task) throw new Error('task unavailable');
      const command = (await window.sprintCoder.commands.list(task.id)).find(
        (candidate) => candidate.state === 'exited',
      );
      if (!command) throw new Error('command unavailable');
      const output = await window.sprintCoder.commands.outputPage({
        taskId: task.id,
        commandId: command.id,
        afterSeq: 0,
        limit: 200,
        maxBytes: 65_536,
      });
      const tail = await window.sprintCoder.commands.outputTail({
        taskId: task.id,
        commandId: command.id,
        maxBytes: 65_536,
      });
      const other = await window.sprintCoder.tasks.create({ title: 'ownership probe' });
      let crossTaskRejected = false;
      try {
        await window.sprintCoder.commands.outputPage({
          taskId: other.id,
          commandId: command.id,
          afterSeq: 0,
          limit: 1,
          maxBytes: 65_536,
        });
      } catch {
        crossTaskRejected = true;
      }
      await window.sprintCoder.tasks.setArchived(other.id, true);
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
    expect(outputApiProof).toMatchObject({ eof: true, crossTaskRejected: true });
    expect(outputApiProof.text).toContain('command ok');
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
