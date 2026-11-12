import { basename } from 'node:path';
import {
  desktopControlArgvMode,
  desktopControlNamesTool,
  readBatchEntries,
  readDesktopControlCommand,
} from './desktop-control';
import {
  desktopControlOwnerReader,
  sameDesktopControlOwner,
  type DesktopControlOwner,
  type DesktopControlOwnerReader,
} from './desktop-control-display';

/**
 * 「このアプリは Task 中許可」: the person's allow, given on a desktop-control card, for the reads
 * and background operations of one app for the rest of the Task. This module decides which app a
 * run is confined to; the ApprovalCoordinator keeps the grants.
 *
 * The app is one process instance of one executable (pid, process instance and executable name),
 * read only from what the executable itself recorded: the snapshot a ref belongs to, and the
 * windows its earlier runs printed (`desktopControlOwnerReader`). The names the agent wrote in the
 * argv decide nothing, and a run whose app cannot be told is never covered.
 *
 * Covered, and offered on a card, only when every part of the run is a read or a background
 * operation listed in `CLI_COMMANDS` and `BATCH_COMMANDS`, with only the options listed there, on
 * one such app named by a ref or a window id: never anything that takes the foreground, the cursor
 * or the keyboard (those are `foreground` and keep their card), launches, closes or minimizes an
 * app (minimizing hands the front to another window), or reads or acts on something other than one
 * app's windows (every window, the screen, a shell surface, notifications, the clipboard). An app
 * given by name (`--app`) is not covered either: the executable picks a window of that name itself,
 * which may belong to another copy of the app the records do not know.
 */
export type DesktopAppGrantLookup = Readonly<{
  /** The Task whose earlier runs' windows may say which app a window id belongs to. */
  taskId?: string;
  stateRoot?: string;
  /** The executable name of Sprint Coder itself, which is never granted. */
  ownExecutable?: string;
}>;

/** A granted app, and how the card names it. */
export type DesktopAppGrantKey = DesktopControlOwner & Readonly<{ id: string; label: string }>;

const REF = /^@[a-z0-9]{1,64}:e[0-9]{1,9}$/u;
const WINDOW = /^w-[A-Za-z0-9-]{1,64}$/u;

// Executables never granted as an app, by name without `.exe`, in lower case. Shared hosts hold
// windows of more than one app, so one process does not mean one app: the frame host of packaged
// apps when the executable cannot tell the hosted app, the shell (desktop, taskbar, File Explorer)
// and other shell hosts. A web browser holds every window, tab and signed-in site in one process.
// An editor with a built-in terminal runs commands, and the rest change system settings. Terminals,
// shells and settings tools are refused by name as `launch` refuses them (`desktopControlNamesTool`).
const NOT_GRANTED = new Set(
  [
    'applicationframehost explorer dllhost svchost sihost runtimebroker shellexperiencehost',
    'startmenuexperiencehost searchhost searchapp searchui textinputhost lockapp shellhost',
    'pickerhost widgets openwith smartscreen credentialuibroker consent logonui winlogon',
    'chrome msedge msedgewebview2 firefox brave opera vivaldi arc iexplore chromium waterfox',
    'librewolf thorium',
    'code code-insiders cursor windsurf devenv idea idea64 pycharm pycharm64 webstorm64 rider64',
    'clion64 goland64 phpstorm64 rubymine64 datagrip64 studio64 eclipse zed sublime_text',
    'systempropertiesadvanced msconfig sechealthui',
  ]
    .join(' ')
    .split(' '),
);

type Target = Readonly<{ kind: 'ref' | 'window'; value: string }>;

type CliCommand = Readonly<{
  /** Options it may take, `=` marking one that takes a value. */
  options: string;
  /** How many positionals it takes; the first is the ref when `ref` is set. */
  positionals: readonly [number, number];
  ref?: true;
  /** Options whose value is a ref or a window id. */
  refs?: readonly string[];
  windows?: readonly string[];
  /** Options covered only with this one value. */
  only?: Readonly<Record<string, string>>;
}>;

