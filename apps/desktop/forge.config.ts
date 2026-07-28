import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { cpSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// @electron-forge/plugin-vite auto-sets packagerConfig.ignore to keep only the `.vite`
// build output (everything else, including this project's own source tree, is dropped
// from the packaged app). The native-safe-fs compiled addon lives outside `.vite` and
// outside node_modules, so under that default it would be silently excluded from the
// package before packagerConfig.asar.unpack ever gets a chance to unpack it. Setting our
// own `ignore` here (which suppresses the plugin's auto-set, per its own resolveForgeConfig
// check) preserves the plugin's `.vite`-only behavior and additionally keeps the
// native-safe-fs build directory so the addon actually ships. See native-safe-fs.ts
// (resolveNativeSafeFsAddonLocation) for how the main process finds this file at runtime.
function isNativeSafeFsAddonPackagePath(file: string): boolean {
  return (
    file === '/native-safe-fs' ||
    file === '/native-safe-fs/build' ||
    file === '/native-safe-fs/build/Release' ||
    (file.startsWith('/native-safe-fs/build/Release/') && file.endsWith('.node'))
  );
}

function shouldIgnoreFromPackage(file: string): boolean {
  if (!file) return false;
  if (file === '/.vite' || file.startsWith('/.vite/')) return false;
  if (isNativeSafeFsAddonPackagePath(file)) return false;
  return true;
}

const runtimeModuleFiles = [
  ['better-sqlite3', 'package.json'],
  ['better-sqlite3', 'lib'],
  ['better-sqlite3', 'build', 'Release', 'better_sqlite3.node'],
  ['bindings', 'package.json'],
  ['bindings', 'bindings.js'],
  ['file-uri-to-path', 'package.json'],
  ['file-uri-to-path', 'index.js'],
] as const;

function copyHoistedRuntimeModules(buildPath: string): void {
  const rootNodeModules = resolve(__dirname, '..', '..', 'node_modules');
  const packagedNodeModules = join(buildPath, 'node_modules');
  mkdirSync(packagedNodeModules, { recursive: true });

  for (const parts of runtimeModuleFiles) {
    const source = join(rootNodeModules, ...parts);
    const destination = join(packagedNodeModules, ...parts);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    // @electron/asar matches `unpack` against the full source filename with matchBase enabled.
    // Native addons cannot be loaded from inside app.asar, so unpack only `.node` binaries.
    asar: { unpack: '*.node' },
    ignore: shouldIgnoreFromPackage,
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, done) => {
        try {
          copyHoistedRuntimeModules(buildPath);
          done();
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      },
    ],
  },
  makers: [new MakerZIP({}, ['darwin', 'win32', 'linux'])],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts' },
        { entry: 'src/runtime-host/index.ts', config: 'vite.runtime-host.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
