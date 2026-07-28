import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DESKTOP_ROOT,
  OUT_DIR,
  ensureDevServerReady,
  isPackagedAvailable,
  preparePackagedAppForPlaywright,
  removeUserDataDir,
  REPO_ROOT,
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
const DESKTOP_MANIFEST = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

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
  if (!existsSync(OUT_DIR) || !existsSync(STAMP_FILE) || !isPackagedAvailable()) return true;
  let stamp: {
    schemaVersion: number;
    packageName: string;
    packageVersion: string;
    sourceMtimeMs: number;
  };
  try {
    stamp = JSON.parse(readFileSync(STAMP_FILE, 'utf8')) as typeof stamp;
  } catch {
    return true;
  }
  if (
    stamp.schemaVersion !== 1 ||
    stamp.packageName !== DESKTOP_MANIFEST.name ||
    stamp.packageVersion !== DESKTOP_MANIFEST.version
  )
    return true;
  const newestSourceMs = Math.max(...WATCHED_ROOTS.map(newestMtimeMs));
  return newestSourceMs > stamp.sourceMtimeMs;
}

function packageIfStale(): void {
  if (!isPackageStale()) {
    console.log(`[e2e globalSetup] ${OUT_DIR} is up to date, skipping electron-forge package.`);
    return;
  }

  console.log('[e2e globalSetup] Packaging sprint-coder (electron-forge package)...');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== 22) {
    throw new Error(
      `Packaged E2E requires Node 22 (current: ${process.versions.node}). ` +
        'Use the repository .nvmrc before running Playwright.',
    );
  }
  execFileSync(
    process.execPath,
    [
      join(
        REPO_ROOT,
        'node_modules',
        '@electron-forge',
        'cli',
        'dist',
        'electron-forge-package.js',
      ),
    ],
    {
      cwd: DESKTOP_ROOT,
      stdio: 'inherit',
      timeout: 10 * 60 * 1000, // packaging can take a few minutes on a cold cache
    },
  );

  if (!isPackagedAvailable()) {
    throw new Error(
      `electron-forge package reported success but no executable was created under ${OUT_DIR}.`,
    );
  }
  const sourceMtimeMs = Math.max(...WATCHED_ROOTS.map(newestMtimeMs));
  writeFileSync(
    STAMP_FILE,
    JSON.stringify(
      {
        schemaVersion: 1,
        packageName: DESKTOP_MANIFEST.name,
        packageVersion: DESKTOP_MANIFEST.version,
        sourceMtimeMs,
        packagedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log('[e2e globalSetup] Packaging complete.');
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const mode = resolveE2EMode();
  console.log(`[e2e globalSetup] mode=${mode}`);

  if (mode === 'packaged') {
    packageIfStale();
    const prepared = await preparePackagedAppForPlaywright();
    process.env['SPRINT_CODER_E2E_EXECUTABLE_PATH'] = prepared.executablePath;
    return async () => {
      delete process.env['SPRINT_CODER_E2E_EXECUTABLE_PATH'];
      removeUserDataDir(prepared.temporaryRoot);
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