const REF_TIMEOUT = '--timeout-ms=';
// `--surface menubar` reads the named window's own menu bar from the menu itself, without opening
// it or sending the app anything (desktop-control 1.2.0 as changed in this repo, #1200).
const MENU_BAR_ONLY = { '--surface': 'menubar' } as const;
const SCOPE = { windows: ['--window-id'] } as const;
// Checked on the desktop-control binary 1.2.0 (`<command> --help`), rebuilt from this repo's source
// after #1182, where `select` takes its value only when the ref is not the option itself (`select
// <ref> [value]`; a batch entry may leave out `value` too). `--surface` is covered only as
// `menubar` on `snapshot`: its other values read the shell, not the app. `--app`, the shared
// `--wait-for` options and `--session`, which reads its refs from another folder, are left out.
const CLI_COMMANDS: Readonly<Record<string, CliCommand>> = {
  snapshot: {
    options:
      '--window-id= --root= --max-depth= --include-bounds -i --interactive-only --compact --skeleton --timeout-ms= --force-electron-a11y --surface=',
    positionals: [0, 0],
    refs: ['--root'],
    only: MENU_BAR_ONLY,
    ...SCOPE,
  },
  find: {
    options:
      '--window-id= --root= --role= --name= --value= --text= --description= --native-id= --exact --state= --timeout-ms= --count --first --last --nth= --limit=',
    positionals: [0, 0],
    refs: ['--root'],
    ...SCOPE,
  },
  screenshot: { options: '--window-id=', positionals: [0, 0], ...SCOPE },
  get: { options: '--property=', positionals: [1, 1], ref: true },
  is: { options: '--property=', positionals: [1, 1], ref: true },
  // `--window-id` only narrows `--event`, which watches the whole desktop.
  wait: {
    options: '--element= --predicate= --value= --action= --count= --timeout=',
    positionals: [0, 1],
    refs: ['--element'],
  },
  click: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  'set-value': { options: REF_TIMEOUT, positionals: [2, 2], ref: true },
  clear: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  select: { options: REF_TIMEOUT, positionals: [1, 2], ref: true },
  toggle: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  check: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  uncheck: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  expand: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  collapse: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  scroll: { options: `--direction= --amount= ${REF_TIMEOUT}`, positionals: [1, 1], ref: true },
  'scroll-to': { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  'move-window': { options: '--window-id= --x= --y=', positionals: [0, 0], ...SCOPE },
  'resize-window': { options: '--window-id= --width= --height=', positionals: [0, 0], ...SCOPE },
};

type BatchCommand = Readonly<{
  keys: string;
  refs?: readonly string[];
  windows?: readonly string[];
  /** Keys covered only with this one value. */
  only?: Readonly<Record<string, string>>;
}>;

const REF_KEYS = 'ref_id timeout_ms';
const BATCH_SCOPE = { windows: ['window_id'] } as const;
// The same, by the argument names a batch entry takes (the binary refuses any other name).
const BATCH_COMMANDS: Readonly<Record<string, BatchCommand>> = {
  snapshot: {
    keys: 'window_id root max_depth include_bounds interactive_only compact skeleton timeout_ms force_electron_a11y surface',
    refs: ['root'],
    only: { surface: 'menubar' },
    ...BATCH_SCOPE,
  },
  find: {
    keys: 'window_id root role name value text description native_id exact states timeout_ms count first last nth limit',
    refs: ['root'],
    ...BATCH_SCOPE,
  },
  screenshot: { keys: 'window_id', ...BATCH_SCOPE },
  get: { keys: 'ref_id property', refs: ['ref_id'] },
  is: { keys: 'ref_id property', refs: ['ref_id'] },
  wait: { keys: 'ms element predicate value action count timeout', refs: ['element'] },
  click: { keys: REF_KEYS, refs: ['ref_id'] },
  'set-value': { keys: `${REF_KEYS} value`, refs: ['ref_id'] },
  clear: { keys: REF_KEYS, refs: ['ref_id'] },
  select: { keys: `${REF_KEYS} value`, refs: ['ref_id'] },
  toggle: { keys: REF_KEYS, refs: ['ref_id'] },
  check: { keys: REF_KEYS, refs: ['ref_id'] },
  uncheck: { keys: REF_KEYS, refs: ['ref_id'] },
  expand: { keys: REF_KEYS, refs: ['ref_id'] },
  collapse: { keys: REF_KEYS, refs: ['ref_id'] },
  scroll: { keys: `${REF_KEYS} direction amount`, refs: ['ref_id'] },
  'scroll-to': { keys: REF_KEYS, refs: ['ref_id'] },
  'move-window': { keys: 'window_id x y', ...BATCH_SCOPE },
  'resize-window': { keys: 'window_id width height', ...BATCH_SCOPE },
};
const BATCH_OPTIONS = '--stop-on-error --timeout-ms=';

/**
 * The parts and windows this run acts on, or `null` when it is not one the grant can cover. Read
 * on its own, more strictly than the executable reads it: an option not listed, one given twice, a
 * value that starts with `-`, `--` or a shared option makes it `null`.
 */
function runTargets(argv: readonly string[]): Target[] | null {
  const mode = desktopControlArgvMode(argv);
  if (mode !== 'read' && mode !== 'background') return null;
  const read = readDesktopControlCommand(argv);
  if (read === null || read.help || read.command === undefined) return null;
  if (argv[0] !== read.command) return null;
  if (read.command === 'batch') return batchTargets(argv);
  const spec = Object.hasOwn(CLI_COMMANDS, read.command) ? CLI_COMMANDS[read.command]! : undefined;
  if (spec === undefined) return null;
  const parsed = strictOptions(argv.slice(1), spec.options);
  if (parsed === null) return null;
  const { options, positionals } = parsed;
  if (positionals.length < spec.positionals[0] || positionals.length > spec.positionals[1])
    return null;
  for (const [name, value] of Object.entries(spec.only ?? {}))
    if (options.has(name) && options.get(name) !== value) return null;
  const targets: Target[] = [];
  if (spec.ref === true) targets.push({ kind: 'ref', value: positionals[0]! });
  for (const [kind, names] of [
    ['ref', spec.refs],
    ['window', spec.windows],
  ] as const)
    for (const name of names ?? []) {
      const value = options.get(name);
      if (value !== undefined) targets.push({ kind, value });
    }
  return targets;
}

function batchTargets(argv: readonly string[]): Target[] | null {
  const parsed = strictOptions(argv.slice(1), BATCH_OPTIONS);
  if (parsed === null || parsed.positionals.length !== 1) return null;
  // Only `{command, args}` entries, judged here too and not only where the run is refused.
  const raw: unknown = JSON.parse(parsed.positionals[0]!);
  if (
    !Array.isArray(raw) ||
    raw.some(
      (entry) =>
        typeof entry !== 'object' ||
        entry === null ||
        Object.keys(entry as object).some((key) => key !== 'command' && key !== 'args'),
    )
  )
    return null;
  const entries = readBatchEntries(parsed.positionals);
  if (entries === null || entries.length === 0) return null;
  const targets: Target[] = [];
  for (const { command, args } of entries) {
    const spec = Object.hasOwn(BATCH_COMMANDS, command) ? BATCH_COMMANDS[command]! : undefined;
    if (spec === undefined) return null;
    const keys = new Set(spec.keys.split(' '));
    if (Object.keys(args).some((key) => !keys.has(key))) return null;
    for (const [key, value] of Object.entries(spec.only ?? {}))
      if (args[key] !== undefined && args[key] !== value) return null;
    const before = targets.length;
    for (const [kind, names] of [
      ['ref', spec.refs],
      ['window', spec.windows],
    ] as const)
      for (const name of names ?? []) {
        const value = args[name];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') return null;
        targets.push({ kind, value });
      }
    // A step that names no part or window acts on whatever has focus.
    if (targets.length === before) return null;
  }
  return targets;
}

function strictOptions(
  tokens: readonly string[],
  spec: string,
): { options: Map<string, string>; positionals: string[] } | null {
  const names = spec.split(' ').filter((token) => token !== '');
  const values = new Set(
    names.filter((name) => name.endsWith('=')).map((name) => name.slice(0, -1)),
  );
  const flags = new Set(names.filter((name) => !name.endsWith('=')));
  const options = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    if (options.has(name)) return null;
    if (flags.has(name) && equals < 0) {
      options.set(name, '');
      continue;
    }
    if (!values.has(name)) return null;
    const value = equals < 0 ? tokens[(index += 1)] : token.slice(equals + 1);
    if (value === undefined || value.startsWith('-')) return null;
    options.set(name, value);
  }
  return { options, positionals };
}

