#!/usr/bin/env node
// Documented fallback for two popovers that Computer Use cannot operate in background mode (their
// options are not accessibility hit-testable, and raw key input does not reach Chromium content):
// model selection and the Access preset. Uses the app's OWN IPC through the bound CDP endpoint, then
// reloads the renderer so the store reflects Main. Record every use in events.jsonl as fail_tooling
// for the popover step — this is not a product finding and not a substitute for RA-xx cases.
//   node lane-select.cjs --run-dir DIR --lane NAME [--model <connectionId>/<providerId>/<modelId>] [--preset ask|auto|full]
// Switching to `full` opens the app's native confirmation sheet: click 「フルアクセスを有効化」 with
// Computer Use (AXPress works on that sheet) while this script waits.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const runDir = opt('--run-dir'); const lane = opt('--lane'); const model = opt('--model'); const preset = opt('--preset');
if (!runDir || !lane || (!model && !preset)) { console.error('--run-dir, --lane and at least one of --model / --preset are required'); process.exit(64); }
const laneDir = path.join(runDir, 'lanes', lane);
const app = JSON.parse(fs.readFileSync(path.join(laneDir, 'app.json'), 'utf8'));
const debug = JSON.parse(fs.readFileSync(path.join(laneDir, 'debug.json'), 'utf8'));
const listener = execFileSync('lsof', ['-nP', `-iTCP:${debug.port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('p'))?.slice(1);
if (String(listener) !== String(app.pid)) { console.error(`fail_tooling: port ${debug.port} listener pid=${listener} != launched pid=${app.pid}`); process.exit(2); }
(async () => {
  const version = await fetch(`http://127.0.0.1:${debug.port}/json/version`).then((r) => r.json());
  const wsUrl = version.webSocketDebuggerUrl ?? '';
  if (!wsUrl.includes(debug.browser_id)) { console.error('fail_tooling: endpoint browser id differs from the launched instance'); process.exit(2); }
  const browser = await chromium.connectOverCDP(wsUrl, { timeout: 15_000 });
  try {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /5173/.test(p.url()));
    if (!page) throw new Error('no renderer page on :5173');
    const result = await page.evaluate(async ({ model, preset }) => {
      const sc = window.sprintCoder; const task = (await sc.tasks.list()).find((t) => !t.archived);
      if (!task) throw new Error('current Task unavailable');
      const out = { taskId: task.id };
      if (model) {
        const [connectionId, requestedProvider, requestedModel] = model.split('/');
        const catalog = await sc.models.query({ taskId: task.id });
        const option = (catalog.items ?? []).find((o) => o.connectionId === connectionId && o.modelId === requestedModel);
        if (!option) throw new Error(`model not in catalog: ${model}`);
        out.model = await sc.models.setSelection(task.id, { connectionId, requestedProvider, requestedModel });
        await new Promise((r) => setTimeout(r, 1000));
        const rt = await sc.settings.getRuntime(); out.runtime = { kind: rt.kind, model: rt.model };
      }
      if (preset) {
        const policy = await sc.permissions.get(task.id);
        const saved = await sc.permissions.set(task.id, preset, policy.policyEpoch); // full => native confirm sheet
        out.preset = { before: policy.preset, after: saved.preset };
      }
      return out;
    }, { model, preset });
    await page.reload(); await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="composer-textarea"]').waitFor({ timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1500));
    result.ui = await page.evaluate(() => ({ access: document.querySelector('[data-testid="access-selector"]')?.getAttribute('data-access-preset') ?? null, model: document.querySelector('[data-testid="model-picker-v2-trigger"]')?.textContent?.trim().slice(0, 30) ?? null }));
    console.log(JSON.stringify(result));
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('select failed:', e.message); process.exit(1); });
