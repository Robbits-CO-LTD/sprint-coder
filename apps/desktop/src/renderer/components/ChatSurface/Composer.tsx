import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { SkillCatalogItem, TurnSkillSelection } from '@sprint-coder/contracts';
import { useAppStore } from '../../store/appStore';
import type { RuntimeState } from '../../store/appStore';
import { ContextBar, PermissionChip } from './ContextBar';
import { ArrowUp, Paperclip, Plus, X } from '../icons';
import { ComposerMenu } from './ComposerMenu';
import { ModelPickerV2 } from '../ModelPickerV2';
import { isModelPickerV2Active } from '../../lib/model-picker-parity';
import { IMAGEGEN_PREFIX } from './imagegen';
import type { ComposerMenuItem } from './ComposerMenu';
import { SlashCommandMenu, type SlashMenuItem } from './SlashCommandMenu';
import {
  filterSlashCommands,
  inheritedProjectForNewTask,
  isStandaloneTeamCommand,
  removeSlashToken,
  SLASH_COMMANDS,
  slashTokenAtCursor,
  type SlashCommand,
  type SlashCommandId,
} from './slash-commands';
import { buildSkillSearchIndex, filterSkillSearchIndex } from './skill-picker';
import { useTaskBoundary } from '../TaskBoundary';
// Shared with the settings dialog (issue #5) so the same option can never be named two ways.
import {
  EFFORT_DESC,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  RUNTIME_DESC,
  RUNTIME_KINDS,
  RUNTIME_LABEL,
  runtimeReadinessHint,
} from '../../lib/runtime-labels';
import type { ClaudeEffort, QueuedInput, RuntimeKind } from '../../types/sprint-coder';

const EMPTY_SKILL_SELECTION: readonly TurnSkillSelection[] = [];

