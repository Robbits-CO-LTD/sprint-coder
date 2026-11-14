import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSetupComplete,
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
    expect(launchSetupFor({ initialized: false, taskCount: 0, setupComplete: false })).toBeNull();
    expect(launchSetupFor({ initialized: false, taskCount: 3, setupComplete: false })).toBeNull();
    // A new installation: the first run's Setup.
    expect(launchSetupFor({ initialized: true, taskCount: 0, setupComplete: false })).toBe(
      'first-run',
    );
    // Tasks already (an update from an older version): the Setup without the Workspace step.
    expect(launchSetupFor({ initialized: true, taskCount: 1, setupComplete: false })).toBe(
      'returning',
    );
    // This Setup already gone through: nothing, with or without Tasks.
    expect(launchSetupFor({ initialized: true, taskCount: 0, setupComplete: true })).toBe('none');
    expect(launchSetupFor({ initialized: true, taskCount: 4, setupComplete: true })).toBe('none');
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
