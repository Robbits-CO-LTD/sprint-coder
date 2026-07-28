import { useEffect, useRef, useState } from 'react';
import type { ProviderConnection, ProviderVerificationStatus } from '@sprint-coder/contracts';

// Plaintext credentials remain here only until Main accepts them into Secret Storage.
// Raw provider errors and secret references are never rendered.

type ProvidersApi = NonNullable<Window['sprintCoder']>['providers'];

/** Null whenever this build of Main has not wired the provider IPC, per the contract's
 * runtime-check rule. Module scope so the effect below can see it is not a reactive value. */
function providerApi(): ProvidersApi | null {
  if (typeof window === 'undefined') return null;
  const api = window.sprintCoder?.providers;
  return typeof api?.listConnections === 'function' ? api : null;
}

export const VERIFICATION_LABEL: Record<ProviderVerificationStatus, string> = {
  not_required: '確認不要',
  unverified: '未確認',
  verified: '確認済み',
  verification_expired: '再確認が必要',
  invalid_credentials: '認証情報が無効',
  unavailable: '一時的に利用できません',
};

export const VERIFICATION_TONE: Record<ProviderVerificationStatus, string> = {
  not_required: 'muted',
  unverified: 'warn',
  verified: 'ok',
  verification_expired: 'warn',
  invalid_credentials: 'danger',
  unavailable: 'danger',
};

export const LIST_ERROR = 'Connection一覧を取得できませんでした。再読み込みしてください。';
export const CREATE_ERROR = 'Connectionを追加できませんでした。入力内容を確認してください。';
export const VERIFY_ERROR = '検証を実行できませんでした。時間をおいて再試行してください。';
export const UNSUPPORTED_TEXT = 'この環境ではProvider設定APIが利用できません。';
export const LOADING_TEXT = 'Connectionを読み込んでいます。';
export const EMPTY_TEXT = '利用できるConnectionはまだありません。';

// Rule 1's boundary in user-facing words: the screen forgets the key, Main keeps it safely.
export const SECTION_DESCRIPTION =
  '組み込みCLIと外部APIの接続先を管理します。登録済みAPIキーはMainプロセスが安全に保管し、この画面へ再表示しません。';
export const KEY_BOUNDARY_HINT =
  'APIキーの平文はこの入力欄にのみ一時的に保持され、送信後に画面から消去されます。キーはMainプロセスがOSの安全な保管領域に保存し、DBには参照情報だけが残ります。';

export const PROVIDER_FORM_OPTIONS = [
  { key: 'openai', label: 'OpenAI API', scoped: true },
  { key: 'openrouter', label: 'OpenRouter API', scoped: false },
  { key: 'anthropic', label: 'Anthropic API', scoped: false },
  { key: 'google', label: 'Google Gemini API', scoped: false },
  { key: 'xai', label: 'xAI API', scoped: false },
] as const;

export type ProviderFormKey = (typeof PROVIDER_FORM_OPTIONS)[number]['key'];

export type ProviderFormValues = {
  provider: ProviderFormKey;
  displayName: string;
  apiKey: string;
  organizationId: string;
  projectId: string;
};

const EMPTY_FORM: ProviderFormValues = {
  provider: 'openai',
  displayName: '',
  apiKey: '',
  organizationId: '',
  projectId: '',
};

/** A Connection whose credentials Main can re-check. Built-in CLIs authenticate themselves. */
export function isExternalConnection(connection: ProviderConnection): boolean {
  return (
    connection.runtimeKind === 'official_api' || connection.runtimeKind === 'openai_compatible'
  );
}

/**
 * Claude CLI and Anthropic API share `providerId: 'anthropic'`; Codex CLI and OpenAI API share
 * `providerId: 'openai'`. Only `runtimeKind` separates them, so the label has to read both.
 */
export function connectionKindLabel(connection: ProviderConnection): string {
  if (connection.runtimeKind === 'builtin_cli') {
    if (connection.providerId === 'anthropic') return 'Claude CLI（組み込み）';
    if (connection.providerId === 'openai') return 'Codex CLI（組み込み）';
    return '組み込みCLI';
  }
  if (connection.runtimeKind === 'mock') return 'モックProvider';
  switch (connection.providerId) {
    case 'openai':
      return 'OpenAI API';
    case 'anthropic':
      return 'Anthropic API';
    case 'google':
      return 'Google Gemini API';
    case 'xai':
      return 'xAI API';
    case 'openrouter':
      return 'OpenRouter API';
    default:
      return connection.runtimeKind === 'openai_compatible' ? 'OpenAI互換API' : '外部API';
  }
}

/** The section's one in-flight flag, driving aria-busy, reload, every retry button and submit.
 * A verification counts whichever Connection it belongs to: that is what stops a second one. */
export function isSectionBusy(state: {
  loading: boolean;
  submitting: boolean;
  verifyingId: string | null;
}): boolean {
  return state.loading || state.submitting || state.verifyingId !== null;
}

