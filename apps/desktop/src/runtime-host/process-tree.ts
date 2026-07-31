import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const GRACE_MS = 2_000;
const POLL_MS = 50;

/**
 * Terminates both the runtime process group and descendants that created their own process group.
 * Codex terminal commands can be re-parented into a PTY group, so a negative-PID signal alone is
 * insufficient. Capture descendants before signaling the root; otherwise they become invisible
 * after the root exits and is re-parented to launchd/init.
 */
export async function terminateRuntimeProcessTree(
  child: ChildProcessWithoutNullStreams,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return true;
  if (process.platform === 'win32') {
    if (childHasExited(child)) return true;
    signalWindowsTree(pid, 'SIGTERM', environment);
    await waitForExit(child, [], GRACE_MS);
    if (!childHasExited(child)) signalWindowsTree(pid, 'SIGKILL', environment);
    await waitForExit(child, [], GRACE_MS);
    return childHasExited(child);
  }

  const descendants = collectDescendantPids(pid);
  signalPosixTree(pid, descendants, 'SIGTERM');
  await waitForExit(child, descendants, GRACE_MS);
  const remaining = [...new Set([...descendants, ...collectDescendantPids(pid)])];
  if (!childHasExited(child) || remaining.some(processAlive)) {
    signalPosixTree(pid, remaining, 'SIGKILL');
    await waitForExit(child, remaining, GRACE_MS);
  }
  return childHasExited(child) && remaining.every((descendant) => !processAlive(descendant));
}

export function collectDescendantPids(rootPid: number): number[] {
  let output: string;
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2_000,
    });
  } catch {
    return [];
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

function signalWindowsTree(
  pid: number,
  signal: NodeJS.Signals,
  environment: NodeJS.ProcessEnv,
): void {
  spawn('taskkill', ['/pid', String(pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])], {
    env: environment,
    stdio: 'ignore',
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
  } catch {
    return false;
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
    (!childHasExited(child) || descendants.some((pid) => processAlive(pid)))
  )
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
