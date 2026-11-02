import { COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS } from './computer-use-native-host';

export const WINDOWS_STOP_CLOSE_MS = COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS;
export const WINDOWS_STOP_EXIT_MS = 2_000;
export const WINDOWS_STOP_DEADLINE_MS = {
  E1: 1_000 + WINDOWS_STOP_CLOSE_MS + WINDOWS_STOP_EXIT_MS,
  E2: 1_000 + WINDOWS_STOP_CLOSE_MS + WINDOWS_STOP_EXIT_MS,
  E3: WINDOWS_STOP_CLOSE_MS + WINDOWS_STOP_EXIT_MS,
  E4: WINDOWS_STOP_CLOSE_MS + WINDOWS_STOP_EXIT_MS,
} as const;

export type WindowsStopEntry = keyof typeof WINDOWS_STOP_DEADLINE_MS;
export type WindowsTerminationResult =
  'terminated_clean' | 'terminated_target_suspect' | 'termination_requested';
export type WindowsStopResult = WindowsTerminationResult | 'receipt' | 'not_submitted';
export type WindowsDiscoveryStopResult =
  | Readonly<{ stopped: true; result: Exclude<WindowsStopResult, 'termination_requested'> }>
  | Readonly<{ stopped: false; result: 'termination_requested'; code: 'native_stop_unconfirmed' }>;

export function windowsDiscoveryStopResult(result: WindowsStopResult): WindowsDiscoveryStopResult {
  return result === 'termination_requested'
    ? { stopped: false, result, code: 'native_stop_unconfirmed' }
    : { stopped: true, result };
}

/** Main-only identity. No target name, path or prompt belongs in this contract. */
export type WindowsTargetIdentity = Readonly<{ pid: number; creationTime: string }>;
export type WindowsInputKind = 'semantic' | 'SendInput' | 'paste' | 'foreground';
export type WindowsLedgerRow = Readonly<{
  helperGeneration: number;
  sessionId: string;
  requestId: string;
  kind: WindowsInputKind;
  inputPath: 'normal' | 'background_semantic' | 'foreground';
  identity: WindowsTargetIdentity;
  state: 'awaiting_response' | 'effect_unconfirmed';
}>;
export type WindowsTargetQuarantine = Readonly<{
  identity: WindowsTargetIdentity;
  reason: 'unconfirmed_input' | 'background_uncertain' | 'restored';
}>;
export type WindowsGenerationOwner = Readonly<{
  helperGeneration: number;
  id: string;
  kind: 'session' | 'start' | 'discovery' | 'picker';
}>;
type RowChange = Readonly<{
  row: WindowsLedgerRow;
  action: 'delete' | 'effect_unconfirmed' | 'transfer' | 'quarantine';
  reason?: WindowsTargetQuarantine['reason'];
}>;
export type WindowsStorageOperation =
  | 'restore'
  | 'response'
  | 'receipt_transfer'
  | 'exit_transfer'
  | 'background_quarantine'
  | 'release';
export type WindowsStorageHold = Readonly<{
  id: string;
  operation: WindowsStorageOperation;
  targets: readonly WindowsTargetIdentity[] | 'unknown';
  changes: readonly RowChange[];
  releaseTarget?: WindowsTargetIdentity;
  recovery:
    'reflect_response' | 'transfer_rows' | 'restore_store' | 'write_quarantine' | 'write_release';
}>;
type StorageWrite =
  Readonly<{ status: 'written' }> | Readonly<{ status: 'failed'; holdId: string }>;
export type WindowsStopState = Readonly<{
  helperGeneration: number;
  entry: WindowsStopEntry;
  sessionId: string;
  killRequested: boolean;
  exitConfirmed: boolean;
  exitWaitExceeded: boolean;
  result: WindowsStopResult | null;
  rows: readonly WindowsLedgerRow[];
  quarantines: readonly WindowsTargetQuarantine[];
  holds: readonly WindowsStorageHold[];
  owners: readonly WindowsGenerationOwner[];
  /** These gates need receipt/exit evidence; a target approval cannot clear them. */
  nativeBlockers: readonly (
    'uncertain' | 'closeCandidate' | 'activeStopQuarantines' | 'in_flight'
  )[];
}>;

