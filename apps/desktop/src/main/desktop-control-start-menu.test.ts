import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureStartMenuShortcutReader,
  startMenuShortcuts,
  type FolderLister,
} from './desktop-control-start-menu';

const folders: string[] = [];
afterEach(() => {
  configureStartMenuShortcutReader(null);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const PROGRAMS = ['Microsoft', 'Windows', 'Start Menu', 'Programs'];
const ALL = 'C:\\ProgramData';
const MINE = 'C:\\Users\\me\\AppData\\Roaming';

/** Folders of Windows paths in memory, so the walk is the same on every OS. */
function memoryFolders(files: readonly string[]): FolderLister {
  const tree = new Map<string, Map<string, boolean>>();
  for (const file of files) {
    let path = file;
    let directory = false;
    while (true) {
      const parent = win32.dirname(path);
      if (parent === path) break;
      const key = parent.toLowerCase();
      const entries = tree.get(key) ?? new Map<string, boolean>();
      entries.set(win32.basename(path), directory);
      tree.set(key, entries);
      path = parent;
      directory = true;
    }
  }
  return (folder) => {
    const entries = tree.get(folder.toLowerCase());
    if (entries === undefined) throw new Error('ENOENT');
    return [...entries].map(([name, directory]) => ({
      name,
      isDirectory: () => directory,
      isFile: () => !directory,
    }));
  };
}

describe('Start menu shortcuts for desktop-control launch', () => {
  it('reads the .lnk files of both Start menus, subfolders included, only once a reader is set', () => {
    const list = memoryFolders([
      win32.join(ALL, ...PROGRAMS, 'RabbitMail.lnk'),
      win32.join(ALL, ...PROGRAMS, 'Tools', 'Viewer.LNK'),
      win32.join(ALL, ...PROGRAMS, 'readme.txt'),
      win32.join(ALL, ...PROGRAMS, 'Broken.lnk'),
      win32.join(MINE, ...PROGRAMS, 'Notes.lnk'),
      // Not a Start menu folder.
      win32.join(MINE, 'Desktop', 'Other.lnk'),
    ]);
    const environment = { ProgramData: ALL, APPDATA: MINE };
    expect(startMenuShortcuts(environment, 0, list)).toBeNull();

    const read: string[] = [];
    configureStartMenuShortcutReader((path) => {
      read.push(path);
      if (path.endsWith('Broken.lnk')) throw new Error('unreadable');
      return { target: `C:\\Apps\\${win32.basename(path)}.exe`, args: '' };
    });
    const shortcuts = startMenuShortcuts(environment, 0, list);
    expect(shortcuts?.map(({ name }) => name).sort()).toEqual(['Notes', 'RabbitMail', 'Viewer']);
    expect([...read].sort()).toEqual(
      [
        win32.join(ALL, ...PROGRAMS, 'Broken.lnk'),
        win32.join(ALL, ...PROGRAMS, 'RabbitMail.lnk'),
        win32.join(ALL, ...PROGRAMS, 'Tools', 'Viewer.LNK'),
        win32.join(MINE, ...PROGRAMS, 'Notes.lnk'),
      ].sort(),
    );

    // Kept for a short time, then read again.
    expect(startMenuShortcuts(environment, 10_000, list)).toBe(shortcuts);
    expect(read).toHaveLength(4);
    startMenuShortcuts(environment, 60_000, list);
    expect(read).toHaveLength(8);
  });

  it('reads no folder that is not an absolute Windows path', () => {
    configureStartMenuShortcutReader(() => ({ target: 'C:\\Apps\\x.exe' }));
    const listed: string[] = [];
    const list: FolderLister = (folder) => {
      listed.push(folder);
      return [];
    };
    expect(startMenuShortcuts({ ProgramData: '/var/lib', APPDATA: 'relative' }, 0, list)).toEqual(
      [],
    );
    expect(listed).toEqual([]);
  });

  // The default lister on real folders, whose paths have a drive letter only on Windows.
  it.skipIf(process.platform !== 'win32')('reads real Start menu folders', () => {
    const all = mkdtempSync(join(tmpdir(), 'sprint-coder-start-all-'));
    folders.push(all);
    const path = join(all, ...PROGRAMS, 'Tools', 'RabbitMail.lnk');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
    configureStartMenuShortcutReader(() => ({ target: 'C:\\Apps\\rabbit.exe', args: '' }));
    expect(startMenuShortcuts({ ProgramData: all }, 0)).toEqual([
      { name: 'RabbitMail', target: 'C:\\Apps\\rabbit.exe', args: '' },
    ]);
  });
});
