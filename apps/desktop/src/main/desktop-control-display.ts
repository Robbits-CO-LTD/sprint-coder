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
 * folder desktop-control runs keep (`desktopControlStateFolder`), and, for a window id no snapshot
 * names, from what the Task's earlier runs reported (`rememberDesktopControlWindows`). They are
 * text the app chose, so they are cut short and invisible characters are shown as their code
 * points. The part's value (what a field holds) is never read out.
 */
export type DesktopControlDisplayLookup = Readonly<{
  /** The state folder; by default the one the runs use (`desktopControlStateFolder`). */
  stateRoot?: string;
  /** False to leave the snapshots unread, for a summary that names no part. */
  names?: boolean;
  /** The Task whose earlier runs' windows may name a window id. */
  taskId?: string;
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
// Semantic operations on a part. Without `--headed` they take no mouse or keyboard and leave the
// part's window where it is, behind the one the person is using.
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
// Bringing a window to the front without `--headed` takes no mouse or keyboard.
const FRONT_NOTE = '対象の窓が前面に出ます。';
const LAUNCH_NOTE =
  '起動した窓は、今使っている窓の後ろに置きます。一瞬だけ手前に見えることがあります。';
const LAUNCH_FRONT_NOTE = '起動した窓が前面に出ます。';
const CLOSE_NOTE = '開いているアプリを閉じます。';
// Minimizing hands the front to another window, so it is never covered by an app-wide grant.
const MINIMIZE_NOTE = '窓を最小化します。最小化すると、次の窓が手前に来ます。';
// `select <ref>` without a value chooses the part the ref names itself, not an option inside it.
const SELECT_ITEM_TITLE = 'この項目を選びます';
// `snapshot --surface menubar` reads the window's menu bar without opening it.
const MENU_BAR_TITLE = 'メニューバーの項目を読みます';
// `click` on a menu item ref runs the app's command for that item, without opening the menu.
const MENU_RUN_TITLE = 'メニューの項目を実行します';
const MENU_NOTE =
  'アプリのメニューの項目を、メニューを開かずに実行します。保存・削除・終了などの項目もあるので、項目の名前を確かめてください。メニューの項目の実行は、毎回確かめます。';
// Reads that take `--root` (`root` in a batch) read only below that part.
const ROOT_COMMANDS = new Set(['snapshot', 'find']);
const BEHIND_NOTE =
  '対象の窓を前面に出さずに操作します。操作の結果、アプリが自分で窓を手前に出すことがあります。';
// Foreground commands that only bring a window to the front (`launch` with `--activate`).
const FRONT_ONLY_COMMANDS = new Set(['focus-window', 'restore', 'maximize', 'launch']);
const TEXT_CUT_NOTE =
  '入れる文字が長いため、途中までを表示しています。全文は「詳細（実行内容）」で確かめてください。';

type KnownWindow = Readonly<{ app: unknown; title: unknown; pid: unknown; instance: unknown }>;
const KNOWN_TASKS = 50;
const KNOWN_WINDOWS_PER_TASK = 200;
const OUTPUT_MAX_CHARACTERS = 1_048_576;
// Per Task, the windows its desktop-control runs reported, oldest first.
const knownWindows = new Map<string, Map<string, KnownWindow>>();
// Per Task, the window ids the executable found owned by another process than the one an app-wide
// grant expected (`window_owner_mismatch`): no record names their owner for the rest of the Task.
const distrustedWindows = new Map<string, Set<string>>();

/**
 * Notes every window id a run's output reports as no longer owned by the expected process, as the
 * shipped executable reports it (`SPRINT_CODER_DESKTOP_EXPECTED_WINDOW_OWNER`), also inside a
 * batch. Output in any other shape notes nothing; noting more only means more cards.
 */
function distrustMovedWindows(taskId: string, stdout: string): void {
  try {
    if (stdout.length > OUTPUT_MAX_CHARACTERS || !stdout.includes('window_owner_mismatch')) return;
    const found: string[] = [];
    const walk = (value: unknown, depth: number): void => {
      if (depth > 8 || typeof value !== 'object' || value === null) return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      const record = value as Record<string, unknown>;
      if (
        record['kind'] === 'window_owner_mismatch' &&
        typeof record['window_id'] === 'string' &&
        WINDOW_ID.test(record['window_id'])
      )
        found.push(record['window_id']);
      for (const item of Object.values(record)) walk(item, depth + 1);
    };
    walk(JSON.parse(stdout), 0);
    if (found.length === 0) return;
    const distrusted = distrustedWindows.get(taskId) ?? new Set<string>();
    for (const id of found) distrusted.add(id);
    distrustedWindows.delete(taskId);
    distrustedWindows.set(taskId, distrusted);
    if (distrustedWindows.size > KNOWN_TASKS)
      distrustedWindows.delete(distrustedWindows.keys().next().value!);
  } catch {
    // Output that cannot be read notes nothing.
  }
}

/**
 * Keeps the windows a finished desktop-control run of a Task reported (`launch` and
 * `list-windows`), so that a later card of the same Task can name a window no snapshot has read
 * yet, such as the one a launch just opened. Read from what the shipped executable printed, never
 * from the agent's arguments; output in any other shape is ignored. For the card only.
 */
export function rememberDesktopControlWindows(
  taskId: string,
  argv: readonly string[],
  stdout: string,
): void {
  distrustMovedWindows(taskId, stdout);
  try {
    const command = readDesktopControlCommand(argv);
    if (
      command === null ||
      command.help ||
      (command.command !== 'launch' && command.command !== 'list-windows') ||
      stdout.length > OUTPUT_MAX_CHARACTERS
    )
      return;
    const output = JSON.parse(stdout) as { ok?: unknown; command?: unknown; data?: unknown };
    if (
      typeof output !== 'object' ||
      output === null ||
      output.ok !== true ||
      output.command !== command.command
    )
      return;
    const data = output.data as { window?: unknown } | null | undefined;
    const windows: unknown[] =
      command.command === 'list-windows'
        ? Array.isArray(data)
          ? data
          : []
        : typeof data === 'object' && data !== null && !Array.isArray(data)
          ? [data.window]
          : [];
    const known = knownWindows.get(taskId) ?? new Map<string, KnownWindow>();
    for (const window of windows) {
      if (typeof window !== 'object' || window === null) continue;
      const {
        id,
        app_name: app,
        title,
        pid,
        process_instance: instance,
      } = window as Record<string, unknown>;
      if (typeof id !== 'string' || !WINDOW_ID.test(id)) continue;
      known.delete(id);
      known.set(id, { app, title, pid, instance });
      if (known.size > KNOWN_WINDOWS_PER_TASK) known.delete(known.keys().next().value!);
    }
    if (known.size === 0) return;
    knownWindows.delete(taskId);
    knownWindows.set(taskId, known);
    if (knownWindows.size > KNOWN_TASKS) knownWindows.delete(knownWindows.keys().next().value!);
  } catch {
    // Output that cannot be read names no window.
  }
}

/**
 * The process a part or window belongs to, as the desktop-control executable recorded it: its pid,
 * the process instance (which tells a reused pid apart) and its executable's name.
 */
export type DesktopControlOwner = Readonly<{ pid: number; instance: string; app: string }>;

/**
 * Reads which process the parts and windows of desktop-control runs belong to, from the same
 * records the card names them from: the snapshots the executable wrote in the state folder, and
 * the windows the Task's earlier runs printed (`rememberDesktopControlWindows`). Never from the
 * agent's arguments. `null` whenever a record is missing, malformed or the records disagree.
 */
export type DesktopControlOwnerReader = Readonly<{
  /** The owner of the part a qualified ref (`@<snapshot id>:eN`) names. */
  part(ref: string): DesktopControlOwner | null;
  /** The one owner every record of this window id agrees on. */
  window(id: string): DesktopControlOwner | null;
  /**
   * Whether the ref may name an item of a window's standard menu bar: it does, or its record cannot
   * be told (`SnapshotReader.refRecord`).
   */
  menuPart(ref: string): boolean;
}>;

export function desktopControlOwnerReader(
  lookup: Pick<DesktopControlDisplayLookup, 'stateRoot' | 'taskId'> = {},
): DesktopControlOwnerReader {
  const reader = new SnapshotReader(
    lookup.stateRoot ?? desktopControlStateFolder(),
    lookup.taskId === undefined ? undefined : knownWindows.get(lookup.taskId),
  );
  const { taskId } = lookup;
  return {
    part: (ref) => reader.partOwner(ref),
    menuPart: (ref) => reader.refRecord(ref) !== 'part',
    // Read when asked, so an id distrusted after the reader was made is not taken either.
    window: (id) =>
      taskId !== undefined && distrustedWindows.get(taskId)?.has(id) === true
        ? null
        : reader.windowOwner(id),
  };
}

/** Whether two owners are the same process instance of the same executable. */
export function sameDesktopControlOwner(
  left: DesktopControlOwner,
  right: DesktopControlOwner,
): boolean {
  return (
    left.pid === right.pid &&
    left.instance === right.instance &&
    left.app.toLowerCase() === right.app.toLowerCase()
  );
}

const PROCESS_INSTANCE = /^[A-Za-z0-9:._-]{1,128}$/u;
// Other control characters are refused with the invisible ones (`UNDISPLAYABLE`).
const APP_NAME = /^[^\t\n\r\\/:*?"<>|]{1,255}$/u;
const UNDISPLAYABLE = new RegExp(APPROVAL_DISPLAY_UNDISPLAYABLE_CHARACTERS.source, 'u');

function ownerOf(pid: unknown, instance: unknown, app: unknown): DesktopControlOwner | null {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof instance !== 'string' || !PROCESS_INSTANCE.test(instance)) return null;
  if (
    typeof app !== 'string' ||
    app.trim() === '' ||
    !APP_NAME.test(app) ||
    UNDISPLAYABLE.test(app)
  )
    return null;
  return { pid, instance, app };
}

export function desktopControlApprovalAction(
  argv: readonly string[],
  lookup: DesktopControlDisplayLookup = {},
): DesktopApprovalAction {
  try {
    const snapshots = new SnapshotReader(
      lookup.stateRoot ?? desktopControlStateFolder(),
      lookup.names === false || lookup.taskId === undefined
        ? undefined
        : knownWindows.get(lookup.taskId),
    );
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
      // A run the card cannot describe is not one it can judge for the Task either.
      allowTaskGrant: false,
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
  // A run naming a standard menu item ref, which runs an app command; never granted for the Task.
  let menuItems = false;
  const menuNames: string[] = [];
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
          ref: stringField(args, ROOT_COMMANDS.has(command) ? 'root' : 'ref_id'),
          windowId: stringField(args, 'window_id'),
          app: stringField(args, 'app'),
          // Not read from a batch entry, so a drag in one is never shown as explained.
          destination: undefined,
          text:
            textArgument(command) === undefined
              ? undefined
              : stringField(args, textArgument(command)![1]),
          surface: stringField(args, 'surface'),
        },
        snapshots,
      ),
    );
    steps = described.map(({ step }) => step);
    if (described.some(({ menu }) => menu)) menuItems = true;
    for (const { menuFull } of described) if (menuFull !== undefined) menuNames.push(menuFull);
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
        ref: REF_COMMANDS.has(command)
          ? read.positionals[0]
          : read.options.get(ROOT_COMMANDS.has(command) ? '--root' : '--from'),
        windowId: read.options.get('--window-id'),
        app: APP_COMMANDS.has(command) ? read.positionals[0] : read.options.get('--app'),
        destination: command === 'drag' ? read.options.get('--to') : undefined,
        text: text === undefined ? undefined : read.positionals[text[0]],
        surface: read.options.get('--surface'),
      },
      snapshots,
    );
    head = described.step;
    if (described.menu) menuItems = true;
    if (described.menuFull !== undefined) menuNames.push(described.menuFull);
    if (described.unexplained) openDetails = true;
    // A point given as coordinates is not what the card names, even beside a part.
    if (COORDINATE_OPTIONS.some((option) => read.options.has(option))) openDetails = true;
    if (described.cut) {
      notes.push(TEXT_CUT_NOTE);
      openDetails = true;
    }
  }
  const all = [head, ...(steps ?? [])];
  const commands =
    read === null || read.help || read.command === undefined
      ? []
      : read.command === 'batch'
        ? (readBatchEntries(read.positionals) ?? []).map(({ command }) => command)
        : [read.command];
  if (
    all.some(
      ({ target, destination }) =>
        (target !== undefined && !target.resolved) ||
        (destination !== undefined && !destination.resolved),
    )
  )
    openDetails = true;
  if (mode === 'background' && commands.some((command) => PART_OPERATIONS.has(command)))
    notes.unshift(BEHIND_NOTE);
  if (all.some((step) => step.kind === 'launch' && step.mode !== 'foreground'))
    notes.unshift(LAUNCH_NOTE);
  if (all.some((step) => step.kind === 'launch' && step.mode === 'foreground'))
    notes.unshift(LAUNCH_FRONT_NOTE);
  if (all.some(({ kind }) => kind === 'close')) notes.unshift(CLOSE_NOTE);
  if (commands.includes('minimize')) notes.unshift(MINIMIZE_NOTE);
  for (const name of menuNames.slice(0, 2))
    notes.push(visible(`メニューの項目の名前（全部）: ${name}`, NOTE_MAX).text);
  if (menuItems) notes.unshift(MENU_NOTE);
  if (mode === 'foreground') {
    // Only bringing a window to the front, without `--headed`, takes no mouse or keyboard.
    const frontOnly =
      read !== null &&
      !read.options.has('--headed') &&
      commands.length > 0 &&
      commands.every((command) => FRONT_ONLY_COMMANDS.has(command));
    if (!frontOnly) notes.unshift(FOREGROUND_NOTE);
    else if (commands.some((command) => command !== 'launch')) notes.unshift(FRONT_NOTE);
  }
  return {
    ...head,
    ...(steps === undefined ? {} : { steps }),
    ...(stepsOmitted === undefined ? {} : { stepsOmitted }),
    allowTaskGrant: mode !== 'foreground' && !menuItems && !taskGrantBlocked(read, snapshots),
    notes,
    openDetails,
  };
}

