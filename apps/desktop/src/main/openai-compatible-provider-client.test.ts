import { describe, expect, it } from 'vitest';
import type {
  CanonicalProviderEvent,
  ProviderConnection,
  ProviderProfile,
} from '@sprint-coder/contracts';
import { MainProviderProfileRegistry } from './provider-profile';
import {
  OpenAICompatibleProviderClient,
  openAICompatibleChatCompletionRequest,
} from './openai-compatible-provider-client';

const profile: ProviderProfile = {
  id: 'example',
  displayName: 'Example',
  baseUrl: 'https://api.example.com/v1',
  baseUrlConfigurable: false,
  protocol: 'chat_completions',
  modelsPath: '/models',
  curatedModels: [],
  verificationModel: null,
  authentication: { headerName: 'Authorization', scheme: 'Bearer' },
  requiredCredentialFields: [],
  errorOverrides: [],
  sourceReference: 'https://docs.example.com/openai',
  reviewedAt: '2026-07-28T00:00:00.000Z',
};

const connection: ProviderConnection = {
  id: 'example:connection',
  providerId: 'example',
  runtimeKind: 'openai_compatible',
  displayName: 'Example',
  enabled: true,
  secretReference: 'provider-secret:00000000-0000-4000-8000-000000000000',
  verification: {
    status: 'verified',
    verifiedAt: '2026-07-28T00:00:00.000Z',
    expiresAt: '2026-07-29T00:00:00.000Z',
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

function registry(): MainProviderProfileRegistry {
  const result = new MainProviderProfileRegistry();
  result.register(profile);
  return result;
}

function sse(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

async function collect(
  iterable: AsyncIterable<CanonicalProviderEvent>,
): Promise<CanonicalProviderEvent[]> {
  const events: CanonicalProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('OpenAICompatibleProviderClient', () => {
  it('uses one Profile for authentication and model discovery without inventing capabilities', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = new OpenAICompatibleProviderClient(
      registry(),
      () => ({ apiKey: 'test-key' }),
      async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'model-a',
                object: 'model',
                context_window: 131_072,
                max_completion_tokens: 8_192,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      () => new Date('2026-07-28T00:00:00.000Z'),
    );

    const models = await client.listModels(connection, new AbortController().signal);

    expect(requests).toEqual([
      {
        url: 'https://api.example.com/v1/models',
        authorization: 'Bearer test-key',
      },
    ]);
    expect(models[0]).toMatchObject({
      providerId: 'example',
      modelId: 'model-a',
      contextWindow: { value: 131_072, source: 'provider_api' },
      maxOutputTokens: { value: 8_192, source: 'provider_api' },
      toolCalling: { value: null, source: 'unknown' },
      reasoning: { value: null, source: 'unknown' },
    });
  });

  it('normalizes fragmented Chat Completions text, reasoning, tools, usage and resolution', async () => {
    const client = new OpenAICompatibleProviderClient(
      registry(),
      () => ({ apiKey: 'test-key' }),
      async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'model-a',
          stream: true,
          stream_options: { include_usage: true },
        });
        return new Response(
          sse([
            {
              model: 'model-a-202607',
              choices: [
                {
                  delta: {
                    reasoning_content: 'think',
                    content: 'hello',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        function: { name: 'lookup', arguments: '{"q":' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: '"value"}' } }],
                  },
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                completion_tokens_details: { reasoning_tokens: 2 },
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    );

    const events = await collect(
      client.execute(
        connection,
        {
          executionId: 'execution-1',
          connectionId: connection.id,
          modelId: 'model-a',
          messages: [{ role: 'user', content: 'hello' }],
          tools: [
            {
              name: 'lookup',
              description: 'Lookup a value',
              inputSchema: { type: 'object' },
            },
          ],
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'think' },
      { type: 'output_delta', text: 'hello' },
      { type: 'tool_call', callId: 'call-1', name: 'lookup', input: { q: 'value' } },
      {
        type: 'resolution',
        resolution: { resolvedProvider: 'example', resolvedModel: 'model-a-202607' },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: 2,
          providerCost: null,
          source: 'provider_api',
        },
      },
      { type: 'completed', stopReason: 'tool_calls' },
    ]);
  });

  it('returns 429 to the shared Scheduler contract instead of credentials', async () => {
    const client = new OpenAICompatibleProviderClient(
      registry(),
      () => ({ apiKey: 'test-key' }),
      async () =>
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
    );
    const events = await collect(
      client.execute(
        connection,
        {
          executionId: 'execution-2',
          connectionId: connection.id,
          modelId: 'model-a',
          messages: [{ role: 'user', content: 'hello' }],
        },
        new AbortController().signal,
      ),
    );
    expect(events).toMatchObject([
      { type: 'rate_limit', retryAfterMs: 2_000 },
      { type: 'error', error: { category: 'rate_limited', retryable: true } },
    ]);
  });

  it('uses a declared minimal probe and curated catalog when no free model list exists', async () => {
    const curated: ProviderProfile = {
      ...profile,
      id: 'curated',
      modelsPath: null,
      curatedModels: [{ id: 'curated-model', displayName: 'Curated Model' }],
      verificationModel: 'curated-model',
    };
    const profiles = new MainProviderProfileRegistry();
    profiles.register(curated);
    const curatedConnection: ProviderConnection = {
      ...connection,
      id: 'curated:connection',
      providerId: 'curated',
    };
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = new OpenAICompatibleProviderClient(
      profiles,
      () => ({ apiKey: 'test-key' }),
      async (input, init) => {
        requests.push({
          url: String(input),
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        });
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      () => new Date('2026-07-28T00:00:00.000Z'),
    );

    await expect(
      client.verify(curatedConnection, new AbortController().signal),
    ).resolves.toMatchObject({ status: 'verified' });
    await expect(
      client.listModels(curatedConnection, new AbortController().signal),
    ).resolves.toMatchObject([
      {
        modelId: 'curated-model',
        displayName: 'Curated Model',
        toolCalling: { value: null, source: 'unknown' },
      },
    ]);
    expect(requests).toEqual([
      {
        url: 'https://api.example.com/v1/chat/completions',
        body: {
          model: 'curated-model',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        },
      },
    ]);
  });
});

describe('openAICompatibleChatCompletionRequest', () => {
  it('maps tools and structured output without Provider-specific branches', () => {
    expect(
      openAICompatibleChatCompletionRequest({
        executionId: 'execution-3',
        connectionId: connection.id,
        modelId: 'model-a',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
        structuredOutput: {
          name: 'answer',
          schema: { type: 'object' },
          strict: true,
        },
      }),
    ).toMatchObject({
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } },
    });
  });

  it('preserves assistant tool calls and their results across provider rounds', () => {
    expect(
      openAICompatibleChatCompletionRequest({
        executionId: 'execution-tool-history',
        connectionId: connection.id,
        modelId: 'model-a',
        messages: [
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
      }),
    ).toMatchObject({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"value"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
      ],
    });
  });
});
