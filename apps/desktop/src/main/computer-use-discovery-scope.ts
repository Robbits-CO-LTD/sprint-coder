import { sameWindowsStopOwner, type WindowsStopOwner } from './computer-use-windows-stop-delivery';
import { computerUseStopReasonSchema, type ComputerUseStopReason } from '@sprint-coder/contracts';
import type { ComputerAppProfileRecord } from './persistence';
import type { ComputerUseNativeHost, ComputerUseNativeWindow } from './computer-use-controller';
import type {
  ComputerUseDiscoveryHandle,
  ComputerUseDiscoveryStop,
} from './computer-use-native-discovery';
import { ComputerUseNativeUnavailableError } from './computer-use-native-host';

import type { ComputerUseDiscoveryResult } from '@sprint-coder/contracts';
export type { ComputerUseDiscoveryResult } from '@sprint-coder/contracts';

/** Main-only lifetime: cancellation remains live until the caller commits its result. */
export class ComputerUseDiscoveryScope {
  readonly controller = new AbortController();
  readonly profileIds = new Set<string>();
  private readonly handles = new Set<
    ComputerUseDiscoveryHandle<readonly ComputerUseNativeWindow[]>
  >();
  private readonly completedHandles = new Set<
    ComputerUseDiscoveryHandle<readonly ComputerUseNativeWindow[]>
  >();
  private stopping: Promise<ComputerUseDiscoveryResult> | null = null;
  private readonly stopOwners = new Map<string, WindowsStopOwner>();
  private readonly lateResults = new Set<string>();
  private readonly unsubscribeStop: (() => void) | undefined;
  private requestedReason: ComputerUseStopReason | null = null;
  // One stop per handle, kept so a handle that completes after an earlier drain is still included.
  private readonly drained = new Map<
    ComputerUseDiscoveryHandle<readonly ComputerUseNativeWindow[]>,
    Promise<ComputerUseDiscoveryStop>
  >();
  private interrupted = false;
  // Cleanup after an internal failure: shared by every reader, never latches a Stop reason.
  private internal: Promise<ComputerUseDiscoveryStop[]> | null = null;
  private finished = false;
  private stopFailed = false;
  private readonly rollback = new Set<() => void>();
  private rejectCanceled!: (error: unknown) => void;
  private readonly canceled = new Promise<never>((_resolve, reject) => {
    this.rejectCanceled = reject;
  });
  private readonly forward = () => {
    const reason = computerUseStopReasonSchema.safeParse(this.externalSignal?.reason);
    void this.stop(true, reason.success ? reason.data : 'user_stop').catch(() => undefined);
  };

