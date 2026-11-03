import type {
  ComputerUseNativeInputReceipt,
  ComputerUseNativeManifest,
} from '@sprint-coder/contracts';

export type ComputerUseNativePlatform = 'darwin' | 'win32' | 'linux';

/** Main-only callbacks. The Windows client never owns or receives a storage implementation. */
export type WindowsDispatchCallbacks = Readonly<{
  beforeWrite(helperGeneration: number, wireRequestId: string): Promise<void>;
  assertSend(): void;
  canceled(): Promise<void>;
  unconfirmed(cause: 'transport_timeout' | 'failAll' | 'abortTransport'): void;
  response(accepted: boolean): Promise<void>;
}>;

export type WindowsCloseConfirmation = Readonly<{ status: 'confirmed' | 'pending' }>;
export type WindowsTerminationCallbacks = Readonly<{
  prepare(): Promise<void>;
  started(generation: number): void;
  owned?(generation: number, kind: 'session' | 'discovery', id: string): void;
  stopping?(generation: number, entry: 'E1' | 'E2' | 'E3' | 'E4', ownerId: string): void;
  event(generation: number, kind: 'kill_requested' | 'pipe_closed' | 'exit_wait_exceeded'): void;
  exited(generation: number, cause: 'stop' | 'crash' | 'abortTransport'): void;
}>;
export type WindowsCloseCallbacks = Readonly<{
  received(generation: number, sessionId: string): void;
  blocked(generation: number): boolean;
  verified(
    generation: number,
    sessionId: string,
    persisted: () => void,
  ): Promise<WindowsCloseConfirmation>;
}>;

/** Local transport proof only. A native error response can never create this instance. */
export class ComputerUseDiscoveryNotSubmittedError extends Error {}

export type ComputerUseNativeProbe = Readonly<{
  available: boolean;
  protocolVersion: 1;
  apiVersion: 3;
  backend: string;
  reason: string;
  artifactPath: string | null;
  artifactDigest: string | null;
  capabilities: Readonly<{
    observe: boolean;
    control: boolean;
    /**
     * Per-capability facts the native probe measured. They are present only when a probe actually
     * reported them, so an absent field means "not measured", never "granted". Main treats
     * anything other than `true` as not granted.
     */
    accessibility?: boolean;
    screenCapture?: boolean;
    screenCaptureKit?: boolean;
    /** Private Windows protocol extension; absence never enables its query/Stop methods. */
    cancellableWindowDiscovery?: boolean;
    /** Private Windows attest for reading one node; absence keeps artifact transfer closed. */
    artifactRead?: boolean;
  }>;
}>;

export type ComputerUseNativeAddon = Readonly<{
  probe(): unknown;
  handshake?(input: unknown): unknown;
  pickApplication?(input: unknown): unknown;
  listWindows?(input: unknown): unknown;
  discoverWindows?(input: unknown): unknown;
  stopWindowDiscovery?(input: unknown): unknown;
  cancelUnsubmittedDiscovery?(discoveryId: string): 'never_sent' | 'may_have_been_sent' | 'unknown';
  /** Windows v2 discovery evidence; absent on older helpers and never a public tool result. */
  listTargets?(input: unknown): unknown;
  startSession?(input: unknown): unknown;
  /** API3: terminates an admitted lifetime without guessing its native epoch. */
  stopPendingStart?(input: unknown): unknown;
  /** Main-only Windows transport proof; never a value received from native. */
  cancelUnsubmittedStart?(sessionId: string): 'never_sent' | 'may_have_been_sent' | 'unknown';
  /** Main-only Windows lifetime state, never native wire data or a public tool. */
  hasUnconfirmedSemanticInputs?(): boolean;
  /** Host has validated this exact native response, including epoch/counter and discovery Stop. */
  confirmSessionClosed?(
    receipt: ComputerUseNativeInputReceipt,
    evidence: unknown,
  ): void | Promise<WindowsCloseConfirmation>;
  configureCloseLedger?(callbacks: WindowsCloseCallbacks): void;
  configureWindowsTermination?(callbacks: WindowsTerminationCallbacks): void;
  cleanupWindowsGeneration?(generation: number): void;
  /** Internal Stop seam; inert unless Host configured the termination callbacks. */
  requestWindowsTermination?(): void;
  reevaluateIdle?(): void;
  observe?(input: unknown): unknown;
  /** macOS native only (N2a). Absent on older native builds and on Windows. */
  preflight?(input: unknown): unknown;
  /**
   * macOS native only (N2b-4). Revalidates and exchanges the waiting approval for an execution
   * ticket. The request is a dispatch request plus `approvalGeneration`; the receipt is a fixed set
   * of nine keys (`ok`, `reasonCode`, `deniedResult`, `sessionId`, `requestId`, `cancelEpoch`,
   * `observationRevision`, `approvalGeneration`, `inputAttemptCount`). No input capability.
   */
  approvalApprove?(input: unknown): unknown;
  /** Ends the approval of exactly `{ sessionId, approvalGeneration }`. No input capability. */
  approvalDiscard?(input: unknown): unknown;
  /** The input entry after `approvalApprove`; asks for `approvalGeneration` and never a ticket. */
  dispatchApproved?(input: unknown): unknown;
  dispatch?(input: unknown, callbacks?: WindowsDispatchCallbacks): unknown;
  dispatchLedgerSupported?: true;
  /**
   * Windows helper only (#785 T15-4w; macOS is T15-4m). Reads the value of the one node a `copy`
   * names and answers `{ ok: true, text }` or `{ ok: false }`. No input capability. The host adapter
   * exposes it; artifact capabilities require a ready Windows handshake and an artifactRead attest.
   */
  readNodeValue?(input: unknown): unknown;
  cancel?(input: unknown): unknown;
  close?(input: unknown): unknown;
}>;

export type ComputerUseNativeBinding = Readonly<{
  manifest: ComputerUseNativeManifest;
  probe: ComputerUseNativeProbe;
  artifactPath: string | null;
  addon: ComputerUseNativeAddon | null;
}>;
