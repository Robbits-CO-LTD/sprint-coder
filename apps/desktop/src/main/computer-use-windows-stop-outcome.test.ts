// ADR §2.6 mapping (R row → tests). Every test name starts with the R rows (or ADR section) it
// checks; "..." stands for the rest of a name. Table cases are the `cases` array below.
// R0: "R0 unsubmitted E3/E4", "R0 non-submission cannot bypass other owners".
// R1: "R1 verified receipt ...", "R1 receipt releases ...", "R1/R4/R7 entry ...".
// R1a: "R1a ...". R2: "R2 ...", "R2/R3 failed receipt ...". R3: "R3 ...", "R2/R3 failed ...".
// R4: "R4 ...", "R4/R9 exit releases ...". R5: "R5 ...", "R5/R18 dispatch ...".
// R6: "R6 ...". R7: "R7 ...". R8: "R8 ...". R9/R10/R12: "R9 ...", "R10 ...", "R12 ...",
// "R9/R10/R12 exit covers ...". R11: "R11 ...", "R11/R13 live generation ...".
// R13: "R13 ...", "R11/R13 ...", "R13/R14 restart ...". R14: "R14 ...", "R14/R19/R23 ...".
// R15: "R15 reconcile ...", "R15/R17/R24 failed release ...". R16: "R16 reconcile ...".
// R17: "R17 ...". R18: "R18 ...", "R18/K-4 ...". R19/R19a–c: "R19 ...", "R19a/b/c ...".
// R20: "R20 ...". R21: "R21 ...". R22: "R22 ...". R23: "R23 ...". R24: "R24 ...".
// Held release superseded by newer isolation: "R15/R24/R21 held release ...", "R17/R21 held
// approval ...", "R24 held approval without newer isolation ...". Startup-only restore: "R19/R7
// restore_read ...". Foreground-only restart failure: "R14/R23 foreground-only ...". Gate then
// write: "R18/K-4 ...", "R18 a row written after the gate ...".
// Omitted combinations: "ADR omitted combinations are rejected".
// Undecided (typed, not chosen here): R8/R11 notification (PR7), sessionless E4 destination and
// reason value (PR11), settle duration (PR7).
import { describe, expect, it } from 'vitest';
import { COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS } from './computer-use-native-host';
import {
  decideWindowsStop,
  windowsDiscoveryStopResult,
  windowsK1QuarantineReason,
  windowsTargetMayStart,
  WINDOWS_STOP_CLOSE_MS,
  WINDOWS_STOP_EXIT_MS,
  WINDOWS_STOP_DEADLINE_MS,
  type WindowsControlLedgerRow,
  type WindowsFreshSessionRequirement,
  type WindowsForegroundLedgerRow,
  type WindowsLedgerRow,
  type WindowsNativeBlocker,
  type WindowsStopDecision,
  type WindowsStopEvent,
  type WindowsStopState,
} from './computer-use-windows-stop-outcome';

const target = { pid: 41, creationTime: 'synthetic-process-a' };
const otherTarget = { pid: 42, creationTime: 'synthetic-process-b' };
const written = { status: 'written' } as const;
const failed = { status: 'failed', holdId: 'write-1' } as const;
const row: WindowsControlLedgerRow = {
  helperGeneration: 1,
  sessionId: 'session-a',
  requestId: 'request-a',
  kind: 'semantic',
  inputPath: 'normal',
  identity: target,
  state: 'awaiting_response',
};
const background: WindowsControlLedgerRow = { ...row, inputPath: 'background_semantic' };
const foreground: WindowsForegroundLedgerRow = {
  ...row,
  kind: 'foreground',
  inputPath: 'foreground',
  state: 'effect_unconfirmed',
};
const quarantine = { identity: target, reason: 'response_lost' } as const;
const blockers = (
  ['uncertain', 'closeCandidate', 'activeStopQuarantines', 'in_flight'] as const
).map((kind): WindowsNativeBlocker => ({ helperGeneration: 1, ownerId: 'session-a', kind }));
function state(overrides: Partial<WindowsStopState> = {}): WindowsStopState {
  return {
    helperGeneration: 1,
    helperLaunched: true,
    entry: 'E1',
    stopOwnerId: 'session-a',
    killRequested: false,
    exitConfirmed: false,
    exitWaitExceeded: false,
    result: null,
    rows: [],
    quarantines: [],
    holds: [],
    owners: [],
    nativeBlockers: [],
    foregroundDiscardPending: false,
    ...overrides,
  };
}
const exit: WindowsStopEvent = {
  kind: 'exit_confirmed',
  helperGeneration: 1,
  cause: 'stop',
  storage: written,
};
const receipt: WindowsStopEvent = {
  kind: 'receipt',
  helperGeneration: 1,
  status: 'verified',
  closeDeadlineExceeded: false,
  storage: written,
};
const response = {
  kind: 'response',
  helperGeneration: 1,
  requestId: row.requestId,
  status: 'success',
  accepted: true,
  storage: written,
} as const satisfies WindowsStopEvent;
const unconfirmedResponse = {
  ...response,
  status: 'effect_unconfirmed',
  accepted: true,
} as const satisfies WindowsStopEvent;
const transportTimeout = {
  kind: 'input_unconfirmed',
  helperGeneration: 1,
  requestId: row.requestId,
  cause: 'transport_timeout',
  storage: written,
} as const satisfies WindowsStopEvent;
const dispatch = {
  kind: 'before_dispatch',
  helperGeneration: 1,
  sessionId: 'session-a',
  requestId: 'request-a',
  input: { kind: 'semantic', inputPath: 'normal' },
  identity: target,
  storage: written,
} as const satisfies WindowsStopEvent;
const gate = {
  kind: 'dispatch_gate',
  helperGeneration: 1,
  identity: target,
} as const satisfies WindowsStopEvent;
const approval = {
  kind: 'approve_new_session',
  identity: target,
  trustedActivation: true,
  previousStop: 'receipt',
  previousGeneration: 1,
  previousSessionId: 'session-a',
  newSessionId: 'session-b',
  storage: written,
} as const satisfies WindowsStopEvent;
const k5Requirements: readonly WindowsFreshSessionRequirement[] = [
  'session_id',
  'ticket',
  'cancel_epoch',
  'observation',
  'current_interaction_epoch',
];

