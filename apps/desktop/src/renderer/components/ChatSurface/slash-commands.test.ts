import { describe, expect, it } from 'vitest';
import {
  filterSlashCommands,
  inheritedProjectForNewTask,
  removeSlashToken,
  SLASH_COMMANDS,
  slashCommandQuery,
  slashTokenAtCursor,
} from './slash-commands';

describe('/new Project inheritance', () => {
  it('inherits the current Project and keeps Projectなし as undefined', () => {
    expect(inheritedProjectForNewTask('project-1')).toBe('project-1');
    expect(inheritedProjectForNewTask(null)).toBeUndefined();
    expect(inheritedProjectForNewTask(undefined)).toBeUndefined();
  });
});

describe('slash commands', () => {
  it('preserves the legacy whole-draft query while cursor matching supports inline tokens', () => {
    expect(slashCommandQuery('/')).toBe('');
    expect(slashCommandQuery('/GO')).toBe('go');
    expect(slashCommandQuery(' /goal')).toBeNull();
    expect(slashCommandQuery('hello /goal')).toBeNull();
    expect(slashTokenAtCursor('hello /goal')?.query).toBe('goal');
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
