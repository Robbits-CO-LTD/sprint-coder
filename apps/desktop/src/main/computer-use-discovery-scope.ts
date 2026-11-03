import { sameWindowsStopOwner, type WindowsStopOwner } from './computer-use-windows-stop-delivery';
import type { ComputerUseStopReason } from '@sprint-coder/contracts';
import type { ComputerAppProfileRecord } from './persistence';
import type { ComputerUseNativeHost, ComputerUseNativeWindow } from './computer-use-controller';
import type {
  ComputerUseDiscoveryHandle,
  ComputerUseDiscoveryStop,
} from './computer-use-native-discovery';

export type ComputerUseDiscoveryResult = Readonly<{
  kind: 'discovery_result';
  late: boolean;
  taskId: string | null;
  turnId: string | null;
  reason: ComputerUseStopReason | 'native_stop_unconfirmed';
  results: readonly ComputerUseDiscoveryStop[];
}>;

/** Main-only lifetime: cancellation remains live until the caller commits its result. */
export class ComputerUseDiscoveryScope {
  readonly controller = new AbortController();
  readonly profileIds = new Set<string>();
  private readonly handles = new Set<
    ComputerUseDiscoveryHandle<readonly ComputerUseNativeWindow[]>
  >();
  private stopping: Promise<ComputerUseDiscoveryResult> | null = null;
  private readonly stopOwners = new Map<string, WindowsStopOwner>();
  private readonly lateResults = new Set<string>();
  private readonly unsubscribeStop: (() => void) | undefined;
  private requestedReason: ComputerUseStopReason = 'user_stop';
  private interrupted = false;
  private finished = false;
  private stopFailed = false;
  private readonly rollback = new Set<() => void>();
  private rejectCanceled!: (error: unknown) => void;
  private readonly canceled = new Promise<never>((_resolve, reject) => {
    this.rejectCanceled = reject;
  });
  private readonly forward = () => {
    void this.stop().catch(() => undefined);
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
          notification.reason === 'requested_reason' ? this.requestedReason : 'native_unavailable',
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
      if (this.signal.aborted) {
        await this.stop(false);
        throw this.signal.reason;
      }
      if (this.native.subscribeWindowsStop !== undefined && error instanceof Error) {
        const result = await this.stop(false);
        Object.assign(error, { discoveryResult: result });
      }
      throw error;
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
    this.stopFailed = false;
    this.requestedReason = reason;
    let resolve!: (result: ComputerUseDiscoveryResult) => void;
    let reject!: (error: unknown) => void;
    const stopping = new Promise<ComputerUseDiscoveryResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.stopping = stopping;
    this.controller.abort(new Error('Computer Use discovery canceled'));
    for (const undo of this.rollback) undo();
    this.rollback.clear();
    // Publish/latch before callbacks; a pending native result is never awaited by Stop.
    void Promise.all(
      [...this.handles].map(async (handle) => {
        const result = await handle.stop();
        this.handles.delete(handle);
        return result;
      }),
    ).then(
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
      await this.stop(false);
      throw error;
    } finally {
      this.finish();
    }
  }

  finish(): void {
    this.finished = true;
    this.rollback.clear();
    this.externalSignal?.removeEventListener('abort', this.forward);
    this.retireIfFinished();
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
      this.retired();
    }
  }
}
