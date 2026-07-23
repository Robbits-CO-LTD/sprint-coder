import { execFile } from 'node:child_process';

// Independent process-tree termination utility for Team stop-all. This intentionally
// re-implements the same POSIX process-group / Windows taskkill strategy that
// command-runner.ts uses internally (signalOwnedTree / forceOwnedTree / runTaskkill /
// ownedTreeAlive), but as a standalone module with no import of command-runner.ts, so the
// hardened command-runner execution path is never touched by this feature.

const DEFAULT_GRACE_MS = 2_000;
const POLL_INTERVAL_MS = 50;

export type KillProcessTreeOptions = Readonly<{
  graceMs?: number;
  now?: () => number;
}>;

/**
 * Returns whether a process is (still) alive. Uses the signal-0 probe: sending signal 0
 * does not actually deliver a signal, it only performs the existence/permission check.
 * EPERM means the process exists but is owned by someone else, which we treat as "alive".
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Terminates a process tree rooted at `pid`. `pid` must be the pid of a detached child
 * (its own process group leader on POSIX). Sends a graceful signal first, waits up to
 * `graceMs` for the tree to exit, then force-kills anything still alive.
 *
 * Already-dead processes are treated as success (nothing to do), not an error.
 */
export async function killProcessTree(
  pid: number,
  { graceMs = DEFAULT_GRACE_MS, now = Date.now }: KillProcessTreeOptions = {},
): Promise<void> {
  if (process.platform === 'win32') {
    await killProcessTreeWindows(pid, graceMs, now);
    return;
  }
  await killProcessTreePosix(pid, graceMs, now);
}

async function killProcessTreePosix(
  pid: number,
  graceMs: number,
  now: () => number,
): Promise<void> {
  const outcome = signalWithGroupFallback(pid, 'SIGTERM', true);
  if (outcome === 'dead') return;
  await waitForExit(pid, graceMs, now);
  if (!processAlive(pid)) return;
  signalWithGroupFallback(pid, 'SIGKILL', outcome === 'group');
}

type SignalOutcome = 'group' | 'single' | 'dead';

/**
 * Sends `signal` to the process group led by `pid` (negative pid). If the group send
 * fails with ESRCH (no such process group), falls back to signalling the pid directly.
 * If that also fails with ESRCH, the target is already gone, which is success.
 * Any other error is rethrown (fail loud, do not silently ignore permission errors etc).
 */
function signalWithGroupFallback(
  pid: number,
  signal: NodeJS.Signals,
  preferGroup: boolean,
): SignalOutcome {
  if (preferGroup) {
    try {
      process.kill(-pid, signal);
      return 'group';
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ESRCH') throw error;
    }
  }
  try {
    process.kill(pid, signal);
    return 'single';
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') return 'dead';
    throw error;
  }
}

async function killProcessTreeWindows(
  pid: number,
  graceMs: number,
  now: () => number,
): Promise<void> {
  await runTaskkill(pid, false);
  await waitForExit(pid, graceMs, now);
  if (!processAlive(pid)) return;
  await runTaskkill(pid, true);
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  try {
    await execFileAsync('taskkill.exe', args, { windowsHide: true });
  } catch (error) {
    // taskkill exits non-zero (and writes "not found") once the tree is already gone.
    // Treat that as success rather than parsing locale-dependent stderr text.
    if (!processAlive(pid)) return;
    throw error;
  }
}

function execFileAsync(
  file: string,
  args: readonly string[],
  options: Readonly<{ windowsHide: boolean }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args as string[], options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForExit(pid: number, graceMs: number, now: () => number): Promise<void> {
  const deadline = now() + graceMs;
  while (processAlive(pid) && now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
