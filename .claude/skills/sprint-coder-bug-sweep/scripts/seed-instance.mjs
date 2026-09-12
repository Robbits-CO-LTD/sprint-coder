#!/usr/bin/env node
// Fallback for the Project-folder step when display-scope Computer Use is unavailable.
// Connects over CDP to a lane instance launched with `launch-dev-instance.sh --debug-port N`, marks
// first-run setup complete, creates one Task, creates a Project whose primary folder is --folder and
// assigns it (the same preload IPC the E2E helper assignCurrentTaskToProjectFolder uses), then
// reloads and disconnects. The app keeps running; drive it with Computer Use afterwards.
//   node seed-instance.mjs --port 9333 --project-name "Bug sweep claude" --folder /abs/workspace
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const port = Number(args.port ?? 9333);
const projectName = args['project-name'] ?? 'Bug sweep';
const folder = args.folder;
if (!folder) {
  console.error('--folder is required');
  process.exit(64);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
try {
  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = pages.find((p) => /localhost:5173|127\.0\.0\.1:5173|\[::1\]:5173/.test(p.url())) ?? pages[0];
  if (!page) throw new Error('no renderer page found over CDP');
  await page.waitForLoadState('domcontentloaded');
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
    // Same entry point as every E2E spec: the sidebar button owns Task creation.
    await newTask.click();
    await page.locator('[data-testid="composer-textarea"]').waitFor({ state: 'visible', timeout: 30_000 });
    createdTask = true;
  }
  const result = await page.evaluate(
    async ({ name, path }) => {
      if (!window.sprintCoder) throw new Error('Sprint Coder API unavailable');
      const task = (await window.sprintCoder.tasks.list()).find((t) => !t.archived);
      if (!task) throw new Error('current Task unavailable');
      const project = await window.sprintCoder.projects.create({ name, folders: [{ path, role: 'primary' }] });
      await window.sprintCoder.projects.assignTask({ projectId: project.id, taskId: task.id, expectedProjectId: task.projectId });
      return { taskId: task.id, projectId: project.id };
    },
    { name: projectName, path: folder },
  );
  result.createdTask = createdTask;
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: projectName }).first().waitFor({ timeout: 30_000 });
  console.log(JSON.stringify({ ok: true, hadWizard, ...result, projectName, folder }));
} finally {
  // Disconnect only; the Electron process is owned by launch-dev-instance.sh.
  await browser.close().catch(() => {});
}
