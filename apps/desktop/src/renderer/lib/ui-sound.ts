import { createUISFX, type CueName, type UISFXPlayer } from 'uisfx';

const SOUND_PREFERENCE_KEY = 'sprint-coder:sound-effects';
const DEFAULT_VOLUME = 0.2;

export type SoundEffectPreferences = Readonly<{
  enabled: boolean;
  volume: number;
}>;

type SoundEvent = Readonly<{
  type: string;
  state?: string;
}>;

let player: UISFXPlayer | null = null;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function clampVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.round(Math.max(0.1, Math.min(0.5, value)) * 10) / 10;
}

export function readSoundEffectPreferences(): SoundEffectPreferences {
  try {
    const raw = storage()?.getItem(SOUND_PREFERENCE_KEY);
    if (raw === null || raw === undefined) return { enabled: false, volume: DEFAULT_VOLUME };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null)
      return { enabled: false, volume: DEFAULT_VOLUME };
    const value = parsed as { enabled?: unknown; volume?: unknown };
    return {
      enabled: value.enabled === true,
      volume: clampVolume(value.volume),
    };
  } catch {
    return { enabled: false, volume: DEFAULT_VOLUME };
  }
}

function soundPlayer(): UISFXPlayer {
  if (player !== null) return player;
  const preferences = readSoundEffectPreferences();
  player = createUISFX({
    pack: 'minimal',
    enabled: preferences.enabled,
    volume: preferences.volume,
    preferences: { key: SOUND_PREFERENCE_KEY },
  });
  return player;
}

export function setSoundEffectsEnabled(enabled: boolean): void {
  soundPlayer().setEnabled(enabled);
}

export function setSoundEffectsVolume(volume: number): void {
  soundPlayer().setVolume(clampVolume(volume));
}

/** Unlock Web Audio only from a trusted user gesture; terminal events may arrive much later. */
export async function unlockSoundEffects(): Promise<boolean> {
  if (!readSoundEffectPreferences().enabled) return false;
  return soundPlayer().unlock();
}

export function soundCueForEvent(event: SoundEvent): CueName | null {
  if (event.type === 'approval.requested') return 'blocked';
  if (event.type !== 'turn.completed') return null;
  if (event.state === 'completed') return 'complete';
  if (event.state === 'failed' || event.state === 'interrupted') return 'error';
  return null;
}

export function playSoundForEvent(event: SoundEvent): void {
  const cue = soundCueForEvent(event);
  if (cue === null || !readSoundEffectPreferences().enabled) return;
  try {
    soundPlayer().play(cue);
  } catch {
    // Sound is supplementary feedback. Audio failures must never interrupt a Turn event.
  }
}
