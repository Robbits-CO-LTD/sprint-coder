import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readSoundEffectPreferences,
  setSoundEffectsEnabled,
  setSoundEffectsVolume,
  soundCueForEvent,
} from './ui-sound';

const SOUND_PREFERENCE_KEY = 'sprint-coder:sound-effects';

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

describe('UI sound preferences', () => {
  it('defaults to silent at 20 percent', () => {
    expect(readSoundEffectPreferences()).toEqual({ enabled: false, volume: 0.2 });
  });

  it('restores valid values and bounds stored volume', () => {
    window.localStorage.setItem(
      SOUND_PREFERENCE_KEY,
      JSON.stringify({ enabled: true, volume: 0.35 }),
    );
    expect(readSoundEffectPreferences()).toEqual({ enabled: true, volume: 0.4 });

    window.localStorage.setItem(SOUND_PREFERENCE_KEY, JSON.stringify({ enabled: true, volume: 8 }));
    expect(readSoundEffectPreferences()).toEqual({ enabled: true, volume: 0.5 });
  });

  it('fails closed for unavailable or malformed storage', () => {
    window.localStorage.setItem(SOUND_PREFERENCE_KEY, '{');
    expect(readSoundEffectPreferences()).toEqual({ enabled: false, volume: 0.2 });
  });

  it('persists changes through the UISFX preference adapter', () => {
    setSoundEffectsEnabled(true);
    setSoundEffectsVolume(0.3);

    expect(readSoundEffectPreferences()).toEqual({ enabled: true, volume: 0.3 });
  });
});

describe('UI sound event mapping', () => {
  it('maps only the three deliberate attention states', () => {
    expect(soundCueForEvent({ type: 'turn.completed', state: 'completed' })).toBe('complete');
    expect(soundCueForEvent({ type: 'turn.completed', state: 'failed' })).toBe('error');
    expect(soundCueForEvent({ type: 'turn.completed', state: 'interrupted' })).toBe('error');
    expect(soundCueForEvent({ type: 'approval.requested' })).toBe('blocked');
  });

  it('keeps routine and canceled events silent', () => {
    expect(soundCueForEvent({ type: 'turn.completed', state: 'canceled' })).toBeNull();
    expect(soundCueForEvent({ type: 'message.delta' })).toBeNull();
  });
});
