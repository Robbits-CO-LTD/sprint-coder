/**
 * #988 N3 PR1: kill-stop result types, generation events and the pure §2.6 state-table kernel.
 * PR5a connects dispatch recording/response only when Host storage is injected (default off).
 * Helper lifetime/exit integration remains deferred. Source of truth:
 * tasks/designs/adr-computer-use-windows-kill-stop-20261102.md §2.2–§2.6, §3.1, §4.1, §6.1.
 *
 * This module is a leaf: it imports nothing at runtime, so later host/client PRs can import it
 * without a cycle.
 */

/** C (§3.1 の 1). Equal to COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS; the test pins the equality. */
export const WINDOWS_STOP_CLOSE_MS = 10_000;
/** T (§2.6, §6.1 の 2). */
export const WINDOWS_STOP_EXIT_MS = 2_000;
const WINDOWS_STOP_CANCEL_ACK_MS = 1_000;
export const WINDOWS_STOP_DEADLINE_MS = {
  E1: WINDOWS_STOP_CANCEL_ACK_MS + WINDOWS_STOP_CLOSE_MS + WINDOWS_STOP_EXIT_MS,
  E2: WINDOWS_STOP_CANCEL_ACK_MS + WINDOWS_STOP_CLOSE_MS + WINDOWS_STOP_EXIT_MS,
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

/** §6.1 の 3: clean / suspect are stopped; requested is native_stop_unconfirmed. */
export function windowsDiscoveryStopResult(result: WindowsStopResult): WindowsDiscoveryStopResult {
  return result === 'termination_requested'
    ? { stopped: false, result, code: 'native_stop_unconfirmed' }
    : { stopped: true, result };
}

/** Main-only identity. No target name, path or prompt belongs in this contract. */
export type WindowsTargetIdentity = Readonly<{ pid: number; creationTime: string }>;
export type WindowsControlInputKind = 'semantic' | 'SendInput' | 'paste';
export type WindowsInputKind = WindowsControlInputKind | 'foreground';
/** K-4: kind and inputPath agree; a foreground handoff is never a control row. */
export type WindowsLedgerPath =
  | Readonly<{ kind: WindowsControlInputKind; inputPath: 'normal' | 'background_semantic' }>
  | Readonly<{ kind: 'foreground'; inputPath: 'foreground' }>;
type LedgerRowBase = Readonly<{
  helperGeneration: number;
  sessionId: string;
  requestId: string;
  identity: WindowsTargetIdentity;
  state: 'awaiting_response' | 'effect_unconfirmed';
}>;
export type WindowsControlLedgerRow = LedgerRowBase &
  Readonly<{ kind: WindowsControlInputKind; inputPath: 'normal' | 'background_semantic' }>;
export type WindowsForegroundLedgerRow = LedgerRowBase &
  Readonly<{ kind: 'foreground'; inputPath: 'foreground' }>;
export type WindowsLedgerRow = WindowsControlLedgerRow | WindowsForegroundLedgerRow;

/**
 * Why a target is quarantined. K-5 (R24) shows response loss, unconfirmed effect and takeover
 * conflict separately; exit and startup restoration have their own values.
 */
export type WindowsTargetQuarantineReason =
  'response_lost' | 'effect_unconfirmed' | 'takeover_conflict' | 'exit_suspect' | 'restored';
export type WindowsTargetQuarantine = Readonly<{
  identity: WindowsTargetIdentity;
  reason: WindowsTargetQuarantineReason;
}>;
/** K-1 causes that Main observes for a live request without a confirming response frame. */
export type WindowsUnconfirmedInputCause =
  | 'transport_timeout'
  | 'failAll'
  | 'abortTransport'
  | 'semantic_owner_uncertain'
  | 'takeover_conflict';

export function windowsK1QuarantineReason(
  cause: WindowsUnconfirmedInputCause,
): WindowsTargetQuarantineReason {
  switch (cause) {
    case 'transport_timeout':
    case 'failAll':
    case 'abortTransport':
      return 'response_lost';
    case 'semantic_owner_uncertain':
      return 'effect_unconfirmed';
    case 'takeover_conflict':
      return 'takeover_conflict';
    default:
      return assertNever(cause);
  }
}

export type WindowsGenerationOwner = Readonly<{
  helperGeneration: number;
  id: string;
  kind: 'session' | 'start' | 'discovery' | 'picker';
}>;
/**
 * Host/client isolation sources that only receipt or helper exit may clear (K-5, §3.1 の 5).
 * A target approval card never clears them.
 */
export type WindowsNativeBlocker = Readonly<{
  helperGeneration: number;
  ownerId: string;
  kind: 'uncertain' | 'closeCandidate' | 'activeStopQuarantines' | 'in_flight';
}>;
type BlockerRelease = Readonly<{ helperGeneration: number; ownerId: string | null }>;

type RowChange =
  | Readonly<{ row: WindowsLedgerRow; action: 'delete' | 'effect_unconfirmed' }>
  | Readonly<{
      row: WindowsLedgerRow;
      action: 'transfer' | 'quarantine';
      reason: WindowsTargetQuarantineReason;
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
  /** Re-write these quarantines if an obsolete release was already persisted. */
  quarantinesToRestore?: readonly WindowsTargetQuarantine[];
  /** A deadline or exception cannot prove that an earlier write left storage unchanged. */
  writeUncertain?: true;
  /**
   * Set on a pending release once newer isolation evidence for `releaseTarget` lands (a K-1
   * quarantine, a K-3 / exit / restore transfer). The release was decided before that evidence, so
   * its retry must not clear it: retry_storage/before_write refuses the release before I/O.
   * If quarantine evidence exists, retain a restoration hold even after a failed/ambiguous write.
   * Kept on the hold rather than as a version column on the
   * quarantine, whose stored row holds only pid, creation time and reason (§2.2 の 5).
   * Before that evidence lands, an isolation hold for the same target (or unknown targets)
   * also supersedes the release on retry. This closes the window where an older release retries
   * before a pending K-1 write, independently of hold order.
   */
  releaseSuperseded?: true;
  /** Native blockers released only after this write lands (§3.1 の 5: transfer first). */
  releaseBlockers?: BlockerRelease;
  /** A held release (R15/R17/R24) returns these requirements only when the write lands. */
  freshSessionRequirements?: readonly WindowsFreshSessionRequirement[];
  recovery:
    'reflect_response' | 'transfer_rows' | 'restore_store' | 'write_quarantine' | 'write_release';
}>;
/** Storage is abstract until N15 Q23 / PR4: only "written" or "failed with a hold id". */
type StorageWrite =
  Readonly<{ status: 'written' }> | Readonly<{ status: 'failed'; holdId: string }>;
export type WindowsStopState = Readonly<{
  helperGeneration: number;
  /**
   * This Main launched a helper for helperGeneration. With exitConfirmed it says whether that
   * helper may still be alive: events of a generation without a live helper are late (R13), and a
   * new generation may start only then (§3.1 の 6). restart clears it: a new Main has no helper.
   */
  helperLaunched: boolean;
  /** The Stop in progress: its entry and owner (session id, or the discovery owner for E4). */
  entry: WindowsStopEntry;
  stopOwnerId: string;
  killRequested: boolean;
  exitConfirmed: boolean;
  exitWaitExceeded: boolean;
  result: WindowsStopResult | null;
  rows: readonly WindowsLedgerRow[];
  quarantines: readonly WindowsTargetQuarantine[];
  holds: readonly WindowsStorageHold[];
  owners: readonly WindowsGenerationOwner[];
  nativeBlockers: readonly WindowsNativeBlocker[];
  /**
   * §2.2 の 5 / R23: a restart whose write failed while it only had foreground rows to discard
   * creates no hold (foreground rows are never a target basis), so nothing retries it in this Main.
   * The rows stay and the next restart discards them again; the discard diagnostic is emitted only
   * when that write lands.
   */
  foregroundDiscardPending: boolean;
}>;

type ResponseOutcome =
  | Readonly<{ status: 'success'; accepted: true }>
  | Readonly<{ status: 'rejected'; accepted: false }>
  | Readonly<{ status: 'effect_unconfirmed'; accepted: true }>;

/**
 * Events carrying helperGeneration belong to that helper generation. Events describe verified
 * Main facts, not untrusted wire objects or a persistence implementation.
 */
export type WindowsGenerationEvent =
  /** Host proves this written request never reached socket.write; not a helper response. */
  | Readonly<{
      kind: 'dispatch_canceled';
      helperGeneration: number;
      sessionId: string;
      requestId: string;
      storage: StorageWrite;
    }>
  | Readonly<{
      kind: 'kill_requested' | 'exit_wait_exceeded' | 'pipe_closed';
      helperGeneration: number;
    }>
  | Readonly<{
      kind: 'exit_confirmed';
      helperGeneration: number;
      storage: StorageWrite;
      cause: 'stop' | 'crash' | 'abortTransport';
    }>
  | Readonly<{
      kind: 'receipt';
      helperGeneration: number;
      status: 'received' | 'verified' | 'invalid' | 'semantic_input_in_flight' | 'deadline';
      closeDeadlineExceeded: boolean;
      storage: StorageWrite;
    }>
  | Readonly<{ kind: 'not_submitted'; helperGeneration: number; otherUnconfirmedOwners: boolean }>
  | (Readonly<{
      kind: 'response';
      helperGeneration: number;
      sessionId: string;
      requestId: string;
      storage: StorageWrite;
    }> &
      ResponseOutcome)
  /** K-1 entry and R6/R23 loss: the request ended without a confirming response frame. */
  | Readonly<{
      kind: 'input_unconfirmed';
      helperGeneration: number;
      sessionId: string;
      requestId: string;
      cause: WindowsUnconfirmedInputCause;
      storage: StorageWrite;
    }>
  /**
   * §2.2 beforeWrite, step 1: the gate (generation, kill, identity, target). It changes no state.
   * Only on `dispatch: 'allow'` does the Host write the ledger row and then send before_dispatch.
   */
  | Readonly<{
      kind: 'dispatch_gate';
      helperGeneration: number;
      identity: WindowsTargetIdentity | null;
    }>
  /**
   * §2.2 beforeWrite, step 2: the result of the ledger write the Host made after dispatch_gate
   * allowed it. A written row is always recorded, so memory never drops a stored row; if the gate
   * no longer passes (a kill, quarantine or hold arrived during the write), the row is kept and the
   * dispatch is still denied (fail-closed).
   */
  | Readonly<{
      kind: 'before_dispatch';
      helperGeneration: number;
      sessionId: string;
      requestId: string;
      input: WindowsLedgerPath;
      identity: WindowsTargetIdentity;
      storage: StorageWrite;
    }>;
export type WindowsStopEvent =
  | WindowsGenerationEvent
  /** A new helper generation in the same Main. Holds, quarantines and untransferred rows carry over. */
  | Readonly<{ kind: 'start_generation'; nextHelperGeneration: number }>
  | Readonly<{ kind: 'restart'; storage: StorageWrite }>
  | Readonly<{
      kind: 'store_unreadable';
      holdId: string;
      targets: readonly WindowsTargetIdentity[] | 'unknown';
    }>
  | Readonly<{
      kind: 'retry_storage';
      holdId: string;
      status: 'before_write' | 'failed' | 'written';
      uncertain?: true;
    }>
  | Readonly<{
      kind: 'restore_read';
      holdId: string;
      rows: readonly WindowsLedgerRow[];
      storage: StorageWrite;
    }>
  /** R20: PR4 parses stored rows; this kernel only records the minimal diagnostic. */
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
    }>;

