import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { DESKTOP_CONTROL_EXECUTABLE, desktopControlSupported } from './desktop-control-build';
import { startMenuShortcuts, type StartMenuShortcut } from './desktop-control-start-menu';
import { applyWindowsAcl } from './native-file-publication';
import { secureLogger } from './secure-logger';

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
  /** The Start menu's shortcuts for `launch <name>`, or `null` when they are not read. */
  startMenuShortcuts?: () => readonly StartMenuShortcut[] | null;
  /** Whether the path is an existing regular file. */
  isFile?: (path: string) => boolean;
  /** The environment the paths of shortcuts and the system folders are read with. */
  environment?: Readonly<Record<string, string | undefined>>;
}>;

/**
 * Where the shipped file should be: `null` where desktop control is not built, and `''` in a
 * packaged app whose resources folder is unknown.
 */
function shippedCandidate(lookup: DesktopControlLookup): Readonly<{
  path: string;
  packaged: boolean;
}> | null {
  const platform = lookup.platform ?? process.platform;
  if (!desktopControlSupported(platform, lookup.arch ?? process.arch)) return null;
  const packaged = lookup.packaged ?? __dirname.includes('app.asar');
  if (packaged) {
    const resources = lookup.resourcesPath ?? process.resourcesPath;
    if (typeof resources !== 'string' || !win32.isAbsolute(resources))
      return { path: '', packaged };
    return { path: win32.join(resources, DESKTOP_CONTROL_EXECUTABLE), packaged };
  }
  // `.vite/build` (the built main) and `src/main` (tests) are both four levels below the root.
  const root = lookup.repositoryRoot ?? resolve(__dirname, '..', '..', '..', '..');
  return {
    path: win32.join(root, ...DEVELOPMENT_BUILD_FOLDER, DESKTOP_CONTROL_EXECUTABLE),
    packaged,
  };
}

/** The build output in the repository that a development run uses. */
const DEVELOPMENT_BUILD_FOLDER = ['apps', 'desktop', 'desktop-control', 'build', 'Release'];

/** The shipped file and the digest it is sealed with, when its bytes are the sealed ones. */
function shippedDesktopControl(
  lookup: DesktopControlLookup,
): Readonly<{ path: string; digest: string }> | null {
  const candidate = shippedCandidate(lookup)?.path ?? '';
  if (candidate === '') return null;
  const digest = (lookup.sealedDigest ?? sealedFileDigest)(candidate);
  if (digest === null || !SHA256.test(digest)) return null;
  return (lookup.contentDigest ?? cachedFileDigest)(candidate) === digest
    ? { path: candidate, digest }
    : null;
}

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Why desktop control is off on a platform it is built for, for the startup log, or `null` when it
 * is on or not built for this platform at all. A development run is told how to build it; a
 * packaged app only why, since its copy comes with the app. Names no full path: the file is named
 * by where it lives.
 */
export function desktopControlUnavailableReason(lookup: DesktopControlLookup = {}): string | null {
  const candidate = shippedCandidate(lookup);
  if (candidate === null || shippedDesktopControl(lookup) !== null) return null;
  const where = candidate.packaged
    ? `resources\\${DESKTOP_CONTROL_EXECUTABLE}`
    : [...DEVELOPMENT_BUILD_FOLDER, DESKTOP_CONTROL_EXECUTABLE].join('/');
  let reason: string;
  if (candidate.path === '') reason = "the app's resources folder is unknown";
  else {
    const sealed = (lookup.sealedDigest ?? sealedFileDigest)(candidate.path);
    const content = (lookup.contentDigest ?? cachedFileDigest)(candidate.path);
    if (content === null && sealed === null)
      reason = candidate.packaged
        ? `${where} and its .sha256 manifest are missing`
        : `the executable has not been built (${where} and its .sha256 manifest are missing)`;
    else if (content === null) reason = `${where} is missing or unreadable`;
    else if (sealed === null) reason = `the .sha256 manifest beside ${where} is missing`;
    else if (!SHA256.test(sealed))
      reason = `the .sha256 manifest beside ${where} does not hold a SHA-256 digest`;
    else reason = `the bytes of ${where} do not match the SHA-256 in its .sha256 manifest`;
  }
  return candidate.packaged
    ? `Desktop control is off: ${reason}.`
    : `Desktop control is off: ${reason}. Run \`npm run build:desktop-control\` at the repository root, then restart.`;
}

