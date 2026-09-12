#!/usr/bin/env node
// Read-only observation of a lane renderer over the CDP endpoint bound by launch-dev-instance.sh.
//   node lane-peek.cjs --run-dir DIR --lane NAME [--screenshot out.png] [--poll SECONDS]
// Prints one JSON line: run-card status, approval card (text + button centers), auto-decision audit
// rows, file-change / command cards, last assistant text, footer, access preset, model. With --poll it
// keeps reading until the last turn settles (completed/failed/canceled/interrupted) or an approval
// card appears. Refuses any endpoint whose browser id or listening pid is not the launched instance.
// It never clicks or types: UI actions stay with Computer Use.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const runDir = opt('--run-dir'); const lane = opt('--lane'); const out = opt('--screenshot'); const poll = Number(opt('--poll', '0'));
if (!runDir || !lane) { console.error('--run-dir and --lane are required'); process.exit(64); }
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
    const read = () => page.evaluate(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const cards = q('[data-testid="run-card"]'); const c = document.querySelector('[data-testid="approval-card"]');
      const center = (el) => { const r = el?.getBoundingClientRect(); return r ? [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] : null; };
      const btn = (t) => center([...(c?.querySelectorAll('button') || [])].find((e) => e.textContent.trim() === t));
      const asst = q('[data-testid="assistant-message"]');
      const ta = document.querySelector('[data-testid="composer-textarea"]'); const send = document.querySelector('[data-testid="composer-send-button"]');
      return {
        wizard: !!document.querySelector('[data-testid="setup-wizard"]'),
        runCount: cards.length,
        lastRun: cards.length ? cards[cards.length - 1].getAttribute('data-run-status') : null,
        approval: c ? { text: c.innerText.replace(/\s+/g, ' ').slice(0, 300), allowOnce: btn('今回のみ許可'), allowTask: btn('Task中許可'), deny: btn('拒否') } : null,
        audit: q('[data-testid="auto-decision-audit"]').map((e) => e.textContent.trim().slice(0, 100)),
        files: q('[data-testid="file-change-card"]').map((e) => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 80)),
        commands: q('[data-testid="command-card"]').map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 200)),
        lastAssistant: asst.length ? asst[asst.length - 1].innerText.replace(/\s+/g, ' ').slice(0, 240) : null,
        footer: document.querySelector('[data-testid="surface-footer-connection"]')?.innerText.replace(/\s+/g, ' ').slice(0, 120) ?? null,
        access: document.querySelector('[data-testid="access-selector"]')?.getAttribute('data-access-preset') ?? null,
        model: document.querySelector('[data-testid="model-picker-v2-trigger"]')?.textContent?.trim().slice(0, 40) ?? null,
        composer: { at: center(ta), sendAt: center(send), sendLabel: send?.getAttribute('aria-label') ?? null, value: ta?.value?.slice(0, 40) ?? null },
      };
    });
    // The first read can still show the PREVIOUS turn's terminal card (the new one is not in the DOM
    // yet right after 送信). A terminal state therefore counts only after a new turn was observed:
    // the card count grew, or the last card was seen running.
    const TERMINAL = ['completed', 'failed', 'canceled', 'interrupted'];
    let last = await read();
    const initialCount = last.runCount;
    let newTurnObserved = last.lastRun === 'running';
    const deadline = Date.now() + poll * 1000;
    while (poll > 0 && Date.now() < deadline) {
      if (last.runCount > initialCount || last.lastRun === 'running') newTurnObserved = true;
      if (last.approval) break;
      if (newTurnObserved && TERMINAL.includes(last.lastRun)) break;
      await new Promise((r) => setTimeout(r, 4000)); last = await read();
    }
    if (last.runCount > initialCount || last.lastRun === 'running') newTurnObserved = true;
    last.newTurnObserved = newTurnObserved;
    if (out) await page.screenshot({ path: out });
    console.log(JSON.stringify(last));
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('peek failed:', e.message); process.exit(1); });