const NOTE_MAX = 200;
// The most entries the executable runs in one batch (`MAX_BATCH_ENTRIES`); it refuses more.
const BATCH_ENTRIES_MAX = 64;
// The fields of a batch entry the executable reads (`BatchCommand`); it refuses any other.
const BATCH_ENTRY_FIELDS = new Set(['command', 'args']);

/**
 * Whether this run's card must not offer 「Task中許可」 because what it acts on cannot be judged
 * here: Main allows a run for the Task only when it can tell every part it names, so anything it
 * cannot tell counts as what it would refuse (a standard menu item, which runs an app command).
 * Judged over every step the executable runs, not only those the card shows: a run Main cannot read,
 * a batch with more steps than the card shows or the executable runs, an entry with a field other
 * than `command` and `args` (a `session` there switches where its refs are read from), and any ref,
 * wherever it appears, that is not one Main reads as a part (`SnapshotReader.refRecord`).
 */
function taskGrantBlocked(
  read: ReturnType<typeof readDesktopControlCommand>,
  snapshots: SnapshotReader,
): boolean {
  if (read === null) return true;
  if (read.help || read.command === undefined) return false;
  const refs: string[] = [];
  for (const value of read.options.values()) if (value.startsWith('@')) refs.push(value);
  if (read.command === 'batch') {
    const raw = batchJson(read.positionals);
    const entries = readBatchEntries(read.positionals);
    if (raw === null || entries === null) return true;
    if (entries.length === 0 || entries.length > DESKTOP_ACTION_MAX_STEPS) return true;
    if (entries.length > BATCH_ENTRIES_MAX) return true;
    if (raw.some((entry) => Object.keys(entry).some((key) => !BATCH_ENTRY_FIELDS.has(key))))
      return true;
    for (const { args } of entries) collectRefs(args, refs);
  } else for (const value of read.positionals) if (value.startsWith('@')) refs.push(value);
  return refs.some((ref) => snapshots.refRecord(ref) !== 'part');
}

