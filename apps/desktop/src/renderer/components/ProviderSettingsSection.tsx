import { useEffect, useRef, useState } from 'react';
import type {
  ProviderConnection,
  ProviderConnectionRateLimitLowerInput,
  ProviderProfile,
  ProviderVerificationStatus,
} from '@sprint-coder/contracts';
import { Eye, EyeOff, Plus, X } from './icons';

// Plaintext credentials remain here only until Main accepts them into Secret Storage.
// Raw provider errors and secret references are never rendered.

type CurrentProvidersApi = NonNullable<Window['sprintCoder']>['providers'];
type ProvidersApi = Omit<CurrentProvidersApi, 'lowerRateLimits' | 'setAutomaticModelRelease'> & {
  lowerRateLimits?: CurrentProvidersApi['lowerRateLimits'];
  setAutomaticModelRelease?: CurrentProvidersApi['setAutomaticModelRelease'];
};

/** Null whenever this build of Main has not wired the provider IPC, per the contract's
 * runtime-check rule. Module scope so the effect below can see it is not a reactive value. */
function providerApi(): ProvidersApi | null {
  if (typeof window === 'undefined') return null;
  const api = window.sprintCoder?.providers;
  return typeof api?.listConnections === 'function' ? api : null;
}

/** Both loaders are `async` so that a synchronous throw also arrives as a rejection, which is what
 * the `Promise.allSettled` in `refresh` reads. */
async function loadConnections(api: ProvidersApi): Promise<ProviderConnection[]> {
  return api.listConnections();
}

/** A build of Main that never wired the Profile IPC has no Profiles to offer. That is an empty
 * list rather than a failure: there is nothing for the user to retry, and the fixed official
 * Providers below are unaffected either way. */
async function loadProfiles(api: ProvidersApi): Promise<ProviderProfile[]> {
  if (typeof api.listProfiles !== 'function') return [];
  return api.listProfiles();
}

/** The runtime check keeps an older Main/Preload usable: it offers no control rather than a save
 * button that throws when `lowerRateLimits` is absent. */
type RateLimitLoweringApi = {
  lowerRateLimits(input: ProviderConnectionRateLimitLowerInput): Promise<ProviderConnection>;
};

export function rateLimitLoweringApi(api: ProvidersApi | null): RateLimitLoweringApi | null {
  if (api === null) return null;
  const candidate: unknown = api;
  const method = (candidate as { lowerRateLimits?: unknown }).lowerRateLimits;
  return typeof method === 'function' ? (candidate as RateLimitLoweringApi) : null;
}

export function supportsRateLimitLowering(api: ProvidersApi | null): boolean {
  return rateLimitLoweringApi(api) !== null;
}

type ModelReleaseApi = Pick<CurrentProvidersApi, 'setAutomaticModelRelease'>;

