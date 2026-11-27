import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoUpdateOptions } from './auto-update';
import {
  classifyUpdateError,
  installUpdateWithFallback,
  selectUpdateRelease,
  startAutoUpdate,
  supportsAutoUpdate,
} from './auto-update';

const windowsAssets = [
  { name: 'RELEASES' },
  { name: 'SprintCoder-0.0.1-beta.5-full.nupkg' },
  { name: 'Sprint-Coder-Setup.exe' },
];
const macAssets = [
  { name: 'RELEASES.json' },
  { name: 'Sprint-Coder-darwin-arm64-0.0.1-beta.5.zip' },
];

function release(tagName: string, assets = windowsAssets, draft = false) {
  return { draft, prerelease: tagName.includes('-beta.'), tag_name: tagName, assets };
}

describe('selectUpdateRelease', () => {
  it('selects the highest newer beta with complete Squirrel.Windows assets', () => {
    expect(
      selectUpdateRelease(
        [
          release('v0.0.1-beta.5'),
          release('v0.0.2-beta.1', [{ name: 'Sprint-Coder-Setup.exe' }]),
          release('v0.0.1-beta.7'),
          release('v0.0.1-beta.6', windowsAssets, true),
        ],
        '0.0.1-beta.4',
        'win32',
        'x64',
      ),
    ).toEqual({
      version: '0.0.1-beta.7',
      tagName: 'v0.0.1-beta.7',
      feedUrl: 'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.0.1-beta.7',
    });
  });

  it.each(['Sprint-Coder-Installer.exe', 'Sprint-Coder-Installer-0.7.0-beta.15.exe'])(
    'accepts Windows update assets with the installer named %s',
    (installerName) => {
      expect(
        selectUpdateRelease(
          [
            release('v0.7.0-beta.15', [
              { name: 'RELEASES' },
              { name: 'SprintCoder-0.7.0-beta15-full.nupkg' },
              { name: installerName },
            ]),
          ],
          '0.7.0-beta.14',
          'win32',
          'x64',
        ),
      ).toMatchObject({
        version: '0.7.0-beta.15',
        feedUrl: 'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.7.0-beta.15',
      });
    },
  );

  it('uses the architecture-specific macOS ZIP and manifest', () => {
    expect(
      selectUpdateRelease([release('v0.0.1-beta.5', macAssets)], '0.0.1-beta.4', 'darwin', 'arm64'),
    ).toEqual({
      version: '0.0.1-beta.5',
      tagName: 'v0.0.1-beta.5',
      feedUrl:
        'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.0.1-beta.5/RELEASES.json',
    });
    expect(
      selectUpdateRelease([release('v0.0.1-beta.5', macAssets)], '0.0.1-beta.4', 'darwin', 'x64'),
    ).toBeNull();
  });

  it('prefers a stable release over a beta of the same version', () => {
    expect(
      selectUpdateRelease(
        [release('v1.0.0-beta.9'), release('v1.0.0')],
        '1.0.0-beta.8',
        'win32',
        'x64',
      )?.version,
    ).toBe('1.0.0');
  });

  it('never moves a stable installation onto the lower-trust beta channel', () => {
    expect(
      selectUpdateRelease([release('v1.1.0-beta.1'), release('v1.0.1')], '1.0.0', 'win32', 'x64')
        ?.version,
    ).toBe('1.0.1');
    expect(selectUpdateRelease([release('v1.1.0-beta.1')], '1.0.0', 'win32', 'x64')).toBeNull();
  });
});

describe('supportsAutoUpdate', () => {
  it('only enables Windows updates for an installed x64 Squirrel app', () => {
    expect(
      supportsAutoUpdate({
        isPackaged: true,
        platform: 'win32',
        architecture: 'x64',
        executablePath:
          'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
        macAutoUpdateEligible: false,
      }),
    ).toBe(true);
    expect(
      supportsAutoUpdate({
        isPackaged: true,
        platform: 'win32',
        architecture: 'x64',
        executablePath: 'C:\\Downloads\\Sprint Coder.exe',
        macAutoUpdateEligible: false,
      }),
    ).toBe(false);
  });

  it('only enables the released ARM64 macOS build when compiled with a real signing identity', () => {
    const base = {
      isPackaged: true,
      platform: 'darwin',
      executablePath: '/Applications/Sprint Coder.app/Contents/MacOS/Sprint Coder',
    };
    expect(
      supportsAutoUpdate({ ...base, architecture: 'arm64', macAutoUpdateEligible: true }),
    ).toBe(true);
    expect(
      supportsAutoUpdate({ ...base, architecture: 'arm64', macAutoUpdateEligible: false }),
    ).toBe(false);
    expect(supportsAutoUpdate({ ...base, architecture: 'x64', macAutoUpdateEligible: true })).toBe(
      false,
    );
  });
});