/** The entries of a batch argument as objects, or `null` when it is not a JSON array of them. */
function batchJson(positionals: readonly string[]): Readonly<Record<string, unknown>>[] | null {
  if (positionals.length !== 1) return null;
  try {
    const parsed: unknown = JSON.parse(positionals[0]!);
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== 'object' || entry === null || Array.isArray(entry))
    )
      return null;
    return parsed as Record<string, unknown>[];
  } catch {
    return null;
  }
}

/** Every string in a batch entry's arguments that may be a ref, at any depth. */
function collectRefs(value: unknown, refs: string[]): void {
  if (typeof value === 'string') {
    if (value.startsWith('@')) refs.push(value);
  } else if (Array.isArray(value)) for (const item of value) collectRefs(item, refs);
  else if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) collectRefs(item, refs);
}

type StepArguments = Readonly<{
  ref: string | undefined;
  windowId: string | undefined;
  app: string | undefined;
  /** The ref a drag drops on. */
  destination: string | undefined;
  text: string | undefined;
  /** The surface a `snapshot` reads. */
  surface: string | undefined;
}>;

/**
 * One operation for the card. `unexplained` is set when the card cannot say what an operation
 * that is not a read acts on: no target (coordinates, or keys to whatever has focus), a part with
 * no name, or a drag whose drop is not a named part. The card then opens its details.
 */
