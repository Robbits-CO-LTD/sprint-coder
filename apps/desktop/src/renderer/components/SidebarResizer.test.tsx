// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarResizer } from './SidebarResizer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SidebarResizer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = () => undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: {
    onResize: (width: number) => void;
    onResizeEnd: (width: number) => void;
    show?: boolean;
  }) {
    act(() => {
      root.render(
        props.show === false ? null : (
          <SidebarResizer
            width={264}
            availableWidth={1440}
            onResize={props.onResize}
            onResizeEnd={props.onResizeEnd}
            onReset={() => undefined}
          />
        ),
      );
    });
    return container.querySelector<HTMLElement>('[data-testid="sidebar-resizer"]');
  }

  function pointer(type: string, clientX: number): PointerEvent {
    const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event as PointerEvent;
  }

  it('settles a drag that is cut short by the handle unmounting', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const handle = render({ onResize, onResizeEnd });
    expect(handle).not.toBeNull();

    act(() => {
      handle!.dispatchEvent(pointer('pointerdown', 264));
      handle!.dispatchEvent(pointer('pointermove', 344));
    });
    expect(onResize).toHaveBeenLastCalledWith(344);
    expect(onResizeEnd).not.toHaveBeenCalled();

    // e.g. ⌘B collapsed the sidebar mid-drag: no pointerup ever reaches the detached element.
    render({ onResize, onResizeEnd, show: false });
    expect(onResizeEnd).toHaveBeenCalledOnce();
    expect(onResizeEnd).toHaveBeenCalledWith(344);
    expect(document.body.classList.contains('is-resizing-sidebar')).toBe(false);
  });

  it('clamps keyboard steps to the room it was given', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const handle = render({ onResize, onResizeEnd });
    act(() => {
      handle!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    // 1440 - 520 = 920 → capped at the 480 maximum.
    expect(onResizeEnd).toHaveBeenLastCalledWith(480);
  });
});
