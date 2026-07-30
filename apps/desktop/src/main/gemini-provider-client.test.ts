import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { GeminiProviderClient } from './gemini-provider-client';

const connection: ProviderConnection = {
  id: 'google:primary',
  providerId: 'google',
  runtimeKind: 'official_api',
  displayName: 'Google Gemini API',
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

describe('GeminiProviderClient', () => {
  it('uses x-goog-api-key and maps the official model list without inferred capabilities', async () => {
    const providerFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('gemini-key');
      return Response.json({
        models: [
          {
            name: 'models/gemini-3.6-pro',
            baseModelId: 'gemini-3.6-pro',
            displayName: 'Gemini 3.6 Pro',
            inputTokenLimit: 1_000_000,
            outputTokenLimit: 65_536,
            supportedGenerationMethods: ['generateContent'],
            thinking: true,
          },
        ],
      });
    });
    const client = new GeminiProviderClient(
      () => ({ apiKey: 'gemini-key' }),
      providerFetch,
      () => new Date('2026-07-28T06:00:00.000Z'),
    );

    const models = await client.listModels(connection, new AbortController().signal);
    expect(models).toEqual([
      expect.objectContaining({
        providerId: 'google',
        modelId: 'gemini-3.6-pro',
        available: true,
        contextWindow: expect.objectContaining({
          value: 1_000_000,
          source: 'provider_api',
        }),
        maxOutputTokens: expect.objectContaining({
          value: 65_536,
          source: 'provider_api',
        }),
        toolCalling: { value: null, source: 'unknown' },
        structuredOutput: { value: null, source: 'unknown' },
        multimodalInput: { value: null, source: 'unknown' },
        reasoning: expect.objectContaining({
          value: true,
          source: 'provider_api',
        }),
      }),
    ]);
  });

  it('uses Gemini request shapes and emits retryable 429 events', async () => {
    const client = new GeminiProviderClient(
      () => ({ apiKey: 'gemini-key' }),
      async (input, init) => {
        expect(String(input)).toContain('/models/gemini-3.6-pro:streamGenerateContent?alt=sse');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          systemInstruction: { parts: [{ text: 'be concise' }] },
          contents: [
            {
              role: 'user',
              parts: [
                { text: 'hello' },
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: 'aGVsbG8=',
                  },
                },
              ],
            },
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-1',
                    name: 'lookup',
                    args: { q: 'value' },
                  },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'call-1',
                    name: 'lookup',
                    response: { output: '{"ok":true}' },
                  },
                },
              ],
            },
          ],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'lookup',
                  parameters: { type: 'object' },
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: { type: 'object' },
          },
        });
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': '1.5' },
        });
      },
      () => new Date('2026-07-28T06:00:00.000Z'),
    );
    const events = [];
    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-1',
        connectionId: connection.id,
        modelId: 'gemini-3.6-pro',
        messages: [
          { role: 'system', content: 'be concise' },
          {
            role: 'user',
            content: 'hello',
            inlineImages: [{ mimeType: 'image/png', base64: 'aGVsbG8=' }],
          },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ callId: 'call-1', name: 'lookup', input: { q: 'value' } }],
          },
          {
            role: 'tool',
            content: '{"ok":true}',
            toolCallId: 'call-1',
            toolName: 'lookup',
          },
        ],
        tools: [
          {
            name: 'lookup',
            description: 'Lookup data',
            inputSchema: { type: 'object' },
          },
        ],
        structuredOutput: {
          name: 'result',
          schema: { type: 'object' },
          strict: true,
        },
      },
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toEqual([
      {
        type: 'rate_limit',
        retryAfterMs: 1_500,
        observedAt: '2026-07-28T06:00:00.000Z',
      },
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({
          category: 'rate_limited',
          retryable: true,
          retryAfterMs: 1_500,
        }),
      }),
    ]);
  });
});
