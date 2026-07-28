import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CREATE_ERROR,
  KEY_BOUNDARY_HINT,
  LIST_ERROR,
  LOADING_TEXT,
  PROVIDER_FORM_OPTIONS,
  ProviderConnectionCard,
  ProviderSettingsSection,
  SECTION_DESCRIPTION,
  VERIFICATION_LABEL,
  VERIFICATION_TONE,
  VERIFY_ERROR,
  canSubmitProviderForm,
  connectionKindLabel,
  createConnection,
  isExternalConnection,
  isSectionBusy,
  upsertConnection,
  type ProviderFormValues,
} from './ProviderSettingsSection';
import type { ProviderConnection, ProviderVerificationStatus } from '@sprint-coder/contracts';

// Every key in this file is a fake literal. Nothing here reads a real credential.
const FAKE_KEY = 'sk-test-not-a-real-key';

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: 'conn-1',
    providerId: 'openai',
    runtimeKind: 'official_api',
    displayName: '本番 OpenAI',
    enabled: true,
    secretReference: 'provider-secret:11111111-2222-4333-8444-555555555555',
    verification: { status: 'verified', verifiedAt: null, expiresAt: null, message: null },
    rateLimit: {
      mode: 'auto',
      maxConcurrentRequests: null,
      requestsPerMinute: null,
      tokensPerMinute: null,
      lastObservedRateLimitHeaders: null,
    },
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

function form(overrides: Partial<ProviderFormValues> = {}): ProviderFormValues {
  return {
    provider: 'openai',
    displayName: '本番',
    apiKey: FAKE_KEY,
    organizationId: '',
    projectId: '',
    ...overrides,
  };
}

function fakeApi() {
  const created = connection({ id: 'conn-new' });
  return {
    listConnections: vi.fn(async () => [connection()]),
    createOpenAIConnection: vi.fn(async () => created),
    createOpenRouterConnection: vi.fn(async () => created),
    createAnthropicConnection: vi.fn(async () => created),
    createGeminiConnection: vi.fn(async () => created),
    createXAIConnection: vi.fn(async () => created),
    verifyConnection: vi.fn(async () => created),
  };
}