/** `busy` is the whole section's in-flight state, not just this form's: a create issued while a
 * list reload or a verification is still running would resolve into a list about to be replaced. */
export function canSubmitProviderForm(form: ProviderFormValues, busy: boolean): boolean {
  return !busy && form.displayName.trim() !== '' && form.apiKey !== '';
}

/** Dispatches to the per-provider create method. Optional fields are omitted, never sent empty. */
export async function createConnection(
  api: ProvidersApi,
  form: ProviderFormValues,
): Promise<ProviderConnection> {
  const displayName = form.displayName.trim();
  const apiKey = form.apiKey;
  switch (form.provider) {
    case 'openai': {
      const organizationId = form.organizationId.trim();
      const projectId = form.projectId.trim();
      return api.createOpenAIConnection({
        displayName,
        apiKey,
        ...(organizationId === '' ? {} : { organizationId }),
        ...(projectId === '' ? {} : { projectId }),
      });
    }
    case 'openrouter':
      return api.createOpenRouterConnection({ displayName, apiKey });
    case 'anthropic':
      return api.createAnthropicConnection({ displayName, apiKey });
    case 'google':
      return api.createGeminiConnection({ displayName, apiKey });
    case 'xai':
      return api.createXAIConnection({ displayName, apiKey });
  }
}

/** Replaces a Connection in place when Main already knows it, appends it otherwise. */
export function upsertConnection(
  connections: readonly ProviderConnection[],
  next: ProviderConnection,
): ProviderConnection[] {
  const index = connections.findIndex((connection) => connection.id === next.id);
  if (index < 0) return [...connections, next];
  const merged = [...connections];
  merged[index] = next;
  return merged;
}

export function ProviderConnectionCard({
  connection,
  verifying,
  disabled,
  onRetry,
}: {
  connection: ProviderConnection;
  verifying: boolean;
  disabled: boolean;
  onRetry: (connection: ProviderConnection) => void;
}) {
  const status = connection.verification.status;
  return (
    <li className="settings-connection-card" data-testid={`settings-connection-${connection.id}`}>
      <span className="settings-connection-main">
        <strong>{connection.displayName}</strong>
        <small>
          {connectionKindLabel(connection)}
          {connection.enabled ? '' : ' · 無効'}
        </small>
      </span>
      <span className={`settings-connection-badge tone-${VERIFICATION_TONE[status]}`}>
        {verifying ? '検証中' : VERIFICATION_LABEL[status]}
      </span>
      {isExternalConnection(connection) && (
        <button
          type="button"
          className="settings-secondary-button"
          aria-label={`${connection.displayName}の検証を再実行`}
          disabled={disabled || verifying}
          onClick={() => onRetry(connection)}
        >
          検証を再実行
        </button>
      )}
    </li>
  );
}

