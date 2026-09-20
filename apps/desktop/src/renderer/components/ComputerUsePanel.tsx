import { useEffect, useRef, useState } from 'react';
import {
  bindComputerUseMaximumMode,
  bindComputerUsePolicyLanguage,
  type ComputerAppGrantView,
  type ComputerUseAcceptanceMode,
  type ComputerUseApprovalDecision,
  type ComputerUseMode,
  type ComputerUseOsPermission,
  type ComputerUsePolicyLanguage,
} from '@sprint-coder/contracts';
import { Eye, ShieldAlert, Square, X } from './icons';
import {
  quickStartActivationIntent,
  serializeComputerUseActivationIntent,
} from '../../computer-use-activation-intent';

export type ComputerUseModeView = ComputerUseMode;

export function availableComputerUseMode(
  requested: ComputerUseModeView,
  controlAvailable: boolean,
  policyLanguage: ComputerUsePolicyLanguage,
  maximumMode: ComputerUseModeView = 'full_access_app',
): ComputerUseModeView {
  if (!controlAvailable) return 'observe_only';
  const bounded = bindComputerUseMaximumMode(requested, maximumMode);
  return bounded === 'full_access_app' && policyLanguage === 'unknown' ? 'supervised' : bounded;
}

export type ComputerUseProfileView = Readonly<{
  id: string;
  revision: number;
  displayName: string;
  identityLabel: string;
  metadata: string;
  available: boolean;
  unavailableReason: string | null;
  mode: ComputerUseModeView;
  connectionId: string;
  modelId: string;
  providerEgressConsent: boolean;
  remember: boolean;
  policyLanguage: ComputerUsePolicyLanguage;
  maximumMode: ComputerUseModeView;
}>;

export type ComputerUseWindowView = Readonly<{
  id: string;
  revision?: number;
  profileRevision: number;
  label: string;
  detail: string;
  policyLanguage: ComputerUsePolicyLanguage;
  maximumMode: ComputerUseModeView;
}>;

export type ComputerUseProviderView = Readonly<{
  connectionId: string;
  modelId: string;
  label: string;
  detail: string;
  capabilityStatus: 'confirmed' | 'unknown';
}>;

export type ComputerUseStartView = Readonly<{
  maxRounds?: number;
  profileId: string;
  profileRevision: number;
  windowCandidateId: string;
  mode: ComputerUseModeView;
  connectionId: string;
  modelId: string;
  remember: boolean;
  egressConfirmed: true;
}>;

export type ComputerUseSessionView = Readonly<{
  sessionId: string;
  appName: string;
  windowLabel: string;
  mode: ComputerUseModeView;
  providerLabel: string;
  state: 'preflight' | 'observing' | 'planning' | 'awaiting_approval' | 'acting' | 'paused';
  round: number;
  maxRounds: number;
  expiresAt: string;
  observedAt: string | null;
  pauseReason: string | null;
  resumable?: boolean;
}>;

export type ComputerUseApprovalView = Readonly<{
  id: string;
  actionLabel: string;
  targetLabel: string;
  impactLabel: string;
  escapedPreview: string | null;
  allowedDecisions: readonly ComputerUseApprovalDecision[];
  activationIntents?: Readonly<Partial<Record<ComputerUseApprovalDecision, string>>>;
}>;

export type ComputerUseUnavailableView = Readonly<{
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  observe: boolean;
  control: boolean;
  reasonCode: string | null;
  /** Named by Main from a verified native probe; never a native string and never a URL. */
  missingPermissions: readonly ComputerUseOsPermission[];
}>;

/** Every OS permission this product can name, in the order the user sees them. */
const COMPUTER_USE_OS_PERMISSIONS = ['accessibility', 'screen_recording'] as const;
const COMPUTER_USE_OS_PERMISSION_LABELS: Readonly<Record<ComputerUseOsPermission, string>> = {
  accessibility: 'アクセシビリティ',
  screen_recording: '画面収録',
};

/**
 * An acceptance-only build waives Windows signer verification, so it must never be mistaken for a
 * release. The notice stays on screen for the whole Computer Use surface, whatever the availability
 * state or the feature flag says.
 */
export function ComputerUseAcceptanceBuildNotice({
  acceptanceMode,
}: {
  acceptanceMode: ComputerUseAcceptanceMode | null;
}) {
  if (acceptanceMode === null) return null;
  return (
    <aside className="computer-use-acceptance-build" role="status">
      <ShieldAlert size={16} />
      <p>
        受入れ専用ビルドです。Windowsの署名者検証を免除しています（<code>{acceptanceMode}</code>
        ）。配布しないでください。
      </p>
    </aside>
  );
}

const COMPUTER_USE_MODE_CEILING_LABELS: Readonly<Record<ComputerUseMode, string>> = {
  observe_only: '観測のみ',
  supervised: '操作ごとに確認',
  full_access_app: 'フルアクセス',
};

