import { describe, expect, it } from 'vitest';
import { normalizeGeminiContentStream } from './gemini-content-stream';

describe('normalizeGeminiContentStream', () => {
  it('generates round-unique local IDs without claiming Gemini supplied them', async () => {
    const eventBody = () =>
      sse([
        { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: {} } }] } }] },
      ]);
    const collect = async (executionId: string) => {
      const events = [];
      for await (const event of normalizeGeminiContentStream(
        eventBody(),
        'gemini-3.6-pro',
        executionId,
      ))
        events.push(event);
      return events.find((event) => event.type === 'tool_call');
    };
    const first = await collect('turn-1-round-1');
    const second = await collect('turn-1-round-2');
    expect(first?.type === 'tool_call' ? first.callId : null).not.toBe(
      second?.type === 'tool_call' ? second.callId : null,
    );
    expect(first).toMatchObject({ providerMetadata: { geminiCallIdPresent: false } });
  });

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
                  thoughtSignature: 'signed-thought-1',
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
        providerMetadata: {
          geminiThoughtSignature: 'signed-thought-1',
          geminiCallIdPresent: true,
        },
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
