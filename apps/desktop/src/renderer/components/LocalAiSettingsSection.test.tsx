// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InstalledLocalModel,
  LocalHardwareSnapshot,
  ManagedLocalInferenceSettingsView,
  ManagedLocalRuntimeSnapshot,
  PublicModelCatalogDetail,
} from '@sprint-coder/contracts';
import { LocalAiSettingsSection, formatLocalBytes } from './LocalAiSettingsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REVISION = 'b'.repeat(40);
const HASH = 'a'.repeat(64);

const hardware: LocalHardwareSnapshot = {
  version: 1,
  status: 'complete',
  observedAt: '2026-08-24T00:00:00.000Z',
  platform: 'darwin',
  architecture: 'arm64',
  memory: { totalBytes: 16_000_000_000, availableBytes: 8_000_000_000, topology: 'unified' },
  cpu: { model: 'Apple M4', logicalCores: 10, features: ['neon'], featuresStatus: 'known' },
  gpuDevicesStatus: 'known',
  gpus: [
    {
      id: 'gpu-0',
      active: true,
      vendorId: null,
      deviceId: null,
      vendorName: 'Apple',
      deviceName: 'Apple M4',
      memory: {
        dedicatedTotalBytes: null,
        dedicatedAvailableBytes: null,
        sharedTotalBytes: null,
        unifiedTotalBytes: 16_000_000_000,
      },
    },
  ],
  backends: [
    { kind: 'metal', status: 'available' },
    { kind: 'cpu', status: 'available' },
  ],
  unknownComponents: [],
};

const runtime: ManagedLocalRuntimeSnapshot = {
  state: 'stopped',
  target: 'darwin-arm64',
  runtimeVersion: 'b10516',
  modelId: null,
  backend: null,
  gpuLayers: null,
  contextTokens: null,
  batchSize: null,
  activeLeaseCount: 0,
  fit: null,
  failureCode: null,
  recovery: null,
  observedAt: '2026-08-24T00:00:00.000Z',
};

const detail: PublicModelCatalogDetail = {
  item: {
    id: 'hugging_face:acme/model',
    source: 'hugging_face',
    sourceId: 'acme/model',
    name: 'Acme Code 1B',
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
    downloads: 12,
    updatedAt: '2026-08-24T00:00:00.000Z',
  },
  description: 'A small code model',
  architecture: 'llama',
  parameterCount: 1_000_000_000,
  contextTokens: 8192,
  toolTemplate: 'available',
  backend: 'llama.cpp',
  variants: ['Q4_K_M'],
  referenceUrls: [],
  artifacts: [
    {
      id: 'artifact-q4',
      filename: 'model-Q4_K_M.gguf',
      format: 'gguf',
      role: 'model',
      quantization: 'Q4_K_M',
      sizeBytes: 1_234_000_000,
      sha256: HASH,
      sourceUrl: `https://huggingface.co/acme/model/blob/${REVISION}/model-Q4_K_M.gguf`,
      installability: { state: 'installable', reason: 'Ready' },
    },
  ],
};

afterEach(() => {
  delete window.sprintCoder;
  document.body.innerHTML = '';
});

