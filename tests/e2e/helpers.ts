import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * vibe-editor3 Electron E2E launch helpers.
 *
 * `npm start` on its own is a dev-server launch and was never meant to be driven directly by
 * E2E — but in this environment `electron-forge package` cannot produce a usable build at all
 * (confirmed: @electron/packager's zip extraction of the Electron binary hangs deterministically
 * on the electron.icns entry, independent of Node version — reproduced under both Node 26 and
 * Electron's bundled Node 22). So two launch modes are supported:
 *
 *  - "packaged": launches the electron-forge packaged app under apps/desktop/out/** (original,
 *    preferred path — used automatically wherever packaging actually works, e.g. future CI).
 *  - "dev": launches the repo's own Electron binary (node_modules/electron) directly against
 *    apps/desktop, reusing whatever `npm start` (dev server + main/preload dev build) is
 *    reachable. This is the fallback this environment relies on today.
 *
 * Mode selection: `VIBE_E2E_MODE=packaged|dev` forces a mode; otherwise `packaged` is used if
 * apps/desktop/out/** already contains a usable build, else `dev`.
 */

export const DESKTOP_ROOT = join(__dirname, '..', '..', 'apps', 'desktop');
export const REPO_ROOT = join(__dirname, '..', '..');
export const OUT_DIR = join(DESKTOP_ROOT, 'out');
export const MAIN_BUILD_OUTPUT = join(DESKTOP_ROOT, '.vite', 'build', 'index.js');
export const PRELOAD_BUILD_OUTPUT = join(DESKTOP_ROOT, '.vite', 'build', 'preload.js');
export const DEV_SERVER_CANDIDATE_URLS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
];

export type E2EMode = 'packaged' | 'dev';

/**
 * `out/` 配下のpackaged app実行ファイルをOSに応じて自動検出する。
 * app名はpackage.jsonの"name"やforge.config.tsのpackagerConfig.nameに依存し
 * 変化しうるため、ディレクトリ内容を実際に走査して決定する。
 */
export function findPackagedExecutable(): string {
  if (!existsSync(OUT_DIR)) {
    throw new Error(`Packaged app not found at ${OUT_DIR}.`);
  }

  const topLevel = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (topLevel.length === 0) {
    throw new Error(`No packaged output directories found under ${OUT_DIR}.`);
  }

  // Prefer a directory that mentions the current platform (e.g. "-darwin-arm64"),
  // fall back to the first (and usually only) directory otherwise.
  const platformDirName = topLevel.find((name) => name.includes(process.platform)) ?? topLevel[0];
  if (platformDirName === undefined) {
    throw new Error(`No packaged output directories found under ${OUT_DIR}.`);
  }
  const packDir = join(OUT_DIR, platformDirName);

  if (process.platform === 'darwin') {
    const bundle = readdirSync(packDir).find((e) => e.endsWith('.app'));
    if (!bundle) throw new Error(`No .app bundle found in ${packDir}.`);
    const appName = bundle.replace(/\.app$/, '');
    const macOsDir = join(packDir, bundle, 'Contents', 'MacOS');
    const expected = join(macOsDir, appName);
    if (existsSync(expected)) return expected;
    // Fallback: pick whatever single executable lives in Contents/MacOS.
    const [firstBinary] = readdirSync(macOsDir);
    if (firstBinary === undefined) throw new Error(`No executable found inside ${bundle}.`);
    return join(macOsDir, firstBinary);
  }

  if (process.platform === 'win32') {
    const exe = readdirSync(packDir).find((e) => e.toLowerCase().endsWith('.exe'));
    if (!exe) throw new Error(`No .exe found in ${packDir}.`);
    return join(packDir, exe);
  }

  // linux: an extensionless executable named after the product, sitting next to
  // resources/, locales/, etc.
  const candidate = readdirSync(packDir, { withFileTypes: true }).find(
    (e) => e.isFile() && (statSync(join(packDir, e.name)).mode & 0o111) !== 0,
  );
  if (!candidate) throw new Error(`No executable found in ${packDir}.`);
  return join(packDir, candidate.name);
}

export function isPackagedAvailable(): boolean {
  try {
    findPackagedExecutable();
    return true;
  } catch {
    return false;
  }
}

/** `VIBE_E2E_MODE` forces a mode; otherwise prefer "packaged" when it's actually usable. */
export function resolveE2EMode(): E2EMode {
  const forced = process.env['VIBE_E2E_MODE'];
  if (forced === 'packaged' || forced === 'dev') return forced;
  return isPackagedAvailable() ? 'packaged' : 'dev';
}

/** Resolves the repo's own Electron binary via node_modules/electron/path.txt, the same
 * indirection the `electron` npm package itself uses — works across mac/win/linux without
 * hardcoding a platform-specific layout. */
export function resolveDevElectronBinary(): string {
  const electronDir = join(REPO_ROOT, 'node_modules', 'electron');
  const relPath = readFileSync(join(electronDir, 'path.txt'), 'utf8').trim();
  const binPath = join(electronDir, 'dist', relPath);
  if (!existsSync(binPath)) {
    throw new Error(`Dev-mode Electron binary not found at ${binPath}.`);
  }
  return binPath;
}

/** Creates a fresh, uniquely-named userData directory for a single test. */
export function createUserDataDir(label: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return mkdtempSync(join(tmpdir(), `vibe-e2e-${safeLabel}-`));
}

