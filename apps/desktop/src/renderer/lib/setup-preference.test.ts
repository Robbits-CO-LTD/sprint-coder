import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSetupComplete,
  readSetupMark,
  launchSetupFor,
  SETUP_COMPLETE_KEY,
  SETUP_VERSION,
  writeSetupComplete,
} from './setup-preference';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('setup preference', () => {
  it('decides the launch Setup only once the Tasks are known, from the current version’s mark', () => {
    expect(launchSetupFor({ initialized: false, taskCount: 0, setupMark: false })).toBeNull();
    expect(launchSetupFor({ initialized: false, taskCount: 3, setupMark: false })).toBeNull();
    // A new installation: the first run's Setup.
    expect(launchSetupFor({ initialized: true, taskCount: 0, setupMark: false })).toBe('first-run');
    // Tasks already (an update from an older version): the Setup without the Workspace step.
    expect(launchSetupFor({ initialized: true, taskCount: 1, setupMark: false })).toBe('returning');
    // This Setup already gone through: nothing, with or without Tasks.
    expect(launchSetupFor({ initialized: true, taskCount: 0, setupMark: true })).toBe('none');
    expect(launchSetupFor({ initialized: true, taskCount: 4, setupMark: true })).toBe('none');
  });

  it('shows nothing rather than guess: Tasks that could not be read, or a mark that cannot be kept', () => {
    // "No Task" is not known to be true when the read failed: no first run that cannot be left.
    expect(
      launchSetupFor({ initialized: true, taskCount: 0, setupMark: false, tasksLoadFailed: true }),
    ).toBe('none');
    // A mark that cannot be read cannot be kept either: no Setup over the app at every launch.
    expect(launchSetupFor({ initialized: true, taskCount: 2, setupMark: null })).toBe('none');
    // A new installation still gets its first run, as it did before the mark had a version.
    expect(launchSetupFor({ initialized: true, taskCount: 0, setupMark: null })).toBe('first-run');
  });

  it('reads an unreadable mark as unknown, and never throws writing one', () => {
    const refusing = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    vi.stubGlobal('window', { localStorage: refusing });
    expect(readSetupMark()).toBeNull();
    expect(readSetupComplete()).toBe(false);
    expect(() => writeSetupComplete()).not.toThrow();
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('no storage');
      },
    });
    expect(readSetupMark()).toBeNull();
    expect(() => writeSetupComplete()).not.toThrow();
  });

  it('the mark carries the Setup version, and an older version’s mark is not read', () => {
    expect(SETUP_COMPLETE_KEY).toBe(`sprint-coder:setup-complete-v${SETUP_VERSION}`);
    expect(SETUP_VERSION).toBeGreaterThanOrEqual(2);
    const localStorage = memoryStorage();
    localStorage.setItem('sprint-coder:setup-complete-v1', '1');
    vi.stubGlobal('window', { localStorage });
    expect(readSetupComplete()).toBe(false);
  });
  it('persists completion without throwing when storage is available', () => {
    const localStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage });
    expect(readSetupComplete()).toBe(false);
    writeSetupComplete();
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBe('1');
    expect(readSetupComplete()).toBe(true);
  });
});
