import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { OrcaRouterProviderClient } from './orcarouter-provider-client';

const connection: ProviderConnection = {
  id: 'orcarouter:primary',
  providerId: 'orcarouter',
  runtimeKind: 'official_api',
  displayName: 'Work OrcaRouter',
  enabled: true,
  secretReference: 'provider-secret:00000000-0000-4000-8000-000000000001',
  verification: { status: 'unverified', verifiedAt: null, expiresAt: null, message: null },
  rateLimit: {
    mode: 'auto',
    maxConcurrentRequests: 2,
    requestsPerMinute: null,
    tokensPerMinute: null,
    lastObservedRateLimitHeaders: null,
  },
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};

describe('OrcaRouterProviderClient', () => {
  it('authenticates against the fixed endpoint and maps only chat-capable models', async () => {
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.orcarouter.ai/v1/models');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer orca-key');
      return Response.json({
        object: 'list',
        data: [
          {
            id: 'anthropic/claude-sonnet-4.6',
            owned_by: 'anthropic',
            supported_endpoint_types: ['anthropic', 'openai'],
          },
          {
            id: 'grok/grok-4-fast-reasoning',
            supported_endpoint_types: ['openai'],
          },
          { id: 'kling/kling-v3-omni', owned_by: 'kling', supported_endpoint_types: ['video'] },
          { id: 'orcarouter/auto', owned_by: 'orcarouter', supported_endpoint_types: [] },
        ],
      });
    });
    const client = new OrcaRouterProviderClient(
      () => ({ apiKey: 'orca-key' }),
      providerFetch,
      () => new Date('2026-08-18T01:00:00.000Z'),
    );

    const models = await client.listModels(connection, new AbortController().signal);
    expect(models.map(({ modelId }) => modelId)).toEqual([
      'anthropic/claude-sonnet-4.6',
      'grok/grok-4-fast-reasoning',
      'orcarouter/auto',
    ]);
    expect(models[0]).toMatchObject({
      providerId: 'orcarouter',
      providerDisplayName: 'OrcaRouter',
      modelAuthor: { value: 'anthropic', source: 'provider_api' },
      toolCalling: { value: true, source: 'provider_api' },
      gateway: { providerId: 'orcarouter', upstreamProvider: { value: null } },
    });
    expect(models[1]?.modelAuthor?.value).toBe('grok');
  });

  it('classifies rejected credentials separately', async () => {
    const client = new OrcaRouterProviderClient(
      () => ({ apiKey: 'bad-key' }),
      async () => new Response(null, { status: 401 }),
    );
    await expect(client.verify(connection, new AbortController().signal)).resolves.toMatchObject({
      status: 'invalid_credentials',
    });
  });

  it('sends Responses function and web-search tools and records the resolved router model', async () => {
    const client = new OrcaRouterProviderClient(
      () => ({ apiKey: 'orca-key' }),
      async (input, init) => {
        expect(String(input)).toBe('https://api.orcarouter.ai/v1/responses');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'orcarouter/auto',
          stream: true,
          store: false,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'hello' },
                { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
              ],
            },
          ],
          tools: [
            {
              type: 'function',
              name: 'read_file',
              description: 'Read a file.',
              parameters: { type: 'object' },
              strict: true,
            },
            { type: 'web_search' },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'answer',
              schema: { type: 'object' },
              strict: true,
            },
          },
        });
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
            'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"path\\":\\"README.md\\"}"}\n\n' +
            'data: {"type":"response.output_item.done","item":{"id":"item-1","type":"function_call","call_id":"call-1","name":"read_file"}}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed","model":"orcarouter/auto","usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
          { headers: { 'X-Orca-Resolved-Model': 'anthropic/claude-sonnet-4.6' } },
        );
      },
    );
    const events = [];
    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-1',
        connectionId: connection.id,
        modelId: 'orcarouter/auto',
        messages: [
          {
            role: 'user',
            content: 'hello',
            inlineImages: [{ mimeType: 'image/png', base64: 'aW1hZ2U=' }],
          },
        ],
        tools: [
          { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object' } },
        ],
        webSearch: true,
        structuredOutput: { name: 'answer', schema: { type: 'object' }, strict: true },
      },
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toContainEqual({ type: 'output_delta', text: 'hi' });
    expect(events).toContainEqual({
      type: 'tool_call',
      callId: 'call-1',
      name: 'read_file',
      input: { path: 'README.md' },
    });
    expect(events).toContainEqual({
      type: 'resolution',
      resolution: {
        resolvedProvider: 'orcarouter',
        resolvedModel: 'anthropic/claude-sonnet-4.6',
        gatewayProvider: 'orcarouter',
        upstreamProvider: null,
      },
    });
  });

  it('normalizes rate limits and cancellation', async () => {
    const rateLimited = new OrcaRouterProviderClient(
      () => ({ apiKey: 'orca-key' }),
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '2' } }),
    );
    const rateEvents = [];
    for await (const event of rateLimited.execute(
      connection,
      {
        executionId: 'execution-rate',
        connectionId: connection.id,
        modelId: 'openai/gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
      },
      new AbortController().signal,
    ))
      rateEvents.push(event);
    expect(rateEvents[0]).toMatchObject({ type: 'rate_limit', retryAfterMs: 2_000 });
    expect(rateEvents[1]).toMatchObject({ type: 'error', error: { category: 'rate_limited' } });

    const aborted = new AbortController();
    aborted.abort();
    const canceled = new OrcaRouterProviderClient(
      () => ({ apiKey: 'orca-key' }),
      async (_input, init) => {
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return new Response(null, { status: 500 });
      },
    );
    const cancelEvents = [];
    for await (const event of canceled.execute(
      connection,
      {
        executionId: 'execution-cancel',
        connectionId: connection.id,
        modelId: 'openai/gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
      },
      aborted.signal,
    ))
      cancelEvents.push(event);
    expect(cancelEvents[0]).toMatchObject({ type: 'error', error: { category: 'canceled' } });
  });

  it('normalizes missing models, service failures, and empty streams', async () => {
    for (const [status, category] of [
      [404, 'not_found'],
      [503, 'provider_unavailable'],
    ] as const) {
      const client = new OrcaRouterProviderClient(
        () => ({ apiKey: 'orca-key' }),
        async () => new Response(null, { status }),
      );
      const events = [];
      for await (const event of client.execute(
        connection,
        {
          executionId: `execution-${status}`,
          connectionId: connection.id,
          modelId: 'openai/gpt-5',
          messages: [{ role: 'user', content: 'hello' }],
        },
        new AbortController().signal,
      ))
        events.push(event);
      expect(events[0]).toMatchObject({ type: 'error', error: { category } });
    }

    const empty = new OrcaRouterProviderClient(
      () => ({ apiKey: 'orca-key' }),
      async () => ({ ok: true, status: 200, headers: new Headers(), body: null }) as Response,
    );
    const emptyEvents = [];
    for await (const event of empty.execute(
      connection,
      {
        executionId: 'execution-empty',
        connectionId: connection.id,
        modelId: 'openai/gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
      },
      new AbortController().signal,
    ))
      emptyEvents.push(event);
    expect(emptyEvents[0]).toMatchObject({
      type: 'error',
      error: { category: 'provider_unavailable', message: 'OrcaRouter returned an empty stream' },
    });
  });
});