function describeStep(
  command: string,
  mode: Mode,
  { ref, windowId, app, destination, text, surface }: StepArguments,
  snapshots: SnapshotReader,
): {
  step: DesktopActionStep;
  cut: boolean;
  unexplained: boolean;
  menu: boolean;
  /** The whole name of a menu item the card could not show in full. */
  menuFull: string | undefined;
} {
  const [kind, heading] = Object.hasOwn(COMMANDS, command) ? COMMANDS[command]! : UNKNOWN;
  // Any command naming a menu item ref; the executable runs it only for `click`.
  const menu = ref !== undefined && ref !== '' && snapshots.refRecord(ref) === 'menu';
  const label = menu ? snapshots.menuLabelOf(ref) : undefined;
  const title =
    command === 'select' && (text === undefined || text === '')
      ? SELECT_ITEM_TITLE
      : command === 'snapshot' && surface === 'menubar'
        ? MENU_BAR_TITLE
        : menu && command === 'click'
          ? MENU_RUN_TITLE
          : heading;
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
      (command === 'drag' && (drop === undefined || unnamed(drop))) ||
      label?.cut === true);
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
    menu,
    menuFull: label?.cut === true ? label.full : undefined,
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
  pid?: unknown;
  process_instance?: unknown;
  role?: unknown;
  name?: unknown;
  source_app?: unknown;
  source_window_id?: unknown;
  source_window_title?: unknown;
  /** Child indexes from the snapshot's root (or `root_ref`) down to the part. */
  path?: unknown;
  root_ref?: unknown;
  path_is_absolute?: unknown;
  /** Set for an item of a window's standard menu bar (`snapshot --surface menubar`). */
  proven_in_menu?: unknown;
}>;

