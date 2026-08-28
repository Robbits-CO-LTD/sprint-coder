import { describe, expect, it, vi } from 'vitest';
import {
  OLLAMA_IMAGE_FIRST_EVENT_TIMEOUT_MS,
  PROVIDER_FIRST_EVENT_TIMEOUT_MS,
  providerEventsWithDeadline,
  providerFirstEventTimeoutMs,
} from './provider-stream-deadline';

function neverYields(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<string>>(() => undefined),
    }),
  };
}

async function* yieldsOnceThenWaits(): AsyncIterable<string> {
  yield 'first';
  await new Promise<never>(() => undefined);
}

describe('providerEventsWithDeadline', () => {
  it('allows bounded extra first-token time only for Ollama image requests', () => {
    expect(providerFirstEventTimeoutMs({ providerId: 'ollama', hasInlineImages: true })).toBe(
      OLLAMA_IMAGE_FIRST_EVENT_TIMEOUT_MS,
    );
    expect(providerFirstEventTimeoutMs({ providerId: 'ollama', hasInlineImages: false })).toBe(
      PROVIDER_FIRST_EVENT_TIMEOUT_MS,
    );
    expect(providerFirstEventTimeoutMs({ providerId: 'openrouter', hasInlineImages: true })).toBe(
      PROVIDER_FIRST_EVENT_TIMEOUT_MS,
    );
  });

  it('fails when the provider does not emit its first event', async () => {
    vi.useFakeTimers();
    try {
      const iterator = providerEventsWithDeadline(neverYields(), {
        executionId: 'turn-1:provider-call:1',
        firstEventTimeoutMs: 1_000,
        idleTimeoutMs: 2_000,
      })[Symbol.asyncIterator]();

      const next = iterator.next();
      const rejected = expect(next).rejects.toMatchObject({
        phase: 'first_event',
        executionId: 'turn-1:provider-call:1',
      });
      await vi.advanceTimersByTimeAsync(1_000);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets to the idle deadline after every event', async () => {
    vi.useFakeTimers();
    try {
      const iterator = providerEventsWithDeadline(yieldsOnceThenWaits(), {
        executionId: 'turn-2:provider-call:1',
        firstEventTimeoutMs: 1_000,
        idleTimeoutMs: 2_000,
      })[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toEqual({ done: false, value: 'first' });
      const next = iterator.next();
      const rejected = expect(next).rejects.toMatchObject({
        phase: 'idle',
        executionId: 'turn-2:provider-call:1',
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes normally without leaving a timer behind', async () => {
    vi.useFakeTimers();
    try {
      async function* events() {
        yield 'one';
      }
      const iterator = providerEventsWithDeadline(events(), {
        executionId: 'turn-3:provider-call:1',
        firstEventTimeoutMs: 1_000,
        idleTimeoutMs: 2_000,
      })[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toEqual({ done: false, value: 'one' });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the timeout when provider cleanup throws synchronously', async () => {
    vi.useFakeTimers();
    try {
      const source: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<string>>(() => undefined),
          return: () => {
            throw new Error('broken provider cleanup');
          },
        }),
      };
      const iterator = providerEventsWithDeadline(source, {
        executionId: 'turn-4:provider-call:1',
        firstEventTimeoutMs: 1_000,
        idleTimeoutMs: 2_000,
      })[Symbol.asyncIterator]();
      const next = iterator.next();
      const rejected = expect(next).rejects.toMatchObject({
        name: 'ProviderStreamTimeoutError',
        phase: 'first_event',
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
