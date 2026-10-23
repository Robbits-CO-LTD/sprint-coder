import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';

// Linux unit jobs do not promise a display server. Exercise the native desktop contract on
// macOS and Windows; the ordinary confirmation tests cover the 120-second policy on every OS.
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
  'parented native confirmation cancellation',
  () => {
    it('keeps a real Electron dialog unanswered until AbortSignal returns its cancel response', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'sc-native-dialog-abort-'));
      const fixturePath = join(directory, 'main.cjs');
      const reportPath = join(directory, 'result.json');
      try {
        await writeFile(
          fixturePath,
          String.raw`
const { app, BrowserWindow, dialog } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
app.setPath('userData', __dirname);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const reportPath = join(__dirname, 'result.json');
const watchdog = setTimeout(() => {
  writeFileSync(reportPath, JSON.stringify({ error: 'Native dialog did not cancel' }));
  app.exit(2);
}, 8000);
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
  const parent = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true });
  let parentFocusEvents = 0;
  parent.on('focus', () => { parentFocusEvents += 1; });
  const controller = new AbortController();
  let settled = false;
  let pendingBeforeAbort = false;
  const answer = dialog.showMessageBox(parent, {
    type: 'warning',
    title: 'Native cancellation fixture',
    message: 'Isolated cancellation test; no action grants any permission.',
    buttons: ['Cancel', 'Fixture response'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal: controller.signal,
  }).then((result) => { settled = true; return result; });
  const abortTimer = setTimeout(() => {
    pendingBeforeAbort = !settled;
    controller.abort();
  }, 250);
  const result = await answer;
  clearTimeout(abortTimer);
  const report = {
    platform: process.platform,
    electron: process.versions.electron,
    pendingBeforeAbort,
    aborted: controller.signal.aborted,
    response: result.response,
    parentAlive: !parent.isDestroyed(),
    parentFocusEvents,
  };
  parent.destroy();
  writeFileSync(reportPath, JSON.stringify({ ...report, parentDestroyed: parent.isDestroyed() }));
  clearTimeout(watchdog);
  app.exit(0);
}).catch(() => {
  writeFileSync(reportPath, JSON.stringify({ error: 'Native dialog fixture failed' }));
  app.exit(3);
});
`,
        );
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        await promisify(execFile)(electronTestExecutablePath(), [fixturePath], {
          env: environment,
          timeout: 15_000,
        });
        const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
        expect(report).toMatchObject({
          platform: process.platform,
          electron: expect.any(String),
          pendingBeforeAbort: true,
          aborted: true,
          response: 0,
          parentAlive: true,
          parentDestroyed: true,
        });
        console.info('Native dialog abort evidence', report);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 20_000);
  },
);
