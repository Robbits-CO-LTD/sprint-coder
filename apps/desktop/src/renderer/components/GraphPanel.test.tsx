// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GraphView } from '@sprint-coder/contracts';
import { GraphPanel } from './GraphPanel';

// Development mode (renderer served by the Vite dev server) runs React's development build, so
// `main.tsx`'s StrictMode double-invokes mount effects. That makes the panel take TWO view leases
// from the Main service per mount and release the first one again — a sequence that only ever
// happens in development, and which issue #464 suspected of breaking node selection. These specs
// pin the invariant that matters: whatever the double mount does to the lease, a selection message
// from the artifact that is actually being displayed must still be accepted.

const taskId = '00000000-0000-4000-8000-000000000001';
const graphId = '00000000-0000-4000-8000-000000000002';

/**
 * Mirrors the observable lease contract of the real Main service (main/graph-render.ts):
 * `get` mints a fresh instanceId and rebinds both the lease and the served artifact to it,
 * `release` only drops the lease when the released instance is still the current one, and
 * `app://graph/<instanceId>` answers 404 unless it names the live lease.
 */
class FakeGraphService {
  instanceId = '00000000-0000-4000-8000-0000000000aa';
  /** The `data-graph-instance` baked into the currently served artifact HTML. */
  boundInstanceId = this.instanceId;
  viewRevision = 1;
  live = true;
  minted: string[] = [];
  released: string[] = [];
  get(): GraphView {
    const next = `00000000-0000-4000-8000-0000000001${String(this.minted.length + 1).padStart(2, '0')}`;
    this.minted.push(next);
    this.instanceId = next;
    this.boundInstanceId = next;
    this.viewRevision += 1;
    this.live = true;
    return {
      id: graphId,
      taskId,
      kind: 'architecture',
      title: 'Graph tool proposal',
      revision: 1,
      renderRevision: 1,
      digest: 'a'.repeat(64),
      instanceId: next,
      viewRevision: this.viewRevision,
      artifactUrl: `app://graph/${next}?theme=dark`,
      nodeIds: ['client', 'api', 'store'],
      edgeIds: ['request', 'persist'],
      annotations: [
        {
          elementKind: 'node',
          elementId: 'api',
          basis: 'inferred',
          rationale: 'APIの役割は推定です。',
        },
      ],
      missionPlan: null,
    };
  }
  release(instanceId: string): void {
    this.released.push(instanceId);
    if (this.instanceId === instanceId) this.live = false;
  }
  /** The `app://graph/<instanceId>` response: the served binding, or null for a 404. */
  fetch(instanceId: string): string | null {
    return this.live && this.instanceId === instanceId ? this.boundInstanceId : null;
  }
}

let root: Root | undefined;
let container: HTMLDivElement;
let service: FakeGraphService;

beforeEach(() => {
  service = new FakeGraphService();
  const graphs = {
    get: vi.fn(async () => service.get()),
    release: vi.fn(async (_taskId: string, instanceId: string) => {
      service.release(instanceId);
    }),
    subscribe: vi.fn(() => () => undefined),
    generation: vi.fn(async () => null),
    subscribeGeneration: vi.fn(() => () => undefined),
    // Source freshness is a separate panel; leave `checkSources` off the stub so these specs only
    // exercise the selection path.
    subscribeSources: vi.fn(() => () => undefined),
    sources: vi.fn(async () => []),
  };
  Object.defineProperty(window, 'sprintCoder', { configurable: true, value: { graphs } });
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  delete window.sprintCoder;
});

async function mount(strict: boolean): Promise<void> {
  root = createRoot(container);
  const panel = <GraphPanel taskId={taskId} onClose={() => undefined} />;
  await act(async () => {
    root!.render(strict ? <StrictMode>{panel}</StrictMode> : panel);
  });
}

/** Replays what the artifact's bridge script (main/graph-html.ts) posts on a node click. */
async function clickNodeInFrame(id: string): Promise<void> {
  const frame = container.querySelector('iframe');
  if (frame === null) throw new Error('the artifact frame was not rendered');
  const url = new URL(frame.getAttribute('src')!);
  const served = service.fetch(url.pathname.slice(1));
  if (served === null) throw new Error(`the displayed artifact ${url.pathname} answers 404`);
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'sprint-graph-selection',
          instanceId: served,
          graphId,
          revision: 1,
          kind: 'node',
          id,
        },
        source: frame.contentWindow,
      }),
    );
  });
}

it('accepts a node selection from the displayed artifact', async () => {
  await mount(false);
  expect(service.minted).toHaveLength(1);
  await clickNodeInFrame('api');
  expect(container.querySelector('[data-testid="graph-evidence-kind"]')?.textContent).toBe('推定');
});

it('keeps the displayed artifact live and selectable across a StrictMode double mount', async () => {
  await mount(true);
  // The development-only double mount takes two leases and releases the first one again.
  expect(service.minted).toHaveLength(2);
  expect(service.released).toEqual([service.minted[0]]);
  // Releasing the superseded lease must not expire the artifact that is on screen.
  expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
    `app://graph/${service.minted[1]!}?theme=dark`,
  );
  expect(service.fetch(service.minted[1]!)).toBe(service.minted[1]);
  await clickNodeInFrame('api');
  expect(container.querySelector('[data-testid="graph-evidence-kind"]')?.textContent).toBe('推定');
});

it('rejects a selection whose artifact instance is not the displayed one', async () => {
  await mount(false);
  // What a stale artifact — one served before a newer lease rebound it — would post.
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'sprint-graph-selection',
          instanceId: '00000000-0000-4000-8000-0000000009ff',
          graphId,
          revision: 1,
          kind: 'node',
          id: 'api',
        },
        source: container.querySelector('iframe')!.contentWindow,
      }),
    );
  });
  expect(container.querySelector('[data-testid="graph-sources"]')).toBeNull();
});