/**
 * Logs once at startup why desktop control is off, on Windows x64 only (see
 * `desktopControlUnavailableReason`); otherwise logs nothing.
 */
export function reportDesktopControlAvailability(
  lookup: DesktopControlLookup = {},
  warn: (message: string) => void = (message) =>
    secureLogger.warn(message, undefined, { event: 'system.desktop_control.unavailable' }),
): void {
  const reason = desktopControlUnavailableReason(lookup);
  if (reason !== null) warn(reason);
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
 * Whether a recorded command ran the shipped desktop-control binary, for the timeline only: its
 * path is the shipped file, whose bytes are checked against the pin. A recorded command keeps no
 * content digest, so this decides nothing about running; the run itself was judged on its bytes.
 */
export function isShippedDesktopControlPath(
  executable: string,
  lookup: DesktopControlLookup = {},
): boolean {
  const native = resolveDesktopControlCommand(lookup);
  return native !== null && comparisonKey(executable, lookup) === comparisonKey(native, lookup);
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
  expectedWindowOwner?: string,
): Readonly<Record<string, string>> {
  const windows = (lookup.platform ?? process.platform) === 'win32';
  const paths = windows ? win32 : posix;
  const separator = windows ? ';' : ':';
  // The run always gets the folder the approval card reads its snapshots from, whether that is
  // Sprint Coder's own or the binary's default, and never one the caller chose in any letter case:
  // otherwise a refmap the agent wrote elsewhere could name a different part on the card than the
  // one the run operates. The binary finds its default from HOME or USERPROFILE, which the caller
  // may also set, so the default is passed explicitly too.
  // The owner a window id must still belong to is set by Main alone, for a run allowed by an
  // app-wide Task grant (`expectedWindowOwner`); one the caller chose, in any letter case, is
  // always dropped.
  const owned = [DESKTOP_CONTROL_STATE_VARIABLE, DESKTOP_CONTROL_EXPECTED_WINDOW_OWNER_VARIABLE];
  const filtered = Object.entries(environment).filter(
    ([key]) => !owned.includes(windows ? key.toUpperCase() : key),
  );
  filtered.push([DESKTOP_CONTROL_STATE_VARIABLE, desktopControlStateFolder()]);
  if (expectedWindowOwner !== undefined)
    filtered.push([DESKTOP_CONTROL_EXPECTED_WINDOW_OWNER_VARIABLE, expectedWindowOwner]);
  return Object.fromEntries(
    filtered.map(([key, value]) => {
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

/** The variable the desktop-control binary 1.2.0 reads its state folder from (an absolute path). */
const DESKTOP_CONTROL_STATE_VARIABLE = 'AGENT_DESKTOP_HOME';
/**
 * The variable the shipped desktop-control executable reads the expected owner of a window id
 * from (`src/dispatch/window_owner.rs`), as `<pid>:<process instance>`. With it, every command that
 * names a window id fails before reading or doing anything unless that window belongs to exactly
 * that process instance right now.
 */
export const DESKTOP_CONTROL_EXPECTED_WINDOW_OWNER_VARIABLE =
  'SPRINT_CODER_DESKTOP_EXPECTED_WINDOW_OWNER';

/** That variable's value for a process, or `null` when it cannot be written in that form. */
export function desktopControlExpectedWindowOwner(owner: {
  pid: number;
  instance: string;
}): string | null {
  return Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    owner.pid <= 0xffff_ffff &&
    /^[A-Za-z0-9:._-]{1,128}$/u.test(owner.instance)
    ? `${owner.pid}:${owner.instance}`
    : null;
}
let configuredStateRoot: string | null = null;

/**
 * Sets the folder, under Sprint Coder's own data, where every desktop-control run outside the
 * sandbox keeps its snapshots. The approval card reads the names of the parts a ref points at from
 * there (`desktop-control-display.ts`). Called once at startup; until then, and in tests, runs keep
 * the binary's default folder in the user's home and the card reads that one.
 *
 * The binary refuses a state folder whose DACL grants anyone but the user, SYSTEM and
 * Administrators any access, even read (checked on 1.2.0). A folder under a drive root inherits
 * Authenticated Users and Users, so the folder is made private on every start, which also repairs
 * one an earlier version left inheriting. When that cannot be done, the folder is not used at all
 * and runs are pointed at the default folder of `desktopControlStateFolder`, the one the card then
 * reads, so the run and the card never read different folders.
 */
export function configureDesktopControlStateRoot(
  root: string | null,
  makePrivate: (folder: string) => void = (folder) =>
    applyWindowsAcl(folder, 'directory', 'secure'),
): void {
  configuredStateRoot = null;
  // Desktop control ships for Windows only, the one place its folder can be checked here.
  if (root === null || process.platform !== 'win32' || !win32.isAbsolute(root)) return;
  const folder = win32.normalize(root);
  try {
    mkdirSync(folder, { recursive: true });
    makePrivate(folder);
  } catch {
    return;
  }
  configuredStateRoot = folder;
}

/** The configured state folder, or `null` for the binary's default. */
export function desktopControlStateRoot(): string | null {
  return configuredStateRoot;
}

/**
 * The folder a desktop-control run outside the sandbox keeps its state in, and the one its approval
 * card reads: the configured one, or else Sprint Coder's own inherited variable (an absolute path
 * with a drive letter), then the binary's folder in the home. `desktopControlEnvironment` passes
 * this to every run, so the run never looks anywhere else.
 */
export function desktopControlStateFolder(): string {
  if (configuredStateRoot !== null) return configuredStateRoot;
  const inherited = process.env[DESKTOP_CONTROL_STATE_VARIABLE];
  if (inherited !== undefined && /^[a-z]:[\\/]/iu.test(inherited))
    return win32.normalize(inherited);
  return join(homedir(), '.agent-desktop');
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
// or a working directory to the app, keys or text sent without naming the window or part they go
// to (they would reach whatever is in front), and — as a convenience, never a boundary — launching a
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
  /** Where each positional sits in the argv. */
  positionalIndexes: readonly number[];
  /** Every option given, by name, with its value (`''` for a flag); a repeated one keeps the last. */
  options: ReadonlyMap<string, string>;
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
  const positionalIndexes: number[] = [];
  const given = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (separated) {
      positionals.push(token);
      positionalIndexes.push(index);
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
        given.set(name, token.includes('=') ? token.slice(name.length + 1) : argv[index]!);
        continue;
      } else if (!options.flags.has(token))
        return refusal(
          `${token} を判定できない（${key ?? command ?? 'デスクトップ操作'} で使える option だけにする）`,
        );
      given.set(name, '');
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
      positionalIndexes.push(index);
      continue;
    }
    key = command;
    const spec = COMMAND_OPTIONS[key];
    if (spec === undefined) return refusal(`${key} を判定できない`);
    options = parseOptions(spec);
  }
  return { command, key, help, global, separated, positionals, positionalIndexes, options: given };
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

/**
 * How a desktop-control run meets the person's own use of the desktop, judged on the sealed argv.
 * `inert` prints only what the binary carries (see `desktopControlArgvIsInert`); `read` only reads
 * the screen; `background` operates an app through its accessibility interface without taking the
 * foreground, the cursor or the keyboard; `foreground` uses one of those, or may close an app the
 * person has open. Anything not known to be weaker is `foreground`.
 */
export type DesktopControlMode = 'inert' | 'read' | 'background' | 'foreground';

const MODE_STRENGTH: Readonly<Record<DesktopControlMode, number>> = {
  inert: 0,
  read: 1,
  background: 2,
  foreground: 3,
};

// Checked on the desktop-control binary 1.2.0 (`--help` and its Windows guide): ref actions are
// semantic accessibility calls without `--headed`, except type, focus and the multi- and
// right-clicks, which are physical or take focus; `press` goes to the foreground queue; and
// `focus-window`, `restore`, `maximize` and `launch --activate` bring a window to the front. Every
// command of `COMMAND_OPTIONS` is listed here, and the table is tested to stay complete.
const COMMAND_MODES: Readonly<Record<string, Exclude<DesktopControlMode, 'inert'>>> = {
  snapshot: 'read',
  find: 'read',
  screenshot: 'read',
  get: 'read',
  is: 'read',
  'list-windows': 'read',
  'list-displays': 'read',
  'list-apps': 'read',
  'list-surfaces': 'read',
  'list-notifications': 'read',
  wait: 'read',
  status: 'read',
  permissions: 'read',
  version: 'read',
  help: 'read',
  'skills list': 'read',
  'skills get': 'read',
  'skills path': 'read',
  'skills help': 'read',
  'session list': 'read',
  'session help': 'read',
  'cursor-overlay help': 'read',
  click: 'background',
  'set-value': 'background',
  clear: 'background',
  select: 'background',
  toggle: 'background',
  check: 'background',
  uncheck: 'background',
  expand: 'background',
  collapse: 'background',
  scroll: 'background',
  'scroll-to': 'background',
  launch: 'background',
  minimize: 'background',
  'move-window': 'background',
  'resize-window': 'background',
  'clipboard-set': 'background',
  'clipboard-clear': 'background',
  'dismiss-notification': 'background',
  'dismiss-all-notifications': 'background',
  'notification-action': 'background',
  'session start': 'background',
  'session end': 'background',
  'session gc': 'background',
  'cursor-overlay enable': 'background',
  'cursor-overlay disable': 'background',
  // `batch` takes the strongest mode of its entries (`desktopControlArgvMode`).
  batch: 'background',
  'double-click': 'foreground',
  'triple-click': 'foreground',
  'right-click': 'foreground',
  type: 'foreground',
  focus: 'foreground',
  press: 'foreground',
  'key-down': 'foreground',
  'key-up': 'foreground',
  hover: 'foreground',
  drag: 'foreground',
  'mouse-move': 'foreground',
  'mouse-click': 'foreground',
  'mouse-down': 'foreground',
  'mouse-up': 'foreground',
  'mouse-wheel': 'foreground',
  'focus-window': 'foreground',
  maximize: 'foreground',
  restore: 'foreground',
  'close-app': 'foreground',
};

/** The commands the mode table leaves out (none), for its completeness test. */
export function desktopControlCommandsWithoutMode(): string[] {
  return Object.keys(COMMAND_OPTIONS).filter((command) => !Object.hasOwn(COMMAND_MODES, command));
}

/**
 * How this run meets the person's use of the desktop (see `DesktopControlMode`). Any `--headed`
 * run is `foreground`, and so is anything this cannot read, including a batch whose JSON it cannot
 * read. A batch is as strong as its strongest entry.
 */
export function desktopControlArgvMode(argv: readonly string[]): DesktopControlMode {
  if (desktopControlArgvIsInert(argv)) return 'inert';
  const read = readDesktopControlArgv(argv);
  if (typeof read === 'string' || argv.some((token) => optionName(token) === '--headed'))
    return 'foreground';
  // Help or version with a shared option prints and exits like the inert form.
  if (read.help.length > 0 || read.command === undefined) return 'read';
  const command = read.command;
  if (command === 'launch')
    return argv.some((token) => optionName(token) === '--activate') ? 'foreground' : 'background';
  if (command === 'batch') return batchMode(read.positionals);
  return commandMode(command);
}

function batchMode(positionals: readonly string[]): DesktopControlMode {
  const entries = readBatchEntries(positionals);
  if (entries === null || entries.length === 0) return 'foreground';
  let strongest: DesktopControlMode = 'read';
  for (const { command, args } of entries) {
    const mode = desktopControlBatchEntryMode(command, args);
    if (MODE_STRENGTH[mode] > MODE_STRENGTH[strongest]) strongest = mode;
  }
  return strongest;
}

/** The mode of one batch entry on its own; a `--headed` batch makes every entry `foreground`. */
export function desktopControlBatchEntryMode(
  command: string,
  args: Readonly<Record<string, unknown>>,
): Exclude<DesktopControlMode, 'inert'> {
  if (command === 'launch')
    return args['activate'] === undefined || args['activate'] === false
      ? 'background'
      : 'foreground';
  if (command === 'batch' || WITH_SUBCOMMANDS.has(command)) return 'foreground';
  return commandMode(command);
}

function commandMode(command: string): Exclude<DesktopControlMode, 'inert'> {
  return Object.hasOwn(COMMAND_MODES, command) ? COMMAND_MODES[command]! : 'foreground';
}

/** The entries of a batch argument, or `null` when they are not the shape `batch` takes. */
export function readBatchEntries(
  positionals: readonly string[],
): { command: string; args: Readonly<Record<string, unknown>> }[] | null {
  if (positionals.length !== 1) return null;
  let entries: unknown;
  try {
    entries = JSON.parse(positionals[0]!);
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const read: { command: string; args: Readonly<Record<string, unknown>> }[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const { command, args } = entry as Record<string, unknown>;
    if (typeof command !== 'string') return null;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args)))
      return null;
    read.push({ command, args: (args ?? {}) as Record<string, unknown> });
  }
  return read;
}

/**
 * The arguments as the desktop-control binary reads them, for the approval card's description.
 * `null` when they are refused.
 */
export function readDesktopControlCommand(argv: readonly string[]): {
  command: string | undefined;
  positionals: readonly string[];
  /** Option values by name, in the order given (`--app=x` and `--app x` both read as `x`). */
  options: ReadonlyMap<string, string>;
  /** Whether help or the version was asked for, which only prints and exits. */
  help: boolean;
} | null {
  const read = readDesktopControlArgv(argv);
  if (typeof read === 'string') return null;
  return {
    command: read.command,
    positionals: read.positionals,
    options: read.options,
    help: read.help.length > 0,
  };
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
  const keyTarget = keyTargetRefusal(key, (name) =>
    name === ''
      ? (positionals[0] ?? '').trim() !== ''
      : (read.options.get(name) ?? '').trim() !== '',
  );
  if (keyTarget !== null) return keyTarget;
  return pointChoiceRefusal(
    key,
    Object.hasOwn(POINT_CHOICES, key) ? POINT_CHOICES[key]! : [],
    (name) => (name === '' ? positionals.length > 0 : read.options.has(name)),
  );
}

// Commands of the desktop-control binary 1.2.0 that take one point either as a part or as
// coordinates (`<command> --help`): the part's option (`''` for the first positional, the ref)
// and the coordinates' option. Given both, which one the binary uses is up to the binary, and the
// card names only the part, so that is refused. In a batch, the same by argument name.
const POINT_CHOICES: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  hover: [['', '--xy']],
  drag: [
    ['--from', '--from-xy'],
    ['--to', '--to-xy'],
  ],
};
const BATCH_POINT_CHOICES: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  hover: [['ref_id', 'xy']],
  drag: [
    ['from', 'from_xy'],
    ['to', 'to_xy'],
  ],
};

