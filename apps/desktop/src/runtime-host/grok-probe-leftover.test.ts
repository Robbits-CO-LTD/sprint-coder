import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as childProcess from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GrokProbeLeftovers, probeGrok } from './grok-adapter';
import { prepareGrokIsolation } from './grok-isolation';
import type * as resolution from './cli-command-resolution';
import type * as worktree from '../main/worker-worktree';

// No OS process is started and no real Grok home, auth file or %TEMP% entry is touched: spawn and
// the process-tree stop are replaced, and the temporary directory is redirected to a test root.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  stop: vi.fn<() => Promise<boolean>>(),
  removeTree: vi.fn<(root: string) => Promise<void>>(),
  realRemoveTree: null as ((root: string) => Promise<void>) | null,
  cli: {
    executable: '/fixture/grok',
    source: 'explicit' as const,
    version: 'grok 1.0.40',
    compatibility: 'compatible' as const,
    capabilities: ['acp'],
  },
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: mocks.spawn,
}));
vi.mock('./process-tree', () => ({ terminateRuntimeProcessTree: mocks.stop }));
vi.mock('./cli-command-resolution', async (original) => ({
  ...(await original<typeof resolution>()),
  probeCliCommandCandidates: vi.fn(async () => mocks.cli),
}));
// The real link-safe removal still runs; the spy only shows which removal ran. The Node that
// vitest uses does not follow a junction in a recursive rmSync either, unlike Electron's (#582).
vi.mock('../main/worker-worktree', async (original) => {
  const actual = await original<typeof worktree>();
  mocks.realRemoveTree = (root) => actual.removeTreeWithoutFollowingLinks(root);
  return { ...actual, removeTreeWithoutFollowingLinks: mocks.removeTree };
});

let root = '';
let source: NodeJS.ProcessEnv = {};
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sprint-coder-probe-leftover-test-'));
  vi.stubEnv('TEMP', root);
  vi.stubEnv('TMP', root);
  vi.stubEnv('TMPDIR', root);
  source = {
    HOME: join(root, 'user-home'),
    USERPROFILE: join(root, 'user-home'),
    GROK_AUTH_PATH: join(root, 'auth-fixture.json'),
  };
  mocks.spawn.mockReset();
  mocks.stop.mockReset();
  mocks.removeTree.mockReset();
  mocks.removeTree.mockImplementation((directory) => mocks.realRemoveTree!(directory));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** A spawned probe CLI that answers initialize and authenticate like the official ACP agent. */
function fakeProbeCli(authMethods: readonly string[]): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null],
  }) as ChildProcessWithoutNullStreams;
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>;
    const result =
      request['method'] === 'initialize'
        ? {
            _meta: {
              grokShell: true,
              modelState: { availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] },
            },
            authMethods: authMethods.map((id) => ({ id })),
          }
        : {};
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request['id'], result }) + '\n');
  });
  children.push(child);
  mocks.spawn.mockReturnValueOnce(child);
  return child;
}

function grokDirectories(): string[] {
  return readdirSync(root).filter((name) => name.startsWith('sprint-coder-grok-'));
}

function exitChild(child: ChildProcessWithoutNullStreams): void {
  Object.assign(child, { exitCode: 0 });
  child.emit('exit', 0, null);
}

