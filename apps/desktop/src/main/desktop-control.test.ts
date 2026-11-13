import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CONTROL_EXPECTED_WINDOW_OWNER_VARIABLE,
  DESKTOP_CONTROL_SKILL_REFERENCES,
  DESKTOP_CONTROL_HOST_PID_VARIABLE,
  DESKTOP_CONTROL_RENDERER_IMAGE_VARIABLE,
  desktopControlArgvIsInert,
  desktopControlArgvRefusal,
  desktopControlEnvironment,
  desktopControlExpectedWindowOwner,
  desktopControlLaunchByName,
  desktopControlStateFolder,
  isDesktopControlExecutable,
  isShippedDesktopControlPath,
  reportDesktopControlAvailability,
  resolveDesktopControlCommand,
  runsOutsideCommandSandbox,
} from './desktop-control';
import {
  DESKTOP_CONTROL_EXECUTABLE,
  DESKTOP_CONTROL_TEAM_CURSORS_VARIABLE,
  DESKTOP_CONTROL_VERSION,
  desktopControlSupported,
  desktopControlTeamCursorsEnabled,
} from './desktop-control-build';

// The digest a build (or the package's signing step) sealed in the `.sha256` manifest.
const SEALED = 'd274667031322e50b9c2b1ab81c2ca46835d52cc932769a5c34bd4d481fd94c3';
const OTHER = 'e'.repeat(64);
const RESOURCES = 'C:\\Program Files\\Sprint Coder\\resources';
const PACKAGED = `${RESOURCES}\\sprint-coder-desktop-control.exe`;
// In a development run, the build output in the repository.
const DEVELOPMENT =
  'F:\\repo\\apps\\desktop\\desktop-control\\build\\Release\\sprint-coder-desktop-control.exe';
const REPOSITORY_BUILD = join(
  __dirname,
  '..',
  '..',
  'desktop-control',
  'build',
  'Release',
  DESKTOP_CONTROL_EXECUTABLE,
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
  contentDigest: digests({ [PACKAGED]: SEALED }),
  sealedDigest: digests({ [PACKAGED]: SEALED }),
  realpath: (path: string) => path,
};
const development = {
  platform: 'win32' as const,
  arch: 'x64',
  packaged: false,
  repositoryRoot: 'F:\\repo',
  contentDigest: digests({ [DEVELOPMENT]: SEALED }),
  sealedDigest: digests({ [DEVELOPMENT]: SEALED }),
  realpath: (path: string) => path,
};

