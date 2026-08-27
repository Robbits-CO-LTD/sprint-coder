import { useEffect, useState } from 'react';
import type {
  ManagedLocalEffectiveLaunchSettings,
  ManagedLocalLaunchBackend,
  ManagedLocalLaunchSettingsView,
  ManagedLocalRuntimeSnapshot,
} from '@sprint-coder/contracts';
import {
  MANAGED_LOCAL_MAX_BATCH_SIZE,
  MANAGED_LOCAL_MAX_CONTEXT_TOKENS,
  MANAGED_LOCAL_MAX_GPU_LAYERS,
} from '@sprint-coder/contracts';

type LocalAiApi = NonNullable<Window['sprintCoder']>['localAI'];

const ACTIVE_RUNTIME_STATES: readonly ManagedLocalRuntimeSnapshot['state'][] = [
  'starting',
  'running',
  'stopping',
];
const GPU_LAYERS_MAX = MANAGED_LOCAL_MAX_GPU_LAYERS;
const CONTEXT_TOKENS_MIN = 256;
const CONTEXT_TOKENS_MAX = MANAGED_LOCAL_MAX_CONTEXT_TOKENS;
const BATCH_SIZE_MAX = MANAGED_LOCAL_MAX_BATCH_SIZE;

function localAiApi(): LocalAiApi | null {
  if (typeof window === 'undefined') return null;
  const api = window.sprintCoder?.localAI;
  return typeof api?.launchSettings === 'function' ? api : null;
}

function loadedRuntimeForModel(
  runtime: ManagedLocalRuntimeSnapshot | null,
  modelId: string,
): boolean {
  return runtime?.modelId === modelId && ACTIVE_RUNTIME_STATES.includes(runtime.state);
}

function busyRuntimeForModel(
  runtime: ManagedLocalRuntimeSnapshot | null,
  modelId: string,
): boolean {
  return (
    runtime?.modelId === modelId &&
    (runtime.state !== 'running' || runtime.activeLeaseCount > 0) &&
    ACTIVE_RUNTIME_STATES.includes(runtime.state)
  );
}

function runtimeEffectiveSettings(
  runtime: ManagedLocalRuntimeSnapshot | null,
  modelId: string,
): ManagedLocalEffectiveLaunchSettings | null {
  if (runtime === null || !loadedRuntimeForModel(runtime, modelId)) return null;
  if (
    runtime.backend === null ||
    runtime.gpuLayers === null ||
    runtime.contextTokens === null ||
    runtime.batchSize === null ||
    runtime.runtimeVersion === null
  )
    return null;
  return {
    backend: runtime.backend,
    gpuLayers: runtime.gpuLayers,
    contextTokens: runtime.contextTokens,
    batchSize: runtime.batchSize,
    runtimeVersion: runtime.runtimeVersion,
  };
}

