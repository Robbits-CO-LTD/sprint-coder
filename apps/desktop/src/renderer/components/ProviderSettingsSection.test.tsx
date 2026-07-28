import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CREATE_ERROR,
  KEY_BOUNDARY_HINT,
  LIST_ERROR,
  LOADING_TEXT,
  PROFILE_LIST_WARNING,
  PROFILE_OPTION_PREFIX,
  PROFILE_UNAVAILABLE_NOTICE,
  PROFILE_UNAVAILABLE_OPTION_LABEL,
  PROFILE_UNAVAILABLE_VALUE,
  PROFILE_WARNING_ID,
  PROVIDER_FORM_OPTIONS,
  ProviderConnectionCard,
  ProviderSettingsSection,
  SECTION_DESCRIPTION,
  SELECTION_UNAVAILABLE_ID,
  VERIFICATION_LABEL,
  VERIFICATION_TONE,
  VERIFY_ERROR,
  applyProviderSelection,
  canSubmitProviderForm,
  clearUnavailableProfileInput,
  connectionKindLabel,
  createConnection,
  isExternalConnection,
  isProviderSelectionUnavailable,
  isSectionBusy,
  profileRequiresAccountId,
  providerSelectDescribedBy,
  providerSelectValue,
  selectedProviderProfile,
  upsertConnection,
  type ProviderFormValues,
} from './ProviderSettingsSection';
import type {
  ProviderConnection,
  ProviderProfile,
  ProviderVerificationStatus,
} from '@sprint-coder/contracts';

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
    profileId: null,
    displayName: '本番',
    apiKey: FAKE_KEY,
    organizationId: '',
    projectId: '',
    baseUrl: '',
    accountId: '',
    ...overrides,
  };
}

// A fictional Provider. Pack A's real ids stay out of this file for the same reason they stay out
// of the component: the Renderer is not supposed to know any of them.
function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'example-compat',
    displayName: 'Example 互換API',
    baseUrl: 'https://api.example-compat.test/v1',
    baseUrlConfigurable: false,
    protocol: 'chat_completions',
    modelsPath: '/models',
    authentication: { headerName: 'Authorization', scheme: 'Bearer' },
    requiredCredentialFields: [],
    errorOverrides: [],
    sourceReference: 'https://docs.example-compat.test/openai',
    reviewedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

// The form once a Profile is picked: only the id lives in the form, and the Profile itself is
// resolved from the listing every caller passes in. Picking one it does not contain is the whole
// subject of 'a Profile that leaves the listing' below.
function profileForm(
  selected: ProviderProfile,
  overrides: Partial<ProviderFormValues> = {},
): ProviderFormValues {
  return form({ profileId: selected.id, ...overrides });
}