type Case = {
  name: string;
  input: WindowsStopState;
  event: WindowsStopEvent;
  expected: Partial<Omit<WindowsStopDecision, 'state'>> & { state?: Partial<WindowsStopState> };
  mayStart: boolean;
};
const cases: Case[] = [
  {
    name: 'R0 unsubmitted E3',
    input: state({ entry: 'E3' }),
    event: { kind: 'not_submitted', helperGeneration: 1, otherUnconfirmedOwners: false },
    expected: {
      confirmation: 'not_submitted',
      state: { result: 'not_submitted' },
      cleanup: 'stop_owner',
      refusal: null,
    },
    mayStart: true,
  },
  {
    name: 'R0 unsubmitted E4 is a stopped discovery; only the sessionless destination is undecided',
    input: state({ entry: 'E4', stopOwnerId: 'discovery-a' }),
    event: { kind: 'not_submitted', helperGeneration: 1, otherUnconfirmedOwners: false },
    expected: {
      confirmation: 'not_submitted',
      notification: {
        kind: 'discovery_result',
        result: { stopped: true, result: 'not_submitted' },
        sessionlessDestination: 'undecided_pr11',
      },
    },
    mayStart: true,
  },
  {
    name: 'R1 E4 verified receipt is a stopped discovery; only the sessionless destination is undecided',
    input: state({ entry: 'E4', stopOwnerId: 'discovery-a' }),
    event: receipt,
    expected: {
      confirmation: 'host_receipt',
      notification: {
        kind: 'discovery_result',
        result: { stopped: true, result: 'receipt' },
        sessionlessDestination: 'undecided_pr11',
      },
    },
    mayStart: true,
  },
  {
    name: 'R1a E4 receipt after kill leaves the report to the exit',
    input: state({ entry: 'E4', stopOwnerId: 'discovery-a', killRequested: true }),
    event: receipt,
    expected: { confirmation: 'none', notification: { kind: 'unchanged' } },
    mayStart: false,
  },
  {
    name: 'R1 verified receipt deletes the session rows and releases its native blockers',
    input: state({ rows: [row], nativeBlockers: blockers }),
    event: receipt,
    expected: {
      confirmation: 'host_receipt',
      idleTeardown: 'allowed',
      awaitingHoldId: null,
      state: { rows: [], result: 'receipt', nativeBlockers: [] },
    },
    mayStart: true,
  },
  {
    name: 'R1a receipt after kill keeps exit as evidence and keeps native blockers',
    input: state({ rows: [row], killRequested: true, nativeBlockers: blockers }),
    event: receipt,
    expected: {
      confirmation: 'none',
      helper: 'retain_child',
      state: { rows: [], killRequested: true, result: null, nativeBlockers: blockers },
    },
    mayStart: false,
  },
  {
    name: 'R2 unverified receipt retains rows',
    input: state({ rows: [row] }),
    event: { ...receipt, status: 'received' },
    expected: { confirmation: 'none', idleTeardown: 'defer', state: { rows: [row], result: null } },
    mayStart: true,
  },
  {
    name: 'R3 in-flight retry within C',
    input: state({ rows: [row] }),
    event: { ...receipt, status: 'semantic_input_in_flight' },
    expected: { retryAfterMs: 50, state: { rows: [row], killRequested: false } },
    mayStart: true,
  },
  {
    name: 'R3 in-flight at deadline requests kill',
    input: state({ rows: [row] }),
    event: { ...receipt, status: 'semantic_input_in_flight', closeDeadlineExceeded: true },
    expected: { helper: 'request_kill', retryAfterMs: null },
    mayStart: false,
  },
  {
    name: 'R4 clean exit preserves existing quarantine',
    input: state({ quarantines: [quarantine] }),
    event: exit,
    expected: {
      confirmation: 'exit',
      notification: { kind: 'session_reason', reason: 'requested_reason' },
      state: { result: 'terminated_clean', quarantines: [quarantine] },
    },
    mayStart: false,
  },
  {
    name: 'R4 E4 clean exit is a stopped discovery; only the sessionless destination is undecided',
    input: state({ entry: 'E4', stopOwnerId: 'discovery-a' }),
    event: exit,
    expected: {
      notification: {
        kind: 'discovery_result',
        result: { stopped: true, result: 'terminated_clean' },
        sessionlessDestination: 'undecided_pr11',
      },
    },
    mayStart: true,
  },
  {
    name: 'R5 awaiting semantic input',
    input: state({ rows: [row] }),
    event: exit,
    expected: {
      state: {
        result: 'terminated_target_suspect',
        rows: [],
        quarantines: [{ identity: target, reason: 'exit_suspect' }],
      },
    },
    mayStart: false,
  },
  {
    name: 'R5 accepted effect unconfirmed',
    input: state({ rows: [{ ...row, state: 'effect_unconfirmed' }] }),
    event: exit,
    expected: { state: { result: 'terminated_target_suspect' } },
    mayStart: false,
  },
  {
    name: 'R5 awaiting SendInput row is suspect at exit',
    input: state({ rows: [{ ...row, kind: 'SendInput' }] }),
    event: exit,
    expected: { state: { result: 'terminated_target_suspect' } },
    mayStart: false,
  },
  {
    name: 'R5 awaiting paste row is suspect at exit',
    input: state({ rows: [{ ...row, kind: 'paste' }] }),
    event: exit,
    expected: { state: { result: 'terminated_target_suspect' } },
    mayStart: false,
  },
  {
    name: 'R6 transport timeout keeps a normal row without isolating or pausing',
    input: state({ rows: [{ ...row, kind: 'SendInput' }] }),
    event: transportTimeout,
    expected: { pause: false, state: { rows: [{ ...row, kind: 'SendInput' }], quarantines: [] } },
    mayStart: true,
  },
  {
    name: 'R7 T exceeded without exit',
    input: state({ killRequested: true, rows: [row] }),
    event: { kind: 'exit_wait_exceeded', helperGeneration: 1 },
    expected: {
      helper: 'retain_child',
      confirmation: 'none',
      notification: { kind: 'session_reason', reason: 'native_unavailable' },
      state: { rows: [row], result: 'termination_requested' },
    },
    mayStart: false,
  },
  {
    name: 'R7 E4 T exceeded reports native_stop_unconfirmed with an undecided destination',
    input: state({ entry: 'E4', stopOwnerId: 'discovery-a', killRequested: true }),
    event: { kind: 'exit_wait_exceeded', helperGeneration: 1 },
    expected: {
      notification: {
        kind: 'discovery_result',
        result: {
          stopped: false,
          result: 'termination_requested',
          code: 'native_stop_unconfirmed',
        },
        sessionlessDestination: 'undecided_pr11',
      },
    },
    mayStart: false,
  },
  {
    name: 'R8 late exit',
    input: state({
      killRequested: true,
      exitWaitExceeded: true,
      result: 'termination_requested',
      rows: [row],
    }),
    event: exit,
    expected: {
      confirmation: 'exit',
      notification: { kind: 'undecided', row: 'R8', decidedBy: 'PR7' },
      state: { result: 'terminated_target_suspect' },
    },
    mayStart: false,
  },
  {
    name: 'R9 discovery and start owners without control release their blockers',
    input: state({
      owners: [
        { helperGeneration: 1, id: 'discovery', kind: 'discovery' },
        { helperGeneration: 1, id: 'start', kind: 'start' },
      ],
      nativeBlockers: [
        { helperGeneration: 1, ownerId: 'discovery', kind: 'in_flight' },
        { helperGeneration: 1, ownerId: 'start', kind: 'closeCandidate' },
      ],
    }),
    event: exit,
    expected: {
      state: { result: 'terminated_clean', quarantines: [], nativeBlockers: [] },
      cleanup: 'generation_after_transfer',
      affectedOwnerIds: ['discovery', 'start'],
    },
    mayStart: true,
  },
  {
    name: 'R10 discovery and control isolate only the control target',
    input: state({
      rows: [row],
      owners: [{ helperGeneration: 1, id: 'discovery', kind: 'discovery' }],
      nativeBlockers: [{ helperGeneration: 1, ownerId: 'discovery', kind: 'in_flight' }],
    }),
    event: exit,
    expected: {
      state: {
        result: 'terminated_target_suspect',
        quarantines: [{ identity: target, reason: 'exit_suspect' }],
        nativeBlockers: [],
      },
      cleanup: 'generation_after_transfer',
    },
    mayStart: false,
  },
  {
    name: 'R11 crash outside Stop',
    input: state({ rows: [row] }),
    event: { ...exit, cause: 'crash' },
    expected: {
      notification: { kind: 'undecided', row: 'R11', decidedBy: 'PR7' },
      state: { result: 'terminated_target_suspect' },
    },
    mayStart: false,
  },
  {
    name: 'R12 all sessions in shared generation',
    input: state({
      rows: [
        row,
        { ...row, sessionId: 'session-b', requestId: 'request-b', identity: otherTarget },
      ],
    }),
    event: exit,
    expected: {
      cleanup: 'generation_after_transfer',
      state: {
        rows: [],
        quarantines: [
          { identity: target, reason: 'exit_suspect' },
          { identity: otherTarget, reason: 'exit_suspect' },
        ],
      },
    },
    mayStart: false,
  },
  {
    name: 'R13 receipt after exit in the same generation changes nothing',
    input: state({
      exitConfirmed: true,
      result: 'terminated_target_suspect',
      rows: [row],
      quarantines: [quarantine],
    }),
    event: receipt,
    expected: {
      confirmation: 'none',
      state: { rows: [row], result: 'terminated_target_suspect', quarantines: [quarantine] },
    },
    mayStart: false,
  },
  {
    name: 'R14 restart restores target quarantine without exit evidence',
    input: state({
      killRequested: true,
      result: 'termination_requested',
      rows: [row, { ...foreground, requestId: 'foreground' }],
      nativeBlockers: blockers,
    }),
    event: { kind: 'restart', storage: written },
    expected: {
      confirmation: 'none',
      state: {
        result: null,
        exitConfirmed: false,
        rows: [],
        quarantines: [{ identity: target, reason: 'restored' }],
        nativeBlockers: [],
      },
      diagnostics: [{ kind: 'foreground', reason: 'foreground_restart_discard' }],
    },
    mayStart: false,
  },
  ...(['signaled', 'creation_mismatch', 'pid_absent'] as const).map((evidence): Case => ({
    name: `R15 reconcile ${evidence} releases and requires a new observation and ticket`,
    input: state({ quarantines: [quarantine] }),
    event: { kind: 'reconcile', identity: target, evidence, storage: written },
    expected: {
      state: { quarantines: [] },
      freshSession: true,
      freshSessionRequirements: ['ticket', 'observation'],
    },
    mayStart: true,
  })),
  ...(['alive', 'unavailable'] as const).map((evidence): Case => ({
    name: `R16 reconcile ${evidence}`,
    input: state({ quarantines: [quarantine] }),
    event: { kind: 'reconcile', identity: target, evidence, storage: written },
    expected: { state: { quarantines: [quarantine] } },
    mayStart: false,
  })),
  {
    name: 'R17 trusted card after exit in a new generation',
    input: state({ helperGeneration: 2, quarantines: [quarantine] }),
    event: { ...approval, previousStop: 'exit' },
    expected: {
      freshSession: true,
      freshSessionRequirements: ['session_id', 'ticket', 'observation'],
      state: { quarantines: [] },
    },
    mayStart: true,
  },
  {
    name: 'R18 missing identity cannot dispatch',
    input: state(),
    event: { ...gate, identity: null },
    expected: { dispatch: 'deny', refusal: 'identity_missing', state: { rows: [] } },
    mayStart: true,
  },
  {
    name: 'R18 write failure cannot dispatch',
    input: state(),
    event: { ...dispatch, storage: failed },
    expected: { dispatch: 'deny', refusal: 'ledger_write_failed', state: { rows: [] } },
    mayStart: true,
  },
  {
    name: 'R18 recorded dispatch adds an awaiting row before sending',
    input: state(),
    event: dispatch,
    expected: { dispatch: 'allow', state: { rows: [row] } },
    mayStart: true,
  },
  {
    name: 'R19 unreadable store blocks all starts',
    input: state(),
    event: { kind: 'store_unreadable', holdId: 'read-1', targets: 'unknown' },
    expected: { state: { result: null } },
    mayStart: false,
  },
  {
    name: 'R19 known target failure',
    input: state({ rows: [row] }),
    event: { kind: 'restart', storage: failed },
    expected: { state: { rows: [row], quarantines: [] } },
    mayStart: false,
  },
  {
    name: 'R19a response delete failure',
    input: state({ rows: [row] }),
    event: { ...response, storage: failed },
    expected: { state: { rows: [row] } },
    mayStart: false,
  },
  {
    name: 'R19a response rewrite failure',
    input: state({ rows: [row] }),
    event: { ...unconfirmedResponse, storage: failed },
    expected: { state: { rows: [row] } },
    mayStart: false,
  },
  {
    name: 'R19b K-3 transfer failure still confirms receipt and defers idle teardown',
    input: state({ rows: [background] }),
    event: { ...receipt, storage: failed },
    expected: {
      confirmation: 'host_receipt',
      idleTeardown: 'defer',
      awaitingHoldId: failed.holdId,
      state: { result: 'receipt', rows: [background], quarantines: [] },
    },
    mayStart: false,
  },
  {
    name: 'R19c exit transfer failure still confirms exit and defers generation cleanup',
    input: state({ rows: [row] }),
    event: { ...exit, storage: failed },
    expected: {
      confirmation: 'exit',
      cleanup: 'deferred_until_transfer',
      awaitingHoldId: failed.holdId,
      state: { result: 'terminated_target_suspect', rows: [row], quarantines: [] },
    },
    mayStart: false,
  },
  ...(['invalid_format', 'missing_identity'] as const).map((reason): Case => ({
    name: `R20 discarded stored row (${reason}) leaves only a minimal diagnostic`,
    input: state(),
    event: { kind: 'invalid_stored_row', rowKind: 'semantic', reason },
    expected: { diagnostics: [{ kind: 'semantic', reason }], state: { rows: [], holds: [] } },
    mayStart: true,
  })),
  ...(
    [
      ['transport_timeout', 'response_lost'],
      ['failAll', 'response_lost'],
      ['abortTransport', 'response_lost'],
      ['semantic_owner_uncertain', 'effect_unconfirmed'],
      ['takeover_conflict', 'takeover_conflict'],
    ] as const
  ).map(([cause, reason]): Case => ({
    name: `R21 K-1 ${cause} pauses and isolates the live target as ${reason}`,
    input: state({ rows: [background] }),
    event: { ...transportTimeout, cause },
    expected: {
      pause: true,
      state: { result: null, rows: [background], quarantines: [{ identity: target, reason }] },
    },
    mayStart: false,
  })),
  {
    name: 'R21 K-1 accepted effect-unconfirmed response isolates as effect_unconfirmed',
    input: state({ rows: [background] }),
    event: unconfirmedResponse,
    expected: {
      pause: true,
      state: { quarantines: [{ identity: target, reason: 'effect_unconfirmed' }] },
    },
    mayStart: false,
  },
  {
    name: 'R22 K-3 receipt transfers even without R21',
    input: state({ rows: [background] }),
    event: receipt,
    expected: {
      confirmation: 'host_receipt',
      state: {
        result: 'receipt',
        rows: [],
        quarantines: [{ identity: target, reason: 'response_lost' }],
      },
    },
    mayStart: false,
  },
  {
    name: 'R23 foreground uncertainty pauses without isolation',
    input: state({ rows: [{ ...foreground, state: 'awaiting_response' }] }),
    event: unconfirmedResponse,
    expected: { pause: true, state: { rows: [foreground], quarantines: [] } },
    mayStart: true,
  },
  {
    name: 'R23 foreground response loss pauses without isolation',
    input: state({ rows: [foreground] }),
    event: transportTimeout,
    expected: { pause: true, state: { rows: [foreground], quarantines: [] } },
    mayStart: true,
  },
  {
    name: 'R23 foreground exit is clean',
    input: state({ rows: [foreground] }),
    event: exit,
    expected: { state: { rows: [], result: 'terminated_clean', quarantines: [] } },
    mayStart: true,
  },
  {
    name: 'R23 foreground receipt deletes row',
    input: state({ rows: [foreground] }),
    event: receipt,
    expected: { state: { rows: [], result: 'receipt', quarantines: [] } },
    mayStart: true,
  },
  {
    name: 'R24 trusted new session in same generation',
    input: state({ result: 'receipt', quarantines: [quarantine] }),
    event: approval,
    expected: {
      freshSession: true,
      freshSessionRequirements: k5Requirements,
      state: { quarantines: [] },
    },
    mayStart: true,
  },
];

