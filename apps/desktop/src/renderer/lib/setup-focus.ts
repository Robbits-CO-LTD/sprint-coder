/** Where the focus goes when a Setup leaves the screen. A candidate that is missing, disabled,
 * hidden or inside an inert part (a collapsed Sidebar, the Team view) is passed over; as a last
 * resort the main area itself takes the focus, so it never falls to the page. */
const REPLAY_CANDIDATES = [
  // The replay: back to the Settings button that led to it, else the next sensible place.
  '[data-testid="sidebar-settings-button"]',
  '[data-testid="composer-textarea"]',
  '[data-testid="empty-state-create-task-button"]',
  '[data-testid="team-toggle"]',
] as const;

const FIRST_RUN_CANDIDATES = [
  // The first run ends with "最初の Task を始める": straight into writing to the new Task.
  '[data-testid="composer-textarea"]',
  '[data-testid="empty-state-create-task-button"]',
  '[data-testid="sidebar-settings-button"]',
  '[data-testid="team-toggle"]',
] as const;

function usable(element: HTMLElement): boolean {
  if (element.closest('[inert], [hidden], [aria-hidden="true"]') !== null) return false;
  if ('disabled' in element && (element as HTMLButtonElement).disabled) return false;
  return true;
}

function focusFirst(candidates: readonly string[], root: Document): HTMLElement | null {
  for (const selector of candidates) {
    const element = root.querySelector<HTMLElement>(selector);
    if (element !== null && usable(element)) {
      element.focus({ preventScroll: true });
      if (root.activeElement === element) return element;
    }
  }
  const main = root.querySelector<HTMLElement>('.main');
  if (main === null) return null;
  if (!main.hasAttribute('tabindex')) main.tabIndex = -1;
  main.focus({ preventScroll: true });
  return main;
}

export function focusAfterSetupReplay(root: Document = document): HTMLElement | null {
  return focusFirst(REPLAY_CANDIDATES, root);
}

/** After the first-run Setup: the Composer's input, then the same kind of fallbacks. Only when the
 * focus has nowhere else to be (it fell to the page) — a place the user has already chosen is
 * kept. With `composerOnly`, nothing else is tried (an early attempt, while the Composer may still
 * be on its way). */
export function focusAfterFirstSetup(
  root: Document = document,
  { composerOnly = false }: { composerOnly?: boolean } = {},
): HTMLElement | null {
  const active = root.activeElement;
  if (active !== null && active !== root.body && active !== root.documentElement) return null;
  if (!composerOnly) return focusFirst(FIRST_RUN_CANDIDATES, root);
  const composer = root.querySelector<HTMLElement>(FIRST_RUN_CANDIDATES[0]);
  if (composer === null || !usable(composer)) return null;
  composer.focus({ preventScroll: true });
  return root.activeElement === composer ? composer : null;
}
