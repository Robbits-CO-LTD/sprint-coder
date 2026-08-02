import { useEffect, useId, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { Check, X } from './icons';
import {
  EFFORT_DESC,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  RUNTIME_CLI_MISSING_HINT,
  RUNTIME_LABEL,
  effortUnavailableReason,
} from '../lib/runtime-labels';
import type { DatabaseRecovery, RuntimeKind, RuntimeStatus } from '../types/sprint-coder';
import { ProviderSettingsSection } from './ProviderSettingsSection';
import { SkillSettingsSection } from './SkillSettingsSection';
import { useTaskBoundary } from './TaskBoundary';
import type { ProviderModel, TeamModelRestriction, TeamPolicy } from '@sprint-coder/contracts';
import {
  filterTeamModelGroups,
  getTeamConnectionSelection,
  groupTeamModelsByConnection,
  providerModelIdentity,
  sameModelRestriction,
  setTeamConnectionSelected,
  setTeamModelSelected,
  teamModelKey,
  type TeamModelConnectionGroup,
} from '../lib/team-model-groups';
import {
  readAccessPresetDefault,
  writeAccessPresetDefault,
  type AccessPresetDefault,
} from '../lib/access-preset-preference';

// Settings dialog (issue #5). The sidebar's "設定" button had no onClick and was not disabled
// either, so it looked pressable and did nothing — and no settings screen existed anywhere in the
// renderer.
//
// Modal rather than a right panel, of the two the issue left open: the right edge is claimed by the
// Team List View today, settings are a modal task (open,
// adjust, close) rather than an ambient one, and a modal is what the app's own focus-restoration
// conventions are already built around.
//
// Built on the native <dialog> element with `showModal()`, which gives the focus trap, Escape
// handling, top-layer stacking (so it is never clipped by `.team-canvas`'s `overflow: clip`), and
// the inert backdrop for free. Hand-rolling those is where accessibility bugs come from; the only
// thing added on top is explicit focus restoration, because the acceptance criterion names it and
// this app is deliberate about it elsewhere.
//
// UI slice A adds a second body behind `settingsWorkspaceV2`: the same dialog element and the same
// controls, laid out as a ~900px two-pane workspace with a section list on the left. The flag-off
// body is the one that shipped and stays exactly as it was, so the flag is a real switch back and
// not a one-way migration.

type SettingsSection = 'models' | 'team' | 'skills' | 'advanced';

/** The left-hand list, in order. It is the nav and the page switcher's source of truth, so a section
 * can never exist in one and not the other. `label` is both the nav row and the section's heading;
 * `eyebrow` is the Latin line above it. "Skill" is singular on purpose — SkillSettingsSection
 * already contributes a heading called "Skills", and two headings with one name is something a
 * screen-reader rotor and a by-name locator both trip over. */
export const SETTINGS_SECTIONS: readonly {
  id: SettingsSection;
  label: string;
  description: string;
  eyebrow: string;
}[] = [
  {
    id: 'models',
    label: 'モデルと接続',
    description: 'モデル・Effort・API',
    eyebrow: 'Models & Connections',
  },
  { id: 'team', label: 'Team', description: '新しいTeamの既定値', eyebrow: 'Team' },
  { id: 'skills', label: 'Skill', description: '読み込みと有効化', eyebrow: 'Skills' },
  { id: 'advanced', label: '詳細', description: 'CLI検出と診断', eyebrow: 'Advanced' },
];

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const workspace = useAppStore((s) => s.settingsWorkspaceV2);
  const { createTask } = useTaskBoundary();
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The element that had focus when the dialog opened. Chromium's <dialog> restores focus itself,
  // but capturing it makes the guarantee explicit and independently testable.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (open) return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  }, [open]);

  const supported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.settings?.getRuntime === 'function';

  async function beginSkillCreation(): Promise<void> {
    const created = await createTask();
    if (created === null) return;
    const state = useAppStore.getState();
    const taskId = state.selectedTaskId;
    if (taskId === null || typeof window.sprintCoder?.skills?.list !== 'function') return;
    const catalog = await window.sprintCoder.skills.list();
    const creator = catalog.items.find(
      ({ ref, enabled }) => ref.source === 'builtin' && ref.skillId === 'skill-creator' && enabled,
    );
    if (creator === undefined) return;
    await state.setSkillSelection(taskId, [{ kind: creator.kind, ref: creator.ref }]);
    state.setDraft(
      taskId,
      '作りたいSkillを説明してください。Chat SkillかTeam Skillかも指定できます。',
    );
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className={`settings-dialog${workspace ? ' settings-dialog-v2' : ''}`}
      data-testid="settings-dialog"
      aria-labelledby="settings-dialog-title"
      // `cancel` is Escape; `close` also covers the backdrop-click path below. Both route through
      // the parent so `open` and the element's own state can never disagree.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
      // Clicking the backdrop lands on the <dialog> element itself, never on its children.
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      {workspace ? (
        <WorkspaceBody
          key={open ? 'open' : 'closed'}
          open={open}
          supported={supported}
          onClose={onClose}
          onCreateSkill={() => void beginSkillCreation()}
        />
      ) : (
        <LegacyBody
          open={open}
          supported={supported}
          onClose={onClose}
          onCreateSkill={() => void beginSkillCreation()}
        />
      )}
    </dialog>
  );
}

