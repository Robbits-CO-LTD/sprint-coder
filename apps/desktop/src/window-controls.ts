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
