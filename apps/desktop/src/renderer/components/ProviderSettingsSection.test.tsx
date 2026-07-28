import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CONCURRENCY_AUTO_TEXT,
  CONCURRENCY_LABEL,
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
  RATE_LIMIT_ERROR,
  SECTION_DESCRIPTION,
  SELECTION_UNAVAILABLE_ID,
  VERIFICATION_LABEL,
  VERIFICATION_TONE,
  VERIFY_ERROR,
  applyProviderSelection,
  canLowerConcurrencyLimit,
  canSubmitProviderForm,
  clearUnavailableProfileInput,
  concurrencyDraftValue,
  concurrencyInputDefault,
  concurrencyLimitHint,
  concurrencyLimitText,
  connectionKindLabel,
  createConnection,
  effectiveConcurrencyLimit,
  isExternalConnection,
  isLoweringConcurrency,
  isProviderSelectionUnavailable,
  isSectionBusy,
  lowerConcurrencyLimit,
  parseConcurrencyLimit,
  profileRequiresAccountId,
  providerSelectDescribedBy,
  providerSelectValue,
  rateLimitLoweringApi,
  selectedProviderProfile,
  supportsRateLimitLowering,
  upsertConnection,
  type ProviderFormValues,
} from './ProviderSettingsSection';
import type {
  ProviderConnection,
  ProviderConnectionRateLimitLowerInput,
  ProviderProfile,
  ProviderVerificationStatus,
} from '@sprint-coder/contracts';

// Every key in this file is a fake literal. Nothing here reads a real credential.
const FAKE_KEY = 'sk-test-not-a-real-key';

// An unobserved ceiling by default — the state Main starts every Connection in, and the one the
// concurrency control has to read as its own default rather than as "unlimited".
function rateLimit(
  overrides: Partial<ProviderConnection['rateLimit']> = {},
): ProviderConnection['rateLimit'] {
  return {
    mode: 'auto',
    maxConcurrentRequests: null,
    requestsPerMinute: null,
    tokensPerMinute: null,
    lastObservedRateLimitHeaders: null,
    ...overrides,
  };
}

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: 'conn-1',
    providerId: 'openai',
    runtimeKind: 'official_api',
    displayName: '本番 OpenAI',
    enabled: true,
    secretReference: 'provider-secret:11111111-2222-4333-8444-555555555555',
    verification: { status: 'verified', verifiedAt: null, expiresAt: null, message: null },
    rateLimit: rateLimit(),
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
    curatedModels: [],
    verificationModel: null,
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

