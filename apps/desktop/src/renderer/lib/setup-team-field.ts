// The Setup's "Team の使い方" picture: lanes of light across the stage, like the race in the logo
// film. One light alone ("言った時だけ"); one light that others join when a big job arrives
// ("おまかせ"); a whole field running side by side ("積極的に").
//
// One requestAnimationFrame loop, owned here: it stops while the page is hidden and for good on
// `destroy()`, which also removes every listener this object added. Positions are worked out from
// the time (nothing is integrated), so a resize never scrambles the picture. Without motion
// (`animate` false) nothing loops: one still, composed frame is drawn, and again after a resize or
// a change of mode. Only cheap drawing is used — lines and two small pre-rendered sprites with
// additive blending; no canvas shadows or filters.

import { watchPixelRatio } from './pixel-ratio';

export type TeamFieldMode = 'explicit' | 'auto' | 'proactive';

/** The logo's colours, top to bottom. */
const COLORS = ['#45befc', '#618ef8', '#c679fd'] as const;
const LANES = 27;
const RUNNERS = 72;
/** The helpers that join the one light when a big job arrives ("おまかせ"). */
const HELPERS = 8;
/** One loop of "おまかせ" (ms), and the part of it in which the big job is on. */
const AUTO_CYCLE_MS = 5200;
const BIG_JOB_FROM = 0.3;
const BIG_JOB_TO = 0.84;
/** At most this many pixels behind the canvas. */
const MAX_CANVAS_PIXELS = 2_400_000;

type Runner = {
  lane: number;
  /** Window widths per second. */
  speed: number;
  phase: number;
  size: number;
  /** Who it is: the one AI, one of its helpers, or one of the crowd. */
  role: 'leader' | 'helper' | 'crowd';
  /** How present it is right now, 0..1 (eased towards what the mode asks for). */
  alpha: number;
};

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

const frac = (value: number): number => value - Math.floor(value);

