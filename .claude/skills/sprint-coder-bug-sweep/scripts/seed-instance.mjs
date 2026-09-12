#!/usr/bin/env node
// Fallback for the Project-folder step when display-scope Computer Use is unavailable.
// Binds to the lane instance launched by `launch-dev-instance.sh --debug-port N` and refuses anything
// else: the DevTools browser id printed by that launch (lanes/<lane>/debug.json) must equal the id the
// endpoint reports now, and the port's listening pid must be the launched pid. Then it marks first-run
// setup complete, creates one Task through the sidebar button, creates a Project whose primary folder
// is the lane workspace and assigns it (the same preload IPC the E2E helper uses), reloads and
// disconnects. The app keeps running; drive it with Computer Use afterwards.
//   node seed-instance.mjs --run-dir DIR --lane claude [--project-name "Bug sweep claude"]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const runDir = opt('--run-dir');
const lane = opt('--lane');
if (!runDir || !lane) { console.error('--run-dir and --lane are required'); process.exit(64); }
const laneDir = path.join(runDir, 'lanes', lane);
const projectName = opt('--project-name', `Bug sweep ${lane}`);
const app = JSON.parse(fs.readFileSync(path.join(laneDir, 'app.json'), 'utf8'));
const debug = JSON.parse(fs.readFileSync(path.join(laneDir, 'debug.json'), 'utf8'));
const folder = app.workspace;

function fail(code, msg) { console.error(`${code}: ${msg}`); process.exit(2); }

// 1. the listening pid must be the launched pid (guards against a foreign instance on the same port)
const listener = execFileSync('lsof', ['-nP', `-iTCP:${debug.port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' })
  .split('\n').find((l) => l.startsWith('p'))?.slice(1);
if (String(listener) !== String(app.pid) || String(debug.pid) !== String(app.pid)) fail('fail_tooling', `port ${debug.port} listener pid=${listener}, launched pid=${app.pid}`);
// 2. the endpoint must report the browser id captured from THIS launch's app.log
const version = await fetch(`http://127.0.0.1:${debug.port}/json/version`).then((r) => r.json());
const wsUrl = version.webSocketDebuggerUrl ?? '';
const reported = wsUrl.split('/devtools/browser/')[1] ?? '';
if (!reported || reported !== debug.browser_id) fail('fail_tooling', `endpoint browser id ${reported || '(none)'} != launched ${debug.browser_id}`);

const browser = await chromium.connectOverCDP(wsUrl, { timeout: 15_000 });
try {
  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = pages.find((p) => /localhost:5173|127\.0\.0\.1:5173|\[::1\]:5173/.test(p.url()));
  if (!page) fail('fail_tooling', 'no renderer page on :5173 in the bound instance');
  await page.waitForLoadState('domcontentloaded');
  if (!(await page.evaluate(() => typeof window.sprintCoder === 'object'))) fail('fail_tooling', 'window.sprintCoder unavailable (not a Sprint Coder renderer)');
  const hadWizard = (await page.locator('[data-testid="setup-wizard"]').count()) > 0;
  if (hadWizard) {
    await page.evaluate(() => window.localStorage.setItem('sprint-coder:setup-complete-v1', '1'));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  }
  const newTask = page.locator('[data-testid="sidebar-new-task-button"]');
  await newTask.waitFor({ state: 'visible', timeout: 30_000 });
  const hasTask = await page.evaluate(async () => (await window.sprintCoder.tasks.list()).some((t) => !t.archived));
  let createdTask = false;
  if (!hasTask) {
    await newTask.click(); // same entry point as every E2E spec: the sidebar button owns Task creation
    await page.locator('[data-testid="composer-textarea"]').waitFor({ state: 'visible', timeout: 30_000 });
    createdTask = true;
  }
  const result = await page.evaluate(
    async ({ name, path: folderPath }) => {
      const task = (await window.sprintCoder.tasks.list()).find((t) => !t.archived);
      if (!task) throw new Error('current Task unavailable');
      const project = await window.sprintCoder.projects.create({ name, folders: [{ path: folderPath, role: 'primary' }] });
      await window.sprintCoder.projects.assignTask({ projectId: project.id, taskId: task.id, expectedProjectId: task.projectId });
      return { taskId: task.id, projectId: project.id };
    },
    { name: projectName, path: folder },
  );
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: projectName }).first().waitFor({ timeout: 30_000 });
  console.log(JSON.stringify({ ok: true, hadWizard, createdTask, ...result, projectName, folder, pid: app.pid, browser_id: reported }));
} finally {
  await browser.close().catch(() => {}); // disconnect only; the process is owned by launch-dev-instance.sh
}