describe('desktop-control run environment', () => {
  it('drops every PATH folder inside a Workspace root, and relative or empty ones, keeping the rest', () => {
    const environment = {
      PATH: [
        'C:\\Windows\\System32',
        'F:\\work\\app',
        'f:\\WORK\\app\\node_modules\\.bin\\',
        '"F:\\work\\app\\tools"',
        'F:\\work\\second\\bin',
        'F:\\work\\application',
        '',
        'relative\\bin',
        '.',
        '\\root-relative',
        'C:drive-relative',
        '\\\\server\\share\\bin',
        '"C:\\Program Files\\Git\\cmd"',
        'D:\\tools',
      ].join(';'),
      TEMP: 'F:\\work\\app\\tmp',
    };
    const filtered = desktopControlEnvironment(environment, ['F:\\work\\app', 'F:\\work\\second'], {
      platform: 'win32',
      realpath: (path) => path,
    });
    expect(filtered['PATH']!.split(';')).toEqual([
      'C:\\Windows\\System32',
      'F:\\work\\application',
      'D:\\tools',
    ]);
    // Only PATH changes.
    expect(filtered['TEMP']).toBe(environment.TEMP);
    expect(
      desktopControlEnvironment({ Path: 'F:\\work\\app' }, ['F:\\work\\app'], {
        platform: 'win32',
        realpath: (path) => path,
      }),
    ).toEqual({ Path: '', AGENT_DESKTOP_HOME: desktopControlStateFolder() });
  });

  it('drops any entry with a quote unread, and rebuilds PATH from the normalized folders', () => {
    const windows = { platform: 'win32' as const, realpath: (path: string) => path };
    const filtered = desktopControlEnvironment(
      {
        PATH: [
          '"C:\\Program Files\\Git\\cmd"',
          'C:\\Tools\\"x"\\bin',
          '"C:\\outside;F:\\work\\app\\bin"',
          'C:\\Tools\\with"quote',
          '  C:\\Windows\\System32\\  ',
          'C:\\Windows\\.\\System32',
          'c:\\windows\\system32\\',
          'C:/Tools/forward/',
          'D:\\',
        ].join(';'),
      },
      ['F:\\work\\app'],
      windows,
    );
    // The quoted `;` splits into `"C:\outside` and `F:\work\app\bin"`: both carry a quote.
    expect(filtered).toEqual({
      PATH: ['C:\\Windows\\System32', 'C:\\Tools\\forward', 'D:\\'].join(';'),
      AGENT_DESKTOP_HOME: desktopControlStateFolder(),
    });
  });

  it('filters every PATH variable whatever its letter case', () => {
    expect(
      desktopControlEnvironment(
        {
          Path: 'F:\\work\\app\\bin;C:\\one',
          PATH: 'F:\\work\\app;C:\\two',
          OTHER: 'F:\\work\\app',
        },
        ['F:\\work\\app'],
        { platform: 'win32', realpath: (path) => path },
      ),
    ).toEqual({
      Path: 'C:\\one',
      PATH: 'C:\\two',
      OTHER: 'F:\\work\\app',
      AGENT_DESKTOP_HOME: desktopControlStateFolder(),
    });
  });

  it('judges a PATH folder by where it really is', () => {
    const filtered = desktopControlEnvironment(
      { PATH: 'C:\\linked;C:\\other' },
      ['F:\\work\\app'],
      {
        platform: 'win32',
        realpath: (path) => (path === 'C:\\linked' ? 'F:\\work\\app\\bin' : path),
      },
    );
    expect(filtered).toEqual({
      PATH: 'C:\\other',
      AGENT_DESKTOP_HOME: desktopControlStateFolder(),
    });
  });

  it('sets the cursor renderer image and host from Main alone, never the ones the caller chose', () => {
    const chosen = {
      SPRINT_CODER_DESKTOP_CONTROL_IMAGE: 'C:\\attacker\\sprint-coder-desktop-control.exe',
      sprint_coder_desktop_host_pid: '1',
      OTHER: 'kept',
    };
    const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
    expect(desktopControlEnvironment(chosen, [], lookup)).toEqual({
      OTHER: 'kept',
      AGENT_DESKTOP_HOME: desktopControlStateFolder(),
    });
    const image = 'C:\\Sprint Coder\\resources\\sprint-coder-desktop-control.exe';
    expect(
      desktopControlEnvironment(chosen, [], lookup, undefined, { image, hostPid: 4242 }),
    ).toEqual({
      OTHER: 'kept',
      AGENT_DESKTOP_HOME: desktopControlStateFolder(),
      [DESKTOP_CONTROL_RENDERER_IMAGE_VARIABLE]: image,
      [DESKTOP_CONTROL_HOST_PID_VARIABLE]: '4242',
    });
  });

  it('always drops the expected window owner the caller chose, and sets only the one Main gives', () => {
    const chosen = {
      SPRINT_CODER_DESKTOP_EXPECTED_WINDOW_OWNER: '1:windows-proc-v1:1:1',
      sprint_coder_desktop_expected_window_owner: '2:windows-proc-v1:2:2',
      Sprint_Coder_Desktop_Expected_Window_Owner: '3:windows-proc-v1:3:3',
      OTHER: 'kept',
    };
    const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
    expect(desktopControlEnvironment(chosen, [], lookup)).toEqual({
      OTHER: 'kept',
      AGENT_DESKTOP_HOME: desktopControlStateFolder(),
    });
    expect(
      desktopControlEnvironment(chosen, [], lookup, '64724:windows-proc-v1:13438878845:5256581'),
    ).toEqual({
      OTHER: 'kept',
      AGENT_DESKTOP_HOME: desktopControlStateFolder(),
      [DESKTOP_CONTROL_EXPECTED_WINDOW_OWNER_VARIABLE]: '64724:windows-proc-v1:13438878845:5256581',
    });
    expect(desktopControlExpectedWindowOwner({ pid: 64724, instance: 'windows-proc-v1:1:2' })).toBe(
      '64724:windows-proc-v1:1:2',
    );
    for (const owner of [
      { pid: 0, instance: 'windows-proc-v1:1:2' },
      { pid: 2 ** 32, instance: 'windows-proc-v1:1:2' },
      { pid: 1.5, instance: 'windows-proc-v1:1:2' },
      { pid: 1, instance: '' },
      { pid: 1, instance: 'windows proc' },
    ])
      expect(desktopControlExpectedWindowOwner(owner)).toBeNull();
  });
});

