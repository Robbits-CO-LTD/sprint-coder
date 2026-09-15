import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utilityProcess, type UtilityProcess } from 'electron';
import { GraphRenderService } from './graph-render';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
afterEach(() => vi.useRealTimers());

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
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

describe('Graph utility output completion', () => {
  it('waits for stdout EOF even when process exit arrives first', async () => {
    const { child, result } = fixture();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    child.stdout.write('{"ok":');
    child.emit('exit', 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.end('true}');
    child.stderr.end();
    await expect(result).resolves.toBe('{"ok":true}');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('waits for process exit when both pipes end first', async () => {
    const { child, result } = fixture();
    child.stdout.end('{"ok":true}');
    child.stderr.end();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    child.emit('exit', 0);
    await expect(result).resolves.toBe('{"ok":true}');
  });

  it('keeps a nonzero result failed even with complete JSON', async () => {
    const { child, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.stdout.end('{"ok":false}');
    child.stderr.end();
    child.emit('exit', 3);
    await rejected;
  });

  it('rejects cancellation after exit without signaling an exited process', async () => {
    const { child, controller, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.emit('exit', 0);
    controller.abort();
    await rejected;
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.end();
    child.stderr.end();
  });

  it('bounds missing EOF after process exit', async () => {
    vi.useFakeTimers();
    const { child, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.end();
    child.stderr.end();
  });

  it('rejects excessive output without waiting for an exit notification', async () => {
    const { child, result } = fixture();
    const rejected = expect(result).rejects.toThrow('Archify check failed');
    child.stdout.write(Buffer.alloc(256 * 1024 + 1));
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 1);
  });
});
