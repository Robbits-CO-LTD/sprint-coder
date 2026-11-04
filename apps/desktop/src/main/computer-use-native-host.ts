import { createHash, randomUUID } from 'node:crypto';
import {
  ApprovalRoundTrips,
  type ApprovalRoundTripIdentity,
} from './computer-use-approval-round-trip';
import { z } from 'zod';
import type { WindowsInteractionListener } from './computer-use-windows-transport-events';
import { queueWindowsInputQuarantine } from './computer-use-windows-input-quarantine';
import {
  computerTargetWindowsGenerationMatches,
  type ComputerTargetWindowsGeneration,
} from './computer-use-target-model';
import { WindowsStopDelivery, type WindowsStopOwner } from './computer-use-windows-stop-delivery';
import {
  createComputerUseDiscoveryManager,
  type ComputerUseDiscoveryHandle,
  type ComputerUseGenerationTerminated,
} from './computer-use-native-discovery';
import { ComputerUseDiscoveryNotSubmittedError } from './computer-use-native-types';
import {
  COMPUTER_USE_ARTIFACT_LIMITS,
  bindComputerUseMaximumMode,
  computerAppIdentitySchema,
  computerUseActionResultSchema,
  computerUseInputSessionSchema,
  computerUseAvailabilitySchema,
  computerUseObservationSchema,
  computerUseModeSchema,
  computerUsePolicyLanguageSchema,
  computerUseResultSchema,
  computerUseNativeInputReceiptSchema,
  computerUseNativeCloseReceiptSchema,
  computerUseWindowCandidateSchema,
  computerUseWindowsApprovalDisplaySchema,
  type ComputerAppIdentity,
  type ComputerUseAvailability,
  type ComputerUseSemanticScrollAction,
  type ComputerUseEligibilityMode,
  type ComputerUseNativeManifest,
  type ComputerUseObservation,
  type ComputerUsePolicyLanguage,
  type ComputerUseMode,
  type ComputerUseNativeInputReceipt,
} from '@sprint-coder/contracts';
import type {
  ComputerUseNativeActionResult,
  ComputerUseNativeApprovalApproveResult,
  ComputerUseNativeApprovalOffer,
  ComputerUseNativeHost,
  ComputerUsePendingStartStop,
  ComputerUseNativeNodeValue,
  ComputerUseNativeSession,
  ComputerUseNativeWindow,
} from './computer-use-controller';
import {
  COMPUTER_USE_APPROVAL_CLASSIFIER_VERSION,
  computerUseApprovalPathEnabled,
  type ComputerUseApprovalRoute,
} from './computer-use-eligibility';
import {
  computerUseCompiledAcceptanceMode,
  computerUseWindowsSignerWaived,
} from './computer-use-acceptance-mode';
// Type-only: a runtime import from the signed loader would close a cycle through the Windows
// transport and leave the close budgets below uninitialised. See computer-use-native-probe-facts.
import type { ComputerUseNativeBinding, ComputerUseNativeAddon } from './computer-use-native';
import { computerUseMissingNativePermissions } from './computer-use-native-probe-facts';
import { sanitizeNativeDisplayLabel } from './computer-use-native-display';
import {
  ComputerUseAccessibilityTreeError,
  projectComputerUseAccessibilityTree,
} from './computer-use-accessibility-tree';
import { computerUseActionDigest } from './computer-use-action';
import { parseWindowsComputerUseTargets } from './computer-use-native-targets';
import { denyRulesetVersion } from './computer-use-target-eligibility';
import { COMPUTER_USE_WINDOWS_BACKGROUND_INPUT_ENABLED } from './computer-use-native-protocol';
import type {
  WindowsDispatchCallbacks,
  WindowsStartCallbacks,
  WindowsCloseConfirmation,
  WindowsGenerationToken,
} from './computer-use-native-types';
import {
  decideWindowsStop,
  windowsTargetMayStart,
  isStoredWindowsLedgerRow,
  isStoredWindowsQuarantine,
  type WindowsStopDiagnostic,
  type WindowsLedgerRow,
  type WindowsLedgerPath,
  type WindowsStopState,
  type WindowsStopEvent,
  type WindowsStopDecision,
  type WindowsTargetQuarantine,
} from './computer-use-windows-stop-outcome';

const windowsExplorerApprovalBrand: unique symbol = Symbol('windows-explorer-approval');
export type WindowsExplorerApproval = Readonly<{
  [windowsExplorerApprovalBrand]: true;
}>;
// Only identity is retained; the shell view is measured at each capability use.
const explorerFactsSchema = z.object({
  platform: z.literal('win32'),
  imageRoot: z.literal('windows_directory'),
  imageRelativePath: z.string(),
  imageLeaf: z.string(),
  imageVolume: z.literal('fixed'),
  runningImageMatches: z.literal(true),
  signature: z.literal('valid'),
  signerMicrosoftRoot: z.literal(true),
  packaged: z.literal(false),
  windowClass: z.string(),
});
const explorerViewSchema = z
  .object({
    shellView: z.object({ kind: z.literal('filesystem_folder'), path: z.string() }).strict(),
    pointOwnerMatches: z.literal(true),
  })
  .strict();
export type WindowsExplorerFacts = Readonly<
  z.infer<typeof explorerFactsSchema> & z.infer<typeof explorerViewSchema>
>;
type ExplorerEvidence = Readonly<{
  facts: Readonly<z.infer<typeof explorerFactsSchema>>;
  current: () => boolean;
  measure: (point: Readonly<{ x: number; y: number }>) => Promise<unknown>;
}>;
const explorerApprovalReaders = new WeakMap<
  ComputerUseNativeHost,
  (sessionId: string) => ExplorerEvidence | undefined
>();
const explorerApprovals = new WeakMap<
  WindowsExplorerApproval,
  ExplorerEvidence & { host: ComputerUseNativeHost; sessionId: string }
>();

// Main-only evidence: neither an IPC boolean nor a caller-supplied host method can mint it.
export function readWindowsExplorerApproval(
  host: ComputerUseNativeHost,
  sessionId: string,
): WindowsExplorerApproval | undefined {
  const evidence = explorerApprovalReaders.get(host)?.(sessionId);
  if (evidence === undefined || !evidence.current()) return undefined;
  const approval: WindowsExplorerApproval = Object.freeze({ [windowsExplorerApprovalBrand]: true });
  explorerApprovals.set(approval, { host, sessionId, ...evidence });
  return approval;
}

