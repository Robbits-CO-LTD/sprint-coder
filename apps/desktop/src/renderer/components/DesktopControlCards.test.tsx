// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ApprovalCard';
import { ApprovalAuditRow } from './ApprovalAuditRow';
import { CommandCard } from './CommandCard';
import { desktopActionsByCall, desktopCallKey } from './ChatSurface/Timeline';
import type { ApprovalSummary } from '../types/sprint-coder';
import type { CommandCardState } from '../store/appStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
});

type DesktopAction = NonNullable<ApprovalSummary['desktopAction']>;

const typing: DesktopAction = {
  kind: 'input',
  title: '文字を入力します',
  mode: 'background',
  target: {
    resolved: true,
    app: 'charmap.exe',
    window: '文字コード表',
    role: '入力欄',
    name: 'コピーする文字',
  },
  text: 'ABC',
  textRole: 'enter',
  allowTaskGrant: true,
  notes: [],
  openDetails: false,
};

const base: ApprovalSummary = {
  id: 'approval-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  callId: 'call-1',
  state: 'pending',
  decision: null,
  revision: 0,
  policyEpoch: 1,
  toolName: 'exec_command',
  reason: 'Tool exec_command requests shell.execute',
  target: 'C:\\Program Files\\Sprint Coder\\resources\\desktop-control.exe',
  impact: 'process',
  execution: JSON.stringify({ argv: ['set-value', '@s1:e1', 'ABC'] }),
  risk: 'high',
  capability: 'shell.execute',
  challenge: 'challenge-value',
  createdAt: '2026-11-10T00:00:00.000Z',
  expiresAt: '2026-11-10T01:00:00.000Z',
};

const card = (desktopAction: DesktopAction, overrides: Partial<ApprovalSummary> = {}) =>
  renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...base, desktopAction, ...overrides }}
      busy={false}
      onDecision={() => undefined}
    />,
  );

