import { describe, expect, it } from 'vitest';
import type { ModelCatalogQueryInput } from '@sprint-coder/contracts';
import { MODEL_CATALOG_MAX_PAGES, queryAllModelCatalogPages } from './model-catalog-pages';

const base = {
  taskId: 'task-1',
  text: '',
  connectionIds: [],
  providerIds: [],
  accessTypes: [],
  capabilities: [],
  availableOnly: true,
} satisfies Omit<ModelCatalogQueryInput, 'cursor' | 'limit'>;

describe('queryAllModelCatalogPages', () => {
  it('stops with an error instead of following a cursor past the page bound', async () => {
    const cursors: (string | null)[] = [];
    const query = async (input: ModelCatalogQueryInput) => {
      cursors.push(input.cursor);
      return { revision: 1, items: [], nextCursor: `cursor:${cursors.length * 100}` };
    };

    await expect(queryAllModelCatalogPages(query, base)).rejects.toThrow(
      'モデル一覧が多すぎるため',
    );
    expect(cursors).toHaveLength(MODEL_CATALOG_MAX_PAGES);
  });

  it('gives up with an error when the revision keeps changing between pages', async () => {
    let revision = 0;
    let calls = 0;
    const query = async (input: ModelCatalogQueryInput) => {
      calls += 1;
      revision += 1;
      return { revision, items: [], nextCursor: input.cursor === null ? 'cursor:100' : null };
    };

    await expect(queryAllModelCatalogPages(query, base)).rejects.toThrow('更新され続けた');
    expect(calls).toBe(6);
  });
});
