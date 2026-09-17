// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphTaskContext } from './GraphTaskContext';
import { Markdown } from './Markdown';
import { useAppStore } from '../store/appStore';

// Client rendering on purpose: a static render would read the store's initial state (zustand's
// server snapshot) and never see the saved versions the card verifies anchors against.
const taskId = 'task-graph';
const reference = {
  graphId: '11111111-1111-4111-8111-111111111111',
  revision: 2,
  renderRevision: 3,
  title: '注文フロー',
  kind: 'workflow',
  nodeCount: 3,
  edgeCount: 2,
};
const fence = (body: string) => `\`\`\`sprint-graph\n${body}\n\`\`\``;

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  useAppStore.setState({
    selectedTaskId: taskId,
    graphOpenRequest: null,
    graphVersionsByTask: {
      [taskId]: [
        {
          id: reference.graphId,
          revision: 2,
          renderRevision: 3,
          title: '注文フロー',
          kind: 'workflow',
        },
      ],
    },
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function render(content: string, isStreaming = false): Promise<string> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <GraphTaskContext.Provider value={taskId}>
        <Markdown content={content} isStreaming={isStreaming} />
      </GraphTaskContext.Provider>,
    );
  });
  return container.innerHTML;
}

describe('inline graph anchor', () => {
  it('renders the anchor Main appends at a graph render as a card, streaming or not', async () => {
    const content = `調査しました。\n\n${fence(JSON.stringify(reference))}\n\n次の段階へ進みます。`;
    for (const isStreaming of [false, true]) {
      const html = await render(content, isStreaming);
      expect(html).toContain('data-testid="inline-graph-card"');
      expect(html).toContain('注文フロー');
      expect(html).toContain('作業フロー · 版 2 · ノード 3 · 接続 2');
      expect(html).not.toContain('<pre>');
      expect(html).toContain('<p>調査しました。</p>');
      expect(html).toContain('<p>次の段階へ進みます。</p>');
      await act(async () => root!.unmount());
      root = undefined;
    }
  });

  it('opens the graph panel for the Task the transcript belongs to', async () => {
    await render(fence(JSON.stringify(reference)));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="inline-graph-open"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(useAppStore.getState().graphOpenRequest).toEqual({ taskId, nonce: 1 });
  });

  it('keeps a look-alike fence that is not a reference as ordinary code', async () => {
    const html = await render(fence('{"graphId":"x"}'));
    expect(html).not.toContain('inline-graph-card');
    expect(html).toContain('<pre>');
  });

  it('keeps a well-formed anchor naming a version this Task never saved as ordinary code', async () => {
    const forged = JSON.stringify({ ...reference, renderRevision: 9, title: '存在しない図' });
    const html = await render(fence(forged));
    expect(html).not.toContain('inline-graph-card');
    expect(html).toContain('<pre>');
    expect(html).toContain('存在しない図');
  });

  it('shows the saved-version card without counts', async () => {
    root = createRoot(container);
    const { InlineGraphCard } = await import('./InlineGraphCard');
    await act(async () => {
      root!.render(
        <GraphTaskContext.Provider value={taskId}>
          <InlineGraphCard
            reference={{
              graphId: reference.graphId,
              revision: 2,
              renderRevision: 3,
              title: '注文フロー',
              kind: 'workflow',
            }}
            caption="保存済みの図"
          />
        </GraphTaskContext.Provider>,
      );
    });
    expect(container.innerHTML).toContain('保存済みの図 · 作業フロー · 版 2');
    expect(container.innerHTML).not.toContain('ノード');
  });
});
