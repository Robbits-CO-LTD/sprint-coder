import { describe, expect, it } from 'vitest';
import { normalizeAnthropicMessagesStream } from './anthropic-messages-stream';

describe('normalizeAnthropicMessagesStream', () => {
  it('normalizes text, thinking, tool input, usage, resolution, and completion', async () => {
    const body = sse([
      {
        type: 'message_start',
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'plan' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'hello' },
      },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"query":"docs"}' },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } },
      },
      { type: 'message_stop' },
    ]);
    const events = [];
    for await (const event of normalizeAnthropicMessagesStream(body, 'claude-requested'))
      events.push(event);

    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'plan' },
      { type: 'output_delta', text: 'hello' },
      {
        type: 'tool_call',
        callId: 'tool-1',
        name: 'lookup',
        input: { query: 'docs' },
      },
      {
        type: 'resolution',
        resolution: {
          resolvedProvider: 'anthropic',
          resolvedModel: 'claude-opus-4-8',
        },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          reasoningTokens: 2,
          providerCost: null,
          source: 'provider_api',
        },
      },
      { type: 'completed', stopReason: 'tool_use' },
    ]);
  });
});

function sse(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          events
            .map(
              (event) =>
                `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(''),
        ),
      );
      controller.close();
    },
  });
}
