import { useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { isSameDay } from '../lib/format';
import type { TaskSummary } from '../types/vibe';

function groupTasks(tasks: TaskSummary[], query: string) {
  const q = query.trim().toLowerCase();
  const visible = tasks.filter((t) => !t.archived && (q === '' || t.title.toLowerCase().includes(q)));
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
  };
}

export function Sidebar() {
  const tasks = useAppStore((s) => s.tasks);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const selectTask = useAppStore((s) => s.selectTask);
  const createTask = useAppStore((s) => s.createTask);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => groupTasks(tasks, query), [tasks, query]);
  const isEmpty = groups.pinned.length === 0 && groups.today.length === 0 && groups.previous.length === 0;

  return (
    <nav className="sidebar" aria-label="Task履歴">
      <button type="button" className="sb-new" onClick={() => void createTask()}>
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
            <TaskGroup label="Pinned" items={groups.pinned} selectedTaskId={selectedTaskId} onSelect={selectTask} />
            <TaskGroup label="Today" items={groups.today} selectedTaskId={selectedTaskId} onSelect={selectTask} />
            <TaskGroup label="Previous" items={groups.previous} selectedTaskId={selectedTaskId} onSelect={selectTask} />
          </>
        )}
      </div>
      <button type="button" className="sb-footer">
        <span aria-hidden="true">⚙</span> 設定
      </button>
    </nav>
  );
}

function TaskGroup({
  label,
  items,
  selectedTaskId,
  onSelect,
}: {
  label: string;
  items: TaskSummary[];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="sb-group">{label}</div>
      {items.map((task) => (
        <button
          type="button"
          key={task.id}
          className={`sb-item${task.id === selectedTaskId ? ' active' : ''}`}
          aria-current={task.id === selectedTaskId ? 'true' : undefined}
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
      ))}
    </div>
  );
}