describe('Windows Stop ADR state table (not connected to product paths)', () => {
  it.each(cases)('$name', ({ input, event, expected, mayStart }) => {
    const before = structuredClone(input);
    const result = decideWindowsStop(input, event);
    expect(result).toMatchObject(expected);
    expect(windowsTargetMayStart(result.state, target)).toBe(mayStart);
    expect(input).toEqual(before);
    expect(decideWindowsStop(input, event)).toEqual(result);
  });

  it('AC-3 fixes C, T and Stop-origin E1–E4 budgets; C equals the native close drain', () => {
    expect(WINDOWS_STOP_CLOSE_MS).toBe(10_000);
    expect(WINDOWS_STOP_CLOSE_MS).toBe(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
    expect(WINDOWS_STOP_EXIT_MS).toBe(2_000);
    expect(WINDOWS_STOP_DEADLINE_MS).toEqual({ E1: 13_000, E2: 13_000, E3: 12_000, E4: 12_000 });
  });

  it.each(['E1', 'E2', 'E3', 'E4'] as const)('R1/R4/R7 entry %s', (entry) => {
    expect(decideWindowsStop(state({ entry }), receipt).state.result).toBe('receipt');
    expect(decideWindowsStop(state({ entry }), exit).state.result).toBe('terminated_clean');
    expect(
      decideWindowsStop(state({ entry, killRequested: true }), {
        kind: 'exit_wait_exceeded',
        helperGeneration: 1,
      }).state.result,
    ).toBe('termination_requested');
  });

  it.each(['terminated_clean', 'terminated_target_suspect', 'receipt', 'not_submitted'] as const)(
    'discovery %s is stopped',
    (result) => {
      expect(windowsDiscoveryStopResult(result)).toEqual({ stopped: true, result });
    },
  );
  it('discovery termination_requested is native_stop_unconfirmed', () => {
    expect(windowsDiscoveryStopResult('termination_requested')).toEqual({
      stopped: false,
      result: 'termination_requested',
      code: 'native_stop_unconfirmed',
    });
  });

  it('R4/R9 exit releases every native blocker of the generation so other targets may start', () => {
    const later: WindowsNativeBlocker = {
      helperGeneration: 2,
      ownerId: 'later',
      kind: 'in_flight',
    };
    const input = state({ nativeBlockers: [...blockers, later], helperGeneration: 1 });
    expect(windowsTargetMayStart(input, otherTarget)).toBe(false);
    const next = decideWindowsStop(input, exit).state;
    expect(next.nativeBlockers).toEqual([later]);
    const withoutLater = decideWindowsStop(state({ nativeBlockers: blockers }), exit).state;
    expect(windowsTargetMayStart(withoutLater, target)).toBe(true);
    expect(windowsTargetMayStart(withoutLater, otherTarget)).toBe(true);
  });

  it('R1 receipt releases only the stopped session blockers', () => {
    const other: WindowsNativeBlocker = {
      helperGeneration: 1,
      ownerId: 'session-b',
      kind: 'uncertain',
    };
    const next = decideWindowsStop(state({ nativeBlockers: [...blockers, other] }), receipt).state;
    expect(next.nativeBlockers).toEqual([other]);
  });

  it('R1a/K-3 classifies at exit after receipt transfer; clean cannot clear quarantine', () => {
    const afterReceipt = decideWindowsStop(
      state({ killRequested: true, rows: [background] }),
      receipt,
    ).state;
    const afterExit = decideWindowsStop(afterReceipt, exit).state;
    expect(afterExit.result).toBe('terminated_clean');
    expect(afterExit.quarantines).toEqual(afterReceipt.quarantines);
    expect(windowsTargetMayStart(afterExit, target)).toBe(false);
    expect(windowsTargetMayStart(afterExit, otherTarget)).toBe(true);
    expect(decideWindowsStop(state({ rows: [background] }), exit).state.result).toBe(
      'terminated_target_suspect',
    );
  });

  it('R1a without exit still reaches R7 after verified receipt', () => {
    const next = decideWindowsStop(state({ killRequested: true, rows: [row] }), receipt).state;
    expect(
      decideWindowsStop(next, { kind: 'exit_wait_exceeded', helperGeneration: 1 }).state.result,
    ).toBe('termination_requested');
  });

  it('R5/R18 dispatch → no response → kill → exit is suspect and isolates the target', () => {
    let current = state();
    const allowed = decideWindowsStop(current, dispatch);
    expect(allowed.dispatch).toBe('allow');
    current = allowed.state;
    current = decideWindowsStop(current, { kind: 'kill_requested', helperGeneration: 1 }).state;
    const exited = decideWindowsStop(current, exit);
    expect(exited.state.result).toBe('terminated_target_suspect');
    expect(exited.state.quarantines).toEqual([{ identity: target, reason: 'exit_suspect' }]);
    expect(windowsTargetMayStart(exited.state, target)).toBe(false);
    expect(windowsTargetMayStart(exited.state, otherTarget)).toBe(true);
  });

  it('R6 SendInput and paste rows survive transport timeout and are suspect at exit', () => {
    for (const kind of ['SendInput', 'paste'] as const) {
      const recorded = decideWindowsStop(state(), {
        ...dispatch,
        input: { kind, inputPath: 'normal' },
      }).state;
      const afterTimeout = decideWindowsStop(recorded, transportTimeout).state;
      expect(afterTimeout.rows).toEqual(recorded.rows);
      expect(decideWindowsStop(afterTimeout, exit).state.result).toBe('terminated_target_suspect');
    }
  });

  it('R18/K-4 dispatch records foreground with a matching path; blocked targets record nothing', () => {
    const recorded = decideWindowsStop(state(), {
      ...dispatch,
      input: { kind: 'foreground', inputPath: 'foreground' },
    }).state;
    expect(recorded.rows).toEqual([{ ...foreground, state: 'awaiting_response' }]);
    // The gate decides before any write and changes no state; the Host writes only on allow.
    const open = state();
    const allowed = decideWindowsStop(open, gate);
    expect(allowed).toMatchObject({ dispatch: 'allow', refusal: null });
    expect(allowed.state).toBe(open);
    const blockedState = state({ quarantines: [quarantine] });
    const blocked = decideWindowsStop(blockedState, gate);
    expect(blocked).toMatchObject({ dispatch: 'deny', refusal: 'target_blocked' });
    expect(blocked.state).toBe(blockedState);
    expect(decideWindowsStop(state({ killRequested: true }), gate)).toMatchObject({
      dispatch: 'deny',
      refusal: 'helper_stopping',
    });
    expect(decideWindowsStop(state(), { ...gate, identity: null })).toMatchObject({
      dispatch: 'deny',
      refusal: 'identity_missing',
    });
  });

  it('R18 a row written after the gate allowed is kept even if a kill arrived meanwhile; it is not sent', () => {
    const open = state();
    expect(decideWindowsStop(open, gate).dispatch).toBe('allow');
    // The Host writes the row; a Stop's kill is decided before the write result comes back.
    const killed = decideWindowsStop(open, { kind: 'kill_requested', helperGeneration: 1 }).state;
    const late = decideWindowsStop(killed, dispatch);
    expect(late).toMatchObject({ dispatch: 'deny', refusal: 'helper_stopping' });
    // Memory keeps the stored row (no orphan in the store); the exit classifies fail-closed.
    expect(late.state.rows).toEqual([row]);
    expect(decideWindowsStop(late.state, exit).state.quarantines).toEqual([
      { identity: target, reason: 'exit_suspect' },
    ]);
    const quarantined = decideWindowsStop(state({ quarantines: [quarantine] }), dispatch);
    expect(quarantined).toMatchObject({ dispatch: 'deny', refusal: 'target_blocked' });
    expect(quarantined.state.rows).toEqual([row]);
    // A failed write records nothing, whatever the gate says now.
    expect(decideWindowsStop(killed, { ...dispatch, storage: failed }).state.rows).toEqual([]);
    // An identity-less write cannot pass the gate, so it is a caller bug.
    expect(() =>
      decideWindowsStop(open, {
        ...dispatch,
        // @ts-expect-error the write result always carries the gated identity.
        identity: null,
      }),
    ).toThrow();
  });

  it('R13 late receipt, response and exit of a confirmed older generation are no-ops after a new generation starts', () => {
    const exited = decideWindowsStop(state({ rows: [row], quarantines: [] }), {
      ...exit,
      storage: failed,
    }).state;
    const gen2 = decideWindowsStop(exited, { kind: 'start_generation', nextHelperGeneration: 2 });
    expect(gen2.helper).toBe('may_start');
    // Holds, quarantines and untransferred rows carry over to the new generation.
    expect(gen2.state.holds).toEqual(exited.holds);
    expect(gen2.state.rows).toEqual(exited.rows);
    expect(gen2.state.helperGeneration).toBe(2);
    for (const late of [receipt, response, exit] as const) {
      const result = decideWindowsStop(gen2.state, late);
      expect(result.state).toBe(gen2.state);
      expect(result.confirmation).toBe('none');
      expect(result.refusal).toBeNull();
    }
    expect(decideWindowsStop(gen2.state, gate)).toMatchObject({
      dispatch: 'deny',
      refusal: 'stale_generation',
    });
    expect(() => decideWindowsStop(gen2.state, { ...receipt, helperGeneration: 3 })).toThrow(
      'Event from an unknown future generation',
    );
  });

  it('R13 receipt and response after exit cannot delete a failed transfer or change classification', () => {
    const next = decideWindowsStop(state({ rows: [row] }), { ...exit, storage: failed }).state;
    expect(decideWindowsStop(next, receipt).state).toBe(next);
    expect(decideWindowsStop(next, response).state).toBe(next);
    expect(decideWindowsStop(next, exit).state).toBe(next);
  });

  it('R11/R13 live generation without a kill cannot start a new helper; its exit still classifies and releases', () => {
    // R11: an abortTransport outside Stop waits for the helper exit without a kill request.
    const live = state({
      rows: [row],
      nativeBlockers: [{ helperGeneration: 1, ownerId: 'session-a', kind: 'in_flight' }],
    });
    const refused = decideWindowsStop(live, { kind: 'start_generation', nextHelperGeneration: 2 });
    expect(refused).toMatchObject({ refusal: 'previous_exit_unconfirmed', helper: 'unchanged' });
    expect(refused.state).toBe(live);
    const exited = decideWindowsStop(live, { ...exit, cause: 'abortTransport' });
    expect(exited.state).toMatchObject({
      result: 'terminated_target_suspect',
      rows: [],
      nativeBlockers: [],
      quarantines: [{ identity: target, reason: 'exit_suspect' }],
    });
    expect(windowsTargetMayStart(exited.state, otherTarget)).toBe(true);
    expect(
      decideWindowsStop(exited.state, { kind: 'start_generation', nextHelperGeneration: 2 }).helper,
    ).toBe('may_start');
  });

  it('R13/R14 restart leaves no live helper: old-generation events are no-ops until a new generation starts', () => {
    const restarted = decideWindowsStop(state({ rows: [row] }), {
      kind: 'restart',
      storage: written,
    }).state;
    expect(restarted.helperLaunched).toBe(false);
    for (const late of [receipt, response, exit] as const) {
      expect(decideWindowsStop(restarted, late).state).toBe(restarted);
    }
    expect(decideWindowsStop(restarted, gate)).toMatchObject({ refusal: 'stale_generation' });
    const gen2 = decideWindowsStop(restarted, {
      kind: 'start_generation',
      nextHelperGeneration: 2,
    });
    expect(gen2).toMatchObject({ helper: 'may_start', refusal: null });
    expect(gen2.state).toMatchObject({ helperGeneration: 2, helperLaunched: true });
  });

  it.each([
    {
      name: 'R15 reconcile',
      event: { kind: 'reconcile', identity: target, evidence: 'pid_absent', storage: failed },
      requirements: ['ticket', 'observation'],
    },
    {
      name: 'R17 approval after exit',
      event: { ...approval, previousStop: 'exit', previousGeneration: 0, storage: failed },
      requirements: ['session_id', 'ticket', 'observation'],
    },
    {
      name: 'R24 approval after receipt',
      event: { ...approval, storage: failed },
      requirements: k5Requirements,
    },
  ] satisfies {
    name: string;
    event: WindowsStopEvent;
    requirements: readonly WindowsFreshSessionRequirement[];
  }[])(
    'R15/R17/R24 failed release ($name) grants no fresh session until the retry lands',
    ({ event, requirements }) => {
      const held = decideWindowsStop(state({ quarantines: [quarantine] }), event);
      expect(held).toMatchObject({
        freshSession: false,
        freshSessionRequirements: [],
        awaitingHoldId: failed.holdId,
      });
      expect(held.state.quarantines).toEqual([quarantine]);
      expect(windowsTargetMayStart(held.state, target)).toBe(false);
      const retryFailed = decideWindowsStop(held.state, {
        kind: 'retry_storage',
        holdId: failed.holdId,
        status: 'failed',
      });
      expect(retryFailed).toMatchObject({ freshSession: false, freshSessionRequirements: [] });
      const released = decideWindowsStop(held.state, {
        kind: 'retry_storage',
        holdId: failed.holdId,
        status: 'written',
      });
      expect(released).toMatchObject({
        freshSession: true,
        freshSessionRequirements: requirements,
      });
      expect(released.state.quarantines).toEqual([]);
      expect(released.state.holds).toEqual([]);
      expect(windowsTargetMayStart(released.state, target)).toBe(true);
    },
  );

  it('R20 restore discards malformed or identity-less stored rows with a diagnostic, not an exception', () => {
    const held = decideWindowsStop(state({ helperLaunched: false }), {
      kind: 'store_unreadable',
      holdId: 'read-1',
      targets: 'unknown',
    }).state;
    const noIdentity = { ...row, requestId: 'no-id', identity: { pid: 0, creationTime: '' } };
    const { identity: _omitted, ...absentIdentity } = { ...row, requestId: 'absent' };
    const badState = { ...row, requestId: 'bad-state', state: 'done' };
    const badPath = { ...row, requestId: 'bad-path', kind: 'foreground' };
    const restored = decideWindowsStop(held, {
      kind: 'restore_read',
      holdId: 'read-1',
      rows: [row, noIdentity, absentIdentity, badState, badPath] as unknown as WindowsLedgerRow[],
      storage: written,
    });
    expect(restored.diagnostics).toEqual([
      { kind: 'semantic', reason: 'missing_identity' },
      { kind: 'semantic', reason: 'missing_identity' },
      { kind: 'semantic', reason: 'invalid_format' },
      { kind: 'foreground', reason: 'invalid_format' },
    ]);
    expect(restored.state.holds).toEqual([]);
    expect(restored.state.rows).toEqual([]);
    expect(restored.state.quarantines).toEqual([{ identity: target, reason: 'restored' }]);
    expect(windowsTargetMayStart(restored.state, otherTarget)).toBe(true);
  });

  it.each([
    {
      name: 'R19a delete',
      event: { ...response, storage: failed },
      inputRow: row,
      recovery: 'reflect_response',
      remaining: [],
    },
    {
      name: 'R19a rewrite',
      event: { ...unconfirmedResponse, storage: failed },
      inputRow: row,
      recovery: 'reflect_response',
      remaining: [{ ...row, state: 'effect_unconfirmed' }],
    },
    {
      name: 'R19b transfer',
      event: { ...receipt, storage: failed },
      inputRow: background,
      recovery: 'transfer_rows',
      remaining: [],
    },
    {
      name: 'R19c transfer',
      event: { ...exit, storage: failed },
      inputRow: row,
      recovery: 'transfer_rows',
      remaining: [],
    },
  ] satisfies {
    name: string;
    event: WindowsStopEvent;
    inputRow: WindowsLedgerRow;
    recovery: string;
    remaining: WindowsLedgerRow[];
  }[])(
    '$name clears hold only after the required write',
    ({ event, inputRow, recovery, remaining }) => {
      const held = decideWindowsStop(state({ rows: [inputRow] }), event).state;
      expect(held.holds[0]?.recovery).toBe(recovery);
      expect(windowsTargetMayStart({ ...held, helperGeneration: 2 }, target)).toBe(false);
      expect(windowsTargetMayStart(held, otherTarget)).toBe(true);
      const retryFailed = decideWindowsStop(held, {
        kind: 'retry_storage',
        holdId: failed.holdId,
        status: 'failed',
      });
      expect(retryFailed.state).toBe(held);
      expect(retryFailed.awaitingHoldId).toBe(failed.holdId);
      const recovered = decideWindowsStop(held, {
        kind: 'retry_storage',
        holdId: failed.holdId,
        status: 'written',
      }).state;
      expect(recovered.holds).toEqual([]);
      expect(recovered.rows).toEqual(remaining);
      expect(windowsTargetMayStart(recovered, target)).toBe(recovery === 'reflect_response');
    },
  );

  it('R19b retry success releases the session blockers and allows the deferred idle teardown', () => {
    const held = decideWindowsStop(state({ rows: [background], nativeBlockers: blockers }), {
      ...receipt,
      storage: failed,
    });
    expect(held.state.nativeBlockers).toEqual(blockers);
    expect(held).toMatchObject({ idleTeardown: 'defer', awaitingHoldId: failed.holdId });
    const recovered = decideWindowsStop(held.state, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'written',
    });
    expect(recovered).toMatchObject({ idleTeardown: 'allowed', awaitingHoldId: null });
    expect(recovered.state.nativeBlockers).toEqual([]);
    expect(recovered.state.quarantines).toEqual([{ identity: target, reason: 'response_lost' }]);
  });

  it('R19c keeps generation blockers until the transfer lands, then signals generation cleanup', () => {
    const held = decideWindowsStop(state({ rows: [row], nativeBlockers: blockers }), {
      ...exit,
      storage: failed,
    });
    expect(held).toMatchObject({
      cleanup: 'deferred_until_transfer',
      cleanupGeneration: 1,
      awaitingHoldId: failed.holdId,
    });
    expect(held.state.nativeBlockers).toEqual(blockers);
    expect(windowsTargetMayStart(held.state, otherTarget)).toBe(false);
    const gen2 = decideWindowsStop(held.state, {
      kind: 'start_generation',
      nextHelperGeneration: 2,
    }).state;
    expect(gen2.nativeBlockers).toEqual(blockers);
    const recovered = decideWindowsStop(gen2, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'written',
    });
    expect(recovered).toMatchObject({
      cleanup: 'generation_after_transfer',
      cleanupGeneration: 1,
      awaitingHoldId: null,
    });
    expect(recovered.state.nativeBlockers).toEqual([]);
    expect(recovered.state.quarantines).toEqual([{ identity: target, reason: 'exit_suspect' }]);
    expect(windowsTargetMayStart(recovered.state, otherTarget)).toBe(true);
  });

  it('R19/R23 storage failures that change nothing or only foreground rows create no hold', () => {
    // A normal row's transport timeout writes nothing, so a failed write cannot hold anything.
    const nothing = decideWindowsStop(state({ rows: [row] }), {
      ...transportTimeout,
      storage: failed,
    }).state;
    expect(nothing.holds).toEqual([]);
    const fg = decideWindowsStop(state({ rows: [foreground] }), {
      ...response,
      storage: failed,
    }).state;
    expect(fg.holds).toEqual([]);
    expect(fg.rows).toEqual([foreground]);
    expect(windowsTargetMayStart(fg, target)).toBe(true);
    const fgExit = decideWindowsStop(state({ rows: [foreground], nativeBlockers: blockers }), {
      ...exit,
      storage: failed,
    });
    expect(fgExit.state.holds).toEqual([]);
    expect(fgExit.cleanup).toBe('generation_after_transfer');
    expect(windowsTargetMayStart(fgExit.state, target)).toBe(true);
  });

  it('R14/R19/R23 restart failure defers the foreground discard diagnostic to the successful retry', () => {
    const restarted = decideWindowsStop(
      state({ rows: [row, { ...foreground, requestId: 'fg' }] }),
      {
        kind: 'restart',
        storage: failed,
      },
    );
    expect(restarted.diagnostics).toEqual([]);
    expect(restarted.state.holds[0]?.targets).toEqual([target]);
    const recovered = decideWindowsStop(restarted.state, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'written',
    });
    expect(recovered.diagnostics).toEqual([
      { kind: 'foreground', reason: 'foreground_restart_discard' },
    ]);
    expect(recovered.state.rows).toEqual([]);
    expect(recovered.state.quarantines).toEqual([{ identity: target, reason: 'restored' }]);
  });

  it.each(['success', 'rejected'] as const)(
    'R23 verified foreground %s deletes the row',
    (status) => {
      expect(
        decideWindowsStop(
          state({ rows: [foreground] }),
          status === 'success' ? response : { ...response, status, accepted: false },
        ).state.rows,
      ).toEqual([]);
    },
  );

  it('R24 card does not clear generation kill or storage holds', () => {
    const held = decideWindowsStop(state({ rows: [background], quarantines: [quarantine] }), {
      ...receipt,
      storage: failed,
    }).state;
    const approved = decideWindowsStop({ ...held, killRequested: true }, approval).state;
    expect(approved.holds).toEqual(held.holds);
    expect(approved.rows).toEqual(held.rows);
    expect(windowsTargetMayStart(approved, target)).toBe(false);
  });

  it('R9/R10/R12 exit covers discovery, picker and start owners without inventing identities', () => {
    const owners = [
      { helperGeneration: 1, id: 'session-a', kind: 'session' },
      { helperGeneration: 1, id: 'session-b', kind: 'session' },
      { helperGeneration: 1, id: 'discovery', kind: 'discovery' },
      { helperGeneration: 1, id: 'picker', kind: 'picker' },
      { helperGeneration: 1, id: 'start', kind: 'start' },
      { helperGeneration: 2, id: 'later', kind: 'session' },
    ] satisfies WindowsStopState['owners'];
    for (const rows of [[], [row]]) {
      const result = decideWindowsStop(state({ owners, rows }), exit);
      expect(result.affectedOwnerIds).toEqual([
        'session-a',
        'session-b',
        'discovery',
        'picker',
        'start',
      ]);
      expect(result.invalidateGenerationTokens).toBe(true);
      expect(result.state.quarantines).toHaveLength(rows.length);
    }
  });

  it.each(blockers)('R24 approval preserves $kind and requires fresh credentials', (blocker) => {
    const result = decideWindowsStop(
      state({ nativeBlockers: [blocker], quarantines: [quarantine] }),
      approval,
    );
    expect(result.state.nativeBlockers).toEqual([blocker]);
    expect(result.state.quarantines).toEqual([]);
    expect(windowsTargetMayStart(result.state, target)).toBe(false);
    expect(result.freshSessionRequirements).toEqual(k5Requirements);
  });

  it('R19 read recovery requires restoring the rows before removing the global hold', () => {
    const held = decideWindowsStop(state({ helperLaunched: false }), {
      kind: 'store_unreadable',
      holdId: 'read-1',
      targets: 'unknown',
    }).state;
    expect(windowsTargetMayStart(held, otherTarget)).toBe(false);
    const readOnly = decideWindowsStop(held, {
      kind: 'retry_storage',
      holdId: 'read-1',
      status: 'written',
    });
    expect(readOnly).toMatchObject({ refusal: 'restore_requires_rows' });
    expect(readOnly.state).toBe(held);
    const restored = decideWindowsStop(held, {
      kind: 'restore_read',
      holdId: 'read-1',
      rows: [row],
      storage: written,
    }).state;
    expect(restored.holds).toEqual([]);
    expect(restored.rows).toEqual([]);
    expect(windowsTargetMayStart(restored, target)).toBe(false);
    expect(windowsTargetMayStart(restored, otherTarget)).toBe(true);
  });

  it.each(['invalid', 'deadline'] as const)(
    'R2/R3 failed receipt (%s) requests kill without waiting for C (§2.2 (c))',
    (status) => {
      expect(decideWindowsStop(state(), { ...receipt, status }).helper).toBe('request_kill');
    },
  );

  it('receipt affects only its session and exit affects only its generation', () => {
    const second = { ...row, sessionId: 'session-b', requestId: 'request-b' };
    const later = { ...row, helperGeneration: 2 };
    const next = decideWindowsStop(state({ rows: [row, second, later] }), receipt).state;
    expect(next.rows).toEqual([second, later]);
    expect(decideWindowsStop(next, exit).state.rows).toEqual([later]);
  });

  it('K-1 cause vocabulary maps to the quarantine reasons the K-5 card distinguishes', () => {
    expect(windowsK1QuarantineReason('transport_timeout')).toBe('response_lost');
    expect(windowsK1QuarantineReason('failAll')).toBe('response_lost');
    expect(windowsK1QuarantineReason('abortTransport')).toBe('response_lost');
    expect(windowsK1QuarantineReason('semantic_owner_uncertain')).toBe('effect_unconfirmed');
    expect(windowsK1QuarantineReason('takeover_conflict')).toBe('takeover_conflict');
  });

  it('K-1 reason survives a later exit transfer of the same target', () => {
    const isolated = decideWindowsStop(state({ rows: [background] }), {
      ...transportTimeout,
      cause: 'takeover_conflict',
    }).state;
    expect(decideWindowsStop(isolated, exit).state.quarantines).toEqual([
      { identity: target, reason: 'takeover_conflict' },
    ]);
  });

  it.each([
    {
      name: 'R24 approval',
      release: { ...approval, storage: failed },
    },
    {
      name: 'R15 reconcile',
      release: { kind: 'reconcile', identity: target, evidence: 'pid_absent', storage: failed },
    },
  ] satisfies { name: string; release: WindowsStopEvent }[])(
    'R15/R24/R21 held release ($name) is superseded by newer K-1 isolation of the same target',
    ({ release }) => {
      const held = decideWindowsStop(
        state({ rows: [background], quarantines: [quarantine] }),
        release,
      );
      expect(held.awaitingHoldId).toBe(failed.holdId);
      // A K-1 quarantine for the same target lands after the release was decided.
      const isolated = decideWindowsStop(held.state, {
        ...transportTimeout,
        cause: 'takeover_conflict',
      });
      expect(isolated.state.holds).toEqual([{ ...held.state.holds[0], releaseSuperseded: true }]);
      const retried = decideWindowsStop(isolated.state, {
        kind: 'retry_storage',
        holdId: failed.holdId,
        status: 'written',
      });
      expect(retried).toMatchObject({
        refusal: 'release_superseded',
        freshSession: false,
        freshSessionRequirements: [],
      });
      expect(retried.state.holds).toMatchObject([
        { id: failed.holdId, recovery: 'write_quarantine' },
      ]);
      const restored = decideWindowsStop(retried.state, {
        kind: 'retry_storage',
        holdId: failed.holdId,
        status: 'written',
      });
      expect(restored.state.holds).toEqual([]);
      expect(restored.state.quarantines).toEqual([quarantine]);
      expect(retried.state.quarantines).toEqual([quarantine]);
      expect(windowsTargetMayStart(retried.state, target)).toBe(false);
      expect(windowsTargetMayStart(retried.state, otherTarget)).toBe(true);
    },
  );

  it('R17/R21 held approval superseded by a first quarantine that landed through its own retry', () => {
    const held = decideWindowsStop(state({ rows: [background] }), {
      ...approval,
      storage: failed,
    }).state;
    // The K-1 write also fails, then lands on its retry: that is newer evidence too.
    const k1Held = decideWindowsStop(held, {
      ...transportTimeout,
      storage: { status: 'failed', holdId: 'write-2' },
    }).state;
    expect(k1Held.holds[0]?.releaseSuperseded).toBeUndefined();
    const k1Landed = decideWindowsStop(k1Held, {
      kind: 'retry_storage',
      holdId: 'write-2',
      status: 'written',
    }).state;
    const retried = decideWindowsStop(k1Landed, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'written',
    });
    expect(retried.refusal).toBe('release_superseded');
    expect(retried.state.quarantines).toEqual([{ identity: target, reason: 'response_lost' }]);
    expect(windowsTargetMayStart(retried.state, target)).toBe(false);
  });

  it.each([false, true])(
    'R21 pending K-1 supersedes release regardless of retry order (%s)',
    (k1First) => {
      const held = decideWindowsStop(state({ rows: [background] }), {
        ...approval,
        storage: failed,
      }).state;
      let pending = decideWindowsStop(held, {
        ...transportTimeout,
        storage: { status: 'failed', holdId: 'k1-pending' },
      }).state;
      if (k1First)
        pending = decideWindowsStop(pending, {
          kind: 'retry_storage',
          holdId: 'k1-pending',
          status: 'written',
        }).state;
      const gate = decideWindowsStop(pending, {
        kind: 'retry_storage',
        holdId: failed.holdId,
        status: 'before_write',
      });
      expect(gate.refusal).toBe('release_superseded');
      expect(gate.state.holds.some((hold) => hold.id === failed.holdId)).toBe(k1First);
      const retried = decideWindowsStop(pending, {
        kind: 'retry_storage',
        holdId: failed.holdId,
        status: 'written',
      });
      expect(retried).toMatchObject({
        freshSession: false,
        refusal: 'release_superseded',
        freshSessionRequirements: [],
      });
      expect(windowsTargetMayStart(retried.state, target)).toBe(false);
    },
  );

  it.each([written, failed])('R18 cancels a stored but unsent row (%s)', (storage) => {
    const recorded = decideWindowsStop(state({ killRequested: true }), dispatch);
    const canceled = decideWindowsStop(recorded.state, {
      kind: 'dispatch_canceled',
      helperGeneration: 1,
      requestId: row.requestId,
      storage,
    });
    expect(canceled.state.rows).toHaveLength(storage.status === 'written' ? 0 : 1);
    if (storage.status === 'failed') {
      expect(windowsTargetMayStart(canceled.state, target)).toBe(false);
      expect(
        decideWindowsStop(canceled.state, {
          kind: 'retry_storage',
          holdId: storage.holdId,
          status: 'written',
        }).state.rows,
      ).toEqual([]);
    }
  });

  it('R21 refuses a superseded release before writing after a receipt transfer', () => {
    const held = decideWindowsStop(state({ rows: [background], quarantines: [quarantine] }), {
      ...approval,
      storage: failed,
    }).state;
    const transferred = decideWindowsStop(held, receipt).state;
    expect(transferred.rows).toEqual([]);
    const gate = decideWindowsStop(transferred, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'before_write',
    });
    expect(gate.refusal).toBe('release_superseded');
    expect(gate.state.holds).toMatchObject([
      { recovery: 'write_quarantine', quarantinesToRestore: [quarantine] },
    ]);
    expect(gate.state.quarantines).toEqual([quarantine]);
    const alreadyWritten = decideWindowsStop(transferred, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'written',
    });
    expect(alreadyWritten.state.holds).toMatchObject([
      { recovery: 'write_quarantine', quarantinesToRestore: [quarantine] },
    ]);
  });

  it('R21 a timed out release retains restoration after newer evidence before writing', () => {
    const held = decideWindowsStop(state({ rows: [background], quarantines: [quarantine] }), {
      ...approval,
      storage: failed,
    }).state;
    const ambiguous = decideWindowsStop(held, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'failed',
      uncertain: true,
    }).state;
    const transferred = decideWindowsStop(ambiguous, receipt).state;
    expect(ambiguous.holds).toMatchObject([{ writeUncertain: true }]);
    const gate = decideWindowsStop(transferred, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'before_write',
    });
    expect(gate.refusal).toBe('release_superseded');
    expect(gate.awaitingHoldId).toBe(failed.holdId);
    expect(gate.state.holds).toMatchObject([
      { recovery: 'write_quarantine', quarantinesToRestore: [quarantine] },
    ]);
    expect(windowsTargetMayStart(gate.state, target)).toBe(false);
  });

  it('R21 a response hold does not supersede a release', () => {
    const held = decideWindowsStop(state({ rows: [row], quarantines: [quarantine] }), {
      ...approval,
      storage: failed,
    }).state;
    const pending = decideWindowsStop(held, {
      ...response,
      storage: { status: 'failed', holdId: 'response-pending' },
    }).state;
    const released = decideWindowsStop(pending, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'written',
    });
    expect(released.refusal).toBeNull();
    expect(released.freshSession).toBe(true);
    expect(released.state.holds).toHaveLength(1);
  });

  it('R24 held approval without newer isolation still releases on retry', () => {
    const held = decideWindowsStop(state({ quarantines: [quarantine] }), {
      ...approval,
      storage: failed,
    }).state;
    // Isolation of another target does not supersede this release.
    const other = decideWindowsStop(
      { ...held, rows: [{ ...background, identity: otherTarget }] },
      transportTimeout,
    ).state;
    expect(other.holds[0]?.releaseSuperseded).toBeUndefined();
    const gate = decideWindowsStop(other, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'before_write',
    });
    expect(gate.state).toBe(other);
    expect(gate.freshSession).toBe(false);
    const released = decideWindowsStop(other, {
      kind: 'retry_storage',
      holdId: failed.holdId,
      status: 'written',
    });
    expect(released).toMatchObject({
      refusal: null,
      freshSession: true,
      freshSessionRequirements: k5Requirements,
    });
    expect(windowsTargetMayStart(released.state, target)).toBe(true);
    expect(windowsTargetMayStart(released.state, otherTarget)).toBe(false);
  });

  it('R19/R7 restore_read is refused once this Main launched a helper; startup still restores', () => {
    const unreadable = {
      kind: 'store_unreadable',
      holdId: 'read-1',
      targets: 'unknown',
    } as const satisfies WindowsStopEvent;
    const restoreRead = {
      kind: 'restore_read',
      holdId: 'read-1',
      rows: [row],
      storage: written,
    } as const satisfies WindowsStopEvent;
    // R7 in progress: a kill without exit and live blockers must not be replayed away.
    const running = decideWindowsStop(
      state({ killRequested: true, nativeBlockers: blockers }),
      unreadable,
    ).state;
    const refused = decideWindowsStop(running, restoreRead);
    expect(refused).toMatchObject({ refusal: 'restore_requires_restart' });
    expect(refused.state).toBe(running);
    expect(windowsTargetMayStart(refused.state, otherTarget)).toBe(false);
    const afterRestart = decideWindowsStop(running, { kind: 'restart', storage: written }).state;
    const restored = decideWindowsStop(afterRestart, restoreRead);
    expect(restored.refusal).toBeNull();
    expect(restored.state.holds).toEqual([]);
    expect(restored.state.quarantines).toEqual([{ identity: target, reason: 'restored' }]);
  });

  it('R14/R23 foreground-only restart failure keeps the rows for the next restart without a diagnostic', () => {
    const fgRow = { ...foreground, requestId: 'fg' };
    const failedRestart = decideWindowsStop(state({ rows: [fgRow] }), {
      kind: 'restart',
      storage: failed,
    });
    expect(failedRestart.diagnostics).toEqual([]);
    expect(failedRestart.awaitingHoldId).toBeNull();
    expect(failedRestart.state).toMatchObject({
      rows: [fgRow],
      holds: [],
      quarantines: [],
      foregroundDiscardPending: true,
    });
    expect(windowsTargetMayStart(failedRestart.state, target)).toBe(true);
    const nextRestart = decideWindowsStop(failedRestart.state, {
      kind: 'restart',
      storage: written,
    });
    expect(nextRestart.diagnostics).toEqual([
      { kind: 'foreground', reason: 'foreground_restart_discard' },
    ]);
    expect(nextRestart.state).toMatchObject({ rows: [], foregroundDiscardPending: false });
  });
});

