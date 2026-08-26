import { describe, expect, it } from 'vitest';
import type {
  LocalHardwareSnapshot,
  ManagedLocalLaunchSettings,
  PublicModelCatalogDetail,
} from '@sprint-coder/contracts';
import {
  installPlan,
  managedLocalReusesLoadedModel,
  resolveManagedLocalLaunchSettings,
} from './managed-local-controller';
import type { VerifiedManagedLocalSidecarBundle } from './managed-local-sidecar-bundle';

const REVISION = 'b'.repeat(40);
const HASH = 'a'.repeat(64);

function bundle(): VerifiedManagedLocalSidecarBundle {
  return {
    target: 'darwin-arm64',
    rootPath: '/fixture/managed-local',
    manifest: {
      schemaVersion: 1,
      runtime: 'llama.cpp',
      runtimeVersion: 'b10516',
      upstreamRepository: 'https://github.com/ggml-org/llama.cpp',
      upstreamRevision: 'b'.repeat(40),
      platform: 'darwin',
      architecture: 'arm64',
      candidateBackends: ['cpu', 'metal'],
      artifacts: [],
    },
    manifestSha256: 'c'.repeat(64),
    serverPath: '/fixture/managed-local/bin/llama-server',
    licensePath: '/fixture/managed-local/licenses/LICENSE',
    artifactPaths: {},
  };
}

function hardware(backends: LocalHardwareSnapshot['backends']): LocalHardwareSnapshot {
  return { backends } as LocalHardwareSnapshot;
}

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
        role: 'model',
        multimodalCompatibilityKey: 'model',
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
          role: 'model',
          filename: 'weights/model-Q4_K_M.gguf',
          sizeBytes: 1_234,
          sha256: HASH,
          sourceUrl: `https://huggingface.co/acme/model/resolve/${REVISION}/weights/model-Q4_K_M.gguf`,
        },
      ],
    });
  });

  it('pins one compatible mmproj after the model even when selection order is reversed', () => {
    const projector = {
      id: 'artifact-mmproj',
      filename: 'mmproj-model-f16.gguf',
      format: 'gguf' as const,
      role: 'mmproj' as const,
      multimodalCompatibilityKey: 'model',
      quantization: 'F16',
      sizeBytes: 567,
      sha256: 'c'.repeat(64),
      sourceUrl: `https://huggingface.co/acme/model/blob/${REVISION}/mmproj-model-f16.gguf`,
      installability: { state: 'installable' as const, reason: 'Ready' },
    };
    const plan = installPlan(
      detail({ artifacts: [detail().artifacts[0]!, projector] }),
      ['artifact-mmproj', 'artifact-q4'],
      'Q4_K_M',
    );

    expect(plan.artifacts).toEqual([
      {
        role: 'model',
        filename: 'weights/model-Q4_K_M.gguf',
        sizeBytes: 1_234,
        sha256: HASH,
        sourceUrl: `https://huggingface.co/acme/model/resolve/${REVISION}/weights/model-Q4_K_M.gguf`,
      },
      {
        role: 'mmproj',
        filename: 'mmproj-model-f16.gguf',
        sizeBytes: 567,
        sha256: 'c'.repeat(64),
        sourceUrl: `https://huggingface.co/acme/model/resolve/${REVISION}/mmproj-model-f16.gguf`,
      },
    ]);
  });

  it('rejects an unclassified projector, a second projector, and a projector from another repo', () => {
    const projector = {
      id: 'artifact-mmproj',
      filename: 'mmproj-model-f16.gguf',
      format: 'gguf' as const,
      role: 'mmproj' as const,
      multimodalCompatibilityKey: 'model',
      quantization: 'F16',
      sizeBytes: 567,
      sha256: 'c'.repeat(64),
      sourceUrl: `https://huggingface.co/acme/model/blob/${REVISION}/mmproj-model-f16.gguf`,
      installability: { state: 'installable' as const, reason: 'Ready' },
    };
    expect(() =>
      installPlan(
        detail({
          artifacts: [{ ...projector, filename: 'vision-f16.gguf' }],
        }),
        ['artifact-mmproj'],
        'Q4_K_M',
      ),
    ).toThrow('not installable');
    expect(() =>
      installPlan(
        detail({
          artifacts: [detail().artifacts[0]!, projector, { ...projector, id: 'artifact-mmproj-2' }],
        }),
        ['artifact-q4', 'artifact-mmproj', 'artifact-mmproj-2'],
        'Q4_K_M',
      ),
    ).toThrow('Only one mmproj');
    expect(() =>
      installPlan(
        detail({
          artifacts: [
            detail().artifacts[0]!,
            {
              ...projector,
              sourceUrl: `https://huggingface.co/other/model/blob/${REVISION}/mmproj-model-f16.gguf`,
            },
          ],
        }),
        ['artifact-q4', 'artifact-mmproj'],
        'Q4_K_M',
      ),
    ).toThrow('identity changed');
    expect(() =>
      installPlan(
        detail({
          artifacts: [
            detail().artifacts[0]!,
            { ...projector, multimodalCompatibilityKey: 'different-family' },
          ],
        }),
        ['artifact-q4', 'artifact-mmproj'],
        'Q4_K_M',
      ),
    ).toThrow('not compatible');
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

describe('resolveManagedLocalLaunchSettings', () => {
  const configured: ManagedLocalLaunchSettings = {
    backend: 'auto',
    gpuLayers: 999,
    contextTokens: 8_192,
    batchSize: 512,
  };

  it('selects an available allowlisted accelerator for auto and keeps configured values', () => {
    expect(
      resolveManagedLocalLaunchSettings(
        configured,
        hardware([
          { kind: 'cpu', status: 'available' },
          { kind: 'metal', status: 'available' },
        ]),
        bundle(),
      ),
    ).toEqual({
      backend: 'metal',
      gpuLayers: 999,
      contextTokens: 8_192,
      batchSize: 512,
      runtimeVersion: 'b10516',
    });
  });

  it('falls back to zero GPU layers for auto CPU execution and rejects unavailable backends', () => {
    expect(
      resolveManagedLocalLaunchSettings(
        configured,
        hardware([{ kind: 'cpu', status: 'available' }]),
        bundle(),
      ),
    ).toMatchObject({ backend: 'cpu', gpuLayers: 0 });
    expect(
      resolveManagedLocalLaunchSettings(
        { ...configured, gpuLayers: 0 },
        hardware([
          { kind: 'cpu', status: 'available' },
          { kind: 'metal', status: 'available' },
        ]),
        bundle(),
      ),
    ).toMatchObject({ backend: 'cpu', gpuLayers: 0 });
    expect(
      resolveManagedLocalLaunchSettings(
        { ...configured, backend: 'metal' },
        hardware([{ kind: 'cpu', status: 'available' }]),
        bundle(),
      ),
    ).toBeNull();
  });
});

describe('managedLocalReusesLoadedModel', () => {
  const modelId = 'e'.repeat(64);

  it('skips another full artifact hash only for the already loaded model', () => {
    expect(managedLocalReusesLoadedModel({ state: 'running', modelId }, modelId)).toBe(true);
    expect(managedLocalReusesLoadedModel({ state: 'starting', modelId }, modelId)).toBe(true);
    expect(managedLocalReusesLoadedModel({ state: 'stopped', modelId: null }, modelId)).toBe(false);
    expect(
      managedLocalReusesLoadedModel({ state: 'running', modelId: 'f'.repeat(64) }, modelId),
    ).toBe(false);
  });
});
