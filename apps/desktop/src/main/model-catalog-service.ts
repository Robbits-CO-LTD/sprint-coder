import {
  modelCatalogQueryInputSchema,
  providerModelSchema,
  type ModelCatalogQueryInput,
  type ProviderModel,
} from '@sprint-coder/contracts';

type IndexedModel = Readonly<{
  model: ProviderModel;
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

  replaceCatalog(models: readonly ProviderModel[]): void {
    const unique = new Map<string, ProviderModel>();
    for (const candidate of models) {
      const model = providerModelSchema.parse(candidate);
      unique.set(`${model.connectionId}\0${model.modelId}`, model);
    }
    const normalized = [...unique.values()].sort((left, right) =>
      `${left.connectionId}\0${left.modelId}`.localeCompare(
        `${right.connectionId}\0${right.modelId}`,
      ),
    );
    const fingerprint = JSON.stringify(normalized);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.indexed = normalized.map((model) => ({
      model,
      searchText: `${model.displayName}\0${model.modelId}\0${model.providerId}`.toLocaleLowerCase(),
    }));
    this.revisionValue += 1;
    this.indexBuildCountValue += 1;
  }

  query(input: ModelCatalogQueryInput): {
    revision: number;
    total: number;
    items: readonly ProviderModel[];
    nextCursor: string | null;
  } {
    const query = modelCatalogQueryInputSchema.parse(input);
    const text = query.text.trim().toLocaleLowerCase();
    const offset = query.cursor === null ? 0 : Number(query.cursor.slice('cursor:'.length));
    const filtered = this.indexed.filter(({ model, searchText }) => {
      if (query.availableOnly && !model.available) return false;
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
