import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { Hexagon, List, MoreHorizontal } from './icons';
import type { TaskSummary } from '../types/sprint-coder';
import teamClusterArt from '../../../assets/generated/team-cluster-button.webp';

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
  const teamWorkerCount = useAppStore(
    (s) => s.teamByTask[task.id]?.workers.filter(({ kind }) => kind === 'worker').length ?? 0,
  );
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
          title={sidebarCollapsed ? 'Task履歴を開く' : 'Task履歴を閉じる'}
          onClick={onToggleSidebar}
        >
          <List size={16} />
        </button>
      )}
      {editing ? (
        <input
          ref={inputRef}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
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
      <button
        type="button"
        className="team-btn"
        data-testid="team-toggle"
        disabled={teamBusy}
        aria-pressed={teamViewOpen}
        aria-label={`Team Canvasを開く${teamWorkerCount > 0 ? `、Worker ${teamWorkerCount}人` : ''}`}
        title="Team Canvasを開く"
        onClick={onToggleTeam}
      >
        <span className="team-btn-art" aria-hidden="true">
          <img src={teamClusterArt} alt="" draggable={false} />
          <Hexagon size={13} />
        </span>
        <span className="team-btn-copy">
          <span>Team</span>
          <small>
            {teamWorkerCount > 0
              ? `${teamWorkerCount} ${teamWorkerCount === 1 ? 'Worker' : 'Workers'}`
              : 'Canvas'}
          </small>
        </span>
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