/** The flag-off body: one column, every group stacked, unchanged from what shipped. Kept as a
 * working fallback rather than deleted — turning `settingsWorkspaceV2` off has to give a usable
 * settings screen, not an empty dialog. */
export function LegacyBody({
  open,
  supported,
  onClose,
  onCreateSkill,
}: {
  open: boolean;
  supported: boolean;
  onClose: () => void;
  onCreateSkill?: () => void;
}) {
  return (
    <div className="settings-body">
      <header className="settings-header">
        <h2 id="settings-dialog-title">設定</h2>
        <CloseButton onClose={onClose} />
      </header>

      {!supported ? (
        <p className="settings-note" data-testid="settings-unsupported">
          この環境では設定APIが利用できません。
        </p>
      ) : (
        <>
          <ModelGroup />
          <EffortGroup />
          <AccessDefaultGroup />
          {/* CLI detection. Previously only reachable as a tooltip on a disabled menu item, which
              is exactly where a user who cannot select a Runtime will not look. */}
          <CliDetectionGroup />
          <TeamModelRestrictionSetting active={open} />
          <TeamResearchSetting active={open} />
          {/* Unmounting clears the renderer-local plaintext credential state. */}
          {open && <ProviderSettingsSection active={open} />}
          <SkillSettingsSection
            active={open}
            {...(onCreateSkill === undefined ? {} : { onCreateWithAi: onCreateSkill })}
          />
        </>
      )}
    </div>
  );
}

/** The flag-on body. Two panes: the section list on the left and one settings page on the right.
 * Pages stay mounted while hidden, so switching categories does not discard a half-typed API key,
 * but unrelated settings no longer form one long document. */
export function WorkspaceBody({
  open,
  supported,
  onClose,
  onCreateSkill,
}: {
  open: boolean;
  supported: boolean;
  onClose: () => void;
  onCreateSkill?: () => void;
}) {
  const uid = useId();
  const [current, setCurrent] = useState<SettingsSection>('models');

  function goTo(id: SettingsSection): void {
    setCurrent(id);
    requestAnimationFrame(() => document.getElementById(`${uid}-${id}`)?.focus());
  }

  function page(id: SettingsSection) {
    const meta = SETTINGS_SECTIONS.find((section) => section.id === id)!;
    return {
      meta,
      uid,
    };
  }

  return (
    <div className="settings-workspace">
      <header className="settings-header">
        <div>
          <h2 id="settings-dialog-title">設定</h2>
          <p>モデル、接続、Team、Skill、CLIの診断を管理します。</p>
        </div>
        <CloseButton onClose={onClose} />
      </header>

      {!supported ? (
        <div className="settings-content">
          <div className="settings-page">
            <p className="settings-note" data-testid="settings-unsupported">
              この環境では設定APIが利用できません。
            </p>
          </div>
        </div>
      ) : (
        <>
          <nav className="settings-nav" aria-label="設定カテゴリ">
            {SETTINGS_SECTIONS.map(({ id, label, description }) => (
              <button
                key={id}
                type="button"
                data-testid={`settings-nav-${id}`}
                className={current === id ? 'active' : ''}
                // `aria-current`, not a pressed toggle: these move the view to one part of a single
                // sheet, which is what "current" describes and what "pressed" does not.
                aria-current={current === id ? 'true' : undefined}
                aria-controls={`${uid}-${id}`}
                onClick={() => goTo(id)}
              >
                <span>{label}</span>
                <small>{description}</small>
              </button>
            ))}
          </nav>

          <div className="settings-content" data-testid="settings-content">
            <WorkspacePage {...page('models')} active={current === 'models'}>
              <ModelGroup />
              <EffortGroup />
              <AccessDefaultGroup />
              {/* Unmounting clears the renderer-local plaintext credential state. */}
              {open && <ProviderSettingsSection active={open} />}
            </WorkspacePage>

            <WorkspacePage {...page('team')} active={current === 'team'}>
              <TeamDefaultPolicySetting active={open} />
              <TeamModelRestrictionSetting active={open} />
              <TeamResearchSetting active={open} />
            </WorkspacePage>

            <WorkspacePage {...page('skills')} active={current === 'skills'}>
              <SkillSettingsSection
                active={open}
                {...(onCreateSkill === undefined ? {} : { onCreateWithAi: onCreateSkill })}
              />
            </WorkspacePage>

            <WorkspacePage {...page('advanced')} active={current === 'advanced'}>
              {/* CLI detection. Previously only reachable as a tooltip on a disabled menu item,
                  which is exactly where a user who cannot select a Runtime will not look. */}
              <CliDetectionGroup />
              <DiagnosticsGroup />
            </WorkspacePage>
          </div>
        </>
      )}
    </div>
  );
}