// A Main with the rate-limit IPC wired. `fakeApi` above deliberately lacks it: a build that
// predates the method is a real shape this screen has to survive, and is what the capability check
// below is for. Main's own answer is what comes back, never the number that was typed.
function fakeRateLimitApi() {
  const lowered = connection({
    rateLimit: rateLimit({ mode: 'manual', maxConcurrentRequests: 1 }),
  });
  return {
    ...fakeApi(),
    lowerRateLimits: vi.fn(async (input: ProviderConnectionRateLimitLowerInput) => ({
      ...lowered,
      id: input.connectionId,
    })),
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

  it('counts a rate-limit save, and reads a caller that predates it as plain idle', () => {
    expect(isSectionBusy({ ...idle, savingRateLimitId: 'conn-1' })).toBe(true);
    // Optional on purpose: an omitted flag is 'no save in flight', not a busy section.
    expect(isSectionBusy({ ...idle, savingRateLimitId: null })).toBe(false);
    expect(isSectionBusy(idle)).toBe(false);
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
    const stillListed = profileForm(listed[0]!);
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

// Concurrency is the one rate limit this screen touches, and only downward: a wider ceiling is what
// produces 429s. Every gate below therefore has to refuse a raise, not merely discourage one.
describe('the concurrency limit a card may save', () => {
  it('accepts a plain positive integer and refuses everything else', () => {
    expect(parseConcurrencyLimit('3')).toBe(3);
    expect(parseConcurrencyLimit('  4  ')).toBe(4);
    expect(parseConcurrencyLimit('007')).toBe(7);
    for (const raw of ['', '   ', '0', '-1', '+2', '1.5', '1e2', '2a', 'abc', '２']) {
      expect(parseConcurrencyLimit(raw)).toBeNull();
    }
    // Past Number.isSafeInteger, so it is not a limit anyone can hold Main to.
    expect(parseConcurrencyLimit('9007199254740993')).toBeNull();
  });

  it('names an unobserved ceiling as the default in force, never as unlimited', () => {
    expect(concurrencyLimitText(null)).toBe(CONCURRENCY_AUTO_TEXT);
    expect(concurrencyLimitText(null)).not.toContain('無制限');
    expect(concurrencyLimitText(4)).toBe('4');
    // The field starts at the ceiling in force, so saving an untouched form changes no number.
    expect(concurrencyInputDefault(4)).toBe('4');
    expect(concurrencyInputDefault(null)).toBe('2');
    expect(concurrencyLimitHint(null)).toContain(CONCURRENCY_AUTO_TEXT);
    // The unobserved hint quotes the ceiling the save button actually enforces, not an invitation
    // to type any positive integer.
    expect(concurrencyLimitHint(null)).toContain('2以下');
    expect(concurrencyLimitHint(4)).toContain('4以下');
  });

  it('reads an unobserved ceiling as the built-in default, not as no ceiling', () => {
    expect(effectiveConcurrencyLimit(null)).toBe(2);
    expect(effectiveConcurrencyLimit(4)).toBe(4);
    expect(effectiveConcurrencyLimit(1)).toBe(1);
  });

  it('treats equal as lowering and anything above the ceiling as a raise', () => {
    // The card says 自動（既定2）, so 2 is the ceiling in force: only 1 or 2 is a lowering, and
    // anything above it would widen the effective limit without ever saying so.
    expect(isLoweringConcurrency(null, 1)).toBe(true);
    expect(isLoweringConcurrency(null, 2)).toBe(true);
    expect(isLoweringConcurrency(null, 3)).toBe(false);
    expect(isLoweringConcurrency(null, 9999)).toBe(false);
    expect(isLoweringConcurrency(4, 3)).toBe(true);
    expect(isLoweringConcurrency(4, 4)).toBe(true);
    expect(isLoweringConcurrency(4, 5)).toBe(false);
  });

  it('keeps what was typed until the ceiling itself moves, then shows the new one', () => {
    // Nothing typed yet: the field starts at the ceiling in force, unobserved case included.
    expect(concurrencyDraftValue(null, 4)).toBe('4');
    expect(concurrencyDraftValue(null, null)).toBe('2');
    // Typed against the ceiling still in force — a reload that changed no number must not wipe it,
    // not even a half-finished value the save button already refuses.
    expect(concurrencyDraftValue({ source: 4, value: '3' }, 4)).toBe('3');
    expect(concurrencyDraftValue({ source: 4, value: '' }, 4)).toBe('');
    expect(concurrencyDraftValue({ source: null, value: '1' }, null)).toBe('1');
    // The ceiling moved underneath the draft — this card's own save, or a reload — so the field
    // shows the number now in force rather than the one typed against the old one.
    expect(concurrencyDraftValue({ source: 4, value: '3' }, 1)).toBe('1');
    expect(concurrencyDraftValue({ source: null, value: '1' }, 2)).toBe('2');
    // A ceiling that becomes unobserved reads as the default, never as the stale draft.
    expect(concurrencyDraftValue({ source: 4, value: '3' }, null)).toBe('2');
  });

  it('unpresses the save button for a raise, an unparseable value, or a busy section', () => {
    const idle = { current: 4, input: '3', busy: false };
    expect(canLowerConcurrencyLimit(idle)).toBe(true);
    expect(canLowerConcurrencyLimit({ ...idle, input: '4' })).toBe(true);
    expect(canLowerConcurrencyLimit({ ...idle, input: '5' })).toBe(false);
    expect(canLowerConcurrencyLimit({ ...idle, input: '' })).toBe(false);
    expect(canLowerConcurrencyLimit({ ...idle, input: '0' })).toBe(false);
    expect(canLowerConcurrencyLimit({ current: null, input: '2', busy: false })).toBe(true);
    expect(canLowerConcurrencyLimit({ current: null, input: '1', busy: false })).toBe(true);
    expect(canLowerConcurrencyLimit({ current: null, input: '3', busy: false })).toBe(false);
    expect(canLowerConcurrencyLimit({ current: null, input: '9999', busy: false })).toBe(false);
    // One section, one in-flight slot: this card's own save is part of `busy` too, so a second
    // click cannot start on top of the first.
    expect(canLowerConcurrencyLimit({ ...idle, busy: true })).toBe(false);
    expect(canLowerConcurrencyLimit({ current: null, input: '2', busy: true })).toBe(false);
  });
});

describe('lowerConcurrencyLimit', () => {
  it('sends only the one limit this screen owns, for the Connection that was saved', async () => {
    const api = fakeRateLimitApi();
    const updated = await lowerConcurrencyLimit(
      api,
      connection({
        id: 'conn-7',
        rateLimit: rateLimit({ maxConcurrentRequests: 4 }),
      }),
      ' 3 ',
    );
    expect(api.lowerRateLimits).toHaveBeenCalledWith({
      connectionId: 'conn-7',
      maxConcurrentRequests: 3,
    });
    // The per-minute limits are left untouched rather than resubmitted at their current values.
    const [payload] = api.lowerRateLimits.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual(['connectionId', 'maxConcurrentRequests']);
    // Main's own answer is what the caller gets back, never the number that was typed.
    expect(updated.rateLimit.maxConcurrentRequests).toBe(1);
  });

  it('lets an equal value through, which is how an unobserved ceiling is pinned', async () => {
    const equal = fakeRateLimitApi();
    await lowerConcurrencyLimit(
      equal,
      connection({ rateLimit: rateLimit({ maxConcurrentRequests: 3 }) }),
      '3',
    );
    expect(equal.lowerRateLimits).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      maxConcurrentRequests: 3,
    });
    // An unobserved ceiling is pinned at the default it was already running under, not above it.
    const auto = fakeRateLimitApi();
    await lowerConcurrencyLimit(auto, connection(), '2');
    expect(auto.lowerRateLimits).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      maxConcurrentRequests: 2,
    });
  });

  it('never widens a ceiling, however the save was reached', async () => {
    const api = fakeRateLimitApi();
    const limited = connection({
      rateLimit: rateLimit({ mode: 'manual', maxConcurrentRequests: 2 }),
    });
    await expect(lowerConcurrencyLimit(api, limited, '3')).rejects.toThrow();
    await expect(lowerConcurrencyLimit(api, limited, '9999')).rejects.toThrow();
    // Including the unobserved case, where the ceiling being widened is the built-in default: the
    // card reads 自動（既定2）, so anything above 2 would raise it without ever saying so.
    await expect(lowerConcurrencyLimit(api, connection(), '3')).rejects.toThrow();
    await expect(lowerConcurrencyLimit(api, connection(), '9999')).rejects.toThrow();
    expect(api.lowerRateLimits).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a positive integer before Main ever hears about it', async () => {
    const api = fakeRateLimitApi();
    for (const raw of ['', '   ', '0', '-2', '1.5', 'abc']) {
      await expect(lowerConcurrencyLimit(api, connection(), raw)).rejects.toThrow();
    }
    expect(api.lowerRateLimits).not.toHaveBeenCalled();
  });

  it('refuses a built-in CLI, whose concurrency belongs to Team Policy', async () => {
    const api = fakeRateLimitApi();
    for (const runtimeKind of ['builtin_cli', 'mock'] as const) {
      await expect(lowerConcurrencyLimit(api, connection({ runtimeKind }), '1')).rejects.toThrow();
    }
    expect(api.lowerRateLimits).not.toHaveBeenCalled();
  });

  it('refuses on a Main that never wired the method, rather than calling something absent', async () => {
    const older = fakeApi();
    await expect(lowerConcurrencyLimit(older, connection(), '1')).rejects.toThrow();
    // And it reaches for nothing else in its place.
    expect(older.verifyConnection).not.toHaveBeenCalled();
  });
});