// Commands of the desktop-control binary 1.2.0 that send keys or text, and the options that name
// where they go (`''` for the first positional, the ref; `<command> --help`). Without one, the
// keys reach whichever window is in front, which may be the one the person is using, so that is
// refused. `key-down` and `key-up` take no target at all. In a batch, the same by argument name.
const KEY_TARGETS: Readonly<Record<string, readonly string[]>> = {
  press: ['--window-id', '--app'],
  type: [''],
  'key-down': [],
  'key-up': [],
};
const BATCH_KEY_TARGETS: Readonly<Record<string, readonly string[]>> = {
  press: ['window_id', 'app'],
  type: ['ref_id'],
  'key-down': [],
  'key-up': [],
};

function keyTargetRefusal(
  label: string,
  given: (name: string) => boolean,
  batch = false,
): string | null {
  if (!Object.hasOwn(KEY_TARGETS, label)) return null;
  const targets = (batch ? BATCH_KEY_TARGETS : KEY_TARGETS)[label]!;
  if (targets.some((name) => given(name))) return null;
  const command = batch ? `batch の中の ${label}` : label;
  const press = batch ? 'window_id か app' : '--window-id か --app';
  if (targets.length === 0)
    return refusal(
      `${command} は対象の窓を指定できない（キーはいちばん手前の窓に届くため、代わりに press を ${press} と使う）`,
    );
  if (label === 'type')
    return refusal(
      `${command} の対象の部品が無い（文字はいちばん手前の窓に届くため、snapshot で得た ref で対象の部品を指定する）`,
    );
  return refusal(
    `${command} の対象の窓が無い（キーはいちばん手前の窓に届くため、${press} で対象の窓を指定する）`,
  );
}

