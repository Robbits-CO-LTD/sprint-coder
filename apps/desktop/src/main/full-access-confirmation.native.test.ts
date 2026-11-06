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
    it.each([
      'hidden',
      'visible',
      'visible-focusable',
      ...(process.platform === 'darwin' ? ['stalled'] : []),
    ])(
      'keeps a %s parent alive until and after native cancellation',
      async (visibility) => {
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
// execFile owns the deadline outside this UI thread. An in-process app.exit watchdog can
// destroy the parent and then have its failure overwritten by the queued sheet completion.
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
  const parent = new BrowserWindow({ show: false, focusable: ${JSON.stringify(visibility === 'visible-focusable')}, skipTaskbar: true });
  const lifecycle = [];
  for (const event of ['close', 'closed', 'show', 'hide'])
    parent.on(event, () => lifecycle.push({ event, elapsed: performance.now() }));
  const visible = ${JSON.stringify(visibility.startsWith('visible'))};
  if (visible) parent.showInactive();
  let parentFocusEvents = 0;
  parent.on('focus', () => { parentFocusEvents += 1; });
  const controller = new AbortController();
  let settled = false;
  let pendingBeforeAbort = false;
  let parentAliveBeforeAbort = false;
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
    parentAliveBeforeAbort = !parent.isDestroyed();
    controller.abort();
  }, 250);
  // Both timers are overdue on a busy native UI thread. The fixture's old app.exit watchdog
  // destroyed the parent before the queued sheet completion and its report then hid that exit.
  if (${JSON.stringify(visibility === 'stalled')}) {
    const until = performance.now() + 8100;
    while (performance.now() < until) {}
  }
  const result = await answer;
  clearTimeout(abortTimer);
  const report = {
    platform: process.platform,
    electron: process.versions.electron,
    pendingBeforeAbort,
    aborted: controller.signal.aborted,
    response: result.response,
    parentAlive: !parent.isDestroyed(),
    parentAliveBeforeAbort,
    visible,
    lifecycle: lifecycle.slice(),
    parentFocusEvents,
  };
  parent.destroy();
  writeFileSync(reportPath, JSON.stringify({ ...report, parentDestroyed: parent.isDestroyed() }));
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
          // Retain phase evidence even when CI catches the intermittent parent loss (#1137).
          console.info('Native dialog abort evidence', report);
          expect(report).toMatchObject({
            platform: process.platform,
            electron: expect.any(String),
            pendingBeforeAbort: true,
            aborted: true,
            response: 0,
            parentAlive: true,
            parentAliveBeforeAbort: true,
            visible: visibility.startsWith('visible'),
            parentDestroyed: true,
          });
        } finally {
          await rm(directory, {
            recursive: true,
            force: true,
            maxRetries: process.platform === 'win32' ? 5 : 0,
            retryDelay: 100,
          });
        }
      },
      20_000,
    );
  },
);
