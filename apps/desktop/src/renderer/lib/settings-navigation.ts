export const OPEN_LOCAL_AI_SETTINGS_EVENT = 'sprint-coder:open-local-ai-settings';

export function requestOpenLocalAiSettings(): void {
  window.dispatchEvent(new Event(OPEN_LOCAL_AI_SETTINGS_EVENT));
}
