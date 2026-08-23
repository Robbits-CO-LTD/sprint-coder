import { describe, expect, it } from 'vitest';
import { PublicModelCatalogService } from './public-model-catalog';

const live = process.env.RUN_PUBLIC_CATALOG_LIVE_SMOKE === '1' ? describe : describe.skip;

live('public model catalog live contract smoke', () => {
  it('reads a small public Hugging Face model fixture', async () => {
    const service = new PublicModelCatalogService(fetch);
    const page = await service.query({
      text: 'Qwen2.5-Coder-7B-Instruct-GGUF',
      source: 'hugging_face',
      purpose: 'code',
      compatibility: 'compatible',
      sort: 'downloads',
      direction: 'descending',
      cursor: null,
      limit: 2,
    });
    expect(page.errors).toEqual([]);
    const model = page.items.find(
      ({ sourceId }) => sourceId === 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    );
    expect(model?.immutableRevision).toMatch(/^[a-f0-9]{40}$/u);

    const detail = await service.detail({
      source: 'hugging_face',
      sourceId: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    });
    expect(
      detail.artifacts.some(({ installability }) => installability.state === 'installable'),
    ).toBe(true);
  }, 30_000);

  it('reads a known official LocalAI Gallery entry', async () => {
    const service = new PublicModelCatalogService(fetch);
    const page = await service.query({
      text: 'hy-mt2-1.8b-q4',
      source: 'localai_gallery',
      purpose: 'all',
      compatibility: 'all',
      sort: 'name',
      direction: 'ascending',
      cursor: null,
      limit: 2,
    });
    expect(page.errors).toEqual([]);
    expect(page.items.some(({ sourceId }) => sourceId === 'hy-mt2-1.8b-q4')).toBe(true);
  }, 30_000);
});
