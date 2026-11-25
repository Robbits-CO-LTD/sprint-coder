// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnEvent } from '@sprint-coder/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, TeamDetail, TurnDiff } from '../../types/sprint-coder';
import { useAppStore } from '../../store/appStore';
import { OPEN_PROVIDER_SETTINGS_EVENT } from '../../lib/settings-navigation';
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
async function render(interact?: (container: HTMLElement) => void): Promise<string> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<Timeline taskId="task-1" />));
  try {
    interact?.(container);
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
  }
}

it('places fixed API and CLI failure guidance on the matching historical Turns', async () => {
  useAppStore.setState({
    messagesByTask: {
      'task-1': [
        message({ id: 'a', turnId: 'api' }),
        message({ id: 'ap', turnId: 'api', author: 'assistant', content: '途中の回答' }),
        message({ id: 'b', turnId: 'cli' }),
        message({ id: 'c', turnId: 'old' }),
      ],
    },
    turnFailuresByTask: { 'task-1': { api: 'api_credentials', cli: 'cli_missing' } },
  });
  const openSettings = vi.fn();
  window.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, openSettings, { once: true });
  let html: string;
  try {
    html = await render((container) => {
      const action = container.querySelector<HTMLButtonElement>(
        '[data-testid="turn-failure-marker"] button',
      );
      expect(action).not.toBeNull();
      action?.click();
    });
    expect(openSettings).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener(OPEN_PROVIDER_SETTINGS_EVENT, openSettings);
  }
  expect(html.match(/data-testid="turn-failure-marker"/gu)).toHaveLength(2);
  expect(html.indexOf('途中の回答')).toBeLessThan(html.indexOf('APIキーを確認できませんでした'));
  expect(html.match(/接続設定を開く/gu)).toHaveLength(1);
  expect(html).toContain('CLIをインストールして');
});

