import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig, ResolvedForgeConfig } from '@electron-forge/shared-types';
import config, {
  desktopControlResources,
  desktopControlSource,
  assertNativePackagingHost,
  createDMGContents,
  DMG_BACKGROUND_PATH,
  DMG_ICON_SIZE,
  DMG_WINDOW_SIZE,
  FONT_LICENSE_RESOURCES,
  macSignOptionsForFile,
  resolveWindowsSignOptions,
  NATIVE_ASAR_UNPACK_GLOB,
  refreshPackagedDesktopControlDigest,
  refreshPackagedSandboxRunnerDigest,
  shouldIgnoreFromPackage,
  verifyDesktopControlBinary,
  verifyBundledNodeResources,
} from './forge.config';
import viteMainConfig, { macAutoUpdateEligibleForIdentity } from './vite.main.config';
import { planWindowsWizardInstaller, SQUIRREL_SETUP_EXE } from './windows-wizard-installer';
import {
  probeSandboxRunner,
  sandboxRunnerPath,
  verifySandboxRunnerDigest,
} from './src/main/sandbox-runner';

// A test may answer execFileSync calls itself (the macOS postPackage test never runs codesign);
// every call it does not answer reaches the real child_process.
const childProcessMock = vi.hoisted(() => ({
  answer: undefined as ((file: string, args: readonly string[]) => { result: unknown } | undefined) | undefined,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  const execFileSync = (file: string, ...rest: unknown[]) => {
    const answered = childProcessMock.answer?.(
      file,
      Array.isArray(rest[0]) ? (rest[0] as string[]) : [],
    );
    if (answered !== undefined) return answered.result;
    return (original.execFileSync as (file: string, ...rest: unknown[]) => unknown)(file, ...rest);
  };
  return { ...original, execFileSync: execFileSync as typeof original.execFileSync };
});

// The desktop-control executable's build output, which the package ships under the same name.
const DESKTOP_CONTROL_SOURCE = resolve(
  __dirname,
  'desktop-control',
  'build',
  'Release',
  'sprint-coder-desktop-control.exe',
);
const MAC_DESKTOP_CONTROL_SOURCE = resolve(
  __dirname,
  'desktop-control',
  'build',
  'Release',
  'sprint-coder-desktop-control',
);
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('desktop package icon', () => {
  it('points Electron Packager at real macOS and Windows icon files', () => {
    const iconPath = resolve(__dirname, 'assets', 'sprint-coder-icon');

    expect(config.packagerConfig?.icon).toBe(iconPath);
    expect(existsSync(`${iconPath}.icns`)).toBe(true);
    expect(existsSync(`${iconPath}.ico`)).toBe(true);
    expect(readFileSync(`${iconPath}.icns`).subarray(0, 4).toString('ascii')).toBe('icns');
    expect([...readFileSync(`${iconPath}.ico`).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  });
});

describe('macOS DMG presentation', () => {
  it('uses branded standard and Retina backgrounds with a balanced drag-to-install layout', () => {
    const retinaBackground = DMG_BACKGROUND_PATH.replace(/\.png$/, '@2x.png');
    const background = readFileSync(DMG_BACKGROUND_PATH);
    const retina = readFileSync(retinaBackground);
    const pngDimensions = (png: Buffer) => ({
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    });

    expect([...background.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([...retina.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngDimensions(background)).toEqual(DMG_WINDOW_SIZE);
    expect(pngDimensions(retina)).toEqual({ width: 1316, height: 996 });
    expect(DMG_ICON_SIZE).toBe(112);
    expect(createDMGContents('/tmp/Sprint Coder.app')).toEqual([
      { x: 190, y: 300, type: 'file', path: '/tmp/Sprint Coder.app' },
      { x: 468, y: 300, type: 'link', path: '/Applications' },
    ]);
  });
});

describe('native package target', () => {
  it('unpacks versioned Linux shared libraries required by Sharp', () => {
    expect(NATIVE_ASAR_UNPACK_GLOB).toContain('so.*');
    expect(config.packagerConfig?.asar).toEqual({ unpack: NATIVE_ASAR_UNPACK_GLOB });
  });

  it('rejects cross-platform packages before Forge can emit an incomplete artifact', () => {
    const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';

    expect(() => assertNativePackagingHost(process.platform)).not.toThrow();
    expect(() => assertNativePackagingHost(otherPlatform)).toThrow(
      'Cross-platform packaging is unsupported',
    );
  });

  it('excludes the retired model runtime while retaining native packaging hooks', () => {
    expect(config.packagerConfig?.extraResource).not.toEqual(
      expect.arrayContaining([expect.stringContaining('managed-local')]),
    );
    expect(shouldIgnoreFromPackage('/managed-local/build/legacy-runtime')).toBe(true);
    expect(typeof config.hooks?.postPackage).toBe('function');
  });

  it('ships the SIL Open Font License text of every bundled font beside the app', () => {
    // The fonts themselves travel inside the renderer build (.vite), which the package keeps.
    expect(shouldIgnoreFromPackage('/.vite/renderer/main_window/assets/Geist.woff2')).toBe(false);
    expect(FONT_LICENSE_RESOURCES.map((path) => path.replace(/\\/g, '/').split('/').pop())).toEqual(
      ['geist-ofl.txt', 'ibm-plex-sans-jp-ofl.txt', 'plemoljp-ofl.txt'],
    );
    expect(config.packagerConfig?.extraResource).toEqual(
      expect.arrayContaining(FONT_LICENSE_RESOURCES),
    );
    for (const path of FONT_LICENSE_RESOURCES) {
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(text).toMatch(/^Copyright /m);
    }
  });

  it.runIf(process.platform === 'win32')(
    'accepts only the pinned signed Node executable used by Windows packages',
    () => {
      expect(() => verifyBundledNodeResources()).not.toThrow();
    },
  );
});

describe('Windows release signing', () => {
  it('selects a CurrentUser code-signing certificate without exporting its private key', () => {
    expect(
      resolveWindowsSignOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: '4f9b 4eaa cd58 21f7 e84f a525 955a 904d 5eb7 7826',
      }),
    ).toEqual({
      signWithParams: '/sha1 4F9B4EAACD5821F7E84FA525955A904D5EB77826',
      description: 'Sprint Coder',
    });
  });

  it('rejects malformed store thumbprints and incomplete PFX settings', () => {
    expect(() =>
      resolveWindowsSignOptions({ SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: 'not-a-thumbprint' }),
    ).toThrow('40-character SHA-1 thumbprint');
    expect(() =>
      resolveWindowsSignOptions({ SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'release.pfx' }),
    ).toThrow('must be provided together');
    expect(() =>
      resolveWindowsSignOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'release.pfx',
        SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD: 'secret',
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: 'not-a-thumbprint',
      }),
    ).toThrow('40-character SHA-1 thumbprint');
    expect(() =>
      resolveWindowsSignOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'release.pfx',
        SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD: 'secret',
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: '4F9B4EAACD5821F7E84FA525955A904D5EB77826',
      }),
    ).toThrow('mutually exclusive');
  });
});

