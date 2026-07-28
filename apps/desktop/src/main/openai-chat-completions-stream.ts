import type { CanonicalProviderEvent } from '@sprint-coder/contracts';

type ToolAccumulator = {
  callId: string | null;
  name: string | null;
  arguments: string;
};

export async function* normalizeOpenAIChatCompletionsStream(
  body: ReadableStream<Uint8Array>,
  providerId: string,
  requestedModel: string,
): AsyncIterable<CanonicalProviderEvent> {
  let resolvedModel = requestedModel;
  let stopReason = 'completed';
  let usage: Record<string, unknown> | null = null;
  const tools = new Map<number, ToolAccumulator>();

  for await (const value of readServerSentJson(body)) {
    const event = asRecord(value);
    if (event === null) continue;
    if (typeof event.model === 'string') resolvedModel = event.model;
    const eventUsage = asRecord(event.usage);
    if (eventUsage !== null) usage = eventUsage;
    const choices = Array.isArray(event.choices) ? event.choices : [];
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      if (choice === null) continue;
      if (typeof choice.finish_reason === 'string') stopReason = choice.finish_reason;
      const delta = asRecord(choice.delta);
      if (delta === null) continue;
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0)
        yield { type: 'reasoning_delta', text: delta.reasoning_content };
      for (const reasoning of reasoningTexts(delta.reasoning_details))
        yield { type: 'reasoning_delta', text: reasoning };
      if (typeof delta.content === 'string' && delta.content.length > 0)
        yield { type: 'output_delta', text: delta.content };
      if (!Array.isArray(delta.tool_calls)) continue;
      for (const rawTool of delta.tool_calls) {
        const tool = asRecord(rawTool);
        if (tool === null || !Number.isInteger(tool.index)) continue;
        const index = tool.index as number;
        const current = tools.get(index) ?? { callId: null, name: null, arguments: '' };
        const fn = asRecord(tool.function);
        if (typeof tool.id === 'string') current.callId = tool.id;
        if (typeof fn?.name === 'string') current.name = fn.name;
        if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
        tools.set(index, current);
      }
    }
  }

  for (const tool of [...tools.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
    if (tool.callId === null || tool.name === null) continue;
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
      reasoningTokens: integerOrNull(
        asRecord(usage?.completion_tokens_details)?.reasoning_tokens,
      ),
      providerCost: null,
      source: usage === null ? 'unknown' : 'provider_api',
    },
  };
  yield { type: 'completed', stopReason };
}

async function* readServerSentJson(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
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
            // Ignore one malformed frame; a later terminal frame still determines the result.
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

function reasoningTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return typeof record?.text === 'string' && record.text.length > 0 ? [record.text] : [];
  });
}

function parseArguments(value: string): unknown {
  if (value.length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
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
