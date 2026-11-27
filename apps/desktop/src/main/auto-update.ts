import type { AutoUpdater } from 'electron';
import type {
  UpdateCheckResult,
  UpdateErrorCategory,
  UpdateInstallState,
} from '@sprint-coder/contracts';

const GITHUB_REPOSITORY = 'Robbits-CO-LTD/sprint-coder';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases?per_page=20`;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

type Platform = 'darwin' | 'win32' | string;
type Architecture = 'arm64' | 'x64' | string;

type Logger = Readonly<{
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
}>;

type FetchResponse = Readonly<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

type GithubAsset = Readonly<{ name: string }>;
type GithubRelease = Readonly<{
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  assets: readonly GithubAsset[];
}>;

export type UpdateRelease = Readonly<{
  version: string;
  tagName: string;
  feedUrl: string;
}>;

type UpdateRestartResult = 'started' | 'busy' | 'shutdown_in_progress';

type ParsedVersion = Readonly<{
  major: number;
  minor: number;
  patch: number;
  beta: number | null;
  value: string;
}>;

export type AutoUpdateOptions = Readonly<{
  updater: Pick<AutoUpdater, 'setFeedURL' | 'checkForUpdates' | 'on' | 'removeListener'>;
  fetch: (url: string, init: RequestInit) => Promise<FetchResponse>;
  logger: Logger;
  restartToInstall: () => Promise<UpdateRestartResult>;
  hasActiveWork: () => boolean;
  onInstallStateChanged?: (state: UpdateInstallState) => void;
  currentVersion: string;
  isPackaged: boolean;
  platform: Platform;
  architecture: Architecture;
  executablePath: string;
  macAutoUpdateEligible: boolean;
  checkIntervalMs?: number;
  recordSuccess?: () => void;
  recordFailure?: (category: UpdateErrorCategory) => void;
}>;

export type AutoUpdateController = Readonly<{
  checkNow(): Promise<UpdateCheckResult>;
  getInstallState(): UpdateInstallState;
  restart(): Promise<void>;
  stop(): void;
}>;

export type UpdateInstallOptions = Readonly<{
  quitAndInstall(): void;
  exit(code: number): void;
  reportFailure(error: unknown): void;
  fallbackDelayMs?: number;
}>;

export function installUpdateWithFallback(options: UpdateInstallOptions): void {
  try {
    options.quitAndInstall();
  } catch (error) {
    options.reportFailure(error);
    options.exit(1);
    return;
  }
  // Squirrel.Mac can report an asynchronous install error without quitting. The caller has
  // already disposed persistence and IPC, so leaving that process alive would be unrecoverable.
  const fallback = setTimeout(() => options.exit(0), options.fallbackDelayMs ?? 10_000);
  (fallback as { unref?: () => void }).unref?.();
}

export function startAutoUpdate(options: AutoUpdateOptions): AutoUpdateController {
  if (!supportsAutoUpdate(options)) {
    options.logger.info('Automatic updates are disabled for this runtime', {
      packaged: options.isPackaged,
      platform: options.platform,
      architecture: options.architecture,
    });
    return {
      checkNow: async () => ({ status: 'unsupported' }),
      getInstallState: () => 'unavailable',
      restart: async () => undefined,
      stop: () => undefined,
    };
  }

  let stopped = false;
  let checking = false;
  let downloaded = false;
  let restarting = false;
  let publishedState: UpdateInstallState = 'unavailable';
  let installStateTimer: ReturnType<typeof setInterval> | undefined;
  let targetVersion: string | null = null;
  let failureRecordedForAttempt = false;
  const recordFailure = (error: unknown): void => {
    if (failureRecordedForAttempt) return;
    failureRecordedForAttempt = true;
    try {
      options.recordFailure?.(classifyUpdateError(error));
    } catch (recordError) {
      options.logger.warn('Automatic update health could not be recorded', recordError);
    }
  };
  const recordSuccess = (): void => {
    try {
      options.recordSuccess?.();
    } catch (recordError) {
      options.logger.warn('Automatic update health could not be recorded', recordError);
    }
  };

  const getInstallState = (): UpdateInstallState => {
    if (stopped || !downloaded) return 'unavailable';
    if (restarting) return 'restarting';
    return options.hasActiveWork() ? 'busy' : 'ready';
  };

  const publishInstallState = (): void => {
    const state = getInstallState();
    if (state === publishedState) return;
    publishedState = state;
    options.onInstallStateChanged?.(state);
  };

  const restart = async (): Promise<void> => {
    if (getInstallState() !== 'ready') {
      publishInstallState();
      return;
    }
    restarting = true;
    publishInstallState();
    try {
      // The mutation gate rechecks after draining handlers that were already in flight.
      restarting = (await options.restartToInstall()) !== 'busy';
    } catch (error) {
      restarting = false;
      options.logger.warn('Automatic update restart failed', error);
      throw new Error('更新を開始できませんでした。');
    } finally {
      publishInstallState();
    }
  };

  const checkNow = async (): Promise<UpdateCheckResult> => {
    if (stopped) return { status: 'unsupported' };
    if (downloaded && targetVersion !== null)
      return { status: 'update_available', version: targetVersion };
    if (checking) return { status: 'already_checking' };
    checking = true;
    failureRecordedForAttempt = false;
    try {
      const release = await discoverUpdate(options);
      if (stopped) return { status: 'unsupported' };
      if (release === null) {
        recordSuccess();
        options.logger.debug('No automatic update is available', {
          currentVersion: options.currentVersion,
        });
        return { status: 'up_to_date' };
      }
      targetVersion = release.version;
      options.updater.setFeedURL(
        options.platform === 'darwin'
          ? { url: release.feedUrl, serverType: 'json' }
          : { url: release.feedUrl },
      );
      await options.updater.checkForUpdates();
      if (stopped) return { status: 'unsupported' };
      options.logger.info('Automatic update download started', { version: release.version });
      return { status: 'update_available', version: release.version };
    } catch (error) {
      recordFailure(error);
      options.logger.warn('Automatic update check failed', error);
      return { status: 'failed', errorCategory: classifyUpdateError(error) };
    } finally {
      checking = false;
    }
  };

  const onUpdaterError = (error: Error): void => {
    if (!stopped) recordFailure(error);
    options.logger.warn('Automatic updater reported an error', error);
  };
  const onUpdateDownloaded = (): void => {
    if (stopped || downloaded) return;
    recordSuccess();
    downloaded = true;
    clearInterval(timer);
    installStateTimer = setInterval(publishInstallState, 1_000);
    installStateTimer.unref();
    publishInstallState();
  };

  options.updater.on('error', onUpdaterError);
  options.updater.on('update-downloaded', onUpdateDownloaded);

  const timer = setInterval(
    () => void checkNow(),
    options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
  );
  (timer as { unref?: () => void }).unref?.();
  void checkNow();

  return {
    checkNow,
    getInstallState,
    restart,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(installStateTimer);
      // Squirrel can still emit an asynchronous `error` after quitAndInstall. Keep this listener
      // until process exit so EventEmitter never turns that expected failure into an uncaught throw.
      options.updater.removeListener('update-downloaded', onUpdateDownloaded);
    },
  };
}

export function classifyUpdateError(error: unknown): UpdateErrorCategory {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes('cryptunprotectdata') ||
    normalized.includes('dpapi') ||
    normalized.includes('decrypt') ||
    normalized.includes('暗号化を解除')
  )
    return 'decryption';
  if (
    normalized.includes('eacces') ||
    normalized.includes('eperm') ||
    normalized.includes('enoent') ||
    normalized.includes('filesystem') ||
    normalized.includes('file system')
  )
    return 'filesystem';
  if (
    normalized.includes('http ') ||
    normalized.includes('release') ||
    normalized.includes('feed') ||
    normalized.includes('manifest')
  )
    return 'release_feed';
  if (
    normalized.includes('fetch') ||
    normalized.includes('network') ||
    normalized.includes('timed out') ||
    /\be(?:conn|host|net|pipe)/.test(normalized)
  )
    return 'network';
  if (error instanceof Error) return 'updater';
  return 'unknown';
}

export async function discoverUpdate(
  options: Pick<AutoUpdateOptions, 'fetch' | 'currentVersion' | 'platform' | 'architecture'>,
): Promise<UpdateRelease | null> {
  const response = await options.fetch(GITHUB_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Sprint-Coder/${options.currentVersion}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub Releases request failed with HTTP ${response.status}`);
  return selectUpdateRelease(
    await response.json(),
    options.currentVersion,
    options.platform,
    options.architecture,
  );
}

