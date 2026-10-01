import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { spawnOwnedCliProcess, stopOwnedCliProcess } from './owned-cli-process';
const boundary = vi.hoisted(() => ({
  spawn: vi.fn(),
  assign: vi.fn(),
  count: vi.fn(),
  terminate: vi.fn(),
  close: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: boundary.spawn,
}));
vi.mock('../main/native-safe-fs', () => ({ nativeSafeFsAddonPath: () => 'owned-addon.node' }));
vi.mock('../main/windows-process-job', () => ({
  windowsJobWrapperCommand: () => 'node.exe',
  WINDOWS_JOB_WRAPPER: 'gated wrapper',
  assignProcessToOwnedJob: boundary.assign,
  ownedJobActiveProcesses: boundary.count,
  terminateRetainedOwnedJob: boundary.terminate,
  closeOwnedJob: boundary.close,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
function fixture() {
  const gate = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [null, null, null, gate],
    kill: vi.fn(),
  });
  child.on('error', () => undefined);
  boundary.spawn.mockReturnValue(child);
  boundary.count.mockReturnValue(1);
  boundary.terminate.mockReturnValue(true);
  boundary.close.mockReturnValue(true);
  return { child, gate, end: vi.spyOn(gate, 'end') };
}
it.runIf(process.platform === 'win32')(
  'assigns and binds identity before releasing CLI argv and environment',
  async () => {
    const { child, end } = fixture();
    const bind = vi.fn();
    const options = {
      cwd: 'workspace 日本語',
      env: { HOME: 'isolated home', CODEX_HOME: 'isolated codex', TEAM_BRIDGE_TOKEN: 'fixture' },
    };
    const owned = spawnOwnedCliProcess(
      'tool 日本語.exe',
      ['script with spaces', '--flag'],
      options,
      bind,
    );
    expect(end).not.toHaveBeenCalled();
    child.emit('spawn');
    expect(boundary.assign.mock.invocationCallOrder[0]).toBeLessThan(
      bind.mock.invocationCallOrder[0]!,
    );
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(end.mock.invocationCallOrder[0]!);
    expect(JSON.parse(String(end.mock.calls[0]?.[0]))).toEqual({
      executable: 'tool 日本語.exe',
      argv: ['script with spaces', '--flag'],
      nativeAddonPath: 'owned-addon.node',
      env: options.env,
      cwd: options.cwd,
    });
    expect(boundary.spawn.mock.calls[0]?.[2]).toMatchObject(options);
    const stopping = stopOwnedCliProcess(owned);
    boundary.count.mockReturnValue(0);
    expect(await stopping).toBe(true);
  },
);
it.runIf(process.platform === 'win32').each(['assign', 'identity', 'query'] as const)(
  'fails closed on %s startup failure',
  async (failure) => {
    const { child, end } = fixture();
    if (failure === 'assign')
      boundary.assign.mockImplementation(() => {
        throw new Error('assign failed');
      });
    if (failure === 'query')
      boundary.count.mockImplementation(() => {
        throw new Error('query failed');
      });
    const bind = vi.fn(() => failure !== 'identity');
    const owned = spawnOwnedCliProcess('tool.exe', [], {}, bind);
    child.emit('spawn');
    expect(end).not.toHaveBeenCalled();
    if (failure !== 'query') boundary.count.mockReturnValue(0);
    expect(await stopOwnedCliProcess(owned)).toBe(false);
    expect(child.kill).toHaveBeenCalledOnce();
  },
);
it.runIf(process.platform === 'win32')(
  'retains ownership while members drain, joins stop, and closes only at zero',
  async () => {
    vi.useFakeTimers();
    const { child } = fixture();
    const owned = spawnOwnedCliProcess('tool.exe', [], {}, vi.fn());
    child.emit('spawn');
    const stopping = stopOwnedCliProcess(owned);
    expect(stopOwnedCliProcess(owned)).toBe(stopping);
    await vi.advanceTimersByTimeAsync(100);
    expect(boundary.close).not.toHaveBeenCalled();
    boundary.count.mockReturnValue(0);
    await vi.advanceTimersByTimeAsync(25);
    expect(await stopping).toBe(true);
    expect(boundary.terminate).toHaveBeenCalledOnce();
    expect(boundary.close).toHaveBeenCalledOnce();
  },
);
it.runIf(process.platform === 'win32')(
  'does not confirm or close a nonempty Job at its bounded deadline',
  async () => {
    vi.useFakeTimers();
    const { child } = fixture();
    const owned = spawnOwnedCliProcess('tool.exe', [], {}, vi.fn());
    child.emit('spawn');
    const stopping = stopOwnedCliProcess(owned);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await stopping).toBe(false);
    expect(boundary.close).not.toHaveBeenCalled();
  },
);
it.runIf(process.platform === 'win32')(
  'cancel before spawn never opens the gate or publishes accepted',
  async () => {
    const { child, end } = fixture();
    const bind = vi.fn();
    const owned = spawnOwnedCliProcess('tool.exe', [], {}, bind);
    const stopping = stopOwnedCliProcess(owned);
    child.emit('spawn');
    boundary.count.mockReturnValue(0);
    expect(await stopping).toBe(true);
    expect(bind).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  },
);

it.runIf(process.platform === 'win32')(
  'cancel during identity binding also keeps the gate closed',
  async () => {
    const { child, end } = fixture();
    const owned = spawnOwnedCliProcess('tool.exe', [], {}, () => {
      void stopOwnedCliProcess(owned);
    });
    child.emit('spawn');
    boundary.count.mockReturnValue(0);
    expect(await stopOwnedCliProcess(owned)).toBe(true);
    expect(end).not.toHaveBeenCalled();
  },
);

it.runIf(process.platform === 'win32')(
  'parallel CLI Jobs keep distinct ownership and independent stop receipts',
  async () => {
    const first = fixture();
    const a = spawnOwnedCliProcess('a.exe', [], {}, vi.fn());
    first.child.emit('spawn');
    const second = fixture();
    const b = spawnOwnedCliProcess('b.exe', [], {}, vi.fn());
    second.child.emit('spawn');
    boundary.count.mockReturnValue(0);
    expect(await Promise.all([stopOwnedCliProcess(a), stopOwnedCliProcess(b)])).toEqual([
      true,
      true,
    ]);
    const ids = boundary.assign.mock.calls.map((call) => call[1]);
    expect(new Set(ids).size).toBe(2);
    expect(boundary.close.mock.calls.map((call) => call[0])).toEqual(ids);
  },
);

it.runIf(process.platform === 'win32')(
  'query failure during stop stays unconfirmed with ownership retained',
  async () => {
    const { child } = fixture();
    const owned = spawnOwnedCliProcess('tool.exe', [], {}, vi.fn());
    child.emit('spawn');
    boundary.count.mockImplementation(() => {
      throw new Error('missing Job or query failure');
    });
    expect(await stopOwnedCliProcess(owned)).toBe(false);
    expect(boundary.close).not.toHaveBeenCalled();
  },
);
