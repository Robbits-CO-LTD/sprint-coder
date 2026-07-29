import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

test.describe('Core C4b: Team Policy settings', () => {
  test('edits the canonical policy from Canvas and remains available in List view', async () => {
    const userDataDir = createUserDataDir('team-policy');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      const page = await firstWindow(app);

      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      // Entering Team mode and restoring the renderer-only view preference can complete on
      // adjacent frames. Pin this scenario to Canvas before retaining a trigger locator; otherwise
      // the Canvas trigger may be clicked just as List replaces it, immediately unmounting the
      // dialog the test opened.
      const initialViewToggle = page.getByTestId('team-view-toggle');
      if ((await initialViewToggle.textContent())?.includes('Canvas表示')) {
        await initialViewToggle.click();
      }
      await expect(page.getByTestId('team-view-toggle')).toContainText('List表示');

      const taskId = await page.evaluate(
        async () => (await window.sprintCoder!.tasks.list())[0]!.id,
      );
      const initial = await page.evaluate(
        async (id) => (await window.sprintCoder!.teams.get(id))!.team,
        taskId,
      );

      const canvasTrigger = page.getByTestId('team-policy-open');
      await canvasTrigger.click();
      const dialog = page.getByTestId('team-policy-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('team-policy-max-depth')).toHaveValue(
        String(initial.policy.maxAgentDepth),
      );
      await expect(page.getByTestId('team-policy-max-concurrent')).toHaveValue(
        String(initial.policy.maxConcurrentExecutions),
      );
      await expect(page.getByTestId('team-policy-revision')).toContainText(
        String(initial.revision),
      );

      await page.getByTestId('team-policy-max-depth').selectOption('3');
      await page.getByTestId('team-policy-max-concurrent').selectOption('5');
      await page.getByTestId('team-policy-direct-messages').press('Space');
      await expect(page.getByTestId('team-policy-direct-messages')).not.toBeChecked();
      await page.getByTestId('team-policy-budget-unlimited').getByRole('radio').press('Space');
      await expect(
        page.getByTestId('team-policy-budget-unlimited').getByRole('radio'),
      ).toBeChecked();
      await page.getByTestId('team-policy-save').click();

      await expect(dialog).toHaveCount(0);
      await expect(canvasTrigger).toBeFocused();
      await expect
        .poll(async () =>
          page.evaluate(async (id) => (await window.sprintCoder!.teams.get(id))!.team, taskId),
        )
        .toMatchObject({
          revision: initial.revision + 1,
          policy: {
            maxAgentDepth: 3,
            maxConcurrentExecutions: 5,
            allowWorkerDirectMessages: false,
            budgetMode: 'unlimited',
          },
        });

      await canvasTrigger.click();
      await expect(page.getByTestId('team-policy-max-depth')).toHaveValue('3');
      await expect(page.getByTestId('team-policy-max-concurrent')).toHaveValue('5');
      await expect(page.getByTestId('team-policy-direct-messages')).not.toBeChecked();
      await expect(
        page.getByTestId('team-policy-budget-unlimited').getByRole('radio'),
      ).toBeChecked();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(canvasTrigger).toBeFocused();

      await page.getByTestId('team-view-toggle').click();
      await expect(page.getByTestId('team-list')).toHaveAttribute('aria-label', 'Team list');
      const listTrigger = page.getByTestId('team-policy-open');
      const headerFit = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>('[data-testid="team-list-header"]');
        const policy = document.querySelector<HTMLElement>('[data-testid="team-policy-open"]');
        if (!header || !policy) return null;
        const h = header.getBoundingClientRect();
        const p = policy.getBoundingClientRect();
        return {
          leftSlack: p.left - h.left,
          rightSlack: h.right - p.right,
          horizontalOverflow: header.scrollWidth - header.clientWidth,
        };
      });
      expect(headerFit).not.toBeNull();
      if (headerFit) {
        expect(headerFit.leftSlack).toBeGreaterThanOrEqual(-1);
        expect(headerFit.rightSlack).toBeGreaterThanOrEqual(-1);
        expect(headerFit.horizontalOverflow).toBeLessThanOrEqual(1);
      }
      await listTrigger.click();
      await expect(page.getByTestId('team-policy-dialog')).toBeVisible();
      await expect(page.getByTestId('team-policy-max-depth')).toHaveValue('3');

      const beforeConflict = await page.evaluate(
        async (id) => (await window.sprintCoder!.teams.get(id))!.team,
        taskId,
      );
      await page.evaluate(
        async ({ id, revision, policy }) =>
          window.sprintCoder!.teams.updatePolicy({
            taskId: id,
            expectedRevision: revision,
            policy: { ...policy, maxConcurrentExecutions: 4 },
          }),
        {
          id: taskId,
          revision: beforeConflict.revision,
          policy: beforeConflict.policy,
        },
      );
      await page.getByTestId('team-policy-save').click();
      await expect(page.getByTestId('team-policy-dialog')).toBeVisible();
      await expect(page.getByTestId('team-policy-error')).toHaveAttribute('role', 'alert');
      await expect(page.getByTestId('team-policy-error')).toContainText('保存できませんでした');
      await expect
        .poll(async () =>
          page.evaluate(
            async (id) =>
              (await window.sprintCoder!.teams.get(id))!.team.policy.maxConcurrentExecutions,
            taskId,
          ),
        )
        .toBe(4);

      await page.getByTestId('team-policy-close').click();
      await expect(page.getByTestId('team-policy-dialog')).toHaveCount(0);
      await expect(listTrigger).toBeFocused();
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });
});
