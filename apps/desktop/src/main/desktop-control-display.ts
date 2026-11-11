import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DESKTOP_ACTION_MAX_STEPS,
  desktopApprovalActionSchema,
  type DesktopActionStep,
  type DesktopActionTarget,
  type DesktopApprovalAction,
} from '@sprint-coder/contracts';
import { APPROVAL_DISPLAY_UNDISPLAYABLE_CHARACTERS } from './approval-display-characters';
import {
  desktopControlArgvMode,
  desktopControlBatchEntryMode,
  desktopControlStateFolder,
  readBatchEntries,
  readDesktopControlCommand,
} from './desktop-control';

/**
 * What a desktop-control run does, for its approval card: the kind of operation, the app and part
 * it targets, and the text it enters, built from the sealed argv. It decides nothing — whether a
 * card is raised, where the run happens and which grants apply are decided from the argv elsewhere
 * — so a part that cannot be named is shown as not confirmed and the card stays as it is.
 *
 * The app, window and part names are read only from the snapshot a ref belongs to, in the state
 * folder desktop-control runs keep (`desktopControlStateFolder`). They are text the app chose, so
 * they are cut short and invisible characters are shown as their code points. The part's value
 * (what a field holds) is never read out.
 */
export type DesktopControlDisplayLookup = Readonly<{
  /** The state folder; by default the one the runs use (`desktopControlStateFolder`). */
  stateRoot?: string;
  /** False to leave the snapshots unread, for a summary that names no part. */
  names?: boolean;
}>;

type Kind = DesktopActionStep['kind'];
type Mode = DesktopActionStep['mode'];

// Command → kind and heading. A command missing here reads as 「デスクトップを操作します」.
const COMMANDS: Readonly<Record<string, readonly [Kind, string]>> = {
  snapshot: ['read', '画面を読みます'],
  find: ['read', '部品を探します'],
  screenshot: ['read', '画面を撮ります'],
  get: ['read', '部品の状態を読みます'],
  is: ['read', '部品の状態を読みます'],
  'list-windows': ['read', '窓の一覧を読みます'],
  'list-apps': ['read', 'アプリの一覧を読みます'],
  'list-displays': ['read', '画面の一覧を読みます'],
  'list-surfaces': ['read', '画面の構成を読みます'],
  'list-notifications': ['read', '通知を読みます'],
  wait: ['read', '画面の変化を待ちます'],
  status: ['read', '状態を確かめます'],
  permissions: ['read', '状態を確かめます'],
  version: ['read', '状態を確かめます'],
  help: ['read', '使い方を読みます'],
  'skills list': ['read', '説明書を読みます'],
  'skills get': ['read', '説明書を読みます'],
  'skills path': ['read', '説明書を読みます'],
  'skills help': ['read', '説明書を読みます'],
  click: ['operate', 'クリックします'],
  'double-click': ['operate', 'ダブルクリックします'],
  'triple-click': ['operate', 'トリプルクリックします'],
  'right-click': ['operate', '右クリックします'],
  toggle: ['operate', '切り替えます'],
  check: ['operate', 'チェックを付けます'],
  uncheck: ['operate', 'チェックを外します'],
  expand: ['operate', 'メニューを開きます'],
  collapse: ['operate', '折りたたみます'],
  scroll: ['operate', 'スクロールします'],
  'scroll-to': ['operate', 'スクロールして表示します'],
  focus: ['operate', '入力先を移します'],
  hover: ['operate', 'マウスを重ねます'],
  drag: ['operate', 'ドラッグします'],
  'mouse-move': ['operate', 'マウスを動かします'],
  'mouse-click': ['operate', 'マウスでクリックします'],
  'mouse-down': ['operate', 'マウスを操作します'],
  'mouse-up': ['operate', 'マウスを操作します'],
  'mouse-wheel': ['operate', 'マウスでスクロールします'],
  'set-value': ['input', '文字を入力します'],
  type: ['input', 'キーで入力します'],
  clear: ['input', '欄を空にします'],
  select: ['input', '一覧から選びます'],
  press: ['input', 'キーを押します'],
  'key-down': ['input', 'キーを押します'],
  'key-up': ['input', 'キーを押します'],
  'clipboard-set': ['input', 'クリップボードに書きます'],
  'clipboard-clear': ['input', 'クリップボードを空にします'],
  launch: ['launch', 'アプリを起動します'],
  'focus-window': ['window', '窓を前面に出します'],
  restore: ['window', '窓を元に戻します'],
  maximize: ['window', '窓を最大化します'],
  minimize: ['window', '窓を最小化します'],
  'move-window': ['window', '窓を動かします'],
  'resize-window': ['window', '窓の大きさを変えます'],
  'close-app': ['close', 'アプリを閉じます'],
  'dismiss-notification': ['other', '通知を消します'],
  'dismiss-all-notifications': ['other', '通知を消します'],
  'notification-action': ['other', '通知のボタンを押します'],
  'session start': ['other', '操作の記録を管理します'],
  'session end': ['other', '操作の記録を管理します'],
  'session list': ['read', '操作の記録を確かめます'],
  'session gc': ['other', '操作の記録を管理します'],
  'session help': ['read', '使い方を読みます'],
  'cursor-overlay enable': ['other', 'カーソルの表示を切り替えます'],
  'cursor-overlay disable': ['other', 'カーソルの表示を切り替えます'],
  'cursor-overlay help': ['read', '使い方を読みます'],
};
const UNKNOWN: readonly [Kind, string] = ['other', 'デスクトップを操作します'];

