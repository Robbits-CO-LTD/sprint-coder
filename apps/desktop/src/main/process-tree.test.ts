import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree, processAlive } from './process-tree';

const isWin32 = process.platform === 'win32';

describe.skipIf(isWin32)('process-tree', () => {
  it('kills a detached process tree started with its own process group', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = requirePid(child);
    await waitUntil(() => processAlive(pid));

    await killProcessTree(pid, { graceMs: 500 });

    expect(processAlive(pid)).toBe(false);
  });

  it('kills grandchild processes along with the tree', async () => {
    const script =
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);" +
      "process.stdout.write(String(c.pid)+'\\n');" +
      'setInterval(() => {}, 1000)';
    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parentPid = requirePid(child);
    const grandchildPid = await readPidFromStdout(child);
    await waitUntil(() => processAlive(parentPid) && processAlive(grandchildPid));

    await killProcessTree(parentPid, { graceMs: 500 });

    expect(processAlive(parentPid)).toBe(false);
    expect(processAlive(grandchildPid)).toBe(false);
  });

  it('resolves without throwing when the target has already exited', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = requirePid(child);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    await expect(killProcessTree(pid, { graceMs: 100 })).resolves.toBeUndefined();
  });
});

function requirePid(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error('failed to spawn test process: missing pid');
  return child.pid;
}

function readPidFromStdout(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for grandchild pid')),
      2_000,
    );
    child.stdout?.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(Number.parseInt(chunk.toString().trim(), 10));
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met before timeout');
}