function modelReleaseApi(api: ProvidersApi | null): ModelReleaseApi | null {
  return typeof api?.setAutomaticModelRelease === 'function' ? (api as ModelReleaseApi) : null;
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

export const LIST_ERROR = '接続一覧を取得できませんでした。再読み込みしてください。';
export const CREATE_ERROR = '接続を追加できませんでした。入力内容を確認してください。';
export const VERIFY_ERROR = '検証を実行できませんでした。時間をおいて再試行してください。';
// A Profile listing failure is not fatal: the fixed Providers below still work, so this is a
// warning beside the picker rather than the section's error alert.
export const PROFILE_LIST_WARNING =
  'Provider Profileの一覧を取得できませんでした。公式Providerはこのまま追加できます。';
// Said out loud because the alternative is a silent one: a Profile that leaves the listing would
// otherwise leave the form pointing at its fixed Provider, holding the key typed for the other one.
export const PROFILE_UNAVAILABLE_NOTICE =
  '選択していたプロバイダープロファイルは利用できなくなりました。入力したAPIキーなどは消去しました。プロバイダーを選び直してください。';
export const RATE_LIMIT_ERROR =
  '同時実行上限を変更できませんでした。値を確認して再試行してください。';
export const MODEL_RELEASE_ERROR =
  'モデルの自動解放設定を変更できませんでした。再試行してください。';
export const UNSUPPORTED_TEXT = 'この環境ではプロバイダー設定APIが利用できません。';
export const LOADING_TEXT = '接続を読み込んでいます。';
export const EMPTY_TEXT = '登録済みの接続はまだありません。';

// Rule 1's boundary in user-facing words: the screen forgets the key, Main keeps it safely. Said
// once, beside the field it is about, rather than twice in two lengths — the section's own
// description now says what the section is for and nothing else.
export const SECTION_DESCRIPTION = '組み込みCLIと外部APIの接続先を管理します。';
export const KEY_BOUNDARY_HINT =
  '入力したキーは送信後に画面から消去し、Mainプロセスが端末の安全な保管領域へ保存します。';

export const PROVIDER_FORM_OPTIONS = [
  { key: 'openai', label: 'OpenAI API', scoped: true },
  { key: 'openrouter', label: 'OpenRouter API', scoped: false },
  { key: 'anthropic', label: 'Anthropic API', scoped: false },
  { key: 'google', label: 'Google Gemini API', scoped: false },
  { key: 'xai', label: 'xAI API', scoped: false },
] as const;

export type ProviderFormKey = (typeof PROVIDER_FORM_OPTIONS)[number]['key'];

/** Profiles are Main's data, not the Renderer's: this screen knows only what a Profile declares
 * about itself, never which company is behind it. The one <select> carries both kinds of choice,
 * so Profile options are namespaced against a Profile id that matches a fixed key. */
export const PROFILE_OPTION_PREFIX = 'profile:';
export const PROFILE_GROUP_LABEL = 'Provider Profile（OpenAI互換）';
export const BASE_URL_HINT = '空欄のままにすると、Providerの既定のエンドポイントを使用します。';

/** The picker's value while the selected Profile is gone: not a choice anyone can make, only the
 * current value of a disabled <option>, so the select never reads as a Provider the user did not
 * pick. Outside the Profile namespace and unlike every fixed key, so `applyProviderSelection`
 * turns it away like any other value no listing offered. */
export const PROFILE_UNAVAILABLE_VALUE = 'profile-unavailable';
export const PROFILE_UNAVAILABLE_OPTION_LABEL = 'Provider未選択';
export const PROFILE_WARNING_ID = 'settings-provider-profile-warning';
export const SELECTION_UNAVAILABLE_ID = 'settings-provider-unavailable';

/** The add form is progressive disclosure, not a second screen: one button in the same settings
 * pane expands it in place, and the same button collapses it again. No nested modal — this whole
 * section is already inside the settings dialog, and a dialog on a dialog steals the focus trap. */
export const ADD_TOGGLE_ID = 'settings-provider-add-toggle';
export const ADD_FORM_PANEL_ID = 'settings-provider-add-form';
export const ADD_CONNECTION_LABEL = '接続を追加';
export const ADD_CONNECTION_CLOSE_LABEL = '追加をやめる';
export const CANCEL_LABEL = 'キャンセル';
export const SUBMIT_LABEL = '追加して検証';
export const SUBMITTING_LABEL = '追加中';
/** Optional, provider-specific extras only. Anything a Provider *requires* stays in the basic three
 * above it — a required field folded out of sight is a form that cannot be submitted and does not
 * say why. */
export const ADVANCED_SUMMARY_LABEL = '詳細設定';
export const KEY_HINT_ID = 'settings-provider-api-key-hint';
export const SUBMIT_HINT_ID = 'settings-provider-submit-hint';
export const CONNECTION_LIST_LABEL = '登録済みの接続';

export type ProviderFormValues = {
  /** Read only while `profileId` is null. */
  provider: ProviderFormKey;
  /** A Main-provided Profile picked from `listProfiles`; null selects a fixed Provider. */
  profileId: string | null;
  displayName: string;
  apiKey: string;
  organizationId: string;
  projectId: string;
  baseUrl: string;
  accountId: string;
};

const EMPTY_FORM: ProviderFormValues = {
  provider: 'openai',
  profileId: null,
  displayName: '',
  apiKey: '',
  organizationId: '',
  projectId: '',
  baseUrl: '',
  accountId: '',
};

/** The Profile behind the current selection: null both when a fixed Provider is selected and when
 * the selected Profile has left the listing. A null alone therefore does not mean "fixed Provider"
 * — every caller that could act on it asks `isProviderSelectionUnavailable` first. */
export function selectedProviderProfile(
  form: ProviderFormValues,
  profiles: readonly ProviderProfile[],
): ProviderProfile | null {
  if (form.profileId === null) return null;
  return profiles.find((profile) => profile.id === form.profileId) ?? null;
}

/** A Profile the user picked that the current listing no longer offers. Reading such a selection as
 * the form's fixed `provider` would arm a create nobody asked for — normally OpenAI, carrying the
 * key typed for the Provider that vanished — so it is held as unavailable instead, and everything
 * downstream refuses until the user picks again. `profiles` defaults to empty so that the refusal
 * is what a caller gets by omission: without a listing, no Profile can resolve. */
export function isProviderSelectionUnavailable(
  form: ProviderFormValues,
  profiles: readonly ProviderProfile[] = [],
): boolean {
  return form.profileId !== null && selectedProviderProfile(form, profiles) === null;
}

export function providerSelectValue(
  form: ProviderFormValues,
  profiles: readonly ProviderProfile[],
): string {
  if (isProviderSelectionUnavailable(form, profiles)) return PROFILE_UNAVAILABLE_VALUE;
  const profile = selectedProviderProfile(form, profiles);
  return profile === null ? form.provider : `${PROFILE_OPTION_PREFIX}${profile.id}`;
}

/** The picker points at whichever notices are on screen, in the order they are rendered; an absent
 * attribute beats one aimed at an element that is not there. */
export function providerSelectDescribedBy(state: {
  profilesFailed: boolean;
  selectionUnavailable: boolean;
}): string | undefined {
  const ids = [
    state.selectionUnavailable ? SELECTION_UNAVAILABLE_ID : null,
    state.profilesFailed ? PROFILE_WARNING_ID : null,
  ].filter((id): id is string => id !== null);
  return ids.length === 0 ? undefined : ids.join(' ');
}

/** Accepts only a known fixed key or a listed Profile id, so a stale <option> cannot leave an
 * unknown Provider in the form. Switching clears the per-Profile fields: a Base URL or Account ID
 * typed for one Provider must never travel to the next one. */
export function applyProviderSelection(
  form: ProviderFormValues,
  value: string,
  profiles: readonly ProviderProfile[],
): ProviderFormValues {
  if (value.startsWith(PROFILE_OPTION_PREFIX)) {
    const profileId = value.slice(PROFILE_OPTION_PREFIX.length);
    if (!profiles.some((profile) => profile.id === profileId)) return form;
    return { ...form, profileId, baseUrl: '', accountId: '' };
  }
  const option = PROVIDER_FORM_OPTIONS.find((candidate) => candidate.key === value);
  if (option === undefined) return form;
  return { ...form, provider: option.key, profileId: null, baseUrl: '', accountId: '' };
}

/** Run against a listing that came back successfully. What the user typed for a Provider that has
 * just been withdrawn is dropped — key first — so none of it can be reused by whichever Provider is
 * picked next. The unresolvable selection itself is kept on purpose: it is what the picker shows as
 * unavailable and what keeps submit blocked, rather than quietly landing on a fixed Provider. The
 * display name is neither a credential nor Provider-specific, so it survives. Returns the same
 * object when there is nothing to clear. */
export function clearUnavailableProfileInput(
  form: ProviderFormValues,
  profiles: readonly ProviderProfile[],
): ProviderFormValues {
  if (!isProviderSelectionUnavailable(form, profiles)) return form;
  return { ...form, apiKey: '', organizationId: '', projectId: '', baseUrl: '', accountId: '' };
}

/** A declared credential field has no default, so the form collects it instead of letting Main
 * reject the call. Base URL stays optional: blank means the Profile's own endpoint. */
export function profileRequiresAccountId(profile: ProviderProfile | null): boolean {
  return profile !== null && profile.requiredCredentialFields.includes('account_id');
}

export function profileRequiresApiKey(profile: ProviderProfile | null): boolean {
  return profile === null || profile.requiredCredentialFields.includes('api_key');
}

/** A Connection whose credentials Main can re-check. Built-in CLIs authenticate themselves. */
export function isExternalConnection(connection: ProviderConnection): boolean {
  return (
    connection.runtimeKind === 'official_api' || connection.runtimeKind === 'openai_compatible'
  );
}

// Concurrency is the one rate limit this screen touches, and only downward. A wider ceiling is what
// produces 429s, so nothing here raises one: there is no control for it, and the save path refuses.
export const CONCURRENCY_LABEL = '同時実行上限';
export const CONCURRENCY_AUTO_TEXT = '自動（既定2）';
export const CONCURRENCY_DEFAULT_INPUT = 2;

/** The number actually in force. A null is not "no ceiling": Main has simply not observed a limit
 * yet and is running its built-in default of 2 until it does, so 2 is what every rule below
 * compares against. Reading a null as "anything goes" would let this screen raise the effective
 * ceiling — the one thing it must not do — while the card still reads 自動（既定2）. */
export function effectiveConcurrencyLimit(current: number | null): number {
  return current ?? CONCURRENCY_DEFAULT_INPUT;
}

/** What the ceiling in force reads as. A null is named as the default it is really running under,
 * never as "unlimited". */
export function concurrencyLimitText(current: number | null): string {
  return current === null ? CONCURRENCY_AUTO_TEXT : String(current);
}

/** The field starts at the ceiling in force, so saving an untouched form changes no number. */
export function concurrencyInputDefault(current: number | null): string {
  return String(effectiveConcurrencyLimit(current));
}

/** Says both what is in force now and what may be saved. The unobserved case quotes the default it
 * is running under, so the number here is the same one the save button enforces. */
export function concurrencyLimitHint(current: number | null): string {
  return current === null
    ? `現在は${CONCURRENCY_AUTO_TEXT}です。${CONCURRENCY_DEFAULT_INPUT}以下の整数だけを保存できます。`
    : `現在の上限は${current}です。${current}以下の整数だけを保存できます。`;
}

/** Only a plain positive integer. Blank, a sign, a decimal, an exponent — none of them is a limit,
 * and a null keeps every one of them away from both the save button and Main. */
export function parseConcurrencyLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** The one rule both the button and the save path read, so neither can drift from the other: a
 * value at or below the ceiling in force, an unobserved one included — that ceiling is the built-in
 * default, so only 1 or 2 gets through. Equal is allowed: it is not a raise, and it is how an
 * unobserved ceiling is pinned to the number the card has been showing all along. */
export function isLoweringConcurrency(current: number | null, next: number): boolean {
  return next <= effectiveConcurrencyLimit(current);
}

/** What the user has typed, tagged with the ceiling it was typed against. Null until they type. */
export type ConcurrencyDraft = { source: number | null; value: string } | null;

/** What the field shows, derived rather than reset by an effect: the draft for as long as the
 * ceiling it was typed against is still the one in force, and that ceiling's own default otherwise.
 * A ceiling that moved underneath the field — this card's own save, or a reload — therefore retires
 * the draft on the very next render, while a reload that changed nothing leaves typing alone. */
export function concurrencyDraftValue(draft: ConcurrencyDraft, current: number | null): string {
  if (draft === null || draft.source !== current) return concurrencyInputDefault(current);
  return draft.value;
}

/** `busy` is the whole section's in-flight state, this card's own save included, so a second save
 * cannot start on top of the first. */
export function canLowerConcurrencyLimit(state: {
  current: number | null;
  input: string;
  busy: boolean;
}): boolean {
  if (state.busy) return false;
  const next = parseConcurrencyLimit(state.input);
  return next !== null && isLoweringConcurrency(state.current, next);
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
  /** Optional so a caller written before the concurrency control still reads as plain idle. */
  savingRateLimitId?: string | null;
  savingModelReleaseId?: string | null;
}): boolean {
  return (
    state.loading ||
    state.submitting ||
    state.verifyingId !== null ||
    (state.savingRateLimitId ?? null) !== null ||
    (state.savingModelReleaseId ?? null) !== null
  );
}

