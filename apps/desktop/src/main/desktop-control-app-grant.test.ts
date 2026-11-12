import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  desktopAppGrantCovering,
  desktopAppGrantOffer,
  type DesktopAppGrantKey,
} from './desktop-control-app-grant';
import {
  desktopControlOwnerReader,
  rememberDesktopControlWindows,
} from './desktop-control-display';

let stateRoot: string;
const stools = 'stools';

function writeRefmap(root: string, snapshot: string, inner: unknown): void {
  const folder = join(root, 'snapshots', snapshot);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'refmap.json'), JSON.stringify({ inner, counter: 3 }));
}

// As the desktop-control executable records parts (checked against the refmaps of real runs).
const part = (
  app: string,
  pid: number,
  window: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  pid,
  process_instance: `windows-proc-v1:1343887${pid}:42`,
  role: 'button',
  name: '選択(S)',
  source_app: app,
  source_window_id: window,
  source_window_title: app,
  path: [3],
  ...extra,
});

beforeAll(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'sc-dc-app-grant-'));
  writeRefmap(stateRoot, 'scharmap', {
    '@e1': part('charmap.exe', 100, 'w-1'),
    '@e2': part('charmap.exe', 100, 'w-1', { role: 'textfield', name: 'コピーする文字(A):' }),
  });
  writeRefmap(stateRoot, 'snotepad', { '@e1': part('Notepad.exe', 200, 'w-2') });
  // Items of charmap's standard menu bar, as `snapshot --surface menubar` records them; the second
  // has a record the card cannot read.
  writeRefmap(stateRoot, 'scharmenu', {
    '@e1': part('charmap.exe', 100, 'w-1', {
      role: 'menuitem',
      name: '終了(X)',
      source_surface: 'menubar',
      proven_in_menu: {
        steps: [
          { name: 'ファイル(F)', position: 0, submenu: true },
          { name: '終了(X)', position: 3, submenu: false },
        ],
        command_id: 1009,
      },
    }),
    '@e2': part('charmap.exe', 100, 'w-1', { role: 'menuitem', proven_in_menu: 'broken' }),
  });
  // A packaged app: the executable names the hosted app's own process, not the frame host.
  writeRefmap(stateRoot, 'scalc', { '@e1': part('CalculatorApp.exe', 300, 'w-3') });
  writeRefmap(stateRoot, 'sphotos', { '@e1': part('Photos.exe', 301, 'w-5') });
  // A frame the executable could not tell the hosted app of, which then reads as the frame host.
  writeRefmap(stateRoot, 'sframe', {
    '@e1': part('ApplicationFrameHost.exe', 400, 'w-4'),
    // A window whose records disagree on its process.
    '@e2': part('Photos.exe', 301, 'w-6'),
    '@e3': part('ApplicationFrameHost.exe', 400, 'w-6'),
  });
  writeRefmap(stateRoot, stools, {
    '@e1': part('WindowsTerminal.exe', 500, 'w-7'),
    '@e2': part('explorer.exe', 501, 'w-8'),
    '@e3': part('Sprint Coder.exe', 502, 'w-9'),
    // No process instance recorded.
    '@e4': { ...part('mspaint.exe', 503, 'w-10'), process_instance: undefined },
  });
});

afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

const lookup = () => ({ stateRoot, taskId: 'task-grant', ownExecutable: 'Sprint Coder.exe' });
const offer = (argv: string[]) => desktopAppGrantOffer(argv, lookup());
const covers = (argv: string[], granted: DesktopAppGrantKey[]) =>
  desktopAppGrantCovering(argv, granted, lookup()) !== null;
const batch = (...entries: unknown[]) => ['batch', JSON.stringify(entries)];

