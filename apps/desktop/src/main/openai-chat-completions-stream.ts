import { providerCompletionEvent } from './provider-output-limit';
import type { CanonicalProviderEvent, ProviderMessageToolCall } from '@sprint-coder/contracts';
import { ProviderStreamBudget, readBoundedServerSentJson } from './provider-stream-budget';

type ToolAccumulator = {
  callId: string | null;
  name: string | null;
  arguments: string;
};

export async function* normalizeOpenAIChatCompletionsStream(
  body: ReadableStream<Uint8Array>,
  providerId: string,
  requestedModel: string,
  budget = new ProviderStreamBudget(),
): AsyncIterable<CanonicalProviderEvent> {
  let resolvedModel = requestedModel;
  let stopReason = 'completed';
  let usage: Record<string, unknown> | null = null;
  let terminalFrameSeen = false;
  const tools = new Map<number, ToolAccumulator>();

  for await (const value of readBoundedServerSentJson(body, budget, () => {
    terminalFrameSeen = true;
  })) {
    const event = asRecord(value);
    if (event === null) continue;
    const streamError = asRecord(event.error);
    if (streamError !== null) {
      yield {
        type: 'error',
        error: {
          category: 'provider_unavailable',
          message: 'Chat Completions stream failed',
          retryable: true,
          retryAfterMs: null,
          providerCode: boundedProviderCode(streamError.code ?? streamError.type),
        },
      };
      return;
    }
    if (typeof event.model === 'string') resolvedModel = event.model;
    const eventUsage = asRecord(event.usage);
    if (eventUsage !== null) usage = eventUsage;
    const choices = Array.isArray(event.choices) ? event.choices : [];
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      if (choice === null) continue;
      if (typeof choice.finish_reason === 'string') {
        stopReason = choice.finish_reason;
        terminalFrameSeen = true;
      }
      const delta = asRecord(choice.delta);
      if (delta === null) continue;
      for (const reasoning of reasoningTextsFromDelta(delta)) {
        budget.consumeOutput(reasoning);
        yield { type: 'reasoning_delta', text: reasoning };
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        budget.consumeOutput(delta.content);
        yield { type: 'output_delta', text: delta.content };
      }
      if (!Array.isArray(delta.tool_calls)) continue;
      for (const rawTool of delta.tool_calls) {
        const tool = asRecord(rawTool);
        if (tool === null || !Number.isInteger(tool.index)) continue;
        const index = tool.index as number;
        const current = tools.get(index) ?? { callId: null, name: null, arguments: '' };
        const fn = asRecord(tool.function);
        if (typeof tool.id === 'string') current.callId = tool.id;
        if (typeof fn?.name === 'string') current.name = fn.name;
        if (typeof fn?.arguments === 'string') {
          budget.consumeToolArguments(String(index), fn.arguments);
          current.arguments += fn.arguments;
        }
        tools.set(index, current);
      }
    }
  }

  if (!terminalFrameSeen) {
    yield {
      type: 'error',
      error: {
        category: 'provider_unavailable',
        message: 'Chat Completions stream ended before completion',
        retryable: true,
        retryAfterMs: null,
        providerCode: null,
      },
    };
    return;
  }

  for (const tool of [...tools.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
    if (tool.callId === null || tool.name === null) continue;
    budget.consumeToolCall();
    yield {
      type: 'tool_call',
      callId: tool.callId,
      name: tool.name,
      input: parseArguments(tool.arguments),
    };
  }
  yield {
    type: 'resolution',
    resolution: { resolvedProvider: providerId, resolvedModel },
  };
  yield {
    type: 'usage',
    usage: {
      inputTokens: integerOrNull(usage?.prompt_tokens ?? usage?.input_tokens),
      outputTokens: integerOrNull(usage?.completion_tokens ?? usage?.output_tokens),
      cacheReadTokens: integerOrNull(asRecord(usage?.prompt_tokens_details)?.cached_tokens),
      cacheWriteTokens: null,
      reasoningTokens: integerOrNull(asRecord(usage?.completion_tokens_details)?.reasoning_tokens),
      providerCost: null,
      source: usage === null ? 'unknown' : 'provider_api',
    },
  };
  yield providerCompletionEvent(stopReason);
}

function reasoningTextsFromDelta(delta: Record<string, unknown>): string[] {
  const texts = [
    ...(typeof delta.reasoning === 'string' && delta.reasoning.length > 0 ? [delta.reasoning] : []),
    ...(typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
      ? [delta.reasoning_content]
      : []),
    ...reasoningTexts(delta.reasoning_details),
  ];
  return [...new Set(texts)];
}

function reasoningTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return typeof record?.text === 'string' && record.text.length > 0 ? [record.text] : [];
  });
}

function parseArguments(value: string): ProviderMessageToolCall['input'] {
  if (value.length === 0) return null;
  try {
    return JSON.parse(value) as ProviderMessageToolCall['input'];
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

function boundedProviderCode(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : null;
}