/** `busy` is the whole section's in-flight state, not just this form's: a create issued while a
 * list reload or a verification is still running would resolve into a list about to be replaced.
 * The Profile is resolved here from the listing rather than accepted ready-made, so a selection the
 * listing has dropped blocks submit instead of arriving as an innocent-looking null. */
export function canSubmitProviderForm(
  form: ProviderFormValues,
  busy: boolean,
  profiles: readonly ProviderProfile[] = [],
): boolean {
  if (busy || form.displayName.trim() === '') return false;
  if (isProviderSelectionUnavailable(form, profiles)) return false;
  const profile = selectedProviderProfile(form, profiles);
  if (profileRequiresApiKey(profile) && form.apiKey === '') return false;
  return !profileRequiresAccountId(profile) || form.accountId.trim() !== '';
}

/** Why the submit is unpressable, in the user's words, or null when it is pressable. The one gate is
 * still `canSubmitProviderForm`; this only names its refusal, and the two are kept in step by
 * returning null exactly when that function returns true. A disabled button with no stated reason
 * is the form telling the user to guess. */
export const SUBMIT_BLOCKED_SELECTION = 'プロバイダーを選び直すと追加できます。';
export const SUBMIT_BLOCKED_INPUT = '表示名とAPIキーを入力すると追加できます。';
export const SUBMIT_BLOCKED_NAME = '表示名を入力すると追加できます。';
export const SUBMIT_BLOCKED_ACCOUNT_ID = 'このプロバイダーはアカウントIDが必須です。';
export const SUBMIT_BLOCKED_BUSY = '他の処理が終わるまでお待ちください。';

