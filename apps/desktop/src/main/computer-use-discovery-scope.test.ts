import { expect, it, vi } from 'vitest';
import { ComputerUseDiscoveryScope } from './computer-use-discovery-scope';
import { createComputerUseDiscoveryManager } from './computer-use-native-discovery';

it('keeps the stop failure as cause and reports unconfirmed native drain through run', async () => {
  const failure = new Error('query failed');
  const stopFailure = new Error('handle stop failed');
  const stop = vi.fn(async () => {
    throw stopFailure;
  });
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
    null,
    null,
    {
      listWindows: async () => [],
      beginWindowDiscovery: () => ({
        id: 'discovery',
        result: Promise.reject(failure),
        terminal: new Promise(() => {}),
        stop,
      }),
    },
    vi.fn(),
  );
  const reading = scope.run(() =>
    scope.read({ id: 'profile' } as Parameters<typeof scope.read>[0]),
  );
  const rejection = await reading.then(
    () => undefined,
    (error: unknown) => error,
  );
  // A fresh error: the drained rejection is shared, so it is never mutated.
  expect(rejection).not.toBe(stopFailure);
  expect(stopFailure).not.toHaveProperty('discoveryResult');
  expect(stopFailure).not.toHaveProperty('cause');
  expect(rejection).toMatchObject({
    reasonCode: 'native_stop_unconfirmed',
    cause: stopFailure,
    discoveryResult: {
      kind: 'discovery_result',
      late: false,
      taskId: 'task',
      turnId: 'turn',
      reason: 'native_stop_unconfirmed',
      results: [],
    },
  });
  expect(stop).toHaveBeenCalledTimes(1);
});

it('includes a handle completed after an earlier drain in the next Stop', async () => {
  const proof = { kind: 'not_submitted' } as const;
  let complete!: (value: typeof proof) => void;
  const terminal = new Promise<typeof proof>((resolve) => {
    complete = resolve;
  });
  const stop = vi.fn(async () => proof);
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
    null,
    null,
    {
      listWindows: async () => [],
      beginWindowDiscovery: () => ({
        id: 'late',
        result: Promise.reject(new Error('query failed')),
        terminal,
        stop,
      }),
    },
    vi.fn(),
  );
  await expect(scope.read({ id: 'profile' } as Parameters<typeof scope.read>[0])).rejects.toThrow(
    'query failed',
  );
  complete(proof);
  await terminal;
  expect(await scope.stop(true, 'policy_changed')).toMatchObject({
    reason: 'policy_changed',
    results: [proof],
  });
  expect(stop).toHaveBeenCalledTimes(1);
});

it.each([
  { result: 'terminated_clean', automatic: false },
  { result: 'terminated_target_suspect', automatic: false },
  { result: 'terminated_clean', automatic: true },
  { result: 'terminated_target_suspect', automatic: true },
] as const)(
  'retains $result evidence when terminal precedes rejection (automatic=$automatic)',
  async ({ result, automatic }) => {
    const manager = createComputerUseDiscoveryManager({
      query: () => (automatic ? Promise.reject(new Error('query failed')) : new Promise(() => {})),
      stop: async () => {
        throw new Error('unconfirmed');
      },
      cancelUnsubmitted: () => 'may_have_been_sent',
      timeoutMs: 10,
      attemptLimit: 1,
      unconfirmedError: () => new Error('unconfirmed'),
      terminationResult: () => result,
      terminate: async (helperGeneration) => {
        manager.terminateGeneration(helperGeneration);
        return { kind: 'terminated', helperGeneration, result };
      },
    });
    const handle = manager.begin({});
    manager.bindGeneration(handle.id, 1);
    const publish = vi.fn();
    const scope = new ComputerUseDiscoveryScope(
      'task',
      'turn',
      null,
      null,
      {
        listWindows: async () => [],
        beginWindowDiscovery: () => ({ ...handle, result: handle.result.then(() => []) }),
      },
      vi.fn(),
      undefined,
      publish,
    );
    const reading = scope.run(() =>
      scope.read({ id: 'profile' } as Parameters<typeof scope.read>[0]),
    );
    const rejected = expect(reading).rejects.toMatchObject({
      discoveryResult: {
        reason: 'native_unavailable',
        results: [{ kind: 'terminated', helperGeneration: 1, result }],
      },
    });
    if (!automatic) manager.terminateGeneration(1);
    await rejected;
    // The same in-time result reaches the Controller once; IPC decides where it belongs.
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      kind: 'discovery_result',
      late: false,
      taskId: 'task',
      turnId: 'turn',
      reason: 'native_unavailable',
      results: [{ kind: 'terminated', helperGeneration: 1, result }],
    });
    expect(await scope.stop(true, 'policy_changed')).toMatchObject({
      reason: 'policy_changed',
      results: [{ kind: 'terminated', helperGeneration: 1, result }],
    });
  },
);

