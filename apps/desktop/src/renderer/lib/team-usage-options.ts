import type { TeamUsageMode } from '@sprint-coder/contracts';

export type TeamUsageOption = Readonly<{
  value: TeamUsageMode;
  label: string;
  description: string;
}>;

/** 「Team の使い方」の選択肢。Settings と Setup の画面で同じ一覧を使う（並びは控えめな順）。 */
export const TEAM_USAGE_OPTIONS: readonly TeamUsageOption[] = Object.freeze([
  {
    value: 'explicit',
    label: '言った時だけ',
    description: '「Team で」と頼んだ時だけ、Team を使います。',
  },
  {
    value: 'auto',
    label: 'おまかせ',
    description:
      '分担した方がいい時だけ、AI が自分で Team を使います。ちょっとした依頼には使いません。',
  },
  {
    value: 'proactive',
    label: '積極的に',
    description: '分担できる作業は、どんどん Team で進めます。',
  },
]);

/** 選択肢の下に添える補足。 */
export const TEAM_USAGE_NOTES: readonly string[] = Object.freeze([
  'Team のメンバーも、AI の利用枠を使います。',
  '変更は次の発言から反映されます。',
]);