export function providerSubmitBlockedReason(
  form: ProviderFormValues,
  busy: boolean,
  profiles: readonly ProviderProfile[] = [],
): string | null {
  if (isProviderSelectionUnavailable(form, profiles)) return SUBMIT_BLOCKED_SELECTION;
  const profile = selectedProviderProfile(form, profiles);
  if (form.displayName.trim() === '')
    return profileRequiresApiKey(profile) ? SUBMIT_BLOCKED_INPUT : SUBMIT_BLOCKED_NAME;
  if (profileRequiresApiKey(profile) && form.apiKey === '') return SUBMIT_BLOCKED_INPUT;
  if (profileRequiresAccountId(profile) && form.accountId.trim() === '') {
    return SUBMIT_BLOCKED_ACCOUNT_ID;
  }
  return busy ? SUBMIT_BLOCKED_BUSY : null;
}

/** Whether the 詳細設定 disclosure has anything to hold. Only optional extras count, so a Provider
 * that asks for nothing beyond the basic three shows no empty disclosure at all. */
export function hasOptionalProviderFields(state: {
  scopedFixedProvider: boolean;
  baseUrlConfigurable: boolean;
}): boolean {
  return state.scopedFixedProvider || state.baseUrlConfigurable;
}

export function providerCreateErrorMessage(error: unknown): string {
  if (String(error).includes('OSの安全な保管領域を利用できません'))
    return '接続を追加できませんでした。OSの安全な保管領域を利用できません。macOSのログインキーチェーンを確認してから再試行してください。';
  if (error !== null && typeof error === 'object') {
    const record = error as { code?: unknown };
    if (typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(record.code))
      return `${CREATE_ERROR}（コード: ${record.code}）`;
  }
  return CREATE_ERROR;
}

/** Dispatches to the per-provider create method. Optional fields are omitted, never sent empty.
 * Every Profile goes through the single generic API, so adding a Provider to Pack A stays a Main
 * change: there is no company-specific branch here to extend. */
