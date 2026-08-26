import { useEffect, useRef, useState } from 'react';
import { MANAGED_LOCAL_MAX_OUTPUT_TOKENS } from '@sprint-coder/contracts';
import type {
  InstalledLocalModel,
  LocalDownloadJob,
  LocalHardwareSnapshot,
  LocalFitAssessment,
  ManagedLocalInferenceSettingsView,
  ManagedLocalRuntimeSnapshot,
  PublicModelArtifact,
  PublicModelCatalogDetail,
  PublicModelCatalogItem,
  PublicModelCatalogPage,
  PublicModelCatalogQuery,
} from '@sprint-coder/contracts';
import { ArrowLeft, Pause, Play, Search, Trash } from './icons';

type LocalAiApi = NonNullable<Window['sprintCoder']>['localAI'];
const ROW_HEIGHT = 58;
const VIEWPORT_HEIGHT = 348;
const OVERSCAN = 3;

function localAiApi(): LocalAiApi | null {
  if (typeof window === 'undefined') return null;
  const api = window.sprintCoder?.localAI;
  return typeof api?.hardware === 'function' ? api : null;
}

export function formatLocalBytes(value: number | null): string {
  if (value === null) return '不明';
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${(value / 1_000_000_000).toFixed(1)} GB`;
}

export function LocalAiSettingsSection({ active }: { active: boolean }) {
  const [hardware, setHardware] = useState<LocalHardwareSnapshot | null>(null);
  const [runtime, setRuntime] = useState<ManagedLocalRuntimeSnapshot | null>(null);
  const [jobs, setJobs] = useState<readonly LocalDownloadJob[]>([]);
  const [installed, setInstalled] = useState<readonly InstalledLocalModel[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [fitByModel, setFitByModel] = useState<Record<string, LocalFitAssessment>>({});
  const mounted = useRef(true);

  async function refresh(includeHardware = false): Promise<void> {
    const api = localAiApi();
    if (api === null) {
      setSupported(false);
      return;
    }
    const requests: Promise<unknown>[] = [api.runtime(), api.listJobs(), api.listInstalled()];
    if (includeHardware) requests.push(api.hardware());
    const values = await Promise.all(requests);
    if (!mounted.current) return;
    setRuntime(values[0] as ManagedLocalRuntimeSnapshot);
    setJobs(values[1] as readonly LocalDownloadJob[]);
    setInstalled(values[2] as readonly InstalledLocalModel[]);
    if (includeHardware) setHardware(values[3] as LocalHardwareSnapshot);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || !supported) return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      void refresh(true)
        .catch(() => !disposed && setError('Local AIの状態を取得できませんでした。'))
        .finally(() => !disposed && setLoading(false));
    });
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active, supported]);

  async function mutate(action: () => Promise<unknown>, message: string): Promise<void> {
    setError(null);
    try {
      await action();
      await refresh();
      setStatus(message);
    } catch {
      setError('操作を完了できませんでした。状態を再読み込みしてから再試行してください。');
    }
  }

  async function verifyModel(modelId: string): Promise<void> {
    setVerifyingId(modelId);
    setError(null);
    try {
      const fit = await localAiApi()!.verify(modelId);
      setFitByModel((current) => ({ ...current, [modelId]: fit }));
      await refresh();
      setStatus(`${fit.label}。`);
    } catch {
      setError('動作確認を完了できませんでした。モデルは削除されていません。再試行できます。');
    } finally {
      setVerifyingId(null);
    }
  }

  return (
    <section className="settings-local-ai" aria-labelledby="settings-local-ai-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="settings-local-ai-title">このPCのLocal AI</h3>
          <p>モデルはこの端末へ保存され、Managed Local runtimeが端末内で推論します。</p>
        </div>
        <button
          type="button"
          className="settings-primary-button"
          onClick={() => setSelectorOpen((value) => !value)}
          aria-expanded={selectorOpen}
          aria-controls="local-ai-selector"
          disabled={!supported}
        >
          {selectorOpen ? 'Selectorを閉じる' : 'Local AI Selector'}
        </button>
      </div>

      {!supported ? (
        <p className="settings-hint">この環境ではManaged Local AI APIを利用できません。</p>
      ) : selectorOpen ? (
        <LocalAiSelector
          onInstalled={async () => {
            await refresh();
            setStatus('モデルのダウンロードを開始しました。');
          }}
        />
      ) : (
        <>
          <div className="local-ai-facts" aria-busy={loading}>
            <HardwareCard hardware={hardware} />
            <RuntimeCard runtime={runtime} />
          </div>
          <LocalDownloadList
            jobs={jobs}
            onPause={(id) =>
              void mutate(() => localAiApi()!.pause(id), 'ダウンロードを一時停止しました。')
            }
            onResume={(id) =>
              void mutate(() => localAiApi()!.resume(id), 'ダウンロードを再開しました。')
            }
            onCancel={(id) =>
              void mutate(() => localAiApi()!.cancel(id, true), 'ダウンロードを中止しました。')
            }
          />
          <InstalledModelList
            models={installed}
            verifyingId={verifyingId}
            fitByModel={fitByModel}
            onVerify={(id) => void verifyModel(id)}
            onDelete={(id) =>
              void mutate(() => localAiApi()!.delete(id), '端末からモデルを削除しました。')
            }
          />
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
    </section>
  );
}

function HardwareCard({ hardware }: { hardware: LocalHardwareSnapshot | null }) {
  const gpu = hardware?.gpus[0];
  return (
    <article className="local-ai-fact-card">
      <span className="settings-list-label">端末能力</span>
      <strong>{hardware?.cpu.model ?? 'CPUを確認中'}</strong>
      <dl>
        <div>
          <dt>CPU</dt>
          <dd>{hardware?.cpu.logicalCores ?? '不明'} logical cores</dd>
        </div>
        <div>
          <dt>RAM</dt>
          <dd>{formatLocalBytes(hardware?.memory.totalBytes ?? null)}</dd>
        </div>
        <div>
          <dt>GPU</dt>
          <dd>{gpu?.deviceName ?? (hardware?.gpuDevicesStatus === 'known' ? '未検出' : '不明')}</dd>
        </div>
        <div>
          <dt>Backend</dt>
          <dd>
            {hardware?.backends
              .filter(({ status }) => status === 'available')
              .map(({ kind }) => kind)
              .join(' / ') || '不明'}
          </dd>
        </div>
      </dl>
      {hardware?.status !== 'complete' && (
        <small>取得できない情報は「不明」と表示しています。</small>
      )}
    </article>
  );
}

function RuntimeCard({ runtime }: { runtime: ManagedLocalRuntimeSnapshot | null }) {
  return (
    <article className="local-ai-fact-card">
      <span className="settings-list-label">Managed runtime</span>
      <strong>{runtime === null ? '確認中' : runtimeStateLabel(runtime.state)}</strong>
      <dl>
        <div>
          <dt>Version</dt>
          <dd>{runtime?.runtimeVersion ?? '不明'}</dd>
        </div>
        <div>
          <dt>Backend</dt>
          <dd>{runtime?.backend ?? '未選択'}</dd>
        </div>
        <div>
          <dt>使用中</dt>
          <dd>{runtime?.activeLeaseCount ?? 0} task</dd>
        </div>
      </dl>
      {runtime?.recovery !== null && runtime?.recovery !== undefined && (
        <small>{runtime.recovery.detail}</small>
      )}
    </article>
  );
}

function runtimeStateLabel(state: ManagedLocalRuntimeSnapshot['state']): string {
  return {
    unavailable: '利用不可',
    stopped: '停止中',
    starting: '起動中',
    running: '実行中',
    stopping: '停止処理中',
    crashed: '異常終了',
  }[state];
}

function LocalDownloadList({
  jobs,
  onPause,
  onResume,
  onCancel,
}: {
  jobs: readonly LocalDownloadJob[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const active = jobs.filter(({ state }) => state !== 'installed' && state !== 'canceled');
  if (active.length === 0) return null;
  return (
    <section className="local-ai-subsection" aria-labelledby="local-ai-downloads-title">
      <h4 id="local-ai-downloads-title">ダウンロード</h4>
      <ul className="local-ai-download-list">
        {active.map((job) => {
          const percent =
            job.totalBytes === 0 ? 0 : Math.round((job.downloadedBytes / job.totalBytes) * 100);
          return (
            <li key={job.id}>
              <div>
                <strong>{job.sourceId ?? job.modelId.slice(0, 12)}</strong>
                <span>
                  {job.state} · {percent}%
                </span>
              </div>
              <progress
                value={job.downloadedBytes}
                max={Math.max(job.totalBytes, 1)}
                aria-label={`${job.modelId}のダウンロード進捗`}
              />
              <div className="local-ai-row-actions">
                {job.state === 'downloading' && (
                  <button
                    type="button"
                    className="settings-secondary-button"
                    onClick={() => onPause(job.id)}
                  >
                    <Pause size={13} />
                    一時停止
                  </button>
                )}
                {['paused', 'interrupted', 'failed'].includes(job.state) && (
                  <button
                    type="button"
                    className="settings-secondary-button"
                    onClick={() => onResume(job.id)}
                  >
                    <Play size={13} />
                    再開
                  </button>
                )}
                {confirming === job.id ? (
                  <>
                    <span>中止しますか？</span>
                    <button
                      type="button"
                      className="settings-danger-button"
                      onClick={() => {
                        setConfirming(null);
                        onCancel(job.id);
                      }}
                    >
                      中止する
                    </button>
                    <button
                      type="button"
                      className="settings-secondary-button"
                      onClick={() => setConfirming(null)}
                    >
                      戻る
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="settings-secondary-button"
                    onClick={() => setConfirming(job.id)}
                  >
                    中止
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function InstalledModelList({
  models,
  verifyingId,
  fitByModel,
  onVerify,
  onDelete,
}: {
  models: readonly InstalledLocalModel[];
  verifyingId: string | null;
  fitByModel: Readonly<Record<string, LocalFitAssessment>>;
  onVerify: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <section className="local-ai-subsection" aria-labelledby="local-ai-installed-title">
      <div className="local-ai-subsection-heading">
        <h4 id="local-ai-installed-title">インストール済み</h4>
        <span className="settings-count-badge">{models.length}件</span>
      </div>
      {models.length === 0 ? (
        <p className="settings-hint">この端末にインストールされたモデルはありません。</p>
      ) : (
        <ul className="local-ai-installed-list">
          {models.map((model) => (
            <li key={model.id}>
              <div>
                <strong>{model.sourceId}</strong>
                <small>
                  {model.quantization} · {formatLocalBytes(model.totalBytes)}
                </small>
                {fitByModel[model.id] !== undefined && <small>{fitByModel[model.id]!.label}</small>}
              </div>
              <div className="local-ai-row-actions">
                <button
                  type="button"
                  className="settings-secondary-button"
                  disabled={verifyingId !== null}
                  onClick={() => onVerify(model.id)}
                >
                  {verifyingId === model.id ? '確認中…' : '動作確認'}
                </button>
                {confirming === model.id ? (
                  <>
                    <span>端末から削除しますか？</span>
                    <button
                      type="button"
                      className="settings-danger-button"
                      onClick={() => {
                        setConfirming(null);
                        onDelete(model.id);
                      }}
                    >
                      <Trash size={13} />
                      削除
                    </button>
                    <button
                      type="button"
                      className="settings-secondary-button"
                      onClick={() => setConfirming(null)}
                    >
                      戻る
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="settings-secondary-button"
                    onClick={() => setConfirming(model.id)}
                  >
                    <Trash size={13} />
                    削除
                  </button>
                )}
              </div>
              {model.state === 'installed' && model.artifactCount === 1 && (
                <ManagedLocalInferenceSettingsCard modelId={model.id} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ManagedLocalInferenceSettingsCard({ modelId }: { modelId: string }) {
  const [view, setView] = useState<ManagedLocalInferenceSettingsView | null>(null);
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const api = localAiApi();
    if (api === null || typeof api.inferenceSettings !== 'function') {
      queueMicrotask(() => {
        if (disposed) return;
        setLoading(false);
        setError('この環境ではManaged Localの推論設定を確認できません。');
      });
      return () => {
        disposed = true;
      };
    }
    queueMicrotask(() => {
      if (disposed) return;
      setLoading(true);
      setError(null);
    });
    void api
      .inferenceSettings(modelId)
      .then((result) => {
        if (disposed) return;
        setView(result);
        setMaxOutputTokens(String(result.configured.maxOutputTokens));
        setThinking(result.configured.thinking);
      })
      .catch(() => {
        if (!disposed) setError('Managed Localの推論設定を取得できませんでした。');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [modelId]);

  async function save(): Promise<void> {
    const api = localAiApi();
    if (api === null || typeof api.setInferenceSettings !== 'function') return;
    const parsed = Number(maxOutputTokens);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MANAGED_LOCAL_MAX_OUTPUT_TOKENS) {
      setError(
        `最大出力トークンは1〜${MANAGED_LOCAL_MAX_OUTPUT_TOKENS.toLocaleString()}の整数で指定してください。`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.setInferenceSettings({
        modelId,
        maxOutputTokens: parsed,
        thinking,
      });
      setView(result);
      setMaxOutputTokens(String(result.configured.maxOutputTokens));
      setThinking(result.configured.thinking);
    } catch {
      setError('Managed Localの推論設定を保存できませんでした。変更内容を確認してください。');
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    view !== null &&
    (maxOutputTokens !== String(view.configured.maxOutputTokens) ||
      thinking !== view.configured.thinking);

  return (
    <article className="local-ai-inference-card" data-testid={`local-ai-inference-${modelId}`}>
      <div className="local-ai-inference-heading">
        <strong>Managed Localの推論設定</strong>
        <small>このモデル専用</small>
      </div>
      {loading ? (
        <p className="settings-hint">推論設定を読み込んでいます。</p>
      ) : view === null ? null : (
        <>
          <div className="local-ai-inference-controls">
            <label className="settings-field" htmlFor={`local-ai-max-output-${modelId}`}>
              <span className="settings-field-label">最大出力トークン</span>
              <input
                id={`local-ai-max-output-${modelId}`}
                data-testid={`local-ai-max-output-${modelId}`}
                className="settings-text-input"
                type="number"
                min={1}
                max={MANAGED_LOCAL_MAX_OUTPUT_TOKENS}
                step={1}
                value={maxOutputTokens}
                onChange={(event) => setMaxOutputTokens(event.target.value)}
              />
            </label>
            <label className="local-ai-checkbox">
              <input
                type="checkbox"
                data-testid={`local-ai-thinking-${modelId}`}
                checked={thinking}
                onChange={(event) => setThinking(event.target.checked)}
              />
              Thinking（思考）を有効にする
            </label>
            <button
              type="button"
              className="settings-secondary-button"
              data-testid={`local-ai-inference-save-${modelId}`}
              disabled={saving || !dirty}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '推論設定を保存'}
            </button>
          </div>
          <p className="settings-hint" data-testid={`local-ai-effort-note-${modelId}`}>
            CLIのReasoning effortはManaged Localには適用されません。Thinkingはllama.cppの
            <code>chat_template_kwargs.enable_thinking</code>へ反映します。
          </p>
          <div
            className="local-ai-effective-settings"
            data-testid={`local-ai-effective-${modelId}`}
          >
            <strong>次回リクエストの実効値</strong>
            <dl>
              <div>
                <dt>max_tokens</dt>
                <dd>{view.effective.maxOutputTokens.toLocaleString()}</dd>
              </div>
              <div>
                <dt>enable_thinking</dt>
                <dd>{view.effective.thinking ? 'true' : 'false'}</dd>
              </div>
              <div>
                <dt>reasoning_effort</dt>
                <dd>{view.effective.reasoningEffort ?? '送信しない'}</dd>
              </div>
              <div>
                <dt>ツール呼出時</dt>
                <dd>max_tokens {view.toolCall.maxOutputTokens.toLocaleString()} · Thinking off</dd>
              </div>
            </dl>
          </div>
        </>
      )}
      {error !== null && (
        <p className="settings-provider-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

function LocalAiSelector({ onInstalled }: { onInstalled: () => Promise<void> }) {
  const [query, setQuery] = useState<PublicModelCatalogQuery>({
    text: '',
    source: 'all',
    purpose: 'code',
    compatibility: 'compatible',
    sort: 'downloads',
    direction: 'descending',
    cursor: null,
    limit: 50,
  });
  const [page, setPage] = useState<PublicModelCatalogPage | null>(null);
  const [selected, setSelected] = useState<PublicModelCatalogItem | null>(null);
  const [detail, setDetail] = useState<PublicModelCatalogDetail | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<PublicModelArtifact | null>(null);
  const [selectedFit, setSelectedFit] = useState<LocalFitAssessment | null>(null);
  const [fitLoading, setFitLoading] = useState(false);
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  async function search(cursor: string | null = null): Promise<void> {
    const api = localAiApi();
    if (api === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.query({ ...query, cursor });
      setPage(result);
      setQuery((current) => ({ ...current, cursor }));
      if (cursor === null) {
        setScrollTop(0);
        listRef.current?.scrollTo({ top: 0 });
      }
    } catch {
      setError('公開モデルを検索できませんでした。接続を確認して再試行してください。');
    } finally {
      setBusy(false);
    }
  }

  async function select(item: PublicModelCatalogItem): Promise<void> {
    const api = localAiApi();
    if (api === null) return;
    setSelected(item);
    setDetail(null);
    setSelectedArtifact(null);
    setSelectedFit(null);
    setLicenseAccepted(false);
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const value = await api.detail({ source: item.source, sourceId: item.sourceId });
      setDetail(value);
      // Quantizations can differ by many gigabytes. Never preselect one merely because the
      // catalog returned it first; the user must make the storage/quality choice explicitly.
      setSelectedArtifact(null);
    } catch {
      setError('モデル詳細を取得できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function install(): Promise<void> {
    if (
      detail === null ||
      selectedArtifact === null ||
      selectedArtifact.quantization === null ||
      !licenseAccepted
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await localAiApi()!.install({
        source: detail.item.source,
        sourceId: detail.item.sourceId,
        artifactIds: [selectedArtifact.id],
        quantization: selectedArtifact.quantization,
        confirmed: true,
      });
      setConfirming(false);
      await onInstalled();
    } catch {
      setError('導入を開始できませんでした。メタデータと空き容量を確認してください。');
    } finally {
      setBusy(false);
    }
  }

  async function chooseArtifact(artifact: PublicModelArtifact): Promise<void> {
    if (detail === null) return;
    setSelectedArtifact(artifact);
    setSelectedFit(null);
    setFitLoading(true);
    try {
      setSelectedFit(
        await localAiApi()!.fit({
          source: detail.item.source,
          sourceId: detail.item.sourceId,
          artifactId: artifact.id,
          contextTokens: 8_192,
        }),
      );
    } catch {
      setError('このPCでの実行見込みを計算できませんでした。');
    } finally {
      setFitLoading(false);
    }
  }

  const items = page?.items ?? [];
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(
    items.length,
    Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN,
  );
  return (
    <div
      id="local-ai-selector"
      className={`local-ai-selector${selected !== null ? ' has-detail' : ''}`}
      aria-busy={busy}
    >
      <div className="local-ai-selector-toolbar">
        <label>
          <span className="sr-only">モデル名</span>
          <Search size={14} />
          <input
            ref={searchRef}
            className="settings-text-input"
            value={query.text}
            placeholder="モデルを検索"
            onChange={(event) => setQuery((current) => ({ ...current, text: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void search();
              }
            }}
          />
        </label>
        <select
          aria-label="取得元"
          value={query.source}
          onChange={(event) =>
            setQuery((current) => ({
              ...current,
              source: event.target.value as PublicModelCatalogQuery['source'],
            }))
          }
        >
          <option value="all">すべての取得元</option>
          <option value="hugging_face">Hugging Face</option>
          <option value="localai_gallery">LocalAI Gallery</option>
        </select>
        <select
          aria-label="用途"
          value={query.purpose}
          onChange={(event) =>
            setQuery((current) => ({
              ...current,
              purpose: event.target.value as PublicModelCatalogQuery['purpose'],
            }))
          }
        >
          <option value="code">コード</option>
          <option value="text_generation">文章生成</option>
          <option value="conversational">会話</option>
          <option value="all">すべて</option>
        </select>
        <label className="local-ai-checkbox">
          <input
            type="checkbox"
            checked={query.compatibility === 'compatible'}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                compatibility: event.target.checked ? 'compatible' : 'all',
              }))
            }
          />
          互換モデルのみ
        </label>
        <button
          type="button"
          className="settings-secondary-button"
          onClick={() => void search()}
          disabled={busy}
        >
          検索
        </button>
      </div>
      <div className="local-ai-selector-columns">
        <div className="local-ai-selector-results">
          <div className="local-ai-selector-mobile-heading">
            {selected !== null && (
              <button
                type="button"
                className="settings-secondary-button"
                onClick={() => {
                  setSelected(null);
                  requestAnimationFrame(() => searchRef.current?.focus());
                }}
              >
                <ArrowLeft size={14} />
                一覧へ戻る
              </button>
            )}
          </div>
          {page === null ? (
            <div className="local-ai-selector-empty">
              <strong>公開モデルを探す</strong>
              <p>名称・取得元・用途で絞り込み、検索してください。</p>
            </div>
          ) : items.length === 0 ? (
            <div className="local-ai-selector-empty">
              <strong>該当するモデルがありません</strong>
              <p>検索語または互換性フィルターを変更してください。</p>
            </div>
          ) : (
            <div
              ref={listRef}
              className="local-ai-virtual-list"
              style={{ height: VIEWPORT_HEIGHT }}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              role="listbox"
              aria-label="公開モデル検索結果"
            >
              <div style={{ height: items.length * ROW_HEIGHT, position: 'relative' }}>
                {items.slice(start, end).map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selected?.id === item.id}
                    className="local-ai-result-row"
                    style={{
                      position: 'absolute',
                      top: (start + index) * ROW_HEIGHT,
                      height: ROW_HEIGHT,
                    }}
                    onClick={() => void select(item)}
                  >
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.source === 'hugging_face' ? 'Hugging Face' : 'LocalAI Gallery'} ·{' '}
                        {item.author ?? '作者不明'}
                      </small>
                    </span>
                    <span className={`local-ai-installability state-${item.installability.state}`}>
                      {installabilityLabel(item.installability.state)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {page?.nextCursor !== null && page?.nextCursor !== undefined && (
            <button
              type="button"
              className="settings-secondary-button local-ai-next"
              onClick={() => void search(page.nextCursor)}
              disabled={busy}
            >
              次の50件
            </button>
          )}
        </div>
        <div className="local-ai-selector-detail" aria-live="polite">
          {selected === null ? (
            <div className="local-ai-selector-empty">
              <strong>モデルを選択</strong>
              <p>ライセンス、構成、コンテキスト長と導入可能なGGUFを確認できます。</p>
            </div>
          ) : detail === null ? (
            <p className="settings-hint">詳細を読み込んでいます。</p>
          ) : (
            <ModelDetail
              detail={detail}
              selectedArtifact={selectedArtifact}
              selectedFit={selectedFit}
              fitLoading={fitLoading}
              onArtifact={(artifact) => void chooseArtifact(artifact)}
              licenseAccepted={licenseAccepted}
              onLicense={setLicenseAccepted}
              confirming={confirming}
              onConfirming={setConfirming}
              onInstall={() => void install()}
              busy={busy}
            />
          )}
        </div>
      </div>
      {page?.errors.map((item) => (
        <p key={item.source} className="settings-provider-error" role="alert">
          {item.message}
        </p>
      ))}
      {error !== null && (
        <p className="settings-provider-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ModelDetail({
  detail,
  selectedArtifact,
  selectedFit,
  fitLoading,
  onArtifact,
  licenseAccepted,
  onLicense,
  confirming,
  onConfirming,
  onInstall,
  busy,
}: {
  detail: PublicModelCatalogDetail;
  selectedArtifact: PublicModelArtifact | null;
  selectedFit: LocalFitAssessment | null;
  fitLoading: boolean;
  onArtifact: (artifact: PublicModelArtifact) => void;
  licenseAccepted: boolean;
  onLicense: (value: boolean) => void;
  confirming: boolean;
  onConfirming: (value: boolean) => void;
  onInstall: () => void;
  busy: boolean;
}) {
  const installable = detail.artifacts.filter(
    ({ installability }) => installability.state === 'installable',
  );
  return (
    <article className="local-ai-model-detail">
      <span className="settings-list-label">
        {detail.item.source === 'hugging_face' ? 'HUGGING FACE' : 'LOCALAI GALLERY'}
      </span>
      <h4>{detail.item.name}</h4>
      <p>{detail.description || '説明は提供されていません。'}</p>
      <dl>
        <div>
          <dt>License</dt>
          <dd>{detail.item.license ?? '不明'}</dd>
        </div>
        <div>
          <dt>Architecture</dt>
          <dd>{detail.architecture ?? '不明'}</dd>
        </div>
        <div>
          <dt>Parameters</dt>
          <dd>{detail.parameterCount?.toLocaleString() ?? '不明'}</dd>
        </div>
        <div>
          <dt>Context</dt>
          <dd>{detail.contextTokens?.toLocaleString() ?? '不明'} tokens</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd className="local-ai-revision">{detail.item.immutableRevision ?? 'mutable / 不明'}</dd>
        </div>
      </dl>
      {installable.length === 0 ? (
        <p className="settings-hint">
          この参照は閲覧専用です。immutable
          revision・サイズ・SHA-256が確認できるGGUFだけを導入できます。
        </p>
      ) : (
        <fieldset className="local-ai-artifacts">
          <legend>GGUFを選択</legend>
          {installable.map((artifact) => (
            <label key={artifact.id}>
              <input
                type="radio"
                name="local-ai-artifact"
                checked={selectedArtifact?.id === artifact.id}
                onChange={() => onArtifact(artifact)}
              />
              <span>
                <strong>{artifact.quantization ?? artifact.filename}</strong>
                <small>{formatLocalBytes(artifact.sizeBytes)} · SHA-256確認済み</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {fitLoading && <p className="settings-hint">このPCでの実行見込みを計算中…</p>}
      {selectedFit !== null && <LocalFitSummary fit={selectedFit} />}
      {selectedArtifact !== null &&
        (confirming ? (
          <div className="local-ai-install-confirm">
            <strong>端末へダウンロードします</strong>
            <p>
              {formatLocalBytes(selectedArtifact.sizeBytes)}
              を使用します。取得後にサイズとSHA-256を検証します。
            </p>
            <label>
              <input
                type="checkbox"
                checked={licenseAccepted}
                onChange={(event) => onLicense(event.target.checked)}
              />
              ライセンス「{detail.item.license ?? '不明'}」を確認しました
            </label>
            <div className="local-ai-row-actions">
              <button
                type="button"
                className="settings-secondary-button"
                onClick={() => onConfirming(false)}
              >
                戻る
              </button>
              <button
                type="button"
                className="settings-primary-button"
                disabled={!licenseAccepted || busy}
                onClick={onInstall}
              >
                ダウンロード開始
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="settings-primary-button"
            onClick={() => onConfirming(true)}
          >
            このGGUFを導入
          </button>
        ))}
    </article>
  );
}

function LocalFitSummary({ fit }: { fit: LocalFitAssessment }) {
  return (
    <div className="local-ai-fit-summary" data-state={fit.state}>
      <strong>{fit.label}</strong>
      <p>{fit.detail}</p>
      {fit.breakdown !== null && (
        <dl>
          <div>
            <dt>Weights</dt>
            <dd>{formatLocalBytes(fit.breakdown.weightsBytes)}</dd>
          </div>
          <div>
            <dt>KV cache</dt>
            <dd>{formatLocalBytes(fit.breakdown.kvCacheBytes)}</dd>
          </div>
          <div>
            <dt>Scratch</dt>
            <dd>{formatLocalBytes(fit.breakdown.scratchBytes)}</dd>
          </div>
          <div>
            <dt>Runtime reserve</dt>
            <dd>{formatLocalBytes(fit.breakdown.runtimeReserveBytes)}</dd>
          </div>
          <div>
            <dt>Host / accelerator</dt>
            <dd>
              {formatLocalBytes(fit.breakdown.requiredHostBytes)} /{' '}
              {formatLocalBytes(fit.breakdown.requiredAcceleratorBytes)}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function installabilityLabel(state: PublicModelCatalogItem['installability']['state']): string {
  return {
    installable: '導入可能',
    browse_only: '閲覧のみ',
    unsupported: '非対応',
    metadata_required: '詳細で確認',
    access_restricted: 'アクセス制限',
  }[state];
}
