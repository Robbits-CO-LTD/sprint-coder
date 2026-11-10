import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  configureDesktopControlStateRoot,
  desktopControlArgvMode,
  desktopControlCommandsWithoutMode,
  desktopControlEnvironment,
  desktopControlStateFolder,
  desktopControlStateRoot,
} from './desktop-control';
import { desktopControlApprovalAction } from './desktop-control-display';

const batch = (entries: unknown) => ['batch', JSON.stringify(entries)];

describe('desktop-control mode', () => {
  it('classifies every command the arguments check knows', () => {
    expect(desktopControlCommandsWithoutMode()).toEqual([]);
  });

  it('keeps inert runs inert and reads the screen as read', () => {
    for (const argv of [
      ['skills', 'get', 'desktop'],
      ['status'],
      ['--version'],
      ['click', '--help'],
    ])
      expect(desktopControlArgvMode(argv)).toBe('inert');
    for (const argv of [
      ['snapshot', '--app', 'charmap'],
      ['find', '--role', 'button', '--count'],
      ['get', '@s1:e1', '--property', 'value'],
      ['list-windows'],
      ['list-apps'],
      ['wait', '200'],
      ['screenshot', '--app', 'charmap'],
      ['-w', 'button:OK', 'snapshot'],
    ])
      expect(desktopControlArgvMode(argv)).toBe('read');
  });

  it('runs semantic operations in the background', () => {
    for (const argv of [
      ['click', '@s1:e1'],
      ['set-value', '@s1:e1', 'ABC'],
      ['clear', '@s1:e1'],
      ['select', '@s1:e2', 'Arial'],
      ['check', '@s1:e3'],
      ['expand', '@s1:e4'],
      ['scroll', '@s1:e5', '--direction', 'down'],
      ['launch', 'charmap'],
      ['launch', 'charmap', '--no-attach'],
      ['minimize', '--app', 'charmap'],
      ['move-window', '--app', 'charmap', '--x', '0', '--y', '0'],
      ['clipboard-set', 'ABC'],
      ['clipboard-clear'],
    ])
      expect(desktopControlArgvMode(argv)).toBe('background');
  });

  it('marks anything that takes the foreground, the cursor or the keyboard as foreground', () => {
    for (const argv of [
      ['focus-window', '--window-id', 'w-1'],
      ['restore', '--app', 'charmap'],
      ['maximize', '--app', 'charmap'],
      ['launch', 'charmap', '--activate'],
      ['press', 'return'],
      ['type', '@s1:e1', 'abc'],
      ['focus', '@s1:e1'],
      ['right-click', '@s1:e1'],
      ['double-click', '@s1:e1'],
      ['triple-click', '@s1:e1'],
      ['hover', '@s1:e1'],
      ['drag', '--from', '@s1:e1', '--to', '@s1:e2'],
      ['mouse-click', '--xy', '1,1'],
      ['mouse-move', '--xy', '1,1'],
      ['key-down', 'shift'],
      ['close-app', 'charmap'],
    ])
      expect(desktopControlArgvMode(argv)).toBe('foreground');
  });

  it('makes every --headed run foreground, even one that would only read', () => {
    for (const argv of [
      ['--headed', 'click', '@s1:e1'],
      ['--headed', 'snapshot'],
      ['--headed', 'status'],
      ['click', '--headed', '@s1:e1'],
      [...['--headed'], ...batch([{ command: 'snapshot' }])],
    ])
      expect(desktopControlArgvMode(argv)).toBe('foreground');
  });

  it('gives a batch the strongest mode of its entries', () => {
    expect(desktopControlArgvMode(batch([{ command: 'snapshot' }, { command: 'wait' }]))).toBe(
      'read',
    );
    expect(
      desktopControlArgvMode(
        batch([{ command: 'expand', args: { ref_id: '@s1:e1' } }, { command: 'snapshot' }]),
      ),
    ).toBe('background');
    expect(
      desktopControlArgvMode(
        batch([
          { command: 'click', args: { ref_id: '@s1:e1' } },
          { command: 'press', args: { combo: 'return' } },
        ]),
      ),
    ).toBe('foreground');
    expect(
      desktopControlArgvMode(
        batch([{ command: 'launch', args: { app: 'charmap', activate: true } }]),
      ),
    ).toBe('foreground');
    expect(desktopControlArgvMode(batch([{ command: 'launch', args: { app: 'charmap' } }]))).toBe(
      'background',
    );
  });

  it('takes the stronger side for whatever it cannot read', () => {
    for (const argv of [
      ['batch', 'not json'],
      ['batch', '[]'],
      batch([{ command: 'made-up' }]),
      batch([{ command: 'toString' }]),
      ['made-up'],
      ['click', '--made-up'],
      ['constructor'],
    ])
      expect(desktopControlArgvMode(argv)).toBe('foreground');
  });
});

