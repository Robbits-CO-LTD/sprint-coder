import { defineConfig } from 'vite';

export function macAutoUpdateEligibleForIdentity(identity: string | undefined): boolean {
  return identity !== undefined && identity.length > 0 && identity !== '-';
}

export default defineConfig({
  define: {
    __SPRINT_CODER_MAC_AUTO_UPDATE_ELIGIBLE__: JSON.stringify(
      macAutoUpdateEligibleForIdentity(process.env['SPRINT_CODER_CODESIGN_IDENTITY']),
    ),
  },
  build: { rollupOptions: { external: ['better-sqlite3', 'sharp'] } },
});