/** Ordinary domain refusals. Exceptions are reserved for broken invariants (caller bugs). */
export type WindowsStopRefusal =
  | 'invalid_non_submission_proof'
  | 'approval_requires_fresh_session'
  | 'previous_exit_unconfirmed'
  | 'no_control_ledger_row'
  | 'restore_requires_rows'
  /** restore_read is accepted only before this Main launches a helper (startup restoration). */
  | 'restore_requires_restart'
  /** A held release whose target got newer isolation evidence; the quarantine stays. */
  | 'release_superseded'
  | 'identity_missing'
  | 'target_blocked'
  | 'ledger_write_failed'
  | 'helper_stopping'
  | 'stale_generation';

/**
 * Decided parts are typed values; undecided ones say which PR decides them (§2.6 末尾, §6.1 の 8).
 * E4's discovery result is decided (native_stop_unconfirmed for R7); only the destination and
 * reason value of a sessionless E4 notification are PR11's.
 */
export type WindowsStopNotification =
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{ kind: 'session_reason'; reason: 'requested_reason' | 'native_unavailable' }>
  | Readonly<{
      kind: 'discovery_result';
      result: WindowsDiscoveryStopResult;
      sessionlessDestination: 'undecided_pr11';
    }>
  | Readonly<{ kind: 'undecided'; row: 'R8' | 'R11'; decidedBy: 'PR7' }>;

