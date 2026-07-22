import { useEffect, useRef, useState } from 'react';
import { WorkspaceChip } from '../WorkspaceChip';
import { useAppStore } from '../../store/appStore';
import type { ContextUsage } from '../../types/vibe';

const SOURCE_LABEL: Record<ContextUsage['fragments'][number]['source'], string> = {
  system: 'システム',
  history: '履歴',
  goal: 'Goal',
  compaction: '圧縮済み',
};

const WARNING_THRESHOLD_PCT = 80;

// ContextBar: workspace / branch / permission preset / usage (§4.2). Workspace is backed by
// real data (workspace.get/select) via WorkspaceChip; branch/permission chips remain
// placeholders until their APIs land on the preload contract. The usage chip reflects real
// contextUsage data (TurnSnapshot.contextUsage / `context.usage` events) and degrades to a
// plain "context —" display while the backend hasn't sent any data yet.
export function ContextBar({ taskId }: { taskId: string }) {
  return (
    <div className="context-bar">
      <WorkspaceChip taskId={taskId} variant="context" />
      <span className="ctx-chip">確認して実行</span>
      <span className="ctx-spacer" />
      <ContextUsageChip taskId={taskId} />
    </div>
  );
}

function ContextUsageChip({ taskId }: { taskId: string }) {
  const usage = useAppStore((s) => s.contextUsageByTask[taskId]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  // Data not arrived yet (backend hasn't wired context-usage tracking, or no turn has run):
  // render a plain, non-interactive placeholder rather than a button with nothing to show.
  if (!usage || usage.hardCapTokens <= 0) {
    return <span className="ctx-chip">context —</span>;
  }

  const pct = Math.min(999, Math.ceil((usage.usedTokens / usage.hardCapTokens) * 100));
  const warning = pct > WARNING_THRESHOLD_PCT;

  return (
    <div
      className="ctx-usage-wrap"
      ref={wrapRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="ctx-chip chip-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="コンテキスト使用量の内訳を表示"
      >
        <span className={warning ? 'ctx-usage-warning' : undefined}>context {pct}%</span>
      </button>
      {open && (
        <div className="ctx-usage-popover" role="dialog" aria-label="コンテキスト使用量の内訳">
          <div className={warning ? 'ctx-usage-total ctx-usage-warning' : 'ctx-usage-total'}>
            {usage.usedTokens.toLocaleString()} / {usage.hardCapTokens.toLocaleString()} tokens
          </div>
          <ul className="ctx-usage-list">
            {usage.fragments.map((fragment) => (
              <li key={fragment.source} className="ctx-usage-row">
                <span className="ctx-usage-label">{SOURCE_LABEL[fragment.source]}</span>
                <span className="ctx-usage-tokens">{fragment.tokens.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
