import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore, type TurnRuntimeState } from '../store/appStore';
import { formatWorkElapsed } from '../lib/format';
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

  it('settles a completed Turn as a fold: status, compact duration and a rule, no stop', () => {
    const html = renderRunCard({ ...terminalTurn, status: 'completed', finishedAt: 12_000 });

    expect(html).toContain('完了');
    expect(html).toContain('12s');
    expect(html).toContain('run-rule');
    expect(html).not.toContain('run-stage-inline');
    expect(html).not.toContain('run-card-stop-button');
  });

  it('prints a running Turn left to right with stage, compact elapsed time and stop', () => {
    const { finishedAt: _settled, ...unsettled } = terminalTurn;
    const html = renderRunCard({ ...unsettled, status: 'running', startedAt: Date.now() });

    expect(html).toContain('思考中');
    expect(html).toContain('回答をまとめ中');
    expect(html).toContain('0s');
    expect(html).toContain('run-card-stop-button');
    expect(html).not.toContain('run-rule');
  });
});

describe('formatWorkElapsed', () => {
  it('formats seconds, minutes and hours compactly', () => {
    expect(formatWorkElapsed(-5)).toBe('0s');
    expect(formatWorkElapsed(12_900)).toBe('12s');
    expect(formatWorkElapsed(63_000)).toBe('1m 03s');
    expect(formatWorkElapsed(3_720_000)).toBe('1h 02m');
  });
});