describe('desktop-control approval card', () => {
  it('says what it does, to what, and what it enters, with the command folded away', () => {
    const html = card(typing);
    expect(html).toContain('文字を入力します');
    expect(html).toContain('マウスとキーボードは使いません');
    expect(html).not.toContain('裏で動きます');
    expect(html).toContain('文字コード表（charmap.exe） の入力欄「コピーする文字」');
    expect(html).toContain('入れる文字');
    expect(html).toContain('「ABC」');
    expect(html).toContain('デスクトップ操作');
    // The command card's own wording is not on it.
    expect(html).not.toContain('実行の承認が必要です');
    expect(html).not.toContain('コマンドの実行または実行中プロセスへの入力を許可します');
    // The command itself is under the details, closed.
    expect(html).toMatch(/<details[^>]*data-testid="desktop-approval-details"[^>]*>/u);
    expect(html).not.toMatch(/<details[^>]*open/u);
    expect(html).toContain('詳細（実行内容）');
    expect(html).toContain('shell.execute');
    expect(html).toContain('desktop-control.exe');
    expect(html).toContain('Task中許可');
  });

  it('shows a launch with its note and no mode mark for a read', () => {
    const launch = card({
      ...typing,
      kind: 'launch',
      title: 'アプリを起動します',
      target: { resolved: true, app: 'charmap' },
      text: undefined,
      textRole: undefined,
      notes: ['新しい窓が手前に出ることがあります。'],
    } as DesktopAction);
    expect(launch).toContain('アプリ「charmap」');
    // A launch gets no mark: its window can come up in front.
    expect(launch).not.toContain('desktop-approval-mode');
    expect(launch).toContain('新しい窓が手前に出ることがあります。');
    expect(launch).not.toContain('入れる文字');

    const read = card({
      kind: 'read',
      title: '画面を読みます',
      mode: 'read',
      allowTaskGrant: true,
      notes: [],
      openDetails: false,
    });
    expect(read).toContain('画面を読みます');
    expect(read).not.toContain('desktop-approval-mode');
  });

  it('marks a foreground run, warns the person, and offers no Task grant', () => {
    const html = card({
      ...typing,
      title: 'キーで入力します',
      mode: 'foreground',
      target: {
        resolved: true,
        app: 'Notepad.exe',
        window: 'メモ帳',
        role: '文書',
        name: 'テキスト エディター',
      },
      text: 'こんにちは',
      allowTaskGrant: false,
      notes: ['窓が前面に出て、マウスとキーボードを使います。入力中は触らないでください。'],
    });
    expect(html).toContain('前面を使います');
    expect(html).toContain('approval-card--foreground');
    expect(html).toContain('入力中は触らないでください。');
    expect(html).not.toContain('approval-allow-task');
    expect(html).toContain('approval-allow-once');
    expect(html).toContain('approval-deny');
  });

  it('opens the details when the target could not be confirmed', () => {
    const html = card({
      ...typing,
      target: { resolved: false, reference: '@s9:e8' },
      openDetails: true,
    });
    expect(html).toContain('対象を確かめられません（@s9:e8）');
    expect(html).toMatch(/<details[^>]*open=""/u);
  });

  it('lists the steps of a batch', () => {
    const html = card({
      kind: 'other',
      title: '2 個の操作をまとめて行います',
      mode: 'background',
      steps: [
        { kind: 'operate', title: 'メニューを開きます', mode: 'background' },
        { kind: 'read', title: '画面を読みます', mode: 'read' },
      ],
      allowTaskGrant: true,
      notes: [],
      openDetails: false,
    });
    expect(html).toContain('desktop-approval-steps');
    expect(html).toContain('メニューを開きます');
    expect(html).toContain('画面を読みます');
  });

  it('names each button and the card with its heading and target, so two cards read apart', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <>
          <ApprovalCard
            approval={{ ...base, desktopAction: typing }}
            busy={false}
            onDecision={() => undefined}
          />
          <ApprovalCard
            approval={{
              ...base,
              id: 'approval-2',
              callId: 'call-2',
              desktopAction: {
                ...typing,
                title: 'クリックします',
                text: undefined,
                textRole: undefined,
              } as DesktopAction,
            }}
            busy={false}
            onDecision={() => undefined}
          />
        </>,
      ),
    );
    const name = (element: Element) =>
      (element.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    const [first, second] = [...container.querySelectorAll('[data-testid="approval-card"]')];
    expect(name(first!)).toBe(
      '文字を入力します 文字コード表（charmap.exe） の入力欄「コピーする文字」',
    );
    expect(name(second!)).toBe(
      'クリックします 文字コード表（charmap.exe） の入力欄「コピーする文字」',
    );
    const once = [...container.querySelectorAll('[data-testid="approval-allow-once"]')].map(name);
    expect(once).toEqual([
      '今回のみ許可 文字を入力します 文字コード表（charmap.exe） の入力欄「コピーする文字」',
      '今回のみ許可 クリックします 文字コード表（charmap.exe） の入力欄「コピーする文字」',
    ]);
    await act(async () => root.unmount());
  });

  it('keeps every other card as it was, with named buttons', async () => {
    const plain = renderToStaticMarkup(
      <ApprovalCard approval={base} busy={false} onDecision={() => undefined} />,
    );
    expect(plain).toContain('実行の承認が必要です');
    expect(plain).toContain('aria-label="ツール実行の承認"');
    expect(plain).toContain('Task中許可');
    expect(plain).not.toContain('デスクトップ操作');
    expect(plain).not.toContain('詳細（実行内容）');

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(<ApprovalCard approval={base} busy={false} onDecision={() => undefined} />),
    );
    const deny = container.querySelector('[data-testid="approval-deny"]')!;
    expect(
      (deny.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' '),
    ).toBe(`拒否 実行の承認が必要です ${base.target}`);
    await act(async () => root.unmount());
  });
});

