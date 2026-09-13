#!/usr/bin/env node
// Read-only observation of a lane renderer over the CDP endpoint bound by launch-dev-instance.sh.
//   node lane-peek.cjs --run-dir DIR --lane NAME [--screenshot out.png]
//        [--baseline-out FILE]                 BEFORE 送信: record the current turn identity, exit
//        [--poll SECONDS [--baseline FILE]]    AFTER 送信: wait for a turn that differs from it
// Prints one JSON line: run-card status, approval card (text + button centers), auto-decision audit
// rows, file-change / command cards, last assistant text, footer, access preset, model. With --poll it
// keeps reading until the last turn settles (completed/failed/canceled/interrupted) or an approval
// card appears. A terminal state only counts once a NEW turn was observed: with --baseline that means
// the identity moved away from the pre-send snapshot, without it that the card count grew or the last
// card was seen running. If the poll ends without such evidence the JSON carries "stale": true and the
// exit code is 3, so a caller can never read a leftover terminal card as this turn's result.
// Refuses any endpoint whose browser id or listening pid is not the launched instance.
// It never clicks or types: UI actions stay with Computer Use.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const runDir = opt('--run-dir'); const lane = opt('--lane'); const out = opt('--screenshot'); const poll = Number(opt('--poll', '0'));
const baselineOut = opt('--baseline-out'); const baselineFile = opt('--baseline');
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
      const user = q('[data-testid="user-message"]');
      const ta = document.querySelector('[data-testid="composer-textarea"]'); const send = document.querySelector('[data-testid="composer-send-button"]');
      return {
        wizard: !!document.querySelector('[data-testid="setup-wizard"]'),
        runCount: cards.length,
        userCount: user.length,
        lastUser: user.length ? user[user.length - 1].innerText.replace(/\s+/g, ' ').slice(0, 160) : null,
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
    // The renderer exposes no turn id (RunCard keeps only data-testid/data-run-status), so a turn is
    // identified by the content that a new turn necessarily changes: how many user messages and run
    // cards are on screen, the last user/assistant text, the card counts and the run/approval state.
    const identify = (s) => crypto.createHash('sha256').update(JSON.stringify([
      s.userCount, s.lastUser, s.runCount, s.lastRun, s.lastAssistant,
      s.commands.length, s.files.length, s.audit.length, s.approval?.text ?? null,
    ])).digest('hex').slice(0, 16);
    // BEFORE 送信: persist the identity so the post-send --poll can tell a NEW turn from the old one.
    if (baselineOut) {
      const snap = await read();
      const baseline = { lane, captured_at: new Date().toISOString(), identity: identify(snap), runCount: snap.runCount, userCount: snap.userCount, lastRun: snap.lastRun };
      fs.writeFileSync(baselineOut, JSON.stringify(baseline, null, 2) + '\n');
      if (out) await page.screenshot({ path: out });
      console.log(JSON.stringify({ ...snap, identity: baseline.identity, baseline_out: baselineOut }));
      return;
    }
    // The first read can still show the PREVIOUS turn's terminal card (the new one is not in the DOM
    // yet right after 送信), and a whole turn can finish between two reads. A terminal state therefore
    // counts only after a new turn was observed: with --baseline, any drift from the pre-send identity
    // (or a grown card count); without one, only that the card count grew or a card was seen running.
    const TERMINAL = ['completed', 'failed', 'canceled', 'interrupted'];
    const baseline = baselineFile ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null;
    // A baseline from another lane would make every read look "new": refuse it instead.
    if (baseline?.lane && baseline.lane !== lane) throw new Error(`baseline ${baselineFile} was captured for lane ${baseline.lane}, not ${lane}`);
    let last = await read();
    const initialCount = last.runCount;
    const isNew = (s) => (baseline
      ? identify(s) !== baseline.identity || s.runCount > baseline.runCount || s.userCount > baseline.userCount
      : s.runCount > initialCount || s.lastRun === 'running');
    let newTurnObserved = isNew(last);
    const deadline = Date.now() + poll * 1000;
    while (poll > 0 && Date.now() < deadline) {
      if (isNew(last)) newTurnObserved = true;
      if (newTurnObserved && last.approval) break;
      if (newTurnObserved && TERMINAL.includes(last.lastRun)) break;
      await new Promise((r) => setTimeout(r, 4000)); last = await read();
    }
    if (isNew(last)) newTurnObserved = true;
    last.identity = identify(last);
    last.baseline = baseline ? { identity: baseline.identity, captured_at: baseline.captured_at ?? null } : null;
    last.newTurnObserved = newTurnObserved;
    // Fail closed: a poll that never saw this turn is reporting the PREVIOUS turn's state.
    last.stale = poll > 0 && !newTurnObserved;
    if (out) await page.screenshot({ path: out });
    console.log(JSON.stringify(last));
    if (last.stale) process.exitCode = 3;
  } finally { await browser.close().catch(() => {}); }
})().catch((e) => { console.error('peek failed:', e.message); process.exit(1); });
