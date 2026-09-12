// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphSourceStatus, GraphView } from '@sprint-coder/contracts';
import { useGraphSourceStatus } from './use-graph-source-status';

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
const view: GraphView = {
  id: 'graph',
  taskId: 'task-a',
  instanceId: 'view-a',
  renderRevision: 1,
  revision: 1,
  viewRevision: 1,
  kind: 'architecture',
  title: 'Plan',
  digest: 'a'.repeat(64),
  artifactUrl: 'app://graph/view-a?theme=dark',
  nodeIds: ['api'],
  edgeIds: [],
};
const initial: GraphSourceStatus = {
  taskId: view.taskId,
  instanceId: view.instanceId,
  renderRevision: 1,
  sequence: 1,
  phase: 'checked',
  checkedAt: new Date().toISOString(),
  monitoring: true,
  sources: [{ sourceId: 'source-a', status: 'current' }],
};
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  function Probe({ current, selection }: { current: GraphView; selection: string | null }) {
    return createElement('output', null, JSON.stringify(useGraphSourceStatus(current, selection)));
  }
  return {
    root,
    state: () =>
      JSON.parse(container.textContent ?? '{}') as ReturnType<typeof useGraphSourceStatus>,
    render: (current = view, selection: string | null = null) =>
      act(async () => root.render(createElement(Probe, { current, selection }))),
  };
}

describe('graph source status subscription', () => {
  it('ignores old/cross-view results, refreshes on selection/focus and unsubscribes on exit', async () => {
    const listeners = new Set<(value: GraphSourceStatus) => void>();
    const checkSources = vi.fn(async () => initial);
    const unsubscribe = vi.fn();
    vi.stubGlobal('sprintCoder', {
      graphs: {
        checkSources,
        subscribeSources: (listener: (value: GraphSourceStatus) => void) => {
          listeners.add(listener);
          return () => {
            unsubscribe();
            listeners.delete(listener);
          };
        },
      },
    });
    const hook = mount();
    await hook.render();
    expect(hook.state().status).toEqual(initial);
    await act(async () => {
      for (const listener of listeners)
        listener({ ...initial, sequence: 3, phase: 'checking', checkedAt: null, sources: [] });
    });
    expect(hook.state().status?.phase).toBe('checking');
    await act(async () => {
      for (const listener of listeners) {
        listener({ ...initial, sequence: 2 });
        listener({ ...initial, instanceId: 'other', sequence: 9 });
        listener({ ...initial, taskId: 'other', sequence: 9 });
      }
    });
    expect(hook.state().status?.sequence).toBe(3);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(checkSources).toHaveBeenCalledTimes(2);
    expect(hook.state().status?.sequence).toBe(3);
    await hook.render(view, 'node:api');
    expect(checkSources).toHaveBeenCalledTimes(3);
    await act(async () => hook.root.unmount());
    expect(listeners.size).toBe(0);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(checkSources).toHaveBeenCalledTimes(3);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
  it('does not let an old failed request erase a newer event or another view', async () => {
    let fail!: (error: Error) => void;
    let listener!: (value: GraphSourceStatus) => void;
    const checkSources = vi.fn(
      () =>
        new Promise<GraphSourceStatus>((_resolve, reject) => {
          fail = reject;
        }),
    );
    vi.stubGlobal('sprintCoder', {
      graphs: {
        checkSources,
        subscribeSources: (callback: typeof listener) => {
          listener = callback;
          return () => {};
        },
      },
    });
    const hook = mount();
    await hook.render();
    await act(async () => listener({ ...initial, sequence: 4 }));
    await act(async () => {
      fail(new Error('late'));
    });
    expect(hook.state().error).toBe(false);
    expect(hook.state().status?.sequence).toBe(4);
    const oldListener = listener;
    await hook.render({ ...view, taskId: 'task-b', instanceId: 'view-b' });
    await act(async () => oldListener({ ...initial, sequence: 10 }));
    expect(hook.state().status).toBeNull();
  });
});
