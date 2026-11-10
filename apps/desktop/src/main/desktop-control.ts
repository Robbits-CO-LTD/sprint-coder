import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { DESKTOP_CONTROL_EXECUTABLE, desktopControlSupported } from './desktop-control-build';

/**
 * Sprint Coder's desktop control is the desktop-control executable that ships with the app: one
 * native CLI built from the source in this repository, sealed by the SHA-256 its build (and, in
 * a package, the signing step) wrote to the `.sha256` manifest beside it (see
 * `desktop-control-build.ts`). The agent runs it through its ordinary shell tool, so the command
 * approval and Stop that already cover every shell command cover it too.
 *
 * Only the shipped copy is used: the packaged app's resources, or, in a development run, the
 * build output in the repository. No environment variable or PATH lookup can point it
 * elsewhere. A file whose bytes are not the sealed ones is not the desktop-control executable,
 * and then the guidance is left out entirely. Windows x64 only for now; elsewhere this is always
 * `null`.
 */
export type DesktopControlLookup = Readonly<{
  platform?: NodeJS.Platform;
  arch?: string;
  /** Whether this is the packaged app; otherwise a development run from the repository. */
  packaged?: boolean;
  resourcesPath?: string;
  /** The repository root whose desktop-control build output is used in a development run. */
  repositoryRoot?: string;
  /** SHA-256 (hex) of the file's current bytes, or `null` when it is not a readable file. */
  contentDigest?: (path: string) => string | null;
  /** The SHA-256 (hex) sealed in the file's `.sha256` manifest, or `null` when there is none. */
  sealedDigest?: (path: string) => string | null;
  realpath?: (path: string) => string;
}>;

/** The shipped file and the digest it is sealed with, when its bytes are the sealed ones. */
function shippedDesktopControl(
  lookup: DesktopControlLookup,
): Readonly<{ path: string; digest: string }> | null {
  const platform = lookup.platform ?? process.platform;
  if (!desktopControlSupported(platform, lookup.arch ?? process.arch)) return null;
  const packaged = lookup.packaged ?? __dirname.includes('app.asar');
  let candidate: string;
  if (packaged) {
    const resources = lookup.resourcesPath ?? process.resourcesPath;
    if (typeof resources !== 'string' || !win32.isAbsolute(resources)) return null;
    candidate = win32.join(resources, DESKTOP_CONTROL_EXECUTABLE);
  } else {
    // `.vite/build` (the built main) and `src/main` (tests) are both four levels below the root.
    const root = lookup.repositoryRoot ?? resolve(__dirname, '..', '..', '..', '..');
    candidate = win32.join(
      root,
      'apps',
      'desktop',
      'desktop-control',
      'build',
      'Release',
      DESKTOP_CONTROL_EXECUTABLE,
    );
  }
  const digest = (lookup.sealedDigest ?? sealedFileDigest)(candidate);
  if (digest === null || !/^[a-f0-9]{64}$/u.test(digest)) return null;
  return (lookup.contentDigest ?? cachedFileDigest)(candidate) === digest
    ? { path: candidate, digest }
    : null;
}

export function resolveDesktopControlCommand(lookup: DesktopControlLookup = {}): string | null {
  return shippedDesktopControl(lookup)?.path ?? null;
}

/**
 * Whether a sealed executable is the shipped desktop-control executable: its content digest (the
 * bytes that were sealed, or that are about to start) equals the shipped file's sealed digest, and
 * it is the shipped file. The path alone never qualifies, so a file that only resolves to the
 * shipped location cannot borrow its trust.
 */
export function isDesktopControlExecutable(
  executable: string,
  contentDigest: string | null,
  lookup: DesktopControlLookup = {},
): boolean {
  const shipped = shippedDesktopControl(lookup);
  if (shipped === null || contentDigest !== shipped.digest) return false;
  return comparisonKey(executable, lookup) === comparisonKey(shipped.path, lookup);
}

/**
 * Whether one approved command may run outside the command sandbox: only the shipped
 * desktop-control binary (see `isDesktopControlExecutable`), judged on the digest of the image
 * about to start, and only when it does not live inside any root of the Turn's Workspace. Desktop
 * control cannot work in the sandbox, which hides other apps' windows and processes and the
 * binary's own settings folder in the user's home.
 */
