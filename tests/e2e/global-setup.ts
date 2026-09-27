import type { FullConfig } from '@playwright/test';
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
  warnAboutUnbuiltDevNativePrerequisites,
} from './helpers';
import type { DevServerHandle } from './helpers';
import { formatDevServerProgress } from './startup-diagnostics';

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

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const mode = resolveE2EMode();
  console.log(`[e2e globalSetup] mode=${mode}`);

  if (mode === 'packaged') {
    // A preset executable path means "test this already-built package" (for example a published
    // release artifact), so nothing is packaged here; the prepared copy still gets the inspector
    // fuse and the source bundle is left untouched, exactly as for a fresh package.
    const presetExecutable = process.env['SPRINT_CODER_E2E_EXECUTABLE_PATH'];
    if (presetExecutable === undefined) packageFresh();
    else console.log(`[e2e globalSetup] Using prebuilt executable: ${presetExecutable}`);
    const prepared = await preparePackagedAppForPlaywright();
    process.env['SPRINT_CODER_E2E_EXECUTABLE_PATH'] = prepared.executablePath;
    return async () => {
      if (presetExecutable === undefined) delete process.env['SPRINT_CODER_E2E_EXECUTABLE_PATH'];
      else process.env['SPRINT_CODER_E2E_EXECUTABLE_PATH'] = presetExecutable;
      removeUserDataDir(prepared.temporaryRoot);
    };
  }

  // Surfaced before the dev server starts: a missing native layer otherwise costs the whole
  // startup budget and then reads as a product bug in whichever specs depend on it.
  warnAboutUnbuiltDevNativePrerequisites();

  // Playwright empties the output directory before globalSetup runs, so the log belongs to this
  // run, and CI uploads it with the rest of test-results.
  const devServerLog = join(
    config.projects[0]?.outputDir ?? join(REPO_ROOT, 'test-results'),
    'dev-server.log',
  );
  console.log('[e2e globalSetup] Ensuring dev server + main/preload dev build are ready...');
  const devServer: DevServerHandle = await ensureDevServerReady(devServerLog);
  console.log(
    devServer.alreadyRunning
      ? '[e2e globalSetup] Reusing an already-running dev server (not touching it).'
      : '[e2e globalSetup] Started our own `npm start` in the background' +
          (devServer.progress === undefined
            ? ''
            : `: ${formatDevServerProgress(devServer.progress)}`) +
          ` (output: ${devServerLog}).`,
  );

  return async () => {
    if (!devServer.alreadyRunning) {
      console.log('[e2e globalTeardown] Stopping the `npm start` we spawned for this run.');
    }
    stopDevServer(devServer);
  };
}