// Commands whose first positional is a ref (`@<snapshot id>:eN`).
const REF_COMMANDS = new Set([
  'click',
  'double-click',
  'triple-click',
  'right-click',
  'type',
  'set-value',
  'clear',
  'focus',
  'select',
  'toggle',
  'check',
  'uncheck',
  'expand',
  'collapse',
  'scroll',
  'scroll-to',
  'get',
  'is',
  'hover',
]);
// Commands over everything of a kind when no app or window narrows them.
const ALL_TARGETS: Readonly<Record<string, NonNullable<DesktopActionTarget['all']>>> = {
  'list-windows': 'windows',
  'list-apps': 'apps',
  'list-displays': 'displays',
  'list-surfaces': 'surfaces',
  'list-notifications': 'notifications',
  'dismiss-all-notifications': 'notifications',
};
// Options that give a point as coordinates, which the card does not name.
const COORDINATE_OPTIONS = ['--xy', '--from-xy', '--to-xy'];
// Operations that act on no app, window or part, so a card without a target still says it all.
const NO_TARGET_COMMANDS = new Set([
  'clipboard-set',
  'clipboard-clear',
  'session start',
  'session end',
  'session gc',
  'cursor-overlay enable',
  'cursor-overlay disable',
]);
// Semantic operations on a part. They take no mouse or keyboard, but the accessibility call can
// bring the part's window to the front (seen with set-value and expand).
const PART_OPERATIONS = new Set([
  'click',
  'set-value',
  'clear',
  'select',
  'toggle',
  'check',
  'uncheck',
  'expand',
  'collapse',
  'scroll',
  'scroll-to',
]);
// Commands whose first positional is an app name.
const APP_COMMANDS = new Set(['launch', 'close-app']);
type TextRole = NonNullable<DesktopActionStep['textRole']>;
// Where the text a command enters sits: the positional index, the batch field, and what it is.
const TEXT_ARGUMENTS: Readonly<Record<string, readonly [number, string, TextRole]>> = {
  'set-value': [1, 'value', 'enter'],
  type: [1, 'text', 'enter'],
  select: [1, 'value', 'select'],
  press: [0, 'combo', 'keys'],
  'key-down': [0, 'key', 'keys'],
  'key-up': [0, 'key', 'keys'],
  'clipboard-set': [0, 'text', 'clipboard'],
  'notification-action': [1, 'action', 'button'],
};

