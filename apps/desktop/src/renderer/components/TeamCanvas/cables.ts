import type { Rect } from './useCamera';

// SVG cable draw between Leader/Worker nodes when a Team message flows (demo/index.html lines
// 830-888): draw-in via dash offset, three amber "packet" circles traveling the path, then the
// receiving node's header flashes a glow ring, then the cable fades out and is removed.

const CABLE_OFFSET = 2000; // matches #cables' left:-2000px/top:-2000px in index.css

function anchorOf(rect: Rect, side: 'left' | 'right') {
  return side === 'right'
    ? { x: rect.x + rect.w, y: rect.y + Math.min(90, rect.h / 2) }
    : { x: rect.x, y: rect.y + Math.min(60, rect.h / 2) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendCable(
  svg: SVGSVGElement,
  fromRect: Rect,
  toRect: Rect,
  toHead: HTMLElement | null,
  options: { reverse?: boolean; reduced?: boolean } = {},
): Promise<void> {
  const { reverse = false, reduced = false } = options;
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
  svg.appendChild(path);
  const len = path.getTotalLength();

  if (!reduced) {
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
  } else {
    await sleep(60);
  }

  if (toHead) {
    toHead.classList.remove('glow');
    // Force reflow so re-adding the class restarts the CSS animation.
    void toHead.offsetWidth;
    toHead.classList.add('glow');
  }

  await sleep(340);
  path.classList.add('afterglow');
  setTimeout(() => path.remove(), 600);
}
