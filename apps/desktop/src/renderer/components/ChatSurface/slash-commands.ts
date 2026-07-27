export type SlashCommandId = 'new' | 'goal' | 'team' | 'workspace' | 'image';

export type SlashCommand = Readonly<{
  id: SlashCommandId;
  command: `/${SlashCommandId}`;
  label: string;
  description: string;
  keywords: readonly string[];
}>;

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'new',
    command: '/new',
    label: '新しいTask',
    description: '新しいTaskを作成します',
    keywords: ['task', 'タスク', '新規'],
  },
  {
    id: 'goal',
    command: '/goal',
    label: 'ゴールを設定',
    description: '現在のTaskのゴールを編集します',
    keywords: ['target', '目標', 'ゴール'],
  },
  {
    id: 'team',
    command: '/team',
    label: 'Teamを開く',
    description: '現在のTaskのTeamビューを切り替えます',
    keywords: ['agents', 'チーム', 'エージェント'],
  },
  {
    id: 'workspace',
    command: '/workspace',
    label: 'Workspaceを選択',
    description: '現在のTaskで使うフォルダを選びます',
    keywords: ['folder', 'project', 'フォルダ', 'プロジェクト'],
  },
  {
    id: 'image',
    command: '/image',
    label: '画像を生成',
    description: '次の送信で画像生成を呼び出します',
    keywords: ['imagegen', '画像', '生成'],
  },
] as const;

/** A command query exists only while the draft is one slash-prefixed token. */
export function slashCommandQuery(draft: string): string | null {
  if (!draft.startsWith('/') || /\s/.test(draft)) return null;
  return draft.slice(1).toLocaleLowerCase();
}

export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
): readonly SlashCommand[] {
  if (query === '') return commands;
  return commands.filter(({ command, label, keywords }) => {
    const terms = [command.slice(1), label, ...keywords];
    return terms.some((term) => term.toLocaleLowerCase().includes(query));
  });
}