// The roles the desktop-control binary reports, in Japanese. Others read as 「部品」.
const ROLES: Readonly<Record<string, string>> = {
  button: 'ボタン',
  textfield: '入力欄',
  textarea: '入力欄',
  searchfield: '検索欄',
  document: '文書',
  checkbox: 'チェックボックス',
  radiobutton: 'ラジオボタン',
  switch: 'スイッチ',
  combobox: '選択欄',
  popupbutton: '選択欄',
  list: '一覧',
  listitem: '一覧の項目',
  menu: 'メニュー',
  menubar: 'メニューバー',
  menuitem: 'メニューの項目',
  menubutton: 'メニューボタン',
  tab: 'タブ',
  tablist: 'タブの並び',
  tree: 'ツリー',
  treeitem: 'ツリーの項目',
  table: '表',
  row: '表の行',
  cell: '表のセル',
  slider: 'スライダー',
  spinbutton: '数値欄',
  link: 'リンク',
  image: '画像',
  text: '文字',
  statictext: '文字',
  heading: '見出し',
  group: 'まとまり',
  toolbar: 'ツールバー',
  scrollbar: 'スクロールバー',
  statusbar: 'ステータスバー',
  dialog: 'ダイアログ',
  window: '窓',
  pane: '領域',
  progressbar: '進み具合の表示',
};

const NAME_MAX = 120;
const ROLE_MAX = 40;
const TEXT_MAX = 1_000;
const REFMAP_MAX_BYTES = 1_048_576;
const RECENT_SNAPSHOTS = 10;
const SNAPSHOT_ID = /^[a-z0-9]{1,64}$/u;
const QUALIFIED_REF = /^@([a-z0-9]{1,64}):(e[0-9]{1,9})$/u;
const WINDOW_ID = /^w-[A-Za-z0-9-]{1,64}$/u;

const FOREGROUND_NOTE =
  '窓が前面に出て、マウスとキーボードを使います。入力中は触らないでください。';
const LAUNCH_NOTE = '新しい窓が手前に出ることがあります。';
const CLOSE_NOTE = '開いているアプリを閉じます。';
const RAISE_NOTE = '対象の窓が手前に出ることがあります。';
const TEXT_CUT_NOTE =
  '入れる文字が長いため、途中までを表示しています。全文は「詳細（実行内容）」で確かめてください。';

export function desktopControlApprovalAction(
  argv: readonly string[],
  lookup: DesktopControlDisplayLookup = {},
): DesktopApprovalAction {
  try {
    const snapshots = new SnapshotReader(lookup.stateRoot ?? desktopControlStateFolder());
    if (lookup.names === false) snapshots.disable();
    const action = describe(argv, snapshots);
    return desktopApprovalActionSchema.parse(action);
  } catch {
    // Never in the way of the approval itself: the card then says it could not describe the run.
    let mode: Mode = 'foreground';
    try {
      mode = displayMode(desktopControlArgvMode(argv));
    } catch {
      // Stays on the stronger side.
    }
    return {
      kind: 'other',
      title: UNKNOWN[1],
      mode,
      allowTaskGrant: mode !== 'foreground',
      notes: mode === 'foreground' ? [FOREGROUND_NOTE] : [],
      openDetails: true,
    };
  }
}

