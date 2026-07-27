// Projects (folder roots remembered across Tasks, modelled on Codex's [projects."/path"] config
// table). The Workspace picker is a native dialog, so the E2E covers what the renderer can drive
// on its own: the settings section renders, starts empty on a fresh profile, and survives being
// opened and closed. The remembering itself, and the rule about when a folder default may seed a
// Task, are covered by persistence.test.ts and project-access.test.ts.
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('Project settings', () => {
  let app: ElectronApplication | null = null;
  let page: Page;
  let userDataDir: string | null = null;

  test.beforeAll(async () => {
    userDataDir = createUserDataDir('projects');
    app = await launchApp(userDataDir);
    page = await firstWindow(app);
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('is reachable from the sidebar and starts empty on a fresh profile', async () => {
    await page.getByTestId('sidebar-settings-button').click();
    const section = page.getByTestId('settings-projects');
    await expect(section).toBeVisible();

    // A profile that has never picked a Workspace has no remembered folders — and the empty state
    // has to say how one appears, since there is no "add project" button by design.
    await expect(page.getByTestId('settings-projects-empty')).toBeVisible();
    await expect(page.getByTestId('settings-project')).toHaveCount(0);

    // The backend under test does implement Projects; if this ever renders instead, the preload
    // surface and the renderer's feature detection have drifted apart.
    await expect(page.getByTestId('settings-projects-unsupported')).toHaveCount(0);
  });

  test('reopening settings does not carry a half-armed delete', async () => {
    await page.keyboard.press('Escape');
    await page.getByTestId('sidebar-settings-button').click();
    await expect(page.getByTestId('settings-projects')).toBeVisible();
    await expect(page.getByTestId('settings-project-confirm')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
