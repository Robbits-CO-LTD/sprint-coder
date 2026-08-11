import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore, type TurnRuntimeState } from '../store/appStore';
import { RunCard } from './RunCard';

function renderRunCard(turn: TurnRuntimeState): string {
  return renderToStaticMarkup(<RunCard turn={turn} taskId="task-191" onStop={() => undefined} />);
}

describe('RunCard terminal status', () => {
  beforeEach(() => {
    useAppStore.setState({ reasoningSeenByTurn: {}, teamByTask: {} });
  });

  const terminalTurn: TurnRuntimeState = {
    turnId: 'turn-191',
    stage: 'synthesizing',
    runtimeStarting: false,
    reachedStageIndex: 4,
    status: 'failed',
    startedAt: 0,
    finishedAt: 1_000,
    streamingMessageId: 'message-191',
    streamingContent: '調査結果の本文',
  };

  it('settles a failed Turn with content as a partial answer', () => {
    const html = renderRunCard(terminalTurn);

    expect(html).toContain('失敗');
    expect(html).toContain('部分回答');
    expect(html).not.toContain('回答をまとめ中');
    expect(html).not.toContain('run-card-stop-button');
  });

  it('settles a failed Turn without content as incomplete', () => {
    const html = renderRunCard({
      ...terminalTurn,
      streamingMessageId: null,
      streamingContent: '',
    });

    expect(html).toContain('失敗');
    expect(html).toContain('未完了');
    expect(html).not.toContain('回答をまとめ中');
  });

  it('settles an interrupted Turn without content as incomplete', () => {
    const html = renderRunCard({
      ...terminalTurn,
      status: 'interrupted',
      streamingMessageId: null,
      streamingContent: '',
    });

    expect(html).toContain('中断');
    expect(html).toContain('未完了');
  });

  it('distinguishes Runtime startup from model understanding', () => {
    const html = renderRunCard({
      ...terminalTurn,
      stage: 'understanding',
      reachedStageIndex: 0,
      status: 'running',
      runtimeStarting: true,
      streamingMessageId: null,
      streamingContent: '',
    });

    expect(html).toContain('起動中');
    expect(html).toContain('Runtime起動待ち');
    expect(html).not.toContain('ユーザーの依頼を理解中');
  });
});