function describe(argv: readonly string[], snapshots: SnapshotReader): DesktopApprovalAction {
  const mode = displayMode(desktopControlArgvMode(argv));
  const read = readDesktopControlCommand(argv);
  const notes: string[] = [];
  let openDetails = false;
  let steps: DesktopActionStep[] | undefined;
  let stepsOmitted: number | undefined;
  let head: DesktopActionStep;
  // A session keeps its snapshots elsewhere, in a form not relied on here.
  if (read !== null && read.options.has('--session')) snapshots.disable();
  if (read === null || (read.command === undefined && !read.help)) {
    head = { kind: 'other', title: UNKNOWN[1], mode };
    openDetails = true;
  } else if (read.help) {
    head = { kind: 'read', title: '使い方を読みます', mode };
  } else if (read.command === 'batch') {
    const entries = readBatchEntries(read.positionals) ?? [];
    const described = entries.slice(0, DESKTOP_ACTION_MAX_STEPS).map(({ command, args }) =>
      describeStep(
        command,
        mode === 'foreground' && read.options.has('--headed')
          ? 'foreground'
          : displayMode(desktopControlBatchEntryMode(command, args)),
        {
          ref: stringField(args, 'ref_id'),
          windowId: stringField(args, 'window_id'),
          app: stringField(args, 'app'),
          // Not read from a batch entry, so a drag in one is never shown as explained.
          destination: undefined,
          text:
            textArgument(command) === undefined
              ? undefined
              : stringField(args, textArgument(command)![1]),
        },
        snapshots,
      ),
    );
    steps = described.map(({ step }) => step);
    if (described.some(({ unexplained }) => unexplained)) openDetails = true;
    // The same in a batch, by argument name (`xy`, `from_xy`, `to_xy` …).
    if (
      entries.some(({ args }) =>
        Object.keys(args).some((key) => /xy$/u.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ''))),
      )
    )
      openDetails = true;
    if (described.some(({ cut }) => cut)) notes.push(TEXT_CUT_NOTE);
    if (entries.length > DESKTOP_ACTION_MAX_STEPS) {
      stepsOmitted = entries.length - DESKTOP_ACTION_MAX_STEPS;
      notes.push(
        `ほかに ${stepsOmitted} 個の操作があります。「詳細（実行内容）」で確かめてください。`,
      );
    }
    head = {
      kind: 'other',
      title: entries.length > 0 ? `${entries.length} 個の操作をまとめて行います` : UNKNOWN[1],
      mode,
    };
    if (entries.length === 0 || stepsOmitted !== undefined || described.some(({ cut }) => cut))
      openDetails = true;
  } else {
    const command = read.command!;
    const text = textArgument(command);
    const described = describeStep(
      command,
      mode,
      {
        ref: REF_COMMANDS.has(command) ? read.positionals[0] : read.options.get('--from'),
        windowId: read.options.get('--window-id'),
        app: APP_COMMANDS.has(command) ? read.positionals[0] : read.options.get('--app'),
        destination: command === 'drag' ? read.options.get('--to') : undefined,
        text: text === undefined ? undefined : read.positionals[text[0]],
      },
      snapshots,
    );
    head = described.step;
    if (described.unexplained) openDetails = true;
    // A point given as coordinates is not what the card names, even beside a part.
    if (COORDINATE_OPTIONS.some((option) => read.options.has(option))) openDetails = true;
    if (described.cut) {
      notes.push(TEXT_CUT_NOTE);
      openDetails = true;
    }
  }
  const all = [head, ...(steps ?? [])];
  const partOperation =
    read !== null &&
    (read.command === 'batch'
      ? (readBatchEntries(read.positionals) ?? []).some(({ command }) =>
          PART_OPERATIONS.has(command),
        )
      : !read.help && read.command !== undefined && PART_OPERATIONS.has(read.command));
  if (
    all.some(
      ({ target, destination }) =>
        (target !== undefined && !target.resolved) ||
        (destination !== undefined && !destination.resolved),
    )
  )
    openDetails = true;
  if (mode === 'background' && partOperation) notes.unshift(RAISE_NOTE);
  if (all.some(({ kind }) => kind === 'launch')) notes.unshift(LAUNCH_NOTE);
  if (all.some(({ kind }) => kind === 'close')) notes.unshift(CLOSE_NOTE);
  if (mode === 'foreground') notes.unshift(FOREGROUND_NOTE);
  return {
    ...head,
    ...(steps === undefined ? {} : { steps }),
    ...(stepsOmitted === undefined ? {} : { stepsOmitted }),
    allowTaskGrant: mode !== 'foreground',
    notes,
    openDetails,
  };
}

