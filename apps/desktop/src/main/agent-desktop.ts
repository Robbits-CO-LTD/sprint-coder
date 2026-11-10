import { realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * Desktop control goes through the external `agent-desktop` CLI (vercel-labs/agent-desktop,
 * Apache-2.0). Sprint Coder does not ship or wrap it: the agent runs it through its ordinary shell
 * tool, so the command approval and Stop that already cover every shell command cover it too.
 *
 * `SPRINT_CODER_AGENT_DESKTOP` names the executable explicitly (an absolute path); otherwise the
 * first `agent-desktop` on PATH is used. Nothing found means the guidance is left out entirely.
 * Either way the result is the native binary itself, never the npm shim or the Node launcher, so
 * it is the one file `runsOutsideCommandSandbox` can match exactly.
 */
export const AGENT_DESKTOP_PATH_ENV = 'SPRINT_CODER_AGENT_DESKTOP';

export type AgentDesktopLookup = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  arch?: string;
  isFile?: (path: string) => boolean;
  realpath?: (path: string) => string;
}>;

const NATIVE_NAME = /^agent-desktop(?:-(?:win32|darwin|linux)-[a-z0-9]+)?(?:\.exe)?$/iu;

export function resolveAgentDesktopCommand(lookup: AgentDesktopLookup = {}): string | null {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const isFile = lookup.isFile ?? isRegularFile;
  const paths = platform === 'win32' ? win32 : posix;
  const explicit = env[AGENT_DESKTOP_PATH_ENV]?.trim();
  if (explicit !== undefined && explicit !== '')
    return paths.isAbsolute(explicit) && isFile(explicit) ? nativeBinary(explicit, lookup) : null;
  const pathValue = platform === 'win32' ? (env['Path'] ?? env['PATH']) : env['PATH'];
  if (pathValue === undefined || pathValue === '') return null;
  // npm's global install leaves `agent-desktop.cmd` on Windows; a release archive leaves the `.exe`.
  const names =
    platform === 'win32' ? ['agent-desktop.cmd', 'agent-desktop.exe'] : ['agent-desktop'];
  for (const entry of pathValue.split(paths.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (directory === '' || !paths.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = paths.join(directory, name);
      if (!isFile(candidate)) continue;
      const native = nativeBinary(candidate, lookup);
      if (native !== null) return native;
    }
  }
  return null;
}

/**
 * Whether one approved command may run outside the command sandbox: only the native agent-desktop
 * binary found above, matched by canonical path, and only when it does not live inside any root
 * of the Turn's Workspace (where the agent could have replaced it). Desktop control cannot work in
 * the sandbox, which hides other apps' windows and processes and `~/.agent-desktop`.
 */
export function runsOutsideCommandSandbox(
  executable: string,
  workspaceRoots: readonly string[],
  lookup: AgentDesktopLookup = {},
): boolean {
  return (
    isAgentDesktopBinary(executable, lookup) &&
    outsideWorkspaceRoots(executable, workspaceRoots, lookup)
  );
}

/** Whether `executable` is the native agent-desktop binary found above, by canonical path. */
export function isAgentDesktopBinary(executable: string, lookup: AgentDesktopLookup = {}): boolean {
  const native = resolveAgentDesktopCommand(lookup);
  return native !== null && comparisonKey(executable, lookup) === comparisonKey(native, lookup);
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

// The npm shim and the Node launcher only start the native binary next to the package's launcher.
function nativeBinary(found: string, lookup: AgentDesktopLookup): string | null {
  const platform = lookup.platform ?? process.platform;
  const arch = lookup.arch ?? process.arch;
  const isFile = lookup.isFile ?? isRegularFile;
  const paths = platform === 'win32' ? win32 : posix;
  let native = found;
  if (platform === 'win32' && paths.extname(found).toLowerCase() === '.cmd') {
    // `<prefix>\agent-desktop.cmd` (global) or `<project>\node_modules\.bin\agent-desktop.cmd`.
    const directory = paths.dirname(found);
    const binary = `agent-desktop-win32-${arch}.exe`;
    native =
      [
        paths.join(directory, 'node_modules', 'agent-desktop', 'bin', binary),
        paths.join(directory, '..', 'agent-desktop', 'bin', binary),
      ].find(isFile) ?? '';
    if (native === '') return null;
  } else if (platform !== 'win32') {
    const launcher = (lookup.realpath ?? canonicalPath)(found);
    const sibling = paths.join(paths.dirname(launcher), `agent-desktop-${platform}-${arch}`);
    native = isFile(sibling) ? sibling : launcher;
  }
  return NATIVE_NAME.test(paths.basename(native)) ? native : null;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