export async function readCurrentWindowsExplorerFacts(
  approval: WindowsExplorerApproval | undefined,
  host: ComputerUseNativeHost,
  sessionId: string,
  point: Readonly<{ x: number; y: number }>,
): Promise<WindowsExplorerFacts | undefined> {
  const evidence = approval === undefined ? undefined : explorerApprovals.get(approval);
  if (evidence?.host !== host || evidence.sessionId !== sessionId || !evidence.current())
    return undefined;
  try {
    const view = explorerViewSchema.safeParse(await evidence.measure(point));
    return view.success && evidence.current() ? { ...evidence.facts, ...view.data } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Each row is keyed by (helperGeneration, sessionId, requestId); the wire request id alone can repeat
 * across sessions, so an implementation must not key rows by requestId only. Stores scope these
 * keys to their stable instanceId. Writes and completion notifications must be serialized on
 * each connection; shared quarantines keep the first committed reason across connections.
 */
export type WindowsDispatchLedgerStorage = Readonly<{
  write(row: WindowsLedgerRow): boolean | Promise<boolean>;
  update(row: WindowsLedgerRow): boolean | Promise<boolean>;
  /**
   * K-1 (a): atomically update this row and add its quarantines (first committed reason kept).
   * Without it a background effect_unconfirmed response stays held (fail-closed, R21).
   */
  updateWithQuarantines?(
    row: WindowsLedgerRow,
    quarantines: readonly WindowsTargetQuarantine[],
  ): boolean | Promise<boolean>;
  delete(row: WindowsLedgerRow): boolean | Promise<boolean>;
  /**
   * Adds quarantines using the same first committed reason rule as transferReceipt.
   * Concurrent connections may commit in a different order from the core's events.
   */
  restoreQuarantines(quarantines: readonly WindowsTargetQuarantine[]): boolean | Promise<boolean>;
  /**
   * The shared quarantine's update revision, or null without a row. Every add or transfer that
   * touches the identity (including one that keeps the first committed reason) changes it.
   */
  quarantineRevision?(
    identity: WindowsTargetQuarantine['identity'],
  ): number | null | Promise<number | null>;
  /**
   * Remove only this identity. Without `revision` (R15: a proven terminated process covers every
   * earlier operation) the delete is unconditional. With it (R17/R24: an explicit approval) the
   * delete happens in one transaction only while the row still has that revision, and returns
   * false, keeping the row, when newer evidence changed it. Retries are idempotent: an absent row
   * returns true.
   */
  releaseQuarantine?(
    identity: WindowsTargetQuarantine['identity'],
    revision?: number,
  ): boolean | Promise<boolean>;
  /** Startup snapshot: only this instance's rows, with all shared quarantines. */
  read?(): WindowsLedgerSnapshot | Promise<WindowsLedgerSnapshot>;
  /** Refresh shared isolation without replaying this Main's live ledger rows. */
  readQuarantines?(): readonly unknown[] | Promise<readonly unknown[]>;
  /**
   * Atomically persist quarantines and delete receipt/exit rows; retries must be idempotent.
   * Quarantines are never removed here, and an existing quarantine keeps its first committed reason.
   * Receipt and exit transfers of one generation can run concurrently, so commit order may differ
   * from the core's order (a late receipt's response_lost can land before an exit's exit_suspect).
   * Reasons are diagnostic, not admission criteria. Preserve first commit order, not core order.
   */
  transferReceipt?(
    rows: readonly WindowsLedgerRow[],
    quarantines: readonly WindowsTargetQuarantine[],
  ): boolean | Promise<boolean>;
}>;
export type WindowsLedgerSnapshot = Readonly<{
  rows: readonly unknown[];
  quarantines: readonly unknown[];
}>;

/** Stable Main-side reason for a native boundary that cannot service the controller seam. */
export const COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE = 'native_picker_unavailable' as const;
export const COMPUTER_USE_NATIVE_CONTROLLER_UNAVAILABLE = 'native_controller_unavailable' as const;

/**
 * Cancel only waits for native to invalidate the input epoch, so it keeps a short emergency
 * acknowledgement deadline. Close additionally waits for the native stop lane to drain, and only a
 * verified close receipt releases the process-local input quarantine. The drain budget therefore
 * has to come from the native side: on macOS `ExecuteNativeStop` takes the same serial dispatch
 * lock as start/observe/dispatch and has no internal timeout of its own
 * (computer-use-native/computer_use_macos.mm), and the Windows helper transport derives its own
 * close budget from this deadline so that it always outlasts it
 * (`COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS` in computer-use-native-windows.ts).
 * A shorter close deadline turns an ordinary drain into `native_stop_unconfirmed`, which disables
 * observe/control for the whole host until restart because the Controller drops the session handle
 * after a failed close. Quarantine on a genuinely unconfirmed stop is intentional; tripping on a
 * slow but successful drain is not.
 */
const COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS = 1_000;
export const COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS = 10_000;

/**
 * How many times Stop sends a close for the same session before it gives up and reports the host
 * as unavailable (`ComputerUseController.completeStop`). The retry itself belongs to the
 * controller, but the budget lives next to the deadline it multiplies, because the transports are
 * what have to outlast the whole re-send window: a transport that stops waiting while Main may
 * still re-send tears the native side down between the two attempts and makes the re-send
 * unanswerable (`COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS` in computer-use-native-windows.ts).
 * Keeping both numbers here lets the transports state that relation as an expression instead of
 * repeating a literal that only happens to line up.
 */
export const COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT = 2;
// Same 2s as T; SQLite's 250ms busy timeout stays inside this deadline.
const WINDOWS_LEDGER_STORAGE_TIMEOUT_MS = 2_000;

export class ComputerUseNativeUnavailableError extends Error {
  constructor(
    readonly reasonCode: string,
    options?: ErrorOptions,
  ) {
    super(reasonCode, options);
    this.name = 'ComputerUseNativeUnavailableError';
  }
}

type NativePlatform = 'darwin' | 'win32';
type RuntimePlatform = 'darwin' | 'win32' | 'linux' | 'other';
type NativeMethod =
  | 'pickApplication'
  | 'listWindows'
  | 'discoverWindows'
  | 'stopWindowDiscovery'
  | 'listTargets'
  | 'startSession'
  | 'stopPendingStart'
  | 'observe'
  | 'preflight'
  | 'approvalApprove'
  | 'approvalDiscard'
  | 'dispatchApproved'
  | 'dispatch'
  | 'readNodeValue'
  | 'cancel'
  | 'close';

type InternalNativeSession = ComputerUseNativeSession &
  Readonly<{
    raw: Readonly<Record<string, unknown> & { processStartTime?: string | null }>;
  }>;
type ComputerUseNativeBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;
export type ComputerUseNativeHostOptions = Readonly<{
  /** Opt-in storage and startup restoration. Product activation remains PR10b. */
  windowsLedger?: WindowsDispatchLedgerStorage;
  /** Test injection only; never sourced from environment, Renderer, or model input. */
  windowsBackgroundInputForTesting?: boolean;
  windowsApprovalRoundTripForTesting?: ApprovalRoundTripIdentity;
  /** Isolate session lifetime tests from the completed start's separate Stop owner. */
  windowsCompletedStartForTesting?: (forget: (sessionId: string) => boolean) => void;
  windowsLedgerDiagnostic?: (diagnostic: WindowsStopDiagnostic) => void;
  /** Main-only PR5b policy. Product activation is coordinated with PR10. */
  windowsStartIdentity?: Readonly<{ enabled: boolean }>;
  /**
   * Internal PR7 seam. Enable only in PR10, together with the R8/R11 notifications (PR7c): without
   * them, a helper whose exit never arrives keeps refusing connections with no user notification.
   * PR5b's start/resume ledger gate immediately before socket.write is also required.
   * PR5b Host identity wiring and pre-send recording are complete; activate with PR10.
   * New-start quarantine matching (PR8) remains a separate prerequisite.
   * Revision-checked quarantine release and approval of restored quarantines without old
   * session memory are required. PR10a binds Main-owned window evidence to the card and
   * consumes trusted activation; the product default remains off until PR10b.
   */
  windowsKillStopTermination?: Readonly<{ enabled: true }>;
  /**
   * Whether the build attests classifier v2 (`NATIVE_APPROVAL_CLASSIFIER_VERSION`). Production sets
   * it from the eligibility compiled into Main (`computerUseClassifierV2Attested`, C5-1), which is
   * false for every build while the versions are 1; tests inject it to drive the path (ADR v2 S4-4
   * addendum, section 0).
   */
  classifierV2Attested?: boolean;
  /** Test-only veto. A true value never substitutes for verified production evidence. */
  windowsApprovalInterlockForTesting?: boolean;
  /**
   * The effective eligibility mode, read at every use so that the V2 flag or the force-v1 variable
   * closes the approval path of a running process. Absent: the mode is read from the route the
   * session is bound to (a session is bound to v2 only when it was asked under the v2 deny-list).
   */
  effectiveEligibilityMode?: () => ComputerUseEligibilityMode;
  stopTimeoutMs?: number;
  windowsPhysicalBoundsToDip?: (bounds: ComputerUseNativeBounds) => ComputerUseNativeBounds;
}>;

// Keep internal semantic scroll out of the Controller/model action contract.
type NativeDispatchInput = Omit<Parameters<ComputerUseNativeHost['dispatch']>[0], 'action'> & {
  action:
    Parameters<ComputerUseNativeHost['dispatch']>[0]['action'] | ComputerUseSemanticScrollAction;
};
type InternalActionNativeHost = Omit<ComputerUseNativeHost, 'dispatch' | 'dispatchApproved'> & {
  dispatch(input: NativeDispatchInput): Promise<ComputerUseNativeActionResult>;
  dispatchApproved(
    input: NativeDispatchInput & { approvalGeneration: number },
  ): Promise<ComputerUseNativeActionResult>;
};

/**
 * Adapt the signed loader result to the Main controller contract.  The loader intentionally
 * exposes optional addon methods so malformed or older packages fail closed. A missing picker or
 * controller surface remains unavailable instead of being papered over with renderer-provided
 * paths or process identifiers.
 */
export function createComputerUseNativeHost(
  binding: ComputerUseNativeBinding,
  platform: NodeJS.Platform = process.platform,
  options: ComputerUseNativeHostOptions = {},
): InternalActionNativeHost & { restoreWindowsLedger(): Promise<boolean> } {
  const addon = binding.addon;
  const runtimePlatform = runtimePlatformFor(platform);
  const acceptanceMode = computerUseCompiledAcceptanceMode();
  const packageReady =
    binding.artifactPath !== null &&
    binding.manifest.nativeVersion !== 'disabled' &&
    (binding.manifest.signerDigest !== null ||
      computerUseWindowsSignerWaived(platform, binding.manifest.signerDigest));
  const pickerReady = hasMethod(addon, 'pickApplication');
  const coordinateReady = platform !== 'win32' || options.windowsPhysicalBoundsToDip !== undefined;
  const controllerReady =
    (platform !== 'win32' ||
      options.windowsKillStopTermination?.enabled !== true ||
      (options.windowsLedger !== undefined &&
        typeof addon?.configureWindowsTermination === 'function' &&
        typeof addon.requestWindowsTermination === 'function' &&
        typeof addon.cleanupWindowsGeneration === 'function')) &&
    coordinateReady &&
    pickerReady &&
    (platform === 'win32'
      ? binding.probe.capabilities.cancellableWindowDiscovery === true &&
        hasMethod(addon, 'discoverWindows') &&
        hasMethod(addon, 'stopWindowDiscovery') &&
        typeof addon?.cancelUnsubmittedDiscovery === 'function'
      : hasMethod(addon, 'listWindows')) &&
    hasMethod(addon, 'startSession') &&
    hasMethod(addon, 'stopPendingStart') &&
    hasMethod(addon, 'observe') &&
    hasMethod(addon, 'dispatch') &&
    hasMethod(addon, 'cancel') &&
    hasMethod(addon, 'close');
  const probeReady = binding.probe.available && binding.probe.capabilities.observe;
  // A protocol probe without the complete Main controller surface is not a usable handshake.
  // Keeping this gate closed also satisfies the availability invariant that a failed state must
  // not advertise all package/handshake gates as ready.
  const handshakeReady =
    packageReady &&
    binding.manifest.protocolVersion === 1 &&
    binding.manifest.apiVersion === 3 &&
    binding.probe.protocolVersion === 1 &&
    binding.probe.apiVersion === 3 &&
    addon !== null &&
    controllerReady;
  const sessions = new Map<string, InternalNativeSession>();
  const explorerSessionFacts = new WeakMap<InternalNativeSession, ExplorerEvidence['facts']>();
  const interactionRevoked = new Set<string>();
  const interactionListeners = new Set<WindowsInteractionListener>();
  const publishInteraction: WindowsInteractionListener = (event) => {
    if (event.kind === 'background_event' || event.state === 'failed')
      interactionRevoked.add(event.sessionId);
    for (const listener of interactionListeners) listener(event);
  };
  const roundTrips =
    platform === 'win32' && options.windowsApprovalRoundTripForTesting
      ? new ApprovalRoundTrips(async (wire) => {
          if (!addon?.approvalRoundTrip) throw new Error('Round trip unavailable');
          return addon.approvalRoundTrip(wire);
        }, publishInteraction)
      : undefined;
  if (platform === 'win32')
    // The helper is the binding authority (start/begin acknowledgement, generation, epochs, order)
    // and passes each revocation once. Latched here even before `sessions` holds the session, so
    // an event of a start still in flight is never dropped by one layer and kept by another.
    addon?.subscribeWindowsInteraction?.((event) => {
      if (event.kind === 'event' && roundTrips) roundTrips.receive(event);
      else publishInteraction(event);
    });
  const ledger = platform === 'win32' ? options.windowsLedger : undefined;
  const startIdentityEnabled =
    platform === 'win32' && options.windowsStartIdentity?.enabled === true;
  const terminationEnabled =
    ledger !== undefined && options.windowsKillStopTermination?.enabled === true;
  const ledgerStates = new Map<number, WindowsStopState>();
  let windowEvidenceSequence = 0;
  const discoveredWindows = new Map<
    string,
    {
      identity: WindowsTargetQuarantine['identity'];
      windowIdentityDigest: string;
    }
  >();
  const resumeTargets = new Map<string, WindowsTargetQuarantine['identity']>();
  const sameIdentity = (
    a: WindowsTargetQuarantine['identity'],
    b: WindowsTargetQuarantine['identity'],
  ) => a.pid === b.pid && a.creationTime === b.creationTime;
  const stopDelivery = new WindowsStopDelivery();
  let holdSequence = 0;
  const pendingWrites = new Map<
    string,
    {
      generation: number;
      write: () => boolean | Promise<boolean>;
      reflect?: (
        written: boolean,
        uncertain: boolean,
      ) => Pick<WindowsStopDecision, 'awaitingHoldId'>;
    }
  >();
  const writing = new Set<string>();
  const receiptCompletions = new Map<string, () => void>();
  const exitCompletions = new Map<number, Set<() => void>>();
  const receiptRows = new Set<string>();
  const uncertainWrites = new Set<WindowsLedgerRow>();
  const ledgerState = (generation: number): WindowsStopState => {
    let state = ledgerStates.get(generation);
    if (state === undefined) {
      // Without the termination seam these records only track dispatches.
      state = {
        helperGeneration: generation,
        helperLaunched: true,
        entry: null,
        stopOwnerId: '',
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
      };
      ledgerStates.set(generation, state);
    }
    return state;
  };
  const ledgerEvent = (
    generation: number,
    event: WindowsStopEvent,
    receiptOwner?: WindowsStopOwner,
  ) => {
    const current = ledgerState(generation);
    const previous =
      terminationEnabled && event.kind === 'receipt'
        ? { ...current, entry: stopDelivery.receiptEntry(generation, current.stopOwnerId) }
        : current;
    const decision = decideWindowsStop(previous, event);
    ledgerStates.set(generation, decision.state);
    // Evidence in another generation must also supersede an in-flight approval release.
    const evidence = decision.state.holds
      .filter((hold) => !previous.holds.includes(hold) && hold.operation !== 'release')
      .flatMap((hold) =>
        hold.changes
          .filter((change) => change.action === 'quarantine' || change.action === 'transfer')
          .map((change) => change.row.identity),
      );
    if (event.kind === 'input_unconfirmed') {
      const row = previous.rows.find(
        (row) =>
          row.sessionId === event.sessionId &&
          row.requestId === event.requestId &&
          row.inputPath === 'background_semantic',
      );
      if (row !== undefined && decision.pause) evidence.push(row.identity);
    }
    for (const q of decision.state.quarantines)
      if (!previous.quarantines.includes(q)) evidence.push(q.identity);
    if (evidence.length > 0)
      for (const [id, state] of ledgerStates) {
        ledgerStates.set(id, {
          ...state,
          holds: state.holds.map((hold) =>
            hold.releaseTarget !== undefined &&
            evidence.some((identity) => sameIdentity(identity, hold.releaseTarget!))
              ? { ...hold, releaseSuperseded: true }
              : hold,
          ),
        });
      }
    for (const diagnostic of decision.diagnostics) options.windowsLedgerDiagnostic?.(diagnostic);
    if (terminationEnabled) {
      if (decision.kind === 'receipt_confirmed' && receiptOwner !== undefined)
        stopDelivery.complete(generation, 'session', previous.stopOwnerId, receiptOwner.lifetimeId);
      ledgerStates.set(generation, stopDelivery.project(ledgerState(generation)));
      stopDelivery.deliver(decision);
    }
    for (const hold of previous.holds) {
      if (
        hold.operation === 'receipt_transfer' &&
        !decision.state.holds.some((remaining) => remaining.id === hold.id)
      ) {
        pendingWrites.delete(hold.id);
        const complete = receiptCompletions.get(hold.id);
        receiptCompletions.delete(hold.id);
        complete?.();
      }
    }
    if (
      terminationEnabled &&
      typeof decision.cleanup === 'object' &&
      decision.cleanup.kind === 'ready' &&
      decision.awaitingHoldId === null
    ) {
      const completions = exitCompletions.get(decision.cleanup.helperGeneration);
      exitCompletions.delete(decision.cleanup.helperGeneration);
      for (const complete of completions ?? []) complete();
      cleanupGeneration(decision.cleanup.helperGeneration);
      addon?.cleanupWindowsGeneration?.(decision.cleanup.helperGeneration);
      stopDelivery.cleanup(decision.cleanup.helperGeneration);
      ledgerStates.set(generation, stopDelivery.project(ledgerState(generation)));
    }
    return decision;
  };
  const tryWrite = async (write: () => boolean | Promise<boolean>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(write()).then((written) => written === true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), WINDOWS_LEDGER_STORAGE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  const retainRestoration = (generation: number, holdId: string): boolean => {
    const hold = ledgerState(generation).holds.find((item) => item.id === holdId);
    if (hold?.quarantinesToRestore === undefined) return false;
    const quarantines = hold.quarantinesToRestore;
    pendingWrites.set(holdId, {
      generation,
      write: () => ledger?.restoreQuarantines(quarantines) ?? false,
    });
    return true;
  };
  const writePending = async (holdId: string): Promise<void> => {
    const pending = pendingWrites.get(holdId);
    if (pending === undefined || writing.has(holdId)) return;
    writing.add(holdId);
    let settled = false;
    // Keep the writer claimed until the original I/O settles, even after the caller's deadline.
    const completion = Promise.resolve()
      .then(pending.write)
      .then(
        (written) => ({ written: written === true, uncertain: false }),
        () => ({ written: false, uncertain: true }),
      )
      .then(async ({ written, uncertain }) => {
        settled = true;
        const decision =
          pending.reflect?.(written, uncertain) ??
          ledgerEvent(pending.generation, {
            kind: 'retry_storage',
            holdId,
            status: written ? 'written' : 'failed',
            ...(uncertain ? { uncertain: true } : {}),
          });
        const restoration = retainRestoration(pending.generation, holdId);
        if (written && decision.awaitingHoldId === null && !restoration) {
          pendingWrites.delete(holdId);
          const complete = receiptCompletions.get(holdId);
          receiptCompletions.delete(holdId);
          complete?.();
        }
        writing.delete(holdId);
        // Response/cancellation writes can remove the final hold without an idle signal.
        addon?.reevaluateIdle?.();
        // A late obsolete release must land before its compensating quarantine write.
        if (restoration && pendingWrites.get(holdId)?.write !== pending.write && written)
          await writePending(holdId);
        return written;
      });
    await tryWrite(() => completion);
    if (!settled) {
      if (pending.reflect !== undefined) pending.reflect(false, true);
      else
        ledgerEvent(pending.generation, {
          kind: 'retry_storage',
          holdId,
          status: 'failed',
          uncertain: true,
        });
    }
  };
  // Separate startup/refresh states never represent a launched helper. Retrying a read must not
  // replay restart over a live generation's kill state, owners or pending transfers (R19/R7).
  let startupRead = false;
  let restoreTask: Promise<boolean> | undefined;
  const restoreWindowsLedger = async (): Promise<boolean> => {
    if (ledger?.read === undefined) return true;
    if (restoreTask !== undefined) return tryWrite(() => restoreTask!);
    const generation = startupRead ? -2 : -1;
    const readHold = `restore-read:${generation}`;
    const current = ledgerState(generation);
    ledgerStates.set(generation, { ...current, helperLaunched: false });
    if (!current.holds.some((hold) => hold.id === readHold))
      ledgerEvent(generation, { kind: 'store_unreadable', holdId: readHold, targets: 'unknown' });
    // A quarantine this Main holds without pending storage work is the shared row. Another Main's
    // persisted release (R15/R17/R24) deletes that row, so a later read must drop it here too.
    const settled = (q: WindowsTargetQuarantine) =>
      ![...uncertainWrites].some((row) => sameIdentity(row.identity, q.identity)) &&
      ![...ledgerStates.values()].some(
        (state) =>
          state.rows.some((row) => sameIdentity(row.identity, q.identity)) ||
          state.holds.some(
            (hold) =>
              !hold.id.startsWith('restore-read:') &&
              (hold.targets === 'unknown' ||
                hold.targets.some((target) => sameIdentity(target, q.identity))),
          ),
      );
    // Object identity: a quarantine added or re-added after this point is never dropped.
    const shared = new Set(
      [...ledgerStates.values()].flatMap((state) => state.quarantines).filter(settled),
    );
    const reconcileShared = (stored: readonly unknown[]) => {
      // A malformed stored row hides its identity; keep every in-memory quarantine (fail-closed).
      if (!stored.every(isStoredWindowsQuarantine)) return;
      const released = (q: WindowsTargetQuarantine) =>
        shared.has(q) &&
        settled(q) &&
        !stored.some((item) => sameIdentity(item.identity, q.identity));
      for (const [id, state] of ledgerStates)
        if (state.quarantines.some(released))
          ledgerStates.set(id, {
            ...state,
            quarantines: state.quarantines.filter((q) => !released(q)),
          });
    };
    const task = Promise.resolve()
      .then(async () => {
        const snapshot = startupRead
          ? {
              rows: [],
              quarantines:
                ledger.readQuarantines !== undefined
                  ? await ledger.readQuarantines()
                  : (await ledger.read!()).quarantines,
            }
          : await ledger.read!();
        if (!Array.isArray(snapshot.rows) || !Array.isArray(snapshot.quarantines)) return false;
        reconcileShared(snapshot.quarantines);
        const rows = snapshot.rows.filter(isStoredWindowsLedgerRow);
        const holdId = `restore-write:${++holdSequence}`;
        const event = {
          kind: 'restore_read',
          holdId: readHold,
          rows: snapshot.rows,
          quarantines: snapshot.quarantines,
        } as const;
        const preview = decideWindowsStop(ledgerState(generation), {
          ...event,
          storage: { status: 'written' },
        });
        const write = () => ledger.transferReceipt?.(rows, preview.state.quarantines) ?? false;
        let written = rows.length === 0;
        if (!written) {
          try {
            written = await write();
          } catch {
            written = false;
          }
        }
        const decision = ledgerEvent(generation, {
          ...event,
          storage: written ? { status: 'written' } : { status: 'failed', holdId },
        });
        startupRead = true;
        if (!written && decision.state.holds.some((hold) => hold.id === holdId))
          pendingWrites.set(holdId, { generation, write });
        return written;
      })
      .catch(() => false)
      .finally(() => {
        restoreTask = undefined;
      });
    restoreTask = task;
    return tryWrite(() => task);
  };
  const retryLedger = async (): Promise<void> => {
    await restoreWindowsLedger();
    let attempts = 0;
    for (const holdId of [...pendingWrites.keys()]) {
      const pending = pendingWrites.get(holdId);
      if (pending === undefined || writing.has(holdId)) continue;
      if (attempts === 2) break;
      attempts += 1;
      // Rotate attempted holds so a failing store cannot starve the later targets.
      pendingWrites.delete(holdId);
      pendingWrites.set(holdId, pending);
      if (
        pending.reflect !== undefined &&
        !ledgerState(pending.generation).holds.some((hold) => hold.id === holdId)
      ) {
        await writePending(holdId);
        continue;
      }
      const gate = ledgerEvent(pending.generation, {
        kind: 'retry_storage',
        holdId,
        status: 'before_write',
      });
      if (gate.refusal !== null) {
        if (gate.refusal === 'release_superseded' && !retainRestoration(pending.generation, holdId))
          pendingWrites.delete(holdId);
        continue;
      }
      await writePending(holdId);
    }
  };
  if (terminationEnabled && ledger !== undefined) {
    addon?.configureWindowsTermination?.({
      prepare: async (operation = 'work') => {
        // Stop on a live connection must not depend on storage availability or retry latency.
        // Reconnecting still uses the work gate, and generation termination stays fail-closed.
        if (operation !== 'stop_existing_helper') {
          await retryLedger();
          if (
            [...ledgerStates.values()].some((state) =>
              state.holds.some((hold) => hold.recovery === 'restore_store'),
            )
          )
            throw new Error('native_unavailable');
        }
        if ([...ledgerStates.values()].some((state) => state.killRequested && !state.exitConfirmed))
          throw new Error('native_stop_unconfirmed');
      },
      started: (generation) => {
        const state = ledgerState(generation);
        ledgerStates.set(generation, {
          ...state,
          helperGeneration: generation - 1,
          helperLaunched: false,
        });
        ledgerEvent(generation, { kind: 'start_generation', nextHelperGeneration: generation });
      },
      owned: (generation, kind, id) => {
        const registered = stopDelivery.register(generation, kind, id);
        if (kind === 'discovery') {
          discoveryManager.bindGeneration(id, generation);
          for (const owner of startOwners.values())
            if ([...owner.discoveries].some((discovery) => discovery.id === id)) {
              owner.helperGeneration ??= generation;
              owner.stopOwner ??= stopDelivery.register(generation, 'session', owner.sessionId);
            }
        } else if (kind === 'session') {
          const owner = startOwners.get(id);
          if (owner !== undefined) {
            owner.helperGeneration ??= generation;
            owner.stopOwner ??= registered;
          }
        }
        ledgerStates.set(generation, stopDelivery.project(ledgerState(generation)));
        return registered.lifetimeId;
      },
      completed: (generation, kind, id, lifetimeId) => {
        const state = ledgerState(generation);
        if (state.exitConfirmed || state.killRequested) return;
        stopDelivery.complete(generation, kind, id, lifetimeId);
        ledgerStates.set(generation, stopDelivery.project(state));
      },
      stopping: (generation, entry, ownerId) => {
        const state = ledgerState(generation);
        if (state.exitConfirmed) return;
        const startOwner =
          entry === 'E4'
            ? [...startOwners.values()].find((owner) =>
                [...owner.discoveries].some((discovery) => discovery.id === ownerId),
              )
            : undefined;
        stopDelivery.stop(
          generation,
          entry === 'E4' ? 'discovery' : 'session',
          ownerId,
          startOwner !== undefined
            ? sessions.has(startOwner.sessionId)
              ? 'E1'
              : 'E3'
            : entry === 'E1' && !sessions.has(ownerId)
              ? 'E2'
              : entry,
          startOwner?.stopOwner,
        );
        ledgerStates.set(generation, stopDelivery.project(state));
      },
      event: (generation, kind) => {
        if (kind === 'kill_requested') {
          pidsByIdentity.clear();
          discoveredWindows.clear();
        }
        ledgerEvent(generation, { kind, helperGeneration: generation });
      },
      exited: (generation, cause) => {
        const state = ledgerState(generation);
        if (state.exitConfirmed) return;
        pidsByIdentity.clear();
        discoveredWindows.clear();
        const rows = state.rows;
        const quarantines: WindowsTargetQuarantine[] = rows
          .filter((row) => row.kind !== 'foreground')
          .map((row) => ({ identity: row.identity, reason: 'exit_suspect' }));
        const holdId = `exit-${++holdSequence}`;
        ledgerStates.set(generation, {
          ...state,
          nativeBlockers: [
            ...state.nativeBlockers,
            {
              helperGeneration: generation,
              ownerId: holdId,
              kind: 'in_flight',
            },
          ],
        });
        // Classify at exit, before any await. Failed storage retains both rows and blockers.
        const decision = ledgerEvent(generation, {
          kind: 'exit_confirmed',
          helperGeneration: generation,
          cause,
          storage: rows.length === 0 ? { status: 'written' } : { status: 'failed', holdId },
        });
        if (rows.length === 0) return;
        // R23 creates no target hold and must not delay generation cleanup. Track the discard
        // separately so a healthy store deletes now and failed I/O can retry without isolation.
        const foregroundOnly = decision.awaitingHoldId === null;
        if (foregroundOnly) {
          for (const row of rows)
            receiptRows.add(`${generation}:${row.sessionId}:${row.requestId}`);
        }
        pendingWrites.set(holdId, {
          generation,
          ...(foregroundOnly
            ? {
                reflect: (written: boolean) => {
                  if (written) {
                    const state = ledgerState(generation);
                    ledgerStates.set(generation, {
                      ...state,
                      rows: state.rows.filter(
                        (row) =>
                          !rows.some(
                            (removed) =>
                              removed.helperGeneration === row.helperGeneration &&
                              removed.sessionId === row.sessionId &&
                              removed.requestId === row.requestId,
                          ),
                      ),
                    });
                    for (const row of rows)
                      receiptRows.delete(`${generation}:${row.sessionId}:${row.requestId}`);
                  }
                  return { awaitingHoldId: written ? null : holdId };
                },
              }
            : {}),
          write: async () => {
            // Response and dispatch_canceled both use response holds. Receipt holds are absorbed.
            if (ledgerState(generation).holds.some((hold) => hold.operation === 'response'))
              return false;
            if ([...uncertainWrites].some((row) => row.helperGeneration === generation))
              return false;
            if (ledger.transferReceipt !== undefined)
              return ledger.transferReceipt(rows, quarantines);
            if (quarantines.length !== 0) return false;
            for (const row of rows) if (!(await ledger.delete(row))) return false;
            return true;
          },
        });
        void writePending(holdId);
      },
    });
  }
  const targetGateState = (state: WindowsStopState): WindowsStopState => {
    if (!terminationEnabled || !state.exitConfirmed) return state;
    // R19c keeps the native blockers until transfer, but scopes admission to that hold's targets.
    return {
      ...state,
      nativeBlockers: state.nativeBlockers.filter(
        (blocker) =>
          !state.holds.some(
            (hold) =>
              hold.operation === 'exit_transfer' &&
              hold.releaseBlockers?.helperGeneration === blocker.helperGeneration,
          ),
      ),
    };
  };
  const ledgerBlocked = (pid: unknown, creationTime?: string | null): boolean =>
    [...uncertainWrites].some(
      (row) =>
        pid === undefined ||
        (row.identity.pid === pid &&
          (creationTime == null || row.identity.creationTime === creationTime)),
    ) ||
    [...ledgerStates.values()].some((state) =>
      creationTime != null && typeof pid === 'number'
        ? !windowsTargetMayStart(targetGateState(state), { pid, creationTime })
        : state.holds.some(
            (hold) =>
              hold.targets === 'unknown' ||
              hold.targets.some((t) => pid === undefined || t.pid === pid),
          ),
    );
  const prepareTargetAdmission = async (
    input: Readonly<Record<string, unknown>>,
    refresh = true,
  ): Promise<() => void> => {
    if (ledger === undefined) return () => undefined;
    if (refresh) await restoreWindowsLedger();
    const pid = input['pid'];
    const creationTime =
      typeof input['processStartTime'] === 'string' ? input['processStartTime'] : undefined;
    const key = (identity: WindowsTargetQuarantine['identity']) =>
      `${identity.pid}:${identity.creationTime}`;
    const quarantines = () =>
      [...ledgerStates.values()]
        .flatMap((state) => state.quarantines)
        .filter(
          (item) =>
            item.identity.pid === pid &&
            (creationTime === undefined || item.identity.creationTime === creationTime),
        );
    const assertAdmission = () => {
      const blocked =
        pid === undefined
          ? [...ledgerStates.values()].some((state) =>
              state.holds.some((hold) => hold.targets === 'unknown'),
            )
          : ledgerBlocked(pid, creationTime);
      if (blocked || quarantines().length !== 0)
        throw new ComputerUseNativeUnavailableError('native_unavailable');
    };
    // A new start has no creation time yet. Check the stored pair, never treat PID alone as
    // identity: persist the core's R15 release before permitting PID reuse.
    if (creationTime === undefined) {
      const seen = new Set<string>();
      for (const { identity } of quarantines()) {
        if (seen.has(key(identity))) continue;
        seen.add(key(identity));
        if (addon?.checkTargetIdentity === undefined)
          throw new ComputerUseNativeUnavailableError('native_unavailable');
        const result = await addon
          .checkTargetIdentity([{ pid: identity.pid, processStartTime: identity.creationTime }])
          .catch(() => {
            throw new ComputerUseNativeUnavailableError('native_unavailable');
          });
        if (result.length !== 1 || result[0]?.result !== 'terminated')
          throw new ComputerUseNativeUnavailableError('native_unavailable');
        const evidence =
          result[0].reason === 'signaled'
            ? 'signaled'
            : result[0].reason === 'start_time_mismatch'
              ? 'creation_mismatch'
              : 'pid_absent';
        for (const [generation, state] of ledgerStates) {
          if (!state.quarantines.some((item) => key(item.identity) === key(identity))) continue;
          const holdId = `reconcile:${++holdSequence}`;
          ledgerEvent(generation, {
            kind: 'reconcile',
            identity,
            evidence,
            storage: { status: 'failed', holdId },
          });
          pendingWrites.set(holdId, {
            generation,
            write: () => ledger.releaseQuarantine?.(identity) ?? false,
          });
          await writePending(holdId);
        }
      }
    }
    assertAdmission();
    return assertAdmission;
  };
  if (ledger !== undefined)
    // Discovery enumerates windows; exclude quarantined candidates individually, not by cached PID.
    addon?.configureWindowsAdmission?.((input) =>
      input['discoveryId'] === undefined
        ? prepareTargetAdmission(input)
        : prepareTargetAdmission({}, false),
    );
  const admissionBatch = () => {
    const checks = new Map<string, Promise<() => void>>();
    return (input: Readonly<Record<string, unknown>>) => {
      const key = `${String(input['pid'])}:${String(input['processStartTime'])}`;
      let check = checks.get(key);
      if (check === undefined) {
        check = prepareTargetAdmission(input, false);
        checks.set(key, check);
      }
      return check;
    };
  };
  const checkDiscoveredTargets = async (value: readonly unknown[]): Promise<readonly unknown[]> => {
    if (ledger === undefined) return value;
    const prepare = admissionBatch();
    const admitted: Array<{ candidate: unknown; check: () => void }> = [];
    for (const candidate of value) {
      const raw = asRecord(candidate, 'native_window_invalid');
      try {
        admitted.push({ candidate, check: await prepare(raw) });
      } catch (error) {
        // Exclude this target only; an unexpected failure is not a refusal and must surface.
        if (!(error instanceof ComputerUseNativeUnavailableError)) throw error;
      }
    }
    return admitted.flatMap(({ candidate, check }) => {
      try {
        check();
        return [candidate];
      } catch (error) {
        if (!(error instanceof ComputerUseNativeUnavailableError)) throw error;
        return [];
      }
    });
  };
  const inputLedger = (
    input: Readonly<{
      sessionId: string;
      identity: WindowsLedgerRow['identity'] | null;
      path: WindowsLedgerPath;
      stopped(): boolean;
    }>,
  ): (WindowsDispatchCallbacks & { completed(): Promise<void> }) | undefined => {
    if (ledger === undefined) return undefined;
    let row: WindowsLedgerRow | undefined;
    const identity = input.identity;
    const deny = (stopped = false): never => {
      throw Object.assign(new ComputerUseNativeUnavailableError('native_unavailable'), {
        code: stopped ? 'NATIVE_STOP_UNCONFIRMED' : 'UNAVAILABLE',
        accepted: false,
      });
    };
    const assertSend = () => {
      if (input.stopped() || inputQuarantined() || startOwners.get(input.sessionId)?.stopped)
        deny(true);
      if (row === undefined || ledgerBlocked(identity?.pid, identity?.creationTime)) deny();
      if (
        row !== undefined &&
        ledgerEvent(row.helperGeneration, {
          kind: 'dispatch_gate',
          helperGeneration: row.helperGeneration,
          identity,
        }).dispatch !== 'allow'
      )
        deny();
    };
    const reflect = async (status: 'success' | 'rejected' | 'effect_unconfirmed' | 'canceled') => {
      const current = row;
      if (current === undefined) return;
      // A validated receipt owns these rows until its write (or retry) completes. A late
      // dispatch response must not race that transaction and recreate a deleted source row.
      if (receiptRows.has(`${current.helperGeneration}:${current.sessionId}:${current.requestId}`))
        return;
      if (
        !ledgerState(current.helperGeneration).rows.some(
          (item) =>
            item.helperGeneration === current.helperGeneration &&
            item.sessionId === current.sessionId &&
            item.requestId === current.requestId,
        )
      )
        return;
      const holdId = `dispatch-write-${++holdSequence}`;
      const storage = { status: 'failed', holdId } as const;
      // Install the hold before awaiting I/O so a concurrent start cannot slip through.
      ledgerEvent(
        current.helperGeneration,
        status === 'canceled'
          ? {
              kind: 'dispatch_canceled',
              helperGeneration: current.helperGeneration,
              sessionId: current.sessionId,
              requestId: current.requestId,
              storage,
            }
          : status === 'rejected'
            ? {
                kind: 'response',
                helperGeneration: current.helperGeneration,
                sessionId: current.sessionId,
                requestId: current.requestId,
                storage,
                status,
                accepted: false,
              }
            : {
                kind: 'response',
                helperGeneration: current.helperGeneration,
                sessionId: current.sessionId,
                requestId: current.requestId,
                storage,
                status,
                accepted: true,
              },
      );
      // K-1 (a): a background row's unconfirmed effect also quarantines its target. The core put
      // that quarantine on this hold; write it with the row update in one transaction (R21).
      const changes =
        ledgerState(current.helperGeneration).holds.find((hold) => hold.id === holdId)?.changes ??
        [];
      const quarantines: WindowsTargetQuarantine[] = changes.flatMap((change) =>
        change.action === 'quarantine'
          ? [{ identity: change.row.identity, reason: change.reason }]
          : [],
      );
      const updated = changes.find((change) => change.action === 'effect_unconfirmed')?.row;
      const write = () =>
        status !== 'effect_unconfirmed'
          ? ledger.delete(current)
          : quarantines.length === 0
            ? ledger.update({ ...(updated ?? current), state: 'effect_unconfirmed' })
            : (ledger.updateWithQuarantines?.(
                { ...(updated ?? current), state: 'effect_unconfirmed' },
                quarantines,
              ) ?? false);
      // R23 foreground rows are never a target basis (K-4): the core keeps the row but creates no
      // hold, so retry_storage has nothing to retry. Like exited(), reflect the write here and
      // keep a self-reflecting retry while storage fails.
      const present = () =>
        ledgerState(current.helperGeneration).rows.some(
          (item) =>
            item.helperGeneration === current.helperGeneration &&
            item.sessionId === current.sessionId &&
            item.requestId === current.requestId,
        );
      // A stale retry must not upsert a row that a later reflect or exit already removed.
      const writeForeground = async () => !present() || (await write());
      const reflectForeground = (written: boolean) => {
        if (written) {
          const state = ledgerState(current.helperGeneration);
          ledgerStates.set(current.helperGeneration, {
            ...state,
            rows: state.rows.flatMap((item) =>
              item.helperGeneration !== current.helperGeneration ||
              item.sessionId !== current.sessionId ||
              item.requestId !== current.requestId
                ? [item]
                : status === 'effect_unconfirmed'
                  ? [{ ...item, state: 'effect_unconfirmed' as const }]
                  : [],
            ),
          });
        }
        return { awaitingHoldId: written ? null : holdId };
      };
      pendingWrites.set(
        holdId,
        current.kind === 'foreground'
          ? {
              generation: current.helperGeneration,
              write: writeForeground,
              reflect: reflectForeground,
            }
          : { generation: current.helperGeneration, write },
      );
      await writePending(holdId);
    };
    return {
      beforeWrite: async (helperGeneration, requestId) => {
        if (input.stopped() || inputQuarantined() || startOwners.get(input.sessionId)?.stopped)
          deny(true);
        if (ledgerBlocked(identity?.pid, identity?.creationTime)) deny();
        if (
          ledgerEvent(helperGeneration, { kind: 'dispatch_gate', helperGeneration, identity })
            .dispatch !== 'allow' ||
          identity === null
        )
          deny();
        if (identity === null) return;
        const candidate: WindowsLedgerRow = {
          helperGeneration,
          sessionId: input.sessionId,
          requestId,
          identity,
          ...input.path,
          state: 'awaiting_response',
        };
        // The row key must stay unique; never let a second row overwrite a stored one.
        if (
          ledgerState(helperGeneration).rows.some(
            (item) => item.sessionId === candidate.sessionId && item.requestId === requestId,
          )
        )
          deny();
        let settled = false;
        const pending = Promise.resolve()
          .then(() => ledger.write(candidate))
          .then(
            (written) => {
              settled = true;
              return written === true;
            },
            () => {
              // A rejected write has settled before socket.write: no input was sent. Unlike a
              // deadline, it has no outstanding completion to await; restart handles any stale row.
              settled = true;
              return false;
            },
          );
        const stored = await tryWrite(() => pending);
        if (!settled) {
          // A deadline cannot cancel storage I/O. Keep this target held until the late write
          // settles and, if it landed, the definitely unsent row has entered cancellation.
          uncertainWrites.add(candidate);
          void pending
            .then(async (written) => {
              if (written) {
                ledgerEvent(helperGeneration, {
                  kind: 'before_dispatch',
                  helperGeneration,
                  sessionId: candidate.sessionId,
                  requestId,
                  identity,
                  input: input.path,
                  storage: { status: 'written' },
                });
                row = candidate;
                await reflect('canceled');
              }
              uncertainWrites.delete(candidate);
            })
            .catch(() => {
              /* Retain the target hold if late cancellation cannot be recorded. */
            });
          deny();
        }
        const decision = ledgerEvent(helperGeneration, {
          kind: 'before_dispatch',
          helperGeneration,
          sessionId: candidate.sessionId,
          requestId,
          identity,
          input: input.path,
          storage: stored
            ? { status: 'written' }
            : { status: 'failed', holdId: `dispatch-write-${++holdSequence}` },
        });
        if (stored) row = candidate;
        if (decision.dispatch !== 'allow') deny();
        assertSend();
      },
      assertSend,
      canceled: () => reflect('canceled'),
      unconfirmed: (cause) => {
        const current = row;
        if (current !== undefined)
          queueWindowsInputQuarantine({
            row: current,
            cause,
            holdId: `input-quarantine-${++holdSequence}`,
            apply: (event) => ledgerEvent(current.helperGeneration, event),
            persist: (quarantines) => ledger.restoreQuarantines(quarantines),
            enqueue: (generation, holdId, write) => {
              pendingWrites.set(holdId, { generation, write });
              void writePending(holdId);
            },
          });
      },
      response: (accepted) => reflect(accepted ? 'effect_unconfirmed' : 'rejected'),
      completed: () => reflect('success'),
    };
  };
  const dispatchLedger = (input: NativeDispatchInput, internal: InternalNativeSession) => {
    if (
      internal.inputSession?.kind === 'background' &&
      (ledger === undefined ||
        input.inputKind === 'paste' ||
        !['invoke', 'set_text', 'select', 'toggle', 'expand_collapse', 'semantic_scroll'].includes(
          input.action.type,
        ))
    )
      throw Object.assign(new ComputerUseNativeUnavailableError('native_unavailable'), {
        code: 'UNAVAILABLE',
        accepted: false,
      });
    return inputLedger({
      sessionId: input.session.sessionId,
      identity:
        typeof internal.raw['pid'] === 'number' && typeof internal.raw.processStartTime === 'string'
          ? { pid: internal.raw['pid'], creationTime: internal.raw.processStartTime }
          : null,
      stopped: () => input.signal.aborted,
      path: {
        kind:
          input.inputKind === 'paste'
            ? 'paste'
            : [
                  'invoke',
                  'set_text',
                  'select',
                  'toggle',
                  'expand_collapse',
                  'semantic_scroll',
                ].includes(input.action.type)
              ? 'semantic'
              : 'SendInput',
        inputPath: internal.inputSession?.kind === 'background' ? 'background_semantic' : 'normal',
      },
    });
  };
  const pidsByIdentity = new Map<string, number>();
  const revisionsBySession = new Map<string, number>();
  const inputAttemptsBySession = new Map<string, number>();
  // The classifier route each session was bound to at creation, and the classifierVersion that
  // route makes Main accept. Never changed after the first binding; dropped on a verified close.
  // `starts` holds one owner token per start of the session that is still in flight, so a failed
  // start takes the binding back only when it is the last one and no session came of it.
  const classifierBindings = new Map<
    string,
    Readonly<{ route: 'v1' | 'v2'; expectedVersion: 1 | 2; starts: Set<symbol> }>
  >();
  const stopEpochs = new Map<string, number>();
  const confirmedClosed = new Set<string>();
  type StartOwner = {
    stopOwner?: WindowsStopOwner;
    helperGeneration: number | null;
    terminated: boolean;
    receiptConfirmed: boolean;
    sessionId: string;
    binding: string;
    route: 'v1' | 'v2' | undefined;
    attempts: Set<symbol>;
    stopped: boolean;
    nativeInvoked: boolean;
    discoveryPending: number;
    discoveryUnconfirmed: boolean;
    discoveries: Set<ComputerUseDiscoveryHandle<readonly unknown[]>>;
    knownEpoch: number;
    terminalEpoch: number;
    terminal: ComputerUsePendingStartStop | null;
    nativeTerminal: ComputerUsePendingStartStop | null;
    nativeTerminalEvidence: unknown;
    unconfirmed: boolean;
    foregroundUnconfirmed?: boolean;
    stopPromise: Promise<ComputerUsePendingStartStop> | null;
  };
  const startOwners = new Map<string, StartOwner>();
  const activeStopQuarantines = new Set<string>();
  const preparingDiscoveries = new Map<string, { stopped: boolean }>();
  const discoveryManager = createComputerUseDiscoveryManager({
    query: async (id, input) => {
      if (ledger !== undefined) {
        const preparation = { stopped: false };
        preparingDiscoveries.set(id, preparation);
        try {
          await retryLedger();
          if (preparation.stopped)
            throw new ComputerUseDiscoveryNotSubmittedError(
              'Discovery canceled before storage retry',
            );
        } finally {
          preparingDiscoveries.delete(id);
        }
      }
      let method: (input: unknown) => unknown;
      try {
        method = requireMethod('discoverWindows');
      } catch (cause) {
        throw new ComputerUseDiscoveryNotSubmittedError(
          'Native discovery unavailable before invocation',
          { cause },
        );
      }
      if (ledger !== undefined) {
        const assertAdmission = await prepareTargetAdmission({}, false).catch((cause: unknown) => {
          throw new ComputerUseDiscoveryNotSubmittedError('native_unavailable', { cause });
        });
        assertAdmission();
      }
      return await Promise.resolve(method({ ...input, discoveryId: id }));
    },
    stop: async (id) => await invoke('stopWindowDiscovery', { discoveryId: id }),
    cancelUnsubmitted: (id) => {
      const preparation = preparingDiscoveries.get(id);
      if (preparation !== undefined) {
        preparation.stopped = true;
        return 'never_sent';
      }
      return addon?.cancelUnsubmittedDiscovery?.(id) ?? 'unknown';
    },
    timeoutMs: options.stopTimeoutMs ?? COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
    attemptLimit: terminationEnabled ? 1 : COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
    retainStop: terminationEnabled,
    unconfirmedError: () => new ComputerUseNativeUnavailableError('native_stop_unconfirmed'),
    ...(terminationEnabled
      ? {
          terminate: async (generation: number) => {
            const result = await stopWithTermination(
              async () => {
                throw new Error('native_stop_unconfirmed');
              },
              () => generation,
            );
            if (result.kind === 'termination_requested')
              throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
            return result;
          },
          terminationResult: (generation: number) =>
            ledgerState(generation).result === 'terminated_target_suspect'
              ? 'terminated_target_suspect'
              : 'terminated_clean',
          generationAvailable: (generation: number) => !ledgerState(generation).exitConfirmed,
          generationKillRequested: (generation: number) => ledgerState(generation).killRequested,
        }
      : {}),
  });
  const semanticUnconfirmed = (): boolean => addon?.hasUnconfirmedSemanticInputs?.() === true;
  const cleanupGeneration = (generation: number): void => {
    for (const [id, owner] of startOwners) {
      if (owner.helperGeneration !== generation || owner.terminated) continue;
      owner.terminated = true;
      owner.terminal = {
        kind: 'terminated',
        helperGeneration: generation,
        result:
          ledgerState(generation).result === 'terminated_target_suspect'
            ? 'terminated_target_suspect'
            : 'terminated_clean',
      };
      owner.stopped = true;
      owner.unconfirmed = false;
      owner.discoveryUnconfirmed = false;
      owner.nativeTerminalEvidence = null;
      owner.discoveries.clear();
      sessions.delete(id);
      classifierBindings.delete(id);
      inputAttemptsBySession.delete(id);
      stopEpochs.delete(id);
      revisionsBySession.delete(id);
      activeStopQuarantines.delete(id);
      confirmedClosed.add(id);
      interactionRevoked.delete(id);
      if (confirmedClosed.size > 128)
        confirmedClosed.delete(confirmedClosed.values().next().value!);
    }
    discoveryManager.terminateGeneration(generation);
  };
  const inputQuarantined = (): boolean =>
    semanticUnconfirmed() ||
    activeStopQuarantines.size !== 0 ||
    discoveryManager.quarantined() ||
    [...startOwners.values()].some(
      (owner) =>
        !owner.terminated &&
        owner.stopped &&
        (owner.unconfirmed ||
          owner.discoveryUnconfirmed ||
          owner.terminal === null ||
          owner.attempts.size !== 0),
    );

  const startBinding = (input: Parameters<ComputerUseNativeHost['startSession']>[0]): string =>
    JSON.stringify([
      input.profile.platform,
      input.profile.identityDigest,
      input.profile.canonicalPath,
      input.profile.revision,
      input.windowId,
      input.taskId,
      input.turnId,
    ]);

  const assertStartOwner = (owner: StartOwner): void => {
    if (
      terminationEnabled &&
      owner.helperGeneration !== null &&
      ledgerState(owner.helperGeneration).exitConfirmed &&
      !owner.terminated
    )
      throw new ComputerUseNativeUnavailableError('native_unavailable');
    if (startOwners.get(owner.sessionId) !== owner || owner.stopped)
      throw new ComputerUseNativeUnavailableError('native_start_canceled');
  };

  // Session completion never substitutes for a discovery's own terminal evidence.
  const latchStartOwner = (owner: StartOwner): void => {
    owner.stopped = true;
    if (platform === 'win32' && owner.discoveries.size !== 0) owner.discoveryUnconfirmed = true;
    for (const discovery of owner.discoveries) void discovery.stop().catch(() => undefined);
  };

  const trimStartOwners = (): void => {
    for (const [id, owner] of startOwners) {
      if (startOwners.size < 128) break;
      if (
        (owner.terminal !== null || owner.terminated) &&
        !owner.unconfirmed &&
        !owner.discoveryUnconfirmed &&
        owner.attempts.size === 0
      ) {
        startOwners.delete(id);
        resumeTargets.delete(id);
      }
    }
  };

  const confirmSessionClosed = (
    receipt: ComputerUseNativeInputReceipt,
    evidence: unknown,
  ): void | Promise<WindowsCloseConfirmation> => {
    try {
      return addon?.confirmSessionClosed?.(receipt, evidence)?.catch(() => {
        throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
      });
    } catch {
      throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
    }
  };

  if (ledger !== undefined) {
    addon?.configureCloseLedger?.({
      received: (generation, sessionId) => {
        const state = ledgerState(generation);
        if (terminationEnabled && state.exitConfirmed) return;
        ledgerStates.set(generation, {
          ...state,
          stopOwnerId: sessionId,
          nativeBlockers: state.nativeBlockers.some((blocker) => blocker.ownerId === sessionId)
            ? state.nativeBlockers
            : [
                ...state.nativeBlockers,
                { helperGeneration: generation, ownerId: sessionId, kind: 'activeStopQuarantines' },
              ],
        });
        ledgerEvent(generation, {
          kind: 'receipt',
          helperGeneration: generation,
          status: 'received',
          closeDeadlineExceeded: false,
          storage: { status: 'written' },
        });
      },
      blocked: (generation) => {
        const state = ledgerState(generation);
        return (
          state.rows.length !== 0 ||
          state.holds.length !== 0 ||
          state.nativeBlockers.length !== 0 ||
          [...pendingWrites.values()].some((pending) => pending.generation === generation)
        );
      },
      verified: async (generation, sessionId, persisted) => {
        const receiptOwner = stopDelivery.find(generation, 'session', sessionId);
        if (!terminationEnabled || !ledgerState(generation).exitConfirmed) await retryLedger();
        const state = ledgerState(generation);
        if (terminationEnabled && state.exitConfirmed) {
          // R13: only subscribe to the exit's existing transfer; never submit another receipt.
          if (!state.holds.some((hold) => hold.operation === 'exit_transfer'))
            return { status: 'confirmed' };
          let completions = exitCompletions.get(generation);
          if (completions === undefined) {
            completions = new Set();
            exitCompletions.set(generation, completions);
          }
          completions.add(persisted);
          return { status: 'pending' };
        }
        const rows = state.rows.filter((row) => row.sessionId === sessionId);
        const quarantines: WindowsTargetQuarantine[] = rows
          .filter((row) => row.inputPath === 'background_semantic')
          .map((row) => ({
            identity: row.identity,
            reason: row.state === 'effect_unconfirmed' ? 'effect_unconfirmed' : 'response_lost',
          }));
        const holdId = `receipt-${++holdSequence}`;
        for (const row of rows) receiptRows.add(`${generation}:${row.sessionId}:${row.requestId}`);
        receiptCompletions.set(holdId, () => {
          for (const row of rows)
            receiptRows.delete(`${generation}:${row.sessionId}:${row.requestId}`);
          if (!terminationEnabled || !ledgerState(generation).killRequested)
            activeStopQuarantines.delete(sessionId);
          persisted();
        });
        pendingWrites.set(holdId, {
          generation,
          reflect: (written, uncertain) => {
            const current = ledgerState(generation);
            if (current.holds.some((hold) => hold.id === holdId))
              return ledgerEvent(generation, {
                kind: 'retry_storage',
                holdId,
                status: written ? 'written' : 'failed',
                ...(uncertain ? { uncertain: true } : {}),
              });
            if (!terminationEnabled || !current.exitConfirmed)
              ledgerStates.set(generation, { ...current, stopOwnerId: sessionId });
            const decision = ledgerEvent(
              generation,
              {
                kind: 'receipt',
                helperGeneration: generation,
                status: 'verified',
                closeDeadlineExceeded: false,
                storage: written ? { status: 'written' } : { status: 'failed', holdId },
              },
              receiptOwner,
            );
            const owner = startOwners.get(sessionId);
            if (decision.confirmation === 'host_receipt' && owner?.helperGeneration === generation)
              owner.receiptConfirmed = true;
            return decision;
          },
          write: async () => {
            const current = ledgerState(generation);
            // Exit owns the transfer once it includes this session's rows.
            if (
              current.holds.some(
                (hold) =>
                  hold.operation === 'exit_transfer' &&
                  hold.changes.some((change) => change.row.sessionId === sessionId),
              )
            )
              return false;
            if (current.exitConfirmed && !current.rows.some((row) => row.sessionId === sessionId))
              return true;
            // Older response writes must finish before receipt deletes their rows.
            if (
              ledgerState(generation).holds.some(
                (hold) =>
                  hold.id !== holdId &&
                  hold.changes.some((change) => change.row.sessionId === sessionId),
              )
            )
              return false;
            if (rows.length === 0) return true;
            if (ledger.transferReceipt !== undefined)
              return ledger.transferReceipt(rows, quarantines);
            if (quarantines.length !== 0) return false;
            for (const row of rows) if (!(await ledger.delete(row))) return false;
            return true;
          },
        });
        await writePending(holdId);
        return { status: pendingWrites.has(holdId) ? 'pending' : 'confirmed' };
      },
    });
  }

  const finishStartOwner = (
    owner: StartOwner,
    result: ComputerUsePendingStartStop,
  ): void | Promise<void> => {
    if (owner.terminated) return;
    const confirmation =
      result.kind === 'closed'
        ? confirmSessionClosed(result.inputReceipt, owner.nativeTerminalEvidence)
        : undefined;
    const finish = (): void => {
      if (owner.terminated) return;
      if (
        terminationEnabled &&
        !owner.receiptConfirmed &&
        owner.helperGeneration !== null &&
        (ledgerState(owner.helperGeneration).killRequested ||
          ledgerState(owner.helperGeneration).exitConfirmed)
      )
        throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
      owner.nativeTerminalEvidence = null;
      sessions.delete(owner.sessionId);
      classifierBindings.delete(owner.sessionId);
      inputAttemptsBySession.delete(owner.sessionId);
      stopEpochs.delete(owner.sessionId);
      revisionsBySession.delete(owner.sessionId);
      activeStopQuarantines.delete(owner.sessionId);
      owner.terminal = result;
      owner.unconfirmed = false;
      if (terminationEnabled && result.kind === 'not_submitted' && owner.stopOwner !== undefined) {
        const registered = owner.stopOwner;
        stopDelivery.complete(
          registered.helperGeneration,
          registered.kind,
          registered.id,
          registered.lifetimeId,
        );
        ledgerStates.set(
          registered.helperGeneration,
          stopDelivery.project(ledgerState(registered.helperGeneration)),
        );
      }
      confirmedClosed.add(owner.sessionId);
      interactionRevoked.delete(owner.sessionId);
      if (confirmedClosed.size > 128) {
        const oldest = confirmedClosed.values().next().value;
        if (oldest !== undefined) confirmedClosed.delete(oldest);
      }
      trimStartOwners();
    };
    return confirmation === undefined ? finish() : confirmation.then(finish);
  };

  const stopWithTermination = async <T>(
    work: () => Promise<T>,
    generationOf: () => number | null | undefined,
  ): Promise<T | ComputerUseGenerationTerminated | Readonly<{ kind: 'termination_requested' }>> => {
    if (!terminationEnabled) return work();
    const outcome = (generation: number | null | undefined) => {
      if (generation == null)
        throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
      const state = ledgerState(generation);
      return state.exitConfirmed
        ? {
            kind: 'terminated' as const,
            helperGeneration: generation,
            result:
              state.result === 'terminated_target_suspect'
                ? ('terminated_target_suspect' as const)
                : ('terminated_clean' as const),
          }
        : { kind: 'termination_requested' as const };
    };
    const started = generationOf();
    if (started != null && ledgerState(started).exitConfirmed) return outcome(started);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('native_stop_unconfirmed')),
            options.stopTimeoutMs ?? COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (failure) {
      // Both timeout and work() rejection enter here. With no initial owner, intentionally
      // replace even work()'s original error with native_stop_unconfirmed: inability to prove
      // Stop takes priority, and the caller discards the session handle as on close failure.
      // The replaced error stays as the cause for diagnostics.
      // Fixed for the whole kill wait: the owner may be gone or replaced by another generation.
      // Without an owner before the race, a later owner may belong to a newer helper than the
      // one work() addressed, so the Stop stays unconfirmed (fail-closed).
      const generation = started;
      if (generation == null)
        throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed', { cause: failure });
      if (ledgerState(generation).exitConfirmed) return outcome(generation);
      // Subscribe before kill: exit may be synchronous, and storage cleanup is independent.
      return await new Promise<ReturnType<typeof outcome>>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          unsubscribe();
          clearTimeout(wait);
          try {
            resolve(outcome(generation));
          } catch (error) {
            reject(error);
          }
        };
        const unsubscribe = stopDelivery.subscribe((event) => {
          if (
            event.kind === 'notification' &&
            event.notification.owner.helperGeneration === generation &&
            (event.notification.phase === 'exit_confirmed' ||
              ledgerState(generation).exitWaitExceeded)
          )
            finish();
        });
        const wait = setTimeout(finish, 2_000);
        addon?.requestWindowsTermination?.();
        if (ledgerState(generation).exitConfirmed || ledgerState(generation).exitWaitExceeded)
          finish();
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const completeNativePendingStop = async (
    owner: StartOwner,
  ): Promise<ComputerUsePendingStartStop> => {
    if (owner.terminal !== null) return owner.terminal;
    if (owner.nativeTerminal !== null) return owner.nativeTerminal;
    const active = sessions.get(owner.sessionId);
    const neverSent =
      !owner.nativeInvoked ||
      (platform === 'win32' && addon?.cancelUnsubmittedStart?.(owner.sessionId) === 'never_sent');
    if (active === undefined && neverSent) {
      const result: ComputerUsePendingStartStop = { kind: 'not_submitted' };
      owner.nativeTerminal = result;
      return result;
    }
    owner.unconfirmed = true;
    let failure: unknown = new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
    for (
      let attempt = 0;
      attempt < (terminationEnabled ? 1 : COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT);
      attempt += 1
    ) {
      try {
        const evidence = await stopWithDeadline('stopPendingStart', { sessionId: owner.sessionId });
        const result = computerUseNativeCloseReceiptSchema.safeParse(evidence);
        const lowerEpoch = Math.max(owner.knownEpoch, stopEpochs.get(owner.sessionId) ?? 0);
        const lowerCount = inputAttemptsBySession.get(owner.sessionId) ?? 0;
        if (
          !result.success ||
          result.data.sessionId !== owner.sessionId ||
          result.data.cancelEpoch <= lowerEpoch ||
          result.data.cancelEpoch < owner.terminalEpoch ||
          result.data.inputAttemptCount < lowerCount
        )
          throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
        owner.terminalEpoch = result.data.cancelEpoch;
        const outcome: ComputerUsePendingStartStop = {
          kind: 'closed',
          inputReceipt: {
            sessionId: result.data.sessionId,
            cancelEpoch: result.data.cancelEpoch,
            inputAttemptCount: result.data.inputAttemptCount,
          },
        };
        owner.nativeTerminalEvidence = evidence;
        owner.nativeTerminal = outcome;
        return outcome;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  };

  const stopOwnerDiscoveries = async (owner: StartOwner): Promise<void> => {
    const results = await Promise.allSettled(
      [...owner.discoveries].map(async (discovery) => {
        await discovery.stop();
        owner.discoveries.delete(discovery);
      }),
    );
    owner.discoveryUnconfirmed =
      owner.discoveries.size !== 0 && results.some((result) => result.status === 'rejected');
    if (owner.discoveryUnconfirmed)
      throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
  };

  const terminatedStart = (owner: StartOwner | undefined) =>
    owner?.terminal?.kind === 'terminated' ? owner.terminal : undefined;

  const completePendingStop = async (owner: StartOwner): Promise<ComputerUsePendingStartStop> => {
    if (owner.terminal !== null) return owner.terminal;
    owner.unconfirmed = true;
    // Independent native lifetimes stop concurrently; neither proof stands in for the other.
    const operations = [stopOwnerDiscoveries(owner), completeNativePendingStop(owner)] as const;
    const [discovery, native] = await (terminationEnabled
      ? Promise.all(operations).then(
          ([discovery, native]) =>
            [
              { status: 'fulfilled' as const, value: discovery },
              { status: 'fulfilled' as const, value: native },
            ] as const,
        )
      : Promise.allSettled(operations));
    if (owner.terminated && owner.terminal !== null) return owner.terminal;
    if (owner.terminal !== null) return owner.terminal;
    if (discovery.status === 'rejected' || native.status === 'rejected')
      throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
    const finishing = finishStartOwner(owner, native.value);
    if (finishing !== undefined) await finishing;
    if (owner.terminated && owner.terminal !== null) return owner.terminal;
    return native.value;
  };

  const stopStartOwner = (owner: StartOwner): Promise<ComputerUsePendingStartStop> => {
    if (owner.terminated && owner.terminal !== null) return Promise.resolve(owner.terminal);
    if (owner.stopPromise !== null) return owner.stopPromise;
    let resolveStop!: (value: ComputerUsePendingStartStop) => void;
    let rejectStop!: (error: unknown) => void;
    const stopping = new Promise<ComputerUsePendingStartStop>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    owner.stopPromise = stopping;
    latchStartOwner(owner);
    void stopWithTermination(
      () => completePendingStop(owner),
      () => owner.helperGeneration,
    ).then(resolveStop, (error) => {
      // Only the disabled compatibility path may request fresh evidence after failure.
      if (!terminationEnabled && owner.stopPromise === stopping) owner.stopPromise = null;
      rejectStop(error);
    });
    return stopping;
  };

  const inputReceipt = (
    record: Record<string, unknown>,
    sessionId: string,
    cancelEpoch: number,
    beforeAdoption = false,
  ): ComputerUseNativeInputReceipt => {
    if (!beforeAdoption && !sessions.has(sessionId))
      throw new ComputerUseNativeUnavailableError('native_input_receipt_unconfirmed');
    const parsed = computerUseNativeInputReceiptSchema.safeParse({
      sessionId: record['sessionId'],
      cancelEpoch: record['cancelEpoch'],
      inputAttemptCount: record['inputAttemptCount'],
    });
    const previous = inputAttemptsBySession.get(sessionId);
    if (
      !parsed.success ||
      parsed.data.sessionId !== sessionId ||
      parsed.data.cancelEpoch !== cancelEpoch ||
      (previous !== undefined && parsed.data.inputAttemptCount < previous)
    )
      throw new ComputerUseNativeUnavailableError('native_input_receipt_unconfirmed');
    if (!beforeAdoption) inputAttemptsBySession.set(sessionId, parsed.data.inputAttemptCount);
    return parsed.data;
  };

  const unavailableReason = (): string => {
    if (!packageReady) return normalizeReason(binding.probe.reason) || 'unsigned_package';
    if (!pickerReady) return COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE;
    if (!controllerReady) return COMPUTER_USE_NATIVE_CONTROLLER_UNAVAILABLE;
    if (!handshakeReady) return normalizeReason(binding.probe.reason) || 'handshake_failed';
    if (inputQuarantined()) return 'native_stop_unconfirmed';
    if (!probeReady) return normalizeReason(binding.probe.reason) || 'native_unavailable';
    return normalizeReason(binding.probe.reason) || 'native_unavailable';
  };

  const requireMethod = (method: NativeMethod): ((input: unknown) => unknown) => {
    if (
      !packageReady ||
      !handshakeReady ||
      !controllerReady ||
      addon === null ||
      !hasMethod(addon, method)
    )
      throw new ComputerUseNativeUnavailableError(
        method === 'pickApplication' && !pickerReady
          ? COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE
          : unavailableReason(),
      );
    if (
      (!probeReady || inputQuarantined()) &&
      (method === 'discoverWindows' ||
        method === 'listTargets' ||
        method === 'startSession' ||
        method === 'observe' ||
        method === 'preflight' ||
        method === 'approvalApprove' ||
        method === 'dispatchApproved' ||
        method === 'readNodeValue' ||
        method === 'dispatch')
    )
      throw semanticUnconfirmed()
        ? Object.assign(new ComputerUseNativeUnavailableError('native_stop_unconfirmed'), {
            code: 'NATIVE_STOP_UNCONFIRMED',
            accepted: false,
          })
        : new ComputerUseNativeUnavailableError(unavailableReason());
    return (input: unknown) => addon[method](input);
  };

  const invoke = async (method: NativeMethod, input: unknown): Promise<unknown> =>
    await Promise.resolve(requireMethod(method)(input));

  const stopWithDeadline = async (
    method: 'cancel' | 'close' | 'stopPendingStart',
    input: unknown,
  ): Promise<unknown> => {
    const timeoutMs =
      options.stopTimeoutMs ??
      (method !== 'cancel'
        ? COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS
        : COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
      throw new ComputerUseNativeUnavailableError('native_stop_timeout_invalid');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseRetry: (() => void) | undefined;
    let ended = false;
    // A claimed UIA call may return shortly after Stop. Retry only that explicit nonterminal
    // answer, within this one original deadline; never leave a retry running after the caller ends.
    // N5-J: semantic input still has a worker and a claim; this is the PR11 close-only exception,
    // not a retry for the removed start, validation, rejudge or discovery workers.
    const attempt = async (): Promise<unknown> => {
      for (;;) {
        if (ended) throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
        try {
          return await invoke(method, input);
        } catch (error) {
          if (
            platform !== 'win32' ||
            (terminationEnabled && method !== 'close') ||
            typeof error !== 'object' ||
            error === null ||
            !('code' in error) ||
            error.code !== 'semantic_input_in_flight'
          )
            throw error;
          if (ended) throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
          await new Promise<void>((resolve) => {
            releaseRetry = resolve;
            retryTimer = setTimeout(resolve, 50);
          });
        }
      }
    };
    try {
      return await Promise.race([
        attempt(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ComputerUseNativeUnavailableError('native_stop_unconfirmed')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      ended = true;
      if (timer !== undefined) clearTimeout(timer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      releaseRetry?.();
    }
  };

  // A session bound to a route whose expected classifier is not 2 (every panel session, and an
  // agent session of a build that did not attest 2) is refused the approval calls here as well as
  // at the receipt, so "no approval on a v1 route" does not rest on one layer. A session with no
  // binding at all (started without a route, closed, or whose start failed) is refused too (C5-1).
  const approvalRouteAllowed = (sessionId: string): boolean =>
    classifierBindings.get(sessionId)?.expectedVersion === 2;

  // The "approval path is open" test (C5-1): platform, the exported surface, the attested classifier
  // version, and the session's mode and route (computerUseApprovalPathEnabled has the table). It is
  // asked about a session and nothing else: a session with no binding (never bound, closed, or whose
  // start failed) is closed, so a missing binding can never open an approval.
  const approvalRouteOf = (sessionId: string): ComputerUseApprovalRoute => {
    const binding = classifierBindings.get(sessionId);
    if (binding === undefined) return 'unbound';
    return binding.expectedVersion === 2 ? 'v2' : 'v1';
  };
  // The loader verifies package provenance and all three declarations. The transport rechecks
  // the live helper handshake; session readiness additionally binds its generation and Stop state.
  const windowsApprovalEvidenceReady = (sessionId?: string): boolean =>
    platform === 'win32' &&
    options.windowsApprovalInterlockForTesting !== false &&
    binding.windowsApprovalVerified === true &&
    packageReady &&
    handshakeReady &&
    probeReady &&
    !inputQuarantined() &&
    addon?.windowsApprovalAvailable?.() === true &&
    (sessionId === undefined ||
      (sessions.has(sessionId) && addon?.windowsApprovalReady?.(sessionId) === true));
  // Discovery has no session yet: only build, provenance and live helper evidence apply.
  const windowsApprovalAvailable = (): boolean =>
    windowsApprovalEvidenceReady() &&
    options.classifierV2Attested === true &&
    (options.effectiveEligibilityMode?.() ?? binding.manifest.eligibility?.mode) ===
      'v2-denylist' &&
    hasMethod(addon, 'preflight') &&
    hasMethod(addon, 'approvalApprove') &&
    hasMethod(addon, 'approvalDiscard') &&
    hasMethod(addon, 'dispatchApproved');
  const presentedMaximumMode = (raw: Readonly<Record<string, unknown>>): ComputerUseMode => {
    const mode = nativeMaximumMode(raw);
    return platform === 'win32' && mode === 'supervised' && !windowsApprovalAvailable()
      ? 'observe_only'
      : mode;
  };
  const revokedApprovalSessions = new Set<string>();
  const approvalPathEnabled = (sessionId: string): boolean => {
    const route = approvalRouteOf(sessionId);
    const enabled = computerUseApprovalPathEnabled({
      platform,
      methodsExported:
        hasMethod(addon, 'preflight') &&
        hasMethod(addon, 'approvalApprove') &&
        hasMethod(addon, 'approvalDiscard') &&
        hasMethod(addon, 'dispatchApproved'),
      attestedClassifierVersion:
        options.classifierV2Attested === true ? COMPUTER_USE_APPROVAL_CLASSIFIER_VERSION : 1,
      effectiveMode:
        options.effectiveEligibilityMode?.() ?? (route === 'v2' ? 'v2-denylist' : 'v1-allowlist'),
      route,
      windowsApprovalReady: windowsApprovalEvidenceReady(sessionId),
    });
    if (platform !== 'win32') return enabled;
    const session = sessions.get(sessionId);
    if (!enabled && session?.maximumMode === 'supervised') revokedApprovalSessions.add(sessionId);
    return enabled && !revokedApprovalSessions.has(sessionId);
  };

  const parseDispatchRecord = (
    value: unknown,
    input: Readonly<{
      session: ComputerUseNativeSession;
      requestId: string;
      observationRevision: number;
      cancelEpoch: number;
    }>,
    internal: InternalNativeSession,
    actionDigest: string,
  ): ComputerUseNativeActionResult => {
    const record = asRecord(value, 'native_action_result_invalid');
    const result = computerUseResultSchema.parse(record['result']);
    const reasonCode = record['reasonCode'];
    if (reasonCode !== null && typeof reasonCode !== 'string')
      throw new ComputerUseNativeUnavailableError('native_action_result_invalid');
    if (
      internal.platform === 'darwin' &&
      (record['requestId'] !== input.requestId ||
        record['sessionId'] !== input.session.sessionId ||
        record['observationRevision'] !== input.observationRevision ||
        record['actionDigest'] !== actionDigest ||
        typeof record['accepted'] !== 'boolean' ||
        typeof record['effectStarted'] !== 'boolean')
    )
      throw new ComputerUseNativeUnavailableError('native_action_envelope_invalid');
    if (internal.platform === 'darwin') {
      const accepted = record['accepted'] === true;
      const effectStarted = record['effectStarted'] === true;
      if (
        (result === 'completed' && !accepted) ||
        (result === 'unknown_effect' && (!accepted || !effectStarted)) ||
        ((result === 'rejected' || result === 'paused' || result === 'canceled') &&
          (accepted || effectStarted))
      )
        throw new ComputerUseNativeUnavailableError('native_action_effect_invalid');
    }
    // Parse the public result shape once here so malformed native responses cannot cross the
    // controller boundary. The action id is native request-bound and is not persisted here.
    computerUseActionResultSchema.partial().parse({
      actionId: input.requestId,
      sessionId: input.session.sessionId,
      observationRevision: input.observationRevision,
      result,
      reasonCode: reasonCode ?? null,
    });
    return Object.freeze({
      result,
      reasonCode: reasonCode ?? null,
      inputReceipt: inputReceipt(record, input.session.sessionId, input.cancelEpoch),
    });
  };

  // The route the native is told for a session (C4): the one Main will accept receipts for, which
  // is v2 only when the build attested classifier 2. The native keeps it for the life of the
  // session. A session that was never bound sends nothing. The Windows host reads it only for
  // the approval gate (route v2 binding, N8-5), so it is sent only to a helper whose approval
  // evidence was verified; an ordinary Windows helper never receives the key (C4-0).
  const nativeRouteField = (route: 'v1' | 'v2' | undefined): Record<string, unknown> =>
    route !== undefined && (platform !== 'win32' || binding.windowsApprovalVerified === true)
      ? { classifierRoute: route }
      : {};

  const parseWindows = (
    profile: Parameters<ComputerUseNativeHost['listWindows']>[0],
    value: unknown,
    current: () => boolean = () => true,
  ): readonly ComputerUseNativeWindow[] => {
    if (!Array.isArray(value))
      throw new ComputerUseNativeUnavailableError('native_windows_invalid');
    const pids: number[] = [];
    const evidence = new Map<
      string,
      { identity: WindowsTargetQuarantine['identity']; windowIdentityDigest: string }
    >();
    const windows = value.map((candidate) => {
      const raw = asRecord(candidate, 'native_window_invalid');
      const executableDigest = nativeWindowExecutableDigest(raw, profile);
      const resolvedPid = raw['pid'];
      if (typeof resolvedPid === 'number' && Number.isSafeInteger(resolvedPid) && resolvedPid > 0)
        pids.push(resolvedPid);
      const publicCandidate = stripNativeEphemeralFields(raw);
      delete publicCandidate['processStartTime'];
      delete publicCandidate['quarantineResume'];
      delete publicCandidate['executableDigest'];
      publicCandidate['policyLanguage'] = nativePolicyLanguage(raw);
      publicCandidate['maximumMode'] = presentedMaximumMode(raw);
      let screenBounds: ComputerUseNativeBounds;
      if (profile.platform === 'win32') {
        if (raw['boundsUnit'] !== 'physical_px' || options.windowsPhysicalBoundsToDip === undefined)
          throw new ComputerUseNativeUnavailableError('native_window_coordinate_invalid');
        publicCandidate['bounds'] = options.windowsPhysicalBoundsToDip(
          parseNativeBounds(raw['bounds']),
        );
        screenBounds = options.windowsPhysicalBoundsToDip(parseNativeBounds(raw['screenBounds']));
      } else {
        screenBounds = parseNativeBounds(raw['screenBounds']);
      }
      delete publicCandidate['screenBounds'];
      const parsed = computerUseWindowCandidateSchema.parse(publicCandidate);
      if (
        terminationEnabled &&
        typeof resolvedPid === 'number' &&
        Number.isSafeInteger(resolvedPid) &&
        resolvedPid > 0 &&
        resolvedPid <= 0xffffffff &&
        validStartTime(raw['processStartTime'])
      )
        evidence.set(parsed.windowId, {
          identity: { pid: resolvedPid, creationTime: raw['processStartTime'] },
          windowIdentityDigest: parsed.windowIdentityDigest,
        });
      return Object.freeze({
        ...parsed,
        ...(evidence.has(parsed.windowId) &&
        [...ledgerStates.values()].some((state) =>
          state.quarantines.some((q) =>
            sameIdentity(q.identity, evidence.get(parsed.windowId)!.identity),
          ),
        )
          ? { quarantineResume: true as const }
          : {}),
        platform: profile.platform,
        executableDigest,
        screenBounds,
      }) as ComputerUseNativeWindow;
    });
    if (!current()) throw new ComputerUseNativeUnavailableError('native_discovery_canceled');
    discoveredWindows.clear();
    for (const [id, value] of evidence) discoveredWindows.set(id, value);
    for (const pid of pids) pidsByIdentity.set(profile.identityDigest, pid);
    return windows;
  };

  const discoveryInput = (profile: Parameters<ComputerUseNativeHost['listWindows']>[0]) => {
    const pid = pidsByIdentity.get(profile.identityDigest);
    return {
      ...profile,
      appIdentityDigest: profile.identityDigest,
      ...(pid === undefined ? {} : { pid }),
    };
  };
  const beginRawDiscovery = (input: Readonly<Record<string, unknown>>) => {
    // The ledger-enabled query retries storage before checking native availability.
    if (ledger === undefined) requireMethod('discoverWindows');
    return discoveryManager.begin({
      ...input,
      ...(startIdentityEnabled || terminationEnabled ? { includeStartIdentity: true } : {}),
    });
  };
  const beginWindowDiscovery = (
    profile: Parameters<ComputerUseNativeHost['listWindows']>[0],
  ): ComputerUseDiscoveryHandle<readonly ComputerUseNativeWindow[]> => {
    const sequence = ++windowEvidenceSequence;
    if (terminationEnabled) discoveredWindows.clear();
    const raw = beginRawDiscovery(discoveryInput(profile));
    let stopped = false;
    const result = raw.result.then((value) => {
      const adopt = (candidates: readonly unknown[] = value) => {
        if (stopped || (terminationEnabled && !discoveryManager.resultAvailable(raw.id)))
          throw new ComputerUseNativeUnavailableError('native_discovery_canceled');
        return parseWindows(
          profile,
          candidates,
          () => !stopped && (!terminationEnabled || sequence === windowEvidenceSequence),
        );
      };
      return ledger === undefined
        ? adopt()
        : checkDiscoveredTargets(value).then((admitted) =>
            adopt(
              value.filter((candidate) => {
                if (admitted.includes(candidate)) return true;
                const raw = asRecord(candidate, 'native_window_invalid');
                return (
                  terminationEnabled &&
                  [...ledgerStates.values()].some((state) =>
                    state.quarantines.some(
                      (q) =>
                        q.identity.pid === raw['pid'] &&
                        q.identity.creationTime === raw['processStartTime'],
                    ),
                  )
                );
              }),
            ),
          );
    });
    void result.catch(() => undefined);
    return Object.freeze({
      id: raw.id,
      result,
      terminal: raw.terminal,
      stop: () => {
        stopped = true;
        return raw.stop();
      },
    });
  };

  const startWindowsDiscovery = async (
    owner: StartOwner,
    input: Readonly<Record<string, unknown>>,
  ) => {
    assertStartOwner(owner);
    const discovery = beginRawDiscovery(input);
    owner.discoveries.add(discovery);
    void discovery.terminal
      .then(() => {
        if (owner.terminated) return;
        owner.discoveries.delete(discovery);
        owner.discoveryUnconfirmed = owner.discoveries.size !== 0 && owner.stopped;
        if (owner.stopped && owner.nativeTerminal !== null && !owner.discoveryUnconfirmed)
          return finishStartOwner(owner, owner.nativeTerminal);
      })
      .catch(() => {
        if (owner.terminated) return;
        owner.unconfirmed = true;
      });
    const value = await discovery.result;
    assertStartOwner(owner);
    return value;
  };

  const startDiscovery = async <T>(owner: StartOwner, work: () => Promise<T>): Promise<T> => {
    owner.discoveryPending += 1;
    try {
      return await work();
    } catch (error) {
      // A bound native refusal completed the synchronous request. Transport failures and
      // malformed results do not prove it ended; kill() is not a process-exit receipt.
      const refused =
        error instanceof Error &&
        'accepted' in error &&
        error.accepted === false &&
        'code' in error &&
        typeof error.code === 'string';
      if (platform === 'win32' && !refused) owner.discoveryUnconfirmed = true;
      throw error;
    } finally {
      owner.discoveryPending -= 1;
    }
  };

  const startNative = async (
    input: Omit<
      Parameters<ComputerUseNativeHost['startSession']>[0],
      'classifierRoute' | 'assertTargetCurrent'
    >,
    nativeRoute: 'v1' | 'v2' | undefined,
    owner: StartOwner,
    assertTargetCurrent?: () => void,
  ): Promise<ComputerUseNativeSession> => {
    assertTargetCurrent?.();
    assertStartOwner(owner);
    if (
      startIdentityEnabled &&
      (ledger === undefined ||
        binding.probe.capabilities.identityBoundStart !== true ||
        addon?.dispatchLedgerSupported !== true ||
        typeof addon.checkTargetIdentity !== 'function')
    )
      throw new ComputerUseNativeUnavailableError('native_unavailable');
    let checkedGeneration: number | undefined;
    const sendStart = async (request: Record<string, unknown>, creationTime: unknown) => {
      assertTargetCurrent?.();
      if (assertTargetCurrent !== undefined && !terminationEnabled)
        throw new ComputerUseNativeUnavailableError('native_target_generation_changed');
      if (ledger === undefined) return await invoke('startSession', request);
      requireMethod('startSession');
      const start = addon?.startSession;
      if (start === undefined) throw new ComputerUseNativeUnavailableError('native_unavailable');
      let callbacks: WindowsStartCallbacks | undefined;
      let unconfirmedRecord: Promise<void> | undefined;
      let startRequest = request;
      if (startIdentityEnabled) {
        if (
          typeof request['pid'] !== 'number' ||
          !Number.isSafeInteger(request['pid']) ||
          request['pid'] < 1 ||
          !validStartTime(creationTime)
        )
          throw new ComputerUseNativeUnavailableError('native_unavailable');
        // Keep these out of `request`: it becomes the session's stored bindings, which a later
        // existing-session start spreads back into its own request.
        startRequest = {
          ...request,
          requireStartIdentity: true,
          expectedProcessStartTime: creationTime,
        };
        const recording = inputLedger({
          sessionId: input.sessionId,
          identity: { pid: request['pid'], creationTime },
          path: { kind: 'foreground', inputPath: 'foreground' },
          stopped: () =>
            owner.stopped || owner.terminated || startOwners.get(owner.sessionId) !== owner,
        });
        if (recording === undefined)
          throw new ComputerUseNativeUnavailableError('native_unavailable');
        const retain = () => (unconfirmedRecord ??= recording.response(true));
        const pause = () => {
          owner.stopped = true;
          owner.unconfirmed = true;
          owner.foregroundUnconfirmed = true;
        };
        callbacks = {
          ...recording,
          beforeWrite: async (generation, requestId) => {
            if (checkedGeneration !== undefined && generation !== checkedGeneration)
              throw new ComputerUseNativeUnavailableError('native_unavailable');
            await recording.beforeWrite(generation, requestId);
          },
          unconfirmed: (cause) => {
            pause();
            recording.unconfirmed(cause);
            void retain().catch(() => undefined);
          },
          startResponse: async (value, succeeded) => {
            try {
              const raw = asRecord(value, 'native_unavailable');
              const result = asRecord(raw['startResult'], 'native_unavailable');
              const count = result['attemptCount'];
              const outcome = result['foregroundResult'];
              if (
                result['pid'] !== request['pid'] ||
                result['processStartTime'] !== creationTime ||
                typeof count !== 'number' ||
                !Number.isSafeInteger(count) ||
                count < 0 ||
                !(
                  (outcome === 'not_attempted' && count === 0) ||
                  (outcome === 'confirmed' && count > 0 && succeeded) ||
                  outcome === 'unconfirmed'
                )
              )
                throw new ComputerUseNativeUnavailableError('native_unavailable');
              if (succeeded) {
                const parsed = parseNativeSession(
                  raw,
                  input.profile.platform,
                  input,
                  request,
                  options.windowsPhysicalBoundsToDip,
                  options.windowsBackgroundInputForTesting === true && ledger !== undefined,
                );
                if (
                  raw['pid'] !== request['pid'] ||
                  parsed.raw.processStartTime !== creationTime ||
                  parsed.windowIdentityDigest !== request['windowIdentityDigest']
                )
                  throw new ComputerUseNativeUnavailableError('native_unavailable');
                inputReceipt(raw, input.sessionId, parsed.cancelEpoch, true);
              }
              if (outcome === 'unconfirmed')
                throw new ComputerUseNativeUnavailableError('native_unavailable');
              await recording.completed();
            } catch {
              pause();
              await retain();
              throw new ComputerUseNativeUnavailableError('native_unavailable');
            }
          },
        };
      }
      try {
        return await start(
          startRequest,
          () => {
            assertTargetCurrent?.();
            assertStartOwner(owner);
            if (
              ledgerBlocked(
                request['pid'],
                typeof creationTime === 'string' ? creationTime : undefined,
              )
            )
              throw new ComputerUseNativeUnavailableError('native_unavailable');
          },
          callbacks,
        );
      } finally {
        // Wait for the R23 record, but never let its storage error replace the start's own error.
        await unconfirmedRecord?.catch(() => undefined);
      }
    };
    const existing = sessions.get(input.sessionId);
    if (existing !== undefined) {
      if (
        existing.platform !== input.profile.platform ||
        existing.appIdentityDigest !== input.profile.identityDigest ||
        existing.windowId !== input.windowId ||
        existing.profileRevision !== input.profile.revision
      )
        throw new ComputerUseNativeUnavailableError('native_session_rebind_forbidden');
      const request = {
        ...existing.raw,
        ...input,
        appIdentityDigest: input.profile.identityDigest,
        canonicalPath: input.profile.canonicalPath,
        windowIdentityDigest: existing.windowIdentityDigest,
        resume: input.resume === true,
        expectedPolicyLanguage: existing.policyLanguage,
        ...nativeRouteField(nativeRoute),
      };
      assertStartOwner(owner);
      if (ledger !== undefined) {
        const assertAdmission = await prepareTargetAdmission(request);
        assertStartOwner(owner);
        assertAdmission();
      }
      owner.nativeInvoked = true;
      const value = await sendStart(request, existing.raw.processStartTime);
      assertStartOwner(owner);
      const raw = asRecord(value, 'native_session_invalid');
      const session = parseNativeSession(
        raw,
        input.profile.platform,
        input,
        request,
        options.windowsPhysicalBoundsToDip,
        options.windowsBackgroundInputForTesting === true && ledger !== undefined,
      );
      if (
        existing.platform === 'win32' &&
        ((typeof existing.raw.processStartTime === 'string' &&
          session.raw.processStartTime !== existing.raw.processStartTime) ||
          (ledger !== undefined && session.raw['pid'] !== existing.raw['pid']))
      ) {
        if (ledger !== undefined) await stopStartOwner(owner).catch(() => undefined);
        throw new ComputerUseNativeUnavailableError('native_session_identity_mismatch');
      }
      assertStartOwner(owner);
      owner.knownEpoch = Math.max(owner.knownEpoch, session.cancelEpoch);
      sessions.set(session.sessionId, session);
      return publicNativeSession(session);
    }
    let pid = pidsByIdentity.get(input.profile.identityDigest);
    if (pid === undefined) {
      const windows =
        platform === 'win32'
          ? parseWindows(
              input.profile,
              await startWindowsDiscovery(owner, discoveryInput(input.profile)),
              () => !owner.stopped,
            )
          : await startDiscovery(owner, () => host.listWindows(input.profile));
      assertStartOwner(owner);
      pid = pidsByIdentity.get(input.profile.identityDigest);
      if (pid === undefined || windows.every((candidate) => candidate.windowId !== input.windowId))
        throw new ComputerUseNativeUnavailableError(
          startIdentityEnabled ? 'native_unavailable' : 'native_app_not_active',
        );
    }
    const discoveryRequest = {
      ...input.profile,
      pid,
      appIdentityDigest: input.profile.identityDigest,
    };
    const candidate =
      platform === 'win32'
        ? await startWindowsDiscovery(owner, discoveryRequest)
        : await startDiscovery(owner, () => invoke('listWindows', discoveryRequest));
    assertStartOwner(owner);
    if (!Array.isArray(candidate))
      throw new ComputerUseNativeUnavailableError('native_windows_invalid');
    const selected = candidate.find((value) => {
      const raw = asRecord(value, 'native_window_invalid');
      return raw['windowId'] === input.windowId && raw['eligible'] === true;
    });
    const selectedRecord =
      selected === undefined ? null : asRecord(selected, 'native_window_invalid');
    if (selectedRecord === null) throw new ComputerUseNativeUnavailableError('native_window_stale');
    if (
      input.expectedWindowIdentityDigest !== undefined &&
      selectedRecord['windowIdentityDigest'] !== input.expectedWindowIdentityDigest
    )
      throw new ComputerUseNativeUnavailableError('native_window_stale');
    const processStartTime = selectedRecord['processStartTime'];
    if (
      ledger !== undefined &&
      processStartTime !== undefined &&
      (typeof processStartTime !== 'string' ||
        !/^[1-9][0-9]{0,19}$/u.test(processStartTime) ||
        BigInt(processStartTime) > 0xffff_ffff_ffff_ffffn)
    )
      throw new ComputerUseNativeUnavailableError('native_unavailable');
    if (startIdentityEnabled && !validStartTime(processStartTime))
      throw new ComputerUseNativeUnavailableError('native_unavailable');
    const selectedPid = selectedRecord['pid'];
    if (typeof selectedPid !== 'number' || !Number.isSafeInteger(selectedPid) || selectedPid < 1)
      throw new ComputerUseNativeUnavailableError(
        startIdentityEnabled ? 'native_unavailable' : 'native_window_owner_invalid',
      );
    if (startIdentityEnabled) {
      if (selectedPid > 0xffff_ffff)
        throw new ComputerUseNativeUnavailableError('native_unavailable');
      let results: unknown;
      try {
        results = await addon?.checkTargetIdentity?.(
          [{ pid: selectedPid, processStartTime }],
          (generation) => {
            checkedGeneration = generation;
          },
        );
      } catch {
        throw new ComputerUseNativeUnavailableError('native_unavailable');
      }
      assertStartOwner(owner);
      if (
        checkedGeneration === undefined ||
        !Array.isArray(results) ||
        results.length !== 1 ||
        asRecord(results[0], 'native_unavailable')['result'] !== 'alive'
      )
        throw new ComputerUseNativeUnavailableError('native_unavailable');
    }
    pid = selectedPid;
    pidsByIdentity.set(input.profile.identityDigest, selectedPid);
    const selectedBounds = asRecord(selectedRecord['bounds'], 'native_window_invalid');
    const explorerFacts = explorerFactsSchema.safeParse(selectedRecord['facts']);
    const explorerBoundFacts =
      explorerFacts.success && selectedRecord['appIdentityDigest'] === input.profile.identityDigest
        ? Object.freeze({ ...explorerFacts.data })
        : undefined;
    const expectedMaximumMode = bindComputerUseMaximumMode(
      nativeMaximumMode(input.profile.identity),
      nativeMaximumMode(selectedRecord),
    );
    const request = {
      ...input,
      pid,
      appIdentityDigest: input.profile.identityDigest,
      canonicalPath: input.profile.canonicalPath,
      windowIdentityDigest: stringField(selectedRecord, 'windowIdentityDigest'),
      expectedBoundsX: selectedBounds['x'],
      expectedBoundsY: selectedBounds['y'],
      expectedBoundsWidth: selectedBounds['width'],
      expectedBoundsHeight: selectedBounds['height'],
      expectedPolicyLanguage: nativePolicyLanguage(selectedRecord),
      maximumMode: expectedMaximumMode,
      expectedMaximumMode,
      ...nativeRouteField(nativeRoute),
    };
    assertStartOwner(owner);
    // Discovery awaited after the admission check; a hold left on this target meanwhile refuses.
    if (
      ledger !== undefined &&
      ledgerBlocked(pid, sessions.get(input.sessionId)?.raw.processStartTime)
    )
      throw new ComputerUseNativeUnavailableError('native_unavailable');
    if (ledger !== undefined) {
      const assertAdmission = await prepareTargetAdmission(request);
      assertStartOwner(owner);
      assertAdmission();
    }
    owner.nativeInvoked = true;
    const value = await sendStart(request, processStartTime);
    assertStartOwner(owner);
    const raw = asRecord(value, 'native_session_invalid');
    const session = parseNativeSession(
      raw,
      input.profile.platform,
      input,
      request,
      options.windowsPhysicalBoundsToDip,
      options.windowsBackgroundInputForTesting === true && ledger !== undefined,
    );
    assertStartOwner(owner);
    owner.knownEpoch = Math.max(owner.knownEpoch, session.cancelEpoch);
    sessions.set(session.sessionId, session);
    if (
      terminationEnabled &&
      typeof session.raw['pid'] === 'number' &&
      typeof session.raw.processStartTime === 'string'
    )
      resumeTargets.set(session.sessionId, {
        pid: session.raw['pid'],
        creationTime: session.raw.processStartTime,
      });
    if (
      explorerBoundFacts !== undefined &&
      session.windowIdentityDigest === selectedRecord['windowIdentityDigest']
    )
      explorerSessionFacts.set(session, explorerBoundFacts);
    // `raw` stays inside this Main/native adapter. It may contain OS handles needed by a native
    // implementation, but it is never returned to the controller or renderer.
    try {
      return {
        ...publicNativeSession(session),
        inputReceipt: inputReceipt(raw, session.sessionId, session.cancelEpoch),
      };
    } catch (error) {
      await host.close(session).catch(() => undefined);
      throw error;
    }
  };

  let targetGeneration: ComputerTargetWindowsGeneration | undefined;
  let targetEnumeration: symbol | undefined;
  const targetGenerationCurrent = (generation: ComputerTargetWindowsGeneration): boolean =>
    terminationEnabled &&
    addon?.isWindowsGenerationCurrent?.(generation.helper) === true &&
    options.effectiveEligibilityMode?.() === 'v2-denylist' &&
    generation.rulesetVersion === denyRulesetVersion('win32') &&
    computerTargetWindowsGenerationMatches(targetGeneration, generation);
  const host: InternalActionNativeHost = {
    ...(terminationEnabled
      ? {
          approveWindowsWindowResume: async (input) => {
            const evidence = discoveredWindows.get(input.windowId);
            if (
              evidence === undefined ||
              evidence.windowIdentityDigest !== input.windowIdentityDigest
            )
              return false;
            return host.approveWindowsQuarantineResume!({
              newSessionId: input.newSessionId,
              trustedActivation: input.trustedActivation,
              restoredTarget: {
                identity: evidence.identity,
                approvedWindow: { ...evidence, windowId: input.windowId },
              },
            });
          },
          approveWindowsQuarantineResume: async (
            input: Parameters<
              NonNullable<ComputerUseNativeHost['approveWindowsQuarantineResume']>
            >[0],
          ): Promise<boolean> => {
            // The Controller consumes the card intent; this entry independently binds its
            // Main-owned evidence to the latest native window discovery.
            const restored = input.restoredTarget;
            const observedWindow =
              restored === undefined
                ? undefined
                : discoveredWindows.get(restored.approvedWindow.windowId);
            if (
              restored !== undefined &&
              (observedWindow === undefined ||
                observedWindow.windowIdentityDigest !==
                  restored.approvedWindow.windowIdentityDigest ||
                !sameIdentity(observedWindow.identity, restored.identity))
            )
              return false;
            const previousSessionId = input.previousSessionId ?? '';
            const identity = restored?.identity ?? resumeTargets.get(previousSessionId);
            const owner = startOwners.get(previousSessionId);
            const previousGeneration = restored === undefined ? owner?.helperGeneration : -1;
            if (
              restored !== undefined &&
              (!Number.isSafeInteger(restored.identity.pid) ||
                restored.identity.pid < 1 ||
                restored.identity.pid > 0xffff_ffff ||
                !validStartTime(restored.identity.creationTime) ||
                !sameIdentity(restored.identity, restored.approvedWindow.identity) ||
                restored.approvedWindow.windowId.length === 0 ||
                !/^[a-f0-9]{64}$/u.test(restored.approvedWindow.windowIdentityDigest))
            )
              return false;
            if (
              !input.trustedActivation ||
              identity === undefined ||
              (restored === undefined && owner === undefined) ||
              previousGeneration == null ||
              input.newSessionId.length === 0 ||
              input.newSessionId === input.previousSessionId ||
              startOwners.has(input.newSessionId) ||
              confirmedClosed.has(input.newSessionId) ||
              (restored === undefined && !owner?.receiptConfirmed && !owner?.terminated) ||
              ledger?.releaseQuarantine === undefined ||
              ledger.quarantineRevision === undefined ||
              addon?.checkTargetIdentity === undefined
            )
              return false;
            const previousStop =
              restored !== undefined
                ? ('restored' as const)
                : owner?.terminated
                  ? ('exit' as const)
                  : ('receipt' as const);
            // K-5 (R24) releases only a K-1 quarantine after receipt; exit approval (R17) any reason.
            const releasable = (q: WindowsTargetQuarantine) =>
              sameIdentity(q.identity, identity) &&
              (previousStop !== 'receipt' ||
                ['response_lost', 'effect_unconfirmed', 'takeover_conflict'].includes(q.reason));
            const blocked = (holdId?: string) =>
              inputQuarantined() ||
              [...ledgerStates.values()].some(
                (state) =>
                  (state.killRequested && !state.exitConfirmed) ||
                  state.nativeBlockers.length > 0 ||
                  state.rows.some((row) => sameIdentity(row.identity, identity)) ||
                  state.holds.some(
                    (hold) =>
                      hold.id !== holdId &&
                      (hold.targets === 'unknown' ||
                        hold.targets.some((target) => sameIdentity(target, identity))),
                  ),
              ) ||
              [...uncertainWrites].some((row) => sameIdentity(row.identity, identity));
            // The approval covers only the shared evidence committed when it was given. Another
            // Host's later add or transfer changes this revision and the release then refuses.
            let revision: number | null;
            try {
              revision = await ledger.quarantineRevision(identity);
            } catch {
              return false;
            }
            if (typeof revision !== 'number') return false;
            const approvedRevision = revision;
            await retryLedger();
            if (
              blocked() ||
              ![...ledgerStates.values()].some((state) => state.quarantines.some(releasable))
            )
              return false;
            // This read is after approval; it can launch the new helper after a confirmed exit.
            const observe = async () => {
              try {
                const result = await addon.checkTargetIdentity!([
                  { pid: identity.pid, processStartTime: identity.creationTime },
                ]);
                return result.length === 1 ? result[0]?.result : undefined;
              } catch {
                return undefined;
              }
            };
            if ((await observe()) !== 'alive' || blocked()) return false;
            const generation = Math.max(
              ...[...ledgerStates.values()]
                .filter((state) => state.helperLaunched && !state.exitConfirmed)
                .map((state) => state.helperGeneration),
            );
            if (
              !Number.isSafeInteger(generation) ||
              (previousStop === 'exit' && generation === previousGeneration)
            )
              return false;
            const holdId = `approval-release-${++holdSequence}`;
            // Keep the original quarantine beside the release hold, including after a generation
            // change, so an ambiguous obsolete delete has a concrete compensating write.
            const state = ledgerState(generation);
            const quarantine = [...ledgerStates.values()]
              .flatMap((state) => state.quarantines)
              .find(releasable);
            if (quarantine === undefined) return false;
            if (!state.quarantines.some((q) => sameIdentity(q.identity, identity)))
              ledgerStates.set(generation, {
                ...state,
                quarantines: [...state.quarantines, quarantine],
              });
            const event = {
              kind: 'approve_new_session',
              identity,
              trustedActivation: true,
              previousStop,
              previousGeneration,
              previousSessionId,
              newSessionId: input.newSessionId,
            } as const;
            const decision = ledgerEvent(generation, {
              ...event,
              storage: { status: 'failed', holdId },
            });
            if (decision.refusal !== null) return false;
            let released = false;
            // Set by the latest write: the shared row changed after approval, or the target ended.
            let superseded = false;
            let terminated = false;
            // A superseded release without a restoration obligation has no hold left (F5).
            const held = () => ledgerState(generation).holds.some((hold) => hold.id === holdId);
            pendingWrites.set(holdId, {
              generation,
              write: async () => {
                superseded = false;
                terminated = false;
                if (!held() || blocked(holdId)) return false;
                const observed = await observe();
                if (!held() || blocked(holdId)) return false;
                if (observed === 'terminated') {
                  // R15 handover: a proven exit covers every earlier operation on this identity,
                  // including newer evidence and an earlier uncertain conditional delete. Without
                  // it a failed release could never settle and PID reuse would stay refused.
                  if (!(await ledger.releaseQuarantine!(identity))) return false;
                  terminated = true;
                  return true;
                }
                if (observed !== 'alive') return false;
                const gate = ledgerEvent(generation, {
                  kind: 'retry_storage',
                  holdId,
                  status: 'before_write',
                });
                if (gate.refusal !== null || startOwners.has(input.newSessionId)) return false;
                if (await ledger.releaseQuarantine!(identity, approvedRevision)) return true;
                superseded = true;
                return false;
              },
              reflect: (written, uncertain) => {
                if (!held()) {
                  // Nothing is left to retry or release; answer with a read-only gate query.
                  released = false;
                  pendingWrites.delete(holdId);
                  return decideWindowsStop(ledgerState(generation), {
                    kind: 'dispatch_gate',
                    helperGeneration: ledgerState(generation).helperGeneration,
                    identity,
                  });
                }
                if (superseded && !written) {
                  // The stored row kept newer evidence: end this approval and keep the quarantine.
                  // A new approval reads the new revision (fail-closed).
                  const state = ledgerState(generation);
                  ledgerStates.set(generation, {
                    ...state,
                    holds: state.holds.map((hold) =>
                      hold.id === holdId ? { ...hold, releaseSuperseded: true } : hold,
                    ),
                  });
                  released = false;
                  return ledgerEvent(generation, {
                    kind: 'retry_storage',
                    holdId,
                    status: 'before_write',
                  });
                }
                const result = ledgerEvent(generation, {
                  kind: 'retry_storage',
                  holdId,
                  status: written ? 'written' : 'failed',
                  ...(uncertain ? { uncertain: true } : {}),
                });
                // The R15 handover clears the quarantine but never grants the approved session.
                released = result.freshSession && !terminated;
                if (result.freshSession)
                  for (const [id, state] of ledgerStates)
                    ledgerStates.set(id, {
                      ...state,
                      quarantines: state.quarantines.filter(
                        (q) => !sameIdentity(q.identity, identity),
                      ),
                    });
                return result;
              },
            });
            await writePending(holdId);
            return released;
          },
        }
      : {}),
    ...(platform === 'win32' && addon?.subscribeWindowsInteraction
      ? {
          subscribeWindowsInteraction: (listener: WindowsInteractionListener) => {
            interactionListeners.add(listener);
            return () => {
              interactionListeners.delete(listener);
            };
          },
        }
      : {}),
    ...(roundTrips === undefined
      ? {}
      : {
          beginApprovalRoundTrip: async (
            input: Parameters<NonNullable<ComputerUseNativeHost['beginApprovalRoundTrip']>>[0],
          ) => {
            if (input.session.inputSession?.kind === 'background') return;
            const generation = addon?.captureWindowsGeneration?.();
            if (
              !generation ||
              !sessions.has(input.session.sessionId) ||
              interactionRevoked.has(input.session.sessionId)
            )
              throw new Error('Round trip session unavailable');
            await roundTrips.begin({
              ...options.windowsApprovalRoundTripForTesting!,
              version: 1,
              kind: 'begin',
              roundTripId: input.roundTripId,
              sessionId: input.session.sessionId,
              taskId: input.taskId,
              turnId: input.turnId,
              helperGeneration: generation.helperGeneration,
              cancelEpoch: input.session.cancelEpoch,
              durationMs: Math.min(input.durationMs, 60_000),
            });
          },
          endApprovalRoundTrip: (sessionId: string, reason: 'rejected' | 'expired' | 'stopped') =>
            roundTrips.cancel(sessionId, reason),
        }),
    ...(terminationEnabled ? { subscribeWindowsStop: stopDelivery.subscribe } : {}),
    ...(terminationEnabled
      ? {
          captureWindowsGeneration: () => addon?.captureWindowsGeneration?.() ?? null,
          isWindowsGenerationCurrent: (token: WindowsGenerationToken) =>
            addon?.isWindowsGenerationCurrent?.(token) === true,
          isWindowsTargetGenerationCurrent: targetGenerationCurrent,
        }
      : {}),
    listTargets: async () => {
      const enumeration = Symbol('target-enumeration');
      targetEnumeration = enumeration;
      targetGeneration = undefined;
      if (ledger !== undefined) await retryLedger();
      const requireDiscovery = (): void => {
        if (
          platform !== 'win32' ||
          binding.manifest.platform !== 'win32' ||
          binding.manifest.eligibility?.mode !== 'v2-denylist' ||
          binding.manifest.eligibility.rulesetVersion !== denyRulesetVersion('win32') ||
          options.effectiveEligibilityMode?.() !== 'v2-denylist'
        )
          throw new ComputerUseNativeUnavailableError('native_target_discovery_unavailable');
        requireMethod('listTargets');
      };
      requireDiscovery();
      if (ledger !== undefined) (await prepareTargetAdmission({}, false))();
      const value = await invoke('listTargets', {});
      const helper = terminationEnabled ? addon?.windowsGenerationFor?.(value) : undefined;
      const requireGeneration = (): void => {
        if (
          terminationEnabled &&
          (enumeration !== targetEnumeration ||
            helper == null ||
            addon?.isWindowsGenerationCurrent?.(helper) !== true)
        )
          throw new ComputerUseNativeUnavailableError('native_target_generation_changed');
      };
      requireGeneration();
      requireDiscovery();
      const parsed = parseWindowsComputerUseTargets(value, windowsApprovalAvailable());
      if (parsed === null)
        throw new ComputerUseNativeUnavailableError('native_target_list_invalid');
      const result = {
        ...parsed,
        ...(helper == null
          ? {}
          : {
              windowsGeneration: Object.freeze({
                helper,
                listGeneration: parsed.generation,
                rulesetVersion: parsed.rulesetVersion,
              }),
            }),
      };
      targetGeneration = result.windowsGeneration;
      if (ledger !== undefined) {
        const targets = [...result.targets];
        const prepare = admissionBatch();
        const guards: Array<{ index: number; check: () => void }> = [];
        for (const [index, target] of targets.entries()) {
          if (target.kind !== 'selectable') continue;
          try {
            guards.push({ index, check: await prepare(target.native) });
          } catch {
            targets[index] = { kind: 'denied' };
          }
        }
        for (const { index, check } of guards) {
          try {
            check();
          } catch {
            targets[index] = { kind: 'denied' };
          }
        }
        requireDiscovery();
        requireGeneration();
        return { ...result, targets };
      }
      return result;
    },
    availability: (): ComputerUseAvailability => {
      const nativeAvailable =
        binding.probe.available && binding.probe.capabilities.observe && !inputQuarantined();
      const observe = packageReady && handshakeReady && nativeAvailable && controllerReady;
      const control = observe && binding.probe.capabilities.control && hasMethod(addon, 'dispatch');
      // Named only once the package and the handshake are trusted: an OS permission is the one
      // failure the user can act on, and it must never mask a package-level refusal.
      const missingPermissions =
        packageReady && handshakeReady && !observe
          ? computerUseMissingNativePermissions(binding.probe)
          : [];
      const state = !packageReady
        ? 'unsigned_package'
        : !handshakeReady
          ? 'handshake_failed'
          : !observe
            ? missingPermissions.length > 0
              ? 'permission_required'
              : 'native_unavailable'
            : 'ready';
      return computerUseAvailabilitySchema.parse({
        platform: runtimePlatform,
        state,
        missingPermissions,
        acceptanceMode,
        // The feature flag itself is evaluated by ComputerUseController. This native seam reports
        // only package/protocol/native facts and leaves the exact opt-in gate to Main.
        featureEnabled: true,
        packageReady,
        handshakeReady,
        observe,
        control,
        available: observe,
        reasonCode: observe ? null : unavailableReason(),
        manifestDigest: packageReady ? manifestDigest(binding.manifest, runtimePlatform) : null,
      });
    },

    pickApplication: async (input): Promise<ComputerAppIdentity | null> => {
      const value = await invoke('pickApplication', input);
      if (value === null) return null;
      const raw = asRecord(value, 'native_app_identity_invalid');
      const pid = raw['pid'];
      const publicIdentity = stripNativeEphemeralFields(raw);
      delete publicIdentity['screenBounds'];
      publicIdentity['policyLanguage'] = nativePolicyLanguage(raw);
      publicIdentity['maximumMode'] = presentedMaximumMode(raw);
      const identity = computerAppIdentitySchema.parse(publicIdentity);
      if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0)
        pidsByIdentity.set(identity.identityDigest, pid);
      return identity;
    },

    ...(platform === 'win32' ? { beginWindowDiscovery } : {}),
    listWindows: async (profile): Promise<readonly ComputerUseNativeWindow[]> => {
      if (platform === 'win32') return await beginWindowDiscovery(profile).result;
      return parseWindows(profile, await invoke('listWindows', discoveryInput(profile)));
    },

    startSession: async (startInput): Promise<ComputerUseNativeSession> => {
      if (interactionRevoked.has(startInput.sessionId))
        throw new ComputerUseNativeUnavailableError('native_interaction_revoked');
      if (ledger === undefined) requireMethod('startSession');
      const {
        classifierRoute,
        assertTargetCurrent: assertCallerTarget,
        windowsGeneration,
        roundTripId,
        ...baseInput
      } = startInput;
      const assertTargetCurrent =
        windowsGeneration === undefined
          ? assertCallerTarget
          : () => {
              assertCallerTarget?.();
              if (
                !targetGenerationCurrent(windowsGeneration) ||
                !/^[a-f0-9]{64}$/u.test(baseInput.expectedWindowIdentityDigest ?? '')
              )
                throw new ComputerUseNativeUnavailableError('native_target_generation_changed');
            };
      const input = {
        ...baseInput,
        ...roundTrips?.returning(startInput.sessionId, roundTripId),
        ...(windowsGeneration === undefined
          ? {}
          : {
              targetGeneration: windowsGeneration.listGeneration,
              denyRulesetVersion: windowsGeneration.rulesetVersion,
              eligibilityBasis: 'v2-denylist',
            }),
      };
      assertTargetCurrent?.();
      if (!Number.isSafeInteger(input.cancelEpoch) || input.cancelEpoch < 0)
        throw new ComputerUseNativeUnavailableError('native_session_invalid');
      let owner = startOwners.get(input.sessionId);
      if (owner?.stopped || confirmedClosed.has(input.sessionId))
        throw new ComputerUseNativeUnavailableError('native_session_closed');
      if (owner !== undefined && owner.binding !== startBinding(startInput))
        throw new ComputerUseNativeUnavailableError('native_session_rebind_forbidden');
      if (owner === undefined) {
        trimStartOwners();
        if (startOwners.size >= 128)
          throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
        owner = {
          helperGeneration: null,
          terminated: false,
          receiptConfirmed: false,
          sessionId: input.sessionId,
          binding: startBinding(startInput),
          route: classifierRoute,
          attempts: new Set(),
          stopped: false,
          nativeInvoked: false,
          discoveryPending: 0,
          discoveryUnconfirmed: false,
          discoveries: new Set(),
          knownEpoch: input.cancelEpoch,
          terminalEpoch: 0,
          terminal: null,
          nativeTerminal: null,
          nativeTerminalEvidence: null,
          unconfirmed: false,
          stopPromise: null,
        };
        startOwners.set(input.sessionId, owner);
      }
      owner.knownEpoch = Math.max(owner.knownEpoch, input.cancelEpoch);
      const attempt = Symbol('native-start-attempt');
      let binding = classifierBindings.get(input.sessionId);
      if (
        binding !== undefined &&
        classifierRoute !== undefined &&
        classifierRoute !== binding.route
      )
        throw new ComputerUseNativeUnavailableError('native_classifier_route_forbidden');
      // Bound before the first await, so two starts of one new session cannot both pass the check
      // above with different routes. The route asks; the attest decides: v2 is expected only from
      // a build that attested classifier 2.
      // A binding is made only by the start that creates the session: an existing session that
      // was started without a route stays unbound (and is sent none), whatever a later start asks.
      if (binding === undefined && owner.route !== undefined && !sessions.has(input.sessionId)) {
        binding = {
          route: owner.route,
          expectedVersion: owner.route === 'v2' && options.classifierV2Attested === true ? 2 : 1,
          starts: new Set<symbol>(),
        };
        classifierBindings.set(input.sessionId, binding);
      }
      // This start's owner token. The binding of a session that never came to exist goes when the
      // last start of it ends, not when the first one that created it fails: another start of the
      // same route may still be on its way to making the session.
      const bindingOwner = Symbol('classifier-route-start');
      binding?.starts.add(bindingOwner);
      owner.attempts.add(attempt);
      let startEntered = false;
      try {
        if (ledger !== undefined) {
          await retryLedger();
          assertStartOwner(owner);
          requireMethod('startSession');
          const existing = sessions.get(startInput.sessionId);
          if (
            ledgerBlocked(
              existing?.raw['pid'] ?? pidsByIdentity.get(startInput.profile.identityDigest),
              existing?.raw.processStartTime,
            )
          )
            throw new ComputerUseNativeUnavailableError('native_unavailable');
        }
        startEntered = true;
        const started = await startNative(
          input,
          binding === undefined ? undefined : binding.expectedVersion === 2 ? 'v2' : 'v1',
          owner,
          assertTargetCurrent,
        );
        if (
          platform === 'win32' &&
          started.maximumMode === 'supervised' &&
          !approvalPathEnabled(started.sessionId)
        ) {
          await host.close(started).catch(() => undefined);
          throw new ComputerUseNativeUnavailableError('native_approval_ceiling_mismatch');
        }
        return started;
      } catch (error) {
        // An active Cancel/Close owns its cleanup. A late resume must not create a second
        // terminal operation that removes the session before Cancel validates its receipt.
        const stoppedBeforeSettlement = owner.stopped;
        if (owner.stopPromise !== null) await owner.stopPromise.catch(() => undefined);
        else if (
          startEntered &&
          !owner.stopped &&
          owner.attempts.size === 1 &&
          !sessions.has(input.sessionId)
        )
          await stopStartOwner(owner).catch(() => undefined);
        // In the disabled compatibility path, a settled start can query evidence; it is not itself
        // a stop receipt. One bounded recheck cannot resurrect the stopped lifetime or bypass
        // an unfinished/uncertain launch-capable discovery.
        if (
          !terminationEnabled &&
          stoppedBeforeSettlement &&
          // R23 pause is not a user Stop; retain evidence until an explicit Stop or exit.
          !owner.foregroundUnconfirmed &&
          owner.nativeInvoked &&
          owner.unconfirmed &&
          !owner.discoveryUnconfirmed &&
          owner.stopPromise === null
        )
          await stopStartOwner(owner).catch(() => undefined);
        throw error;
      } finally {
        owner.attempts.delete(attempt);
        if (
          !startEntered &&
          !owner.nativeInvoked &&
          owner.attempts.size === 0 &&
          !owner.stopped &&
          owner.discoveryPending === 0 &&
          !owner.discoveryUnconfirmed &&
          startOwners.get(input.sessionId) === owner
        )
          startOwners.delete(input.sessionId);
        if (binding !== undefined) {
          binding.starts.delete(bindingOwner);
          if (
            binding.starts.size === 0 &&
            !sessions.has(input.sessionId) &&
            !owner.unconfirmed &&
            classifierBindings.get(input.sessionId) === binding
          )
            classifierBindings.delete(input.sessionId);
        }
        trimStartOwners();
      }
    },

    stopPendingStart: (sessionId): Promise<ComputerUsePendingStartStop> => {
      const owner = startOwners.get(sessionId);
      return owner === undefined
        ? Promise.reject(new ComputerUseNativeUnavailableError('native_stop_unconfirmed'))
        : stopStartOwner(owner);
    },

    observe: async (session, input): Promise<ComputerUseObservation> => {
      const internal = sessions.get(session.sessionId);
      if (internal === undefined)
        throw new ComputerUseNativeUnavailableError('native_session_missing');
      const value = await invoke('observe', {
        ...internal.raw,
        appIdentityDigest: session.appIdentityDigest,
        requestId: input.requestId,
        cancelEpoch: input.cancelEpoch,
      });
      return toObservation(
        value,
        session,
        revisionsBySession,
        () => Date.now(),
        options.windowsPhysicalBoundsToDip,
      );
    },

    nativeApprovalPathEnabled: (sessionId: string): boolean => approvalPathEnabled(sessionId),

    // T15-E: only a ready Windows helper with the read attest opens artifact transfer.
    ...(platform === 'win32' &&
    handshakeReady &&
    probeReady &&
    binding.probe.capabilities.artifactRead === true &&
    hasMethod(addon, 'readNodeValue')
      ? { artifactReadSupported: () => true, artifactPasteSupported: () => true }
      : {}),

    // The method alone grants no capability. Every way of not reading is `{ ok: false }`.
    ...(hasMethod(addon, 'readNodeValue')
      ? {
          readNodeValue: async (input: {
            session: ComputerUseNativeSession;
            requestId: string;
            targetId: string;
            targetSignature: string;
            observationRevision: number;
            cancelEpoch: number;
          }): Promise<ComputerUseNativeNodeValue> => {
            const internal = sessions.get(input.session.sessionId);
            if (internal === undefined) return Object.freeze({ ok: false });
            try {
              const value = await invoke('readNodeValue', {
                ...internal.raw,
                type: 'copy',
                requestId: input.requestId,
                targetId: input.targetId,
                targetSignature: input.targetSignature,
                observationRevision: input.observationRevision,
                cancelEpoch: input.cancelEpoch,
              });
              return parseNativeNodeValue(value);
            } catch {
              return Object.freeze({ ok: false });
            }
          },
        }
      : {}),

    approvalApprove: async (input): Promise<ComputerUseNativeApprovalApproveResult> => {
      let exchanged = false;
      try {
        if (interactionRevoked.has(input.session.sessionId))
          return { kind: 'refused', result: 'rejected', reasonCode: 'native_interaction_revoked' };
        const internal = sessions.get(input.session.sessionId);
        if (ledger !== undefined && internal !== undefined) {
          await retryLedger();
          if (ledgerBlocked(internal.raw['pid'], internal.raw.processStartTime))
            return { kind: 'refused', result: 'rejected', reasonCode: 'native_unavailable' };
        }
        // approvalApprove has no input capability: every failure below is a typed pre-input result.
        if (internal === undefined)
          return Object.freeze({
            kind: 'refused',
            result: 'rejected',
            reasonCode: 'native_session_missing',
          });
        // A session bound to a route that does not expect classifier 2 never gets an approval.
        if (!approvalRouteAllowed(input.session.sessionId))
          return Object.freeze({
            kind: 'refused',
            result: 'rejected',
            reasonCode: 'native_approval_route_forbidden',
          });
        const request = {
          ...internal.raw,
          ...roundTrips?.exchange(input.session.sessionId),
          ...input.action,
          requestId: input.requestId,
          observationRevision: input.observationRevision,
          cancelEpoch: input.cancelEpoch,
          actionDigest: computerUseActionDigest(input.action),
          approvalGeneration: input.approvalGeneration,
        };
        let receipt: unknown;
        try {
          if (!approvalPathEnabled(input.session.sessionId))
            throw new ComputerUseNativeUnavailableError('native_approval_closed');
          receipt = await invoke('approvalApprove', request);
        } catch {
          // approvalApprove has no input capability: a throw or a closed path is a pre-input failure.
          return Object.freeze({
            kind: 'refused',
            result: 'rejected',
            reasonCode: 'native_approval_approve_failed',
          });
        }
        const outcome = parseNativeApprovalApproveReceipt(receipt, {
          sessionId: input.session.sessionId,
          requestId: input.requestId,
          cancelEpoch: input.cancelEpoch,
          observationRevision: input.observationRevision,
          approvalGeneration: input.approvalGeneration,
        });
        if (outcome.kind === 'invalid')
          return Object.freeze({
            kind: 'invalid',
            result: outcome.result,
            reasonCode: outcome.reasonCode,
          });
        // Unlike preflight (which throws on a regressed count), this is a typed rejection: approvalApprove
        // has no input capability, so nothing can have been input. A regressed receipt does not update
        // inputAttemptsBySession, so every later receipt still compares against the old count, regresses
        // too, and throws before any input.
        try {
          inputReceipt(
            {
              sessionId: input.session.sessionId,
              cancelEpoch: input.cancelEpoch,
              inputAttemptCount: outcome.inputAttemptCount,
            },
            input.session.sessionId,
            input.cancelEpoch,
          );
        } catch {
          // A count that went backwards is an untrustworthy receipt, but approvalApprove cannot input.
          return Object.freeze({
            kind: 'invalid',
            result: 'rejected',
            reasonCode: 'native_approval_receipt_invalid',
          });
        }
        if (outcome.kind === 'approved') {
          await roundTrips?.exchanged(input.session.sessionId);
          exchanged = true;
          return Object.freeze({ kind: 'approved' });
        }
        return Object.freeze({
          kind: 'refused',
          result: outcome.result,
          reasonCode: outcome.reasonCode,
        });
      } finally {
        if (!exchanged) await roundTrips?.cancel(input.session.sessionId, 'rejected');
      }
    },

    approvalDiscard: async (input): Promise<void> => {
      const internal = sessions.get(input.session.sessionId);
      if (internal === undefined || !hasMethod(addon, 'approvalDiscard')) return;
      try {
        // No input capability, and a stale generation is a no-op: nothing here can fail closed.
        await invoke('approvalDiscard', {
          ...internal.raw,
          sessionId: input.session.sessionId,
          approvalGeneration: input.approvalGeneration,
        });
      } catch {
        // The slot also expires on its own (at most 60 seconds), is replaced by the next intent,
        // and is dropped by cancel and close.
      }
    },

    dispatchApproved: async (input): Promise<ComputerUseNativeActionResult> => {
      if (interactionRevoked.has(input.session.sessionId))
        return { result: 'rejected', reasonCode: 'native_interaction_revoked' };
      const internal = sessions.get(input.session.sessionId);
      if (internal === undefined && platform === 'win32')
        return { result: 'rejected', reasonCode: 'native_session_missing' };
      if (internal === undefined)
        throw new ComputerUseNativeUnavailableError('native_session_missing');
      if (
        !approvalPathEnabled(input.session.sessionId) ||
        !approvalRouteAllowed(input.session.sessionId)
      ) {
        if (platform === 'win32')
          return { result: 'rejected', reasonCode: 'native_approval_closed' };
        throw new ComputerUseNativeUnavailableError('native_approval_closed');
      }
      const actionDigest = computerUseActionDigest(input.action);
      const request = {
        ...internal.raw,
        ...input.action,
        requestId: input.requestId,
        observationRevision: input.observationRevision,
        cancelEpoch: input.cancelEpoch,
        actionDigest,
        approvalGeneration: input.approvalGeneration,
      };
      let value: unknown;
      try {
        const callbacks = dispatchLedger(input, internal);
        if (callbacks === undefined) value = await invoke('dispatchApproved', request);
        else {
          requireMethod('dispatchApproved');
          if (addon?.dispatchLedgerSupported !== true || addon.dispatchApproved === undefined)
            throw Object.assign(new ComputerUseNativeUnavailableError('native_unavailable'), {
              accepted: false,
              code: 'UNAVAILABLE',
            });
          value = await addon.dispatchApproved(request, callbacks);
          if (Object.keys(asRecord(value, 'native_action_result_invalid')).length !== 5)
            throw new ComputerUseNativeUnavailableError('native_action_result_invalid');
          const result = parseDispatchRecord(value, input, internal, actionDigest);
          if (result.result !== 'completed' || result.reasonCode !== null)
            throw new ComputerUseNativeUnavailableError('native_action_result_invalid');
          await callbacks.completed();
          return result;
        }
      } catch (error) {
        const preDispatch = classifyComputerUseNativeDispatchFailure(error);
        if (preDispatch !== null) return preDispatch;
        throw error;
      }
      return parseDispatchRecord(value, input, internal, actionDigest);
    },

    dispatch: async (input): Promise<ComputerUseNativeActionResult> => {
      if (interactionRevoked.has(input.session.sessionId))
        return { result: 'rejected', reasonCode: 'native_interaction_revoked' };
      if (ledger !== undefined) await retryLedger();
      const internal = sessions.get(input.session.sessionId);
      if (internal === undefined)
        throw new ComputerUseNativeUnavailableError('native_session_missing');
      if (
        platform === 'win32' &&
        internal.maximumMode === 'supervised' &&
        !approvalPathEnabled(input.session.sessionId)
      )
        return { result: 'rejected', reasonCode: 'native_approval_closed' };
      const actionDigest = computerUseActionDigest(input.action);
      const dispatchRequest = {
        ...internal.raw,
        ...roundTrips?.exchange(input.session.sessionId),
        ...input.action,
        requestId: input.requestId,
        observationRevision: input.observationRevision,
        cancelEpoch: input.cancelEpoch,
        actionDigest,
      };
      // A native that exports preflight (macOS N2a, Windows S5-a): every dispatch is preceded by a
      // side-effect-free preflight and carries the single-use ordinary ticket it returns. The
      // capability is the presence of the exported method. A native build from before ticket
      // enforcement keeps the legacy path and does not itself refuse an input without a ticket; the
      // Windows addon always exports preflight, and the packaged helper is pinned to this Main by
      // digest and source commit, so only an unpinned development run can pair them differently
      // (a stale helper then fails closed on the unknown message type).
      let ticket: string | null = null;
      const generationToken = terminationEnabled ? addon?.captureWindowsGeneration?.() : undefined;
      let settled = false;
      try {
        if (hasMethod(addon, 'preflight')) {
          let receipt: unknown;
          try {
            receipt = await invoke('preflight', dispatchRequest);
          } catch (error) {
            // Preflight has no input capability, so whatever went wrong happened before any input:
            // a coded pre-dispatch failure keeps its mapping, anything else is a typed rejection.
            return (
              classifyComputerUseNativeDispatchFailure(error) ??
              Object.freeze({ result: 'rejected', reasonCode: 'native_preflight_failed' })
            );
          }
          let outcome: NativePreflightOutcome;
          try {
            const expected = classifierBindings.get(input.session.sessionId)?.expectedVersion;
            outcome = parseNativePreflightReceipt(receipt, {
              ...input,
              ...(expected === undefined ? {} : { expectedClassifierVersion: expected }),
              ...(platform === 'win32' && approvalPathEnabled(input.session.sessionId)
                ? {
                    windowsApproval: {
                      route: approvalRouteOf(input.session.sessionId),
                      receiptVersion: 3,
                    },
                  }
                : {}),
            });
          } catch (error) {
            // A receipt that cannot be trusted was produced before any input. It is a typed
            // pre-input rejection, never an exception the controller would book as unknown_effect.
            const typed = nativePreflightInvalidResult(error);
            if (typed !== null) return typed;
            throw error;
          }
          // The preflight count must also be a non-regressing, session-bound receipt.
          const preflightReceipt = inputReceipt(
            outcome.record,
            input.session.sessionId,
            input.cancelEpoch,
          );
          if (outcome.kind === 'ticket') {
            // Defence in depth: Main judged this target high-impact and the approval path is open, yet
            // native called it ordinary. The vocabularies differ, so no input is made. The ordinary
            // ticket is never used; it expires in the native slot or is replaced by the next preflight.
            if (input.mainHighImpact === true && approvalPathEnabled(input.session.sessionId))
              return Object.freeze({
                result: 'paused',
                reasonCode: 'hard_boundary',
                inputReceipt: preflightReceipt,
              });
            ticket = outcome.ticket;
            await roundTrips?.exchanged(input.session.sessionId);
            settled = true;
          }
          if (outcome.kind === 'refused') {
            // Same public-shape check as a dispatch result, so the contract owns the reason format.
            if (
              !computerUseActionResultSchema
                .partial()
                .safeParse({ result: outcome.result, reasonCode: outcome.reasonCode }).success
            )
              return nativePreflightInvalidResult(null)!;
            if (outcome.approvalOffer !== undefined) {
              const id = roundTrips?.offered(input.session.sessionId);
              if (id !== undefined) addon?.completeApprovalRoundTrip?.(input.session.sessionId, id);
              settled = true;
            } else await roundTrips?.cancel(input.session.sessionId, 'rejected');
            return Object.freeze({
              result: outcome.result,
              reasonCode: outcome.reasonCode,
              inputReceipt: preflightReceipt,
              ...(outcome.approvalOffer === undefined
                ? {}
                : { approvalOffer: outcome.approvalOffer }),
            });
          }
        }
      } finally {
        if (!settled) await roundTrips?.cancel(input.session.sessionId, 'rejected');
      }
      let value: unknown;
      const callbacks = dispatchLedger(input, internal);
      try {
        if (
          terminationEnabled &&
          (generationToken == null || addon?.isWindowsGenerationCurrent?.(generationToken) !== true)
        )
          throw Object.assign(new ComputerUseNativeUnavailableError('native_unavailable'), {
            code: 'UNAVAILABLE',
            accepted: false,
          });
        const request = ticket === null ? dispatchRequest : { ...dispatchRequest, ticket };
        if (callbacks === undefined) value = await invoke('dispatch', request);
        else {
          requireMethod('dispatch');
          if (addon?.dispatchLedgerSupported !== true || addon.dispatch === undefined)
            throw new ComputerUseNativeUnavailableError('native_unavailable');
          value = await addon.dispatch(request, callbacks);
        }
      } catch (error) {
        const preDispatch = classifyComputerUseNativeDispatchFailure(error);
        if (preDispatch !== null) return preDispatch;
        throw error;
      }
      if (
        callbacks !== undefined &&
        Object.keys(asRecord(value, 'native_action_result_invalid')).length !== 5
      )
        throw new ComputerUseNativeUnavailableError('native_action_result_invalid');
      const result = parseDispatchRecord(value, input, internal, actionDigest);
      if (callbacks !== undefined) {
        if (result.result !== 'completed' || result.reasonCode !== null)
          throw new ComputerUseNativeUnavailableError('native_action_result_invalid');
        await callbacks.completed();
      }
      return result;
    },

    cancel: async (session, cancelEpoch): Promise<ComputerUseNativeInputReceipt> => {
      const internal = sessions.get(session.sessionId);
      if (internal === undefined)
        throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
      activeStopQuarantines.add(session.sessionId);
      const owner = startOwners.get(session.sessionId);
      if (owner !== undefined) latchStartOwner(owner);
      stopEpochs.set(
        session.sessionId,
        Math.max(stopEpochs.get(session.sessionId) ?? internal.cancelEpoch, cancelEpoch),
      );
      const result = asRecord(
        await stopWithDeadline('cancel', { ...internal.raw, cancelEpoch }),
        'native_stop_unconfirmed',
      );
      if (result['result'] !== 'canceled' || result['drained'] !== true)
        throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
      return inputReceipt(result, session.sessionId, cancelEpoch);
    },

    close: async (session) => {
      const close = async () => {
        const owner = startOwners.get(session.sessionId);
        if (terminatedStart(owner) !== undefined) return terminatedStart(owner);
        const internal = sessions.get(session.sessionId);
        if (internal === undefined) {
          if (confirmedClosed.has(session.sessionId)) return;
          throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
        }
        activeStopQuarantines.add(session.sessionId);
        if (owner !== undefined) latchStartOwner(owner);
        const cancelEpoch = (stopEpochs.get(session.sessionId) ?? internal.cancelEpoch) + 1;
        stopEpochs.set(session.sessionId, cancelEpoch);
        const [discoveryStop, nativeClose] = await Promise.allSettled([
          owner === undefined ? Promise.resolve() : stopOwnerDiscoveries(owner),
          stopWithDeadline('close', {
            ...internal.raw,
            cancelEpoch,
            ...(terminationEnabled ? { killStopClose: true } : {}),
          }),
        ]);
        if (terminatedStart(owner) !== undefined) return terminatedStart(owner);
        if (nativeClose.status === 'rejected')
          throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
        if (owner?.terminal !== null && owner?.terminal !== undefined) return;
        const parsed = computerUseNativeCloseReceiptSchema.safeParse(nativeClose.value);
        if (!parsed.success) throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
        inputReceipt(parsed.data, session.sessionId, cancelEpoch);
        const terminal: ComputerUsePendingStartStop = {
          kind: 'closed',
          inputReceipt: {
            sessionId: parsed.data.sessionId,
            cancelEpoch: parsed.data.cancelEpoch,
            inputAttemptCount: parsed.data.inputAttemptCount,
          },
        };
        if (owner !== undefined) {
          owner.nativeTerminal = terminal;
          owner.nativeTerminalEvidence = nativeClose.value;
        }
        if (
          owner?.discoveryUnconfirmed ||
          (discoveryStop.status === 'rejected' &&
            owner !== undefined &&
            owner.discoveries.size !== 0)
        ) {
          if (owner !== undefined) owner.unconfirmed = true;
          throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
        }
        const confirming = confirmSessionClosed(terminal.inputReceipt, nativeClose.value);
        if (confirming !== undefined) await confirming;
        if (owner?.terminated) return terminatedStart(owner);
        if (
          terminationEnabled &&
          !owner?.receiptConfirmed &&
          owner?.helperGeneration != null &&
          (ledgerState(owner.helperGeneration).killRequested ||
            ledgerState(owner.helperGeneration).exitConfirmed)
        )
          throw new ComputerUseNativeUnavailableError('native_stop_unconfirmed');
        sessions.delete(session.sessionId);
        classifierBindings.delete(session.sessionId);
        inputAttemptsBySession.delete(session.sessionId);
        stopEpochs.delete(session.sessionId);
        revisionsBySession.delete(session.sessionId);
        confirmedClosed.add(session.sessionId);
        interactionRevoked.delete(session.sessionId);
        if (confirmedClosed.size > 128)
          confirmedClosed.delete(confirmedClosed.values().next().value!);
        // Only a verified close releases the process-local quarantine. Late/failed completion
        // leaves the old session tracked and cannot open a new input lane.
        activeStopQuarantines.delete(session.sessionId);
        if (owner !== undefined) {
          owner.terminal = terminal;
          owner.nativeTerminalEvidence = null;
          owner.unconfirmed = false;
          owner.stopPromise ??= Promise.resolve(owner.terminal);
          trimStartOwners();
        }
      };
      return stopWithTermination(close, () => startOwners.get(session.sessionId)?.helperGeneration);
    },
  };
  const frozenHost = Object.freeze({ ...host, restoreWindowsLedger });
  options.windowsCompletedStartForTesting?.((sessionId) => {
    const owner = startOwners.get(sessionId);
    if (
      !sessions.has(sessionId) ||
      owner === undefined ||
      owner.stopped ||
      owner.attempts.size !== 0 ||
      owner.discoveries.size !== 0
    )
      return false;
    return startOwners.delete(sessionId);
  });
  explorerApprovalReaders.set(frozenHost, (sessionId) => {
    const session = sessions.get(sessionId);
    if (session === undefined) return undefined;
    const facts = explorerSessionFacts.get(session);
    if (facts === undefined) return undefined;
    const windowDigest = session.windowIdentityDigest;
    const appDigest = session.appIdentityDigest;
    const epoch = stopEpochs.get(sessionId) ?? session.cancelEpoch;
    // Session object and epoch prevent reuse after quarantine clears or the id is reopened.
    return {
      facts,
      // P5 REQUIREMENT (M2): this measures Main's point at the time of the request. The dispatch
      // must re-check the point owner and view natively, with WindowsActionPoint's POINT, before
      // its first input API; this answer never authorizes an input by itself.
      measure: async (point) =>
        addon?.measureExplorerView?.({
          sessionId,
          windowId: session.windowId,
          cancelEpoch: epoch,
          requestId: randomUUID(),
          x: point.x,
          y: point.y,
        }),
      current: () =>
        sessions.get(sessionId) === session &&
        session.windowIdentityDigest === windowDigest &&
        session.appIdentityDigest === appDigest &&
        (stopEpochs.get(sessionId) ?? session.cancelEpoch) === epoch &&
        !interactionRevoked.has(sessionId) &&
        windowsApprovalAvailable() &&
        approvalRouteOf(sessionId) === 'v2' &&
        approvalPathEnabled(sessionId),
    };
  });
  return frozenHost;
}

/** Default for unit/embedded callers that do not provide a loaded native binding. */
export function createUnavailableComputerUseNativeHost(
  platform: NodeJS.Platform = process.platform,
): ComputerUseNativeHost {
  const nativePlatform: NativePlatform = platform === 'win32' ? 'win32' : 'darwin';
  const zero = '0'.repeat(64);
  return createComputerUseNativeHost(
    {
      manifest: {
        version: 1,
        sourceCommit: '0'.repeat(40),
        platform: nativePlatform,
        architecture: platform === 'win32' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x64',
        protocolVersion: 1,
        apiVersion: 3,
        nativeVersion: 'disabled',
        moduleDigest: zero,
        binaryDigest: zero,
        signerDigest: null,
        capabilities: ['observe'],
      },
      probe: {
        available: false,
        protocolVersion: 1,
        apiVersion: 3,
        backend: `${platform}-unavailable`,
        reason: 'FEATURE_FLAG_DISABLED',
        artifactPath: null,
        artifactDigest: null,
        capabilities: { observe: false, control: false },
      },
      artifactPath: null,
      addon: null,
    },
    platform,
  );
}

type NativePreflightOutcome =
  | Readonly<{ kind: 'ticket'; ticket: string; record: Record<string, unknown> }>
  | Readonly<{ kind: 'replay'; record: Record<string, unknown> }>
  | Readonly<{
      kind: 'refused';
      result: 'rejected' | 'paused' | 'canceled';
      reasonCode: string;
      record: Record<string, unknown>;
      /** Present only for a version 2 approval offer; nothing acts on it before the controller PR. */
      approvalOffer?: ComputerUseNativeApprovalOffer;
    }>;

/**
 * The classifier version of a native whose classifier cannot yet offer an approval, and the one a
 * version 2 approval offer must carry. Mirrors `classifier_version` in
 * `computer_use_native_approval_ticket.h`; a contract test keeps the two in step. Until D7 attests
 * the classifier version in the handshake, these are Main's fixed expectations.
 */
export const NATIVE_PREFLIGHT_CLASSIFIER_VERSION = 1;
export const NATIVE_APPROVAL_CLASSIFIER_VERSION = 2;

/** `effect` strings of a version 2 approval offer; the native `NativeApprovalEffect` minus kInvalid. */
export const NATIVE_APPROVAL_EFFECTS = [
  'download_open',
  'file_manager_open',
  'high_impact_confirmation',
  'supervised_action',
] as const;

/** The native approval wait is bounded at 60 seconds (ADR v2 S4-4). */
const NATIVE_APPROVAL_WAIT_MAX_MS = 60_000;

const NATIVE_SINGLE_USE_APPROVAL_UNAVAILABLE = 'native_single_use_approval_unavailable';

/**
 * The closed set of blocked and takeover receipts native may return, as (decision, reason, result).
 * A reason is only valid together with the decision and result it belongs to, so a reason can not be
 * carried into another kind of refusal. It mirrors `kNativePreflightRefusalTable` in the macOS native.
 * - secure field: blocked / rejected (the person is not asked)
 * - high impact and unclassified targets: takeover (a person decides)
 * - shell, script and command surfaces (ADR 3.7): blocked / rejected
 * - an execution trigger (ADR 3.6, E1 / E4): takeover / paused
 * - an opening that needs an approval while the approval path is closed (E2 / E3): blocked / rejected,
 *   a code of its own so that the pair of one code means one thing.
 * A reason of this table is valid only in its own row: carried in a different decision, or in a
 * `denied` receipt, it is invalid. The rest of `denied` is a different, longer table (native
 * closes it) and is not listed here.
 */
export const NATIVE_PREFLIGHT_REFUSALS: readonly Readonly<{
  decision: 'blocked' | 'takeover';
  reasonCode: string;
  deniedResult: 'rejected' | 'paused';
}>[] = Object.freeze([
  { decision: 'blocked', reasonCode: 'native_secure_field_blocked', deniedResult: 'rejected' },
  { decision: 'blocked', reasonCode: 'native_shell_surface_blocked', deniedResult: 'rejected' },
  { decision: 'blocked', reasonCode: 'native_approval_not_enabled', deniedResult: 'rejected' },
  { decision: 'takeover', reasonCode: 'native_high_impact_user_takeover', deniedResult: 'paused' },
  { decision: 'takeover', reasonCode: 'native_target_unclassified', deniedResult: 'rejected' },
  { decision: 'takeover', reasonCode: 'native_execution_trigger_blocked', deniedResult: 'paused' },
]);

const NATIVE_PREFLIGHT_KEYS = [
  'decision',
  'reasonCode',
  'deniedResult',
  'ticket',
  'classifierVersion',
  'inputAttemptCount',
  'requestId',
  'sessionId',
  'cancelEpoch',
  'observationRevision',
] as const;

/** Version 2 adds `receiptVersion`; only a `single_use_approval` offer carries the other three. */
const NATIVE_PREFLIGHT_KEYS_V2 = [...NATIVE_PREFLIGHT_KEYS, 'receiptVersion'] as const;
const NATIVE_APPROVAL_OFFER_KEYS_V2 = [
  ...NATIVE_PREFLIGHT_KEYS_V2,
  'approvalGeneration',
  'remainingMs',
  'effect',
] as const;
const NATIVE_APPROVAL_OFFER_KEYS_V3 = [...NATIVE_APPROVAL_OFFER_KEYS_V2, 'display'] as const;

/**
 * Validate a native preflight receipt. Fail closed (throw before any input) on anything outside
 * the fixed key set or the closed decision table. The ticket is a secret: it is returned only to
 * be passed straight to dispatch and never appears in an error message.
 */
export function parseNativePreflightReceipt(
  value: unknown,
  input: Readonly<{
    session: ComputerUseNativeSession;
    requestId: string;
    observationRevision: number;
    cancelEpoch: number;
    /**
     * The classifier version the session's route expects (classifier C3). Bound: every receipt
     * must carry exactly this version, and an approval offer additionally needs classifier 2, so
     * a v1-bound session can never be offered one. Unbound (no route given at start): the
     * pre-C3 rule, classifier 2 for an offer and 1 for the rest. Main always binds a route.
     */
    expectedClassifierVersion?: number;
    /** Supplied only after the Windows connection's capability and session route are checked.
     * Production remains closed until N7 attests the Windows interlock. */
    windowsApproval?: Readonly<{ route: ComputerUseApprovalRoute; receiptVersion: number }>;
  }>,
): NativePreflightOutcome {
  const invalid = (): never => {
    throw new ComputerUseNativeUnavailableError('native_preflight_invalid');
  };
  const record = asRecord(value, 'native_preflight_invalid');
  const keys = Reflect.ownKeys(record);
  // `receiptVersion` is the format version and is independent of the classifier's own version. A
  // receipt without it is version 1 and keeps its original strict shape.
  const version2 = keys.includes('receiptVersion');
  const version3 = record['receiptVersion'] === 3;
  const offersApproval = version2 && record['decision'] === 'single_use_approval';
  if (offersApproval && input.session.platform === 'win32' && !version3) return invalid();
  if (version3) {
    if (
      input.session.platform !== 'win32' ||
      input.windowsApproval?.route !== 'v2' ||
      input.windowsApproval.receiptVersion !== 3 ||
      input.expectedClassifierVersion !== 2 ||
      !offersApproval ||
      typeof record['inputAttemptCount'] !== 'number' ||
      !Number.isSafeInteger(record['inputAttemptCount']) ||
      record['inputAttemptCount'] < 0
    )
      return invalid();
  } else if (version2 && record['receiptVersion'] !== 2) return invalid();
  const expectedKeys = version3
    ? NATIVE_APPROVAL_OFFER_KEYS_V3
    : !version2
      ? NATIVE_PREFLIGHT_KEYS
      : offersApproval
        ? NATIVE_APPROVAL_OFFER_KEYS_V2
        : NATIVE_PREFLIGHT_KEYS_V2;
  const bound = input.expectedClassifierVersion;
  const expectedClassifierVersion = offersApproval
    ? NATIVE_APPROVAL_CLASSIFIER_VERSION
    : (bound ?? NATIVE_PREFLIGHT_CLASSIFIER_VERSION);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key)) ||
    record['classifierVersion'] !== expectedClassifierVersion ||
    (bound !== undefined && record['classifierVersion'] !== bound) ||
    record['requestId'] !== input.requestId ||
    record['sessionId'] !== input.session.sessionId ||
    record['cancelEpoch'] !== input.cancelEpoch ||
    record['observationRevision'] !== input.observationRevision
  )
    return invalid();
  const { decision, reasonCode, deniedResult, ticket } = record;
  if (decision === 'ordinary') {
    if (
      reasonCode !== null ||
      deniedResult !== null ||
      typeof ticket !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(ticket)
    )
      return invalid();
    return { kind: 'ticket', ticket, record };
  }
  if (ticket !== null) return invalid();
  if (offersApproval) {
    const approvalGeneration = record['approvalGeneration'];
    const remainingMs = record['remainingMs'];
    const effect = record['effect'];
    if (
      reasonCode !== null ||
      deniedResult !== null ||
      typeof approvalGeneration !== 'number' ||
      !Number.isSafeInteger(approvalGeneration) ||
      approvalGeneration < 1 ||
      typeof remainingMs !== 'number' ||
      !Number.isSafeInteger(remainingMs) ||
      remainingMs < 1 ||
      remainingMs > NATIVE_APPROVAL_WAIT_MAX_MS ||
      typeof effect !== 'string' ||
      !(NATIVE_APPROVAL_EFFECTS as readonly string[]).includes(effect)
    )
      return invalid();
    if (version3) {
      const rawDisplay = asRecord(record['display'], 'native_preflight_invalid');
      let targetLabel = rawDisplay['targetLabel'];
      if (typeof targetLabel === 'string') {
        const sanitized = sanitizeNativeDisplayLabel(targetLabel);
        if (sanitized.kind === 'rejected') return invalid();
        targetLabel = sanitized.kind === 'verified' ? sanitized.label : null;
      }
      const parsed = computerUseWindowsApprovalDisplaySchema.safeParse({
        ...rawDisplay,
        targetLabel,
      });
      if (!parsed.success || parsed.data.effect !== effect) return invalid();
      const display = parsed.data;
      const common = { kind: 'approval_required' as const, approvalGeneration, remainingMs };
      // Preserve the effect/display discriminant relationship without an unchecked cast.
      let approvalOffer: ComputerUseNativeApprovalOffer;
      switch (display.effect) {
        case 'supervised_action':
          approvalOffer = { ...common, effect: display.effect, display };
          break;
        case 'high_impact_confirmation':
          approvalOffer = { ...common, effect: display.effect, display };
          break;
        case 'download_open':
          approvalOffer = { ...common, effect: display.effect, display };
          break;
        case 'file_manager_open':
          approvalOffer = { ...common, effect: display.effect, display };
          break;
      }
      return {
        kind: 'refused',
        result: 'paused',
        reasonCode: NATIVE_SINGLE_USE_APPROVAL_UNAVAILABLE,
        record,
        approvalOffer,
      };
    }
    // No approval path exists in Main yet, so the offer is still a closed no-input pause.
    return {
      kind: 'refused',
      result: 'paused',
      reasonCode: NATIVE_SINGLE_USE_APPROVAL_UNAVAILABLE,
      record,
      approvalOffer: {
        kind: 'approval_required',
        approvalGeneration,
        remainingMs,
        effect: effect as ComputerUseNativeApprovalOffer['effect'],
        display: null,
      },
    };
  }
  if (version2 && decision === 'single_use_approval') return invalid();
  if (decision === 'single_use_approval') {
    // N2b-2: no approval path exists yet, so this is a closed no-input pause. Only the exact
    // null-reason tuple is accepted; the native reason is never forwarded, only a fixed Main one.
    if (reasonCode !== null || deniedResult !== null) return invalid();
    return {
      kind: 'refused',
      result: 'paused',
      reasonCode: NATIVE_SINGLE_USE_APPROVAL_UNAVAILABLE,
      record,
    };
  }
  if (decision === 'replay') {
    if (reasonCode !== null || deniedResult !== null) return invalid();
    return { kind: 'replay', record };
  }
  if (decision === 'blocked' || decision === 'takeover') {
    // Closed: only the listed (decision, reason, result) triples are receipts.
    if (
      !NATIVE_PREFLIGHT_REFUSALS.some(
        (entry) =>
          entry.decision === decision &&
          entry.reasonCode === reasonCode &&
          entry.deniedResult === deniedResult,
      )
    )
      return invalid();
    return {
      kind: 'refused',
      result: deniedResult as 'rejected' | 'paused',
      reasonCode: reasonCode as string,
      record,
    };
  }
  if (
    decision === 'denied' &&
    typeof reasonCode === 'string' &&
    // A refusal reason (v1 or interlock) belongs to blocked / takeover only.
    !NATIVE_PREFLIGHT_REFUSALS.some((entry) => entry.reasonCode === reasonCode) &&
    (deniedResult === 'rejected' || deniedResult === 'paused' || deniedResult === 'canceled')
  )
    return { kind: 'refused', result: deniedResult, reasonCode, record };
  return invalid();
}

/** What `parseNativeApprovalApproveReceipt` expects the receipt to echo back. */
export type NativeApprovalApproveExpectation = Readonly<{
  sessionId: string;
  requestId: string;
  cancelEpoch: number;
  observationRevision: number;
  approvalGeneration: number;
}>;

export type NativeApprovalApproveOutcome =
  | Readonly<{ kind: 'approved'; inputAttemptCount: number }>
  | Readonly<{
      kind: 'refused';
      result: 'rejected' | 'paused' | 'canceled';
      reasonCode: string;
      inputAttemptCount: number;
    }>
  // Wrong keys, types, correlation or ok / reasonCode / deniedResult combination. Nothing was input.
  | Readonly<{
      kind: 'invalid';
      result: 'rejected';
      reasonCode: 'native_approval_receipt_invalid';
    }>;

const NATIVE_APPROVAL_APPROVE_KEYS = [
  'ok',
  'reasonCode',
  'deniedResult',
  'sessionId',
  'requestId',
  'cancelEpoch',
  'observationRevision',
  'approvalGeneration',
  'inputAttemptCount',
] as const;

/**
 * Validates the nine-key `approvalApprove` receipt (ADR v2 S4-4 addendum). `approvalApprove` has no
 * input capability, so every violation is a typed pre-input result, never an exception. The input
 * attempt count is returned for the caller to check against its own non-regression record, because
 * a count that went backwards may mean input happened and keeps throwing there, like preflight.
 * Nothing calls this yet; the controller connection is a later change.
 */
export function parseNativeApprovalApproveReceipt(
  value: unknown,
  expected: NativeApprovalApproveExpectation,
): NativeApprovalApproveOutcome {
  const invalid = Object.freeze({
    kind: 'invalid',
    result: 'rejected',
    reasonCode: 'native_approval_receipt_invalid',
  } as const);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== NATIVE_APPROVAL_APPROVE_KEYS.length ||
    NATIVE_APPROVAL_APPROVE_KEYS.some((key) => !keys.includes(key)) ||
    record['sessionId'] !== expected.sessionId ||
    record['requestId'] !== expected.requestId ||
    record['cancelEpoch'] !== expected.cancelEpoch ||
    record['observationRevision'] !== expected.observationRevision ||
    record['approvalGeneration'] !== expected.approvalGeneration
  )
    return invalid;
  const { ok, reasonCode, deniedResult, inputAttemptCount } = record;
  if (
    typeof ok !== 'boolean' ||
    typeof inputAttemptCount !== 'number' ||
    !Number.isSafeInteger(inputAttemptCount) ||
    inputAttemptCount < 0
  )
    return invalid;
  if (ok) {
    if (reasonCode !== null || deniedResult !== null) return invalid;
    return { kind: 'approved', inputAttemptCount };
  }
  if (
    typeof reasonCode !== 'string' ||
    (deniedResult !== 'rejected' && deniedResult !== 'paused' && deniedResult !== 'canceled') ||
    !computerUseActionResultSchema.partial().safeParse({ result: deniedResult, reasonCode }).success
  )
    return invalid;
  return { kind: 'refused', result: deniedResult, reasonCode, inputAttemptCount };
}

/** The typed, pre-input result for a receipt that failed validation; null for any other error. */
function nativePreflightInvalidResult(error: unknown): ComputerUseNativeActionResult | null {
  if (
    error !== null &&
    !(
      error instanceof ComputerUseNativeUnavailableError &&
      (error as { reasonCode?: unknown }).reasonCode === 'native_preflight_invalid'
    )
  )
    return null;
  return Object.freeze({ result: 'rejected', reasonCode: 'native_preflight_invalid' });
}

/**
 * The answer of the native read of one node. Exactly `{ ok: true, text }` with a non-empty text of at
 * most the artifact byte bound (the contracts'), or `{ ok: false }`. Anything else, an extra key, a
 * text over the bound or a non-string, is the same refusal, so the planner learns nothing from it.
 */
export function parseNativeNodeValue(value: unknown): ComputerUseNativeNodeValue {
  const refused = Object.freeze({ ok: false as const });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refused;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record['ok'] !== true || keys.length !== 2 || !keys.includes('text')) return refused;
  const text = record['text'];
  if (typeof text !== 'string' || text.length === 0) return refused;
  if (Buffer.byteLength(text, 'utf8') > COMPUTER_USE_ARTIFACT_LIMITS.maxBytes) return refused;
  return Object.freeze({ ok: true as const, text });
}

function hasMethod(
  addon: ComputerUseNativeAddon | null,
  method: NativeMethod,
): addon is ComputerUseNativeAddon & Record<NativeMethod, (input: unknown) => unknown> {
  return addon !== null && typeof addon[method] === 'function';
}

function runtimePlatformFor(platform: NodeJS.Platform): RuntimePlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform;
  return 'other';
}

function manifestDigest(
  manifest: ComputerUseNativeManifest,
  platform: RuntimePlatform,
): string | null {
  if (platform !== 'darwin' && platform !== 'win32') return null;
  return platform === 'darwin' ? manifest.moduleDigest : manifest.binaryDigest;
}

function normalizeReason(reason: string): string {
  return reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function asRecord(value: unknown, reason: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ComputerUseNativeUnavailableError(reason);
  return value as Record<string, unknown>;
}

function parseNativeSession(
  raw: Readonly<Record<string, unknown>>,
  platform: NativePlatform,
  input: {
    profile: { identityDigest: string; revision: number };
    windowId: string;
    sessionId: string;
    cancelEpoch: number;
  },
  requestBindings: Readonly<Record<string, unknown>>,
  windowsPhysicalBoundsToDip?: (bounds: ComputerUseNativeBounds) => ComputerUseNativeBounds,
  backgroundInputForTesting = false,
): InternalNativeSession {
  const sessionId = stringField(raw, 'sessionId', input.sessionId);
  const windowId = stringField(raw, 'windowId', input.windowId);
  const appIdentityDigest = stringField(raw, 'appIdentityDigest');
  const windowIdentityDigest = stringField(raw, 'windowIdentityDigest');
  const profileRevision = numberField(raw, 'profileRevision', input.profile.revision);
  const cancelEpoch = numberField(raw, 'cancelEpoch', input.cancelEpoch);
  const processIdentity =
    platform === 'win32' ? { processStartTime: parseWindowsProcessStartTime(raw) } : {};
  const inputSession =
    raw['inputSession'] === undefined
      ? undefined
      : computerUseInputSessionSchema.safeParse(raw['inputSession']);
  if (
    inputSession !== undefined &&
    (!inputSession.success ||
      platform !== 'win32' ||
      (inputSession.data.kind === 'background' &&
        !COMPUTER_USE_WINDOWS_BACKGROUND_INPUT_ENABLED &&
        !backgroundInputForTesting))
  )
    throw new ComputerUseNativeUnavailableError('native_session_invalid');
  const policyLanguage = nativePolicyLanguage(raw);
  if (
    platform === 'win32' &&
    nativeMaximumMode(raw) === 'supervised' &&
    nativeMaximumMode(requestBindings) === 'observe_only'
  )
    throw new ComputerUseNativeUnavailableError('native_approval_ceiling_mismatch');
  const maximumMode = bindComputerUseMaximumMode(
    nativeMaximumMode(requestBindings),
    nativeMaximumMode(raw),
  );
  const rawScreenBounds = parseNativeBounds(raw['screenBounds']);
  const screenBounds =
    platform === 'win32' ? windowsPhysicalBoundsToDip?.(rawScreenBounds) : rawScreenBounds;
  if (
    sessionId !== input.sessionId ||
    windowId !== input.windowId ||
    appIdentityDigest !== input.profile.identityDigest ||
    profileRevision !== input.profile.revision
  )
    throw new ComputerUseNativeUnavailableError('native_session_identity_mismatch');
  if (screenBounds === undefined)
    throw new ComputerUseNativeUnavailableError('native_window_coordinate_invalid');
  // startResult is per-start evidence; a stored copy would be re-sent by a later existing start.
  const { startResult, ...response } = raw;
  void startResult;
  return Object.freeze({
    sessionId,
    platform,
    ...(inputSession?.success ? { inputSession: inputSession.data } : {}),
    appIdentityDigest,
    windowIdentityDigest,
    windowId,
    profileRevision,
    cancelEpoch,
    policyLanguage,
    maximumMode,
    screenBounds,
    // The native response intentionally exposes no OS handles beyond its bounded envelope. Keep
    // Main's already-verified geometry/path bindings so an explicit resume can re-submit them,
    // while authority-bearing response facts (especially policyLanguage) always win.
    raw: Object.freeze({
      ...requestBindings,
      ...response,
      ...processIdentity,
      policyLanguage,
      maximumMode,
    }),
  });
}

function parseWindowsProcessStartTime(raw: Readonly<Record<string, unknown>>): string | null {
  const value = raw['processStartTime'];
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(value) ||
    BigInt(value) > 18_446_744_073_709_551_615n
  )
    throw new ComputerUseNativeUnavailableError('native_session_invalid');
  return value;
}

function publicNativeSession(session: InternalNativeSession): ComputerUseNativeSession {
  return Object.freeze({
    sessionId: session.sessionId,
    ...(session.inputSession === undefined ? {} : { inputSession: session.inputSession }),
    platform: session.platform,
    appIdentityDigest: session.appIdentityDigest,
    windowIdentityDigest: session.windowIdentityDigest,
    windowId: session.windowId,
    profileRevision: session.profileRevision,
    cancelEpoch: session.cancelEpoch,
    policyLanguage: session.policyLanguage,
    maximumMode: session.maximumMode,
    screenBounds: session.screenBounds,
  });
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  fallback?: string,
): string {
  const candidate = value[key];
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  if (fallback !== undefined) return fallback;
  throw new ComputerUseNativeUnavailableError('native_session_invalid');
}

function numberField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const candidate = value[key];
  if (candidate === undefined) return fallback;
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0)
    throw new ComputerUseNativeUnavailableError('native_session_invalid');
  return candidate;
}

function stripNativeEphemeralFields(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result = { ...value };
  delete result['pid'];
  delete result['processId'];
  delete result['windowHandle'];
  delete result['boundsUnit'];
  return result;
}

function nativeWindowExecutableDigest(
  value: Readonly<Record<string, unknown>>,
  profile: Readonly<{
    platform: 'darwin' | 'win32';
    identityDigest: string;
    executableDigest: string | null;
    identity: Readonly<Record<string, unknown>>;
  }>,
): string | null {
  if (profile.platform !== 'win32') return null;
  const executableDigest = value['executableDigest'];
  if (typeof executableDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(executableDigest))
    throw new ComputerUseNativeUnavailableError('native_app_identity_changed');
  if (value['appIdentityDigest'] !== profile.identityDigest)
    throw new ComputerUseNativeUnavailableError('native_app_identity_changed');
  const signerDigest = profile.identity['signerDigest'];
  if (
    executableDigest !== profile.executableDigest &&
    (typeof signerDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(signerDigest))
  )
    throw new ComputerUseNativeUnavailableError('native_app_identity_changed');
  return executableDigest;
}

function parseNativeBounds(value: unknown): ComputerUseNativeBounds {
  const bounds = asRecord(value, 'native_window_coordinate_invalid');
  const parsed = {
    x: bounds['x'],
    y: bounds['y'],
    width: bounds['width'],
    height: bounds['height'],
  };
  if (
    !Object.values(parsed).every((item) => typeof item === 'number' && Number.isFinite(item)) ||
    Number(parsed.width) <= 0 ||
    Number(parsed.height) <= 0 ||
    Number(parsed.width) > 32_768 ||
    Number(parsed.height) > 32_768
  )
    throw new ComputerUseNativeUnavailableError('native_window_coordinate_invalid');
  return {
    x: Number(parsed.x),
    y: Number(parsed.y),
    width: Number(parsed.width),
    height: Number(parsed.height),
  };
}

/**
 * The v2 interlock refusals a dispatch can still make on its own (#500 S5-c-2 PR-5): the native
 * evaluates the interlocks again right before any input. Each is the dispatch code of a preflight
 * refusal, so it takes the result of the same row of NATIVE_PREFLIGHT_REFUSALS: a block is rejected
 * and an execution trigger is paused for a person. Shared with macOS (dispatchApproved).
 */
const NATIVE_DISPATCH_INTERLOCK_CODES: ReadonlySet<string> = new Set([
  'SHELL_SURFACE_BLOCKED',
  'EXECUTION_TRIGGER_BLOCKED',
  'APPROVAL_NOT_ENABLED',
]);

export function classifyComputerUseNativeDispatchFailure(
  error: unknown,
): ComputerUseNativeActionResult | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; accepted?: unknown };
  if (candidate.accepted === true || typeof candidate.code !== 'string') return null;
  const code = candidate.code.toUpperCase();
  if (code === 'CANCELED')
    return Object.freeze({ result: 'canceled', reasonCode: 'native_canceled_pre_dispatch' });
  const preDispatchCodes = new Set([
    'INVALID_ACTION',
    'NATIVE_CAPABILITY_UNAVAILABLE',
    'FOCUS_REQUIRED',
    'APP_IDENTITY_CHANGED',
    'WINDOW_UNAVAILABLE',
    'STALE_TARGET',
    'TARGET_REQUIRED',
    'TARGET_UNCLASSIFIED',
    'SECURE_FIELD_BLOCKED',
    'HIGH_IMPACT_BLOCKED',
    'UNSUPPORTED_ACTION',
    'INPUT_UNAVAILABLE',
    'SESSION_MISSING',
    'SESSION_IDENTITY_CHANGED',
    'SESSION_TARGET_REJECTED',
    'WINDOW_IDENTITY_CHANGED',
    'WINDOW_GEOMETRY_CHANGED',
    'WINDOW_NOT_SHAREABLE',
    'ELEVATED_TARGET_BLOCKED',
    'TARGET_AMBIGUOUS',
    'TARGET_INELIGIBLE',
    'SEMANTIC_PATTERN_UNAVAILABLE',
    'SEMANTIC_STATE_UNAVAILABLE',
    'SEMANTIC_ACTION_FAILED',
    'INVALID_KEY',
    'INVALID_TEXT',
    'INVALID_TARGET',
    ...NATIVE_DISPATCH_INTERLOCK_CODES,
  ]);
  if (candidate.accepted !== false && !preDispatchCodes.has(code)) return null;
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return null;
  if (NATIVE_DISPATCH_INTERLOCK_CODES.has(code)) {
    const reasonCode = `native_${code.toLowerCase()}`;
    const row = NATIVE_PREFLIGHT_REFUSALS.find((entry) => entry.reasonCode === reasonCode);
    // The table owns the result; a code with no row stays a plain rejection.
    return Object.freeze({ result: row?.deniedResult ?? 'rejected', reasonCode });
  }
  return Object.freeze({
    result: 'rejected',
    reasonCode: `native_${code.toLowerCase()}`.slice(0, 64),
  });
}

