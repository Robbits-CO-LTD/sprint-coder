import { describe, expect, it, vi } from 'vitest';
import {
  applyWindowControl,
  isWindowControlAction,
  presentWindow,
  restoreWindow,
  windowChromeOptions,
  type WindowPresentationTarget,
  type WindowRestoreTarget,
  type WindowControlTarget,
} from './window-controls';

function target(maximized = false): WindowControlTarget {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(() => maximized),
    close: vi.fn(),
  };
}

describe('windowChromeOptions', () => {
  it('keeps only the native traffic lights over product chrome on macOS', () => {
    expect(windowChromeOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 13 },
    });
  });

  it('removes the Windows frame so the renderer owns the complete titlebar', () => {
    expect(windowChromeOptions('win32')).toEqual({ frame: false, autoHideMenuBar: true });
  });

  it('leaves Linux on its existing native frame', () => {
    expect(windowChromeOptions('linux')).toEqual({ autoHideMenuBar: true });
  });
});

describe('window controls', () => {
  it('accepts only the three fixed renderer actions', () => {
    expect(isWindowControlAction('minimize')).toBe(true);
    expect(isWindowControlAction('toggle-maximize')).toBe(true);
    expect(isWindowControlAction('close')).toBe(true);
    expect(isWindowControlAction('maximize')).toBe(false);
    expect(isWindowControlAction({ action: 'close' })).toBe(false);
  });

  it('minimizes and closes through the exact BrowserWindow target', () => {
    const window = target();
    applyWindowControl(window, 'minimize');
    applyWindowControl(window, 'close');
    expect(window.minimize).toHaveBeenCalledOnce();
    expect(window.close).toHaveBeenCalledOnce();
  });

  it('maximizes a restored window and restores a maximized window', () => {
    const restored = target(false);
    applyWindowControl(restored, 'toggle-maximize');
    expect(restored.maximize).toHaveBeenCalledOnce();
    expect(restored.unmaximize).not.toHaveBeenCalled();

    const maximized = target(true);
    applyWindowControl(maximized, 'toggle-maximize');
    expect(maximized.unmaximize).toHaveBeenCalledOnce();
    expect(maximized.maximize).not.toHaveBeenCalled();
  });
});

describe('window presentation', () => {
  function presentationTarget(): WindowPresentationTarget {
    return { show: vi.fn(), showInactive: vi.fn() };
  }

  it('shows normal launches with focus-capable presentation', () => {
    const window = presentationTarget();
    presentWindow(window, {});
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it('shows E2E launches without activating the app', () => {
    const window = presentationTarget();
    presentWindow(window, { SPRINT_CODER_E2E_BACKGROUND: '1' });
    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
  });

  it('restores normal windows and focuses them', () => {
    const window: WindowRestoreTarget = {
      ...presentationTarget(),
      focus: vi.fn(),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => false),
      restore: vi.fn(),
    };
    restoreWindow(window, {});
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it('restores hidden E2E windows without focusing them', () => {
    const window: WindowRestoreTarget = {
      ...presentationTarget(),
      focus: vi.fn(),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => false),
      restore: vi.fn(),
    };
    restoreWindow(window, { SPRINT_CODER_E2E_BACKGROUND: '1' });
    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.focus).not.toHaveBeenCalled();
  });
});
