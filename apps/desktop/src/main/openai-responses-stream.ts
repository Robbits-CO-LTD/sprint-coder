import type { CanonicalProviderEvent } from '@sprint-coder/contracts';
import { ProviderStreamBudget, readBoundedServerSentJson } from './provider-stream-budget';

export async function* normalizeOpenAIResponsesStream(
  body: ReadableStream<Uint8Array>,
  providerId: string,
  requestedModel: string,
  options: Readonly<{ costTicksPerUsd?: number }> = {},
  budget = new ProviderStreamBudget(),
): AsyncIterable<CanonicalProviderEvent> {
  const toolArguments = new Map<string, string>();
  for await (const value of readBoundedServerSentJson(body, budget)) {
    const event = asRecord(value);
    if (event === null || typeof event.type !== 'string') continue;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      budget.consumeOutput(event.delta);
      yield { type: 'output_delta', text: event.delta };
      continue;
    }
    if (event.type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      budget.consumeOutput(event.delta);
      yield { type: 'reasoning_delta', text: event.delta };
      continue;
    }
    if (
      event.type === 'response.function_call_arguments.delta' &&
      typeof event.delta === 'string'
    ) {
      const key = toolEventKey(event);
      if (key !== null) {
        budget.consumeToolArguments(key, event.delta);
        toolArguments.set(key, (toolArguments.get(key) ?? '') + event.delta);
      }
      continue;
    }
    if (event.type === 'response.output_item.done') {
      const item = asRecord(event.item);
      if (
        item?.type === 'function_call' &&
        typeof item.call_id === 'string' &&
        typeof item.name === 'string'
      ) {
        const key = toolEventKey(item) ?? toolEventKey(event) ?? item.call_id;
        const accumulated = toolArguments.get(key);
        budget.consumeToolCall();
        if (accumulated === undefined && typeof item.arguments === 'string')
          budget.consumeToolArguments(item.call_id, item.arguments);
        yield {
          type: 'tool_call',
          callId: item.call_id,
          name: item.name,
          input: parseToolArguments(accumulated ?? item.arguments),
        };
        toolArguments.delete(key);
      }
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

function toolEventKey(value: Record<string, unknown>): string | null {
  for (const candidate of [value.item_id, value.id, value.call_id, value.output_index])
    if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate);
  return null;
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