function toObservation(
  value: unknown,
  session: ComputerUseNativeSession,
  revisions: Map<string, number>,
  now: () => number,
  windowsPhysicalBoundsToDip?: (bounds: ComputerUseNativeBounds) => ComputerUseNativeBounds,
): ComputerUseObservation {
  const raw = asRecord(value, 'native_observation_invalid');
  const rawScreenBounds = parseNativeBounds(raw['screenBounds']);
  const screenBounds =
    session.platform === 'win32' ? windowsPhysicalBoundsToDip?.(rawScreenBounds) : rawScreenBounds;
  if (screenBounds === undefined)
    throw new ComputerUseNativeUnavailableError('native_window_coordinate_invalid');
  const maximumMode = bindComputerUseMaximumMode(session.maximumMode, nativeMaximumMode(raw));
  // Test/native adapters may already return the canonical contract. Keep the check strict while
  // still accepting the low-level `{screenshot, tree, captureWidth, ...}` payload emitted by the
  // Objective-C++ module.
  if (Array.isArray(raw['images'])) {
    const parsed = computerUseObservationSchema.parse({
      ...raw,
      policyLanguage: nativePolicyLanguage(raw),
      maximumMode,
      screenBounds,
    });
    const sanitized = sanitizeCanonicalObservationTree(parsed);
    revisions.set(session.sessionId, sanitized.revision);
    return sanitized;
  }
  const screenshot = bytesValue(raw['screenshot']);
  if (screenshot === null || screenshot.byteLength === 0 || screenshot.byteLength > 8 * 1024 * 1024)
    throw new ComputerUseNativeUnavailableError('native_screenshot_invalid');
  const width = requiredCaptureDimension(raw['captureWidth'] ?? raw['clientWidth'], 2_560);
  const height = requiredCaptureDimension(raw['captureHeight'] ?? raw['clientHeight'], 1_600);
  const tree = typeof raw['tree'] === 'string' ? raw['tree'] : undefined;
  const projection = tree === undefined ? null : projectNativeAccessibilityTree(tree);
  const prior = revisions.get(session.sessionId) ?? 0;
  const revision = Math.max(prior + 1, positiveDimension(raw['revision']) || 1);
  const observedAtMs = now();
  const observedAt = new Date(observedAtMs).toISOString();
  const parsed = computerUseObservationSchema.parse({
    sessionId: session.sessionId,
    appIdentityDigest: session.appIdentityDigest,
    windowIdentityDigest: session.windowIdentityDigest,
    profileRevision: session.profileRevision,
    policyLanguage: nativePolicyLanguage(raw),
    maximumMode,
    screenBounds,
    revision,
    observedAt,
    // Keep a small margin under the contract TTL so timestamp rounding or a slow tree projection
    // cannot make a freshly captured observation appear already invalid.
    expiresAt: new Date(observedAtMs + 29_000).toISOString(),
    clientWidth: width,
    clientHeight: height,
    images: [
      {
        mimeType: raw['screenshotMimeType'] === 'image/jpeg' ? 'image/jpeg' : 'image/png',
        digest: sha256(screenshot),
        byteLength: screenshot.byteLength,
        width,
        height,
        base64: screenshot.toString('base64'),
      },
    ],
    treeDigest: projection?.digest ?? null,
    treeByteLength: projection?.byteLength ?? 0,
    treeDepth: projection?.depth ?? 0,
    treeNodeCount: projection?.nodeCount ?? 0,
    ...(projection === null ? {} : { accessibilityTree: projection.serialized }),
    ...(projection === null
      ? {}
      : {
          targetSignatures: projection.signatures,
          targetMetadata: projection.metadata,
        }),
    focusedElementSignature:
      raw['focusedElementSignature'] === null
        ? null
        : typeof raw['focusedElementSignature'] === 'string'
          ? raw['focusedElementSignature']
          : undefined,
    ...(typeof raw['focusedElementSecure'] === 'boolean'
      ? { focusedElementSecure: raw['focusedElementSecure'] }
      : {}),
    ...(typeof raw['focusedElementHighImpact'] === 'boolean'
      ? { focusedElementHighImpact: raw['focusedElementHighImpact'] }
      : {}),
    dialogSetRevision: raw['dialogSetRevision'] ?? 0,
    dialogSetDigest: raw['dialogSetDigest'] ?? null,
    activeWindowIdentityDigest: raw['activeWindowIdentityDigest'] ?? null,
    activeWindowKind: raw['activeWindowKind'] ?? 'application',
  });
  revisions.set(session.sessionId, parsed.revision);
  return parsed;
}

