import type { CanonicalProviderEvent } from '@sprint-coder/contracts';

export async function* normalizeOpenRouterResponsesStream(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
): AsyncIterable<CanonicalProviderEvent> {
  for await (const value of readServerSentJson(body)) {
    const event = record(value);
    if (event === null || typeof event.type !== 'string') continue;
    if (
      (event.type === 'response.content_part.delta' ||
        event.type === 'response.output_text.delta') &&
      typeof event.delta === 'string'
    ) {
      yield { type: 'output_delta', text: event.delta };
      continue;
    }
    if (event.type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      yield { type: 'reasoning_delta', text: event.delta };
      continue;
    }
    if (event.type === 'response.output_item.done') {
      const item = record(event.item);
      if (
        item?.type === 'function_call' &&
        typeof item.call_id === 'string' &&
        typeof item.name === 'string'
      )
        yield {
          type: 'tool_call',
          callId: item.call_id,
          name: item.name,
          input: parseJsonOrString(item.arguments),
        };
      continue;
    }
    if (event.type === 'response.done' || event.type === 'response.completed') {
      const response = record(event.response);
      const usage = record(response?.usage);
      const inputDetails = record(usage?.input_tokens_details);
      const outputDetails = record(usage?.output_tokens_details);
      const metadata = record(response?.openrouter_metadata ?? event.openrouter_metadata);
      const upstream = selectedUpstream(metadata);
      yield {
        type: 'resolution',
        resolution: {
          resolvedProvider: 'openrouter',
          resolvedModel: typeof response?.model === 'string' ? response.model : requestedModel,
          gatewayProvider: 'openrouter',
          upstreamProvider: upstream,
          routing: routingSummary(metadata),
        },
      };
      yield {
        type: 'usage',
        usage: {
          inputTokens: integer(usage?.input_tokens),
          outputTokens: integer(usage?.output_tokens),
          cacheReadTokens: integer(inputDetails?.cached_tokens),
          cacheWriteTokens: null,
          reasoningTokens: integer(outputDetails?.reasoning_tokens),
          providerCost:
            typeof usage?.cost === 'number' && usage.cost >= 0
              ? { amount: usage.cost, currency: 'USD' }
              : null,
          source: 'provider_api',
        },
      };
      yield {
        type: 'completed',
        stopReason: typeof response?.status === 'string' ? response.status : 'completed',
      };
      continue;
    }
    if (event.type === 'error' || event.type === 'response.failed')
      yield {
        type: 'error',
        error: {
          category: 'provider_unavailable',
          message: 'OpenRouter response generation failed',
          retryable: true,
          retryAfterMs: null,
          providerCode: stringValue(event.code),
        },
      };
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
        if (data !== '' && data !== '[DONE]') {
          try {
            yield JSON.parse(data) as unknown;
          } catch {
            // Keepalive comments and malformed gateway frames do not replace a terminal event.
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

function selectedUpstream(metadata: Record<string, unknown> | null): string | null {
  const endpoints = record(metadata?.endpoints);
  const available = Array.isArray(endpoints?.available) ? endpoints.available : [];
  for (const candidate of available) {
    const endpoint = record(candidate);
    if (endpoint?.selected === true && typeof endpoint.provider === 'string')
      return endpoint.provider.slice(0, 128);
  }
  return null;
}

function routingSummary(
  metadata: Record<string, unknown> | null,
): Record<string, string | number | boolean | null> | null {
  if (metadata === null) return null;
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of ['requested', 'strategy', 'region', 'attempt', 'is_byok'] as const) {
    const value = metadata[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    )
      result[key] = value;
  }
  return Object.keys(result).length === 0 ? null : result;
}

function parseJsonOrString(
  value: unknown,
): Extract<CanonicalProviderEvent, { type: 'tool_call' }>['input'] {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as Extract<CanonicalProviderEvent, { type: 'tool_call' }>['input'];
  } catch {
    return value;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : null;
}
