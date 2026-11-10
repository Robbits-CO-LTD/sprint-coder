import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desktopApprovalActionSchema } from '@sprint-coder/contracts';
import { desktopControlApprovalAction } from './desktop-control-display';

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
      notes: ['対象の窓が手前に出ることがあります。'],
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
    expect(describeArgv(['expand', '@s1abc:e3'])).toMatchObject({ title: 'メニューを開きます' });
    expect(describeArgv(['snapshot', '--app', 'charmap'])).toMatchObject({
      kind: 'read',
      title: '画面を読みます',
      mode: 'read',
      target: { resolved: true, app: 'charmap' },
    });
    expect(describeArgv(['launch', 'charmap'])).toMatchObject({
      kind: 'launch',
      title: 'アプリを起動します',
      mode: 'background',
      target: { resolved: true, app: 'charmap' },
      notes: ['新しい窓が手前に出ることがあります。'],
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
    expect(describeArgv(['minimize', '--app', 'charmap']).notes).toEqual([]);
    expect(describeArgv(['launch', 'charmap']).notes).toEqual([
      '新しい窓が手前に出ることがあります。',
    ]);
    expect(
      describeArgv([
        'batch',
        JSON.stringify([{ command: 'expand', args: { ref_id: '@s1abc:e3' } }]),
      ]).notes,
    ).toEqual(['対象の窓が手前に出ることがあります。']);
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