export function runsOutsideCommandSandbox(
  executable: string,
  contentDigest: string | null,
  workspaceRoots: readonly string[],
  lookup: DesktopControlLookup = {},
): boolean {
  return (
    isDesktopControlExecutable(executable, contentDigest, lookup) &&
    outsideWorkspaceRoots(executable, workspaceRoots, lookup)
  );
}

/**
 * The environment of a desktop-control run outside the sandbox. Its PATH keeps only the absolute
 * folders outside every root of the Turn's Workspace, so a bare `launch` name never resolves to a
 * file the agent wrote in the Workspace. Relative, root-relative, UNC and empty entries are
 * dropped as well, since what they name depends on where they are read. An entry with a `"`
 * anywhere is dropped without being read, since quoting is read differently by different users of
 * PATH. The PATH is rebuilt from the normalized folders that were judged, not from the original
 * text, and every variable named PATH in any letter case is filtered. Other variables, the
 * approved ExecutionSpec and the approval card stay as they are.
 */
export function desktopControlEnvironment(
  environment: Readonly<Record<string, string>>,
  workspaceRoots: readonly string[],
  lookup: DesktopControlLookup = {},
): Readonly<Record<string, string>> {
  const windows = (lookup.platform ?? process.platform) === 'win32';
  const paths = windows ? win32 : posix;
  const separator = windows ? ';' : ':';
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => {
      if ((windows ? key.toUpperCase() : key) !== 'PATH') return [key, value];
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const entry of value.split(separator)) {
        const trimmed = entry.trim();
        if (trimmed.includes('"') || trimmed.includes('\0')) continue;
        if (!(windows ? /^[a-z]:[\\/]/iu.test(trimmed) : posix.isAbsolute(trimmed))) continue;
        const normalized = paths.normalize(trimmed);
        const minimum = windows ? 3 : 1;
        const folder =
          normalized.length > minimum
            ? normalized.replace(windows ? /[\\/]+$/u : /\/+$/u, '')
            : normalized;
        const identity = windows ? folder.toLowerCase() : folder;
        if (seen.has(identity) || !outsideWorkspaceRoots(folder, workspaceRoots, lookup)) continue;
        seen.add(identity);
        kept.push(folder);
      }
      return [key, kept.join(separator)];
    }),
  );
}

