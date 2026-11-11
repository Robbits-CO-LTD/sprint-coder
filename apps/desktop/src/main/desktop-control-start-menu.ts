import { readdirSync } from 'node:fs';
import { win32 } from 'node:path';

/** One `.lnk` under a Start menu folder: its file name without `.lnk`, and what it points to. */
export type StartMenuShortcut = Readonly<{ name: string; target: string; args: string }>;

/** Reads one `.lnk` file (Electron's `shell.readShortcutLink` in the app); throws when it cannot. */
export type ShortcutLinkReader = (path: string) => Readonly<{ target?: string; args?: string }>;

let configuredReader: ShortcutLinkReader | null = null;
let cached: Readonly<{ at: number; shortcuts: readonly StartMenuShortcut[] }> | null = null;

// Long enough that the launches of one Turn read the folders once, short enough that an app the
// person just installed is found on the next try.
const CACHE_MS = 30_000;
// Bounds for a Start menu folder far larger than usual, so a lookup never walks without end.
const MAX_DEPTH = 8;
const MAX_SHORTCUTS = 3_000;

/**
 * Sets how the shortcuts of the Start menu are read, for `launch <name>` of desktop control
 * (`desktopControlLaunchByName`). Called once at startup on Windows; until then, and in tests,
 * no shortcut is read and a bare name goes to the executable as before.
 */
export function configureStartMenuShortcutReader(reader: ShortcutLinkReader | null): void {
  configuredReader = reader;
  cached = null;
}

/**
 * The shortcuts under the Start menu folders of all users and of the current user, subfolders
 * included, read only (kept for a short time), or `null` when no reader is configured.
 */
export function startMenuShortcuts(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now: number = Date.now(),
  listFolder: FolderLister = (folder) => readdirSync(folder, { withFileTypes: true }),
): readonly StartMenuShortcut[] | null {
  const reader = configuredReader;
  if (reader === null) return null;
  if (cached !== null && now - cached.at >= 0 && now - cached.at < CACHE_MS)
    return cached.shortcuts;
  const shortcuts: StartMenuShortcut[] = [];
  for (const base of [environment['ProgramData'], environment['APPDATA']]) {
    if (base === undefined || !/^[a-z]:[\\/]/iu.test(base)) continue;
    walk(
      win32.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      0,
      reader,
      listFolder,
      shortcuts,
    );
  }
  cached = { at: now, shortcuts };
  return shortcuts;
}

/** The entries of one folder, as `readdirSync` with `withFileTypes` gives them; throws when unreadable. */
export type FolderLister = (folder: string) => readonly Readonly<{
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}>[];

function walk(
  folder: string,
  depth: number,
  reader: ShortcutLinkReader,
  listFolder: FolderLister,
  shortcuts: StartMenuShortcut[],
): void {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = listFolder(folder);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (shortcuts.length >= MAX_SHORTCUTS) return;
    const path = win32.join(folder, entry.name);
    // Links to folders are not followed: only the folders themselves are read.
    if (entry.isDirectory()) walk(path, depth + 1, reader, listFolder, shortcuts);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
      try {
        const link = reader(path);
        shortcuts.push({
          name: entry.name.slice(0, -'.lnk'.length),
          target: typeof link.target === 'string' ? link.target : '',
          args: typeof link.args === 'string' ? link.args : '',
        });
      } catch {
        // A shortcut that cannot be read is not one to launch.
      }
    }
  }
}
