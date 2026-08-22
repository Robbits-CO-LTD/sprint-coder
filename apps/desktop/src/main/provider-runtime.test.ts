import { describe, expect, it } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import {
  captureProviderImageInputCapability,
  DeterministicMockProviderRuntime,
  MainProviderRegistry,
} from './provider-runtime';

const connection: ProviderConnection = {
  id: 'mock:local',
  providerId: 'mock',
  runtimeKind: 'mock',
  displayName: 'Mock',
  enabled: true,
  secretReference: null,
  verification: {
    status: 'not_required',
    verifiedAt: null,
    expiresAt: null,
    message: null,
  },
  rateLimit: {
    mode: 'bypass',
    maxConcurrentRequests: null,
    requestsPerMinute: null,
    tokensPerMinute: null,
    lastObservedRateLimitHeaders: null,
  },
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

describe('Provider Runtime Registry', () => {
  it('resolves a generic Runtime and emits canonical events only', async () => {
    const registry = new MainProviderRegistry();
    const runtime = new DeterministicMockProviderRuntime();
    registry.register({ runtimeKind: 'mock', providerId: null, runtime });
    const resolved = registry.resolve(connection);
    const events = [];
    for await (const event of resolved.execute(
      connection,
      {
        executionId: 'execution-1',
        connectionId: connection.id,
        modelId: 'mock-model',
        messages: [{ role: 'user', content: 'hello' }],
      },
      new AbortController().signal,
    ))
      events.push(event);

    expect(events.map(({ type }) => type)).toEqual([
      'output_delta',
      'resolution',
      'usage',
      'completed',
    ]);
    expect(events[1]).toEqual({
      type: 'resolution',
      resolution: { resolvedProvider: 'mock', resolvedModel: 'mock-model' },
    });
  });

  it('fails closed with a stable revision when a Provider catalog has unknown image capability', async () => {
    const runtime = new DeterministicMockProviderRuntime();
    const first = await captureProviderImageInputCapability(
      runtime,
      connection,
      'mock-model',
      new AbortController().signal,
      () => 10,
    );
    const second = await captureProviderImageInputCapability(
      runtime,
      connection,
      'mock-model',
      new AbortController().signal,
      () => 20,
    );

    expect(first).toMatchObject({ value: null, capturedAtMs: 10 });
    expect(second).toMatchObject({ value: null, capturedAtMs: 20 });
    expect(second.revision).toBe(first.revision);
  });
});
