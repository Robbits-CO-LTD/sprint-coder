import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { terminateRuntimeProcessTree } from './process-tree';

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  execFileSync: mocks.snapshot,
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const rootPid = 424_242;
const descendantPid = 424_243;
const missing = () => Object.assign(new Error('gone'), { code: 'ESRCH' });

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  vi.useFakeTimers();
  mocks.snapshot.mockReset().mockReturnValue(`${descendantPid} ${rootPid}\n`);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platform);
});

function exitedRoot(): ChildProcessWithoutNullStreams {
  return Object.assign(new ChildProcess(), {
    pid: rootPid,
    exitCode: 0,
  }) as ChildProcessWithoutNullStreams;
}
async function stop(): Promise<boolean> {
  const result = terminateRuntimeProcessTree(exitedRoot(), {});
  await vi.advanceTimersByTimeAsync(5_000);
  return result;
}

it.each([0, -1, Number.NaN])(
  'rejects an invalid root PID %s without signals or probes',
  async (pid) => {
    const kill = vi.spyOn(process, 'kill');
    const root = Object.assign(exitedRoot(), { pid });
    expect(await terminateRuntimeProcessTree(root, {})).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  },
);

it.each(['EPERM', 'EIO', undefined])(
  'does not confirm a descendant with probe failure %s',
  async (code) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === descendantPid) throw Object.assign(new Error('unconfirmed'), { code });
      throw missing();
    });
    expect(await stop()).toBe(false);
    expect(kill).toHaveBeenCalledWith(descendantPid, 'SIGKILL');
  },
);

it('confirms descendants and the original group only when probes report ESRCH', async () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw missing();
  });
  expect(await stop()).toBe(true);
});

it('does not interpret a failed process snapshot as an empty tree', async () => {
  mocks.snapshot.mockImplementation(() => {
    throw new Error('snapshot unavailable');
  });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw missing();
  });
  expect(await stop()).toBe(false);
});

it('escalates the surviving original process group after root exit', async () => {
  mocks.snapshot.mockReturnValue('');
  let groupAlive = true;
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -rootPid && signal === 'SIGKILL') groupAlive = false;
    if (pid === -rootPid && groupAlive) return true;
    throw missing();
  });
  expect(await stop()).toBe(true);
  expect(kill).toHaveBeenCalledWith(-rootPid, 'SIGKILL');
});

it('keeps a surviving original group unconfirmed even with no visible descendants', async () => {
  mocks.snapshot.mockReturnValue('');
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === -rootPid) return true;
    throw missing();
  });
  expect(await stop()).toBe(false);
});