/** Events describe verified Main facts, not untrusted wire objects or a persistence implementation. */
export type WindowsGenerationEvent = Readonly<{ helperGeneration: number }> &
  (
    | Readonly<{ kind: 'kill_requested' | 'exit_wait_exceeded' | 'pipe_closed' }>
    | Readonly<{
        kind: 'exit_confirmed';
        storage: StorageWrite;
        cause: 'stop' | 'crash' | 'abortTransport';
      }>
    | Readonly<{
        kind: 'receipt';
        status: 'received' | 'verified' | 'invalid' | 'semantic_input_in_flight' | 'deadline';
        closeDeadlineExceeded: boolean;
        storage: StorageWrite;
      }>
    | Readonly<{ kind: 'not_submitted'; otherUnconfirmedOwners: boolean }>
    | Readonly<{
        kind: 'response';
        requestId: string;
        status: 'success' | 'rejected' | 'effect_unconfirmed' | 'missing';
        accepted?: boolean;
        storage: StorageWrite;
      }>
    | Readonly<{ kind: 'background_uncertain'; requestId: string; storage: StorageWrite }>
  );
export type WindowsStopEvent =
  | WindowsGenerationEvent
  | Readonly<{ kind: 'restart'; storage: StorageWrite }>
  | Readonly<{
      kind: 'store_unreadable';
      holdId: string;
      targets: readonly WindowsTargetIdentity[] | 'unknown';
    }>
  | Readonly<{ kind: 'retry_storage'; holdId: string; status: 'failed' | 'written' }>
  | Readonly<{
      kind: 'restore_read';
      holdId: string;
      rows: readonly WindowsLedgerRow[];
      storage: StorageWrite;
    }>
  | Readonly<{
      kind: 'invalid_stored_row';
      rowKind: string;
      reason: 'invalid_format' | 'missing_identity';
    }>
  | Readonly<{
      kind: 'reconcile';
      identity: WindowsTargetIdentity;
      evidence: 'signaled' | 'creation_mismatch' | 'pid_absent' | 'alive' | 'unavailable';
      storage: StorageWrite;
    }>
  | Readonly<{
      kind: 'approve_new_session';
      identity: WindowsTargetIdentity;
      trustedActivation: boolean;
      previousStop: 'exit' | 'receipt';
      previousGeneration: number;
      previousSessionId: string;
      newSessionId: string;
      storage: StorageWrite;
    }>
  | Readonly<{
      kind: 'before_dispatch';
      identity: WindowsTargetIdentity | null;
      storage: StorageWrite;
    }>
  | Readonly<{ kind: 'start_helper' }>;

export type WindowsStopDecision = Readonly<{
  state: WindowsStopState;
  confirmation: 'none' | 'host_receipt' | 'exit' | 'not_submitted';
  helper: 'unchanged' | 'request_kill' | 'retain_child' | 'may_start';
  cleanup: 'none' | 'stop_owner' | 'generation_after_transfer';
  idleTeardown: 'unchanged' | 'defer' | 'allowed';
  retryAfterMs: 50 | null;
  pause: boolean;
  dispatch: 'unchanged' | 'deny' | 'allow';
  freshSession: boolean;
  freshSessionRequirements: readonly (
    'session_id' | 'ticket' | 'cancel_epoch' | 'observation' | 'current_interaction_epoch'
  )[];
  affectedOwnerIds: readonly string[];
  invalidateGenerationTokens: boolean;
  diagnostics: readonly Readonly<{ kind: string; reason: string }>[];
  /** R8/R11: PR7; sessionless E4: PR11. Settle duration also remains undecided. */
  notification: 'unchanged' | 'requested_reason' | 'native_unavailable' | 'undecided';
}>;

function sameTarget(a: WindowsTargetIdentity, b: WindowsTargetIdentity): boolean {
  return a.pid === b.pid && a.creationTime === b.creationTime;
}
function sameRow(a: WindowsLedgerRow, b: WindowsLedgerRow): boolean {
  return (
    a.helperGeneration === b.helperGeneration &&
    a.sessionId === b.sessionId &&
    a.requestId === b.requestId
  );
}
function validIdentity(identity: WindowsTargetIdentity): boolean {
  return Number.isSafeInteger(identity.pid) && identity.pid > 0 && identity.creationTime.length > 0;
}
function controlRows(rows: readonly WindowsLedgerRow[]): readonly WindowsLedgerRow[] {
  return rows.filter((row) => row.kind !== 'foreground');
}

