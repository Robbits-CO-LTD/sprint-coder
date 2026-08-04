import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { OpenRouterCatalogClient } from './openrouter-provider-client';

const connection: ProviderConnection = {
  id: 'openrouter:primary',
  providerId: 'openrouter',
  runtimeKind: 'official_api',
  displayName: 'OpenRouter',
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

describe('OpenRouterCatalogClient', () => {
  it('maps a 1000+ gateway catalog without inventing the upstream provider', async () => {
    const providerFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer openrouter-key');
      expect(headers.get('X-OpenRouter-Title')).toBe('Sprint Coder');
      return Response.json({
        data: Array.from({ length: 1_200 }, (_, index) => ({
          id: `vendor/model-${index}`,
          name: `Model ${index}`,
          context_length: 128_000,
          supported_parameters: ['tools', 'response_format', 'reasoning'],
          architecture: { input_modalities: ['text', 'image'] },
          top_provider: { max_completion_tokens: 8_192 },
          pricing: { prompt: '0.000001', completion: '0.000002' },
        })),
      });
    });
    const client = new OpenRouterCatalogClient(
      () => ({ apiKey: 'openrouter-key' }),
      providerFetch,
      () => new Date('2026-07-28T04:00:00.000Z'),
    );

    const models = await client.listModels(connection, new AbortController().signal);
    expect(models).toHaveLength(1_200);
    expect(models[0]).toMatchObject({
      connectionId: 'openrouter:primary',
      providerId: 'openrouter',
      modelAuthor: { value: 'vendor', source: 'provider_api' },
      modelId: 'vendor/model-0',
      contextWindow: { value: 128_000, source: 'provider_api' },
      maxOutputTokens: { value: 8_192, source: 'provider_api' },
      toolCalling: { value: true, source: 'provider_api' },
      structuredOutput: { value: true, source: 'provider_api' },
      multimodalInput: { value: true, source: 'provider_api' },
      reasoning: { value: true, source: 'provider_api' },
      gateway: {
        providerId: 'openrouter',
        upstreamProvider: { value: null, source: 'unknown' },
      },
      pricing: {
        promptPerToken: { value: '0.000001', source: 'provider_api' },
        completionPerToken: { value: '0.000002', source: 'provider_api' },
        currency: 'USD',
      },
    });
  });

  it('classifies rejected gateway credentials separately', async () => {
    const client = new OpenRouterCatalogClient(
      () => ({ apiKey: 'bad-key' }),
      async () => new Response(null, { status: 401 }),
    );
    await expect(client.verify(connection, new AbortController().signal)).resolves.toMatchObject({
      status: 'invalid_credentials',
    });
  });

  it('sends Responses requests with routing metadata enabled', async () => {
    const client = new OpenRouterCatalogClient(
      () => ({ apiKey: 'openrouter-key' }),
      async (input, init) => {
        expect(String(input)).toBe('https://openrouter.ai/api/v1/responses');
        expect(new Headers(init?.headers).get('X-OpenRouter-Metadata')).toBe('enabled');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'openai/gpt-5.2',
          stream: true,
          store: false,
          input: [{ role: 'user', content: 'hello' }],
        });
        return new Response(
          'data: {"type":"response.content_part.delta","delta":"hi"}\n\n' +
            'data: {"type":"response.done","response":{"status":"completed","model":"openai/gpt-5.2","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        );
      },
    );
    const events = [];
    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-1',
        connectionId: connection.id,
        modelId: 'openai/gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      new AbortController().signal,
    ))
      events.push(event);
    expect(events.at(0)).toEqual({ type: 'output_delta', text: 'hi' });
    expect(events.at(-1)).toEqual({ type: 'completed', stopReason: 'completed' });
  });

  it('adds the OpenRouter Web Search server tool without dropping Team function tools', async () => {
    const client = new OpenRouterCatalogClient(
      () => ({ apiKey: 'openrouter-key' }),
      async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'x-ai/grok-4.3',
          tools: [
            {
              type: 'function',
              name: 'team_send_message',
              description: 'Send an audited Team message.',
              parameters: { type: 'object' },
              strict: true,
            },
            { type: 'openrouter:web_search' },
          ],
        });
        return new Response(
          'data: {"type":"response.done","response":{"status":"completed","model":"x-ai/grok-4.3","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        );
      },
    );

    for await (const _event of client.execute(
      connection,
      {
        executionId: 'execution-web-search',
        connectionId: connection.id,
        modelId: 'x-ai/grok-4.3',
        messages: [{ role: 'user', content: '最新情報をWeb調査してください' }],
        tools: [
          {
            name: 'team_send_message',
            description: 'Send an audited Team message.',
            inputSchema: { type: 'object' },
          },
        ],
        webSearch: true,
      },
      new AbortController().signal,
    )) {
      // Request assertion is the regression proof.
    }
  });

  it('preserves function calls and correlated results across Provider rounds', async () => {
    const client = new OpenRouterCatalogClient(
      () => ({ apiKey: 'openrouter-key' }),
      async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          input: [
            {
              type: 'function_call',
              call_id: 'call-1',
              name: 'read_file',
              arguments: '{"path":"README.md"}',
            },
            {
              type: 'function_call_output',
              call_id: 'call-1',
              output: '{"ok":true}',
            },
          ],
        });
        return new Response(
          'data: {"type":"response.done","response":{"status":"completed","model":"openai/gpt-5.2","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        );
      },
    );

    for await (const _event of client.execute(
      connection,
      {
        executionId: 'execution-tool-history',
        connectionId: connection.id,
        modelId: 'openai/gpt-5.2',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ callId: 'call-1', name: 'read_file', input: { path: 'README.md' } }],
          },
          {
            role: 'tool',
            content: '{"ok":true}',
            toolCallId: 'call-1',
            toolName: 'read_file',
          },
        ],
      },
      new AbortController().signal,
    )) {
      // Request assertion is the regression proof.
    }
  });
});
