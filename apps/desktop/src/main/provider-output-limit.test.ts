import { expect, it } from 'vitest';
import { normalizeAnthropicMessagesStream } from './anthropic-messages-stream';
import { normalizeOpenAIChatCompletionsStream } from './openai-chat-completions-stream';
import { normalizeGeminiContentStream } from './gemini-content-stream';
import { AnthropicProviderClient } from './anthropic-provider-client';
import type { ProviderConnection } from '@sprint-coder/contracts';

function body(events: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        ),
      );
      controller.close();
    },
  });
}

it.each(['anthropic', 'openai', 'gemini'] as const)(
  'does not silently complete a truncated %s response',
  async (provider) => {
    const stream =
      provider === 'anthropic'
        ? normalizeAnthropicMessagesStream(
            body([
              { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
              { type: 'message_stop' },
            ]),
            'model',
          )
        : provider === 'openai'
          ? normalizeOpenAIChatCompletionsStream(
              body([{ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }]),
              'openai',
              'model',
            )
          : normalizeGeminiContentStream(
              body([
                {
                  candidates: [
                    { content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' },
                  ],
                },
              ]),
              'model',
            );
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ providerCode: 'output_token_limit', retryable: false }),
      }),
    );
    expect(events.some((event) => event.type === 'completed')).toBe(false);
  },
);

it('uses the selected Anthropic model output limit from the catalog', async () => {
  const connection: ProviderConnection = {
    id: 'anthropic:test',
    providerId: 'anthropic',
    runtimeKind: 'official_api',
    displayName: 'test',
    enabled: true,
    secretReference: 'test',
    verification: { status: 'verified', verifiedAt: null, expiresAt: null, message: null },
    rateLimit: {
      mode: 'auto',
      maxConcurrentRequests: 2,
      requestsPerMinute: null,
      tokensPerMinute: null,
      lastObservedRateLimitHeaders: null,
    },
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
  let requestBody: unknown;
  const client = new AnthropicProviderClient(
    () => ({ apiKey: 'fixture-key' }),
    async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 429 });
    },
    undefined,
    () => 16384,
  );
  for await (const _event of client.execute(
    connection,
    {
      executionId: 'test-limit',
      connectionId: connection.id,
      modelId: 'model',
      messages: [{ role: 'user', content: 'test' }],
    },
    new AbortController().signal,
  )) {
    /* drain */
  }
  expect(requestBody).toMatchObject({ max_tokens: 16384 });
});
