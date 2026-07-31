import { describe, expect, it } from 'vitest';
import { RetryableActionRegistry } from './retryable-action';

describe('RetryableActionRegistry', () => {
  it('reuses a failed action and removes it only after success', async () => {
    const registry = new RetryableActionRegistry();
    let creates = 0;
    let attempts = 0;
    const create = () => {
      creates += 1;
      return async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient cancel failure');
      };
    };

    await expect(registry.run('turn-1', create)).rejects.toThrow('transient cancel failure');
    await expect(registry.run('turn-1', create)).resolves.toBeUndefined();
    await expect(registry.run('turn-1', create)).resolves.toBeUndefined();

    expect({ creates, attempts }).toEqual({ creates: 2, attempts: 3 });
  });
});