describe('installUpdateWithFallback', () => {
  afterEach(() => vi.useRealTimers());

  it('terminates a disposed app if Squirrel does not quit after starting the install', () => {
    vi.useFakeTimers();
    const quitAndInstall = vi.fn();
    const exit = vi.fn();

    installUpdateWithFallback({
      quitAndInstall,
      exit,
      reportFailure: vi.fn(),
      fallbackDelayMs: 10_000,
    });

    expect(quitAndInstall).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(9_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('reports a synchronous installer failure and exits immediately', () => {
    vi.useFakeTimers();
    const failure = new Error('installer failed');
    const reportFailure = vi.fn();
    const exit = vi.fn();

    installUpdateWithFallback({
      quitAndInstall: () => {
        throw failure;
      },
      exit,
      reportFailure,
    });

    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function updateFixture(events: EventEmitter): AutoUpdateOptions {
  return {
    updater: {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(async () => null),
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
    } as unknown as AutoUpdateOptions['updater'],
    fetch: async () => ({ ok: true, status: 200, json: async () => [release('v0.0.1-beta.5')] }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    restartToInstall: async () => 'started',
    hasActiveWork: () => false,
    currentVersion: '0.0.1-beta.4',
    isPackaged: true,
    platform: 'win32',
    architecture: 'x64',
    executablePath:
      'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
    macAutoUpdateEligible: false,
  };
}

describe('startAutoUpdate', () => {
  afterEach(() => vi.useRealTimers());

  it('announces a downloaded update and restarts only on explicit request', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const setFeedURL = vi.fn();
    const checkForUpdates = vi.fn(async () => null);
    const restartToInstall = vi.fn(async () => 'started' as const);
    const onInstallStateChanged = vi.fn();
    const options = {
      updater: {
        setFeedURL,
        checkForUpdates,
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      },
      hasActiveWork: () => false,
      onInstallStateChanged,
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [release('v0.0.1-beta.5')],
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall,
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath:
        'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as unknown as AutoUpdateOptions;

    const controller = startAutoUpdate(options);
    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledOnce());
    expect(options.recordSuccess).not.toHaveBeenCalled();
    expect(setFeedURL).toHaveBeenCalledWith({
      url: 'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.0.1-beta.5',
    });
    await expect(controller.checkNow()).resolves.toEqual({
      status: 'update_available',
      version: '0.0.1-beta.5',
    });

    expect(controller.getInstallState()).toBe('unavailable');
    await controller.restart();
    expect(restartToInstall).not.toHaveBeenCalled();

    events.emit('update-downloaded');
    events.emit('update-downloaded');
    expect(controller.getInstallState()).toBe('ready');
    expect(onInstallStateChanged).toHaveBeenCalledExactlyOnceWith('ready');
    expect(options.recordSuccess).toHaveBeenCalledOnce();
    expect(restartToInstall).not.toHaveBeenCalled();
    await expect(controller.checkNow()).resolves.toEqual({
      status: 'update_available',
      version: '0.0.1-beta.5',
    });
    expect(checkForUpdates).toHaveBeenCalledTimes(2);

    await Promise.all([controller.restart(), controller.restart()]);
    expect(restartToInstall).toHaveBeenCalledOnce();
    expect(onInstallStateChanged).toHaveBeenLastCalledWith('restarting');
    events.emit('error', new Error('active Squirrel error'));
    events.emit('error', new Error('duplicate active Squirrel error'));
    expect(options.recordFailure).toHaveBeenCalledWith('updater');
    controller.stop();
    expect(events.listenerCount('update-downloaded')).toBe(0);
    expect(events.listenerCount('error')).toBe(1);
    expect(() => events.emit('error', new Error('late Squirrel error'))).not.toThrow();
    expect(options.logger.warn).toHaveBeenCalledWith(
      'Automatic updater reported an error',
      expect.any(Error),
    );
    expect(options.recordFailure).toHaveBeenCalledOnce();
  });

  it('does not reset persistent failure health when only the download start succeeds', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const recordSuccess = vi.fn();
    const recordFailure = vi.fn();
    const checkForUpdates = vi.fn(async () => null);
    const controller = startAutoUpdate({
      updater: {
        setFeedURL: vi.fn(),
        checkForUpdates,
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      hasActiveWork: () => false,
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [release('v0.0.1-beta.5')],
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall: vi.fn(async () => 'started' as const),
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath:
        'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
      recordSuccess,
      recordFailure,
    });

    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    events.emit('error', new Error('download failed'));
    await controller.checkNow();
    events.emit('error', new Error('download failed again'));
    await controller.checkNow();
    events.emit('error', new Error('download failed a third time'));

    expect(recordSuccess).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it('classifies updater failures without exposing their raw text to the health contract', () => {
    expect(
      classifyUpdateError(
        new Error(
          'C:\\Users\\alice\\AppData\\Local\\SprintCoder: CryptUnprotectData failed for token',
        ),
      ),
    ).toBe('decryption');
    expect(classifyUpdateError(new Error('fetch failed: ECONNRESET'))).toBe('network');
    expect(classifyUpdateError(new Error('GitHub Releases request failed with HTTP 503'))).toBe(
      'release_feed',
    );
  });

  it('blocks restart while work is active and enables the button when work ends', async () => {
    vi.useFakeTimers();
    let busy = true;
    const events = new EventEmitter();
    const restartToInstall = vi.fn(async () => 'started' as const);
    const onInstallStateChanged = vi.fn();
    const controller = startAutoUpdate({
      ...updateFixture(events),
      restartToInstall,
      hasActiveWork: () => busy,
      onInstallStateChanged,
    });

    events.emit('update-downloaded');
    expect(controller.getInstallState()).toBe('busy');
    expect(onInstallStateChanged).toHaveBeenCalledExactlyOnceWith('busy');
    await controller.restart();
    expect(restartToInstall).not.toHaveBeenCalled();

    busy = false;
    vi.advanceTimersByTime(1_000);
    expect(onInstallStateChanged).toHaveBeenLastCalledWith('ready');
    expect(restartToInstall).not.toHaveBeenCalled();

    // Work may start again before the titlebar gets the next state.
    busy = true;
    await controller.restart();
    expect(onInstallStateChanged).toHaveBeenLastCalledWith('busy');
    expect(restartToInstall).not.toHaveBeenCalled();

    controller.stop();
    expect(controller.getInstallState()).toBe('unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires a new click if the final install gate detects work', async () => {
    vi.useFakeTimers();
    let busy = false;
    const events = new EventEmitter();
    const restartToInstall = vi
      .fn<AutoUpdateOptions['restartToInstall']>()
      .mockImplementationOnce(async () => {
        busy = true;
        return 'busy';
      })
      .mockResolvedValueOnce('started');
    const onInstallStateChanged = vi.fn();
    const controller = startAutoUpdate({
      ...updateFixture(events),
      restartToInstall,
      hasActiveWork: () => busy,
      onInstallStateChanged,
    });

    events.emit('update-downloaded');
    await controller.restart();
    expect(restartToInstall).toHaveBeenCalledOnce();
    expect(onInstallStateChanged.mock.calls.map(([state]) => state)).toEqual([
      'ready',
      'restarting',
      'busy',
    ]);
    busy = false;
    vi.advanceTimersByTime(1_000);
    expect(onInstallStateChanged).toHaveBeenLastCalledWith('ready');
    expect(restartToInstall).toHaveBeenCalledOnce();
    await controller.restart();
    expect(restartToInstall).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('clears the restarting state if starting the installer throws', async () => {
    const events = new EventEmitter();
    const onInstallStateChanged = vi.fn();
    const controller = startAutoUpdate({
      ...updateFixture(events),
      restartToInstall: vi.fn().mockRejectedValue(new Error('private updater detail')),
      onInstallStateChanged,
    });

    events.emit('update-downloaded');
    await expect(controller.restart()).rejects.toThrow('更新を開始できませんでした。');
    expect(controller.getInstallState()).toBe('ready');
    expect(onInstallStateChanged).toHaveBeenLastCalledWith('ready');
    controller.stop();
  });

  it('marks the macOS manifest as a Squirrel JSON feed', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const setFeedURL = vi.fn();
    const checkForUpdates = vi.fn(async () => null);
    const controller = startAutoUpdate({
      updater: {
        setFeedURL,
        checkForUpdates,
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      hasActiveWork: () => false,
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [release('v0.0.1-beta.5', macAssets)],
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall: vi.fn(async () => 'started' as const),
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'darwin',
      architecture: 'arm64',
      executablePath: '/Applications/Sprint Coder.app/Contents/MacOS/Sprint Coder',
      macAutoUpdateEligible: true,
    });

    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledOnce());
    expect(setFeedURL).toHaveBeenCalledWith({
      url: 'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.0.1-beta.5/RELEASES.json',
      serverType: 'json',
    });
    controller.stop();
  });

  it('does not contact GitHub from development builds', async () => {
    const fetch = vi.fn();
    const controller = startAutoUpdate({
      updater: {} as AutoUpdateOptions['updater'],
      hasActiveWork: () => false,
      fetch,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall: vi.fn(async () => 'started' as const),
      currentVersion: '0.0.1-beta.4',
      isPackaged: false,
      platform: 'darwin',
      architecture: 'arm64',
      executablePath: '/tmp/Sprint Coder',
      macAutoUpdateEligible: false,
    });

    await expect(controller.checkNow()).resolves.toEqual({ status: 'unsupported' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports when a manual check confirms the current version is latest', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const recordSuccess = vi.fn();
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));
    const controller = startAutoUpdate({
      updater: {
        setFeedURL: vi.fn(),
        checkForUpdates: vi.fn(),
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      hasActiveWork: () => false,
      fetch,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall: vi.fn(async () => 'started' as const),
      currentVersion: '0.4.0',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath: 'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.4.0\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
      recordSuccess,
    });

    await vi.waitFor(() => expect(recordSuccess).toHaveBeenCalledOnce());
    await expect(controller.checkNow()).resolves.toEqual({ status: 'up_to_date' });
    controller.stop();
  });

  it('returns only the classified failure when a manual check fails', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const recordFailure = vi.fn();
    const fetch = vi.fn(async () => {
      throw new Error('fetch failed for /Users/alice/private/update.log');
    });
    const controller = startAutoUpdate({
      updater: {
        setFeedURL: vi.fn(),
        checkForUpdates: vi.fn(),
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      hasActiveWork: () => false,
      fetch,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall: vi.fn(async () => 'started' as const),
      currentVersion: '0.4.0',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath: 'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.4.0\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
      recordFailure,
    });

    await vi.waitFor(() => expect(recordFailure).toHaveBeenCalledOnce());
    await expect(controller.checkNow()).resolves.toEqual({
      status: 'failed',
      errorCategory: 'network',
    });
    controller.stop();
  });

  it('does not enter Electron autoUpdater after stop wins a release-discovery race', async () => {
    const events = new EventEmitter();
    const setFeedURL = vi.fn();
    const checkForUpdates = vi.fn(async () => null);
    const responseJson = vi.fn(async () => [release('v0.0.1-beta.5')]);
    let resolveFetch!: (response: {
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }) => void;
    const fetch = vi.fn(
      () =>
        new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const controller = startAutoUpdate({
      updater: {
        setFeedURL,
        checkForUpdates,
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      hasActiveWork: () => false,
      fetch,
      logger,
      restartToInstall: vi.fn(async () => 'started' as const),
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath:
        'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(controller.checkNow()).resolves.toEqual({ status: 'already_checking' });
    controller.stop();
    resolveFetch({ ok: true, status: 200, json: responseJson });
    await vi.waitFor(() => expect(responseJson).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(setFeedURL).not.toHaveBeenCalled();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(() => events.emit('error', new Error('late error'))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      'Automatic updater reported an error',
      expect.any(Error),
    );
  });
});
