import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPUTER_USE_EMERGENCY_ACCELERATOR,
  ComputerUseEmergencyStop,
  computerUseVisualPointBlocked,
  positionComputerUseStopOverlay,
} from './computer-use-emergency-stop';

const electronMocks = vi.hoisted(() => ({
  BrowserWindow: vi.fn(),
  globalShortcut: {
    register: vi.fn(() => true),
    isRegistered: vi.fn(() => true),
    unregister: vi.fn(),
  },
  screen: {
    getDisplayNearestPoint: vi.fn(() => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
    })),
    getDisplayMatching: vi.fn(() => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
    })),
    getAllDisplays: vi.fn(() => [{ id: 1, workArea: { x: 0, y: 0, width: 1200, height: 800 } }]),
  },
}));

vi.mock('electron', () => electronMocks);

describe('Computer Use emergency stop', () => {
  const workArea = { x: 0, y: 0, width: 1200, height: 800 };

  beforeEach(() => {
    electronMocks.BrowserWindow.mockReset();
    electronMocks.globalShortcut.register.mockReset().mockReturnValue(true);
    electronMocks.globalShortcut.isRegistered.mockReset().mockReturnValue(true);
    electronMocks.globalShortcut.unregister.mockReset();
    electronMocks.screen.getDisplayMatching.mockReset().mockReturnValue({
      id: 1,
      workArea,
    });
    electronMocks.screen.getAllDisplays.mockReset().mockReturnValue([{ id: 1, workArea }]);
  });

  it('uses a fixed non-text emergency accelerator', () => {
    expect(COMPUTER_USE_EMERGENCY_ACCELERATOR).toBe('CommandOrControl+Shift+F8');
  });

  it('places the overlay outside the target when the right edge has room', () => {
    expect(
      positionComputerUseStopOverlay(workArea, { x: 100, y: 80, width: 700, height: 600 }),
    ).toEqual({ x: 812, y: 80 });
  });

  it('uses the left edge but refuses a same-display position that overlaps the target', () => {
    expect(
      positionComputerUseStopOverlay(workArea, { x: 300, y: 780, width: 850, height: 40 }),
    ).toEqual({ x: 144, y: 736 });
    expect(
      positionComputerUseStopOverlay(workArea, { x: 0, y: 0, width: 1200, height: 800 }),
    ).toBeNull();
  });

  it('marks only visual coordinates covered by the non-activating Stop overlay', () => {
    const target = { x: 0, y: 0, width: 1200, height: 800 };
    const overlay = { x: 1044, y: 12, width: 144, height: 52 };
    expect(computerUseVisualPointBlocked(target, overlay, 0.95, 0.04)).toBe(true);
    expect(computerUseVisualPointBlocked(target, overlay, 0.5, 0.5)).toBe(false);
  });

  it('unregisters the shortcut when overlay construction throws', async () => {
    electronMocks.BrowserWindow.mockImplementation(() => {
      throw new Error('overlay construction failed');
    });
    const stop = new ComputerUseEmergencyStop({ onStop: vi.fn() });

    await expect(stop.arm({ x: 0, y: 0, width: 800, height: 600 })).resolves.toBe(false);
    expect(electronMocks.globalShortcut.unregister).toHaveBeenCalledWith(
      COMPUTER_USE_EMERGENCY_ACCELERATOR,
    );
  });

  it('uses a non-overlapping second display and keeps the static overlay non-focusable', async () => {
    electronMocks.screen.getAllDisplays.mockReturnValue([
      { id: 1, workArea },
      { id: 2, workArea: { x: 1200, y: 0, width: 1200, height: 800 } },
    ]);
    const overlay = {
      setContentProtection: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      webContents: {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      },
      once: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      isDestroyed: vi.fn(() => false),
      showInactive: vi.fn(),
      destroy: vi.fn(),
      getBounds: vi.fn(() => ({ x: 1212, y: 12, width: 144, height: 52 })),
      setPosition: vi.fn(),
    };
    electronMocks.BrowserWindow.mockImplementation(() => overlay);
    const stop = new ComputerUseEmergencyStop({ onStop: vi.fn() });

    await expect(stop.arm({ x: 0, y: 0, width: 1200, height: 800 })).resolves.toBe(true);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ x: 1212, y: 12, focusable: false, alwaysOnTop: true }),
    );
    expect(overlay.showInactive).toHaveBeenCalledOnce();
    expect(stop.reposition({ x: 100, y: 80, width: 700, height: 600 })).toBe(true);
    expect(overlay.setPosition).toHaveBeenCalledWith(812, 80, false);
  });

  it('refuses to arm when no display can host the overlay outside the target', async () => {
    const stop = new ComputerUseEmergencyStop({ onStop: vi.fn() });

    await expect(stop.arm({ x: 0, y: 0, width: 1200, height: 800 })).resolves.toBe(false);
    expect(electronMocks.BrowserWindow).not.toHaveBeenCalled();
    expect(electronMocks.globalShortcut.unregister).toHaveBeenCalledWith(
      COMPUTER_USE_EMERGENCY_ACCELERATOR,
    );
  });

  it('returns failure and disarms when authoritative target bounds leave no safe overlay position', async () => {
    const overlay = {
      setContentProtection: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() },
      once: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      isDestroyed: vi.fn(() => false),
      showInactive: vi.fn(),
      destroy: vi.fn(),
      getBounds: vi.fn(() => ({ x: 812, y: 80, width: 144, height: 52 })),
      setPosition: vi.fn(),
    };
    electronMocks.screen.getAllDisplays.mockReturnValue([
      { id: 1, workArea },
      { id: 2, workArea: { x: 1200, y: 0, width: 1200, height: 800 } },
    ]);
    electronMocks.BrowserWindow.mockImplementation(() => overlay);
    const stop = new ComputerUseEmergencyStop({ onStop: vi.fn() });
    await expect(stop.arm({ x: 0, y: 0, width: 1200, height: 800 })).resolves.toBe(true);

    electronMocks.screen.getAllDisplays.mockReturnValue([{ id: 1, workArea }]);
    expect(stop.reposition({ x: 0, y: 0, width: 1200, height: 800 })).toBe(false);
    expect(overlay.destroy).toHaveBeenCalledOnce();
  });
});