function grantable(owner: DesktopControlOwner, lookup: DesktopAppGrantLookup): boolean {
  const app = owner.app.toLowerCase();
  // `Code - Insiders.exe` reads as `code-insiders`.
  const stem = app
    .replace(/\.exe$/u, '')
    .trim()
    .replace(/\s*-\s*|\s+/gu, '-');
  const own = (lookup.ownExecutable ?? basename(process.execPath)).toLowerCase();
  return !NOT_GRANTED.has(stem) && app !== own && !desktopControlNamesTool(owner.app);
}

function keyOf(owner: DesktopControlOwner): DesktopAppGrantKey {
  // The name has no invisible character (`desktopControlOwnerReader`); it is only cut short.
  const characters = Array.from(owner.app.trim());
  return {
    ...owner,
    id: JSON.stringify([owner.pid, owner.instance, owner.app.toLowerCase()]),
    label: characters.length > 120 ? `${characters.slice(0, 119).join('')}…` : characters.join(''),
  };
}

/**
 * The one app every part and window of this run belongs to, by the records, or `null` when the run
 * names none, or one the records cannot place, or parts of more than one app.
 */
function recordedOwner(
  targets: readonly Target[],
  reader: DesktopControlOwnerReader,
): DesktopControlOwner | null {
  let found: DesktopControlOwner | null = null;
  for (const { kind, value } of targets) {
    if (!(kind === 'ref' ? REF : WINDOW).test(value)) return null;
    // A standard menu item runs an app command (保存・削除・終了 among them) that no part on screen
    // shows, so it is decided on its own card every time, never by the app-wide grant.
    if (kind === 'ref' && reader.menuPart(value)) return null;
    const owner = kind === 'ref' ? reader.part(value) : reader.window(value);
    if (owner === null) return null;
    if (found !== null && !sameDesktopControlOwner(found, owner)) return null;
    found = owner;
  }
  return found;
}

/** The app a card for this run may offer the app-wide Task grant for, or `null`. */
export function desktopAppGrantOffer(
  argv: readonly string[],
  lookup: DesktopAppGrantLookup = {},
): DesktopAppGrantKey | null {
  try {
    const targets = runTargets(argv);
    if (targets === null) return null;
    const owner = recordedOwner(targets, desktopControlOwnerReader(lookup));
    return owner === null || !grantable(owner, lookup) ? null : keyOf(owner);
  } catch {
    return null;
  }
}

/**
 * The granted app this run is confined to, when it is one of `granted` (from
 * `desktopAppGrantOffer`), or `null`. Judged again from the records each time, never remembered.
 */
export function desktopAppGrantCovering(
  argv: readonly string[],
  granted: readonly DesktopAppGrantKey[],
  lookup: DesktopAppGrantLookup = {},
): DesktopAppGrantKey | null {
  try {
    if (granted.length === 0) return null;
    const targets = runTargets(argv);
    if (targets === null) return null;
    const owner = recordedOwner(targets, desktopControlOwnerReader(lookup));
    if (owner === null) return null;
    return (
      granted.find((key) => sameDesktopControlOwner(key, owner) && grantable(key, lookup)) ?? null
    );
  } catch {
    return null;
  }
}