describe('verification labels', () => {
  const ALL: ProviderVerificationStatus[] = [
    'not_required',
    'unverified',
    'verified',
    'verification_expired',
    'invalid_credentials',
    'unavailable',
  ];

  it('names every status in Japanese, with no duplicates', () => {
    const labels = ALL.map((status) => VERIFICATION_LABEL[status]);
    expect(labels).toEqual([
      '確認不要',
      '未確認',
      '確認済み',
      '再確認が必要',
      '認証情報が無効',
      '一時的に利用できません',
    ]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('gives every status a tone, and reserves the danger tone for credential problems', () => {
    for (const status of ALL) expect(VERIFICATION_TONE[status]).toBeTruthy();
    expect(VERIFICATION_TONE.invalid_credentials).toBe('danger');
    expect(VERIFICATION_TONE.unavailable).toBe('danger');
    expect(VERIFICATION_TONE.verified).toBe('ok');
  });
});

describe('connectionKindLabel', () => {
  it('separates the built-in CLIs from the APIs that share their providerId', () => {
    expect(
      connectionKindLabel(connection({ providerId: 'anthropic', runtimeKind: 'builtin_cli' })),
    ).toBe('Claude CLI（組み込み）');
    expect(
      connectionKindLabel(connection({ providerId: 'anthropic', runtimeKind: 'official_api' })),
    ).toBe('Anthropic API');
    expect(
      connectionKindLabel(connection({ providerId: 'openai', runtimeKind: 'builtin_cli' })),
    ).toBe('Codex CLI（組み込み）');
    expect(
      connectionKindLabel(connection({ providerId: 'openai', runtimeKind: 'official_api' })),
    ).toBe('OpenAI API');
  });

  it('names the remaining providers and never returns an empty label', () => {
    expect(connectionKindLabel(connection({ providerId: 'google' }))).toBe('Google Gemini API');
    expect(connectionKindLabel(connection({ providerId: 'xai' }))).toBe('xAI API');
    expect(
      connectionKindLabel(
        connection({ providerId: 'openrouter', runtimeKind: 'openai_compatible' }),
      ),
    ).toBe('OpenRouter API');
    expect(connectionKindLabel(connection({ providerId: 'mock', runtimeKind: 'mock' }))).toBe(
      'モックProvider',
    );
    expect(
      connectionKindLabel(connection({ providerId: 'unknown', runtimeKind: 'openai_compatible' })),
    ).toBe('OpenAI互換API');
  });
});

describe('isExternalConnection', () => {
  it('is true only for the Connections whose credentials Main can re-check', () => {
    expect(isExternalConnection(connection({ runtimeKind: 'official_api' }))).toBe(true);
    expect(isExternalConnection(connection({ runtimeKind: 'openai_compatible' }))).toBe(true);
    expect(isExternalConnection(connection({ runtimeKind: 'builtin_cli' }))).toBe(false);
    expect(isExternalConnection(connection({ runtimeKind: 'mock' }))).toBe(false);
  });
});

describe('canSubmitProviderForm', () => {
  it('blocks on any in-flight request, not only a create — a whitespace key still counts as typed', () => {
    // `busy` covers a list reload and a verification too, so a filled-in form is still refused.
    expect(canSubmitProviderForm(form(), true)).toBe(false);
    // A key is sent verbatim: no trim, because leading/trailing bytes may be part of the secret.
    expect(canSubmitProviderForm(form({ apiKey: ' ' }), false)).toBe(true);
  });

  it('requires both a display name and a key, and blocks a request in flight', () => {
    expect(canSubmitProviderForm(form(), false)).toBe(true);
    expect(canSubmitProviderForm(form(), true)).toBe(false);
    expect(canSubmitProviderForm(form({ apiKey: '' }), false)).toBe(false);
    expect(canSubmitProviderForm(form({ displayName: '' }), false)).toBe(false);
    expect(canSubmitProviderForm(form({ displayName: '   ' }), false)).toBe(false);
  });
});

describe('isSectionBusy', () => {
  const idle = { loading: false, submitting: false, verifyingId: null };

  it('is busy for any of the three operations, so none can overlap another', () => {
    expect(isSectionBusy(idle)).toBe(false);
    expect(isSectionBusy({ ...idle, loading: true })).toBe(true);
    expect(isSectionBusy({ ...idle, submitting: true })).toBe(true);
    // The one that matters most: a verification in flight blocks starting a second one, whichever
    // Connection the click came from. Both responses would otherwise race into the same list.
    expect(isSectionBusy({ ...idle, verifyingId: 'conn-1' })).toBe(true);
  });
});

describe('createConnection', () => {
  it('routes each provider to its own create method', async () => {
    for (const option of PROVIDER_FORM_OPTIONS) {
      const api = fakeApi();
      await createConnection(api, form({ provider: option.key }));
      const calls = [
        api.createOpenAIConnection,
        api.createOpenRouterConnection,
        api.createAnthropicConnection,
        api.createGeminiConnection,
        api.createXAIConnection,
      ].filter((fn) => fn.mock.calls.length > 0);
      expect(calls).toHaveLength(1);
    }
  });

  it('trims the display name and omits the OpenAI scope fields when they are blank', async () => {
    const api = fakeApi();
    await createConnection(api, form({ displayName: '  本番  ' }));
    expect(api.createOpenAIConnection).toHaveBeenCalledWith({
      displayName: '本番',
      apiKey: FAKE_KEY,
    });
  });

  it('sends the OpenAI scope fields trimmed when they are filled in', async () => {
    const api = fakeApi();
    await createConnection(api, form({ organizationId: ' org-1 ', projectId: ' proj-1 ' }));
    expect(api.createOpenAIConnection).toHaveBeenCalledWith({
      displayName: '本番',
      apiKey: FAKE_KEY,
      organizationId: 'org-1',
      projectId: 'proj-1',
    });
  });

  it('never sends the scope fields to a provider that has no such concept', async () => {
    const api = fakeApi();
    await createConnection(
      api,
      form({ provider: 'anthropic', organizationId: 'org-1', projectId: 'proj-1' }),
    );
    expect(api.createAnthropicConnection).toHaveBeenCalledWith({
      displayName: '本番',
      apiKey: FAKE_KEY,
    });
  });
});

describe('upsertConnection', () => {
  it('replaces a known Connection in place and appends an unknown one', () => {
    const existing = connection({ id: 'conn-1', displayName: '旧' });
    const updated = connection({ id: 'conn-1', displayName: '新' });
    expect(upsertConnection([existing], updated)).toEqual([updated]);
    const added = connection({ id: 'conn-2' });
    expect(upsertConnection([existing], added)).toEqual([existing, added]);
    expect(upsertConnection([], added)).toEqual([added]);
  });
});

describe('ProviderConnectionCard', () => {
  it('shows the name, kind and Japanese verification state, and offers retry for external ones', () => {
    const html = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection({
          verification: {
            status: 'verification_expired',
            verifiedAt: null,
            expiresAt: null,
            message: null,
          },
        })}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain('本番 OpenAI');
    expect(html).toContain('OpenAI API');
    expect(html).toContain('再確認が必要');
    expect(html).toContain('本番 OpenAIの検証を再実行');
  });

  it('never renders the secret reference', () => {
    const html = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection()}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
      />,
    );
    expect(html).not.toContain('provider-secret:');
  });

  it('never renders the backend verification message, which can carry raw provider text', () => {
    const html = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection({
          verification: {
            status: 'invalid_credentials',
            verifiedAt: null,
            expiresAt: null,
            message: 'Error: 401 from https://api.example.com/v1 (trace abc123)',
          },
        })}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
      />,
    );
    expect(html).not.toContain('401');
    expect(html).not.toContain('api.example.com');
    expect(html).toContain('認証情報が無効');
  });

  it('offers no retry for a built-in CLI and reports it as not required', () => {
    const html = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection({
          providerId: 'anthropic',
          runtimeKind: 'builtin_cli',
          displayName: 'Claude CLI',
          secretReference: null,
          verification: {
            status: 'not_required',
            verifiedAt: null,
            expiresAt: null,
            message: null,
          },
        })}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain('Claude CLI（組み込み）');
    expect(html).toContain('確認不要');
    expect(html).not.toContain('検証を再実行');
  });

  it('marks the retry button busy while its own verification is in flight', () => {
    const html = renderToStaticMarkup(
      <ProviderConnectionCard connection={connection()} verifying disabled onRetry={() => {}} />,
    );
    expect(html).toContain('検証中');
    expect(html).toContain('disabled');
  });

  it('goes dead during someone else‘s operation without claiming to be verifying itself', () => {
    // The badge is this card's own state; `disabled` is the section's. A card that is merely
    // blocked must not read 検証中, or every row would claim to be verifying at once.
    const html = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection()}
        verifying={false}
        disabled
        onRetry={() => {}}
      />,
    );
    expect(html).toContain('disabled');
    expect(html).not.toContain('検証中');
    expect(html).toContain('確認済み');
  });
});