export type WindowsStopDiagnostic = Readonly<{
  kind: string;
  reason: 'invalid_format' | 'missing_identity' | 'foreground_restart_discard';
}>;
export type WindowsFreshSessionRequirement =
  | 'session_id'
  | 'ticket'
  | 'cancel_epoch'
  | 'observation'
  /** Bound only for a background session (K-5). */
  | 'current_interaction_epoch';

/**
 * A flat record on purpose: making it a discriminated union per event is deferred to PR7, once the
 * Host/client callers that consume it are settled. Fields an event does not decide keep the
 * neutral value ('none', 'unchanged', null, false, []).
 */
export type WindowsStopDecision = Readonly<{
  state: WindowsStopState;
  confirmation: 'none' | 'host_receipt' | 'exit' | 'not_submitted';
  helper: 'unchanged' | 'request_kill' | 'retain_child' | 'may_start';
  /**
   * deferred_until_transfer: the exit is confirmed but generation cleanup (releasing isolation
   * sources, idle teardown) must wait for `awaitingHoldId` (R19c). retry_storage then returns
   * generation_after_transfer.
   */
  cleanup: 'none' | 'stop_owner' | 'generation_after_transfer' | 'deferred_until_transfer';
  cleanupGeneration: number | null;
  idleTeardown: 'unchanged' | 'defer' | 'allowed';
  /**
   * The storage hold this decision waits on. While a R19b/R19c transfer is pending, no generation
   * cleanup or idle teardown; while a release write is pending, no fresh session (R15/R17/R24).
   */
  awaitingHoldId: string | null;
  retryAfterMs: 50 | null;
  pause: boolean;
  dispatch: 'unchanged' | 'deny' | 'allow';
  refusal: WindowsStopRefusal | null;
  freshSession: boolean;
  freshSessionRequirements: readonly WindowsFreshSessionRequirement[];
  affectedOwnerIds: readonly string[];
  invalidateGenerationTokens: boolean;
  diagnostics: readonly WindowsStopDiagnostic[];
  /** Settle duration also remains undecided (PR7, §6.1 の 9). */
  notification: WindowsStopNotification;
}>;

function assertNever(value: never): never {
  throw new Error(`Unhandled Windows stop value: ${JSON.stringify(value)}`);
}
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
/**
 * §2.2: a row is keyed by (helper generation, session, request). The wire request id alone is not
 * unique across sessions, so every row lookup uses the whole key. before_dispatch refuses a second
 * row with the same key; finding one here is an invariant violation (fail-closed).
 */