function pointChoiceRefusal(
  label: string,
  choices: readonly (readonly [string, string])[],
  given: (name: string) => boolean,
): string | null {
  for (const [part, coordinates] of choices)
    if (given(part) && given(coordinates))
      return refusal(
        `${label} の ${part === '' ? 'ref' : part} と ${coordinates} は同時に指定できない（部品の指定と座標の指定は、どちらか片方だけにする）`,
      );
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
  if (desktopControlNamesTool(base))
    return refusal(`${base} は起動できない（端末・shell・設定の道具）`);
  return null;
}

/**
 * Whether an app or file name (no folder) names a terminal, shell, script host or settings tool,
 * the kind `launch` refuses by name. Also used to keep such an app out of an app-wide Task grant.
 */
export function desktopControlNamesTool(base: string): boolean {
  const lower = base.toLowerCase();
  const extension = /\.[a-z0-9-]+$/u.exec(lower)?.[0] ?? '';
  const stem = ['.exe', '.com', '.app'].includes(extension)
    ? lower.slice(0, -extension.length)
    : lower;
  const names = [stem, ...stem.split('.')].map((name) => name.replace(/[^a-z0-9]/gu, ''));
  return (
    REFUSED_LAUNCH_EXTENSIONS.has(extension) || names.some((name) => REFUSED_LAUNCH_NAMES.has(name))
  );
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
    // Compared without letter case or separators, as the refused names are.
    const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/gu, '');
    const keys = new Set(Object.keys(fields).map(plain));
    const pointRefusal = pointChoiceRefusal(
      `batch の中の ${command}`,
      Object.hasOwn(BATCH_POINT_CHOICES, command) ? BATCH_POINT_CHOICES[command]! : [],
      (name) => keys.has(plain(name)),
    );
    if (pointRefusal !== null) return pointRefusal;
    const keyTarget = keyTargetRefusal(
      command,
      (name) => typeof fields[name] === 'string' && fields[name].trim() !== '',
      true,
    );
    if (keyTarget !== null) return keyTarget;
  }
  return null;
}

