import {
  windowsK1QuarantineReason,
  type WindowsLedgerRow,
  type WindowsStopDecision,
  type WindowsStopEvent,
  type WindowsTargetQuarantine,
  type WindowsUnconfirmedInputCause,
} from './computer-use-windows-stop-outcome';

/** Main-only K-1 entry. N9 supplies a recorded request, never a caller-provided target. */
export function queueWindowsInputQuarantine(input: {
  row: WindowsLedgerRow;
  cause: WindowsUnconfirmedInputCause;
  holdId: string;
  apply(event: WindowsStopEvent): WindowsStopDecision;
  persist(quarantines: readonly WindowsTargetQuarantine[]): boolean | Promise<boolean>;
  enqueue(generation: number, holdId: string, write: () => boolean | Promise<boolean>): void;
}): boolean {
  const { row } = input;
  const decision = input.apply({
    kind: 'input_unconfirmed',
    helperGeneration: row.helperGeneration,
    sessionId: row.sessionId,
    requestId: row.requestId,
    cause: input.cause,
    storage: { status: 'failed', holdId: input.holdId },
  });
  // Install isolation synchronously; the Host's bounded writer owns retries and late completion.
  if (decision.state.holds.some((hold) => hold.id === input.holdId)) {
    input.enqueue(row.helperGeneration, input.holdId, () =>
      input.persist([{ identity: row.identity, reason: windowsK1QuarantineReason(input.cause) }]),
    );
  }
  return decision.pause;
}
