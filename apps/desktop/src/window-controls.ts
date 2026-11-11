import type { BrowserWindowConstructorOptions } from 'electron';

export const WINDOW_CONTROL_CHANNELS = {
  action: 'sprint-coder:window:control',
  getMaximized: 'sprint-coder:window:get-maximized',
  maximizedChanged: 'sprint-coder:window:maximized-changed',
} as const;

export const WINDOW_CONTROL_ACTIONS = ['minimize', 'toggle-maximize', 'close'] as const;
export type WindowControlAction = (typeof WINDOW_CONTROL_ACTIONS)[number];

export type WindowControlTarget = {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  close(): void;
};

export type WindowPresentationTarget = {
  show(): void;
  showInactive(): void;
};

export type WindowRestoreTarget = WindowPresentationTarget & {
  focus(): void;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
};

export function usesInactiveWindowPresentation(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  return environment['SPRINT_CODER_E2E_BACKGROUND'] === '1';
}

export function usesHiddenWindowPresentation(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  return environment['SPRINT_CODER_E2E_HIDDEN'] === '1';
}

/** Keeps automated app windows visible for rendering without stealing OS focus. */
export function presentWindow(
  target: WindowPresentationTarget,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): void {
  if (usesHiddenWindowPresentation(environment)) return;
  if (usesInactiveWindowPresentation(environment)) target.showInactive();
  else target.show();
}

/** Restores an existing window while preserving the developer's active app during E2E. */
export function restoreWindow(
  target: WindowRestoreTarget,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): void {
  if (usesHiddenWindowPresentation(environment)) return;
  if (target.isMinimized()) target.restore();
  if (!target.isVisible()) presentWindow(target, environment);
  if (!usesInactiveWindowPresentation(environment)) target.focus();
}

/** Keeps Linux on its existing native frame while macOS and Windows use product-owned chrome. */
export function windowChromeOptions(
  platform: NodeJS.Platform,
): Partial<BrowserWindowConstructorOptions> {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 13 },
    };
  }
  if (platform === 'win32') return { frame: false, autoHideMenuBar: true };
  return { autoHideMenuBar: true };
}

/**
 * Chromium features turned off before the app is ready.
 *
 * On Windows, Chromium marks a window it judges fully covered as hidden: it stops painting it and
 * stops updating its accessibility tree. It judges again when a window is shown, moved, resized or
 * activated, but not when only the stacking order changes. A desktop-control launch shows the new
 * app's window on top of everything (Sprint Coder is judged covered) and then moves it below the
 * window that was in front by a stacking-order change alone, so Sprint Coder stayed "hidden" while
 * it was in plain view: the screen kept the frame from the launch (the command still "running",
 * no approval card) and screen readers saw nothing new until the window was moved or re-activated.
 */
export function disabledChromiumFeatures(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['CalculateNativeWinOcclusion'] : [];
}

export function isWindowControlAction(value: unknown): value is WindowControlAction {
  return WINDOW_CONTROL_ACTIONS.some((action) => action === value);
}

export function applyWindowControl(target: WindowControlTarget, action: WindowControlAction): void {
  switch (action) {
    case 'minimize':
      target.minimize();
      break;
    case 'toggle-maximize':
      if (target.isMaximized()) target.unmaximize();
      else target.maximize();
      break;
    case 'close':
      target.close();
      break;
  }
}
