import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSetupComplete,
  SETUP_COMPLETE_KEY,
  shouldShowSetupWizard,
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
  it('shows only for an initialized installation with no tasks', () => {
    expect(shouldShowSetupWizard({ initialized: false, taskCount: 0, setupComplete: false })).toBe(
      false,
    );
    expect(shouldShowSetupWizard({ initialized: true, taskCount: 1, setupComplete: false })).toBe(
      false,
    );
    expect(shouldShowSetupWizard({ initialized: true, taskCount: 0, setupComplete: true })).toBe(
      false,
    );
    expect(shouldShowSetupWizard({ initialized: true, taskCount: 0, setupComplete: false })).toBe(
      true,
    );
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
