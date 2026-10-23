export const FULL_ACCESS_CONFIRMATION_TIMEOUT_MS = 120_000;

export class FullAccessConfirmation {
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  async confirm(show: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    if (this.disposed) return false;
    const controller = new AbortController();
    this.controllers.add(controller);
    let cancel = (): void => undefined;
    const canceled = new Promise<false>((resolve) => {
      cancel = () => resolve(false);
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), FULL_ACCESS_CONFIRMATION_TIMEOUT_MS);
    try {
      // Abort closes the native dialog. Settle independently as well: a delayed native reply
      // must neither hold the Task mailbox nor authorize a change after cancellation.
      const approved = await Promise.race([show(controller.signal), canceled]);
      return !controller.signal.aborted && approved;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
      this.controllers.delete(controller);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
  }
}