export function ManagedLocalLaunchSettingsCard({
  modelId,
  runtime,
}: {
  modelId: string;
  runtime: ManagedLocalRuntimeSnapshot | null;
}) {
  const [view, setView] = useState<ManagedLocalLaunchSettingsView | null>(null);
  const [backend, setBackend] = useState<ManagedLocalLaunchBackend>('auto');
  const [gpuLayers, setGpuLayers] = useState('');
  const [contextTokens, setContextTokens] = useState('');
  const [batchSize, setBatchSize] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let disposed = false;
    const api = localAiApi();
    if (api === null) {
      queueMicrotask(() => {
        if (disposed) return;
        setLoading(false);
        setError('この環境ではManaged Localの起動設定を確認できません。');
      });
      return () => {
        disposed = true;
      };
    }
    void api
      .launchSettings(modelId)
      .then((result) => {
        if (disposed) return;
        setView(result);
        setBackend(result.configured.backend);
        setGpuLayers(String(result.configured.gpuLayers));
        setContextTokens(String(result.configured.contextTokens));
        setBatchSize(String(result.configured.batchSize));
      })
      .catch(() => {
        if (!disposed) setError('Managed Localの起動設定を取得できませんでした。');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [modelId]);

  const loaded = loadedRuntimeForModel(runtime, modelId);
  const busy = busyRuntimeForModel(runtime, modelId);
  const activeEffective = runtimeEffectiveSettings(runtime, modelId);
  const effective = activeEffective ?? view?.effective ?? null;
  const dirty =
    view !== null &&
    (backend !== view.configured.backend ||
      gpuLayers !== String(view.configured.gpuLayers) ||
      contextTokens !== String(view.configured.contextTokens) ||
      batchSize !== String(view.configured.batchSize));

  async function save(): Promise<void> {
    const api = localAiApi();
    if (api === null || typeof api.setLaunchSettings !== 'function' || busy) return;
    const parsedGpuLayers = Number(gpuLayers);
    const parsedContextTokens = Number(contextTokens);
    const parsedBatchSize = Number(batchSize);
    if (
      !Number.isSafeInteger(parsedGpuLayers) ||
      parsedGpuLayers < 0 ||
      parsedGpuLayers > GPU_LAYERS_MAX ||
      !Number.isSafeInteger(parsedContextTokens) ||
      parsedContextTokens < CONTEXT_TOKENS_MIN ||
      parsedContextTokens > CONTEXT_TOKENS_MAX ||
      !Number.isSafeInteger(parsedBatchSize) ||
      parsedBatchSize < 1 ||
      parsedBatchSize > BATCH_SIZE_MAX ||
      (backend === 'cpu' && parsedGpuLayers !== 0) ||
      (backend !== 'auto' && backend !== 'cpu' && parsedGpuLayers === 0)
    ) {
      setError('GPU layers、context、batchは許可された整数範囲で指定してください。');
      return;
    }
    setSaving(true);
    setError(null);
    setStatus('');
    try {
      const result = await api.setLaunchSettings({
        modelId,
        backend,
        gpuLayers: parsedGpuLayers,
        contextTokens: parsedContextTokens,
        batchSize: parsedBatchSize,
      });
      setView(result);
      setBackend(result.configured.backend);
      setGpuLayers(String(result.configured.gpuLayers));
      setContextTokens(String(result.configured.contextTokens));
      setBatchSize(String(result.configured.batchSize));
      setStatus('起動設定を保存しました。');
    } catch {
      setError(
        'Managed Localの起動設定を保存できませんでした。実行中のモデルは停止後に変更してください。',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="local-ai-launch-card" data-testid={`local-ai-launch-${modelId}`}>
      <div className="local-ai-launch-heading">
        <strong>Managed Localの起動設定</strong>
        <small>このモデル専用</small>
      </div>
      {loading ? (
        <p className="settings-hint">起動設定を読み込んでいます。</p>
      ) : view === null ? null : (
        <>
          <div className="local-ai-launch-controls">
            <label className="settings-field" htmlFor={`local-ai-launch-backend-${modelId}`}>
              <span className="settings-field-label">Backend</span>
              <select
                id={`local-ai-launch-backend-${modelId}`}
                data-testid={`local-ai-launch-backend-${modelId}`}
                className="settings-text-input"
                value={backend}
                disabled={busy || saving}
                onChange={(event) => {
                  const next = event.target.value as ManagedLocalLaunchBackend;
                  setBackend(next);
                  if (next === 'cpu') setGpuLayers('0');
                }}
              >
                <option value="auto">自動（利用可能なbackend）</option>
                <option value="cpu">CPU</option>
                <option value="metal">Metal</option>
                <option value="cuda">CUDA</option>
                <option value="vulkan">Vulkan</option>
              </select>
            </label>
            <label className="settings-field" htmlFor={`local-ai-launch-gpu-${modelId}`}>
              <span className="settings-field-label">GPU layers</span>
              <input
                id={`local-ai-launch-gpu-${modelId}`}
                data-testid={`local-ai-launch-gpu-${modelId}`}
                className="settings-text-input"
                type="number"
                min={0}
                max={GPU_LAYERS_MAX}
                step={1}
                value={gpuLayers}
                disabled={busy || saving}
                onChange={(event) => setGpuLayers(event.target.value)}
              />
            </label>
            <label className="settings-field" htmlFor={`local-ai-launch-context-${modelId}`}>
              <span className="settings-field-label">Context tokens</span>
              <input
                id={`local-ai-launch-context-${modelId}`}
                data-testid={`local-ai-launch-context-${modelId}`}
                className="settings-text-input"
                type="number"
                min={CONTEXT_TOKENS_MIN}
                max={CONTEXT_TOKENS_MAX}
                step={1}
                value={contextTokens}
                disabled={busy || saving}
                onChange={(event) => setContextTokens(event.target.value)}
              />
            </label>
            <label className="settings-field" htmlFor={`local-ai-launch-batch-${modelId}`}>
              <span className="settings-field-label">Batch size</span>
              <input
                id={`local-ai-launch-batch-${modelId}`}
                data-testid={`local-ai-launch-batch-${modelId}`}
                className="settings-text-input"
                type="number"
                min={1}
                max={BATCH_SIZE_MAX}
                step={1}
                value={batchSize}
                disabled={busy || saving}
                onChange={(event) => setBatchSize(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="settings-secondary-button"
              data-testid={`local-ai-launch-save-${modelId}`}
              disabled={busy || saving || !dirty}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '起動設定を保存'}
            </button>
          </div>
          <p className="settings-hint" data-testid={`local-ai-launch-note-${modelId}`}>
            設定は次回のモデル起動時に反映します。任意のllama.cpp raw引数は受け付けません。
            {busy && ' このモデルは実行中のため変更できません。'}
            {loaded && !busy && ' 保存時に待機中のモデルを停止します。'}
          </p>
          <div
            className="local-ai-launch-effective"
            data-testid={`local-ai-launch-effective-${modelId}`}
          >
            <strong>{loaded ? '現在の実効値' : '次回起動時の実効値'}</strong>
            {effective === null ? (
              <p>この端末で利用可能なbackendを解決できません。</p>
            ) : (
              <dl>
                <div>
                  <dt>Backend</dt>
                  <dd>{effective.backend}</dd>
                </div>
                <div>
                  <dt>GPU layers</dt>
                  <dd>{effective.gpuLayers.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Context</dt>
                  <dd>{effective.contextTokens.toLocaleString()} tokens</dd>
                </div>
                <div>
                  <dt>Batch</dt>
                  <dd>{effective.batchSize.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>llama.cpp</dt>
                  <dd>{effective.runtimeVersion}</dd>
                </div>
              </dl>
            )}
          </div>
        </>
      )}
      {error !== null && (
        <p className="settings-provider-error" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </article>
  );
}
