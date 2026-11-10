import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { agentDesktopPin } from './agent-desktop-pins';

/**
 * Sprint Coder's desktop control is the agent-desktop CLI (vercel-labs/agent-desktop, Apache-2.0)
 * that ships with the app: one native binary, pinned by its SHA-256 in `agent-desktop-pins.ts`.
 * The agent runs it through its ordinary shell tool, so the command approval and Stop that already
 * cover every shell command cover it too.
 *
 * Only the shipped copy is used: the packaged app's resources, or, in a development run, the
 * package in the repository's node_modules. No environment variable or PATH lookup can point it
 * elsewhere. A file whose bytes are not the pinned ones is not agent-desktop, and then the guidance
 * is left out entirely. Windows only for now (see `agent-desktop-pins.ts`); elsewhere this is
 * always `null`.
 */
export type AgentDesktopLookup = Readonly<{
  platform?: NodeJS.Platform;
  arch?: string;
  /** Whether this is the packaged app; otherwise a development run from the repository. */
  packaged?: boolean;
  resourcesPath?: string;
  /** The repository root whose node_modules holds the package in a development run. */
  repositoryRoot?: string;
  /** SHA-256 (hex) of the file's current bytes, or `null` when it is not a readable file. */
  contentDigest?: (path: string) => string | null;
  realpath?: (path: string) => string;
}>;

export function resolveAgentDesktopCommand(lookup: AgentDesktopLookup = {}): string | null {
  const platform = lookup.platform ?? process.platform;
  if (platform !== 'win32') return null;
  const pin = agentDesktopPin(platform, lookup.arch ?? process.arch);
  if (pin === null) return null;
  const packaged = lookup.packaged ?? __dirname.includes('app.asar');
  let candidate: string;
  if (packaged) {
    const resources = lookup.resourcesPath ?? process.resourcesPath;
    if (typeof resources !== 'string' || !win32.isAbsolute(resources)) return null;
    candidate = win32.join(resources, pin.file);
  } else {
    // `.vite/build` (the built main) and `src/main` (tests) are both four levels below the root.
    const root = lookup.repositoryRoot ?? resolve(__dirname, '..', '..', '..', '..');
    candidate = win32.join(root, 'node_modules', 'agent-desktop', 'bin', pin.file);
  }
  return (lookup.contentDigest ?? cachedFileDigest)(candidate) === pin.sha256 ? candidate : null;
}

/**
 * Whether a sealed executable is the shipped agent-desktop: its content digest (the bytes that
 * were sealed, or that are about to start) equals the pin, and it is the shipped file. The path
 * alone never qualifies, so a file that only resolves to the shipped location cannot borrow its
 * trust.
 */
export function isAgentDesktopExecutable(
  executable: string,
  contentDigest: string | null,
  lookup: AgentDesktopLookup = {},
): boolean {
  const platform = lookup.platform ?? process.platform;
  const pin = agentDesktopPin(platform, lookup.arch ?? process.arch);
  if (pin === null || contentDigest !== pin.sha256) return false;
  const native = resolveAgentDesktopCommand(lookup);
  return native !== null && comparisonKey(executable, lookup) === comparisonKey(native, lookup);
}

/**
 * Whether one approved command may run outside the command sandbox: only the shipped agent-desktop
 * (see `isAgentDesktopExecutable`), judged on the digest of the image about to start, and only
 * when it does not live inside any root of the Turn's Workspace. Desktop control cannot work in
 * the sandbox, which hides other apps' windows and processes and `~/.agent-desktop`.
 */
export function runsOutsideCommandSandbox(
  executable: string,
  contentDigest: string | null,
  workspaceRoots: readonly string[],
  lookup: AgentDesktopLookup = {},
): boolean {
  return (
    isAgentDesktopExecutable(executable, contentDigest, lookup) &&
    outsideWorkspaceRoots(executable, workspaceRoots, lookup)
  );
}

function comparisonKey(path: string, lookup: AgentDesktopLookup): string {
  const platform = lookup.platform ?? process.platform;
  const normalized = (platform === 'win32' ? win32 : posix).normalize(
    (lookup.realpath ?? canonicalPath)(path),
  );
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function outsideWorkspaceRoots(
  path: string,
  workspaceRoots: readonly string[],
  lookup: AgentDesktopLookup,
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
// agent-desktop run on its own approval card; nothing here makes operating the desktop safe, since
// keystrokes reach whatever window has focus. This check only drops the plainly dangerous forms
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
// Every option of agent-desktop 1.2.0 (`<command> --help`) except the refused ones above. `=`
// marks an option that takes a value. Commands with subcommands are listed as `command sub`.
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
// In a batch, the same refusals by argument name (agent-desktop rejects unknown names itself).
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

/** Why agent-desktop must not run with these arguments, or `null` when it may. */
export function agentDesktopArgvRefusal(
  argv: readonly string[],
  workspaceRoots: readonly string[],
  lookup: AgentDesktopLookup = {},
): string | null {
  let command: string | undefined;
  let key: string | undefined;
  let options = parseOptions('');
  let help = false;
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
      if (HELP_OPTIONS.has(name) && name === token) help = true;
      else if (options.values.has(name)) {
        if (!token.includes('=') && (index += 1) >= argv.length)
          return refusal(`${name} に値が無い`);
      } else if (!options.flags.has(token))
        return refusal(
          `${token} を判定できない（${key ?? command ?? 'agent-desktop'} で使える option だけにする）`,
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
  // Help and version print and exit without acting.
  if (help || key === undefined) return null;
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
  return `agent-desktop の実行を拒否した: ${reason}。`;
}

function optionName(token: string): string {
  const equals = token.indexOf('=');
  return equals < 0 ? token : token.slice(0, equals);
}

function launchTargetRefusal(
  target: string,
  workspaceRoots: readonly string[],
  lookup: AgentDesktopLookup,
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
  lookup: AgentDesktopLookup,
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

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
