// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalHardwareSnapshot,
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

function installApi() {
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
  window.sprintCoder = {
    localAI: {
      hardware: vi.fn(async () => hardware),
      runtime: vi.fn(async () => runtime),
      listJobs: vi.fn(async () => []),
      listInstalled: vi.fn(async () => []),
      query: vi.fn(async () => ({ items: [detail.item], nextCursor: null, errors: [] })),
      detail: vi.fn(async () => detail),
      install,
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as NonNullable<Window['sprintCoder']>;
  return install;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('LocalAiSettingsSection', () => {
  it('shows truthful device and runtime facts', async () => {
    installApi();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<LocalAiSettingsSection active />));
    await flush();
    expect(container.textContent).toContain('Apple M4');
    expect(container.textContent).toContain('16.0 GB');
    expect(container.textContent).toContain('停止中');
    await act(async () => root.unmount());
  });

  it('requires an explicit license acknowledgement before starting an immutable install', async () => {
    const install = installApi();
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

  it('formats unknown and byte totals without overstating precision', () => {
    expect(formatLocalBytes(null)).toBe('不明');
    expect(formatLocalBytes(1_500_000_000)).toBe('1.5 GB');
  });
});
