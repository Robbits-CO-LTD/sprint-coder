import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('Project Context Inspector (B4)', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;
  let page: Page;

  test.beforeAll(async () => {
    userDataDir = createUserDataDir('project-context-inspector');
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('saves instruction explicitly and inspects the immutable Turn seal as plain text', async () => {
    await page.getByRole('button', { name: 'Projectを作成' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Project名').fill('Inspector Project');
    await dialog.getByRole('button', { name: '作成' }).click();

    const project = page.locator('.sb-project').filter({ hasText: 'Inspector Project' });
    await project.getByLabel('Inspector Projectのメニュー').click();
    await project.getByRole('button', { name: '新しいTask' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '作成' }).click();

    await page.getByTestId('project-context-chip').click();
    const inspector = page.getByTestId('project-context-inspector');
    await expect(inspector).toBeVisible();
    await expect(page.getByTestId('inspector-panel')).toHaveAttribute(
      'data-inspector-state',
      'panel',
    );

    const instruction = page.getByTestId('project-instruction-input');
    await expect(instruction).toHaveValue('');
    await instruction.fill('Keep **this** as plain text.');
    await page.getByTestId('project-instruction-save').click();
    await expect(page.getByTestId('project-instruction-save')).toBeDisabled();

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('Context sealを確認します');
    await textarea.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'Contextを表示' }).click();
    const manifest = page.getByTestId('context-manifest');
    await expect(manifest).toContainText('Inspector Project');
    await expect(manifest).toContainText('Candidate digest');
    await expect(manifest.locator('pre')).toHaveText('Keep **this** as plain text.');
    await expect(manifest.locator('strong')).toHaveText('instruction');
    await expect(manifest).toContainText('authority: user · localOnly: false');
  });

  test('preserves local input on CAS conflict and offers an explicit reload', async () => {
    const instruction = page.getByTestId('project-instruction-input');
    await instruction.fill('My unsaved local instruction');
    await page.evaluate(async () => {
      const task = (await window.sprintCoder!.tasks.list()).find(
        (item) =>
          item.id === document.querySelector<HTMLElement>('[data-task-id].active')?.dataset.taskId,
      );
      if (task?.projectId === null || task?.projectId === undefined)
        throw new Error('Project missing');
      const current = await window.sprintCoder!.projects.get({ projectId: task.projectId });
      await window.sprintCoder!.projects.setInstruction({
        projectId: task.projectId,
        expectedRevision: current.revision,
        instruction: 'Remote instruction',
      });
    });

    await page.getByTestId('project-instruction-save').click();
    await expect(instruction).toHaveValue('My unsaved local instruction');
    const conflict = page.getByRole('alert');
    await expect(conflict).toContainText('入力内容は保持されています');
    await conflict.getByRole('button', { name: '最新を再読込' }).click();
    await expect(instruction).toHaveValue('Remote instruction');
  });

  test('saves an explicit user-authored memory from a completed Turn', async () => {
    await page.getByRole('button', { name: 'Project Memoryに保存' }).last().click();
    const memoryDialog = page.getByRole('dialog', { name: 'Project Memoryに保存' });
    await expect(memoryDialog).toBeVisible();
    await expect(memoryDialog.getByRole('heading', { name: 'Request' })).toBeVisible();
    await expect(memoryDialog.locator('pre').first()).toHaveText('Context sealを確認します');
    const memory = memoryDialog.getByLabel('Memory（1〜4000文字）');
    await expect(memory).toHaveValue('');
    await memory.fill('公開APIを維持する。');
    await memoryDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(memoryDialog.getByRole('status')).toHaveText(
      '保存しました。次のTurnから利用されます。',
    );
    await memoryDialog.getByRole('button', { name: '閉じる' }).click();

    const memorySection = page
      .locator('.project-context-section')
      .filter({ has: page.getByRole('heading', { name: 'Shared memory' }) });
    await memorySection.getByRole('button', { name: '更新' }).click();
    await expect(memorySection.getByLabel('Memory内容')).toHaveValue('公開APIを維持する。');
  });

  test('keeps a manually selected past Turn when a newer Turn arrives', async () => {
    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('二つ目のTurn');
    await textarea.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 30_000,
    });

    const selector = page.getByTestId('context-turn-selector');
    await expect(selector.locator('option')).toHaveCount(3);
    const oldestTurn = await selector.locator('option').last().getAttribute('value');
    expect(oldestTurn).not.toBeNull();
    await selector.selectOption(oldestTurn!);
    await expect(selector).toHaveValue(oldestTurn!);

    await textarea.fill('三つ目のTurn');
    await textarea.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 30_000,
    });
    await expect(selector.locator('option')).toHaveCount(4);
    await expect(selector).toHaveValue(oldestTurn!);
  });

  test('warns before closing with an unsaved Instruction', async () => {
    const instruction = page.getByTestId('project-instruction-input');
    await instruction.fill('Unsaved close guard');
    page.once('dialog', (nativeDialog) => void nativeDialog.dismiss());
    await page.getByTestId('inspector-close').click();
    await expect(page.getByTestId('project-context-inspector')).toBeVisible();
    await expect(instruction).toHaveValue('Unsaved close guard');

    page.once('dialog', (nativeDialog) => void nativeDialog.accept());
    await page.getByTestId('inspector-close').click();
    await expect(page.getByTestId('inspector-panel')).toHaveCount(0);
  });
});