function fakeApi() {
  const created = connection({ id: 'conn-new' });
  return {
    listConnections: vi.fn(async () => [connection()]),
    listProfiles: vi.fn(async () => [profile()]),
    createProfileConnection: vi.fn(async () => created),
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
      // The official Providers keep their own endpoints; none of them may fall through to the
      // generic Profile API just because that API now exists.
      expect(api.createProfileConnection).not.toHaveBeenCalled();
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

describe('Provider Profile selection', () => {
  const listed = [profile(), profile({ id: 'other-compat', displayName: 'Other 互換API' })];

  it('takes a listed Profile and ignores a value no listing offered', () => {
    const chosen = applyProviderSelection(form(), `${PROFILE_OPTION_PREFIX}other-compat`, listed);
    expect(chosen.profileId).toBe('other-compat');
    expect(selectedProviderProfile(chosen, listed)?.displayName).toBe('Other 互換API');
    // A Profile id Main never listed, and a fixed key that does not exist, both leave the form as
    // it was rather than arming a create against an unknown Provider.
    const ghost = `${PROFILE_OPTION_PREFIX}ghost`;
    expect(applyProviderSelection(chosen, ghost, listed)).toEqual(chosen);
    expect(applyProviderSelection(chosen, 'not-a-provider', listed)).toEqual(chosen);
  });

  it('clears the per-Profile fields when the selection changes, in both directions', () => {
    const filled = form({
      profileId: 'example-compat',
      baseUrl: 'https://x.test',
      accountId: 'acct-1',
    });
    const next = applyProviderSelection(filled, `${PROFILE_OPTION_PREFIX}other-compat`, listed);
    expect(next).toMatchObject({ profileId: 'other-compat', baseUrl: '', accountId: '' });
    expect(applyProviderSelection(filled, 'anthropic', listed)).toMatchObject({
      provider: 'anthropic',
      profileId: null,
      baseUrl: '',
      accountId: '',
    });
  });

  it('requires a declared credential field before the form can be submitted', () => {
    const needsAccount = profile({ requiredCredentialFields: ['account_id'] });
    const offered = [needsAccount];
    expect(profileRequiresAccountId(needsAccount)).toBe(true);
    expect(profileRequiresAccountId(profile())).toBe(false);
    expect(profileRequiresAccountId(null)).toBe(false);
    expect(canSubmitProviderForm(profileForm(needsAccount), false, offered)).toBe(false);
    const blank = profileForm(needsAccount, { accountId: '  ' });
    expect(canSubmitProviderForm(blank, false, offered)).toBe(false);
    const filled = profileForm(needsAccount, { accountId: 'acct-1' });
    expect(canSubmitProviderForm(filled, false, offered)).toBe(true);
    // Still one section, one in-flight slot: a complete Profile form waits like every other.
    expect(canSubmitProviderForm(filled, true, offered)).toBe(false);
    // A Profile that declares nothing extra submits on name and key alone.
    expect(canSubmitProviderForm(profileForm(profile()), false, [profile()])).toBe(true);
  });
});

// The round-1 blocker: a Profile the user had selected disappears from a later, successful listing.
// Resolving that selection to the fixed `provider` underneath it would have created an official
// OpenAI Connection — with the key typed for the Provider that vanished — while the user believed
// their Profile was still selected. Every path below has to refuse instead.
describe('a Profile that leaves the listing', () => {
  const gone = profile();
  const listed = [profile({ id: 'other-compat', displayName: 'Other 互換API' })];

  it('reads as unavailable, not as the fixed Provider sitting underneath it', () => {
    const stale = profileForm(gone, { provider: 'anthropic' });
    expect(providerSelectValue(stale, [gone])).toBe(`${PROFILE_OPTION_PREFIX}${gone.id}`);
    expect(isProviderSelectionUnavailable(stale, [gone])).toBe(false);
    // Same form, a listing without it: the picker must show neither 'anthropic' nor the Profile.
    expect(selectedProviderProfile(stale, listed)).toBeNull();
    expect(isProviderSelectionUnavailable(stale, listed)).toBe(true);
    expect(providerSelectValue(stale, listed)).toBe(PROFILE_UNAVAILABLE_VALUE);
    // Held as a value, never offered as a choice: re-selecting it changes nothing.
    expect(applyProviderSelection(stale, PROFILE_UNAVAILABLE_VALUE, listed)).toEqual(stale);
    // A fixed selection is untouched by all of this.
    expect(isProviderSelectionUnavailable(form({ provider: 'anthropic' }), listed)).toBe(false);
  });

  it('blocks submit until the user picks again', () => {
    const stale = profileForm(gone, { accountId: 'acct-1' });
    expect(canSubmitProviderForm(stale, false, listed)).toBe(false);
    // An omitted listing resolves nothing, so the refusal is also what a caller gets by default.
    expect(canSubmitProviderForm(stale, false)).toBe(false);
    // Choosing explicitly is what unblocks it — and it arrives with no Base URL or Account ID
    // carried over from the Provider that went away.
    const chosen = applyProviderSelection(stale, 'anthropic', listed);
    expect(chosen).toMatchObject({ profileId: null, baseUrl: '', accountId: '' });
    expect(canSubmitProviderForm(chosen, false, listed)).toBe(true);
  });

  it('never reaches a create, least of all the official OpenAI one', async () => {
    const api = fakeApi();
    await expect(createConnection(api, profileForm(gone), listed)).rejects.toThrow();
    // Not the fixed Provider left in the form, and not the generic Profile API either.
    for (const fn of [
      api.createOpenAIConnection,
      api.createProfileConnection,
      api.createOpenRouterConnection,
      api.createAnthropicConnection,
      api.createGeminiConnection,
      api.createXAIConnection,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    // The same form with an empty default listing must not slip through either.
    await expect(createConnection(api, profileForm(gone))).rejects.toThrow();
    expect(api.createOpenAIConnection).not.toHaveBeenCalled();
  });

  it('drops the key and every per-Provider field once the new listing is in', () => {
    const stale = profileForm(gone, {
      baseUrl: 'https://x.test',
      accountId: 'acct-1',
      organizationId: 'org-1',
      projectId: 'proj-1',
    });
    const cleared = clearUnavailableProfileInput(stale, listed);
    expect(cleared).toEqual(
      profileForm(gone, {
        apiKey: '',
        baseUrl: '',
        accountId: '',
        organizationId: '',
        projectId: '',
      }),
    );
    // The display name is neither a credential nor Provider-specific, so it stays; the selection
    // stays unresolvable, which is what keeps the notice up and submit refused.
    expect(cleared.displayName).toBe('本番');
    expect(canSubmitProviderForm(cleared, false, listed)).toBe(false);
    // Nothing to clear leaves the very same object, for a Profile still listed and for a fixed one.
    const stillListed = profileForm(listed[0]);
    expect(clearUnavailableProfileInput(stillListed, listed)).toBe(stillListed);
    const fixed = form();
    expect(clearUnavailableProfileInput(fixed, [])).toBe(fixed);
  });

  it('describes the picker by whichever notices are on screen', () => {
    const off = { profilesFailed: false, selectionUnavailable: false };
    expect(providerSelectDescribedBy(off)).toBeUndefined();
    expect(providerSelectDescribedBy({ ...off, profilesFailed: true })).toBe(PROFILE_WARNING_ID);
    expect(providerSelectDescribedBy({ ...off, selectionUnavailable: true })).toBe(
      SELECTION_UNAVAILABLE_ID,
    );
    // Both can stand at once: a listing that failed keeps the last good one, which may already
    // have retired the selection.
    expect(providerSelectDescribedBy({ profilesFailed: true, selectionUnavailable: true })).toBe(
      `${SELECTION_UNAVAILABLE_ID} ${PROFILE_WARNING_ID}`,
    );
  });

  it('tells the user what happened without naming the Provider that went away', () => {
    expect(PROFILE_UNAVAILABLE_NOTICE).toContain('選び直');
    expect(PROFILE_UNAVAILABLE_NOTICE).toContain('消去');
    expect(PROFILE_UNAVAILABLE_OPTION_LABEL).not.toContain(gone.displayName);
  });
});

describe('createConnection for a Provider Profile', () => {
  it('sends the Profile id through the one generic API, with the name trimmed', async () => {
    const api = fakeApi();
    const chosen = profile();
    await createConnection(api, profileForm(chosen, { displayName: '  本番  ' }), [chosen]);
    expect(api.createProfileConnection).toHaveBeenCalledWith({
      profileId: 'example-compat',
      displayName: '本番',
      apiKey: FAKE_KEY,
    });
    for (const fn of [api.createOpenAIConnection, api.createAnthropicConnection]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('omits fields the Profile does not declare, however the form was filled in', async () => {
    const api = fakeApi();
    const chosen = profile();
    // Values left over from an earlier selection must not reach a Provider that declares neither.
    await createConnection(
      api,
      profileForm(chosen, {
        baseUrl: 'https://typed.test/v1',
        accountId: 'acct-1',
        organizationId: 'org-1',
      }),
      [chosen],
    );
    expect(api.createProfileConnection).toHaveBeenCalledWith({
      profileId: 'example-compat',
      displayName: '本番',
      apiKey: FAKE_KEY,
    });
  });

  it('sends Base URL only when the Profile allows one, and never as an empty string', async () => {
    const configurable = profile({ baseUrlConfigurable: true });
    const blank = fakeApi();
    await createConnection(blank, profileForm(configurable, { baseUrl: '   ' }), [configurable]);
    expect(blank.createProfileConnection).toHaveBeenCalledWith({
      profileId: 'example-compat',
      displayName: '本番',
      apiKey: FAKE_KEY,
    });
    const custom = fakeApi();
    await createConnection(custom, profileForm(configurable, { baseUrl: ' https://x.test/v1 ' }), [
      configurable,
    ]);
    expect(custom.createProfileConnection).toHaveBeenCalledWith({
      profileId: 'example-compat',
      displayName: '本番',
      apiKey: FAKE_KEY,
      baseUrl: 'https://x.test/v1',
    });
  });

  it('sends the Account ID trimmed when the Profile requires it', async () => {
    const api = fakeApi();
    const chosen = profile({ requiredCredentialFields: ['account_id'], baseUrlConfigurable: true });
    await createConnection(api, profileForm(chosen, { accountId: ' acct-1 ' }), [chosen]);
    expect(api.createProfileConnection).toHaveBeenCalledWith({
      profileId: 'example-compat',
      displayName: '本番',
      apiKey: FAKE_KEY,
      accountId: 'acct-1',
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

describe('Pack independence', () => {
  it('names no Pack A Provider anywhere in the component source', () => {
    // Profiles arrive from Main at runtime. If a vendor id or a company-specific create branch
    // ever appears here, adding the next Pack stops being a Main-only change.
    const source = readFileSync(new URL('./ProviderSettingsSection.tsx', import.meta.url), 'utf8');
    for (const vendor of ['mistral', 'deepseek', 'groq']) {
      expect(source.toLowerCase()).not.toContain(vendor);
    }
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
    const copy = [LIST_ERROR, CREATE_ERROR, VERIFY_ERROR, PROFILE_LIST_WARNING];
    for (const message of [...copy, PROFILE_UNAVAILABLE_NOTICE]) {
      expect(message).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(message).not.toContain('${');
      expect(message).not.toMatch(/Error|http|undefined/i);
    }
  });
});