  constructor(
    readonly taskId: string | null,
    readonly turnId: string | null,
    readonly cardId: string | null,
    readonly actor: string | null,
    private readonly native: Pick<
      ComputerUseNativeHost,
      'beginWindowDiscovery' | 'listWindows' | 'subscribeWindowsStop'
    >,
    private readonly retired: () => void,
    private readonly externalSignal?: AbortSignal,
    private readonly publishResult?: (result: ComputerUseDiscoveryResult) => void,
  ) {
    void this.canceled.catch(() => undefined);
    this.unsubscribeStop = native.subscribeWindowsStop?.((event) => {
      if (event.kind === 'registered') {
        if (
          event.owner.kind === 'discovery' &&
          [...this.handles].some((handle) => handle.id === event.owner.id)
        )
          this.stopOwners.set(event.owner.id, event.owner);
        return;
      }
      if (event.kind !== 'notification') return;
      const notification = event.notification;
      const owner = this.stopOwners.get(notification.owner.id);
      if (owner === undefined || !sameWindowsStopOwner(owner, notification.owner)) return;
      if (notification.reason === 'native_unavailable') this.interrupted = true;
      // An internal failure's automatic Stop registers this owner too. Its late exit is reported
      // as native_unavailable below rather than dropped; no requested reason is invented.
      if (
        notification.phase !== 'exit_confirmed' ||
        !notification.late ||
        notification.result === 'termination_requested' ||
        this.lateResults.has(owner.lifetimeId)
      )
        return;
      this.lateResults.add(owner.lifetimeId);
      this.publish({
        kind: 'discovery_result',
        late: true,
        taskId: this.taskId,
        turnId: this.turnId,
        reason:
          notification.reason === 'requested_reason'
            ? (this.requestedReason ?? 'native_unavailable')
            : 'native_unavailable',
        results: [
          {
            kind: 'terminated',
            helperGeneration: owner.helperGeneration,
            result: notification.result,
          },
        ],
      });
    });
    externalSignal?.addEventListener('abort', this.forward, { once: true });
    if (externalSignal?.aborted) this.forward();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  check(): void {
    this.signal.throwIfAborted();
    if (this.finished) throw new Error('Computer Use discovery scope is closed');
  }

  async read(profile: ComputerAppProfileRecord): Promise<readonly ComputerUseNativeWindow[]> {
    this.check();
    this.profileIds.add(profile.id);
    const handle = this.native.beginWindowDiscovery?.(profile);
    if (handle !== undefined) {
      this.handles.add(handle);
      void handle.terminal.then(() => {
        this.completedHandles.add(handle);
        this.handles.delete(handle);
        this.retireIfFinished();
      });
    }
    // macOS retains its existing native path; cancellation here makes no native drain claim.
    const result = handle?.result ?? this.native.listWindows(profile);
    try {
      const windows = await Promise.race([result, this.canceled]);
      this.check();
      return windows;
    } catch (error) {
      if (this.signal.aborted) return await this.rethrowCanceled();
      // macOS makes no native drain claim: the failed application alone is skipped, as before.
      if (handle === undefined) throw error;
      const proof = await this.stopHandle(handle).catch(() => null);
      // This query's stop is confirmed and its helper lives on, so the other applications stay
      // usable: only this application fails.
      const ownFailure = proof !== null && proof.kind !== 'terminated';
      if (this.signal.aborted) {
        // A Stop arrived while this query's own failure was being confirmed.
        await (this.stopping ?? this.settleInternally(this.signal.reason));
        throw ownFailure ? error : this.signal.reason;
      }
      if (ownFailure) throw error;
      if (proof === null) {
        // Unconfirmed stop invalidates the whole scope; this rejects with that result.
        await this.settleInternally(error);
        throw error;
      }
      // The helper generation ended under every query of this scope.
      const failure = new Error(
        error instanceof Error ? error.message : 'Computer Use discovery failed',
        { cause: error },
      );
      const results = await this.settleInternally(failure);
      throw Object.assign(failure, {
        discoveryResult: this.discoveryResult('native_unavailable', results),
      });
    }
  }

  onCancel(rollback: () => void): void {
    this.check();
    this.rollback.add(rollback);
  }

  stop(
    retry = true,
    reason: ComputerUseStopReason = 'user_stop',
  ): Promise<ComputerUseDiscoveryResult> {
    if (
      this.stopping !== null &&
      (!retry || !this.stopFailed || this.native.subscribeWindowsStop !== undefined)
    )
      return this.stopping;
    if (this.stopFailed && this.native.subscribeWindowsStop === undefined) this.drained.clear();
    this.stopFailed = false;
    this.requestedReason = reason;
    let resolve!: (result: ComputerUseDiscoveryResult) => void;
    let reject!: (error: unknown) => void;
    const stopping = new Promise<ComputerUseDiscoveryResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.stopping = stopping;
    this.cancelWork(new Error('Computer Use discovery canceled'));
    // Publish/latch before callbacks; a pending native result is never awaited by Stop.
    void this.drain().then(
      (results) => {
        const result: ComputerUseDiscoveryResult = {
          kind: 'discovery_result',
          late: false,
          taskId: this.taskId,
          turnId: this.turnId,
          reason: this.interrupted ? 'native_unavailable' : reason,
          results,
        };
        Object.assign(this.signal.reason, { discoveryResult: result });
        this.rejectCanceled(this.signal.reason);
        this.retireIfFinished();
        resolve(result);
        this.publish(result);
      },
      () => {
        if (this.stopping === stopping) this.stopFailed = true;
        const error = Object.assign(new Error('Computer Use native_stop_unconfirmed'), {
          discoveryResult: {
            kind: 'discovery_result',
            late: false,
            taskId: this.taskId,
            turnId: this.turnId,
            reason: 'native_stop_unconfirmed',
            results: [],
          } satisfies ComputerUseDiscoveryResult,
        });
        this.rejectCanceled(error);
        reject(error);
        this.publish(error.discoveryResult);
      },
    );
    return stopping;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      this.check();
      const result = await work();
      if (!this.finished) this.check();
      return result;
    } catch (error) {
      await this.fail(error);
      throw error;
    } finally {
      this.finish();
    }
  }

