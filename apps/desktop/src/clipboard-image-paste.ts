/**
 * Shared by the preload bridge and the Composer so the Renderer's paste decision and the gate that
 * authorizes the clipboard read can never disagree about what counts as an image paste.
 */

/**
 * How long a genuine paste keeps the clipboard read authorized.
 *
 * The Composer calls through synchronously from its paste handler, so this only has to cover the
 * IPC hop — it is a leash, not a grace period.
 */
export const TRUSTED_IMAGE_PASTE_WINDOW_MS = 3_000;

/**
 * Decides whether a paste should become an attachment instead of text.
 *
 * `text/plain` wins whenever it is present: several apps (spreadsheets and slide editors in
 * particular) put a picture of the selection on the clipboard alongside the text, and pasting that
 * picture instead of the text the user copied would be wrong far more often than it is right.
 */
export function clipboardCarriesImage(
  data: {
    types?: readonly string[];
    items?: ArrayLike<{ kind: string; type: string }>;
  } | null,
): boolean {
  if (!data) return false;
  if ((data.types ?? []).includes('text/plain')) return false;
  return Array.from(data.items ?? []).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/'),
  );
}

export type TrustedImagePasteGate = Readonly<{
  arm: () => void;
  consume: () => boolean;
}>;

/**
 * Ties Main's clipboard read to a paste the user actually performed.
 *
 * Reading the OS clipboard is a capability the Renderer does not otherwise have, and this app
 * renders model-influenced content, so an IPC that reads it on demand would be a polling channel
 * for whatever the user last copied. The gate is armed only from the preload's isolated world, by a
 * `paste` event the user agent marked `isTrusted` — the page cannot forge one and cannot reach this
 * closure — and each arming authorizes exactly one read.
 */
export function createTrustedImagePasteGate(now: () => number): TrustedImagePasteGate {
  let armedAtMs: number | null = null;
  return {
    arm(): void {
      armedAtMs = now();
    },
    consume(): boolean {
      if (armedAtMs === null) return false;
      const elapsed = now() - armedAtMs;
      armedAtMs = null;
      // A backwards clock reads as expired rather than as an unbounded window.
      return elapsed >= 0 && elapsed <= TRUSTED_IMAGE_PASTE_WINDOW_MS;
    },
  };
}
