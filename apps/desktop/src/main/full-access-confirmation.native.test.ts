import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';

// macOS CI has started this Electron fixture in 1 to 8 seconds, and once stalled two runs for
// about 40 seconds (#1137). Startup is not what this test proves, so it gets its own budget. The
// native contract (sheet shown, abort, cancel response, parent alive) is timed from app ready.
const STARTUP_DEADLINE_MS = 60_000;
const NATIVE_DEADLINE_MS = 15_000;
const STDERR_GRACE_MS = 500;

interface ProgressEntry {
  readonly phase: string;
  readonly elapsed?: number;
  readonly [key: string]: unknown;
}

interface FixtureRun {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Which budget killed the fixture, or null when it exited by itself. */
  readonly deadline: 'startup' | 'native' | null;
  readonly elapsedMs: number;
  readonly stderrTail: string;
}

function readProgress(path: string): ProgressEntry[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries: ProgressEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      entries.push(JSON.parse(line) as ProgressEntry);
    } catch {
      entries.push({ phase: 'unparsed', line });
    }
  }
  return entries;
}

/**
 * Runs the fixture and kills it with SIGKILL when a budget expires. A graceful SIGTERM would let
 * Electron quit, close the parent, end the sheet with its cancel response and report that as a
 * normal finish: the same masking the old in-process app.exit watchdog caused (#1137).
 */
function runFixture(fixturePath: string, progressPath: string): Promise<FixtureRun> {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const started = performance.now();
  const child = spawn(electronTestExecutablePath(), [fixturePath], {
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-8192);
  });
  return new Promise((resolve, reject) => {
    let deadline: FixtureRun['deadline'] = null;
    let nativeTimer: NodeJS.Timeout | undefined;
    const kill = (budget: 'startup' | 'native'): void => {
      deadline = budget;
      child.kill('SIGKILL');
    };
    const startupTimer = setTimeout(() => kill('startup'), STARTUP_DEADLINE_MS);
    const readyPoll = setInterval(() => {
      if (!readProgress(progressPath).some((entry) => entry.phase === 'ready')) return;
      clearInterval(readyPoll);
      clearTimeout(startupTimer);
      nativeTimer = setTimeout(() => kill('native'), NATIVE_DEADLINE_MS);
    }, 100);
    const stopTimers = (): void => {
      clearTimeout(startupTimer);
      clearInterval(readyPoll);
      clearTimeout(nativeTimer);
    };
    child.once('error', (error) => {
      stopTimers();
      reject(error);
    });
    child.once('exit', (exitCode, signal) => {
      stopTimers();
      const elapsedMs = Math.round(performance.now() - started);
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        resolve({ exitCode, signal, deadline, elapsedMs, stderrTail });
      };
      // Electron helper processes can keep the inherited stderr open after the main one exits.
      if (child.stderr.readableEnded) {
        finish();
        return;
      }
      const grace = setTimeout(finish, STDERR_GRACE_MS);
      child.stderr.once('end', () => {
        clearTimeout(grace);
        finish();
      });
    });
  });
}

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
        const progressPath = join(directory, 'progress.jsonl');
        try {
          await writeFile(
            fixturePath,
            String.raw`
const { app, BrowserWindow, dialog } = require('electron');
const { appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const reportPath = join(__dirname, 'result.json');
const progressPath = join(__dirname, 'progress.jsonl');
// Each phase is flushed synchronously, so a stalled or killed run still shows how far it got.
const mark = (phase, detail) => appendFileSync(progressPath,
  JSON.stringify({ phase, elapsed: Math.round(performance.now()), at: Date.now(), ...detail }) + '\n');
mark('script');
app.setPath('userData', __dirname);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
// An app quit closes every window and ends the sheet with its cancel response. Record it, so a
// parent lost to shutdown is not mistaken for one lost to the AbortSignal cancellation.
const lifecycle = [];
const record = (source, event) => {
  const entry = { source, event, elapsed: Math.round(performance.now()) };
  lifecycle.push(entry);
  mark('lifecycle', entry);
};
for (const event of ['before-quit', 'will-quit', 'quit']) app.on(event, () => record('app', event));
// The runner outside this UI thread owns every deadline. An in-process app.exit watchdog can
// destroy the parent and then have its failure overwritten by the queued sheet completion.
app.whenReady().then(async () => {
  mark('ready');
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
  const parent = new BrowserWindow({ show: false, focusable: ${JSON.stringify(visibility === 'visible-focusable')}, skipTaskbar: true });
  for (const event of ['close', 'closed', 'show', 'hide'])
    parent.on(event, () => record('parent', event));
  const visible = ${JSON.stringify(visibility.startsWith('visible'))};
  if (visible) parent.showInactive();
  mark('parent-ready', { visible, parentVisible: parent.isVisible() });
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
  mark('dialog-requested');
  const abortTimer = setTimeout(() => {
    pendingBeforeAbort = !settled;
    parentAliveBeforeAbort = !parent.isDestroyed();
    mark('abort-requested', { pendingBeforeAbort, parentAliveBeforeAbort });
    controller.abort();
    mark('abort-returned', { parentAlive: !parent.isDestroyed() });
  }, 250);
  // Both timers are overdue on a busy native UI thread. The fixture's old app.exit watchdog
  // destroyed the parent before the queued sheet completion and its report then hid that exit.
  if (${JSON.stringify(visibility === 'stalled')}) {
    const until = performance.now() + 8100;
    while (performance.now() < until) {}
    mark('stall-ended');
  }
  const result = await answer;
  clearTimeout(abortTimer);
  const parentAlive = !parent.isDestroyed();
  const quitBeforeAnswer = lifecycle.some((entry) => entry.source === 'app');
  mark('answer', { response: result.response, parentAlive, quitBeforeAnswer });
  const report = {
    platform: process.platform,
    electron: process.versions.electron,
    pendingBeforeAbort,
    aborted: controller.signal.aborted,
    response: result.response,
    parentAlive,
    parentAliveBeforeAbort,
    quitBeforeAnswer,
    visible,
    lifecycle: lifecycle.slice(),
    parentFocusEvents,
  };
  parent.destroy();
  writeFileSync(reportPath, JSON.stringify({ ...report, parentDestroyed: parent.isDestroyed() }));
  mark('report-written');
  app.exit(0);
}).catch((error) => {
  mark('failed', { error: String(error && error.stack || error) });
  writeFileSync(reportPath, JSON.stringify({ error: 'Native dialog fixture failed' }));
  app.exit(3);
});
`,
          );
          const run = await runFixture(fixturePath, progressPath);
          const progress = readProgress(progressPath);
          let report: unknown;
          try {
            report = JSON.parse(await readFile(reportPath, 'utf8'));
          } catch {
            report = undefined;
          }
          const evidence = { visibility, run, progress, report };
          // Retain phase evidence even when CI catches the intermittent parent loss (#1137).
          console.info('Native dialog abort evidence', JSON.stringify(evidence, null, 2));
          if (run.deadline !== null || run.exitCode !== 0 || report === undefined)
            throw new Error(
              `Native dialog fixture did not finish by itself: ${JSON.stringify(evidence)}`,
            );
          expect(report).toMatchObject({
            platform: process.platform,
            electron: expect.any(String),
            pendingBeforeAbort: true,
            aborted: true,
            response: 0,
            parentAlive: true,
            parentAliveBeforeAbort: true,
            quitBeforeAnswer: false,
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
      STARTUP_DEADLINE_MS + NATIVE_DEADLINE_MS + 5_000,
    );
  },
);