function installApi(
  input: {
    installed?: readonly InstalledLocalModel[];
    catalogDetail?: PublicModelCatalogDetail;
    runtime?: ManagedLocalRuntimeSnapshot;
  } = {},
) {
  const catalogDetail = input.catalogDetail ?? detail;
  const install = vi.fn(async () => ({
    id: '11111111-1111-4111-8111-111111111111',
    modelId: HASH,
    state: 'queued' as const,
    artifactCount: 1,
    completedArtifacts: 0,
    downloadedBytes: 0,
    totalBytes: 1_234_000_000,
    failureCode: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  }));
  const inferenceSettings = vi.fn(
    async (modelId: string): Promise<ManagedLocalInferenceSettingsView> => ({
      modelId,
      configured: { maxOutputTokens: 512, thinking: false },
      effective: { maxOutputTokens: 512, thinking: false, reasoningEffort: 'none' },
      toolCall: { maxOutputTokens: 1_024, thinking: false, reasoningEffort: 'none' },
    }),
  );
  const setInferenceSettings = vi.fn(
    async (settings: {
      modelId: string;
      maxOutputTokens: number;
      thinking: boolean;
    }): Promise<ManagedLocalInferenceSettingsView> => ({
      modelId: settings.modelId,
      configured: {
        maxOutputTokens: settings.maxOutputTokens,
        thinking: settings.thinking,
      },
      effective: {
        maxOutputTokens: settings.maxOutputTokens,
        thinking: settings.thinking,
        reasoningEffort: settings.thinking ? null : 'none',
      },
      toolCall: { maxOutputTokens: 1_024, thinking: false, reasoningEffort: 'none' },
    }),
  );
  const fit = vi.fn(async () => ({
    state: 'unknown' as const,
    label: '未判定',
    detail: '実行条件を確認できませんでした。',
    breakdown: null,
    verification: null,
  }));
  window.sprintCoder = {
    localAI: {
      hardware: vi.fn(async () => hardware),
      runtime: vi.fn(async () => input.runtime ?? runtime),
      listJobs: vi.fn(async () => []),
      listInstalled: vi.fn(async () => input.installed ?? []),
      inferenceSettings,
      setInferenceSettings,
      query: vi.fn(async () => ({ items: [catalogDetail.item], nextCursor: null, errors: [] })),
      detail: vi.fn(async () => catalogDetail),
      fit,
      install,
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as NonNullable<Window['sprintCoder']>;
  return { install, inferenceSettings, setInferenceSettings, fit };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('LocalAiSettingsSection', () => {
  it('shows truthful device and runtime facts', async () => {
    installApi({
      runtime: {
        ...runtime,
        state: 'running',
        modelId: HASH,
        backend: 'metal',
        gpuLayers: 999,
        contextTokens: 8_192,
        batchSize: 512,
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<LocalAiSettingsSection active />));
    await flush();
    expect(container.textContent).toContain('Apple M4');
    expect(container.textContent).toContain('16.0 GB');
    expect(container.textContent).toContain('実行中');
    expect(container.textContent).toContain('GPU layers999');
    expect(container.textContent).toContain('Context8,192 tokens');
    expect(container.textContent).toContain('Batch512');
    await act(async () => root.unmount());
  });

  it('requires an explicit license acknowledgement before starting an immutable install', async () => {
    const { install } = installApi();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<LocalAiSettingsSection active />));
    await flush();
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Local AI Selector',
    )!;
    await act(async () => button.click());
    const search = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === '検索',
    )!;
    await act(async () => search.click());
    await flush();
    const model = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Acme Code 1B'),
    )!;
    await act(async () => model.click());
    await flush();
    const artifact = container.querySelector('input[type="radio"]') as HTMLInputElement;
    await act(async () => artifact.click());
    const choose = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'このGGUFを導入',
    )!;
    await act(async () => choose.click());
    const start = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'ダウンロード開始',
    ) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    const checkbox = [...container.querySelectorAll('input[type="checkbox"]')].at(
      -1,
    ) as HTMLInputElement;
    await act(async () => checkbox.click());
    expect(start.disabled).toBe(false);
    await act(async () => start.click());
    await flush();
    expect(install).toHaveBeenCalledWith({
      source: 'hugging_face',
      sourceId: 'acme/model',
      artifactIds: ['artifact-q4'],
      quantization: 'Q4_K_M',
      confirmed: true,
    });
    await act(async () => root.unmount());
  });

  it('lets an image model install one verified mmproj with the selected model GGUF', async () => {
    const projectorHash = 'c'.repeat(64);
    const imageDetail: PublicModelCatalogDetail = {
      ...detail,
      artifacts: [
        { ...detail.artifacts[0]!, multimodalCompatibilityKey: 'model' },
        {
          id: 'artifact-mmproj',
          filename: 'mmproj-model-f16.gguf',
          format: 'gguf',
          role: 'mmproj',
          multimodalCompatibilityKey: 'model',
          quantization: null,
          sizeBytes: 234_000_000,
          sha256: projectorHash,
          sourceUrl: `https://huggingface.co/acme/model/blob/${REVISION}/mmproj-model-f16.gguf`,
          installability: { state: 'installable', reason: 'Ready' },
        },
        {
          id: 'artifact-mmproj-other',
          filename: 'mmproj-other-family-f16.gguf',
          format: 'gguf',
          role: 'mmproj',
          multimodalCompatibilityKey: 'other-family',
          quantization: null,
          sizeBytes: 100_000_000,
          sha256: 'd'.repeat(64),
          sourceUrl: `https://huggingface.co/acme/model/blob/${REVISION}/mmproj-other-family-f16.gguf`,
          installability: { state: 'installable', reason: 'Ready' },
        },
      ],
    };
    const { install, fit } = installApi({ catalogDetail: imageDetail });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<LocalAiSettingsSection active />));
    await flush();
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((item) => item.textContent === 'Local AI Selector')!
        .click(),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((item) => item.textContent === '検索')!
        .click(),
    );
    await flush();
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((item) => item.textContent?.includes('Acme Code 1B'))!
        .click(),
    );
    await flush();
    await act(async () =>
      (container.querySelector('input[name="local-ai-artifact"]') as HTMLInputElement).click(),
    );
    expect(container.textContent).not.toContain('mmproj-other-family-f16.gguf');
    await act(async () =>
      (container.querySelectorAll('input[name="local-ai-mmproj"]')[1] as HTMLInputElement).click(),
    );
    await flush();
    expect(fit).toHaveBeenLastCalledWith({
      source: 'hugging_face',
      sourceId: 'acme/model',
      artifactId: 'artifact-q4',
      mmprojArtifactId: 'artifact-mmproj',
      contextTokens: 8_192,
    });
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((item) => item.textContent === 'このGGUFを導入')!
        .click(),
    );
    await act(async () =>
      (
        container.querySelector(
          '.local-ai-install-confirm input[type="checkbox"]',
        ) as HTMLInputElement
      ).click(),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((item) => item.textContent === 'ダウンロード開始')!
        .click(),
    );
    await flush();
    expect(install).toHaveBeenCalledWith({
      source: 'hugging_face',
      sourceId: 'acme/model',
      artifactIds: ['artifact-q4', 'artifact-mmproj'],
      quantization: 'Q4_K_M',
      confirmed: true,
    });
    await act(async () => root.unmount());
  });

  it('formats unknown and byte totals without overstating precision', () => {
    expect(formatLocalBytes(null)).toBe('不明');
    expect(formatLocalBytes(1_500_000_000)).toBe('1.5 GB');
  });

  it('edits a model-specific request setting and shows the effective Managed Local fields', async () => {
    const model: InstalledLocalModel = {
      id: HASH,
      source: 'hugging_face',
      sourceId: 'acme/model',
      immutableRevision: REVISION,
      quantization: 'Q4_K_M',
      artifactCount: 1,
      totalBytes: 1_234_000_000,
      state: 'installed',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    const api = installApi({ installed: [model] });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<LocalAiSettingsSection active />));
    await flush();
    const maxTokens = container.querySelector(
      `[data-testid="local-ai-max-output-${HASH}"]`,
    ) as HTMLInputElement;
    expect(maxTokens.value).toBe('512');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        maxTokens,
        '4096',
      );
      maxTokens.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const thinking = container.querySelector(
      `[data-testid="local-ai-thinking-${HASH}"]`,
    ) as HTMLInputElement;
    await act(async () => thinking.click());
    const save = container.querySelector(
      `[data-testid="local-ai-inference-save-${HASH}"]`,
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await flush();
    expect(api.setInferenceSettings).toHaveBeenCalledWith({
      modelId: HASH,
      maxOutputTokens: 4_096,
      thinking: true,
    });
    expect(
      container.querySelector(`[data-testid="local-ai-effective-${HASH}"]`)?.textContent,
    ).toContain('4,096');
    expect(container.textContent).toContain('Reasoning effortはManaged Localには適用されません');
    await act(async () => root.unmount());
  });
});
