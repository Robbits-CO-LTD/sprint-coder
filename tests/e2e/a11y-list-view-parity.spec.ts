import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Phase 7 (tasks/IMPLEMENTATION_PLAN.md §10.3: "Canvasと同等情報をlist viewで提供" /
// NFR-A11Y-02): the List View must not omit anything the Canvas shows for the same settled Team.
// This machine-diffs the actual rendered DOM text between the two views for the identical Team
// state (App only ever mounts one of the two, so this reopens the same Task in each), rather than
// eyeballing a screenshot.
//
// One real asymmetry, noted rather than papered over: once a Worker reaches a terminal state,
// Canvas's `.w-body` stops rendering a "currently doing X" line at all (WorkerNode.tsx only shows
// it `worker.state === 'busy'`), and Canvas never renders token/time/tool-call usage anywhere.
// List View always shows both (`tlv-activity`/`tlv-usage`) regardless of state. That is List
// showing *more* than Canvas for a settled Team, never less — so it's asserted directly (List has
// them) rather than diffed against a Canvas value that doesn't exist.

type WorkerFacts = { role: string; objective: string; state: string; lines: string[] };

async function readCanvasWorkers(page: Page): Promise<Map<string, WorkerFacts>> {
  const cards = page.getByTestId('team-worker');
  const count = await cards.count();
  const out = new Map<string, WorkerFacts>();
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    // eslint-disable-next-line no-await-in-loop
    const role = (await card.locator('.role-name').innerText()).trim();
    // eslint-disable-next-line no-await-in-loop
    const objective = (await card.locator('.role-sub').innerText()).trim();
    // eslint-disable-next-line no-await-in-loop
    const state = (await card.locator('.team-status').innerText()).trim();
    // eslint-disable-next-line no-await-in-loop
    const lines = await readLines(card.locator('.w-line'));
    out.set(role, { role, objective, state, lines });
  }
  return out;
}

async function readListWorkers(page: Page): Promise<Map<string, WorkerFacts>> {
  const items = page.getByTestId('team-worker'); // TeamListView.tsx reuses the same testid
  const count = await items.count();
  const out = new Map<string, WorkerFacts>();
  for (let i = 0; i < count; i += 1) {
    const item = items.nth(i);
    // eslint-disable-next-line no-await-in-loop
    const role = (await item.locator('.role-name').innerText()).trim();
    // eslint-disable-next-line no-await-in-loop
    const objective = (await item.locator('.tlv-objective').innerText()).trim();
    // eslint-disable-next-line no-await-in-loop
    const state = (await item.locator('.team-status').innerText()).trim();
    // eslint-disable-next-line no-await-in-loop
    const lines = await readLines(item.locator('.w-line'));
    out.set(role, { role, objective, state, lines });
  }
  return out;
}

async function readLines(locator: Locator): Promise<string[]> {
  const count = await locator.count();
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    lines.push((await locator.nth(i).innerText()).trim());
  }
  return lines;
}

test.describe('List View parity with Canvas (settled Team)', () => {
  test('role/objective/state/message-lines/team-chip machine-diff identically; List additionally exposes activity + usage', async () => {
    const dir = createUserDataDir('a11y-list-parity');
    let app: ElectronApplication | null = null;
    try {
      app = await launchApp(dir);
      const page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await page.getByTestId('team-toggle').click();
      await expect(page.getByTestId('team-list')).toBeVisible();

      const composer = page.getByTestId('composer-textarea');
      await composer.fill('チームテスト：List View parity確認');
      await composer.press('Enter');
      await expect(page.getByTestId('team-worker')).toHaveCount(3, { timeout: 20_000 });
      const cards = page.getByTestId('team-worker');
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await expect(cards.nth(i).locator('.team-status')).toHaveText('done', { timeout: 20_000 });
      }

      const canvasTeamChip = (await page.locator('.team-status-chip').innerText()).trim();
      const canvasWorkers = await readCanvasWorkers(page);
      expect(canvasWorkers.size).toBe(3);
      // Sanity on the fixture itself: every Worker really did get one dispatch + one report line —
      // otherwise an empty-lines diff would trivially "pass" without proving anything.
      for (const facts of canvasWorkers.values()) {
        expect(facts.lines.length).toBe(2);
        expect(facts.lines.some((l) => l.startsWith('Leaderから'))).toBe(true);
        expect(facts.lines.some((l) => l.startsWith('報告'))).toBe(true);
      }

      await page.getByTestId('team-view-toggle').click();
      await expect(page.locator('.team-list-view')).toBeVisible();

      const listTeamChip = (await page.locator('.team-status-chip').innerText()).trim();
      const listWorkers = await readListWorkers(page);
      expect(listWorkers.size).toBe(3);

      // --- Machine diff: List must carry every field Canvas showed, byte-for-byte. ---
      expect(listTeamChip).toBe(canvasTeamChip);
      expect([...listWorkers.keys()].sort()).toEqual([...canvasWorkers.keys()].sort());
      for (const [role, canvasFacts] of canvasWorkers) {
        const listFacts = listWorkers.get(role);
        expect(listFacts, `List View is missing Worker "${role}" that Canvas showed`).toBeDefined();
        expect(listFacts?.objective).toBe(canvasFacts.objective);
        expect(listFacts?.state).toBe(canvasFacts.state);
        expect(listFacts?.lines).toEqual(canvasFacts.lines);
      }

      // --- List additionally exposes activity + usage for every Worker (superset, not a gap —
      // Canvas shows neither once a Worker is terminal, see file header comment). ---
      const items = page.getByTestId('team-worker');
      for (let i = 0; i < 3; i += 1) {
        const item = items.nth(i);
        // eslint-disable-next-line no-await-in-loop
        await expect(item.locator('.tlv-activity')).toContainText('現在:');
        // eslint-disable-next-line no-await-in-loop
        const usage = await item.locator('.tlv-usage').innerText();
        // `dt` labels render as `text-transform: uppercase` visually, which `innerText` reflects.
        expect(usage).toMatch(/tokens/i);
        expect(usage).toMatch(/tools/i);
      }

      // --- List's aggregate message timeline: 3 Workers x (dispatch + report) = 6 entries. ---
      await expect(page.locator('.tlv-timeline ol > li')).toHaveCount(6);
    } finally {
      await closeApp(app);
      removeUserDataDir(dir);
    }
  });
});