function comparisonKey(path: string, lookup: DesktopControlLookup): string {
  const platform = lookup.platform ?? process.platform;
  const normalized = (platform === 'win32' ? win32 : posix).normalize(
    (lookup.realpath ?? canonicalPath)(path),
  );
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function outsideWorkspaceRoots(
  path: string,
  workspaceRoots: readonly string[],
  lookup: DesktopControlLookup,
): boolean {
  const paths = (lookup.platform ?? process.platform) === 'win32' ? win32 : posix;
  const target = comparisonKey(path, lookup);
  return workspaceRoots.every((root) => {
    const inside = paths.relative(comparisonKey(root, lookup), target);
    return (
      inside !== '' &&
      (inside === '..' || inside.startsWith(`..${paths.sep}`) || paths.isAbsolute(inside))
    );
  });
}

// The arguments are what the agent chose. The safety boundary is that the person allows every
// desktop-control run that reads or operates the desktop on its own approval card (only the
// closed list in `desktopControlArgvIsInert` runs without one); nothing here makes operating the desktop safe,
// since keystrokes reach whatever window has focus. This check only drops the plainly dangerous forms
// before a card exists: an option or command it does not know, a file path to read or write, the
// clipboard's contents, a long-lived server (`mcp`), a launch that passes arguments, environment
// or a working directory to the app, and — as a convenience, never a boundary — launching a
// terminal, shell, script host or settings tool by name.
const GLOBAL_OPTIONS =
  '--session= --agent-id= -w= --wait-for= --wait-for-gone= --wait-timeout= -v --verbose --headed';
const HELP_OPTIONS = new Set(['-h', '--help', '-V', '--version']);
const REFUSED_OPTIONS = new Set(
  [
    '--trace --trace-strict --screenshot --debug --screenshots --cdp --image --file-url',
    '--pointer-image --out --stdin --env --cwd --arg --force --guide --request',
  ]
    .join(' ')
    .split(' '),
);
const REFUSED_COMMANDS = new Set(['mcp', 'open-system-surface', 'clipboard-get', 'trace']);
const REF = '--timeout-ms=';
const WINDOW = '--app= --window-id=';
const BUTTONS = '--xy= --button= --modifiers=';
// Every option of the desktop-control binary 1.2.0 (`<command> --help`) except the refused ones
// above. `=` marks an option that takes a value. Commands with subcommands are listed as `command sub`.
const COMMAND_OPTIONS: Readonly<Record<string, string>> = {
  snapshot: `${WINDOW} --max-depth= --include-bounds -i --interactive-only --compact --skeleton --surface= --root= ${REF} --force-electron-a11y`,
  find: `${WINDOW} --role= --name= --value= --text= --description= --native-id= --exact --root= --surface= --state= ${REF} --count --first --last --nth= --limit=`,
  screenshot: `${WINDOW} --screen=`,
  get: '--property=',
  is: '--property=',
  click: REF,
  'double-click': REF,
  'triple-click': REF,
  'right-click': REF,
  type: `${REF} --interval-ms=`,
  'set-value': REF,
  clear: REF,
  focus: REF,
  select: REF,
  toggle: REF,
  check: REF,
  uncheck: REF,
  expand: REF,
  collapse: REF,
  scroll: `--direction= --amount= ${REF}`,
  'scroll-to': REF,
  press: WINDOW,
  'key-down': '',
  'key-up': '',
  hover: `--xy= --duration= ${REF}`,
  drag: `--from= --from-xy= --to= --to-xy= --duration= --drop-delay= ${REF} --wait-for-scope=`,
  'mouse-move': '--xy=',
  'mouse-click': `${BUTTONS} --count=`,
  'mouse-down': BUTTONS,
  'mouse-up': BUTTONS,
  'mouse-wheel': '--x= --y= --dy= --dx= --modifiers=',
  launch: '--timeout= --no-attach --activate',
  'close-app': '',
  'list-windows': `--app= ${REF}`,
  'list-displays': '',
  'list-apps': `--app= ${REF}`,
  'focus-window': `${WINDOW} --title=`,
  'resize-window': `${WINDOW} --width= --height=`,
  'move-window': `${WINDOW} --x= --y=`,
  minimize: WINDOW,
  maximize: WINDOW,
  restore: WINDOW,
  'list-surfaces': '--app=',
  'list-notifications': '--app= --text= --limit=',
  'dismiss-notification': '--app= --expected-app= --expected-title=',
  'dismiss-all-notifications': '--app=',
  'notification-action': '--expected-app= --expected-title=',
  'clipboard-set': '',
  'clipboard-clear': '',
  wait: `--element= --window= --text= --menu --menu-closed --notification --event= --window-id= --predicate= --value= --action= --count= --timeout= --app=`,
  status: '',
  permissions: '',
  version: '',
  batch: '--stop-on-error --timeout-ms=',
  help: '',
  'skills list': '',
  'skills get': '--full',
  'skills path': '',
  'skills help': '',
  'session start': '--name= --no-trace --cursor --multi-agent',
  'session end': '',
  'session list': '',
  'session gc': '--older-than= --ended',
  'session help': '',
  'cursor-overlay enable':
    '--multi-agent --label= --max-words= --fill= --rim= --accent= --size= --no-ripple --no-highlight --hotspot= --pointer-hotspot= --travel-ms= --bow= --overshoot= --tremor= --dwell-ms= --motion-seed=',
  'cursor-overlay disable': '',
  'cursor-overlay help': '',
};
const WITH_SUBCOMMANDS = new Set(['skills', 'session', 'cursor-overlay']);
// In a batch, the same refusals by argument name (the binary rejects unknown names itself).
const REFUSED_BATCH_KEYS = new Set(
  [...REFUSED_OPTIONS, '--path'].map((option) => option.slice(2).replace(/-/gu, '')),
);
const BATCH_LAUNCH_KEYS = new Set(['app', 'timeout', 'no_attach', 'activate']);
const REFUSED_LAUNCH_NAMES = new Set(
  [
    'cmd powershell powershellise pwsh wt windowsterminal conhost openconsole bash sh zsh fish',
    'dash ksh csh tcsh nu wsl wslg gitbash mintty terminal iterm iterm2 gnometerminal konsole',
    'xterm alacritty kitty wezterm weztermgui hyper tabby warp ghostty foot terminator tilix',
    'xfce4terminal mateterminal lxterminal regedit regedt32 taskmgr mmc systemsettings',
    'systempreferences control gpedit secpol wscript cscript mshta rundll32 regsvr32 msiexec',
    'python python3 pythonw py node perl ruby osascript scripteditor',
  ]
    .join(' ')
    .split(' '),
);
// Scripts, shortcuts and console snap-ins start a shell or something else entirely.
const REFUSED_LAUNCH_EXTENSIONS = new Set(
  [
    '.bat .cmd .ps1 .psm1 .psd1 .vbs .vbe .js .jse .wsf .wsh .hta .msc .cpl .reg .sh .bash .zsh',
    '.command .scpt .applescript .py .pl .rb .lnk .url .scf .inf .msi .appref-ms',
  ]
    .join(' ')
    .split(' '),
);

type ParsedOptions = Readonly<{ values: ReadonlySet<string>; flags: ReadonlySet<string> }>;

function parseOptions(spec: string): ParsedOptions {
  const tokens = `${GLOBAL_OPTIONS} ${spec}`.split(' ').filter((token) => token !== '');
  return {
    values: new Set(
      tokens.filter((token) => token.endsWith('=')).map((token) => token.slice(0, -1)),
    ),
    flags: new Set(tokens.filter((token) => !token.endsWith('='))),
  };
}

/** How the arguments read: the command, and which options and positionals came with it. */
type ReadArgv = Readonly<{
  /** `skills get` for a command with subcommands, or `skills` alone; `undefined` for none. */
  command: string | undefined;
  /** Set once the command (and subcommand, if it has them) is complete. */
  key: string | undefined;
  /** The help and version options given, by name. */
  help: readonly string[];
  /** Whether any option shared by every command (`--session`, `--headed`, `-w` …) was given. */
  global: boolean;
  separated: boolean;
  positionals: readonly string[];
}>;

const GLOBAL_OPTION_NAMES = new Set(
  GLOBAL_OPTIONS.split(' ').map((token) => (token.endsWith('=') ? token.slice(0, -1) : token)),
);

/** The arguments as the desktop-control binary reads them, or why they are refused. */
function readDesktopControlArgv(argv: readonly string[]): ReadArgv | string {
  let command: string | undefined;
  let key: string | undefined;
  let options = parseOptions('');
  const help: string[] = [];
  let global = false;
  let separated = false;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (separated) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      if (key === undefined) return refusal('-- の位置を判定できない');
      separated = true;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      const name = optionName(token);
      if (REFUSED_OPTIONS.has(name)) return refusal(`${name} は使えない`);
      if (GLOBAL_OPTION_NAMES.has(name)) global = true;
      if (HELP_OPTIONS.has(name) && name === token) help.push(name);
      else if (options.values.has(name)) {
        if (!token.includes('=') && (index += 1) >= argv.length)
          return refusal(`${name} に値が無い`);
      } else if (!options.flags.has(token))
        return refusal(
          `${token} を判定できない（${key ?? command ?? 'デスクトップ操作'} で使える option だけにする）`,
        );
      continue;
    }
    if (command === undefined) {
      command = token;
      if (REFUSED_COMMANDS.has(command)) return refusal(`${command} は使えない`);
      if (WITH_SUBCOMMANDS.has(command)) continue;
    } else if (key === undefined) {
      if (COMMAND_OPTIONS[`${command} ${token}`] === undefined)
        return refusal(`${command} ${token} を判定できない`);
      command = `${command} ${token}`;
    } else {
      positionals.push(token);
      continue;
    }
    key = command;
    const spec = COMMAND_OPTIONS[key];
    if (spec === undefined) return refusal(`${key} を判定できない`);
    options = parseOptions(spec);
  }
  return { command, key, help, global, separated, positionals };
}