const MENU_STEPS_MAX = 16;

const MENU_NAME_MAX = 1_024;

/** How the card names a menu item: what fits, the whole name, and whether they differ. */
type MenuLabel = Readonly<{ text: string; full: string; cut: boolean }>;

/**
 * How a person names a standard menu item: its menus from the bar down, each exactly as the record
 * names it (「(F)」 and 「(1)」 kept, so items that differ only there stay apart), and its shortcut,
 * e.g. 「ファイル(F) > 上書き保存(S)（Ctrl+S）」. The item's own name is never dropped: a name too
 * long for the card shortens the menus above it to 「…」 first, and whenever anything is left out
 * `cut` is set, so the card opens its details and shows the whole name in a note.
 * `undefined` when the record is not in the shape the executable writes.
 */
function menuLabel(proof: unknown): MenuLabel | undefined {
  if (typeof proof !== 'object' || proof === null) return undefined;
  const { steps, shortcut } = proof as { steps?: unknown; shortcut?: unknown };
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MENU_STEPS_MAX)
    return undefined;
  const names: string[] = [];
  for (const step of steps) {
    const name =
      typeof step === 'object' && step !== null ? (step as { name?: unknown }).name : undefined;
    if (typeof name !== 'string' || name.trim() === '') return undefined;
    names.push(visible(name, MENU_NAME_MAX).text);
  }
  const keys =
    typeof shortcut === 'string' && shortcut.trim() !== ''
      ? `（${visible(shortcut, NAME_MAX).text}）`
      : '';
  const leaf = `${names.at(-1)!}${keys}`;
  const full = `${names.join(' > ')}${keys}`;
  const shortened = [full];
  if (names.length > 2) shortened.push(`${names[0]!} > … > ${leaf}`);
  if (names.length > 1) shortened.push(`… > ${leaf}`);
  for (const text of shortened)
    if (text.length <= NAME_MAX) return { text, full, cut: text !== full };
  return { text: visible(shortened.at(-1)!, NAME_MAX).text, full, cut: true };
}

