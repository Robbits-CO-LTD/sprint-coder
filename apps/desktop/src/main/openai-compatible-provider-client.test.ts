import { describe, expect, it, vi } from 'vitest';
import type {
  CanonicalProviderEvent,
  ProviderConnection,
  ProviderProfile,
} from '@sprint-coder/contracts';
import { MainProviderProfileRegistry, resolvedProfileEndpointTrust } from './provider-profile';
import {
  OLLAMA_MODEL_PRELOAD_TIMEOUT_MS,
  OpenAICompatibleProviderClient,
  openAICompatibleChatCompletionRequest,
  resolveOllamaNativeGenerateEndpoint,
  resolveOllamaNativeShowEndpoint,
} from './openai-compatible-provider-client';
import {
  ProviderEndpointPolicy,
  fetchWithProviderEndpointPolicy,
} from './provider-endpoint-policy';
import { providerEventsWithDeadline } from './provider-stream-deadline';

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
  requiredCredentialFields: ['api_key'],
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

const endpointPolicy = new ProviderEndpointPolicy();

function approvedCredential(target: ProviderProfile, apiKey?: string) {
  const digest = endpointPolicy.digestForBaseUrl(target.baseUrl);
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    endpointDigest: digest,
    ...(resolvedProfileEndpointTrust(target, {}) === 'trusted-local'
      ? { localConsentDigest: digest }
      : {}),
  };
}

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
  it('does not start a request for a pre-aborted execution', async () => {
    const providerFetch = vi.fn();
    const client = new OpenAICompatibleProviderClient(
      registry(),
      () => approvedCredential(profile, 'test-key'),
      providerFetch,
    );
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      client.execute(
        connection,
        {
          executionId: 'execution-pre-aborted',
          connectionId: connection.id,
          modelId: 'model-a',
          messages: [{ role: 'user', content: 'hello' }],
        },
        controller.signal,
      ),
    );

    expect(providerFetch).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ category: 'canceled' }),
      }),
    );
  });

  it.each([
    ['http://localhost:11434/v1', 'http://127.0.0.1:11434/api/generate'],
    ['http://127.9.8.7:11434/v1/', 'http://127.9.8.7:11434/api/generate'],
    ['http://[::1]:11434/v1', 'http://[::1]:11434/api/generate'],
    ['https://localhost:11434/v1', null],
    ['http://192.168.1.20:11434/v1', null],
    ['http://localhost:11434/custom', null],
  ])('resolves only a pinned loopback Ollama native endpoint from %s', (baseUrl, expected) => {
    expect(resolveOllamaNativeGenerateEndpoint(baseUrl)).toBe(expected);
  });

  it('resolves the native Ollama show endpoint under the same loopback policy', () => {
    expect(resolveOllamaNativeShowEndpoint('http://localhost:11434/v1')).toBe(
      'http://127.0.0.1:11434/api/show',
    );
    expect(resolveOllamaNativeShowEndpoint('https://localhost:11434/v1')).toBeNull();
    expect(resolveOllamaNativeShowEndpoint('http://192.168.1.20:11434/v1')).toBeNull();
  });

  it.each([
    [['completion', 'vision'], true],
    [['completion', 'tools'], false],
  ] as const)(
    'derives Ollama image input only from bounded /api/show capabilities %j',
    async (capabilities, expected) => {
      const ollamaProfile: ProviderProfile = {
        ...profile,
        id: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        baseUrlConfigurable: true,
        nativeModelLifecycle: 'ollama',
        requiredCredentialFields: [],
      };
      const profiles = new MainProviderProfileRegistry();
      profiles.register(ollamaProfile);
      const requests: Array<{ url: string; body: unknown }> = [];
      const client = new OpenAICompatibleProviderClient(
        profiles,
        () => ({}),
        async (input, init) => {
          requests.push({
            url: String(input),
            body: init?.body === undefined ? null : JSON.parse(String(init.body)),
          });
          return new Response(JSON.stringify({ capabilities }), { status: 200 });
        },
        () => new Date('2026-08-22T00:00:00.000Z'),
      );
      const ollamaConnection = {
        ...connection,
        id: 'ollama:capability',
        providerId: 'ollama',
      };

      const captured = await client.captureImageInputCapability(
        ollamaConnection,
        'gemma4:12b',
        new AbortController().signal,
      );

      expect(captured).toMatchObject({
        value: expected,
        capturedAtMs: Date.parse('2026-08-22T00:00:00.000Z'),
      });
      expect(captured?.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(requests).toEqual([
        {
          url: 'http://127.0.0.1:11434/api/show',
          body: { model: 'gemma4:12b', verbose: false },
        },
      ]);
    },
  );

  it('fails closed on a malformed Ollama capability response', async () => {
    const ollamaProfile: ProviderProfile = {
      ...profile,
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      baseUrlConfigurable: true,
      nativeModelLifecycle: 'ollama',
      requiredCredentialFields: [],
    };
    const profiles = new MainProviderProfileRegistry();
    profiles.register(ollamaProfile);
    const client = new OpenAICompatibleProviderClient(
      profiles,
      () => ({}),
      async () => new Response(JSON.stringify({ capabilities: ['vision', { raw: 'secret' }] })),
    );

    await expect(
      client.captureImageInputCapability(
        { ...connection, id: 'ollama:malformed', providerId: 'ollama' },
        'gemma4:12b',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ value: null });
  });

  it('accepts bounded Ollama show metadata larger than 64 KiB', async () => {
    const ollamaProfile: ProviderProfile = {
      ...profile,
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      baseUrlConfigurable: true,
      nativeModelLifecycle: 'ollama',
      requiredCredentialFields: [],
    };
    const profiles = new MainProviderProfileRegistry();
    profiles.register(ollamaProfile);
    const client = new OpenAICompatibleProviderClient(
      profiles,
      () => ({}),
      async () =>
        new Response(
          JSON.stringify({ capabilities: ['completion', 'vision'], license: 'x'.repeat(70_000) }),
        ),
    );

    await expect(
      client.captureImageInputCapability(
        { ...connection, id: 'ollama:large-show', providerId: 'ollama' },
        'gemma4:12b',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ value: true });
  });

  it('bounds an unresponsive Ollama image capability probe', async () => {
    vi.useFakeTimers();
    try {
      const ollamaProfile: ProviderProfile = {
        ...profile,
        id: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        baseUrlConfigurable: true,
        nativeModelLifecycle: 'ollama',
        requiredCredentialFields: [],
      };
      const profiles = new MainProviderProfileRegistry();
      profiles.register(ollamaProfile);
      const client = new OpenAICompatibleProviderClient(
        profiles,
        () => ({}),
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      );
      const capability = client.captureImageInputCapability(
        { ...connection, id: 'ollama:capability-timeout', providerId: 'ollama' },
        'gemma4:12b',
        new AbortController().signal,
      );
      const expected = expect(capability).resolves.toMatchObject({ value: null });

      await vi.advanceTimersByTimeAsync(5_000);
      await expected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a bundled loopback Ollama model after its logical lease', async () => {
    const ollamaProfile: ProviderProfile = {
      ...profile,
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      baseUrlConfigurable: true,
      nativeModelLifecycle: 'ollama',
      requiredCredentialFields: [],
    };
    const profiles = new MainProviderProfileRegistry();
    profiles.register(ollamaProfile);
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = new OpenAICompatibleProviderClient(
      profiles,
      () => ({}),
      async (input, init) => {
        const body = init?.body === undefined ? null : JSON.parse(String(init.body));
        requests.push({
          url: String(input),
          body,
        });
        return new Response(
          body?.keep_alive === 0 ? '{}' : JSON.stringify({ model: body?.model }),
          { status: 200 },
        );
      },
    );
    const ollamaConnection = {
      ...connection,
      id: 'ollama:connection',
      providerId: 'ollama',
      automaticModelRelease: true,
    };

    const lease = await client.acquireModelLease(ollamaConnection, 'gemma3:1b');
    await lease.release();

    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:11434/api/generate',
        body: { model: 'gemma3:1b', keep_alive: '5m', stream: false },
      },
      {
        url: 'http://127.0.0.1:11434/api/generate',
        body: { model: 'gemma3:1b', keep_alive: 0 },
      },
    ]);
  });

  it('classifies a missing Ollama model before opening the answer stream', async () => {
    const ollamaProfile: ProviderProfile = {
      ...profile,
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      baseUrlConfigurable: true,
      nativeModelLifecycle: 'ollama',
      requiredCredentialFields: [],
    };
    const profiles = new MainProviderProfileRegistry();
    profiles.register(ollamaProfile);
    const client = new OpenAICompatibleProviderClient(
      profiles,
      () => ({}),
      async () => new Response('{}', { status: 404 }),
    );

    await expect(
      client.acquireModelLease(
        { ...connection, id: 'ollama:missing', providerId: 'ollama' },
        'missing:model',
      ),
    ).rejects.toMatchObject({
      name: 'OllamaModelPreparationError',
      category: 'not_found',
    });
  });

  it('bounds Ollama preload separately from the provider first-event timeout', async () => {
    vi.useFakeTimers();
    try {
      const ollamaProfile: ProviderProfile = {
        ...profile,
        id: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        baseUrlConfigurable: true,
        nativeModelLifecycle: 'ollama',
        requiredCredentialFields: [],
      };
      const profiles = new MainProviderProfileRegistry();
      profiles.register(ollamaProfile);
      const client = new OpenAICompatibleProviderClient(
        profiles,
        () => ({}),
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      );
      const lease = client.acquireModelLease(
        { ...connection, id: 'ollama:slow', providerId: 'ollama' },
        'slow:model',
      );
      const timedOut = expect(lease).rejects.toMatchObject({
        category: 'preload_timeout',
      });

      await vi.advanceTimersByTimeAsync(OLLAMA_MODEL_PRELOAD_TIMEOUT_MS);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  it.runIf(process.env['SPRINT_CODER_OLLAMA_TEST'] === '1')(
    'removes the exercised model from a real local Ollama process',
    async () => {
      const ollamaProfile: ProviderProfile = {
        ...profile,
        id: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        baseUrlConfigurable: true,
        nativeModelLifecycle: 'ollama',
        requiredCredentialFields: [],
      };
      const profiles = new MainProviderProfileRegistry();
      profiles.register(ollamaProfile);
      const client = new OpenAICompatibleProviderClient(profiles, () =>
        approvedCredential(ollamaProfile),
      );
      const ollamaConnection = {
        ...connection,
        id: 'ollama:real-local',
        providerId: 'ollama',
        automaticModelRelease: true,
      };
      const modelId = process.env['SPRINT_CODER_OLLAMA_MODEL'] ?? 'gemma3:1b';
      const lease = await client.acquireModelLease(ollamaConnection, modelId);
      try {
        const events = await collect(
          client.execute(
            ollamaConnection,
            {
              executionId: 'ollama-real-local-execution',
              connectionId: ollamaConnection.id,
              modelId,
              messages: [{ role: 'user', content: 'Reply with OK.' }],
            },
            new AbortController().signal,
          ),
        );
        expect(events).toContainEqual(expect.objectContaining({ type: 'completed' }));
      } finally {
        await lease.release();
      }
      const processes = (await (await fetch('http://127.0.0.1:11434/api/ps')).json()) as {
        models: Array<{ name: string }>;
      };
      expect(processes.models.some(({ name }) => name === modelId)).toBe(false);
    },
    120_000,
  );
  it.runIf(
    process.env['SPRINT_CODER_OLLAMA_TEST'] === '1' &&
      process.env['SPRINT_CODER_OLLAMA_VISION_MODEL'] !== undefined,
  )('reads real local Ollama vision capability without loading the model', async () => {
    const ollamaProfile: ProviderProfile = {
      ...profile,
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      baseUrlConfigurable: true,
      nativeModelLifecycle: 'ollama',
      requiredCredentialFields: [],
    };
    const profiles = new MainProviderProfileRegistry();
    profiles.register(ollamaProfile);
    const client = new OpenAICompatibleProviderClient(profiles, () =>
      approvedCredential(ollamaProfile),
    );
    const ollamaConnection = {
      ...connection,
      id: 'ollama:real-vision',
      providerId: 'ollama',
    };

    await expect(
      client.captureImageInputCapability(
        ollamaConnection,
        process.env['SPRINT_CODER_OLLAMA_VISION_MODEL']!,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ value: true });
  });
  it.runIf(
    process.env['SPRINT_CODER_OLLAMA_TEST'] === '1' &&
      process.env['SPRINT_CODER_OLLAMA_NONVISION_MODEL'] !== undefined,
  )('rejects a real local Ollama model without vision capability', async () => {
    const ollamaProfile: ProviderProfile = {
      ...profile,
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      baseUrlConfigurable: true,
      nativeModelLifecycle: 'ollama',
      requiredCredentialFields: [],
    };
    const profiles = new MainProviderProfileRegistry();
    profiles.register(ollamaProfile);
    const client = new OpenAICompatibleProviderClient(profiles, () =>
      approvedCredential(ollamaProfile),
    );

    await expect(
      client.captureImageInputCapability(
        { ...connection, id: 'ollama:real-nonvision', providerId: 'ollama' },
        process.env['SPRINT_CODER_OLLAMA_NONVISION_MODEL']!,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ value: false });
  });
  it('classifies only resolved loopback endpoints as trusted local', () => {
    const configurable = { ...profile, baseUrlConfigurable: true };
    expect(
      resolvedProfileEndpointTrust({ ...configurable, baseUrl: 'http://localhost:11434/v1' }, {}),
    ).toBe('trusted-local');
    expect(
      resolvedProfileEndpointTrust(configurable, { baseUrl: 'http://127.0.0.1:8080/v1' }),
    ).toBe('trusted-local');
    expect(resolvedProfileEndpointTrust(configurable, { baseUrl: 'http://[::1]:8080/v1' })).toBe(
      'trusted-local',
    );
    expect(
      resolvedProfileEndpointTrust(configurable, { baseUrl: 'https://local.example.test/v1' }),
    ).toBe('trusted-remote');
    expect(() =>
      resolvedProfileEndpointTrust(configurable, { baseUrl: 'http://192.168.1.20:8080/v1' }),
    ).toThrow('must use HTTPS or loopback HTTP');
  });

  it('uses one Profile for authentication and model discovery without inventing capabilities', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = new OpenAICompatibleProviderClient(
      registry(),
      () => approvedCredential(profile, 'test-key'),
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

  it('fails closed before network access when a stored endpoint has no validated digest', async () => {
    const providerFetch = vi.fn();
    const client = new OpenAICompatibleProviderClient(
      registry(),
      () => ({ apiKey: 'legacy-key' }),
      providerFetch,
    );

    await expect(client.listModels(connection, new AbortController().signal)).rejects.toThrow(
      'requires validation',
    );
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('omits authentication for a Profile whose API key is optional', async () => {
    const optionalProfile: ProviderProfile = {
      ...profile,
      id: 'local',
      baseUrl: 'http://localhost:11434/v1',
      baseUrlConfigurable: true,
      requiredCredentialFields: [],
    };
    const profiles = new MainProviderProfileRegistry();
    profiles.register(optionalProfile);
    const client = new OpenAICompatibleProviderClient(
      profiles,
      () => approvedCredential(optionalProfile),
      async (input, init) => {
        expect(String(input)).toBe('http://localhost:11434/v1/models');
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'local-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    await expect(
      client.listModels(
        { ...connection, id: 'local:connection', providerId: 'local' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject([{ modelId: 'local-model' }]);
  });

  it('normalizes fragmented Chat Completions text, reasoning, tools, usage and resolution', async () => {
    const client = new OpenAICompatibleProviderClient(
      registry(),
      () => approvedCredential(profile, 'test-key'),
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

  it('treats Ollama delta.reasoning as the first provider event without double counting aliases', async () => {
    const client = new OpenAICompatibleProviderClient(
      registry(),
      () => approvedCredential(profile, 'test-key'),
      async () =>
        new Response(
          sse([
            {
              model: 'model-a',
              choices: [
                {
                  delta: {
                    reasoning: 'ollama-think',
                    reasoning_content: 'ollama-think',
                    reasoning_details: [{ text: 'ollama-think' }, { text: 'distinct-detail' }],
                    content: '',
                  },
                },
              ],
            },
            {
              choices: [{ finish_reason: 'stop', delta: { content: 'done' } }],
            },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );

    const events = providerEventsWithDeadline(
      client.execute(
        connection,
        {
          executionId: 'execution-ollama-reasoning',
          connectionId: connection.id,
          modelId: 'model-a',
          messages: [{ role: 'user', content: 'hello' }],
        },
        new AbortController().signal,
      ),
      {
        executionId: 'execution-ollama-reasoning',
        firstEventTimeoutMs: 1_000,
        idleTimeoutMs: 1_000,
      },
    );

    await expect(collect(events)).resolves.toEqual([
      { type: 'reasoning_delta', text: 'ollama-think' },
      { type: 'reasoning_delta', text: 'distinct-detail' },
      { type: 'output_delta', text: 'done' },
      {
        type: 'resolution',
        resolution: { resolvedProvider: 'example', resolvedModel: 'model-a' },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          providerCost: null,
          source: 'unknown',
        },
      },
      { type: 'completed', stopReason: 'stop' },
    ]);
  });

  it('returns 429 to the shared Scheduler contract instead of credentials', async () => {
    const client = new OpenAICompatibleProviderClient(
      registry(),
      () => approvedCredential(profile, 'test-key'),
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
      () => approvedCredential(curated, 'test-key'),
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
  it('serializes accepted inline images as ordered data URLs on the same user message', () => {
    expect(
      openAICompatibleChatCompletionRequest({
        executionId: 'execution-images',
        connectionId: connection.id,
        modelId: 'vision-model',
        messages: [
          {
            role: 'user',
            content: 'describe both',
            inlineImages: [
              { mimeType: 'image/png', base64: 'b25l' },
              { mimeType: 'image/webp', base64: 'dHdv' },
            ],
          },
        ],
      }),
    ).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe both' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,b25l' } },
            { type: 'image_url', image_url: { url: 'data:image/webp;base64,dHdv' } },
          ],
        },
      ],
    });
  });

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

  it('disables Ollama thinking when tools are present so the model reaches its tool call', () => {
    const request = {
      executionId: 'execution-ollama-tools',
      connectionId: 'ollama:local',
      modelId: 'gemma4:12b',
      messages: [{ role: 'user' as const, content: 'create the file' }],
      tools: [
        { name: 'create_file', description: 'Create a file', inputSchema: { type: 'object' } },
      ],
    };

    expect(openAICompatibleChatCompletionRequest(request, 'ollama')).toMatchObject({
      reasoning_effort: 'none',
      tools: [{ type: 'function', function: { name: 'create_file' } }],
    });
    expect(openAICompatibleChatCompletionRequest(request, 'openai')).not.toHaveProperty(
      'reasoning_effort',
    );
  });

  it('maps a required Managed Local tool choice without changing Cloud sampling', () => {
    const request = {
      executionId: 'execution-managed-local-tools',
      connectionId: 'managed-local:runtime',
      modelId: 'managed-model',
      messages: [{ role: 'user' as const, content: 'create the file' }],
      tools: [
        { name: 'create_file', description: 'Create a file', inputSchema: { type: 'object' } },
      ],
      toolChoice: { name: 'create_file' },
    };

    expect(openAICompatibleChatCompletionRequest(request, 'sprint-managed-local')).toMatchObject({
      max_tokens: 512,
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
      tool_choice: { type: 'function', function: { name: 'create_file' } },
    });
    expect(openAICompatibleChatCompletionRequest(request, 'openai')).not.toHaveProperty(
      'temperature',
    );
  });

  it('maps Managed Local thinking and output limits to the request fields it supports', () => {
    const request = {
      executionId: 'execution-managed-local-inference-settings',
      connectionId: 'managed-local:runtime',
      modelId: 'managed-model',
      messages: [{ role: 'user' as const, content: 'reason carefully' }],
    };

    expect(
      openAICompatibleChatCompletionRequest(request, 'sprint-managed-local', {
        maxOutputTokens: 4_096,
        thinking: true,
      }),
    ).toMatchObject({
      max_tokens: 4_096,
      chat_template_kwargs: { enable_thinking: true },
    });
    expect(
      openAICompatibleChatCompletionRequest(request, 'sprint-managed-local', {
        maxOutputTokens: 1_024,
        thinking: true,
      }),
    ).not.toHaveProperty('reasoning_effort');
    expect(
      openAICompatibleChatCompletionRequest(request, 'sprint-managed-local', {
        maxOutputTokens: 2_048,
        thinking: false,
      }),
    ).toMatchObject({
      max_tokens: 2_048,
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
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
it('re-resolves and pins the real chat request before exposing its image body', async () => {
  const localProfile: ProviderProfile = {
    ...profile,
    id: 'local-vision',
    baseUrl: 'http://localhost:11434/v1',
    baseUrlConfigurable: true,
    requiredCredentialFields: [],
  };
  const profiles = new MainProviderProfileRegistry();
  profiles.register(localProfile);
  const localConnection: ProviderConnection = {
    ...connection,
    id: 'local-vision:connection',
    providerId: localProfile.id,
  };
  const credential = approvedCredential(localProfile);
  const deniedTransport = vi.fn();
  const deniedPolicy = new ProviderEndpointPolicy(async () => [
    { address: '192.168.1.20', family: 4 },
  ]);
  const deniedClient = new OpenAICompatibleProviderClient(
    profiles,
    () => credential,
    (input, init) => fetchWithProviderEndpointPolicy(deniedPolicy, input, init, deniedTransport),
  );
  const request = {
    executionId: 'execution-request-time-dns',
    connectionId: localConnection.id,
    modelId: 'vision-model',
    messages: [
      {
        role: 'user' as const,
        content: 'inspect',
        inlineImages: [{ mimeType: 'image/png' as const, base64: 'aW1hZ2U=' }],
      },
    ],
  };

  await expect(
    collect(deniedClient.execute(localConnection, request, new AbortController().signal)),
  ).resolves.toContainEqual(
    expect.objectContaining({
      type: 'error',
      error: expect.objectContaining({ category: 'network' }),
    }),
  );
  expect(deniedTransport).not.toHaveBeenCalled();

  const allowedTransport = vi.fn(
    async (_prepared: unknown, _init: RequestInit) =>
      new Response(
        sse([
          { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const allowedPolicy = new ProviderEndpointPolicy(async () => [
    { address: '127.0.0.1', family: 4 },
  ]);
  const allowedClient = new OpenAICompatibleProviderClient(
    profiles,
    () => credential,
    (input, init) => fetchWithProviderEndpointPolicy(allowedPolicy, input, init, allowedTransport),
  );

  const allowedEvents = await collect(
    allowedClient.execute(localConnection, request, new AbortController().signal),
  );
  expect(allowedTransport).toHaveBeenCalledOnce();
  expect(allowedTransport.mock.calls[0]?.[0]).toMatchObject({
    trust: 'trusted-local',
    addresses: [{ address: '127.0.0.1', family: 4 }],
  });
  expect(allowedEvents).toContainEqual({ type: 'output_delta', text: 'ok' });
});
