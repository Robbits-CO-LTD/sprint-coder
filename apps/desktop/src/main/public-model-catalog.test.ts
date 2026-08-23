import { describe, expect, it, vi } from 'vitest';
import { PublicModelCatalogService, type PublicCatalogFetch } from './public-model-catalog';

const HASH = 'a'.repeat(64);
const REVISION = 'b'.repeat(40);

function hfModel(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    author: id.split('/')[0],
    gated: false,
    private: false,
    sha: REVISION,
    downloads: 10,
    tags: ['gguf', 'code', 'text-generation', 'license:apache-2.0'],
    pipeline_tag: 'text-generation',
    lastModified: '2026-08-20T00:00:00.000Z',
    ...extra,
  };
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
}

describe('PublicModelCatalogService', () => {
  it('keeps the Hugging Face Link cursor inside Main and binds the opaque cursor to the query', async () => {
    const seen: string[] = [];
    const fetch: PublicCatalogFetch = vi.fn(async (url) => {
      seen.push(url);
      if (url.includes('cursor=remote-secret'))
        return response([hfModel('acme/model-b')], { headers: { etag: '"p2"' } });
      return response([hfModel('acme/model-a')], {
        headers: {
          etag: '"p1"',
          link: '<https://huggingface.co/api/models?filter=gguf&limit=1&full=true&cursor=remote-secret>; rel="next"',
        },
      });
    });
    const service = new PublicModelCatalogService(
      fetch,
      () => 1_000,
      new Uint8Array(32).fill(7),
      () => 'cursor-one',
    );
    const query = {
      text: '',
      source: 'hugging_face' as const,
      purpose: 'code' as const,
      compatibility: 'compatible' as const,
      sort: 'downloads' as const,
      direction: 'descending' as const,
      cursor: null,
      limit: 1,
    };

    const first = await service.query(query);
    expect(first.items.map(({ sourceId }) => sourceId)).toEqual(['acme/model-a']);
    expect(first.nextCursor).toMatch(/^pc1\.cursor-one\./u);
    expect(first.nextCursor).not.toContain('remote-secret');

    const second = await service.query({ ...query, cursor: first.nextCursor });
    expect(second.items.map(({ sourceId }) => sourceId)).toEqual(['acme/model-b']);
    expect(seen[1]).toContain('cursor=remote-secret');

    const rebound = await service.query({ ...query, text: 'changed', cursor: first.nextCursor });
    expect(rebound.errors[0]?.code).toBe('invalid_cursor');
    expect(seen).toHaveLength(2);
  });

  it('rejects a next link that leaves the fixed Hugging Face endpoint', async () => {
    const service = new PublicModelCatalogService(async () =>
      response([hfModel('acme/model-a')], {
        headers: { link: '<https://attacker.invalid/steal?cursor=x>; rel="next"' },
      }),
    );

    const page = await service.query({
      text: '',
      source: 'hugging_face',
      purpose: 'code',
      compatibility: 'compatible',
      sort: 'downloads',
      direction: 'descending',
      cursor: null,
      limit: 10,
    });

    expect(page.items).toEqual([]);
    expect(page.errors[0]?.code).toBe('invalid_response');
  });

  it('uses ETag revalidation and serves bounded stale cache while offline', async () => {
    let now = 0;
    const fetch = vi
      .fn<PublicCatalogFetch>()
      .mockResolvedValueOnce(
        response([hfModel('acme/cached')], { headers: { etag: '"catalog-1"' } }),
      )
      .mockRejectedValueOnce(new TypeError('offline'));
    const service = new PublicModelCatalogService(fetch, () => now);
    const query = {
      text: '',
      source: 'hugging_face' as const,
      purpose: 'code' as const,
      compatibility: 'compatible' as const,
      sort: 'downloads' as const,
      direction: 'descending' as const,
      cursor: null,
      limit: 50,
    };

    expect((await service.query(query)).errors).toEqual([]);
    now = 5 * 60_000 + 1;
    const stale = await service.query(query);

    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('if-none-match')).toBe('"catalog-1"');
    expect(stale.items[0]?.sourceId).toBe('acme/cached');
    expect(stale.errors[0]?.code).toBe('offline');
  });

  it('reuses the cached body after an ETag 304 response', async () => {
    let now = 0;
    const fetch = vi
      .fn<PublicCatalogFetch>()
      .mockResolvedValueOnce(
        response([hfModel('acme/not-modified')], { headers: { etag: '"v1"' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const service = new PublicModelCatalogService(fetch, () => now);
    const query = {
      text: '',
      source: 'hugging_face' as const,
      purpose: 'code' as const,
      compatibility: 'compatible' as const,
      sort: 'downloads' as const,
      direction: 'descending' as const,
      cursor: null,
      limit: 50,
    };
    await service.query(query);
    now = 5 * 60_000 + 1;
    const page = await service.query(query);

    expect(page.items[0]?.sourceId).toBe('acme/not-modified');
    expect(page.errors).toEqual([]);
  });

  it('reports 429 without turning it into an empty successful search', async () => {
    const service = new PublicModelCatalogService(async () =>
      response('', { status: 429, headers: { 'retry-after': '60' } }),
    );
    const page = await service.query({
      text: '',
      source: 'hugging_face',
      purpose: 'all',
      compatibility: 'all',
      sort: 'name',
      direction: 'ascending',
      cursor: null,
      limit: 50,
    });
    expect(page.items).toEqual([]);
    expect(page.errors[0]).toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('normalizes Hugging Face detail without forwarding README or HTML', async () => {
    const fetch: PublicCatalogFetch = async () =>
      response(
        hfModel('acme/model', {
          cardData: {
            license: 'apache-2.0',
            description: '<b>Small model</b>\n```sh\nrm -rf /\n```',
          },
          config: { architectures: ['LlamaForCausalLM'], max_position_embeddings: 8192 },
          gguf: { total: 1_500_000_000 },
          siblings: [
            { rfilename: 'README.md' },
            { rfilename: 'model-Q4_K_M.gguf', lfs: { size: 1234, sha256: HASH } },
          ],
        }),
      );
    const detail = await new PublicModelCatalogService(fetch).detail({
      source: 'hugging_face',
      sourceId: 'acme/model',
    });

    expect(detail.description).toBe('Small model');
    expect(detail.description).not.toContain('rm -rf');
    expect(detail.item.immutableRevision).toBe(REVISION);
    expect(detail.item.installability.state).toBe('installable');
    expect(detail.artifacts[1]).toMatchObject({
      filename: 'model-Q4_K_M.gguf',
      sizeBytes: 1234,
      sha256: HASH,
      quantization: 'Q4_K_M',
      installability: { state: 'installable' },
    });
  });

  it('does not mark a Hugging Face artifact installable without an immutable revision', async () => {
    const service = new PublicModelCatalogService(async () =>
      response(
        hfModel('acme/mutable', {
          sha: null,
          siblings: [{ rfilename: 'model-Q4_K_M.gguf', lfs: { size: 1234, sha256: HASH } }],
        }),
      ),
    );
    const detail = await service.detail({
      source: 'hugging_face',
      sourceId: 'acme/mutable',
    });

    expect(detail.item.immutableRevision).toBeNull();
    expect(detail.item.installability.state).toBe('metadata_required');
    expect(detail.artifacts[0]?.installability.state).toBe('metadata_required');
  });

  it('reaches 1,000 LocalAI entries without duplicates and returns only one bounded page', async () => {
    const yaml = Array.from({ length: 1_000 }, (_, index) => {
      const name = `model-${String(index).padStart(4, '0')}`;
      return `- name: ${name}\n  license: apache-2.0\n  tags: [llm, gguf, code]\n  overrides:\n    backend: llama-cpp\n    parameters:\n      model: ${name}-Q4_K_M.gguf\n  files:\n    - filename: ${name}-Q4_K_M.gguf\n      uri: huggingface://acme/${name}/${name}-Q4_K_M.gguf\n      sha256: ${HASH}`;
    }).join('\n');
    const fetch = vi
      .fn<PublicCatalogFetch>()
      .mockResolvedValue(response(yaml, { headers: { etag: '"gallery"' } }));
    const service = new PublicModelCatalogService(fetch);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.query({
        text: '',
        source: 'localai_gallery',
        purpose: 'code',
        compatibility: 'compatible',
        sort: 'name',
        direction: 'ascending',
        cursor,
        limit: 50,
      });
      expect(page.items.length).toBeLessThanOrEqual(50);
      expect(page.errors).toEqual([]);
      ids.push(...page.items.map(({ sourceId }) => sourceId));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(ids).toHaveLength(1_000);
    expect(new Set(ids).size).toBe(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps unsupported gallery entries viewable but not installable', async () => {
    const yaml = `- name: unsupported-model
  license: unknown
  tags: [image]
  overrides:
    backend: diffusers
  files:
    - filename: model.safetensors
      uri: https://huggingface.co/acme/model/resolve/main/model.safetensors`;
    const service = new PublicModelCatalogService(async () => response(yaml));
    const page = await service.query({
      text: '',
      source: 'localai_gallery',
      purpose: 'all',
      compatibility: 'all',
      sort: 'name',
      direction: 'ascending',
      cursor: null,
      limit: 50,
    });

    expect(page.items[0]).toMatchObject({
      viewable: true,
      installability: { state: 'unsupported' },
    });
    const detail = await service.detail({
      source: 'localai_gallery',
      sourceId: 'unsupported-model',
    });
    expect(detail.artifacts[0]?.installability.state).toBe('unsupported');
  });

  it('continues an all-source query into the gallery without duplicates', async () => {
    const yaml = `- name: gallery-a
  tags: [llm, gguf, code]
  overrides: { backend: llama-cpp }
  files:
    - filename: gallery-a-Q4_K_M.gguf
      uri: huggingface://acme/gallery-a/gallery-a-Q4_K_M.gguf
      sha256: ${HASH}
- name: gallery-b
  tags: [llm, gguf, code]
  overrides: { backend: llama-cpp }
  files:
    - filename: gallery-b-Q4_K_M.gguf
      uri: huggingface://acme/gallery-b/gallery-b-Q4_K_M.gguf
      sha256: ${HASH}`;
    const service = new PublicModelCatalogService(async (url) =>
      url.includes('raw.githubusercontent.com') ? response(yaml) : response([hfModel('acme/hf')]),
    );
    const base = {
      text: '',
      source: 'all' as const,
      purpose: 'code' as const,
      compatibility: 'compatible' as const,
      sort: 'name' as const,
      direction: 'ascending' as const,
      limit: 2,
    };
    const first = await service.query({ ...base, cursor: null });
    const second = await service.query({ ...base, cursor: first.nextCursor });

    expect([...first.items, ...second.items].map(({ sourceId }) => sourceId)).toEqual([
      'acme/hf',
      'gallery-a',
      'gallery-b',
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects an oversized catalog response before parsing it', async () => {
    const service = new PublicModelCatalogService(async () =>
      response('[]', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }),
    );
    const page = await service.query({
      text: '',
      source: 'hugging_face',
      purpose: 'all',
      compatibility: 'all',
      sort: 'name',
      direction: 'ascending',
      cursor: null,
      limit: 50,
    });
    expect(page.errors[0]?.code).toBe('invalid_response');
  });
});
