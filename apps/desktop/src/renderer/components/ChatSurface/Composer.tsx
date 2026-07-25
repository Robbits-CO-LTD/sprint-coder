import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useAppStore } from '../../store/appStore';
import { ContextBar } from './ContextBar';
import { ArrowRightLeft, ArrowUp, Paperclip, Plus, Square, Target } from '../icons';
import { ComposerMenu } from './ComposerMenu';
import type { ComposerMenuItem } from './ComposerMenu';
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
  // Goal editing moved here from the header (issue #13): TaskHeader's chip is now a read-only
  // display of the current value, and the plus menu is the single entry point for changing it.
  const [goalEditing, setGoalEditing] = useState(false);

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
        {goalEditing && <GoalEditor taskId={taskId} onDone={() => setGoalEditing(false)} />}
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
            <PlusMenu taskId={taskId} onSetGoal={() => setGoalEditing(true)} />
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

const EFFORT_LEVELS: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL: Record<ClaudeEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};
const EFFORT_DESC: Record<ClaudeEffort, string> = {
  low: '最速・最小のコストで応答',
  medium: '速度と精度のバランス',
  high: 'じっくり考えて応答',
  xhigh: 'より深く考えて応答',
  max: '最大限考えて応答（最も低速・高コスト）',
};

// Effort selector (FR-SET-03 follow-up). Verified empirically against the installed Claude CLI
// (2.1.218, `claude --help`): `--effort <level>` accepts exactly these 5 values and is honored
// per-turn (see the ADR amendment) — unlike the model chip, this control is Claude-only: Codex
// has no equivalent flag on this CLI version, and mock has no effort concept at all, so both stay
// disabled with a static display, mirroring how ModelChip disables for an inactive Runtime.
function EffortChip() {
  const runtime = useAppStore((s) => s.runtime);
  const setEffort = useAppStore((s) => s.setEffort);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const supported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.settings?.setEffort === 'function';
  const enabled = supported && runtime.kind === 'claude' && runtime.claudeAvailable;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  function choose(effort: ClaudeEffort) {
    setOpen(false);
    if (effort !== runtime.effort) void setEffort(effort);
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
        title={enabled ? 'Effortを選択' : 'Claude Runtime選択時にEffortを変更できます'}
      >
        {`effort: ${EFFORT_LABEL[runtime.effort]}`}
      </button>
      {open && (
        <div className="runtime-menu effort-menu" role="menu" aria-label="Effort選択">
          {EFFORT_LEVELS.map((effort) => (
            <button
              data-testid={`effort-option-${effort}`}
              key={effort}
              type="button"
              role="menuitemradio"
              aria-checked={runtime.effort === effort}
              className={`runtime-menu-item${runtime.effort === effort ? ' active' : ''}`}
              onClick={() => choose(effort)}
            >
              <span className="runtime-menu-title">{EFFORT_LABEL[effort]}</span>
              <span className="runtime-menu-desc">{EFFORT_DESC[effort]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Composer plus menu (issue #13). Replaces the permanently-`disabled` paperclip button, which
// advertised an affordance the app did not have; attachment becomes one entry in this menu instead,
// so there is nothing left for a standalone clip button to mean.
//
// Items the app cannot honour yet are shown and announced unavailable with the reason, matching how
// the Runtime/Effort chips already treat an unusable option — hiding them would leave the user
// wondering whether the feature exists at all.
function PlusMenu({ taskId, onSetGoal }: { taskId: string; onSetGoal: () => void }) {
  const goal = useAppStore((s) => s.tasks.find((t) => t.id === taskId)?.goal ?? null);
  const runtime = useAppStore((s) => s.runtime);
  const goalSupported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.tasks?.setGoal === 'function';

  const items: ComposerMenuItem[] = [
    {
      id: 'goal',
      label: 'ゴールを設定',
      description: goal === null || goal === '' ? '未設定' : goal,
      icon: <Target size={14} />,
      ...(goalSupported
        ? { onSelect: onSetGoal }
        : { unavailableReason: 'Goal編集に対応していません' }),
    },
    {
      id: 'attach',
      label: 'ファイルを添付',
      description: '会話にファイルを添える',
      icon: <Paperclip size={14} />,
      // Genuinely unimplemented end to end: there is no attachment type in the contracts, so IPC,
      // persistence and rendering are all still missing.
      unavailableReason: '添付は未実装です',
    },
    {
      id: 'imagegen',
      label: '画像を生成',
      description: 'Codexの画像生成を呼び出す',
      icon: <Plus size={14} />,
      // Codex-only by design, and blocked besides — see #11 for the read-only-sandbox problem that
      // has to be solved before a generated image can be saved or shown at all.
      unavailableReason:
        runtime.kind === 'codex'
          ? '画像生成は未実装です'
          : 'Codex Runtime選択時に画像生成を使えます',
    },
  ];

  return (
    <ComposerMenu
      items={items}
      triggerTestId="composer-plus"
      triggerLabel="操作を追加"
      menuLabel="Composerの操作"
      triggerIcon={<Plus size={15} />}
    />
  );
}

// Inline Goal editor, opened from the plus menu. Mirrors the interaction the header chip used to
// own (Enter commits, Escape cancels, blur commits) so the muscle memory carries over.
function GoalEditor({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const goal = useAppStore((s) => s.tasks.find((t) => t.id === taskId)?.goal ?? '');
  const setGoal = useAppStore((s) => s.setGoal);
  const [draft, setDraft] = useState(goal);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed !== goal) void setGoal(taskId, trimmed);
    onDone();
  }

  return (
    <div className="goal-editor">
      <label className="goal-editor-label" htmlFor={`goal-input-${taskId}`}>
        <Target size={13} /> Goal
      </label>
      <input
        ref={inputRef}
        id={`goal-input-${taskId}`}
        className="goal-input"
        data-testid="composer-goal-input"
        value={draft}
        placeholder="このTaskのゴールを入力"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
        }}
      />
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