describe('Timeline history (issue #842)', () => {
  it('shows the tools-disabled resend notice only for the affected request', async () => {
    useAppStore.setState({
      messagesByTask: {
        'task-1': [
          message({ id: 'u1', turnId: 'turn-1', content: '先の依頼' }),
          message({ id: 'u2', turnId: 'turn-2', content: '再送した依頼' }),
          message({ id: 'a2', turnId: 'turn-2', author: 'assistant', content: '回答' }),
        ],
      },
      toolsDisabledTurnIdsByTask: { 'task-1': ['turn-2'] },
    });
    const html = await render();
    const notices = html.match(/ツールなしで再送しました/gu) ?? [];
    expect(notices).toHaveLength(1);
    expect(html.indexOf('ツールなしで再送しました')).toBeGreaterThan(html.indexOf('再送した依頼'));
  });
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

  it('marks a steered Turn once, under its last request or its last reply', async () => {
    // steerTurn adds a further user message with the same Turn id.
    useAppStore.setState({
      messagesByTask: {
        'task-1': [
          message({ id: 'u1', turnId: 'turn-1', content: '最初の依頼' }),
          message({ id: 'u1b', turnId: 'turn-1', content: '途中での修正指示' }),
          message({ id: 'u2', turnId: 'turn-2', content: '次の依頼' }),
          message({ id: 'u2b', turnId: 'turn-2', content: '次の修正指示' }),
          message({ id: 'a2', turnId: 'turn-2', author: 'assistant', content: '途中の回答' }),
        ],
      },
      interruptedTurnIdsByTask: { 'task-1': ['turn-1', 'turn-2'] },
    });
    const html = await render();
    expect(html.match(/data-testid="turn-interrupted-marker"/gu) ?? []).toHaveLength(2);
    expect(html.match(/回答の前に止まりました。/gu) ?? []).toHaveLength(1);
    expect(html.indexOf('回答の前に止まりました。')).toBeGreaterThan(
      html.indexOf('途中での修正指示'),
    );
    expect(html.indexOf('回答の前に止まりました。')).toBeLessThan(html.indexOf('次の依頼'));
    expect(html.match(/この回答は完了していません。/gu) ?? []).toHaveLength(1);
    expect(html.indexOf('この回答は完了していません。')).toBeGreaterThan(
      html.indexOf('途中の回答'),
    );
  });

  it('drops the old stop reason once the step was resumed and waits to be admitted', async () => {
    useAppStore.setState({
      messagesByTask: {
        'task-1': [
          message({ id: 'u1' }),
          message({ id: 'a1', author: 'assistant', content: '回答' }),
        ],
      },
      turnDiffByTask: {
        'task-1': {
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
        },
      },
      teamByTask: {
        'task-1': {
          workers: [{ id: 'w1', role: 'implementer', state: 'waiting' }],
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
          missions: [
            {
              id: 'm1',
              state: 'running',
              steps: [
                { executionId: 'e1', state: 'waiting_resume', graph: { stepResumePending: true } },
              ],
            },
          ],
        } as unknown as TeamDetail,
      },
    });
    const html = await render();
    expect(html).toContain('<span>implementer</span><span>再開済み</span>');
    expect(html).not.toContain('Workerが失敗を報告');
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
            { id: 'w3', role: 'writer', state: 'done' },
          ],
          executions: [
            {
              id: 'e1',
              assigneeAgentId: 'w1',
              state: 'waiting_resume',
              terminalReason: 'worker_reported_failure',
              updatedAt: '2026-10-18T00:00:01.000Z',
            },
            // A failed execution is terminal history: a Worker that has done other work since keeps
            // the label of its own state, not an old 「失敗」.
            {
              id: 'e3',
              assigneeAgentId: 'w3',
              state: 'failed',
              terminalReason: 'worker_reported_failure',
              updatedAt: '2026-10-18T00:00:00.500Z',
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
    expect(html).toContain('<span>writer</span><span>完了</span>');
    expect(html).not.toContain('<span>writer</span><span>失敗');
  });
});

if (process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1')
  it.each(['live', 'during-open', 'replayed'] as const)(
    'shows one persisted GitHub stop notice through Timeline (%s)',
    async (timing) => {
      const { SqlitePersistenceClient } = await import('../../../main/persistence');
      const folder = mkdtempSync(join(tmpdir(), 'sc-stop-notice-renderer-'));
      const database = join(folder, 'sprint-coder.sqlite3');
      let persistence = new SqlitePersistenceClient(database);
      try {
        const target = persistence.createTask('GitHub Stop fixture');
        const other = persistence.createTask('Other fixture');
        const started = persistence.startTurn(target.id, 'Synthetic request');
        const notice =
          'GitHubから結果を確認できませんでした。二重投稿を避けるため、再送する前にリポジトリのIssue一覧を確認してください。';
        let deliver = (_event: TurnEvent): void => undefined;
        let stopped = false;
        let replayed = false;
        function stop() {
          stopped = true;
          const { event } = persistence.cancelTurnAndFinishGoal(target.id, started.turnId, notice);
          if (!event) throw new Error('Missing synthetic completion');
          return event;
        }
        vi.stubGlobal('sprintCoder', {
          tasks: {
            messages: async (taskId: string) => {
              if (taskId === target.id && !stopped && timing === 'replayed') stop();
              return persistence.listMessages(taskId);
            },
          },
          turns: {
            snapshot: async (taskId: string) => {
              if (taskId === target.id && !stopped && timing === 'during-open') stop();
              return persistence.snapshot(taskId);
            },
            subscribe: (
              taskId: string,
              handler: (event: TurnEvent) => void,
              options?: { afterSeq: number },
            ) => {
              deliver = handler;
              for (const event of persistence.listEventsAfter(taskId, options?.afterSeq ?? 0)) {
                if (event.type === 'turn.completed' && event.state === 'canceled') replayed = true;
                handler(event);
              }
              return () => undefined;
            },
          },
        });
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const container = document.createElement('div');
        const root = createRoot(container);
        try {
          await act(async () => {
            await useAppStore.getState().selectTask(target.id);
            root.render(<Timeline taskId={target.id} />);
          });
          if (timing === 'live') await act(async () => deliver(stop()));
          expect(replayed).toBe(timing === 'replayed');
          const verify = () => {
            expect(container.textContent?.split(notice)).toHaveLength(2);
            expect(container.querySelector('[data-testid="approval-canceled-row"]')).toBeNull();
          };
          verify();
          expect(
            container.querySelectorAll('[data-testid="run-card"][data-run-status="canceled"]'),
          ).toHaveLength(timing === 'during-open' ? 0 : 1);
          persistence.close();
          persistence = new SqlitePersistenceClient(database);
          await act(async () => {
            await useAppStore.getState().selectTask(other.id);
            await useAppStore.getState().selectTask(target.id);
          });
          verify();
          expect(container.querySelector('[data-testid="run-card"]')).toBeNull();
        } finally {
          await act(async () => root.unmount());
        }
      } finally {
        persistence.close();
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