function ledgerRow(
  rows: readonly WindowsLedgerRow[],
  key: Readonly<{ helperGeneration: number; sessionId: string; requestId: string }>,
): WindowsLedgerRow | undefined {
  const matches = rows.filter(
    (row) =>
      row.helperGeneration === key.helperGeneration &&
      row.sessionId === key.sessionId &&
      row.requestId === key.requestId,
  );
  if (matches.length > 1) throw new Error('Duplicate ledger request');
  return matches[0];
}
function validIdentity(identity: WindowsTargetIdentity): boolean {
  return Number.isSafeInteger(identity.pid) && identity.pid > 0 && identity.creationTime.length > 0;
}
function uniqueTargets(targets: readonly WindowsTargetIdentity[]): WindowsTargetIdentity[] {
  return targets.filter((t, i) => targets.findIndex((other) => sameTarget(other, t)) === i);
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
  const evidence: WindowsTargetIdentity[] = [];
  for (const change of changes) {
    switch (change.action) {
      case 'delete':
        rows = rows.filter((row) => !sameRow(row, change.row));
        break;
      case 'effect_unconfirmed':
        rows = rows.map((row) =>
          sameRow(row, change.row) ? { ...row, state: 'effect_unconfirmed' } : row,
        );
        break;
      case 'transfer':
      case 'quarantine':
        evidence.push(change.row.identity);
        // An existing quarantine keeps its first reason (a K-1 reason survives a later exit).
        if (!quarantines.some((q) => sameTarget(q.identity, change.row.identity))) {
          quarantines.push({ identity: change.row.identity, reason: change.reason });
        }
        if (change.action === 'transfer') rows = rows.filter((row) => !sameRow(row, change.row));
        break;
      default:
        assertNever(change);
    }
  }
  // Newer evidence supersedes a release that is still waiting for its write (fail-closed).
  const holds = state.holds.map((hold) => {
    const releaseTarget = hold.releaseTarget;
    return releaseTarget !== undefined && evidence.some((t) => sameTarget(t, releaseTarget))
      ? { ...hold, releaseSuperseded: true as const }
      : hold;
  });
  return { ...state, rows, quarantines, holds };
}

function applyWritten(
  state: WindowsStopState,
  write: Readonly<{
    changes: readonly RowChange[];
    releaseTarget?: WindowsTargetIdentity;
    releaseBlockers?: BlockerRelease;
  }>,
): WindowsStopState {
  const next = applyChanges(state, write.changes);
  const { releaseTarget, releaseBlockers } = write;
  return {
    ...next,
    quarantines:
      releaseTarget === undefined
        ? next.quarantines
        : next.quarantines.filter((q) => !sameTarget(q.identity, releaseTarget)),
    nativeBlockers:
      releaseBlockers === undefined
        ? next.nativeBlockers
        : next.nativeBlockers.filter(
            (b) =>
              b.helperGeneration !== releaseBlockers.helperGeneration ||
              (releaseBlockers.ownerId !== null && b.ownerId !== releaseBlockers.ownerId),
          ),
  };
}

type PersistInput = Readonly<{
  operation: WindowsStorageOperation;
  recovery: WindowsStorageHold['recovery'];
  changes: readonly RowChange[];
  releaseTarget?: WindowsTargetIdentity;
  releaseBlockers?: BlockerRelease;
  freshSessionRequirements?: readonly WindowsFreshSessionRequirement[];
}>;
type PersistOutcome = Readonly<{
  state: WindowsStopState;
  applied: boolean;
  holdId: string | null;
}>;

/**
 * Applies a write that succeeded. A failed write keeps every row and quarantine and holds the
 * affected targets (R19–R19c). Foreground rows are never a target basis (K-4), so a failure that
 * only touches them creates no hold; a write with nothing to change needs no storage at all.
 */
function persist(
  state: WindowsStopState,
  storage: StorageWrite,
  input: PersistInput,
): PersistOutcome {
  if (
    storage.status === 'written' ||
    (input.changes.length === 0 && input.releaseTarget === undefined)
  ) {
    return { state: applyWritten(state, input), applied: true, holdId: null };
  }
  if (state.holds.some((hold) => hold.id === storage.holdId))
    throw new Error('Duplicate storage hold');
  const targets =
    input.releaseTarget === undefined
      ? uniqueTargets(
          input.changes
            .filter((change) => change.row.kind !== 'foreground')
            .map((change) => change.row.identity),
        )
      : [input.releaseTarget];
  if (targets.length === 0) {
    // Only foreground rows were affected: keep them, release blockers, hold nothing.
    return {
      state: applyWritten(state, {
        changes: [],
        ...(input.releaseBlockers === undefined ? {} : { releaseBlockers: input.releaseBlockers }),
      }),
      applied: false,
      holdId: null,
    };
  }
  const hold: WindowsStorageHold = {
    id: storage.holdId,
    operation: input.operation,
    targets,
    changes: input.changes,
    recovery: input.recovery,
    ...(input.releaseTarget === undefined ? {} : { releaseTarget: input.releaseTarget }),
    ...(input.releaseBlockers === undefined ? {} : { releaseBlockers: input.releaseBlockers }),
    ...(input.freshSessionRequirements === undefined
      ? {}
      : { freshSessionRequirements: input.freshSessionRequirements }),
  };
  return { state: { ...state, holds: [...state.holds, hold] }, applied: false, holdId: hold.id };
}

function foregroundDiscards(changes: readonly RowChange[]): WindowsStopDiagnostic[] {
  return changes
    .filter((change) => change.row.kind === 'foreground' && change.action === 'delete')
    .map((change) => ({ kind: change.row.kind, reason: 'foreground_restart_discard' }));
}

function assertStateInvariants(state: WindowsStopState): void {
  if (
    (state.result === 'terminated_clean' || state.result === 'terminated_target_suspect') &&
    !state.exitConfirmed
  ) {
    throw new Error('Termination requires exit evidence');
  }
  for (const row of state.rows) {
    if (storedRowProblem(row) !== null) throw new Error('Invalid live ledger row');
  }
}

