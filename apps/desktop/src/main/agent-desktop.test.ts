import { describe, expect, it } from 'vitest';
import {
  agentDesktopArgvRefusal,
  isAgentDesktopBinary,
  resolveAgentDesktopCommand,
  runsOutsideCommandSandbox,
} from './agent-desktop';

const files = (...paths: string[]) => {
  const set = new Set(paths);
  return (path: string) => set.has(path);
};

const WIN_NATIVE = 'C:\\npm\\node_modules\\agent-desktop\\bin\\agent-desktop-win32-x64.exe';
const windows = {
  env: { Path: 'C:\\npm' },
  platform: 'win32' as const,
  arch: 'x64',
  isFile: files('C:\\npm\\agent-desktop.cmd', WIN_NATIVE),
  realpath: (path: string) => path,
};

describe('agent-desktop lookup', () => {
  it('uses an explicit absolute path when it names an existing native binary', () => {
    expect(
      resolveAgentDesktopCommand({
        env: { SPRINT_CODER_AGENT_DESKTOP: 'C:\\tools\\agent-desktop.exe' },
        platform: 'win32',
        isFile: files('C:\\tools\\agent-desktop.exe'),
      }),
    ).toBe('C:\\tools\\agent-desktop.exe');
  });

  it('does not fall back to PATH when the explicit path is relative, missing or not agent-desktop', () => {
    const onPath = files('C:\\npm\\agent-desktop.cmd', WIN_NATIVE, 'C:\\node\\node.exe');
    const env = { Path: 'C:\\npm' };
    for (const explicit of [
      'agent-desktop.exe',
      'C:\\missing\\agent-desktop.exe',
      'C:\\node\\node.exe',
    ])
      expect(
        resolveAgentDesktopCommand({
          env: { ...env, SPRINT_CODER_AGENT_DESKTOP: explicit },
          platform: 'win32',
          arch: 'x64',
          isFile: onPath,
        }),
      ).toBeNull();
  });

  it('maps the Windows npm shim to the native binary in the package', () => {
    expect(resolveAgentDesktopCommand(windows)).toBe(WIN_NATIVE);
    const local = 'C:\\app\\node_modules\\agent-desktop\\bin\\agent-desktop-win32-arm64.exe';
    expect(
      resolveAgentDesktopCommand({
        env: { SPRINT_CODER_AGENT_DESKTOP: 'C:\\app\\node_modules\\.bin\\agent-desktop.cmd' },
        platform: 'win32',
        arch: 'arm64',
        isFile: files('C:\\app\\node_modules\\.bin\\agent-desktop.cmd', local),
      }),
    ).toBe(local);
  });

  it('skips a Windows shim without its native binary and keeps searching the Path in order', () => {
    expect(
      resolveAgentDesktopCommand({
        env: { Path: '.;"C:\\Program Files\\nodejs";C:\\npm;C:\\later' },
        platform: 'win32',
        arch: 'x64',
        isFile: files('C:\\npm\\agent-desktop.cmd', 'C:\\later\\agent-desktop.exe'),
      }),
    ).toBe('C:\\later\\agent-desktop.exe');
  });

  it('follows the POSIX launcher link to the native binary next to it', () => {
    const launcher = '/opt/homebrew/lib/node_modules/agent-desktop/bin/agent-desktop';
    const native = '/opt/homebrew/lib/node_modules/agent-desktop/bin/agent-desktop-darwin-arm64';
    const lookup = {
      env: { PATH: 'relative:/usr/bin:/opt/homebrew/bin' },
      platform: 'darwin' as const,
      arch: 'arm64',
      realpath: (path: string) => (path === '/opt/homebrew/bin/agent-desktop' ? launcher : path),
    };
    expect(
      resolveAgentDesktopCommand({
        ...lookup,
        isFile: files('/opt/homebrew/bin/agent-desktop', launcher, native),
      }),
    ).toBe(native);
    // A release archive that put the binary itself on PATH resolves to that binary.
    expect(
      resolveAgentDesktopCommand({
        ...lookup,
        isFile: files('/opt/homebrew/bin/agent-desktop', launcher),
      }),
    ).toBe(launcher);
  });

  it('returns null when nothing is installed', () => {
    expect(
      resolveAgentDesktopCommand({ env: { PATH: '/usr/bin' }, platform: 'linux', isFile: files() }),
    ).toBeNull();
    expect(resolveAgentDesktopCommand({ env: {}, platform: 'linux', isFile: files() })).toBeNull();
    expect(
      resolveAgentDesktopCommand({ ...windows, isFile: files('C:\\npm\\agent-desktop.cmd') }),
    ).toBeNull();
  });
});