/** The helper gate is separate from target gates; existing quarantines survive a clean exit. */
export function windowsTargetMayStart(
  state: WindowsStopState,
  identity: WindowsTargetIdentity,
): boolean {
  return !(
    (state.killRequested && !state.exitConfirmed) ||
    state.nativeBlockers.length > 0 ||
    state.quarantines.some((q) => sameTarget(q.identity, identity)) ||
    state.holds.some(
      (hold) =>
        hold.targets === 'unknown' || hold.targets.some((target) => sameTarget(target, identity)),
    )
  );
}

function applyChanges(state: WindowsStopState, changes: readonly RowChange[]): WindowsStopState {
  let rows = [...state.rows];
  const quarantines = [...state.quarantines];
  for (const change of changes) {
    if (change.action === 'transfer' || change.action === 'quarantine') {
      if (!quarantines.some((q) => sameTarget(q.identity, change.row.identity))) {
        quarantines.push({
          identity: change.row.identity,
          reason: change.reason ?? 'unconfirmed_input',
        });
      }
    }
    if (change.action === 'delete' || change.action === 'transfer') {
      rows = rows.filter((row) => !sameRow(row, change.row));
    } else if (change.action === 'effect_unconfirmed') {
      rows = rows.map((row) =>
        sameRow(row, change.row) ? { ...row, state: 'effect_unconfirmed' } : row,
      );
    }
  }
  return { ...state, rows, quarantines };
}

function persist(
  state: WindowsStopState,
  storage: StorageWrite,
  operation: WindowsStorageOperation,
  changes: readonly RowChange[],
  recovery: WindowsStorageHold['recovery'],
  releaseTarget?: WindowsTargetIdentity,
): WindowsStopState {
  if (storage.status === 'written') {
    const next = applyChanges(state, changes);
    return releaseTarget === undefined
      ? next
      : {
          ...next,
          quarantines: next.quarantines.filter((q) => !sameTarget(q.identity, releaseTarget)),
        };
  }
  if (state.holds.some((hold) => hold.id === storage.holdId))
    throw new Error('Duplicate storage hold');
  const targets =
    releaseTarget === undefined ? changes.map((change) => change.row.identity) : [releaseTarget];
  return {
    ...state,
    holds: [
      ...state.holds,
      {
        id: storage.holdId,
        operation,
        changes,
        recovery,
        targets: targets.length === 0 ? 'unknown' : targets,
        ...(releaseTarget === undefined ? {} : { releaseTarget }),
      },
    ],
  };
}

