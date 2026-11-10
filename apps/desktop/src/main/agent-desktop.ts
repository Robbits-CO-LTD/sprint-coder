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

// The arguments are what the agent chose, and outside the sandbox the binary acts with the user's
// own authority. Anything that would hand out more than looking at and operating the apps on
// screen is refused here, before an approval card exists: a terminal, shell, script host or
// settings tool to launch, a long-lived server (`mcp`), the clipboard's contents, an arbitrary
// file to write (`--trace`, `--screenshot`, a screenshot path), or anything this cannot parse.
const GLOBAL_VALUE_OPTIONS = [
  '--session',
  '--agent-id',
  '-w',
  '--wait-for',
  '--wait-for-gone',
  '--wait-timeout',
];
const GLOBAL_FLAGS = new Set(['-v', '--verbose', '--headed', '-h', '--help', '-V', '--version']);
const REFUSED_OPTIONS = new Set([
  '--trace',
  '--trace-strict',
  '--screenshot',
  '--debug',
  '--cdp',
  '--image',
  '--file-url',
  '--out',
]);
const REFUSED_COMMANDS = new Set(['mcp', 'open-system-surface', 'clipboard-get', 'trace']);
const KNOWN_COMMANDS = new Set(
  [
    'snapshot find screenshot get is click double-click triple-click right-click type set-value',
    'clear focus select toggle check uncheck expand collapse scroll scroll-to press key-down',
    'key-up hover drag mouse-move mouse-click mouse-down mouse-up mouse-wheel launch close-app',
    'list-windows list-displays list-apps focus-window resize-window move-window minimize',
    'maximize restore list-surfaces list-notifications dismiss-notification',
    'dismiss-all-notifications notification-action clipboard-set clipboard-clear wait status',
    'permissions version batch skills session cursor-overlay help',
  ]
    .join(' ')
    .split(' '),
);
// Commands whose positional arguments are checked, with the options that take a value.
const POSITIONAL_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  launch: ['--timeout', '--arg', '--env', '--cwd'],
  batch: ['--timeout-ms'],
  screenshot: ['--app', '--window-id', '--screen'],
};
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  launch: ['--activate', '--no-attach'],
  batch: ['--stop-on-error'],
};
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
const REFUSED_BATCH_KEYS = new Set([
  'trace',
  'tracestrict',
  'screenshot',
  'debug',
  'cdp',
  'image',
  'fileurl',
  'out',
  'path',
]);