it('checks cancellation after work resolves but before returning its result', async () => {
  const abort = new AbortController();
  const retired = vi.fn();
  const native = { listWindows: async () => [] };
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
    null,
    null,
    native,
    retired,
    abort.signal,
  );
  const rollback = vi.fn();
  scope.onCancel(rollback);
  const result = scope.run(async () => {
    queueMicrotask(() => abort.abort());
    return 'late target tokens';
  });
  await expect(result).rejects.toThrow('discovery canceled');
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(retired).toHaveBeenCalled();
});

it('does not publish or latch user_stop on an internal failure before policy Stop', async () => {
  const publish = vi.fn();
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
    null,
    null,
    { listWindows: async () => [], subscribeWindowsStop: () => () => {} },
    vi.fn(),
    undefined,
    publish,
  );
  const failure = new Error('internal failure');
  const rollback = vi.fn();
  scope.onCancel(rollback);
  await expect(
    scope.run(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(publish).not.toHaveBeenCalled();
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(() => scope.check()).toThrow(failure);
  expect(await scope.stop(true, 'policy_changed')).toMatchObject({ reason: 'policy_changed' });
});

it('uses the calling signal stop reason', async () => {
  const abort = new AbortController();
  const publish = vi.fn();
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
    null,
    null,
    { listWindows: async () => [] },
    vi.fn(),
    abort.signal,
    publish,
  );
  abort.abort('policy_changed');
  expect(await scope.stop()).toMatchObject({ reason: 'policy_changed' });
});

it('shares internal native cleanup with a later policy Stop without latching its reason early', async () => {
  let finish!: (proof: { kind: 'not_submitted' }) => void;
  const draining = new Promise<{ kind: 'not_submitted' }>((resolve) => {
    finish = resolve;
  });
  const failure = new Error('discovery failed');
  const stop = vi.fn(() => draining);
  const publish = vi.fn();
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
    null,
    null,
    {
      listWindows: async () => [],
      beginWindowDiscovery: () => ({
        id: 'discovery',
        result: Promise.reject(failure),
        terminal: draining,
        stop,
      }),
      subscribeWindowsStop: () => () => {},
    },
    vi.fn(),
    undefined,
    publish,
  );
  const reading = scope.run(() =>
    scope.read({ id: 'profile' } as Parameters<typeof scope.read>[0]),
  );
  const rejected = expect(reading).rejects.toBe(failure);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  expect(publish).not.toHaveBeenCalled();
  const stopping = scope.stop(true, 'policy_changed');
  finish({ kind: 'not_submitted' });
  await rejected;
  expect(await stopping).toMatchObject({ reason: 'policy_changed' });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ reason: 'policy_changed' }),
  );
});

