import { describe, expect, it, vi } from 'vitest';
import { TaskTitleAbortRegistry, TaskTitleRuntimePool } from './task-title-runtime-pool';

describe('TaskTitleRuntimePool', () => {
  it('creates isolated, reusable hosts for each CLI kind', () => {
    const create = vi.fn((kind: 'codex' | 'claude' | 'grok') => ({ kind, dispose: vi.fn() }));
    const pool = new TaskTitleRuntimePool(create);

    expect(pool.get('codex')).toBe(pool.get('codex'));
    expect(pool.get('claude')).toBe(pool.get('claude'));
    expect(pool.get('codex')).not.toBe(pool.get('claude'));
    expect(pool.get('grok')).toBe(pool.get('grok'));
    expect(pool.get('grok')).not.toBe(pool.get('codex'));
    expect(pool.get('grok')).not.toBe(pool.get('claude'));
    expect(create.mock.calls.map(([kind]) => kind)).toEqual(['codex', 'claude', 'grok']);
  });

  it.each(['codex', 'claude', 'grok'] as const)(
    'disposes and recreates the %s background host',
    (kind) => {
      const runtimes: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
      const pool = new TaskTitleRuntimePool(() => {
        const runtime = { dispose: vi.fn() };
        runtimes.push(runtime);
        return runtime;
      });
      const first = pool.get(kind);

      pool.dispose();

      expect(first.dispose).toHaveBeenCalledOnce();
      expect(pool.get(kind)).not.toBe(first);
      expect(runtimes).toHaveLength(2);
    },
  );
});

describe('TaskTitleAbortRegistry', () => {
  it('aborts tracked provider requests while leaving completed requests alone', () => {
    const registry = new TaskTitleAbortRegistry();
    const active = new AbortController();
    const completed = new AbortController();
    registry.track(active);
    const releaseCompleted = registry.track(completed);
    releaseCompleted();

    registry.abortAll();

    expect(active.signal.aborted).toBe(true);
    expect(completed.signal.aborted).toBe(false);
  });
});
