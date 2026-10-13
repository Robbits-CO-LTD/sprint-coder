import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GrokRuntimeAdapter } from './grok-adapter';
import { isRuntimeFailureDiagnostic, type RuntimeCanonicalEvent } from './protocol';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  stop: vi.fn<() => Promise<boolean>>(),
  cleanup: vi.fn(),
  isolationDirectory: '/inert-grok-fixture',
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: mocks.spawn,
}));
vi.mock('./process-tree', () => ({ terminateRuntimeProcessTree: mocks.stop }));
vi.mock('./grok-isolation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prepareGrokIsolation: () => ({
    directory: mocks.isolationDirectory,
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
  const refusePrompt = () => {
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Fixture refused.' },
    });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'refusal' } });
  };
  return { child, adapter, events, failed, exited, start, finishPrompt, refusePrompt };
}

describe('Grok stop timing diagnostic (issue #749)', () => {
  // A virtual clock: the recorder reads performance.now() on every call, so the offsets below
  // are exact and independent of real time.
  let clock = 0;
  beforeEach(() => {
    clock = 50_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.mocked(performance.now).mockRestore();
  });
  const observedStop = (confirmed: boolean) =>
    mocks.stop.mockImplementation(async (...args: unknown[]) => {
      const options = args[2] as { observe?: (o: unknown) => void } | undefined;
      options?.observe?.({ signal: 'SIGTERM', event: 'start' });
      clock += 100;
      options?.observe?.({ signal: 'SIGTERM', event: 'exit', exitCode: 128 });
      options?.observe?.({ signal: 'SIGKILL', event: 'start' });
      clock += 100;
      options?.observe?.({ signal: 'SIGKILL', event: 'exit', exitCode: 0 });
      clock += 100;
      return confirmed;
    });
  const timingOf = (failed: ReturnType<typeof vi.fn>) =>
    (failed.mock.lastCall?.[1] as { grokProtocol?: Record<string, unknown> }).grokProtocol;

  it('records the taskkill results and an unobserved root exit when stop=false', async () => {
    observedStop(false);
    const f = await startFixture();
    f.finishPrompt();
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
    const grokProtocol = timingOf(f.failed);
    expect(grokProtocol).toMatchObject({ stopConfirmation: 'unconfirmed' });
    expect(grokProtocol?.['stopTiming']).toMatchObject({
      signalTaskkillExitCode: 128,
      forceTaskkillExitCode: 0,
      rootExitMs: null,
      rootCloseMs: null,
      isolationRemaining: 0,
      rootAliveAtSettle: null,
    });
    // requested() and settled() are both wired: offsets start at the stop request (clock 0) and
    // the stop settles after the last taskkill finished.
    expect(grokProtocol?.['stopTiming']).toMatchObject({
      signalTaskkillExitMs: 100,
      forceTaskkillStartMs: 100,
      forceTaskkillExitMs: 200,
      settledMs: 300,
    });
    expect(Object.keys(grokProtocol?.['stopTiming'] as object).sort()).toEqual(
      [
        'settledMs',
        'signalTaskkillExitMs',
        'signalTaskkillExitCode',
        'forceTaskkillStartMs',
        'forceTaskkillExitMs',
        'forceTaskkillExitCode',
        'rootExitMs',
        'rootCloseMs',
        'isolationRemaining',
        'rootAliveAtSettle',
      ].sort(),
    );
    expect(isRuntimeFailureDiagnostic(f.failed.mock.lastCall?.[1])).toBe(true);
  });

  it('reports a surviving isolation directory and a root the OS still knows', async () => {
    observedStop(false);
    mocks.isolationDirectory = mkdtempSync(join(tmpdir(), 'grok-749-isolation-'));
    try {
      const f = await startFixture();
      Object.defineProperty(f.child, 'pid', { value: process.pid, configurable: true });
      f.finishPrompt();
      await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
      expect(timingOf(f.failed)?.['stopTiming']).toMatchObject({
        isolationRemaining: 1,
        rootAliveAtSettle: 1,
        rootExitMs: null,
      });
    } finally {
      rmSync(mocks.isolationDirectory, { recursive: true, force: true });
      mocks.isolationDirectory = '/inert-grok-fixture';
    }
  });

  it('records the timing too when the stop is confirmed and the Turn fails for another reason', async () => {
    observedStop(true);
    const f = await startFixture();
    // Node has handled the root's exit: its PID is no longer evidence, whatever the OS says.
    Object.defineProperty(f.child, 'pid', { value: process.pid, configurable: true });
    Object.assign(f.child, { exitCode: 1 });
    f.child.emit('exit', 1, null);
    f.refusePrompt();
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
    const grokProtocol = timingOf(f.failed);
    expect(grokProtocol).toMatchObject({ stopConfirmation: 'confirmed' });
    expect(grokProtocol?.['stopTiming']).toMatchObject({
      forceTaskkillExitCode: 0,
      rootExitMs: expect.any(Number),
      rootCloseMs: null,
      rootAliveAtSettle: 0,
    });
    expect(isRuntimeFailureDiagnostic(f.failed.mock.lastCall?.[1])).toBe(true);
  });
});