it('reports an internal unconfirmed stop in time and delivers its late exit once as native_unavailable', async () => {
  let listener: Parameters<
    NonNullable<ConstructorParameters<typeof ComputerUseDiscoveryScope>[4]['subscribeWindowsStop']>
  >[0] = () => {};
  const publish = vi.fn();
  const stopFailure = new Error('native_stop_unconfirmed');
  const handle = {
    id: 'discovery',
    // The manager's automatic Stop after the query failure could not be confirmed.
    result: Promise.reject(new Error('native_stop_unconfirmed')),
    terminal: new Promise<never>(() => {}),
    stop: vi.fn(async () => {
      throw stopFailure;
    }),
  };
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
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
    vi.fn(),
    undefined,
    publish,
  );
  const owner = {
    kind: 'discovery',
    id: 'discovery',
    helperGeneration: 1,
    lifetimeId: 'lifetime',
  } as const;
  const reading = scope.run(async () => {
    const pending = scope.read({ id: 'profile' } as Parameters<typeof scope.read>[0]);
    listener({ kind: 'registered', owner });
    return await pending;
  });
  const failure = await reading.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error,
  );
  expect(failure).not.toBe(stopFailure);
  expect(failure).toMatchObject({
    message: 'native_stop_unconfirmed',
    cause: stopFailure,
    discoveryResult: { late: false, reason: 'native_stop_unconfirmed', results: [] },
  });
  expect(stopFailure).not.toHaveProperty('discoveryResult');
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ late: false, reason: 'native_stop_unconfirmed' }),
  );
  const notification = {
    owner,
    phase: 'exit_confirmed',
    result: 'terminated_target_suspect',
    late: true,
    reason: 'requested_reason',
    internalReason: 'requested_stop',
  } as const;
  listener({ kind: 'notification', notification });
  listener({ kind: 'notification', notification });
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenLastCalledWith({
    kind: 'discovery_result',
    late: true,
    taskId: 'task',
    turnId: 'turn',
    reason: 'native_unavailable',
    results: [{ kind: 'terminated', helperGeneration: 1, result: 'terminated_target_suspect' }],
  });
  expect(handle.stop).toHaveBeenCalledTimes(1);
});

it('wraps a non-Error stop failure without throwing it raw', async () => {
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
    null,
    null,
    {
      listWindows: async () => [],
      beginWindowDiscovery: () => ({
        id: 'discovery',
        result: Promise.reject(new Error('query failed')),
        terminal: new Promise(() => {}),
        stop: () => Promise.reject('opaque'),
      }),
      subscribeWindowsStop: () => () => {},
    },
    vi.fn(),
  );
  await expect(
    scope.read({ id: 'profile' } as Parameters<typeof scope.read>[0]),
  ).rejects.toMatchObject({
    message: 'native_stop_unconfirmed',
    cause: 'opaque',
    discoveryResult: { reason: 'native_stop_unconfirmed' },
  });
});

type StopListener = Parameters<
  NonNullable<ConstructorParameters<typeof ComputerUseDiscoveryScope>[4]['subscribeWindowsStop']>
>[0];
const lateExit = (
  owner: { kind: 'discovery'; id: string; helperGeneration: number; lifetimeId: string },
  reason: 'requested_reason' | 'native_unavailable' = 'requested_reason',
) =>
  ({
    kind: 'notification',
    notification: {
      owner,
      phase: 'exit_confirmed',
      result: 'terminated_clean',
      late: true,
      reason,
      internalReason: 'requested_stop',
    },
  }) as const;

