// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedLocalLaunchSettingsSetInput,
  ManagedLocalLaunchSettingsView,
  ManagedLocalRuntimeSnapshot,
} from '@sprint-coder/contracts';
import { ManagedLocalLaunchSettingsCard } from './ManagedLocalLaunchSettingsCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODEL_ID = 'a'.repeat(64);

const stoppedRuntime: ManagedLocalRuntimeSnapshot = {
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
  observedAt: '2026-08-26T00:00:00.000Z',
};

const activeRuntime: ManagedLocalRuntimeSnapshot = {
  ...stoppedRuntime,
  state: 'running',
  modelId: MODEL_ID,
  backend: 'metal',
  gpuLayers: 999,
  contextTokens: 8_192,
  batchSize: 512,
  activeLeaseCount: 1,
};

function view(input?: Partial<ManagedLocalLaunchSettingsView>): ManagedLocalLaunchSettingsView {
  return {
    modelId: MODEL_ID,
    configured: {
      backend: 'auto',
      gpuLayers: 999,
      contextTokens: 8_192,
      batchSize: 512,
    },
    effective: {
      backend: 'metal',
      gpuLayers: 999,
      contextTokens: 8_192,
      batchSize: 512,
      runtimeVersion: 'b10516',
    },
    ...input,
  };
}

afterEach(() => {
  delete window.sprintCoder;
  document.body.innerHTML = '';
});

function installApi(runtime = stoppedRuntime) {
  const launchSettings = vi.fn(async () => view());
  const setLaunchSettings = vi.fn(
    async (input: ManagedLocalLaunchSettingsSetInput): Promise<ManagedLocalLaunchSettingsView> =>
      view({
        configured: {
          backend: input.backend,
          gpuLayers: input.gpuLayers,
          contextTokens: input.contextTokens,
          batchSize: input.batchSize,
        },
        effective: {
          backend: input.backend === 'auto' ? 'metal' : input.backend,
          gpuLayers: input.backend === 'cpu' ? 0 : input.gpuLayers,
          contextTokens: input.contextTokens,
          batchSize: input.batchSize,
          runtimeVersion: 'b10516',
        },
      }),
  );
  window.sprintCoder = {
    localAI: {
      runtime: vi.fn(async () => runtime),
      launchSettings,
      setLaunchSettings,
    },
  } as unknown as NonNullable<Window['sprintCoder']>;
  return { launchSettings, setLaunchSettings };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ManagedLocalLaunchSettingsCard', () => {
  it('loads, edits, saves, and displays typed effective launch values', async () => {
    const api = installApi();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(<ManagedLocalLaunchSettingsCard modelId={MODEL_ID} runtime={stoppedRuntime} />),
    );
    await flush();

    const backend = container.querySelector(
      `[data-testid="local-ai-launch-backend-${MODEL_ID}"]`,
    ) as HTMLSelectElement;
    const gpu = container.querySelector(
      `[data-testid="local-ai-launch-gpu-${MODEL_ID}"]`,
    ) as HTMLInputElement;
    const context = container.querySelector(
      `[data-testid="local-ai-launch-context-${MODEL_ID}"]`,
    ) as HTMLInputElement;
    const batch = container.querySelector(
      `[data-testid="local-ai-launch-batch-${MODEL_ID}"]`,
    ) as HTMLInputElement;
    await act(async () => {
      backend.value = 'cpu';
      backend.dispatchEvent(new Event('change', { bubbles: true }));
      setInputValue(context, '4096');
      setInputValue(batch, '256');
    });
    const save = container.querySelector(
      `[data-testid="local-ai-launch-save-${MODEL_ID}"]`,
    ) as HTMLButtonElement;
    expect(gpu.value).toBe('0');
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await flush();

    expect(api.setLaunchSettings).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      backend: 'cpu',
      gpuLayers: 0,
      contextTokens: 4096,
      batchSize: 256,
    });
    expect(
      container.querySelector(`[data-testid="local-ai-launch-effective-${MODEL_ID}"]`)?.textContent,
    ).toContain('0');
    expect(
      container.querySelector(`[data-testid="local-ai-launch-effective-${MODEL_ID}"]`)?.textContent,
    ).toContain('b10516');
    await act(async () => root.unmount());
  });

  it('locks edits while this model is running and shows active effective values', async () => {
    installApi(activeRuntime);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(<ManagedLocalLaunchSettingsCard modelId={MODEL_ID} runtime={activeRuntime} />),
    );
    await flush();

    expect(
      (
        container.querySelector(
          `[data-testid="local-ai-launch-backend-${MODEL_ID}"]`,
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(true);
    expect(container.textContent).toContain('実行中のため変更できません');
    expect(container.textContent).toContain('現在の実効値');
    expect(
      container.querySelector(`[data-testid="local-ai-launch-effective-${MODEL_ID}"]`)?.textContent,
    ).toContain('999');
    await act(async () => root.unmount());
  });
});
