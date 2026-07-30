import { describe, expect, it } from 'vitest';
import { normalizeOpenRouterResponsesStream } from './openrouter-responses-stream';

describe('normalizeOpenRouterResponsesStream', () => {
  it('keeps gateway, upstream, requested model, routing, usage, and cost distinct', async () => {
    const body = sse([
      { type: 'response.content_part.delta', delta: 'hello' },
      {
        type: 'response.done',
        response: {
          status: 'completed',
          model: 'openai/gpt-5.2',
          usage: { input_tokens: 5, output_tokens: 3, cost: 0.004 },
          openrouter_metadata: {
            requested: 'openai/gpt-5.2',
            strategy: 'direct',
            region: 'iad',
            attempt: 2,
            is_byok: false,
            endpoints: {
              available: [
                { provider: 'Azure', model: 'openai/gpt-5.2', selected: false },
                { provider: 'OpenAI', model: 'openai/gpt-5.2', selected: true },
              ],
            },
          },
        },
      },
    ]);
    const events = [];
    for await (const event of normalizeOpenRouterResponsesStream(body, 'openai/gpt-5.2'))
      events.push(event);

    expect(events[0]).toEqual({ type: 'output_delta', text: 'hello' });
    expect(events[1]).toEqual({
      type: 'resolution',
      resolution: {
        resolvedProvider: 'openrouter',
        resolvedModel: 'openai/gpt-5.2',
        gatewayProvider: 'openrouter',
        upstreamProvider: 'OpenAI',
        routing: {
          requested: 'openai/gpt-5.2',
          strategy: 'direct',
          region: 'iad',
          attempt: 2,
          is_byok: false,
        },
      },
    });
    expect(events[2]).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 3, providerCost: { amount: 0.004, currency: 'USD' } },
    });
    expect(events[3]).toEqual({ type: 'completed', stopReason: 'completed' });
  });
});

function sse(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `: OPENROUTER PROCESSING\n\n${events
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')}data: [DONE]\n\n`,
        ),
      );
      controller.close();
    },
  });
}
