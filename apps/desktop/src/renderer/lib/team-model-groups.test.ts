import { describe, expect, it } from 'vitest';
import type { ProviderModel, TeamModelIdentity } from '@sprint-coder/contracts';
import {
  filterTeamModelGroups,
  getTeamConnectionSelection,
  groupTeamModelsByConnection,
  setTeamConnectionSelected,
  setTeamModelSelected,
} from './team-model-groups';

const unknown = { value: null, source: 'unknown' as const };

function model(input: {
  connectionId: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  connectionDisplayName?: string;
}): ProviderModel {
  return {
    ...input,
    displayName: input.displayName ?? input.modelId,
    available: true,
    availabilityCheckedAt: '2026-08-02T00:00:00.000Z',
    contextWindow: unknown,
    maxOutputTokens: unknown,
    toolCalling: unknown,
    structuredOutput: unknown,
    multimodalInput: unknown,
    reasoning: unknown,
  };
}

describe('Team model Connection groups', () => {
  const models = [
    model({
      connectionId: 'builtin:codex-cli',
      connectionDisplayName: 'Codex CLI',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
    }),
    model({
      connectionId: 'builtin:codex-cli',
      connectionDisplayName: 'Codex CLI',
      providerId: 'openai',
      modelId: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
    }),
    model({
      connectionId: 'openai:production',
      connectionDisplayName: 'OpenAI Production',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
    }),
    model({
      connectionId: 'builtin:claude-cli',
      connectionDisplayName: 'Claude Code',
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8',
    }),
  ];

  it('separates CLI and API Connections even when they share one provider id', () => {
    const groups = groupTeamModelsByConnection(models, []);
    expect(groups.map(({ connectionId }) => connectionId).sort()).toEqual([
      'builtin:claude-cli',
      'builtin:codex-cli',
      'openai:production',
    ]);
    expect(groups.filter(({ providerId }) => providerId === 'openai')).toHaveLength(2);
  });

  it('keeps unavailable saved identities visible and removable', () => {
    const stale: TeamModelIdentity = {
      connectionId: 'anthropic:retired',
      providerId: 'anthropic',
      modelId: 'claude-retired',
    };
    const groups = groupTeamModelsByConnection(models, [stale]);
    const retired = groups.find(({ connectionId }) => connectionId === 'anthropic:retired');
    expect(retired?.choices).toEqual([
      { identity: stale, displayName: 'claude-retired', available: false },
    ]);
    expect(setTeamModelSelected([stale], stale, false)).toEqual([]);
  });

  it('searches Connection metadata and model metadata without merging groups', () => {
    const groups = groupTeamModelsByConnection(models, []);
    expect(
      filterTeamModelGroups(groups, 'production').map(({ connectionId }) => connectionId),
    ).toEqual(['openai:production']);
    expect(filterTeamModelGroups(groups, 'opus').map(({ connectionId }) => connectionId)).toEqual([
      'builtin:claude-cli',
    ]);
  });

  it('selects every available model in one Connection and clears stale values with that Connection', () => {
    const group = groupTeamModelsByConnection(models, []).find(
      ({ connectionId }) => connectionId === 'builtin:codex-cli',
    )!;
    const selected = setTeamConnectionSelected([], group, true);
    expect(selected).toEqual(group.choices.map(({ identity }) => identity));
    expect(setTeamConnectionSelected(selected, group, false)).toEqual([]);
  });

  it('reports unchecked, partial, and whole-Connection permission states', () => {
    const group = groupTeamModelsByConnection(models, []).find(
      ({ connectionId }) => connectionId === 'builtin:codex-cli',
    )!;
    expect(getTeamConnectionSelection(group, [])).toMatchObject({
      selectedCount: 0,
      allAvailableSelected: false,
      partiallySelected: false,
    });
    expect(getTeamConnectionSelection(group, [group.choices[0]!.identity])).toMatchObject({
      selectedCount: 1,
      allAvailableSelected: false,
      partiallySelected: true,
    });
    expect(
      getTeamConnectionSelection(
        group,
        group.choices.map(({ identity }) => identity),
      ),
    ).toMatchObject({
      selectedCount: 2,
      totalCount: 2,
      availableCount: 2,
      allAvailableSelected: true,
      partiallySelected: false,
    });
  });
});
