// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphDiff, GraphVersionSummary, GraphView } from '@sprint-coder/contracts';
import { GraphHistoryPanel } from './GraphHistoryPanel';

const id = '00000000-0000-4000-8000-000000000001';
const view: GraphView = {
  id,
  taskId: id,
  kind: 'architecture',
  title: 'Current',
  revision: 3,
  renderRevision: 3,
  digest: 'a'.repeat(64),
  instanceId: id,
  viewRevision: 1,
  artifactUrl: `app://graph/${id}?theme=dark`,
  nodeIds: ['api'],
  edgeIds: [],
};
function version(n: number): GraphVersionSummary {
  return {
    id,
    taskId: id,
    kind: 'architecture',
    title: `Plan ${n}`,
    semanticRevision: n,
    renderRevision: n,
    updatedAt: '2026-09-11T00:00:00Z',
  };
}
function difference(n: number): GraphDiff {
  return {
    graphId: id,
    taskId: id,
    before: version(n),
    after: version(3),
    contentChanged: true,
    presentationOnly: false,
    changes: [
      {
        kind: 'node',
        id: 'api',
        action: 'changed',
        beforeLabel: 'Old',
        afterLabel: `Comparison ${n}`,
        fields: [{ name: 'label', before: 'Old', after: `Comparison ${n}` }],
      },
    ],
  };
}
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  delete window.sprintCoder;
  vi.unstubAllGlobals();
});
async function mount(graphs: object, currentView = view) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'sprintCoder', { configurable: true, value: { graphs } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<GraphHistoryPanel view={currentView} />));
}

describe('graph history comparison', () => {
  it('does not replace a newly selected comparison with a late older response', async () => {
    let resolveOlder!: (value: GraphDiff) => void;
    const older = new Promise<GraphDiff>((resolve) => {
      resolveOlder = resolve;
    });
    const compare = vi.fn(({ beforeRenderRevision }: { beforeRenderRevision: number }) =>
      beforeRenderRevision === 2 ? older : Promise.resolve(difference(1)),
    );
    await mount({
      history: vi
        .fn()
        .mockResolvedValue({
          versions: [version(3), version(2), version(1)],
          nextBeforeRenderRevision: null,
        }),
      compare,
    });
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="graph-diff"]')?.textContent).toContain(
      'Comparison 1',
    );
    await act(async () => resolveOlder(difference(2)));
    expect(container.querySelector('[data-testid="graph-diff"]')?.textContent).not.toContain(
      'Comparison 2',
    );
    expect(compare).toHaveBeenLastCalledWith({
      taskId: id,
      beforeRenderRevision: 1,
      afterRenderRevision: 3,
    });
  });

  it('loads older pages without dropping the selected comparison', async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce({ versions: [version(3), version(2)], nextBeforeRenderRevision: 2 })
      .mockResolvedValueOnce({ versions: [version(1)], nextBeforeRenderRevision: null });
    await mount({ history, compare: vi.fn().mockResolvedValue(difference(2)) });
    const button = container.querySelector('button')!;
    await act(async () => button.click());
    expect(history).toHaveBeenLastCalledWith({ taskId: id, beforeRenderRevision: 2 });
    expect([...container.querySelectorAll('option')].map((option) => option.value)).toEqual([
      '2',
      '1',
    ]);
    expect(container.querySelector('select')?.value).toBe('2');
    expect(container.querySelector('button')).toBeNull();
  });

  it('degrades explicitly when the preload does not provide version APIs', async () => {
    await mount({});
    expect(container.textContent).toContain('変更履歴を利用できません');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