const CONTROL_KINDS: readonly unknown[] = ['semantic', 'SendInput', 'paste'];
const CONTROL_PATHS: readonly unknown[] = ['normal', 'background_semantic'];
const ROW_STATES: readonly unknown[] = ['awaiting_response', 'effect_unconfirmed'];

/**
 * Runtime shape check for a ledger row. Restored rows (R20) come from storage, so every field is
 * treated as unknown here; a live row failing it is an invariant violation instead.
 */
function storedRowProblem(row: WindowsLedgerRow): 'invalid_format' | 'missing_identity' | null {
  const loose = row as Readonly<Partial<Record<keyof WindowsLedgerRow, unknown>>>;
  const identity = loose.identity as Readonly<Partial<Record<'pid' | 'creationTime', unknown>>>;
  if (
    typeof identity !== 'object' ||
    identity === null ||
    typeof identity.pid !== 'number' ||
    typeof identity.creationTime !== 'string' ||
    !validIdentity({ pid: identity.pid, creationTime: identity.creationTime })
  ) {
    return 'missing_identity';
  }
  const pathOk =
    loose.kind === 'foreground'
      ? loose.inputPath === 'foreground'
      : CONTROL_KINDS.includes(loose.kind) && CONTROL_PATHS.includes(loose.inputPath);
  const formatOk =
    pathOk &&
    ROW_STATES.includes(loose.state) &&
    typeof loose.helperGeneration === 'number' &&
    Number.isSafeInteger(loose.helperGeneration) &&
    typeof loose.sessionId === 'string' &&
    typeof loose.requestId === 'string';
  return formatOk ? null : 'invalid_format';
}

function entryAllowsNonSubmission(entry: WindowsStopEntry): boolean {
  switch (entry) {
    case 'E3':
    case 'E4':
      return true;
    case 'E1':
    case 'E2':
      return false;
    default:
      return assertNever(entry);
  }
}

function helperMayBeAlive(state: WindowsStopState): boolean {
  return state.helperLaunched && !state.exitConfirmed;
}

/** §2.2 beforeWrite gate shared by dispatch_gate and the write result. */
function dispatchGateRefusal(
  state: WindowsStopState,
  helperGeneration: number,
  identity: WindowsTargetIdentity | null,
): WindowsStopRefusal | null {
  if (helperGeneration < state.helperGeneration || !helperMayBeAlive(state)) {
    return 'stale_generation';
  }
  if (state.killRequested) return 'helper_stopping';
  if (identity === null || !validIdentity(identity)) return 'identity_missing';
  if (!windowsTargetMayStart(state, identity)) return 'target_blocked';
  return null;
}

function isGenerationEvent(event: WindowsStopEvent): event is WindowsGenerationEvent {
  return 'helperGeneration' in event;
}

const FULL_FRESH_SESSION: readonly WindowsFreshSessionRequirement[] = [
  'session_id',
  'ticket',
  'cancel_epoch',
  'observation',
  'current_interaction_epoch',
];

function discoveryNotification(result: WindowsStopResult): WindowsStopNotification {
  return {
    kind: 'discovery_result',
    result: windowsDiscoveryStopResult(result),
    sessionlessDestination: 'undecided_pr11',
  };
}

function exitNotification(
  state: WindowsStopState,
  cause: 'stop' | 'crash' | 'abortTransport',
  result: WindowsTerminationResult,
): WindowsStopNotification {
  if (state.exitWaitExceeded) return { kind: 'undecided', row: 'R8', decidedBy: 'PR7' };
  if (cause !== 'stop') return { kind: 'undecided', row: 'R11', decidedBy: 'PR7' };
  if (state.entry === 'E4') return discoveryNotification(result);
  return { kind: 'session_reason', reason: 'requested_reason' };
}

