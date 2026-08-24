import { describe, expect, it } from 'vitest';
import type { PublicModelCatalogDetail } from '@sprint-coder/contracts';
import { installPlan } from './managed-local-controller';

const REVISION = 'b'.repeat(40);
const HASH = 'a'.repeat(64);

function detail(overrides: Partial<PublicModelCatalogDetail> = {}): PublicModelCatalogDetail {
  return {
    item: {
      id: 'hugging_face:acme/model',
      source: 'hugging_face',
      sourceId: 'acme/model',
      name: 'acme/model',
      author: 'acme',
      sourceUrl: 'https://huggingface.co/acme/model',
      immutableRevision: REVISION,
      gated: false,
      private: false,
      viewable: true,
      installability: { state: 'installable', reason: 'Ready' },
      license: 'apache-2.0',
      purpose: 'code',
      tags: ['gguf', 'code'],
      downloads: 10,
      updatedAt: '2026-08-20T00:00:00.000Z',
    },
    description: 'Small code model',
    architecture: 'llama',
    parameterCount: 1_000_000_000,
    contextTokens: 8_192,
    toolTemplate: 'available',
    backend: 'llama.cpp',
    variants: ['Q4_K_M'],
    referenceUrls: [],
    artifacts: [
      {
        id: 'artifact-q4',
        filename: 'weights/model-Q4_K_M.gguf',
        format: 'gguf',
        quantization: 'Q4_K_M',
        sizeBytes: 1_234,
        sha256: HASH,
        sourceUrl: `https://huggingface.co/acme/model/blob/${REVISION}/weights/model-Q4_K_M.gguf`,
        installability: { state: 'installable', reason: 'Ready' },
      },
    ],
    ...overrides,
  };
}

describe('installPlan', () => {
  it('pins an installable GGUF to its immutable resolve URL, size, and digest', () => {
    expect(installPlan(detail(), ['artifact-q4'], 'Q4_K_M')).toEqual({
      source: 'hugging_face',
      sourceId: 'acme/model',
      immutableRevision: REVISION,
      quantization: 'Q4_K_M',
      artifacts: [
        {
          filename: 'weights/model-Q4_K_M.gguf',
          sizeBytes: 1_234,
          sha256: HASH,
          sourceUrl: `https://huggingface.co/acme/model/resolve/${REVISION}/weights/model-Q4_K_M.gguf`,
        },
      ],
    });
  });

  it('rejects mutable, browse-only, mismatched, and non-Hugging-Face artifacts', () => {
    expect(() =>
      installPlan(
        detail({ item: { ...detail().item, immutableRevision: null } }),
        ['artifact-q4'],
        'Q4_K_M',
      ),
    ).toThrow('Immutable Hugging Face revision is required');
    expect(() =>
      installPlan(
        detail({
          artifacts: [
            {
              ...detail().artifacts[0]!,
              installability: { state: 'metadata_required', reason: 'Missing SHA-256' },
            },
          ],
        }),
        ['artifact-q4'],
        'Q4_K_M',
      ),
    ).toThrow('not installable');
    expect(() => installPlan(detail(), ['artifact-q4'], 'Q5_K_M')).toThrow('not installable');
    expect(() =>
      installPlan(
        detail({ item: { ...detail().item, source: 'localai_gallery' } }),
        ['artifact-q4'],
        'Q4_K_M',
      ),
    ).toThrow('immutable resolution');
  });

  it('rejects a catalog artifact URL whose identity changed', () => {
    expect(() =>
      installPlan(
        detail({
          artifacts: [
            {
              ...detail().artifacts[0]!,
              sourceUrl: `https://huggingface.co/other/model/blob/${REVISION}/weights/model-Q4_K_M.gguf`,
            },
          ],
        }),
        ['artifact-q4'],
        'Q4_K_M',
      ),
    ).toThrow('identity changed');
  });
});
