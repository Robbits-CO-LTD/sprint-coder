import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const GRACE_MS = 2_000;
const POLL_MS = 50;
const TASKKILL_TIMEOUT_MS = 10_000;

export type RuntimeProcessTreeStopOptions = Readonly<{
  /**
   * Windows only: start the last wait after the forced taskkill has finished (bounded by
   * TASKKILL_TIMEOUT_MS) instead of right after spawning it. taskkill needs about a second on an
   * idle machine and longer under load, so the forced kill can land after a window counted from its
   * spawn has already closed, reporting a tree that does stop as unconfirmed (issue #665).
   */
  awaitTaskkill?: boolean;
}>;

/**
 * Terminates both the runtime process group and descendants that created their own process group.
 * Codex terminal commands can be re-parented into a PTY group, so a negative-PID signal alone is
 * insufficient. Capture descendants before signaling the root; otherwise they become invisible
 * after the root exits and is re-parented to launchd/init.
 * POSIX callers must have spawned this runtime detached, owning the group whose ID is child.pid.
 */
export async function terminateRuntimeProcessTree(
  child: ChildProcessWithoutNullStreams,
  environment: NodeJS.ProcessEnv,
  options: RuntimeProcessTreeStopOptions = {},
): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return true;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    if (childHasExited(child)) return true;
    void signalWindowsTree(pid, 'SIGTERM', environment);
    await waitForExit(child, [], GRACE_MS);
    if (!childHasExited(child))
      await signalWindowsTree(
        pid,
        'SIGKILL',
        environment,
        options.awaitTaskkill === true ? child : undefined,
      );
    await waitForExit(child, [], GRACE_MS);
    return childHasExited(child);
  }

  const initialSnapshot = collectDescendantPids(pid);
  const descendants = initialSnapshot ?? [];
  signalPosixTree(pid, descendants, 'SIGTERM');
  await waitForExit(child, descendants, GRACE_MS);
  const finalSnapshot = collectDescendantPids(pid);
  const remaining = [...new Set([...descendants, ...(finalSnapshot ?? [])])];
  if (!childHasExited(child) || processAlive(-pid) || remaining.some(processAlive)) {
    signalPosixTree(pid, remaining, 'SIGKILL');
    await waitForExit(child, remaining, GRACE_MS);
  }
  return (
    initialSnapshot !== undefined &&
    finalSnapshot !== undefined &&
    childHasExited(child) &&
    !processAlive(-pid) &&
    remaining.every((descendant) => !processAlive(descendant))
  );
}

export function collectDescendantPids(rootPid: number): number[] | undefined {
  let output: string;
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2_000,
    });
  } catch {
    // A failed snapshot is not evidence that the tree is empty.
    return undefined;
  }
  const children = new Map<number, number[]>();
  for (const line of output.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  const descendants: number[] = [];
  const visit = (parent: number): void => {
    for (const pid of children.get(parent) ?? []) {
      visit(pid);
      descendants.push(pid);
    }
  };
  visit(rootPid);
  return descendants;
}

function signalPosixTree(
  rootPid: number,
  descendants: readonly number[],
  signal: NodeJS.Signals,
): void {
  for (const pid of descendants) signalPid(pid, signal);
  try {
    process.kill(-rootPid, signal);
  } catch {
    signalPid(rootPid, signal);
  }
}

/** Settles right away unless `awaited` is given; then once taskkill has finished, failed to
 * start, or `awaited` has exited, and at the latest after TASKKILL_TIMEOUT_MS. */
function signalWindowsTree(
  pid: number,
  signal: NodeJS.Signals,
  environment: NodeJS.ProcessEnv,
  awaited?: ChildProcessWithoutNullStreams,
): Promise<void> {
  const taskkill = spawn(
    'taskkill',
    ['/pid', String(pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])],
    { env: environment, stdio: 'ignore', windowsHide: true },
  );
  if (awaited === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      taskkill.off('exit', settle);
      taskkill.off('error', settle);
      awaited.off('exit', settle);
      resolve();
    };
    const timer = setTimeout(settle, TASKKILL_TIMEOUT_MS);
    taskkill.once('exit', settle);
    taskkill.once('error', settle);
    awaited.once('exit', settle);
  });
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // It may have exited between the process snapshot and signal delivery.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still means the process/group exists. Unknown probe failures cannot confirm exit.
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  descendants: readonly number[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (
    Date.now() < deadline &&
    (!childHasExited(child) ||
      (process.platform !== 'win32' && child.pid !== undefined && processAlive(-child.pid)) ||
      descendants.some((pid) => processAlive(pid)))
  )
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