/**
 * `launch <name>` with the name looked up in the Start menu, for arguments
 * `desktopControlArgvRefusal` accepts. The desktop-control binary starts a bare name only from
 * the Windows system folders, so a name it would not find there is replaced by the absolute path
 * of the one `.exe` the Start menu's shortcuts of that name point to, before any card exists: the
 * card shows that path and the run starts it, never the name. In a batch, each `launch` the same.
 *
 * `null` when nothing is replaced (an absolute path, a name in the system folders, no Start menu
 * read, or not Windows), the replaced arguments, or why the name is refused: no shortcut of that
 * name (with similar names to try), shortcuts to different executables, or a target that the
 * checks of an absolute path refuse. Only a shortcut without arguments to an existing `.exe` at an
 * absolute path counts, so a shortcut cannot pass what `--arg` may not.
 */
export function desktopControlLaunchByName(
  argv: readonly string[],
  workspaceRoots: readonly string[],
  lookup: DesktopControlLookup = {},
): { argv: readonly string[] } | { refusal: string } | null {
  if ((lookup.platform ?? process.platform) !== 'win32') return null;
  const read = readDesktopControlArgv(argv);
  if (typeof read === 'string' || read.help.length > 0 || read.positionals.length !== 1)
    return null;
  const index = read.positionalIndexes[0]!;
  if (read.key === 'launch') {
    const found = launchNameTarget(read.positionals[0]!, workspaceRoots, lookup);
    if (found === null || 'refusal' in found) return found;
    return { argv: argv.map((token, at) => (at === index ? found.path : token)) };
  }
  if (read.key !== 'batch') return null;
  const entries = readBatchEntries(read.positionals);
  if (entries === null) return null;
  let replaced = false;
  const next: { command: string; args: Readonly<Record<string, unknown>> }[] = [];
  for (const entry of entries) {
    const app = entry.args['app'];
    if (entry.command !== 'launch' || typeof app !== 'string') {
      next.push(entry);
      continue;
    }
    const found = launchNameTarget(app, workspaceRoots, lookup);
    if (found !== null && 'refusal' in found) return found;
    if (found !== null) replaced = true;
    next.push(found === null ? entry : { ...entry, args: { ...entry.args, app: found.path } });
  }
  if (!replaced) return null;
  const json = JSON.stringify(next);
  return { argv: argv.map((token, at) => (at === index ? json : token)) };
}

