import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { XAIProviderClient } from './xai-provider-client';

const connection: ProviderConnection = {
  id: 'xai:primary',
  providerId: 'xai',
  runtimeKind: 'official_api',
  displayName: 'xAI API',
  enabled: true,
  secretReference: 'provider-secret:00000000-0000-4000-8000-000000000001',
  verification: {
    status: 'unverified',
    verifiedAt: null,
    expiresAt: null,
    message: null,
  },
  rateLimit: {
    mode: 'auto',
    maxConcurrentRequests: 2,
    requestsPerMinute: null,
    tokensPerMinute: null,
    lastObservedRateLimitHeaders: null,
  },
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

describe('XAIProviderClient', () => {
  it('does not start a request for a pre-aborted execution', async () => {
    const providerFetch = vi.fn();
    const client = new XAIProviderClient(() => ({ apiKey: 'xai-key' }), providerFetch);
    const controller = new AbortController();
    controller.abort();
    const events = [];

    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-pre-aborted',
        connectionId: connection.id,
        modelId: 'grok-4.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
      controller.signal,
    ))
      events.push(event);

    expect(providerFetch).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ category: 'canceled' }),
      }),
    );
  });

  it('merges xAI model identity, modalities, context, and exact price units', async () => {
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer xai-key');
      if (String(input).endsWith('/models'))
        return Response.json({
          object: 'list',
          data: [{ id: 'grok-4.5', context_length: 256_000 }],
        });
      return Response.json({
        models: [
          {
            id: 'grok-4.5',
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            prompt_text_token_price: 12_500,
            completion_text_token_price: 25_000,
          },
        ],
      });
    });
    const client = new XAIProviderClient(
      () => ({ apiKey: 'xai-key' }),
      providerFetch,
      () => new Date('2026-07-28T07:00:00.000Z'),
    );

    const models = await client.listModels(connection, new AbortController().signal);
    expect(models).toEqual([
      expect.objectContaining({
        providerId: 'xai',
        modelId: 'grok-4.5',
        contextWindow: expect.objectContaining({
          value: 256_000,
          source: 'provider_api',
        }),
        multimodalInput: expect.objectContaining({
          value: true,
          source: 'provider_api',
        }),
        reasoning: { value: null, source: 'unknown' },
        pricing: {
          promptPerToken: expect.objectContaining({
            value: '0.00000125',
            source: 'provider_api',
          }),
          completionPerToken: expect.objectContaining({
            value: '0.0000025',
            source: 'provider_api',
          }),
          currency: 'USD',
        },
      }),
    ]);
  });

  it('reuses Responses wire format but preserves xAI resolution and billed cost', async () => {
    const client = new XAIProviderClient(
      () => ({ apiKey: 'xai-key' }),
      async (input, init) => {
        expect(String(input)).toBe('https://api.x.ai/v1/responses');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'grok-4.5',
          stream: true,
          input: [{ role: 'user', content: 'hello' }],
          tools: [{ type: 'web_search' }],
        });
        return new Response(
          [
            'data: {"type":"response.output_text.delta","delta":"hi"}',
            'data: {"type":"response.completed","response":{"status":"completed","model":"grok-4.5","usage":{"input_tokens":5,"output_tokens":2,"cost_in_usd_ticks":37756000}}}',
            '',
          ].join('\n\n'),
        );
      },
    );
    const events = [];
    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-1',
        connectionId: connection.id,
        modelId: 'grok-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        webSearch: true,
      },
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([
      { type: 'output_delta', text: 'hi' },
      {
        type: 'resolution',
        resolution: {
          resolvedProvider: 'xai',
          resolvedModel: 'grok-4.5',
        },
      },
      expect.objectContaining({
        type: 'usage',
        usage: expect.objectContaining({
          inputTokens: 5,
          outputTokens: 2,
          providerCost: { amount: 0.0037756, currency: 'USD' },
        }),
      }),
      { type: 'completed', stopReason: 'completed' },
    ]);
  });

  it('classifies 429 separately from credentials', async () => {
    const client = new XAIProviderClient(
      () => ({ apiKey: 'xai-key' }),
      async () =>
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
      () => new Date('2026-07-28T07:00:00.000Z'),
    );
    const events = [];
    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-2',
        connectionId: connection.id,
        modelId: 'grok-4.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
      new AbortController().signal,
    ))
      events.push(event);
    expect(events).toEqual([
      {
        type: 'rate_limit',
        retryAfterMs: 2_000,
        observedAt: '2026-07-28T07:00:00.000Z',
      },
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({
          category: 'rate_limited',
          retryable: true,
        }),
      }),
    ]);
  });
});
