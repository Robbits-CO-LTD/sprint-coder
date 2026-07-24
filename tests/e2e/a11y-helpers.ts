import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
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
// Why a local HTTP server, not `page.addScriptTag({ path })`: this app ships a real CSP even in
// dev mode (index.html's meta tag, `script-src 'self' http://localhost:*` — see its own comment for
// why), which rejects `addScriptTag({ path })`'s inline `<script>` injection outright ("Executing
// inline script violates ... script-src"). `page.addInitScript` sidesteps CSP but only takes effect
// on the *next* navigation — useless once the app and its state (a populated chat/Team/approval)
// already exist. Serving axe-core's own file from a `http://localhost:*` origin and loading it via
// `addScriptTag({ url })` is a same-shape `<script src>` the CSP already explicitly allows, with no
// relaxation of the app's own policy. This only works against the dev-mode CSP (packaged builds'
// `script-src 'self'` has no localhost exception) — matching how this gate is actually verified
// (`SPRINT_CODER_E2E_MODE=dev`, see tests/e2e/helpers.ts's own doc comment on why packaging isn't
// usable in this environment today).
const AXE_SOURCE = readFileSync(join(__dirname, '..', '..', 'node_modules', 'axe-core', 'axe.min.js'));

let axeServer: Server | null = null;
let axeServerUrl: string | null = null;

function ensureAxeServer(): Promise<string> {
  if (axeServerUrl) return Promise.resolve(axeServerUrl);
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(AXE_SOURCE);
    });
    server.on('error', reject);
    // Bound to 127.0.0.1, but referenced via the `localhost` hostname below — the CSP's allowance
    // is specifically `http://localhost:*` (see the module doc comment), not `127.0.0.1`.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      axeServer = server;
      axeServerUrl = `http://localhost:${port}/axe.min.js`;
      resolve(axeServerUrl);
    });
  });
}

/** Call once after all axe-using tests in a file/suite are done (e.g. in `test.afterAll`) to stop
 * the local static server. Safe to call even if no axe check ever ran. */
export function stopAxeServer(): void {
  axeServer?.close();
  axeServer = null;
  axeServerUrl = null;
}

export async function injectAxe(page: Page): Promise<void> {
  const alreadyPresent = await page.evaluate(() => typeof (window as { axe?: unknown }).axe !== 'undefined');
  if (alreadyPresent) return;
  const url = await ensureAxeServer();
  await page.addScriptTag({ url });
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
export async function runAxeSerious(page: Page, includeSelectors?: string[]): Promise<AxeViolation[]> {
  await injectAxe(page);
  const violations = await page.evaluate(async (selectors) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: unknown[] }> } }).axe;
    const context = selectors && selectors.length > 0 ? { include: selectors.map((s) => [s]) } : document;
    const result = await axe.run(context, { resultTypes: ['violations'] });
    return result.violations;
  }, includeSelectors);
  return (violations as AxeViolation[]).filter((v) => v.impact === 'serious' || v.impact === 'critical');
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
