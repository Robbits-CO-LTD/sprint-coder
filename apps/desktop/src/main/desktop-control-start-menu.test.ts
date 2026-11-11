import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureStartMenuShortcutReader, startMenuShortcuts } from './desktop-control-start-menu';

const folders: string[] = [];
afterEach(() => {
  configureStartMenuShortcutReader(null);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function startMenu(base: string, files: readonly string[]): void {
  for (const file of files) {
    const path = join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
  }
}

describe('Start menu shortcuts for desktop-control launch', () => {
  it('reads the .lnk files of both Start menus, subfolders included, only once a reader is set', () => {
    const all = mkdtempSync(join(tmpdir(), 'sprint-coder-start-all-'));
    const mine = mkdtempSync(join(tmpdir(), 'sprint-coder-start-mine-'));
    folders.push(all, mine);
    startMenu(all, ['RabbitMail.lnk', 'Tools\\Viewer.LNK', 'readme.txt', 'Broken.lnk']);
    startMenu(mine, ['Notes.lnk']);
    const environment = { ProgramData: all, APPDATA: mine };
    expect(startMenuShortcuts(environment, 0)).toBeNull();

    const read: string[] = [];
    configureStartMenuShortcutReader((path) => {
      read.push(path);
      if (path.endsWith('Broken.lnk')) throw new Error('unreadable');
      return { target: `C:\\Apps\\${path.split('\\').pop()}.exe`, args: '' };
    });
    const shortcuts = startMenuShortcuts(environment, 0);
    expect(shortcuts?.map(({ name }) => name).sort()).toEqual(['Notes', 'RabbitMail', 'Viewer']);
    expect(read).toHaveLength(4);

    // Kept for a short time, then read again.
    expect(startMenuShortcuts(environment, 10_000)).toBe(shortcuts);
    expect(read).toHaveLength(4);
    startMenuShortcuts(environment, 60_000);
    expect(read).toHaveLength(8);
  });
});