// Commands that only print what is compiled into the binary or its own state, and touch no other
// app, window or file: checked on the desktop-control binary 1.2.0. `status` reports permissions,
// platform, version, its state folder and the last snapshot's id and ref count, never a window's
// title or content. `skills` alone lists the skills.
const INERT_COMMANDS = new Set([
  'skills',
  'skills list',
  'skills get',
  'skills path',
  'skills help',
  'status',
  'version',
  'permissions',
  'help',
]);
// The skill names `skills get` accepts on the desktop-control binary 1.2.0 (`skills get --help`,
// `skills list`), and the form of a reference name such as `commands-system`. The binary's own
// answer to anything else is not relied on: other positionals keep the card.
const INERT_SKILL_NAMES = new Set([
  'desktop',
  'platform',
  'macos',
  'windows',
  'linux',
  'ffi',
  'jev',
]);
const INERT_SKILL_REFERENCE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** Whether the positionals of an inert command are ones it is known to only print for. */
function inertPositionals(command: string, positionals: readonly string[]): boolean {
  if (positionals.length === 0) return true;
  if (command === 'skills get')
    return (
      positionals.length <= 2 &&
      INERT_SKILL_NAMES.has(positionals[0]!) &&
      (positionals[1] === undefined || INERT_SKILL_REFERENCE.test(positionals[1]))
    );
  if (command !== 'help' || positionals.length > 2) return false;
  // `help <command>` or `help <command> <subcommand>`, named as the commands above are.
  const [name, sub] = positionals as [string, string | undefined];
  if (sub === undefined) return COMMAND_OPTIONS[name] !== undefined || WITH_SUBCOMMANDS.has(name);
  return WITH_SUBCOMMANDS.has(name) && COMMAND_OPTIONS[`${name} ${sub}`] !== undefined;
}

