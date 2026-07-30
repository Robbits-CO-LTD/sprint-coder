import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #4: the only path that ever set a Task title was the header's inline rename, so the sidebar
// filled up with rows all reading "新しいタスク" and none of them distinguishable.

const PLACEHOLDER = '新しいタスク';

test.describe('automatic Task naming', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('task-auto-title');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('names a Task from its first message, then never touches it again', async () => {
    app = await launchApp(userDataDir);
    let page: Page = await firstWindow(app);

    await page.getByTestId('sidebar-new-task-button').click();
    const textarea = page.getByTestId('composer-textarea');
    await expect(textarea).toBeVisible();

    const sidebar = page.locator('.sidebar');
    // A blank Task is a composer workspace, not conversation history.
    await expect(sidebar.getByText(PLACEHOLDER, { exact: true })).toHaveCount(0);

    // First message names it. Sent as a multi-line message so the assertion also covers "only the
    // first line becomes the title", which is what makes a realistic paste usable as a label.
    await textarea.fill('ログイン画面のバグを直して\n\n詳細:\n- トークンが切れる');
    await textarea.press('Enter');

    // Visible before the turn even finishes: the rename commits in the same transaction as the
    // user message and comes back on the start result.
    await expect(sidebar.getByText('ログイン画面のバグを直して', { exact: true })).toBeVisible();
    await expect(sidebar.getByText(PLACEHOLDER, { exact: true })).toHaveCount(0);

    const runCard = page.getByTestId('run-card');
    await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 30_000 });

    // A second message must not rename an established conversation.
    await textarea.fill('全く違う二通目の内容です');
    await textarea.press('Enter');
    await expect(runCard).toHaveAttribute('data-run-status', 'completed', { timeout: 30_000 });
    await expect(sidebar.getByText('ログイン画面のバグを直して', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('全く違う二通目の内容です', { exact: true })).toHaveCount(0);

    // The name is durable, not just an in-memory store update.
    await closeApp(app);
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
    await expect(
      page.locator('.sidebar').getByText('ログイン画面のバグを直して', { exact: true }),
    ).toBeVisible();
  });

  test('leaves a manually renamed Task alone', async () => {
    // Second Task in the same userDataDir, so this also covers the sidebar holding two
    // distinguishable rows — the actual complaint in the issue.
    const page: Page = await firstWindow(app!);
    await page.getByTestId('sidebar-new-task-button').click();

    // TaskHeader has no testids on the title control; its accessible name is the stable handle.
    const header = page.locator('.task-header .task-title');
    await header.click();
    const titleInput = page.getByLabel('Task名を編集');
    await titleInput.fill('自分で付けた名前');
    await titleInput.press('Enter');
    await expect(header).toHaveText('自分で付けた名前');

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('この内容ではタイトルが上書きされないはず');
    await textarea.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 30_000,
    });

    await expect(header).toHaveText('自分で付けた名前');
    const sidebar = page.locator('.sidebar');
    await expect(sidebar.getByText('自分で付けた名前', { exact: true })).toBeVisible();
    await expect(
      sidebar.getByText('この内容ではタイトルが上書きされないはず', { exact: true }),
    ).toHaveCount(0);
    // Both Tasks are now telling apart from each other, which is the whole point.
    await expect(sidebar.getByText('ログイン画面のバグを直して', { exact: true })).toBeVisible();
  });
});
