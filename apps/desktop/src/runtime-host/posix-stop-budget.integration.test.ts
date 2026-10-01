import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ToolRegistry } from '@sprint-coder/domain';
import { expect, it, vi } from 'vitest';
import { RuntimeHostClient } from '../main/runtime-host';
import { CodexRuntimeAdapter } from './codex-adapter';
import { ClaudeRuntimeAdapter } from './claude-adapter';
import type { RuntimeKind } from './protocol';
import type * as StopBudget from './stop-budget';

const mocks = vi.hoisted(() => ({
  platform: 'linux',
  spawn: vi.fn(),
  stop: vi.fn(),
  hosts: [] as EventEmitter[],
}));
vi.mock('./stop-budget', async (original) => {
  const actual = await original<typeof StopBudget>();
  return {
    ...actual,
    runtimeStopConfirmationTimeoutMs: (kind: RuntimeKind) =>
      actual.runtimeStopConfirmationTimeoutMs(kind, mocks.platform),
  };
});
vi.mock('./owned-cli-process', () => ({
  spawnOwnedCliProcess: mocks.spawn,
  stopOwnedCliProcess: () => mocks.stop(),
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    utilityProcess: {
      fork: () => {
        const host = Object.assign(new EventEmitter(), {
          messages: [] as Record<string, unknown>[],
          postMessage: vi.fn(),
          kill: vi.fn(),
        });
        host.postMessage.mockImplementation((message: Record<string, unknown>) =>
          host.messages.push(message),
        );
        mocks.hosts.push(host);
        return host;
      },
    },
  };
});

// Actual Main and adapter cancellation run on Windows. Only the budget's platform input and
// OS stop boundary are controlled; process.platform and real OS signals are never changed.
it.each([
  { kind: 'codex' as const, platform: 'linux', delay: 6_000 },
  { kind: 'codex' as const, platform: 'linux', delay: 8_000 },
  { kind: 'claude' as const, platform: 'darwin', delay: 6_000 },
  { kind: 'claude' as const, platform: 'darwin', delay: 8_000 },
])(
  'accepts $kind confirmed adapter receipt at $delay ms under modeled $platform policy',
  async ({ kind, platform, delay }) => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-posix-budget-'));
    await mkdir(join(root, '.git'));
    let confirm!: (stopped: boolean) => void;
    mocks.stop.mockReset().mockReturnValue(
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
    );
    mocks.platform = platform;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      pid: undefined,
    });
    mocks.spawn.mockReturnValue(child);
    const adapter =
      kind === 'codex'
        ? new CodexRuntimeAdapter(60_000, 'fixture', [], root)
        : new ClaudeRuntimeAdapter(60_000);
    adapter.setCliResolution({
      executable: 'fixture',
      source: 'explicit',
      version: 'fixture',
      compatibility: 'verified',
      capabilities: [],
    });
    let client: RuntimeHostClient | undefined;
    try {
      adapter.start(
        'turn',
        'Synthetic request',
        [],
        vi.fn(),
        root,
        'auto',
        vi.fn(),
        vi.fn(),
        vi.fn(),
      );
      vi.useFakeTimers();
      client = new RuntimeHostClient(vi.fn(), vi.fn(), undefined, undefined, kind);
      const host = mocks.hosts.at(-1)! as EventEmitter & {
        messages: Record<string, unknown>[];
        postMessage: ReturnType<typeof vi.fn>;
        kill: ReturnType<typeof vi.fn>;
      };
      host.emit('spawn');
      client.start(
        'task',
        'turn',
        'Synthetic request',
        null,
        'auto',
        new ToolRegistry().createSnapshot({ providerId: kind, workspaceId: null }),
      );
      await Promise.resolve();
      const start = host.messages.find((message) => message['type'] === 'start')!;
      host.postMessage.mockImplementation((message: Record<string, unknown>) => {
        host.messages.push(message);
        if (message['type'] === 'cancel')
          void adapter.cancel('turn').then((forced) => {
            host.emit('message', { ...start, type: 'stopped', seq: 1, forced });
          });
      });
      const pending = [client.cancel('task', 'turn'), client.cancel('task', 'turn')].map(
        (promise) =>
          promise.then(
            () => 'resolved',
            () => 'rejected',
          ),
      );
      let results: string[] | undefined;
      void Promise.all(pending).then((value) => {
        results = value;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(results).toBeUndefined();
      expect(host.kill).not.toHaveBeenCalled();
      expect(host.messages.filter((message) => message['type'] === 'cancel')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(delay - 5_000);
      confirm(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(await Promise.all(pending)).toEqual(['resolved', 'resolved']);
      expect(host.kill).not.toHaveBeenCalled();
      expect(mocks.stop).toHaveBeenCalledOnce();
    } finally {
      confirm(true);
      client?.dispose();
      Object.assign(child, { exitCode: 0 });
      child.emit('close', 0);
      adapter.dispose();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await rm(root, { recursive: true, force: true });
      mocks.hosts.length = 0;
    }
  },
);

it.each([
  { kind: 'codex' as const, platform: 'linux' },
  { kind: 'claude' as const, platform: 'darwin' },
])(
  'bounds repeated $kind cancellations at 9s and rejects old-host receipts under modeled $platform policy',
  async ({ kind, platform }) => {
    mocks.platform = platform;
    vi.useFakeTimers();
    const client = new RuntimeHostClient(vi.fn(), vi.fn(), undefined, undefined, kind);
    const host = mocks.hosts.at(-1)! as EventEmitter & {
      messages: Record<string, unknown>[];
      kill: ReturnType<typeof vi.fn>;
    };
    try {
      host.emit('spawn');
      client.start(
        'task',
        'deadline-turn',
        'Synthetic request',
        null,
        'auto',
        new ToolRegistry().createSnapshot({ providerId: kind, workspaceId: null }),
      );
      await Promise.resolve();
      const start = host.messages.find((message) => message['type'] === 'start')!;
      const pending = [
        client.cancel('task', 'deadline-turn'),
        client.cancel('task', 'deadline-turn'),
      ].map((promise) =>
        promise.then(
          () => 'resolved',
          () => 'rejected',
        ),
      );
      let results: string[] | undefined;
      void Promise.all(pending).then((value) => {
        results = value;
      });
      await vi.advanceTimersByTimeAsync(8_999);
      expect(results).toBeUndefined();
      expect(host.kill).not.toHaveBeenCalled();
      expect(host.messages.filter((message) => message['type'] === 'cancel')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(results).toEqual(['rejected', 'rejected']);
      expect(host.kill).toHaveBeenCalledOnce();
      host.emit('message', { ...start, type: 'stopped', seq: 1, forced: false });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(results).toEqual(['rejected', 'rejected']);
      expect(host.kill).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
      vi.useRealTimers();
      mocks.hosts.length = 0;
    }
  },
);
