import { useEffect, useRef, useState } from 'react';
import { WorkspaceChip } from '../WorkspaceChip';
import { ShieldAlert } from '../icons';
import { useAppStore } from '../../store/appStore';
import { accessDescription, accessEnforcement } from '../../lib/access-labels';
import type { ContextUsage } from '../../types/sprint-coder';
import type { AccessPreset } from '../../types/sprint-coder';
import { openProjectContext } from '../../lib/project-inspector';

const SOURCE_LABEL: Record<ContextUsage['fragments'][number]['source'], string> = {
  system: 'システム',
  history: '履歴',
  goal: 'Goal',
  compaction: '圧縮済み',
  background: 'バックグラウンド',
  skill: 'Skill',
};

const WARNING_THRESHOLD_PCT = 80;

// ContextBar: workspace / usage (§4.2). Access mode lives beside the Composer's plus button because
// it configures the next send; keeping it in this row made that action look like workspace metadata.
export function ContextBar({ taskId }: { taskId: string }) {
  const projectId = useAppStore(
    (state) => state.tasks.find((task) => task.id === taskId)?.projectId,
  );
  const project = useAppStore((state) => state.projects.find((item) => item.id === projectId));
  return (
    <div className="context-bar">
      <WorkspaceChip taskId={taskId} variant="context" />
      {project !== undefined && (
        <button
          type="button"
          className="ctx-chip chip-btn ctx-project-chip"
          data-testid="project-context-chip"
          onClick={() => openProjectContext(taskId)}
          title="ProjectのInstructionとTurn contextを表示"
        >
          Project: {project.name}
        </button>
      )}
      <span className="ctx-spacer" />
      <ContextUsageChip taskId={taskId} />
    </div>
  );
}

const PRESET_LABEL: Record<AccessPreset, string> = {
  ask: '確認する',
  auto: '安全時は自動',
  full: 'フルアクセス',
};

const PRESET_DESC: Record<AccessPreset, string> = {
  ask: '権限が必要な操作は毎回確認します',
  auto: '安全と証明できた操作だけ自動許可します',
  full: '広い操作を許可しますが、管理denyと秘密保護は維持します',
};

export function PermissionChip({ taskId }: { taskId: string }) {
  const permission = useAppStore((state) => state.permissionByTask[taskId]) ?? {
    preset: 'ask' as const,
    policyEpoch: 0,
  };
  const setAccessPreset = useAppStore((state) => state.setAccessPreset);
  const runtimeKind = useAppStore((state) => state.runtime.kind);
  const enforcement = accessEnforcement(permission.preset, runtimeKind);
  const [open, setOpen] = useState(false);
  const [confirmingFull, setConfirmingFull] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const supported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.permissions?.set === 'function';

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
        setConfirmingFull(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  function choose(preset: AccessPreset) {
    if (preset === 'full' && permission.preset !== 'full') {
      setConfirmingFull(true);
      return;
    }
    setOpen(false);
    setConfirmingFull(false);
    void setAccessPreset(taskId, preset);
  }

  if (!supported) {
    return (
      <span className="composer-permission-chip" data-access-preset={permission.preset}>
        <ShieldAlert size={16} />
        {PRESET_LABEL[permission.preset]}
      </span>
    );
  }

  return (
    <div
      className="ctx-permission-wrap composer-permission-wrap"
      ref={wrapRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
          setConfirmingFull(false);
        }
      }}
    >
      <button
        data-testid="access-selector"
        type="button"
        className="composer-permission-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setConfirmingFull(false);
        }}
        data-access-preset={permission.preset}
        data-access-enforcement={enforcement}
        title={accessDescription(permission.preset, runtimeKind)}
      >
        <ShieldAlert size={16} />
        {PRESET_LABEL[permission.preset]}
        {/* Moved here from the TaskHeader when the duplicate chips were removed (issue #47). It must
            travel with the control, not be dropped: this is the one place the app admits that a
            write-capable Claude is not sandboxed by anything the app enforces (issue #37). A word,
            never only a colour. */}
        {enforcement === 'trusted-unmanaged' && (
          <span className="access-unmanaged" data-testid="access-unmanaged">
            非サンドボックス
          </span>
        )}
      </button>
      {open && (
        <div className="runtime-menu permission-menu" role="menu" aria-label="Access mode選択">
          {confirmingFull ? (
            <div className="permission-confirm">
              <span className="runtime-menu-title">フルアクセスの影響</span>
              <span className="runtime-menu-desc">
                Workspace操作、Shell、Networkなどをpolicy上は許可します。実際の書込み・コマンド実行は
                安全な実行境界が完成した機能だけ利用できます。管理deny、秘密情報、provider egress、
                Renderer非特権は常に維持されます。
              </span>
              <button
                data-testid="access-full-confirm"
                type="button"
                className="permission-confirm-action"
                onClick={() => {
                  setOpen(false);
                  setConfirmingFull(false);
                  void setAccessPreset(taskId, 'full');
                }}
              >
                影響を理解してフルアクセスにする
              </button>
              <button
                type="button"
                className="permission-confirm-cancel"
                onClick={() => setConfirmingFull(false)}
              >
                戻る
              </button>
            </div>
          ) : (
            (['ask', 'auto', 'full'] as AccessPreset[]).map((preset) => (
              <button
                key={preset}
                data-testid={`access-option-${preset}`}
                type="button"
                role="menuitemradio"
                aria-checked={permission.preset === preset}
                className={`runtime-menu-item${permission.preset === preset ? ' active' : ''}`}
                onClick={() => choose(preset)}
              >
                <span className="runtime-menu-title">{PRESET_LABEL[preset]}</span>
                <span className="runtime-menu-desc">{PRESET_DESC[preset]}</span>
              </button>
            ))
          )}
        </div>
      )}
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
            <li className="ctx-usage-row" data-testid="context-project-tokens">
              <span className="ctx-usage-label">Project</span>
              <span className="ctx-usage-tokens">{usage.projectTokens.toLocaleString()}</span>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