/** Pure state-table kernel. It neither calls native code nor writes storage. */
export function decideWindowsStop(
  state: WindowsStopState,
  event: WindowsStopEvent,
): WindowsStopDecision {
  if (
    (state.result === 'terminated_clean' || state.result === 'terminated_target_suspect') &&
    !state.exitConfirmed
  ) {
    throw new Error('Termination requires exit evidence');
  }
  for (const row of state.rows) {
    if (
      !validIdentity(row.identity) ||
      !['awaiting_response', 'effect_unconfirmed'].includes(row.state)
    ) {
      throw new Error('Invalid live ledger row');
    }
    if ((row.kind === 'foreground') !== (row.inputPath === 'foreground'))
      throw new Error('Invalid foreground path');
  }
  const decision: WindowsStopDecision = {
    state,
    confirmation: 'none',
    helper: 'unchanged',
    cleanup: 'none',
    idleTeardown: 'unchanged',
    retryAfterMs: null,
    pause: false,
    dispatch: 'unchanged',
    freshSession: false,
    freshSessionRequirements: [],
    affectedOwnerIds: [],
    invalidateGenerationTokens: false,
    diagnostics: [],
    notification: 'unchanged',
  };
  if ('helperGeneration' in event) {
    if (event.helperGeneration !== state.helperGeneration) throw new Error('Generation mismatch');
    // R13 also applies before a new helper starts. No late response may rewrite the exit snapshot.
    if (state.exitConfirmed) return decision;
  }
  const generationRows = state.rows.filter(
    (row) => row.helperGeneration === state.helperGeneration,
  );
  switch (event.kind) {
    case 'pipe_closed':
      return decision;
    case 'kill_requested':
      return { ...decision, state: { ...state, killRequested: true }, helper: 'request_kill' };
    case 'exit_wait_exceeded':
      if (!state.killRequested) throw new Error('Exit deadline requires a kill request');
      return {
        ...decision,
        state: { ...state, exitWaitExceeded: true, result: 'termination_requested' },
        helper: 'retain_child',
        notification: state.entry === 'E4' ? 'undecided' : 'native_unavailable',
      };
    case 'not_submitted':
      if (
        !['E3', 'E4'].includes(state.entry) ||
        event.otherUnconfirmedOwners ||
        generationRows.length > 0 ||
        state.killRequested
      ) {
        throw new Error('Invalid non-submission proof');
      }
      return {
        ...decision,
        state: { ...state, result: 'not_submitted' },
        confirmation: 'not_submitted',
        cleanup: 'stop_owner',
        helper: 'may_start',
      };
    case 'receipt': {
      if (event.status !== 'verified') {
        if (state.killRequested) return { ...decision, helper: 'retain_child' };
        if (
          event.status === 'invalid' ||
          event.status === 'deadline' ||
          event.closeDeadlineExceeded
        ) {
          return { ...decision, state: { ...state, killRequested: true }, helper: 'request_kill' };
        }
        return {
          ...decision,
          idleTeardown: 'defer',
          retryAfterMs: event.status === 'semantic_input_in_flight' ? 50 : null,
        };
      }
      const changes: RowChange[] = generationRows
        .filter((row) => row.sessionId === state.sessionId)
        .map((row) => ({
          row,
          action: row.inputPath === 'background_semantic' ? 'transfer' : 'delete',
        }));
      const next = persist(state, event.storage, 'receipt_transfer', changes, 'transfer_rows');
      return {
        ...decision,
        state: { ...next, result: state.killRequested ? state.result : 'receipt' },
        confirmation: state.killRequested ? 'none' : 'host_receipt',
        helper: state.killRequested ? 'retain_child' : 'unchanged',
        cleanup: state.killRequested ? 'none' : 'stop_owner',
        idleTeardown: event.storage.status === 'written' ? 'allowed' : 'defer',
      };
    }
    case 'exit_confirmed': {
      const suspect = controlRows(generationRows).length > 0;
      const changes: RowChange[] = generationRows.map((row) => ({
        row,
        action: row.kind === 'foreground' ? 'delete' : 'transfer',
      }));
      const next = persist(state, event.storage, 'exit_transfer', changes, 'transfer_rows');
      return {
        ...decision,
        state: {
          ...next,
          exitConfirmed: true,
          result: suspect ? 'terminated_target_suspect' : 'terminated_clean',
        },
        confirmation: 'exit',
        helper: 'may_start',
        cleanup: 'generation_after_transfer',
        affectedOwnerIds: state.owners
          .filter((owner) => owner.helperGeneration === state.helperGeneration)
          .map((owner) => owner.id),
        invalidateGenerationTokens: true,
        notification:
          state.exitWaitExceeded || event.cause !== 'stop' || state.entry === 'E4'
            ? 'undecided'
            : 'requested_reason',
      };
    }
    case 'response':
    case 'background_uncertain': {
      if (
        event.kind === 'response' &&
        event.status === 'effect_unconfirmed' &&
        event.accepted === false
      ) {
        throw new Error('Rejected input cannot be effect-unconfirmed');
      }
      const row = generationRows.find((item) => item.requestId === event.requestId);
      if (row === undefined)
        throw new Error('No control ledger row; discovery cannot supply an identity');
      const background = row.inputPath === 'background_semantic';
      if (event.kind === 'background_uncertain' && !background)
        throw new Error('Not a background input');
      const status = event.kind === 'response' ? event.status : 'missing';
      const confirmed = status === 'success' || status === 'rejected';
      const changes: RowChange[] = confirmed
        ? [{ row, action: 'delete' }]
        : [
            ...(status === 'effect_unconfirmed'
              ? [{ row, action: 'effect_unconfirmed' as const }]
              : []),
            ...(background
              ? [{ row, action: 'quarantine' as const, reason: 'background_uncertain' as const }]
              : []),
          ];
      return {
        ...decision,
        state: persist(
          state,
          event.storage,
          event.kind === 'response' ? 'response' : 'background_quarantine',
          changes,
          event.kind === 'response' ? 'reflect_response' : 'write_quarantine',
        ),
        pause: !confirmed && (background || row.kind === 'foreground'),
      };
    }
    case 'restart': {
      const changes: RowChange[] = state.rows.map((row) => ({
        row,
        action: row.kind === 'foreground' ? 'delete' : 'transfer',
        reason: 'restored',
      }));
      const next = persist(state, event.storage, 'restore', changes, 'transfer_rows');
      return {
        ...decision,
        state: {
          ...next,
          killRequested: false,
          exitConfirmed: false,
          exitWaitExceeded: false,
          result: null,
        },
        helper: 'may_start',
        diagnostics: state.rows
          .filter((row) => row.kind === 'foreground')
          .map((row) => ({ kind: row.kind, reason: 'foreground_restart_discard' })),
      };
    }
    case 'store_unreadable':
      return {
        ...decision,
        state: {
          ...state,
          holds: [
            ...state.holds,
            {
              id: event.holdId,
              operation: 'restore',
              targets: event.targets,
              changes: [],
              recovery: 'restore_store',
            },
          ],
        },
      };
    case 'retry_storage': {
      const hold = state.holds.find((item) => item.id === event.holdId);
      if (hold === undefined) throw new Error('Unknown storage hold');
      if (event.status === 'failed') return decision;
      // A read succeeding alone is not proof that restoration has completed.
      if (hold.recovery === 'restore_store') throw new Error('Restore requires restored rows');
      const next = persist(
        state,
        { status: 'written' },
        hold.operation,
        hold.changes,
        hold.recovery,
        hold.releaseTarget,
      );
      return {
        ...decision,
        state: { ...next, holds: next.holds.filter((item) => item.id !== hold.id) },
      };
    }
    case 'restore_read': {
      const hold = state.holds.find((item) => item.id === event.holdId);
      if (hold?.recovery !== 'restore_store') throw new Error('Unknown restore hold');
      const restored = decideWindowsStop(
        { ...state, rows: event.rows, holds: state.holds.filter((item) => item.id !== hold.id) },
        { kind: 'restart', storage: event.storage },
      );
      return restored;
    }
    case 'invalid_stored_row':
      return { ...decision, diagnostics: [{ kind: event.rowKind, reason: event.reason }] };
    case 'reconcile':
      if (event.evidence === 'alive' || event.evidence === 'unavailable') return decision;
      return {
        ...decision,
        state: persist(state, event.storage, 'release', [], 'write_release', event.identity),
        freshSession: true,
        freshSessionRequirements: [
          'session_id',
          'ticket',
          'cancel_epoch',
          'observation',
          'current_interaction_epoch',
        ],
      };
    case 'approve_new_session':
      if (
        !event.trustedActivation ||
        event.previousSessionId === event.newSessionId ||
        (event.previousStop === 'exit' && event.previousGeneration === state.helperGeneration)
      ) {
        throw new Error('Approval requires a fresh session and valid generation');
      }
      return {
        ...decision,
        state: persist(state, event.storage, 'release', [], 'write_release', event.identity),
        freshSession: true,
        freshSessionRequirements: [
          'session_id',
          'ticket',
          'cancel_epoch',
          'observation',
          'current_interaction_epoch',
        ],
      };
    case 'before_dispatch':
      return {
        ...decision,
        dispatch:
          event.identity !== null &&
          validIdentity(event.identity) &&
          event.storage.status === 'written' &&
          windowsTargetMayStart(state, event.identity)
            ? 'allow'
            : 'deny',
      };
    case 'start_helper':
      if (state.killRequested && !state.exitConfirmed)
        throw new Error('Previous helper exit is unconfirmed');
      return { ...decision, helper: 'may_start' };
  }
}
