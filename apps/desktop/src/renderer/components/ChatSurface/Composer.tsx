import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useAppStore } from '../../store/appStore';
import type { RuntimeState } from '../../store/appStore';
import { ContextBar } from './ContextBar';
import { ArrowRightLeft, ArrowUp, Paperclip, Plus, Square } from '../icons';
import type { ClaudeEffort, QueuedInput, RuntimeKind } from '../../types/sprint-coder';

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

const MODE_ICON: Record<SendMode, typeof Plus> = {
  queue: Plus,
  steer: ArrowRightLeft,
  stopAndSend: Square,
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

  // Focus restoration after send (a11y fix, Phase 7 / NFR-A11Y-02): the textarea is
  // `disabled={sending}` for the brief window between `startTurn` firing and the `turn.accepted`
  // event reconciling it back to `false` (see appStore.ts). Disabling a focused element drops
  // keyboard focus to `document.body` — the same defocus-on-disable/inert class of bug fixed
  // elsewhere for the Team morph (TeamCanvas.tsx/TeamListView.tsx/App.tsx) — so every keyboard-only
  // message send was silently losing focus for that window. Only re-focus if it actually landed on
  // `<body>`, so a deliberate click elsewhere during that brief gap isn't overridden.
  const wasSendingRef = useRef(sending);
  useEffect(() => {
    if (wasSendingRef.current && !sending && document.activeElement === document.body) {
      textareaRef.current?.focus({ preventScroll: true });
    }
    wasSendingRef.current = sending;
  }, [sending]);

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
            <EffortChip />
            <button
              type="button"
              className="cmp-chip"
              disabled
              title="添付は今回のスコープ外です"
              aria-label="添付"
            >
              <Paperclip size={15} />
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
              {turnActive ? (
                (() => {
                  const ModeIcon = MODE_ICON[sendMode];
                  return <ModeIcon size={15} />;
                })()
              ) : (
                <ArrowUp size={15} />
              )}
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
        title={
          enabled
            ? runtime.kind === 'claude' && runtime.resolvedModel
              ? `Modelを選択（直近のTurnで実際に使用: ${runtime.resolvedModel}）`
              : 'Modelを選択'
            : 'Codex/Claude Runtime選択時にモデルを変更できます'
        }
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

const EFFORT_LEVELS: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
const EFFORT_LABEL: Record<ClaudeEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
  ultracode: 'Ultracode',
};
const EFFORT_DESC: Record<ClaudeEffort, string> = {
  low: '最速・最小のコストで応答',
  medium: '速度と精度のバランス',
  high: 'じっくり考えて応答',
  xhigh: 'より深く考えて応答',
  max: '最大限考えて応答（最も低速・高コスト）',
  ultracode: '複数エージェントを動員して最大限に検証（最も低速・高コスト）',
};

type EffortChoice = { id: string; label: string; description: string };

/** Title-cases a level id the app has no curated label for, so a level a future CLI adds still
 * renders as a name rather than a raw slug. `xhigh` keeps the hyphenated form used above. */
function effortLabel(id: string): string {
  return (
    EFFORT_LABEL[id as ClaudeEffort] ??
    (id === 'ultra' ? 'Ultra' : id.replace(/^./, (c) => c.toUpperCase()))
  );
}

/**
 * The levels offered for the active Runtime, and why the chip is disabled when it is.
 *
 * The two providers do not share a value space (issue #6). Claude's set is fixed and verified
 * against `claude --help` plus the `ultracode` probe. Codex's is per-model and published by the CLI
 * in models_cache.json, so it is read off the selected model rather than hardcoded — GPT-5.6-Sol
 * advertises `max`/`ultra` and GPT-5.5 does not, and offering a level the model has not advertised
 * fails the whole turn with an API 400 rather than falling back.
 */
function effortChoicesFor(runtime: RuntimeState): {
  choices: EffortChoice[];
  selected: string;
  disabledReason: string | null;
} {
  if (runtime.kind === 'claude') {
    if (!runtime.claudeAvailable)
      return {
        choices: [],
        selected: runtime.effort,
        disabledReason: 'Claude CLIが利用できません',
      };
    return {
      choices: EFFORT_LEVELS.map((id) => ({
        id,
        label: EFFORT_LABEL[id],
        description: EFFORT_DESC[id],
      })),
      selected: runtime.effort,
      disabledReason: null,
    };
  }
  if (runtime.kind === 'codex') {
    if (!runtime.codexAvailable)
      return { choices: [], selected: '', disabledReason: 'Codex CLIが利用できません' };
    const model = runtime.models.find(({ id }) => id === runtime.model);
    const efforts = model?.efforts ?? [];
    if (efforts.length === 0)
      return {
        choices: [],
        selected: '',
        // The `auto` sentinel is the common case here: the CLI picks the concrete model itself, so
        // there is no advertised level set to choose from and its own default applies.
        disabledReason:
          runtime.model === 'auto'
            ? 'モデルをAuto以外にするとEffortを変更できます'
            : 'このモデルはEffortの選択肢を公開していません',
      };
    return {
      choices: efforts.map(({ id, description }) => ({
        id,
        label: effortLabel(id),
        description,
      })),
      // '' means nothing is persisted, in which case the level actually in force is the model's own
      // advertised default — so showing that is accurate, not a guess.
      selected: runtime.codexEffort || model?.defaultEffort || '',
      disabledReason: null,
    };
  }
  return {
    choices: [],
    selected: '',
    disabledReason: 'Codex/Claude Runtime選択時にEffortを変更できます',
  };
}

// Effort selector (FR-SET-03 follow-up), now available for both real Runtimes. Mock has no effort
// concept at all, so it stays disabled with a static display, mirroring how ModelChip disables for
// an inactive Runtime.
function EffortChip() {
  const runtime = useAppStore((s) => s.runtime);
  const setEffort = useAppStore((s) => s.setEffort);
  const setCodexEffort = useAppStore((s) => s.setCodexEffort);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const supported =
    typeof window !== 'undefined' &&
    typeof window.sprintCoder?.settings?.setEffort === 'function' &&
    typeof window.sprintCoder?.settings?.setCodexEffort === 'function';
  const { choices, selected, disabledReason } = effortChoicesFor(runtime);
  const enabled = supported && disabledReason === null && choices.length > 0;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  function choose(effort: string) {
    setOpen(false);
    if (effort === selected) return;
    if (runtime.kind === 'claude') void setEffort(effort as ClaudeEffort);
    else void setCodexEffort(effort);
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
        data-testid="effort-selector"
        type="button"
        className="cmp-chip runtime-chip effort-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!enabled}
        onClick={() => setOpen((value) => !value)}
        title={enabled ? 'Effortを選択' : (disabledReason ?? 'Effortを変更できません')}
      >
        {`effort: ${selected === '' ? '—' : effortLabel(selected)}`}
      </button>
      {open && (
        <div className="runtime-menu effort-menu" role="menu" aria-label="Effort選択">
          {choices.map(({ id, label, description }) => (
            <button
              data-testid={`effort-option-${id}`}
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={selected === id}
              className={`runtime-menu-item${selected === id ? ' active' : ''}`}
              onClick={() => choose(id)}
            >
              <span className="runtime-menu-title">{label}</span>
              <span className="runtime-menu-desc">{description}</span>
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