function computerUseGrantDate(value: string | null): string {
  if (value === null) return '未使用';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '不明'
    : parsed.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The permanent application grants, and the only way to take one back (ADR v2 §6.1, §6.5).
 *
 * The row is built out of verified facts — publisher, application id, signing class, the mode
 * ceiling — with the application's own name kept in its own element and labelled as such. They are
 * never concatenated: an application that names itself "Notes — Apple, verified" must not be able to
 * read as though the product said so.
 *
 * Revoking is a plain button rather than a confirmation flow. It only ever removes permission, the
 * worst outcome is being asked again, and an extra dialog between a worried user and "stop this" is
 * the wrong trade. The trusted click is what Main requires, so the activation attribute is on the
 * button itself.
 */
export function ComputerUseGrantSection({
  grants,
  discardedRecords,
  busy,
  error,
  onRevoke,
}: {
  grants: readonly ComputerAppGrantView[];
  discardedRecords: number;
  busy: boolean;
  error: string | null;
  onRevoke: (grant: ComputerAppGrantView) => Promise<void>;
}) {
  return (
    <section className="computer-use-grants" aria-labelledby="computer-use-grants-title">
      <h3 id="computer-use-grants-title" className="computer-use-grants__title">
        許可済みアプリ
      </h3>
      <p className="computer-use-grants__lead">
        AIが確認なしで操作できるアプリです。取り消すと、実行中の操作はその場で停止します。
      </p>
      {discardedRecords > 0 ? (
        <p className="computer-use-grants__discarded" role="status">
          <ShieldAlert size={14} />
          無効な許可レコードを{discardedRecords}
          件破棄しました。該当アプリは次回あらためて確認します。
        </p>
      ) : null}
      {error === null ? null : (
        <p className="computer-use-grants__error" role="alert">
          {error}
        </p>
      )}
      {grants.length === 0 ? (
        <p className="computer-use-grants__empty">許可済みのアプリはありません。</p>
      ) : (
        <ul className="computer-use-grant-list">
          {grants.map((grant) => (
            <li className="computer-use-grant" key={grant.id}>
              <div className="computer-use-grant__copy">
                <strong className="computer-use-grant__name">
                  {grant.untrustedDisplayName}
                  <span className="computer-use-grant__name-note">（アプリ自称名）</span>
                </strong>
                <dl className="computer-use-grant__facts">
                  <div>
                    <dt>発行元</dt>
                    <dd>{grant.publisher ?? '確認できません'}</dd>
                  </div>
                  <div>
                    <dt>アプリID</dt>
                    <dd>{grant.appId}</dd>
                  </div>
                  <div>
                    <dt>署名</dt>
                    <dd
                      className={
                        grant.identityKind === 'verified-signed'
                          ? 'computer-use-grant__signed'
                          : 'computer-use-grant__unsigned'
                      }
                    >
                      {grant.identityKind === 'verified-signed' ? '本人確認済み' : '未署名'}
                    </dd>
                  </div>
                  <div>
                    <dt>上限</dt>
                    <dd>{COMPUTER_USE_MODE_CEILING_LABELS[grant.maxMode]}</dd>
                  </div>
                  <div>
                    <dt>最終使用</dt>
                    <dd>{computerUseGrantDate(grant.lastUsedAt)}</dd>
                  </div>
                  <div>
                    <dt>AIの要求</dt>
                    <dd>
                      {grant.requestCount}回（拒否{grant.denialCount}回）
                    </dd>
                  </div>
                </dl>
                {grant.codeChangedAt === null ? null : (
                  <small className="computer-use-grant__updated">
                    {computerUseGrantDate(grant.codeChangedAt)}にアプリが更新されました。
                  </small>
                )}
              </div>
              <button
                type="button"
                className="computer-use-grant__revoke"
                data-computer-use-activation="app-grant-revoke"
                disabled={busy}
                onClick={() => void onRevoke(grant)}
              >
                許可を取り消す
                <span className="sr-only">（{grant.appId}）</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ComputerUseUnavailableNotice({
  availability,
  busy,
  error,
  onClose,
  onRetry,
  onOpenSettings,
}: {
  availability: ComputerUseUnavailableView;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onRetry: () => Promise<void>;
  onOpenSettings: (permission: ComputerUseOsPermission) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const descriptionId = 'computer-use-unavailable-description';

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // Main names a permission only from a verified native probe, so an itemised list is available
  // exactly when the user can act on it. Everything else keeps the platform guidance below.
  const permissionRows =
    availability.missingPermissions.length === 0
      ? []
      : COMPUTER_USE_OS_PERMISSIONS.map((permission) => ({
          permission,
          granted: !availability.missingPermissions.includes(permission),
        }));
  const missing = [
    availability.observe ? null : '画面の読み取り',
    availability.control ? null : 'アクセシビリティ操作',
  ].filter((label): label is string => label !== null);
  const guidance =
    availability.platform === 'darwin'
      ? 'macOSの「システム設定」→「プライバシーとセキュリティ」で、Sprint Coderの「画面収録」と「アクセシビリティ」を許可してください。変更後はSprint Coderの再起動が必要な場合があります。'
      : availability.platform === 'win32'
        ? '対象アプリとSprint Coderを同じ権限レベルで起動し、Windowsのプライバシー設定を確認してください。管理者権限のアプリは操作できません。'
        : 'このOSではComputer Useの権限を確認できません。対応する署名済みpackageで再試行してください。';

  return (
    <dialog
      ref={dialogRef}
      className="computer-use-dialog computer-use-unavailable-dialog"
      aria-labelledby="computer-use-unavailable-title"
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClose={onClose}
    >
      <div className="computer-use-onboarding">
        <header className="computer-use-dialog__header">
          <div>
            <span className="computer-use-eyebrow">COMPUTER USE</span>
            <h2 id="computer-use-unavailable-title">OSの許可が必要です</h2>
          </div>
          <button type="button" className="computer-use-close" onClick={onClose} disabled={busy}>
            <X size={16} />
            <span className="sr-only">閉じる</span>
          </button>
        </header>
        <section className="computer-use-step computer-use-permission-step">
          <div className="computer-use-full-warning" role="status">
            <ShieldAlert size={20} />
            <div>
              <strong>
                {permissionRows.length === 0
                  ? `${missing.join('と')}を利用できません`
                  : '足りないOSの許可があります'}
              </strong>
              <p id={descriptionId}>
                {permissionRows.length === 0
                  ? guidance
                  : 'macOSの「システム設定」→「プライバシーとセキュリティ」で、Sprint Coderに次の許可を与えてください。許可の反映にはSprint Coderの再起動が必要です。再起動後もこの案内が出る場合は「許可を再確認」してください。'}
              </p>
            </div>
          </div>
          {permissionRows.length === 0 ? null : (
            <ul className="computer-use-permission-list" aria-live="polite">
              {permissionRows.map((row) => (
                <li key={row.permission} className="computer-use-permission-row">
                  <span className="computer-use-permission-name">
                    {COMPUTER_USE_OS_PERMISSION_LABELS[row.permission]}
                  </span>
                  <span
                    className={
                      row.granted
                        ? 'computer-use-permission-state computer-use-permission-state--granted'
                        : 'computer-use-permission-state computer-use-permission-state--missing'
                    }
                  >
                    {row.granted ? '許可済み' : '未許可'}
                  </span>
                  {row.granted ? null : (
                    <button
                      type="button"
                      className="computer-use-permission-open"
                      data-computer-use-activation="permission-settings"
                      data-computer-use-permission={row.permission}
                      aria-label={`${COMPUTER_USE_OS_PERMISSION_LABELS[row.permission]}の設定を開く`}
                      disabled={busy}
                      onClick={() => void onOpenSettings(row.permission)}
                    >
                      設定を開く
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {availability.reasonCode === null ? null : (
            <p className="computer-use-reason-code">状態コード: {availability.reasonCode}</p>
          )}
          {error === null || error === undefined ? null : (
            <p className="computer-use-error" role="alert">
              {error}
            </p>
          )}
        </section>
        <footer className="computer-use-dialog__actions">
          <button type="button" disabled={busy} onClick={onClose}>
            閉じる
          </button>
          <button
            type="button"
            className="computer-use-primary"
            disabled={busy}
            autoFocus
            onClick={() => void onRetry()}
          >
            {busy ? '確認中…' : '許可を再確認'}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

export function ComputerUseOnboarding({
  taskId = 'unbound-task',
  expectedPolicyEpoch = 0,
  profiles,
  providers,
  controlAvailable,
  busy,
  error: externalError,
  grants = null,
  grantError = null,
  onClose,
  onRegister,
  onResolveWindows,
  onRevokeGrant,
  onStart,
}: {
  taskId?: string;
  expectedPolicyEpoch?: number;
  profiles: readonly ComputerUseProfileView[];
  providers: readonly ComputerUseProviderView[];
  controlAvailable: boolean;
  busy: boolean;
  error?: string | null;
  /**
   * Null when the agent-driven gate is off, which is also the default.
   *
   * The section is absent rather than empty in that case: Main refuses the channel too, so an empty
   * list would promise a surface that does not exist.
   */
  grants?: Readonly<{ grants: readonly ComputerAppGrantView[]; discardedRecords: number }> | null;
  grantError?: string | null;
  onClose: () => void;
  onRegister: () => Promise<void>;
  onResolveWindows: (profileId: string) => Promise<readonly ComputerUseWindowView[]>;
  onRevokeGrant?: (grant: ComputerAppGrantView) => Promise<void>;
  onStart: (input: ComputerUseStartView) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const firstAvailableProfileId = profiles.find((profile) => profile.available)?.id;
  const firstAvailableProfile = profiles.find((profile) => profile.id === firstAvailableProfileId);
  const [profileId, setProfileId] = useState(firstAvailableProfileId ?? profiles[0]?.id ?? '');
  const [windows, setWindows] = useState<readonly ComputerUseWindowView[]>([]);
  const [windowId, setWindowId] = useState('');
  const [mode, setMode] = useState<ComputerUseModeView>(
    availableComputerUseMode(
      'full_access_app',
      controlAvailable,
      firstAvailableProfile?.policyLanguage ?? 'unknown',
      firstAvailableProfile?.maximumMode ?? 'observe_only',
    ),
  );
  const [providerKey, setProviderKey] = useState(
    providers[0] === undefined ? '' : providerKeyOf(providers[0]),
  );
  const [remember, setRemember] = useState(false);
  const [roundLimit, setRoundLimit] = useState('25');
  const maxRounds = Number(roundLimit);
  const roundLimitValid = Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 25;
  const [egressConfirmed, setEgressConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const selectedProfile = profiles.find((profile) => profile.id === profileId) ?? null;
  const selectedProvider = providers.find((provider) => providerKeyOf(provider) === providerKey);
  const selectedWindow = windows.find((candidate) => candidate.id === windowId) ?? null;
  const policyLanguage = bindComputerUsePolicyLanguage(
    selectedProfile?.policyLanguage ?? 'unknown',
    selectedWindow?.policyLanguage ?? 'unknown',
  );
  const maximumMode = bindComputerUseMaximumMode(
    selectedProfile?.maximumMode ?? 'observe_only',
    selectedWindow?.maximumMode ?? 'observe_only',
  );
  const effectiveMode = availableComputerUseMode(
    mode,
    controlAvailable,
    policyLanguage,
    maximumMode,
  );
  const selectedProviderUnconfirmed = selectedProvider?.capabilityStatus === 'unknown';
  const visibleError = error ?? externalError;
  const startIntent =
    step === 2 &&
    selectedProfile !== null &&
    selectedProvider !== undefined &&
    selectedWindow !== null &&
    roundLimitValid &&
    egressConfirmed
      ? serializeComputerUseActivationIntent({
          operation: 'start',
          taskId,
          profileId: selectedProfile.id,
          mode: effectiveMode,
          connectionId: selectedProvider.connectionId,
          modelId: selectedProvider.modelId,
          providerEgressConsent: true,
          remember,
          maxRounds,
          expectedPolicyEpoch,
          expectedProfileRevision: selectedWindow.profileRevision,
          windowId: selectedWindow.id,
          expectedWindowRevision: selectedWindow.revision ?? 0,
        })
      : undefined;

  function quickIntentFor(profile: ComputerUseProfileView): string | undefined {
    const preferred = providers.find(
      (provider) =>
        provider.connectionId === profile.connectionId && provider.modelId === profile.modelId,
    );
    if (!profile.remember || !profile.providerEgressConsent || preferred === undefined)
      return undefined;
    return quickStartActivationIntent({
      taskId,
      profileId: profile.id,
      mode: availableComputerUseMode(
        profile.mode,
        controlAvailable,
        profile.policyLanguage,
        profile.maximumMode,
      ),
      connectionId: preferred.connectionId,
      modelId: preferred.modelId,
      providerEgressConsent: true,
      remember: true,
      maxRounds: 25,
      expectedPolicyEpoch,
      expectedProfileRevision: profile.revision,
    });
  }

  async function continueToMode(): Promise<void> {
    if (selectedProfile === null || !selectedProfile.available) return;
    await openModeForProfile(selectedProfile);
  }

  async function openModeForProfile(profile: ComputerUseProfileView): Promise<void> {
    setError(null);
    try {
      const candidates = await onResolveWindows(profile.id);
      if (candidates.length === 0) {
        setError('操作できるウィンドウが見つかりません。対象アプリを開いて再試行してください。');
        return;
      }
      setWindows(candidates);
      setWindowId(candidates[0]!.id);
      const preferred = providers.find(
        (provider) =>
          provider.connectionId === profile.connectionId && provider.modelId === profile.modelId,
      );
      if (preferred !== undefined) {
        setProviderKey(providerKeyOf(preferred));
        setEgressConfirmed(profile.providerEgressConsent);
      } else {
        setProviderKey(providers[0] === undefined ? '' : providerKeyOf(providers[0]));
        // A fallback Provider/Model is a new egress destination and needs a fresh user consent.
        setEgressConfirmed(false);
      }
      setProfileId(profile.id);
      setMode(
        availableComputerUseMode(
          profile.mode,
          controlAvailable,
          bindComputerUsePolicyLanguage(profile.policyLanguage, candidates[0]!.policyLanguage),
          bindComputerUseMaximumMode(profile.maximumMode, candidates[0]!.maximumMode),
        ),
      );
      setRemember(profile.remember);
      setStep(2);
    } catch (cause) {
      setError(messageOf(cause, '対象アプリのウィンドウを確認できませんでした。'));
    }
  }

  async function quickStart(profile: ComputerUseProfileView): Promise<void> {
    const preferred = providers.find(
      (provider) =>
        provider.connectionId === profile.connectionId && provider.modelId === profile.modelId,
    );
    if (!profile.remember || !profile.providerEgressConsent || preferred === undefined) {
      await openModeForProfile(profile);
      return;
    }
    if (!controlAvailable && profile.mode !== 'observe_only') {
      await openModeForProfile(profile);
      return;
    }
    setError(null);
    try {
      const candidates = await onResolveWindows(profile.id);
      if (candidates.length !== 1) {
        setProfileId(profile.id);
        setWindows(candidates);
        setWindowId(candidates[0]?.id ?? '');
        setProviderKey(providerKeyOf(preferred));
        setMode(
          availableComputerUseMode(
            profile.mode,
            controlAvailable,
            bindComputerUsePolicyLanguage(
              profile.policyLanguage,
              candidates[0]?.policyLanguage ?? 'unknown',
            ),
            bindComputerUseMaximumMode(
              profile.maximumMode,
              candidates[0]?.maximumMode ?? 'observe_only',
            ),
          ),
        );
        setEgressConfirmed(true);
        setRemember(true);
        setStep(2);
        if (candidates.length === 0)
          setError('操作できるウィンドウが見つかりません。対象アプリを開いて再試行してください。');
        return;
      }
      const quickMode = availableComputerUseMode(
        profile.mode,
        controlAvailable,
        bindComputerUsePolicyLanguage(profile.policyLanguage, candidates[0]!.policyLanguage),
        bindComputerUseMaximumMode(profile.maximumMode, candidates[0]!.maximumMode),
      );
      if (quickMode !== profile.mode) {
        setProfileId(profile.id);
        setWindows(candidates);
        setWindowId(candidates[0]!.id);
        setProviderKey(providerKeyOf(preferred));
        setMode(quickMode);
        setEgressConfirmed(true);
        setRemember(true);
        setStep(2);
        return;
      }
      await onStart({
        profileId: profile.id,
        profileRevision: candidates[0]!.profileRevision,
        windowCandidateId: candidates[0]!.id,
        mode: quickMode,
        connectionId: preferred.connectionId,
        modelId: preferred.modelId,
        remember: true,
        maxRounds: 25,
        egressConfirmed: true,
      });
    } catch (cause) {
      setError(messageOf(cause, 'Computer Useを開始できませんでした。'));
    }
  }

  async function register(): Promise<void> {
    setError(null);
    try {
      await onRegister();
    } catch (cause) {
      setError(messageOf(cause, 'アプリを登録できませんでした。'));
    }
  }

  async function start(): Promise<void> {
    if (
      selectedProfile === null ||
      selectedProvider === undefined ||
      selectedWindow === null ||
      windowId === '' ||
      !roundLimitValid ||
      !egressConfirmed
    )
      return;
    setError(null);
    try {
      await onStart({
        profileId: selectedProfile.id,
        profileRevision: selectedWindow.profileRevision,
        windowCandidateId: windowId,
        mode: effectiveMode,
        connectionId: selectedProvider.connectionId,
        modelId: selectedProvider.modelId,
        remember,
        maxRounds,
        egressConfirmed: true,
      });
    } catch (cause) {
      setError(messageOf(cause, 'Computer Useを開始できませんでした。'));
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="computer-use-dialog"
      aria-labelledby="computer-use-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClose={onClose}
    >
      <form
        className="computer-use-onboarding"
        onSubmit={(event) => {
          event.preventDefault();
          if (step === 1) void continueToMode();
          else void start();
        }}
      >
        <header className="computer-use-dialog__header">
          <div>
            <span className="computer-use-eyebrow">COMPUTER USE · {step} / 2</span>
            <h2 id="computer-use-dialog-title">
              {step === 1 ? '操作するアプリを選ぶ' : '操作方法と送信先を確認'}
            </h2>
          </div>
          <button type="button" className="computer-use-close" onClick={onClose} disabled={busy}>
            <X size={16} />
            <span className="sr-only">閉じる</span>
          </button>
        </header>

        {step === 1 ? (
          <section className="computer-use-step" aria-label="登録済みアプリ">
            {profiles.length === 0 ? (
              <div className="computer-use-empty">
                <Eye size={20} />
                <strong>登録済みアプリはありません</strong>
                <p>アプリは署名情報と実行ファイルのidentityに結び付けて登録します。</p>
              </div>
            ) : (
              <fieldset className="computer-use-profile-list">
                <legend className="sr-only">操作するアプリ</legend>
                {profiles.map((profile) => (
                  <div
                    className={`computer-use-profile${profileId === profile.id ? ' is-selected' : ''}`}
                    key={profile.id}
                  >
                    <label>
                      <input
                        type="radio"
                        name="computer-use-profile"
                        value={profile.id}
                        checked={profileId === profile.id}
                        disabled={!profile.available || busy}
                        autoFocus={profile.id === firstAvailableProfileId}
                        onChange={() => setProfileId(profile.id)}
                      />
                      <span className="computer-use-profile__copy">
                        <strong>{profile.displayName}</strong>
                        <span>{profile.identityLabel}</span>
                        <small>
                          {profile.available
                            ? profile.metadata
                            : (profile.unavailableReason ?? '現在は利用できません')}
                        </small>
                      </span>
                    </label>
                    {profile.remember && profile.providerEgressConsent ? (
                      <button
                        type="button"
                        className="computer-use-quick-start"
                        data-computer-use-activation="start"
                        data-computer-use-intent={quickIntentFor(profile)}
                        disabled={!profile.available || busy}
                        onClick={() => void quickStart(profile)}
                      >
                        開始
                      </button>
                    ) : null}
                  </div>
                ))}
              </fieldset>
            )}
            <button
              type="button"
              className="computer-use-secondary"
              data-computer-use-activation="application"
              disabled={busy}
              autoFocus={firstAvailableProfileId === undefined}
              onClick={() => void register()}
            >
              アプリを登録
            </button>
            <p className="computer-use-native-latency-note" role="note">
              V1の対応アプリは、WindowsはSystem32のクラシック版メモ帳と同じreleaseで署名した受入fixture、macOSはTextEditと公式Visual
              Studio Code（確認あり）です。上記以外のアプリは未対応です。
            </p>
            {grants === null || onRevokeGrant === undefined ? null : (
              <ComputerUseGrantSection
                grants={grants.grants}
                discardedRecords={grants.discardedRecords}
                busy={busy}
                error={grantError}
                onRevoke={onRevokeGrant}
              />
            )}
          </section>
        ) : (
          <section className="computer-use-step">
            <label className="computer-use-field">
              <span>対象ウィンドウ</span>
              <select
                value={windowId}
                disabled={busy}
                autoFocus
                onChange={(e) => setWindowId(e.target.value)}
              >
                {windows.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label} — {candidate.detail}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="computer-use-mode-list">
              <legend>操作方法</legend>
              <ModeCard
                mode="full_access_app"
                selected={effectiveMode === 'full_access_app'}
                disabled={
                  busy ||
                  !controlAvailable ||
                  policyLanguage === 'unknown' ||
                  maximumMode !== 'full_access_app'
                }
                title="フルアクセス"
                description="対象アプリ内の保存・送信・削除を含む通常操作を、操作ごとの確認なしで実行します。"
                onSelect={setMode}
              />
              <ModeCard
                mode="supervised"
                selected={effectiveMode === 'supervised'}
                disabled={busy || !controlAvailable || maximumMode === 'observe_only'}
                title="確認あり"
                description="入力やクリックなどの副作用がある操作を、その都度確認します。"
                onSelect={setMode}
              />
              {controlAvailable && maximumMode !== 'observe_only' ? (
                <details className="computer-use-observe-details">
                  <summary>見るだけを選ぶ</summary>
                  <ModeCard
                    mode="observe_only"
                    selected={effectiveMode === 'observe_only'}
                    disabled={busy}
                    title="見るだけ"
                    description="対象ウィンドウを観測しますが、入力は一切実行しません。"
                    onSelect={setMode}
                  />
                </details>
              ) : (
                <ModeCard
                  mode="observe_only"
                  selected={effectiveMode === 'observe_only'}
                  disabled={busy}
                  title="見るだけ"
                  description="対象ウィンドウを観測しますが、入力は一切実行しません。"
                  onSelect={setMode}
                />
              )}
            </fieldset>

            {!controlAvailable ? (
              <div className="computer-use-capability-note" role="note">
                <ShieldAlert size={18} />
                <p>
                  アクセシビリティ操作の許可がないため、現在は「見るだけ」で開始できます。操作も許可するにはOSのプライバシー設定を変更し、この画面を開き直してください。
                </p>
              </div>
            ) : null}
            {controlAvailable && policyLanguage === 'unknown' ? (
              <div className="computer-use-capability-note" role="note">
                <ShieldAlert size={18} />
                <p>
                  対象アプリと対象ウィンドウのUI言語をnativeで英語または日本語と確認できないため、「確認あり」または「見るだけ」を使用してください。
                </p>
              </div>
            ) : null}
            {controlAvailable && maximumMode !== 'full_access_app' ? (
              <div className="computer-use-capability-note" role="note">
                <ShieldAlert size={18} />
                <p>
                  {maximumMode === 'supervised'
                    ? 'このアプリとウィンドウは「確認あり」まで対応します。フルアクセスは選べません。'
                    : 'このアプリとウィンドウは「見るだけ」に対応します。入力操作は選べません。'}
                </p>
              </div>
            ) : null}

            {effectiveMode === 'full_access_app' ? (
              <div className="computer-use-full-warning" role="note">
                <ShieldAlert size={18} />
                <p>
                  パスワード、決済・契約、インストール、管理者権限、OSのセキュリティ設定、ファイル選択、OSプロンプト、別アプリへの移動は自動実行しません。
                  対象controlや画面patchをnativeで同一と確認できない座標操作も停止し、利用者の操作へ切り替えます。
                </p>
                <p>
                  hard-boundaryの文字判定は英語・日本語のUIだけに対応します。それ以外の表示言語では「確認あり」または「見るだけ」を選んでください。
                </p>
              </div>
            ) : null}
            <p className="computer-use-native-latency-note" role="note">
              1回のnative操作中は停止表示の反応が短く遅れる場合があります。停止後に次の入力は開始しません。
            </p>

            {providers.length === 0 ? (
              <div className="computer-use-provider-empty" role="note">
                <strong>画像対応のProvider / Modelがありません</strong>
                <p>
                  設定のAI
                  ConnectionsでConnectionを有効にし、画像入力に対応するModelを選べる状態にしてから、この画面を開き直してください。
                </p>
              </div>
            ) : (
              <label className="computer-use-field">
                <span>画像と画面情報の送信先</span>
                <select
                  value={providerKey}
                  disabled={busy}
                  onChange={(event) => {
                    setProviderKey(event.target.value);
                    setEgressConfirmed(false);
                  }}
                >
                  {providers.map((provider) => (
                    <option key={providerKeyOf(provider)} value={providerKeyOf(provider)}>
                      {provider.label} — {provider.detail}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selectedProviderUnconfirmed ? (
              <p className="computer-use-native-latency-note" role="note">
                このModelの画像入力対応は未確認です。開始時に固定画像のpreflightを実行してから、実際の画面情報を送信します。
              </p>
            ) : null}
            <p className="computer-use-native-latency-note" role="note">
              利用料金、送信データの保持期間、学習利用の有無は選択したProviderとの契約・設定に従います。開始前にProvider側の条件を確認してください。
            </p>
            <details className="computer-use-observe-details">
              <summary>実行回数の詳細設定</summary>
              <label className="computer-use-field">
                <span>最大実行回数</span>
                <input
                  type="number"
                  min={1}
                  max={25}
                  step={1}
                  value={roundLimit}
                  disabled={busy}
                  aria-invalid={!roundLimitValid}
                  aria-describedby="computer-use-round-limit-help"
                  onChange={(event) => setRoundLimit(event.target.value)}
                />
              </label>
              <p id="computer-use-round-limit-help" className="computer-use-native-latency-note">
                1〜25回。この回数に達したら最後の画面を確認して停止します。今回の開始だけに適用します。
              </p>
              {!roundLimitValid ? (
                <p className="computer-use-error" role="alert">
                  1〜25の整数を入力してください。
                </p>
              ) : null}
            </details>
            <label className="computer-use-check">
              <input
                type="checkbox"
                checked={egressConfirmed}
                disabled={busy || providers.length === 0}
                onChange={(event) => setEgressConfirmed(event.target.checked)}
              />
              <span>
                スクリーンショット本体は伏字されません。secure・高影響項目を伏字処理したアクセシビリティツリーとともに、選択したProviderへ送信します。
              </span>
            </label>
            <label className="computer-use-check">
              <input
                type="checkbox"
                checked={remember}
                disabled={busy}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>
                操作方法とProviderの選択を次回も使う（登録アプリの署名identityは、この設定に関係なく保持されます）
              </span>
            </label>
          </section>
        )}

        {visibleError !== null && visibleError !== undefined ? (
          <p className="computer-use-error" role="alert">
            {visibleError}
          </p>
        ) : null}

        <footer className="computer-use-dialog__actions">
          {step === 2 ? (
            <button type="button" disabled={busy} onClick={() => setStep(1)}>
              戻る
            </button>
          ) : (
            <span />
          )}
          <button
            type="submit"
            className="computer-use-primary"
            data-computer-use-activation={step === 2 ? 'start' : undefined}
            data-computer-use-intent={step === 2 ? startIntent : undefined}
            disabled={
              busy ||
              (step === 1
                ? selectedProfile === null || !selectedProfile.available
                : selectedProvider === undefined ||
                  windowId === '' ||
                  !egressConfirmed ||
                  !roundLimitValid)
            }
          >
            {busy ? '確認中…' : step === 1 ? '次へ' : '開始'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function ModeCard({
  mode,
  selected,
  disabled,
  title,
  description,
  onSelect,
}: {
  mode: ComputerUseModeView;
  selected: boolean;
  disabled: boolean;
  title: string;
  description: string;
  onSelect: (mode: ComputerUseModeView) => void;
}) {
  return (
    <label className={`computer-use-mode${selected ? ' is-selected' : ''}`}>
      <input
        type="radio"
        name="computer-use-mode"
        value={mode}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(mode)}
      />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

export function ComputerUseSessionRail({
  session,
  approval,
  stopping,
  resuming = false,
  resumeActivationIntent,
  error,
  stopButtonRef,
  onStop,
  onResume = () => undefined,
  onApproval,
}: {
  session: ComputerUseSessionView;
  approval: ComputerUseApprovalView | null;
  stopping: boolean;
  resuming?: boolean;
  resumeActivationIntent?: string;
  error?: string | null;
  stopButtonRef?: React.RefObject<HTMLButtonElement | null>;
  onStop: () => void;
  onResume?: () => void;
  onApproval: (decision: 'allow_once' | 'allow_plan' | 'deny') => void;
}) {
  const localStopButtonRef = useRef<HTMLButtonElement>(null);
  const approvalButtonRef = useRef<HTMLButtonElement>(null);
  const previousApprovalIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const activeStopButtonRef = stopButtonRef ?? localStopButtonRef;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const previousApprovalId = previousApprovalIdRef.current;
    if (approval !== null && approval.id !== previousApprovalId) {
      approvalButtonRef.current?.focus({ preventScroll: true });
    } else if (approval === null && (previousApprovalId !== null || !mountedRef.current)) {
      activeStopButtonRef.current?.focus({ preventScroll: true });
    }
    previousApprovalIdRef.current = approval?.id ?? null;
    mountedRef.current = true;
  }, [activeStopButtonRef, approval]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [session.expiresAt]);

  const providerSendState =
    session.state === 'preflight' || session.state === 'planning'
      ? 'Providerへ送信中'
      : 'Provider送信は待機中';

  return (
    <aside className="computer-use-rail" aria-label="Computer Useの実行状態">
      <div className="computer-use-rail__status">
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          Computer Use: {stateLabel(session.state)}
        </span>
        <span className={`computer-use-state is-${session.state}`} aria-hidden="true" />
        <div className="computer-use-rail__identity">
          <strong>{session.appName}</strong>
          <span>{session.windowLabel}</span>
        </div>
        <span className="computer-use-mode-badge">{modeLabel(session.mode)}</span>
        <span className="computer-use-rail__facts">
          {session.providerLabel} · {providerSendState} · {stateLabel(session.state)} ·{' '}
          {session.round}/{session.maxRounds}
        </span>
        <span className="computer-use-rail__facts" aria-live="off">
          観測 {formatObservationTime(session.observedAt)} · 残り{' '}
          {formatRemainingTime(session.expiresAt, now)}
        </span>
        {session.pauseReason === null ? null : (
          <span className="computer-use-rail__pause">{session.pauseReason}</span>
        )}
      </div>
      <div className="computer-use-rail__actions">
        <button
          ref={activeStopButtonRef}
          type="button"
          className="computer-use-stop"
          disabled={stopping}
          onClick={onStop}
        >
          <Square size={14} /> {stopping ? '停止中…' : '停止'}
        </button>
        {session.state === 'paused' &&
        session.resumable !== false &&
        session.round < session.maxRounds ? (
          <button
            type="button"
            className="computer-use-resume"
            data-computer-use-activation="start"
            data-computer-use-intent={resumeActivationIntent}
            disabled={stopping || resuming}
            onClick={onResume}
          >
            {resuming ? '状態を確認中…' : '対象へ戻って再開'}
          </button>
        ) : null}
      </div>
      {approval === null ? null : (
        <section className="computer-use-approval" aria-labelledby="computer-use-approval-title">
          <div>
            <span className="computer-use-eyebrow">ACTION CHECK</span>
            <h3 id="computer-use-approval-title">{approval.actionLabel}</h3>
            <dl>
              <div>
                <dt>対象</dt>
                <dd>{approval.targetLabel}</dd>
              </div>
              <div>
                <dt>影響</dt>
                <dd>{approval.impactLabel}</dd>
              </div>
            </dl>
            {approval.escapedPreview === null ? null : (
              <code className="computer-use-approval__preview">{approval.escapedPreview}</code>
            )}
          </div>
          <div className="computer-use-approval__actions">
            {approval.allowedDecisions.includes('allow_once') ? (
              <button
                ref={approvalButtonRef}
                type="button"
                data-computer-use-activation="approval"
                data-computer-use-intent={approval.activationIntents?.allow_once}
                onClick={() => onApproval('allow_once')}
              >
                今回のみ許可
              </button>
            ) : null}
            {approval.allowedDecisions.includes('allow_plan') ? (
              <button
                type="button"
                data-computer-use-activation="approval"
                data-computer-use-intent={approval.activationIntents?.allow_plan}
                onClick={() => onApproval('allow_plan')}
              >
                この計画で許可
              </button>
            ) : null}
            {approval.allowedDecisions.includes('deny') ? (
              <button
                type="button"
                className="danger"
                data-computer-use-activation="approval"
                data-computer-use-intent={approval.activationIntents?.deny}
                onClick={() => onApproval('deny')}
              >
                拒否
              </button>
            ) : null}
          </div>
        </section>
      )}
      {error === null || error === undefined ? null : (
        <p className="computer-use-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}

function providerKeyOf(provider: ComputerUseProviderView): string {
  return `${provider.connectionId}\u0000${provider.modelId}`;
}

function modeLabel(mode: ComputerUseModeView): string {
  if (mode === 'full_access_app') return 'フルアクセス';
  if (mode === 'supervised') return '確認あり';
  return '見るだけ';
}

function stateLabel(state: ComputerUseSessionView['state']): string {
  return (
    {
      preflight: '互換性を確認中',
      observing: '観測中',
      planning: '次の操作を計画中',
      awaiting_approval: '確認待ち',
      acting: '操作中',
      paused: '一時停止',
    } as const
  )[state];
}

function formatObservationTime(observedAt: string | null): string {
  if (observedAt === null) return 'まだありません';
  return new Date(observedAt).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatRemainingTime(expiresAt: string, now: number): string {
  const totalSeconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback;
}
