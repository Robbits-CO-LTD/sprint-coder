import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { AnthropicProviderClient } from './anthropic-provider-client';

const connection: ProviderConnection = {
  id: 'anthropic:primary',
  providerId: 'anthropic',
  runtimeKind: 'official_api',
  displayName: 'Anthropic API',
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

describe('AnthropicProviderClient', () => {
  it('does not start a request for a pre-aborted execution', async () => {
    const providerFetch = vi.fn();
    const client = new AnthropicProviderClient(() => ({ apiKey: 'anthropic-key' }), providerFetch);
    const controller = new AbortController();
    controller.abort();
    const events = [];

    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-pre-aborted',
        connectionId: connection.id,
        modelId: 'claude-opus-4-8',
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

  it('uses Anthropic auth and maps the official model capabilities', async () => {
    const providerFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('anthropic-key');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      return Response.json({
        data: [
          {
            id: 'claude-opus-4-8',
            display_name: 'Claude Opus 4.8',
            max_input_tokens: 200_000,
            max_tokens: 64_000,
            capabilities: {
              image_input: { supported: true },
              structured_outputs: { supported: true },
              thinking: { supported: true },
            },
          },
        ],
        has_more: false,
        last_id: 'claude-opus-4-8',
      });
    });
    const client = new AnthropicProviderClient(
      () => ({ apiKey: 'anthropic-key' }),
      providerFetch,
      () => new Date('2026-07-28T05:00:00.000Z'),
    );

    await expect(client.listModels(connection, new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({
        providerId: 'anthropic',
        modelId: 'claude-opus-4-8',
        contextWindow: {
          value: 200_000,
          source: 'provider_api',
          sourceReference: expect.any(String),
          observedAt: expect.any(String),
        },
        maxOutputTokens: {
          value: 64_000,
          source: 'provider_api',
          sourceReference: expect.any(String),
          observedAt: expect.any(String),
        },
        toolCalling: { value: null, source: 'unknown' },
        structuredOutput: {
          value: true,
          source: 'provider_api',
          sourceReference: expect.any(String),
          observedAt: expect.any(String),
        },
        multimodalInput: {
          value: true,
          source: 'provider_api',
          sourceReference: expect.any(String),
          observedAt: expect.any(String),
        },
        reasoning: {
          value: true,
          source: 'provider_api',
          sourceReference: expect.any(String),
          observedAt: expect.any(String),
        },
      }),
    ]);
  });

  it('sends Messages requests and returns 429 to the shared retry scheduler', async () => {
    const client = new AnthropicProviderClient(
      () => ({ apiKey: 'anthropic-key' }),
      async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'claude-opus-4-8',
          stream: true,
          system: 'be concise',
          messages: [
            { role: 'user', content: 'hello' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'call-1',
                  name: 'lookup',
                  input: { q: 'value' },
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call-1',
                  content: '{"ok":true}',
                },
              ],
            },
          ],
          tools: [
            {
              name: 'lookup',
              input_schema: { type: 'object' },
              strict: true,
            },
          ],
          output_config: {
            format: { type: 'json_schema', schema: { type: 'object' } },
          },
        });
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': '2' },
        });
      },
      () => new Date('2026-07-28T05:00:00.000Z'),
    );
    const events = [];
    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-1',
        connectionId: connection.id,
        modelId: 'claude-opus-4-8',
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'hello' },
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
        retryAfterMs: 2_000,
        observedAt: '2026-07-28T05:00:00.000Z',
      },
      {
        type: 'error',
        error: {
          category: 'rate_limited',
          message: 'Anthropic rate limit reached',
          retryable: true,
          retryAfterMs: 2_000,
          providerCode: 'http_429',
        },
      },
    ]);
  });
});
