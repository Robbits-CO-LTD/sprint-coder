import { describe, expect, it } from 'vitest';
import { normalizeGeminiContentStream } from './gemini-content-stream';

describe('normalizeGeminiContentStream', () => {
  it('normalizes text, thought, function calls, model resolution, and usage', async () => {
    const body = sse([
      {
        modelVersion: 'models/gemini-3.6-pro',
        candidates: [
          {
            content: {
              parts: [
                { text: 'plan', thought: true },
                { text: 'hello' },
                {
                  functionCall: {
                    id: 'call-1',
                    name: 'lookup',
                    args: { query: 'docs' },
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 4,
          cachedContentTokenCount: 2,
          thoughtsTokenCount: 1,
        },
      },
    ]);
    const events = [];
    for await (const event of normalizeGeminiContentStream(body, 'gemini-requested'))
      events.push(event);

    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'plan' },
      { type: 'output_delta', text: 'hello' },
      {
        type: 'tool_call',
        callId: 'call-1',
        name: 'lookup',
        input: { query: 'docs' },
      },
      {
        type: 'resolution',
        resolution: {
          resolvedProvider: 'google',
          resolvedModel: 'gemini-3.6-pro',
        },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 8,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: null,
          reasoningTokens: 1,
          providerCost: null,
          source: 'provider_api',
        },
      },
      { type: 'completed', stopReason: 'STOP' },
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
