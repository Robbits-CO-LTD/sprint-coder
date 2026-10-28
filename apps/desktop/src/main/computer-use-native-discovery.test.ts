import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComputerUseDiscoveryManager } from './computer-use-native-discovery';
import { ComputerUseDiscoveryNotSubmittedError } from './computer-use-native-types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const completed = (id: string, windows: unknown[] = []) => ({
  discoveryId: id,
  result: 'completed',
  drained: true,
  launchAttemptCount: 1,
  windows,
});
const stopped = (id: string) => ({
  discoveryId: id,
  result: 'stopped',
  drained: true,
  launchAttemptCount: 1,
});
function setup() {
  const query = vi.fn(
    async (id: string, _input: Readonly<Record<string, unknown>>): Promise<unknown> =>
      completed(id),
  );
  const stop = vi.fn(async (id: string): Promise<unknown> => stopped(id));
  const cancelUnsubmitted = vi.fn(
    (_id: string): 'never_sent' | 'may_have_been_sent' | 'unknown' => 'may_have_been_sent',
  );
  const manager = createComputerUseDiscoveryManager({
    query,
    stop,
    cancelUnsubmitted,
    timeoutMs: 10,
    attemptLimit: 2,
    unconfirmedError: () => new Error('native_stop_unconfirmed'),
  });
  return { manager, query, stop, cancelUnsubmitted };
}
afterEach(() => vi.useRealTimers());

