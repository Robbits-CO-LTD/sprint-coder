// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskRow } from './Sidebar';
import { useAppStore } from '../store/appStore';
import type { TaskSummary } from '../types/sprint-coder';

const task: TaskSummary = {
  id: 'task-1',
  projectId: null,
  title: 'Dev server',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: false,
  activeTurnId: null,
  runningWork: null,
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-14T00:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState({ turnByTask: {}, tasks: [] });
  vi.unstubAllGlobals();
});

async function renderRow(
  row: TaskSummary,
  options: {
    selected?: boolean;
    notice?: string;
    onToggleArchive?: (task: TaskSummary) => void;
    onDismiss?: () => void;
  } = {},
) {
  await act(async () =>
    root.render(
      <TaskRow
        task={row}
        selectedTaskId={options.selected ? row.id : 'other'}
        onSelect={vi.fn()}
        canManage
        canMove={false}
        activeProjects={[]}
        onMove={vi.fn()}
        onTogglePin={vi.fn()}
        onToggleArchive={options.onToggleArchive ?? vi.fn()}
        archiveNotice={
          options.notice === undefined ? null : { taskId: row.id, message: options.notice }
        }
        onDismissArchiveNotice={options.onDismiss ?? vi.fn()}
      />,
    ),
  );
}

function archiveButton(label = 'アーカイブ'): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.sb-menu-popover button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`${label} button missing`);
  return button;
}

