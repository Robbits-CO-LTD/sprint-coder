// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalSummary, ChatMessage } from '../../types/sprint-coder';
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
    createdAt: '2026-11-15T00:00:00.000Z',
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalSummary> & Pick<ApprovalSummary, 'id'>) {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    callId: `call-${overrides.id}`,
    state: 'canceled',
    decision: null,
    revision: 1,
    policyEpoch: 1,
    toolName: 'run_command',
    reason: 'Tool requests shell.execute',
    target: 'desktop-control',
    impact: 'execute',
    execution: 'desktop-control launch',
    risk: 'medium',
    capability: 'shell.execute',
    challenge: 'redacted',
    createdAt: '2026-11-15T00:00:01.000Z',
    expiresAt: '2026-11-15T01:00:00.000Z',
    desktopAction: {
      kind: 'launch',
      title: 'アプリを起動します',
      mode: 'background',
      target: { resolved: true, app: 'chrome.exe' },
      allowTaskGrant: false,
      notes: [],
      openDetails: false,
    },
    ...overrides,
  } satisfies ApprovalSummary;
}

const conversation = [
  message({ id: 'u1', content: 'Chrome を開いて' }),
  message({ id: 'a1', author: 'assistant', content: 'ツールの応答がまだ返っておらず' }),
];

afterEach(() => {
  useAppStore.setState(initial, true);
  vi.unstubAllGlobals();
});

async function render(): Promise<string> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<Timeline taskId="task-1" />));
  const html = container.innerHTML;
  await act(async () => root.unmount());
  return html;
}

describe('Timeline: a card its Turn left unanswered (issue #1285)', () => {
  it('says under the reply that the waiting operation was withdrawn and not run, and what it was', async () => {
    useAppStore.setState({
      messagesByTask: { 'task-1': conversation },
      approvalHistoryByTask: { 'task-1': [approval({ id: 'withdrawn' })] },
    });
    const html = await render();
    expect(html.match(/data-testid="approval-canceled-row"/gu) ?? []).toHaveLength(1);
    expect(html).toContain(
      '承認を待っていた操作は、答えが無いまま取り消されました。実行していません。',
    );
    expect(html).toContain('デスクトップ操作 · アプリを起動します アプリ「chrome.exe」');
    expect(html).toContain('role="note"');
    // After what the Turn said, not above it.
    expect(html.indexOf('approval-canceled-row')).toBeGreaterThan(
      html.indexOf('ツールの応答がまだ返っておらず'),
    );
    // It is not taken for a decision.
    expect(html).not.toContain('approval-audit-row');
  });

  it('sits under the request when the Turn wrote nothing, and names a non-desktop call by its target', async () => {
    useAppStore.setState({
      messagesByTask: { 'task-1': [message({ id: 'u1', content: '覚えておいて' })] },
      approvalHistoryByTask: {
        'task-1': [
          approval({
            id: 'memory',
            toolName: 'project_memory_remember',
            target: 'Project memory',
            desktopAction: undefined,
          }),
        ],
      },
    });
    const html = await render();
    expect(html).toContain('project_memory_remember · Project memory');
    expect(html.indexOf('approval-canceled-row')).toBeGreaterThan(html.indexOf('覚えておいて'));
  });

  it('leaves the cards of a stopped Turn unmarked, from the snapshot or while it stops', async () => {
    useAppStore.setState({
      messagesByTask: {
        'task-1': [
          ...conversation,
          message({ id: 'u2', turnId: 'turn-2', content: '次の依頼' }),
          message({ id: 'a2', turnId: 'turn-2', author: 'assistant', content: '途中' }),
        ],
      },
      approvalHistoryByTask: {
        'task-1': [approval({ id: 'one' }), approval({ id: 'two', turnId: 'turn-2' })],
      },
      canceledTurnIdsByTask: { 'task-1': ['turn-1'] },
      turnByTask: {
        'task-1': {
          turnId: 'turn-2',
          status: 'canceling',
        } as ReturnType<typeof useAppStore.getState>['turnByTask'][string],
      },
    });
    expect(await render()).not.toContain('approval-canceled-row');
  });

  it('keeps the rows of answered cards as they were', async () => {
    useAppStore.setState({
      messagesByTask: { 'task-1': conversation },
      approvalHistoryByTask: {
        'task-1': [
          approval({
            id: 'allowed',
            state: 'resolved',
            decision: 'allow_once',
            decidedAt: '2026-11-15T00:00:02.000Z',
          }),
          approval({
            id: 'denied',
            state: 'resolved',
            decision: 'deny',
            decidedAt: '2026-11-15T00:00:03.000Z',
          }),
        ],
      },
    });
    const html = await render();
    expect(html.match(/data-testid="approval-audit-row"/gu) ?? []).toHaveLength(2);
    expect(html).toContain('今回のみ許可しました');
    expect(html).toContain('拒否しました');
    expect(html).not.toContain('approval-canceled-row');
    // Under the request, as before.
    expect(html.indexOf('approval-audit-row')).toBeLessThan(
      html.indexOf('ツールの応答がまだ返っておらず'),
    );
  });
});
