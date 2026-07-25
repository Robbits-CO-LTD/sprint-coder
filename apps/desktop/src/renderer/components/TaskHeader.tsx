import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { WorkspaceChip } from './WorkspaceChip';
import { Hexagon, LayoutGrid, List, MoreHorizontal, Target } from './icons';
import type { TaskSummary } from '../types/sprint-coder';

export function TaskHeader({
  task,
  onToggleTeam,
  inert,
  onToggleInspector,
  inspectorOpen = false,
  onToggleSidebar,
  sidebarCollapsed = false,
}: {
  task: TaskSummary;
  /** Enters Team mode via App's morph orchestration (SurfaceLayer/TeamCanvas, Slice 6.2) instead
   * of flipping the store directly — see App.tsx's `requestEnterTeam`. */
  onToggleTeam: () => void;
  inert?: boolean;
  /** Cycles the inspector panel's width (issue #16). Lives in the header rather than in the panel so
   * it stays reachable while the panel is hidden. */
  onToggleInspector?: (() => void) | undefined;
  inspectorOpen?: boolean;
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
      {onToggleInspector !== undefined && (
        <button
          type="button"
          className="chip-btn goal-chip"
          data-testid="inspector-toggle"
          aria-expanded={inspectorOpen}
          title="実行インスペクタを開閉"
          onClick={onToggleInspector}
        >
          <LayoutGrid size={13} /> Inspector
        </button>
      )}
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

// Goal chip: read-only display of the current Goal (FR-COMP-05).
//
// Editing moved to the Composer's plus menu (issue #13). Two entry points for one setting was the
// alternative, and the reason to prefer one is that a Goal is read far more often than it is
// changed: the header is where the user *checks* it while working, and mixing an edit affordance
// into that spot makes an accidental click mutate state they only meant to glance at.
function GoalChip({ task }: { task: TaskSummary }) {
  const goal = task.goal ?? '';
  return (
    <span
      className="goal-chip"
      data-testid="task-goal-chip"
      title={
        goal === ''
          ? 'ComposerのプラスボタンからGoalを設定できます'
          : `Goal: ${goal}（Composerのプラスボタンから変更できます）`
      }
    >
      <Target size={13} /> Goal: {goal === '' ? '未設定' : goal}
    </span>
  );
}