export function deriveComputerUseTargetFacts(tree: string): Readonly<{
  signatures: Readonly<Record<string, string>>;
  metadata: Readonly<Record<string, Readonly<{ secure: boolean; highImpact: boolean }>>>;
}> {
  const projection = projectNativeAccessibilityTree(tree);
  return Object.freeze({
    signatures: projection.signatures,
    metadata: projection.metadata,
  });
}

function projectNativeAccessibilityTree(
  tree: string,
): ReturnType<typeof projectComputerUseAccessibilityTree> {
  try {
    return projectComputerUseAccessibilityTree(tree);
  } catch (error) {
    if (error instanceof ComputerUseAccessibilityTreeError)
      throw new ComputerUseNativeUnavailableError(
        error.code === 'tree_oversized' ? 'native_tree_oversized' : 'native_tree_invalid',
      );
    throw error;
  }
}

function sanitizeCanonicalObservationTree(
  observation: ComputerUseObservation,
): ComputerUseObservation {
  if (observation.accessibilityTree === undefined || observation.accessibilityTree === '') {
    if (observation.treeDigest !== null || observation.treeByteLength !== 0)
      throw new ComputerUseNativeUnavailableError('native_tree_invalid');
    const {
      accessibilityTree: _tree,
      targetSignatures: _signatures,
      targetMetadata: _metadata,
      ...rest
    } = observation;
    return computerUseObservationSchema.parse({
      ...rest,
      treeDepth: 0,
      treeNodeCount: 0,
    });
  }
  const projection = projectNativeAccessibilityTree(observation.accessibilityTree);
  const targetMetadata: Record<
    string,
    { secure: boolean; highImpact: boolean; highImpactNative?: boolean; surface?: boolean }
  > = { ...projection.metadata };
  for (const [targetId, facts] of Object.entries(observation.targetMetadata ?? {})) {
    const projectedFacts = targetMetadata[targetId];
    targetMetadata[targetId] = {
      secure: projectedFacts?.secure === true || facts.secure === true,
      highImpact: projectedFacts?.highImpact === true || facts.highImpact === true,
      // The incoming observation is native's; only its own flag counts as native's judgement.
      highImpactNative: facts.highImpact === true,
      // Main's own evidence only: native's metadata does not carry a surface.
      ...(projectedFacts?.surface === true ? { surface: true } : {}),
    };
  }
  return computerUseObservationSchema.parse({
    ...observation,
    accessibilityTree: projection.serialized,
    treeDigest: projection.digest,
    treeByteLength: projection.byteLength,
    treeDepth: projection.depth,
    treeNodeCount: projection.nodeCount,
    targetSignatures: { ...projection.signatures, ...observation.targetSignatures },
    targetMetadata,
  });
}

function bytesValue(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function nativePolicyLanguage(value: Readonly<Record<string, unknown>>): ComputerUsePolicyLanguage {
  const candidate = value['policyLanguage'];
  if (candidate === undefined || candidate === null) return 'unknown';
  const parsed = computerUsePolicyLanguageSchema.safeParse(candidate);
  if (!parsed.success)
    throw new ComputerUseNativeUnavailableError('native_policy_language_invalid');
  return parsed.data;
}

/** Missing or malformed native capability evidence never authorizes control. */
function nativeMaximumMode(value: Readonly<Record<string, unknown>>): ComputerUseMode {
  const parsed = computerUseModeSchema.safeParse(value['maximumMode']);
  return parsed.success ? parsed.data : 'observe_only';
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function positiveDimension(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 1;
}

function requiredCaptureDimension(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)
    throw new ComputerUseNativeUnavailableError('native_capture_dimensions_invalid');
  return Number(value);
}

function validStartTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,19}$/u.test(value) &&
    BigInt(value) <= 0xffff_ffff_ffff_ffffn
  );
}
