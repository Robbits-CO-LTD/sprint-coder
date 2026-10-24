// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_SCALE, NESTED_SCROLLPORTS, preservesNestedScroll, useCamera } from './useCamera';
import { canvasCameraSchema } from '@sprint-coder/contracts';

describe('preservesNestedScroll', () => {
  it.each(['.timeline-scroll', '.w-body', '.w-attention', '.w-details-panel'])(
    'keeps wheel gestures inside the %s scrollport',
    (matchedSelector) => {
      const closest = vi.fn((selectors: string) =>
        selectors.includes(matchedSelector) ? ({} as Element) : null,
      );

      expect(preservesNestedScroll({ closest } as unknown as EventTarget)).toBe(true);
      expect(closest).toHaveBeenCalledWith(NESTED_SCROLLPORTS);
    },
  );

  it('gives the wheel back to the camera when the scrollport has nothing to scroll', () => {
    const scrollport = (scrollHeight: number) =>
      ({ scrollHeight, clientHeight: 300 }) as unknown as Element;
    expect(
      preservesNestedScroll({ closest: () => scrollport(300) } as unknown as EventTarget),
    ).toBe(false);
    expect(
      preservesNestedScroll({ closest: () => scrollport(900) } as unknown as EventTarget),
    ).toBe(true);
  });

  it('leaves wheel gestures on the canvas to camera controls', () => {
    expect(
      preservesNestedScroll({
        closest: () => null,
      } as unknown as EventTarget),
    ).toBe(false);
    expect(preservesNestedScroll(null)).toBe(false);
  });
});

function CameraCanvas({
  capture,
  onSettle,
}: {
  capture?: (camera: ReturnType<typeof useCamera>) => void;
  onSettle?: () => void;
}) {
  const camera = useCamera(onSettle);
  const { canvasRef, worldRef } = camera;
  useEffect(() => capture?.(camera), [capture, camera]);
  return createElement(
    'section',
    { ref: canvasRef, 'data-testid': 'camera-canvas' },
    createElement(
      'div',
      { ref: worldRef, 'data-testid': 'camera-world' },
      ...['surface--node', 'worker'].map((className) =>
        createElement(
          'div',
          { className, key: className },
          createElement('button', { 'data-testid': `${className}-input` }, 'Node action'),
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'team-canvas-notice' },
      createElement('button', { type: 'button', 'data-testid': 'team-back' }, 'Chatに戻る'),
      createElement('button', { type: 'button', 'data-testid': 'team-view-toggle' }, 'List表示'),
    ),
    ...['team-header-overlay', 'team-canvas-controls', 'team-policy-dialog'].map((className) =>
      createElement(
        'div',
        { className, key: className },
        createElement('button', { 'data-testid': className }, 'Overlay action'),
      ),
    ),
  );
}

function pointerDown(target: HTMLElement) {
  // jsdom supplies MouseEvent but not PointerEvent; these are the pointer fields read by the hook.
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: 30,
    clientY: 40,
  });
  Object.defineProperty(event, 'pointerId', { value: 7 });
  target.dispatchEvent(event);
  return event;
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    'team-back',
    'team-view-toggle',
    'team-header-overlay',
    'team-canvas-controls',
    'team-policy-dialog',
  ])('does not capture a pointerdown bubbling from the %s recovery button', (testId) => {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
    pointerDown(button);

    expect(capture).not.toHaveBeenCalled();
    expect(canvas.dataset.cameraOwner).toBe('system');
  });

  it.each(['surface--node', 'worker'])(
    'freezes in-flight camera motion for a %s button without capturing or panning its input',
    (nodeClass) => {
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
      const cancel = vi.fn((id: number) => frames.delete(id));
      vi.stubGlobal('cancelAnimationFrame', cancel);
      vi.spyOn(performance, 'now').mockReturnValue(0);
      void camera.animateCamTo({ x: 500, y: 300, s: 0.6 }, 480);
      const firstFrame = frames.get(frameId)!;
      frames.delete(frameId);
      firstFrame(80);
      const movingFrame = frameId;
      const held = { ...camera.camRef.current };
      expect(held.x).toBeGreaterThan(0);
      expect(held.x).toBeLessThan(500);
      const button = container.querySelector<HTMLButtonElement>(
        `[data-testid="${nodeClass}-input"]`,
      )!;
      const click = vi.fn();
      button.addEventListener('click', click);
      const down = pointerDown(button);

      expect(cancel).toHaveBeenCalledWith(movingFrame);
      expect(frames.size).toBe(0);
      expect(canvas.dataset.cameraOwner).toBe('user');
      expect(capture).not.toHaveBeenCalled();
      expect(down.defaultPrevented).toBe(false);
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 120 }));
      button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      button.click();
      expect(camera.camRef.current).toEqual(held);
      expect(camera.draggingRef.current).toBe(false);
      expect(click).toHaveBeenCalledOnce();
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

  it('settles canceled and superseded animation promises exactly once with false', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(7));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const first = vi.fn();
    const second = vi.fn();
    void camera.animateCamTo({ x: 10, y: 20, s: 0.8 }).then(first);
    void camera.animateCamTo({ x: 30, y: 40, s: 0.6 }).then(second);
    await Promise.resolve();
    expect(first).toHaveBeenCalledExactlyOnceWith(false);
    expect(second).not.toHaveBeenCalled();
    camera.claimUserOwnership();
    camera.cancelCamAnim();
    await Promise.resolve();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('reports natural completion even when onSettle reenters cancellation', async () => {
    const request = vi.fn<(callback: FrameRequestCallback) => number>().mockReturnValue(1);
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(performance, 'now').mockReturnValue(0);
    act(() =>
      root.render(
        createElement(CameraCanvas, {
          capture: (value) => {
            camera = value;
          },
          onSettle: () => camera.cancelCamAnim(),
        }),
      ),
    );
    const completed = camera.animateCamTo({ x: 10, y: 20, s: 0.8 }, 100);
    request.mock.calls[0]![0](100);
    await expect(completed).resolves.toBe(true);
  });

  it('reports immediate reduced-motion completion with true', async () => {
    act(() => root.unmount());
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    vi.mocked(matchMedia).mockReturnValue({ ...media, matches: true });
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
    await expect(camera.animateCamTo({ x: 10, y: 20, s: 0.8 })).resolves.toBe(true);
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