export function Composer({ taskId }: { taskId: string }) {
  const draft = useAppStore((s) => s.draftByTask[taskId]) ?? '';
  const setDraft = useAppStore((s) => s.setDraft);
  const setGoal = useAppStore((s) => s.setGoal);
  const startTurn = useAppStore((s) => s.startTurn);
  const queueMessage = useAppStore((s) => s.queueMessage);
  const { createTask } = useTaskBoundary();
  const currentProjectId = useAppStore(
    (state) => state.tasks.find(({ id }) => id === taskId)?.projectId ?? null,
  );
  const toggleTeamView = useAppStore((s) => s.toggleTeamView);
  const sending = useAppStore((s) => s.sendingByTask[taskId]) ?? false;
  const projectSwitching = useAppStore((s) => s.projectSwitchingByTask[taskId]) ?? false;
  const turn = useAppStore((s) => s.turnByTask[taskId]);
  const queued = useAppStore((s) => s.queuedByTask[taskId]) ?? [];
  const toast = useAppStore((s) => s.toast);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const runtime = useAppStore((s) => s.runtime);
  const currentTeam = useAppStore((s) => s.teamByTask[taskId]);
  const skillCatalog = useAppStore((s) => s.skillCatalog);
  const skillCatalogRevision = useAppStore((s) => s.skillCatalogRevision);
  const selectedSkills =
    useAppStore((s) => s.skillSelectionByTask[taskId]) ?? EMPTY_SKILL_SELECTION;
  const loadSkills = useAppStore((s) => s.loadSkills);
  const setSkillSelection = useAppStore((s) => s.setSkillSelection);
  // The V2 Model Picker replaces the legacy chip only once Main has answered `true` for *this*
  // Task (UI slice U1b). `enabled === null` (unresolved, in flight, or a backend without the
  // `models` API) and a stale answer for the previous Task both keep the legacy chip, so the flag
  // being off — or the query never arriving — is indistinguishable from today's UI.
  const modelPickerV2 = useAppStore((s) => isModelPickerV2Active(s.modelPicker, taskId));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // `/goal` changes the meaning of this same Composer for one send. It deliberately does not open
  // a second input: the armed chip and placeholder are the only extra UI needed to make the mode
  // visible and cancelable.
  const [goalRequested, setGoalRequested] = useState(false);
  // Armed by the plus menu, consumed by the next send. One-shot rather than a mode, so a user who
  // opens the menu and changes their mind is not stuck generating images.
  const [imageRequested, setImageRequested] = useState(false);
  const [slashSelection, setSlashSelection] = useState(0);
  const [slashDismissedDraft, setSlashDismissedDraft] = useState<string | null>(null);
  const [composerCursor, setComposerCursor] = useState(draft.length);

  const turnActive = turn ? turn.status === 'running' || turn.status === 'canceling' : false;

  const canQueue = typeof window.sprintCoder?.turns?.queue === 'function';
  const slashMatch = slashTokenAtCursor(draft, composerCursor);
  const slashQuery = slashMatch?.query ?? null;
  const skillIndex = useMemo(
    () => buildSkillSearchIndex(skillCatalog),
    // Main returns a stable revision. Avoid rebuilding the index when unrelated store state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillCatalogRevision],
  );
  const slashCommands = useMemo(
    () => (slashQuery === null ? [] : filterSlashCommands(SLASH_COMMANDS, slashQuery)),
    [slashQuery],
  );
  const slashSkills = useMemo(
    () => (slashQuery === null ? [] : filterSkillSearchIndex(skillIndex, slashQuery)),
    [skillIndex, slashQuery],
  );
  const { selectedSkillKeys, chatSkillCount, teamSkillCount } = useMemo(
    () => ({
      selectedSkillKeys: new Set(
        selectedSkills.map(({ ref }) => `${ref.source}:${ref.skillId}:${ref.digest}`),
      ),
      chatSkillCount: selectedSkills.filter(({ kind }) => kind === 'chat').length,
      teamSkillCount: selectedSkills.filter(({ kind }) => kind === 'team').length,
    }),
    [selectedSkills],
  );
  const goalSupported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.tasks?.setGoal === 'function';
  const teamSupported = typeof window !== 'undefined' && window.sprintCoder?.teams !== undefined;
  const slashUnavailable = useMemo<Partial<Record<SlashCommandId, string>>>(
    () => ({
      ...(!goalSupported ? { goal: 'Goal設定に対応していません' } : {}),
      ...(!teamSupported ? { team: 'Teamビューに対応していません' } : {}),
      ...(runtime.kind === 'codex' && runtime.codexReadiness === 'ready'
        ? {}
        : {
            image:
              runtime.kind === 'codex'
                ? 'Codex CLIが見つかりません'
                : 'Codex Runtime選択時に画像生成を使えます',
          }),
    }),
    [goalSupported, runtime.codexReadiness, runtime.kind, teamSupported],
  );
  const slashItems = useMemo<SlashMenuItem[]>(
    () => [
      ...slashCommands.map((command) => ({
        key: `command:${command.id}`,
        group: 'コマンド' as const,
        command: command.command,
        label: command.label,
        description: command.description,
        ...(slashUnavailable[command.id] === undefined
          ? {}
          : { unavailable: slashUnavailable[command.id] }),
      })),
      ...slashSkills.map((skill) => {
        const skillKey = `${skill.ref.source}:${skill.ref.skillId}:${skill.ref.digest}`;
        const unavailable = !skill.enabled
          ? 'このSkillは無効です'
          : selectedSkillKeys.has(skillKey)
            ? 'すでに選択されています'
            : skill.kind === 'chat' && chatSkillCount >= 5
              ? 'Chat Skillは最大5件です'
              : skill.kind === 'team' && teamSkillCount >= 1
                ? 'Team Skillは最大1件です'
                : skill.kind === 'team' &&
                    currentTeam !== null &&
                    currentTeam !== undefined &&
                    currentTeam.workers.some(({ kind }) => kind === 'worker')
                  ? 'このTaskではTeamが開始済みです。別のTeam Skillは新規Taskで使用してください'
                  : undefined;
        return {
          key: `skill:${skillKey}`,
          group:
            skill.ref.source === 'builtin'
              ? ('Built-in Skills' as const)
              : skill.kind === 'team'
                ? ('Team Skills' as const)
                : ('Chat Skills' as const),
          command: `/${skill.ref.skillId}`,
          label: skill.name,
          description: skill.description,
          ...(unavailable === undefined ? {} : { unavailable }),
        };
      }),
    ],
    [
      chatSkillCount,
      currentTeam,
      selectedSkillKeys,
      slashCommands,
      slashSkills,
      slashUnavailable,
      teamSkillCount,
    ],
  );
  const slashOpen = slashQuery !== null && draft !== slashDismissedDraft;
  const activeSlashSelection = Math.min(slashSelection, Math.max(0, slashItems.length - 1));

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  }, [draft]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

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

  const sendDisabled =
    !draft.trim() || sending || projectSwitching || (turnActive && !goalRequested && !canQueue);

  function handleSend() {
    const raw = draft.trim();
    if (!raw || sendDisabled) return;
    // Enter while the slash picker is open already runs `/team` through runSlashCommand. Keep the
    // send button and `/team ` (with a trailing space) consistent: a standalone command opens the
    // Canvas, while `/team <request>` remains a message and Main routes it through Sprint Coder
    // Team. The explicit prefix stays in history as an auditable statement of Team intent.
    if (isStandaloneTeamCommand(raw)) {
      setDraft(taskId, '');
      void toggleTeamView(taskId);
      return;
    }
    if (goalRequested) {
      setGoalRequested(false);
      setDraft(taskId, '');
      void setGoal(taskId, raw);
      return;
    }
    // The prefix goes into the stored message rather than being injected invisibly in the adapter.
    // The issue names this as an open question; traceability wins. An image appearing with no
    // explanation in the history is worse than a visible directive, and a hidden one would make
    // "why did this turn generate an image?" unanswerable after the fact.
    const text = imageRequested ? `${IMAGEGEN_PREFIX} ${raw}` : raw;
    setImageRequested(false);
    if (!turnActive) {
      void startTurn(taskId, text);
      return;
    }
    if (canQueue) void queueMessage(taskId, text);
  }

  function removeActiveSlashToken(restoreTextareaFocus = true): void {
    if (slashMatch === null) return;
    const nextDraft = removeSlashToken(draft, slashMatch);
    const nextCursor = slashMatch.start;
    setDraft(taskId, nextDraft);
    setComposerCursor(nextCursor);
    if (!restoreTextareaFocus) return;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      textareaRef.current?.focus({ preventScroll: true });
    });
  }

  function runSlashCommand(command: SlashCommand) {
    removeActiveSlashToken();
    setSlashDismissedDraft(null);
    switch (command.id) {
      case 'new':
        void createTask(inheritedProjectForNewTask(currentProjectId));
        break;
      case 'goal':
        setImageRequested(false);
        setGoalRequested(true);
        break;
      case 'team':
        void toggleTeamView(taskId);
        break;
      case 'image':
        setGoalRequested(false);
        setImageRequested(true);
        break;
    }
  }

  function selectSkill(skill: SkillCatalogItem): void {
    const selection: TurnSkillSelection = { kind: skill.kind, ref: skill.ref };
    removeActiveSlashToken();
    setSlashDismissedDraft(null);
    void setSkillSelection(taskId, [...selectedSkills, selection]);
  }

  function selectSlashItem(item: SlashMenuItem): void {
    if (item.key.startsWith('command:')) {
      const command = SLASH_COMMANDS.find(({ id }) => `command:${id}` === item.key);
      if (command) runSlashCommand(command);
      return;
    }
    const skill = slashSkills.find(
      ({ ref }) => `skill:${ref.source}:${ref.skillId}:${ref.digest}` === item.key,
    );
    if (skill) selectSkill(skill);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (slashOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissedDraft(draft);
        return;
      }
      if (slashItems.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const direction = e.key === 'ArrowDown' ? 1 : -1;
          setSlashSelection(
            (activeSlashSelection + direction + slashItems.length) % slashItems.length,
          );
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const selected = slashItems[activeSlashSelection];
          if (selected && selected.unavailable === undefined) selectSlashItem(selected);
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape' && goalRequested) {
      e.preventDefault();
      setGoalRequested(false);
    }
  }

  return (
    <div className="composer-zone">
      <div className="composer-inner">
        <QueuedList items={queued} />
        <ContextBar taskId={taskId} />
        <div className="composer">
          {slashOpen && (
            <SlashCommandMenu
              items={slashItems}
              selectedIndex={activeSlashSelection}
              onHover={setSlashSelection}
              onSelect={selectSlashItem}
            />
          )}
          {selectedSkills.length > 0 && (
            <div className="composer-skill-chips" aria-label="この送信で使用するSkill">
              {selectedSkills.map((selection) => {
                const item = skillCatalog.find(
                  ({ ref }) =>
                    ref.source === selection.ref.source &&
                    ref.skillId === selection.ref.skillId &&
                    ref.digest === selection.ref.digest,
                );
                const key = `${selection.ref.source}:${selection.ref.skillId}:${selection.ref.digest}`;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`composer-skill-chip ${selection.kind}`}
                    title={`${item?.name ?? selection.ref.skillId}をこの送信から外す`}
                    onClick={() =>
                      void setSkillSelection(
                        taskId,
                        selectedSkills.filter(
                          ({ ref }) => `${ref.source}:${ref.skillId}:${ref.digest}` !== key,
                        ),
                      )
                    }
                  >
                    <span>{selection.kind === 'team' ? 'Team' : 'Skill'}</span>
                    {item?.name ?? selection.ref.skillId}
                    <X size={12} />
                  </button>
                );
              })}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="composer-input"
            data-testid="composer-textarea"
            rows={1}
            placeholder={
              goalRequested
                ? 'Goalを入力 (Enterで保存 / Escでキャンセル)'
                : turnActive
                  ? 'Turn実行中です。既定ではキューに追加されます (Enter)'
                  : 'メッセージを送信 (Enterで送信 / Shift+Enterで改行)'
            }
            value={draft}
            disabled={sending}
            onChange={(e) => {
              const nextDraft = e.target.value;
              const nextCursor = e.target.selectionStart;
              if (slashTokenAtCursor(nextDraft, nextCursor)?.query !== slashQuery)
                setSlashSelection(0);
              setComposerCursor(nextCursor);
              setDraft(taskId, nextDraft);
            }}
            onClick={(event) => setComposerCursor(event.currentTarget.selectionStart)}
            onKeyUp={(event) => setComposerCursor(event.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            aria-label="メッセージ入力"
            aria-autocomplete="list"
            aria-controls={slashOpen ? 'composer-slash-commands' : undefined}
            aria-activedescendant={
              slashOpen && slashItems[activeSlashSelection]
                ? `slash-item-${slashItems[activeSlashSelection].key}`
                : undefined
            }
          />
          <div className="composer-row">
            <PlusMenu
              onRequestImage={() => {
                setGoalRequested(false);
                setImageRequested(true);
              }}
            />
            <PermissionChip taskId={taskId} />
            {goalRequested && (
              <button
                type="button"
                className="cmp-chip goal-armed"
                data-testid="composer-goal-armed"
                title="次の送信内容をGoalとして保存します。クリックで取り消し"
                onClick={() => setGoalRequested(false)}
              >
                Goal ×
              </button>
            )}
            {imageRequested && (
              <button
                type="button"
                className="cmp-chip imagegen-armed"
                data-testid="composer-imagegen-armed"
                title="この送信で画像生成を呼び出します。クリックで取り消し"
                onClick={() => setImageRequested(false)}
              >
                画像生成 ×
              </button>
            )}
            <div className="composer-run-controls" data-testid="composer-run-controls">
              {/* One AI control, not two: under V2 the picker names a connection *and* a model in a
                  single choice, so a separate Runtime chip would be a second, coarser control over
                  the same decision — and one the picker deliberately cannot read. With the flag
                  off the pair is exactly what it was.

                  The picker is keyed by Task: its local state (the open popup, the typed search,
                  the loaded page window, the display name of the row just chosen) all belongs to
                  one Task, so switching Tasks remounts it rather than adjusting that state during
                  render. */}
              {modelPickerV2 ? (
                <ModelPickerV2 key={taskId} taskId={taskId} />
              ) : (
                <>
                  <RuntimeChip />
                  <ModelChip />
                </>
              )}
              <EffortChip />
            </div>
            <button
              type="button"
              className="send-btn"
              data-testid="composer-send-button"
              disabled={sendDisabled}
              onClick={handleSend}
              aria-label={goalRequested ? 'Goalを保存' : turnActive ? 'キューに追加' : '送信'}
              title={
                goalRequested
                  ? 'Goalを保存'
                  : turnActive
                    ? '現在の実行が終わったら送信します'
                    : '送信'
              }
            >
              <ArrowUp size={15} />
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
    if (kind === 'codex' && runtime.codexReadiness !== 'ready') return;
    if (kind === 'claude' && runtime.claudeReadiness !== 'ready') return;
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
          {RUNTIME_KINDS.map((kind) => {
            const disabled =
              (kind === 'codex' && runtime.codexReadiness !== 'ready') ||
              (kind === 'claude' && runtime.claudeReadiness !== 'ready');
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
                    ? (runtimeReadinessHint(
                        kind,
                        kind === 'codex' ? runtime.codexReadiness : runtime.claudeReadiness,
                      ) ?? undefined)
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
    ((runtime.kind === 'codex' && runtime.codexReadiness === 'ready') ||
      (runtime.kind === 'claude' && runtime.claudeReadiness === 'ready'));
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

type EffortChoice = { id: string; label: string; description: string };

/** Title-cases a level id the app has no curated label for, so a level a future CLI adds still
 * renders as a name rather than a raw slug. `xhigh` keeps the hyphenated form used above. */
function effortLabel(id: string): string {
  return (
    EFFORT_LABEL[id as ClaudeEffort] ??
    (id === 'ultra' ? 'Ultra' : id.replace(/^./, (c) => c.toUpperCase()))
  );
}

/** Compact Japanese labels keep Model + Effort readable as one control cluster in the Composer. */
function compactEffortLabel(id: string): string {
  const labels: Record<string, string> = {
    low: '低',
    medium: '中程度',
    high: '高',
    xhigh: '非常に高',
    max: '最大',
    ultra: 'Ultra',
    ultracode: 'Ultracode',
  };
  return labels[id] ?? effortLabel(id);
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
    if (runtime.claudeReadiness !== 'ready')
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
    if (runtime.codexReadiness !== 'ready')
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
        {selected === '' ? '—' : compactEffortLabel(selected)}
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

// Composer plus menu (issue #13). Replaces the permanently-`disabled` paperclip button, which
// advertised an affordance the app did not have; attachment becomes one entry in this menu instead,
// so there is nothing left for a standalone clip button to mean.
//
// Items the app cannot honour yet are shown and announced unavailable with the reason, matching how
// the Runtime/Effort chips already treat an unusable option — hiding them would leave the user
// wondering whether the feature exists at all.
function PlusMenu({ onRequestImage }: { onRequestImage: () => void }) {
  const runtime = useAppStore((s) => s.runtime);

  const items: ComposerMenuItem[] = [
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
      description: '次の送信でCodexの画像生成を呼び出す',
      icon: <Plus size={14} />,
      // Codex-only: `$imagegen` is a Codex CLI facility with no Claude equivalent.
      ...(runtime.kind === 'codex' && runtime.codexReadiness === 'ready'
        ? { onSelect: onRequestImage }
        : {
            unavailableReason:
              runtime.kind === 'codex'
                ? 'Codex CLIが見つかりません'
                : 'Codex Runtime選択時に画像生成を使えます',
          }),
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
