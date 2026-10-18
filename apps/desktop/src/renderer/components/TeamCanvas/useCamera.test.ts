// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_SCALE, preservesNestedScroll, useCamera } from './useCamera';
import { canvasCameraSchema } from '@sprint-coder/contracts';

describe('preservesNestedScroll', () => {
  it.each(['.timeline-scroll', '.w-body'])(
    'keeps wheel gestures inside the %s scrollport',
    (matchedSelector) => {
      const closest = vi.fn((selectors: string) =>
        selectors.includes(matchedSelector) ? ({} as Element) : null,
      );

      expect(preservesNestedScroll({ closest } as unknown as EventTarget)).toBe(true);
      expect(closest).toHaveBeenCalledWith('.timeline-scroll, .w-body');
    },
  );

  it('leaves wheel gestures on the canvas to camera controls', () => {
    expect(
      preservesNestedScroll({
        closest: () => null,
      } as unknown as EventTarget),
    ).toBe(false);
    expect(preservesNestedScroll(null)).toBe(false);
  });
});

function CameraCanvas({ capture }: { capture?: (camera: ReturnType<typeof useCamera>) => void }) {
  const camera = useCamera();
  const { canvasRef, worldRef } = camera;
  useEffect(() => capture?.(camera), [capture, camera]);
  return createElement(
    'section',
    { ref: canvasRef, 'data-testid': 'camera-canvas' },
    createElement('div', { ref: worldRef, 'data-testid': 'camera-world' }),
    createElement(
      'div',
      { className: 'team-canvas-notice' },
      createElement('button', { type: 'button', 'data-testid': 'team-back' }, 'Chatに戻る'),
      createElement('button', { type: 'button', 'data-testid': 'team-view-toggle' }, 'List表示'),
    ),
  );
}

function pointerDown(target: HTMLElement) {
  // jsdom supplies MouseEvent but not PointerEvent; these are the pointer fields read by the hook.
  const event = new MouseEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 40 });
  Object.defineProperty(event, 'pointerId', { value: 7 });
  target.dispatchEvent(event);
}

describe('camera pointer capture', () => {
  let container: HTMLDivElement;
  let root: Root;
  let canvas: HTMLElement;
  let capture: ReturnType<typeof vi.fn>;
  let camera: ReturnType<typeof useCamera>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(CameraCanvas, {
          capture: (value) => {
            camera = value;
          },
        }),
      ),
    );
    canvas = container.querySelector<HTMLElement>('[data-testid="camera-canvas"]')!;
    capture = vi.fn();
    canvas.setPointerCapture = capture;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each(['team-back', 'team-view-toggle'])(
    'does not capture a pointerdown bubbling from the %s recovery button',
    (testId) => {
      const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
      pointerDown(button);

      expect(capture).not.toHaveBeenCalled();
      expect(canvas.dataset.cameraOwner).toBe('system');
    },
  );

  it('still captures and pans a pointerdown on the blank canvas', () => {
    pointerDown(canvas);

    expect(capture).toHaveBeenCalledExactlyOnceWith(7);
    expect(canvas.dataset.cameraOwner).toBe('user');
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 90 }),
    );
    expect(
      container.querySelector<HTMLElement>('[data-testid="camera-world"]')!.style.transform,
    ).toBe('translate(50px, 50px) scale(1)');
  });

  it('keeps a large Team fit inside the scale accepted by canvas persistence', () => {
    Object.defineProperties(canvas, {
      clientWidth: { value: 900 },
      clientHeight: { value: 700 },
    });
    const fitted = camera.camToFit([{ x: 0, y: 0, w: 8000, h: 2400 }]);
    expect(fitted.s).toBeLessThan(0.18);
    expect(fitted.x).toBeGreaterThanOrEqual(0);
    expect(fitted.y).toBeGreaterThanOrEqual(0);
    expect(fitted.x + 8000 * fitted.s).toBeLessThanOrEqual(900);
    expect(fitted.y + 2400 * fitted.s).toBeLessThanOrEqual(700);
    expect(
      canvasCameraSchema.safeParse({ x: fitted.x, y: fitted.y, scale: fitted.s }).success,
    ).toBe(true);
  });

  it('keeps focus targets inside the scale accepted by canvas persistence', () => {
    Object.defineProperties(canvas, {
      clientWidth: { value: 900 },
      clientHeight: { value: 700 },
    });
    const focused = camera.camToFocus({ x: 0, y: 0, w: 8000, h: 2400 });
    expect(focused.s).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(focused.s).toBeLessThan(0.18);
    expect(
      canvasCameraSchema.safeParse({ x: focused.x, y: focused.y, scale: focused.s }).success,
    ).toBe(true);
  });

  it('bounds very large fit and focus targets at the minimum persistable scale', () => {
    Object.defineProperties(canvas, {
      clientWidth: { value: 900 },
      clientHeight: { value: 700 },
    });
    const target = { x: 0, y: 0, w: 40000, h: 40000 };
    expect(camera.camToFit([target]).s).toBe(MIN_SCALE);
    expect(camera.camToFocus(target).s).toBe(MIN_SCALE);
  });
});
