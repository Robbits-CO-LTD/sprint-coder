// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_BRIDGE_SCRIPT } from './graph-html';

// The bridge is a string executed inside the sandboxed artifact, so exercise it the way the
// artifact does: run it for real and drive it through `postMessage`. In a jsdom top-level window
// `window.parent === window`, so a message carrying `source: window` is what the bridge accepts as
// coming from its embedder, and its own announcements land on the same spy.
const instanceId = '00000000-0000-4000-8000-000000000001';
const graphId = '00000000-0000-4000-8000-000000000002';
const revision = 2;
let startup: unknown[] = [];
let posted: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  document.documentElement.dataset['graphId'] = graphId;
  document.documentElement.dataset['graphInstance'] = instanceId;
  document.documentElement.dataset['graphRevision'] = String(revision);
  const announcements = vi.spyOn(window, 'postMessage');
  new Function(GRAPH_BRIDGE_SCRIPT)();
  startup = announcements.mock.calls.map(([message]) => message);
  announcements.mockRestore();
});

beforeEach(() => {
  document.body.innerHTML =
    '<svg role="img"><g data-node-id="api"><text>api</text></g></svg><p id="empty">x</p>';
  posted = vi.spyOn(window, 'postMessage');
});

afterEach(() => {
  posted.mockRestore();
  Reflect.deleteProperty(document, 'elementFromPoint');
});

/** jsdom has no layout, so the hit test is the one thing that has to be stood in for. */
function hitTest(element: Element | null): void {
  document.elementFromPoint = (() => element) as typeof document.elementFromPoint;
}

function forward(overrides: Record<string, unknown> = {}, source: Window | null = window): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: 'sprint-graph-click',
        instanceId,
        graphId,
        revision,
        x: 40,
        y: 50,
        ...overrides,
      },
      source,
    }),
  );
}

function selections(): unknown[] {
  return posted.mock.calls
    .map(([message]) => message)
    .filter(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        Reflect.get(message, 'type') === 'sprint-graph-selection',
    );
}

describe('Graph artifact bridge', () => {
  it('announces that its listeners are registered as soon as it runs', () => {
    expect(startup).toEqual([{ type: 'sprint-graph-ready', instanceId, graphId, revision }]);
  });

  // Issue #464: Chromium delivers a click aimed at the out-of-process artifact to the parent
  // renderer until the frame's hit-test region is registered. The parent forwards those, and
  // replaying one here has to reach the bridge's own capture listener exactly as a real click does.
  it('replays a forwarded click on the element under the point', () => {
    hitTest(document.querySelector('[data-node-id="api"] text'));
    forward();
    expect(selections()).toEqual([
      { type: 'sprint-graph-selection', instanceId, graphId, revision, kind: 'node', id: 'api' },
    ]);
  });

  it('replays nothing when no element is under the point', () => {
    hitTest(null);
    forward();
    expect(selections()).toEqual([]);
  });

  it('ignores a forwarded click that did not come from its embedder', () => {
    hitTest(document.querySelector('[data-node-id="api"]'));
    forward({}, null);
    expect(selections()).toEqual([]);
  });

  it('ignores a forwarded click bound to another artifact, revision or instance', () => {
    const other = '00000000-0000-4000-8000-0000000009ff';
    for (const overrides of [
      { instanceId: other },
      { graphId: other },
      { revision: revision + 1 },
    ]) {
      hitTest(document.querySelector('[data-node-id="api"]'));
      forward(overrides);
    }
    expect(selections()).toEqual([]);
  });

  it('ignores a forwarded point that is not a finite coordinate inside the frame', () => {
    for (const overrides of [
      { x: Number.NaN },
      { y: Number.POSITIVE_INFINITY },
      { x: '40' },
      { x: -1 },
      { y: -1 },
      { x: window.innerWidth + 1 },
      { y: window.innerHeight + 1 },
    ]) {
      hitTest(document.querySelector('[data-node-id="api"]'));
      forward(overrides);
    }
    expect(selections()).toEqual([]);
  });

  it('still reports a real click on a node without any forwarding', () => {
    document
      .querySelector('[data-node-id="api"] text')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(selections()).toEqual([
      { type: 'sprint-graph-selection', instanceId, graphId, revision, kind: 'node', id: 'api' },
    ]);
  });
});
