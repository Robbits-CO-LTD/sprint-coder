import { useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { isSameDay } from '../lib/format';
import type { TaskSummary } from '../types/vibe';

function groupTasks(tasks: TaskSummary[], query: string) {
  const q = query.trim().toLowerCase();
  const matches = (t: TaskSummary) => q === '' || t.title.toLowerCase().includes(q);
  const visible = tasks.filter((t) => !t.archived && matches(t));
  const archived = tasks.filter((t) => t.archived && matches(t));
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

export function Sidebar() {
  const tasks = useAppStore((s) => s.tasks);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const selectTask = useAppStore((s) => s.selectTask);
  const createTask = useAppStore((s) => s.createTask);
  const setPinned = useAppStore((s) => s.setPinned);
  const setArchived = useAppStore((s) => s.setArchived);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => groupTasks(tasks, query), [tasks, query]);
  const isEmpty =
    groups.pinned.length === 0 &&
    groups.today.length === 0 &&
    groups.previous.length === 0 &&
    groups.archived.length === 0;

  const canManage =
    typeof window !== 'undefined' &&
    typeof window.vibe?.tasks?.setPinned === 'function' &&
    typeof window.vibe?.tasks?.setArchived === 'function';

  const rowProps = {
    selectedTaskId,
    onSelect: selectTask,
    canManage,
    onTogglePin: (task: TaskSummary) => void setPinned(task.id, !task.pinned),
    onToggleArchive: (task: TaskSummary) => void setArchived(task.id, !task.archived),
  };

  return (
    <nav className="sidebar" aria-label="Task履歴">
      <button
        type="button"
        className="sb-new"
        data-testid="sidebar-new-task-button"
        onClick={() => void createTask()}
      >
        ＋ 新しいTask
      </button>
      <div className="sb-search">
        <span aria-hidden="true">🔍</span>
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
      <button type="button" className="sb-footer">
        <span aria-hidden="true">⚙</span> 設定
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
          <span className="pin" aria-hidden="true">
            📌
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
            {task.pinned ? '📌' : '📍'}
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
            {task.archived ? '⤴' : '🗄'}
          </button>
        </span>
      )}
    </div>
  );
}