function isMenuEntry(entry: RefmapEntry): boolean {
  return Object.hasOwn(entry, 'proven_in_menu');
}

const PATH_MAX = 256;

/** The part's place in its snapshot's tree, or `null` when it is not in the shape refmaps use. */
function treePath(entry: RefmapEntry): readonly number[] | null {
  const { path } = entry;
  if (!Array.isArray(path) || path.length === 0 || path.length > PATH_MAX) return null;
  return path.every((index) => Number.isSafeInteger(index) && (index as number) >= 0)
    ? (path as number[])
    : null;
}

/** Whether `inner` sits below `outer` in the same tree of the same window. */
function contains(outer: RefmapEntry, inner: RefmapEntry): boolean {
  const outerPath = treePath(outer);
  const innerPath = treePath(inner);
  return (
    outerPath !== null &&
    innerPath !== null &&
    outerPath.length < innerPath.length &&
    outer.source_window_id === inner.source_window_id &&
    outer.root_ref === inner.root_ref &&
    outer.path_is_absolute === inner.path_is_absolute &&
    outerPath.every((index, at) => innerPath[at] === index)
  );
}

/** Reads snapshots only, synchronously and within bounds; anything unexpected reads as nothing. */
class SnapshotReader {
  private readonly cache = new Map<string, Readonly<Record<string, RefmapEntry>> | null>();
  private disabled = false;

  constructor(
    private readonly root: string,
    private readonly known?: ReadonlyMap<string, KnownWindow>,
  ) {}

  disable(): void {
    this.disabled = true;
  }

  part(ref: string): DesktopActionTarget {
    const unresolved = { resolved: false, reference: visible(ref, NAME_MAX).text };
    const match = QUALIFIED_REF.exec(ref);
    if (match === null) return unresolved;
    const entries = this.refmap(match[1]!);
    const entry = entries?.[`@${match[2]!}`];
    if (entries === null || entry === undefined || typeof entry !== 'object' || entry === null)
      return unresolved;
    const app = textField(entry.source_app, NAME_MAX);
    const window = textField(entry.source_window_title, NAME_MAX);
    const menu = isMenuEntry(entry);
    // A menu item is named by its whole place in the menu; one whose record cannot be read is
    // shown without a name, which opens the card's details.
    const name = menu ? menuLabel(entry.proven_in_menu)?.text : textField(entry.name, NAME_MAX);
    if (app === undefined && window === undefined) return unresolved;
    const windowId =
      typeof entry.source_window_id === 'string' && WINDOW_ID.test(entry.source_window_id)
        ? entry.source_window_id
        : undefined;
    const within = name === undefined || menu ? undefined : SnapshotReader.within(entries, entry);
    return {
      resolved: true,
      ...(app === undefined ? {} : { app }),
      ...(window === undefined ? {} : { window }),
      role: roleText(entry.role),
      ...(name === undefined ? {} : { name }),
      ...(within === undefined ? {} : { within }),
      ...(windowId === undefined ? {} : { windowId }),
    };
  }

