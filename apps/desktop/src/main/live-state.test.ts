import { describe, expect, it } from 'vitest';
import { workerStates } from '@sprint-coder/domain';
import { deriveLiveState, type LiveAgent } from './live-state';

const agent = (overrides: Partial<LiveAgent> = {}): LiveAgent => ({
  id: 'w-1',
  kind: 'worker',
  role: 'backend',
  state: 'busy',
  currentActivity: null,
  ...overrides,
});

const entry = (path: string, destination: string | null = null) => ({ path, destination });

describe('deriving live state from stored records', () => {
  it('reports a Worker that can still act', () => {
    expect(deriveLiveState({ agents: [agent()], diff: [] }).runningWorkers).toEqual([
      { id: 'w-1', role: 'backend', status: 'busy' },
    ]);
  });

  it('prefers what the Worker is doing over the state it is in', () => {
    const [worker] =
      deriveLiveState({
        agents: [agent({ currentActivity: 'running the test suite' })],
        diff: [],
      }).runningWorkers ?? [];
    expect(worker?.status).toBe('running the test suite');
  });

  it('drops Workers that have finished, failed, or been stopped', () => {
    const finished = workerStates.filter((state) => ['done', 'failed', 'stopped'].includes(state));
    const derived = deriveLiveState({
      agents: finished.map((state, index) => agent({ id: `w-${index}`, state })),
      diff: [],
    });
    expect(derived.runningWorkers).toEqual([]);
  });

  it('keeps every Worker the state machine can still move', () => {
    const active = workerStates.filter((state) => !['done', 'failed', 'stopped'].includes(state));
    const derived = deriveLiveState({
      agents: active.map((state, index) => agent({ id: `w-${index}`, state })),
      diff: [],
    });
    expect(derived.runningWorkers).toHaveLength(active.length);
  });

  it('does not tell the Leader that it is itself running', () => {
    const derived = deriveLiveState({
      agents: [agent({ id: 'leader-1', kind: 'leader', role: 'leader' }), agent()],
      diff: [],
    });
    expect(derived.runningWorkers?.map((worker) => worker.id)).toEqual(['w-1']);
  });

  it('yields nothing to restate when a task has no Team and nothing changed', () => {
    const derived = deriveLiveState({ agents: [], diff: [] });
    expect(derived.runningWorkers).toEqual([]);
    expect(derived.touchedPaths).toEqual([]);
  });
});

describe('which paths count as changed', () => {
  it('reports the paths the diff names', () => {
    const derived = deriveLiveState({
      agents: [],
      diff: [entry('src/a.ts'), entry('src/b.ts')],
    });
    expect(derived.touchedPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('reports a renamed file where it now is, not where it was', () => {
    const derived = deriveLiveState({ agents: [], diff: [entry('src/old.ts', 'src/new.ts')] });
    expect(derived.touchedPaths).toEqual(['src/new.ts']);
  });

  it('names a path once however many times the Turn touched it', () => {
    const derived = deriveLiveState({
      agents: [],
      diff: [entry('src/a.ts'), entry('src/b.ts'), entry('src/a.ts')],
    });
    expect(derived.touchedPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps the order the Turn first touched them', () => {
    const derived = deriveLiveState({
      agents: [],
      diff: [entry('z.ts'), entry('a.ts'), entry('m.ts')],
    });
    expect(derived.touchedPaths).toEqual(['z.ts', 'a.ts', 'm.ts']);
  });
});
