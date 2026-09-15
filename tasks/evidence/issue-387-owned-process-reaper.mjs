// Bounded cleanup for the owned application started by the #387 unsigned-availability probe.
// Extracted from the harness so the failure paths that never reach a page or a CDP connection can
// be exercised without launching a real app.
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

// Windows has no signals and the probe owns an Electron tree, so mirror tests/e2e/helpers.ts and
// terminate the exact owned tree with taskkill /T /F. Never target a PID after Node has observed
// the owned process exit: Windows may already have reused that number for something else.
export function killOwnedProcessTree(child, platform = process.platform) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32' && typeof child.pid === 'number') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch {
      // taskkill exits non-zero when the exact owned process already stopped.
    }
  }
  try {
    child.kill();
  } catch {
    // The owned process is already gone.
  }
}

/**
 * Always reap the owned application, on the success path and on every failure before it — a CDP
 * readiness timeout, a refused connectOverCDP, or a missing page all leave `page`/`browser`
 * undefined, so the normal close can never run and the app would otherwise outlive this probe.
 *
 * `normalExit` keeps its original meaning: the owned process exited on its own, within the close
 * deadline, with nothing killed. Anything that needed force is reported separately as
 * `forcedCleanup`/`forcedExit` so a terminated app is never read as a clean shutdown.
 */
export async function reapOwnedApp({
  child,
  exited,
  page,
  browser,
  normalCloseMs = 20_000,
  forcedExitMs = 10_000,
  kill = killOwnedProcessTree,
}) {
  let normalCloseAttempted = false;
  if (page && !page.isClosed()) {
    normalCloseAttempted = true;
    // Closing the owned page takes the normal BrowserWindow -> window-all-closed -> app.quit path.
    await page.close().catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});

  // Unreferenced deadlines: a pending timer must not be what keeps this probe alive.
  const normalExit = await Promise.race([exited, delay(normalCloseMs, null, { ref: false })]);
  if (normalExit)
    return {
      normalExit,
      normalCloseAttempted,
      forcedCleanup: false,
      forcedExit: null,
      reaped: true,
    };

  kill(child);
  const forcedExit = await Promise.race([exited, delay(forcedExitMs, null, { ref: false })]);
  // Whatever survives both deadlines is recorded as a leak rather than allowed to hang this probe.
  if (!forcedExit) child.unref?.();
  return {
    normalExit: null,
    normalCloseAttempted,
    forcedCleanup: true,
    forcedExit,
    reaped: Boolean(forcedExit),
  };
}