export function selectUpdateRelease(
  value: unknown,
  currentVersion: string,
  platform: Platform,
  architecture: Architecture,
): UpdateRelease | null {
  if (!Array.isArray(value)) throw new Error('GitHub Releases response was not an array');
  const current = parseVersion(currentVersion);
  if (current === null) throw new Error(`Unsupported current version: ${currentVersion}`);

  let selected: { release: GithubRelease; version: ParsedVersion } | null = null;
  for (const candidate of value) {
    const release = parseRelease(candidate);
    if (
      release === null ||
      release.draft ||
      (release.prerelease && current.beta === null) ||
      !hasUpdateAssets(release, platform, architecture)
    )
      continue;
    const version = parseVersion(release.tag_name);
    if (version === null || compareVersions(version, current) <= 0) continue;
    if (selected === null || compareVersions(version, selected.version) > 0)
      selected = { release, version };
  }
  if (selected === null) return null;

  const tagName = selected.release.tag_name;
  const baseUrl = `https://github.com/${GITHUB_REPOSITORY}/releases/download/${encodeURIComponent(tagName)}`;
  return {
    version: selected.version.value,
    tagName,
    feedUrl: platform === 'darwin' ? `${baseUrl}/RELEASES.json` : baseUrl,
  };
}

export function supportsAutoUpdate(
  options: Pick<
    AutoUpdateOptions,
    'isPackaged' | 'platform' | 'architecture' | 'executablePath' | 'macAutoUpdateEligible'
  >,
): boolean {
  if (!options.isPackaged) return false;
  // The release workflow currently publishes one native macOS artifact: ARM64. Squirrel.Mac also
  // requires source and update bundles signed by the same real identity, so ad-hoc beta builds are
  // deliberately compiled with eligibility=false (see vite.main.config.ts).
  if (options.platform === 'darwin')
    return options.architecture === 'arm64' && options.macAutoUpdateEligible;
  if (options.platform !== 'win32' || options.architecture !== 'x64') return false;
  return /(?:^|[\\/])app-[^\\/]+[\\/][^\\/]+\.exe$/i.test(options.executablePath);
}

