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

function displayedFrame(): HTMLIFrameElement {
  const frame = container.querySelector('iframe');
  if (frame === null) throw new Error('the artifact frame was not rendered');
  return frame;
}

/**
 * jsdom has no layout, so give the iframe element a box the forwarded coordinates can be measured
 * against, and watch what the panel posts into the artifact's window.
 */
function instrumentFrame(box: { left: number; top: number }): () => unknown[] {
  const frame = displayedFrame();
  frame.getBoundingClientRect = () =>
    ({ left: box.left, top: box.top, width: 600, height: 400 }) as DOMRect;
  const posted = vi.spyOn(frame.contentWindow!, 'postMessage');
  // Execution state goes down the same channel, so keep only the forwarded clicks.
  return () =>
    posted.mock.calls
      .map(([message]) => message)
      .filter(
        (message): message is Record<string, unknown> =>
          typeof message === 'object' &&
          message !== null &&
          Reflect.get(message, 'type') === 'sprint-graph-click',
      );
}

/** A click the parent renderer received on the iframe element instead of the frame consuming it. */
async function clickIframeElement(at: { clientX: number; clientY: number }): Promise<void> {
  const frame = displayedFrame();
  await act(async () => {
    frame.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...at }));
  });
}

/** The instance the displayed artifact was served with, or null if that URL answers 404. */
function servedInstance(): string | null {
  const url = new URL(displayedFrame().getAttribute('src')!);
  return service.fetch(url.pathname.slice(1));
}

async function postFromFrame(data: unknown): Promise<void> {
  const frame = displayedFrame();
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
  });
}

/** Replays the readiness announcement the bridge script posts once its listeners are registered. */
async function announceReady(): Promise<void> {
  const served = servedInstance();
  if (served === null) throw new Error('the displayed artifact answers 404');
  await postFromFrame({
    type: 'sprint-graph-ready',
    instanceId: served,
    graphId,
    revision: 1,
  });
}

/** Replays what the artifact's bridge script (main/graph-html.ts) posts on a node click. */
async function clickNodeInFrame(id: string): Promise<void> {
  const served = servedInstance();
  if (served === null) throw new Error('the displayed artifact answers 404');
  await postFromFrame({
    type: 'sprint-graph-selection',
    instanceId: served,
    graphId,
    revision: 1,
    kind: 'node',
    id,
  });
}

it('accepts a node selection from the displayed artifact', async () => {
  await mount(false);
  expect(service.minted).toHaveLength(1);
  await announceReady();
  await clickNodeInFrame('api');
  expect(container.querySelector('[data-testid="graph-evidence-kind"]')?.textContent).toBe('推定');
});

// Issue #464: the artifact's diagram is painted before its bridge script has registered the
// selection listeners, so a click in that window reaches the frame and is silently dropped. The
// panel must not present the frame as interactive until the displayed artifact says it is.
it('refuses pointer input until the displayed artifact announces its listeners', async () => {
  await mount(false);
  expect(displayedFrame().getAttribute('data-graph-ready')).toBe('0');
  expect(container.querySelector('[data-testid="graph-frame-pending"]')).not.toBeNull();
  await announceReady();
  expect(displayedFrame().getAttribute('data-graph-ready')).toBe('1');
  expect(container.querySelector('[data-testid="graph-frame-pending"]')).toBeNull();
});

// Issue #464's routing half: the artifact runs out of process, and until Chromium has registered
// its hit-test region a click aimed at the diagram is delivered to the parent renderer, arriving
// as a click on the iframe element. The panel forwards those so the artifact can replay them.
it('forwards a click the iframe element received into the displayed artifact', async () => {
  await mount(false);
  await announceReady();
  const forwarded = instrumentFrame({ left: 300, top: 100 });
  await clickIframeElement({ clientX: 956, clientY: 315 });
  expect(forwarded()).toEqual([
    {
      type: 'sprint-graph-click',
      instanceId: service.minted[0],
      graphId,
      revision: 1,
      x: 656,
      y: 215,
    },
  ]);
});

it('does not forward a click before the displayed artifact can handle it', async () => {
  await mount(false);
  const forwarded = instrumentFrame({ left: 300, top: 100 });
  await clickIframeElement({ clientX: 956, clientY: 315 });
  expect(forwarded()).toEqual([]);
  await announceReady();
  await clickIframeElement({ clientX: 956, clientY: 315 });
  expect(forwarded()).toHaveLength(1);
});

it('ignores a readiness announcement for an artifact that is not displayed', async () => {
  await mount(false);
  await postFromFrame({
    type: 'sprint-graph-ready',
    instanceId: '00000000-0000-4000-8000-0000000009ff',
    graphId,
    revision: 1,
  });
  expect(displayedFrame().getAttribute('data-graph-ready')).toBe('0');
});

it('goes back to refusing pointer input when a new artifact replaces the displayed one', async () => {
  await mount(false);
  await announceReady();
  expect(displayedFrame().getAttribute('data-graph-ready')).toBe('1');
  // A regenerated graph arrives on the subscription with a fresh lease, so the new artifact has to
  // announce itself again before it can be clicked.
  await act(async () => {
    const push = vi.mocked(window.sprintCoder!.graphs.subscribe).mock.calls[0]![0];
    push(service.get());
  });
  expect(displayedFrame().getAttribute('data-graph-ready')).toBe('0');
  await announceReady();
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
  await announceReady();
  await clickNodeInFrame('api');
  expect(container.querySelector('[data-testid="graph-evidence-kind"]')?.textContent).toBe('推定');
});

it('rejects a selection whose artifact instance is not the displayed one', async () => {
  await mount(false);
  await announceReady();
  // What a stale artifact — one served before a newer lease rebound it — would post.
  await postFromFrame({
    type: 'sprint-graph-selection',
    instanceId: '00000000-0000-4000-8000-0000000009ff',
    graphId,
    revision: 1,
    kind: 'node',
    id: 'api',
  });
  expect(container.querySelector('[data-testid="graph-sources"]')).toBeNull();
});