/**
 * Whether these arguments, which are never refused, only print the bundled guides, the version,
 * help or the binary's own status, touching no other app, window or file. Such a run needs no
 * approval card. Any option shared by every command (`--headed`, `--session`, `-w` …) keeps the
 * card, and so does every other command, `batch` included.
 */
export function desktopControlArgvIsInert(argv: readonly string[]): boolean {
  const read = readDesktopControlArgv(argv);
  if (typeof read === 'string' || read.global || read.separated) return false;
  if (read.help.length > 0) {
    // Top-level help or version alone, or `<command> --help` with nothing else.
    if (read.command === undefined) return read.positionals.length === 0;
    return (
      !read.command.startsWith('batch') &&
      read.positionals.length === 0 &&
      argv.length === read.command.split(' ').length + read.help.length &&
      read.help.every((name) => name === '-h' || name === '--help')
    );
  }
  return (
    read.command !== undefined &&
    INERT_COMMANDS.has(read.command) &&
    // No path separator, dot, colon, space, control character or leading dash in any of them.
    read.positionals.every((token) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(token)) &&
    inertPositionals(read.command, read.positionals)
  );
}

/** Why the desktop-control binary must not run with these arguments, or `null` when it may. */
export function desktopControlArgvRefusal(
  argv: readonly string[],
  workspaceRoots: readonly string[],
  lookup: DesktopControlLookup = {},
): string | null {
  const read = readDesktopControlArgv(argv);
  if (typeof read === 'string') return read;
  const { key, positionals } = read;
  // Help and version print and exit without acting.
  if (read.help.length > 0 || key === undefined) return null;
  if (key === 'screenshot' && positionals.length > 0)
    return refusal('screenshot の保存先は指定できない');
  if (key === 'launch')
    return positionals.length === 1
      ? launchTargetRefusal(positionals[0]!, workspaceRoots, lookup)
      : refusal('launch に渡せるのはアプリ名か Workspace の外の絶対パス 1 つだけ');
  if (key === 'batch')
    return positionals.length === 1
      ? batchRefusal(positionals[0]!, workspaceRoots, lookup)
      : refusal('batch には JSON の配列を 1 つだけ渡す');
  return null;
}

function refusal(reason: string): string {
  return `デスクトップ操作の実行を拒否した: ${reason}。`;
}

function optionName(token: string): string {
  const equals = token.indexOf('=');
  return equals < 0 ? token : token.slice(0, equals);
}

