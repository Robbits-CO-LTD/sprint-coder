#!/usr/bin/env node
// Documented fallback for two popovers that Computer Use cannot operate in background mode (their
// options are not accessibility hit-testable, and raw key input does not reach Chromium content):
// model selection and the Access preset. Uses the app's OWN IPC through the bound CDP endpoint, then
// reloads the renderer so the store reflects Main. Record every use in events.jsonl as fail_tooling
// for the popover step — this is not a product finding and not a substitute for RA-xx cases.
//   node lane-select.cjs --run-dir DIR --lane NAME [--model <connectionId>/<providerId>/<modelId>]
//        [--preset ask|auto|full] [--task-id ID]
// It only ever changes the Task the sidebar shows as selected (aria-current / .sb-row.active); with
// no selected row it changes nothing. --task-id is only a cross-check of that row, and the row's
// title must match the store's (an untitled Task is refused): picking "the first unarchived Task"
// would silently reconfigure a Task the operator is not looking at.
// Switching to `full` opens the app's native confirmation sheet: click 「フルアクセスを有効化」 with
// Computer Use (AXPress works on that sheet) while this script waits.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const runDir = opt('--run-dir'); const lane = opt('--lane'); const model = opt('--model'); const preset = opt('--preset');
const taskIdArg = opt('--task-id') ?? null;
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
    const result = await page.evaluate(async ({ model, preset, taskIdArg }) => {
      const sc = window.sprintCoder;
      // Sidebar.tsx: <div class="sb-row[ active]" data-task-id=…><button class="sb-item"
      // aria-current="true" title={task.title}>. The selected row is the Task on screen.
      const rows = [...document.querySelectorAll('[data-task-id]')].map((el) => ({
        id: el.getAttribute('data-task-id'),
        active: el.classList.contains('active') || !!el.querySelector('[aria-current="true"]'),
        title: el.querySelector('button.sb-item')?.getAttribute('title') ?? el.querySelector('button')?.textContent?.trim() ?? null,
      }));
      // The selected row is the ONLY thing that decides which Task is changed. --task-id is a
      // cross-check, never a source: without a selected row there is nothing to verify against.
      const active = rows.find((r) => r.active) ?? null;
      if (!active) throw new Error('current Task unavailable: the sidebar shows no selected Task (aria-current) — select the Task in the UI and retry; --task-id alone is not a reason to change anything');
      if (taskIdArg && taskIdArg !== active.id) throw new Error(`--task-id ${taskIdArg} is not the Task on screen (${active.id}) — refusing to change another Task`);
      const taskId = active.id;
      const task = (await sc.tasks.list()).find((t) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} is selected in the sidebar but not in tasks.list()`);
      const uiTitle = (active.title ?? '').trim(); const storeTitle = (task.title ?? '').trim();
      if (!uiTitle || !storeTitle) throw new Error(`Task ${taskId} has no title on ${uiTitle ? 'the store' : 'the sidebar'} side, so UI and store cannot be cross-checked — name the Task first`);
      if (uiTitle !== storeTitle) throw new Error(`Task title mismatch: sidebar "${uiTitle}" vs store "${storeTitle}" — refusing`);
      const out = { taskId: task.id, taskTitle: storeTitle, taskIdChecked: Boolean(taskIdArg) };
      if (model) {
        // modelId itself may contain "/" (OpenRouter ships author/model ids), so only the FIRST two
        // separators are structural and everything after them is the model id.
        const [connectionId, requestedProvider, ...rest] = model.split('/');
        const requestedModel = rest.join('/');
        if (!connectionId || !requestedProvider || !requestedModel) throw new Error(`--model must be <connectionId>/<providerId>/<modelId>: ${model}`);
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
    }, { model, preset, taskIdArg });
    await page.reload(); await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="composer-textarea"]').waitFor({ timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1500));
    result.ui = await page.evaluate(() => ({ access: document.querySelector('[data-testid="access-selector"]')?.getAttribute('data-access-preset') ?? null, model: document.querySelector('[data-testid="model-picker-v2-trigger"]')?.textContent?.trim().slice(0, 30) ?? null }));
    console.log(JSON.stringify(result));
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('select failed:', e.message); process.exit(1); });
