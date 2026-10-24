import type {
  ModelCatalogQueryInput,
  ModelCatalogQueryResult,
  ProviderModel,
} from '@sprint-coder/contracts';

/** The largest page `modelCatalogQueryInputSchema` accepts. */
export const MODEL_CATALOG_PAGE_LIMIT = 100;
/** The most `connectionIds` one catalog query accepts. */
export const MODEL_CATALOG_CONNECTION_FILTER_MAX = 32;
/** Upper bound on pages read for one listing (5,000 models), so a runaway cursor cannot hang the UI. */
export const MODEL_CATALOG_MAX_PAGES = 50;
/** How many times a listing restarts from the first page when the catalog revision moves under it. */
const MODEL_CATALOG_MAX_ATTEMPTS = 3;

type CatalogPage = Pick<ModelCatalogQueryResult, 'revision' | 'items' | 'nextCursor'>;

/**
 * Reads every page of one catalog query, following `nextCursor` until Main reports no more rows.
 *
 * A cursor is an offset into one catalog revision. When the revision changes between pages the rows
 * collected so far may be shifted or stale, so the listing restarts from the first page instead of
 * splicing two revisions together; a catalog that keeps changing is reported as an error. A failed
 * page rejects the whole listing — a partial list would silently hide the models that live on the
 * pages that were not read, which is the very bug this exists to prevent.
 */
export async function queryAllModelCatalogPages(
  query: (input: ModelCatalogQueryInput) => Promise<CatalogPage>,
  input: Omit<ModelCatalogQueryInput, 'cursor' | 'limit'>,
): Promise<readonly ProviderModel[]> {
  for (let attempt = 0; attempt < MODEL_CATALOG_MAX_ATTEMPTS; attempt += 1) {
    const items: ProviderModel[] = [];
    let revision: number | null = null;
    let cursor: string | null = null;
    let pages = 0;
    let restarted = false;
    do {
      if (pages >= MODEL_CATALOG_MAX_PAGES)
        throw new Error('モデル一覧が多すぎるため、すべてを読み込めませんでした。');
      const page = await query({ ...input, cursor, limit: MODEL_CATALOG_PAGE_LIMIT });
      pages += 1;
      if (revision !== null && page.revision !== revision) {
        restarted = true;
        break;
      }
      revision = page.revision;
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (!restarted) return items;
  }
  throw new Error('モデル一覧が読み込み中に更新され続けたため、読み込めませんでした。');
}
