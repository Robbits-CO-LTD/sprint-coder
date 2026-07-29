import { describe, expect, it } from 'vitest';
import {
  filterSlashCommands,
  removeSlashToken,
  SLASH_COMMANDS,
  slashCommandQuery,
  slashTokenAtCursor,
} from './slash-commands';

describe('slash commands', () => {
  it('recognizes a slash token at line start or after whitespace', () => {
    expect(slashCommandQuery('/')).toBe('');
    expect(slashCommandQuery('/GO')).toBe('go');
    expect(slashCommandQuery(' /goal')).toBe('goal');
    expect(slashCommandQuery('hello /goal')).toBe('goal');
    expect(slashTokenAtCursor('/goal now', 3)?.query).toBe('goal');
    expect(slashTokenAtCursor('/goal now', 9)).toBeNull();
    expect(slashCommandQuery('hello/not-a-command')).toBeNull();
    expect(slashCommandQuery('hello')).toBeNull();
  });

  it('removes only the selected slash token', () => {
    const draft = '前文 /accessibility 後文';
    const match = slashTokenAtCursor(draft, 8);
    expect(match).not.toBeNull();
    expect(removeSlashToken(draft, match!)).toBe('前文  後文');
  });

  it('filters by command name and localized keywords', () => {
    expect(filterSlashCommands(SLASH_COMMANDS, 'go').map(({ id }) => id)).toEqual(['goal']);
    expect(filterSlashCommands(SLASH_COMMANDS, '画像').map(({ id }) => id)).toEqual(['image']);
    expect(filterSlashCommands(SLASH_COMMANDS, '')).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands(SLASH_COMMANDS, 'missing')).toEqual([]);
  });
});