/** A deterministic random sequence, so the field looks the same every time. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SetupTeamField {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly animate: boolean;
  private mode: TeamFieldMode;
  private since = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  // The screen's pixel ratio the canvas was last sized for. The box keeps its size when only the
  // ratio changes (the window moved to a screen of another density), so no resize is reported: the
  // ratio is watched (lib/pixel-ratio.ts), and looked at on each frame while the loop runs.
  private ratio = 1;
  private sized = false;
  private frame = 0;
  private last = 0;
  private running = false;
  private destroyed = false;
  private readonly runners: Runner[] = [];
  private readonly streaks = new Map<string, HTMLCanvasElement>();
  private readonly glows = new Map<string, HTMLCanvasElement>();
  private observer: ResizeObserver | null = null;
  private unwatchPixelRatio: () => void = () => {};
  private readonly onResize = () => this.resize();
  private readonly onPixelRatio = () => {
    if ((window.devicePixelRatio || 1) !== this.ratio) this.resize();
  };
  private readonly onVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  constructor(canvas: HTMLCanvasElement, options: { animate: boolean; mode: TeamFieldMode }) {
    this.canvas = canvas;
    this.animate = options.animate;
    this.mode = options.mode;
    this.ctx = contextOf(canvas);
    this.cast();
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(canvas.parentElement ?? canvas);
    } else {
      window.addEventListener('resize', this.onResize);
    }
    this.unwatchPixelRatio = watchPixelRatio(this.onPixelRatio);
    if (this.animate) document.addEventListener('visibilitychange', this.onVisibility);
    this.since = performance.now();
    // Sizing draws the still picture when there is no motion.
    this.resize();
    if (this.animate) this.start();
  }

  /** True while a frame is scheduled. */
  get isRunning(): boolean {
    return this.running;
  }

  /** How many lights the current mode shows at its fullest (for tests). */
  get fullCount(): number {
    return this.runners.filter((runner) => this.wanted(runner, 0.5) > 0).length;
  }

  setMode(mode: TeamFieldMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.since = performance.now();
    if (!this.animate) this.drawStill();
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.observer?.disconnect();
    this.observer = null;
    this.unwatchPixelRatio();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.streaks.clear();
    this.glows.clear();
  }

  // ---------- who runs ----------

  private cast(): void {
    const rnd = random(2611);
    const middle = Math.floor(LANES / 2);
    this.runners.push({
      lane: middle,
      speed: 0.34,
      phase: 0.12,
      size: 1,
      role: 'leader',
      alpha: 0,
    });
    for (let k = 0; k < HELPERS; k += 1) {
      const side = k % 2 === 0 ? -1 : 1;
      const lane = middle + side * (1 + Math.floor(k / 2)) * 2;
      this.runners.push({ lane, speed: 0.34, phase: 0, size: 0.7, role: 'helper', alpha: 0 });
    }
    for (let k = this.runners.length; k < RUNNERS; k += 1) {
      this.runners.push({
        lane: (k * 7 + 3) % LANES,
        speed: 0.22 + 0.34 * rnd(),
        phase: rnd(),
        size: 0.35 + 0.5 * rnd(),
        role: 'crowd',
        alpha: 0,
      });
    }
  }

  /** How present `runner` should be, `cycle` (0..1) into the loop of "おまかせ". */
  private wanted(runner: Runner, cycle: number): number {
    if (runner.role === 'leader') return 1;
    if (this.mode === 'explicit') return 0;
    if (this.mode === 'proactive') return 1;
    return runner.role === 'helper' && cycle > BIG_JOB_FROM && cycle < BIG_JOB_TO ? 1 : 0;
  }

  // ---------- loop ----------

  private start(): void {
    if (this.running || this.destroyed || !this.animate || this.ctx === null) return;
    this.running = true;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private readonly tick = (now: number) => {
    if (!this.running) return;
    try {
      this.onPixelRatio();
      const dt = Math.min(64, Math.max(0, now - this.last));
      this.last = now;
      this.draw(now, dt);
    } catch {
      // A drawing failure must not leave a half-running loop: stop, and keep the last picture.
      this.running = false;
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private resize(): void {
    // Noted first, whether or not there is a box to size: one look per change, not one a frame.
    this.ratio = window.devicePixelRatio || 1;
    // The stage's size as laid out, not as it is drawn at this moment: the scene comes in a little
    // smaller than it is (a scale easing to 1), no resize is reported when that ends, and a size
    // taken during it would stay — the picture a few percent short of its box, stretched to fit.
    // (Where nothing is laid out — a test's stand-in — the drawn box is all there is.)
    const stage = this.canvas.parentElement ?? this.canvas;
    const drawn =
      stage.clientWidth > 0 && stage.clientHeight > 0 ? null : stage.getBoundingClientRect();
    const width = drawn ? drawn.width : stage.clientWidth;
    const height = drawn ? drawn.height : stage.clientHeight;
    if (!(width > 0) || !(height > 0)) {
      this.sized = false;
      return;
    }
    this.width = width;
    this.height = height;
    const cap = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
    this.dpr = Math.max(0.25, Math.min(2, this.ratio, cap));
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.sized = true;
    if (!this.animate) this.drawStill();
  }

  // ---------- drawing ----------

  private laneColor(lane: number): string {
    return COLORS[Math.min(2, Math.floor((lane / LANES) * 3))]!;
  }

  /** A streak of light: clear at its tail, its colour along it, white towards the head. */
  private streak(color: string): HTMLCanvasElement {
    let sprite = this.streaks.get(color);
    if (sprite) return sprite;
    sprite = document.createElement('canvas');
    sprite.width = 128;
    sprite.height = 16;
    const g = sprite.getContext('2d');
    const along = g?.createLinearGradient(0, 0, 128, 0);
    const across = g?.createLinearGradient(0, 0, 0, 16);
    if (g && along && across) {
      along.addColorStop(0, `${color}00`);
      along.addColorStop(0.7, `${color}cc`);
      // White at the head, which melts into its glow rather than ending in a flat edge.
      along.addColorStop(0.94, '#ffffff');
      along.addColorStop(1, '#ffffff00');
      g.fillStyle = along;
      g.fillRect(0, 0, 128, 16);
      across.addColorStop(0, 'rgba(0,0,0,0)');
      across.addColorStop(0.5, 'rgba(0,0,0,1)');
      across.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalCompositeOperation = 'destination-in';
      g.fillStyle = across;
      g.fillRect(0, 0, 128, 16);
    }
    this.streaks.set(color, sprite);
    return sprite;
  }

  private glow(color: string): HTMLCanvasElement {
    let sprite = this.glows.get(color);
    if (sprite) return sprite;
    sprite = document.createElement('canvas');
    sprite.width = 64;
    sprite.height = 64;
    const g = sprite.getContext('2d');
    const gradient = g?.createRadialGradient(32, 32, 0, 32, 32, 32);
    if (g && gradient) {
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.22, `${color}88`);
      gradient.addColorStop(1, `${color}00`);
      g.fillStyle = gradient;
      g.fillRect(0, 0, 64, 64);
    }
    this.glows.set(color, sprite);
    return sprite;
  }

  private drawStill(): void {
    // A composed frame: everyone the mode shows, where they are part-way through the loop.
    for (const runner of this.runners) runner.alpha = this.wanted(runner, 0.55);
    this.since = performance.now() - AUTO_CYCLE_MS * 0.55;
    this.draw(performance.now(), 0);
  }

  private draw(now: number, dt: number): void {
    const ctx = this.ctx;
    if (ctx === null || !this.sized) return;
    const w = this.width;
    const h = this.height;
    const seconds = now / 1000;
    const cycle = frac((now - this.since) / AUTO_CYCLE_MS);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    const top = h * 0.08;
    const gap = (h * 0.84) / (LANES - 1);
    // The lanes themselves: faint lines, a little brighter where someone runs.
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g += 1) {
      ctx.strokeStyle = COLORS[g]!;
      ctx.globalAlpha = this.mode === 'proactive' ? 0.22 : 0.12;
      ctx.beginPath();
      for (let lane = 0; lane < LANES; lane += 1) {
        if (Math.min(2, Math.floor((lane / LANES) * 3)) !== g) continue;
        const y = top + lane * gap;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    }
    const ease = dt > 0 ? 1 - Math.exp(-dt / 220) : 1;
    for (const runner of this.runners) {
      runner.alpha += (this.wanted(runner, cycle) - runner.alpha) * ease;
      if (runner.alpha < 0.01) continue;
      const color = runner.role === 'leader' ? '#dfe9ff' : this.laneColor(runner.lane);
      const y = top + runner.lane * gap;
      let x: number;
      if (runner.role === 'crowd') {
        x = frac(runner.phase + seconds * runner.speed) * (w * 1.3) - w * 0.15;
      } else {
        // The one AI crosses steadily; its helpers keep just behind it while the big job is on.
        const lead = frac(0.12 + (seconds * 0.34) / 1.3) * (w * 1.3) - w * 0.15;
        const behind = runner.role === 'helper' ? 16 + Math.abs(runner.lane - LANES / 2) * 7 : 0;
        x = lead - behind * (2 - runner.alpha);
      }
      // The one AI is always the largest light on the field.
      const lead = runner.role === 'leader';
      const length = lead
        ? Math.max(180, w * 0.34)
        : (40 + runner.speed * 260) * (0.5 + runner.size);
      const thick = lead ? 18 : 3 + 9 * runner.size;
      ctx.globalAlpha = runner.alpha * (0.45 + 0.55 * runner.size);
      ctx.drawImage(this.streak(color), x - length, y - thick / 2, length, thick);
      const halo = lead ? 84 : 10 + 26 * runner.size;
      ctx.globalAlpha = runner.alpha * 0.9;
      ctx.drawImage(this.glow(color), x - halo / 2, y - halo / 2, halo, halo);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