describe('owned Main window discovery', () => {
  it('publishes one shared Stop before any deferred query can run', async () => {
    const { manager, query, stop } = setup();
    const handle = manager.begin({});
    const first = handle.stop(),
      second = handle.stop();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ kind: 'not_submitted' });
    await expect(handle.result).rejects.toThrow('canceled');
    expect(query).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(manager.quarantined()).toBe(false);
  });

  it('never reuses an issued ID after bounded terminal records have been trimmed', async () => {
    const { manager, query, stop } = setup();
    const ids = new Set<string>();
    for (let index = 0; index < 270; index += 1) {
      const handle = manager.begin({ discoveryId: 'caller-cannot-choose' });
      expect(ids.has(handle.id)).toBe(false);
      ids.add(handle.id);
      await expect(handle.result).resolves.toEqual([]);
      await expect(handle.stop()).resolves.toEqual({ kind: 'completed', launchAttemptCount: 1 });
      expect(Object.keys(handle).sort()).toEqual(['id', 'result', 'stop', 'terminal']);
    }
    expect(query).toHaveBeenCalledTimes(270);
    expect(stop).not.toHaveBeenCalled();
    expect(manager.quarantined()).toBe(false);
  });

  it('finishes Stop independently of a permanently pending query result', async () => {
    const { manager, query, stop } = setup();
    query.mockImplementation(() => new Promise(() => {}));
    const handle = manager.begin({});
    await Promise.resolve();
    await expect(handle.stop()).resolves.toEqual({ kind: 'stopped', launchAttemptCount: 1 });
    await expect(handle.result).rejects.toThrow('canceled');
    expect(stop).toHaveBeenCalledWith(handle.id);
    expect(manager.quarantined()).toBe(false);
  });

  it('keeps unknown Stop quarantined, bounds retries and permits a fresh explicit recheck', async () => {
    vi.useFakeTimers();
    const { manager, query, stop } = setup();
    query.mockImplementation(() => new Promise(() => {}));
    stop.mockImplementation(() => new Promise(() => {}));
    const handle = manager.begin({});
    await Promise.resolve();
    const failed = handle.stop().catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(25);
    await expect(failed).resolves.toBe('native_stop_unconfirmed');
    await expect(handle.result).rejects.toThrow('native_stop_unconfirmed');
    expect(stop).toHaveBeenCalledTimes(2);
    expect(manager.quarantined()).toBe(true);
    expect(() => manager.begin({})).toThrow('native_stop_unconfirmed');
    stop.mockImplementation(async (id) => stopped(id));
    await expect(handle.stop()).resolves.toEqual({ kind: 'stopped', launchAttemptCount: 1 });
    expect(manager.quarantined()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a late bound terminal envelope but never delivers its windows after Stop', async () => {
    vi.useFakeTimers();
    const { manager, query, stop } = setup();
    const pending = deferred<unknown>();
    query.mockImplementation(() => pending.promise);
    stop.mockRejectedValue(new Error('not drained'));
    const handle = manager.begin({});
    const delivered = vi.fn();
    void handle.result.then(delivered, () => undefined);
    await Promise.resolve();
    await expect(handle.stop()).rejects.toThrow('native_stop_unconfirmed');
    expect(manager.quarantined()).toBe(true);
    pending.resolve(completed(handle.id, [{ late: true }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.quarantined()).toBe(false);
    expect(delivered).not.toHaveBeenCalled();
    await expect(handle.stop()).resolves.toEqual({ kind: 'completed', launchAttemptCount: 1 });
  });

  it.each(['wrong-owner', 'malformed'] as const)(
    'retains a valid late Stop after both deadlines and rejects %s late proof',
    async (invalid) => {
      vi.useFakeTimers();
      const { manager, query, stop } = setup();
      const queryReply = deferred<unknown>();
      const firstReply = deferred<unknown>();
      const secondReply = deferred<unknown>();
      query.mockImplementation(() => queryReply.promise);
      stop
        .mockImplementationOnce(() => firstReply.promise)
        .mockImplementationOnce(() => secondReply.promise);
      const handle = manager.begin({});
      const delivered = vi.fn();
      void handle.result.then(delivered, () => undefined);
      await Promise.resolve();
      const stopping = handle.stop().catch((error: Error) => error.message);
      queryReply.reject(new Error('native query canceled'));
      await vi.advanceTimersByTimeAsync(25);
      expect(await stopping).toBe('native_stop_unconfirmed');
      await expect(handle.result).rejects.toThrow('native_stop_unconfirmed');
      expect(stop).toHaveBeenCalledTimes(2);
      expect(manager.quarantined()).toBe(true);

      firstReply.resolve(invalid === 'wrong-owner' ? stopped('another-owner') : []);
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.quarantined()).toBe(true);
      secondReply.resolve(stopped(handle.id));
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.quarantined()).toBe(false);
      await expect(handle.terminal).resolves.toEqual({ kind: 'stopped', launchAttemptCount: 1 });
      await expect(handle.stop()).resolves.toEqual({ kind: 'stopped', launchAttemptCount: 1 });
      expect(stop).toHaveBeenCalledTimes(2);
      expect(delivered).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not treat a late legacy array or a native error string as terminal proof', async () => {
    const { manager, query, stop } = setup();
    const pending = deferred<unknown>();
    query.mockImplementation(() => pending.promise);
    stop.mockRejectedValue(new Error('not drained'));
    const handle = manager.begin({});
    await Promise.resolve();
    await expect(handle.stop()).rejects.toThrow('native_stop_unconfirmed');
    pending.resolve([]);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(4));
    expect(manager.quarantined()).toBe(true);
    const second = setup();
    second.query.mockRejectedValue(
      Object.assign(new Error('native refusal'), {
        accepted: false,
        code: 'profile_identity_invalid',
      }),
    );
    second.stop.mockRejectedValue(new Error('unconfirmed'));
    await expect(second.manager.begin({}).result).rejects.toThrow('native_stop_unconfirmed');
    expect(second.manager.quarantined()).toBe(true);
  });

  it('automatically proves failed queries stopped while preserving the original error', async () => {
    const { manager, query, stop } = setup();
    query.mockRejectedValue(new Error('app_identity_changed'));
    await expect(manager.begin({}).result).rejects.toThrow('app_identity_changed');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.quarantined()).toBe(false);
    query.mockRejectedValue(new ComputerUseDiscoveryNotSubmittedError('spawn rejected locally'));
    await expect(manager.begin({}).result).rejects.toThrow('spawn rejected locally');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps unsent preparation isolated until its original attempt settles', async () => {
    const { manager, query, cancelUnsubmitted, stop } = setup();
    const pending = deferred<unknown>();
    query.mockImplementation(() => pending.promise);
    cancelUnsubmitted.mockReturnValue('never_sent');
    const handle = manager.begin({});
    await Promise.resolve();
    await expect(handle.stop()).resolves.toEqual({ kind: 'not_submitted' });
    expect(manager.quarantined()).toBe(true);
    pending.reject(new ComputerUseDiscoveryNotSubmittedError('canceled before write'));
    await vi.waitFor(() => expect(manager.quarantined()).toBe(false));
    expect(stop).not.toHaveBeenCalled();
  });

  it('cannot clear another operation with the wrong ID or with an unrelated terminal result', async () => {
    const { manager, query, stop } = setup();
    const a = deferred<unknown>(),
      b = deferred<unknown>();
    query.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const first = manager.begin({}),
      second = manager.begin({});
    await Promise.resolve();
    stop.mockResolvedValue(stopped(second.id));
    await expect(first.stop()).rejects.toThrow('native_stop_unconfirmed');
    b.resolve(completed(second.id));
    await expect(second.result).resolves.toEqual([]);
    expect(manager.quarantined()).toBe(true);
    stop.mockImplementation(async (id) => stopped(id));
    await expect(first.stop()).resolves.toMatchObject({ kind: 'stopped' });
    a.resolve(completed(first.id));
    await expect(first.result).rejects.toThrow('native_stop_unconfirmed');
    expect(manager.quarantined()).toBe(false);
  });
});
