import type { AccessPreset } from '../types/sprint-coder';

export type AccessPresetDefault = AccessPreset | 'last';

const LAST_ACCESS_PRESET_KEY = 'sprint-coder:last-access-preset';
const DEFAULT_ACCESS_PRESET_KEY = 'sprint-coder:default-access-preset';

function isAccessPreset(value: string | null): value is AccessPreset {
  return value === 'ask' || value === 'auto' || value === 'full';
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readAccessPresetDefault(): AccessPresetDefault {
  const value = storage()?.getItem(DEFAULT_ACCESS_PRESET_KEY) ?? null;
  return isAccessPreset(value) ? value : 'last';
}

export function writeAccessPresetDefault(value: AccessPresetDefault): void {
  const target = storage();
  if (target === null) return;
  if (value === 'last') target.removeItem(DEFAULT_ACCESS_PRESET_KEY);
  else target.setItem(DEFAULT_ACCESS_PRESET_KEY, value);
}

export function rememberAccessPreset(value: AccessPreset): void {
  storage()?.setItem(LAST_ACCESS_PRESET_KEY, value);
}

export function accessPresetForNewTask(): AccessPreset {
  const configured = readAccessPresetDefault();
  if (configured !== 'last') return configured;
  const previous = storage()?.getItem(LAST_ACCESS_PRESET_KEY) ?? null;
  return isAccessPreset(previous) ? previous : 'ask';
}
