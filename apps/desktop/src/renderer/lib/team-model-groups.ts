import type {
  ProviderModel,
  TeamModelIdentity,
  TeamModelRestriction,
} from '@sprint-coder/contracts';

export type TeamModelChoice = Readonly<{
  identity: TeamModelIdentity;
  displayName: string;
  available: boolean;
}>;

export type TeamModelConnectionGroup = Readonly<{
  connectionId: string;
  providerId: string;
  label: string;
  choices: readonly TeamModelChoice[];
}>;

export function teamModelKey(model: TeamModelIdentity): string {
  return `${model.connectionId}\0${model.providerId}\0${model.modelId}`;
}

export function providerModelIdentity(model: ProviderModel): TeamModelIdentity {
  return {
    connectionId: model.connectionId,
    providerId: model.providerId,
    modelId: model.modelId,
  };
}

export function sameModelRestriction(
  left: TeamModelRestriction | null,
  right: TeamModelRestriction | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.mode !== right.mode || left.allowedModels.length !== right.allowedModels.length)
    return false;
  const rightKeys = new Set(right.allowedModels.map(teamModelKey));
  return left.allowedModels.every((model) => rightKeys.has(teamModelKey(model)));
}

/**
 * Groups by Connection rather than provider id. Codex CLI and OpenAI API both use `openai`, while
 * Claude Code and Anthropic API both use `anthropic`; credentials and rate limits still make each
 * Connection an independent choice for Team hiring.
 */
export function groupTeamModelsByConnection(
  models: readonly ProviderModel[],
  allowedModels: readonly TeamModelIdentity[],
): readonly TeamModelConnectionGroup[] {
  const groups = new Map<
    string,
    {
      connectionId: string;
      providerId: string;
      label: string;
      choices: Map<string, TeamModelChoice>;
    }
  >();

  for (const model of models) {
    const identity = providerModelIdentity(model);
    const group = groups.get(model.connectionId) ?? {
      connectionId: model.connectionId,
      providerId: model.providerId,
      label: model.connectionDisplayName ?? model.connectionId,
      choices: new Map<string, TeamModelChoice>(),
    };
    group.choices.set(teamModelKey(identity), {
      identity,
      displayName: model.displayName,
      available: true,
    });
    groups.set(model.connectionId, group);
  }

  // A saved identity can disappear from the live catalog. Keep it visible so the user can see and
  // remove the stale restriction instead of carrying an invisible checked value forever.
  for (const identity of allowedModels) {
    const group = groups.get(identity.connectionId) ?? {
      connectionId: identity.connectionId,
      providerId: identity.providerId,
      label: identity.connectionId,
      choices: new Map<string, TeamModelChoice>(),
    };
    const key = teamModelKey(identity);
    if (!group.choices.has(key))
      group.choices.set(key, {
        identity,
        displayName: identity.modelId,
        available: false,
      });
    groups.set(identity.connectionId, group);
  }

  return [...groups.values()]
    .map((group) => ({
      connectionId: group.connectionId,
      providerId: group.providerId,
      label: group.label,
      choices: [...group.choices.values()].sort((left, right) => {
        if (left.available !== right.available) return left.available ? -1 : 1;
        return (
          left.displayName.localeCompare(right.displayName, 'ja') ||
          left.identity.modelId.localeCompare(right.identity.modelId)
        );
      }),
    }))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label, 'ja') ||
        left.connectionId.localeCompare(right.connectionId),
    );
}

export function filterTeamModelGroups(
  groups: readonly TeamModelConnectionGroup[],
  query: string,
): readonly TeamModelConnectionGroup[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === '') return groups;
  return groups.flatMap((group) => {
    const groupMatches = `${group.label} ${group.providerId} ${group.connectionId}`
      .toLocaleLowerCase()
      .includes(normalized);
    const choices = groupMatches
      ? group.choices
      : group.choices.filter((choice) =>
          `${choice.displayName} ${choice.identity.modelId} ${choice.identity.providerId}`
            .toLocaleLowerCase()
            .includes(normalized),
        );
    return choices.length === 0 ? [] : [{ ...group, choices }];
  });
}

export function setTeamModelSelected(
  allowedModels: readonly TeamModelIdentity[],
  identity: TeamModelIdentity,
  selected: boolean,
): TeamModelIdentity[] {
  const key = teamModelKey(identity);
  const next = allowedModels.filter((candidate) => teamModelKey(candidate) !== key);
  if (selected) next.push(identity);
  return next;
}

export function setTeamConnectionSelected(
  allowedModels: readonly TeamModelIdentity[],
  group: TeamModelConnectionGroup,
  selected: boolean,
): TeamModelIdentity[] {
  const next = allowedModels.filter((candidate) => candidate.connectionId !== group.connectionId);
  if (selected)
    next.push(
      ...group.choices.filter((choice) => choice.available).map((choice) => choice.identity),
    );
  return next;
}