describe('desktop-control app-wide Task grant', () => {
  it('stops naming a window the executable found reused, even for a reader made before', () => {
    const reader = desktopControlOwnerReader({ stateRoot, taskId: 'task-reused' });
    expect(reader.window('w-1')).toMatchObject({ pid: 100, app: 'charmap.exe' });
    rememberDesktopControlWindows(
      'task-reused',
      ['batch', '[]'],
      JSON.stringify({
        ok: true,
        command: 'batch',
        data: {
          results: [
            {
              ok: false,
              error: {
                code: 'POLICY_DENIED',
                details: { kind: 'window_owner_mismatch', window_id: 'w-1', found: 1 },
              },
            },
          ],
        },
      }),
    );
    expect(reader.window('w-1')).toBeNull();
    expect(
      desktopControlOwnerReader({ stateRoot, taskId: 'task-reused' }).window('w-1'),
    ).toBeNull();
    // Other Tasks, and the window's parts (checked by the executable itself), are unaffected.
    expect(
      desktopControlOwnerReader({ stateRoot, taskId: 'task-other' }).window('w-1'),
    ).not.toBeNull();
    expect(reader.part('@scharmap:e1')).toMatchObject({ pid: 100 });
  });

  it('names the app by the process the executable recorded, never by the argv', () => {
    const charmap = offer(['click', '@scharmap:e1']);
    expect(charmap).toMatchObject({
      pid: 100,
      instance: 'windows-proc-v1:1343887100:42',
      app: 'charmap.exe',
      label: 'charmap.exe',
    });
    // Every read and background operation on a part of that app gives the same app.
    for (const argv of [
      ['set-value', '@scharmap:e2', 'ABC'],
      ['select', '@scharmap:e2', 'Arial'],
      ['get', '@scharmap:e2', '--property', 'value'],
      ['scroll', '@scharmap:e1', '--direction', 'down'],
      ['snapshot', '--window-id', 'w-1', '-i', '--compact'],
      ['find', '--root', '@scharmap:e1', '--role', 'button'],
      ['wait', '--element', '@scharmap:e1', '--predicate', 'actionable'],
      ['move-window', '--window-id', 'w-1', '--x', '10', '--y', '10'],
      ['resize-window', '--window-id', 'w-1', '--width', '400', '--height', '300'],
    ])
      expect(offer(argv)?.id, argv.join(' ')).toBe(charmap!.id);
  });

  it('covers the same app’s reads and background operations, and no other app', () => {
    const charmap = offer(['click', '@scharmap:e1'])!;
    expect(covers(['set-value', '@scharmap:e2', 'xyz'], [charmap])).toBe(true);
    expect(covers(['snapshot', '--window-id', 'w-1'], [charmap])).toBe(true);
    expect(
      covers(
        batch(
          { command: 'expand', args: { ref_id: '@scharmap:e1' } },
          { command: 'snapshot', args: { window_id: 'w-1' } },
        ),
        [charmap],
      ),
    ).toBe(true);
    // Another app, by its part or its window.
    expect(covers(['click', '@snotepad:e1'], [charmap])).toBe(false);
    expect(covers(['snapshot', '--window-id', 'w-2'], [charmap])).toBe(false);
    // The app's name given beside another app's part.
    expect(covers(['snapshot', '--window-id', 'w-2', '--app', 'charmap'], [charmap])).toBe(false);
    // No grant at all.
    expect(covers(['click', '@scharmap:e1'], [])).toBe(false);
  });

  it('never covers or offers running a standard menu item, alone or in a batch', () => {
    const charmap = offer(['click', '@scharmap:e1'])!;
    for (const argv of [
      ['click', '@scharmenu:e1'],
      ['click', '@scharmenu:e2'],
      ['click', '@scharmenu:e1', '--timeout-ms', '2000'],
      ['get', '@scharmenu:e1', '--property', 'name'],
      ['snapshot', '--root', '@scharmenu:e1'],
      batch({ command: 'click', args: { ref_id: '@scharmenu:e1' } }),
      batch(
        { command: 'snapshot', args: { window_id: 'w-1', surface: 'menubar' } },
        { command: 'click', args: { ref_id: '@scharmenu:e1' } },
      ),
    ]) {
      expect(covers(argv, [charmap]), argv.join(' ')).toBe(false);
      expect(offer(argv), argv.join(' ')).toBeNull();
    }
    // The app's other parts stay covered.
    expect(covers(['click', '@scharmap:e1'], [charmap])).toBe(true);
  });

  it('covers and offers reading the named window’s own menu bar, and no other surface', () => {
    const charmap = offer(['click', '@scharmap:e1'])!;
    for (const argv of [
      ['snapshot', '--surface', 'menubar', '--window-id', 'w-1'],
      ['snapshot', '--window-id', 'w-1', '--surface=menubar', '--max-depth', '3'],
      batch({ command: 'snapshot', args: { window_id: 'w-1', surface: 'menubar' } }),
    ]) {
      expect(offer(argv)?.id, argv.join(' ')).toBe(charmap.id);
      expect(covers(argv, [charmap]), argv.join(' ')).toBe(true);
    }
    // Another app's window is that app's, not the granted one's.
    expect(covers(['snapshot', '--surface', 'menubar', '--window-id', 'w-2'], [charmap])).toBe(
      false,
    );
    for (const argv of [
      // No window, or another surface.
      ['snapshot', '--surface', 'menubar'],
      ['snapshot', '--surface', 'menu', '--window-id', 'w-1'],
      ['snapshot', '--surface', 'taskbar', '--window-id', 'w-1'],
      ['snapshot', '--surface', 'menubar', '--surface', 'taskbar', '--window-id', 'w-1'],
      batch({ command: 'snapshot', args: { window_id: 'w-1', surface: 'menu' } }),
      batch({ command: 'snapshot', args: { window_id: 'w-1', surface: 1 } }),
    ]) {
      expect(covers(argv, [charmap]), argv.join(' ')).toBe(false);
      expect(offer(argv), argv.join(' ')).toBeNull();
    }
  });

  it('covers and offers a select without a value, where the ref is the option itself', () => {
    const charmap = offer(['click', '@scharmap:e1'])!;
    expect(offer(['select', '@scharmap:e2'])?.id).toBe(charmap.id);
    expect(offer(['select', '@scharmap:e2', '--timeout-ms', '2000'])?.id).toBe(charmap.id);
    expect(covers(['select', '@scharmap:e2'], [charmap])).toBe(true);
    expect(covers(batch({ command: 'select', args: { ref_id: '@scharmap:e2' } }), [charmap])).toBe(
      true,
    );
    // Another app's part, with or without a value.
    expect(covers(['select', '@snotepad:e1'], [charmap])).toBe(false);
    expect(covers(['select', '@snotepad:e1', 'Arial'], [charmap])).toBe(false);
    expect(covers(batch({ command: 'select', args: { ref_id: '@snotepad:e1' } }), [charmap])).toBe(
      false,
    );
    // Still no more than a ref and one value, and never without the ref.
    expect(offer(['select', '@scharmap:e2', 'Arial', 'extra'])).toBeNull();
    expect(offer(['select'])).toBeNull();
  });

  it('never covers or offers what uses the foreground, launches, closes or minimizes an app', () => {
    const charmap = offer(['click', '@scharmap:e1'])!;
    for (const argv of [
      // Minimizing hands the front, and the person's typing, to another window.
      ['minimize', '--window-id', 'w-1'],
      batch({ command: 'minimize', args: { window_id: 'w-1' } }),
      ['--headed', 'click', '@scharmap:e1'],
      ['click', '@scharmap:e1', '--headed'],
      ['type', '@scharmap:e2', 'ABC'],
      ['focus', '@scharmap:e2'],
      ['double-click', '@scharmap:e1'],
      ['right-click', '@scharmap:e1'],
      ['hover', '@scharmap:e1'],
      ['press', 'ctrl+c', '--window-id', 'w-1'],
      ['press', 'alt+f4', '--app', 'charmap'],
      ['focus-window', '--window-id', 'w-1'],
      ['restore', '--window-id', 'w-1'],
      ['maximize', '--window-id', 'w-1'],
      ['launch', 'charmap'],
      ['launch', 'charmap', '--activate'],
      ['close-app', 'charmap'],
      batch({ command: 'launch', args: { app: 'charmap' } }),
      batch({ command: 'close-app', args: { app: 'charmap' } }),
      batch({ command: 'type', args: { ref_id: '@scharmap:e2', text: 'x' } }),
    ]) {
      expect(covers(argv, [charmap]), argv.join(' ')).toBe(false);
      expect(offer(argv), argv.join(' ')).toBeNull();
    }
  });

  it('never covers or offers a run whose app cannot be told', () => {
    const charmap = offer(['click', '@scharmap:e1'])!;
    for (const argv of [
      // The whole desktop, the screen, the focused window, the shell, the clipboard, notifications.
      ['list-windows'],
      ['list-windows', '--app', 'charmap'],
      ['list-apps'],
      ['list-surfaces', '--app', 'charmap'],
      ['list-notifications'],
      ['screenshot', '--screen', '0'],
      ['snapshot'],
      ['snapshot', '--surface', 'desktop', '--window-id', 'w-1'],
      ['snapshot', '--surface', 'focused', '--window-id', 'w-1'],
      ['find', '--name', 'OK'],
      ['clipboard-set', 'x'],
      ['clipboard-clear'],
      ['dismiss-all-notifications', '--app', 'charmap'],
      ['wait', '1000'],
      ['wait', '--text', 'OK'],
      ['wait', '--event', 'window-opened', '--window-id', 'w-1'],
      ['wait', '--window', '文字コード表', '--app', 'charmap'],
      ['session', 'start'],
      // A ref the records do not hold, or not in the qualified form.
      ['click', '@sunknown:e1'],
      ['click', '@scharmap:e99'],
      ['click', '@e1'],
      ['snapshot', '--window-id', 'w-404'],
      // Another folder of refs, an option given twice or not known for the grant.
      ['click', '@scharmap:e1', '--session', 'abc'],
      ['snapshot', '--window-id', 'w-1', '--window-id', 'w-2'],
      ['snapshot', '--window-id', 'w-1', '--wait-for', 'button:OK'],
      ['set-value', '@scharmap:e2', '--', '-x'],
      // A batch step without a target, or with an argument not listed.
      batch({ command: 'snapshot', args: {} }),
      batch({ command: 'snapshot', args: { window_id: null } }),
      batch({ command: 'snapshot', args: { window_id: 'w-1', surface: 'desktop' } }),
      batch({ command: 'wait', args: { ms: 500 } }),
      batch({ command: 'click', args: { ref_id: '@scharmap:e1' }, session: 'abc' }),
      batch(),
    ]) {
      expect(covers(argv, [charmap]), argv.join(' ')).toBe(false);
      expect(offer(argv), argv.join(' ')).toBeNull();
    }
  });

  it('covers a batch only when every step is a read or background step on the granted app', () => {
    const charmap = offer(['click', '@scharmap:e1'])!;
    const notepad = offer(['click', '@snotepad:e1'])!;
    const mixed = batch(
      { command: 'click', args: { ref_id: '@scharmap:e1' } },
      { command: 'click', args: { ref_id: '@snotepad:e1' } },
    );
    expect(covers(mixed, [charmap])).toBe(false);
    // Even with both apps granted, a batch over two apps is decided on its card.
    expect(covers(mixed, [charmap, notepad])).toBe(false);
    expect(offer(mixed)).toBeNull();
    expect(
      covers(
        batch(
          { command: 'set-value', args: { ref_id: '@scharmap:e2', value: 'A' } },
          { command: 'press', args: { combo: 'return', window_id: 'w-1' } },
        ),
        [charmap],
      ),
    ).toBe(false);
  });

  it('never takes an app given by name, which the executable resolves to a window itself', () => {
    const charmap = offer(['click', '@scharmap:e1'])!;
    for (const argv of [
      ['snapshot', '--app', 'charmap'],
      ['snapshot', '--app', 'charmap.exe', '-i'],
      ['screenshot', '--app', 'charmap'],
      ['find', '--app', 'charmap', '--role', 'button'],
      ['wait', '--text', 'OK', '--app', 'charmap'],
      ['move-window', '--app', 'charmap', '--x', '0', '--y', '0'],
      ['resize-window', '--app', 'charmap', '--width', '1', '--height', '1'],
      // Not even beside the app's own window or part.
      ['snapshot', '--window-id', 'w-1', '--app', 'charmap'],
      ['wait', '--element', '@scharmap:e1', '--app', 'charmap'],
      batch({ command: 'snapshot', args: { app: 'charmap' } }),
      batch({ command: 'snapshot', args: { window_id: 'w-1', app: 'charmap' } }),
    ]) {
      expect(covers(argv, [charmap]), argv.join(' ')).toBe(false);
      expect(offer(argv), argv.join(' ')).toBeNull();
    }
  });

  it('keeps browsers, editors with a terminal, shell hosts and system settings out', () => {
    const root = mkdtempSync(join(tmpdir(), 'sc-dc-app-grant-names-'));
    try {
      const names = [
        'chrome.exe',
        'msedge.exe',
        'firefox.exe',
        'brave.exe',
        'opera.exe',
        'vivaldi.exe',
        'Arc.exe',
        'iexplore.exe',
        'Code.exe',
        'Code - Insiders.exe',
        'Cursor.exe',
        'devenv.exe',
        'idea64.exe',
        'ShellHost.exe',
        'PickerHost.exe',
        'Widgets.exe',
        'OpenWith.exe',
        'smartscreen.exe',
        'SystemPropertiesAdvanced.exe',
        'msconfig.exe',
        'SecHealthUI.exe',
      ];
      writeRefmap(
        root,
        'snames',
        Object.fromEntries(
          names.map((app, index) => [`@e${index}`, part(app, 700 + index, `w-7${index}`)]),
        ),
      );
      names.forEach((app, index) =>
        expect(
          desktopAppGrantOffer(['click', `@snames:e${index}`], { stateRoot: root }),
          app,
        ).toBeNull(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a shared frame host, the shell, terminals and Sprint Coder itself out', () => {
    for (const argv of [
      ['click', '@sframe:e1'],
      ['snapshot', '--window-id', 'w-4'],
      ['click', `@${stools}:e1`],
      ['click', `@${stools}:e2`],
      ['click', `@${stools}:e3`],
      ['click', `@${stools}:e4`],
    ])
      expect(offer(argv), argv.join(' ')).toBeNull();
    // Packaged apps each have their own process, so allowing one does not allow another.
    const calculator = offer(['click', '@scalc:e1'])!;
    expect(calculator.app).toBe('CalculatorApp.exe');
    expect(covers(['click', '@sphotos:e1'], [calculator])).toBe(false);
    // A window whose records name two processes is not any one app's window.
    expect(offer(['snapshot', '--window-id', 'w-6'])).toBeNull();
    const photos = offer(['click', '@sphotos:e1'])!;
    expect(covers(['snapshot', '--window-id', 'w-6'], [photos])).toBe(false);
  });

  it('names a window an earlier run of the same Task printed, with its process', () => {
    const root = mkdtempSync(join(tmpdir(), 'sc-dc-app-grant-known-'));
    try {
      rememberDesktopControlWindows(
        'task-known',
        ['launch', 'charmap'],
        JSON.stringify({
          ok: true,
          command: 'launch',
          data: {
            window: {
              id: 'w-500',
              app_name: 'charmap.exe',
              title: '文字コード表',
              pid: 600,
              process_instance: 'windows-proc-v1:9:1',
            },
          },
        }),
      );
      rememberDesktopControlWindows(
        'task-known',
        ['list-windows'],
        JSON.stringify({
          ok: true,
          command: 'list-windows',
          data: [{ id: 'w-501', app_name: 'parsecd.exe', title: 'x', pid: 601 }],
        }),
      );
      const known = desktopAppGrantOffer(['snapshot', '--window-id', 'w-500'], {
        stateRoot: root,
        taskId: 'task-known',
      });
      expect(known).toMatchObject({ pid: 600, app: 'charmap.exe' });
      // Another Task's runs name nothing here, and a window without a process instance no app.
      expect(
        desktopAppGrantOffer(['snapshot', '--window-id', 'w-500'], {
          stateRoot: root,
          taskId: 'task-other',
        }),
      ).toBeNull();
      expect(
        desktopAppGrantOffer(['snapshot', '--window-id', 'w-501'], {
          stateRoot: root,
          taskId: 'task-known',
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
