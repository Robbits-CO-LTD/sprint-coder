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
const activeTurn = { taskId: 'task-1', turnId: 'turn-1', taskTitle: '長い作業' };

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

describe('startAutoUpdate', () => {
  afterEach(() => vi.useRealTimers());

  it('downloads a discovered update and restarts only after user confirmation', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const setFeedURL = vi.fn();
    const checkForUpdates = vi.fn(async () => null);
    const restartToInstall = vi.fn();
    const showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
    const options = {
      updater: {
        setFeedURL,
        checkForUpdates,
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      },
      dialog: { showMessageBox },
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
    expect(options.recordSuccess).toHaveBeenCalledOnce();
    expect(setFeedURL).toHaveBeenCalledWith({
      url: 'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.0.1-beta.5',
    });

    events.emit('update-downloaded');
    await vi.waitFor(() => expect(restartToInstall).toHaveBeenCalledOnce());
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Sprint Coder 0.0.1-beta.5 を適用できます。' }),
    );
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

  it('does not restart while a Turn is active and offers all safe choices', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const restartToInstall = vi.fn(async () => true);
    const showMessageBox = vi
      .fn()
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 2, checkboxChecked: false });
    const controller = startAutoUpdate({
      updater: {
        setFeedURL: vi.fn(),
        checkForUpdates: vi.fn(async () => null),
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      dialog: { showMessageBox } as unknown as AutoUpdateOptions['dialog'],
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [release('v0.0.1-beta.5')],
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall,
      getActiveTurns: vi.fn(async () => [activeTurn]),
      stopActiveTurns: vi.fn(),
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath:
        'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
    });

    await vi.waitFor(() => expect(events.listenerCount('update-downloaded')).toBe(1));
    events.emit('update-downloaded');
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(2));

    expect(showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ buttons: ['完了を待つ', 'Turnを停止して更新', 'あとで'] }),
    );
    expect(restartToInstall).not.toHaveBeenCalled();
    controller.stop();
  });

  it('stops the exact active Turn before installing and revalidates idle state', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const restartToInstall = vi.fn(async () => true);
    const stopActiveTurns = vi.fn(async () => undefined);
    const getActiveTurns = vi.fn().mockResolvedValueOnce([activeTurn]).mockResolvedValueOnce([]);
    const showMessageBox = vi
      .fn()
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const controller = startAutoUpdate({
      updater: {
        setFeedURL: vi.fn(),
        checkForUpdates: vi.fn(async () => null),
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      dialog: { showMessageBox } as unknown as AutoUpdateOptions['dialog'],
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [release('v0.0.1-beta.5')],
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall,
      getActiveTurns,
      stopActiveTurns,
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath:
        'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
    });

    await vi.waitFor(() => expect(events.listenerCount('update-downloaded')).toBe(1));
    events.emit('update-downloaded');
    await vi.waitFor(() => expect(restartToInstall).toHaveBeenCalledOnce());

    expect(stopActiveTurns).toHaveBeenCalledWith([activeTurn]);
    expect(getActiveTurns).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('waits for active Turns to finish before revalidating and installing', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const restartToInstall = vi.fn(async () => true);
    const getActiveTurns = vi
      .fn()
      .mockResolvedValueOnce([activeTurn])
      .mockResolvedValueOnce([activeTurn])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const showMessageBox = vi
      .fn()
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const controller = startAutoUpdate({
      updater: {
        setFeedURL: vi.fn(),
        checkForUpdates: vi.fn(async () => null),
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      dialog: { showMessageBox } as unknown as AutoUpdateOptions['dialog'],
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [release('v0.0.1-beta.5')],
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall,
      getActiveTurns,
      stopActiveTurns: vi.fn(),
      activeTurnPollIntervalMs: 100,
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath:
        'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
    });

    await vi.waitFor(() => expect(events.listenerCount('update-downloaded')).toBe(1));
    events.emit('update-downloaded');
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(2));
    expect(restartToInstall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(restartToInstall).toHaveBeenCalledOnce());
    expect(getActiveTurns).toHaveBeenCalledTimes(4);
    controller.stop();
  });

  it('returns to the safety prompt when the final install gate detects a new Turn', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const restartToInstall = vi.fn(async () => false);
    const showMessageBox = vi
      .fn()
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 2, checkboxChecked: false });
    const getActiveTurns = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([activeTurn]);
    const controller = startAutoUpdate({
      updater: {
        setFeedURL: vi.fn(),
        checkForUpdates: vi.fn(async () => null),
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      dialog: { showMessageBox } as unknown as AutoUpdateOptions['dialog'],
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [release('v0.0.1-beta.5')],
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall,
      getActiveTurns,
      stopActiveTurns: vi.fn(),
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath:
        'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
    });

    await vi.waitFor(() => expect(events.listenerCount('update-downloaded')).toBe(1));
    events.emit('update-downloaded');
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(2));

    expect(restartToInstall).toHaveBeenCalledOnce();
    expect(showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ buttons: ['完了を待つ', 'Turnを停止して更新', 'あとで'] }),
    );
    controller.stop();
  });

  it('retries the final gate when transient busy work finishes before the re-query', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const restartToInstall = vi.fn().mockResolvedValueOnce('busy').mockResolvedValueOnce('started');
    const getActiveTurns = vi.fn(async () => []);
    const controller = startAutoUpdate({
      updater: {
        setFeedURL: vi.fn(),
        checkForUpdates: vi.fn(async () => null),
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
      } as unknown as AutoUpdateOptions['updater'],
      dialog: {
        showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
      } as unknown as AutoUpdateOptions['dialog'],
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [release('v0.0.1-beta.5')],
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall,
      getActiveTurns,
      stopActiveTurns: vi.fn(),
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath:
        'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
    });

    await vi.waitFor(() => expect(events.listenerCount('update-downloaded')).toBe(1));
    events.emit('update-downloaded');
    await vi.waitFor(() => expect(restartToInstall).toHaveBeenCalledTimes(2));

    expect(getActiveTurns).toHaveBeenCalledTimes(2);
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
      dialog: { showMessageBox: vi.fn() } as unknown as AutoUpdateOptions['dialog'],
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [release('v0.0.1-beta.5', macAssets)],
      })),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall: vi.fn(),
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
      dialog: {} as AutoUpdateOptions['dialog'],
      fetch,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      restartToInstall: vi.fn(),
      currentVersion: '0.0.1-beta.4',
      isPackaged: false,
      platform: 'darwin',
      architecture: 'arm64',
      executablePath: '/tmp/Sprint Coder',
      macAutoUpdateEligible: false,
    });

    await controller.checkNow();
    expect(fetch).not.toHaveBeenCalled();
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
      dialog: { showMessageBox: vi.fn() } as unknown as AutoUpdateOptions['dialog'],
      fetch,
      logger,
      restartToInstall: vi.fn(),
      currentVersion: '0.0.1-beta.4',
      isPackaged: true,
      platform: 'win32',
      architecture: 'x64',
      executablePath:
        'C:\\Users\\me\\AppData\\Local\\SprintCoder\\app-0.0.1-beta.4\\Sprint Coder.exe',
      macAutoUpdateEligible: false,
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
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
