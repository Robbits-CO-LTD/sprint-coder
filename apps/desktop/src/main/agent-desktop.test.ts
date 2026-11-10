import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  agentDesktopArgvRefusal,
  isAgentDesktopExecutable,
  resolveAgentDesktopCommand,
  runsOutsideCommandSandbox,
} from './agent-desktop';
import { AGENT_DESKTOP_PINS, AGENT_DESKTOP_VERSION, agentDesktopPin } from './agent-desktop-pins';

const PIN = 'd274667031322e50b9c2b1ab81c2ca46835d52cc932769a5c34bd4d481fd94c3';
const OTHER = 'e'.repeat(64);
const RESOURCES = 'C:\\Program Files\\Sprint Coder\\resources';
const PACKAGED = `${RESOURCES}\\agent-desktop-win32-x64.exe`;
const DEVELOPMENT = 'F:\\repo\\node_modules\\agent-desktop\\bin\\agent-desktop-win32-x64.exe';
const REPOSITORY_BIN = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'node_modules',
  'agent-desktop',
  'bin',
);
const digests =
  (entries: Record<string, string>) =>
  (path: string): string | null =>
    entries[path] ?? null;
const packaged = {
  platform: 'win32' as const,
  arch: 'x64',
  packaged: true,
  resourcesPath: RESOURCES,
  contentDigest: digests({ [PACKAGED]: PIN }),
  realpath: (path: string) => path,
};
const development = {
  platform: 'win32' as const,
  arch: 'x64',
  packaged: false,
  repositoryRoot: 'F:\\repo',
  contentDigest: digests({ [DEVELOPMENT]: PIN }),
  realpath: (path: string) => path,
};

describe('agent-desktop pin', () => {
  it('pins only the Windows x64 binary of 1.2.0, to the npm package bytes', () => {
    expect(AGENT_DESKTOP_VERSION).toBe('1.2.0');
    expect(Object.keys(AGENT_DESKTOP_PINS)).toEqual(['win32-x64']);
    expect(agentDesktopPin('win32', 'x64')).toEqual({
      file: 'agent-desktop-win32-x64.exe',
      sha256: PIN,
    });
    for (const [platform, arch] of [
      ['win32', 'arm64'],
      ['darwin', 'arm64'],
      ['linux', 'x64'],
      ['__proto__', 'x'],
    ] as const)
      expect(agentDesktopPin(platform, arch)).toBeNull();
    // The installed dependency carries exactly these bytes and agrees with its own manifest.
    const binary = readFileSync(join(REPOSITORY_BIN, 'agent-desktop-win32-x64.exe'));
    expect(createHash('sha256').update(binary).digest('hex')).toBe(PIN);
    expect(
      readFileSync(join(REPOSITORY_BIN, 'agent-desktop-win32-x64.exe.sha256'), 'utf8').trim(),
    ).toBe(PIN);
  });
});