export async function createConnection(
  api: ProvidersApi,
  form: ProviderFormValues,
  profiles: readonly ProviderProfile[] = [],
): Promise<ProviderConnection> {
  // The last gate, after the disabled submit: a withdrawn Profile has no create of its own and
  // must not fall through to the fixed Provider still sitting in the form. Rejecting reaches the
  // caller as the section's generic create error; this text is never rendered.
  if (isProviderSelectionUnavailable(form, profiles)) {
    throw new Error('the selected provider profile is no longer available');
  }
  const profile = selectedProviderProfile(form, profiles);
  const displayName = form.displayName.trim();
  const apiKey = form.apiKey;
  if (profile !== null) {
    const baseUrl = form.baseUrl.trim();
    const accountId = form.accountId.trim();
    const apiKey = form.apiKey;
    return api.createProfileConnection({
      profileId: profile.id,
      displayName,
      ...(apiKey === '' ? {} : { apiKey }),
      // Only what this Profile declares it takes. The input contract is strict, and a field the
      // Provider has no concept of would be rejected outright.
      ...(profile.baseUrlConfigurable && baseUrl !== '' ? { baseUrl } : {}),
      ...(profileRequiresAccountId(profile) && accountId !== '' ? { accountId } : {}),
    });
  }
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

/** The last gate before Main, behind the disabled save button: a built-in CLI, a value that is not
 * a positive integer, and above all a raise are each refused here too, so no path through this
 * screen can widen a ceiling. Rejecting reaches the caller as the section's generic rate-limit
 * error; none of these messages is ever rendered. Only the one limit this screen owns is sent —
 * the per-minute limits are left untouched rather than resubmitted at their current values. */
export async function lowerConcurrencyLimit(
  api: ProvidersApi,
  connection: ProviderConnection,
  input: string,
): Promise<ProviderConnection> {
  if (!isExternalConnection(connection)) {
    throw new Error('built-in CLI concurrency is not set from this screen');
  }
  const next = parseConcurrencyLimit(input);
  if (next === null) throw new Error('the concurrency limit must be a positive integer');
  if (!isLoweringConcurrency(connection.rateLimit.maxConcurrentRequests, next)) {
    throw new Error('this screen can only lower a provider concurrency limit');
  }
  const lowering = rateLimitLoweringApi(api);
  if (lowering === null) throw new Error('this build of Main cannot lower provider rate limits');
  return lowering.lowerRateLimits({ connectionId: connection.id, maxConcurrentRequests: next });
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

export type ConnectionRateLimitControl = {
  /** False on a Main that never wired the rate-limit IPC: the control is then not offered at all,
   * rather than offered and always failing. */
  supported: boolean;
  saving: boolean;
  /** Takes the field as typed; `lowerConcurrencyLimit` is what reads it, so the refusal rules live
   * in one place instead of being re-implemented per caller. */
  onSave: (connection: ProviderConnection, input: string) => void;
};

export type ConnectionModelReleaseControl = {
  saving: boolean;
  onChange: (connection: ProviderConnection, enabled: boolean) => void;
};

export function ProviderConnectionCard({
  connection,
  verifying,
  disabled,
  onRetry,
  rateLimit,
  modelRelease,
}: {
  connection: ProviderConnection;
  verifying: boolean;
  disabled: boolean;
  onRetry: (connection: ProviderConnection) => void;
  /** Omitted wherever the concurrency control is not wired; the rest of the card is unaffected. */
  rateLimit?: ConnectionRateLimitControl;
  modelRelease?: ConnectionModelReleaseControl;
}) {
  const status = connection.verification.status;
  const currentLimit = connection.rateLimit.maxConcurrentRequests;
  const [limitDraft, setLimitDraft] = useState<ConcurrencyDraft>(null);
  // Keyed on the stored number, so a ceiling that moved underneath the field is what the field then
  // shows, while typing survives a reload that changed nothing. No effect, so no reset frame either.
  const limitInput = concurrencyDraftValue(limitDraft, currentLimit);
  // Only where Main can re-check credentials, which is also the only place Main accepts a limit:
  // a built-in CLI's concurrency belongs to Team Policy, and it is not offered here.
  const limitControl =
    isExternalConnection(connection) && rateLimit?.supported === true ? rateLimit : null;
  const savingLimit = limitControl?.saving === true;
  const limitInputId = `settings-connection-limit-${connection.id}`;
  const limitHintId = `${limitInputId}-hint`;
  return (
    <li className="settings-connection-card" data-testid={`settings-connection-${connection.id}`}>
      <span className="settings-connection-main">
        <strong>{connection.displayName}</strong>
        <small>
          {connectionKindLabel(connection)}
          {connection.enabled ? '' : ' · 無効'}
        </small>
        {limitControl !== null && (
          <span className="settings-field">
            <label className="settings-field-label" htmlFor={limitInputId}>
              {CONCURRENCY_LABEL}
            </label>
            <span className="settings-key-row">
              <input
                id={limitInputId}
                data-testid={limitInputId}
                type="number"
                className="settings-text-input"
                inputMode="numeric"
                min={1}
                // Bounded by the ceiling in force — the built-in default while none has been
                // observed — so the spinner cannot reach a value the save button would refuse.
                max={effectiveConcurrencyLimit(currentLimit)}
                step={1}
                aria-describedby={limitHintId}
                disabled={disabled || savingLimit}
                value={limitInput}
                onChange={(e) => setLimitDraft({ source: currentLimit, value: e.target.value })}
              />
              <button
                type="button"
                className="settings-secondary-button"
                data-testid={`${limitInputId}-save`}
                aria-label={`${connection.displayName}の${CONCURRENCY_LABEL}を保存`}
                disabled={
                  !canLowerConcurrencyLimit({
                    current: currentLimit,
                    input: limitInput,
                    busy: disabled || savingLimit,
                  })
                }
                onClick={() => limitControl.onSave(connection, limitInput)}
              >
                {savingLimit ? '保存中' : '保存'}
              </button>
            </span>
            <span className="settings-hint" id={limitHintId}>
              {concurrencyLimitHint(currentLimit)}
            </span>
          </span>
        )}
        {connection.providerId === 'ollama' &&
          connection.runtimeKind === 'openai_compatible' &&
          modelRelease !== undefined && (
            <label className="settings-field settings-provider-model-release">
              <span className="settings-field-label">モデルを使用後に自動解放</span>
              <input
                type="checkbox"
                data-testid={`settings-connection-model-release-${connection.id}`}
                checked={connection.automaticModelRelease !== false}
                disabled={disabled || modelRelease.saving}
                onChange={(event) => modelRelease.onChange(connection, event.target.checked)}
              />
              <span className="settings-hint">ローカルOllama接続だけに適用されます。</span>
            </label>
          )}
      </span>
      {/* A fact about the Connection, not a control. Deliberately a plain <span> with no border,
          no fill and no role: 「確認不要」is not something anyone can press, and dressing it as a
          chip put it in the same visual family as 検証を再実行 right beside it. */}
      <span
        className={`settings-connection-badge tone-${VERIFICATION_TONE[status]}`}
        data-testid={`settings-connection-badge-${connection.id}`}
      >
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

/** The add form, split out so it can be rendered — and tested — in the one state the section itself
 * never starts in: open. Every value it edits belongs to the section, plaintext key included, so
 * closing the disclosure is what clears it. */
export function ProviderAddConnectionForm({
  form,
  profiles,
  profilesFailed,
  busy,
  submitting,
  showKey,
  onChange,
  onToggleKey,
  onSubmit,
  onCancel,
}: {
  form: ProviderFormValues;
  profiles: readonly ProviderProfile[];
  profilesFailed: boolean;
  busy: boolean;
  submitting: boolean;
  showKey: boolean;
  onChange: (update: (current: ProviderFormValues) => ProviderFormValues) => void;
  onToggleKey: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const selectedProfile = selectedProviderProfile(form, profiles);
  const selectionUnavailable = isProviderSelectionUnavailable(form, profiles);
  // No fixed Provider is selected while a withdrawn Profile is: its scoped fields would be the
  // clearest possible claim that OpenAI is chosen, which is exactly what is not true here.
  const fixedOption =
    selectedProfile === null && !selectionUnavailable
      ? PROVIDER_FORM_OPTIONS.find((option) => option.key === form.provider)
      : undefined;
  const showAdvanced = hasOptionalProviderFields({
    scopedFixedProvider: fixedOption?.scoped === true,
    baseUrlConfigurable: selectedProfile?.baseUrlConfigurable === true,
  });
  // Its own submit is not a reason to explain: the button already reads 追加中.
  const blockedReason = submitting ? null : providerSubmitBlockedReason(form, busy, profiles);

  return (
    <form
      id={ADD_FORM_PANEL_ID}
      className="settings-provider-form"
      // Named by the disclosure button that opened it, so the group needs no second heading of its
      // own — the pair 「Connectionを追加」/「PROVIDER」 that used to sit here read as two.
      aria-labelledby={ADD_TOGGLE_ID}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="settings-provider-form-heading">
        <div>
          <h4>新しいAPI接続</h4>
          <p>プロバイダーと表示名を設定し、必要な場合だけAPIキーを入力します。</p>
        </div>
        <span>APIキーは端末内に保存</span>
      </div>
      <fieldset className="settings-group" disabled={submitting}>
        <div className="settings-provider-basic-fields">
          <label className="settings-field" htmlFor="settings-provider-kind">
            <span className="settings-field-label">プロバイダー</span>
            <select
              id="settings-provider-kind"
              data-testid="settings-provider-kind"
              value={providerSelectValue(form, profiles)}
              aria-describedby={providerSelectDescribedBy({ profilesFailed, selectionUnavailable })}
              onChange={(e) =>
                onChange((current) => applyProviderSelection(current, e.target.value, profiles))
              }
            >
              {/* Present only as the current value of a withdrawn selection, and disabled: it
                is not offered as a choice, it just stops the picker from displaying a
                Provider the user never picked. */}
              {selectionUnavailable && (
                <option value={PROFILE_UNAVAILABLE_VALUE} disabled>
                  {PROFILE_UNAVAILABLE_OPTION_LABEL}
                </option>
              )}
              {PROVIDER_FORM_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
              {/* Whatever Main lists, in Main's order. The Renderer names no Provider of its
                own, so a Pack that gains or loses one needs no change here. */}
              {profiles.length > 0 && (
                <optgroup label={PROFILE_GROUP_LABEL}>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={`${PROFILE_OPTION_PREFIX}${profile.id}`}>
                      {profile.displayName}
                    </option>
                  ))}
                </optgroup>
              )}
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
              placeholder="例: 開発用 OpenAI"
              value={form.displayName}
              onChange={(e) => onChange((current) => ({ ...current, displayName: e.target.value }))}
            />
          </label>
        </div>

        {/* Announced on arrival: the selection changed underneath the user, and only they
            can resolve it. Submit stays disabled until they do. */}
        {selectionUnavailable && (
          <p
            className="settings-provider-error"
            id={SELECTION_UNAVAILABLE_ID}
            data-testid={SELECTION_UNAVAILABLE_ID}
            role="alert"
          >
            {PROFILE_UNAVAILABLE_NOTICE}
          </p>
        )}

        {profilesFailed && (
          <p className="settings-hint" id={PROFILE_WARNING_ID} data-testid={PROFILE_WARNING_ID}>
            {PROFILE_LIST_WARNING}
          </p>
        )}

        <div className="settings-field">
          <label className="settings-field-label" htmlFor="settings-provider-api-key">
            APIキー（{profileRequiresApiKey(selectedProfile) ? '必須' : '任意'}）
          </label>
          {/* The reveal sits inside the field's right edge, where a masked input is looked at,
              rather than as a second control competing with it in a row. */}
          <div className="settings-key-field">
            <input
              id="settings-provider-api-key"
              data-testid="settings-provider-api-key"
              // Masked by default; the toggle beside it is the only way to reveal it.
              type={showKey ? 'text' : 'password'}
              className="settings-text-input settings-key-input"
              autoComplete="off"
              spellCheck={false}
              placeholder="APIキーを貼り付け"
              aria-describedby={KEY_HINT_ID}
              value={form.apiKey}
              onChange={(e) => onChange((current) => ({ ...current, apiKey: e.target.value }))}
            />
            <button
              type="button"
              className="settings-key-reveal"
              data-testid="settings-provider-api-key-reveal"
              aria-pressed={showKey}
              aria-controls="settings-provider-api-key"
              aria-label={showKey ? 'APIキーを隠す' : 'APIキーを表示'}
              title={showKey ? 'APIキーを隠す' : 'APIキーを表示'}
              onClick={onToggleKey}
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <p className="settings-hint" id={KEY_HINT_ID}>
            {KEY_BOUNDARY_HINT}
          </p>
        </div>

        {/* Required by the selected Profile, so it stays out in the open beside the basic three.
            Folding a required field into 詳細設定 would hide the reason submit refuses. */}
        {profileRequiresAccountId(selectedProfile) && (
          <label className="settings-field" htmlFor="settings-provider-account-id">
            <span className="settings-field-label">アカウントID（必須）</span>
            <input
              id="settings-provider-account-id"
              data-testid="settings-provider-account-id"
              type="text"
              className="settings-text-input"
              autoComplete="off"
              spellCheck={false}
              required
              value={form.accountId}
              onChange={(e) => onChange((current) => ({ ...current, accountId: e.target.value }))}
            />
          </label>
        )}

        {showAdvanced && (
          <details className="settings-provider-advanced" data-testid="settings-provider-advanced">
            <summary>{ADVANCED_SUMMARY_LABEL}</summary>
            <div className="settings-provider-advanced-body">
              {fixedOption?.scoped === true && (
                <>
                  <label className="settings-field" htmlFor="settings-provider-org">
                    <span className="settings-field-label">組織ID（任意）</span>
                    <input
                      id="settings-provider-org"
                      data-testid="settings-provider-org"
                      type="text"
                      className="settings-text-input"
                      autoComplete="off"
                      value={form.organizationId}
                      onChange={(e) =>
                        onChange((current) => ({ ...current, organizationId: e.target.value }))
                      }
                    />
                  </label>
                  <label className="settings-field" htmlFor="settings-provider-project">
                    <span className="settings-field-label">プロジェクトID（任意）</span>
                    <input
                      id="settings-provider-project"
                      data-testid="settings-provider-project"
                      type="text"
                      className="settings-text-input"
                      autoComplete="off"
                      value={form.projectId}
                      onChange={(e) =>
                        onChange((current) => ({ ...current, projectId: e.target.value }))
                      }
                    />
                  </label>
                </>
              )}

              {/* Each extra field is asked for only where the selected Profile declares it.
                  Nothing is inferred from the Provider's identity. */}
              {selectedProfile?.baseUrlConfigurable === true && (
                <label className="settings-field" htmlFor="settings-provider-base-url">
                  <span className="settings-field-label">ベースURL（任意）</span>
                  <input
                    id="settings-provider-base-url"
                    data-testid="settings-provider-base-url"
                    type="url"
                    className="settings-text-input"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={selectedProfile.baseUrl}
                    value={form.baseUrl}
                    onChange={(e) =>
                      onChange((current) => ({ ...current, baseUrl: e.target.value }))
                    }
                  />
                  <span className="settings-hint">{BASE_URL_HINT}</span>
                </label>
              )}
            </div>
          </details>
        )}

        <div className="settings-provider-actions">
          {blockedReason !== null && (
            <p
              className="settings-hint settings-provider-submit-hint"
              id={SUBMIT_HINT_ID}
              data-testid={SUBMIT_HINT_ID}
            >
              {blockedReason}
            </p>
          )}
          <button
            type="button"
            className="settings-secondary-button"
            data-testid="settings-provider-cancel"
            onClick={onCancel}
          >
            {CANCEL_LABEL}
          </button>
          <button
            type="submit"
            className="settings-primary-button"
            data-testid="settings-provider-submit"
            disabled={!canSubmitProviderForm(form, busy, profiles)}
            aria-describedby={blockedReason === null ? undefined : SUBMIT_HINT_ID}
          >
            {submitting ? SUBMITTING_LABEL : SUBMIT_LABEL}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export function ProviderSettingsSection({ active }: { active: boolean }) {
  const [connections, setConnections] = useState<ProviderConnection[] | null>(null);
  const [profiles, setProfiles] = useState<readonly ProviderProfile[]>([]);
  const [profilesFailed, setProfilesFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [savingRateLimitId, setSavingRateLimitId] = useState<string | null>(null);
  const [savingModelReleaseId, setSavingModelReleaseId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFormValues>(EMPTY_FORM);
  const [showKey, setShowKey] = useState(false);
  // Closed on arrival: the registered Connections are what this screen is for, and adding one is an
  // occasional act. The form is unmounted while closed, so no plaintext key survives a close.
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);

  const busy = isSectionBusy({
    loading,
    submitting,
    verifyingId,
    savingRateLimitId,
    savingModelReleaseId,
  });
  // Read at render because that is when a card has to decide whether to offer the control at all.
  const rateLimitSupported = supportsRateLimitLowering(providerApi());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
    setProfilesFailed(false);
    // Settled independently: a Profile listing that fails must not take the fixed official
    // Providers down with it, and neither list may be waited on by the other.
    const [connectionResult, profileResult] = await Promise.allSettled([
      loadConnections(api),
      loadProfiles(api),
    ]);
    // A response from a superseded reload — or one that lands after this section is gone — is
    // dropped whole, so it can never overwrite the newer state that replaced it.
    if (request !== generation.current || !mounted.current) return;
    if (profileResult.status === 'fulfilled') {
      const listedProfiles = profileResult.value;
      setProfiles(listedProfiles);
      // Only a listing that actually arrived may retire a selection. Whatever was typed for a
      // Provider this list no longer offers is dropped here; the selection stays unresolvable, so
      // the picker shows it as unavailable and submit waits for the user to choose.
      setForm((current) => clearUnavailableProfileInput(current, listedProfiles));
    } else {
      // The last good list is kept rather than emptied: dropping it would silently move a user
      // who had a Profile selected back onto a fixed Provider, mid-form. The warning says so.
      setProfilesFailed(true);
    }
    if (connectionResult.status === 'fulfilled') {
      setConnections(connectionResult.value);
      setStatus(`${connectionResult.value.length}件の接続を読み込みました。`);
    } else {
      setError(LIST_ERROR);
      setLoadFailed(true);
    }
    setLoading(false);
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

  async function lowerRateLimit(connection: ProviderConnection, input: string): Promise<void> {
    const api = providerApi();
    if (api === null) {
      setSupported(false);
      return;
    }
    if (busy) return;
    setError(null);
    setSavingRateLimitId(connection.id);
    try {
      const updated = await lowerConcurrencyLimit(api, connection, input);
      // Only Main's own answer reaches the list: a failure below leaves the card showing the limit
      // that is actually in force, never the number that was typed.
      setConnections((current) => upsertConnection(current ?? [], updated));
      setStatus(
        `${updated.displayName}の${CONCURRENCY_LABEL}を${concurrencyLimitText(
          updated.rateLimit.maxConcurrentRequests,
        )}に変更しました。`,
      );
    } catch {
      setError(RATE_LIMIT_ERROR);
    } finally {
      setSavingRateLimitId(null);
    }
  }

  async function setAutomaticModelRelease(
    connection: ProviderConnection,
    enabled: boolean,
  ): Promise<void> {
    const api = modelReleaseApi(providerApi());
    if (api === null || busy) return;
    setError(null);
    setSavingModelReleaseId(connection.id);
    try {
      const updated = await api.setAutomaticModelRelease({
        connectionId: connection.id,
        automaticModelRelease: enabled,
      });
      setConnections((current) => upsertConnection(current ?? [], updated));
      setStatus(`${updated.displayName}のモデル自動解放を${enabled ? '有効' : '無効'}にしました。`);
    } catch {
      setError(MODEL_RELEASE_ERROR);
    } finally {
      setSavingModelReleaseId(null);
    }
  }

  async function submitForm(): Promise<void> {
    const api = providerApi();
    if (api === null) {
      setSupported(false);
      return;
    }
    if (!canSubmitProviderForm(form, busy, profiles)) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createConnection(api, form, profiles);
      // Main now owns the encrypted secret; clear the renderer copy immediately. Only the
      // Provider choice survives, so adding a second Connection to the same one stays quick.
      setForm((current) => ({
        ...EMPTY_FORM,
        provider: current.provider,
        profileId: current.profileId,
      }));
      setShowKey(false);
      setConnections((current) => upsertConnection(current ?? [], created));
      setStatus(
        `${created.displayName}を追加しました。検証結果: ${VERIFICATION_LABEL[created.verification.status]}`,
      );
    } catch (error) {
      setError(providerCreateErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  /** Both ways out of the form — the disclosure button again, and キャンセル — land here. The whole
   * draft goes with it, plaintext key first: a closed form must not be holding a credential. */
  function closeAddForm(): void {
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setShowKey(false);
  }

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
          <h3 id="settings-providers-title">プロバイダー接続</h3>
          <p>{SECTION_DESCRIPTION}</p>
        </div>
        <div className="settings-heading-actions">
          {connections !== null && <span className="settings-count-badge">{listed.length}件</span>}
          <button
            type="button"
            className="settings-secondary-button"
            onClick={() => void refresh()}
            disabled={busy || !supported}
          >
            再読み込み
          </button>
        </div>
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
            <div className="settings-provider-empty">
              <strong>API接続はまだありません</strong>
              <p>{EMPTY_TEXT}</p>
            </div>
          ) : (
            <>
              <p className="settings-list-label">{CONNECTION_LIST_LABEL}</p>
              <ul className="settings-connection-list" aria-label={CONNECTION_LIST_LABEL}>
                {listed.map((connection) => (
                  <ProviderConnectionCard
                    key={connection.id}
                    connection={connection}
                    verifying={verifyingId === connection.id}
                    disabled={busy}
                    onRetry={(target) => void retryVerification(target)}
                    rateLimit={{
                      supported: rateLimitSupported,
                      saving: savingRateLimitId === connection.id,
                      onSave: (target, input) => void lowerRateLimit(target, input),
                    }}
                    {...(typeof providerApi()?.setAutomaticModelRelease !== 'function'
                      ? {}
                      : {
                          modelRelease: {
                            saving: savingModelReleaseId === connection.id,
                            onChange: (target: ProviderConnection, enabled: boolean) =>
                              void setAutomaticModelRelease(target, enabled),
                          },
                        })}
                  />
                ))}
              </ul>
            </>
          )}

          {error !== null && (
            <p className="settings-provider-error" role="alert">
              {error}
            </p>
          )}

          <div className="settings-provider-add">
            {/* One disclosure, in place, inside the settings dialog that is already open. The
                single accent on this screen: everything else here is data or a quiet control. */}
            <button
              type="button"
              id={ADD_TOGGLE_ID}
              data-testid="settings-provider-add-toggle"
              className="settings-add-connection"
              aria-expanded={formOpen}
              {...(formOpen ? { 'aria-controls': ADD_FORM_PANEL_ID } : {})}
              onClick={() => (formOpen ? closeAddForm() : setFormOpen(true))}
            >
              {formOpen ? <X size={14} /> : <Plus size={14} />}
              {formOpen ? ADD_CONNECTION_CLOSE_LABEL : ADD_CONNECTION_LABEL}
            </button>

            {formOpen && (
              <ProviderAddConnectionForm
                form={form}
                profiles={profiles}
                profilesFailed={profilesFailed}
                busy={busy}
                submitting={submitting}
                showKey={showKey}
                onChange={setForm}
                onToggleKey={() => setShowKey((value) => !value)}
                onSubmit={() => void submitForm()}
                onCancel={closeAddForm}
              />
            )}
          </div>
        </>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
