import {
  modelCatalogQueryInputSchema,
  providerModelSchema,
  type ModelCatalogAccessType,
  type ModelCatalogQueryInput,
  type ProviderModel,
} from '@sprint-coder/contracts';

type IndexedModel = Readonly<{
  model: ProviderModel;
  accessType: ModelCatalogAccessType;
  searchText: string;
}>;

export class ModelCatalogService {
  private revisionValue = 0;
  private fingerprint = '';
  private indexed: readonly IndexedModel[] = [];
  private indexBuildCountValue = 0;

  get revision(): number {
    return this.revisionValue;
  }

  get indexBuildCount(): number {
    return this.indexBuildCountValue;
  }

  find(connectionId: string, modelId: string): ProviderModel | undefined {
    return this.indexed.find(
      ({ model }) => model.connectionId === connectionId && model.modelId === modelId,
    )?.model;
  }

  replaceCatalog(
    models: readonly ProviderModel[],
    accessTypesByConnection: ReadonlyMap<string, ModelCatalogAccessType> = new Map(),
  ): void {
    const unique = new Map<string, ProviderModel>();
    for (const candidate of models) {
      // ToolBroker accepts plain JSON only. Zod preserves explicitly-undefined optional fields,
      // so normalize provider results once when they enter the catalog.
      const model = providerModelSchema.parse(JSON.parse(JSON.stringify(candidate)) as unknown);
      unique.set(`${model.connectionId}\0${model.modelId}`, model);
    }
    const normalized = [...unique.values()].sort((left, right) =>
      `${left.connectionId}\0${left.modelId}`.localeCompare(
        `${right.connectionId}\0${right.modelId}`,
      ),
    );
    const normalizedWithAccess = normalized.map((model) => ({
      model,
      // Unknown connections retain the pre-Local-AI behavior. Only an explicit Main-owned
      // classification may promote a model into the local catalog.
      accessType: accessTypesByConnection.get(model.connectionId) ?? ('api' as const),
    }));
    const fingerprint = JSON.stringify(
      normalizedWithAccess.map(({ model, accessType }) => ({
        model: stableCatalogIdentity(model),
        accessType,
      })),
    );
    if (fingerprint === this.fingerprint) {
      const refreshed = new Map(
        normalized.map((model) => [`${model.connectionId}\0${model.modelId}`, model]),
      );
      this.indexed = this.indexed.map((entry) => ({
        ...entry,
        model: refreshed.get(`${entry.model.connectionId}\0${entry.model.modelId}`) ?? entry.model,
      }));
      return;
    }
    this.fingerprint = fingerprint;
    this.indexed = normalizedWithAccess.map(({ model, accessType }) => ({
      model,
      accessType,
      searchText:
        `${model.displayName}\0${model.modelId}\0${model.providerId}\0${model.providerDisplayName ?? ''}\0${modelAuthorSearchText(model.modelAuthor?.value)}\0${model.connectionDisplayName ?? ''}`.toLocaleLowerCase(),
    }));
    this.revisionValue += 1;
    this.indexBuildCountValue += 1;
  }

  query(
    input: ModelCatalogQueryInput,
    allowedModelKeys?: ReadonlySet<string>,
  ): {
    revision: number;
    total: number;
    items: readonly ProviderModel[];
    nextCursor: string | null;
  } {
    const query = modelCatalogQueryInputSchema.parse(input);
    const text = query.text.trim().toLocaleLowerCase();
    const offset = query.cursor === null ? 0 : Number(query.cursor.slice('cursor:'.length));
    const filtered = this.indexed.filter(({ model, accessType, searchText }) => {
      if (allowedModelKeys !== undefined && !allowedModelKeys.has(teamModelIdentityKey(model)))
        return false;
      if (query.availableOnly && !model.available) return false;
      if (query.accessTypes.length > 0 && !query.accessTypes.includes(accessType)) return false;
      if (query.connectionIds.length > 0 && !query.connectionIds.includes(model.connectionId))
        return false;
      if (query.providerIds.length > 0 && !query.providerIds.includes(model.providerId))
        return false;
      if (text !== '' && !searchText.includes(text)) return false;
      return query.capabilities.every((capability) => model[capability].value === true);
    });
    const items = filtered.slice(offset, offset + query.limit).map(({ model }) => model);
    const nextOffset = offset + items.length;
    return {
      revision: this.revisionValue,
      total: filtered.length,
      items,
      nextCursor: nextOffset < filtered.length ? `cursor:${nextOffset}` : null,
    };
  }
}

function modelAuthorSearchText(author: string | null | undefined): string {
  if (author === null || author === undefined) return '';
  const normalized = author.toLocaleLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    grok: 'xai x-ai',
    'x-ai': 'xai grok',
    xai: 'x-ai grok',
    'meta-llama': 'meta llama',
    mistralai: 'mistral',
    moonshot: 'kimi',
    moonshotai: 'kimi',
    zhipu: 'z-ai zai',
    zhipuai: 'z-ai zai',
  };
  return `${author}\0${aliases[normalized] ?? ''}`;
}

export function teamModelIdentityKey(model: {
  connectionId: string;
  providerId: string;
  modelId: string;
}): string {
  return `${model.connectionId}\0${model.providerId}\0${model.modelId}`;
}

function stableCatalogIdentity(model: ProviderModel): unknown {
  return JSON.parse(
    JSON.stringify(model, (key, value: unknown) =>
      key === 'availabilityCheckedAt' || key === 'observedAt' ? undefined : value,
    ),
  ) as unknown;
}