describe('agent-desktop lookup', () => {
  it('uses only the shipped copy: the packaged resources, or node_modules in development', () => {
    expect(resolveAgentDesktopCommand(packaged)).toBe(PACKAGED);
    expect(resolveAgentDesktopCommand(development)).toBe(DEVELOPMENT);
    // The packaged app never looks at node_modules, and development never at resources.
    expect(
      resolveAgentDesktopCommand({ ...packaged, contentDigest: digests({ [DEVELOPMENT]: PIN }) }),
    ).toBeNull();
    expect(
      resolveAgentDesktopCommand({ ...development, contentDigest: digests({ [PACKAGED]: PIN }) }),
    ).toBeNull();
    expect(resolveAgentDesktopCommand({ ...packaged, resourcesPath: '' })).toBeNull();
  });

  it('returns null when the shipped file is missing or its bytes are not the pin', () => {
    expect(resolveAgentDesktopCommand({ ...packaged, contentDigest: () => null })).toBeNull();
    expect(
      resolveAgentDesktopCommand({ ...packaged, contentDigest: digests({ [PACKAGED]: OTHER }) }),
    ).toBeNull();
  });

  it('is off on macOS, Linux and architectures without a pin', () => {
    const contentDigest = () => PIN;
    for (const platform of ['darwin', 'linux'] as const)
      expect(resolveAgentDesktopCommand({ ...development, platform, contentDigest })).toBeNull();
    expect(resolveAgentDesktopCommand({ ...development, arch: 'arm64', contentDigest })).toBeNull();
  });

  it('reads no environment variable and searches no PATH', () => {
    vi.stubEnv('SPRINT_CODER_AGENT_DESKTOP', 'C:\\tools\\agent-desktop.exe');
    vi.stubEnv('Path', 'C:\\tools;C:\\npm');
    vi.stubEnv('PATH', 'C:\\tools;C:\\npm');
    const seen: string[] = [];
    try {
      expect(
        resolveAgentDesktopCommand({
          ...development,
          contentDigest: (path) => {
            seen.push(path);
            return PIN;
          },
        }),
      ).toBe(DEVELOPMENT);
      expect(seen).toEqual([DEVELOPMENT]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
    'finds the real dependency in this checkout',
    () => {
      expect(resolveAgentDesktopCommand()?.toLowerCase()).toBe(
        join(REPOSITORY_BIN, 'agent-desktop-win32-x64.exe').toLowerCase(),
      );
    },
  );
});

describe('agent-desktop outside the command sandbox', () => {
  it('lets only the shipped file with the pinned bytes out', () => {
    expect(isAgentDesktopExecutable(PACKAGED, PIN, packaged)).toBe(true);
    expect(isAgentDesktopExecutable(PACKAGED.toUpperCase(), PIN, packaged)).toBe(true);
    expect(runsOutsideCommandSandbox(PACKAGED, PIN, ['C:\\work\\repo'], packaged)).toBe(true);
    expect(runsOutsideCommandSandbox(DEVELOPMENT, PIN, ['C:\\work\\repo'], development)).toBe(true);
  });

  it('never trusts the path alone: other sealed bytes at the shipped path stay inside', () => {
    // The Critical: a sealed Workspace binary whose path was swapped to point at agent-desktop.
    for (const digest of [OTHER, null]) {
      expect(isAgentDesktopExecutable(PACKAGED, digest, packaged)).toBe(false);
      expect(runsOutsideCommandSandbox(PACKAGED, digest, ['C:\\work\\repo'], packaged)).toBe(false);
      expect(isAgentDesktopExecutable(DEVELOPMENT, digest, development)).toBe(false);
    }
    expect(
      runsOutsideCommandSandbox('C:\\link\\ad.exe', OTHER, ['C:\\work\\repo'], {
        ...packaged,
        realpath: (path) => (path === 'C:\\link\\ad.exe' ? PACKAGED : path),
      }),
    ).toBe(false);
  });

  it('keeps the pinned bytes inside anywhere but the shipped file', () => {
    for (const executable of [
      'C:\\work\\repo\\agent-desktop-win32-x64.exe',
      'C:\\other\\agent-desktop-win32-x64.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ])
      expect(runsOutsideCommandSandbox(executable, PIN, ['C:\\work\\repo'], packaged)).toBe(false);
    // Nor when the shipped file itself no longer holds the pinned bytes.
    expect(
      runsOutsideCommandSandbox(PACKAGED, PIN, ['C:\\work\\repo'], {
        ...packaged,
        contentDigest: () => OTHER,
      }),
    ).toBe(false);
    // Nor on a platform without a pin.
    expect(
      runsOutsideCommandSandbox(DEVELOPMENT, PIN, ['/home/me/repo'], {
        ...development,
        platform: 'linux',
      }),
    ).toBe(false);
  });

  it('keeps the binary inside when it lives in any Workspace root of the Turn', () => {
    for (const root of [RESOURCES, 'c:\\PROGRAM FILES', 'C:\\'])
      expect(runsOutsideCommandSandbox(PACKAGED, PIN, ['C:\\work\\repo', root], packaged)).toBe(
        false,
      );
    expect(
      runsOutsideCommandSandbox(
        PACKAGED,
        PIN,
        ['C:\\Program Files\\Sprint', 'C:\\Program Files\\Sprint Coder-other', 'D:\\'],
        packaged,
      ),
    ).toBe(true);
  });
});

describe('agent-desktop arguments outside the command sandbox', () => {
  const roots = ['C:\\work\\repo'];
  const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
  const refused = (argv: string[]) => agentDesktopArgvRefusal(argv, roots, lookup);
  const BATCH_MENU =
    '[{"command":"expand","args":{"ref_id":"@s1:e3"}},{"command":"snapshot","args":{"window_id":"w1"}}]';

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
