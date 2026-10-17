// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, TeamDetail, TurnDiff } from '../../types/sprint-coder';
import { useAppStore } from '../../store/appStore';
import { Timeline } from './Timeline';

const initial = useAppStore.getState();

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    author: 'user',
    content: '依頼',
    attachments: [],
    createdAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  useAppStore.setState(initial, true);
  vi.unstubAllGlobals();
});

// The store is read through useSyncExternalStore, whose server snapshot is the initial state, so
// the Timeline is mounted in jsdom rather than rendered to static markup.
async function render(): Promise<string> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<Timeline taskId="task-1" />));
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
}

describe('Timeline history (issue #842)', () => {
  it('marks a Turn a restart interrupted under its partial reply, and leaves finished Turns alone', async () => {
    useAppStore.setState({
      messagesByTask: {
        'task-1': [
          message({ id: 'u1', turnId: 'turn-1', content: '最初の依頼' }),
          message({ id: 'a1', turnId: 'turn-1', author: 'assistant', content: '完了した回答' }),
          message({ id: 'u2', turnId: 'turn-2', content: '次の依頼' }),
          message({
            id: 'a2',
            turnId: 'turn-2',
            author: 'assistant',
            content: '…完了まで待機します。',
          }),
          message({ id: 'u3', turnId: 'turn-3', content: '書く前に止まった依頼' }),
        ],
      },
      interruptedTurnIdsByTask: { 'task-1': ['turn-2', 'turn-3'] },
    });
    const html = await render();
    const markers = html.match(/data-testid="turn-interrupted-marker"/gu) ?? [];
    expect(markers).toHaveLength(2);
    expect(html).toContain('role="note"');
    // The reply of turn-2 carries the marker right after it; turn-1 has none.
    const partial = html.indexOf('…完了まで待機します。');
    const replyMarker = html.indexOf('この回答は完了していません。');
    expect(partial).toBeGreaterThan(-1);
    expect(replyMarker).toBeGreaterThan(partial);
    expect(html.indexOf('完了した回答')).toBeLessThan(html.indexOf('turn-interrupted-marker'));
    // turn-3 wrote nothing, so the marker sits under the request.
    expect(html.indexOf('回答の前に止まりました。')).toBeGreaterThan(
      html.indexOf('書く前に止まった依頼'),
    );
  });

  it('renders no marker when nothing was interrupted', async () => {
    useAppStore.setState({
      messagesByTask: {
        'task-1': [
          message({ id: 'u1' }),
          message({ id: 'a1', author: 'assistant', content: '回答' }),
        ],
      },
    });
    expect(await render()).not.toContain('turn-interrupted-marker');
  });

  it('says why a Worker whose step failed waits for a resume, instead of 待機中', async () => {
    const diff: TurnDiff = {
      turnId: 'turn-1',
      entries: [
        {
          ordinal: 1,
          kind: 'update',
          path: 'src/client.ts',
          destination: null,
          preHash: null,
          postHash: null,
          provenance: 'agent_edit',
          status: 'applied',
          actualHash: null,
        },
      ],
    };
    useAppStore.setState({
      messagesByTask: {
        'task-1': [
          message({ id: 'u1' }),
          message({ id: 'a1', author: 'assistant', content: '回答' }),
        ],
      },
      turnDiffByTask: { 'task-1': diff },
      teamByTask: {
        'task-1': {
          workers: [
            { id: 'w1', role: 'implementer', state: 'waiting' },
            { id: 'w2', role: 'reviewer', state: 'waiting' },
          ],
          executions: [
            {
              id: 'e1',
              assigneeAgentId: 'w1',
              state: 'waiting_resume',
              terminalReason: 'worker_reported_failure',
              updatedAt: '2026-10-18T00:00:01.000Z',
            },
          ],
          activities: [],
          missions: [],
        } as unknown as TeamDetail,
      },
    });
    const html = await render();
    expect(html).toContain('Team内訳');
    expect(html).toContain('再開待ち: Workerが失敗を報告');
    // A Worker that is merely idle keeps its existing wording.
    expect(html).toContain('<span>reviewer</span><span>待機中</span>');
  });
});