/** Pure state-table kernel. It neither calls native code nor writes storage. */
export function decideWindowsStop(
  state: WindowsStopState,
  event: WindowsStopEvent,
): WindowsStopDecision {
  assertStateInvariants(state);
  const decision: WindowsStopDecision = {
    state,
    confirmation: 'none',
    helper: 'unchanged',
    cleanup: 'none',
    cleanupGeneration: null,
    idleTeardown: 'unchanged',
    awaitingHoldId: null,
    retryAfterMs: null,
    pause: false,
    dispatch: 'unchanged',
    refusal: null,
    freshSession: false,
    freshSessionRequirements: [],
    affectedOwnerIds: [],
    invalidateGenerationTokens: false,
    diagnostics: [],
    notification: { kind: 'unchanged' },
  };
  const refuse = (
    refusal: WindowsStopRefusal,
    extra: Partial<WindowsStopDecision> = {},
  ): WindowsStopDecision => ({ ...decision, ...extra, refusal });
  /**
   * A target release grants a fresh session only when its write lands. A failed write keeps the
   * quarantine, holds the target and carries the requirements to the retry that releases it.
   */
  const release = (
    identity: WindowsTargetIdentity,
    storage: StorageWrite,
    requirements: readonly WindowsFreshSessionRequirement[],
  ): WindowsStopDecision => {
    const persisted = persist(state, storage, {
      operation: 'release',
      recovery: 'write_release',
      changes: [],
      releaseTarget: identity,
      freshSessionRequirements: requirements,
    });
    return persisted.applied
      ? {
          ...decision,
          state: persisted.state,
          freshSession: true,
          freshSessionRequirements: requirements,
        }
      : { ...decision, state: persisted.state, awaitingHoldId: persisted.holdId };
  };

  if (isGenerationEvent(event)) {
    if (event.helperGeneration > state.helperGeneration)
      throw new Error('Event from an unknown future generation');
    // R13: once the generation has no live helper (its exit is confirmed, a newer generation
    // started after that exit, or Main restarted), a late receipt, response or exit changes no
    // row, classification, quarantine or newer owner. start_generation requires that state, so
    // an older generation's events are always late.
    // The dispatch gate and the write result handle staleness themselves.
    if (
      event.kind !== 'dispatch_gate' &&
      event.kind !== 'before_dispatch' &&
      event.kind !== 'dispatch_canceled' &&
      (event.helperGeneration < state.helperGeneration || !helperMayBeAlive(state))
    ) {
      return decision;
    }
  }
  const generationRows = state.rows.filter(
    (row) => row.helperGeneration === state.helperGeneration,
  );
  switch (event.kind) {
    case 'dispatch_canceled': {
      const row = ledgerRow(state.rows, event);
      if (row === undefined) return decision;
      // Cancel only this unsent row. An exit classification or quarantine is never rolled back.
      return {
        ...decision,
        state: persist(state, event.storage, {
          operation: 'response',
          recovery: 'reflect_response',
          changes: [{ row, action: 'delete' }],
        }).state,
      };
    }
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
        notification:
          state.entry === 'E4'
            ? discoveryNotification('termination_requested')
            : { kind: 'session_reason', reason: 'native_unavailable' },
      };
    case 'not_submitted':
      if (
        !entryAllowsNonSubmission(state.entry) ||
        event.otherUnconfirmedOwners ||
        generationRows.length > 0 ||
        state.killRequested
      ) {
        return refuse('invalid_non_submission_proof');
      }
      return {
        ...decision,
        state: { ...state, result: 'not_submitted' },
        confirmation: 'not_submitted',
        cleanup: 'stop_owner',
        helper: 'may_start',
        // E4 (R0): a stopped discovery; only the sessionless destination is PR11's.
        ...(state.entry === 'E4' ? { notification: discoveryNotification('not_submitted') } : {}),
      };
    case 'receipt': {
      const requestKill: WindowsStopDecision = {
        ...decision,
        state: { ...state, killRequested: true },
        helper: 'request_kill',
      };
      const receiptStatus = event.status;
      switch (receiptStatus) {
        case 'verified':
          break;
        case 'invalid':
        case 'deadline':
          // R3 / §2.2 (c): any other failure terminates immediately.
          return state.killRequested ? { ...decision, helper: 'retain_child' } : requestKill;
        case 'received':
        case 'semantic_input_in_flight':
          if (state.killRequested) return { ...decision, helper: 'retain_child' };
          if (event.closeDeadlineExceeded) return requestKill;
          return {
            ...decision,
            idleTeardown: 'defer',
            retryAfterMs: receiptStatus === 'semantic_input_in_flight' ? 50 : null,
          };
        default:
          return assertNever(receiptStatus);
      }
      const changes: RowChange[] = generationRows
        .filter((row) => row.sessionId === state.stopOwnerId)
        .map((row): RowChange =>
          row.inputPath === 'background_semantic'
            ? {
                row,
                action: 'transfer',
                reason: row.state === 'effect_unconfirmed' ? 'effect_unconfirmed' : 'response_lost',
              }
            : { row, action: 'delete' },
        );
      // R1 releases this owner's blockers; after kill (R1a) only the exit releases them.
      const persisted = persist(state, event.storage, {
        operation: 'receipt_transfer',
        recovery: 'transfer_rows',
        changes,
        ...(state.killRequested
          ? {}
          : {
              releaseBlockers: {
                helperGeneration: state.helperGeneration,
                ownerId: state.stopOwnerId,
              },
            }),
      });
      return {
        ...decision,
        state: { ...persisted.state, result: state.killRequested ? state.result : 'receipt' },
        confirmation: state.killRequested ? 'none' : 'host_receipt',
        helper: state.killRequested ? 'retain_child' : 'unchanged',
        cleanup: state.killRequested ? 'none' : 'stop_owner',
        idleTeardown: persisted.holdId === null ? 'allowed' : 'defer',
        awaitingHoldId: persisted.holdId,
        // E4 (R1): the receipt stops the discovery. After a kill (R1a) the exit reports instead.
        ...(state.entry === 'E4' && !state.killRequested
          ? { notification: discoveryNotification('receipt') }
          : {}),
      };
    }
    case 'exit_confirmed': {
      const result: WindowsTerminationResult = generationRows.some(
        (row) => row.kind !== 'foreground',
      )
        ? 'terminated_target_suspect'
        : 'terminated_clean';
      const changes = generationRows.map((row): RowChange =>
        row.kind === 'foreground'
          ? { row, action: 'delete' }
          : { row, action: 'transfer', reason: 'exit_suspect' },
      );
      // §3.1 の 5: transfer first, then release every blocker of this generation.
      const persisted = persist(state, event.storage, {
        operation: 'exit_transfer',
        recovery: 'transfer_rows',
        changes,
        releaseBlockers: { helperGeneration: state.helperGeneration, ownerId: null },
      });
      return {
        ...decision,
        state: { ...persisted.state, exitConfirmed: true, result },
        confirmation: 'exit',
        helper: 'may_start',
        cleanup:
          persisted.holdId === null ? 'generation_after_transfer' : 'deferred_until_transfer',
        cleanupGeneration: state.helperGeneration,
        awaitingHoldId: persisted.holdId,
        affectedOwnerIds: state.owners
          .filter((owner) => owner.helperGeneration === state.helperGeneration)
          .map((owner) => owner.id),
        invalidateGenerationTokens: true,
        notification: exitNotification(state, event.cause, result),
      };
    }
    case 'response': {
      if (event.accepted !== (event.status !== 'rejected'))
        throw new Error('Response acceptance contradicts its status');
      const row = ledgerRow(state.rows, event);
      if (row === undefined) return refuse('no_control_ledger_row');
      const background = row.inputPath === 'background_semantic';
      const confirmed = event.status !== 'effect_unconfirmed';
      const changes: RowChange[] = confirmed
        ? [{ row, action: 'delete' }]
        : [
            { row, action: 'effect_unconfirmed' },
            ...(background
              ? [{ row, action: 'quarantine' as const, reason: 'effect_unconfirmed' as const }]
              : []),
          ];
      return {
        ...decision,
        state: persist(state, event.storage, {
          operation: 'response',
          recovery: 'reflect_response',
          changes,
        }).state,
        pause: !confirmed && (background || row.kind === 'foreground'),
      };
    }
    case 'input_unconfirmed': {
      const row = ledgerRow(state.rows, event);
      // Discovery cannot supply a control identity (omitted combination).
      if (row === undefined) return refuse('no_control_ledger_row');
      const background = row.inputPath === 'background_semantic';
      // The row itself stays: timeout / failAll / abortTransport never delete it (§2.2, R6).
      const changes: RowChange[] = background
        ? [{ row, action: 'quarantine', reason: windowsK1QuarantineReason(event.cause) }]
        : [];
      return {
        ...decision,
        state: persist(state, event.storage, {
          operation: 'background_quarantine',
          recovery: 'write_quarantine',
          changes,
        }).state,
        pause: background || row.kind === 'foreground',
      };
    }
    case 'dispatch_gate': {
      const refusal = dispatchGateRefusal(state, event.helperGeneration, event.identity);
      return refusal === null
        ? { ...decision, dispatch: 'allow' }
        : refuse(refusal, { dispatch: 'deny' });
    }
    case 'before_dispatch': {
      // The gate refuses identity-less dispatch before any write, so this is a caller bug.
      if (!validIdentity(event.identity)) throw new Error('Ledger write without a target identity');
      if ((event.input.kind === 'foreground') !== (event.input.inputPath === 'foreground'))
        throw new Error('Invalid foreground path');
      if (event.storage.status !== 'written')
        return refuse('ledger_write_failed', { dispatch: 'deny' });
      const added: WindowsLedgerRow = {
        helperGeneration: event.helperGeneration,
        sessionId: event.sessionId,
        requestId: event.requestId,
        identity: event.identity,
        state: 'awaiting_response',
        ...event.input,
      };
      if (state.rows.some((item) => sameRow(item, added)))
        throw new Error('Duplicate ledger request');
      const recorded = { ...state, rows: [...state.rows, added] };
      // The state changed between the gate and the write: keep the stored row, do not send.
      const lateRefusal = dispatchGateRefusal(state, event.helperGeneration, event.identity);
      return lateRefusal === null
        ? { ...decision, state: recorded, dispatch: 'allow' }
        : refuse(lateRefusal, { state: recorded, dispatch: 'deny' });
    }
    case 'start_generation':
      if (event.nextHelperGeneration <= state.helperGeneration)
        throw new Error('Helper generation must increase');
      // §3.1 の 6 / §2.6: no new helper while the old one may be alive in the same Main, with or
      // without a kill (an R11 abortTransport or idle teardown still waits for its exit).
      if (helperMayBeAlive(state)) return refuse('previous_exit_unconfirmed');
      // Holds, quarantines, untransferred rows and pending-transfer blockers carry over; the next
      // Stop supplies its own entry and stopOwnerId.
      return {
        ...decision,
        state: {
          ...state,
          helperGeneration: event.nextHelperGeneration,
          helperLaunched: true,
          killRequested: false,
          exitConfirmed: false,
          exitWaitExceeded: false,
          result: null,
          owners: state.owners.filter(
            (owner) => owner.helperGeneration >= event.nextHelperGeneration,
          ),
        },
        helper: 'may_start',
      };
    case 'restart': {
      const changes = state.rows.map((row): RowChange =>
        row.kind === 'foreground'
          ? { row, action: 'delete' }
          : { row, action: 'transfer', reason: 'restored' },
      );
      const persisted = persist(state, event.storage, {
        operation: 'restore',
        recovery: 'transfer_rows',
        changes,
      });
      return {
        ...decision,
        // A new Main has none of the old Main's in-memory owners or native blockers.
        state: {
          ...persisted.state,
          helperLaunched: false,
          killRequested: false,
          exitConfirmed: false,
          exitWaitExceeded: false,
          result: null,
          owners: [],
          nativeBlockers: [],
          // Only a foreground-only failure has no hold to retry it; the next restart retries.
          foregroundDiscardPending: !persisted.applied && persisted.holdId === null,
        },
        helper: 'may_start',
        // §2.2 の 5: the discard diagnostic follows the discard itself, not a failed write.
        diagnostics: persisted.applied ? foregroundDiscards(changes) : [],
      };
    }
    case 'store_unreadable':
      if (state.holds.some((hold) => hold.id === event.holdId))
        throw new Error('Duplicate storage hold');
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
      if (event.status === 'failed')
        return {
          ...decision,
          state: event.uncertain
            ? {
                ...state,
                holds: state.holds.map((item) =>
                  item.id === hold.id ? { ...item, writeUncertain: true } : item,
                ),
              }
            : state,
          awaitingHoldId: hold.id,
        };
      // A read succeeding alone is not proof that restoration has completed.
      if (hold.recovery === 'restore_store') return refuse('restore_requires_rows');
      // Newer isolation evidence invalidates an older release. No fresh session is granted.
      const releaseTarget = hold.releaseTarget;
      const pendingEvidence =
        releaseTarget !== undefined &&
        state.holds.some(
          (item) =>
            item.operation !== 'release' &&
            (item.changes.some(
              (change) => change.action === 'transfer' || change.action === 'quarantine',
            ) ||
              ['transfer_rows', 'write_quarantine', 'restore_store'].includes(item.recovery)) &&
            (item.targets === 'unknown' ||
              item.targets.some((target) => sameTarget(target, releaseTarget))),
        );
      if (hold.releaseSuperseded === true || pendingEvidence) {
        const remaining = state.holds.filter((item) => item.id !== hold.id);
        const quarantines = state.quarantines.filter(
          (q) => releaseTarget !== undefined && sameTarget(q.identity, releaseTarget),
        );
        // A writer that missed the pre-write gate may already have deleted the stored quarantine.
        // Keep a concrete restoration obligation even after receipt removed the source rows.
        const restoration: WindowsStorageHold[] =
          quarantines.length > 0
            ? [
                {
                  id: hold.id,
                  operation: 'background_quarantine',
                  recovery: 'write_quarantine',
                  targets: quarantines.map((q) => q.identity),
                  changes: [],
                  quarantinesToRestore: quarantines,
                },
              ]
            : [];
        return refuse('release_superseded', {
          state: { ...state, holds: [...remaining, ...restoration] },
          awaitingHoldId: restoration.length > 0 ? hold.id : null,
        });
      }
      if (event.status === 'before_write') return { ...decision, awaitingHoldId: hold.id };
      const next = applyWritten(state, hold);
      const resolved: WindowsStopDecision = {
        ...decision,
        state: { ...next, holds: next.holds.filter((item) => item.id !== hold.id) },
      };
      switch (hold.operation) {
        case 'exit_transfer':
          return {
            ...resolved,
            cleanup: 'generation_after_transfer',
            cleanupGeneration: hold.releaseBlockers?.helperGeneration ?? null,
          };
        case 'receipt_transfer':
          return { ...resolved, idleTeardown: 'allowed' };
        case 'restore':
          return {
            ...resolved,
            state: { ...resolved.state, foregroundDiscardPending: false },
            diagnostics: foregroundDiscards(hold.changes),
          };
        case 'release':
          return hold.freshSessionRequirements === undefined
            ? resolved
            : {
                ...resolved,
                freshSession: true,
                freshSessionRequirements: hold.freshSessionRequirements,
              };
        case 'response':
        case 'background_quarantine':
          return resolved;
        default:
          return assertNever(hold.operation);
      }
    }
    case 'restore_read': {
      const hold = state.holds.find((item) => item.id === event.holdId);
      if (hold?.recovery !== 'restore_store') throw new Error('Unknown restore hold');
      // Startup only: reading the store back after this Main launched a helper would replay
      // restart over live kill state, owners and pending-transfer blockers (R7, R19c).
      if (state.helperLaunched) return refuse('restore_requires_restart');
      // R20: a malformed or identity-less stored row is discarded with a minimal diagnostic; it is
      // ordinary input, never an exception or a permanent host hold.
      const discarded: WindowsStopDiagnostic[] = [];
      const rows = event.rows.filter((item) => {
        const problem = storedRowProblem(item);
        if (problem === null) return true;
        const kind: unknown = (item as Readonly<{ kind?: unknown }>).kind;
        discarded.push({ kind: typeof kind === 'string' ? kind : 'unknown', reason: problem });
        return false;
      });
      const restored = decideWindowsStop(
        { ...state, rows, holds: state.holds.filter((item) => item.id !== hold.id) },
        { kind: 'restart', storage: event.storage },
      );
      return { ...restored, diagnostics: [...discarded, ...restored.diagnostics] };
    }
    case 'invalid_stored_row':
      return { ...decision, diagnostics: [{ kind: event.rowKind, reason: event.reason }] };
    case 'reconcile':
      if (event.evidence === 'alive' || event.evidence === 'unavailable') return decision;
      // R15: a new observation and ticket.
      return release(event.identity, event.storage, ['ticket', 'observation']);
    case 'approve_new_session':
      if (
        !event.trustedActivation ||
        event.previousSessionId === event.newSessionId ||
        (event.previousStop === 'exit' && event.previousGeneration === state.helperGeneration)
      ) {
        return refuse('approval_requires_fresh_session');
      }
      // R17: a new generation's ticket and a new observation. R24 (K-5): every fresh credential.
      return release(
        event.identity,
        event.storage,
        event.previousStop === 'exit'
          ? ['session_id', 'ticket', 'observation']
          : FULL_FRESH_SESSION,
      );
    default:
      return assertNever(event);
  }
}
