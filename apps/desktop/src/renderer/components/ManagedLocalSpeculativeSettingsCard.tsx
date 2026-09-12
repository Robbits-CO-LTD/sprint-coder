import { useEffect, useRef, useState } from 'react';
import type {
  ManagedLocalRuntimeSnapshot,
  ManagedLocalSpeculativeSettingsView,
} from '@sprint-coder/contracts';

export function ManagedLocalSpeculativeSettingsCard({
  modelId,
  runtime,
  onFindDraft,
}: {
  modelId: string;
  runtime: ManagedLocalRuntimeSnapshot | null;
  onFindDraft?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>投機的デコード（DFlash2）</summary>
      {expanded ? (
        <SpeculativeForm
          key={modelId}
          modelId={modelId}
          runtime={runtime}
          onFindDraft={onFindDraft}
        />
      ) : null}
    </details>
  );
}

function SpeculativeForm({
  modelId,
  runtime,
  onFindDraft,
}: {
  modelId: string;
  runtime: ManagedLocalRuntimeSnapshot | null;
  onFindDraft: (() => void) | undefined;
}) {
  const [view, setView] = useState<ManagedLocalSpeculativeSettingsView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [draftId, setDraftId] = useState('');
  const [tokens, setTokens] = useState('3');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    const api = window.sprintCoder?.localAI;
    const request =
      typeof api?.speculativeSettings === 'function'
        ? api.speculativeSettings(modelId)
        : Promise.reject(new Error('unavailable'));
    void request
      .then((result) => {
        if (disposed) return;
        setView(result);
        setEnabled(result.configured.type === 'draft-dflash');
        setDraftId(result.configured.draftModelId ?? '');
        setTokens(String(result.configured.draftTokensMax));
      })
      .catch(() => {
        if (!disposed) setError('投機的デコード設定を読み込めませんでした。');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [modelId, revision]);
  const busy =
    runtime?.modelId === modelId &&
    ['starting', 'running', 'stopping'].includes(runtime.state) &&
    (runtime.state !== 'running' || runtime.activeLeaseCount > 0);
  const count = Number(tokens);
  const invalidTokens = !Number.isSafeInteger(count) || count < 1 || count > 64;
  const eligible = view?.eligibleDrafts.some(({ id }) => id === draftId) === true;
  const dirty =
    view !== null &&
    (view.recoveryRequired ||
      enabled !== (view.configured.type === 'draft-dflash') ||
      (enabled &&
        (draftId !== view.configured.draftModelId || count !== view.configured.draftTokensMax)));
  const invalid = enabled && (invalidTokens || !eligible || view?.supported !== true);

  async function save() {
    if (invalid || busy || saving || !dirty || window.sprintCoder === undefined) return;
    setSaving(true);
    setError(null);
    setStatus('');
    try {
      const result = await window.sprintCoder.localAI.setSpeculativeSettings({
        modelId,
        settings: enabled
          ? { type: 'draft-dflash', draftModelId: draftId, draftTokensMax: count }
          : { type: 'off', draftModelId: null, draftTokensMax: 3 },
      });
      if (!mounted.current) return;
      setView(result);
      setEnabled(result.configured.type === 'draft-dflash');
      setDraftId(result.configured.draftModelId ?? '');
      setTokens(String(result.configured.draftTokensMax));
      setStatus('保存しました。次回のモデル起動から反映します。');
    } catch {
      if (mounted.current)
        setError('保存できませんでした。モデルの状態と互換性を再確認してください。');
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <section aria-label="投機的デコード設定" aria-busy={loading || saving}>
      <p className="settings-hint">
        同じモデル用に学習した下書きで先読みします。効果はモデルと実行環境により異なります。
      </p>
      {loading ? (
        <p className="settings-hint">設定を読み込んでいます。</p>
      ) : view === null ? null : (
        <>
          {view.recoveryRequired ? (
            <p role="alert" className="settings-provider-error">
              保存設定を復元できなかったためオフに戻しました。再設定してください。
            </p>
          ) : null}
          <div className="local-ai-launch-controls">
            <label className="settings-field" htmlFor={`spec-mode-${modelId}`}>
              <span className="settings-field-label">方式</span>
              <select
                id={`spec-mode-${modelId}`}
                className="settings-text-input"
                value={enabled ? 'draft-dflash' : 'off'}
                disabled={busy || saving}
                onChange={(event) => {
                  setEnabled(event.target.value === 'draft-dflash');
                  if (!draftId) setDraftId(view.eligibleDrafts[0]?.id ?? '');
                }}
              >
                <option value="off">オフ</option>
                <option
                  value="draft-dflash"
                  disabled={!view.supported || view.eligibleDrafts.length === 0}
                >
                  DFlash2
                </option>
              </select>
            </label>
            {enabled ? (
              <>
                <label className="settings-field" htmlFor={`spec-draft-${modelId}`}>
                  <span className="settings-field-label">下書きモデル</span>
                  <select
                    id={`spec-draft-${modelId}`}
                    className="settings-text-input"
                    value={draftId}
                    disabled={busy || saving}
                    onChange={(event) => setDraftId(event.target.value)}
                  >
                    {!eligible ? (
                      <option value={draftId}>
                        {draftId ? '保存済みの下書きを確認できません' : '下書きを選択してください'}
                      </option>
                    ) : null}
                    {view.eligibleDrafts.map((draft) => (
                      <option key={draft.id} value={draft.id}>
                        {draft.sourceId} · {draft.quantization}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field" htmlFor={`spec-tokens-${modelId}`}>
                  <span className="settings-field-label">先読みトークン上限</span>
                  <input
                    id={`spec-tokens-${modelId}`}
                    className="settings-text-input"
                    type="number"
                    min={1}
                    max={64}
                    step={1}
                    value={tokens}
                    aria-invalid={invalidTokens}
                    aria-describedby={invalidTokens ? `spec-token-error-${modelId}` : undefined}
                    disabled={busy || saving}
                    onChange={(event) => setTokens(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            <button
              className="settings-secondary-button"
              type="button"
              disabled={busy || saving || invalid || !dirty}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '投機的デコード設定を保存'}
            </button>
          </div>
          {enabled && invalidTokens ? (
            <p id={`spec-token-error-${modelId}`} className="settings-provider-error">
              1〜64の整数を入力してください。
            </p>
          ) : null}
          {view.reason !== null ? <p className="settings-hint">{view.reason}</p> : null}
          {busy ? <p className="settings-hint">実行中のため設定を変更できません。</p> : null}
        </>
      )}
      <div className="local-ai-row-actions">
        {onFindDraft !== undefined ? (
          <button
            type="button"
            className="settings-secondary-button"
            disabled={saving}
            onClick={onFindDraft}
          >
            下書きモデルを探す
          </button>
        ) : null}
        <button
          type="button"
          className="settings-secondary-button"
          disabled={loading || saving}
          onClick={() => {
            setLoading(true);
            setError(null);
            setRevision((value) => value + 1);
          }}
        >
          再読み込み
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className="settings-provider-error">
          {error}
        </p>
      ) : null}
      <p role="status" className="settings-hint">
        {status}
      </p>
    </section>
  );
}
