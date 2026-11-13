import type { AssistantPreferences } from '@sprint-coder/contracts';

// 「返事の仕方」の表示用の選択肢。Settings と Setup の画面が同じ一覧を使う。
// 文言は利用者向けなので、専門用語を使わない。AI に渡す文は Main の
// `assistant-preferences-prompt.ts` が別に持つ（こちらは画面の言葉だけ）。

export type AssistantPreferenceChoiceKey = 'tone' | 'length' | 'depth' | 'language' | 'confirm';
export type AssistantPreferenceToggleKey = 'emoji' | 'suggestNextSteps' | 'planFirst';

export interface AssistantPreferenceOption<V extends string = string> {
  value: V;
  /** 短い名前（ボタンや一覧の見出し）。 */
  label: string;
  /** 1 行の説明。 */
  description: string;
}

export interface AssistantPreferenceChoiceGroup<
  K extends AssistantPreferenceChoiceKey = AssistantPreferenceChoiceKey,
> {
  key: K;
  title: string;
  description: string;
  options: readonly AssistantPreferenceOption<AssistantPreferences[K]>[];
}

export interface AssistantPreferenceToggle {
  key: AssistantPreferenceToggleKey;
  title: string;
  description: string;
}

export const ASSISTANT_TONE_OPTIONS: readonly AssistantPreferenceOption<
  AssistantPreferences['tone']
>[] = [
  { value: 'polite', label: 'ていねい', description: 'ていねいな言葉づかいで話します。' },
  { value: 'casual', label: 'フランク', description: '親しみやすく、くだけた言葉で話します。' },
  { value: 'crisp', label: 'きびきび', description: '前置きを省いて、てきぱきと話します。' },
];

export const ASSISTANT_LENGTH_OPTIONS: readonly AssistantPreferenceOption<
  AssistantPreferences['length']
>[] = [
  { value: 'short', label: '短く', description: '要点だけを短く伝えます。' },
  { value: 'balanced', label: 'ふつう', description: 'ちょうどよい長さで伝えます。' },
  { value: 'detailed', label: 'くわしく', description: '背景や補足もふくめて伝えます。' },
];

export const ASSISTANT_DEPTH_OPTIONS: readonly AssistantPreferenceOption<
  AssistantPreferences['depth']
>[] = [
  { value: 'conclusion', label: '結論だけ', description: '結論とやることだけを伝えます。' },
  { value: 'reasoned', label: '理由も', description: '結論に、そう考えた理由を添えます。' },
  {
    value: 'beginner',
    label: 'かみくだいて',
    description: 'むずかしい言葉を避けて、初めての人にも分かるように話します。',
  },
];

export const ASSISTANT_LANGUAGE_OPTIONS: readonly AssistantPreferenceOption<
  AssistantPreferences['language']
>[] = [
  {
    value: 'auto',
    label: '相手に合わせる',
    description: '話しかけた言葉と同じ言葉で返事します。',
  },
  { value: 'ja', label: '日本語', description: 'いつも日本語で返事します。' },
  { value: 'en', label: '英語', description: 'いつも英語で返事します。' },
];

export const ASSISTANT_CONFIRM_OPTIONS: readonly AssistantPreferenceOption<
  AssistantPreferences['confirm']
>[] = [
  {
    value: 'ask',
    label: '迷ったら聞く',
    description: '判断に迷うときは、進める前に聞きます。',
  },
  { value: 'balanced', label: 'ふつう', description: '大事なことだけ確かめてから進めます。' },
  {
    value: 'proceed',
    label: '聞かずに進める',
    description:
      '元に戻せることは聞かずに進めて、あとで知らせます。許可が必要な操作は、これまでどおり確認します。',
  },
];

/** 選ぶ項目を、画面に出す順に並べたもの。 */
export const ASSISTANT_PREFERENCE_CHOICE_GROUPS: readonly [
  AssistantPreferenceChoiceGroup<'tone'>,
  AssistantPreferenceChoiceGroup<'length'>,
  AssistantPreferenceChoiceGroup<'depth'>,
  AssistantPreferenceChoiceGroup<'language'>,
  AssistantPreferenceChoiceGroup<'confirm'>,
] = [
  {
    key: 'tone',
    title: '言葉づかい',
    description: 'どんな話し方で返事をするか。',
    options: ASSISTANT_TONE_OPTIONS,
  },
  {
    key: 'length',
    title: '長さ',
    description: '返事をどのくらいの長さにするか。',
    options: ASSISTANT_LENGTH_OPTIONS,
  },
  {
    key: 'depth',
    title: '説明のしかた',
    description: 'どこまでくわしく説明するか。',
    options: ASSISTANT_DEPTH_OPTIONS,
  },
  {
    key: 'language',
    title: '返事の言語',
    description: '何語で返事をするか。',
    options: ASSISTANT_LANGUAGE_OPTIONS,
  },
  {
    key: 'confirm',
    title: '進め方',
    description: '作業の途中で、どのくらい確かめながら進めるか。',
    options: ASSISTANT_CONFIRM_OPTIONS,
  },
];

/** オン・オフで決める項目。 */
export const ASSISTANT_PREFERENCE_TOGGLES: readonly AssistantPreferenceToggle[] = [
  { key: 'emoji', title: '絵文字を使う', description: '返事の中で、絵文字を適度に使います。' },
  {
    key: 'suggestNextSteps',
    title: '最後に次の一手を提案する',
    description: '返事の終わりに、次にできることを短く提案します。',
  },
  {
    key: 'planFirst',
    title: '作業の前に進め方を見せる',
    description: '作業に取りかかる前に、どう進めるかを短く見せます。',
  },
];

/** 呼び名の入力欄。最大の長さは保存の決まり（40 文字）と同じ。 */
export const ASSISTANT_CALL_NAME_FIELD = {
  title: '呼び名',
  description: 'あなたを何と呼ぶか。空のままなら、名前では呼びません。',
  placeholder: '例: 山田さん',
  maxLength: 40,
} as const;

/** 設定の変更がいつ効くかの一言。 */
export const ASSISTANT_PREFERENCES_APPLY_NOTE = '変更は次の発言から反映されます。';
