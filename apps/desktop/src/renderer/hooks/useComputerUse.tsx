import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ComputerAppProfile,
  ComputerUseApprovalDecision,
  ComputerUseApi,
  ComputerUseAvailability,
  ComputerUseSessionStatus,
  ComputerUseStartInput,
  ComputerUseWindowCandidate,
} from '@sprint-coder/contracts';
import {
  ComputerUseOnboarding,
  ComputerUseSessionRail,
  ComputerUseUnavailableNotice,
  type ComputerUseApprovalView,
  type ComputerUseProfileView,
  type ComputerUseProviderView,
  type ComputerUseSessionView,
  type ComputerUseStartView,
  type ComputerUseWindowView,
} from '../components/ComputerUsePanel';
import {
  approvalActivationIntent,
  startActivationIntent,
} from '../../computer-use-activation-intent';

export type ComputerUseFeature = Readonly<{
  enabled: boolean;
  active: boolean;
  open: () => void;
  stop: () => void;
  surface: React.ReactNode;
}>;

function focusIfUsable(element: HTMLElement | null): void {
  if (
    element === null ||
    !element.isConnected ||
    element.matches(':disabled') ||
    element.closest('[inert]') !== null
  )
    return;
  element.focus({ preventScroll: true });
}

function scheduleFocus(element: HTMLElement | null): void {
  if (typeof requestAnimationFrame !== 'function') {
    focusIfUsable(element);
    return;
  }
  requestAnimationFrame(() => focusIfUsable(element));
}

