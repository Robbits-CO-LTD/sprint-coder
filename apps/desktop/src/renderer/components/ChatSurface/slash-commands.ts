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
    label: '新しいタスク',
    description: '新しいタスクを作成します',
    keywords: ['task', 'タスク', '新規'],
  },
  {
    id: 'goal',
    command: '/goal',
    label: 'Goalを設定',
    description: '次の送信内容を現在のTaskのGoalとして保存します',
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

export function inheritedProjectForNewTask(
  projectId: string | null | undefined,
): string | undefined {
  return projectId ?? undefined;
}

export type SlashTokenMatch = Readonly<{
  start: number;
  end: number;
  query: string;
}>;

/**
 * Returns the slash token touching the caret.
 *
 * A slash opens the picker only at the beginning of the draft or immediately after whitespace.
 * The token ends at whitespace, so selecting an item can remove only `/query` without discarding
 * the rest of a multi-line message.
 */
export function slashTokenAtCursor(draft: string, cursor = draft.length): SlashTokenMatch | null {
  const safeCursor = Math.max(0, Math.min(cursor, draft.length));
  let start = safeCursor;
  while (start > 0 && !/\s/u.test(draft[start - 1] ?? '')) start -= 1;
  if (draft[start] !== '/' || (start > 0 && !/\s/u.test(draft[start - 1] ?? ''))) return null;

  let end = start;
  while (end < draft.length && !/\s/u.test(draft[end] ?? '')) end += 1;
  if (safeCursor < start || safeCursor > end) return null;
  return {
    start,
    end,
    query: draft.slice(start + 1, end).toLocaleLowerCase(),
  };
}

/** Backward-compatible helper: the complete draft must be one slash-prefixed token. */
export function slashCommandQuery(draft: string): string | null {
  if (!draft.startsWith('/') || /\s/.test(draft)) return null;
  return draft.slice(1).toLocaleLowerCase();
}

export function removeSlashToken(draft: string, match: SlashTokenMatch): string {
  return `${draft.slice(0, match.start)}${draft.slice(match.end)}`;
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
