// Windows-only, opt-in diagnostic: invoke the real preload API in an unchanged packaged app.
// No fixtures, raw IPC envelopes, input actions, screenshots, or console forwarding.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import console from 'node:console';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { reapOwnedApp, withDeadline } from './issue-387-owned-process-reaper.mjs';

const [appRootArgument, profileArgument, dependencyRoot, outputArgument] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(process.versions.node.startsWith('22.'));
assert.ok(appRootArgument && profileArgument && dependencyRoot && outputArgument);
const appRoot = resolve(appRootArgument);
const profile = resolve(profileArgument);
const output = resolve(outputArgument);
assert.ok(!existsSync(profile), 'Profile must be new');
assert.ok(!existsSync(output), 'Evidence must be new');
const executable = join(appRoot, 'Sprint Coder.exe');
const require = createRequire(join(resolve(dependencyRoot), 'package.json'));
const { chromium } = require('playwright');
const { getCurrentFuseWire } = require('@electron/fuses');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function packageSnapshot() {
  const files = [];
  const visit = (relative) => {
    for (const entry of readdirSync(join(appRoot, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Unexpected package link');
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        files.push([name.replaceAll('\\', '/'), digest(readFileSync(join(appRoot, name)))]);
      else assert.fail('Unexpected package entry');
    }
  };
  visit('');
  files.sort(([a], [b]) => a.localeCompare(b, 'en'));
  return { fileCount: files.length, treeSha256: digest(JSON.stringify(files)) };
}

const manifest = JSON.parse(
  readFileSync(join(appRoot, 'resources', 'computer-use-native.manifest.json'), 'utf8'),
);
assert.equal(manifest.sourceCommit, '5b20208eb7b4f7697105dca2bf9436da3aeec910');
assert.equal(manifest.signerDigest, null);
assert.equal(manifest.platform, 'win32');
assert.equal(manifest.architecture, 'x64');
const report = {
  scope: 'unsigned-package-availability-only',
  status: 'FAIL',
  sourceCommit: manifest.sourceCommit,
  featureOptIn: true,
  nativeInputAttempted: false,
  fuseChanges: [],
  packageBefore: packageSnapshot(),
  fusesBefore: await getCurrentFuseWire(executable),
};
mkdirSync(profile);
const server = createServer();
await new Promise((done, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', done);
});
const port = server.address().port;
await new Promise((done) => server.close(done));
let stage = 'launch';
let browser;
let page;
const child = spawn(
  executable,
  [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  {
    cwd: appRoot,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      SPRINT_CODER_USER_DATA_DIR: profile,
      SPRINT_CODER_SKILL_HOME: profile,
      SPRINT_CODER_RUNTIME_ADOPT: '0',
      SPRINT_CODER_E2E_BACKGROUND: '1',
      SPRINT_CODER_COMPUTER_USE_DESKTOP_V1: '1',
    },
  },
);
report.ownedMainPid = child.pid;
const exited = new Promise((done) => {
  child.once('exit', (code, signal) => done({ code, signal }));
  child.once('error', () => done({ code: null, signal: 'spawn_error' }));
});
try {
  stage = 'chromium-connection';
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await globalThis.fetch(`${endpoint}/json/version`, {
        signal: globalThis.AbortSignal.timeout(500),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Only readiness is retained; no target URLs or page contents are logged. */
    }
    if (child.exitCode !== null) break;
    await delay(250);
  }
  assert.ok(ready, 'Chromium endpoint unavailable');
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
  stage = 'preload-ready';
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 15000 }));
  await page.waitForFunction(
    () => typeof globalThis.sprintCoder?.computerUse?.availability === 'function',
    null,
    { timeout: 15000 },
  );
  stage = 'official-preload-availability';
  // Two cheap preload round trips, but evaluate() has no timeout and neither does the
  // ipcRenderer.invoke() behind it, so bound them on the Node side with the same 15s the
  // preload-readiness waits above use. Exceeding it throws into the cleanup instead of hanging.
  const observed = await withDeadline(
    page.evaluate(async () => {
      const info = await globalThis.sprintCoder.app.getInfo();
      const availability = await globalThis.sprintCoder.computerUse.availability();
      return { version: info.version, platform: info.platform, availability };
    }),
    15000,
    stage,
  );
  report.observed = observed;
  assert.equal(observed.version, '0.7.0-beta.3');
  assert.equal(observed.platform, 'win32');
  assert.deepEqual(observed.availability, {
    platform: 'win32',
    state: 'unsigned_package',
    featureEnabled: true,
    packageReady: false,
    handshakeReady: false,
    observe: false,
    control: false,
    available: false,
    reasonCode: 'windows_signature_required',
    manifestDigest: null,
  });
  report.status = 'PASS';
} catch {
  report.failureStage = stage;
} finally {
  // Reaching this block without a page (CDP readiness timeout, refused connection) still owns a
  // running app, so the cleanup is bounded and always ends with the owned process accounted for.
  const cleanup = await reapOwnedApp({ child, exited, page, browser });
  report.normalExit = cleanup.normalExit;
  report.normalCloseAttempted = cleanup.normalCloseAttempted;
  report.forcedCleanup = cleanup.forcedCleanup;
  report.forcedExit = cleanup.forcedExit;
  report.ownedProcessReaped = cleanup.reaped;
  report.packageAfter = packageSnapshot();
  report.fusesAfter = await getCurrentFuseWire(executable);
  report.packageUnchanged =
    JSON.stringify(report.packageBefore) === JSON.stringify(report.packageAfter);
  report.fusesUnchanged = JSON.stringify(report.fusesBefore) === JSON.stringify(report.fusesAfter);
  if (report.normalExit?.code !== 0 || !report.packageUnchanged || !report.fusesUnchanged)
    report.status = 'FAIL';
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