function WorkspacePage({
  meta,
  uid,
  active,
  children,
}: {
  meta: (typeof SETTINGS_SECTIONS)[number];
  uid: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className="settings-page"
      id={`${uid}-${meta.id}`}
      data-testid={`settings-page-${meta.id}`}
      aria-labelledby={`${uid}-${meta.id}-title`}
      hidden={!active}
      // Focusable only programmatically, so activating a nav item can put a screen reader's cursor
      // where the eye already went without adding a Tab stop for anyone else.
      tabIndex={-1}
    >
      <div className="settings-page-heading">
        <p className="settings-eyebrow">{meta.eyebrow}</p>
        <h3 id={`${uid}-${meta.id}-title`}>{meta.label}</h3>
        <p>{meta.description}</p>
      </div>
      {children}
    </section>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="settings-close"
      data-testid="settings-close"
      aria-label="設定を閉じる"
      onClick={onClose}
    >
      <X size={16} />
    </button>
  );
}

// ---------- Controls shared by both bodies ----------
// One definition each. Two copies of a control that writes a persisted setting is exactly the kind
// of thing that ends up disagreeing with itself.

function availabilityOf(
  kind: RuntimeKind,
  runtime: { codexAvailable: boolean; claudeAvailable: boolean },
): { available: boolean; reason: string | null } {
  if (kind === 'mock') return { available: true, reason: null };
  const available = kind === 'codex' ? runtime.codexAvailable : runtime.claudeAvailable;
  return { available, reason: available ? null : RUNTIME_CLI_MISSING_HINT[kind] };
}

