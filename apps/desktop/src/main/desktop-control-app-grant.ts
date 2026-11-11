import { basename } from 'node:path';
import {
  desktopControlArgvMode,
  desktopControlNamesTool,
  readBatchEntries,
  readDesktopControlCommand,
} from './desktop-control';
import {
  desktopControlAppNameMatches,
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
 * one such app: never anything that takes the foreground, the cursor or the keyboard (those are
 * `foreground` and keep their card), launches or closes an app, or reads or acts on something other
 * than one app's windows (every window, the screen, a shell surface, notifications, the clipboard).
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

// Executables that hold windows of more than one app, so one process does not mean one app: the
// frame host of packaged apps when the executable cannot tell the hosted app, the shell (desktop,
// taskbar and File Explorer), and other shared hosts. Never granted as an app.
const SHARED_HOSTS = new Set(
  [
    'applicationframehost explorer dllhost svchost sihost runtimebroker shellexperiencehost',
    'startmenuexperiencehost searchhost searchapp searchui textinputhost lockapp',
    'credentialuibroker consent logonui winlogon',
  ]
    .join(' ')
    .split(' ')
    .map((name) => `${name}.exe`),
);

type Target = Readonly<{ kind: 'ref' | 'window' | 'app'; value: string }>;

type CliCommand = Readonly<{
  /** Options it may take, `=` marking one that takes a value. */
  options: string;
  /** How many positionals it takes; the first is the ref when `ref` is set. */
  positionals: readonly [number, number];
  ref?: true;
  /** Options whose value is a ref, a window id or an app name. */
  refs?: readonly string[];
  windows?: readonly string[];
  apps?: readonly string[];
}>;

const REF_TIMEOUT = '--timeout-ms=';
const SCOPE = { windows: ['--window-id'], apps: ['--app'] } as const;
// Checked on the desktop-control binary 1.2.0 (`<command> --help`). `--surface` is left out: its
// other values read the shell, not the app. So are the shared `--wait-for` options and
// `--session`, which reads its refs from another folder.
const CLI_COMMANDS: Readonly<Record<string, CliCommand>> = {
  snapshot: {
    options:
      '--app= --window-id= --root= --max-depth= --include-bounds -i --interactive-only --compact --skeleton --timeout-ms= --force-electron-a11y',
    positionals: [0, 0],
    refs: ['--root'],
    ...SCOPE,
  },
  find: {
    options:
      '--app= --window-id= --root= --role= --name= --value= --text= --description= --native-id= --exact --state= --timeout-ms= --count --first --last --nth= --limit=',
    positionals: [0, 0],
    refs: ['--root'],
    ...SCOPE,
  },
  screenshot: { options: '--app= --window-id=', positionals: [0, 0], ...SCOPE },
  get: { options: '--property=', positionals: [1, 1], ref: true },
  is: { options: '--property=', positionals: [1, 1], ref: true },
  // `--window-id` only narrows `--event`, which watches the whole desktop.
  wait: {
    options: '--element= --app= --text= --predicate= --value= --action= --count= --timeout=',
    positionals: [0, 1],
    refs: ['--element'],
    apps: ['--app'],
  },
  click: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  'set-value': { options: REF_TIMEOUT, positionals: [2, 2], ref: true },
  clear: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  select: { options: REF_TIMEOUT, positionals: [2, 2], ref: true },
  toggle: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  check: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  uncheck: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  expand: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  collapse: { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  scroll: { options: `--direction= --amount= ${REF_TIMEOUT}`, positionals: [1, 1], ref: true },
  'scroll-to': { options: REF_TIMEOUT, positionals: [1, 1], ref: true },
  minimize: { options: '--app= --window-id=', positionals: [0, 0], ...SCOPE },
  'move-window': { options: '--app= --window-id= --x= --y=', positionals: [0, 0], ...SCOPE },
  'resize-window': {
    options: '--app= --window-id= --width= --height=',
    positionals: [0, 0],
    ...SCOPE,
  },
};

type BatchCommand = Readonly<{
  keys: string;
  refs?: readonly string[];
  windows?: readonly string[];
  apps?: readonly string[];
}>;

const REF_KEYS = 'ref_id timeout_ms';
const BATCH_SCOPE = { windows: ['window_id'], apps: ['app'] } as const;
// The same, by the argument names a batch entry takes (the binary refuses any other name).
const BATCH_COMMANDS: Readonly<Record<string, BatchCommand>> = {
  snapshot: {
    keys: 'app window_id root max_depth include_bounds interactive_only compact skeleton timeout_ms force_electron_a11y',
    refs: ['root'],
    ...BATCH_SCOPE,
  },
  find: {
    keys: 'app window_id root role name value text description native_id exact states timeout_ms count first last nth limit',
    refs: ['root'],
    ...BATCH_SCOPE,
  },
  screenshot: { keys: 'app window_id', ...BATCH_SCOPE },
  get: { keys: 'ref_id property', refs: ['ref_id'] },
  is: { keys: 'ref_id property', refs: ['ref_id'] },
  wait: {
    keys: 'ms element app text predicate value action count timeout',
    refs: ['element'],
    apps: ['app'],
  },
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
  minimize: { keys: 'app window_id', ...BATCH_SCOPE },
  'move-window': { keys: 'app window_id x y', ...BATCH_SCOPE },
  'resize-window': { keys: 'app window_id width height', ...BATCH_SCOPE },
};
const BATCH_OPTIONS = '--stop-on-error --timeout-ms=';

/**
 * The parts, windows and app names this run acts on, or `null` when it is not one the grant can
 * cover. Read on its own, more strictly than the executable reads it: an option not listed, one
 * given twice, a value that starts with `-`, `--` or a shared option makes it `null`.
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
  const targets: Target[] = [];
  if (spec.ref === true) targets.push({ kind: 'ref', value: positionals[0]! });
  for (const [kind, names] of [
    ['ref', spec.refs],
    ['window', spec.windows],
    ['app', spec.apps],
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
  const entries = readBatchEntries(parsed.positionals);
  if (entries === null || entries.length === 0) return null;
  const targets: Target[] = [];
  for (const { command, args } of entries) {
    const spec = Object.hasOwn(BATCH_COMMANDS, command) ? BATCH_COMMANDS[command]! : undefined;
    if (spec === undefined) return null;
    const keys = new Set(spec.keys.split(' '));
    if (Object.keys(args).some((key) => !keys.has(key))) return null;
    const before = targets.length;
    for (const [kind, names] of [
      ['ref', spec.refs],
      ['window', spec.windows],
      ['app', spec.apps],
    ] as const)
      for (const name of names ?? []) {
        const value = args[name];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') return null;
        targets.push({ kind, value });
      }
    // A step that names no part, window or app acts on whatever has focus.
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
  const own = (lookup.ownExecutable ?? basename(process.execPath)).toLowerCase();
  return !SHARED_HOSTS.has(app) && app !== own && !desktopControlNamesTool(owner.app);
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
 * The one app every part and window of this run belongs to, by the records, when an app name the
 * run gives also names it (see `nameConfirms`). `undefined` when the run names no part or window,
 * and `null` when it is not one the grant can cover.
 */
function recordedOwner(
  targets: readonly Target[],
  reader: DesktopControlOwnerReader,
): DesktopControlOwner | null | undefined {
  let found: DesktopControlOwner | undefined;
  for (const { kind, value } of targets) {
    if (kind === 'app') continue;
    if (!(kind === 'ref' ? REF : WINDOW).test(value)) return null;
    const owner = kind === 'ref' ? reader.part(value) : reader.window(value);
    if (owner === null) return null;
    if (found !== undefined && !sameDesktopControlOwner(found, owner)) return null;
    found = owner;
  }
  return found;
}

/**
 * Whether an app name confirms this owner: it is the owner's executable name, and every process of
 * that name the records know is this one, so the name cannot reach another copy the Task has seen.
 */
function nameConfirms(
  name: string,
  owner: DesktopControlOwner,
  reader: DesktopControlOwnerReader,
): boolean {
  if (!desktopControlAppNameMatches(name, owner.app)) return false;
  const named = reader.named(name);
  return (
    named !== null &&
    named.length > 0 &&
    named.every((other) => sameDesktopControlOwner(other, owner))
  );
}

/**
 * The app a card for this run may offer the app-wide Task grant for, or `null`. Only a run that
 * names a part or a window can establish the app; one that gives only an app name cannot.
 */
export function desktopAppGrantOffer(
  argv: readonly string[],
  lookup: DesktopAppGrantLookup = {},
): DesktopAppGrantKey | null {
  try {
    const targets = runTargets(argv);
    if (targets === null) return null;
    const reader = desktopControlOwnerReader(lookup);
    const owner = recordedOwner(targets, reader);
    if (owner === null || owner === undefined || !grantable(owner, lookup)) return null;
    for (const { kind, value } of targets)
      if (kind === 'app' && !nameConfirms(value, owner, reader)) return null;
    return keyOf(owner);
  } catch {
    return null;
  }
}

/**
 * The granted app this run is confined to, when it is one of `granted` (ids from
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
    if (targets === null || targets.length === 0) return null;
    const reader = desktopControlOwnerReader(lookup);
    const owner = recordedOwner(targets, reader);
    if (owner === null) return null;
    const candidates =
      owner === undefined ? granted : granted.filter((key) => sameDesktopControlOwner(key, owner));
    for (const key of candidates) {
      if (!grantable(key, lookup)) continue;
      if (targets.every(({ kind, value }) => kind !== 'app' || nameConfirms(value, key, reader)))
        return key;
    }
    return null;
  } catch {
    return null;
  }
}
