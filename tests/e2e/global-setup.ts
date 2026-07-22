import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DESKTOP_ROOT,
  OUT_DIR,
  ensureDevServerReady,
  resolveE2EMode,
  stopDevServer,
} from './helpers';
import type { DevServerHandle } from './helpers';

/**
 * Prepares whichever launch mode resolveE2EMode() selects (see tests/e2e/helpers.ts):
 *
 *  - "packaged": runs `electron-forge package` once (skipped if apps/desktop/out/** is already
 *    up to date, tracked via a stamp file compared against source mtimes).
 *  - "dev": makes sure a Vite dev server + main/preload dev build are reachable, starting
 *    `npm start` in the background if nothing is already listening. A pre-existing dev instance
 *    (a developer's own `npm start`, or a previous leftover) is detected and reused as-is — it
 *    is never killed. Playwright treats a function returned from globalSetup as the matching
 *    globalTeardown, which is how the dev server we spawned here (and only that one) gets torn
 *    down once the whole suite finishes.
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

function packageIfStale(): void {
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
      `electron-forge package reported success but ${OUT_DIR} was not created. This has been ` +
        "confirmed to be an environment/toolchain bug (@electron/packager's zip extraction of " +
        'the Electron binary hangs deterministically on the electron.icns entry, independent ' +
        'of Node version) rather than an application bug. Use VIBE_E2E_MODE=dev to run E2E ' +
        'against `npm start` instead.',
    );
  }
  writeFileSync(STAMP_FILE, new Date().toISOString());
  console.log('[e2e globalSetup] Packaging complete.');
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const mode = resolveE2EMode();
  console.log(`[e2e globalSetup] mode=${mode}`);

  if (mode === 'packaged') {
    packageIfStale();
    return async () => {
      /* nothing spawned in packaged mode — each test owns/closes its own process */
    };
  }

  console.log('[e2e globalSetup] Ensuring dev server + main/preload dev build are ready...');
  const devServer: DevServerHandle = await ensureDevServerReady(90_000);
  console.log(
    devServer.alreadyRunning
      ? '[e2e globalSetup] Reusing an already-running dev server (not touching it).'
      : '[e2e globalSetup] Started our own `npm start` in the background.',
  );

  return async () => {
    if (!devServer.alreadyRunning) {
      console.log('[e2e globalTeardown] Stopping the `npm start` we spawned for this run.');
    }
    stopDevServer(devServer);
  };
}
