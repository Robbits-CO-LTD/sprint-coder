import { BrowserWindow, globalShortcut, screen, type Rectangle } from 'electron';
import type { ComputerUseAction } from '@sprint-coder/contracts';

export const COMPUTER_USE_EMERGENCY_ACCELERATOR = 'CommandOrControl+Shift+F8';
export const COMPUTER_USE_STOP_OVERLAY_SIZE = Object.freeze({ width: 144, height: 52 });

export type ComputerUseEmergencyStopOptions = Readonly<{
  onStop: () => void | Promise<void>;
}>;

/**
 * Owns both stop paths that remain reachable while the controlled application is foreground.
 * The overlay has no preload or renderer bridge: Main handles its trusted mouse event directly.
 */
export class ComputerUseEmergencyStop {
  private overlay: BrowserWindow | null = null;
  private targetBounds: Rectangle | null = null;
  private armed = false;

  constructor(private readonly options: ComputerUseEmergencyStopOptions) {}

  async arm(targetBounds?: Rectangle): Promise<boolean> {
    if (this.armed) return true;
    let registered: boolean;
    try {
      registered = globalShortcut.register(COMPUTER_USE_EMERGENCY_ACCELERATOR, () => {
        void this.options.onStop();
      });
    } catch {
      registered = false;
    }
    if (!registered || !globalShortcut.isRegistered(COMPUTER_USE_EMERGENCY_ACCELERATOR)) {
      globalShortcut.unregister(COMPUTER_USE_EMERGENCY_ACCELERATOR);
      return false;
    }

    let overlay: BrowserWindow | null = null;
    try {
      if (targetBounds === undefined)
        throw new Error('Computer Use Stop overlay requires target bounds');
      const matchingDisplay = screen.getDisplayMatching(targetBounds);
      const displays = [
        matchingDisplay,
        ...screen.getAllDisplays().filter((display) => display.id !== matchingDisplay.id),
      ];
      const position = displays
        .map((display) => positionComputerUseStopOverlay(display.workArea, targetBounds))
        .find((candidate) => candidate !== null);
      if (position === undefined)
        throw new Error('No display can host the Computer Use Stop overlay outside the target');
      overlay = new BrowserWindow({
        ...COMPUTER_USE_STOP_OVERLAY_SIZE,
        ...position,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
        },
      });
      overlay.setContentProtection(true);
      if (process.platform === 'darwin')
        overlay.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      overlay.webContents.on('will-navigate', (event) => event.preventDefault());
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      overlay.webContents.on('before-mouse-event', (_event, mouse) => {
        if (mouse.type === 'mouseDown' && mouse.button === 'left') void this.options.onStop();
      });
      overlay.once('closed', () => {
        if (this.overlay === overlay) this.overlay = null;
      });
      await overlay.loadURL(stopOverlayDataUrl());
      if (overlay.isDestroyed()) throw new Error('Computer Use Stop overlay was destroyed');
      overlay.showInactive();
      this.overlay = overlay;
      this.targetBounds = targetBounds ?? null;
      this.armed = true;
      return true;
    } catch {
      if (overlay !== null && !overlay.isDestroyed()) overlay.destroy();
      globalShortcut.unregister(COMPUTER_USE_EMERGENCY_ACCELERATOR);
      return false;
    }
  }

  reposition(targetBounds: Rectangle): boolean {
    const overlay = this.overlay;
    if (overlay === null || overlay.isDestroyed()) return false;
    try {
      const matchingDisplay = screen.getDisplayMatching(targetBounds);
      const displays = [
        matchingDisplay,
        ...screen.getAllDisplays().filter((display) => display.id !== matchingDisplay.id),
      ];
      const position = displays
        .map((display) => positionComputerUseStopOverlay(display.workArea, targetBounds))
        .find((candidate) => candidate !== null);
      if (position === undefined) {
        this.disarm();
        return false;
      }
      overlay.setPosition(position.x, position.y, false);
      this.targetBounds = targetBounds;
      return true;
    } catch {
      this.disarm();
      return false;
    }
  }

  blocksTargetAction(action: ComputerUseAction): boolean {
    const overlay = this.overlay;
    const targetBounds = this.targetBounds;
    if (
      overlay === null ||
      overlay.isDestroyed() ||
      targetBounds === null ||
      (action.type !== 'click' && action.type !== 'scroll')
    )
      return false;
    return computerUseVisualPointBlocked(targetBounds, overlay.getBounds(), action.x, action.y);
  }

  disarm(): void {
    this.armed = false;
    globalShortcut.unregister(COMPUTER_USE_EMERGENCY_ACCELERATOR);
    const overlay = this.overlay;
    this.overlay = null;
    this.targetBounds = null;
    if (overlay !== null && !overlay.isDestroyed()) overlay.destroy();
  }

  dispose(): void {
    this.disarm();
  }
}