describe('the sidebar’s archive of a Task that still moves (issue #1225)', () => {
  it.each([
    [
      'its Turn',
      {
        ...task,
        activeTurnId: 'turn-1',
        runningWork: { turn: true, team: false, workers: 0, commands: 0 },
      },
      'AIの作業',
      'AIの作業は入力欄の「実行を停止」',
    ],
    [
      'Team Workers after the Leader’s Turn',
      { ...task, runningWork: { turn: false, team: true, workers: 2, commands: 0 } },
      'TeamのWorker 2人',
      'Teamは「すべて停止」（Workerの起動中は、少し待ってから）',
    ],
    [
      'a background command',
      { ...task, runningWork: { turn: false, team: false, workers: 0, commands: 1 } },
      '実行中のコマンド 1件',
      'コマンドは「実行中のコマンドを停止」',
    ],
  ])(
    'cannot be pressed while %s moves, and says why and how to stop it',
    async (_name, row, part, stop) => {
      const onToggleArchive = vi.fn();
      await renderRow(row, { onToggleArchive });
      const button = archiveButton();
      expect(button.getAttribute('aria-disabled')).toBe('true');
      // Still focusable (no disabled attribute), so the reason is reachable and read out.
      expect(button.disabled).toBe(false);
      const reason = `このTaskは、まだ動いています（${part}）。${stop}で止めてから、アーカイブしてください。`;
      expect(button.title).toBe(reason);
      const note = document.getElementById(button.getAttribute('aria-describedby')!);
      expect(note?.textContent).toBe(reason);
      await act(async () => button.click());
      expect(onToggleArchive).not.toHaveBeenCalled();
    },
  );

  it('holds the archive of a Task whose AI stop could not be confirmed, and points to a restart', async () => {
    const onToggleArchive = vi.fn();
    // Its Turn is recorded as canceled: nothing else moves, yet its process may go on.
    await renderRow(
      {
        ...task,
        runningWork: { turn: false, team: false, workers: 0, commands: 0, stopUnconfirmed: true },
      },
      { onToggleArchive },
    );
    const button = archiveButton();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.title).toBe(
      'このTaskは、まだ動いています（停止を確認できなかったAIの作業）。停止を確認できなかった作業はアプリを再起動して片付けてから、アーカイブしてください。',
    );
    await act(async () => button.click());
    expect(onToggleArchive).not.toHaveBeenCalled();
  });

  it('holds the selected Task’s archive while its live Turn runs, even before Main’s snapshot', async () => {
    useAppStore.setState({
      turnByTask: {
        'task-1': {
          turnId: 'turn-1',
          status: 'running',
          stage: 'executing',
          runtimeStarting: false,
          reachedStageIndex: 2,
          startedAt: 0,
          streamingMessageId: null,
          streamingContent: '',
        },
      },
    });
    await renderRow(task, { selected: true });
    expect(archiveButton().getAttribute('aria-disabled')).toBe('true');
    expect(archiveButton().title).toContain('AIの作業');
  });

  it('archives a Task with nothing moving, and always restores an archived one', async () => {
    const onToggleArchive = vi.fn();
    await renderRow(task, { onToggleArchive });
    expect(archiveButton().hasAttribute('aria-disabled')).toBe(false);
    expect(archiveButton().title).toBe('');
    await act(async () => archiveButton().click());
    expect(onToggleArchive).toHaveBeenCalledWith(task);

    const archived = {
      ...task,
      archived: true,
      runningWork: { turn: true, team: true, workers: 1, commands: 1 },
    };
    onToggleArchive.mockClear();
    await renderRow(archived, { onToggleArchive });
    expect(archiveButton('復元').hasAttribute('aria-disabled')).toBe(false);
    await act(async () => archiveButton('復元').click());
    expect(onToggleArchive).toHaveBeenCalledWith(archived);
  });

  it('shows Main’s refusal on the row as an alert, until it is closed', async () => {
    const onDismiss = vi.fn();
    const message =
      'このTaskは、まだ動いています（AIの作業）。AIの作業は入力欄の「実行を停止」で止めてから、アーカイブしてください。';
    await renderRow(task, { notice: message, onDismiss });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(message);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="お知らせを閉じる"]')!.click(),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  /** Renders the row from the store's Task, as the sidebar does, so store updates reach it. */
  function StoreRow(props: { notice?: string }) {
    const row = useAppStore((state) => state.tasks.find(({ id }) => id === 'task-1'))!;
    return (
      <TaskRow
        task={row}
        selectedTaskId="other"
        onSelect={vi.fn()}
        canManage
        canMove={false}
        activeProjects={[]}
        onMove={vi.fn()}
        onTogglePin={vi.fn()}
        onToggleArchive={vi.fn()}
        archiveNotice={
          props.notice === undefined ? null : { taskId: 'task-1', message: props.notice }
        }
        onDismissArchiveNotice={vi.fn()}
      />
    );
  }

  it('asks Main afresh as the menu opens, so a stale snapshot does not hold the archive back', async () => {
    // The snapshot still says a command runs; it ended unseen.
    const stale = { ...task, runningWork: { turn: false, team: false, workers: 0, commands: 1 } };
    const runningWork = vi.fn(async () => null);
    vi.stubGlobal('sprintCoder', { tasks: { runningWork } });
    useAppStore.setState({ tasks: [stale] });
    await act(async () => root.render(<StoreRow />));
    expect(archiveButton().getAttribute('aria-disabled')).toBe('true');
    const menu = container.querySelector<HTMLDetailsElement>('.sb-task-menu')!;
    await act(async () => {
      menu.open = true;
      menu.dispatchEvent(new Event('toggle'));
    });
    expect(runningWork).toHaveBeenCalledWith('task-1');
    expect(archiveButton().hasAttribute('aria-disabled')).toBe(false);
  });

  it('stops the Task’s commands from where the archive is held back, then lets it archive', async () => {
    const running = { ...task, runningWork: { turn: false, team: false, workers: 0, commands: 1 } };
    let release = (): void => undefined;
    const stopTask = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    );
    vi.stubGlobal('sprintCoder', { commands: { stopTask }, tasks: {} });
    useAppStore.setState({ tasks: [running] });
    await act(async () => root.render(<StoreRow />));
    const stop = () =>
      [...container.querySelectorAll<HTMLButtonElement>('.sb-stop-commands')].find(Boolean);
    expect(stop()?.textContent).toBe('実行中のコマンドを停止');
    await act(async () => stop()!.click());
    expect(stopTask).toHaveBeenCalledExactlyOnceWith('task-1');
    expect(stop()?.textContent).toBe('停止中…');
    expect(stop()?.disabled).toBe(true);
    await act(async () => release());
    // Nothing moves any more: the stop is gone and 「アーカイブ」 can be pressed.
    expect(stop()).toBeUndefined();
    expect(archiveButton().hasAttribute('aria-disabled')).toBe(false);
  });

  it('says so when a command’s stop could not be confirmed, and keeps the archive held back', async () => {
    const running = { ...task, runningWork: { turn: false, team: false, workers: 0, commands: 1 } };
    const unconfirmed =
      'コマンドの停止を確認できませんでした。アプリを再起動してからもう一度お試しください。';
    vi.stubGlobal('sprintCoder', {
      commands: {
        stopTask: vi.fn(async () => {
          throw new Error(unconfirmed);
        }),
      },
      tasks: { runningWork: vi.fn(async () => running.runningWork) },
    });
    useAppStore.setState({ tasks: [running] });
    await act(async () => root.render(<StoreRow />));
    await act(async () => container.querySelector<HTMLButtonElement>('.sb-stop-commands')!.click());
    const alert = [...container.querySelectorAll('[role="alert"]')].find((node) =>
      node.textContent?.includes('停止を確認できませんでした'),
    );
    expect(alert?.textContent).toBe(unconfirmed);
    expect(archiveButton().getAttribute('aria-disabled')).toBe('true');
  });

  it('offers the commands’ stop with Main’s refusal too', async () => {
    const running = { ...task, runningWork: { turn: false, team: false, workers: 0, commands: 2 } };
    useAppStore.setState({ tasks: [running] });
    await act(async () =>
      root.render(<StoreRow notice="このTaskは、まだ動いています（実行中のコマンド 2件）。" />),
    );
    const notice = container.querySelector('.sb-task-notice')!;
    expect(notice.querySelector('.sb-stop-commands')?.textContent).toBe('実行中のコマンドを停止');
  });
});

