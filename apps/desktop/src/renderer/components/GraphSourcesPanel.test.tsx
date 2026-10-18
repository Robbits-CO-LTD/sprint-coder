// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GraphSourcePreview,
  GraphSourceRef,
  GraphSourceStatus,
  GraphView,
} from '@sprint-coder/contracts';
import { GraphSourcesPanel } from './GraphSourcesPanel';

const id = '00000000-0000-4000-8000-000000000001';
const source: GraphSourceRef = {
  id,
  elementKind: 'node',
  elementId: 'api',
  rootId: id,
  rootIdentityDigest: 'a'.repeat(64),
  path: 'source.ts',
  lineStart: 1,
  lineEnd: 1,
  contentHash: 'b'.repeat(64),
  excerptHash: 'c'.repeat(64),
  excerpt: 'return "original";',
  observedAt: '2026-10-18T00:00:00Z',
};
const view: GraphView = {
  id,
  taskId: id,
  instanceId: id,
  renderRevision: 1,
  revision: 1,
  viewRevision: 1,
  kind: 'architecture',
  title: 'Plan',
  digest: 'a'.repeat(64),
  artifactUrl: `app://graph/${id}?theme=dark`,
  nodeIds: ['api'],
  edgeIds: [],
};
function status(sequence: number): GraphSourceStatus {
  return {
    taskId: id,
    instanceId: id,
    renderRevision: 1,
    sequence,
    phase: 'checked',
    checkedAt: '2026-10-18T00:00:00Z',
    monitoring: true,
    sources: [{ sourceId: id, status: 'changed' }],
  };
}
function preview(currentExcerpt: string): GraphSourcePreview {
  return { source, status: 'changed', currentExcerpt, truncated: false };
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
async function mount(graphs: object, freshness = status(3)) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'sprintCoder', { configurable: true, value: { graphs } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await render(freshness);
}
async function render(freshness: GraphSourceStatus) {
  await act(async () =>
    root!.render(
      <GraphSourcesPanel
        view={view}
        selection={{
          type: 'sprint-graph-selection',
          instanceId: id,
          graphId: id,
          revision: 1,
          kind: 'node',
          id: 'api',
        }}
        freshness={freshness}
      />,
    ),
  );
}

describe('Graph source preview freshness', () => {
  it('uses the checked sequence even when the status prop has not caught up', async () => {
    const checkSources = vi.fn(async () => status(5));
    const previewSource = vi.fn(async () => preview('return "current";'));
    await mount({ sources: async () => [source], checkSources, previewSource });
    await act(async () => container.querySelector('button')!.click());
    await render(status(5));
    expect(container.textContent).toContain('return "current";');
    expect(previewSource).toHaveBeenCalledTimes(1);
  });

  it('rechecks a preview when monitoring advances during the explicit request', async () => {
    let resolveFirst!: (value: GraphSourcePreview) => void;
    const previewSource = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GraphSourcePreview>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(preview('return "after-recheck";'));
    await mount({
      sources: async () => [source],
      previewSource,
      checkSources: vi.fn().mockResolvedValueOnce(status(3)).mockResolvedValue(status(5)),
    });
    await act(async () => container.querySelector('button')!.click());
    await render(status(5));
    await act(async () => resolveFirst(preview('return "before-recheck";')));
    expect(previewSource).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('return "after-recheck";');
    expect(container.textContent).not.toContain('return "before-recheck";');
  });

  it('hides a completed preview after a later invalidation without reading automatically', async () => {
    const previewSource = vi.fn(async () => preview('return "current";'));
    await mount({
      sources: async () => [source],
      previewSource,
      checkSources: async () => status(3),
    });
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('return "current";');
    await render(status(5));
    expect(container.textContent).not.toContain('return "current";');
    expect(container.textContent).toContain('return "original";');
    expect(previewSource).toHaveBeenCalledTimes(1);
  });

  it('does not start a read after leaving the inspector while its monitor settles', async () => {
    let resolveCheck!: (value: GraphSourceStatus) => void;
    const checkSources = vi.fn(
      () =>
        new Promise<GraphSourceStatus>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const previewSource = vi.fn(async () => preview('return "current";'));
    await mount(
      { sources: async () => [source], previewSource, checkSources },
      {
        ...status(4),
        phase: 'checking',
        checkedAt: null,
        sources: [],
      },
    );
    await act(async () => container.querySelector('button')!.click());
    expect(previewSource).not.toHaveBeenCalled();
    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => resolveCheck(status(5)));
    expect(previewSource).not.toHaveBeenCalled();
  });
});
