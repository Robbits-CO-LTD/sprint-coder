import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desktopApprovalActionSchema } from '@sprint-coder/contracts';
import {
  desktopControlApprovalAction,
  rememberDesktopControlWindows,
} from './desktop-control-display';

let stateRoot: string;

function writeRefmap(snapshot: string, inner: unknown, at = Date.now() / 1000): void {
  const folder = join(stateRoot, 'snapshots', snapshot);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'refmap.json'), JSON.stringify({ inner, counter: 3 }));
  utimesSync(folder, at, at);
}

const charmapField = {
  role: 'textfield',
  name: 'コピーする文字(A):',
  value: 'SECRET FIELD CONTENT',
  source_app: 'charmap.exe',
  source_window_id: 'w-62263518',
  source_window_title: '文字コード表',
};

beforeAll(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'sc-dc-display-'));
  writeRefmap('s1abc', {
    '@e1': charmapField,
    '@e2': { ...charmapField, role: 'combobox', name: 'フォント(F):' },
    '@e3': { ...charmapField, role: 'menubutton', name: 'ファイル' },
    '@e4': {
      ...charmapField,
      role: 'made-up-role',
      name: `${String.fromCodePoint(0x200b)}隠し${String.fromCodePoint(0x202e)}テキスト`,
    },
    '@e5': { ...charmapField, name: 'あ'.repeat(300), source_window_title: 'い'.repeat(300) },
    // An icon-only button: no name, or only spaces.
    '@e6': { ...charmapField, role: 'button', name: undefined },
    '@e7': { ...charmapField, role: 'button', name: '   ' },
  });
  writeRefmap('suntitled', {
    '@e1': { role: 'window', source_app: 'untitled.exe', source_window_id: 'w-777' },
  });
  // Three 「閉じる」 buttons: on the title bar, in a dialog, and in a group with no name.
  const mail = {
    source_app: 'RabbitMail.exe',
    source_window_id: 'w-4242',
    source_window_title: 'RabbitMail',
  };
  writeRefmap('smail', {
    '@e1': { ...mail, role: 'button', name: '閉じる', path: [0, 2] },
    '@e2': { ...mail, role: 'dialog', name: '終了の確認', path: [1] },
    '@e3': { ...mail, role: 'group', path: [1, 0] },
    '@e4': { ...mail, role: 'button', name: '閉じる', path: [1, 0, 3] },
    '@e5': { ...mail, role: 'group', name: '本文', path: [2] },
    '@e6': { ...mail, role: 'button', name: '閉じる', path: [2, 1] },
    '@e7': { ...mail, role: 'button', name: '送信', path: [2, 0] },
    // Under a different root, so not inside 「本文」 at all.
    '@e8': { ...mail, role: 'button', name: '保存', path: [2, 5], root_ref: '@e9' },
    '@e10': { ...mail, role: 'button', name: '保存', path: [3] },
  });
  writeRefmap('snotepad', {
    '@e1': {
      role: 'document',
      name: 'テキスト エディター',
      source_app: 'Notepad.exe',
      source_window_id: 'w-5903576',
      source_window_title: '無題 - メモ帳',
    },
  });
  // Broken and oversized snapshots read as nothing.
  mkdirSync(join(stateRoot, 'snapshots', 'sbroken'), { recursive: true });
  writeFileSync(join(stateRoot, 'snapshots', 'sbroken', 'refmap.json'), '{not json');
  mkdirSync(join(stateRoot, 'snapshots', 'shuge'), { recursive: true });
  writeFileSync(
    join(stateRoot, 'snapshots', 'shuge', 'refmap.json'),
    JSON.stringify({ inner: { '@e1': charmapField }, pad: 'x'.repeat(1_100_000) }),
  );
  writeRefmap('swrong', ['@e1']);
});

afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));

const describeArgv = (argv: readonly string[]) => {
  const action = desktopControlApprovalAction(argv, { stateRoot });
  // Main only ever hands over what the contract accepts.
  expect(desktopApprovalActionSchema.parse(action)).toEqual(action);
  return action;
};