  /** Internal failure cleanup; rejects only when native cleanup cannot be confirmed. */
  async fail(error: unknown): Promise<void> {
    if (this.stopping !== null) await this.stopping;
    else await this.settleInternally(error);
  }

  finish(): void {
    this.finished = true;
    this.rollback.clear();
    this.externalSignal?.removeEventListener('abort', this.forward);
    this.retireIfFinished();
  }

  private async rethrowCanceled(): Promise<never> {
    await (this.stopping ?? this.settleInternally(this.signal.reason));
    throw this.signal.reason;
  }

  private stopHandle(
    handle: ComputerUseDiscoveryHandle<readonly ComputerUseNativeWindow[]>,
  ): Promise<ComputerUseDiscoveryStop> {
    let stopping = this.drained.get(handle);
    if (stopping === undefined) {
      stopping = handle.stop().then((result) => {
        this.handles.delete(handle);
        return result;
      });
      this.drained.set(handle, stopping);
    }
    return stopping;
  }

  private drain(): Promise<ComputerUseDiscoveryStop[]> {
    const all = [...new Set([...this.completedHandles, ...this.handles])];
    return Promise.all(all.map((handle) => this.stopHandle(handle))).catch((error: unknown) => {
      this.stopFailed = true;
      throw error;
    });
  }

  /** Internal failure needs native cleanup, but must not invent a requested Stop reason. */
  private settleInternally(error: unknown): Promise<ComputerUseDiscoveryStop[]> {
    this.cancelWork(error);
    this.internal ??= this.drain().then(
      (results) => {
        this.rejectCanceled(this.signal.reason);
        if (results.some((result) => result.kind === 'terminated'))
          this.publish(this.discoveryResult('native_unavailable', results));
        return results;
      },
      (stopError: unknown) => {
        // A fresh error: the drained Promise hands the same rejection to every reader.
        const failure = Object.assign(
          new ComputerUseNativeUnavailableError('native_stop_unconfirmed'),
          {
            cause: stopError,
            discoveryResult: this.discoveryResult('native_stop_unconfirmed', []),
          },
        );
        this.rejectCanceled(failure);
        this.publish(failure.discoveryResult);
        throw failure;
      },
    );
    return this.internal;
  }

  private discoveryResult(
    reason: ComputerUseDiscoveryResult['reason'],
    results: ComputerUseDiscoveryStop[],
  ): ComputerUseDiscoveryResult {
    return {
      kind: 'discovery_result',
      late: false,
      taskId: this.taskId,
      turnId: this.turnId,
      reason,
      results,
    };
  }

  private cancelWork(error: unknown): void {
    this.controller.abort(
      error instanceof Error ? error : new Error('Computer Use discovery failed'),
    );
    for (const undo of this.rollback) undo();
    this.rollback.clear();
  }

  private publish(result: ComputerUseDiscoveryResult): void {
    try {
      this.publishResult?.(result);
    } catch {
      // A notification consumer cannot change the native Stop result.
    }
  }

  private retireIfFinished(): void {
    if (this.finished && this.handles.size === 0) {
      this.unsubscribeStop?.();
      this.stopOwners.clear();
      this.lateResults.clear();
      // Completed proofs stay: a Stop after retirement still reports them. The scope is per Turn.
      this.retired();
    }
  }
}
