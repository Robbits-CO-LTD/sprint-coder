import { describe, expect, it } from 'vitest';
import type { ProviderModel } from '@sprint-coder/contracts';
import { ModelCatalogService } from './model-catalog-service';

const unknown = { value: null, source: 'unknown' as const };

function model(index: number): ProviderModel {
  return {
    connectionId: index % 2 === 0 ? 'builtin:codex-cli' : 'builtin:claude-cli',
    providerId: index % 2 === 0 ? 'openai' : 'anthropic',
    modelId: `model-${index}`,
    displayName: `Synthetic Model ${index}`,
    available: true,
    availabilityCheckedAt: '2026-07-28T00:00:00.000Z',
    contextWindow: unknown,
    maxOutputTokens: unknown,
    toolCalling: unknown,
    structuredOutput: unknown,
    multimodalInput: unknown,
    reasoning: unknown,
  };
}

describe('ModelCatalogService', () => {
  it('builds one index per catalog revision and pages a 1000+ model fixture', () => {
    const service = new ModelCatalogService();
    const catalog = Array.from({ length: 1_200 }, (_, index) => model(index));
    service.replaceCatalog(catalog);
    service.replaceCatalog(catalog);
    const first = service.query({
      taskId: 'task-1',
      text: 'Synthetic Model 11',
      connectionIds: [],
      providerIds: [],
      accessTypes: [],
      capabilities: [],
      availableOnly: true,
      cursor: null,
      limit: 25,
    });

    expect(service.indexBuildCount).toBe(1);
    expect(first.total).toBeGreaterThan(25);
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBe('cursor:25');
  });

  it('refreshes observation timestamps without rebuilding the search index', () => {
    const service = new ModelCatalogService();
    service.replaceCatalog([model(1)]);
    service.replaceCatalog([{ ...model(1), availabilityCheckedAt: '2026-07-28T01:00:00.000Z' }]);
    const result = service.query({
      taskId: 'task-1',
      text: '',
      connectionIds: [],
      providerIds: [],
      accessTypes: [],
      capabilities: [],
      availableOnly: true,
      cursor: null,
      limit: 10,
    });
    expect(service.indexBuildCount).toBe(1);
    expect(result.items[0]?.availabilityCheckedAt).toBe('2026-07-28T01:00:00.000Z');
  });

  it('filters subscription and API models without exposing Runtime-specific state to Renderer', () => {
    const service = new ModelCatalogService();
    const subscription = {
      ...model(1),
      connectionId: 'builtin:claude-cli',
      connectionDisplayName: 'Claude Code',
    };
    const api = {
      ...model(2),
      connectionId: 'openrouter:connection-1',
      connectionDisplayName: 'OpenRouter',
    };
    service.replaceCatalog([subscription, api], new Set(['builtin:claude-cli']));

    const subscriptionResult = service.query({
      taskId: 'task-1',
      text: '',
      connectionIds: [],
      providerIds: [],
      accessTypes: ['subscription'],
      capabilities: [],
      availableOnly: true,
      cursor: null,
      limit: 10,
    });
    const apiResult = service.query({
      taskId: 'task-1',
      text: 'OpenRouter',
      connectionIds: [],
      providerIds: [],
      accessTypes: ['api'],
      capabilities: [],
      availableOnly: true,
      cursor: null,
      limit: 10,
    });

    expect(subscriptionResult.items.map(({ connectionId }) => connectionId)).toEqual([
      'builtin:claude-cli',
    ]);
    expect(apiResult.items.map(({ connectionId }) => connectionId)).toEqual([
      'openrouter:connection-1',
    ]);
  });

  it('applies a Team model allowlist before pagination and total calculation', () => {
    const service = new ModelCatalogService();
    service.replaceCatalog([model(1), model(2), model(3)]);
    const allowed = new Set(['builtin:codex-cli\u0000openai\u0000model-2']);

    const result = service.query(
      {
        taskId: 'task-1',
        text: '',
        connectionIds: [],
        providerIds: [],
        accessTypes: [],
        capabilities: [],
        availableOnly: true,
        cursor: null,
        limit: 10,
      },
      allowed,
    );

    expect(result.total).toBe(1);
    expect(result.items.map(({ modelId }) => modelId)).toEqual(['model-2']);
    expect(result.nextCursor).toBeNull();
  });
});
