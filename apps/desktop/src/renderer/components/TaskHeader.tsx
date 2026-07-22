import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { TaskSummary } from '../types/vibe';

export function TaskHeader({ task }: { task: TaskSummary }) {
  const renameTask = useAppStore((s) => s.renameTask);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraftTitle(task.title);
  }, [task.title, editing]);

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
    <header className="task-header">
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
      <span className="goal-chip" title="Goal編集は今後のフェーズで対応予定です">
        🎯 Goal: 未設定
      </span>
      <button
        type="button"
        className="team-btn"
        disabled
        title="Team機能は今回のスコープ外です"
        aria-disabled="true"
      >
        ⬡ Team
      </button>
      <button type="button" className="icon-btn" disabled title="今回のスコープ外です" aria-disabled="true">
        ⋯
      </button>
    </header>
  );
}
