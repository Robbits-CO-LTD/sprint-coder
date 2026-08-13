import type { CanonicalProviderEvent, NormalizedProviderUsage } from '@sprint-coder/contracts';
import { ProviderStreamBudget, readBoundedServerSentJson } from './provider-stream-budget';

type ToolBlock = {
  callId: string;
  name: string;
  partialJson: string;
};

export async function* normalizeAnthropicMessagesStream(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
  budget = new ProviderStreamBudget(),
): AsyncIterable<CanonicalProviderEvent> {
  let resolvedModel = requestedModel;
  let stopReason: string | null = null;
  let usage = emptyUsage();
  const tools = new Map<number, ToolBlock>();

  for await (const value of readBoundedServerSentJson(body, budget)) {
    const event = record(value);
    if (event === null || typeof event.type !== 'string') continue;

    if (event.type === 'message_start') {
      const message = record(event.message);
      if (typeof message?.model === 'string') resolvedModel = message.model;
      usage = mergeUsage(usage, record(message?.usage));
      continue;
    }

    if (event.type === 'content_block_start') {
      const index = integer(event.index);
      const block = record(event.content_block);
      if (
        index !== null &&
        block?.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        const partialJson = objectHasValues(block.input) ? JSON.stringify(block.input) : '';
        if (partialJson !== '') budget.consumeToolArguments(String(index), partialJson);
        tools.set(index, {
          callId: block.id.slice(0, 256),
          name: block.name.slice(0, 256),
          partialJson,
        });
      }
      continue;
    }

    if (event.type === 'content_block_delta') {
      const delta = record(event.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        budget.consumeOutput(delta.text);
        yield { type: 'output_delta', text: delta.text };
        continue;
      }
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        budget.consumeOutput(delta.thinking);
        yield { type: 'reasoning_delta', text: delta.thinking };
        continue;
      }
      const index = integer(event.index);
      if (
        index !== null &&
        delta?.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        const tool = tools.get(index);
        if (tool !== undefined) {
          budget.consumeToolArguments(String(index), delta.partial_json);
          tool.partialJson += delta.partial_json;
        }
      }
      continue;
    }

    if (event.type === 'content_block_stop') {
      const index = integer(event.index);
      if (index === null) continue;
      const tool = tools.get(index);
      if (tool === undefined) continue;
      tools.delete(index);
      budget.consumeToolCall();
      yield {
        type: 'tool_call',
        callId: tool.callId,
        name: tool.name,
        input: parseToolInput(tool.partialJson),
      };
      continue;
    }

    if (event.type === 'message_delta') {
      const delta = record(event.delta);
      if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
      usage = mergeUsage(usage, record(event.usage));
      continue;
    }

    if (event.type === 'error') {
      const error = record(event.error);
      const type = typeof error?.type === 'string' ? error.type : null;
      yield {
        type: 'error',
        error: {
          category: type === 'rate_limit_error' ? 'rate_limited' : 'provider_unavailable',
          message:
            type === 'overloaded_error' ? 'Anthropic API is overloaded' : 'Anthropic stream failed',
          retryable: type === 'rate_limit_error' || type === 'overloaded_error',
          retryAfterMs: null,
          providerCode: type?.slice(0, 128) ?? null,
        },
      };
      continue;
    }

    if (event.type === 'message_stop') {
      yield {
        type: 'resolution',
        resolution: {
          resolvedProvider: 'anthropic',
          resolvedModel,
        },
      };
      yield { type: 'usage', usage };
      yield { type: 'completed', stopReason };
    }
  }
}

function emptyUsage(): NormalizedProviderUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    providerCost: null,
    source: 'provider_api',
  };
}

function mergeUsage(
  current: NormalizedProviderUsage,
  value: Record<string, unknown> | null,
): NormalizedProviderUsage {
  if (value === null) return current;
  const outputDetails = record(value.output_tokens_details);
  return {
    ...current,
    inputTokens: integer(value.input_tokens) ?? current.inputTokens,
    outputTokens: integer(value.output_tokens) ?? current.outputTokens,
    cacheReadTokens: integer(value.cache_read_input_tokens) ?? current.cacheReadTokens,
    cacheWriteTokens: integer(value.cache_creation_input_tokens) ?? current.cacheWriteTokens,
    reasoningTokens: integer(outputDetails?.thinking_tokens) ?? current.reasoningTokens,
  };
}

function parseToolInput(
  value: string,
): Extract<CanonicalProviderEvent, { type: 'tool_call' }>['input'] {
  if (value === '') return {};
  try {
    return JSON.parse(value) as Extract<CanonicalProviderEvent, { type: 'tool_call' }>['input'];
  } catch {
    return value;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function objectHasValues(value: unknown): boolean {
  const candidate = record(value);
  return candidate !== null && Object.keys(candidate).length > 0;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
