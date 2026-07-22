import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_ROOT, OUT_DIR } from './helpers';

/**
 * Runs `electron-forge package` once before the whole E2E suite (§15.5 golden paths are all
 * production-runtime tests; `npm start` is a dev-server launch and is unusable here).
 *
 * A stamp file (out/.e2e-package-stamp) records when packaging last succeeded; if every
 * relevant source file is older than the stamp, packaging is skipped so repeated `npm run e2e`
 * runs during local iteration don't pay the multi-minute packaging cost every time.
 */
const STAMP_FILE = join(OUT_DIR, '.e2e-package-stamp');

const WATCHED_ROOTS = [
  join(DESKTOP_ROOT, 'src'),
  join(DESKTOP_ROOT, 'forge.config.ts'),
  join(DESKTOP_ROOT, 'package.json'),
  join(DESKTOP_ROOT, 'vite.main.config.ts'),
  join(DESKTOP_ROOT, 'vite.preload.config.ts'),
  join(DESKTOP_ROOT, 'vite.renderer.config.ts'),
  join(DESKTOP_ROOT, 'index.html'),
];

function newestMtimeMs(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = newestMtimeMs(join(path, entry.name));
    if (child > newest) newest = child;
  }
  return newest;
}

function isPackageStale(): boolean {
  if (!existsSync(OUT_DIR) || !existsSync(STAMP_FILE)) return true;
  const stampMs = statSync(STAMP_FILE).mtimeMs;
  const newestSourceMs = Math.max(...WATCHED_ROOTS.map(newestMtimeMs));
  return newestSourceMs > stampMs;
}

export default async function globalSetup(): Promise<void> {
  if (!isPackageStale()) {
    console.log(`[e2e globalSetup] ${OUT_DIR} is up to date, skipping electron-forge package.`);
    return;
  }

  console.log('[e2e globalSetup] Packaging vibe-editor3 (electron-forge package)...');
  execSync('npx electron-forge package', {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
    timeout: 10 * 60 * 1000, // packaging can take a few minutes on a cold cache
  });

  if (!existsSync(OUT_DIR)) {
    throw new Error(
      `electron-forge package reported success but ${OUT_DIR} was not created. ` +
        'This has been observed to be an environment/toolchain issue (electron-packager\'s ' +
        'zip extraction of the Electron binary never settles on this Node version) rather ' +
        'than an application bug — see the E2E task notes. Re-run with ' +
        '`DEBUG=electron-packager npx electron-forge package` inside apps/desktop to inspect.',
    );
  }
  writeFileSync(STAMP_FILE, new Date().toISOString());
  console.log('[e2e globalSetup] Packaging complete.');
}
