import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

// Phase 7 axe pass (tasks/IMPLEMENTATION_PLAN.md §10.3): injects the real axe-core engine into the
// live app instead of building a separate jsdom/@testing-library renderer harness.
//
// Why this approach over a jsdom component-test harness: every candidate component (Sidebar,
// TaskHeader, Composer, ApprovalCard, RunCard, TeamListView, WorkerNode) reads from the zustand
// store (useAppStore) and, in several places, from the `window.sprintCoder` preload bridge
// directly (Sidebar's canManage, Composer's canQueue/canSteer/canStopAndSend, TaskHeader's
// GoalChip). Rendering any of them in isolation would mean hand-mocking a non-trivial slice of
// both, with a real risk of the mocked state silently drifting from what the app actually produces
// — and this repo has no jsdom/@testing-library devDependency or vitest DOM environment configured
// today (command-projection.test.ts and contrast.test.ts both run under vitest's plain Node
// environment). Driving axe-core against the actual running Electron renderer (already exercised
// end-to-end by every other spec in this directory) tests the real DOM the user sees, with zero new
// test infra beyond the axe-core devDependency itself.
//
// `addScriptTag` is intentionally not used: both inline tags and localhost script URLs are
// rejected by the packaged production CSP. Playwright's `page.evaluate(string)` executes through
// the browser automation protocol rather than by adding a page-owned script element, so it can
// load the local test dependency without weakening the product CSP or starting a network server.
const AXE_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'node_modules', 'axe-core', 'axe.min.js'),
  'utf8',
);

/** Call once after all axe-using tests in a file/suite are done (e.g. in `test.afterAll`) to stop
 * the local static server. Safe to call even if no axe check ever ran. */
export function stopAxeServer(): void {
  // Compatibility no-op: older callers still invoke this in afterAll.
}

export async function injectAxe(page: Page): Promise<void> {
  const alreadyPresent = await page.evaluate(
    () => typeof (window as { axe?: unknown }).axe !== 'undefined',
  );
  if (alreadyPresent) return;
  await page.evaluate(AXE_SOURCE);
}

export type AxeViolation = {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[] }>;
};

/** Runs axe-core scoped to `includeSelectors` (defaults to the whole document) and returns only
 * serious/critical violations — matching this gate's bar (docs/PRODUCT_AND_TECHNICAL_DESIGN.md
 * NFR-A11Y-01), not every moderate/minor finding axe's full ruleset would otherwise surface. */
export async function runAxeSerious(
  page: Page,
  includeSelectors?: string[],
): Promise<AxeViolation[]> {
  await injectAxe(page);
  const violations = await page.evaluate(async (selectors) => {
    const axe = (
      window as unknown as {
        axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: unknown[] }> };
      }
    ).axe;
    const context =
      selectors && selectors.length > 0 ? { include: selectors.map((s) => [s]) } : document;
    const result = await axe.run(context, { resultTypes: ['violations'] });
    return result.violations;
  }, includeSelectors);
  return (violations as AxeViolation[]).filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
}

export function formatViolations(violations: AxeViolation[]): string {
  if (violations.length === 0) return '(no serious/critical violations)';
  return violations
    .map((v) => {
      const nodes = v.nodes
        .map((n) => `    - ${n.target.join(' ')}\n      ${n.html.slice(0, 200)}`)
        .join('\n');
      return `[${v.impact}] ${v.id} — ${v.help} (${v.helpUrl})\n${nodes}`;
    })
    .join('\n\n');
}
