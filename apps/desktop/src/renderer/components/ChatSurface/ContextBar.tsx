import { useEffect, useId, useRef, useState } from 'react';
import { ShieldAlert } from '../icons';
import { useAppStore } from '../../store/appStore';
import {
  accessDescription,
  accessEnforcement,
  commandSandboxDescription,
  NO_WORKSPACE_ACCESS,
} from '../../lib/access-labels';
import type { ContextUsage } from '../../types/sprint-coder';
import type { AccessPreset } from '../../types/sprint-coder';
import { ProjectPicker } from '../ProjectPicker';
import { FileEditorDialog } from '../FileEditorDialog';
import { taskHasEffectiveWorkspaceRoot } from '../../lib/effective-workspace-root';

const SOURCE_LABEL: Record<ContextUsage['fragments'][number]['source'], string> = {
  system: 'システム',
  history: '履歴',
  goal: 'Goal',
  compaction: '圧縮済み',
  background: 'バックグラウンド',
  skill: 'Skill',
};

const WARNING_THRESHOLD_PCT = 80;

// ContextBar: Project / usage (§4.2). Access mode lives beside the Composer's plus button because
// it configures the next send; keeping it in this row made that action look like Project metadata.
export function ContextBar({ taskId }: { taskId: string }) {
  const hasWorkspace = useAppStore((state) => taskHasEffectiveWorkspaceRoot(taskId, state));
  return (
    <div className="context-bar">
      <ProjectPicker taskId={taskId} />
      <FileEditorDialog key={taskId} taskId={taskId} hasWorkspace={hasWorkspace} />
      <span className="ctx-spacer" />
      <ContextUsageChip taskId={taskId} />
    </div>
  );
}

const PRESET_LABEL: Record<AccessPreset, string> = {
  ask: '確認する',
  auto: '自動モード',
  full: 'フルアクセス',
};

const PRESET_DESC: Record<AccessPreset, string> = {
  ask: '作業フォルダー内の読み取りも含め、許可ルールにない操作は実行前に確認します',
  auto: '禁止ルールを優先し、許可済みの操作は自動で進めます。その他のファイル読み取りは選択中のAIが審査します',
  full: 'ほかのアプリの画面を読む、クリックする、入力する、アプリを開く操作も確認なしで行います',
};

export function PermissionChip({ taskId }: { taskId: string }) {
  const permission = useAppStore((state) => state.permissionByTask[taskId]) ?? {
    preset: 'ask' as const,
    policyEpoch: 0,
  };
  const setAccessPreset = useAppStore((state) => state.setAccessPreset);
  const pending = useAppStore((state) => state.permissionChangeByTask[taskId]) !== undefined;
  const commandSandbox = useAppStore((state) => state.commandSandbox);
  const hasWorkspace = useAppStore((state) => taskHasEffectiveWorkspaceRoot(taskId, state));
  const enforcement = accessEnforcement(hasWorkspace ? commandSandbox : null);
  const restrictionId = useId();
  const commandDescription = commandSandboxDescription(commandSandbox);
  const accessStatus = hasWorkspace ? commandDescription : NO_WORKSPACE_ACCESS;
  const restriction = enforcement === 'command-unavailable' && (
    <span id={restrictionId} className="composer-access-status" title={accessStatus}>
      {hasWorkspace ? commandDescription : 'ファイル・コマンド不可（フォルダー未設定）'}
    </span>
  );
  const [open, setOpen] = useState(false);
  const [confirmingFull, setConfirmingFull] = useState(false);
  const [reviewingRules, setReviewingRules] = useState(false);
  const [rulesStatus, setRulesStatus] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const supported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.permissions?.set === 'function';
  // The desktop-control warning names the OS file manager; only macOS calls it something else.
  const fileManagerName =
    typeof window !== 'undefined' && window.sprintCoder?.windowControls?.platform === 'darwin'
      ? 'Finder'
      : 'エクスプローラー';

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
    // Full access chosen again shows what it does too, and lets Main ask its confirmation again.
    if (preset === 'full') {
      setConfirmingFull(true);
      return;
    }
    setOpen(false);
    setConfirmingFull(false);
    void setAccessPreset(taskId, preset);
  }

  if (!supported) {
    return (
      <div className="composer-permission-wrap">
        <span className="composer-permission-chip" data-access-preset={permission.preset}>
          <ShieldAlert size={16} />
          {PRESET_LABEL[permission.preset]}
        </span>
        {restriction}
      </div>
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
        aria-busy={pending}
        aria-describedby={restriction ? restrictionId : undefined}
        disabled={pending}
        onClick={() => {
          setOpen((value) => !value);
          setConfirmingFull(false);
        }}
        data-access-preset={permission.preset}
        data-access-enforcement={enforcement}
        title={
          pending
            ? `権限の変更を確認中です。変更前の権限: ${PRESET_LABEL[permission.preset]}`
            : accessDescription(permission.preset, commandSandbox, hasWorkspace)
        }
      >
        <ShieldAlert size={16} />
        {pending ? '確認待ち' : PRESET_LABEL[permission.preset]}
      </button>
      {restriction}
      {open && (
        <div className="runtime-menu permission-menu" role="menu" aria-label="Access mode選択">
          <span className="runtime-menu-desc">{accessStatus}</span>
          {confirmingFull ? (
            <div className="permission-confirm">
              <span className="runtime-menu-title">フルアクセスの影響</span>
              <span className="runtime-menu-desc">
                {hasWorkspace &&
                  '作業フォルダー内のファイルの読み書きは確認なしで行います。読み取った内容は、秘密情報を伏せる処理を経て接続先のAIに送ります。'}
                {enforcement === 'os-sandbox' &&
                  'コマンドの実行と、実行中のコマンドへの入力も確認なしで行います。コマンドは外部と通信できないため、GitHubへの起票やpush、パッケージのダウンロードには使えません。'}
                ほかのアプリの画面を読み、クリックや入力を行い、アプリを開く操作も確認なしで行います。
                ファイルやコマンドに適用する秘密情報の保護や禁止ルールは、開いている画面（端末、
                {fileManagerName}
                、パスワード管理アプリ、ログイン済みのブラウザーやメールなど）を操作する場合には適用されません。
                撮影した画面の画像は接続先のAIに送ります。クラウドAPIに画像を送るときは、画像ごとに接続先とモデルを表示し、承認を求めます。
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
            <>
              {(['ask', 'auto', 'full'] as AccessPreset[]).map((preset) => (
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
              ))}
              <button
                type="button"
                role="menuitem"
                className="runtime-menu-item"
                disabled={reviewingRules}
                onClick={async () => {
                  setReviewingRules(true);
                  setRulesStatus('');
                  try {
                    const permissions = window.sprintCoder?.permissions;
                    if (!permissions) throw new Error('Permission service unavailable');
                    setRulesStatus(await permissions.reviewProjectRules(taskId));
                  } catch {
                    setRulesStatus('権限ルールを確認できませんでした。もう一度お試しください。');
                  } finally {
                    setReviewingRules(false);
                  }
                }}
              >
                <span className="runtime-menu-title">
                  {reviewingRules ? '権限ルールを確認中…' : 'プロジェクトの権限ルールを確認'}
                </span>
                <span className="runtime-menu-desc">
                  .sprint-coder 内の settings.json と settings.local.json を読み込みます
                </span>
              </button>
              {rulesStatus && (
                <span role="status" className="runtime-menu-desc">
                  {rulesStatus}
                </span>
              )}
            </>
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
