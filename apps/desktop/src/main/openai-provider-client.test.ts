import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { OpenAIProviderClient } from './openai-provider-client';

const connection: ProviderConnection = {
  id: 'openai:primary',
  providerId: 'openai',
  runtimeKind: 'official_api',
  displayName: 'OpenAI API',
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

describe('OpenAIProviderClient', () => {
  it('verifies with the free model-list endpoint and Main-only credential headers', async () => {
    const providerFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer test-openai-key');
      expect(headers.get('OpenAI-Organization')).toBe('org_test');
      expect(headers.get('OpenAI-Project')).toBe('proj_test');
      return Response.json({ object: 'list', data: [] });
    });
    const client = new OpenAIProviderClient(
      () => ({
        apiKey: 'test-openai-key',
        organizationId: 'org_test',
        projectId: 'proj_test',
      }),
      providerFetch,
      () => new Date('2026-07-28T01:00:00.000Z'),
    );

    await expect(client.verify(connection, new AbortController().signal)).resolves.toEqual({
      status: 'verified',
      verifiedAt: '2026-07-28T01:00:00.000Z',
      expiresAt: '2026-07-29T01:00:00.000Z',
      message: null,
    });
  });

  it.each([401, 403])('classifies HTTP %s as invalid credentials', async (status) => {
    const client = new OpenAIProviderClient(
      () => ({ apiKey: 'rejected-key' }),
      async () => new Response(null, { status }),
      () => new Date('2026-07-28T01:00:00.000Z'),
    );

    await expect(client.verify(connection, new AbortController().signal)).resolves.toMatchObject({
      status: 'invalid_credentials',
      message: 'OpenAI API credentials were rejected',
    });
  });

  it('keeps temporary provider errors distinct from invalid credentials', async () => {
    const client = new OpenAIProviderClient(
      () => ({ apiKey: 'valid-key' }),
      async () => new Response(null, { status: 429 }),
    );

    await expect(client.verify(connection, new AbortController().signal)).resolves.toMatchObject({
      status: 'unavailable',
      message: 'OpenAI API is temporarily unavailable',
    });
  });

  it('maps discovered identity while leaving unpublished capabilities unknown', async () => {
    const client = new OpenAIProviderClient(
      () => ({ apiKey: 'valid-key' }),
      async () =>
        Response.json({
          object: 'list',
          data: [
            { id: 'gpt-5.2', object: 'model', created: 1, owned_by: 'openai' },
            { id: 'custom-model', object: 'model', created: 2, owned_by: 'customer' },
          ],
        }),
      () => new Date('2026-07-28T02:00:00.000Z'),
    );

    const models = await client.listModels(connection, new AbortController().signal);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      connectionId: 'openai:primary',
      providerId: 'openai',
      modelId: 'gpt-5.2',
      displayName: 'gpt-5.2',
      available: true,
      availabilityCheckedAt: '2026-07-28T02:00:00.000Z',
      toolCalling: { value: null, source: 'unknown' },
      reasoning: { value: null, source: 'unknown' },
    });
  });

  it('sends a streaming Responses request with tools and structured output', async () => {
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'gpt-5.2',
        stream: true,
        store: false,
        input: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'Weather?' },
          { type: 'function_call_output', call_id: 'call_previous', output: 'sunny' },
        ],
        tools: [
          {
            type: 'function',
            name: 'lookup',
            description: 'Look up weather',
            parameters: { type: 'object' },
            strict: true,
          },
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
        'data: {"type":"response.output_text.delta","delta":"sunny"}\n\n' +
          'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-5.2","usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const client = new OpenAIProviderClient(() => ({ apiKey: 'valid-key' }), providerFetch);
    const events = [];
    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-1',
        connectionId: connection.id,
        modelId: 'gpt-5.2',
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'Weather?' },
          { role: 'tool', content: 'sunny', toolCallId: 'call_previous' },
        ],
        tools: [
          {
            name: 'lookup',
            description: 'Look up weather',
            inputSchema: { type: 'object' },
          },
        ],
        structuredOutput: {
          name: 'answer',
          schema: { type: 'object' },
          strict: true,
        },
      },
      new AbortController().signal,
    ))
      events.push(event);
    expect(events.at(0)).toEqual({ type: 'output_delta', text: 'sunny' });
    expect(events.at(-1)).toEqual({ type: 'completed', stopReason: 'completed' });
  });

  it('emits rate-limit admission information without misclassifying credentials', async () => {
    const client = new OpenAIProviderClient(
      () => ({ apiKey: 'valid-key' }),
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '2' } }),
      () => new Date('2026-07-28T01:00:00.000Z'),
    );
    const events = [];
    for await (const event of client.execute(
      connection,
      {
        executionId: 'execution-429',
        connectionId: connection.id,
        modelId: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      new AbortController().signal,
    ))
      events.push(event);
    expect(events).toEqual([
      {
        type: 'rate_limit',
        retryAfterMs: 2_000,
        observedAt: '2026-07-28T01:00:00.000Z',
      },
      {
        type: 'error',
        error: {
          category: 'rate_limited',
          message: 'OpenAI API rate limit reached',
          retryable: true,
          retryAfterMs: 2_000,
          providerCode: 'http_429',
        },
      },
    ]);
  });

  it('cancels the in-flight HTTP stream by execution ID', async () => {
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const client = new OpenAIProviderClient(
      () => ({ apiKey: 'valid-key' }),
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          notifyStarted?.();
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const iterator = client.execute(
      connection,
      {
        executionId: 'execution-cancel',
        connectionId: connection.id,
        modelId: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      new AbortController().signal,
    )[Symbol.asyncIterator]();
    const pending = iterator.next();
    await started;
    await client.cancel('execution-cancel');

    await expect(pending).resolves.toEqual({
      done: false,
      value: {
        type: 'error',
        error: {
          category: 'canceled',
          message: 'OpenAI execution was canceled',
          retryable: false,
          retryAfterMs: null,
          providerCode: null,
        },
      },
    });
  });
});
