import type { WindowsStopListener } from './computer-use-windows-stop-delivery';
import { ComputerUseDiscoveryScope } from './computer-use-discovery-scope';
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
function setup(
  generationAvailable?: (generation: number) => boolean,
  generationKillRequested?: (generation: number) => boolean,
) {
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
    ...(generationAvailable === undefined ? {} : { generationAvailable }),
    ...(generationKillRequested === undefined ? {} : { generationKillRequested }),
  });
  return { manager, query, stop, cancelUnsubmitted };
}
afterEach(() => vi.useRealTimers());

describe('owned Main window discovery', () => {
  it('does not accept a Stop receipt after kill before exit transfer', async () => {
    let killed = false;
    const { manager, query, stop } = setup(
      () => true,
      () => killed,
    );
    query.mockImplementation(() => new Promise(() => {}));
    const reply = deferred<unknown>();
    stop.mockImplementation(() => reply.promise);
    const handle = manager.begin({});
    manager.bindGeneration(handle.id, 1);
    await Promise.resolve();
    const stopping = handle.stop();
    await Promise.resolve();
    killed = true;
    reply.resolve(stopped(handle.id));
    await expect(stopping).rejects.toThrow('native_stop_unconfirmed');
    expect(manager.quarantined()).toBe(true);
    manager.terminateGeneration(1);
    await expect(handle.terminal).resolves.toEqual({ kind: 'terminated', helperGeneration: 1 });
    expect(manager.quarantined()).toBe(false);
  });
  it('rejects completion from an exited generation until transfer terminates it', async () => {
    let available = true;
    const { manager, query, stop } = setup(() => available);
    const reply = deferred<unknown>();
    query.mockImplementation(() => reply.promise);
    const handle = manager.begin({});
    manager.bindGeneration(handle.id, 1);
    await Promise.resolve();
    available = false;
    expect(manager.resultAvailable(handle.id)).toBe(false);
    reply.resolve(completed(handle.id));
    await expect(handle.result).rejects.toThrow('native_stop_unconfirmed');
    expect(stop).toHaveBeenCalledTimes(2);
    expect(manager.quarantined()).toBe(true);
    manager.terminateGeneration(1);
    await expect(handle.terminal).resolves.toEqual({ kind: 'terminated', helperGeneration: 1 });
    expect(manager.quarantined()).toBe(false);
  });
  it('uses termination evidence when exit races an in-flight Stop', async () => {
    const { manager, query, stop } = setup();
    query.mockImplementation(() => new Promise(() => {}));
    const reply = deferred<unknown>();
    stop.mockImplementation(() => reply.promise);
    const handle = manager.begin({});
    manager.bindGeneration(handle.id, 1);
    await Promise.resolve();
    const stopping = handle.stop();
    await Promise.resolve();
    manager.terminateGeneration(1);
    await expect(stopping).resolves.toEqual({ kind: 'terminated', helperGeneration: 1 });
    reply.resolve(stopped(handle.id));
    await expect(handle.terminal).resolves.toEqual({ kind: 'terminated', helperGeneration: 1 });
    expect(manager.quarantined()).toBe(false);
  });
  it('releases a never-sent owner still waiting for query settlement after its generation exits', async () => {
    const { manager, query, cancelUnsubmitted } = setup();
    query.mockImplementation(() => new Promise(() => {}));
    cancelUnsubmitted.mockReturnValue('never_sent');
    const handle = manager.begin({});
    manager.bindGeneration(handle.id, 1);
    await Promise.resolve();
    await expect(handle.stop()).resolves.toEqual({ kind: 'not_submitted' });
    expect(manager.quarantined()).toBe(true);
    manager.terminateGeneration(1);
    expect(manager.quarantined()).toBe(false);
  });
  it('terminates only the exited generation and never adopts its late windows', async () => {
    const { manager, query, stop } = setup();
    const oldReply = deferred<unknown>();
    const newReply = deferred<unknown>();
    query
      .mockImplementationOnce(() => oldReply.promise)
      .mockImplementationOnce(() => newReply.promise);
    const old = manager.begin({});
    const fresh = manager.begin({});
    manager.bindGeneration(old.id, 1);
    manager.bindGeneration(fresh.id, 2);
    const terminal = vi.fn();
    void old.terminal.then(terminal);
    await Promise.resolve();
    manager.terminateGeneration(1);
    manager.terminateGeneration(1);
    await expect(old.result).rejects.toThrow('canceled');
    await expect(old.stop()).resolves.toEqual({ kind: 'terminated', helperGeneration: 1 });
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(manager.quarantined()).toBe(false);
    oldReply.resolve(completed(old.id, [{ stale: true }]));
    newReply.resolve(completed(fresh.id, [{ fresh: true }]));
    await expect(fresh.result).resolves.toEqual([{ fresh: true }]);
    await expect(old.terminal).resolves.toEqual({ kind: 'terminated', helperGeneration: 1 });
    expect(stop).not.toHaveBeenCalled();
  });
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

describe('PR11 discovery scope results', () => {
  it('returns the E4 termination result to its Task and Turn', async () => {
    const proof = {
      kind: 'terminated',
      helperGeneration: 1,
      result: 'terminated_target_suspect',
    } as const;
    const handle = {
      id: 'discovery',
      result: new Promise<readonly never[]>(() => {}),
      terminal: new Promise<never>(() => {}),
      stop: vi.fn(async () => proof),
    };
    const publish = vi.fn();
    const scope = new ComputerUseDiscoveryScope(
      'task-a',
      'turn-a',
      null,
      null,
      {
        beginWindowDiscovery: () => handle,
        listWindows: async () => [],
        subscribeWindowsStop: () => () => {},
      },
      () => {},
      undefined,
      publish,
    );
    const reading = scope
      .read({ id: 'profile-a' } as Parameters<typeof scope.read>[0])
      .catch((error) => error);
    expect(await scope.stop(true, 'task_changed')).toMatchObject({
      kind: 'discovery_result',
      taskId: 'task-a',
      turnId: 'turn-a',
      reason: 'task_changed',
      results: [proof],
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: 'task_changed', results: [proof] }),
    );
    expect(await reading).toHaveProperty('discoveryResult.results', [proof]);
    await scope.stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });
  it('publishes a late E4 exit once to the original Task and Turn without reviving Stop', async () => {
    let listener: WindowsStopListener = () => {};
    const publish = vi.fn();
    const handle = {
      id: 'discovery',
      result: new Promise<readonly never[]>(() => {}),
      terminal: new Promise<never>(() => {}),
      stop: vi.fn(async () => {
        throw new Error('native_stop_unconfirmed');
      }),
    };
    const scope = new ComputerUseDiscoveryScope(
      'task-a',
      'turn-a',
      null,
      null,
      {
        beginWindowDiscovery: () => handle,
        listWindows: async () => [],
        subscribeWindowsStop: (next) => {
          listener = next;
          return () => {};
        },
      },
      () => {},
      undefined,
      publish,
    );
    void scope.read({ id: 'profile-a' } as Parameters<typeof scope.read>[0]).catch(() => undefined);
    const owner = {
      kind: 'discovery',
      id: 'discovery',
      helperGeneration: 1,
      lifetimeId: 'lifetime-a',
    } as const;
    listener({ kind: 'registered', owner });
    const stopping = scope.stop(true, 'turn_started');
    await expect(stopping).rejects.toThrow('native_stop_unconfirmed');
    const notification = {
      owner,
      phase: 'exit_confirmed',
      result: 'terminated_clean',
      late: true,
      reason: 'requested_reason',
      internalReason: 'requested_stop',
    } as const;
    listener({
      kind: 'notification',
      notification: { ...notification, owner: { ...owner, lifetimeId: 'stale' } },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    listener({ kind: 'notification', notification });
    listener({ kind: 'notification', notification });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'discovery_result',
        late: true,
        taskId: 'task-a',
        turnId: 'turn-a',
        reason: 'turn_started',
        results: [{ kind: 'terminated', result: 'terminated_clean', helperGeneration: 1 }],
      }),
    );
    await expect(stopping).rejects.toThrow('native_stop_unconfirmed');
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it('retains native_unavailable for a discovery stopped by another owner', async () => {
    let listener: WindowsStopListener = () => {};
    const proof = { kind: 'terminated', helperGeneration: 1, result: 'terminated_clean' } as const;
    const handle = {
      id: 'discovery',
      result: new Promise<readonly never[]>(() => {}),
      terminal: new Promise<never>(() => {}),
      stop: async () => proof,
    };
    const scope = new ComputerUseDiscoveryScope(
      'task-b',
      'turn-b',
      null,
      null,
      {
        beginWindowDiscovery: () => handle,
        listWindows: async () => [],
        subscribeWindowsStop: (next) => {
          listener = next;
          return () => {};
        },
      },
      () => {},
    );
    void scope.read({ id: 'profile-b' } as Parameters<typeof scope.read>[0]).catch(() => undefined);
    const owner = {
      kind: 'discovery',
      id: 'discovery',
      helperGeneration: 1,
      lifetimeId: 'lifetime-b',
    } as const;
    listener({ kind: 'registered', owner });
    listener({
      kind: 'notification',
      notification: {
        owner,
        phase: 'exit_confirmed',
        result: 'terminated_clean',
        late: false,
        reason: 'native_unavailable',
        internalReason: 'shared_helper_stop',
      },
    });
    expect(await scope.stop()).toMatchObject({
      taskId: 'task-b',
      turnId: 'turn-b',
      reason: 'native_unavailable',
      results: [proof],
    });
  });

  it('does not resend failed E4 Stop through its scope', async () => {
    const handle = {
      id: 'discovery',
      result: new Promise<readonly never[]>(() => {}),
      terminal: new Promise<never>(() => {}),
      stop: vi.fn(async () => {
        throw new Error('native_stop_unconfirmed');
      }),
    };
    const scope = new ComputerUseDiscoveryScope(
      'task-a',
      'turn-a',
      null,
      null,
      {
        beginWindowDiscovery: () => handle,
        listWindows: async () => [],
        subscribeWindowsStop: () => () => {},
      },
      () => {},
    );
    void scope.read({ id: 'profile-a' } as Parameters<typeof scope.read>[0]).catch(() => undefined);
    await expect(scope.stop()).rejects.toThrow('native_stop_unconfirmed');
    await expect(scope.stop()).rejects.toThrow('native_stop_unconfirmed');
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });
});
