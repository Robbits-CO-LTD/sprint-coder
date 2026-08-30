import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computerUseNativeManifestSchema } from '@sprint-coder/contracts';
import { defineConfig } from 'vite';
import { computerUseNativeCompiledPin } from './src/main/computer-use-native-provenance';

export function macAutoUpdateEligibleForIdentity(identity: string | undefined): boolean {
  return identity !== undefined && identity.length > 0 && identity !== '-';
}

export function managedLocalSidecarPinsForBuild(
  path = resolve(__dirname, 'managed-local', 'build', 'managed-local-sidecar-pins.json'),
): unknown {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid generated Managed Local sidecar pins');
  return value;
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

export default defineConfig({
  define: {
    __SPRINT_CODER_MAC_AUTO_UPDATE_ELIGIBLE__: JSON.stringify(
      macAutoUpdateEligibleForIdentity(process.env['SPRINT_CODER_CODESIGN_IDENTITY']),
    ),
    __SPRINT_CODER_MANAGED_LOCAL_SIDECAR_PINS__: JSON.stringify(managedLocalSidecarPinsForBuild()),
    __SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__: JSON.stringify(computerUseNativePinForBuild()),
  },
  build: { rollupOptions: { external: ['better-sqlite3', 'sharp'] } },
});