describe('ProviderSettingsSection', () => {
  it('renders a labelled section with a polite status region and a loading state', () => {
    const html = renderToStaticMarkup(<ProviderSettingsSection active />);
    expect(html).toContain('aria-labelledby="settings-providers-title"');
    expect(html).toContain('id="settings-providers-title"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain(LOADING_TEXT);
    // Idle first paint, so the busy flag the section publishes is off rather than absent.
    expect(html).toContain('aria-busy="false"');
  });

  it('masks the API key field by default and exposes a pressed-state reveal toggle', () => {
    const html = renderToStaticMarkup(<ProviderSettingsSection active />);
    expect(html).toContain('id="settings-provider-api-key"');
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-controls="settings-provider-api-key"');
    expect(html).toContain('APIキーを表示');
  });

  it('offers every required provider and starts with submit disabled', () => {
    const html = renderToStaticMarkup(<ProviderSettingsSection active />);
    for (const option of PROVIDER_FORM_OPTIONS) expect(html).toContain(option.label);
    expect(html).toContain('id="settings-provider-org"');
    expect(html).toContain('id="settings-provider-project"');
    // Empty display name and empty key on first render, so the submit must start unpressable.
    expect(html).toMatch(/data-testid="settings-provider-submit"[^>]*disabled/);
  });
});

describe('secret boundary copy', () => {
  it('states where the key goes instead of claiming it is never saved', () => {
    // Main puts the key in OS Secret Storage and the DB keeps an opaque reference, so wording like
    // 「保存されず」would be a false promise. The honest claim is cleared-here, stored-by-Main.
    for (const text of [SECTION_DESCRIPTION, KEY_BOUNDARY_HINT]) {
      expect(text).not.toMatch(/保存されず|保存しません|保存されません/);
      expect(text).toContain('Main');
    }
    expect(KEY_BOUNDARY_HINT).toContain('消去');
    expect(KEY_BOUNDARY_HINT).toContain('安全な保管領域');
    const html = renderToStaticMarkup(<ProviderSettingsSection active />);
    expect(html).toContain(SECTION_DESCRIPTION);
    expect(html).toContain(KEY_BOUNDARY_HINT);
    expect(html).not.toContain('provider-secret:'); // nor the reference, ever
  });
});

describe('error copy', () => {
  it('is fixed generic Japanese text with no interpolation seams for backend detail', () => {
    for (const message of [LIST_ERROR, CREATE_ERROR, VERIFY_ERROR]) {
      expect(message).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(message).not.toContain('${');
      expect(message).not.toMatch(/Error|http|undefined/i);
    }
  });
});