  /**
   * Where a part sits, when its window has other parts of the same role and name (three 「閉じる」
   * buttons): the nearest named part of the snapshot that holds it but not every one of the others.
   * A snapshot records only the parts it gives a ref, so a dialog or group with none is not found,
   * and then nothing is added.
   */
  private static within(
    entries: Readonly<Record<string, RefmapEntry>>,
    entry: RefmapEntry,
  ): { role: string; name: string } | undefined {
    const all = Object.values(entries).filter(
      (other): other is RefmapEntry => typeof other === 'object' && other !== null,
    );
    const name = (value: unknown) => (typeof value === 'string' ? value.trim() : undefined);
    const twins = all.filter(
      (other) =>
        other !== entry &&
        other.source_window_id === entry.source_window_id &&
        other.role === entry.role &&
        name(other.name) === name(entry.name),
    );
    if (twins.length === 0) return undefined;
    let nearest: RefmapEntry | undefined;
    for (const outer of all) {
      if (textField(outer.name, NAME_MAX) === undefined || !contains(outer, entry)) continue;
      if (twins.every((twin) => contains(outer, twin))) continue;
      if (nearest === undefined || treePath(outer)!.length > treePath(nearest)!.length)
        nearest = outer;
    }
    return nearest === undefined
      ? undefined
      : { role: roleText(nearest.role), name: textField(nearest.name, NAME_MAX)! };
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
        return windowTarget(id, app, window);
      }
    }
    // A window no snapshot names yet, as an earlier run of the Task reported it.
    const known = this.known?.get(id);
    if (known !== undefined) {
      const app = textField(known.app, NAME_MAX);
      const window = textField(known.title, NAME_MAX);
      if (app !== undefined || window !== undefined) return windowTarget(id, app, window);
    }
    return unresolved;
  }

  /**
   * What the record of a ref says it names: an item of a window's standard menu bar (which runs the
   * app's command for that item), another part, or `unknown` when Main cannot tell - a ref not in
   * the form Main reads (`QUALIFIED_REF`; the executable takes more forms, such as an upper-case
   * id, which a case-blind file system finds under the lower-case one), records Main does not read
   * (`--session`, names off) or a record that cannot be read. Anything but `part` may be a menu
   * item, and is treated as one wherever that matters.
   */
  refRecord(ref: string): 'menu' | 'part' | 'unknown' {
    const match = QUALIFIED_REF.exec(ref);
    if (match === null) return 'unknown';
    const entry = this.refmap(match[1]!)?.[`@${match[2]!}`];
    if (typeof entry !== 'object' || entry === null) return 'unknown';
    return isMenuEntry(entry) ? 'menu' : 'part';
  }

  /** The card's name of the menu item a ref names, when it is one whose record can be read. */
  menuLabelOf(ref: string): MenuLabel | undefined {
    const match = QUALIFIED_REF.exec(ref);
    if (match === null) return undefined;
    const entry = this.refmap(match[1]!)?.[`@${match[2]!}`];
    if (typeof entry !== 'object' || entry === null || !isMenuEntry(entry)) return undefined;
    return menuLabel(entry.proven_in_menu);
  }

  partOwner(ref: string): DesktopControlOwner | null {
    const match = QUALIFIED_REF.exec(ref);
    if (match === null) return null;
    const entry = this.refmap(match[1]!)?.[`@${match[2]!}`];
    if (typeof entry !== 'object' || entry === null) return null;
    return ownerOf(entry.pid, entry.process_instance, entry.source_app);
  }

  /**
   * The records can be older than the window: a closed window's id can be reused by another app's.
   * So a run an app-wide grant allows by window id also has the executable check the id's owner
   * as it runs (`SPRINT_CODER_DESKTOP_EXPECTED_WINDOW_OWNER`), and an id it found reused is
   * distrusted for the rest of the Task.
   */
  windowOwner(id: string): DesktopControlOwner | null {
    if (!WINDOW_ID.test(id)) return null;
    const owners: (DesktopControlOwner | null)[] = [];
    for (const snapshot of this.recentSnapshots())
      for (const entry of Object.values(this.refmap(snapshot) ?? {}))
        if (typeof entry === 'object' && entry !== null && entry.source_window_id === id)
          owners.push(ownerOf(entry.pid, entry.process_instance, entry.source_app));
    const known = this.known?.get(id);
    if (known !== undefined) owners.push(ownerOf(known.pid, known.instance, known.app));
    const [first] = owners;
    if (first === undefined || first === null) return null;
    return owners.every((owner) => owner !== null && sameDesktopControlOwner(owner, first))
      ? first
      : null;
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

function windowTarget(
  windowId: string,
  app: string | undefined,
  window: string | undefined,
): DesktopActionTarget {
  return {
    resolved: true,
    ...(app === undefined ? {} : { app }),
    ...(window === undefined ? {} : { window }),
    role: '窓',
    windowId,
  };
}

function roleText(role: unknown): string {
  return (typeof role === 'string' && Object.hasOwn(ROLES, role) ? ROLES[role]! : '部品').slice(
    0,
    ROLE_MAX,
  );
}

function textField(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return visible(value, max).text;
}