export function ProviderSettingsSection({ active }: { active: boolean }) {
  const [connections, setConnections] = useState<ProviderConnection[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFormValues>(EMPTY_FORM);
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const generation = useRef(0);

  const busy = isSectionBusy({ loading, submitting, verifyingId });

  // A failed initial load waits for the explicit retry button instead of looping.
  useEffect(() => {
    if (!active || connections !== null || loading || loadFailed || !supported) return;
    void refresh();
  }, [active, connections, loadFailed, loading, supported]);

  async function refresh(): Promise<void> {
    const api = providerApi();
    if (api === null) {
      setSupported(false);
      return;
    }
    const request = ++generation.current;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    try {
      const result = await api.listConnections();
      if (request !== generation.current) return;
      setConnections(result);
      setStatus(`${result.length}件のConnectionを読み込みました。`);
    } catch {
      if (request !== generation.current) return;
      setError(LIST_ERROR);
      setLoadFailed(true);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  async function retryVerification(connection: ProviderConnection): Promise<void> {
    const api = providerApi();
    if (api === null) {
      setSupported(false);
      return;
    }
    if (busy) return;
    setError(null);
    setVerifyingId(connection.id);
    try {
      const updated = await api.verifyConnection(connection.id);
      setConnections((current) => upsertConnection(current ?? [], updated));
      setStatus(
        `${updated.displayName}の検証結果: ${VERIFICATION_LABEL[updated.verification.status]}`,
      );
    } catch {
      setError(VERIFY_ERROR);
    } finally {
      setVerifyingId(null);
    }
  }

  async function submitForm(): Promise<void> {
    const api = providerApi();
    if (api === null) {
      setSupported(false);
      return;
    }
    if (!canSubmitProviderForm(form, busy)) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createConnection(api, form);
      // Main now owns the encrypted secret; clear the renderer copy immediately.
      setForm({ ...EMPTY_FORM, provider: form.provider });
      setShowKey(false);
      setConnections((current) => upsertConnection(current ?? [], created));
      setStatus(
        `${created.displayName}を追加しました。検証結果: ${VERIFICATION_LABEL[created.verification.status]}`,
      );
    } catch {
      setError(CREATE_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  const selected = PROVIDER_FORM_OPTIONS.find((option) => option.key === form.provider);
  const listed = connections ?? [];

  return (
    <section
      className="settings-providers"
      aria-labelledby="settings-providers-title"
      // The whole busy state, not just the load: a verification or create leaves controls inert too.
      aria-busy={busy}
    >
      <div className="settings-section-heading">
        <div>
          <h3 id="settings-providers-title">Provider Connection</h3>
          <p>{SECTION_DESCRIPTION}</p>
        </div>
        <button
          type="button"
          className="settings-secondary-button"
          onClick={() => void refresh()}
          disabled={busy || !supported}
        >
          再読み込み
        </button>
      </div>

      {!supported ? (
        <p className="settings-hint" data-testid="settings-providers-unsupported">
          {UNSUPPORTED_TEXT}
        </p>
      ) : (
        <>
          {connections === null ? (
            // Suppressed once a load has failed: the alert below is the honest state, and a
            // "loading" line that never resolves reads as a hang.
            error === null && <p className="settings-hint">{LOADING_TEXT}</p>
          ) : listed.length === 0 ? (
            <p className="settings-hint">{EMPTY_TEXT}</p>
          ) : (
            <ul className="settings-connection-list" aria-label="Connection一覧">
              {listed.map((connection) => (
                <ProviderConnectionCard
                  key={connection.id}
                  connection={connection}
                  verifying={verifyingId === connection.id}
                  disabled={busy}
                  onRetry={(target) => void retryVerification(target)}
                />
              ))}
            </ul>
          )}

          {error !== null && (
            <p className="settings-provider-error" role="alert">
              {error}
            </p>
          )}

          <form
            className="settings-provider-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitForm();
            }}
          >
            <fieldset className="settings-group" disabled={submitting}>
              <legend>Connectionを追加</legend>

              <label className="settings-field" htmlFor="settings-provider-kind">
                <span className="settings-field-label">Provider</span>
                <select
                  id="settings-provider-kind"
                  data-testid="settings-provider-kind"
                  value={form.provider}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      provider: e.target.value as ProviderFormKey,
                    }))
                  }
                >
                  {PROVIDER_FORM_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-field" htmlFor="settings-provider-name">
                <span className="settings-field-label">表示名</span>
                <input
                  id="settings-provider-name"
                  data-testid="settings-provider-name"
                  type="text"
                  className="settings-text-input"
                  autoComplete="off"
                  value={form.displayName}
                  onChange={(e) =>
                    setForm((current) => ({ ...current, displayName: e.target.value }))
                  }
                />
              </label>

              <div className="settings-field">
                <label className="settings-field-label" htmlFor="settings-provider-api-key">
                  APIキー
                </label>
                <div className="settings-key-row">
                  <input
                    id="settings-provider-api-key"
                    data-testid="settings-provider-api-key"
                    // Masked by default; the toggle below is the only way to reveal it.
                    type={showKey ? 'text' : 'password'}
                    className="settings-text-input"
                    autoComplete="off"
                    spellCheck={false}
                    value={form.apiKey}
                    onChange={(e) => setForm((current) => ({ ...current, apiKey: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="settings-secondary-button"
                    aria-pressed={showKey}
                    aria-controls="settings-provider-api-key"
                    aria-label={showKey ? 'APIキーを隠す' : 'APIキーを表示'}
                    onClick={() => setShowKey((value) => !value)}
                  >
                    {showKey ? '隠す' : '表示'}
                  </button>
                </div>
                <p className="settings-hint">{KEY_BOUNDARY_HINT}</p>
              </div>

              {selected?.scoped === true && (
                <>
                  <label className="settings-field" htmlFor="settings-provider-org">
                    <span className="settings-field-label">Organization ID（任意）</span>
                    <input
                      id="settings-provider-org"
                      data-testid="settings-provider-org"
                      type="text"
                      className="settings-text-input"
                      autoComplete="off"
                      value={form.organizationId}
                      onChange={(e) =>
                        setForm((current) => ({ ...current, organizationId: e.target.value }))
                      }
                    />
                  </label>
                  <label className="settings-field" htmlFor="settings-provider-project">
                    <span className="settings-field-label">Project ID（任意）</span>
                    <input
                      id="settings-provider-project"
                      data-testid="settings-provider-project"
                      type="text"
                      className="settings-text-input"
                      autoComplete="off"
                      value={form.projectId}
                      onChange={(e) =>
                        setForm((current) => ({ ...current, projectId: e.target.value }))
                      }
                    />
                  </label>
                </>
              )}

              <div className="settings-provider-actions">
                <button
                  type="submit"
                  className="settings-primary-button"
                  data-testid="settings-provider-submit"
                  disabled={!canSubmitProviderForm(form, busy)}
                >
                  {submitting ? '追加中' : '追加して検証'}
                </button>
              </div>
            </fieldset>
          </form>
        </>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
