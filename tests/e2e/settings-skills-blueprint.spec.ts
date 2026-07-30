import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('Settings v2 and Skill selection', () => {
  let app: ElectronApplication | null = null;
  let userDataDir: string;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('settings-skills-blueprint');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('navigates Team and Skills settings, then pins and restores skill-creator without sending', async () => {
    app = await launchApp(userDataDir);
    let page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();

    await page.getByTestId('sidebar-settings-button').click();
    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('settings-nav-team')).toBeVisible();
    await expect(page.getByTestId('settings-nav-skills')).toBeVisible();

    await page.getByTestId('settings-nav-team').click();
    await expect(page.getByTestId('settings-team-defaults')).toBeVisible();
    await expect(page.getByTestId('settings-team-default-depth')).toHaveValue('4');
    await expect(page.getByTestId('settings-team-default-concurrency')).toHaveValue('8');
    await expect(page.getByTestId('settings-team-research')).toBeVisible();

    await page.getByTestId('settings-nav-skills').click();
    await expect(page.getByText('Skill Creator', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Chat Skill／Team Skill作成/)).toBeVisible();
    await page.getByTestId('settings-close').click();

    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill('/skill-creator');
    const creator = page.locator('[data-testid^="slash-item-skill:builtin:skill-creator:"]');
    await expect(creator).toBeVisible();
    await creator.click();

    await expect(textarea).toHaveValue('');
    const chip = page.locator('.composer-skill-chip').filter({ hasText: 'skill-creator' });
    await expect(chip).toBeVisible();
    await expect(page.locator('.message-bubble')).toHaveCount(0);

    await closeApp(app);
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
    await expect(
      page.locator('.composer-skill-chip').filter({ hasText: 'skill-creator' }),
    ).toBeVisible();

    await page.locator('.composer-skill-chip').filter({ hasText: 'skill-creator' }).click();
    await expect(
      page.locator('.composer-skill-chip').filter({ hasText: 'skill-creator' }),
    ).toHaveCount(0);
  });
});
