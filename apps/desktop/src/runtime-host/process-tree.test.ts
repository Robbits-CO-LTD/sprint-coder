import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminateRuntimeProcessTree } from './process-tree';

type TaskkillMode =
  { kind: 'real'; delayMs: number } | { kind: 'hang' } | { kind: 'noop'; exitAfterMs: number };

const mocks = vi.hoisted(() => ({
  actual: undefined as typeof childProcess | undefined,
  taskkill: { kind: 'real', delayMs: 0 } as TaskkillMode,
  taskkillCalls: [] as string[][],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  mocks.actual = actual;
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      if (command !== 'taskkill') return actual.spawn(command, args, options);
      mocks.taskkillCalls.push([...args]);
      // Only the caller-visible lifecycle of taskkill is modelled: when it exits and whether it
      // acted. The process under test stays a real OS process where a test needs one.
      const proxy = new EventEmitter();
      const mode = mocks.taskkill;
      if (mode.kind === 'real')
        setTimeout(() => {
          const real = actual.spawn(command, args, options);
          real.once('error', (error) => proxy.emit('error', error));
          real.once('exit', (code, signal) => proxy.emit('exit', code, signal));
        }, mode.delayMs);
      else if (mode.kind === 'noop')
        setTimeout(() => proxy.emit('exit', 0, null), mode.exitAfterMs);
      return proxy;
    },
  };
});

const started: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  vi.useRealTimers();
  mocks.taskkill = { kind: 'real', delayMs: 0 };
  mocks.taskkillCalls.length = 0;
  for (const child of started.splice(0)) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
    mocks.actual!.spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
});

/** A console root that never exits on its own and owns a grandchild, like grok.exe and its Team
 * MCP node server. */
async function startRealTree(): Promise<ChildProcessWithoutNullStreams> {
  const child = mocks.actual!.spawn(
    process.execPath,
    [
      '-e',
      "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); console.log('ready'); setInterval(() => {}, 1000);",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  started.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve());
  });
  return child;
}

function fakeRoot(): ChildProcessWithoutNullStreams {
  return Object.assign(new ChildProcess(), { pid: 424_242 }) as ChildProcessWithoutNullStreams;
}

function asWindows(): () => void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  return () => Object.defineProperty(process, 'platform', platform);
}

describe.runIf(process.platform === 'win32')(
  'Windows runtime process-tree stop (real processes)',
  () => {
    it('confirms a tree whose taskkill takes effect later than the fixed grace windows (issue #665)', async () => {
      // taskkill needs about a second on an idle machine and more under load. Delaying it here
      // stands in for a loaded machine: the forced kill lands after the old 2s + 2s windows.
      mocks.taskkill = { kind: 'real', delayMs: 2_500 };
      const child = await startRealTree();
      const startedAt = Date.now();
      const stopped = await terminateRuntimeProcessTree(child, process.env, {
        awaitTaskkill: true,
      });
      const elapsed = Date.now() - startedAt;
      expect({ stopped, exited: child.exitCode !== null || child.signalCode !== null }).toEqual({
        stopped: true,
        exited: true,
      });
      expect(elapsed).toBeGreaterThan(4_000);
      expect(mocks.taskkillCalls.at(-1)).toEqual(['/pid', String(child.pid), '/t', '/f']);
    }, 30_000);
  },
);

describe('Windows runtime process-tree stop bounds', () => {
  it('still reports an unconfirmed stop, within a finite bound, when taskkill never finishes', async () => {
    const restore = asWindows();
    try {
      vi.useFakeTimers();
      mocks.taskkill = { kind: 'hang' };
      const root = fakeRoot();
      let result: boolean | undefined;
      void terminateRuntimeProcessTree(root, {}, { awaitTaskkill: true }).then((stopped) => {
        result = stopped;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(result).toBe(false);
      expect(mocks.taskkillCalls.map((args) => args.includes('/f'))).toEqual([false, true]);
    } finally {
      restore();
    }
  });

  it('still reports an unconfirmed stop when taskkill finishes but the root never exits', async () => {
    const restore = asWindows();
    try {
      vi.useFakeTimers();
      mocks.taskkill = { kind: 'noop', exitAfterMs: 1_000 };
      const root = fakeRoot();
      let result: boolean | undefined;
      void terminateRuntimeProcessTree(root, {}, { awaitTaskkill: true }).then((stopped) => {
        result = stopped;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(result).toBe(false);
    } finally {
      restore();
    }
  });

  it('confirms once the root exits after the forced taskkill finishes', async () => {
    const restore = asWindows();
    try {
      vi.useFakeTimers();
      mocks.taskkill = { kind: 'noop', exitAfterMs: 3_000 };
      const root = fakeRoot();
      let result: boolean | undefined;
      void terminateRuntimeProcessTree(root, {}, { awaitTaskkill: true }).then((stopped) => {
        result = stopped;
      });
      // The forced taskkill starts after the 2s grace and finishes at 5s, past the old 4s bound.
      await vi.advanceTimersByTimeAsync(5_100);
      expect(result).toBeUndefined();
      Object.assign(root, { exitCode: 1 });
      root.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(100);
      expect(result).toBe(true);
    } finally {
      restore();
    }
  });
});
