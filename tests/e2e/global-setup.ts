import { execFileSync } from 'node:child_process';
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
 *  - "packaged": always runs `electron-forge package` once before the suite. An existing `out/`
 *    directory is never treated as proof that the current source was packaged.
 *  - "dev": makes sure a Vite dev server + main/preload dev build are reachable, starting
 *    `npm start` in the background if nothing is already listening. A pre-existing dev instance
 *    (a developer's own `npm start`, or a previous leftover) is detected and reused as-is — it
 *    is never killed. Playwright treats a function returned from globalSetup as the matching
 *    globalTeardown, which is how the dev server we spawned here (and only that one) gets torn
 *    down once the whole suite finishes.
 */
function packageFresh(): void {
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
  console.log('[e2e globalSetup] Packaging complete.');
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const mode = resolveE2EMode();
  console.log(`[e2e globalSetup] mode=${mode}`);

  if (mode === 'packaged') {
    packageFresh();
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