describe('Grok capability probe whose CLI exit is not confirmed (issue #581)', () => {
  it.each([
    [['cached_token'], 'ready'],
    [[], 'authentication_required'],
  ] as const)(
    'keeps the initialize/authenticate result (%j -> %s) and remembers only its own isolation',
    async (authMethods, readiness) => {
      const leftovers = new GrokProbeLeftovers();
      fakeProbeCli(authMethods);
      mocks.stop.mockResolvedValue(false);
      const probe = await probeGrok('/fixture/grok', source, leftovers);
      expect(probe).toMatchObject({
        available: true,
        readiness,
        cli: mocks.cli,
        stopUnconfirmed: true,
      });
      expect(probe.models.map(({ id }) => id)).toEqual(['auto', 'grok-4.7']);
      // The unconfirmed CLI's isolation is not removed while it may still be running.
      expect(grokDirectories()).toHaveLength(1);
      expect(leftovers.size).toBe(1);
    },
  );

  it('reports no stop uncertainty and leaves nothing behind when the exit is confirmed', async () => {
    const leftovers = new GrokProbeLeftovers();
    fakeProbeCli(['cached_token']);
    mocks.stop.mockResolvedValue(true);
    const probe = await probeGrok('/fixture/grok', source, leftovers);
    expect(probe.readiness).toBe('ready');
    expect(probe).not.toHaveProperty('stopUnconfirmed');
    expect(grokDirectories()).toEqual([]);
    expect(leftovers.size).toBe(0);
  });

  it('removes the leftover at a later detection once its stop is confirmed, and nothing else', async () => {
    const leftovers = new GrokProbeLeftovers();
    fakeProbeCli(['cached_token']);
    mocks.stop.mockResolvedValue(false);
    await probeGrok('/fixture/grok', source, leftovers);
    const [leftover] = grokDirectories();
    // Same prefix, same temporary directory: another app instance's probe and a running Turn.
    const otherInstance = join(root, 'sprint-coder-grok-other-instance');
    mkdirSync(join(otherInstance, 'home', '.grok'), { recursive: true });
    writeFileSync(join(otherInstance, 'home', '.grok', '.config-init.lock'), '');
    const runningTurn = prepareGrokIsolation(source).directory;

    // A later detection whose own probe CLI stops normally. Nothing else asks for a reclaim.
    fakeProbeCli(['cached_token']);
    mocks.stop.mockResolvedValue(true);
    await expect(probeGrok('/fixture/grok', source, leftovers)).resolves.toMatchObject({
      readiness: 'ready',
    });
    await vi.waitFor(() => expect(leftovers.size).toBe(0));

    expect(existsSync(join(root, leftover!))).toBe(false);
    expect(existsSync(join(otherInstance, 'home', '.grok', '.config-init.lock'))).toBe(true);
    expect(existsSync(runningTurn)).toBe(true);
    expect(grokDirectories().sort()).toEqual(
      ['sprint-coder-grok-other-instance', basename(runningTurn)].sort(),
    );
  });

  it('keeps the leftover while its stop stays unconfirmed, then removes it when the CLI exits', async () => {
    const leftovers = new GrokProbeLeftovers();
    const child = fakeProbeCli(['cached_token']);
    mocks.stop.mockResolvedValue(false);
    await probeGrok('/fixture/grok', source, leftovers);
    const [leftover] = grokDirectories();

    await leftovers.reclaim();
    expect(existsSync(join(root, leftover!))).toBe(true);
    expect(leftovers.size).toBe(1);

    const stopCalls = mocks.stop.mock.calls.length;
    // The CLI's own exit is what triggers the removal here.
    exitChild(child);
    await vi.waitFor(() => expect(leftovers.size).toBe(0));
    expect(existsSync(join(root, leftover!))).toBe(false);
    // An exited root is never signaled again: its PID may already belong to another process.
    expect(mocks.stop).toHaveBeenCalledTimes(stopCalls);
  });

  it('removes a leftover without following a link placed inside it', async () => {
    const leftovers = new GrokProbeLeftovers();
    const child = fakeProbeCli(['cached_token']);
    mocks.stop.mockResolvedValue(false);
    await probeGrok('/fixture/grok', source, leftovers);
    const [leftover] = grokDirectories();
    const outside = join(root, 'outside-target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(
      outside,
      join(root, leftover!, 'home', '.grok', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    exitChild(child);
    await leftovers.reclaim();
    expect(existsSync(join(root, leftover!))).toBe(false);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(mocks.removeTree).toHaveBeenCalledWith(join(root, leftover!));
  });

  it('on POSIX waits for the probe process group to empty after the root has exited', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    const groupAlive = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const leftovers = new GrokProbeLeftovers();
      const child = fakeProbeCli([]);
      Object.defineProperty(child, 'pid', { value: 4242 });
      const directory = join(root, 'sprint-coder-grok-posix-leftover');
      mkdirSync(directory);
      exitChild(child);
      leftovers.keep({ child, directory, environment: {} });
      await leftovers.reclaim();
      expect(groupAlive).toHaveBeenCalledWith(-4242, 0);
      expect(existsSync(directory)).toBe(true);

      groupAlive.mockImplementation(() => {
        throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
      });
      await leftovers.reclaim();
      expect(existsSync(directory)).toBe(false);
      expect(mocks.stop).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
