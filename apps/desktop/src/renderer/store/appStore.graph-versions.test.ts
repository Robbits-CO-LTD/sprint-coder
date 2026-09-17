import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphView } from '@sprint-coder/contracts';
import { useAppStore } from './appStore';

const taskId = 'task-graph-versions';
const saved = (renderRevision: number) => ({
  id: '11111111-1111-4111-8111-111111111111',
  taskId,
  kind: 'workflow' as const,
  title: '注文フロー',
  semanticRevision: renderRevision,
  renderRevision,
  updatedAt: '2026-09-17T00:00:00.000Z',
});
const pushed = (renderRevision: number) =>
  ({
    id: saved(1).id,
    taskId,
    revision: renderRevision,
    renderRevision,
    title: '注文フロー',
    kind: 'workflow',
  }) as unknown as GraphView;
const renderRevisions = () =>
  useAppStore.getState().graphVersionsByTask[taskId]?.map((version) => version.renderRevision);

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ graphVersionsByTask: {}, graphVersionsStateByTask: {} });
});

describe('saved graph versions', () => {
  it('pages through history newest first and merges the versions later pushes carry', async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce({ versions: [saved(3), saved(2)], nextBeforeRenderRevision: 2 })
      .mockResolvedValueOnce({ versions: [saved(1)], nextBeforeRenderRevision: null });
    vi.stubGlobal('window', { sprintCoder: { graphs: { history } } });

    await useAppStore.getState().loadGraphVersions(taskId);

    expect(history).toHaveBeenNthCalledWith(1, { taskId });
    expect(history).toHaveBeenNthCalledWith(2, { taskId, beforeRenderRevision: 2 });
    expect(renderRevisions()).toEqual([3, 2, 1]);
    expect(useAppStore.getState().graphVersionsStateByTask[taskId]).toBe('loaded');

    useAppStore.getState().noteGraphVersion(pushed(4));
    useAppStore.getState().noteGraphVersion(pushed(3));
    expect(renderRevisions()).toEqual([4, 3, 2, 1]);
    expect(useAppStore.getState().graphVersionsByTask[taskId]?.[0]).toEqual({
      id: saved(1).id,
      revision: 4,
      renderRevision: 4,
      title: '注文フロー',
      kind: 'workflow',
    });
  });

  it('leaves the Task unknown rather than empty when history is unavailable', async () => {
    vi.stubGlobal('window', {
      sprintCoder: { graphs: { history: vi.fn().mockRejectedValue(new Error('offline')) } },
    });
    await useAppStore.getState().loadGraphVersions(taskId);
    expect(useAppStore.getState().graphVersionsByTask[taskId]).toBeUndefined();
    expect(useAppStore.getState().graphVersionsStateByTask[taskId]).toBe('unavailable');
  });
});
