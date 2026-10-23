import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computerUseNativeManifestSchema } from '@sprint-coder/contracts';
import { defineConfig } from 'vite';
import {
  computerUseAcceptanceBuildForEnv,
  type ComputerUseAcceptanceBuild,
} from './computer-use-acceptance-build';
import { computerUseNativeCompiledPin } from './src/main/computer-use-native-provenance';

export function macAutoUpdateEligibleForIdentity(identity: string | undefined): boolean {
  return identity !== undefined && identity.length > 0 && identity !== '-';
}

export function computerUseNativePinForBuild(
  path = resolve(
    __dirname,
    'computer-use-native',
    'build',
    'Release',
    'computer-use-native.manifest.json',
  ),
): unknown {
  if (!existsSync(path)) return null;
  const manifest = computerUseNativeManifestSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')) as unknown,
  );
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (manifest.platform !== process.platform || manifest.architecture !== architecture) return null;
  return computerUseNativeCompiledPin(manifest);
}

/**
 * The acceptance mode is fixed here, at build time, and nowhere else.  Compiling it to `null` for
 * every ordinary build is what makes the waiver unreachable in a release package.
 */
export function computerUseAcceptanceBuildForBuild(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): ComputerUseAcceptanceBuild | null {
  return computerUseAcceptanceBuildForEnv(environment, platform);
}

export default defineConfig({
  define: {
    __SPRINT_CODER_MAC_AUTO_UPDATE_ELIGIBLE__: JSON.stringify(
      macAutoUpdateEligibleForIdentity(process.env['SPRINT_CODER_CODESIGN_IDENTITY']),
    ),
    __SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__: JSON.stringify(computerUseNativePinForBuild()),
    __SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD__: JSON.stringify(
      computerUseAcceptanceBuildForBuild(),
    ),
  },
  build: { rollupOptions: { external: ['better-sqlite3', 'sharp'] } },
});
