import { describe, expect, it } from 'vitest';
import type { TeamExecutionSummary, TeamMessageSummary } from '../types/sprint-coder';
import {
  executionNeedsAttention,
  workerGlance,
  workerReportText,
  workerThread,
  workStepIcon,
  workStepLabel,
} from './worker-thread';

function message(id: string, createdAt: string): TeamMessageSummary {
  return {
    id,
    teamId: 'team',
    sourceAgentId: 'leader',
    targetAgentId: 'worker',
    sourceKind: 'leader',
    targetKind: 'worker',
    seq: 1,
    state: 'delivered',
    content: id,
    executionId: null,
    attemptId: null,
    deliveryState: null,
    attempt: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('workerThread', () => {
  it('merges messages and steps by time, the request before a step recorded in the same instant', () => {
    const thread = workerThread(
      [
        message('request', '2026-10-20T10:00:00.000Z'),
        message('report', '2026-10-20T10:00:09.000Z'),
      ],
      [
        { kind: 'activity', label: 'read_file', at: '2026-10-20T10:00:00.000Z' },
        { kind: 'fileChange', label: '編集 a.ts', at: '2026-10-20T10:00:05.000Z' },
      ],
    );
    expect(
      thread.map((item) => (item.kind === 'message' ? item.message.id : item.step.label)),
    ).toEqual(['request', 'read_file', '編集 a.ts', 'report']);
  });
});

describe('work step presentation', () => {
  it('names a tool call by the tool, and keeps any other label as written', () => {
    expect(workStepLabel('Workerがread_fileを実行中')).toBe('read_file');
    expect(workStepLabel('Managerがteam_hire_workerを実行中')).toBe('team_hire_worker');
    expect(workStepLabel('依頼を処理中')).toBe('依頼を処理中');
  });

  it('picks an icon from what the step did', () => {
    const at = '2026-10-20T10:00:00.000Z';
    expect(workStepIcon({ kind: 'fileChange', label: '編集 a.ts', at })).toBe('edit');
    expect(workStepIcon({ kind: 'activity', label: 'Workerがgrepを実行中', at })).toBe('search');
    expect(workStepIcon({ kind: 'activity', label: 'Workerがread_fileを実行中', at })).toBe('read');
    expect(workStepIcon({ kind: 'activity', label: 'Workerがrun_commandを実行中', at })).toBe(
      'tool',
    );
    expect(workStepIcon({ kind: 'activity', label: '依頼を処理中', at })).toBe('status');
  });
});

describe('executionNeedsAttention', () => {
  const base = { state: 'running', isolation: null } as unknown as TeamExecutionSummary;

  it('keeps an ordinary run behind the details', () => {
    expect(executionNeedsAttention(null)).toBe(false);
    expect(executionNeedsAttention(base)).toBe(false);
    expect(executionNeedsAttention({ ...base, state: 'completed' })).toBe(false);
  });

  it('surfaces waits, failures and resumes on the card', () => {
    for (const state of ['waiting_resume', 'waiting_rate_limit', 'queued', 'failed'] as const)
      expect(executionNeedsAttention({ ...base, state })).toBe(true);
  });
});

describe('workerGlance', () => {
  const idle = {
    id: 'worker',
    state: 'ready',
    reasoningActive: false,
    currentActivity: null,
    liveOutput: '',
  } as const;

  it('names the state in words and says what an idle Worker is waiting for', () => {
    expect(workerGlance(idle, [])).toEqual({
      state: '待機中',
      line: 'Leaderからの依頼を待っています',
    });
    expect(workerGlance({ ...idle, state: 'done' }, [])).toEqual({ state: '完了', line: '' });
    expect(workerGlance({ ...idle, state: 'stopped' }, []).state).toBe('停止済み');
    expect(workerGlance({ ...idle, state: 'failed' }, []).state).toBe('失敗');
    expect(workerGlance({ ...idle, state: 'spawning' }, []).state).toBe('準備中');
  });

  it('prefers what a busy Worker is doing now over its thread', () => {
    const thread = workerThread([message('依頼の本文', '2026-10-20T10:00:00.000Z')], []);
    const busy = { ...idle, state: 'busy' } as const;
    expect(workerGlance({ ...busy, currentActivity: 'Workerがread_fileを実行中' }, thread)).toEqual(
      { state: '作業中', line: 'read_file' },
    );
    expect(
      workerGlance({ ...busy, reasoningActive: true, liveOutput: '一行目\n\n二行目\n' }, thread),
    ).toEqual({ state: '思考中', line: '二行目' });
    // The card shows streaming text raw, so the glance keeps it as written too.
    expect(
      workerGlance({ ...busy, liveOutput: 'from __init__.py import *x*\n' }, thread).line,
    ).toBe('from __init__.py import *x*');
    expect(workerGlance(busy, thread).line).toBe('依頼の本文');
  });

  it('shows the newest step or message, its report unwrapped and its Markdown as prose', () => {
    const step = workerThread(
      [],
      [{ kind: 'fileChange', label: 'Workerがedit_fileを実行中', at: '2026-10-20T10:00:00.000Z' }],
    );
    expect(workerGlance(idle, step).line).toBe('edit_file');

    const report = {
      ...message('report', '2026-10-20T10:00:09.000Z'),
      sourceAgentId: 'worker',
      content: JSON.stringify({ summary: '## **原因**を特定\n詳細は後述' }),
    };
    expect(workerGlance({ ...idle, state: 'done' }, workerThread([report], []))).toEqual({
      state: '完了',
      line: '原因を特定',
    });
    expect(
      workerGlance(idle, workerThread([{ ...report, content: 'x'.repeat(300) }], [])).line,
    ).toBe(`${'x'.repeat(160)}…`);
  });

  it('removes only paired emphasis, so identifiers and operators read as written', () => {
    const lineOf = (content: string) =>
      workerGlance(
        idle,
        workerThread([{ ...message('m', '2026-10-20T10:00:00.000Z'), content }], []),
      ).line;
    expect(lineOf('Fixed test_utils.py and LIVE_OUTPUT_DISPLAY_CHARS')).toBe(
      'Fixed test_utils.py and LIVE_OUTPUT_DISPLAY_CHARS',
    );
    expect(lineOf('a * b * c を計算')).toBe('a * b * c を計算');
    expect(lineOf('`__init__.py` と `a_b` を直す')).toBe('__init__.py と a_b を直す');
    expect(lineOf('**太字** と *斜体* と _下線_ と __強調__')).toBe('太字 と 斜体 と 下線 と 強調');
    expect(lineOf('- 箇条書きの snake_case')).toBe('箇条書きの snake_case');
    expect(lineOf('```ts\nconst a_b = 1;\n```')).toBe('const a_b = 1;');
  });

  it('unwraps a structured report and leaves other content as written', () => {
    expect(workerReportText(JSON.stringify({ summary: '完了しました' }))).toBe('完了しました');
    expect(workerReportText('{"other":1}')).toBe('{"other":1}');
    expect(workerReportText('ただの文')).toBe('ただの文');
  });
});
