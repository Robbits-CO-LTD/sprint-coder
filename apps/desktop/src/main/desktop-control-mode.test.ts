import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  configureDesktopControlStateRoot,
  desktopControlArgvMode,
  desktopControlCommandsWithoutMode,
  desktopControlEnvironment,
  desktopControlStateRoot,
} from './desktop-control';

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

  it('points every run outside the sandbox at Sprint Coder’s own state folder once set', () => {
    const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
    // Not set: the environment is only filtered, as before.
    expect(desktopControlEnvironment({ A: '1' }, [], lookup)).toEqual({ A: '1' });
    const parent = mkdtempSync(join(tmpdir(), 'sc-dc-state-'));
    onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
    const root = join(parent, 'desktop-control');
    configureDesktopControlStateRoot(root);
    expect(desktopControlStateRoot()).toBe(root);
    // The folder exists before the first run.
    expect(existsSync(root)).toBe(true);
    // The agent's own value, in any letter case, never wins.
    expect(
      desktopControlEnvironment({ A: '1', agent_desktop_home: 'C:\\elsewhere' }, [], lookup),
    ).toEqual({ A: '1', AGENT_DESKTOP_HOME: root });
    // A relative folder is not taken.
    configureDesktopControlStateRoot('relative');
    expect(desktopControlStateRoot()).toBeNull();
  });
});