it('keeps listening after run() fails and finishes until the unconfirmed owner exits', async () => {
  let listener: StopListener = () => {};
  const unsubscribe = vi.fn();
  const publish = vi.fn();
  let retireGeneration!: (proof: { kind: 'terminated'; helperGeneration: number }) => void;
  const handle = {
    id: 'discovery',
    result: Promise.reject(new Error('native_stop_unconfirmed')),
    terminal: new Promise<{ kind: 'terminated'; helperGeneration: number }>((resolve) => {
      retireGeneration = resolve;
    }),
    stop: vi.fn(async () => {
      throw new Error('native_stop_unconfirmed');
    }),
  };
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
    null,
    null,
    {
      beginWindowDiscovery: () => handle,
      listWindows: async () => [],
      subscribeWindowsStop: (next) => {
        listener = next;
        return unsubscribe;
      },
    },
    vi.fn(),
    undefined,
    publish,
  );
  const owner = {
    kind: 'discovery',
    id: 'discovery',
    helperGeneration: 1,
    lifetimeId: 'lifetime',
  } as const;
  await expect(
    scope.run(async () => {
      const pending = scope.read({ id: 'profile' } as Parameters<typeof scope.read>[0]);
      listener({ kind: 'registered', owner });
      listener({
        kind: 'notification',
        notification: {
          owner,
          phase: 'termination_pending',
          result: 'termination_requested',
          late: false,
          reason: 'requested_reason',
          internalReason: 'requested_stop',
        },
      });
      return await pending;
    }),
  ).rejects.toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
  // The generation's cleanup resolves the handle's terminal before its late exit is delivered.
  retireGeneration({ kind: 'terminated', helperGeneration: 1 });
  await handle.terminal;
  await Promise.resolve();
  expect(unsubscribe).not.toHaveBeenCalled();
  publish.mockClear();
  listener(lateExit(owner));
  listener(lateExit(owner));
  expect(publish).toHaveBeenCalledExactlyOnceWith({
    kind: 'discovery_result',
    late: true,
    taskId: 'task',
    turnId: 'turn',
    reason: 'native_unavailable',
    results: [{ kind: 'terminated', helperGeneration: 1, result: 'terminated_clean' }],
  });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('registers the stop owner of a handle that completed before its registration', async () => {
  let listener: StopListener = () => {};
  const publish = vi.fn();
  const handle = {
    id: 'discovery',
    result: Promise.resolve([]),
    terminal: Promise.resolve({ kind: 'completed', launchAttemptCount: 1 } as const),
    stop: vi.fn(async () => {
      throw new Error('native_stop_unconfirmed');
    }),
  };
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
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
    vi.fn(),
    undefined,
    publish,
  );
  await scope.read({ id: 'profile' } as Parameters<typeof scope.read>[0]);
  await handle.terminal;
  await Promise.resolve();
  const owner = {
    kind: 'discovery',
    id: 'discovery',
    helperGeneration: 1,
    lifetimeId: 'lifetime',
  } as const;
  listener({ kind: 'registered', owner });
  await expect(scope.stop(true, 'task_changed')).rejects.toMatchObject({
    reasonCode: 'native_stop_unconfirmed',
    cause: expect.any(Error),
    discoveryResult: { reason: 'native_stop_unconfirmed' },
  });
  publish.mockClear();
  listener(lateExit(owner));
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ late: true, reason: 'task_changed' }),
  );
});

it.each([
  { proof: null, aborts: true },
  { proof: { kind: 'terminated', helperGeneration: 1 } as const, aborts: true },
  { proof: { kind: 'not_submitted' } as const, aborts: false },
  { proof: { kind: 'stopped', launchAttemptCount: 1 } as const, aborts: false },
  { proof: { kind: 'completed', launchAttemptCount: 0 } as const, aborts: false },
])('aborts the whole scope only for an unconfirmed or terminated stop ($proof)', async (row) => {
  const failure = new Error('query failed');
  const scope = new ComputerUseDiscoveryScope(
    'task',
    'turn',
    null,
    null,
    {
      listWindows: async () => [],
      beginWindowDiscovery: () => ({
        id: 'discovery',
        result: Promise.reject(failure),
        terminal: new Promise(() => {}),
        stop: async () => {
          if (row.proof === null) throw new Error('unconfirmed');
          return row.proof;
        },
      }),
      subscribeWindowsStop: () => () => {},
    },
    vi.fn(),
  );
  const rejection = await scope
    .read({ id: 'profile' } as Parameters<typeof scope.read>[0])
    .catch((error: unknown) => error);
  expect(scope.signal.aborted).toBe(row.aborts);
  if (row.aborts) {
    expect(rejection).not.toBe(failure);
    expect(() => scope.check()).toThrow();
  } else {
    expect(rejection).toBe(failure);
    expect(() => scope.check()).not.toThrow();
  }
});
