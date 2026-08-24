import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

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

export default defineConfig({
  define: {
    __SPRINT_CODER_MAC_AUTO_UPDATE_ELIGIBLE__: JSON.stringify(
      macAutoUpdateEligibleForIdentity(process.env['SPRINT_CODER_CODESIGN_IDENTITY']),
    ),
    __SPRINT_CODER_MANAGED_LOCAL_SIDECAR_PINS__: JSON.stringify(managedLocalSidecarPinsForBuild()),
  },
  build: { rollupOptions: { external: ['better-sqlite3', 'sharp'] } },
});
