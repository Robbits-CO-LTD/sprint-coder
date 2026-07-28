import { describe, expect, it } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { DeterministicMockProviderRuntime, MainProviderRegistry } from './provider-runtime';

const connection: ProviderConnection = {
  id: 'mock:local',
  providerId: 'mock',
  runtimeKind: 'mock',
  displayName: 'Mock',
  enabled: true,
  secretReference: null,
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
});
