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
  const BATCH_MENU =
    '[{"command":"expand","args":{"ref_id":"@s1:e3"}},{"command":"snapshot","args":{"window_id":"w1"}}]';

  it('matches the binary itself for the card, wherever it lives', () => {
    expect(isAgentDesktopBinary(WIN_NATIVE, windows)).toBe(true);
    expect(isAgentDesktopBinary('C:\\npm\\agent-desktop.cmd', windows)).toBe(false);
  });

  // Every form the agent used on the real desktop, and a few more ordinary ones.
  it.each([
    [['skills', 'get', 'desktop']],
    [['skills', 'get', 'platform']],
    [['skills']],
    [['status']],
    [['list-windows']],
    [['list-windows', '--app', 'notepad.exe']],
    [['launch', 'notepad']],
    [['launch', '--activate', 'notepad', '--no-attach', '--timeout', '5000']],
    [['launch', 'C:\\Program Files\\App\\app.exe']],
    [['launch', '--help']],
    [['batch', '--help']],
    [['snapshot', '--help']],
    [['--version']],
    [['snapshot', '--window-id', 'w1']],
    [
      [
        'snapshot',
        '--window-id',
        'w1',
        '-i',
        '--compact',
        '--max-depth',
        '3',
        '--root',
        '@s1:e2',
        '--surface',
        'menu',
      ],
    ],
    [['snapshot', '--app', 'notepad.exe', '--max-depth=3', '--interactive-only']],
    [['set-value', '@s1:e2', 'text']],
    [['get', '@s1:e2']],
    [['click', '@s1:e5']],
    [['expand', '@s1:e5']],
    [['collapse', '@s1:e5']],
    [['--headed', 'focus-window', '--window-id', 'w1']],
    [['--headed', 'focus', '@s1:e2']],
    [['--headed', 'type', '@s1:e2', 'hello']],
    [['type', '@s1:e2', '--', '-5']],
    [['click', '@s1:e5', '--headed']],
    [['press', 'return']],
    [['--headed', 'mouse-click', '--xy', '100,200']],
    [['--headed', 'mouse-click', '--xy=-100,50', '--button', 'right']],
    [['--session', 's1', 'list-windows']],
    [['screenshot', '--app', 'notepad.exe']],
    [['wait', '--element', '@s1:e9', '--predicate', 'actionable', '--timeout', '5000']],
    [['batch', BATCH_MENU]],
    [
      [
        'batch',
        '--stop-on-error',
        '[{"command":"launch","args":{"app":"notepad","activate":true}}]',
      ],
    ],
  ])('lets ordinary desktop work through: %j', (argv) => {
    expect(refused(argv)).toBeNull();
  });

  it.each([
    // launch takes one app and nothing for it: no arguments, environment or working directory.
    [['launch', 'notepad', '--arg', 'C:\\notes\\a.txt'], '--arg は使えない'],
    [['launch', '--arg=--inspect', 'notepad'], '--arg は使えない'],
    [['launch', 'code', '--env', 'ELECTRON_RUN_AS_NODE=1'], '--env は使えない'],
    [['launch', 'notepad', '--env=NODE_OPTIONS=--require x'], '--env は使えない'],
    [['launch', 'notepad', '--cwd', 'C:\\work\\repo'], '--cwd は使えない'],
    [['launch', '--cdp', 'notepad'], '--cdp は使えない'],
    [['launch', 'notepad', 'extra'], 'アプリ名か'],
    [['launch'], 'アプリ名か'],
    [['batch', '[{"command":"launch","args":{"app":"notepad","env":["A=1"]}}]'], 'env は使えない'],
    [['batch', '[{"command":"launch","args":{"app":"notepad","args":["x"]}}]'], 'args は使えない'],
    [['batch', '[{"command":"launch","args":{"app":"notepad","cwd":"C:\\\\"}}]'], 'cwd は使えない'],
    [['batch', '[{"command":"launch","args":{"app":"notepad","cdp":0}}]'], 'cdp は使えない'],
    [['batch', '[{"command":"launch"}]'], 'app を判定できない'],
    // Unknown, short or refused options, wherever they stand.
    [['snapshot', '--bogus'], '--bogus を判定できない（snapshot で使える option だけにする）'],
    [['--bogus', 'snapshot'], '--bogus を判定できない'],
    [['snapshot', '-x'], '-x を判定できない'],
    [['snapshot', '-iv'], '-iv を判定できない'],
    [['click', '@s1:e5', '--compact'], '--compact を判定できない（click'],
    [['snapshot', '--compact=yes'], '--compact=yes を判定できない'],
    [['list-windows', '--app'], '--app に値が無い'],
    [['type', '@s1:e2', '--stdin'], '--stdin は使えない'],
    [['set-value', '@s1:e2', '--stdin'], '--stdin は使えない'],
    [['press', 'alt+f4', '--force'], '--force は使えない'],
    [['close-app', 'notepad', '--force'], '--force は使えない'],
    [['permissions', '--guide'], '--guide は使えない'],
    [['cursor-overlay', 'enable', '--image', 'C:\\x.png'], '--image は使えない'],
    [['session', 'start', '--screenshots'], '--screenshots は使えない'],
    [['clipboard-set', '--file-url', 'C:\\secret.txt'], '--file-url は使えない'],
    [['--trace', 'C:\\Users\\me\\x.jsonl', 'snapshot'], '--trace は使えない'],
    [['snapshot', '--trace=C:\\x.jsonl'], '--trace は使えない'],
    [['snapshot', '--screenshot', 'C:\\x.html'], '--screenshot は使えない'],
    [['screenshot', 'C:\\Users\\me\\Desktop\\x.png'], '保存先は指定できない'],
    [['--', 'snapshot'], '-- の位置'],
    // Commands that are refused or unknown.
    [['mcp'], 'mcp は使えない'],
    [['--headed', 'mcp'], 'mcp は使えない'],
    [['open-system-surface', 'start-menu'], 'open-system-surface は使えない'],
    [['clipboard-get'], 'clipboard-get は使えない'],
    [['trace', 'export', '--out', 'C:\\x.html'], 'trace は使えない'],
    [['no-such-command'], 'no-such-command を判定できない'],
    [['skills', 'bogus'], 'skills bogus を判定できない'],
    // The name list is a convenience, not the boundary.
    [['launch', 'cmd'], 'cmd は起動できない'],
    [
      ['launch', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
      'powershell.exe は起動できない',
    ],
    [['launch', 'ms-settings:display'], 'URI'],
    [['launch', 'com.apple.Terminal'], 'は起動できない'],
    [['launch', 'run.bat'], 'run.bat は起動できない'],
    // A path the agent could have written, or one that is not absolute.
    [['launch', 'C:\\work\\repo\\build\\app.exe'], 'Workspace の中'],
    [['launch', '.\\app.exe'], '絶対パスだけ'],
    [['launch', '\\\\server\\share\\app.exe'], '絶対パスだけ'],
    // Batches that cannot be read, or carry a refused command or argument.
    [['batch', 'not json'], 'JSON を読めない'],
    [['batch', '{"command":"snapshot"}'], '配列にする'],
    [['batch', '[{"command":"mcp"}]'], 'mcp は使えない'],
    [['batch', '[{"command":"clipboard-get","args":{}}]'], 'clipboard-get は使えない'],
    [['batch', '[{"command":"launch","args":{"app":"cmd.exe"}}]'], 'cmd.exe は起動できない'],
    [['batch', '[{"command":"screenshot","args":{"path":"C:\\\\x.png"}}]'], 'path は使えない'],
    [['batch', '[{"command":"snapshot","args":{"trace":"C:\\\\x.jsonl"}}]'], 'trace は使えない'],
    [['batch', '[{"command":"type","args":{"ref_id":"@s1:e2","stdin":true}}]'], 'stdin は使えない'],
    [['batch', '[{"command":"batch","args":{}}]'], 'batch の中の batch'],
    [['batch', '[{"command":"skills","args":{}}]'], '判定できない'],
    [['batch', '[{"command":"snapshot","extra":1}]'], '形を判定できない'],
    [['batch', '[1]'], '形を判定できない'],
    [['batch', '[]', 'second'], 'JSON の配列を 1 つだけ'],
  ])('refuses %j', (argv, reason) => {
    const refusal = refused(argv);
    expect(refusal).toMatch(/^agent-desktop の実行を拒否した: .+。$/u);
    expect(refusal).toContain(reason);
  });
});
