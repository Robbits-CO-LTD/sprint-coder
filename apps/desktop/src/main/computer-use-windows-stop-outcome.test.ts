// ADR §2.6 mapping: each table name starts with its R row (R0–R24, R1a, R19a–c).
// Additional sequential tests cover R1a/K-3, R13, R19a–c recovery and R23 lifetime.
// R8/R11 notification, sessionless E4 notification and settle duration remain undecided.
import { describe, expect, it } from 'vitest';
import {
  decideWindowsStop,
  windowsDiscoveryStopResult,
  windowsTargetMayStart,
  WINDOWS_STOP_CLOSE_MS,
  WINDOWS_STOP_EXIT_MS,
  WINDOWS_STOP_DEADLINE_MS,
  type WindowsStopState,
  type WindowsStopEvent,
  type WindowsStopDecision,
  type WindowsLedgerRow,
} from './computer-use-windows-stop-outcome';

const target = { pid: 41, creationTime: 'synthetic-process-a' };
const otherTarget = { pid: 42, creationTime: 'synthetic-process-b' };
const written = { status: 'written' } as const;
const failed = { status: 'failed', holdId: 'write-1' } as const;
const row: WindowsLedgerRow = {
  helperGeneration: 1,
  sessionId: 'session-a',
  requestId: 'request-a',
  kind: 'semantic',
  inputPath: 'normal',
  identity: target,
  state: 'awaiting_response',
};
const background: WindowsLedgerRow = { ...row, inputPath: 'background_semantic' };
const foreground: WindowsLedgerRow = {
  ...row,
  kind: 'foreground',
  inputPath: 'foreground',
  state: 'effect_unconfirmed',
};
const quarantine = { identity: target, reason: 'background_uncertain' } as const;
function state(overrides: Partial<WindowsStopState> = {}): WindowsStopState {
  return {
    helperGeneration: 1,
    entry: 'E1',
    sessionId: 'session-a',
    killRequested: false,
    exitConfirmed: false,
    exitWaitExceeded: false,
    result: null,
    rows: [],
    quarantines: [],
    holds: [],
    owners: [],
    nativeBlockers: [],
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
const response: WindowsStopEvent = {
  kind: 'response',
  helperGeneration: 1,
  requestId: row.requestId,
  status: 'success',
  storage: written,
};

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
    },
    mayStart: true,
  },
  {
    name: 'R0 unsubmitted E4',
    input: state({ entry: 'E4' }),
    event: { kind: 'not_submitted', helperGeneration: 1, otherUnconfirmedOwners: false },
    expected: { confirmation: 'not_submitted' },
    mayStart: true,
  },
  {
    name: 'R1 verified receipt',
    input: state({ rows: [row] }),
    event: receipt,
    expected: {
      confirmation: 'host_receipt',
      idleTeardown: 'allowed',
      state: { rows: [], result: 'receipt' },
    },
    mayStart: true,
  },
  {
    name: 'R1a receipt after kill keeps exit as evidence',
    input: state({ rows: [row], killRequested: true }),
    event: receipt,
    expected: {
      confirmation: 'none',
      helper: 'retain_child',
      state: { rows: [], killRequested: true, result: null },
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
      state: { result: 'terminated_clean', quarantines: [quarantine] },
    },
    mayStart: false,
  },
  {
    name: 'R5 awaiting semantic input',
    input: state({ rows: [row] }),
    event: exit,
    expected: {
      state: {
        result: 'terminated_target_suspect',
        rows: [],
        quarantines: [{ identity: target, reason: 'unconfirmed_input' }],
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
    name: 'R6 SendInput survives transport timeout',
    input: state({ rows: [{ ...row, kind: 'SendInput' }] }),
    event: exit,
    expected: { state: { result: 'terminated_target_suspect' } },
    mayStart: false,
  },
  {
    name: 'R6 paste survives transport timeout',
    input: state({ rows: [{ ...row, kind: 'paste' }] }),
    event: exit,
    expected: { state: { result: 'terminated_target_suspect' } },
    mayStart: false,
  },
  {
    name: 'R7 T exceeded without exit',
    input: state({ killRequested: true, rows: [row] }),
    event: { kind: 'exit_wait_exceeded', helperGeneration: 1 },
    expected: {
      helper: 'retain_child',
      confirmation: 'none',
      notification: 'native_unavailable',
      state: { rows: [row], result: 'termination_requested' },
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
      notification: 'undecided',
      state: { result: 'terminated_target_suspect' },
    },
    mayStart: false,
  },
  {
    name: 'R9 discovery and start without control',
    input: state(),
    event: exit,
    expected: {
      state: { result: 'terminated_clean', quarantines: [] },
      cleanup: 'generation_after_transfer',
    },
    mayStart: true,
  },
  {
    name: 'R10 discovery and control',
    input: state({ rows: [row] }),
    event: exit,
    expected: {
      state: {
        result: 'terminated_target_suspect',
        quarantines: [{ identity: target, reason: 'unconfirmed_input' }],
      },
      cleanup: 'generation_after_transfer',
    },
    mayStart: false,
  },
  {
    name: 'R11 crash outside Stop',
    input: state({ rows: [row] }),
    event: { ...exit, cause: 'crash' },
    expected: { notification: 'undecided', state: { result: 'terminated_target_suspect' } },
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
          { identity: target, reason: 'unconfirmed_input' },
          { identity: otherTarget, reason: 'unconfirmed_input' },
        ],
      },
    },
    mayStart: false,
  },
  {
    name: 'R13 receipt after exit changes nothing',
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
    }),
    event: { kind: 'restart', storage: written },
    expected: {
      confirmation: 'none',
      state: {
        result: null,
        exitConfirmed: false,
        rows: [],
        quarantines: [{ identity: target, reason: 'restored' }],
      },
      diagnostics: [{ kind: 'foreground', reason: 'foreground_restart_discard' }],
    },
    mayStart: false,
  },
  ...(['signaled', 'creation_mismatch', 'pid_absent'] as const).map((evidence): Case => ({
    name: `R15 reconcile ${evidence}`,
    input: state({ quarantines: [quarantine] }),
    event: { kind: 'reconcile', identity: target, evidence, storage: written },
    expected: { state: { quarantines: [] }, freshSession: true },
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
    name: 'R17 trusted new generation session',
    input: state({ helperGeneration: 2, quarantines: [quarantine] }),
    event: {
      kind: 'approve_new_session',
      identity: target,
      trustedActivation: true,
      previousStop: 'exit',
      previousGeneration: 1,
      previousSessionId: 'session-a',
      newSessionId: 'session-b',
      storage: written,
    },
    expected: { freshSession: true, state: { quarantines: [] } },
    mayStart: true,
  },
  {
    name: 'R18 missing identity cannot dispatch',
    input: state(),
    event: { kind: 'before_dispatch', identity: null, storage: written },
    expected: { dispatch: 'deny', helper: 'unchanged' },
    mayStart: true,
  },
  {
    name: 'R18 write failure cannot dispatch',
    input: state(),
    event: { kind: 'before_dispatch', identity: target, storage: failed },
    expected: { dispatch: 'deny', helper: 'unchanged' },
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
    event: { ...response, status: 'effect_unconfirmed', storage: failed },
    expected: { state: { rows: [row] } },
    mayStart: false,
  },
  {
    name: 'R19b K-3 transfer failure still confirms receipt',
    input: state({ rows: [background] }),
    event: { ...receipt, storage: failed },
    expected: {
      confirmation: 'host_receipt',
      state: { result: 'receipt', rows: [background], quarantines: [] },
    },
    mayStart: false,
  },
  {
    name: 'R19c exit transfer failure still confirms exit',
    input: state({ rows: [row] }),
    event: { ...exit, storage: failed },
    expected: {
      confirmation: 'exit',
      cleanup: 'generation_after_transfer',
      state: { result: 'terminated_target_suspect', rows: [row], quarantines: [] },
    },
    mayStart: false,
  },
  ...(['invalid_format', 'missing_identity'] as const).map((reason): Case => ({
    name: `R20 discard ${reason}`,
    input: state(),
    event: { kind: 'invalid_stored_row', rowKind: 'semantic', reason },
    expected: { diagnostics: [{ kind: 'semantic', reason }], state: { rows: [], holds: [] } },
    mayStart: true,
  })),
  {
    name: 'R21 background uncertainty pauses and isolates live target',
    input: state({ rows: [background] }),
    event: {
      kind: 'background_uncertain',
      helperGeneration: 1,
      requestId: row.requestId,
      storage: written,
    },
    expected: {
      pause: true,
      state: { result: null, rows: [background], quarantines: [quarantine] },
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
        quarantines: [{ identity: target, reason: 'unconfirmed_input' }],
      },
    },
    mayStart: false,
  },
  {
    name: 'R23 foreground uncertainty pauses without isolation',
    input: state({ rows: [foreground] }),
    event: { ...response, status: 'effect_unconfirmed' },
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
    event: {
      kind: 'approve_new_session',
      identity: target,
      trustedActivation: true,
      previousStop: 'receipt',
      previousGeneration: 1,
      previousSessionId: 'session-a',
      newSessionId: 'session-b',
      storage: written,
    },
    expected: { freshSession: true, state: { quarantines: [] } },
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

  it('AC-3 fixes C, T and Stop-origin E1–E4 budgets', () => {
    expect(WINDOWS_STOP_CLOSE_MS).toBe(10_000);
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

  it('R13 receipt and response after exit cannot delete a failed transfer or change classification', () => {
    const next = decideWindowsStop(state({ rows: [row] }), { ...exit, storage: failed }).state;
    expect(decideWindowsStop(next, receipt).state).toBe(next);
    expect(decideWindowsStop(next, response).state).toBe(next);
    expect(decideWindowsStop(next, exit).state).toBe(next);
    expect(() => decideWindowsStop(state({ helperGeneration: 2 }), receipt)).toThrow(
      'Generation mismatch',
    );
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
      event: { ...response, status: 'effect_unconfirmed', storage: failed },
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
      expect(
        decideWindowsStop(held, { kind: 'retry_storage', holdId: failed.holdId, status: 'failed' })
          .state,
      ).toBe(held);
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

  it.each(['success', 'rejected'] as const)(
    'R23 verified foreground %s deletes the row',
    (status) => {
      expect(
        decideWindowsStop(state({ rows: [foreground] }), { ...response, status }).state.rows,
      ).toEqual([]);
    },
  );

  it('R24 card does not clear generation kill or storage holds', () => {
    const held = decideWindowsStop(state({ rows: [background], quarantines: [quarantine] }), {
      ...receipt,
      storage: failed,
    }).state;
    const approved = decideWindowsStop(
      { ...held, killRequested: true },
      {
        kind: 'approve_new_session',
        identity: target,
        trustedActivation: true,
        previousStop: 'receipt',
        previousGeneration: 1,
        previousSessionId: 'session-a',
        newSessionId: 'session-b',
        storage: written,
      },
    ).state;
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

  it.each(['uncertain', 'closeCandidate', 'activeStopQuarantines', 'in_flight'] as const)(
    'R24 approval preserves %s and requires fresh credentials',
    (blocker) => {
      const result = decideWindowsStop(
        state({ nativeBlockers: [blocker], quarantines: [quarantine] }),
        {
          kind: 'approve_new_session',
          identity: target,
          trustedActivation: true,
          previousStop: 'receipt',
          previousGeneration: 1,
          previousSessionId: 'session-a',
          newSessionId: 'session-b',
          storage: written,
        },
      );
      expect(result.state.nativeBlockers).toEqual([blocker]);
      expect(windowsTargetMayStart(result.state, target)).toBe(false);
      expect(result.freshSessionRequirements).toEqual([
        'session_id',
        'ticket',
        'cancel_epoch',
        'observation',
        'current_interaction_epoch',
      ]);
    },
  );

  it('R19 read recovery requires restoring the rows before removing the global hold', () => {
    const held = decideWindowsStop(state(), {
      kind: 'store_unreadable',
      holdId: 'read-1',
      targets: 'unknown',
    }).state;
    expect(windowsTargetMayStart(held, otherTarget)).toBe(false);
    expect(() =>
      decideWindowsStop(held, { kind: 'retry_storage', holdId: 'read-1', status: 'written' }),
    ).toThrow('Restore requires restored rows');
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

  it.each(['invalid', 'deadline'] as const)('R3 %s immediately requests kill', (status) => {
    expect(decideWindowsStop(state(), { ...receipt, status }).helper).toBe('request_kill');
  });

  it('receipt affects only its session and exit affects only its generation', () => {
    const second = { ...row, sessionId: 'session-b', requestId: 'request-b' };
    const later = { ...row, helperGeneration: 2 };
    const next = decideWindowsStop(state({ rows: [row, second, later] }), receipt).state;
    expect(next.rows).toEqual([second, later]);
    expect(decideWindowsStop(next, exit).state.rows).toEqual([later]);
  });
});

describe('ADR omitted combinations are rejected', () => {
  it.each(['terminated_clean', 'terminated_target_suspect'] as const)(
    'no exit evidence for %s',
    (result) => {
      expect(() => decideWindowsStop(state({ result }), { kind: 'start_helper' })).toThrow(
        'Termination requires exit evidence',
      );
    },
  );
  it('kill return and pipe closure are not exit evidence', () => {
    const next = decideWindowsStop(state(), { kind: 'kill_requested', helperGeneration: 1 }).state;
    expect(
      decideWindowsStop(next, { kind: 'pipe_closed', helperGeneration: 1 }).state.result,
    ).toBeNull();
  });
  it('identity-free dispatch is denied', () => {
    expect(
      decideWindowsStop(state(), { kind: 'before_dispatch', identity: null, storage: written })
        .dispatch,
    ).toBe('deny');
  });
  it('discovery cannot supply a control identity to quarantine', () => {
    expect(() =>
      decideWindowsStop(state(), {
        kind: 'background_uncertain',
        helperGeneration: 1,
        requestId: 'discovery-only',
        storage: written,
      }),
    ).toThrow('No control ledger row');
  });
  it('same Main cannot start helper while old exit is pending', () => {
    expect(() =>
      decideWindowsStop(state({ killRequested: true }), { kind: 'start_helper' }),
    ).toThrow('Previous helper exit is unconfirmed');
  });
  it('verified accepted=false is deleted and cannot become suspect', () => {
    const next = decideWindowsStop(state({ rows: [background] }), {
      ...response,
      status: 'rejected',
    }).state;
    expect(next.rows).toEqual([]);
    expect(decideWindowsStop(next, exit).state.result).toBe('terminated_clean');
    expect(next.quarantines).toEqual([]);
  });
  it('rejects accepted=false paired with effect_unconfirmed', () => {
    expect(() =>
      decideWindowsStop(state({ rows: [background] }), {
        ...response,
        status: 'effect_unconfirmed',
        accepted: false,
      }),
    ).toThrow('Rejected input cannot be effect-unconfirmed');
  });
  it('non-submission cannot bypass other owners', () => {
    expect(() =>
      decideWindowsStop(state({ entry: 'E3' }), {
        kind: 'not_submitted',
        helperGeneration: 1,
        otherUnconfirmedOwners: true,
      }),
    ).toThrow('Invalid non-submission proof');
  });
});
