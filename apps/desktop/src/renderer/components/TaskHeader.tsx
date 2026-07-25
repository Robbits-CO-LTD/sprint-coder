import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { WorkspaceChip } from './WorkspaceChip';
import { Hexagon, List, MoreHorizontal, Target } from './icons';
import type { TaskSummary } from '../types/sprint-coder';

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
  const accessPreset = useAppStore((s) => s.permissionByTask[task.id]?.preset ?? ('ask' as const));
  const teamViewOpen = useAppStore((s) => s.teamViewOpen);
  const teamBusy = useAppStore((s) => s.teamBusy);
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
          style={{
            font: 'inherit',
            fontWeight: 600,
            fontSize: 14,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 6,
            color: 'var(--text-primary)',
            padding: '2px 8px',
            minWidth: 160,
          }}
        />
      ) : (
        <button
          type="button"
          className="task-title"
          style={{ border: 'none', background: 'none', cursor: 'text', padding: 0 }}
          onClick={() => setEditing(true)}
          title="クリックしてTask名を変更"
        >
          {task.title || '無題のTask'}
        </button>
      )}
      <GoalChip task={task} />
      <WorkspaceChip taskId={task.id} variant="header" />
      <span className="goal-chip" title="現在のAccess mode">
        Access: {accessPreset === 'ask' ? '確認する' : accessPreset === 'auto' ? '自動' : 'フル'}
      </span>
      <button
        type="button"
        className="team-btn"
        data-testid="team-toggle"
        disabled={teamBusy}
        aria-pressed={teamViewOpen}
        title="Team Canvasを開く"
        onClick={onToggleTeam}
      >
        <Hexagon size={14} /> Team
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

// Goal chip: click → inline edit → tasks.setGoal (FR-COMP-05). Falls back to a read-only chip
// when the backend hasn't wired setGoal yet (graceful degrade).
function GoalChip({ task }: { task: TaskSummary }) {
  const setGoal = useAppStore((s) => s.setGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.goal ?? '');
  const [syncedGoal, setSyncedGoal] = useState(task.goal ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const supported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.tasks?.setGoal === 'function';

  // Render-time adjustment instead of an effect, per react-hooks/set-state-in-effect.
  if (!editing && (task.goal ?? '') !== syncedGoal) {
    setSyncedGoal(task.goal ?? '');
    setDraft(task.goal ?? '');
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== (task.goal ?? '')) {
      void setGoal(task.id, trimmed);
    }
  }

  function cancel() {
    setEditing(false);
    setDraft(task.goal ?? '');
  }

  if (!supported) {
    return (
      <span className="goal-chip" title="Goal編集は今回のバックエンドでは未対応です">
        <Target size={13} /> Goal: {task.goal ?? '未設定'}
      </span>
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="goal-input"
        value={draft}
        placeholder="Goalを入力"
        onChange={(e) => setDraft(e.target.value)}
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
        aria-label="Goalを編集"
      />
    );
  }

  return (
    <button
      type="button"
      className="goal-chip chip-btn"
      onClick={() => setEditing(true)}
      title="クリックしてGoalを編集"
    >
      <Target size={13} /> Goal: {task.goal ?? '未設定'}
    </button>
  );
}