describe('desktop-control build', () => {
  it('is built and shipped for Windows x64 only, from the 1.2.0 source, under one name', () => {
    expect(DESKTOP_CONTROL_VERSION).toBe('1.2.0');
    expect(DESKTOP_CONTROL_EXECUTABLE).toBe('sprint-coder-desktop-control.exe');
    expect(desktopControlSupported('win32', 'x64')).toBe(true);
    for (const [platform, arch] of [
      ['win32', 'arm64'],
      ['win32', 'ia32'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['__proto__', 'x'],
    ] as const)
      expect(desktopControlSupported(platform, arch)).toBe(false);
  });

  it('has the Team’s desktop cursors on by default, off only with 0, and never where it is not built', () => {
    expect(DESKTOP_CONTROL_TEAM_CURSORS_VARIABLE).toBe('SPRINT_CODER_DESKTOP_TEAM_CURSORS');
    for (const value of [undefined, '1', '', 'true', 'false', 'off', ' 0', '00'])
      expect(desktopControlTeamCursorsEnabled(value, 'win32', 'x64'), String(value)).toBe(true);
    expect(desktopControlTeamCursorsEnabled('0', 'win32', 'x64')).toBe(false);
    for (const [platform, arch] of [
      ['win32', 'arm64'],
      ['darwin', 'arm64'],
      ['linux', 'x64'],
    ] as const)
      for (const value of [undefined, '1'])
        expect(desktopControlTeamCursorsEnabled(value, platform, arch)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
    'has a build in this checkout whose bytes agree with its own manifest',
    () => {
      const sealed = readFileSync(`${REPOSITORY_BUILD}.sha256`, 'utf8').trim();
      expect(sealed).toMatch(/^[a-f0-9]{64}$/u);
      expect(createHash('sha256').update(readFileSync(REPOSITORY_BUILD)).digest('hex')).toBe(
        sealed,
      );
    },
  );
});

describe('desktop-control lookup', () => {
  it('uses only the shipped copy: the packaged resources, or the build output in development', () => {
    expect(resolveDesktopControlCommand(packaged)).toBe(PACKAGED);
    expect(resolveDesktopControlCommand(development)).toBe(DEVELOPMENT);
    // The packaged app never looks at the build output, and development never at resources.
    const atDevelopment = digests({ [DEVELOPMENT]: SEALED });
    const atPackaged = digests({ [PACKAGED]: SEALED });
    expect(
      resolveDesktopControlCommand({
        ...packaged,
        contentDigest: atDevelopment,
        sealedDigest: atDevelopment,
      }),
    ).toBeNull();
    expect(
      resolveDesktopControlCommand({
        ...development,
        contentDigest: atPackaged,
        sealedDigest: atPackaged,
      }),
    ).toBeNull();
    expect(resolveDesktopControlCommand({ ...packaged, resourcesPath: '' })).toBeNull();
    // The packaged app looks only under the shipped name.
    const elsewhere = digests({ [`${RESOURCES}\\desktop-control.exe`]: SEALED });
    expect(
      resolveDesktopControlCommand({
        ...packaged,
        contentDigest: elsewhere,
        sealedDigest: elsewhere,
      }),
    ).toBeNull();
  });

  it('returns null when the shipped file is missing or its bytes are not the sealed ones', () => {
    expect(resolveDesktopControlCommand({ ...packaged, contentDigest: () => null })).toBeNull();
    expect(
      resolveDesktopControlCommand({ ...packaged, contentDigest: digests({ [PACKAGED]: OTHER }) }),
    ).toBeNull();
  });

  it('returns null when the seal is missing or malformed, whatever the bytes', () => {
    for (const sealed of [null, '', 'not-a-digest', SEALED.toUpperCase(), `${SEALED}0`])
      for (const lookup of [packaged, development])
        expect(
          resolveDesktopControlCommand({
            ...lookup,
            contentDigest: () => sealed,
            sealedDigest: () => sealed,
          }),
        ).toBeNull();
  });

  it('trusts whatever digest the shipped file is sealed with, and only while its bytes match', () => {
    // A rebuild (or the package's signing step) seals new bytes; the old digest stops counting.
    const rebuilt = { ...packaged, contentDigest: () => OTHER, sealedDigest: () => OTHER };
    expect(resolveDesktopControlCommand(rebuilt)).toBe(PACKAGED);
    expect(isDesktopControlExecutable(PACKAGED, OTHER, rebuilt)).toBe(true);
    expect(isDesktopControlExecutable(PACKAGED, SEALED, rebuilt)).toBe(false);
  });

  it('is off on macOS, Linux and architectures it is not built for', () => {
    const contentDigest = () => SEALED;
    const sealedDigest = () => SEALED;
    for (const platform of ['darwin', 'linux'] as const)
      expect(
        resolveDesktopControlCommand({ ...development, platform, contentDigest, sealedDigest }),
      ).toBeNull();
    expect(
      resolveDesktopControlCommand({ ...development, arch: 'arm64', contentDigest, sealedDigest }),
    ).toBeNull();
  });

  it('reads no environment variable and searches no PATH', () => {
    vi.stubEnv('SPRINT_CODER_DESKTOP_CONTROL', 'C:\\tools\\desktop-control.exe');
    vi.stubEnv('Path', 'C:\\tools;C:\\npm');
    vi.stubEnv('PATH', 'C:\\tools;C:\\npm');
    const seen: string[] = [];
    try {
      expect(
        resolveDesktopControlCommand({
          ...development,
          contentDigest: (path) => {
            seen.push(path);
            return SEALED;
          },
          sealedDigest: (path) => {
            seen.push(path);
            return SEALED;
          },
        }),
      ).toBe(DEVELOPMENT);
      expect(seen).toEqual([DEVELOPMENT, DEVELOPMENT]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
    'finds the real build in this checkout',
    () => {
      expect(resolveDesktopControlCommand()?.toLowerCase()).toBe(REPOSITORY_BUILD.toLowerCase());
    },
  );
});

describe('desktop-control startup report', () => {
  const BUILD = 'apps/desktop/desktop-control/build/Release/sprint-coder-desktop-control.exe';
  const FIX = 'Run `npm run build:desktop-control` at the repository root, then restart.';
  const reported = (lookup: Parameters<typeof reportDesktopControlAvailability>[0]) => {
    const messages: string[] = [];
    reportDesktopControlAvailability(lookup, (message) => messages.push(message));
    return messages;
  };

  it('says nothing when the sealed build is there, or where desktop control is not built', () => {
    expect(reported(packaged)).toEqual([]);
    expect(reported(development)).toEqual([]);
    const none = { contentDigest: () => null, sealedDigest: () => null };
    for (const platform of ['darwin', 'linux'] as const)
      expect(reported({ ...development, ...none, platform })).toEqual([]);
    expect(reported({ ...development, ...none, arch: 'arm64' })).toEqual([]);
  });

  it('tells a development run why it is off and how to build it', () => {
    const missing = (exe: string | null, seal: string | null) =>
      reported({ ...development, contentDigest: () => exe, sealedDigest: () => seal });
    expect(missing(null, null)).toEqual([
      `Desktop control is off: the executable has not been built (${BUILD} and its .sha256 manifest are missing). ${FIX}`,
    ]);
    expect(missing(null, SEALED)).toEqual([
      `Desktop control is off: ${BUILD} is missing or unreadable. ${FIX}`,
    ]);
    expect(missing(SEALED, null)).toEqual([
      `Desktop control is off: the .sha256 manifest beside ${BUILD} is missing. ${FIX}`,
    ]);
    expect(missing(SEALED, 'not-a-digest')).toEqual([
      `Desktop control is off: the .sha256 manifest beside ${BUILD} does not hold a SHA-256 digest. ${FIX}`,
    ]);
    expect(missing(OTHER, SEALED)).toEqual([
      `Desktop control is off: the bytes of ${BUILD} do not match the SHA-256 in its .sha256 manifest. ${FIX}`,
    ]);
  });

  it('tells a packaged app only why, without the development build command or a full path', () => {
    const messages = [
      ...reported({ ...packaged, contentDigest: () => null, sealedDigest: () => null }),
      ...reported({ ...packaged, contentDigest: () => OTHER }),
      ...reported({ ...packaged, resourcesPath: '' }),
    ];
    expect(messages).toEqual([
      'Desktop control is off: resources\\sprint-coder-desktop-control.exe and its .sha256 manifest are missing.',
      'Desktop control is off: the bytes of resources\\sprint-coder-desktop-control.exe do not match the SHA-256 in its .sha256 manifest.',
      "Desktop control is off: the app's resources folder is unknown.",
    ]);
    for (const message of messages) {
      expect(message).not.toContain('npm');
      expect(message).not.toContain(RESOURCES);
    }
  });
});

describe('desktop control outside the command sandbox', () => {
  it('lets only the shipped file with the sealed bytes out', () => {
    expect(isDesktopControlExecutable(PACKAGED, SEALED, packaged)).toBe(true);
    expect(isDesktopControlExecutable(PACKAGED.toUpperCase(), SEALED, packaged)).toBe(true);
    expect(runsOutsideCommandSandbox(PACKAGED, SEALED, ['C:\\work\\repo'], packaged)).toBe(true);
    expect(runsOutsideCommandSandbox(DEVELOPMENT, SEALED, ['C:\\work\\repo'], development)).toBe(
      true,
    );
  });

  it('never trusts the path alone: other sealed bytes at the shipped path stay inside', () => {
    // The Critical: a sealed Workspace binary whose path was swapped to point at the desktop-control binary.
    for (const digest of [OTHER, null]) {
      expect(isDesktopControlExecutable(PACKAGED, digest, packaged)).toBe(false);
      expect(runsOutsideCommandSandbox(PACKAGED, digest, ['C:\\work\\repo'], packaged)).toBe(false);
      expect(isDesktopControlExecutable(DEVELOPMENT, digest, development)).toBe(false);
    }
    expect(
      runsOutsideCommandSandbox('C:\\link\\ad.exe', OTHER, ['C:\\work\\repo'], {
        ...packaged,
        realpath: (path) => (path === 'C:\\link\\ad.exe' ? PACKAGED : path),
      }),
    ).toBe(false);
  });

  it('keeps the sealed bytes inside anywhere but the shipped file', () => {
    for (const executable of [
      'C:\\work\\repo\\sprint-coder-desktop-control.exe',
      'C:\\other\\desktop-control.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ])
      expect(runsOutsideCommandSandbox(executable, SEALED, ['C:\\work\\repo'], packaged)).toBe(
        false,
      );
    // Nor when the shipped file itself no longer holds the sealed bytes.
    expect(
      runsOutsideCommandSandbox(PACKAGED, SEALED, ['C:\\work\\repo'], {
        ...packaged,
        contentDigest: () => OTHER,
      }),
    ).toBe(false);
    // Nor when the shipped file has no seal.
    expect(
      runsOutsideCommandSandbox(PACKAGED, SEALED, ['C:\\work\\repo'], {
        ...packaged,
        sealedDigest: () => null,
      }),
    ).toBe(false);
    // Nor on a platform it is not built for.
    expect(
      runsOutsideCommandSandbox(DEVELOPMENT, SEALED, ['/home/me/repo'], {
        ...development,
        platform: 'linux',
      }),
    ).toBe(false);
  });

  it('keeps the binary inside when it lives in any Workspace root of the Turn', () => {
    for (const root of [RESOURCES, 'c:\\PROGRAM FILES', 'C:\\'])
      expect(runsOutsideCommandSandbox(PACKAGED, SEALED, ['C:\\work\\repo', root], packaged)).toBe(
        false,
      );
    expect(
      runsOutsideCommandSandbox(
        PACKAGED,
        SEALED,
        ['C:\\Program Files\\Sprint', 'C:\\Program Files\\Sprint Coder-other', 'D:\\'],
        packaged,
      ),
    ).toBe(true);
  });
});

describe('a Workspace root written another way than the file system resolves it', () => {
  // As on a Windows CI runner, whose temp folder is `C:\Users\RUNNER~1\...` (an 8.3 short name)
  // while the file system resolves it to the long name, and as through a symlink or junction. The
  // root exists; the executable to launch has not been written yet, so it does not resolve.
  const SHORT = 'C:\\Users\\RUNNER~1\\Temp\\worktree';
  const LONG = 'C:\\Users\\runneradmin\\Temp\\worktree';
  const realpath = (path: string) => {
    const lower = path.toLowerCase();
    for (const base of [SHORT, LONG])
      if (lower === base.toLowerCase() || lower === `${base}\\`.toLowerCase()) return LONG;
      else if (lower.startsWith(`${base}\\`.toLowerCase()))
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return path;
  };
  const lookup = { platform: 'win32' as const, realpath };
  const refused = (target: string, root: string) =>
    desktopControlArgvRefusal(['launch', target], [root], lookup);

  it('reads an executable under it as inside, in either spelling of either one', () => {
    for (const root of [SHORT, LONG])
      for (const target of [`${SHORT}\\app.exe`, `${LONG}\\app.exe`, `${LONG}\\bin\\app.exe`])
        expect(refused(target, root)).toContain('Workspace の中の実行ファイルは起動できない');
    expect(refused('C:\\Windows\\System32\\charmap.exe', SHORT)).toBeNull();
    expect(refused('C:\\Users\\runneradmin\\Temp\\other\\app.exe', SHORT)).toBeNull();
  });
});

describe('desktop-control arguments outside the command sandbox', () => {
  const roots = ['C:\\work\\repo'];
  const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
  const refused = (argv: string[]) => desktopControlArgvRefusal(argv, roots, lookup);
  const batch = (entries: unknown) => ['batch', JSON.stringify(entries)];
  const BATCH_MENU =
    '[{"command":"expand","args":{"ref_id":"@s1:e3"}},{"command":"snapshot","args":{"window_id":"w1"}}]';

  it('refuses a point given both as a part and as coordinates, and takes either one alone', () => {
    const both = '部品の指定と座標の指定は、どちらか片方だけにする';
    for (const argv of [
      ['--headed', 'drag', '--from', '@s1:e1', '--from-xy', '1,1', '--to', '@s1:e2'],
      ['--headed', 'drag', '--from', '@s1:e1', '--to', '@s1:e2', '--to-xy=2,2'],
      ['--headed', 'hover', '@s1:e1', '--xy', '1,1'],
      batch([{ command: 'drag', args: { from: '@s1:e1', from_xy: '1,1', to: '@s1:e2' } }]),
      batch([{ command: 'drag', args: { from: '@s1:e1', to: '@s1:e2', toXy: '2,2' } }]),
      batch([{ command: 'hover', args: { ref_id: '@s1:e1', xy: '1,1' } }]),
    ])
      expect(refused(argv)).toContain(both);
    expect(refused(['drag', '--from', '@s1:e1', '--to', '@s1:e2', '--to-xy', '2,2'])).toBe(
      'デスクトップ操作の実行を拒否した: drag の --to と --to-xy は同時に指定できない（部品の指定と座標の指定は、どちらか片方だけにする）。',
    );
    for (const argv of [
      ['--headed', 'drag', '--from', '@s1:e1', '--to', '@s1:e2'],
      ['--headed', 'drag', '--from-xy', '1,1', '--to-xy', '2,2'],
      ['--headed', 'drag', '--from', '@s1:e1', '--to-xy', '2,2'],
      ['--headed', 'hover', '@s1:e1'],
      ['--headed', 'hover', '--xy', '1,1'],
      batch([{ command: 'drag', args: { from: '@s1:e1', to_xy: '2,2' } }]),
      batch([{ command: 'hover', args: { ref_id: '@s1:e1' } }]),
    ])
      expect(refused(argv)).toBeNull();
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
    [['press', 'return', '--app', 'notepad']],
    [['--headed', 'press', '7', '--window-id', 'w-1']],
    [['batch', '[{"command":"press","args":{"combo":"return","window_id":"w-1"}}]']],
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
    // Keys or text that name no window or part reach whatever is in front.
    [
      ['press', '7', '--headed'],
      'press の対象の窓が無い（キーはいちばん手前の窓に届くため、--window-id か --app で対象の窓を指定する）',
    ],
    [['press', 'return'], 'press の対象の窓が無い'],
    [['press', 'return', '--app', ' '], 'press の対象の窓が無い'],
    [['--headed', 'type'], 'type の対象の部品が無い'],
    [['key-down', 'shift'], 'key-down は対象の窓を指定できない'],
    [['--session', 's1', 'key-up', 'shift'], 'key-up は対象の窓を指定できない'],
    [
      ['batch', '[{"command":"press","args":{"combo":"7"}}]'],
      'batch の中の press の対象の窓が無い（キーはいちばん手前の窓に届くため、window_id か app で対象の窓を指定する）',
    ],
    [['batch', '[{"command":"type","args":{"text":"x"}}]'], 'batch の中の type の対象の部品が無い'],
    [['batch', '[{"command":"key-down","args":{"key":"shift"}}]'], 'batch の中の key-down は'],
  ])('refuses %j', (argv, reason) => {
    const refusal = refused(argv);
    expect(refusal).toMatch(/^デスクトップ操作の実行を拒否した: .+。$/u);
    expect(refusal).toContain(reason);
  });
});

describe('desktop-control runs that touch no other app', () => {
  const roots = ['C:\\work\\repo'];
  const lookup = { platform: 'win32' as const, realpath: (path: string) => path };

  // Only print the bundled guides, help, the version or the binary's own status.
  it.each([
    [['skills', 'get', 'desktop']],
    [['skills', 'get', 'desktop', 'commands-system']],
    [['skills', 'get', 'platform']],
    [['skills', 'get', 'platform', '--full']],
    [['skills']],
    [['skills', 'list']],
    [['skills', 'path']],
    [['status']],
    [['version']],
    [['--version']],
    [['-V']],
    [['--help']],
    [['help']],
    [['help', 'launch']],
    [['help', 'skills', 'get']],
    [['skills', 'get', 'jev']],
    // A guide's reference, by its name or by its path as the guides write it.
    [['skills', 'get', 'agent-desktop-windows']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references/troubleshooting.md']],
    [['skills', 'get', 'windows', 'shell-and-overlay']],
    [['skills', 'get', 'platform', 'references/permissions-and-elevation.md']],
    [['skills', 'get', 'desktop', 'references/workflows.md']],
    [['skills', 'get', 'agent-desktop-linux', 'references/troubleshooting.md']],
    [['launch', '--help']],
    [['snapshot', '--help']],
    [['select', '--help']],
    [['snapshot', '-h']],
    [['skills', 'get', '--help']],
    [['permissions']],
  ])('%j needs no card', (argv) => {
    expect(desktopControlArgvRefusal(argv, roots, lookup)).toBeNull();
    expect(desktopControlArgvIsInert(argv)).toBe(true);
  });

  it.each([
    // Reading the screen or operating it.
    [['list-windows']],
    [['list-apps']],
    [['snapshot']],
    [['snapshot', '--window-id', 'w1']],
    [['launch', 'notepad']],
    [['click', '@s1:e3']],
    [['set-value', '@s1:e3', 'text']],
    [['batch', '[{"command":"status"}]']],
    [['batch', '--help']],
    [['session', 'list']],
    [['session']],
    // Options shared by every command keep the card, even on a status check.
    [['--headed', 'status']],
    [['--session', 's1', 'status']],
    [['status', '--session=s1']],
    [['-w', 'w1', 'skills', 'get', 'desktop']],
    [['-v', 'version']],
    // Help that comes with anything else, or a version option on a command.
    [['launch', 'notepad', '--help']],
    [['snapshot', '--compact', '-h']],
    [['launch', '-V']],
    [['status', 'extra']],
    // Positionals are closed in code, not left to how the binary answers them.
    [['skills', 'get', 'desktop', '../x']],
    [['skills', 'get', 'C:\\Windows\\win.ini']],
    [['skills', 'get', 'desktop', 'a', 'b']],
    // A reference only by its exact name or path, among the ones that skill carries.
    [['skills', 'get', 'desktop', 'references/../SKILL.md']],
    [['skills', 'get', 'desktop', 'references/../../agent-desktop-windows/SKILL.md']],
    [['skills', 'get', 'agent-desktop-windows', '../references/chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', '/references/chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', './references/chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references\\chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references//chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'C:\\references\\chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'C:references/chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', '\\\\server\\share\\x.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium-and-electron.md:x']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium-and-electron.txt']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium-and-electron.md.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium-and-electron']],
    [['skills', 'get', 'agent-desktop-windows', 'chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references/Chromium-and-Electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'References/chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium-and-electron.md ']],
    [['skills', 'get', 'agent-desktop-windows', ' references/chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium and electron.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references/unknown.md']],
    [['skills', 'get', 'agent-desktop-windows', 'unknown']],
    [['skills', 'get', 'agent-desktop-windows', 'references/workflows.md']],
    [['skills', 'get', 'desktop', 'references/chromium-and-electron.md']],
    [['skills', 'get', 'jev', 'references/workflows.md']],
    [['skills', 'get', 'Agent-Desktop-Windows', 'references/chromium-and-electron.md']],
    [['skills', 'get', 'agent-desktop-unknown', 'references/troubleshooting.md']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium-and-electron.md', 'x']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium-and-electron.md', '--full']],
    [['skills', 'get', 'agent-desktop-windows', '--full', 'troubleshooting']],
    [['skills', 'get', 'agent-desktop-windows', 'references/chromium-and-electron.md', '-h']],
    [['skills', 'get', '--session', 's1', 'windows', 'references/troubleshooting.md']],
    [['skills', 'get', 'windows', '--', 'references/troubleshooting.md']],
    [['skills', 'get', 'unknown']],
    [['skills', 'get', 'Desktop']],
    [['skills', 'get', 'desktop', 'with space']],
    [['skills', 'get', 'desktop', 'tab\tname']],
    [['skills', 'path', 'x']],
    [['skills', 'list', 'x']],
    [['version', 'x']],
    [['permissions', 'x']],
    [['help', '../x']],
    [['help', 'notacommand']],
    [['help', 'mcp']],
    [['help', 'launch', 'notepad']],
    [['help', 'skills', 'get', 'desktop']],
    [['skills', 'get', 'desktop', '--', 'x']],
    [[]],
    // Refused arguments are never inert.
    [['permissions', '--request']],
    [['permissions', '--guide']],
    [['skills', 'get', 'desktop', '--out', 'x']],
    [['mcp']],
    [['trace']],
  ])('%j keeps the card', (argv) => {
    expect(desktopControlArgvIsInert(argv)).toBe(false);
  });

  it('knows each bundled guide by the references the binary carries for it', () => {
    const skills = join(__dirname, '..', '..', 'desktop-control', 'skills');
    const embedded = readFileSync(
      join(skills, '..', 'crates', 'core', 'src', 'commands', 'skills.rs'),
      'utf8',
    );
    const guides = readdirSync(skills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name);
    expect(guides.sort()).toEqual(
      [
        'agent-desktop',
        'agent-desktop-ffi',
        'agent-desktop-linux',
        'agent-desktop-macos',
        'agent-desktop-windows',
        'jev-desktop',
      ].sort(),
    );
    for (const guide of guides) {
      const folder = join(skills, guide, 'references');
      const files = existsSync(folder) ? readdirSync(folder) : [];
      for (const file of files) expect(embedded).toContain(`skills/${guide}/references/${file}"`);
      const names = files.map((file) => file.replace(/\.md$/u, '')).sort();
      expect([...(DESKTOP_CONTROL_SKILL_REFERENCES.get(guide) ?? ['missing'])].sort()).toEqual(
        names,
      );
      // The short name (`windows`) carries the same ones as the full name.
      const alias =
        guide === 'jev-desktop' ? 'jev' : guide.replace(/^agent-/u, '').replace(/^desktop-/u, '');
      expect([...(DESKTOP_CONTROL_SKILL_REFERENCES.get(alias) ?? ['missing'])].sort()).toEqual(
        names,
      );
      for (const name of names) {
        expect(desktopControlArgvIsInert(['skills', 'get', guide, `references/${name}.md`])).toBe(
          true,
        );
        expect(desktopControlArgvIsInert(['skills', 'get', alias, name])).toBe(true);
      }
    }
    expect([...DESKTOP_CONTROL_SKILL_REFERENCES.get('platform')!]).toEqual([
      ...DESKTOP_CONTROL_SKILL_REFERENCES.get('agent-desktop-windows')!,
    ]);
    expect(DESKTOP_CONTROL_SKILL_REFERENCES.size).toBe(guides.length * 2 + 1);
  });
});

describe('shipped desktop-control path', () => {
  it('recognizes a recorded command of the shipped binary only, for the timeline', () => {
    expect(isShippedDesktopControlPath(PACKAGED, packaged)).toBe(true);
    expect(isShippedDesktopControlPath(PACKAGED.toUpperCase(), packaged)).toBe(true);
    expect(isShippedDesktopControlPath('C:\\Windows\\System32\\cmd.exe', packaged)).toBe(false);
    // A shipped file whose bytes are not the pinned ones is not it.
    expect(isShippedDesktopControlPath(PACKAGED, { ...packaged, contentDigest: digests({}) })).toBe(
      false,
    );
  });
});

describe('desktop-control launch by a Start menu name', () => {
  const roots = ['C:\\work\\repo'];
  const RABBIT = 'C:\\Program Files\\RabbitMail\\rabbitmail-desktop.exe';
  const files = new Set(
    [
      'C:\\Windows\\System32\\calc.exe',
      'C:\\Windows\\System32\\charmap.exe',
      RABBIT,
      'C:\\Program Files\\Other\\other.exe',
      'C:\\Program Files\\Viewer\\viewer.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\work\\repo\\build\\tool.exe',
      'C:\\Program Files\\Script\\run.cmd',
      'C:\\Program Files\\Rabbit Notes\\notes.exe',
    ].map((path) => path.toLowerCase()),
  );
  const shortcut = (name: string, target: string, args = '') => ({ name, target, args });
  const start = [
    shortcut('RabbitMail', RABBIT),
    // The same executable for all users and for this user is one target.
    shortcut('rabbitmail ', '%ProgramFiles%\\RabbitMail\\rabbitmail-desktop.exe'),
    shortcut('Rabbit Notes', 'C:\\Program Files\\Rabbit Notes\\notes.exe'),
    shortcut('Twice', 'C:\\Program Files\\Other\\other.exe'),
    shortcut('Twice', 'C:\\Program Files\\Viewer\\viewer.exe'),
    shortcut('With Arguments', 'C:\\Program Files\\Other\\other.exe', '--profile x'),
    shortcut('Script', 'C:\\Program Files\\Script\\run.cmd'),
    shortcut('Chained', 'C:\\Users\\me\\Desktop\\RabbitMail.lnk'),
    shortcut('Folder', 'C:\\Program Files\\RabbitMail'),
    shortcut('Web', 'https://example.test/'),
    shortcut('Unknown Variable', '%NOT_SET%\\other.exe'),
    shortcut('Missing File', 'C:\\Program Files\\Gone\\gone.exe'),
    shortcut(
      'Windows PowerShell',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ),
    shortcut('Workspace Tool', 'C:\\work\\repo\\build\\tool.exe'),
  ];
  const lookup = {
    platform: 'win32' as const,
    realpath: (path: string) => path,
    environment: { SystemRoot: 'C:\\Windows', PROGRAMFILES: 'C:\\Program Files' },
    isFile: (path: string) => files.has(path.toLowerCase()),
    startMenuShortcuts: () => start,
  };
  const byName = (
    argv: string[],
    given: Parameters<typeof desktopControlLaunchByName>[2] = lookup,
  ) => desktopControlLaunchByName(argv, roots, given);
  const refusalOf = (argv: string[]) => {
    const result = byName(argv);
    return result !== null && 'refusal' in result ? result.refusal : null;
  };

  it('replaces a name that one Start menu executable answers with its absolute path', () => {
    expect(byName(['launch', 'RabbitMail'])).toEqual({ argv: ['launch', RABBIT] });
    // Letter case and surrounding spaces do not matter; the options stay where they were.
    expect(byName(['launch', '--timeout', '5000', ' rabbitmail ', '--no-attach'])).toEqual({
      argv: ['launch', '--timeout', '5000', RABBIT, '--no-attach'],
    });
    expect(byName(['launch', '--activate', 'RabbitMail'])).toEqual({
      argv: ['launch', '--activate', RABBIT],
    });
    // The replaced arguments pass every check of an absolute path.
    expect(desktopControlArgvRefusal(['launch', RABBIT], roots, lookup)).toBeNull();
  });

  it('keeps names of the system folders and absolute paths as they are', () => {
    for (const argv of [
      ['launch', 'calc'],
      ['launch', 'charmap.exe'],
      ['launch', RABBIT],
      ['launch', 'C:\\Program Files\\Other\\other.exe'],
      ['list-windows', '--app', 'RabbitMail'],
      ['launch', '--help'],
    ])
      expect(byName(argv)).toBeNull();
  });

  it('does nothing off Windows or when the Start menu is not read', () => {
    expect(byName(['launch', 'RabbitMail'], { ...lookup, platform: 'darwin' })).toBeNull();
    expect(
      byName(['launch', 'RabbitMail'], { ...lookup, startMenuShortcuts: () => null }),
    ).toBeNull();
  });

  it('refuses a name it cannot find, naming similar Start menu apps', () => {
    expect(refusalOf(['launch', 'RabbitMale'])).toBe(
      'デスクトップ操作の実行を拒否した: 「RabbitMale」という名前のアプリが、Windows の標準のフォルダーにもスタートメニューにも無い（スタートメニューにある似た名前: RabbitMail）。そのどれかの名前か、実行ファイルの絶対パスで launch する。',
    );
    expect(refusalOf(['launch', 'Rabbit'])).toContain('似た名前: RabbitMail、Rabbit Notes）');
    // Shortcuts that could not be launched are not offered.
    expect(refusalOf(['launch', 'Twise'])).not.toContain('Twice');
    expect(refusalOf(['launch', 'Windows PowerShel'])).not.toContain('Windows PowerShell');
    expect(refusalOf(['launch', 'zzzzzzzz'])).toBe(
      'デスクトップ操作の実行を拒否した: 「zzzzzzzz」という名前のアプリが、Windows の標準のフォルダーにもスタートメニューにも無い（似た名前も無い）。実行ファイルの絶対パスで launch する。',
    );
    const many = Array.from({ length: 8 }, (_, at) =>
      shortcut(`Rabbit ${at}`, 'C:\\Program Files\\Rabbit Notes\\notes.exe'),
    );
    const listed = byName(['launch', 'Rabbit'], { ...lookup, startMenuShortcuts: () => many });
    expect(listed).toMatchObject({ refusal: expect.stringContaining('Rabbit 4）') });
    expect(listed).not.toMatchObject({ refusal: expect.stringContaining('Rabbit 5') });
  });

  it('refuses a name whose shortcuts point to different executables', () => {
    expect(refusalOf(['launch', 'Twice'])).toBe(
      'デスクトップ操作の実行を拒否した: スタートメニューの「Twice」が違う実行ファイルを指している（C:\\Program Files\\Other\\other.exe、C:\\Program Files\\Viewer\\viewer.exe）。起動するものの絶対パスで launch する。',
    );
  });

  it('uses no shortcut with arguments, or to anything but an existing .exe at an absolute path', () => {
    for (const name of [
      'With Arguments',
      'Script',
      'Chained',
      'Folder',
      'Web',
      'Unknown Variable',
      'Missing File',
    ])
      expect(refusalOf(['launch', name])).toBe(
        `デスクトップ操作の実行を拒否した: スタートメニューの「${name}」は、引数の無い .exe へのショートカットではないので使えない。実行ファイルの絶対パスで launch する。`,
      );
  });

  it('judges the executable a shortcut points to as an absolute path, by its own name', () => {
    expect(refusalOf(['launch', 'Windows PowerShell'])).toBe(
      'デスクトップ操作の実行を拒否した: powershell.exe は起動できない（端末・shell・設定の道具）。',
    );
    expect(refusalOf(['launch', 'Workspace Tool'])).toBe(
      'デスクトップ操作の実行を拒否した: launch で Workspace の中の実行ファイルは起動できない。',
    );
  });

  it('replaces each launch of a batch the same way, and refuses the batch on any refusal', () => {
    const batch = (entries: unknown) => ['batch', JSON.stringify(entries)];
    expect(
      byName([
        'batch',
        '--stop-on-error',
        JSON.stringify([
          { command: 'launch', args: { app: 'RabbitMail', no_attach: true } },
          { command: 'launch', args: { app: 'calc' } },
          { command: 'list-windows', args: { app: 'RabbitMail' } },
        ]),
      ]),
    ).toEqual({
      argv: [
        'batch',
        '--stop-on-error',
        JSON.stringify([
          { command: 'launch', args: { app: RABBIT, no_attach: true } },
          { command: 'launch', args: { app: 'calc' } },
          { command: 'list-windows', args: { app: 'RabbitMail' } },
        ]),
      ],
    });
    expect(byName(batch([{ command: 'launch', args: { app: 'calc' } }]))).toBeNull();
    expect(byName(batch([{ command: 'launch', args: { app: 'Twice' } }]))).toMatchObject({
      refusal: expect.stringContaining('違う実行ファイル'),
    });
    expect(
      byName(batch([{ command: 'launch', args: { app: 'Windows PowerShell' } }])),
    ).toMatchObject({ refusal: expect.stringContaining('powershell.exe は起動できない') });
  });
});