type StepArguments = Readonly<{
  ref: string | undefined;
  windowId: string | undefined;
  app: string | undefined;
  /** The ref a drag drops on. */
  destination: string | undefined;
  text: string | undefined;
}>;

/**
 * One operation for the card. `unexplained` is set when the card cannot say what an operation
 * that is not a read acts on: no target (coordinates, or keys to whatever has focus), a part with
 * no name, or a drag whose drop is not a named part. The card then opens its details.
 */
function describeStep(
  command: string,
  mode: Mode,
  { ref, windowId, app, destination, text }: StepArguments,
  snapshots: SnapshotReader,
): { step: DesktopActionStep; cut: boolean; unexplained: boolean } {
  const [kind, title] = Object.hasOwn(COMMANDS, command) ? COMMANDS[command]! : UNKNOWN;
  const target =
    ref !== undefined && ref !== ''
      ? snapshots.part(ref)
      : windowId !== undefined && windowId !== ''
        ? snapshots.window(windowId)
        : app !== undefined && app.trim() !== ''
          ? { resolved: true, app: visible(app, NAME_MAX).text }
          : Object.hasOwn(ALL_TARGETS, command)
            ? { resolved: true, all: ALL_TARGETS[command]! }
            : undefined;
  const drop =
    command === 'drag' && destination !== undefined && destination !== ''
      ? snapshots.part(destination)
      : undefined;
  const shown = text === undefined || text === '' ? undefined : visible(text, TEXT_MAX, true);
  const unexplained =
    kind !== 'read' &&
    ((target === undefined && !NO_TARGET_COMMANDS.has(command)) ||
      (target !== undefined && unnamed(target)) ||
      (command === 'drag' && (drop === undefined || unnamed(drop))));
  return {
    step: {
      kind,
      title,
      mode,
      ...(target === undefined ? {} : { target }),
      ...(drop === undefined ? {} : { destination: drop }),
      ...(shown === undefined ? {} : { text: shown.text, textRole: textArgument(command)![2] }),
    },
    cut: shown?.cut === true,
    unexplained,
  };
}

/**
 * Whether a confirmed target is a part, or a window, without a name, which the card cannot tell
 * apart from others of its kind in the same window (an icon-only button, an untitled window).
 */
function unnamed(target: DesktopActionTarget): boolean {
  if (!target.resolved || target.all !== undefined || target.role === undefined) return false;
  return target.role === '窓' ? target.window === undefined : target.name === undefined;
}

function textArgument(command: string): readonly [number, string, TextRole] | undefined {
  return Object.hasOwn(TEXT_ARGUMENTS, command) ? TEXT_ARGUMENTS[command] : undefined;
}

function displayMode(mode: ReturnType<typeof desktopControlArgvMode>): Mode {
  return mode === 'inert' ? 'read' : mode;
}