export function computerUseVisualPointBlocked(
  targetBounds: Rectangle,
  overlayBounds: Rectangle,
  normalizedX: number,
  normalizedY: number,
): boolean {
  const x = targetBounds.x + normalizedX * targetBounds.width;
  const y = targetBounds.y + normalizedY * targetBounds.height;
  return (
    x >= overlayBounds.x &&
    x <= overlayBounds.x + overlayBounds.width &&
    y >= overlayBounds.y &&
    y <= overlayBounds.y + overlayBounds.height
  );
}

export function positionComputerUseStopOverlay(
  workArea: Rectangle,
  targetBounds?: Rectangle,
): Readonly<{ x: number; y: number }> | null {
  const margin = 12;
  const { width, height } = COMPUTER_USE_STOP_OVERLAY_SIZE;
  const minimumX = workArea.x + margin;
  const minimumY = workArea.y + margin;
  const maximumX = workArea.x + workArea.width - width - margin;
  const maximumY = workArea.y + workArea.height - height - margin;
  if (minimumX > maximumX || minimumY > maximumY) return null;
  if (targetBounds === undefined) return { x: maximumX, y: minimumY };

  const right = targetBounds.x + targetBounds.width + margin;
  const left = targetBounds.x - width - margin;
  const above = targetBounds.y - height - margin;
  const below = targetBounds.y + targetBounds.height + margin;
  const candidates = [
    { x: right, y: clamp(targetBounds.y, minimumY, maximumY) },
    { x: left, y: clamp(targetBounds.y, minimumY, maximumY) },
    { x: clamp(targetBounds.x, minimumX, maximumX), y: above },
    { x: clamp(targetBounds.x, minimumX, maximumX), y: below },
    { x: minimumX, y: minimumY },
    { x: maximumX, y: minimumY },
    { x: minimumX, y: maximumY },
    { x: maximumX, y: maximumY },
  ];
  return (
    candidates.find((candidate) => {
      const overlayBounds = { ...candidate, width, height };
      return (
        rectangleContains(workArea, overlayBounds) &&
        !rectanglesOverlap(overlayBounds, targetBounds)
      );
    }) ?? null
  );
}

function rectangleContains(container: Rectangle, contained: Rectangle): boolean {
  return (
    contained.x >= container.x &&
    contained.y >= container.y &&
    contained.x + contained.width <= container.x + container.width &&
    contained.y + contained.height <= container.y + container.height
  );
}

function rectanglesOverlap(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function stopOverlayDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  :root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:transparent}
  button{width:100%;height:100%;border:1px solid rgba(255,147,138,.62);border-radius:9px;color:#ffb0aa;background:rgba(43,17,18,.96);font:650 13px/1 inherit;letter-spacing:.02em;box-shadow:inset 0 1px rgba(255,255,255,.09),0 8px 24px rgba(0,0,0,.36)}
  button:focus-visible{outline:2px solid #8ab0f0;outline-offset:-4px}
  </style></head><body><button type="button" aria-label="Computer Useを停止">■&nbsp;&nbsp;Computer Useを停止</button></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
