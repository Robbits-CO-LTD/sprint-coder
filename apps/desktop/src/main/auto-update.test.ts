import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoUpdateOptions } from './auto-update';
import { selectUpdateRelease, startAutoUpdate, supportsAutoUpdate } from './auto-update';

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
      }),
    ).toBe(true);
    expect(
      supportsAutoUpdate({
        isPackaged: true,
        platform: 'win32',
        architecture: 'x64',
        executablePath: 'C:\\Downloads\\Sprint Coder.exe',
      }),
    ).toBe(false);
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
    } as unknown as AutoUpdateOptions;

    const controller = startAutoUpdate(options);
    await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledOnce());
    expect(setFeedURL).toHaveBeenCalledWith({
      url: 'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.0.1-beta.5',
    });

    events.emit('update-downloaded');
    await vi.waitFor(() => expect(restartToInstall).toHaveBeenCalledOnce());
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Sprint Coder 0.0.1-beta.5 を適用できます。' }),
    );
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
    });

    await controller.checkNow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