export function removeUserDataDir(dir: string | null | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best-effort cleanup only; a leftover temp dir is not fatal for CI.
  }
}

async function pingUrl(url: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.status >= 200; // any response at all means something is listening
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function isDevServerUp(): Promise<boolean> {
  for (const url of DEV_SERVER_CANDIDATE_URLS) {
    if (await pingUrl(url)) return true;
  }
  return false;
}

async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 750,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export type DevServerHandle = { alreadyRunning: boolean; proc: ChildProcess | null };

/**
 * Ensures the Vite dev server + main/preload dev build (apps/desktop/.vite/build/index.js) are
 * ready for dev-mode E2E.
 *
 * If a dev server is already reachable (e.g. a developer's own `npm start`, or one left running
 * from a previous run), it is reused untouched — we must never kill or otherwise interfere with
 * an already-running dev instance. Only a dev server WE spawn here is torn down later
 * (see stopDevServer).
 */
export async function ensureDevServerReady(timeoutMs = 90_000): Promise<DevServerHandle> {
  if (await isDevServerUp()) {
    return { alreadyRunning: true, proc: null };
  }

  const previousMainMtime = existsSync(MAIN_BUILD_OUTPUT) ? statSync(MAIN_BUILD_OUTPUT).mtimeMs : 0;
  const previousPreloadMtime = existsSync(PRELOAD_BUILD_OUTPUT)
    ? statSync(PRELOAD_BUILD_OUTPUT).mtimeMs
    : 0;
  const proc = spawn('npm', ['start'], {
    cwd: REPO_ROOT,
    detached: true, // its own process group, so we can signal the whole tree on teardown
    stdio: 'ignore',
    env: process.env,
  });
  proc.unref();

  try {
    await waitForCondition(
      async () =>
        (await isDevServerUp()) &&
        existsSync(MAIN_BUILD_OUTPUT) &&
        existsSync(PRELOAD_BUILD_OUTPUT) &&
        statSync(MAIN_BUILD_OUTPUT).mtimeMs > previousMainMtime &&
        statSync(PRELOAD_BUILD_OUTPUT).mtimeMs > previousPreloadMtime,
      timeoutMs,
    );
  } catch (err) {
    stopDevServer({ alreadyRunning: false, proc });
    throw new Error(
      `Dev server / main build did not become ready within ${timeoutMs}ms: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return { alreadyRunning: false, proc };
}

/** Tears down only a dev server WE started via ensureDevServerReady — a pre-existing developer
 * instance (alreadyRunning: true) is left running untouched, per the E2E task's constraint. */
export function stopDevServer(handle: DevServerHandle | null | undefined): void {
  if (!handle || handle.alreadyRunning || !handle.proc || handle.proc.pid === undefined) return;
  const descendants =
    process.platform === 'win32' ? [] : collectDescendantPids(handle.proc.pid).reverse();
  try {
    // `detached: true` put the spawned `npm start` in its own process group; signalling the
    // negative pid kills the whole tree (npm -> electron-forge start -> electron/vite/etc).
    process.kill(-handle.proc.pid, 'SIGTERM');
  } catch {
    // Already exited, or the process group is already gone — nothing further to do.
  }
  // Electron.app may move itself into another process group on macOS. Capture the exact
  // descendant set before stopping npm, then signal only those owned processes as well so
  // their single-instance lock cannot leak into the next E2E run.
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The group signal normally wins the race; ESRCH here is expected.
    }
  }
}

function collectDescendantPids(rootPid: number): number[] {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
    const children = new Map<number, number[]>();
    for (const line of output.split('\n')) {
      const [pidText, parentText] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      const parent = Number(parentText);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
    }
    const descendants: number[] = [];
    const pending = [...(children.get(rootPid) ?? [])];
    while (pending.length > 0) {
      const pid = pending.pop();
      if (pid === undefined) break;
      descendants.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return descendants;
  } catch {
    return [];
  }
}

/**
 * Launches vibe-editor3 with an isolated VIBE_USER_DATA_DIR (own SQLite file + own
 * single-instance lock), so tests never collide with a developer's running instance or with
 * each other. Mode defaults to resolveE2EMode() (see module doc comment).
 */
export async function launchApp(
  userDataDir: string,
  mode: E2EMode = resolveE2EMode(),
): Promise<ElectronApplication> {
  const env = { ...process.env, VIBE_USER_DATA_DIR: userDataDir };

  if (mode === 'packaged') {
    return electron.launch({ executablePath: findPackagedExecutable(), env });
  }

  // dev mode: run the repo's own Electron binary directly against apps/desktop. The main/preload
  // bundle at apps/desktop/.vite/build/*.js was produced by `npm start` (see
  // ensureDevServerReady) and has MAIN_WINDOW_VITE_DEV_SERVER_URL baked in, so the renderer loads
  // from the already-running Vite dev server rather than the app://bundle production protocol.
  return electron.launch({
    executablePath: resolveDevElectronBinary(),
    args: [DESKTOP_ROOT],
    env,
  });
}

export async function firstWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** Always call in a `finally` block: closes the Electron process (ignoring errors from an
 * already-crashed/closed app) — never touches a developer's separately-running instance since
 * each test owns its own isolated userData dir/process. */
export async function closeApp(app: ElectronApplication | null | undefined): Promise<void> {
  if (!app) return;
  try {
    await app.close();
  } catch {
    // Already closed/crashed — nothing further to do.
  }
}