describe('rate-limit capability detection', () => {
  it('is false without an API and on a Main that predates the method', () => {
    expect(supportsRateLimitLowering(null)).toBe(false);
    expect(rateLimitLoweringApi(null)).toBeNull();
    expect(supportsRateLimitLowering(fakeApi())).toBe(false);
    expect(rateLimitLoweringApi(fakeApi())).toBeNull();
  });

  it('is true once Main offers it, and hands back the same API to call', () => {
    const api = fakeRateLimitApi();
    expect(supportsRateLimitLowering(api)).toBe(true);
    expect(rateLimitLoweringApi(api)).toBe(api);
  });
});

describe('the concurrency control on a card', () => {
  const control = { supported: true, saving: false, onSave: () => {} };

  it('labels the field, seeds it with the ceiling in force, and says what may be saved', () => {
    const html = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection({
          rateLimit: rateLimit({ mode: 'manual', maxConcurrentRequests: 4 }),
        })}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
        rateLimit={control}
      />,
    );
    expect(html).toContain(CONCURRENCY_LABEL);
    expect(html).toContain('for="settings-connection-limit-conn-1"');
    expect(html).toContain('data-testid="settings-connection-limit-conn-1"');
    expect(html).toContain('data-testid="settings-connection-limit-conn-1-save"');
    expect(html).toContain('aria-describedby="settings-connection-limit-conn-1-hint"');
    expect(html).toContain('id="settings-connection-limit-conn-1-hint"');
    expect(html).toContain(concurrencyLimitHint(4));
    // Seeded at the ceiling and bounded by it, so the spinner itself cannot reach a raise.
    expect(html).toContain('value="4"');
    expect(html).toContain('max="4"');
    expect(html).toContain('本番 OpenAIの同時実行上限を保存');
  });

  it('offers an unobserved ceiling the built-in default, and bounds the spinner by it', () => {
    const html = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection()}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
        rateLimit={control}
      />,
    );
    expect(html).toContain(concurrencyLimitHint(null));
    expect(html).toContain(CONCURRENCY_AUTO_TEXT);
    expect(html).toContain('value="2"');
    // Bounded by the default in force rather than left open, so the spinner cannot climb to a
    // number the save button refuses.
    expect(html).toContain('max="2"');
  });

  it('goes inert while its own save is in flight, and while the section is busy', () => {
    const saving = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection()}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
        rateLimit={{ ...control, saving: true }}
      />,
    );
    expect(saving).toContain('保存中');
    expect(saving).toMatch(/data-testid="settings-connection-limit-conn-1-save"[^>]*disabled/);
    expect(saving).toMatch(/data-testid="settings-connection-limit-conn-1"[^>]*disabled/);
    const blocked = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection()}
        verifying={false}
        disabled
        onRetry={() => {}}
        rateLimit={control}
      />,
    );
    // Blocked by someone else's operation, so it must not claim to be saving itself.
    expect(blocked).not.toContain('保存中');
    expect(blocked).toMatch(/data-testid="settings-connection-limit-conn-1-save"[^>]*disabled/);
  });

  it('is absent for a built-in CLI and on a Main that cannot lower a limit', () => {
    const cli = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection({
          providerId: 'anthropic',
          runtimeKind: 'builtin_cli',
          displayName: 'Claude CLI',
          secretReference: null,
        })}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
        rateLimit={control}
      />,
    );
    expect(cli).not.toContain(CONCURRENCY_LABEL);
    expect(cli).not.toContain('settings-connection-limit-');
    // Not offered and always failing, but simply not offered.
    const unsupported = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection()}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
        rateLimit={{ ...control, supported: false }}
      />,
    );
    expect(unsupported).not.toContain(CONCURRENCY_LABEL);
    // An omitted control is the same story, and leaves the rest of the card alone.
    const omitted = renderToStaticMarkup(
      <ProviderConnectionCard
        connection={connection()}
        verifying={false}
        disabled={false}
        onRetry={() => {}}
      />,
    );
    expect(omitted).not.toContain(CONCURRENCY_LABEL);
    expect(omitted).toContain('本番 OpenAIの検証を再実行');
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
    const copy = [LIST_ERROR, CREATE_ERROR, VERIFY_ERROR, PROFILE_LIST_WARNING, RATE_LIMIT_ERROR];
    for (const message of [...copy, PROFILE_UNAVAILABLE_NOTICE]) {
      expect(message).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(message).not.toContain('${');
      expect(message).not.toMatch(/Error|http|undefined/i);
    }
  });
});
