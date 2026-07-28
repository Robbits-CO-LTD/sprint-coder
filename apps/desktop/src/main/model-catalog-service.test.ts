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
});