describe('ADR omitted combinations are rejected', () => {
  it.each(['terminated_clean', 'terminated_target_suspect'] as const)(
    'no exit evidence for %s',
    (result) => {
      expect(() =>
        decideWindowsStop(state({ result }), { kind: 'pipe_closed', helperGeneration: 1 }),
      ).toThrow('Termination requires exit evidence');
    },
  );
  it('kill return and pipe closure are not exit evidence', () => {
    const next = decideWindowsStop(state(), { kind: 'kill_requested', helperGeneration: 1 }).state;
    expect(
      decideWindowsStop(next, { kind: 'pipe_closed', helperGeneration: 1 }).state.result,
    ).toBeNull();
  });
  it('identity-free dispatch is denied', () => {
    expect(decideWindowsStop(state(), { ...gate, identity: null }).dispatch).toBe('deny');
  });
  it('discovery cannot supply a control identity to quarantine', () => {
    const result = decideWindowsStop(state(), {
      ...transportTimeout,
      requestId: 'discovery-only',
    });
    expect(result).toMatchObject({ refusal: 'no_control_ledger_row' });
    expect(result.state.quarantines).toEqual([]);
  });
  it('same Main cannot start helper while old exit is pending', () => {
    const result = decideWindowsStop(state({ killRequested: true }), {
      kind: 'start_generation',
      nextHelperGeneration: 2,
    });
    expect(result).toMatchObject({ refusal: 'previous_exit_unconfirmed', helper: 'unchanged' });
    expect(result.state.helperGeneration).toBe(1);
  });
  it('verified accepted=false is deleted and cannot become suspect', () => {
    const next = decideWindowsStop(state({ rows: [background] }), {
      ...response,
      status: 'rejected',
      accepted: false,
    }).state;
    expect(next.rows).toEqual([]);
    expect(decideWindowsStop(next, exit).state.result).toBe('terminated_clean');
    expect(next.quarantines).toEqual([]);
  });
  it('rejects accepted=false paired with effect_unconfirmed', () => {
    // @ts-expect-error accepted=false is a verified rejection, never effect_unconfirmed.
    const contradictory: WindowsStopEvent = { ...unconfirmedResponse, accepted: false };
    expect(() => decideWindowsStop(state({ rows: [background] }), contradictory)).toThrow(
      'Response acceptance contradicts its status',
    );
  });
  it('R0 non-submission cannot bypass other owners', () => {
    const result = decideWindowsStop(state({ entry: 'E3' }), {
      kind: 'not_submitted',
      helperGeneration: 1,
      otherUnconfirmedOwners: true,
    });
    expect(result).toMatchObject({ refusal: 'invalid_non_submission_proof', confirmation: 'none' });
    expect(result.state.result).toBeNull();
  });
  it('approval without trusted activation or a fresh session is refused', () => {
    for (const event of [
      { ...approval, trustedActivation: false },
      { ...approval, newSessionId: 'session-a' },
      { ...approval, previousStop: 'exit' as const },
    ]) {
      const result = decideWindowsStop(state({ quarantines: [quarantine] }), event);
      expect(result).toMatchObject({ refusal: 'approval_requires_fresh_session' });
      expect(result.state.quarantines).toEqual([quarantine]);
    }
  });
});