function ModelGroup() {
  const runtime = useAppStore((s) => s.runtime);
  const setModel = useAppStore((s) => s.setModel);
  const selectedModel = runtime.models.find(({ id }) => id === runtime.model);
  return (
    <div className="settings-group">
      <label className="settings-field" htmlFor="settings-model">
        <span className="settings-field-label">モデル</span>
        <select
          id="settings-model"
          data-testid="settings-model"
          value={runtime.model}
          disabled={runtime.models.length === 0}
          onChange={(e) => void setModel(e.target.value)}
        >
          {runtime.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>
      {selectedModel !== undefined && selectedModel.description !== '' && (
        <p className="settings-hint">{selectedModel.description}</p>
      )}
    </div>
  );
}

function EffortGroup() {
  const runtime = useAppStore((s) => s.runtime);
  const setEffort = useAppStore((s) => s.setEffort);
  const effortReason = effortUnavailableReason(runtime.kind, runtime.claudeAvailable);
  return (
    <div className="settings-group">
      <label className="settings-field" htmlFor="settings-effort">
        <span className="settings-field-label">Effort</span>
        <select
          id="settings-effort"
          data-testid="settings-effort"
          value={runtime.effort}
          disabled={effortReason !== null}
          onChange={(e) => void setEffort(e.target.value as (typeof EFFORT_LEVELS)[number])}
        >
          {EFFORT_LEVELS.map((effort) => (
            <option key={effort} value={effort}>
              {EFFORT_LABEL[effort]}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-hint" data-testid="settings-effort-hint">
        {effortReason ?? EFFORT_DESC[runtime.effort]}
      </p>
    </div>
  );
}

function AccessDefaultGroup() {
  const [accessDefault, setAccessDefault] = useState<AccessPresetDefault>(() =>
    readAccessPresetDefault(),
  );
  return (
    <div className="settings-group">
      <label className="settings-field" htmlFor="settings-access-default">
        <span className="settings-field-label">新しいタスクの安全設定</span>
        <select
          id="settings-access-default"
          data-testid="settings-access-default"
          value={accessDefault}
          onChange={(event) => {
            const value = event.target.value as AccessPresetDefault;
            setAccessDefault(value);
            writeAccessPresetDefault(value);
          }}
        >
          <option value="last">前回選択した設定</option>
          <option value="ask">毎回確認</option>
          <option value="auto">安全時は自動</option>
        </select>
      </label>
      <p className="settings-hint">
        設定しない場合は直近の安全な選択を引き継ぎます。フルアクセスは新しいタスクへ
        引き継がれず、タスクごとに確認します。
      </p>
    </div>
  );
}

function CliDetectionGroup() {
  const runtime = useAppStore((s) => s.runtime);
  return (
    <div className="settings-group">
      <span className="settings-field-label">CLI検出状況</span>
      <ul className="settings-status">
        {(['codex', 'claude'] as const).map((kind) => {
          const { available, reason } = availabilityOf(kind, runtime);
          return (
            <li key={kind} data-testid={`settings-cli-${kind}`}>
              <span className={available ? 'settings-ok' : 'settings-missing'}>
                {available ? <Check size={14} /> : <X size={14} />}
              </span>
              <span>{RUNTIME_LABEL[kind]}</span>
              <span className="settings-hint">{available ? '検出済み' : (reason ?? '未検出')}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Read-only facts the renderer already holds. No new backend call: the Runtime liveness push and
 * the launch's recovery record are both already in the store, and until now the only place either
 * appeared was a dot in the footer. */
function DiagnosticsGroup() {
  const runtimeStatus = useAppStore((s) => s.runtimeStatus);
  const recovery = useAppStore((s) => s.recovery);
  return (
    <div className="settings-group">
      <span className="settings-field-label">状態</span>
      <ul className="settings-status">
        <li data-testid="settings-diagnostic-runtime">
          <span>Runtimeプロセス</span>
          <span className="settings-hint">{runtimeStatusText(runtimeStatus)}</span>
        </li>
        <li data-testid="settings-diagnostic-recovery">
          <span>起動時のデータベース</span>
          <span className="settings-hint">{recoveryText(recovery)}</span>
        </li>
      </ul>
      <p className="settings-hint">表示だけの項目です。ここから変わる設定はありません。</p>
    </div>
  );
}

export function runtimeStatusText(status: RuntimeStatus | null): string {
  if (status === null) return 'まだ通知はありません';
  const state =
    status.state === 'running' ? '実行中' : status.state === 'failed' ? '失敗' : '待機中';
  const head = `${RUNTIME_LABEL[status.kind]} · ${state}`;
  return status.userMessage === null || status.userMessage === ''
    ? head
    : `${head} · ${status.userMessage}`;
}

export function recoveryText(recovery: DatabaseRecovery | null): string {
  if (recovery === null) return 'まだ読み込まれていません';
  const notes: string[] = [];
  if (recovery.corruptionDetected) notes.push('破損を検出');
  if (recovery.restoredFromBackup) notes.push('バックアップから復元');
  if (recovery.freshStart) notes.push('新しいデータベースで開始');
  if (recovery.interruptedTurns > 0) notes.push(`中断されたターン ${recovery.interruptedTurns}件`);
  return notes.length === 0 ? '問題なく起動しました' : notes.join(' · ');
}

// ---------- Team ----------

/** The bounds the contract already enforces (`min(1).max(4)` / `min(1).max(8)`). Selects rather
 * than number inputs for exactly that reason: a closed range of four or eight values cannot hold a
 * half-typed or out-of-range entry, so there is no client-side validation error to design. */
export const TEAM_DEPTH_RANGE = { min: 1, max: 4 } as const;
export const TEAM_CONCURRENCY_RANGE = { min: 1, max: 8 } as const;

export function integerOptions({ min, max }: { min: number; max: number }): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

export function samePolicy(a: TeamPolicy | null, b: TeamPolicy | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.maxAgentDepth === b.maxAgentDepth &&
    a.maxConcurrentExecutions === b.maxConcurrentExecutions &&
    a.allowWorkerDirectMessages === b.allowWorkerDirectMessages &&
    a.budgetMode === b.budgetMode
  );
}

/** The default policy new Teams start from. Saved explicitly rather than field by field: the four
 * values only mean something together, and a per-field autosave would push three half-finished
 * combinations at Main on the way to the one the user meant. Nothing here touches a Team that
 * already exists — the copy says so, because that is the one thing this screen cannot show. */
function TeamDefaultPolicySetting({ active }: { active: boolean }) {
  const [api] = useState(defaultPolicyApi);
  const [canonical, setCanonical] = useState<TeamPolicy | null>(null);
  const [draft, setDraft] = useState<TeamPolicy | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const uid = useId();
  // Bumped by every read and write, so a response that lost the race can never overwrite a newer
  // one — the failure mode being a slow load that lands after a save and reverts the form.
  const generation = useRef(0);

  useEffect(() => {
    if (!active || api === null) return;
    const request = ++generation.current;
    void (async () => {
      // Yield once so opening the native dialog is the only synchronous work in its parent effect.
      await Promise.resolve();
      if (request !== generation.current) return;
      setCanonical(null);
      setDraft(null);
      setPhase('loading');
      setError(null);
      try {
        const policy = await api.getDefaultTeamPolicy();
        if (request !== generation.current) return;
        setCanonical(policy);
        setDraft(policy);
        setPhase('idle');
      } catch {
        if (request !== generation.current) return;
        setError('Teamの既定値を読み込めませんでした。設定を開き直してください。');
        setPhase('idle');
      }
    })();
    return () => {
      if (request === generation.current) generation.current += 1;
    };
  }, [active, api]);

  async function save(): Promise<void> {
    if (api === null || draft === null || phase !== 'idle') return;
    const request = ++generation.current;
    setPhase('saving');
    setError(null);
    setStatus('');
    try {
      await api.setDefaultTeamPolicy(draft);
      if (request !== generation.current) return;
      setCanonical(draft);
      setStatus('新しいTeamの既定値を保存しました。');
    } catch {
      if (request !== generation.current) return;
      // The edit is kept exactly as made: a rejected save must not leave the form claiming a value
      // Main does not hold, and must not throw the user's work away either.
      setError('Teamの既定値を保存できませんでした。もう一度お試しください。');
    } finally {
      if (request === generation.current) setPhase('idle');
    }
  }

  const unavailable = api === null;
  const disabled = unavailable || draft === null || phase !== 'idle';
  const dirty = !samePolicy(draft, canonical);
  const shown = draft ?? { ...FALLBACK_POLICY };

  function patch(next: Partial<TeamPolicy>): void {
    setDraft((value) => (value === null ? value : { ...value, ...next }));
  }

  return (
    <form
      className="settings-group team-default-policy"
      data-testid="settings-team-defaults"
      aria-busy={phase === 'loading'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="settings-inline-actions">
        <span className="settings-field-label">新しいTeamの既定値</span>
        <span className="settings-hint" data-testid="settings-team-defaults-state">
          {unavailable
            ? 'この環境では変更できません'
            : phase === 'loading'
              ? '読み込み中'
              : phase === 'saving'
                ? '保存中'
                : draft === null
                  ? '未取得'
                  : dirty
                    ? '未保存の変更あり'
                    : '保存済み'}
        </span>
      </div>
      <p className="settings-hint">
        これから作るTeamの初期値です。すでに動いているTeamの設定は変わりません。
        個々のTeamはTeam画面のポリシーからいつでも変更できます。
      </p>

      <div className="team-default-policy-grid">
        <label className="settings-field" htmlFor={`${uid}-depth`}>
          <span className="settings-field-label">Workerの階層の深さ</span>
          <select
            id={`${uid}-depth`}
            data-testid="settings-team-default-depth"
            aria-describedby={`${uid}-depth-desc`}
            value={shown.maxAgentDepth}
            disabled={disabled}
            onChange={(e) => patch({ maxAgentDepth: Number(e.target.value) })}
          >
            {integerOptions(TEAM_DEPTH_RANGE).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <small id={`${uid}-depth-desc`}>
            Workerがさらに下のWorkerを雇える段数です。1ならLeaderが直接雇うWorkerだけになります。
          </small>
        </label>

        <label className="settings-field" htmlFor={`${uid}-concurrency`}>
          <span className="settings-field-label">同時に動かせるWorkerの数</span>
          <select
            id={`${uid}-concurrency`}
            data-testid="settings-team-default-concurrency"
            aria-describedby={`${uid}-concurrency-desc`}
            value={shown.maxConcurrentExecutions}
            disabled={disabled}
            onChange={(e) => patch({ maxConcurrentExecutions: Number(e.target.value) })}
          >
            {integerOptions(TEAM_CONCURRENCY_RANGE).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <small id={`${uid}-concurrency-desc`}>
            同じ時間に作業できるWorkerの上限です。少なくすると順番待ちは増えますが負荷は下がります。
          </small>
        </label>
      </div>

      <label className={`settings-skill-row${disabled ? ' disabled' : ''}`}>
        <input
          type="checkbox"
          data-testid="settings-team-default-direct-messages"
          aria-describedby={`${uid}-dm-desc`}
          checked={shown.allowWorkerDirectMessages}
          disabled={disabled}
          onChange={(e) => patch({ allowWorkerDirectMessages: e.target.checked })}
        />
        <span>
          <strong>Worker同士が直接やり取りすることを許可する</strong>
          <small id={`${uid}-dm-desc`}>オフにすると、やり取りはかならずLeaderを通ります。</small>
        </span>
      </label>

      <fieldset className="settings-group">
        <legend>使う量の上限</legend>
        {BUDGET_MODES.map(({ mode, title, desc }) => (
          <label
            key={mode}
            className={`settings-radio${disabled ? ' disabled' : ''}`}
            data-testid={`settings-team-default-budget-${mode}`}
          >
            <input
              type="radio"
              name={`${uid}-budget`}
              value={mode}
              checked={shown.budgetMode === mode}
              disabled={disabled}
              onChange={() => patch({ budgetMode: mode })}
            />
            <span className="settings-radio-text">
              <span className="settings-radio-title">{title}</span>
              <span className="settings-radio-desc">{desc}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="settings-inline-actions">
        <p className="settings-hint">保存したあとに作るTeamから適用されます。</p>
        <button
          type="submit"
          className="settings-secondary-button"
          data-testid="settings-team-defaults-save"
          disabled={disabled || !dirty}
        >
          {phase === 'saving' ? '保存中…' : '既定値を保存'}
        </button>
      </div>

      {error !== null && (
        <p className="settings-skill-error" role="alert" data-testid="settings-team-defaults-error">
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </form>
  );
}

const BUDGET_MODES: readonly {
  mode: TeamPolicy['budgetMode'];
  title: string;
  desc: string;
}[] = [
  { mode: 'bounded', title: '上限あり', desc: '決められた範囲のなかで動かします。' },
  {
    mode: 'unlimited',
    title: '上限なし',
    desc: '上限を設けずに動かします。長い実行になることがあります。',
  },
];

/** Shown only while the form has no policy to show (loading, or an unavailable bridge), so the
 * controls have something valid to render without claiming it is what Main stores. */
const FALLBACK_POLICY: TeamPolicy = {
  maxAgentDepth: 4,
  maxConcurrentExecutions: 8,
  allowWorkerDirectMessages: true,
  budgetMode: 'bounded',
};

function TeamProviderPermissionCheckbox({
  checked,
  mixed,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={`${label}をTeamで許可`}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function TeamModelRestrictionSetting({ active }: { active: boolean }) {
  const [api] = useState(teamModelSettingsApi);
  const [models, setModels] = useState<readonly ProviderModel[]>([]);
  const [canonical, setCanonical] = useState<TeamModelRestriction | null>(null);
  const [draft, setDraft] = useState<TeamModelRestriction | null>(null);
  const [query, setQuery] = useState('');
  const [expandedConnections, setExpandedConnections] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [phase, setPhase] = useState<'idle' | 'loading' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    if (!active || api === null) return;
    const request = ++generation.current;
    void (async () => {
      await Promise.resolve();
      if (request !== generation.current) return;
      setPhase('loading');
      setError(null);
      try {
        const result = await api.getTeamModelSettings();
        if (request !== generation.current) return;
        setModels(result.availableModels);
        setCanonical(result.restriction);
        setDraft(result.restriction);
        setPhase('idle');
      } catch {
        if (request !== generation.current) return;
        setError('Teamモデルの設定を読み込めませんでした。');
        setPhase('idle');
      }
    })();
    return () => {
      if (request === generation.current) generation.current += 1;
    };
  }, [active, api]);

  const selectedKeys = new Set(draft?.allowedModels.map(teamModelKey) ?? []);
  const availableKeys = new Set(models.map((model) => teamModelKey(providerModelIdentity(model))));
  const groups = groupTeamModelsByConnection(models, draft?.allowedModels ?? []);
  const visibleGroups = filterTeamModelGroups(groups, query);
  const dirty = !sameModelRestriction(draft, canonical);
  const selectedCount = draft?.mode === 'selected' ? draft.allowedModels.length : models.length;
  const availableSelectedCount =
    draft?.mode === 'selected'
      ? draft.allowedModels.filter((model) => availableKeys.has(teamModelKey(model))).length
      : models.length;
  const unavailableSelectedCount = Math.max(0, selectedCount - availableSelectedCount);

  function chooseMode(mode: TeamModelRestriction['mode']): void {
    setDraft((current) => {
      if (current === null) return current;
      return mode === 'all'
        ? { mode: 'all', allowedModels: [] }
        : { mode: 'selected', allowedModels: models.map(providerModelIdentity) };
    });
  }

  function toggleModel(
    identity: TeamModelConnectionGroup['choices'][number]['identity'],
    checked: boolean,
  ): void {
    setDraft((current) => {
      if (current === null) return current;
      return {
        mode: 'selected',
        allowedModels: setTeamModelSelected(current.allowedModels, identity, checked),
      };
    });
  }

  function toggleConnection(group: TeamModelConnectionGroup, checked: boolean): void {
    setDraft((current) => {
      if (current === null) return current;
      return {
        mode: 'selected',
        allowedModels: setTeamConnectionSelected(current.allowedModels, group, checked),
      };
    });
  }

  function toggleConnectionExpanded(connectionId: string): void {
    setExpandedConnections((current) => {
      const next = new Set(current);
      if (next.has(connectionId)) next.delete(connectionId);
      else next.add(connectionId);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (api === null || draft === null || phase !== 'idle') return;
    const request = ++generation.current;
    setPhase('saving');
    setError(null);
    setStatus('');
    try {
      await api.setTeamModelRestriction(draft);
      if (request !== generation.current) return;
      setCanonical(draft);
      setStatus('Teamで使用するモデルを保存しました。');
    } catch {
      if (request !== generation.current) return;
      setError('Teamモデルの設定を保存できませんでした。1つ以上選択してください。');
    } finally {
      if (request === generation.current) setPhase('idle');
    }
  }

  const disabled = api === null || draft === null || phase !== 'idle';

  return (
    <form
      className="settings-group team-model-settings"
      data-testid="settings-team-models"
      aria-busy={phase === 'loading'}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="settings-section-heading">
        <div>
          <h3>Teamで使用するモデル</h3>
          <p>Providerごとにまとめて許可するか、開いて使用するモデルを指定できます。</p>
        </div>
        <span className="settings-count-badge">
          {phase === 'loading'
            ? '読み込み中'
            : unavailableSelectedCount > 0
              ? `${availableSelectedCount} / ${models.length} · 利用不可 ${unavailableSelectedCount}`
              : `${availableSelectedCount} / ${models.length}`}
        </span>
      </div>

      <div className="team-model-mode" role="radiogroup" aria-label="Teamモデルの範囲">
        <label>
          <input
            type="radio"
            name="team-model-mode"
            checked={draft?.mode === 'all'}
            disabled={disabled}
            onChange={() => chooseMode('all')}
          />
          すべての接続・モデルを許可
        </label>
        <label>
          <input
            type="radio"
            name="team-model-mode"
            checked={draft?.mode === 'selected'}
            disabled={disabled || models.length === 0}
            onChange={() => chooseMode('selected')}
          />
          Providerごとに指定
        </label>
      </div>

      {draft?.mode === 'selected' && (
        <>
          <label className="settings-field" htmlFor="settings-team-model-search">
            <span className="settings-field-label">モデルを検索</span>
            <input
              id="settings-team-model-search"
              className="settings-text-input"
              type="search"
              placeholder="モデル名、Provider、接続名"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Search never submits this settings form. In particular, the Enter that commits a
                // Japanese IME composition must not save a half-finished provider selection.
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
          </label>
          <div className="team-model-connections" aria-label="使用を許可するProviderとモデル">
            {visibleGroups.length === 0 ? (
              <p className="settings-hint">条件に一致するモデルはありません。</p>
            ) : (
              visibleGroups.map((group, index) => {
                // Search narrows only the rendered rows. Counts and bulk actions still target the
                // complete Connection, including models currently hidden by the query.
                const fullGroup = groups.find(
                  (candidate) => candidate.connectionId === group.connectionId,
                )!;
                const selection = getTeamConnectionSelection(fullGroup, draft.allowedModels);
                const searchActive = query.trim() !== '';
                const expanded = searchActive || expandedConnections.has(group.connectionId);
                const modelRegionId = `team-provider-models-${index}-${group.connectionId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                return (
                  <div
                    className={`team-model-connection${expanded ? ' expanded' : ''}`}
                    data-testid={`settings-team-model-connection-${group.connectionId}`}
                    key={group.connectionId}
                  >
                    <div className="team-provider-summary">
                      <label className="team-provider-permission">
                        <TeamProviderPermissionCheckbox
                          checked={selection.allAvailableSelected}
                          mixed={selection.partiallySelected}
                          disabled={
                            phase !== 'idle' ||
                            (selection.availableCount === 0 && selection.selectedCount === 0)
                          }
                          label={group.label}
                          onChange={(checked) => toggleConnection(fullGroup, checked)}
                        />
                        <span>
                          <strong>{group.label}</strong>
                          <small>
                            {group.providerId} · {selection.totalCount}モデル
                          </small>
                        </span>
                      </label>
                      <div className="team-provider-actions">
                        <span className="settings-count-badge">
                          {selection.selectedCount === selection.totalCount
                            ? 'すべて許可'
                            : selection.selectedCount === 0
                              ? '許可なし'
                              : `${selection.selectedCount} / ${selection.totalCount}`}
                        </span>
                        <button
                          type="button"
                          className="team-provider-expand"
                          aria-expanded={expanded}
                          aria-controls={modelRegionId}
                          aria-label={
                            searchActive
                              ? `${group.label}の検索結果を表示中`
                              : `${group.label}のモデルを${expanded ? '閉じる' : '開く'}`
                          }
                          disabled={searchActive}
                          onClick={() => toggleConnectionExpanded(group.connectionId)}
                        >
                          <span aria-hidden="true">›</span>
                        </button>
                      </div>
                    </div>
                    {expanded && (
                      <fieldset id={modelRegionId} className="team-model-detail">
                        <legend className="sr-only">{group.label}で使用するモデル</legend>
                        <div className="team-model-list">
                          {group.choices.map((choice) => (
                            <label
                              className={`team-model-row${choice.available ? '' : ' unavailable'}`}
                              key={teamModelKey(choice.identity)}
                            >
                              <input
                                type="checkbox"
                                checked={selectedKeys.has(teamModelKey(choice.identity))}
                                disabled={phase !== 'idle'}
                                onChange={(event) =>
                                  toggleModel(choice.identity, event.target.checked)
                                }
                              />
                              <span>
                                <strong>{choice.displayName}</strong>
                                <small>
                                  {choice.identity.modelId}
                                  {choice.available ? '' : ' · 現在利用不可'}
                                </small>
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      <div className="settings-inline-actions">
        <p className="settings-hint">
          保存後の新しい採用から全Teamに適用されます。あとから追加した接続は、モデルを選ぶまで候補に入りません。
        </p>
        <button
          type="submit"
          className="settings-secondary-button"
          data-testid="settings-team-models-save"
          disabled={
            disabled || !dirty || (draft?.mode === 'selected' && availableSelectedCount === 0)
          }
        >
          {phase === 'saving' ? '保存中…' : 'モデル設定を保存'}
        </button>
      </div>
      {error !== null && (
        <p className="settings-skill-error" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </form>
  );
}

// Global Team setting: whether a Leader/Manager researches the Web before hiring Workers. Kept in
// this file rather than the store because it is a persisted backend value with no renderer-side
// consumer — the canonical answer lives in Main, so the dialog reads it fresh on every open instead
// of caching a copy that can silently drift.
function TeamResearchSetting({ active }: { active: boolean }) {
  const [api] = useState(researchApi);
  const [canonical, setCanonical] = useState<boolean | null>(null);
  const [shown, setShown] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  // Bumped by every read and write, so a response that lost the race can never overwrite a newer
  // one — the failure mode being that a slow load lands after a save and reverts the checkbox.
  const generation = useRef(0);
  // State reads inside the change handler can lag a double-click; the ref cannot.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!active || api === null) return;
    const request = ++generation.current;
    inFlight.current = true;
    void (async () => {
      // Yield once so opening the native dialog is the only synchronous work in its parent effect.
      await Promise.resolve();
      if (request !== generation.current) return;
      setCanonical(null);
      setShown(null);
      setPhase('loading');
      setError(null);
      try {
        const result = await api.getTeamModelResearch();
        if (request !== generation.current) return;
        inFlight.current = false;
        setCanonical(result.researchBeforeHiring);
        setShown(result.researchBeforeHiring);
        setPhase('idle');
      } catch {
        if (request !== generation.current) return;
        inFlight.current = false;
        setError('Teamの調査設定を読み込めませんでした。設定を開き直してください。');
        setPhase('idle');
      }
    })();
    return () => {
      if (request !== generation.current) return;
      generation.current += 1;
      inFlight.current = false;
    };
  }, [active, api]);

  async function save(next: boolean): Promise<void> {
    if (api === null || inFlight.current) return;
    const request = ++generation.current;
    inFlight.current = true;
    const previous = canonical;
    setShown(next);
    setPhase('saving');
    setError(null);
    try {
      await api.setTeamModelResearch({ researchBeforeHiring: next });
      if (request !== generation.current) return;
      setCanonical(next);
      setStatus(
        next
          ? 'Worker採用前のWeb調査を有効にしました。'
          : 'Worker採用前のWeb調査を無効にしました。',
      );
    } catch {
      if (request !== generation.current) return;
      // Restore the last value Main confirmed, not the one just attempted.
      setShown(previous);
      setError('設定を保存できませんでした。直前の値に戻しました。');
    } finally {
      if (request === generation.current) {
        inFlight.current = false;
        setPhase('idle');
      }
    }
  }

  const unavailable = api === null;
  const disabled = unavailable || phase !== 'idle' || shown === null;

  return (
    <fieldset className="settings-group" aria-busy={phase === 'loading'}>
      <legend>Team</legend>
      <label
        className={`settings-skill-row${disabled ? ' disabled' : ''}`}
        data-testid="settings-team-research"
      >
        <input
          type="checkbox"
          checked={shown ?? false}
          disabled={disabled}
          aria-describedby="settings-team-research-hint"
          onChange={(e) => void save(e.target.checked)}
        />
        <span>
          <strong>Worker採用前にWebで調査する</strong>
          <small data-testid="settings-team-research-state">
            {unavailable
              ? 'この環境では変更できません'
              : phase === 'loading'
                ? '現在の設定を読み込み中'
                : phase === 'saving'
                  ? '保存中'
                  : shown === null
                    ? '未取得'
                    : shown
                      ? 'ON · Web調査あり'
                      : 'OFF · カタログのみ'}
          </small>
        </span>
      </label>
      <p className="settings-hint" id="settings-team-research-hint">
        ONにすると、LeaderやManagerがWorkerを採用する前に、担当させるモデルごとにWebを検索して
        最新の情報を確認し、参照した情報源を記録します。そのぶんTeamの開始が遅くなることがあります。
        OFFにするとWeb調査は行わず、これまでどおりカタログにあるモデル情報だけで担当を決めます。
      </p>
      {error !== null && (
        <p className="settings-skill-error" role="alert" data-testid="settings-team-research-error">
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </fieldset>
  );
}

// Null when the preload bridge predates this setting, which keeps the control disabled instead of
// throwing on click in an older shell.
function researchApi(): NonNullable<Window['sprintCoder']>['settings'] | null {
  const settings = typeof window === 'undefined' ? undefined : window.sprintCoder?.settings;
  if (
    settings === undefined ||
    typeof settings.getTeamModelResearch !== 'function' ||
    typeof settings.setTeamModelResearch !== 'function'
  )
    return null;
  return settings;
}

function defaultPolicyApi(): NonNullable<Window['sprintCoder']>['settings'] | null {
  const settings = typeof window === 'undefined' ? undefined : window.sprintCoder?.settings;
  if (
    settings === undefined ||
    typeof settings.getDefaultTeamPolicy !== 'function' ||
    typeof settings.setDefaultTeamPolicy !== 'function'
  )
    return null;
  return settings;
}

function teamModelSettingsApi(): NonNullable<Window['sprintCoder']>['settings'] | null {
  const settings = typeof window === 'undefined' ? undefined : window.sprintCoder?.settings;
  if (
    settings === undefined ||
    typeof settings.getTeamModelSettings !== 'function' ||
    typeof settings.setTeamModelRestriction !== 'function'
  )
    return null;
  return settings;
}
