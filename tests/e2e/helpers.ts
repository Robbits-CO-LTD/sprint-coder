import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Package済み(production build)のvibe-editor3 Electron E2Eヘルパー。
 *
 * `npm start` はdevサーバ起動型のためE2Eには使わない。ここでは
 * `apps/desktop/out/**` に生成されたpackaged app (electron-forge package) の
 * 実行ファイルを自動検出し、テストごとに隔離した VIBE_USER_DATA_DIR で起動する。
 */

export const DESKTOP_ROOT = join(__dirname, '..', '..', 'apps', 'desktop');
export const OUT_DIR = join(DESKTOP_ROOT, 'out');

/**
 * `out/` 配下のpackaged app実行ファイルをOSに応じて自動検出する。
 * app名はpackage.jsonの"name"やforge.config.tsのpackagerConfig.nameに依存し
 * 変化しうるため、ディレクトリ内容を実際に走査して決定する。
 */
export function findPackagedExecutable(): string {
  if (!existsSync(OUT_DIR)) {
    throw new Error(
      `Packaged app not found at ${OUT_DIR}. Run "npx electron-forge package" inside ` +
        `${DESKTOP_ROOT} first (globalSetup should have done this automatically).`,
    );
  }

  const topLevel = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (topLevel.length === 0) {
    throw new Error(`No packaged output directories found under ${OUT_DIR}.`);
  }

  // Prefer a directory that mentions the current platform (e.g. "-darwin-arm64"),
  // fall back to the first (and usually only) directory otherwise.
  const platformDirName =
    topLevel.find((name) => name.includes(process.platform)) ?? topLevel[0];
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
    (e) => e.isFile() && statSync(join(packDir, e.name)).mode & 0o111,
  );
  if (!candidate) throw new Error(`No executable found in ${packDir}.`);
  return join(packDir, candidate.name);
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

/**
 * Launches the packaged app with an isolated VIBE_USER_DATA_DIR (own SQLite file +
 * own single-instance lock), so tests never collide with a developer's running
 * `npm start` instance or with each other.
 */
export async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const executablePath = findPackagedExecutable();
  return electron.launch({
    executablePath,
    env: {
      ...process.env,
      VIBE_USER_DATA_DIR: userDataDir,
    },
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
