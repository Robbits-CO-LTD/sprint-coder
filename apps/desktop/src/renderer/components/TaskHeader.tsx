import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { MoreHorizontal, PanelLeft } from './icons';
import { SIDEBAR_SHORTCUT_ARIA, SIDEBAR_SHORTCUT_LABEL } from '../lib/sidebar-preference';
import type { TurnStatus } from '../store/appStore';
import type { TaskSummary } from '../types/sprint-coder';

const statusLabels: Record<TurnStatus | 'idle' | 'waiting', string> = {
  idle: '待機中',
  running: '作業中',
  waiting: '承認待ち',
  completed: '完了',
  canceling: '停止中',
  canceled: '停止済み',
  failed: 'エラー',
  interrupted: '中断',
};

function revealTaskApproval(taskId: string): void {
  const timeline = Array.from(
    document.querySelectorAll<HTMLElement>('.timeline-scroll[data-task-id]'),
  ).find((element) => element.dataset.taskId === taskId && element.closest('[inert]') === null);
  const card = timeline?.querySelector<HTMLElement>('[data-testid="approval-card"]');
  if (card == null) return;
  card.scrollIntoView({ block: 'nearest' });
  card.focus({ preventScroll: true });
}

export function TaskHeader({
  task,
  onToggleTeam,
  inert,
  onToggleSidebar,
  sidebarCollapsed = false,
}: {
  task: TaskSummary;
  /** Enters Team mode via App's morph orchestration (SurfaceLayer/TeamCanvas, Slice 6.2) instead
   * of flipping the store directly — see App.tsx's `requestEnterTeam`. */
  onToggleTeam: () => void;
  inert?: boolean;
  /** Shows/hides the Task history sidebar (issue #12). Lives here rather than inside the sidebar
   * itself because it has to stay reachable while the sidebar is collapsed. */
  onToggleSidebar?: (() => void) | undefined;
  sidebarCollapsed?: boolean;
}) {
  const renameTask = useAppStore((s) => s.renameTask);
  const teamViewOpen = useAppStore((s) => s.teamViewOpen);
  const teamBusy = useAppStore((s) => s.teamBusy);
  const turnStatus = useAppStore((s) => s.turnByTask[task.id]?.status);
  const approvalCount = useAppStore((s) => s.approvalsByTask[task.id]?.length ?? 0);
  const activity = turnStatus ?? (task.activeTurnId ? 'running' : 'idle');
  const status = approvalCount > 0 ? 'waiting' : activity;
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [syncedTitle, setSyncedTitle] = useState(task.title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the draft in sync with the persisted title while not editing (render-time adjustment
  // instead of an effect, per react-hooks/set-state-in-effect).
  if (!editing && task.title !== syncedTitle) {
    setSyncedTitle(task.title);
    setDraftTitle(task.title);
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    setEditing(false);
    const trimmed = draftTitle.trim();
    if (trimmed && trimmed !== task.title) {
      void renameTask(task.id, trimmed);
    } else {
      setDraftTitle(task.title);
    }
  }

  function cancel() {
    setEditing(false);
    setDraftTitle(task.title);
  }

  return (
    <header className="task-header" inert={inert}>
      {onToggleSidebar !== undefined && (
        <button
          type="button"
          className="sidebar-toggle"
          data-testid="sidebar-toggle"
          aria-expanded={!sidebarCollapsed}
          aria-label={sidebarCollapsed ? 'Task履歴を開く' : 'Task履歴を閉じる'}
          aria-keyshortcuts={SIDEBAR_SHORTCUT_ARIA}
          title={`${sidebarCollapsed ? 'Task履歴を開く' : 'Task履歴を閉じる'} (${SIDEBAR_SHORTCUT_LABEL})`}
          onClick={onToggleSidebar}
        >
          <PanelLeft size={16} />
        </button>
      )}
      {editing ? (
        <input
          ref={inputRef}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          aria-label="Task名を編集"
          className="task-title-input"
        />
      ) : (
        <button
          type="button"
          className="task-title"
          style={{ cursor: 'text' }}
          onClick={() => setEditing(true)}
          title="クリックしてTask名を変更"
        >
          {task.title || '無題のTask'}
        </button>
      )}
      <span className="sr-only" role="status">
        {statusLabels[status]}
      </span>
      {status === 'waiting' ? (
        <button
          type="button"
          className="task-header-status task-header-status--waiting"
          data-testid="task-header-approval"
          aria-label={'承認待ち ' + approvalCount + '件。確認箇所へ移動'}
          onClick={() => revealTaskApproval(task.id)}
        >
          <span className="task-header-status-dot" aria-hidden="true" />
          承認待ち <span className="task-header-status-count">{approvalCount}</span>
        </button>
      ) : (
        <span className={'task-header-status task-header-status--' + status} aria-hidden="true">
          <span className="task-header-status-dot" />
          {statusLabels[status]}
        </span>
      )}
      <button
        type="button"
        className="team-btn"
        data-testid="team-toggle"
        disabled={teamBusy}
        aria-pressed={teamViewOpen}
        aria-label="Teamを開く"
        title="Teamを開く"
        onClick={onToggleTeam}
      >
        Team
      </button>
      <button
        type="button"
        className="icon-btn"
        disabled
        title="今回のスコープ外です"
        aria-disabled="true"
        aria-label="その他の操作"
      >
        <MoreHorizontal size={16} />
      </button>
    </header>
  );
}