describe('agent-desktop outside the command sandbox', () => {
  it('lets only the resolved native binary out, matched by canonical path', () => {
    expect(runsOutsideCommandSandbox(WIN_NATIVE, ['C:\\work\\repo'], windows)).toBe(true);
    expect(runsOutsideCommandSandbox(WIN_NATIVE.toUpperCase(), ['C:\\work\\repo'], windows)).toBe(
      true,
    );
    expect(
      runsOutsideCommandSandbox('C:\\link\\ad.exe', ['C:\\work\\repo'], {
        ...windows,
        realpath: (path) => (path === 'C:\\link\\ad.exe' ? WIN_NATIVE : path),
      }),
    ).toBe(true);
  });

  it('keeps every other executable inside', () => {
    for (const executable of [
      'C:\\npm\\agent-desktop.cmd',
      'C:\\other\\agent-desktop-win32-x64.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\nodejs\\node.exe',
    ])
      expect(runsOutsideCommandSandbox(executable, ['C:\\work\\repo'], windows)).toBe(false);
    expect(runsOutsideCommandSandbox(WIN_NATIVE, [], { ...windows, isFile: files() })).toBe(false);
  });

  it('keeps the binary inside when it lives in any Workspace root of the Turn', () => {
    for (const root of ['C:\\npm', 'c:\\NPM\\node_modules', 'C:\\'])
      expect(runsOutsideCommandSandbox(WIN_NATIVE, ['C:\\work\\repo', root], windows)).toBe(false);
    expect(
      runsOutsideCommandSandbox(WIN_NATIVE, ['C:\\np', 'C:\\npm-other', 'D:\\npm'], windows),
    ).toBe(true);
    const native = '/usr/lib/node_modules/agent-desktop/bin/agent-desktop-linux-x64';
    const linux = {
      env: { PATH: '/usr/bin' },
      platform: 'linux' as const,
      arch: 'x64',
      isFile: files('/usr/bin/agent-desktop', native),
      realpath: (path: string) =>
        path === '/usr/bin/agent-desktop'
          ? '/usr/lib/node_modules/agent-desktop/bin/agent-desktop'
          : path,
    };
    expect(runsOutsideCommandSandbox(native, ['/home/me/repo'], linux)).toBe(true);
    expect(runsOutsideCommandSandbox(native, ['/usr/lib'], linux)).toBe(false);
  });
});

