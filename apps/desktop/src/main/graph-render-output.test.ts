import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utilityProcess, type UtilityProcess } from 'electron';
import { GRAPH_WORKER_OUTPUT_MAX_BYTES } from '@sprint-coder/contracts';
import { GraphRenderService } from './graph-render';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
afterEach(() => vi.useRealTimers());
const message = { type: 'sprint-graph-result', output: '{"ok":true}', exitCode: 0, stderrBytes: 0 };

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    postMessage: vi.fn(),
  });
  vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
  const run = Reflect.get(GraphRenderService.prototype, 'runUtility') as (
    mode: 'check',
    input: { kind: 'architecture' },
    directory: string,
    signal: AbortSignal,
  ) => Promise<string>;
  const controller = new AbortController();
  const result = run.call(
    { options: { workerPath: '/worker', vendorRoot: '/vendor' } },
    'check',
    { kind: 'architecture' },
    '/work',
    controller.signal,
  );
  return { child, controller, result };
}

describe('Graph utility result handoff', () => {
  it('acknowledges the full result but waits for matching process exit', async () => {
    const { child, result } = fixture();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    child.emit('message', message);
    expect(child.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'sprint-graph-result-ack' });
    await Promise.resolve();
    expect(settled).toBe(false);
    // Real Electron UtilityProcess pipes can emit neither end nor close. IPC carries all bytes.
    child.emit('exit', 0);
    await expect(result).resolves.toBe(message.output);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('does not mistake a bare successful exit for a received report', async () => {
    const { child, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.stdout.write('{"ok":');
    child.emit('exit', 0);
    await rejected;
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    [3, 3],
    [0, 3],
    [3, 0],
  ])('rejects reported exit %i and actual exit %i', async (reported, actual) => {
    const { child, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.emit('message', { ...message, exitCode: reported });
    child.emit('exit', actual);
    await rejected;
  });

  it('rejects a signal exit immediately without killing an already exited worker', async () => {
    const { child, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.emit('message', message);
    child.emit('exit', null);
    await rejected;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    { ...message, type: 'wrong' },
    { ...message, extra: true },
    { ...message, output: '界'.repeat(GRAPH_WORKER_OUTPUT_MAX_BYTES / 2) },
    { ...message, stderrBytes: GRAPH_WORKER_OUTPUT_MAX_BYTES },
  ])('rejects invalid or over-budget IPC results', async (payload) => {
    const { child, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.emit('message', payload);
    await rejected;
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('rejects duplicate results before exit', async () => {
    const { child, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.emit('message', message);
    child.emit('message', message);
    await rejected;
    expect(child.postMessage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'bounds the lifetime whether a result arrived (%s) or not',
    async (received) => {
      vi.useFakeTimers();
      const { child, result } = fixture();
      const rejected = expect(result).rejects.toThrow('Archify check failed');
      if (received) child.emit('message', message);
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(child.kill).toHaveBeenCalledOnce();
    },
  );

  it('rejects cancellation after receipt instead of accepting the result', async () => {
    const { child, controller, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.emit('message', message);
    controller.abort();
    child.emit('exit', 0);
    await rejected;
  });

  it('enforces the combined pipe budget without waiting for an exit event', async () => {
    const { child, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.stdout.write(Buffer.alloc(128 * 1024));
    child.stderr.write(Buffer.alloc(128 * 1024 + 1));
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
