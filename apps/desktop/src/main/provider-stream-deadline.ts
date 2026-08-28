export const PROVIDER_FIRST_EVENT_TIMEOUT_MS = 45_000;
export const PROVIDER_IDLE_TIMEOUT_MS = 90_000;
// Local vision inference can spend the ordinary deadline loading its projector and ingesting the
// first image even after the Ollama model preload has completed. Keep the wider bound image-only.
export const OLLAMA_IMAGE_FIRST_EVENT_TIMEOUT_MS = 120_000;

export function providerFirstEventTimeoutMs(
  input: Readonly<{
    providerId: string;
    hasInlineImages: boolean;
  }>,
): number {
  return input.providerId === 'ollama' && input.hasInlineImages
    ? OLLAMA_IMAGE_FIRST_EVENT_TIMEOUT_MS
    : PROVIDER_FIRST_EVENT_TIMEOUT_MS;
}

export type ProviderStreamTimeoutPhase = 'first_event' | 'idle';

export class ProviderStreamTimeoutError extends Error {
  readonly userMessage: string;

  constructor(
    readonly executionId: string,
    readonly phase: ProviderStreamTimeoutPhase,
    readonly timeoutMs: number,
  ) {
    super(
      phase === 'first_event'
        ? 'Provider stream timed out before its first event'
        : 'Provider stream became idle before completion',
    );
    this.name = 'ProviderStreamTimeoutError';
    const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
    this.userMessage =
      phase === 'first_event'
        ? `Providerから${timeoutSeconds}秒間応答がなかったため、このTurnを終了しました。接続とモデル設定を確認して、もう一度お試しください。`
        : `Providerから${timeoutSeconds}秒間新しい応答がなかったため、このTurnを終了しました。接続状態を確認して、もう一度お試しください。`;
  }
}

type DeadlineOptions = Readonly<{
  executionId: string;
  firstEventTimeoutMs: number;
  idleTimeoutMs: number;
}>;

export async function* providerEventsWithDeadline<T>(
  source: AsyncIterable<T>,
  options: DeadlineOptions,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let firstEvent = true;
  let completed = false;
  try {
    while (true) {
      const phase: ProviderStreamTimeoutPhase = firstEvent ? 'first_event' : 'idle';
      const timeoutMs = firstEvent ? options.firstEventTimeoutMs : options.idleTimeoutMs;
      const result = await nextWithDeadline(
        iterator.next(),
        timeoutMs,
        new ProviderStreamTimeoutError(options.executionId, phase, timeoutMs),
      );
      if (result.done) {
        completed = true;
        return;
      }
      firstEvent = false;
      yield result.value;
    }
  } finally {
    // A provider that ignores AbortSignal may also leave iterator.return() pending forever. Invoke
    // cleanup on abnormal exit, but never let that provider-controlled promise hold the Turn open.
    if (!completed && iterator.return !== undefined)
      try {
        void iterator.return().catch(() => undefined);
      } catch {
        // Preserve the deadline error even when a non-conforming provider throws from cleanup.
      }
  }
}

function nextWithDeadline<T>(
  next: Promise<IteratorResult<T>>,
  timeoutMs: number,
  timeoutError: ProviderStreamTimeoutError,
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  return Promise.race([next, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