describe('desktop-control state folder', () => {
  afterEach(() => configureDesktopControlStateRoot(null));
  const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
  const temporaryRoot = () => {
    const parent = mkdtempSync(join(tmpdir(), 'sc-dc-state-'));
    onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
    return join(parent, 'desktop-control');
  };

  it.runIf(process.platform === 'win32')(
    'makes the folder private and points every run, and the card, at it',
    () => {
      // Not set: the environment is only filtered, as before.
      expect(desktopControlEnvironment({ A: '1' }, [], lookup)).toEqual({ A: '1' });
      const root = temporaryRoot();
      const makePrivate = vi.fn();
      configureDesktopControlStateRoot(root, makePrivate);
      // Made private after it exists, on every start.
      expect(makePrivate).toHaveBeenCalledWith(root);
      expect(existsSync(root)).toBe(true);
      expect(desktopControlStateRoot()).toBe(root);
      expect(desktopControlStateFolder()).toBe(root);
      // The agent's own value, in any letter case, never wins.
      expect(
        desktopControlEnvironment({ A: '1', agent_desktop_home: 'C:\\elsewhere' }, [], lookup),
      ).toEqual({ A: '1', AGENT_DESKTOP_HOME: root });
      // The card reads the same folder the run writes.
      mkdirSync(join(root, 'snapshots', 'sabc'), { recursive: true });
      writeFileSync(
        join(root, 'snapshots', 'sabc', 'refmap.json'),
        JSON.stringify({
          inner: {
            '@e1': {
              role: 'button',
              name: 'OK',
              source_app: 'app.exe',
              source_window_id: 'w-1',
              source_window_title: 'App',
            },
          },
        }),
      );
      expect(desktopControlApprovalAction(['click', '@sabc:e1']).target).toMatchObject({
        resolved: true,
        name: 'OK',
      });
      configureDesktopControlStateRoot(root, makePrivate);
      expect(makePrivate).toHaveBeenCalledTimes(2);
      // A relative folder is not taken.
      configureDesktopControlStateRoot('relative', makePrivate);
      expect(desktopControlStateRoot()).toBeNull();
    },
  );

  it('keeps the binary’s own folder, for the run and the card, when the folder cannot be private', () => {
    const root = temporaryRoot();
    configureDesktopControlStateRoot(root, () => {
      throw new Error('ACL refused');
    });
    expect(desktopControlStateRoot()).toBeNull();
    expect(desktopControlStateFolder()).not.toBe(root);
    expect(desktopControlEnvironment({ A: '1' }, [], lookup)).toEqual({ A: '1' });
  });

  it.runIf(process.platform === 'win32')(
    'leaves only the user on a folder that inherited a loose ACL, and repairs it again later',
    () => {
      const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
      const root = temporaryRoot();
      mkdirSync(root, { recursive: true });
      // What a folder under a drive root inherits.
      execFileSync(icacls, [root, '/grant', '*S-1-5-11:(OI)(CI)M', '*S-1-5-32-545:(OI)(CI)RX']);
      for (let start = 0; start < 2; start += 1) {
        configureDesktopControlStateRoot(root);
        expect(desktopControlStateRoot()).toBe(root);
        const acl = execFileSync(icacls, [root], { encoding: 'utf8' });
        expect(acl).not.toMatch(/Authenticated Users|BUILTIN\\Users|\(I\)/u);
        expect(acl).toContain(userInfo().username);
      }
    },
  );
});
