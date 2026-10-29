import { expect, it, vi } from 'vitest';
import { ComputerUseDiscoveryScope } from './computer-use-discovery-scope';

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
