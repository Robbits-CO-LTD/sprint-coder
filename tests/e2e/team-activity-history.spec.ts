import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

/**
 * Core C2c: the persisted Team activity history (Core C2b) must be visible in the shipped app and
 * must come back after a restart as the *same* activities — no losses, no duplicates.
 *
 * Launch goes through helpers.ts's `launchApp`, which resolves to the packaged production build
 * (apps/desktop/out/**, packaged by global-setup.ts) wherever packaging works and only falls back
 * to the repo's dev-mode Electron otherwise; every launch here gets its own throwaway userData dir
 * (own SQLite file, own single-instance lock), so no real user profile or secret is ever touched.
 */

// Fixed mock scenario roles (main/team-tools.ts's TEAM_SCENARIO_ROLES), hired in this order.
const SCENARIO_ROLES = ['調査', '実装', 'レビュー'] as const;
// main/team-tools.ts's TEAM_SCENARIO_TRIGGER — what a real user types to ask for a Team.
const TEAM_TRIGGER = 'チームテスト';
const PROMPT = `${TEAM_TRIGGER}：活動履歴の永続化を確認してください`;
// Same budget team-flow.spec.ts gives the mock scenario's hire/dispatch/report round trip.
const SCENARIO_TIMEOUT = 20_000;

// The Leader's own agent row carries role 'leader'; an actor the renderer cannot name falls back to
// the literal 'Leader' (team-activity-display.ts's UNKNOWN_ACTOR_ROLE_LABEL). Either spelling is the
// Leader, and nothing else in the scenario is — so the case-insensitive first letter is the whole
// tolerance, not a wildcard.
const LEADER = '[Ll]eader';

function activityCards(page: Page): Locator {
  return page.getByTestId('team-activity-card');
}

function activityGroup(page: Page): Locator {
  return page.getByTestId('team-activity-group');
}

function activitySummary(page: Page): Locator {
  return page.getByTestId('team-activity-summary');
}

function cardsOfType(page: Page, type: string): Locator {
  return page.locator(`[data-testid="team-activity-card"][data-activity-type="${type}"]`);
}

/** The headline element of each card of `type` — its text is exactly the sentence, so the
 * assertions below can anchor on it instead of matching the card's time/live-region text too. */
function headlinesOfType(page: Page, type: string): Locator {
  return cardsOfType(page, type).getByTestId('team-activity-headline');
}

async function activityIdsInDom(page: Page): Promise<string[]> {
  return activityCards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-activity-id') ?? ''),
  );
}

async function persistedActivityIds(page: Page, taskId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const detail = await window.sprintCoder!.teams.get(id);
    return (detail?.activities ?? []).map((activity) => activity.id);
  }, taskId);
}

/**
 * Waits for the timeline to hold exactly the activities the backend has persisted for this Task.
 *
 * This is the convergence condition the ID-set comparison actually needs — not "enough time has
 * passed". Snapshotting the DOM while a trailing activity is still being written would compare a
 * pre-restart subset against a complete post-restart set and fail for the wrong reason, so the
 * wait is on the store/DOM agreeing with SQLite rather than on any fixed sleep.
 */
async function waitForTimelineToMatchPersistedActivities(
  page: Page,
  taskId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const dom = await activityIdsInDom(page);
        const persisted = await persistedActivityIds(page, taskId);
        return (
          persisted.length > 0 &&
          dom.length === persisted.length &&
          persisted.every((id) => dom.includes(id))
        );
      },
      { timeout: SCENARIO_TIMEOUT },
    )
    .toBe(true);
}

/** Ids seen more than once. `activityIdsInDom` returns every rendered card, so an empty result is
 * exactly "each activity exists in the DOM once". */
function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

