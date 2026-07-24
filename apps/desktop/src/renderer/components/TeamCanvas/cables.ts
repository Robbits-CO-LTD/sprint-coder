import type { Rect } from './useCamera';
import type { TeamMessageSummary } from '../../types/sprint-coder';

// SVG cable draw between Leader/Worker nodes when a Team message flows (demo/index.html lines
// 830-888): draw-in via dash offset, three amber "packet" circles traveling the path, then the
// receiving node's header flashes a glow ring, then the cable fades out and is removed. Slice 6.4
// connects this to the message's actual delivery lifecycle instead of firing unconditionally.

const CABLE_OFFSET = 2000; // matches #cables' left:-2000px/top:-2000px in index.css
const HOLD_POLL_MS = 120;
const HOLD_TIMEOUT_MS = 10_000; // safety valve: never leave a cable drawn forever if ack never comes

function anchorOf(rect: Rect, side: 'left' | 'right') {
  return side === 'right'
    ? { x: rect.x + rect.w, y: rect.y + Math.min(90, rect.h / 2) }
    : { x: rect.x, y: rect.y + Math.min(60, rect.h / 2) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flashGlow(head: HTMLElement) {
  head.classList.remove('glow');
  // Force reflow so re-adding the class restarts the CSS animation.
  void head.offsetWidth;
  head.classList.add('glow');
}

export type CableMessageLike = Pick<TeamMessageSummary, 'state' | 'deliveryState'>;
export type CableOutcome = 'glow' | 'hold' | 'danger';

// Pure state -> animation-phase decision (Slice 6.4 items 4 & 7): once the draw-on + packet phase
// finishes (or immediately, for the reduced-motion substitute), this decides what happens next.
// Exported standalone, independent of any DOM/SVG, so the ack-gating logic is unit-testable — the
// mock Team backend acks synchronously in practice (by the time the renderer observes a message it
// is usually already acknowledged), so the 'hold' branch is essentially untestable end-to-end.
export function decideCableOutcome(message: CableMessageLike): CableOutcome {
  if (message.deliveryState === 'acked' || message.state === 'acknowledged') return 'glow';
  if (message.deliveryState === 'timedOut' || message.deliveryState === 'failed') return 'danger';
  return 'hold';
}

export interface SendCableOptions {
  /** Worker -> Leader direction (report) instead of the default Leader -> Worker (dispatch). */
  reverse?: boolean;
  reduced?: boolean;
  /** Source node's header — glowed too under reduced motion (item 6: both headers highlight). */
  fromHead?: HTMLElement | null;
  sourceId?: string;
  targetId?: string;
  /** Live lookup of the message's current row, polled while the cable is 'hold'ing (drawn, no
   * glow yet) so a real (non-mock) backend's async ack still resolves correctly. Absent only when
   * exercising the raw draw primitive directly (e.g. from a test). */
  getLatest?: () => CableMessageLike | undefined;
  /** Fired once the terminal outcome (glow/danger) is decided — 'hold' never reaches here. Lets
   * the caller (TeamCanvas) emit its textual event without this module knowing worker names or
   * Japanese copy. */
  onOutcome?: (outcome: 'glow' | 'danger') => void;
}

function resolveOutcome(getLatest: SendCableOptions['getLatest']): CableOutcome {
  if (!getLatest) return 'glow';
  const latest = getLatest();
  // No row found (shouldn't happen — the message that queued this cable came from the same
  // store): treat as already-settled rather than holding on nothing.
  return latest ? decideCableOutcome(latest) : 'glow';
}

export async function sendCable(
  svg: SVGSVGElement,
  fromRect: Rect,
  toRect: Rect,
  toHead: HTMLElement | null,
  options: SendCableOptions = {},
): Promise<void> {
  const { reverse = false, reduced = false, fromHead = null, getLatest, onOutcome } = options;

  if (reduced) {
    // Reduced motion (item 6): replace the cable entirely — no path, no packets — with an
    // immediate static highlight on BOTH headers. Ack-gating still applies (no glow if the
    // delivery has already failed); a still-pending 'hold' isn't distinguished visually here
    // (the already-acked fast path is the overwhelmingly common case with today's backend, and
    // briefly showing nothing is preferable to a premature/misleading glow).
    const outcome = resolveOutcome(getLatest);
    if (outcome === 'danger') {
      onOutcome?.('danger');
      return;
    }
    if (fromHead) flashGlow(fromHead);
    if (toHead) flashGlow(toHead);
    onOutcome?.('glow');
    return;
  }

  const a = anchorOf(fromRect, reverse ? 'left' : 'right');
  const b = anchorOf(toRect, reverse ? 'right' : 'left');
  const dx = Math.max(70, Math.abs(b.x - a.x) * 0.45);
  const O = CABLE_OFFSET;

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    `M ${a.x + O} ${a.y + O} C ${a.x + O + (reverse ? -dx : dx)} ${a.y + O}, ` +
      `${b.x + O + (reverse ? dx : -dx)} ${b.y + O}, ${b.x + O} ${b.y + O}`,
  );
  path.setAttribute('class', 'cable-path');
  // Source/target identity (item 7): lets e2e assert the cable connects the correct pair without
  // relying on timing/position alone.
  if (options.sourceId) path.setAttribute('data-source-id', options.sourceId);
  if (options.targetId) path.setAttribute('data-target-id', options.targetId);
  svg.appendChild(path);
  const len = path.getTotalLength();

  path.style.strokeDasharray = String(len);
  path.style.strokeDashoffset = String(len);
  path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
    duration: 240,
    easing: 'cubic-bezier(.22,1,.36,1)',
    fill: 'forwards',
  });
  await sleep(240);

  const packets: SVGCircleElement[] = [];
  for (let i = 0; i < 3; i += 1) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', '3.2');
    c.setAttribute('class', 'packet');
    svg.appendChild(c);
    packets.push(c);
  }
  const dur = 520;
  const gap = 130;
  await new Promise<void>((resolve) => {
    const t0 = performance.now();
    const step = (now: number) => {
      let alive = false;
      packets.forEach((c, i) => {
        const t = (now - t0 - i * gap) / dur;
        if (t < 0) {
          alive = true;
          return;
        }
        if (t > 1) {
          c.setAttribute('opacity', '0');
          return;
        }
        alive = true;
        const pt = path.getPointAtLength(len * t);
        c.setAttribute('cx', String(pt.x));
        c.setAttribute('cy', String(pt.y));
        c.setAttribute('opacity', '.95');
      });
      if (alive) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  packets.forEach((c) => c.remove());

  // Ack-gating (item 4): the packet flight has finished — decide whether to glow now (already
  // acked, the fast path), hold (drawn, no glow) until ack/failure is observed, or flash danger
  // immediately (already failed/timed out by the time packets finished).
  let outcome = resolveOutcome(getLatest);
  if (outcome === 'hold' && getLatest) {
    const deadline = Date.now() + HOLD_TIMEOUT_MS;
    while (outcome === 'hold' && Date.now() < deadline) {
      // Deliberately sequential: poll until the message's row settles — there is nothing to
      // parallelize here.
      await sleep(HOLD_POLL_MS);
      outcome = resolveOutcome(getLatest);
    }
    if (outcome === 'hold') outcome = 'danger'; // never resolved — don't leave the cable up forever
  }

  if (outcome === 'danger') {
    onOutcome?.('danger');
    path.classList.add('cable-danger');
    await sleep(260);
    path.classList.add('afterglow');
    setTimeout(() => path.remove(), 600);
    return;
  }

  onOutcome?.('glow');
  if (toHead) flashGlow(toHead);
  await sleep(340);
  path.classList.add('afterglow');
  setTimeout(() => path.remove(), 600);
}
