// Bounded waits and cleanup for the owned application started by the #387 unsigned-availability
// probe. Extracted from the harness so the failure paths that never reach a page or a CDP
// connection can be exercised without launching a real app.
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const EXPIRED = Symbol('deadline-expired');

/**
 * Await an already-started request under a Node-side deadline.
 *
 * Playwright's `evaluate()` carries no timeout of its own and the preload's `ipcRenderer.invoke()`
 * waits on Main without one either, so a Main or renderer that stops answering would park the
 * probe forever and never reach the cleanup below. Rejecting on the deadline hands control back to
 * the harness's catch/finally, which records the stage and reaps the owned app.
 */
export async function withDeadline(work, deadlineMs, label) {
  // Promise.race subscribes to `work`, so a rejection that arrives after the deadline is already
  // handled; the explicit catch keeps that true even if this stops racing the same promise.
  void Promise.resolve(work).catch(() => {});
  const settled = await Promise.race([work, delay(deadlineMs, EXPIRED, { ref: false })]);
  if (settled === EXPIRED) throw new Error(`Deadline exceeded: ${label}`);
  return settled;
}

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
  // One unreferenced budget for the whole normal-shutdown phase. An unresponsive Electron can
  // leave close() pending forever, and `.catch()` never settles such a request, so every close is
  // raced against this budget instead of awaited: the deadline and the forced termination after it
  // must start on time no matter what the app does. A pending timer never keeps the probe alive.
  const budget = Promise.race([exited, delay(normalCloseMs, null, { ref: false })]);

  let normalCloseAttempted = false;
  if (page && !page.isClosed()) {
    normalCloseAttempted = true;
    // Closing the owned page takes the normal BrowserWindow -> window-all-closed -> app.quit path.
    await Promise.race([page.close().catch(() => {}), budget]);
  }
  if (browser) await Promise.race([browser.close().catch(() => {}), budget]);

  const normalExit = await budget;
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