describe('desktop-control history and timeline', () => {
  it('shows the heading and target on the decided row', () => {
    const html = renderToStaticMarkup(
      <ApprovalAuditRow
        approval={{
          ...base,
          state: 'resolved',
          decision: 'allow_once',
          decidedAt: '2026-11-10T00:00:10.000Z',
          desktopAction: typing,
        }}
      />,
    );
    expect(html).toContain('今回のみ許可しました');
    expect(html).toContain(
      'デスクトップ操作 · 文字を入力します 文字コード表（charmap.exe） の入力欄「コピーする文字」',
    );
    expect(html).not.toContain('shell.execute');

    const plain = renderToStaticMarkup(
      <ApprovalAuditRow
        approval={{
          ...base,
          state: 'resolved',
          decision: 'deny',
          decidedAt: '2026-11-10T00:00:10.000Z',
        }}
      />,
    );
    expect(plain).toContain('shell.execute · high');
  });

  it('shows the run as desktop control with its argv folded away', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const command: CommandCardState = {
      command: {
        id: 'command-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        specDigest: 'digest',
        executable: 'C:\\desktop-control.exe',
        argv: ['set-value', '@s1:e1', 'ABC'],
        cwd: 'C:\\workspace',
        envDelta: {},
        purpose: '文字を入れる',
        risk: 'high',
        state: 'exited',
        pid: 1,
        exitCode: 0,
        signal: null,
        outputBytes: 0,
        truncated: false,
        createdAt: '2026-11-10T00:00:00.000Z',
        startedAt: '2026-11-10T00:00:00.000Z',
        finishedAt: '2026-11-10T00:00:01.000Z',
      },
      tail: { lines: [], lastOutputSeq: 0 },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(<CommandCard taskId="task-1" card={command} desktopAction={typing} />),
    );
    const head = container.querySelector('.command-card__head')!.textContent;
    expect(head).toContain('デスクトップ操作');
    expect(head).toContain('文字を入力します');
    expect(head).not.toContain('Command');
    expect(head).not.toContain('高リスク');
    expect(container.textContent).toContain(
      '文字コード表（charmap.exe） の入力欄「コピーする文字」',
    );
    expect(container.querySelector('details')?.textContent).toContain('set-value');
    expect(container.querySelector('details')?.textContent).toContain('AI の説明: 文字を入れる');

    await act(async () => root.render(<CommandCard taskId="task-1" card={command} />));
    expect(container.querySelector('.command-card__head')!.textContent).toContain('Command');
    expect(container.querySelector('details')).toBeNull();
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('shows a run that needed no card with Main’s description, and a failed exit as failed', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const base: CommandCardState['command'] = {
      id: 'command-2',
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-2',
      specDigest: 'digest',
      executable: 'C:\\desktop-control.exe',
      argv: ['status'],
      cwd: 'C:\\workspace',
      envDelta: {},
      purpose: '状態を見る',
      risk: 'high',
      state: 'exited',
      pid: 1,
      exitCode: 1,
      signal: null,
      outputBytes: 0,
      truncated: false,
      createdAt: '2026-11-10T00:00:00.000Z',
      startedAt: '2026-11-10T00:00:00.000Z',
      finishedAt: '2026-11-10T00:00:01.000Z',
      desktopAction: {
        kind: 'read',
        title: '状態を確かめます',
        mode: 'read',
        allowTaskGrant: true,
        notes: [],
        openDetails: false,
      },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <CommandCard
          taskId="task-1"
          card={{ command: base, tail: { lines: [], lastOutputSeq: 0 } }}
        />,
      ),
    );
    const head = container.querySelector('.command-card__head')!.textContent;
    expect(head).toContain('デスクトップ操作');
    expect(head).toContain('状態を確かめます');
    expect(head).not.toContain('高リスク');
    expect(container.querySelector('details')?.textContent).toContain('status');
    expect(container.querySelector('summary')?.getAttribute('aria-label')).toContain(
      '詳細（実行内容） 状態を確かめます',
    );
    // exit 1 is not drawn as a success, on this row or on a plain command's.
    expect(container.querySelector('.command-card__status')?.className).toContain('is-failure');
    const { desktopAction: _omitted, ...plain } = base;
    await act(async () =>
      root.render(
        <CommandCard
          taskId="task-1"
          card={{ command: plain, tail: { lines: [], lastOutputSeq: 0 } }}
        />,
      ),
    );
    expect(container.querySelector('.command-card__status')?.className).toContain('is-failure');
    await act(async () =>
      root.render(
        <CommandCard
          taskId="task-1"
          card={{ command: { ...plain, exitCode: 0 }, tail: { lines: [], lastOutputSeq: 0 } }}
        />,
      ),
    );
    expect(container.querySelector('.command-card__status')?.className).not.toContain('is-failure');
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('tells apart same-titled windows by id, names lists of everything, and names each details', async () => {
    const withId = card({
      ...typing,
      target: { ...typing.target!, windowId: 'w-23073794' },
    });
    expect(withId).toContain('文字コード表（charmap.exe） の入力欄「コピーする文字」 · w-23073794');
    const list = card({
      kind: 'read',
      title: '窓の一覧を読みます',
      mode: 'read',
      target: { resolved: true, all: 'windows' },
      allowTaskGrant: true,
      notes: [],
      openDetails: false,
    });
    expect(list).toContain('すべての窓');

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <>
          <ApprovalCard
            approval={{ ...base, desktopAction: typing }}
            busy={false}
            onDecision={() => undefined}
          />
          <ApprovalCard
            approval={{
              ...base,
              id: 'approval-2',
              callId: 'call-2',
              desktopAction: { ...typing, title: 'クリックします' },
            }}
            busy={false}
            onDecision={() => undefined}
          />
        </>,
      ),
    );
    const names = [...container.querySelectorAll('summary')].map((summary) =>
      (summary.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .join(' '),
    );
    expect(names).toEqual([
      '詳細（実行内容） 文字を入力します 文字コード表（charmap.exe） の入力欄「コピーする文字」',
      '詳細（実行内容） クリックします 文字コード表（charmap.exe） の入力欄「コピーする文字」',
    ]);
    await act(async () => root.unmount());
  });

  it('shows where a drag drops, and says a part has no name', () => {
    const drag: DesktopAction = {
      kind: 'operate',
      title: 'ドラッグします',
      mode: 'foreground',
      target: { ...typing.target! },
      destination: { resolved: true, app: 'charmap.exe', window: '文字コード表', role: 'ボタン' },
      allowTaskGrant: false,
      notes: [],
      openDetails: true,
    };
    const html = card(drag);
    expect(html).toContain('移動先');
    expect(html).toContain('文字コード表（charmap.exe） のボタン（名前なし）');
    expect(html).toMatch(/<details[^>]*open=""/u);
    const row = renderToStaticMarkup(
      <ApprovalAuditRow
        approval={{
          ...base,
          state: 'resolved',
          decision: 'allow_once',
          decidedAt: '2026-11-10T00:00:10.000Z',
          desktopAction: drag,
        }}
      />,
    );
    expect(row).toContain(
      'ドラッグします 文字コード表（charmap.exe） の入力欄「コピーする文字」 → 文字コード表（charmap.exe） のボタン（名前なし）',
    );
  });

  it('matches a command to its approval by Turn and call id, never by call id alone', () => {
    const other = { ...typing, title: 'クリックします' };
    const byCall = desktopActionsByCall([
      { ...base, desktopAction: typing },
      { ...base, id: 'approval-2', turnId: 'turn-2', desktopAction: other },
    ]);
    expect(byCall.get(desktopCallKey('turn-1', 'call-1'))).toBe(typing);
    expect(byCall.get(desktopCallKey('turn-2', 'call-1'))).toBe(other);
    // The same call id in a Turn whose approval had no description gets none.
    expect(byCall.get(desktopCallKey('turn-3', 'call-1'))).toBeUndefined();
  });
});