describe('agent-desktop arguments outside the command sandbox', () => {
  const roots = ['C:\\work\\repo'];
  const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
  const refused = (argv: string[]) => agentDesktopArgvRefusal(argv, roots, lookup);

  it('matches the binary itself for the card, wherever it lives', () => {
    expect(isAgentDesktopBinary(WIN_NATIVE, windows)).toBe(true);
    expect(isAgentDesktopBinary('C:\\npm\\agent-desktop.cmd', windows)).toBe(false);
  });

  it.each([
    [['snapshot', '--app', 'notepad.exe', '-i', '--compact']],
    [['--headed', 'type', '@s1:e2', 'hello']],
    [['click', '@s1:e5', '--headed']],
    [['set-value', '@s1:e2', 'text']],
    [['launch', 'notepad']],
    [['launch', '--activate', 'notepad', '--arg', 'C:\\notes\\a.txt']],
    [['launch', 'C:\\Program Files\\App\\app.exe']],
    [['--session', 's1', 'list-windows']],
    [['skills', 'get', 'desktop']],
    [['status']],
    [['screenshot', '--app', 'notepad.exe']],
    [['--version']],
    [
      [
        'batch',
        '[{"command":"expand","args":{"ref_id":"@s1:e3"}},{"command":"snapshot","args":{"window_id":"w1"}}]',
      ],
    ],
    [['batch', '--stop-on-error', '[{"command":"launch","args":{"app":"notepad"}}]']],
  ])('lets ordinary desktop work through: %j', (argv) => {
    expect(refused(argv)).toBeNull();
  });

  it.each([
    // Terminals, shells, script hosts and settings, however they are spelled.
    [['launch', 'cmd']],
    [['launch', 'CMD.EXE']],
    [['launch', 'PowerShell']],
    [['launch', 'pwsh.exe']],
    [['launch', 'wt']],
    [['launch', 'WindowsTerminal.exe']],
    [['launch', 'C:\\Windows\\System32\\cmd.exe']],
    [['launch', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']],
    [['launch', 'conhost']],
    [['launch', 'wsl']],
    [['launch', 'regedit']],
    [['launch', 'taskmgr']],
    [['launch', 'control']],
    [['launch', 'gpedit.msc']],
    [['launch', 'SystemSettings']],
    [['launch', 'ms-settings:display']],
    [['launch', 'Terminal']],
    [['launch', 'com.apple.Terminal']],
    [['launch', 'iTerm.app']],
    [['launch', 'System Settings']],
    [['launch', 'gnome-terminal']],
    [['launch', 'run.bat']],
    // A path the agent could have written, or one that is not absolute.
    [['launch', 'C:\\work\\repo\\build\\app.exe']],
    [['launch', '.\\app.exe']],
    [['launch', '\\\\server\\share\\app.exe']],
    // Pointing the launched app at a shell another way.
    [['launch', 'notepad', '--arg', 'cmd.exe']],
    [['launch', 'notepad', '--arg=powershell']],
    [['launch', 'notepad', '--env', 'COMSPEC=C:\\Windows\\System32\\cmd.exe']],
    [['launch', 'notepad', '--cwd', 'C:\\Windows\\System32\\cmd.exe']],
    [['launch', '--cdp', 'notepad']],
    [['launch', 'notepad', 'extra']],
    [['launch']],
    // Long-lived, clipboard, system surfaces, files written anywhere.
    [['mcp']],
    [['--headed', 'mcp']],
    [['open-system-surface', 'start-menu']],
    [['clipboard-get']],
    [['clipboard-set', '--file-url', 'C:\\secret.txt']],
    [['trace', 'export', '--out', 'C:\\x.html']],
    [['--trace', 'C:\\Users\\me\\x.jsonl', 'snapshot']],
    [['snapshot', '--trace=C:\\x.jsonl']],
    [['snapshot', '--screenshot', 'C:\\x.html']],
    [['screenshot', 'C:\\Users\\me\\Desktop\\x.png']],
    // Anything not understood.
    [['--unknown', 'snapshot']],
    [['no-such-command']],
    [['--', 'snapshot']],
    [['batch', 'not json']],
    [['batch', '{"command":"snapshot"}']],
    [['batch', '[{"command":"mcp"}]']],
    [['batch', '[{"command":"clipboard-get","args":{}}]']],
    [['batch', '[{"command":"launch","args":{"app":"cmd.exe"}}]']],
    [['batch', '[{"command":"launch","args":{"app":"notepad","args":["powershell"]}}]']],
    [['batch', '[{"command":"launch"}]']],
    [['batch', '[{"command":"screenshot","args":{"path":"C:\\\\x.png"}}]']],
    [['batch', '[{"command":"snapshot","args":{"trace":"C:\\\\x.jsonl"}}]']],
    [['batch', '[{"command":"batch","args":{}}]']],
    [['batch', '[{"command":"snapshot","extra":1}]']],
    [['batch', '[1]']],
    [['batch', '[]', 'second']],
  ])('refuses %j', (argv) => {
    expect(refused(argv)).toMatch(/^agent-desktop の実行を拒否した: .+。$/u);
  });
});