describe('desktop-control approval description', () => {
  it('names the app, window and part a ref points at, and the text it enters', () => {
    const action = describeArgv(['set-value', '@s1abc:e1', 'ABC']);
    expect(action).toMatchObject({
      kind: 'input',
      title: '文字を入力します',
      mode: 'background',
      target: {
        resolved: true,
        app: 'charmap.exe',
        window: '文字コード表',
        role: '入力欄',
        name: 'コピーする文字(A):',
        windowId: 'w-62263518',
      },
      text: 'ABC',
      textRole: 'enter',
      allowTaskGrant: true,
      // No mouse or keyboard, but the call can bring the window to the front.
      notes: [
        '対象の窓を前面に出さずに操作します。操作の結果、アプリが自分で窓を手前に出すことがあります。',
      ],
      openDetails: false,
    });
    // What the field holds is never read out.
    expect(JSON.stringify(action)).not.toContain('SECRET FIELD CONTENT');
  });

  it('describes each kind of command with its heading', () => {
    expect(describeArgv(['click', '@s1abc:e3'])).toMatchObject({
      kind: 'operate',
      title: 'クリックします',
      target: { role: 'メニューボタン', name: 'ファイル' },
    });
    expect(describeArgv(['select', '@s1abc:e2', 'Arial'])).toMatchObject({
      kind: 'input',
      title: '一覧から選びます',
      text: 'Arial',
      textRole: 'select',
      target: { role: '選択欄' },
    });
    // Without a value, the ref is the option itself: the card names that part, not a choice in it.
    for (const argv of [
      ['select', '@s1abc:e2'],
      ['select', '@s1abc:e2', ''],
    ]) {
      const action = describeArgv(argv);
      expect(action).toMatchObject({
        kind: 'input',
        title: 'この項目を選びます',
        target: { resolved: true, role: '選択欄', name: 'フォント(F):' },
      });
      expect(action.text).toBeUndefined();
      expect(action.textRole).toBeUndefined();
    }
    expect(
      describeArgv([
        'batch',
        JSON.stringify([{ command: 'select', args: { ref_id: '@s1abc:e2' } }]),
      ]).steps,
    ).toMatchObject([{ title: 'この項目を選びます', target: { role: '選択欄' } }]);
    expect(describeArgv(['expand', '@s1abc:e3'])).toMatchObject({ title: 'メニューを開きます' });
    expect(describeArgv(['snapshot', '--app', 'charmap'])).toMatchObject({
      kind: 'read',
      title: '画面を読みます',
      mode: 'read',
      target: { resolved: true, app: 'charmap' },
    });
    // A read below one part names that part and its app, as a ref operation does.
    for (const argv of [
      ['snapshot', '--root', '@s1abc:e2', '--max-depth', '30'],
      ['find', '--root=@s1abc:e2', '--role', 'listitem'],
    ])
      expect(describeArgv(argv), argv.join(' ')).toMatchObject({
        kind: 'read',
        target: {
          resolved: true,
          app: 'charmap.exe',
          window: '文字コード表',
          role: '選択欄',
          name: 'フォント(F):',
        },
        openDetails: false,
      });
    expect(describeArgv(['snapshot', '--root', '@snothere:e1']).target).toMatchObject({
      resolved: false,
      reference: '@snothere:e1',
    });
    expect(
      describeArgv([
        'batch',
        JSON.stringify([{ command: 'find', args: { root: '@s1abc:e2', role: 'listitem' } }]),
      ]).steps,
    ).toMatchObject([
      { title: '部品を探します', target: { role: '選択欄', name: 'フォント(F):' } },
    ]);
    expect(describeArgv(['launch', 'charmap'])).toMatchObject({
      kind: 'launch',
      title: 'アプリを起動します',
      mode: 'background',
      target: { resolved: true, app: 'charmap' },
      notes: ['起動した窓は、今使っている窓の後ろに置きます。一瞬だけ手前に見えることがあります。'],
    });
    // A name the Start menu answered reaches the card as the executable's absolute path.
    expect(
      describeArgv(['launch', 'C:\\Program Files\\RabbitMail\\rabbitmail-desktop.exe']),
    ).toMatchObject({
      kind: 'launch',
      target: { resolved: true, app: 'C:\\Program Files\\RabbitMail\\rabbitmail-desktop.exe' },
    });
    expect(describeArgv(['close-app', 'charmap'])).toMatchObject({
      kind: 'close',
      title: 'アプリを閉じます',
      mode: 'foreground',
      allowTaskGrant: false,
    });
    expect(describeArgv(['close-app', 'charmap']).notes).toContain('開いているアプリを閉じます。');
    expect(describeArgv(['press', 'ctrl+c', '--app', 'charmap'])).toMatchObject({
      title: 'キーを押します',
      text: 'ctrl+c',
      textRole: 'keys',
      target: { app: 'charmap' },
    });
    expect(
      describeArgv(['move-window', '--window-id', 'w-5903576', '--x', '0', '--y', '0']),
    ).toMatchObject({
      kind: 'window',
      title: '窓を動かします',
      target: { resolved: true, app: 'Notepad.exe', window: '無題 - メモ帳', role: '窓' },
    });
    expect(describeArgv(['clipboard-set', 'hello'])).toMatchObject({
      text: 'hello',
      textRole: 'clipboard',
    });
  });

  it('names everything of a kind, help and status, and warns only where a window may come up', () => {
    expect(describeArgv(['list-windows']).target).toEqual({ resolved: true, all: 'windows' });
    expect(describeArgv(['list-apps']).target).toEqual({ resolved: true, all: 'apps' });
    expect(describeArgv(['list-windows', '--app', 'charmap']).target).toEqual({
      resolved: true,
      app: 'charmap',
    });
    expect(describeArgv(['click', '--help'])).toMatchObject({
      title: '使い方を読みます',
      mode: 'read',
    });
    expect(describeArgv(['status'])).toMatchObject({ title: '状態を確かめます', mode: 'read' });
    expect(describeArgv(['skills', 'get', 'desktop'])).toMatchObject({ title: '説明書を読みます' });
    expect(describeArgv(['snapshot', '--app', 'charmap']).notes).toEqual([]);
    // Minimizing brings another window forward, which is why it always asks.
    expect(describeArgv(['minimize', '--app', 'charmap']).notes).toEqual([
      '窓を最小化します。最小化すると、次の窓が手前に来ます。',
    ]);
    expect(
      describeArgv([
        'batch',
        JSON.stringify([
          { command: 'expand', args: { ref_id: '@s1abc:e3' } },
          { command: 'minimize', args: { window_id: 'w-62263518' } },
        ]),
      ]).notes,
    ).toEqual([
      '窓を最小化します。最小化すると、次の窓が手前に来ます。',
      '対象の窓を前面に出さずに操作します。操作の結果、アプリが自分で窓を手前に出すことがあります。',
    ]);
    expect(describeArgv(['launch', 'charmap']).notes).toEqual([
      '起動した窓は、今使っている窓の後ろに置きます。一瞬だけ手前に見えることがあります。',
    ]);
    expect(
      describeArgv([
        'batch',
        JSON.stringify([{ command: 'expand', args: { ref_id: '@s1abc:e3' } }]),
      ]).notes,
    ).toEqual([
      '対象の窓を前面に出さずに操作します。操作の結果、アプリが自分で窓を手前に出すことがあります。',
    ]);
    // A foreground run already says the window comes to the front.
    expect(describeArgv(['--headed', 'click', '@s1abc:e1']).notes).toEqual([
      '窓が前面に出て、マウスとキーボードを使います。入力中は触らないでください。',
    ]);
    // Without reading snapshots, for a timeline row.
    expect(
      desktopControlApprovalAction(['click', '@s1abc:e1'], { stateRoot, names: false }).target,
    ).toMatchObject({ resolved: false });
  });

  it('says a foreground run uses the mouse and keyboard and offers no Task grant', () => {
    const action = describeArgv(['--headed', 'type', '@snotepad:e1', 'こんにちは']);
    expect(action).toMatchObject({
      title: 'キーで入力します',
      mode: 'foreground',
      allowTaskGrant: false,
      text: 'こんにちは',
      target: {
        app: 'Notepad.exe',
        window: '無題 - メモ帳',
        role: '文書',
        name: 'テキスト エディター',
      },
    });
    expect(action.notes[0]).toBe(
      '窓が前面に出て、マウスとキーボードを使います。入力中は触らないでください。',
    );
  });

  it('lists the steps of a batch with the strongest mode on top', () => {
    const action = describeArgv([
      'batch',
      JSON.stringify([
        { command: 'expand', args: { ref_id: '@s1abc:e3' } },
        { command: 'snapshot', args: { window_id: 'w-62263518' } },
        { command: 'set-value', args: { ref_id: '@s1abc:e1', value: 'xyz' } },
      ]),
    ]);
    expect(action).toMatchObject({
      title: '3 個の操作をまとめて行います',
      mode: 'background',
      allowTaskGrant: true,
    });
    expect(action.steps).toEqual([
      expect.objectContaining({ title: 'メニューを開きます', mode: 'background' }),
      expect.objectContaining({
        title: '画面を読みます',
        mode: 'read',
        target: expect.objectContaining({ window: '文字コード表', role: '窓' }),
      }),
      expect.objectContaining({ title: '文字を入力します', text: 'xyz' }),
    ]);

    const long = describeArgv([
      'batch',
      JSON.stringify(Array.from({ length: 25 }, () => ({ command: 'wait', args: { ms: 10 } }))),
    ]);
    expect(long.steps).toHaveLength(20);
    expect(long.stepsOmitted).toBe(5);
    expect(long.openDetails).toBe(true);
  });

  it('says what it could not confirm and opens the details', () => {
    for (const ref of [
      '@smissing:e1', // no such snapshot
      '@s1abc:e99', // no such element
      '@sbroken:e1', // not JSON
      '@shuge:e1', // over the size bound
      '@swrong:e1', // not a refmap
      '@../../x:e1', // not a snapshot id
      '@e1', // not qualified
    ]) {
      const action = describeArgv(['click', ref]);
      expect(action.target).toEqual({ resolved: false, reference: ref });
      expect(action.openDetails).toBe(true);
    }
    expect(describeArgv(['focus-window', '--window-id', 'w-404']).target).toEqual({
      resolved: false,
      reference: 'w-404',
    });
    // A session keeps its snapshots elsewhere.
    expect(describeArgv(['--session', 'abc', 'click', '@s1abc:e1']).target).toMatchObject({
      resolved: false,
    });
    // Arguments that are refused are described as an unknown operation on the stronger side.
    expect(describeArgv(['--trace', 'x', 'click', '@s1abc:e1'])).toMatchObject({
      title: 'デスクトップを操作します',
      mode: 'foreground',
      allowTaskGrant: false,
      openDetails: true,
    });
  });

  it('shows where a drag drops, and opens the details when the drop is not a named part', () => {
    const drag = describeArgv(['drag', '--from', '@s1abc:e1', '--to', '@s1abc:e3']);
    expect(drag).toMatchObject({
      title: 'ドラッグします',
      target: { resolved: true, name: 'コピーする文字(A):' },
      destination: { resolved: true, role: 'メニューボタン', name: 'ファイル' },
      openDetails: false,
    });
    // A drop that cannot be read, one on coordinates, and one on a part with no name.
    for (const to of [
      ['--to', '@s1abc:e99'],
      ['--to-xy', '10,10'],
      ['--to', '@s1abc:e6'],
    ])
      expect(describeArgv(['drag', '--from', '@s1abc:e1', ...to]).openDetails).toBe(true);
    expect(describeArgv(['drag', '--from', '@s1abc:e1', '--to', '@s1abc:e99']).destination).toEqual(
      { resolved: false, reference: '@s1abc:e99' },
    );
    // A drag in a batch, whose drop is not read, is never shown as explained.
    expect(
      describeArgv(['batch', JSON.stringify([{ command: 'drag', args: { ref_id: '@s1abc:e1' } }])])
        .openDetails,
    ).toBe(true);
  });

  it('opens the details whenever a point is also given as coordinates, beside a named part', () => {
    for (const argv of [
      ['drag', '--from', '@s1abc:e1', '--to', '@s1abc:e3', '--to-xy', '2,2'],
      ['drag', '--from', '@s1abc:e1', '--from-xy=1,1', '--to', '@s1abc:e3'],
      ['hover', '@s1abc:e3', '--xy', '1,1'],
      ['batch', JSON.stringify([{ command: 'hover', args: { ref_id: '@s1abc:e3', xy: '1,1' } }])],
    ])
      expect(describeArgv(argv).openDetails).toBe(true);
    // The part alone stays closed.
    expect(describeArgv(['hover', '@s1abc:e3']).openDetails).toBe(false);
    expect(
      describeArgv(['batch', JSON.stringify([{ command: 'hover', args: { ref_id: '@s1abc:e3' } }])])
        .openDetails,
    ).toBe(false);
  });

  it('opens the details of any operation whose target it cannot name', () => {
    for (const argv of [
      ['mouse-click', '--xy', '10,10'],
      ['mouse-move', '--xy', '10,10'],
      ['mouse-down', '--xy', '10,10'],
      ['mouse-up', '--xy', '10,10'],
      ['mouse-wheel', '--x', '10', '--y', '10', '--dy', '3'],
      ['hover', '--xy', '10,10'],
      ['drag', '--from-xy', '1,1', '--to-xy', '2,2'],
      ['scroll', '--direction', 'down'],
      ['press', 'ctrl+c'],
      ['key-down', 'shift'],
    ]) {
      const action = describeArgv(argv);
      expect(action.target).toBeUndefined();
      expect(action.openDetails).toBe(true);
    }
    // One such entry opens a batch's details too.
    expect(
      describeArgv([
        'batch',
        JSON.stringify([
          { command: 'expand', args: { ref_id: '@s1abc:e3' } },
          { command: 'mouse-click', args: { xy: '10,10' } },
        ]),
      ]).openDetails,
    ).toBe(true);
    // Reads, and operations that act on no app or part, stay closed.
    for (const argv of [
      ['snapshot'],
      ['wait', '200'],
      ['clipboard-set', 'hello'],
      ['clipboard-clear'],
      ['press', 'ctrl+c', '--app', 'charmap'],
    ])
      expect(describeArgv(argv).openDetails).toBe(false);
    expect(describeArgv(['dismiss-all-notifications'])).toMatchObject({
      target: { resolved: true, all: 'notifications' },
      openDetails: false,
    });
  });

  it('says a part has no name and opens the details', () => {
    for (const ref of ['@s1abc:e6', '@s1abc:e7']) {
      const action = describeArgv(['click', ref]);
      expect(action.target).toEqual({
        resolved: true,
        app: 'charmap.exe',
        window: '文字コード表',
        role: 'ボタン',
        windowId: 'w-62263518',
      });
      expect(action.openDetails).toBe(true);
    }
    // A window with no title, found by its id.
    const untitled = describeArgv(['minimize', '--window-id', 'w-777']);
    expect(untitled.target).toEqual({
      resolved: true,
      app: 'untitled.exe',
      role: '窓',
      windowId: 'w-777',
    });
    expect(untitled.openDetails).toBe(true);
  });

  it('says where a part sits when its window has others of the same name', () => {
    expect(describeArgv(['click', '@smail:e4']).target).toEqual({
      resolved: true,
      app: 'RabbitMail.exe',
      window: 'RabbitMail',
      role: 'ボタン',
      name: '閉じる',
      within: { role: 'ダイアログ', name: '終了の確認' },
      windowId: 'w-4242',
    });
    expect(describeArgv(['click', '@smail:e6']).target?.within).toEqual({
      role: 'まとまり',
      name: '本文',
    });
    // On the title bar, held by no named part the snapshot records: shown as before.
    expect(describeArgv(['click', '@smail:e1']).target?.within).toBeUndefined();
    // The only part of its name, and twins in different trees, are shown as before.
    expect(describeArgv(['click', '@smail:e7']).target?.within).toBeUndefined();
    expect(describeArgv(['click', '@smail:e8']).target?.within).toBeUndefined();
    expect(describeArgv(['click', '@s1abc:e1']).target?.within).toBeUndefined();
  });

  it('names a window an earlier run of the same Task reported, from its output', () => {
    const task = 'task-windows';
    const argv = ['snapshot', '--window-id', 'w-9001'];
    expect(describeArgv(argv).target).toEqual({ resolved: false, reference: 'w-9001' });
    rememberDesktopControlWindows(
      task,
      ['launch', 'RabbitMail'],
      JSON.stringify({
        version: '2.6',
        ok: true,
        command: 'launch',
        data: {
          app: 'RabbitMail',
          pid: 1,
          window: { id: 'w-9001', title: 'RabbitMail', app_name: 'RabbitMail.exe' },
        },
      }),
    );
    rememberDesktopControlWindows(
      task,
      ['list-windows'],
      JSON.stringify({
        ok: true,
        command: 'list-windows',
        data: [{ id: 'w-9002', title: '無題 - メモ帳', app_name: 'Notepad.exe' }],
      }),
    );
    const look = (args: readonly string[], taskId?: string) =>
      desktopControlApprovalAction(args, {
        stateRoot,
        ...(taskId === undefined ? {} : { taskId }),
      });
    expect(look(argv, task)).toMatchObject({
      target: {
        resolved: true,
        app: 'RabbitMail.exe',
        window: 'RabbitMail',
        role: '窓',
        windowId: 'w-9001',
      },
      openDetails: false,
    });
    expect(look(['focus-window', '--window-id', 'w-9002'], task).target).toMatchObject({
      resolved: true,
      window: '無題 - メモ帳',
    });
    // Another Task, a timeline row, and a card with no Task do not use it.
    expect(look(argv, 'task-other').target).toMatchObject({ resolved: false });
    expect(look(argv).target).toMatchObject({ resolved: false });
    expect(
      desktopControlApprovalAction(argv, { stateRoot, taskId: task, names: false }).target,
    ).toMatchObject({ resolved: false });

    // Output that is not what the run's own command prints is ignored.
    const window = { id: 'w-9003', title: '偽物', app_name: 'x.exe' };
    for (const [runArgv, output] of [
      [['list-windows'], { ok: false, command: 'list-windows', data: [window] }],
      [['list-windows'], { ok: true, command: 'launch', data: { window } }],
      [['snapshot'], { ok: true, command: 'snapshot', data: [window] }],
      [['list-windows'], { ok: true, command: 'list-windows', data: [{ ...window, id: '../x' }] }],
    ] as const)
      rememberDesktopControlWindows(task, runArgv, JSON.stringify(output));
    rememberDesktopControlWindows(task, ['list-windows'], 'not json');
    expect(look(['focus-window', '--window-id', 'w-9003'], task).target).toMatchObject({
      resolved: false,
    });
  });

  it('says a window comes to the front only where it does', () => {
    expect(describeArgv(['launch', 'charmap', '--activate']).notes).toEqual([
      '起動した窓が前面に出ます。',
    ]);
    expect(describeArgv(['focus-window', '--window-id', 'w-5903576']).notes).toEqual([
      '対象の窓が前面に出ます。',
    ]);
    expect(describeArgv(['--headed', 'focus-window', '--window-id', 'w-5903576']).notes).toEqual([
      '窓が前面に出て、マウスとキーボードを使います。入力中は触らないでください。',
    ]);
    expect(describeArgv(['press', 'return', '--app', 'charmap']).notes).toEqual([
      '窓が前面に出て、マウスとキーボードを使います。入力中は触らないでください。',
    ]);
  });

  it('cuts long names and shows invisible characters as code points', () => {
    const long = describeArgv(['click', '@s1abc:e5']);
    expect(long.target?.name).toHaveLength(120);
    expect(long.target?.name?.endsWith('…')).toBe(true);
    expect(long.target?.window).toHaveLength(120);

    const hidden = describeArgv(['click', '@s1abc:e4']);
    expect(hidden.target).toMatchObject({ role: '部品', name: '\\u{200b}隠し\\u{202e}テキスト' });

    const zeroWidth = String.fromCodePoint(0x200b);
    const text = describeArgv(['set-value', '@s1abc:e1', `a${zeroWidth}b${'x'.repeat(2_000)}`]);
    expect(text.text?.startsWith('a\\u{200b}b')).toBe(true);
    expect(text.text).toHaveLength(1_000);
    expect(text.openDetails).toBe(true);
    expect(text.notes.join('')).toContain('途中までを表示しています');
  });
});