describe('macOS auto-update signing gate', () => {
  it('enables the compiled updater only for a real signing identity', () => {
    expect(macAutoUpdateEligibleForIdentity(undefined)).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('')).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('-')).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('Developer ID Application: Sprint Coder')).toBe(true);
  });
});

describe('retired model runtime package boundary', () => {
  it('does not compile a sidecar pin into Main', () => {
    expect(viteMainConfig.define).not.toHaveProperty('__SPRINT_CODER_MANAGED_LOCAL_SIDECAR_PINS__');
  });
});

describe('macOS sandbox runner sealing', () => {
  it.runIf(process.platform === 'win32')(
    'probes the real Windows helper after sealing its changed PE bytes',
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-real-runner-seal-'));
      try {
        const resources = join(root, 'resources');
        const runner = join(resources, 'sprint-coder-sandbox-runner.exe');
        mkdirSync(resources, { recursive: true });
        copyFileSync(sandboxRunnerPath(), runner);
        copyFileSync(`${sandboxRunnerPath()}.sha256`, `${runner}.sha256`);
        appendFileSync(runner, 'SIGNING_BYTE_MUTATION_FIXTURE');
        await expect(probeSandboxRunner(runner)).resolves.toMatchObject({ available: false });
        refreshPackagedSandboxRunnerDigest(root, 'win32');
        await expect(probeSandboxRunner(runner)).resolves.toMatchObject({
          available: true,
          backend: 'windows-appcontainer',
        });
        appendFileSync(runner, 'TAMPER_FIXTURE');
        await expect(probeSandboxRunner(runner)).resolves.toMatchObject({ available: false });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('refreshes Windows runner bytes in the real postPackage hook before other native verification', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-windows-runner-seal-'));
    try {
      const resources = join(root, 'resources');
      const runner = join(resources, 'sprint-coder-sandbox-runner.exe');
      mkdirSync(resources, { recursive: true });
      writeFileSync(runner, 'unsigned-runner');
      writeFileSync(
        `${runner}.sha256`,
        `${createHash('sha256').update('unsigned-runner').digest('hex')}\n`,
      );
      expect(() => verifySandboxRunnerDigest(runner)).not.toThrow();
      // Deterministic signing-byte mutation; no certificate or signing service is used.
      writeFileSync(runner, 'post-signing-runner');
      expect(() => verifySandboxRunnerDigest(runner)).toThrow('digest mismatch');
      // The desktop-control executable the package ships next to it, resealed in the same hook.
      const desktop = join(resources, 'sprint-coder-desktop-control.exe');
      writeFileSync(desktop, 'unsigned-desktop-control');
      writeFileSync(`${desktop}.sha256`, `${sha256('unsigned-desktop-control')}\n`);
      expect(() => verifyDesktopControlBinary(desktop)).not.toThrow();
      writeFileSync(desktop, 'post-signing-desktop-control');
      expect(() => verifyDesktopControlBinary(desktop)).toThrow('does not match its sealed digest');
      const resolvedConfig: ResolvedForgeConfig = {
        ...config,
        plugins: config.plugins ?? [],
        rebuildConfig: config.rebuildConfig ?? {},
        packagerConfig: config.packagerConfig ?? {},
        makers: config.makers ?? [],
        publishers: config.publishers ?? [],
        pluginInterface: {
          triggerHook: async () => undefined,
          getHookListrTasks: async () => [],
          triggerMutatingHook: async (_name, item) => item,
          overrideStartLogic: async () => {
            throw new Error('Unexpected plugin invocation');
          },
        },
      };
      await expect(
        config.hooks!.postPackage!(resolvedConfig, {
          platform: 'win32',
          arch: 'x64',
          outputPaths: [root],
        }),
      ).resolves.toBeUndefined();
      expect(() => verifySandboxRunnerDigest(runner)).not.toThrow();
      writeFileSync(runner, 'tampered-after-package');
      expect(() => verifySandboxRunnerDigest(runner)).toThrow('digest mismatch');
      // The desktop-control seal now holds the signed bytes, which the app checks at run time.
      expect(readFileSync(`${desktop}.sha256`, 'utf8')).toBe(
        `${sha256('post-signing-desktop-control')}\n`,
      );
      expect(() => verifyDesktopControlBinary(desktop)).not.toThrow();
      appendFileSync(desktop, 'tampered-after-package');
      expect(() => verifyDesktopControlBinary(desktop)).toThrow('does not match its sealed digest');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('regenerates the packaged digest from the post-signing runner bytes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-runner-seal-'));
    try {
      const appPath = resolve(root, 'Sprint Coder.app');
      const resources = resolve(appPath, 'Contents', 'Resources');
      const runner = resolve(resources, 'sprint-coder-sandbox-runner');
      mkdirSync(resources, { recursive: true });
      writeFileSync(runner, 'post-signing-runner-bytes');
      writeFileSync(`${runner}.sha256`, `${'0'.repeat(64)}\n`);

      const digest = refreshPackagedSandboxRunnerDigest(appPath);

      expect(digest).toBe(createHash('sha256').update('post-signing-runner-bytes').digest('hex'));
      expect(readFileSync(`${runner}.sha256`, 'utf8')).toBe(`${digest}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('desktop-control resources', () => {
  const LICENSE = resolve(__dirname, '..', '..', 'docs', 'licenses', 'desktop-control-license.txt');

  it('ships only the Windows x64 and macOS arm64 build output, its seal and its license, under their build names', () => {
    expect(desktopControlSource('win32', 'x64')).toBe(DESKTOP_CONTROL_SOURCE);
    expect(desktopControlResources('win32', 'x64')).toEqual([
      DESKTOP_CONTROL_SOURCE,
      `${DESKTOP_CONTROL_SOURCE}.sha256`,
      LICENSE,
    ]);
    expect(desktopControlSource('darwin', 'arm64')).toBe(MAC_DESKTOP_CONTROL_SOURCE);
    expect(desktopControlResources('darwin', 'arm64')).toEqual([
      MAC_DESKTOP_CONTROL_SOURCE,
      `${MAC_DESKTOP_CONTROL_SOURCE}.sha256`,
      LICENSE,
    ]);
    for (const [platform, arch] of [
      ['win32', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
    ] as const) {
      expect(desktopControlSource(platform, arch)).toBeNull();
      expect(desktopControlResources(platform, arch)).toEqual([]);
    }
    const extra = (config.packagerConfig?.extraResource ?? []) as string[];
    const shipped = [DESKTOP_CONTROL_SOURCE, `${DESKTOP_CONTROL_SOURCE}.sha256`, LICENSE];
    const macShipped = [
      MAC_DESKTOP_CONTROL_SOURCE,
      `${MAC_DESKTOP_CONTROL_SOURCE}.sha256`,
      LICENSE,
    ];
    expect(extra.filter((path) => shipped.includes(path) || macShipped.includes(path))).toEqual(
      process.platform === 'win32' && process.arch === 'x64'
        ? shipped
        : process.platform === 'darwin' && process.arch === 'arm64'
          ? macShipped
          : [],
    );
    expect(config.packagerConfig?.afterCopyExtraResources).toHaveLength(1);
    // The source and its Cargo output never enter the package.
    expect(shouldIgnoreFromPackage('/desktop-control/src/main.rs')).toBe(true);
    expect(shouldIgnoreFromPackage('/desktop-control/target/release/app.exe')).toBe(true);
    // The third-party license stays shipped in full, with its source.
    const license = readFileSync(LICENSE, 'utf8');
    expect(license).toContain('agent-desktop 1.2.0');
    expect(license).toContain('https://github.com/vercel-labs/agent-desktop');
    expect(license).toContain('2b0a7334fc111730454b726e6800aa41cdafc093');
    expect(license).toContain('apps/desktop/desktop-control/VENDORED.md');
    expect(license).toContain('Apache License');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
  });

  it('checks the copied bytes against their build seal before signing, in the real hook', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-desktop-control-copy-'));
    const [hook] = config.packagerConfig!.afterCopyExtraResources!;
    const runHook = (platform: string, arch: string) =>
      new Promise<void>((done, fail) =>
        hook!(root, '0.0.0', platform, arch, (error) => (error ? fail(error) : done())),
      );
    try {
      const resources = join(root, 'resources');
      mkdirSync(resources, { recursive: true });
      const shipped = join(resources, 'sprint-coder-desktop-control.exe');
      writeFileSync(shipped, 'built-desktop-control');
      writeFileSync(`${shipped}.sha256`, `${sha256('built-desktop-control')}\n`);
      await expect(runHook('win32', 'x64')).resolves.toBeUndefined();
      appendFileSync(shipped, 'x');
      await expect(runHook('win32', 'x64')).rejects.toThrow('does not match its sealed digest');
      // Nothing is checked for a target it is not shipped for.
      await expect(runHook('linux', 'x64')).resolves.toBeUndefined();
      await expect(runHook('win32', 'arm64')).resolves.toBeUndefined();
      rmSync(shipped);
      await expect(runHook('win32', 'x64')).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks the copied macOS bytes inside the staged .app before signing, in the real hook', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-desktop-control-mac-copy-'));
    const [hook] = config.packagerConfig!.afterCopyExtraResources!;
    const runHook = (platform: string, arch: string) =>
      new Promise<void>((done, fail) =>
        hook!(root, '0.0.0', platform, arch, (error) => (error ? fail(error) : done())),
      );
    try {
      // Packager hands the hook its staging directory, which holds the renamed .app.
      await expect(runHook('darwin', 'arm64')).rejects.toThrow('Expected one macOS app bundle');
      const resources = join(root, 'Sprint Coder.app', 'Contents', 'Resources');
      mkdirSync(resources, { recursive: true });
      const shipped = join(resources, 'sprint-coder-desktop-control');
      writeFileSync(shipped, 'built-desktop-control');
      writeFileSync(`${shipped}.sha256`, `${sha256('built-desktop-control')}\n`);
      await expect(runHook('darwin', 'arm64')).resolves.toBeUndefined();
      appendFileSync(shipped, 'x');
      await expect(runHook('darwin', 'arm64')).rejects.toThrow('does not match its sealed digest');
      // Intel macOS does not ship it.
      await expect(runHook('darwin', 'x64')).resolves.toBeUndefined();
      rmSync(shipped);
      await expect(runHook('darwin', 'arm64')).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('signs the macOS executable with hardened runtime and an empty entitlement set', () => {
    const app = '/out/Sprint Coder-darwin-arm64/Sprint Coder.app';
    expect(macSignOptionsForFile(`${app}/Contents/Resources/sprint-coder-desktop-control`)).toEqual(
      { entitlements: [], hardenedRuntime: true },
    );
    // The bundled Node keeps its own entitlements; other files keep osx-sign's defaults.
    expect(macSignOptionsForFile(`${app}/Contents/Resources/node`)).toEqual({
      entitlements: resolve(__dirname, 'entitlements.node.plist'),
    });
    expect(macSignOptionsForFile(`${app}/Contents/Resources/sprint-coder-sandbox-runner`)).toEqual(
      {},
    );
    expect(
      macSignOptionsForFile(`${app}/Contents/Resources/sprint-coder-desktop-control.sha256`),
    ).toEqual({});
  });

  it('fails the build when the executable is not the bytes its manifest seals', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-desktop-control-seal-'));
    try {
      const copy = join(root, 'sprint-coder-desktop-control.exe');
      writeFileSync(copy, 'desktop-control');
      writeFileSync(`${copy}.sha256`, `${sha256('desktop-control')}\n`);
      expect(() => verifyDesktopControlBinary(copy)).not.toThrow();
      appendFileSync(copy, 'x');
      expect(() => verifyDesktopControlBinary(copy)).toThrow('does not match its sealed digest');
      writeFileSync(`${copy}.sha256`, 'not-a-digest\n');
      expect(() => verifyDesktopControlBinary(copy)).toThrow('invalid digest manifest');
      rmSync(`${copy}.sha256`);
      expect(() => verifyDesktopControlBinary(copy)).toThrow();
      // A build that never ran gets the command to run, not a raw ENOENT.
      expect(() => verifyDesktopControlBinary(join(root, 'missing.exe'))).toThrow(
        'executable was not found; run npm run build:desktop-control first',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32' && process.arch === 'x64')(
    'has a real build output that agrees with its seal',
    () => {
      expect(() => verifyDesktopControlBinary(DESKTOP_CONTROL_SOURCE)).not.toThrow();
      expect(existsSync(DESKTOP_CONTROL_SOURCE)).toBe(true);
    },
  );

  it.runIf(
    process.platform === 'darwin' &&
      process.arch === 'arm64' &&
      existsSync(MAC_DESKTOP_CONTROL_SOURCE),
  )('has a real macOS build output that agrees with its seal', () => {
    expect(() => verifyDesktopControlBinary(MAC_DESKTOP_CONTROL_SOURCE)).not.toThrow();
  });

  it('reseals the packaged executable from its post-signing bytes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-desktop-control-reseal-'));
    try {
      const resources = join(root, 'resources');
      mkdirSync(resources, { recursive: true });
      const shipped = join(resources, 'sprint-coder-desktop-control.exe');
      writeFileSync(shipped, 'signed-desktop-control');
      writeFileSync(`${shipped}.sha256`, `${'0'.repeat(64)}\n`);
      expect(refreshPackagedDesktopControlDigest(root)).toBe(sha256('signed-desktop-control'));
      expect(readFileSync(`${shipped}.sha256`, 'utf8')).toBe(
        `${sha256('signed-desktop-control')}\n`,
      );
      rmSync(shipped);
      expect(() => refreshPackagedDesktopControlDigest(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reseals the macOS executable inside the .app from its post-signing bytes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-desktop-control-mac-reseal-'));
    try {
      const appPath = join(root, 'Sprint Coder.app');
      const resources = join(appPath, 'Contents', 'Resources');
      mkdirSync(resources, { recursive: true });
      const shipped = join(resources, 'sprint-coder-desktop-control');
      writeFileSync(shipped, 'signed-desktop-control');
      writeFileSync(`${shipped}.sha256`, `${'0'.repeat(64)}\n`);
      expect(refreshPackagedDesktopControlDigest(appPath, 'darwin')).toBe(
        sha256('signed-desktop-control'),
      );
      expect(readFileSync(`${shipped}.sha256`, 'utf8')).toBe(
        `${sha256('signed-desktop-control')}\n`,
      );
      // The Windows layout is not looked for inside a macOS bundle.
      expect(() => refreshPackagedDesktopControlDigest(appPath)).toThrow();
      rmSync(shipped);
      expect(() => refreshPackagedDesktopControlDigest(appPath, 'darwin')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('macOS postPackage desktop-control sealing', () => {
  const STALE_SEAL = `${'0'.repeat(64)}\n`;
  const RESEAL = '--preserve-metadata=identifier,entitlements,requirements';
  const resolvedConfigFor = (forgeConfig: ForgeConfig): ResolvedForgeConfig => ({
    ...forgeConfig,
    plugins: forgeConfig.plugins ?? [],
    rebuildConfig: forgeConfig.rebuildConfig ?? {},
    packagerConfig: forgeConfig.packagerConfig ?? {},
    makers: forgeConfig.makers ?? [],
    publishers: forgeConfig.publishers ?? [],
    pluginInterface: {
      triggerHook: async () => undefined,
      getHookListrTasks: async () => [],
      triggerMutatingHook: async (_name, item) => item,
      overrideStartLogic: async () => {
        throw new Error('Unexpected plugin invocation');
      },
    },
  });

  /**
   * Runs the real darwin postPackage hook on a fake `Sprint Coder.app`. The signing identity is
   * read when forge.config loads, so the module is loaded again under the given environment.
   * Every codesign call is recorded with the seals as they were at that moment, and never run.
   */
  async function runMacPostPackage(arch: 'arm64' | 'x64', identity: string | undefined) {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-mac-post-package-'));
    const appPath = join(root, 'Sprint Coder.app');
    const resources = join(appPath, 'Contents', 'Resources');
    const runner = join(resources, 'sprint-coder-sandbox-runner');
    const desktop = join(resources, 'sprint-coder-desktop-control');
    const node = join(resources, 'node');
    mkdirSync(resources, { recursive: true });
    writeFileSync(runner, 'signed-runner', { mode: 0o755 });
    writeFileSync(`${runner}.sha256`, STALE_SEAL);
    writeFileSync(desktop, 'signed-desktop-control', { mode: 0o755 });
    writeFileSync(`${desktop}.sha256`, STALE_SEAL);
    writeFileSync(node, 'fake-node', { mode: 0o755 });
    const codesign: { args: string[]; desktopSeal: string; runnerSeal: string }[] = [];
    childProcessMock.answer = (file, args) => {
      if (file === '/usr/bin/codesign') {
        // Ad-hoc signing rewrites a nested executable's bytes, as the real codesign does.
        if (args.at(-1) === desktop && !args.includes(RESEAL) && !args.includes('--verify'))
          appendFileSync(desktop, '+ad-hoc-signature');
        codesign.push({
          args: [...args],
          desktopSeal: readFileSync(`${desktop}.sha256`, 'utf8'),
          runnerSeal: readFileSync(`${runner}.sha256`, 'utf8'),
        });
        return { result: Buffer.alloc(0) };
      }
      // The packaged Node version check (BUNDLED_NODE_VERSION in forge.config.ts).
      if (file === node) return { result: 'v22.23.3\n' };
      return undefined;
    };
    try {
      vi.stubEnv('CI', '');
      vi.stubEnv('SPRINT_CODER_RELEASE', '');
      vi.stubEnv('SPRINT_CODER_ALLOW_ADHOC_CODESIGN', '');
      vi.stubEnv('SPRINT_CODER_CODESIGN_IDENTITY', identity);
      vi.resetModules();
      const { default: freshConfig } = await import('./forge.config');
      await expect(
        freshConfig.hooks!.postPackage!(resolvedConfigFor(freshConfig), {
          platform: 'darwin',
          arch,
          outputPaths: [root],
        }),
      ).resolves.toBeUndefined();
      const resealIndex = codesign.findIndex((call) => call.args.includes(RESEAL));
      expect(codesign.filter((call) => call.args.includes(RESEAL))).toHaveLength(1);
      const reseal = codesign[resealIndex]!;
      expect(reseal.args.at(-1)).toBe(appPath);
      expect(codesign.findIndex((call) => call.args.includes('--verify'))).toBeGreaterThan(
        resealIndex,
      );
      // The sandbox runner is resealed before the outer signature, on both architectures.
      expect(reseal.runnerSeal).toBe(`${sha256(readFileSync(runner))}\n`);
      return {
        appPath,
        codesign,
        desktop,
        desktopBytes: readFileSync(desktop),
        desktopSeal: readFileSync(`${desktop}.sha256`, 'utf8'),
        reseal,
        resealIndex,
      };
    } finally {
      childProcessMock.answer = undefined;
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('seals the ad-hoc signed Apple silicon helper before the outer re-seal with identity -', async () => {
    const run = await runMacPostPackage('arm64', undefined);
    const digest = `${sha256(run.desktopBytes)}\n`;
    expect(digest).not.toBe(STALE_SEAL);
    expect(run.desktopSeal).toBe(digest);
    // Already rewritten when the outer app signature was refreshed, so CodeResources covers it.
    expect(run.reseal.desktopSeal).toBe(digest);
    const sign = run.reseal.args.indexOf('--sign');
    expect(run.reseal.args[sign + 1]).toBe('-');
    expect(run.reseal.args).toContain('--timestamp=none');
    // Without a configured identity the hook ad-hoc signs the bundle first.
    expect(run.codesign.findIndex((call) => call.args.at(-1) === run.appPath)).toBeLessThan(
      run.resealIndex,
    );
    // Execute bits exist only off Windows, so only there does the ad-hoc signing reach the helper.
    if (process.platform !== 'win32') {
      expect(run.desktopBytes.toString()).toBe('signed-desktop-control+ad-hoc-signature');
      expect(
        run.codesign.findIndex(
          (call) => call.args.at(-1) === run.desktop && !call.args.includes('--verify'),
        ),
      ).toBeLessThan(run.resealIndex);
    }
  });

  it('seals the helper Packager signed before the outer re-seal with the configured identity', async () => {
    const identity = 'Developer ID Application: Fixture (FIXTURE123)';
    const run = await runMacPostPackage('arm64', identity);
    const digest = `${sha256('signed-desktop-control')}\n`;
    expect(run.desktopSeal).toBe(digest);
    expect(run.reseal.desktopSeal).toBe(digest);
    const sign = run.reseal.args.indexOf('--sign');
    expect(run.reseal.args[sign + 1]).toBe(identity);
    expect(run.reseal.args).toContain('--timestamp');
    expect(run.reseal.args).not.toContain('--timestamp=none');
    // @electron/osx-sign already signed the bundle in Packager; the hook signs nothing else.
    expect(run.resealIndex).toBe(0);
  });

  it('leaves the desktop-control seal alone on Intel macOS, which does not ship it', async () => {
    const run = await runMacPostPackage('x64', undefined);
    expect(run.desktopSeal).toBe(STALE_SEAL);
    expect(run.reseal.desktopSeal).toBe(STALE_SEAL);
  });
});

describe('release artifacts', () => {
  it('builds macOS and explicitly unsigned Windows artifacts in Actions', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/release-beta.yml'),
      'utf8',
    );
    const ciWorkflow = readFileSync(resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
    const macPackageJob = ciWorkflow.slice(
      ciWorkflow.indexOf('\n  package-macos:'),
      ciWorkflow.indexOf('\n  platform-tests:'),
    );
    const requiredJob = ciWorkflow.slice(ciWorkflow.indexOf('\n  required:'));
    const provisioner = readFileSync(resolve(__dirname, 'scripts/ensure-inno-setup.ps1'), 'utf8');
    const unsignedVerifier = readFileSync(
      resolve(__dirname, 'scripts/verify-unsigned-windows-release.ps1'),
      'utf8',
    );

    expect(workflow).toContain('apps/desktop/out/make/**/*.zip');
    expect(workflow).toContain('os: macos-latest');
    expect(workflow).not.toContain('os: ubuntu-latest');
    expect(workflow).toContain('os: windows-2022');
    expect(workflow).toContain("SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS: '1'");
    expect(workflow).toContain('mac_zip_count != 1');
    expect(workflow).not.toContain('linux_zip_count');
    expect(workflow).toContain('release-assets/RELEASES.json');
    expect(workflow).toContain('${#assets[@]} != 6');
    expect(workflow).toContain('--prerelease="${RELEASE_PRERELEASE}"');
    expect(workflow).toContain('--draft');
    expect(readFileSync(resolve(__dirname, 'forge.config.ts'), 'utf8')).toContain(
      "new MakerZIP({}, ['darwin', 'linux', 'win32'])",
    );
    expect(workflow).toMatch(
      /release:\n[\s\S]*?- name: Checkout\n\s+uses: actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/u,
    );
    expect(ciWorkflow).toContain('npx electron-forge package --platform=win32 --arch=x64');
    expect(ciWorkflow).toContain('npx electron-forge make --platform=win32 --arch=x64');
    expect(macPackageJob).not.toContain('if: github.event_name');
    expect(macPackageJob).toContain("if: needs.classify.outputs.distribution_required == 'true'");
    expect(requiredJob).toContain('package-macos,');
    expect(requiredJob).toContain('CI_JOB_RESULTS_JSON: ${{ toJSON(needs) }}');
    expect(requiredJob).toContain('run: node ci-scope.mjs gate');
    expect(ciWorkflow).toContain('Select checks from the complete change set');
    expect(ciWorkflow).not.toContain('SPRINT_CODER_MANAGED_LOCAL_LIVE');
    expect(ciWorkflow).not.toContain('SPRINT_CODER_MANAGED_LOCAL_CODING_LIVE');
    expect(ciWorkflow).toContain('./apps/desktop/scripts/verify-unsigned-windows-release.ps1');
    expect(unsignedVerifier).toContain('Sprint-Coder-Installer-$version.exe');
    expect(unsignedVerifier).toContain('Sprint-Coder-Setup.exe');
    expect(unsignedVerifier).toContain("$installerSignature.Status -ne 'NotSigned'");
    expect(unsignedVerifier).toContain("$appSignature.Status -ne 'NotSigned'");
    expect(provisioner).toContain('choco install innosetup --version=6.7.1');
    expect(provisioner).toContain('Get-AuthenticodeSignature -LiteralPath $compiler');
    expect(provisioner).toContain("$publisher -ne 'Pyrsys B.V.'");
    expect(provisioner).toContain(
      '4EFD84E6F1091B19321231743B9AA86482EFFD6D0BEA9F7A44DB6211154616F3',
    );
  });

  it.each(['0.7.0', '0.7.0-beta.15'])(
    'wraps the Squirrel bootstrapper in a versioned Windows setup wizard for %s',
    (version) => {
      const script = readFileSync(resolve(__dirname, 'installer/windows-wizard.iss'), 'utf8');
      const sourceSetupPath = resolve('out/make/squirrel.windows/x64', SQUIRREL_SETUP_EXE);
      const plan = planWindowsWizardInstaller([
        {
          platform: 'win32',
          arch: 'x64',
          packageJSON: { version },
          artifacts: [sourceSetupPath, resolve('out/make/squirrel.windows/x64/RELEASES')],
        },
      ]);

      expect(plan).toMatchObject({
        sourceSetupPath,
        outputPath: resolve(
          'out/make/squirrel.windows/x64',
          `Sprint-Coder-Installer-${version}.exe`,
        ),
        version,
      });
      expect(script).toContain('OutputBaseFilename=Sprint-Coder-Installer-{#AppVersion}');
      expect(script).toContain('WizardStyle=modern');
      expect(script).toContain('DisableWelcomePage=no');
      expect(script).toContain('DisableReadyPage=no');
      expect(script).toContain('DisableFinishedPage=no');
      expect(script).toContain('compiler:Languages\\Japanese.isl');
      expect(script).toContain('#if VER >= EncodeVer(6,3,0)');
      expect(script).toContain('ArchitecturesAllowed=x64compatible');
      expect(script).toContain('#else\nArchitecturesAllowed=x64');
      expect(script).toContain('AfterInstall: InstallSprintCoder');
      expect(script).toContain(
        "Exec(Bootstrapper, '--silent', ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode)",
      );
      expect(script).toContain('if ResultCode <> 0 then');
      expect(script).toContain('RaiseException');
      expect(script).toContain('Parameters: "--processStart ""Sprint Coder.exe"""; Description:');
      expect(script).toContain('Flags: nowait postinstall skipifsilent skipifdoesntexist');
    },
  );

  it('generates a Squirrel.Mac manifest that targets the release ZIP', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'sprint-coder-update-'));
    try {
      const zipPath = resolve(directory, 'Sprint-Coder-darwin-arm64-0.0.1-beta.5.zip');
      const outputPath = resolve(directory, 'RELEASES.json');
      writeFileSync(zipPath, 'fixture');
      execFileSync(process.execPath, [
        resolve(__dirname, 'scripts/create-macos-update-manifest.mjs'),
        '--version',
        '0.0.1-beta.5',
        '--tag',
        'v0.0.1-beta.5',
        '--repository',
        'Robbits-CO-LTD/sprint-coder',
        '--zip',
        zipPath,
        '--output',
        outputPath,
      ]);

      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
        currentRelease: '0.0.1-beta.5',
        releases: [
          {
            version: '0.0.1-beta.5',
            updateTo: {
              version: '0.0.1-beta.5',
              url: 'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.0.1-beta.5/Sprint-Coder-darwin-arm64-0.0.1-beta.5.zip',
            },
          },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
