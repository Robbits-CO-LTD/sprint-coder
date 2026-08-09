export const SETUP_COMPLETE_KEY = 'sprint-coder:setup-complete-v1';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readSetupComplete(): boolean {
  return storage()?.getItem(SETUP_COMPLETE_KEY) === '1';
}

export function writeSetupComplete(): void {
  storage()?.setItem(SETUP_COMPLETE_KEY, '1');
}

export function shouldShowSetupWizard(input: {
  initialized: boolean;
  taskCount: number;
  setupComplete: boolean;
}): boolean {
  return input.initialized && input.taskCount === 0 && !input.setupComplete;
}
