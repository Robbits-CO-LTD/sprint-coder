export const PROVIDER_STREAM_LIMITS = Object.freeze({
  eventBytes: 1024 * 1024,
  toolArgumentBytes: 4 * 1024 * 1024,
  rawStreamBytes: 64 * 1024 * 1024,
  normalizedOutputBytes: 16 * 1024 * 1024,
  persistedTurnBytes: 32 * 1024 * 1024,
  events: 50_000,
  toolCalls: 128,
  callDurationMs: 15 * 60_000,
  turnDurationMs: 30 * 60_000,
});

export type ProviderQuotaKind =
  | 'event_bytes'
  | 'tool_argument_bytes'
  | 'raw_stream_bytes'
  | 'normalized_output_bytes'
  | 'persisted_turn_bytes'
  | 'events'
  | 'tool_calls'
  | 'call_duration'
  | 'turn_duration';

export class ProviderQuotaExceededError extends Error {
  readonly retryable = false;

  constructor(readonly quota: ProviderQuotaKind) {
    super(`Provider response exceeded the ${quota} quota`);
    this.name = 'ProviderQuotaExceededError';
  }
}

export class ProviderStreamBudget {
  private rawBytes = 0;
  private outputBytes = 0;
  private eventCount = 0;
  private toolCallCount = 0;
  private toolResultBytes = 0;
  private readonly toolBytes = new Map<string, number>();

  constructor(
    private callStartedAt = Date.now(),
    private readonly turnStartedAt = callStartedAt,
  ) {}

  beginCall(now = Date.now()): this {
    this.callStartedAt = now;
    this.rawBytes = 0;
    this.outputBytes = 0;
    this.eventCount = 0;
    this.toolCallCount = 0;
    this.toolResultBytes = 0;
    this.toolBytes.clear();
    this.assertTime(now);
    return this;
  }

  assertTime(now = Date.now()): void {
    if (now - this.callStartedAt > PROVIDER_STREAM_LIMITS.callDurationMs)
      throw new ProviderQuotaExceededError('call_duration');
    if (now - this.turnStartedAt > PROVIDER_STREAM_LIMITS.turnDurationMs)
      throw new ProviderQuotaExceededError('turn_duration');
  }

  consumeRaw(bytes: number): void {
    this.assertTime();
    this.rawBytes = checkedTotal(
      this.rawBytes,
      bytes,
      PROVIDER_STREAM_LIMITS.rawStreamBytes,
      'raw_stream_bytes',
    );
  }

  consumeEvent(bytes: number): void {
    if (bytes > PROVIDER_STREAM_LIMITS.eventBytes)
      throw new ProviderQuotaExceededError('event_bytes');
    this.eventCount = checkedTotal(this.eventCount, 1, PROVIDER_STREAM_LIMITS.events, 'events');
  }

  consumeOutput(text: string): void {
    this.outputBytes = checkedTotal(
      this.outputBytes,
      Buffer.byteLength(text, 'utf8'),
      PROVIDER_STREAM_LIMITS.normalizedOutputBytes,
      'normalized_output_bytes',
    );
  }

  consumeToolArguments(key: string, text: string): void {
    const current = this.toolBytes.get(key) ?? 0;
    this.toolBytes.set(
      key,
      checkedTotal(
        current,
        Buffer.byteLength(text, 'utf8'),
        PROVIDER_STREAM_LIMITS.toolArgumentBytes,
        'tool_argument_bytes',
      ),
    );
  }

  consumeToolCall(): void {
    this.toolCallCount = checkedTotal(
      this.toolCallCount,
      1,
      PROVIDER_STREAM_LIMITS.toolCalls,
      'tool_calls',
    );
  }

  consumeToolResult(text: string): void {
    this.toolResultBytes = checkedTotal(
      this.toolResultBytes,
      Buffer.byteLength(text, 'utf8'),
      PROVIDER_STREAM_LIMITS.normalizedOutputBytes,
      'normalized_output_bytes',
    );
  }
}

export async function* readBoundedServerSentJson(
  body: ReadableStream<Uint8Array>,
  budget: ProviderStreamBudget,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let completed = false;
  try {
    while (true) {
      budget.assertTime();
      const { done, value } = await reader.read();
      if (value !== undefined) budget.consumeRaw(value.byteLength);
      pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary = pending.indexOf('\n\n');
      if (boundary < 0 && Buffer.byteLength(pending, 'utf8') > PROVIDER_STREAM_LIMITS.eventBytes)
        throw new ProviderQuotaExceededError('event_bytes');
      while (boundary >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        budget.consumeEvent(Buffer.byteLength(block, 'utf8'));
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data !== '' && data !== '[DONE]') {
          try {
            yield JSON.parse(data) as unknown;
          } catch {
            // Malformed provider frames do not supersede a later terminal event.
          }
        }
        if (Buffer.byteLength(pending, 'utf8') > PROVIDER_STREAM_LIMITS.eventBytes)
          throw new ProviderQuotaExceededError('event_bytes');
        boundary = pending.indexOf('\n\n');
      }
      if (done) {
        completed = true;
        break;
      }
    }
  } finally {
    if (!completed)
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // Preserve the quota/deadline error.
      }
    reader.releaseLock();
  }
}

function checkedTotal(
  current: number,
  added: number,
  limit: number,
  quota: ProviderQuotaKind,
): number {
  if (!Number.isSafeInteger(added) || added < 0 || current > limit - added)
    throw new ProviderQuotaExceededError(quota);
  return current + added;
}
