import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readStoredTeamViewPreference,
  writeStoredTeamViewPreference,
} from './team-view-preference';

const TEAM_VIEW_PREFERENCE_KEY = 'sprint-coder:team-view-preference';

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

describe('team view preference', () => {
  it('restores list and falls back to canvas for missing, canvas, or unknown values', () => {
    expect(readStoredTeamViewPreference()).toBe('canvas');

    window.localStorage.setItem(TEAM_VIEW_PREFERENCE_KEY, 'canvas');
    expect(readStoredTeamViewPreference()).toBe('canvas');

    window.localStorage.setItem(TEAM_VIEW_PREFERENCE_KEY, 'unknown');
    expect(readStoredTeamViewPreference()).toBe('canvas');

    window.localStorage.setItem(TEAM_VIEW_PREFERENCE_KEY, 'list');
    expect(readStoredTeamViewPreference()).toBe('list');
  });

  it('writes canvas and list using the existing storage key', () => {
    writeStoredTeamViewPreference('canvas');
    expect(window.localStorage.getItem(TEAM_VIEW_PREFERENCE_KEY)).toBe('canvas');

    writeStoredTeamViewPreference('list');
    expect(window.localStorage.getItem(TEAM_VIEW_PREFERENCE_KEY)).toBe('list');
  });

  it('falls back to canvas when reading throws', () => {
    vi.stubGlobal('window', {
      localStorage: {
        ...memoryStorage(),
        getItem: () => {
          throw new Error('storage unavailable');
        },
      },
    });

    expect(readStoredTeamViewPreference()).toBe('canvas');
  });

  it('does not throw when writing fails', () => {
    vi.stubGlobal('window', {
      localStorage: {
        ...memoryStorage(),
        setItem: () => {
          throw new Error('storage unavailable');
        },
      },
    });

    expect(() => writeStoredTeamViewPreference('list')).not.toThrow();
  });
});
