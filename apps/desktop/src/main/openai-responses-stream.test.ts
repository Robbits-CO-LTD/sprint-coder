import { describe, expect, it } from 'vitest';
import { normalizeOpenAIResponsesStream } from './openai-responses-stream';

describe('normalizeOpenAIResponsesStream', () => {
  it('normalizes text, reasoning, function calls, resolved model, and usage', async () => {
    const stream = sse([
      {
        type: 'response.output_text.delta',
        delta: 'hello',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        delta: 'summary',
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"query":"weather"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          model: 'gpt-5.2-2026-07-01',
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
    ]);

    const events = [];
    for await (const event of normalizeOpenAIResponsesStream(stream, 'openai', 'gpt-5.2'))
      events.push(event);

    expect(events).toEqual([
      { type: 'output_delta', text: 'hello' },
      { type: 'reasoning_delta', text: 'summary' },
      {
        type: 'tool_call',
        callId: 'call_1',
        name: 'lookup',
        input: { query: 'weather' },
      },
      {
        type: 'resolution',
        resolution: { resolvedProvider: 'openai', resolvedModel: 'gpt-5.2-2026-07-01' },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: null,
          reasoningTokens: 2,
          providerCost: null,
          source: 'provider_api',
        },
      },
      { type: 'completed', stopReason: 'completed' },
    ]);
  });

  it('handles events split across transport chunks and ignores malformed data', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {bad json}\n\ndata: {"type":"response.output_'));
        controller.enqueue(encoder.encode('text.delta","delta":"ok"}\n\n'));
        controller.close();
      },
    });
    const events = [];
    for await (const event of normalizeOpenAIResponsesStream(body, 'openai', 'gpt'))
      events.push(event);
    expect(events).toEqual([{ type: 'output_delta', text: 'ok' }]);
  });

  it('assembles function arguments split across response events', async () => {
    const body = sse([
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"query":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"weather"}' },
      {
        type: 'response.output_item.done',
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup' },
      },
    ]);
    const events = [];
    for await (const event of normalizeOpenAIResponsesStream(body, 'openai', 'gpt'))
      events.push(event);
    expect(events).toEqual([
      { type: 'tool_call', callId: 'call_1', name: 'lookup', input: { query: 'weather' } },
    ]);
  });
});

function sse(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
      );
      controller.close();
    },
  });
}