export function useComputerUse(taskId: string | null): ComputerUseFeature {
  const [availability, setAvailability] = useState<ComputerUseAvailability | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<readonly ComputerAppProfile[]>([]);
  const [providerOptions, setProviderOptions] = useState<readonly ComputerUseProviderView[]>([]);
  const [session, setSession] = useState<ComputerUseSessionStatus | null>(null);
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [lastStartInput, setLastStartInput] = useState<ComputerUseStartInput | null>(null);
  const [windowCandidates, setWindowCandidates] = useState<
    ReadonlyMap<string, ComputerUseWindowCandidate>
  >(new Map());
  const windowCandidatesRef = useRef<ReadonlyMap<string, ComputerUseWindowCandidate>>(new Map());
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);
  const sessionModeRef = useRef<ComputerUseSessionStatus['mode'] | null>(null);
  const [policyEpoch, setPolicyEpoch] = useState<number | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const stopButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;
    const api = window.sprintCoder?.computerUse;
    if (api === undefined) {
      return () => {
        active = false;
      };
    }
    void api
      .availability()
      .then((availability) => {
        if (active) setAvailability(availability);
      })
      .catch(() => {
        if (active) setAvailability(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const sessionId = session?.sessionId ?? null;
  useEffect(() => {
    if (sessionId === null) return;
    const api = window.sprintCoder?.computerUse;
    if (api === undefined) return;
    const applyStatus = (status: ComputerUseSessionStatus): void => {
      const previousMode = sessionModeRef.current;
      const adjustment =
        previousMode === null ? null : computerUseModeAdjustmentNotice(previousMode, status.mode);
      sessionModeRef.current = status.state === 'stopped' ? null : status.mode;
      setSession(status.state === 'stopped' ? null : status);
      if (status.state === 'stopped') {
        setStopping(false);
        setResuming(false);
        setLastStartInput(null);
        setSessionError(null);
        setTerminalNotice(computerUseTerminalNotice(status));
        if (status.stopReason === 'user_stop') scheduleFocus(openerRef.current);
      } else if (adjustment !== null) setSessionError(adjustment);
    };
    return subscribeComputerUseStatusWithReplay(api, sessionId, applyStatus);
  }, [sessionId]);

  useEffect(() => {
    if (session === null || taskId === session.taskId) return;
    const api = window.sprintCoder?.computerUse;
    const staleSessionId = session.sessionId;
    const stopped =
      api === undefined
        ? Promise.resolve()
        : api.stop({ sessionId: staleSessionId, reason: 'task_changed' }).catch(() => undefined);
    void stopped.finally(() => {
      setSession((current) => (current?.sessionId === staleSessionId ? null : current));
      setDialogOpen(false);
      setDialogError(null);
      setTerminalNotice(null);
      setLastStartInput(null);
    });
  }, [session, taskId]);

  const refreshProfiles = useCallback(async (): Promise<readonly ComputerAppProfile[]> => {
    const api = window.sprintCoder?.computerUse;
    if (api === undefined) return [];
    const result = await api.listProfiles(taskId === null ? {} : { taskId });
    setProfiles(result.profiles);
    return result.profiles;
  }, [taskId]);

  const loadOnboarding = useCallback(async (): Promise<void> => {
    if (taskId === null) return;
    const permissions = window.sprintCoder?.permissions;
    const providersApi = window.sprintCoder?.providers;
    const modelsApi = window.sprintCoder?.models;
    if (permissions === undefined || providersApi === undefined || modelsApi === undefined)
      throw new Error('Computer Useの設定APIを利用できません。');
    const [currentProfiles, policy, connections, catalog] = await Promise.all([
      refreshProfiles(),
      permissions.get(taskId),
      providersApi.listConnections(),
      modelsApi.query({
        taskId,
        text: '',
        connectionIds: [],
        providerIds: [],
        accessTypes: [],
        capabilities: [],
        availableOnly: true,
        cursor: null,
        limit: 100,
      }),
    ]);
    setPolicyEpoch(policy.policyEpoch);
    const compatibleConnections = new Map(
      connections
        .filter(
          (connection) =>
            connection.enabled &&
            (connection.runtimeKind === 'official_api' ||
              connection.runtimeKind === 'openai_compatible'),
        )
        .map((connection) => [connection.id, connection]),
    );
    const catalogOptions = catalog.items.flatMap((model) => {
      const connection = compatibleConnections.get(model.connectionId);
      if (connection === undefined || model.multimodalInput.value === false) return [];
      return [
        {
          connectionId: connection.id,
          modelId: model.modelId,
          label: connection.displayName,
          detail: model.displayName,
          capabilityStatus:
            model.multimodalInput.value === true ? ('confirmed' as const) : ('unknown' as const),
        },
      ];
    });
    // Remembered ids are display metadata, not proof that a currently enabled Connection/Model
    // still satisfies the Computer Use provider gates.
    setProviderOptions(catalogOptions);
    setProfiles(currentProfiles);
  }, [refreshProfiles, taskId]);

  const enabled = availability !== null && computerUseEntryVisible(availability);

  const closeDialog = useCallback(() => {
    if (busy) return;
    setDialogOpen(false);
    setDialogError(null);
    setTerminalNotice(null);
    scheduleFocus(openerRef.current);
  }, [busy]);

  const open = useCallback(() => {
    const api = window.sprintCoder?.computerUse;
    if (api === undefined || taskId === null || !enabled || session !== null) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialogError(null);
    setTerminalNotice(null);
    setBusy(true);
    void api
      .availability()
      .then(async (current) => {
        setAvailability(current);
        if (!computerUseEntryVisible(current)) return;
        setDialogOpen(true);
        if (computerUseCapabilitiesReady(current)) await loadOnboarding();
      })
      .catch((cause) => {
        setDialogError(messageOf(cause, 'Computer Useの設定を読み込めませんでした。'));
        setDialogOpen(true);
      })
      .finally(() => setBusy(false));
  }, [enabled, loadOnboarding, session, taskId]);

  const retryAvailability = useCallback(async (): Promise<void> => {
    const api = window.sprintCoder?.computerUse;
    if (api === undefined) return;
    setBusy(true);
    try {
      const current = await api.availability();
      setAvailability(current);
      setDialogError(null);
      if (!computerUseEntryVisible(current)) {
        setDialogOpen(false);
        return;
      }
      if (computerUseCapabilitiesReady(current)) await loadOnboarding();
    } catch (cause) {
      setDialogError(messageOf(cause, 'Computer Useの状態を確認できませんでした。'));
    } finally {
      setBusy(false);
    }
  }, [loadOnboarding]);

  const register = useCallback(async (): Promise<void> => {
    const api = window.sprintCoder?.computerUse;
    if (api === undefined || taskId === null) return;
    setBusy(true);
    try {
      await api.registerProfile({ taskId });
      await refreshProfiles();
    } finally {
      setBusy(false);
    }
  }, [refreshProfiles, taskId]);

  const resolveWindows = useCallback(
    async (profileId: string): Promise<readonly ComputerUseWindowView[]> => {
      const api = window.sprintCoder?.computerUse;
      if (api === undefined || taskId === null) return [];
      setBusy(true);
      try {
        const result = await api.listWindowCandidates({ taskId, profileId });
        const refreshedProfiles = await refreshProfiles();
        const refreshedProfile = refreshedProfiles.find((profile) => profile.id === profileId);
        if (refreshedProfile === undefined)
          throw new Error('登録済みアプリの更新後identityを確認できません。');
        const candidateMap = new Map(
          result.candidates.map((candidate) => [candidate.windowId, candidate]),
        );
        // Quick Start continues in the same async click before React must commit state. Keep the
        // exact Main-issued token synchronously available to that continuation.
        windowCandidatesRef.current = candidateMap;
        setWindowCandidates(candidateMap);
        return computerUseWindowViews(result.candidates, refreshedProfile.profileRevision);
      } finally {
        setBusy(false);
      }
    },
    [refreshProfiles, taskId],
  );

  const start = useCallback(
    async (input: ComputerUseStartView): Promise<void> => {
      const api = window.sprintCoder?.computerUse;
      if (api === undefined || taskId === null) return;
      const profile = profiles.find((candidate) => candidate.id === input.profileId);
      const windowCandidate = windowCandidatesRef.current.get(input.windowCandidateId);
      if (profile === undefined || windowCandidate === undefined)
        throw new Error('選択したアプリまたはウィンドウが変更されました。');
      const expectedPolicyEpoch = policyEpoch;
      if (expectedPolicyEpoch === null)
        throw new Error('Taskの権限状態を確認できません。Computer Useを開き直してください。');
      setBusy(true);
      try {
        const request: ComputerUseStartInput = {
          taskId,
          profileId: profile.id,
          windowId: windowCandidate.windowId,
          mode: input.mode,
          connectionId: input.connectionId,
          modelId: input.modelId,
          providerEgressConsent: input.egressConfirmed,
          providerEgressConsentBinding: {
            connectionId: input.connectionId,
            modelId: input.modelId,
          },
          remember: input.remember,
          expectedPolicyEpoch,
          expectedWindowRevision: windowCandidate.revision,
          expectedProfileRevision: input.profileRevision,
        };
        const status = await api.start(request);
        setLastStartInput({
          ...request,
          mode: status.mode,
          expectedProfileRevision: status.profileRevision,
          expectedPolicyEpoch: status.policyEpoch,
        });
        sessionModeRef.current = status.mode;
        setSession(status);
        setSessionError(computerUseModeAdjustmentNotice(request.mode, status.mode));
        setDialogOpen(false);
        setDialogError(null);
      } finally {
        setBusy(false);
      }
    },
    [policyEpoch, profiles, taskId],
  );

  const stop = useCallback(() => {
    const api = window.sprintCoder?.computerUse;
    if (api === undefined || session === null || stopping) return;
    setSessionError(null);
    setStopping(true);
    void api.stop({ sessionId: session.sessionId, reason: 'user_stop' }).catch((cause) => {
      setStopping(false);
      setSessionError(messageOf(cause, 'Computer Useを停止できませんでした。'));
    });
  }, [session, stopping]);

  const resume = useCallback(() => {
    const api = window.sprintCoder?.computerUse;
    const prior = lastStartInput;
    if (
      api === undefined ||
      session === null ||
      session.state !== 'paused' ||
      prior === null ||
      resuming ||
      stopping
    )
      return;
    setSessionError(null);
    setResuming(true);
    void api
      .start({ ...prior, mode: session.mode, resumeSessionId: session.sessionId })
      .then((next) => {
        sessionModeRef.current = next.mode;
        setSession(next);
        setSessionError(computerUseModeAdjustmentNotice(session.mode, next.mode));
      })
      .catch((cause) =>
        setSessionError(messageOf(cause, '対象アプリの状態を確認して再開できませんでした。')),
      )
      .finally(() => setResuming(false));
  }, [lastStartInput, resuming, session, stopping]);

  const resolveApproval = useCallback(
    (decision: 'allow_once' | 'allow_plan' | 'deny') => {
      const api = window.sprintCoder?.computerUse;
      const approval = session?.pendingApproval;
      if (api === undefined || approval === null || approval === undefined) return;
      setSessionError(null);
      void api
        .resolveApproval({
          approvalId: approval.id,
          expectedRevision: approval.revision,
          decision,
          challenge: approval.challenge,
        })
        .then((next) => {
          setSession(next);
        })
        .catch((cause) =>
          setSessionError(
            messageOf(cause, '確認結果を反映できませんでした。もう一度お試しください。'),
          ),
        );
    },
    [session],
  );

  const profileViews = useMemo(() => profiles.map(profileView), [profiles]);
  const currentSession = session === null ? null : sessionView(session, profiles, windowCandidates);
  const approval =
    session?.pendingApproval === null || session?.pendingApproval === undefined
      ? null
      : approvalView(session.pendingApproval);
  const resumeActivation =
    session?.state === 'paused' && lastStartInput !== null
      ? startActivationIntent({
          ...lastStartInput,
          mode: session.mode,
          resumeSessionId: session.sessionId,
        })
      : undefined;

  return {
    enabled,
    active: session !== null,
    open,
    stop,
    surface: (
      <>
        {dialogOpen && taskId !== null && availability !== null ? (
          computerUseCapabilitiesReady(availability) ? (
            <ComputerUseOnboarding
              key={taskId}
              taskId={taskId}
              expectedPolicyEpoch={policyEpoch ?? 0}
              profiles={profileViews}
              providers={providerOptions}
              controlAvailable={availability.control}
              busy={busy}
              error={dialogError}
              onClose={closeDialog}
              onRegister={register}
              onResolveWindows={resolveWindows}
              onStart={start}
            />
          ) : (
            <ComputerUseUnavailableNotice
              availability={availability}
              busy={busy}
              error={dialogError}
              onClose={closeDialog}
              onRetry={retryAvailability}
            />
          )
        ) : null}
        {currentSession === null ? null : (
          <ComputerUseSessionRail
            session={currentSession}
            approval={approval}
            stopping={stopping}
            resuming={resuming}
            {...(resumeActivation === undefined
              ? {}
              : { resumeActivationIntent: resumeActivation })}
            error={sessionError}
            stopButtonRef={stopButtonRef}
            onStop={stop}
            onResume={resume}
            onApproval={resolveApproval}
          />
        )}
        {terminalNotice === null ? null : (
          <aside className="computer-use-terminal-notice" role="alert">
            <p>{terminalNotice}</p>
            <div>
              <button type="button" onClick={open}>
                もう一度設定
              </button>
              <button type="button" onClick={() => setTerminalNotice(null)}>
                閉じる
              </button>
            </div>
          </aside>
        )}
      </>
    ),
  };
}

export function computerUseEntryVisible(availability: ComputerUseAvailability): boolean {
  return availability.featureEnabled && availability.packageReady && availability.handshakeReady;
}

export function computerUseCapabilitiesReady(availability: ComputerUseAvailability): boolean {
  return availability.available && availability.observe;
}

export function computerUseModeAdjustmentNotice(
  requested: ComputerUseStartInput['mode'],
  effective: ComputerUseSessionStatus['mode'],
): string | null {
  if (requested === effective) return null;
  return effective === 'observe_only'
    ? '対象の入力許可を確認できなかったため、「見るだけ」で開始しました。'
    : '対象アプリのUI言語を開始時に再確認できなかったため、「確認あり」で開始しました。';
}

export function subscribeComputerUseStatusWithReplay(
  api: Pick<ComputerUseApi, 'getStatus' | 'subscribeStatus'>,
  sessionId: string,
  listener: (status: ComputerUseSessionStatus) => void,
): () => void {
  let active = true;
  let replayComplete = false;
  let latestRevision = -1;
  const buffered: ComputerUseSessionStatus[] = [];
  const deliver = (status: ComputerUseSessionStatus): void => {
    if (!active || status.statusRevision < latestRevision) return;
    latestRevision = status.statusRevision;
    listener(status);
  };
  // Subscribe first so the query closes the only gap: events emitted between start() and the
  // effect mounting are replayed, and events emitted after the query are already observed live.
  const unsubscribe = api.subscribeStatus(sessionId, (status) => {
    if (replayComplete) deliver(status);
    else buffered.push(status);
  });
  void api
    .getStatus({ sessionId })
    .then((status) => {
      if (status !== null) deliver(status);
    })
    .catch(() => undefined)
    .finally(() => {
      replayComplete = true;
      for (const status of buffered.splice(0)) deliver(status);
    });
  return () => {
    active = false;
    buffered.length = 0;
    unsubscribe();
  };
}

export function profileView(profile: ComputerAppProfile): ComputerUseProfileView {
  const identity = profile.identity;
  const authority =
    identity.bundleId ?? identity.packageFamilyName ?? identity.teamId ?? '署名identity';
  return {
    id: profile.id,
    revision: profile.profileRevision,
    displayName: profile.label,
    identityLabel: `${identity.displayName} · ${authority} · ID ${identity.identityDigest}`,
    metadata: `登録確認 ${profile.updatedAt.slice(0, 10)}`,
    available: true,
    unavailableReason: null,
    mode: profile.mode,
    connectionId: profile.connectionId,
    modelId: profile.modelId,
    providerEgressConsent: profile.providerEgressConsent,
    remember: profile.remember,
    policyLanguage: profile.policyLanguage,
    maximumMode: profile.maximumMode,
  };
}

export function computerUseWindowViews(
  candidates: readonly ComputerUseWindowCandidate[],
  profileRevision: number,
): readonly ComputerUseWindowView[] {
  return candidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => ({
      id: candidate.windowId,
      revision: candidate.revision,
      profileRevision,
      label: candidate.title,
      detail: candidate.modal ? '確認ダイアログ' : 'メインウィンドウ',
      policyLanguage: candidate.policyLanguage,
      maximumMode: candidate.maximumMode,
    }));
}

export function computerUseTerminalNotice(status: ComputerUseSessionStatus): string | null {
  return status.state === 'stopped' &&
    (status.stopReason === 'error' || status.stopReason === 'native_unavailable')
    ? 'Computer Useは安全のため停止しました。対象アプリ、OSの許可、Provider設定を確認してから再度開始してください。'
    : null;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback;
}

function sessionView(
  status: ComputerUseSessionStatus,
  profiles: readonly ComputerAppProfile[],
  windows: ReadonlyMap<string, ComputerUseWindowCandidate>,
): ComputerUseSessionView {
  const profile = profiles.find((candidate) => candidate.id === status.profileId);
  const window = windows.get(status.windowId);
  return {
    sessionId: status.sessionId,
    appName: profile?.label ?? '登録済みアプリ',
    windowLabel: window?.title ?? '対象ウィンドウ',
    mode: status.mode,
    providerLabel: `${status.connectionId} · ${status.modelId}`,
    state:
      status.state === 'starting'
        ? 'preflight'
        : status.state === 'stopping' || status.state === 'stopped' || status.state === 'failed'
          ? 'paused'
          : status.state,
    round: status.round,
    maxRounds: status.maxRounds,
    expiresAt: status.expiresAt,
    observedAt: status.lastObservationAt,
    resumable: status.state === 'paused',
    pauseReason:
      status.state === 'paused'
        ? '必要な手動操作を終えたら「対象へ戻って再開」を選んでください'
        : status.state === 'failed'
          ? '利用者の操作を待っています'
          : null,
  };
}

function approvalView(
  approval: NonNullable<ComputerUseSessionStatus['pendingApproval']>,
): ComputerUseApprovalView {
  const activationIntents: Partial<Record<ComputerUseApprovalDecision, string>> = {};
  for (const decision of approval.allowedDecisions)
    activationIntents[decision] = approvalActivationIntent({
      approvalId: approval.id,
      expectedRevision: approval.revision,
      decision,
      challenge: approval.challenge,
    });
  return {
    id: approval.id,
    actionLabel: actionLabel(approval.actionType),
    targetLabel: approval.targetLabel,
    impactLabel: approval.risk === 'high' ? '対象アプリ内を変更します' : '対象を観測します',
    escapedPreview: approval.preview === '' ? null : approval.preview,
    allowedDecisions: approval.allowedDecisions,
    activationIntents,
  };
}

function actionLabel(
  action: NonNullable<ComputerUseSessionStatus['pendingApproval']>['actionType'],
): string {
  return (
    {
      invoke: '操作を実行',
      set_text: '文字を設定',
      select: '項目を選択',
      toggle: '設定を切り替え',
      expand_collapse: '表示を切り替え',
      scroll: 'スクロール',
      click: 'クリック',
      type: '文字を入力',
      key: 'キーを入力',
      wait: '待機',
      finish: '完了',
    } as const
  )[action];
}
