import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// Accessible menu for the Composer's plus button (issue #13).
//
// The Composer already has three popovers (Runtime/Model/Effort) built on `.runtime-menu`, and this
// reuses their styling and their Escape/outside-click behaviour. What it does not reuse is their
// *keyboard* model: those are single-select radio groups, where landing on the trigger and tabbing
// through options is coherent. This is a real menu of unrelated actions, so it implements what
// `role="menu"` actually promises — arrow keys, Home/End, and Escape returning focus to the trigger
// — rather than declaring the role and behaving like a list of buttons.
//
// Typeahead is deliberately NOT implemented, despite the issue listing it. Every item label here is
// Japanese, and a Japanese character cannot reach a keydown handler as `event.key`: it arrives
// through IME composition, which emits `Process`/dead keys and commits via `insertText`. A
// first-character matcher would therefore never fire for the labels it is meant to serve, while
// still swallowing stray ASCII keystrokes. WAI-ARIA lists typeahead as optional; the required keys
// are all here.
//
// Disabled items use `aria-disabled` rather than the `disabled` attribute on purpose: a disabled
// attribute removes the item from the focus order, which hides the very explanation of why it is
// unavailable from anyone navigating by keyboard or screen reader.

export type ComposerMenuItem = {
  id: string;
  label: string;
  description: string;
  icon?: ReactNode;
  /** When set, the item is announced disabled and this is shown as its description instead. */
  unavailableReason?: string | undefined;
  onSelect?: (() => void) | undefined;
};

export function ComposerMenu({
  items,
  triggerLabel,
  menuLabel,
  triggerIcon,
  triggerTestId,
}: {
  items: readonly ComposerMenuItem[];
  triggerLabel: string;
  menuLabel: string;
  triggerIcon: ReactNode;
  triggerTestId: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Which item to focus once the menu is on screen. Held in state (not a ref) because opening has
  // to re-render before there is anything to focus.
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPendingFocus(null);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (pendingFocus === null) return;
    itemRefs.current[pendingFocus]?.focus({ preventScroll: true });
  }, [pendingFocus, open]);

  function focusedIndex(): number {
    return itemRefs.current.findIndex((node) => node !== null && node === document.activeElement);
  }

  function moveFocus(delta: number) {
    if (items.length === 0) return;
    const current = focusedIndex();
    const from = current === -1 ? (delta > 0 ? -1 : 0) : current;
    // Wraps, per the menu pattern — Down on the last item returns to the first.
    const next = (from + delta + items.length) % items.length;
    itemRefs.current[next]?.focus({ preventScroll: true });
  }

  function activate(item: ComposerMenuItem) {
    if (item.unavailableReason !== undefined) return;
    close(true);
    item.onSelect?.();
  }

  return (
    <div
      className="runtime-chip-wrap"
      ref={wrapRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close(true);
          return;
        }
        if (!open) return;
        if (e.key === 'Tab') {
          // Tabbing out of a menu closes it, but must not steal the Tab itself — focus continues to
          // wherever it was headed.
          close(false);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveFocus(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveFocus(-1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          itemRefs.current[0]?.focus({ preventScroll: true });
        } else if (e.key === 'End') {
          e.preventDefault();
          itemRefs.current[items.length - 1]?.focus({ preventScroll: true });
        }
      }}
    >
      <button
        ref={triggerRef}
        data-testid={triggerTestId}
        type="button"
        className="cmp-chip composer-plus"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => {
          setOpen((value) => !value);
          setPendingFocus(null);
        }}
        onKeyDown={(e) => {
          // Down/Up open the menu and land on the first/last item, the standard menu-button keys.
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            setPendingFocus(e.key === 'ArrowDown' ? 0 : items.length - 1);
          }
        }}
      >
        {triggerIcon}
      </button>
      {open && (
        <div className="runtime-menu composer-plus-menu" role="menu" aria-label={menuLabel}>
          {items.map((item, index) => {
            const unavailable = item.unavailableReason !== undefined;
            return (
              <button
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                data-testid={`composer-menu-${item.id}`}
                key={item.id}
                type="button"
                role="menuitem"
                aria-disabled={unavailable || undefined}
                className={`runtime-menu-item${unavailable ? ' unavailable' : ''}`}
                title={item.unavailableReason}
                onClick={() => activate(item)}
              >
                <span className="runtime-menu-title">
                  {item.icon}
                  {item.label}
                </span>
                <span className="runtime-menu-desc">
                  {item.unavailableReason ?? item.description}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
