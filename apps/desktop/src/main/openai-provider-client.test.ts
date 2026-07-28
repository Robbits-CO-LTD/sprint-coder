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
});
