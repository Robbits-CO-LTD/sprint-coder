import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessPresetForNewTask,
  readAccessPresetDefault,
  rememberAccessPreset,
  writeAccessPresetDefault,
} from './access-preset-preference';

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

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: memoryStorage() });
});

describe('access preset preference', () => {
  it('starts safe and reuses only non-privileged confirmed selections', () => {
    expect(accessPresetForNewTask()).toBe('ask');
    rememberAccessPreset('auto');
    expect(accessPresetForNewTask()).toBe('auto');
    rememberAccessPreset('full');
    expect(accessPresetForNewTask()).toBe('ask');
  });

  it('lets an explicit settings default override later task selections', () => {
    rememberAccessPreset('full');
    writeAccessPresetDefault('auto');
    expect(readAccessPresetDefault()).toBe('auto');
    expect(accessPresetForNewTask()).toBe('auto');

    rememberAccessPreset('ask');
    expect(accessPresetForNewTask()).toBe('auto');
  });

  it('returns to safe last-selection behavior when the settings override is cleared', () => {
    rememberAccessPreset('full');
    writeAccessPresetDefault('ask');
    writeAccessPresetDefault('last');
    expect(readAccessPresetDefault()).toBe('last');
    expect(accessPresetForNewTask()).toBe('ask');
  });

  it('ignores a stale full-access default from older builds or tampered storage', () => {
    window.localStorage.setItem('sprint-coder:default-access-preset', 'full');
    window.localStorage.setItem('sprint-coder:last-access-preset', 'full');
    expect(readAccessPresetDefault()).toBe('last');
    expect(accessPresetForNewTask()).toBe('ask');
  });
});
