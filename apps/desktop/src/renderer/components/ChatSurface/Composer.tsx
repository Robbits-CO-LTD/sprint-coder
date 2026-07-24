import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useAppStore } from '../../store/appStore';
import { ContextBar } from './ContextBar';
import type { QueuedInput, RuntimeKind } from '../../types/sprint-coder';

const STEER_UNSUPPORTED_HINT =
  '選択中のruntimeでは実行中の追加指示に対応していません。キュー追加を使ってください';

type SendMode = 'queue' | 'steer' | 'stopAndSend';

const MODE_LABEL: Record<SendMode, string> = {
  queue: 'キュー',
  steer: 'Steer',
  stopAndSend: 'Stop & Send',
};

const MODE_HINT: Record<SendMode, string> = {
  queue: '生成完了後にキューへ追加します',
  steer: '実行中のTurnへ追加指示を送ります（Turnが切り替わると送信し直しが必要です）',
  stopAndSend: '実行中のTurnを停止し、直ちにこのメッセージで開始します',
};

const MODE_ICON: Record<SendMode, string> = {
  queue: '➕',
  steer: '⇄',
  stopAndSend: '⏹',
};

export function Composer({ taskId }: { taskId: string }) {
  const draft = useAppStore((s) => s.draftByTask[taskId]) ?? '';
  const setDraft = useAppStore((s) => s.setDraft);
  const startTurn = useAppStore((s) => s.startTurn);
  const queueMessage = useAppStore((s) => s.queueMessage);
  const steerMessage = useAppStore((s) => s.steerMessage);
  const stopAndSend = useAppStore((s) => s.stopAndSend);
  const sending = useAppStore((s) => s.sendingByTask[taskId]) ?? false;
  const turn = useAppStore((s) => s.turnByTask[taskId]);
  const queued = useAppStore((s) => s.queuedByTask[taskId]) ?? [];
  const toast = useAppStore((s) => s.toast);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const runtime = useAppStore((s) => s.runtime);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [sendMode, setSendMode] = useState<SendMode>('queue');
  const [wasTurnActive, setWasTurnActive] = useState(false);

  const turnActive = turn ? turn.status === 'running' || turn.status === 'canceling' : false;

  const canQueue = typeof window.sprintCoder?.turns?.queue === 'function';
  const canSteer = typeof window.sprintCoder?.turns?.steer === 'function';
  const canStopAndSend = typeof window.sprintCoder?.turns?.stopAndSend === 'function';
  const hasAnyActiveModeCapability = canQueue || canSteer || canStopAndSend;
  // Codex and Claude runtimes are headless single-shot invocations and do not support mid-turn
  // steering (STEER_UNSUPPORTED) — the Steer segment stays visible but disabled so the user
  // understands why, per FR-SET-03.
  const steerBlockedByRuntime = runtime.kind === 'codex' || runtime.kind === 'claude';

  // Reset the mode selector back to the default once the turn finishes (render-time adjustment
  // instead of an effect, per react-hooks/set-state-in-effect).
  if (turnActive !== wasTurnActive) {
    setWasTurnActive(turnActive);
    if (!turnActive) setSendMode('queue');
  }
  // Likewise, fall back off Steer if the runtime switches to Codex or Claude while it's selected.
  if (sendMode === 'steer' && steerBlockedByRuntime) {
    setSendMode('queue');
  }

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  }, [draft]);

  const activeModeCapable =
    sendMode === 'queue'
      ? canQueue
      : sendMode === 'steer'
        ? canSteer && !steerBlockedByRuntime
        : canStopAndSend;
  const sendDisabled = !draft.trim() || sending || (turnActive && !activeModeCapable);

  function handleSend() {
    const text = draft.trim();
    if (!text || sendDisabled) return;
    if (!turnActive) {
      void startTurn(taskId, text);
      return;
    }
    if (sendMode === 'steer' && canSteer && !steerBlockedByRuntime && turn) {
      void steerMessage(taskId, text, turn.turnId);
    } else if (sendMode === 'stopAndSend' && canStopAndSend) {
      void stopAndSend(taskId, text);
    } else if (canQueue) {
      void queueMessage(taskId, text);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="composer-zone">
      <div className="composer-inner">
        <ContextBar taskId={taskId} />
        <QueuedList items={queued} />
        <div className="composer">
          <textarea
            ref={textareaRef}
            className="composer-input"
            data-testid="composer-textarea"
            rows={1}
            placeholder={
              turnActive
                ? 'Turn実行中です。既定ではキューに追加されます (Enter)'
                : 'メッセージを送信 (Enterで送信 / Shift+Enterで改行)'
            }
            value={draft}
            disabled={sending}
            onChange={(e) => setDraft(taskId, e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="メッセージ入力"
          />
          <div className="composer-row">
            <RuntimeChip />
            <ModelChip />
            <button
              type="button"
              className="cmp-chip"
              disabled
              title="Reasoning effort選択は今回のスコープ外です"
            >
              effort: medium
            </button>
            <button
              type="button"
              className="cmp-chip"
              disabled
              title="添付は今回のスコープ外です"
              aria-label="添付"
            >
              📎
            </button>
            {turnActive && hasAnyActiveModeCapability && (
              <div className="send-mode-group" role="group" aria-label="実行中の送信方法">
                {(['queue', 'steer', 'stopAndSend'] as SendMode[])
                  .filter((mode) =>
                    mode === 'queue' ? canQueue : mode === 'steer' ? canSteer : canStopAndSend,
                  )
                  .map((mode) => {
                    const blocked = mode === 'steer' && steerBlockedByRuntime;
                    return (
                      <button
                        key={mode}
                        type="button"
                        className={`send-mode-btn${sendMode === mode ? ' active' : ''}`}
                        onClick={() => {
                          if (!blocked) setSendMode(mode);
                        }}
                        disabled={blocked}
                        aria-disabled={blocked || undefined}
                        title={blocked ? STEER_UNSUPPORTED_HINT : MODE_HINT[mode]}
                        aria-pressed={sendMode === mode}
                      >
                        {MODE_LABEL[mode]}
                      </button>
                    );
                  })}
              </div>
            )}
            <button
              type="button"
              className="send-btn"
              data-testid="composer-send-button"
              disabled={sendDisabled}
              onClick={handleSend}
              aria-label={turnActive ? `${MODE_LABEL[sendMode]}で送信` : '送信'}
              title={turnActive ? MODE_HINT[sendMode] : '送信'}
            >
              {turnActive ? MODE_ICON[sendMode] : '↑'}
            </button>
          </div>
        </div>
      </div>
      {toast && (
        <div className="surface-toast" role="status" onClick={dismissToast}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

const RUNTIME_LABEL: Record<RuntimeKind, string> = {
  mock: 'Mock Runtime',
  codex: 'Codex',
  claude: 'Claude Code',
};

const RUNTIME_DESC: Record<RuntimeKind, string> = {
  mock: '決定論的ローカル応答',
  codex: 'ローカルのCodex CLIで実応答',
  claude: 'ローカルのClaude Code CLIで実応答',
};

const RUNTIME_CLI_MISSING_HINT: Record<'codex' | 'claude', string> = {
  codex: 'Codex CLIが見つかりません',
  claude: 'Claude CLIが見つかりません',
};

// Runtime selector chip (FR-SET-03). Falls back to the legacy dummy "GPT-6.2 mini" chip when
// the backend hasn't wired the `settings` API yet — graceful degrade per the sprint-coder.d.ts contract.
function RuntimeChip() {
  const runtimeSupported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.settings?.getRuntime === 'function';
  const runtime = useAppStore((s) => s.runtime);
  const setRuntime = useAppStore((s) => s.setRuntime);
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

  if (!runtimeSupported) {
    return (
      <button type="button" className="cmp-chip" disabled title="モデル選択は今回のスコープ外です">
        GPT-6.2 mini
      </button>
    );
  }

  function choose(kind: RuntimeKind) {
    if (kind === 'codex' && !runtime.codexAvailable) return;
    if (kind === 'claude' && !runtime.claudeAvailable) return;
    setOpen(false);
    if (kind !== runtime.kind) void setRuntime(kind);
  }

  return (
    <div
      className="runtime-chip-wrap"
      ref={wrapRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <button
        data-testid="runtime-selector"
        type="button"
        className="cmp-chip runtime-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Runtimeを選択"
      >
        {RUNTIME_LABEL[runtime.kind]}
      </button>
      {open && (
        <div className="runtime-menu" role="menu" aria-label="Runtime選択">
          {(['mock', 'codex', 'claude'] as RuntimeKind[]).map((kind) => {
            const disabled =
              (kind === 'codex' && !runtime.codexAvailable) ||
              (kind === 'claude' && !runtime.claudeAvailable);
            return (
              <button
                data-testid={`runtime-option-${kind}`}
                key={kind}
                type="button"
                role="menuitemradio"
                aria-checked={runtime.kind === kind}
                className={`runtime-menu-item${runtime.kind === kind ? ' active' : ''}`}
                disabled={disabled}
                title={
                  disabled && (kind === 'codex' || kind === 'claude')
                    ? RUNTIME_CLI_MISSING_HINT[kind]
                    : undefined
                }
                onClick={() => choose(kind)}
              >
                <span className="runtime-menu-title">{RUNTIME_LABEL[kind]}</span>
                <span className="runtime-menu-desc">{RUNTIME_DESC[kind]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModelChip() {
  const runtime = useAppStore((s) => s.runtime);
  const setModel = useAppStore((s) => s.setModel);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const supported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.settings?.setModel === 'function';
  const enabled =
    supported &&
    ((runtime.kind === 'codex' && runtime.codexAvailable) ||
      (runtime.kind === 'claude' && runtime.claudeAvailable));
  const selected = runtime.models.find(({ id }) => id === runtime.model) ?? {
    id: runtime.model,
    displayName: runtime.model,
    description: '',
  };

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  function choose(model: string) {
    setOpen(false);
    if (model !== runtime.model) void setModel(model);
  }

  return (
    <div
      className="runtime-chip-wrap"
      ref={wrapRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <button
        data-testid="model-selector"
        type="button"
        className="cmp-chip runtime-chip model-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!enabled}
        onClick={() => setOpen((value) => !value)}
        title={enabled ? 'Modelを選択' : 'Codex/Claude Runtime選択時にモデルを変更できます'}
      >
        {selected.displayName}
      </button>
      {open && (
        <div className="runtime-menu model-menu" role="menu" aria-label="Model選択">
          {runtime.models.map((model) => (
            <button
              data-testid={`model-option-${model.id}`}
              key={model.id}
              type="button"
              role="menuitemradio"
              aria-checked={runtime.model === model.id}
              className={`runtime-menu-item${runtime.model === model.id ? ' active' : ''}`}
              onClick={() => choose(model.id)}
            >
              <span className="runtime-menu-title">{model.displayName}</span>
              <span className="runtime-menu-desc">{model.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QueuedList({ items }: { items: QueuedInput[] }) {
  if (items.length === 0) return null;
  return (
    <div className="queued-list" aria-label="キュー投入済みの入力">
      {items.map((item) => (
        <div key={item.ordinal} className="queued-item" data-testid="queued-item">
          <span className="queued-ordinal">#{item.ordinal}</span>
          <span className="queued-text">{item.text}</span>
        </div>
      ))}
    </div>
  );
}
