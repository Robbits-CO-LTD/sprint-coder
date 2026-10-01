import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as childProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GrokRuntimeAdapter } from './grok-adapter';
import { RuntimeHostClient } from '../main/runtime-host';
import { ToolRegistry } from '@sprint-coder/domain';
import type { RuntimeCanonicalEvent } from './protocol';

type FixtureHost = EventEmitter & {
  messages: Array<Record<string, unknown>>;
  kill: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
};
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  stop: vi.fn<() => Promise<boolean>>(),
  cleanup: vi.fn(),
  hosts: [] as FixtureHost[],
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: mocks.spawn,
}));
vi.mock('./process-tree', () => ({ terminateRuntimeProcessTree: mocks.stop }));
vi.mock('./grok-isolation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prepareGrokIsolation: () => ({
    directory: '/inert-grok-fixture',
    cwd: '/inert-grok-fixture/work',
    environment: {},
    cleanup: mocks.cleanup,
  }),
}));

const fixtures: Array<{ adapter: GrokRuntimeAdapter; child: ChildProcessWithoutNullStreams }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cleanup.mockReset();
  mocks.stop.mockResolvedValue(false);
});

afterEach(async () => {
  for (const { adapter, child } of fixtures.splice(0)) {
    adapter.dispose();
    child.emit('close', 0);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  await Promise.resolve();
  vi.useRealTimers();
  mocks.hosts.length = 0;
});

function deferredStop() {
  let resolve!: (confirmed: boolean) => void;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  mocks.stop.mockReturnValue(promise);
  return resolve;
}

async function startFixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // No OS process is started. Only the real ACP parser and adapter lifecycle run.
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null],
  }) as ChildProcessWithoutNullStreams;
  mocks.spawn.mockReturnValue(child);
  const events: RuntimeCanonicalEvent[] = [];
  const failed = vi.fn();
  const exited = vi.fn();
  const accepted = vi.fn();
  const sessionRequest = vi.fn();
  const promptRequest = vi.fn();
  let promptId: unknown;
  const send = (frame: unknown) => stdout.write(JSON.stringify(frame) + '\n');
  const update = (value: unknown) =>
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'fixture-session', update: value },
    });
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>;
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id: request['id'], result });
    switch (request['method']) {
      case 'initialize':
        reply({ _meta: { grokShell: true }, authMethods: [{ id: 'cached_token' }] });
        break;
      case 'authenticate':
        reply({});
        break;
      case 'session/new':
        sessionRequest(request['params']);
        update({
          sessionUpdate: 'available_commands_update',
          _meta: { tools: ['search_tool', 'use_tool'] },
        });
        reply({ sessionId: 'fixture-session', models: { currentModelId: 'grok-fixture' } });
        break;
      case '_x.ai/mcp/list':
        reply({ servers: [], sessionMcpResolved: true });
        break;
      case 'session/prompt':
        promptId = request['id'];
        promptRequest();
        break;
      default:
        throw new Error('Unexpected fixture RPC');
    }
  });
  const adapter = new GrokRuntimeAdapter();
  fixtures.push({ adapter, child });
  adapter.setCliResolution({
    executable: '/inert-grok-fixture/grok',
    source: 'explicit',
    version: 'grok 1.0.40',
    compatibility: 'compatible',
    capabilities: ['acp'],
  });
  const start = () =>
    adapter.start(
      'turn',
      'Synthetic request',
      [],
      accepted,
      null,
      'auto',
      (event) => events.push(event),
      failed,
      exited,
    );
  start();
  child.emit('spawn');
  await vi.waitFor(() => expect(promptRequest).toHaveBeenCalledOnce());
  expect(sessionRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      _meta: expect.objectContaining({ yoloMode: false, autoMode: false }),
    }),
  );
  expect(failed).not.toHaveBeenCalled();
  const finishPrompt = () => {
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Fixture completed.' },
    });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  };
  return { child, adapter, events, failed, exited, start, finishPrompt };
}

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    utilityProcess: {
      fork: () => {
        const host = Object.assign(new EventEmitter(), {
          messages: [] as Array<Record<string, unknown>>,
          kill: vi.fn(),
          postMessage: vi.fn(),
        });
        host.postMessage.mockImplementation((message: Record<string, unknown>) => {
          host.messages.push(message);
        });
        mocks.hosts.push(host);
        return host;
      },
    },
  };
});
it.each([6000, 14000])(
  'accepts real Grok adapter confirmation at %sms within the bounded Windows stop budget',
  async (delayMs) => {
    const restore = asPlatform('win32');
    const confirm = deferredStop();
    let client: RuntimeHostClient | undefined;
    try {
      const f = await startFixture();
      vi.useFakeTimers();
      client = new RuntimeHostClient(vi.fn(), vi.fn(), undefined, undefined, 'grok');
      const host = mocks.hosts.at(-1)!;
      host.emit('spawn');
      client.start(
        'task',
        'turn',
        'Synthetic request',
        null,
        'auto',
        new ToolRegistry().createSnapshot({ providerId: 'grok', workspaceId: null }),
      );
      await Promise.resolve();
      const start = host.messages.find((m: Record<string, unknown>) => m.type === 'start')!;
      let adapterReceipt: boolean | undefined;
      host.postMessage.mockImplementation((message: Record<string, unknown>) => {
        host.messages.push(message);
        if (message.type === 'cancel')
          void f.adapter.cancel('turn').then((forced) => {
            adapterReceipt = forced;
            host.emit('message', { ...start, type: 'stopped', seq: 1, forced });
          });
      });
      const canceled = client.cancel('task', 'turn');
      const settled = canceled.then(
        () => 'resolved',
        () => 'rejected',
      );
      let result: string | undefined;
      void settled.then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(result).toBeUndefined();
      expect(host.kill).not.toHaveBeenCalled();
      expect(adapterReceipt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(delayMs - 5000);
      confirm(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(adapterReceipt).toBe(false);
      expect(await settled).toBe('resolved');
      expect(host.kill).not.toHaveBeenCalled();
      expect(mocks.stop).toHaveBeenCalledWith(f.child, expect.any(Object), { awaitTaskkill: true });
    } finally {
      confirm(true);
      client?.dispose();
      vi.useRealTimers();
      restore();
    }
  },
);

function startMain(kind: 'codex' | 'grok') {
  const client = new RuntimeHostClient(vi.fn(), vi.fn(), undefined, undefined, kind);
  const host = mocks.hosts.at(-1)!;
  host.emit('spawn');
  client.start(
    'task-budget',
    'turn-budget',
    'Synthetic request',
    null,
    'auto',
    new ToolRegistry().createSnapshot({ providerId: kind, workspaceId: null }),
  );
  return { client, host };
}
function asPlatform(value: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value });
  return () => Object.defineProperty(process, 'platform', descriptor);
}
it.each([
  { kind: 'codex' as const, platform: 'win32', timeout: 5000 },
  { kind: 'grok' as const, platform: 'linux', timeout: 5000 },
  { kind: 'grok' as const, platform: 'win32', timeout: 15000 },
])(
  'keeps $kind/$platform nonresponse bounded at $timeout ms and ignores old-host receipts',
  async ({ kind, platform, timeout }) => {
    const restore = asPlatform(platform);
    vi.useFakeTimers();
    const { client, host } = startMain(kind);
    try {
      await Promise.resolve();
      const start = host.messages.find((message) => message.type === 'start')!;
      let results: string[] | undefined;
      const pending = [
        client.cancel('task-budget', 'turn-budget'),
        client.cancel('task-budget', 'turn-budget'),
      ].map((promise) =>
        promise.then(
          () => 'resolved',
          () => 'rejected',
        ),
      );
      void Promise.all(pending).then((value) => {
        results = value;
      });
      await vi.advanceTimersByTimeAsync(timeout - 1);
      expect(results).toBeUndefined();
      expect(host.messages.filter((message) => message.type === 'cancel')).toHaveLength(1);
      expect(host.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(results).toEqual(['rejected', 'rejected']);
      expect(host.kill).toHaveBeenCalledOnce();
      host.emit('message', { ...start, type: 'stopped', seq: 1, forced: false });
      await vi.advanceTimersByTimeAsync(timeout);
      expect(results).toEqual(['rejected', 'rejected']);
      expect(host.kill).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
      restore();
    }
  },
);
it('quarantines an unconfirmed Grok stop immediately and rejects every joined caller', async () => {
  const restore = asPlatform('win32');
  vi.useFakeTimers();
  const { client, host } = startMain('grok');
  try {
    await Promise.resolve();
    const start = host.messages.find((message) => message.type === 'start')!;
    const first = expect(client.cancel('task-budget', 'turn-budget')).rejects.toThrow(
      'stop could not be confirmed',
    );
    const joined = expect(client.cancel('task-budget', 'turn-budget')).rejects.toThrow(
      'stop could not be confirmed',
    );
    host.emit('message', {
      ...start,
      type: 'error',
      seq: 1,
      error: {
        code: 'RUNTIME_STOP_UNCONFIRMED',
        userMessage: 'synthetic uncertainty',
        retryable: false,
      },
    });
    await first;
    await joined;
    expect(
      client.start(
        'other',
        'other-turn',
        'Synthetic request',
        null,
        'auto',
        new ToolRegistry().createSnapshot({ providerId: 'grok', workspaceId: null }),
      ),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(host.kill).not.toHaveBeenCalled();
  } finally {
    client.dispose();
    restore();
  }
});
it('rejects parallel Grok cancellation at one bounded host restart and never accepts a mismatched operation', async () => {
  const restore = asPlatform('win32');
  vi.useFakeTimers();
  const { client, host } = startMain('grok');
  try {
    client.start(
      'task-two',
      'turn-two',
      'Synthetic request',
      null,
      'auto',
      new ToolRegistry().createSnapshot({ providerId: 'grok', workspaceId: null }),
    );
    await Promise.resolve();
    const start = host.messages.find((message) => message.type === 'start')!;
    let results: string[] | undefined;
    const pending = [
      client.cancel('task-budget', 'turn-budget'),
      client.cancel('task-two', 'turn-two'),
    ].map((promise) =>
      promise.then(
        () => 'resolved',
        () => 'rejected',
      ),
    );
    void Promise.all(pending).then((value) => {
      results = value;
    });
    host.emit('message', {
      ...start,
      operationId: 'different-operation',
      type: 'stopped',
      seq: 1,
      forced: false,
    });
    await vi.advanceTimersByTimeAsync(14000);
    expect(results).toBeUndefined();
    expect(host.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(results).toEqual(['rejected', 'rejected']);
    expect(host.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30000);
    expect(host.kill).toHaveBeenCalledOnce();
  } finally {
    client.dispose();
    restore();
  }
});
it('clears the enlarged watchdog on disposal without restarting from a delayed receipt', async () => {
  const restore = asPlatform('win32');
  vi.useFakeTimers();
  const { client, host } = startMain('grok');
  try {
    await Promise.resolve();
    const start = host.messages.find((message) => message.type === 'start')!;
    const pending = client.cancel('task-budget', 'turn-budget').then(
      () => 'settled',
      () => 'settled',
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(host.kill).not.toHaveBeenCalled();
    client.dispose();
    expect(await pending).toBe('settled');
    host.emit('message', { ...start, type: 'stopped', seq: 1, forced: false });
    await vi.advanceTimersByTimeAsync(30000);
    expect(host.kill).toHaveBeenCalledOnce();
  } finally {
    client.dispose();
    restore();
  }
});
