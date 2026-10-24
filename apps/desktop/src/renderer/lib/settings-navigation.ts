export const OPEN_PROVIDER_SETTINGS_EVENT = 'sprint-coder:open-provider-settings';

export function requestOpenProviderSettings(): void {
  window.dispatchEvent(new Event(OPEN_PROVIDER_SETTINGS_EVENT));
}
