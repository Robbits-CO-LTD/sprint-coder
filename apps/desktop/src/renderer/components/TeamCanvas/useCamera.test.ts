// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preservesNestedScroll, useCamera } from './useCamera';

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

function CameraCanvas() {
  const { canvasRef, worldRef } = useCamera();
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
    act(() => root.render(createElement(CameraCanvas)));
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
});
