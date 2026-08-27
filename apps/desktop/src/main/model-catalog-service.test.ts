import { describe, expect, it } from 'vitest';
import type { ProviderModel } from '@sprint-coder/contracts';
import { toolValueMatchesSchema } from '@sprint-coder/domain';
import { ModelCatalogService } from './model-catalog-service';
import { TEAM_LIST_MODELS_TOOL } from './team-tools';

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

  it('filters subscription, API, and local models without exposing Runtime-specific state to Renderer', () => {
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
    const local = {
      ...model(3),
      connectionId: 'ollama:local',
      connectionDisplayName: 'Local Ollama',
    };
    service.replaceCatalog(
      [subscription, api, local],
      new Map([
        ['builtin:claude-cli', 'subscription'],
        ['ollama:local', 'local'],
      ]),
    );

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
    const localResult = service.query({
      taskId: 'task-1',
      text: '',
      connectionIds: [],
      providerIds: [],
      accessTypes: ['local'],
      capabilities: [],
      availableOnly: true,
      cursor: null,
      limit: 10,
    });
    const apiOrLocalResult = service.query({
      taskId: 'task-1',
      text: '',
      connectionIds: [],
      providerIds: [],
      accessTypes: ['api', 'local'],
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
    expect(localResult.items.map(({ connectionId }) => connectionId)).toEqual(['ollama:local']);
    expect(apiOrLocalResult.items.map(({ connectionId }) => connectionId).sort()).toEqual([
      'ollama:local',
      'openrouter:connection-1',
    ]);
  });

  it('keeps an unmapped connection in API for backward compatibility', () => {
    const service = new ModelCatalogService();
    service.replaceCatalog([model(1)], new Map());

    const api = service.query({
      taskId: 'task-1',
      text: '',
      connectionIds: [],
      providerIds: [],
      accessTypes: ['api'],
      capabilities: [],
      availableOnly: true,
      cursor: null,
      limit: 10,
    });
    const local = service.query({
      taskId: 'task-1',
      text: '',
      connectionIds: [],
      providerIds: [],
      accessTypes: ['local'],
      capabilities: [],
      availableOnly: true,
      cursor: null,
      limit: 10,
    });

    expect(api.items).toHaveLength(1);
    expect(local.items).toHaveLength(0);
  });

  it('searches stable provider names and model authors as well as connection names', () => {
    const service = new ModelCatalogService();
    const orcaModel = {
      ...model(2),
      connectionId: 'orcarouter:work',
      connectionDisplayName: '本番ゲートウェイ',
      providerId: 'orcarouter',
      providerDisplayName: 'OrcaRouter',
      modelAuthor: { value: 'grok', source: 'provider_api' as const },
    };
    service.replaceCatalog([orcaModel]);

    const query = (text: string) =>
      service.query({
        taskId: 'task-1',
        text,
        connectionIds: [],
        providerIds: [],
        accessTypes: [],
        capabilities: [],
        availableOnly: true,
        cursor: null,
        limit: 10,
      });
    expect(query('OrcaRouter').items).toHaveLength(1);
    expect(query('grok').items).toHaveLength(1);
    expect(query('xAI').items).toHaveLength(1);
    expect(query('本番ゲートウェイ').items).toHaveLength(1);
  });

  it('returns JSON-safe Team candidates when an external provider has no known author', () => {
    const service = new ModelCatalogService();
    service.replaceCatalog([
      {
        ...model(2),
        connectionId: 'localai:windows',
        connectionDisplayName: 'Qwen3.8-27B',
        providerId: 'localai',
        providerDisplayName: 'localai',
        modelAuthor: undefined,
        modelId: 'Local-Qwen3.8',
      },
    ]);

    const result = service.query({
      taskId: 'task-1',
      text: 'Local-Qwen3.8',
      connectionIds: ['localai:windows'],
      providerIds: ['localai'],
      accessTypes: [],
      capabilities: [],
      availableOnly: true,
      cursor: null,
      limit: 10,
    });

    expect(result.items).toHaveLength(1);
    expect(Object.hasOwn(result.items[0]!, 'modelAuthor')).toBe(false);
    expect(toolValueMatchesSchema(TEAM_LIST_MODELS_TOOL.outputSchema, result)).toBe(true);
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

  it('admits multiple selected models but excludes a later unconfigured Connection', () => {
    const service = new ModelCatalogService();
    const codexCli = {
      ...model(2),
      connectionId: 'builtin:codex-cli',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
    };
    const openAiProduction = {
      ...model(4),
      connectionId: 'openai:production',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
    };
    const laterOpenAiConnection = {
      ...model(6),
      connectionId: 'openai:added-later',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
    };
    service.replaceCatalog([codexCli, openAiProduction, laterOpenAiConnection]);
    const allowed = new Set([
      'builtin:codex-cli\u0000openai\u0000gpt-5.6-sol',
      'openai:production\u0000openai\u0000gpt-5.6-sol',
    ]);

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

    expect(result.items.map(({ connectionId }) => connectionId).sort()).toEqual([
      'builtin:codex-cli',
      'openai:production',
    ]);
  });
});