describe('Grok process stop confirmation', () => {
  it('cannot complete, exit, clean up or forget the active turn when a terminal reply is followed by stop=false', async () => {
    const resolveStop = deferredStop();
    const f = await startFixture();
    f.finishPrompt();
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    expect(f.events.some((event) => event.type === 'completed')).toBe(false);
    f.child.emit('close', 0);
    expect(f.exited).not.toHaveBeenCalled();
    resolveStop(false);
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
    expect(f.failed.mock.lastCall?.[0].code).toBe('RUNTIME_STOP_UNCONFIRMED');
    expect(f.events.some((event) => event.type === 'completed')).toBe(false);
    expect(f.exited).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    await expect(f.adapter.cancel('turn')).rejects.toThrow('exit was not confirmed');
    f.start();
    expect(f.failed.mock.lastCall?.[0]).toMatchObject({ retryable: false });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
    f.adapter.start(
      'distinct-turn',
      'Synthetic retry',
      [],
      vi.fn(),
      null,
      'auto',
      vi.fn(),
      f.failed,
      f.exited,
    );
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(f.failed.mock.lastCall?.[0].code).toBe('RUNTIME_STOP_UNCONFIRMED');
  });

  it('does not resolve cancellation or emit exit when the root closes but stop=false', async () => {
    const resolveStop = deferredStop();
    const f = await startFixture();
    const canceled = f.adapter.cancel('turn');
    const rejected = expect(canceled).rejects.toThrow('exit was not confirmed');
    f.child.emit('close', 0);
    resolveStop(false);
    await rejected;
    await expect(f.adapter.cancel('turn')).rejects.toThrow('exit was not confirmed');
    expect(f.exited).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.type === 'completed')).toBe(false);
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('does not treat an abnormal root exit as process-tree confirmation', async () => {
    const f = await startFixture();
    f.child.emit('close', 1);
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
    await expect(f.adapter.cancel('turn')).rejects.toThrow('exit was not confirmed');
    expect(f.exited).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.type === 'completed')).toBe(false);
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('emits completion and exit only after the pending stop is confirmed', async () => {
    const resolveStop = deferredStop();
    const f = await startFixture();
    f.finishPrompt();
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    f.child.emit('close', 0);
    expect(f.events.some((event) => event.type === 'completed')).toBe(false);
    expect(f.exited).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    resolveStop(true);
    await vi.waitFor(() => expect(f.exited).toHaveBeenCalledOnce());
    // The Turn waits for each taskkill before its grace window (issue #665).
    expect(mocks.stop).toHaveBeenCalledWith(f.child, expect.any(Object), {
      awaitTaskkill: true,
      observe: expect.any(Function),
    });
    expect(f.events.filter((event) => event.type === 'completed')).toEqual([
      { type: 'completed', resolvedModel: 'grok-fixture' },
    ]);
    expect(f.exited).toHaveBeenCalledWith(0, false);
    expect(f.failed).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it('returns forced=false only after cancellation stop is confirmed', async () => {
    const resolveStop = deferredStop();
    const f = await startFixture();
    const canceled = f.adapter.cancel('turn');
    f.child.emit('close', 0);
    expect(f.exited).not.toHaveBeenCalled();
    resolveStop(true);
    await expect(canceled).resolves.toBe(false);
    expect(f.exited).toHaveBeenCalledWith(0, true);
    expect(f.events.some((event) => event.type === 'completed')).toBe(false);
    expect(f.failed).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
  it('reports confirmed exit even when private scratch cleanup throws', async () => {
    mocks.cleanup.mockImplementation(() => {
      throw new Error('Synthetic EPERM');
    });
    const resolveStop = deferredStop();
    const f = await startFixture();
    f.finishPrompt();
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    f.child.emit('close', 0);
    resolveStop(true);
    await vi.waitFor(() => expect(f.exited).toHaveBeenCalledOnce());
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.events.filter((e) => e.type === 'completed')).toHaveLength(1);
  });
});
