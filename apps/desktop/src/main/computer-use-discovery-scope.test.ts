import { expect, it, vi } from 'vitest';
import { ComputerUseDiscoveryScope } from './computer-use-discovery-scope';
import { createComputerUseDiscoveryManager } from './computer-use-native-discovery';

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
    expect(publish).not.toHaveBeenCalled();
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