test.describe('Core C2c: Team activity history in the packaged app survives a restart', () => {
  // Playwright requires object destructuring when the second `testInfo` argument is used.
  // eslint-disable-next-line no-empty-pattern
  test('shows who was hired and delegated to, and restores the identical activities', async ({}, testInfo) => {
    const userDataDir = createUserDataDir('team-activity-history');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(userDataDir);
      let page: Page = await firstWindow(app);

      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      // The user only ever talks to the Leader, through the normal composer (re-parented into the
      // Canvas by the morph) — no hire UI, no test-only entry point.
      const composer = page.getByTestId('composer-textarea');
      await composer.fill(PROMPT);
      await composer.press('Enter');

      // All three Workers are hired, dispatched to, and finished by the Leader itself.
      const workers = page.getByTestId('team-worker');
      await expect(workers).toHaveCount(3, { timeout: SCENARIO_TIMEOUT });
      for (let index = 0; index < 3; index += 1) {
        await expect(workers.nth(index).locator('.team-status')).toHaveText('done', {
          timeout: SCENARIO_TIMEOUT,
        });
      }
      await expect(page.getByText('completed · Worker 3人')).toBeVisible({
        timeout: SCENARIO_TIMEOUT,
      });

      const taskId: string = await page.evaluate(
        async () => (await window.sprintCoder!.tasks.list())[0]!.id,
      );
      await waitForTimelineToMatchPersistedActivities(page, taskId);

      // The live rows settle into one compact work summary, and that summary remains between the
      // user's request and the Leader's answer even if a trailing lifecycle row was persisted
      // after the answer timestamp.
      await expect(activityGroup(page)).toHaveCount(1);
      await expect(activityGroup(page)).not.toHaveAttribute('open', '');
      await expect(activitySummary(page)).toContainText(/作業しました/);
      const summaryPrecedesAnswer = await activitySummary(page).evaluate((summary) => {
        const answers = document.querySelectorAll('.msg-assistant');
        const answer = answers.item(answers.length - 1);
        return (
          answer !== null &&
          (summary.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        );
      });
      expect(summaryPrecedesAnswer).toBe(true);
      await testInfo.attach('collapsed-team-work-summary', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // The summary is compression, not data loss: opening it restores every persisted activity.
      await activitySummary(page).click();
      await expect(activityGroup(page)).toHaveAttribute('open', '');
      await expect(activityCards(page).first()).toBeVisible();

      // One hire card and one delegation card per Worker — the history says who did what to whom.
      await expect(cardsOfType(page, 'worker_hired')).toHaveCount(3);
      await expect(cardsOfType(page, 'task_assigned')).toHaveCount(3);
      for (const role of SCENARIO_ROLES) {
        await expect(
          headlinesOfType(page, 'worker_hired').filter({
            hasText: new RegExp(`^${LEADER}が「${role}」を雇いました$`),
          }),
        ).toHaveCount(1);
        await expect(
          headlinesOfType(page, 'task_assigned').filter({
            hasText: new RegExp(`^${LEADER}が${role}へ作業を任せました$`),
          }),
        ).toHaveCount(1);
      }

      // Every card carries the persisted activity's own id, and carries it exactly once.
      const idsBeforeRestart = await activityIdsInDom(page);
      expect(idsBeforeRestart.length).toBeGreaterThanOrEqual(6);
      expect(idsBeforeRestart.filter((id) => id === '')).toEqual([]);
      expect(duplicateIds(idsBeforeRestart)).toEqual([]);

      // --- Restart against the SAME userData dir. ---
      await closeApp(app);
      app = await launchApp(userDataDir);
      page = await firstWindow(app);

      // The only Task is auto-selected and its Chat timeline restores from SQLite.
      await expect(page.getByTestId('user-message')).toHaveText(PROMPT, {
        timeout: SCENARIO_TIMEOUT,
      });
      await waitForTimelineToMatchPersistedActivities(page, taskId);

      const idsAfterRestart = await activityIdsInDom(page);
      expect(duplicateIds(idsAfterRestart)).toEqual([]);
      expect([...idsAfterRestart].sort()).toEqual([...idsBeforeRestart].sort());
      await expect(activityGroup(page)).toHaveCount(1);
      await expect(activityGroup(page)).not.toHaveAttribute('open', '');
      await expect(activitySummary(page)).toContainText(/作業しました/);
      await expect(cardsOfType(page, 'worker_hired')).toHaveCount(3);
      await expect(cardsOfType(page, 'task_assigned')).toHaveCount(3);

      // Same timeline seen through the Team Canvas (the morph re-parents the one ChatSurface, so
      // the restored history must still be present once — not duplicated into a second copy).
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();
      await waitForTimelineToMatchPersistedActivities(page, taskId);
      const idsInTeamView = await activityIdsInDom(page);
      expect(duplicateIds(idsInTeamView)).toEqual([]);
      expect([...idsInTeamView].sort()).toEqual([...idsBeforeRestart].sort());
    } finally {
      await closeApp(app);
      removeUserDataDir(userDataDir);
    }
  });
});
