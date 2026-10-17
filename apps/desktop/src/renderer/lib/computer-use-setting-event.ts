/**
 * Fired on `window` after Main saved the Computer Use (beta) setting, so the entry point that
 * fetched availability on mount reads it again instead of waiting for a restart.
 */
export const COMPUTER_USE_SETTING_CHANGED_EVENT = 'sprint-coder:computer-use-setting-changed';

export function announceComputerUseSettingChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(COMPUTER_USE_SETTING_CHANGED_EVENT));
}
