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
  if (value === 'last' || isAccessPreset(value)) return value;
  // Earlier versions represented "last" by a missing default and a remembered selection.
  return readLastAccessPreset() === null ? 'auto' : 'last';
}

export function writeAccessPresetDefault(value: AccessPresetDefault): void {
  const target = storage();
  if (target === null) return;
  target.setItem(DEFAULT_ACCESS_PRESET_KEY, value);
}

/** The safety setting last chosen for a Task, if any: what `last` ("前回選択した設定") carries over. */
export function readLastAccessPreset(): AccessPreset | null {
  const value = storage()?.getItem(LAST_ACCESS_PRESET_KEY) ?? null;
  return isAccessPreset(value) ? value : null;
}

export function rememberAccessPreset(value: AccessPreset): void {
  const target = storage();
  if (target === null) return;
  if (target.getItem(DEFAULT_ACCESS_PRESET_KEY) === null)
    target.setItem(DEFAULT_ACCESS_PRESET_KEY, readAccessPresetDefault());
  target.setItem(LAST_ACCESS_PRESET_KEY, value);
}

export function accessPresetForNewTask(): AccessPreset {
  const configured = readAccessPresetDefault();
  if (configured !== 'last') return configured;
  return readLastAccessPreset() ?? 'auto';
}
