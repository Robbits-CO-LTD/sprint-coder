import type { CanonicalProviderEvent } from '@sprint-coder/contracts';

export async function* normalizeOpenAIResponsesStream(
  body: ReadableStream<Uint8Array>,
  providerId: string,
  requestedModel: string,
  options: Readonly<{ costTicksPerUsd?: number }> = {},
): AsyncIterable<CanonicalProviderEvent> {
  for await (const value of readServerSentJson(body)) {
    const event = asRecord(value);
    if (event === null || typeof event.type !== 'string') continue;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      yield { type: 'output_delta', text: event.delta };
      continue;
    }
    if (event.type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      yield { type: 'reasoning_delta', text: event.delta };
      continue;
    }
    if (event.type === 'response.output_item.done') {
      const item = asRecord(event.item);
      if (
        item?.type === 'function_call' &&
        typeof item.call_id === 'string' &&
        typeof item.name === 'string'
      )
        yield {
          type: 'tool_call',
          callId: item.call_id,
          name: item.name,
          input: parseToolArguments(item.arguments),
        };
      continue;
    }
    if (event.type === 'response.completed') {
      const response = asRecord(event.response);
      const usage = asRecord(response?.usage);
      const inputDetails = asRecord(usage?.input_tokens_details);
      const outputDetails = asRecord(usage?.output_tokens_details);
      yield {
        type: 'resolution',
        resolution: {
          resolvedProvider: providerId,
          resolvedModel: typeof response?.model === 'string' ? response.model : requestedModel,
        },
      };
      yield {
        type: 'usage',
        usage: {
          inputTokens: integerOrNull(usage?.input_tokens),
          outputTokens: integerOrNull(usage?.output_tokens),
          cacheReadTokens: integerOrNull(inputDetails?.cached_tokens),
          cacheWriteTokens: null,
          reasoningTokens: integerOrNull(outputDetails?.reasoning_tokens),
          providerCost: providerCost(usage?.cost_in_usd_ticks, options.costTicksPerUsd),
          source: 'provider_api',
        },
      };
      yield {
        type: 'completed',
        stopReason: typeof response?.status === 'string' ? response.status : 'completed',
      };
      continue;
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      yield {
        type: 'error',
        error: {
          category: 'provider_unavailable',
          message: 'OpenAI response generation failed',
          retryable: true,
          retryAfterMs: null,
          providerCode: stringOrNull(event.code),
        },
      };
    }
  }
}

async function* readServerSentJson(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary = pending.indexOf('\n\n');
      while (boundary >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data.length > 0 && data !== '[DONE]') {
          try {
            yield JSON.parse(data) as unknown;
          } catch {
            // A malformed provider event is ignored; a later terminal event still decides outcome.
          }
        }
        boundary = pending.indexOf('\n\n');
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseToolArguments(
  value: unknown,
): Extract<CanonicalProviderEvent, { type: 'tool_call' }>['input'] {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as Extract<CanonicalProviderEvent, { type: 'tool_call' }>['input'];
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : null;
}

function providerCost(
  ticks: unknown,
  ticksPerUsd: number | undefined,
): { amount: number; currency: 'USD' } | null {
  if (
    ticksPerUsd === undefined ||
    !Number.isFinite(ticksPerUsd) ||
    ticksPerUsd <= 0 ||
    typeof ticks !== 'number' ||
    !Number.isFinite(ticks) ||
    ticks < 0
  )
    return null;
  return { amount: ticks / ticksPerUsd, currency: 'USD' };
}