/** Up to how many similar names or executables a refusal lists. */
const LAUNCH_NAME_LIST_MAX = 5;

function launchNameTarget(
  name: string,
  workspaceRoots: readonly string[],
  lookup: DesktopControlLookup,
): { path: string } | { refusal: string } | null {
  // A path is judged as it is; a drive-relative `C:x` is refused by the binary.
  if (/[\\/]/u.test(name) || /^[a-z]:/iu.test(name) || name.trim() === '') return null;
  const environment = lookup.environment ?? process.env;
  const isFile = lookup.isFile ?? regularFile;
  if (inSystemFolders(name, environment, isFile)) return null;
  const shortcuts = (lookup.startMenuShortcuts ?? (() => startMenuShortcuts(environment)))();
  if (shortcuts === null) return null;
  const wanted = name.trim().toLowerCase();
  const matching = shortcuts.filter((shortcut) => shortcut.name.trim().toLowerCase() === wanted);
  const targets = new Map<string, string>();
  for (const shortcut of matching) {
    const path = shortcutExecutable(shortcut, environment, isFile);
    if (path !== null) targets.set(comparisonKey(path, lookup), path);
  }
  const shown = name.trim();
  if (targets.size === 1) {
    const path = [...targets.values()][0]!;
    const reason = launchTargetRefusal(path, workspaceRoots, lookup);
    return reason === null ? { path } : { refusal: reason };
  }
  if (targets.size > 1)
    return {
      refusal: refusal(
        `スタートメニューの「${shown}」が違う実行ファイルを指している（${[...targets.values()].slice(0, LAUNCH_NAME_LIST_MAX).join('、')}）。起動するものの絶対パスで launch する`,
      ),
    };
  if (matching.length > 0)
    return {
      refusal: refusal(
        `スタートメニューの「${shown}」は、引数の無い .exe へのショートカットではないので使えない。実行ファイルの絶対パスで launch する`,
      ),
    };
  const similar = similarLaunchNames(
    wanted,
    shortcuts,
    workspaceRoots,
    lookup,
    environment,
    isFile,
  );
  return {
    refusal: refusal(
      similar.length > 0
        ? `「${shown}」という名前のアプリが、Windows の標準のフォルダーにもスタートメニューにも無い（スタートメニューにある似た名前: ${similar.join('、')}）。そのどれかの名前か、実行ファイルの絶対パスで launch する`
        : `「${shown}」という名前のアプリが、Windows の標準のフォルダーにもスタートメニューにも無い（似た名前も無い）。実行ファイルの絶対パスで launch する`,
    ),
  };
}

