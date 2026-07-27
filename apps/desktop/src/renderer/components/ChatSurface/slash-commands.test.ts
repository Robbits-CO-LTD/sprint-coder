import { describe, expect, it } from 'vitest';
import { filterSlashCommands, SLASH_COMMANDS, slashCommandQuery } from './slash-commands';

describe('slash commands', () => {
  it('recognizes only a slash-prefixed, single-token draft', () => {
    expect(slashCommandQuery('/')).toBe('');
    expect(slashCommandQuery('/GO')).toBe('go');
    expect(slashCommandQuery(' /goal')).toBeNull();
    expect(slashCommandQuery('/goal now')).toBeNull();
    expect(slashCommandQuery('hello')).toBeNull();
  });

  it('filters by command name and localized keywords', () => {
    expect(filterSlashCommands(SLASH_COMMANDS, 'go').map(({ id }) => id)).toEqual(['goal']);
    expect(filterSlashCommands(SLASH_COMMANDS, '画像').map(({ id }) => id)).toEqual(['image']);
    expect(filterSlashCommands(SLASH_COMMANDS, '')).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands(SLASH_COMMANDS, 'missing')).toEqual([]);
  });
});
