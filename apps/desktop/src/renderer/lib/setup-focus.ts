/** Where the focus goes when the replayed Setup closes: the Settings button that led to it, else
 * the next sensible place in the workspace. A candidate that is missing, disabled, hidden or
 * inside an inert part (a collapsed Sidebar, the Team view) is passed over; as a last resort the
 * main area itself takes the focus, so it never falls to the page. */
const CANDIDATES = [
  '[data-testid="sidebar-settings-button"]',
  '[data-testid="composer-textarea"]',
  '[data-testid="empty-state-create-task-button"]',
  '[data-testid="team-toggle"]',
] as const;

function usable(element: HTMLElement): boolean {
  if (element.closest('[inert], [hidden], [aria-hidden="true"]') !== null) return false;
  if ('disabled' in element && (element as HTMLButtonElement).disabled) return false;
  return true;
}

export function focusAfterSetupReplay(root: Document = document): HTMLElement | null {
  for (const selector of CANDIDATES) {
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
