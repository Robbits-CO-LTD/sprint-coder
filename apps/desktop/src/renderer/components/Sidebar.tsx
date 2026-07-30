import { useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { isSameDay } from '../lib/format';
import { Archive, ArchiveRestore, Pin, PinOff, Plus, Search, Settings } from './icons';
import type { TaskSummary } from '../types/sprint-coder';

function groupTasks(tasks: TaskSummary[], query: string) {
  const q = query.trim().toLowerCase();
  const matches = (t: TaskSummary) => q === '' || t.title.toLowerCase().includes(q);
  // A DB Task is created before the first message because Workspace, permission, model and draft
  // settings all need a stable id. It is not conversation history until a message is accepted.
  // `undefined` keeps compatibility with older Main builds that predate this projection.
  const hasHistory = (task: TaskSummary) => task.hasConversation !== false;
  const visible = tasks.filter((t) => hasHistory(t) && !t.archived && matches(t));
  const archived = tasks.filter((t) => hasHistory(t) && t.archived && matches(t));
  const nowIso = new Date().toISOString();

  const pinned = visible.filter((t) => t.pinned);
  const rest = visible.filter((t) => !t.pinned);
  const today = rest.filter((t) => isSameDay(t.updatedAt, nowIso));
  const previous = rest.filter((t) => !isSameDay(t.updatedAt, nowIso));

  const byRecency = (a: TaskSummary, b: TaskSummary) => (a.updatedAt < b.updatedAt ? 1 : -1);
  return {
    pinned: [...pinned].sort(byRecency),
    today: [...today].sort(byRecency),
    previous: [...previous].sort(byRecency),
    archived: [...archived].sort(byRecency),
  };
}

export function Sidebar({
  inert,
  collapsed = false,
  onOpenSettings,
}: {
  inert?: boolean;
  collapsed?: boolean;
  onOpenSettings?: (() => void) | undefined;
} = {}) {
  const tasks = useAppStore((s) => s.tasks);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const selectTask = useAppStore((s) => s.selectTask);
  const createTask = useAppStore((s) => s.createTask);
  const setPinned = useAppStore((s) => s.setPinned);
  const setArchived = useAppStore((s) => s.setArchived);
  const editorDirty = useAppStore((s) => s.editorDirty);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => groupTasks(tasks, query), [tasks, query]);
  const isEmpty =
    groups.pinned.length === 0 &&
    groups.today.length === 0 &&
    groups.previous.length === 0 &&
    groups.archived.length === 0;

  const canManage =
    typeof window !== 'undefined' &&
    typeof window.sprintCoder?.tasks?.setPinned === 'function' &&
    typeof window.sprintCoder?.tasks?.setArchived === 'function';

  // Switching Task unmounts the editor, so unsaved typing would vanish without a word (issue #43).
  // A confirm is blunt, but losing someone's edit silently is worse, and the alternative — keeping
  // per-Task editor buffers alive — means holding the user's code in memory indefinitely.
  const selectTaskGuarded = (id: string): void => {
    if (
      editorDirty &&
      !window.confirm('編集中のファイルに未保存の変更があります。破棄して移動しますか？')
    )
      return;
    void selectTask(id);
  };

  const rowProps = {
    selectedTaskId,
    onSelect: selectTaskGuarded,
    canManage,
    onTogglePin: (task: TaskSummary) => void setPinned(task.id, !task.pinned),
    onToggleArchive: (task: TaskSummary) => void setArchived(task.id, !task.archived),
  };

  return (
    <nav
      className="sidebar"
      data-testid="sidebar"
      aria-label="Task履歴"
      aria-hidden={collapsed || undefined}
      inert={inert}
    >
      <button
        type="button"
        className="sb-new"
        data-testid="sidebar-new-task-button"
        onClick={() => void createTask()}
      >
        <Plus size={15} /> 新しいタスク
      </button>
      <div className="sb-search">
        <Search size={14} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="検索…"
          aria-label="Taskを検索"
        />
      </div>
      <div className="sb-scroll">
        {isEmpty ? (
          <div className="sb-empty">Taskはまだありません</div>
        ) : (
          <>
            <TaskGroup label="Pinned" items={groups.pinned} {...rowProps} />
            <TaskGroup label="Today" items={groups.today} {...rowProps} />
            <TaskGroup label="Previous" items={groups.previous} {...rowProps} />
            {groups.archived.length > 0 && (
              <details className="sb-archived">
                <summary className="sb-group sb-group--toggle">
                  Archived ({groups.archived.length})
                </summary>
                <div>
                  {groups.archived.map((task) => (
                    <TaskRow key={task.id} task={task} {...rowProps} />
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        className="sb-footer"
        data-testid="sidebar-settings-button"
        onClick={onOpenSettings}
        // The button had no onClick and was not disabled either, so it looked pressable and did
        // nothing (issue #5). If the host never wires a handler, say so rather than repeat that.
        disabled={onOpenSettings === undefined}
        title={onOpenSettings === undefined ? '設定は利用できません' : undefined}
      >
        <Settings size={15} /> 設定
      </button>
    </nav>
  );
}

type RowProps = {
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
  canManage: boolean;
  onTogglePin: (task: TaskSummary) => void;
  onToggleArchive: (task: TaskSummary) => void;
};

function TaskGroup({
  label,
  items,
  ...rowProps
}: { label: string; items: TaskSummary[] } & RowProps) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="sb-group">{label}</div>
      {items.map((task) => (
        <TaskRow key={task.id} task={task} {...rowProps} />
      ))}
    </div>
  );
}

function TaskRow({
  task,
  selectedTaskId,
  onSelect,
  canManage,
  onTogglePin,
  onToggleArchive,
}: { task: TaskSummary } & RowProps) {
  const isActive = task.id === selectedTaskId;
  return (
    <div className={`sb-row${isActive ? ' active' : ''}`}>
      <button
        type="button"
        className="sb-item"
        aria-current={isActive ? 'true' : undefined}
        onClick={() => onSelect(task.id)}
        title={task.title}
      >
        {task.pinned && (
          <span className="pin">
            <Pin size={12} />
          </span>
        )}
        {task.title || '無題のTask'}
      </button>
      {canManage && (
        <span className="sb-actions">
          <button
            type="button"
            className="sb-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin(task);
            }}
            title={task.pinned ? 'ピン留めを解除' : 'ピン留め'}
            aria-label={task.pinned ? 'ピン留めを解除' : 'ピン留め'}
          >
            {task.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            type="button"
            className="sb-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleArchive(task);
            }}
            title={task.archived ? 'アーカイブを解除' : 'アーカイブ'}
            aria-label={task.archived ? 'アーカイブを解除' : 'アーカイブ'}
          >
            {task.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </button>
        </span>
      )}
    </div>
  );
}