/** Whether the binary finds this bare name in the system folders (as its `resolve_executable`). */
function inSystemFolders(
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
  isFile: (path: string) => boolean,
): boolean {
  const root =
    environmentValue(environment, 'SystemRoot') ?? environmentValue(environment, 'WINDIR');
  if (root === undefined || !/^[a-z]:[\\/]/iu.test(root)) return false;
  const file = win32.extname(name) === '' ? `${name}.exe` : name;
  return [win32.join(root, 'System32', file), win32.join(root, file)].some((path) => isFile(path));
}

/** The absolute path of the `.exe` a shortcut without arguments points to, or `null`. */
function shortcutExecutable(
  shortcut: StartMenuShortcut,
  environment: Readonly<Record<string, string | undefined>>,
  isFile: (path: string) => boolean,
): string | null {
  if (shortcut.args.trim() !== '') return null;
  let unknown = false;
  const expanded = shortcut.target.trim().replace(/%([^%]+)%/gu, (_, variable: string) => {
    const value = environmentValue(environment, variable);
    if (value === undefined) unknown = true;
    return value ?? '';
  });
  if (unknown || expanded.includes('%') || /[\p{Cc}"]/u.test(expanded)) return null;
  if (!/^[a-z]:[\\/]/iu.test(expanded)) return null;
  const path = win32.normalize(expanded);
  if (win32.extname(path).toLowerCase() !== '.exe' || !isFile(path)) return null;
  return path;
}

/** The names of usable Start menu shortcuts that look like the name asked for, closest first. */
function similarLaunchNames(
  wanted: string,
  shortcuts: readonly StartMenuShortcut[],
  workspaceRoots: readonly string[],
  lookup: DesktopControlLookup,
  environment: Readonly<Record<string, string | undefined>>,
  isFile: (path: string) => boolean,
): string[] {
  // Only a name that would launch one executable is offered.
  const scored = new Map<string, { name: string; score: number; targets: Set<string> }>();
  for (const shortcut of shortcuts) {
    const name = shortcut.name.trim().replace(/\p{Cc}/gu, '');
    const lower = name.toLowerCase();
    if (name === '' || name.length > 80) continue;
    const distance = editDistance(wanted, lower);
    const contains = lower.includes(wanted) || wanted.includes(lower);
    if (!contains && distance > Math.max(2, Math.floor(wanted.length / 3))) continue;
    const path = shortcutExecutable(shortcut, environment, isFile);
    if (path === null || launchTargetRefusal(path, workspaceRoots, lookup) !== null) continue;
    const entry = scored.get(lower) ?? {
      name,
      score: contains ? distance - 1_000 : distance,
      targets: new Set<string>(),
    };
    entry.targets.add(comparisonKey(path, lookup));
    scored.set(lower, entry);
  }
  return [...scored.values()]
    .filter(({ targets }) => targets.size === 1)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, LAUNCH_NAME_LIST_MAX)
    .map(({ name }) => name);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

/** A variable by name in any letter case, as Windows reads them. */
function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const exact = environment[name];
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(environment))
    if (key.toLowerCase() === lower && value !== undefined) return value;
  return undefined;
}

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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