/** Why agent-desktop must not run with these arguments, or `null` when it may. */
export function agentDesktopArgvRefusal(
  argv: readonly string[],
  workspaceRoots: readonly string[],
  lookup: AgentDesktopLookup = {},
): string | null {
  let index = 0;
  let command: string | undefined;
  for (; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('-')) {
      command = token;
      break;
    }
    const name = optionName(token);
    if (REFUSED_OPTIONS.has(name)) return refusal(`${name} は使えない`);
    if (GLOBAL_VALUE_OPTIONS.includes(name)) {
      if (!token.includes('=')) index += 1;
    } else if (!GLOBAL_FLAGS.has(name)) return refusal(`${token} を判定できない`);
  }
  if (command === undefined) return null;
  if (REFUSED_COMMANDS.has(command)) return refusal(`${command} は使えない`);
  if (!KNOWN_COMMANDS.has(command)) return refusal(`${command} を判定できない`);
  const rest = argv.slice(index + 1);
  const separator = rest.indexOf('--');
  for (const token of separator < 0 ? rest : rest.slice(0, separator))
    if (token.startsWith('-') && REFUSED_OPTIONS.has(optionName(token)))
      return refusal(`${optionName(token)} は使えない`);
  const valueOptions = POSITIONAL_COMMANDS[command];
  if (valueOptions === undefined) return null;
  const positionals: string[] = [];
  const values: string[] = [];
  for (let at = 0; at < rest.length; at += 1) {
    const token = rest[at]!;
    if (at > separator && separator >= 0) {
      positionals.push(token);
      continue;
    }
    if (token === '--' || !token.startsWith('-')) {
      if (token !== '--') positionals.push(token);
      continue;
    }
    const name = optionName(token);
    if ([...valueOptions, ...GLOBAL_VALUE_OPTIONS].includes(name)) {
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : rest[(at += 1)];
      if (value === undefined) return refusal(`${name} に値が無い`);
      values.push(value);
    } else if (!GLOBAL_FLAGS.has(name) && !(COMMAND_FLAGS[command] ?? []).includes(name))
      return refusal(`${token} を判定できない`);
  }
  if (command === 'screenshot')
    return positionals.length === 0 ? null : refusal('screenshot の保存先は指定できない');
  if (positionals.length !== 1) return refusal(`${command} の引数を判定できない`);
  if (command === 'launch')
    return (
      launchTargetRefusal(positionals[0]!, workspaceRoots, lookup) ??
      values.map(launchValueRefusal).find((reason) => reason !== null) ??
      null
    );
  return batchRefusal(positionals[0]!, workspaceRoots, lookup);
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
    // A path outside the Workspace was not written by the agent's sandboxed commands; one inside
    // could be anything the agent built.
    if (!paths.isAbsolute(app) || app.startsWith('\\\\') || app.startsWith('//'))
      return refusal('launch のパスは Workspace の外の絶対パスだけ');
    if (!outsideWorkspaceRoots(app, workspaceRoots, lookup))
      return refusal('launch で Workspace の中の実行ファイルは起動できない');
  }
  return launchValueRefusal(app);
}

// Names a terminal, shell, script host or settings tool, with or without a path or `.exe`.
function launchValueRefusal(value: string): string | null {
  for (const part of value.split('=')) {
    const base =
      part
        .trim()
        .replace(/^["']|["']$/gu, '')
        .split(/[\\/]/u)
        .pop() ?? '';
    const lower = base.toLowerCase();
    const extension = /\.[a-z0-9-]+$/u.exec(lower)?.[0] ?? '';
    if (REFUSED_LAUNCH_EXTENSIONS.has(extension))
      return refusal(`${base} は起動できない（端末・shell・設定の道具）`);
    const stem = ['.exe', '.com', '.app'].includes(extension)
      ? lower.slice(0, -extension.length)
      : lower;
    const names = [stem, ...stem.split('.')].map((name) => name.replace(/[^a-z0-9]/gu, ''));
    if (names.some((name) => REFUSED_LAUNCH_NAMES.has(name)))
      return refusal(`${base} は起動できない（端末・shell・設定の道具）`);
  }
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
    if (!KNOWN_COMMANDS.has(command)) return refusal(`batch の中の ${command} を判定できない`);
    const fields = (args ?? {}) as Record<string, unknown>;
    const strings: string[] = [];
    const keyRefusal = collectBatchStrings(fields, strings);
    if (keyRefusal !== null) return keyRefusal;
    if (command === 'launch') {
      if (typeof fields['app'] !== 'string')
        return refusal('batch の launch の app を判定できない');
      const reason =
        launchTargetRefusal(fields['app'], workspaceRoots, lookup) ??
        strings.map(launchValueRefusal).find((found) => found !== null) ??
        null;
      if (reason !== null) return reason;
    }
  }
  return null;
}

function collectBatchStrings(value: unknown, strings: string[]): string | null {
  if (typeof value === 'string') strings.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) {
      const reason = collectBatchStrings(item, strings);
      if (reason !== null) return reason;
    }
  } else if (typeof value === 'object' && value !== null)
    for (const [key, item] of Object.entries(value)) {
      if (REFUSED_BATCH_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/gu, '')))
        return refusal(`batch の中の ${key} は使えない`);
      const reason = collectBatchStrings(item, strings);
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
