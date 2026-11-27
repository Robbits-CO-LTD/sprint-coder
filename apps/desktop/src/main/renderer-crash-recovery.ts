const AUTOMATIC_RELOAD_COOLDOWN_MS = 60_000;

type RendererRecoveryOptions = Readonly<{
  canRecover: () => boolean;
  reload: () => void;
  confirmRetry: () => Promise<boolean>;
  reportFailure: (error: unknown) => void;
  now?: () => number;
}>;

// Keep the main process and its work alive. Only the failed window renderer is re-created.
export function createRendererCrashRecovery({
  canRecover,
  reload,
  confirmRetry,
  reportFailure,
  now = Date.now,
}: RendererRecoveryOptions): (reason: string) => Promise<void> {
  let lastReload: number | undefined;
  let awaitingChoice = false;
  return async (reason) => {
    if (reason !== 'crashed' && reason !== 'abnormal-exit' && reason !== 'oom') return;
    if (awaitingChoice || !canRecover()) return;

    try {
      const time = now();
      if (lastReload === undefined || time - lastReload >= AUTOMATIC_RELOAD_COOLDOWN_MS) {
        lastReload = time;
        reload();
        return;
      }

      // A second immediate crash may be deterministic. Don't leave a blank window or loop.
      awaitingChoice = true;
      if ((await confirmRetry()) && canRecover()) {
        lastReload = now();
        reload();
      }
    } catch (error) {
      reportFailure(error);
    } finally {
      awaitingChoice = false;
    }
  };
}