function launchTargetRefusal(
  target: string,
  workspaceRoots: readonly string[],
  lookup: DesktopControlLookup,
): string | null {
  const platform = lookup.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const app = target.trim();
  if (app === '') return refusal('launch の対象が空');
  if (/^[a-z][a-z0-9+.-]+:/iu.test(app) && !/^[a-z]:[\\/]/iu.test(app))
    return refusal(`launch で URI（${app}）は開けない`);
  if (/[\\/]/u.test(app)) {
    if (!paths.isAbsolute(app) || app.startsWith('\\\\') || app.startsWith('//'))
      return refusal('launch のパスは Workspace の外の絶対パスだけ');
    if (!outsideWorkspaceRoots(app, workspaceRoots, lookup))
      return refusal('launch で Workspace の中の実行ファイルは起動できない');
  }
  // A convenience for an obvious mistake, not a boundary: the card is.
  const base = app.split(/[\\/]/u).pop() ?? '';
  const lower = base.toLowerCase();
  const extension = /\.[a-z0-9-]+$/u.exec(lower)?.[0] ?? '';
  const stem = ['.exe', '.com', '.app'].includes(extension)
    ? lower.slice(0, -extension.length)
    : lower;
  const names = [stem, ...stem.split('.')].map((name) => name.replace(/[^a-z0-9]/gu, ''));
  if (
    REFUSED_LAUNCH_EXTENSIONS.has(extension) ||
    names.some((name) => REFUSED_LAUNCH_NAMES.has(name))
  )
    return refusal(`${base} は起動できない（端末・shell・設定の道具）`);
  return null;
}

function batchRefusal(
  json: string,
  workspaceRoots: readonly string[],
  lookup: DesktopControlLookup,
): string | null {
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch {
    return refusal('batch の JSON を読めない');
  }
  if (!Array.isArray(entries)) return refusal('batch の JSON は配列にする');
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      return refusal('batch の形を判定できない');
    const { command, args, ...extra } = entry as Record<string, unknown>;
    if (Object.keys(extra).length > 0 || typeof command !== 'string')
      return refusal('batch の形を判定できない');
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args)))
      return refusal('batch の args を判定できない');
    if (REFUSED_COMMANDS.has(command) || command === 'batch')
      return refusal(`batch の中の ${command} は使えない`);
    if (COMMAND_OPTIONS[command] === undefined || WITH_SUBCOMMANDS.has(command))
      return refusal(`batch の中の ${command} を判定できない`);
    const fields = (args ?? {}) as Record<string, unknown>;
    if (command === 'launch') {
      const unknown = Object.keys(fields).find((name) => !BATCH_LAUNCH_KEYS.has(name));
      if (unknown !== undefined) return refusal(`batch の中の launch の ${unknown} は使えない`);
      if (typeof fields['app'] !== 'string')
        return refusal('batch の launch の app を判定できない');
      const reason = launchTargetRefusal(fields['app'], workspaceRoots, lookup);
      if (reason !== null) return reason;
    }
    const keyRefusal = refusedBatchKey(fields);
    if (keyRefusal !== null) return keyRefusal;
  }
  return null;
}

function refusedBatchKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = refusedBatchKey(item);
      if (reason !== null) return reason;
    }
  } else if (typeof value === 'object' && value !== null)
    for (const [key, item] of Object.entries(value)) {
      if (REFUSED_BATCH_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/gu, '')))
        return refusal(`batch の中の ${key} は使えない`);
      const reason = refusedBatchKey(item);
      if (reason !== null) return reason;
    }
  return null;
}

// Hashing the ~4 MB binary on every lookup would be slow, so the digest is kept per file version.
// This only decides whether to offer desktop control; the run itself is judged on the digest of
// the sealed image that starts (CommandRunner.run).
const digestCache = new Map<string, Readonly<{ version: string; digest: string }>>();

function cachedFileDigest(path: string): string | null {
  try {
    const stats = statSync(path, { bigint: true });
    if (!stats.isFile()) return null;
    const version = [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
    const cached = digestCache.get(path);
    if (cached?.version === version) return cached.digest;
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    digestCache.set(path, { version, digest });
    return digest;
  } catch {
    return null;
  }
}

function sealedFileDigest(path: string): string | null {
  try {
    const manifest = `${path}.sha256`;
    if (!statSync(manifest).isFile()) return null;
    return readFileSync(manifest, 'utf8').trim();
  } catch {
    return null;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