function stringField(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Text the card can show as it is: invisible and control characters become their code points
 * (`\u{200B}`), and anything past `max` characters is cut with 「…」. A name stays on one line.
 */
function visible(value: string, max: number, multiline = false): { text: string; cut: boolean } {
  const escaped = value.replace(
    new RegExp(APPROVAL_DISPLAY_UNDISPLAYABLE_CHARACTERS.source, 'gu'),
    (match) =>
      Array.from(match, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`).join(''),
  );
  const line = multiline ? escaped : escaped.replace(/[\t\n\r]+/gu, ' ').trim();
  if (line.length <= max) return { text: line === '' ? '（空）' : line, cut: false };
  // Cut on a whole character, within `max` UTF-16 units including the 「…」.
  let kept = '';
  for (const character of line) {
    if (kept.length + character.length > max - 1) break;
    kept += character;
  }
  return { text: `${kept}…`, cut: true };
}

type RefmapEntry = Readonly<{
  role?: unknown;
  name?: unknown;
  source_app?: unknown;
  source_window_id?: unknown;
  source_window_title?: unknown;
}>;

/** Reads snapshots only, synchronously and within bounds; anything unexpected reads as nothing. */
class SnapshotReader {
  private readonly cache = new Map<string, Readonly<Record<string, RefmapEntry>> | null>();
  private disabled = false;

  constructor(private readonly root: string) {}

  disable(): void {
    this.disabled = true;
  }

  part(ref: string): DesktopActionTarget {
    const unresolved = { resolved: false, reference: visible(ref, NAME_MAX).text };
    const match = QUALIFIED_REF.exec(ref);
    if (match === null) return unresolved;
    const entry = this.refmap(match[1]!)?.[`@${match[2]!}`];
    if (entry === undefined || typeof entry !== 'object' || entry === null) return unresolved;
    const app = textField(entry.source_app, NAME_MAX);
    const window = textField(entry.source_window_title, NAME_MAX);
    const name = textField(entry.name, NAME_MAX);
    const role =
      typeof entry.role === 'string' && Object.hasOwn(ROLES, entry.role)
        ? ROLES[entry.role]!
        : '部品';
    if (app === undefined && window === undefined) return unresolved;
    const windowId =
      typeof entry.source_window_id === 'string' && WINDOW_ID.test(entry.source_window_id)
        ? entry.source_window_id
        : undefined;
    return {
      resolved: true,
      ...(app === undefined ? {} : { app }),
      ...(window === undefined ? {} : { window }),
      role: role.slice(0, ROLE_MAX),
      ...(name === undefined ? {} : { name }),
      ...(windowId === undefined ? {} : { windowId }),
    };
  }

  window(id: string): DesktopActionTarget {
    const unresolved = { resolved: false, reference: visible(id, NAME_MAX).text };
    if (!WINDOW_ID.test(id)) return unresolved;
    for (const snapshot of this.recentSnapshots()) {
      const entries = this.refmap(snapshot);
      if (entries === null) continue;
      for (const entry of Object.values(entries)) {
        if (typeof entry !== 'object' || entry === null || entry.source_window_id !== id) continue;
        const app = textField(entry.source_app, NAME_MAX);
        const window = textField(entry.source_window_title, NAME_MAX);
        if (app === undefined && window === undefined) continue;
        return {
          resolved: true,
          ...(app === undefined ? {} : { app }),
          ...(window === undefined ? {} : { window }),
          role: '窓',
          windowId: id,
        };
      }
    }
    return unresolved;
  }

  private recentSnapshots(): string[] {
    if (this.disabled) return [];
    try {
      const folder = join(this.root, 'snapshots');
      return readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SNAPSHOT_ID.test(entry.name))
        .map((entry) => {
          try {
            return { name: entry.name, time: statSync(join(folder, entry.name)).mtimeMs };
          } catch {
            return { name: entry.name, time: 0 };
          }
        })
        .sort((left, right) => right.time - left.time)
        .slice(0, RECENT_SNAPSHOTS)
        .map(({ name }) => name);
    } catch {
      return [];
    }
  }

  private refmap(snapshot: string): Readonly<Record<string, RefmapEntry>> | null {
    if (this.disabled || !SNAPSHOT_ID.test(snapshot)) return null;
    const cached = this.cache.get(snapshot);
    if (cached !== undefined) return cached;
    let entries: Readonly<Record<string, RefmapEntry>> | null = null;
    try {
      const path = join(this.root, 'snapshots', snapshot, 'refmap.json');
      const stats = statSync(path);
      if (stats.isFile() && stats.size <= REFMAP_MAX_BYTES) {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { inner?: unknown };
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof parsed.inner === 'object' &&
          parsed.inner !== null &&
          !Array.isArray(parsed.inner)
        )
          entries = parsed.inner as Record<string, RefmapEntry>;
      }
    } catch {
      entries = null;
    }
    this.cache.set(snapshot, entries);
    return entries;
  }
}

function textField(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return visible(value, max).text;
}
