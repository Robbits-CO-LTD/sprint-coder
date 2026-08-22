import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, RefObject } from 'react';
import type { GoalSummary, SkillCatalogItem, TurnSkillSelection } from '@sprint-coder/contracts';
import { useAppStore } from '../../store/appStore';
import type { RuntimeState } from '../../store/appStore';
import { ContextBar, PermissionChip } from './ContextBar';
import { ArrowUp, Paperclip, Pause, Pencil, Play, Plus, Square, Target, Trash, X } from '../icons';
import { ComposerMenu } from './ComposerMenu';
import { ModelPickerV2 } from '../ModelPickerV2';
import { isModelPickerV2Active } from '../../lib/model-picker-parity';
import { IMAGEGEN_PREFIX } from './imagegen';
import type { ComposerMenuItem } from './ComposerMenu';
import { SlashCommandMenu, type SlashMenuItem } from './SlashCommandMenu';
import {
  filterSlashCommands,
  inheritedProjectForNewTask,
  removeSlashToken,
  shouldOpenTeamCanvas,
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
import type {
  ClaudeEffort,
  ImageAttachmentMetadata,
  QueuedInput,
  RuntimeKind,
} from '../../types/sprint-coder';

const EMPTY_SKILL_SELECTION: readonly TurnSkillSelection[] = [];

export type ComposerActionKind = 'send' | 'queue' | 'cancel';

export function composerSubmitShortcut(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): 'submit' | 'none' {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing ? 'submit' : 'none';
}

export function composerMessageText(raw: string, imageRequested: boolean): string {
  return imageRequested ? `${IMAGEGEN_PREFIX} ${raw}` : raw;
}

export function imageRequestFailureRecovery(input: {
  currentDraft: string;
  rawDraft: string;
  imageRequested: boolean;
  draftRestored: boolean;
  imageModeUnchanged: boolean;
}): { draft: string; rearm: boolean } {
  return input.imageRequested && input.draftRestored && input.imageModeUnchanged
    ? { draft: input.rawDraft, rearm: true }
    : { draft: input.currentDraft, rearm: false };
}

export type ComposerActionPolicy = Readonly<{
  primary: Readonly<{
    kind: ComposerActionKind;
    label: string;
    title: string;
    disabled: boolean;
    busy: boolean;
  }>;
  interrupt: Readonly<{
    visible: boolean;
    label: string;
    title: string;
    disabled: boolean;
  }>;
}>;

export function composerActionPolicy(input: {
  turnStatus: 'idle' | 'running' | 'canceling';
  hasDraft: boolean;
  canQueue: boolean;
  canStopAndSend: boolean;
  canCancel: boolean;
  actionPending: boolean;
  sendBlocked: boolean;
}): ComposerActionPolicy {
  const canceling = input.turnStatus === 'canceling';
  const running = input.turnStatus === 'running';
  const unavailableSuffix = '（この環境では利用できません）';
  const interruptVisible = input.turnStatus !== 'idle' && input.hasDraft;

  if (canceling || (running && !input.hasDraft)) {
    const unavailable = !input.canCancel;
    return {
      primary: {
        kind: 'cancel',
        label: unavailable ? `実行を停止${unavailableSuffix}` : '実行を停止',
        title: canceling
          ? '実行を停止しています'
          : unavailable
            ? 'この環境では実行を停止できません'
            : '実行を停止',
        disabled: canceling || input.actionPending || unavailable,
        busy: canceling || input.actionPending,
      },
      interrupt: {
        visible: interruptVisible,
        label: !input.canStopAndSend ? `割り込んで送信${unavailableSuffix}` : '割り込んで送信',
        title: !input.canStopAndSend
          ? 'この環境では割り込み送信を利用できません'
          : '現在の実行を停止して、すぐに送信します',
        disabled: true,
      },
    };
  }

  if (running) {
    const unavailable = !input.canQueue;
    return {
      primary: {
        kind: 'queue',
        label: unavailable ? `キューに追加${unavailableSuffix}` : 'キューに追加',
        title: unavailable
          ? 'この環境ではキュー追加を利用できません'
          : '現在の実行が終わったら送信します',
        disabled: input.actionPending || input.sendBlocked || unavailable,
        busy: false,
      },
      interrupt: {
        visible: true,
        label: !input.canStopAndSend ? `割り込んで送信${unavailableSuffix}` : '割り込んで送信',
        title: !input.canStopAndSend
          ? 'この環境では割り込み送信を利用できません'
          : '現在の実行を停止して、すぐに送信します',
        disabled: input.actionPending || input.sendBlocked || !input.canStopAndSend,
      },
    };
  }

  return {
    primary: {
      kind: 'send',
      label: '送信',
      title: '送信',
      disabled: !input.hasDraft || input.actionPending || input.sendBlocked,
      busy: false,
    },
    interrupt: {
      visible: false,
      label: '割り込んで送信',
      title: '現在の実行を停止して、すぐに送信します',
      disabled: true,
    },
  };
}

export function ComposerActionButtons({
  policy,
  onPrimary,
  onInterrupt,
}: {
  policy: ComposerActionPolicy;
  onPrimary: () => void;
  onInterrupt: () => void;
}) {
  const unavailableReasons = [policy.primary, policy.interrupt]
    .filter((action) => action.label.includes('この環境では利用できません'))
    .map((action) => action.title);
  return (
    <div className="composer-action-buttons">
      {unavailableReasons.length > 0 && (
        <span className="composer-action-unavailable" role="status">
          {unavailableReasons.join(' / ')}
        </span>
      )}
      {policy.interrupt.visible && (
        <button
          type="button"
          className="composer-interrupt-btn"
          data-testid="composer-interrupt-button"
          disabled={policy.interrupt.disabled}
          onClick={onInterrupt}
          aria-label={policy.interrupt.label}
          title={policy.interrupt.title}
        >
          <Square size={11} />
          <span>{policy.interrupt.label}</span>
        </button>
      )}
      <button
        type="button"
        className={`send-btn ${policy.primary.kind === 'cancel' ? 'stop' : policy.primary.kind}`}
        data-testid="composer-send-button"
        disabled={policy.primary.disabled}
        onClick={onPrimary}
        aria-label={policy.primary.label}
        aria-busy={policy.primary.busy || undefined}
        title={policy.primary.title}
      >
        {policy.primary.kind === 'cancel' ? (
          <Square size={13} />
        ) : (
          <>
            {policy.primary.kind === 'queue' && <span className="send-btn-label">キュー</span>}
            <ArrowUp size={15} />
          </>
        )}
      </button>
    </div>
  );
}

export function Composer({ taskId }: { taskId: string }) {
  const draft = useAppStore((s) => s.draftByTask[taskId]) ?? '';
  const setDraft = useAppStore((s) => s.setDraft);
  const startGoal = useAppStore((s) => s.startGoal);
  const pauseGoal = useAppStore((s) => s.pauseGoal);
  const resumeGoal = useAppStore((s) => s.resumeGoal);
  const clearGoal = useAppStore((s) => s.clearGoal);
  const startTurn = useAppStore((s) => s.startTurn);
  const queueMessage = useAppStore((s) => s.queueMessage);
  const stopAndSend = useAppStore((s) => s.stopAndSend);
  const cancelActiveTurn = useAppStore((s) => s.cancelActiveTurn);
  const { createTask } = useTaskBoundary();
  const currentTask = useAppStore((state) => state.tasks.find(({ id }) => id === taskId));
  const currentProjectId = currentTask?.projectId ?? null;
  const goal = currentTask?.goalState ?? null;
  const toggleTeamView = useAppStore((s) => s.toggleTeamView);
  const sending = useAppStore((s) => s.sendingByTask[taskId]) ?? false;
  const projectSwitching = useAppStore((s) => s.projectSwitchingByTask[taskId]) ?? false;
  const turn = useAppStore((s) => s.turnByTask[taskId]);
  const queued = useAppStore((s) => s.queuedByTask[taskId]) ?? [];
  const draftAttachments = useAppStore((s) => s.draftAttachmentsByTask[taskId]) ?? [];
  const attachmentCapability = useAppStore((s) => s.attachmentCapabilityByTask[taskId]);
  const attachmentBusy = useAppStore((s) => s.attachmentBusyByTask[taskId]) ?? false;
  const attachmentError = useAppStore((s) => s.attachmentErrorByTask[taskId]);
  const attachmentAnnouncement = useAppStore((s) => s.attachmentAnnouncementByTask[taskId]);
  const pickDraftAttachment = useAppStore((s) => s.pickDraftAttachment);
  const pasteDraftAttachment = useAppStore((s) => s.pasteDraftAttachment);
  const setAttachmentError = useAppStore((s) => s.setAttachmentError);
  const removeDraftAttachment = useAppStore((s) => s.removeDraftAttachment);
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
  const plusTriggerRef = useRef<HTMLButtonElement>(null);
  const attachmentRemoveRefs = useRef(new Map<string, HTMLButtonElement>());
  // `/goal` changes the meaning of this same Composer for one send. It deliberately does not open
  // a second input: the armed chip and placeholder are the only extra UI needed to make the mode
  // visible and cancelable.
  const [goalRequested, setGoalRequested] = useState(false);
  const [goalEditDraftBackup, setGoalEditDraftBackup] = useState<string | null>(null);
  const [goalControlPending, setGoalControlPending] = useState(false);
  // Armed by the plus menu, consumed by the next send. One-shot rather than a mode, so a user who
  // opens the menu and changes their mind is not stuck generating images.
  const [imageRequested, setImageRequested] = useState(false);
  const imageRequestRevisionRef = useRef(0);
  const [slashSelection, setSlashSelection] = useState(0);
  const [slashDismissedDraft, setSlashDismissedDraft] = useState<string | null>(null);
  const [composerCursor, setComposerCursor] = useState(draft.length);
  const [turnActionPending, setTurnActionPending] = useState<
    'queue' | 'interrupt' | 'cancel' | null
  >(null);
  const turnActionPendingRef = useRef<'queue' | 'interrupt' | 'cancel' | null>(null);
  const [turnActionError, setTurnActionError] = useState<string | null>(null);

  const turnActive = turn ? turn.status === 'running' || turn.status === 'canceling' : false;

  const attachmentPolicy = attachmentInteractionPolicy({
    draftCount: draftAttachments.length,
    turnActive,
    goalRequested,
    capabilityStatus: attachmentCapability?.status ?? 'pending',
    capabilityReason: attachmentCapability?.reason ?? '画像添付の準備状況を確認中です',
  });
  const attachmentErrorId = attachmentError ? `composer-attachment-error-${taskId}` : undefined;

  const canQueue = typeof window.sprintCoder?.turns?.queue === 'function';
  const canStopAndSend = typeof window.sprintCoder?.turns?.stopAndSend === 'function';
  const canCancel = typeof window.sprintCoder?.turns?.cancel === 'function';
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
    typeof window !== 'undefined' && typeof window.sprintCoder?.goals?.start === 'function';
  const teamSupported = typeof window !== 'undefined' && window.sprintCoder?.teams !== undefined;
  const slashUnavailable = useMemo<Partial<Record<SlashCommandId, string>>>(
    () => ({
      ...(!goalSupported
        ? { goal: 'Goal設定に対応していません' }
        : attachmentPolicy.goalBlocked
          ? { goal: '画像を削除してからGoalを設定してください' }
          : {}),
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
    [
      attachmentPolicy.goalBlocked,
      goalSupported,
      runtime.codexReadiness,
      runtime.kind,
      teamSupported,
    ],
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

  const actionPolicy = composerActionPolicy({
    turnStatus: turn?.status === 'canceling' ? 'canceling' : turnActive ? 'running' : 'idle',
    hasDraft: draft.trim().length > 0,
    canQueue,
    canStopAndSend,
    canCancel,
    actionPending: sending || turnActionPending !== null,
    sendBlocked:
      goalControlPending ||
      projectSwitching ||
      attachmentPolicy.sendBlocked ||
      (turnActive && goalRequested),
  });

  function updateImageRequested(next: boolean): void {
    imageRequestRevisionRef.current += 1;
    setImageRequested(next);
  }

  // Ctrl+V / Cmd+V with an image on the clipboard attaches it instead of pasting nothing visible.
  // Only the *decision* is made here — Main reads the clipboard bytes itself (see
  // main/image-attachment-store.ts), so the Renderer never carries image content.
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    if (!clipboardCarriesImage(event.clipboardData)) return;
    event.preventDefault();
    if (!attachmentPolicy.attachSupported) {
      setAttachmentError(
        taskId,
        attachmentPolicy.attachUnavailableReason ?? '画像を添付できません',
      );
      return;
    }
    void pasteDraftAttachment(taskId);
  }

  async function handleRemoveAttachment(attachmentId: string): Promise<void> {
    const index = draftAttachments.findIndex(({ id }) => id === attachmentId);
    const nextId = draftAttachments[index + 1]?.id;
    const previousId = draftAttachments[index - 1]?.id;
    if (!(await removeDraftAttachment(taskId, attachmentId))) return;
    requestAnimationFrame(() => {
      focusAfterAttachmentRemoval({
        nextId,
        previousId,
        removeRefs: attachmentRemoveRefs.current,
        plusTrigger: plusTriggerRef.current,
        textarea: textareaRef.current,
      });
    });
  }

  function handleSend() {
    const raw = draft.trim();
    if (!raw || actionPolicy.primary.disabled || actionPolicy.primary.kind === 'cancel') return;
    // Enter while the slash picker is open already runs `/team` through runSlashCommand. Keep the
    // send button and `/team ` (with a trailing space) consistent: a standalone command opens the
    // Canvas, while `/team <request>` remains a message and Main routes it through Sprint Coder
    // Team. The explicit prefix stays in history as an auditable statement of Team intent.
    if (shouldOpenTeamCanvas(raw, { goalRequested, imageRequested })) {
      setDraft(taskId, '');
      void toggleTeamView(taskId);
      return;
    }
    if (goalRequested) {
      setGoalRequested(false);
      setDraft(taskId, '');
      setGoalControlPending(true);
      void (async () => {
        try {
          if (!(await startGoal(taskId, raw))) {
            setGoalRequested(true);
            setDraft(taskId, raw);
          } else {
            setGoalEditDraftBackup(null);
          }
        } finally {
          setGoalControlPending(false);
        }
      })();
      return;
    }
    // The prefix goes into the stored message rather than being injected invisibly in the adapter.
    // The issue names this as an open question; traceability wins. An image appearing with no
    // explanation in the history is worse than a visible directive, and a hidden one would make
    // "why did this turn generate an image?" unanswerable after the fact.
    const text = composerMessageText(raw, imageRequested);
    updateImageRequested(false);
    if (!turnActive) {
      void startTurn(taskId, text, undefined, directTurnAttachmentIds(draftAttachments));
      return;
    }
    if (actionPolicy.primary.kind === 'queue') {
      runTurnAction('queue', () => queueMessage(taskId, text, selectedSkills));
    }
  }

  function runTurnAction(
    action: 'queue' | 'interrupt' | 'cancel',
    operation: () => Promise<boolean>,
  ): void {
    // The ref closes the same-event-loop gap before React commits the disabled state. A fast
    // double-click (or Enter immediately followed by click) must never enqueue/cancel twice.
    if (turnActionPendingRef.current !== null) return;
    turnActionPendingRef.current = action;
    setTurnActionError(null);
    setTurnActionPending(action);
    void operation()
      .then((completed) => {
        if (!completed) {
          setTurnActionError(
            action === 'cancel'
              ? '実行を停止できませんでした。Turnを実行中に戻しました。'
              : '操作を完了できませんでした。入力内容とSkillを復元しました。',
          );
        }
      })
      .finally(() => {
        turnActionPendingRef.current = null;
        setTurnActionPending(null);
      });
  }

  function handlePrimaryAction(): void {
    if (actionPolicy.primary.disabled) return;
    if (actionPolicy.primary.kind === 'cancel') {
      runTurnAction('cancel', () => cancelActiveTurn(taskId));
      return;
    }
    handleSend();
  }

  function handleInterrupt(): void {
    const raw = draft.trim();
    if (!raw || actionPolicy.interrupt.disabled) return;
    const text = composerMessageText(raw, imageRequested);
    const restoreImageRequest = imageRequested;
    updateImageRequested(false);
    const imageRequestRevision = imageRequestRevisionRef.current;
    runTurnAction('interrupt', async () => {
      const result = await stopAndSend(taskId, text, selectedSkills);
      if (!result.completed) {
        const recovery = imageRequestFailureRecovery({
          currentDraft: useAppStore.getState().draftByTask[taskId] ?? '',
          rawDraft: raw,
          imageRequested: restoreImageRequest,
          draftRestored: result.draftRestored,
          imageModeUnchanged: imageRequestRevisionRef.current === imageRequestRevision,
        });
        if (recovery.rearm) {
          setDraft(taskId, recovery.draft);
          updateImageRequested(true);
        }
      }
      return result.completed;
    });
  }

  function runGoalControl(action: () => Promise<void>): void {
    if (goalControlPending) return;
    setGoalControlPending(true);
    void action().finally(() => setGoalControlPending(false));
  }

  function cancelGoalRequest(): void {
    if (goalEditDraftBackup !== null) setDraft(taskId, goalEditDraftBackup);
    setGoalEditDraftBackup(null);
    setGoalRequested(false);
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
        if (attachmentPolicy.goalBlocked) break;
        updateImageRequested(false);
        setGoalEditDraftBackup(null);
        setGoalRequested(true);
        break;
      case 'team':
        void toggleTeamView(taskId);
        break;
      case 'image':
        cancelGoalRequest();
        updateImageRequested(true);
        break;
    }
  }

  function editGoal() {
    if (goal === null || goal.status === 'active') return;
    updateImageRequested(false);
    setGoalEditDraftBackup(draft);
    setGoalRequested(true);
    setDraft(taskId, goal.objective);
    requestAnimationFrame(() => {
      const end = goal.objective.length;
      textareaRef.current?.setSelectionRange(end, end);
      textareaRef.current?.focus();
    });
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
    if (
      composerSubmitShortcut({
        key: e.key,
        shiftKey: e.shiftKey,
        isComposing: e.nativeEvent.isComposing,
      }) === 'submit'
    ) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape' && goalRequested) {
      e.preventDefault();
      cancelGoalRequest();
    }
  }

  return (
    <div className="composer-zone">
      <div className="composer-inner">
        <QueuedList items={queued} />
        {goal !== null && (
          <GoalProgress
            goal={goal}
            controlsPending={goalControlPending}
            onPause={() => runGoalControl(() => pauseGoal(taskId))}
            onResume={() => runGoalControl(() => resumeGoal(taskId))}
            onEdit={editGoal}
            onClear={() => runGoalControl(() => clearGoal(taskId))}
          />
        )}
        {/* One matte panel: the run context strip and the input share a single surface, edge and
            shadow rather than stacking two framed boxes on top of each other. */}
        <div className="composer-panel">
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
            {draftAttachments.length > 0 && (
              <AttachmentDraftList
                taskId={taskId}
                attachments={draftAttachments}
                busy={attachmentBusy}
                removeRefs={attachmentRemoveRefs}
                onRemove={(attachmentId) => void handleRemoveAttachment(attachmentId)}
                errorId={attachmentErrorId}
                status={attachmentDraftStatus({
                  turnActive,
                  goalRequested,
                  capabilityStatus: attachmentCapability?.status ?? 'pending',
                  capabilityReason:
                    attachmentCapability?.reason ?? '画像添付の準備状況を確認中です',
                })}
              />
            )}
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {attachmentAnnouncement ?? ''}
            </div>
            {attachmentError && (
              <div id={attachmentErrorId} className="composer-attachment-error" role="alert">
                {attachmentError}
              </div>
            )}
            {turnActionError && (
              <div className="composer-operation-error" role="alert">
                {turnActionError}
              </div>
            )}
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {turnActionPending === 'queue'
                ? 'キューに追加しています'
                : turnActionPending === 'interrupt'
                  ? '現在の実行を停止して送信しています'
                  : turnActionPending === 'cancel' || turn?.status === 'canceling'
                    ? '実行を停止しています'
                    : ''}
            </div>
            <textarea
              ref={textareaRef}
              className="composer-input"
              data-testid="composer-textarea"
              rows={1}
              placeholder={
                goalRequested
                  ? 'Goalを入力（Enterで開始 / Escでキャンセル）'
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
              onPaste={handlePaste}
              aria-label="メッセージ入力"
              aria-describedby={attachmentErrorId}
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
                capabilityReason={attachmentPolicy.attachUnavailableReason ?? ''}
                attachmentSupported={attachmentPolicy.attachSupported}
                errorId={attachmentErrorId}
                triggerRef={plusTriggerRef}
                onRequestAttachment={() => void pickDraftAttachment(taskId)}
                onRequestImage={() => {
                  cancelGoalRequest();
                  updateImageRequested(true);
                }}
              />
              <PermissionChip taskId={taskId} />
              {goalRequested && (
                <button
                  type="button"
                  className="cmp-chip goal-armed"
                  data-testid="composer-goal-armed"
                  title="次の送信内容でGoalを開始します。クリックで取り消し"
                  onClick={cancelGoalRequest}
                >
                  <Target size={13} /> Goal <X size={12} />
                </button>
              )}
              {imageRequested && (
                <button
                  type="button"
                  className="cmp-chip imagegen-armed"
                  data-testid="composer-imagegen-armed"
                  title="この送信で画像生成を呼び出します。クリックで取り消し"
                  onClick={() => updateImageRequested(false)}
                >
                  画像生成 <X size={12} />
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
              <ComposerActionButtons
                policy={
                  goalRequested && actionPolicy.primary.kind === 'send'
                    ? {
                        ...actionPolicy,
                        primary: {
                          ...actionPolicy.primary,
                          label: 'Goalを開始',
                          title: 'Goalを開始',
                        },
                      }
                    : actionPolicy
                }
                onPrimary={handlePrimaryAction}
                onInterrupt={handleInterrupt}
              />
            </div>
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

function GoalProgress({
  goal,
  controlsPending,
  onPause,
  onResume,
  onEdit,
  onClear,
}: {
  goal: GoalSummary;
  controlsPending: boolean;
  onPause: () => void;
  onResume: () => void;
  onEdit: () => void;
  onClear: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (goal.status !== 'active') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [goal.status]);
  const liveSeconds =
    goal.status === 'active'
      ? Math.max(0, Math.floor((now - new Date(goal.updatedAt).getTime()) / 1000))
      : 0;
  const elapsed = goal.timeUsedSeconds + liveSeconds;
  const statusLabel =
    goal.status === 'active'
      ? '実行中'
      : goal.status === 'paused'
        ? '一時停止中'
        : goal.status === 'completed'
          ? '完了'
          : 'ブロック中';

  return (
    <section
      className="goal-progress"
      data-status={goal.status}
      aria-label={`Goal: ${statusLabel}`}
      aria-busy={controlsPending}
    >
      <div className="goal-progress-mark" aria-hidden="true">
        <Target size={15} />
      </div>
      <div className="goal-progress-copy">
        <div className="goal-progress-title-row">
          <span className="goal-progress-label">Goal</span>
          <span className="goal-progress-status" aria-live="polite">
            <span className="goal-progress-dot" aria-hidden="true" />
            {statusLabel}
          </span>
          <span className="goal-progress-time">{formatGoalDuration(elapsed)}</span>
          {(goal.tokenBudget !== null || goal.tokensUsed > 0) && (
            <span className="goal-progress-usage">
              {goal.tokensUsed.toLocaleString()}
              {goal.tokenBudget === null ? '' : ` / ${goal.tokenBudget.toLocaleString()}`} tokens
            </span>
          )}
        </div>
        <p title={goal.objective}>{goal.objective}</p>
      </div>
      <div className="goal-progress-actions">
        {goal.status === 'active' ? (
          <button
            type="button"
            onClick={onPause}
            disabled={controlsPending}
            aria-label="Goalを一時停止"
            title="一時停止"
          >
            <Pause size={14} />
          </button>
        ) : (
          <button
            type="button"
            onClick={onResume}
            disabled={controlsPending}
            aria-label="Goalを再開"
            title="再開"
          >
            <Play size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          disabled={controlsPending || goal.status === 'active'}
          aria-label="Goalを編集"
          title={goal.status === 'active' ? '一時停止してから編集できます' : '編集'}
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={controlsPending}
          aria-label="Goalを解除"
          title="解除"
        >
          <Trash size={14} />
        </button>
      </div>
    </section>
  );
}

function formatGoalDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
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
function PlusMenu({
  attachmentSupported,
  capabilityReason,
  errorId,
  triggerRef,
  onRequestAttachment,
  onRequestImage,
}: {
  attachmentSupported: boolean;
  capabilityReason: string;
  errorId?: string | undefined;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onRequestAttachment: () => void;
  onRequestImage: () => void;
}) {
  const runtime = useAppStore((s) => s.runtime);

  const items: ComposerMenuItem[] = [
    {
      id: 'attach',
      label: '画像を添付',
      description: 'この送信にPNG・JPEG・WebP画像を添える',
      icon: <Paperclip size={14} />,
      ...(attachmentSupported
        ? { onSelect: onRequestAttachment }
        : { unavailableReason: capabilityReason }),
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
      externalTriggerRef={triggerRef}
      triggerAriaDescribedBy={errorId}
    />
  );
}

function formatAttachmentBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${Math.ceil(byteLength / 1024)} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Decides whether a paste should become an attachment instead of text.
 *
 * `text/plain` wins whenever it is present: several apps (spreadsheets and slide editors in
 * particular) put a picture of the selection on the clipboard alongside the text, and pasting that
 * picture instead of the text the user copied would be wrong far more often than it is right.
 */
export function clipboardCarriesImage(
  data: {
    types?: readonly string[];
    items?: ArrayLike<{ kind: string; type: string }>;
  } | null,
): boolean {
  if (!data) return false;
  if ((data.types ?? []).includes('text/plain')) return false;
  return Array.from(data.items ?? []).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/'),
  );
}

export function directTurnAttachmentIds(attachments: readonly ImageAttachmentMetadata[]): string[] {
  return attachments.map(({ id }) => id);
}

/**
 * The line under the draft tiles, which states what will happen to these images on the next send.
 *
 * It tracks the same conditions as `attachmentInteractionPolicy`: whenever `sendBlocked` is false
 * the copy has to say the images will be sent, or a pasted image reads as one the app is going to
 * ignore.
 */
export function attachmentDraftStatus(input: {
  turnActive: boolean;
  goalRequested: boolean;
  capabilityStatus: 'pending' | 'supported' | 'unsupported';
  capabilityReason: string;
}): string {
  if (input.turnActive)
    return '画像添付は実行中のTurnにはキュー追加できません。完了後に送信してください';
  if (input.goalRequested) return 'Goal入力中は画像を送信できません。Goalを取り消すと送信できます';
  if (input.capabilityStatus !== 'supported')
    return `${input.capabilityReason}。画像を削除すると通常のメッセージを送信できます`;
  return '送信するとこの画像が参照されます';
}

export function attachmentInteractionPolicy(input: {
  draftCount: number;
  turnActive: boolean;
  goalRequested: boolean;
  capabilityStatus: 'pending' | 'supported' | 'unsupported';
  capabilityReason: string;
}): {
  sendBlocked: boolean;
  goalBlocked: boolean;
  attachSupported: boolean;
  attachUnavailableReason: string | null;
} {
  const attachUnavailableReason = input.turnActive
    ? 'Turn実行中は画像を追加できません'
    : input.goalRequested
      ? 'Goal入力中は画像を追加できません'
      : input.capabilityStatus !== 'supported'
        ? input.capabilityReason
        : null;
  return {
    sendBlocked:
      input.draftCount > 0 &&
      (input.turnActive || input.goalRequested || input.capabilityStatus !== 'supported'),
    goalBlocked: input.draftCount > 0,
    attachSupported: attachUnavailableReason === null,
    attachUnavailableReason,
  };
}

type FocusTarget = Pick<HTMLElement, 'focus'>;

export function focusAfterAttachmentRemoval(input: {
  nextId: string | undefined;
  previousId: string | undefined;
  removeRefs: ReadonlyMap<string, FocusTarget>;
  plusTrigger: FocusTarget | null;
  textarea: FocusTarget | null;
}): void {
  const target =
    (input.nextId ? input.removeRefs.get(input.nextId) : undefined) ??
    (input.previousId ? input.removeRefs.get(input.previousId) : undefined) ??
    input.plusTrigger ??
    input.textarea;
  target?.focus({ preventScroll: true });
}

function attachmentDraftLabel(attachment: ImageAttachmentMetadata): string {
  return `${attachment.fileName} · ${attachment.mimeType.replace('image/', '').toUpperCase()} · ${formatAttachmentBytes(attachment.byteLength)}`;
}

/**
 * Bytes stay in Main; this asks it for a downscaled copy and builds a `data:` URL from the base64
 * it returns — never a path or an http(s) URL, so showing a thumbnail can neither read the
 * filesystem nor issue a request (the rule GeneratedImageCard follows for the same reason).
 */
function AttachmentThumbnail({
  taskId,
  attachment,
}: {
  taskId: string;
  attachment: ImageAttachmentMetadata;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const preview = window.sprintCoder?.attachments?.preview;
    if (typeof preview !== 'function') return;
    let cancelled = false;
    void preview({ taskId, attachmentId: attachment.id })
      .then((image) => {
        if (!cancelled) setDataUrl(`data:${image.mimeType};base64,${image.base64}`);
      })
      // A thumbnail that cannot be rendered falls back to the placeholder below. The attachment
      // itself is unaffected, so this is not surfaced as an attachment error.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, attachment.id]);

  if (dataUrl === null)
    return (
      <span className="composer-attachment-thumb placeholder" aria-hidden="true">
        <Paperclip size={16} />
      </span>
    );
  return (
    <img
      className="composer-attachment-thumb"
      data-testid="composer-attachment-thumbnail"
      src={dataUrl}
      alt=""
    />
  );
}

export function AttachmentDraftList({
  taskId,
  attachments,
  busy,
  removeRefs,
  onRemove,
  status,
  errorId,
}: {
  taskId: string;
  attachments: readonly ImageAttachmentMetadata[];
  busy: boolean;
  removeRefs: RefObject<Map<string, HTMLButtonElement>>;
  onRemove: (attachmentId: string) => void;
  status: string;
  errorId?: string | undefined;
}) {
  return (
    <div className="composer-attachments" aria-label="この送信に添付する画像">
      <div className="composer-attachment-scope">参照範囲: この送信のみ</div>
      <div className="composer-attachment-list">
        {attachments.map((attachment) => (
          <div
            className="composer-attachment-chip"
            key={attachment.id}
            data-testid="composer-attachment"
            title={attachmentDraftLabel(attachment)}
          >
            <AttachmentThumbnail taskId={taskId} attachment={attachment} />
            {/* The tile is the image itself, as in the picker preview. Name, media type, and size
                stay in the accessible name and the tooltip so nothing is lost to sighted keyboard
                or screen-reader users. */}
            <span className="sr-only">{attachmentDraftLabel(attachment)}</span>
            <button
              ref={(node) => {
                if (node) removeRefs.current.set(attachment.id, node);
                else removeRefs.current.delete(attachment.id);
              }}
              type="button"
              className="composer-attachment-remove"
              aria-label={`${attachment.fileName}を削除`}
              aria-describedby={errorId}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) onRemove(attachment.id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="composer-attachment-status" role="status">
        {status}
      </div>
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
