import {
  ASSISTANT_CONFIRM_OPTIONS,
  ASSISTANT_DEPTH_OPTIONS,
  ASSISTANT_LANGUAGE_OPTIONS,
  ASSISTANT_LENGTH_OPTIONS,
  ASSISTANT_PREFERENCE_CHOICE_GROUPS,
  ASSISTANT_PREFERENCE_TOGGLES,
  ASSISTANT_TONE_OPTIONS,
  type AssistantPreferenceChoiceKey,
  type AssistantPreferenceOption,
  type AssistantPreferenceToggleKey,
} from './assistant-preferences-options';
import type { TeamUsageMode } from './setup-settings';
import {
  TEAM_USAGE_NOTES,
  TEAM_USAGE_OPTIONS as SHARED_TEAM_USAGE_OPTIONS,
} from './team-usage-options';

// The Setup's lists. Values, names, group titles and toggle titles come from the shared list
// (`assistant-preferences-options.ts`, the same one Settings uses). Only the one-line descriptions
// are replaced here: the Setup shows them inside small cards next to each other, where the shared
// full sentences wrap to three or four lines and push the sample reply off the screen.

export type SetupOption<T extends string> = Readonly<{
  value: T;
  label: string;
  description: string;
}>;

function withSetupWording<T extends string>(
  options: readonly AssistantPreferenceOption<T>[],
  short: Readonly<Record<T, string>>,
): readonly SetupOption<T>[] {
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    description: short[option.value] ?? option.description,
  }));
}

export const TONE_OPTIONS = withSetupWording(ASSISTANT_TONE_OPTIONS, {
  polite: 'です・ます で落ち着いて',
  casual: '友だちのように気軽に',
  crisp: '要点だけをすばやく',
});

export const LENGTH_OPTIONS = withSetupWording(ASSISTANT_LENGTH_OPTIONS, {
  short: 'ひとことで',
  balanced: 'ちょうどよく',
  detailed: 'しっかり説明',
});

export const DEPTH_OPTIONS = withSetupWording(ASSISTANT_DEPTH_OPTIONS, {
  conclusion: '答えを先に',
  reasoned: 'なぜかも添えて',
  beginner: 'たとえを使って',
});

export const LANGUAGE_OPTIONS = withSetupWording(ASSISTANT_LANGUAGE_OPTIONS, {
  auto: '話しかけた言葉で',
  ja: 'いつも日本語で',
  en: 'いつも英語で',
});

export const CONFIRM_OPTIONS = withSetupWording(ASSISTANT_CONFIRM_OPTIONS, {
  ask: '決めにくい所は先に確認',
  balanced: '大事な所だけ確認',
  proceed: 'なるべく止まらずに',
});

export function choiceTitle(key: AssistantPreferenceChoiceKey): string {
  return ASSISTANT_PREFERENCE_CHOICE_GROUPS.find((group) => group.key === key)?.title ?? key;
}

export function toggleTitle(key: AssistantPreferenceToggleKey): string {
  return ASSISTANT_PREFERENCE_TOGGLES.find((toggle) => toggle.key === key)?.title ?? key;
}

/** The shared Team list (Settings uses the same), plus the Setup's own "おすすめ" mark. */
export type TeamUsageOption = SetupOption<TeamUsageMode> & { recommended?: boolean };

export const TEAM_USAGE_OPTIONS: readonly TeamUsageOption[] = SHARED_TEAM_USAGE_OPTIONS.map(
  (option) => ({ ...option, ...(option.value === 'auto' ? { recommended: true } : {}) }),
);

/** "Team のメンバーも、AI の利用枠を使います。" */
export const TEAM_USAGE_COST_NOTE: string =
  TEAM_USAGE_NOTES[0] ?? 'Team のメンバーも、AI の利用枠を使います。';
export function optionLabel<T extends string>(
  options: readonly SetupOption<T>[],
  value: T,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
