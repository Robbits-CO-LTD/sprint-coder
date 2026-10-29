import type { ComputerUseNativeManifest } from '@sprint-coder/contracts';

export type ComputerUseNativePlatform = 'darwin' | 'win32' | 'linux';

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
  dispatch?(input: unknown): unknown;
  /**
   * Windows helper only (#785 T15-4w; macOS is T15-4m). Reads the value of the one node a `copy`
   * names and answers `{ ok: true, text }` or `{ ok: false }`. No input capability. The host adapter
   * exposes it, but the capability `artifactReadSupported` stays false until T15-E.
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
