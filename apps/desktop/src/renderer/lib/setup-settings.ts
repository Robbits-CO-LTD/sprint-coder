// The one place the Setup talks to the two settings the Setup owns the first choice of: how the AI
// replies (contract 1) and when it brings in a Team (contract 2). Everything else in the Setup goes
// through this file, so wiring the real bridge later only changes what is below.
//
// Older preloads and test stubs do not expose these four functions. That is not an error: the
// matching Setup step is simply not offered (a choice that could not take effect would mislead),
// and nothing is reported as "not saved".

import {
  DEFAULT_ASSISTANT_PREFERENCES,
  DEFAULT_TEAM_USAGE_MODE,
  type AssistantPreferences,
  type AssistantPreferencesState,
  type TeamUsageMode,
} from '@sprint-coder/contracts';
import { ASSISTANT_CALL_NAME_FIELD } from './assistant-preferences-options';

export { DEFAULT_ASSISTANT_PREFERENCES, DEFAULT_TEAM_USAGE_MODE };
export type { AssistantPreferences, AssistantPreferencesState, TeamUsageMode };

export const CALL_NAME_MAX: number = ASSISTANT_CALL_NAME_FIELD.maxLength;

/** `saved` and `failed` only happen where the bridge exists; `unsupported` is never shown as a
 * failure. */
export type SetupSaveOutcome = 'saved' | 'failed' | 'unsupported';

type SetupSettingsBridge = {
  getAssistantPreferences?: () => Promise<AssistantPreferencesState>;
  setAssistantPreferences?: (input: AssistantPreferences) => Promise<AssistantPreferencesState>;
  getTeamUsageMode?: () => Promise<{ mode: TeamUsageMode }>;
  setTeamUsageMode?: (input: { mode: TeamUsageMode }) => Promise<{ mode: TeamUsageMode }>;
};

function bridge(): SetupSettingsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  // Any of the four may be missing from an older preload (or a test stub), hence the optional
  // members.
  return window.sprintCoder?.settings as SetupSettingsBridge | undefined;
}

export type SetupSettingsSupport = Readonly<{ assistant: boolean; team: boolean }>;

export function setupSettingsSupport(): SetupSettingsSupport {
  const api = bridge();
  return {
    assistant:
      typeof api?.getAssistantPreferences === 'function' &&
      typeof api.setAssistantPreferences === 'function',
    team: typeof api?.getTeamUsageMode === 'function' && typeof api.setTeamUsageMode === 'function',
  };
}

export function clampCallName(value: string): string {
  return Array.from(value).slice(0, CALL_NAME_MAX).join('');
}

const TONES = new Set(['polite', 'casual', 'crisp']);
const LENGTHS = new Set(['short', 'balanced', 'detailed']);
const DEPTHS = new Set(['conclusion', 'reasoned', 'beginner']);
const LANGUAGES = new Set(['auto', 'ja', 'en']);
const CONFIRMS = new Set(['ask', 'balanced', 'proceed']);
const TEAM_MODES = new Set<string>(['explicit', 'auto', 'proactive']);

/** Accepts whatever the bridge returned and keeps only well-formed fields, so a newer or broken
 * answer can never put the Setup into a state none of its controls can show. */
function normalizePreferences(value: unknown): AssistantPreferences {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const pick = <T extends string>(key: keyof AssistantPreferences, allowed: Set<string>): T =>
    (typeof input[key] === 'string' && allowed.has(input[key])
      ? input[key]
      : DEFAULT_ASSISTANT_PREFERENCES[key]) as T;
  const flag = (key: 'emoji' | 'suggestNextSteps' | 'planFirst'): boolean =>
    typeof input[key] === 'boolean' ? input[key] : DEFAULT_ASSISTANT_PREFERENCES[key];
  return {
    tone: pick('tone', TONES),
    length: pick('length', LENGTHS),
    depth: pick('depth', DEPTHS),
    language: pick('language', LANGUAGES),
    confirm: pick('confirm', CONFIRMS),
    callName: typeof input.callName === 'string' ? clampCallName(input.callName) : '',
    emoji: flag('emoji'),
    suggestNextSteps: flag('suggestNextSteps'),
    planFirst: flag('planFirst'),
  };
}

/** What Main has stored right now, or `null` when it cannot be read (no bridge, or an error). A
 * caller that cannot read must not guess: it keeps the last value it knew. */
export async function loadAssistantPreferences(): Promise<AssistantPreferencesState | null> {
  const get = bridge()?.getAssistantPreferences;
  if (typeof get !== 'function') return null;
  try {
    const state = await get();
    return {
      configured: state?.configured === true,
      preferences: normalizePreferences(state?.preferences),
    };
  } catch {
    return null;
  }
}

/** On success, `preferences` is what Main actually stored (it cleans the call name), which is
 * what the Setup shows from then on. */
export async function saveAssistantPreferences(
  preferences: AssistantPreferences,
): Promise<{ outcome: SetupSaveOutcome; preferences?: AssistantPreferences }> {
  const set = bridge()?.setAssistantPreferences;
  if (typeof set !== 'function') return { outcome: 'unsupported' };
  const input = { ...preferences, callName: clampCallName(preferences.callName.trim()) };
  try {
    const state = await set(input);
    return {
      outcome: 'saved',
      preferences: state?.preferences ? normalizePreferences(state.preferences) : input,
    };
  } catch {
    return { outcome: 'failed' };
  }
}

/** The stored Team mode, or `null` when it cannot be read. */
export async function loadTeamUsageMode(): Promise<TeamUsageMode | null> {
  const get = bridge()?.getTeamUsageMode;
  if (typeof get !== 'function') return null;
  try {
    const state = await get();
    return TEAM_MODES.has(state?.mode) ? state.mode : DEFAULT_TEAM_USAGE_MODE;
  } catch {
    return null;
  }
}

/** On success, `mode` is what Main stored. */
export async function saveTeamUsageMode(
  mode: TeamUsageMode,
): Promise<{ outcome: SetupSaveOutcome; mode?: TeamUsageMode }> {
  const set = bridge()?.setTeamUsageMode;
  if (typeof set !== 'function') return { outcome: 'unsupported' };
  try {
    const state = await set({ mode });
    return { outcome: 'saved', mode: TEAM_MODES.has(state?.mode) ? state.mode : mode };
  } catch {
    return { outcome: 'failed' };
  }
}
