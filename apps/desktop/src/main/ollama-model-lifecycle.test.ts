import { describe, expect, it, vi } from 'vitest';
import { OllamaModelLeaseCoordinator } from './ollama-model-lifecycle';

const target = {
  endpoint: 'http://127.0.0.1:11434/api/generate',
  modelId: 'gemma3:1b',
} as const;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('OllamaModelLeaseCoordinator', () => {
  it('unloads once after the last automatic lease releases', async () => {
    const unload = vi.fn(async () => undefined);
    const subject = new OllamaModelLeaseCoordinator(unload, vi.fn());
    const first = await subject.acquire(target, true);
    const second = await subject.acquire(target, true);

    await first.release();
    expect(unload).not.toHaveBeenCalled();
    await second.release();
    await second.release();

    expect(unload).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledWith(target);
  });

  it('tracks opt-out leases so another connection cannot unload a model still in use', async () => {
    const unload = vi.fn(async () => undefined);
    const subject = new OllamaModelLeaseCoordinator(unload, vi.fn());
    const automatic = await subject.acquire(target, true);
    const optedOut = await subject.acquire(target, false);

    await automatic.release();
    expect(unload).not.toHaveBeenCalled();
    await optedOut.release();

    expect(unload).toHaveBeenCalledTimes(1);
  });

  it('never unloads an opt-out-only use', async () => {
    const unload = vi.fn(async () => undefined);
    const subject = new OllamaModelLeaseCoordinator(unload, vi.fn());
    const lease = await subject.acquire(target, false);
    await lease.release();
    expect(unload).not.toHaveBeenCalled();
  });

  it('waits for an in-flight unload before admitting a new use', async () => {
    const gate = deferred();
    const unload = vi.fn(() => gate.promise);
    const subject = new OllamaModelLeaseCoordinator(unload, vi.fn());
    const oldLease = await subject.acquire(target, true);
    const releasing = oldLease.release();
    let acquired = false;
    const nextLeasePromise = subject.acquire(target, true).then((lease) => {
      acquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(acquired).toBe(false);
    gate.resolve();
    await releasing;
    const nextLease = await nextLeasePromise;
    expect(acquired).toBe(true);
    await nextLease.release();
    expect(unload).toHaveBeenCalledTimes(2);
  });

  it('contains unload failures and remains reusable', async () => {
    const onError = vi.fn();
    const unload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const subject = new OllamaModelLeaseCoordinator(unload, onError);

    await (await subject.acquire(target, true)).release();
    await (await subject.acquire(target, true)).release();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledTimes(2);
  });

  it('retries a failed held-model unload during shutdown', async () => {
    const unload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const subject = new OllamaModelLeaseCoordinator(unload, vi.fn());
    await (await subject.acquire(target, true)).release();

    await subject.dispose();

    expect(unload).toHaveBeenCalledTimes(2);
  });

  it('does not replace a completed result when diagnostic logging itself fails', async () => {
    const subject = new OllamaModelLeaseCoordinator(
      async () => {
        throw new Error('offline');
      },
      () => {
        throw new Error('logger failed');
      },
    );
    await expect((await subject.acquire(target, true)).release()).resolves.toBeUndefined();
  });

  it('closes admission and force-unloads an active automatic lease during shutdown', async () => {
    const unload = vi.fn(async () => undefined);
    const subject = new OllamaModelLeaseCoordinator(unload, vi.fn(), 1);
    const lease = await subject.acquire(target, true);

    await subject.dispose();
    await lease.release();

    expect(unload).toHaveBeenCalledTimes(1);
    await expect(subject.acquire(target, true)).rejects.toThrow('shutting down');
  });
});