describe('the store’s archive (issue #1225)', () => {
  afterEach(() => {
    useAppStore.setState({ tasks: [], error: null });
  });

  it('resolves to Main’s refusal and leaves the Task as it was', async () => {
    const running = {
      ...task,
      activeTurnId: 'turn-1',
      runningWork: { turn: true, team: false, workers: 0, commands: 0 },
    };
    const refusal =
      'このTaskは、まだ動いています（AIの作業）。先に停止してから、アーカイブしてください。';
    vi.stubGlobal('sprintCoder', {
      tasks: {
        setArchived: vi.fn(async () => {
          throw Object.assign(new Error(refusal), { code: 'TASK_STILL_RUNNING' });
        }),
      },
    });
    useAppStore.setState({ tasks: [running] });
    await expect(useAppStore.getState().setArchived('task-1', true)).resolves.toBe(refusal);
    expect(useAppStore.getState().tasks).toEqual([running]);
  });

  it('keeps the activity snapshot across a pin, and clears it when an archive passes', async () => {
    const running = {
      ...task,
      activeTurnId: 'turn-1',
      runningWork: { turn: true, team: false, workers: 0, commands: 0 },
    };
    // Main's mutation results carry no activity snapshot.
    const { activeTurnId: _turn, runningWork: _work, ...plain } = running;
    vi.stubGlobal('sprintCoder', {
      tasks: {
        setPinned: vi.fn(async () => ({ ...plain, pinned: true })),
        setArchived: vi.fn(async () => ({ ...plain, archived: true })),
      },
    });
    useAppStore.setState({ tasks: [running] });
    await useAppStore.getState().setPinned('task-1', true);
    expect(useAppStore.getState().tasks[0]).toMatchObject({
      pinned: true,
      activeTurnId: 'turn-1',
      runningWork: { turn: true },
    });
    await expect(useAppStore.getState().setArchived('task-1', true)).resolves.toBeNull();
    expect(useAppStore.getState().tasks[0]).toMatchObject({
      archived: true,
      activeTurnId: null,
      runningWork: null,
    });
  });
});
