import type { ComputerAppProfileRecord } from './persistence';
import type { ComputerUseNativeHost, ComputerUseNativeWindow } from './computer-use-controller';
import type { ComputerUseDiscoveryHandle } from './computer-use-native-discovery';

/** Main-only lifetime: cancellation remains live until the caller commits its result. */
export class ComputerUseDiscoveryScope {
  readonly controller = new AbortController();
  readonly profileIds = new Set<string>();
  private readonly handles = new Set<
    ComputerUseDiscoveryHandle<readonly ComputerUseNativeWindow[]>
  >();
  private stopping: Promise<void> | null = null;
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
    private readonly native: ComputerUseNativeHost,
    private readonly retired: () => void,
    private readonly externalSignal?: AbortSignal,
  ) {
    void this.canceled.catch(() => undefined);
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
      throw error;
    }
  }

  onCancel(rollback: () => void): void {
    this.check();
    this.rollback.add(rollback);
  }

  stop(retry = true): Promise<void> {
    if (this.stopping !== null && (!retry || !this.stopFailed)) return this.stopping;
    this.stopFailed = false;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const stopping = new Promise<void>((yes, no) => {
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
        await handle.stop();
        this.handles.delete(handle);
      }),
    ).then(
      () => {
        this.rejectCanceled(this.signal.reason);
        this.retireIfFinished();
        resolve();
      },
      () => {
        if (this.stopping === stopping) this.stopFailed = true;
        const error = new Error('Computer Use native_stop_unconfirmed');
        this.rejectCanceled(error);
        reject(error);
      },
    );
    return stopping;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      this.check();
      return await work();
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

  private retireIfFinished(): void {
    if (this.finished && this.handles.size === 0) this.retired();
  }
}