function hasUpdateAssets(
  release: GithubRelease,
  platform: Platform,
  architecture: Architecture,
): boolean {
  const names = release.assets.map((asset) => asset.name);
  if (platform === 'darwin')
    return (
      names.includes('RELEASES.json') &&
      names.some(
        (name) => name.toLowerCase().includes(`darwin-${architecture}`) && name.endsWith('.zip'),
      )
    );
  if (platform === 'win32' && architecture === 'x64')
    return (
      names.includes('RELEASES') &&
      names.some((name) => name.toLowerCase().endsWith('-full.nupkg')) &&
      names.some((name) => name.toLowerCase().endsWith('.exe'))
    );
  return false;
}

function parseRelease(value: unknown): GithubRelease | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['draft'] !== 'boolean' ||
    typeof candidate['prerelease'] !== 'boolean' ||
    typeof candidate['tag_name'] !== 'string' ||
    !Array.isArray(candidate['assets'])
  )
    return null;
  const assets: GithubAsset[] = [];
  for (const asset of candidate['assets']) {
    if (asset === null || typeof asset !== 'object') return null;
    const name = (asset as Record<string, unknown>)['name'];
    if (typeof name !== 'string') return null;
    assets.push({ name });
  }
  return {
    draft: candidate['draft'],
    prerelease: candidate['prerelease'],
    tag_name: candidate['tag_name'],
    assets,
  };
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(value);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const beta = match[4] === undefined ? null : Number(match[4]);
  if (![major, minor, patch, ...(beta === null ? [] : [beta])].every(Number.isSafeInteger))
    return null;
  return {
    major,
    minor,
    patch,
    beta,
    value: `${major}.${minor}.${patch}${beta === null ? '' : `-beta.${beta}`}`,
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.beta === right.beta) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return left.beta - right.beta;
}
