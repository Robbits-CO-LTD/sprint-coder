// The logo film before the first Setup: one full-window canvas that plays what is timed in
// setup-logo-timeline.ts — a hundred lights race across the window, stop, line up, pour into the
// logo's three nodes, run down its branches and strike the arrow's tip; then a cursor writes the
// name, and a wipe of light leaves the Setup behind it.
//
// The logo is the real one: it is cut out of the app icon (shape and colours; only the dark plate
// is dropped) and shown through a mask that grows along its branches, so it is never redrawn by
// hand. Everything heavy happens once, before the film needs it: the cut-out, the light sprites,
// the letters and the counter's digits (again only if the window changes size). A frame then only
// draws: images, lines batched by colour, and a glow made by shrinking the frame and adding it
// back (no canvas filters or shadows).
//
// Every position is worked out from the film's time and the window's size (nothing is integrated
// from frame to frame), so a resize never scrambles the picture and a skip can start from
// anywhere. The clock stops while the window is hidden, so nobody misses the film by looking away.
// `destroy()` cancels the frame and removes every listener and timer this object added.

import { FONT_SANS, waitForFonts } from './fonts';
import { watchPixelRatio } from './pixel-ratio';
import type { LogoIntroSound } from './setup-logo-sound';
import {
  clamp01,
  createLogoFrame,
  easeOutBack,
  easeOutCubic,
  letterProgress,
  LOGO_RUNNERS,
  LOGO_SKIP_MS,
  logoIntroFrameInto,
  logoReadyGateAt,
  runClockAt,
  runnerJoinAt,
  rushProgress,
  type LogoIntroFrame,
  type LogoIntroVariant,
} from './setup-logo-timeline';

// ---------- the logo, as measured on the 1024 px master (sprint-coder-icon-master-v1.png) ----------

const SOURCE_SIZE = 1024;
/** The part of the master the logo sits in. */
const CROP = { x: 160, y: 156, w: 672, h: 686 } as const;
/** Centres of the three nodes (top, middle, bottom) and the arrow's tip. */
const NODES: readonly (readonly [number, number])[] = [
  [312, 245],
  [245, 500],
  [312, 755],
];
const NODE_RADIUS = 72;
const TIP: readonly [number, number] = [815, 500];
/** The centre lines the light runs along: each branch from inside its node to where the three
 * meet, then the arrow to its tip. The widths are the mask's (a little wider than the logo). */
const BRANCHES: readonly Readonly<{
  from: readonly [number, number];
  to: readonly [number, number];
  width: number;
}>[] = [
  { from: [335, 222], to: [600, 487], width: 114 },
  { from: [245, 503], to: [585, 503], width: 104 },
  { from: [335, 778], to: [600, 513], width: 114 },
];
const TRUNK = { from: [548, 503], to: [832, 503], width: 152 } as const;
/** The logo's own colours at its nodes (top, middle, bottom), and along the arrow. */
const NODE_RGB: readonly (readonly [number, number, number])[] = [
  [69, 190, 252],
  [97, 142, 248],
  [198, 121, 253],
];
const ARROW_RGB: readonly [number, number, number] = [173, 197, 250];
const hex = (rgb: readonly [number, number, number]): string =>
  `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
const NODE_HEX = NODE_RGB.map(hex);
const ARROW_HEX = hex(ARROW_RGB);
const WHITE = '#ffffff';
const INK = '#f3f6ff';

export const LOGO_WORD = 'Sprint Coder';
export const LOGO_TAGLINE = '最大 100 の AI が、同時に動く';
const COUNTER_LABEL = '同時に動く AI';

/** Give up (and go straight to the Setup) if the logo cannot be read in this time. */
const LOAD_TIMEOUT_MS = 2600;
const FONT_WAIT_MS = 900;
/** At most this many pixels behind the canvas (about 2560×1600). */
const MAX_CANVAS_PIXELS = 4_200_000;
/** A streak runs from where its light was this long ago to where it is now. */
const EXPOSURE_MS = 80;
/** How far outside the window a runner goes before it comes round again (in window widths). */
const WRAP_MARGIN = 0.32;
const WRAP_SPAN = 1 + WRAP_MARGIN * 2;
const SPARKS = 64;
const DUST = 54;
/** Lights far behind the runners, and a few huge soft ones close to the eye: depth. */
const FAR = 96;
const NEAR = 7;
/** The runners line up in this many ranks. */
const RANKS = 6;
const LANE_STEPS = 18;
/** The lanes start this far left of the window (in window widths). */
const LANE_START = 0.04;
/** The glow: the frame at 1/2, 1/4, 1/8 and 1/16, the last three added back with these weights. */
const BLOOM_WEIGHTS = [0, 0.3, 0.36, 0.44] as const;

type Palette = Readonly<{ bg: string; bgGlow: string }>;

export type LogoIntroOptions = Readonly<{
  variant: LogoIntroVariant;
  /** URL of the app icon the logo is cut out of. */
  iconUrl: string;
  /** The Setup may start to come in (the last scene runs over it). Called once. */
  onHandoff: () => void;
  /** The film is over (or could not be played). Called once, after onHandoff. */
  onDone: () => void;
  /** The film's sound, if it has one: kept with the film's clock, faded on a skip, stopped at
   * the end. */
  sound?: LogoIntroSound;
  /** For tests: how the icon is loaded. */
  loadImage?: (url: string) => Promise<CanvasImageSource>;
}>;

type Layout = {
  w: number;
  h: number;
  cx: number;
  /** The logo's centre line when it is large in the middle, and on the finished card. */
  heroY: number;
  cardY: number;
  /** The logo's height on the card, and how much larger it is in the middle. */
  gh: number;
  heroScale: number;
  wordSize: number;
  wordY: number;
  taglineSize: number;
  taglineY: number;
  counterSize: number;
  /** Half the height the lanes span at the window's left edge, once the card is up. */
  cardFan: number;
};

/** Where the logo is in one frame. */
type Box = {
  cx: number;
  cy: number;
  gx: number;
  gy: number;
  gw: number;
  gh: number;
  /** Screen px per master px. */
  unit: number;
  hero: number;
  zoom: number;
};

type TextAssets = {
  key: string;
  /** Each letter alone, and where its left edge sits from the word's left edge (CSS px). */
  letters: { canvas: HTMLCanvasElement; x: number; w: number }[];
  whole: HTMLCanvasElement;
  width: number;
  height: number;
  pad: number;
  size: number;
  /** The counter's digits, 0–9, and one digit's width and height (CSS px). */
  digits: HTMLCanvasElement[];
  digitW: number;
  digitH: number;
};

/** Where the logo sits in the app icon, for anything else that shows the logo itself. */
export const LOGO_SOURCE_SIZE = SOURCE_SIZE;
export const LOGO_CROP = CROP;

/**
 * Makes the icon's dark plate transparent in `pixels` (RGBA, in place), leaving the coloured
 * logo with a soft edge. Returns how many pixels of logo are left (none: not the icon).
 */
export function keepLogoPixels(pixels: Uint8ClampedArray): number {
  let area = 0;
  for (let p = 0; p < pixels.length; p += 4) {
    const r = pixels[p]!;
    const g = pixels[p + 1]!;
    const b = pixels[p + 2]!;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    // The plate is a dark grey; the logo is coloured or bright. A soft edge, not a hard cut.
    const k = clamp01((Math.max(chroma - 25, lum - 110) - 4) / 34) * (pixels[p + 3]! / 255);
    pixels[p + 3] = Math.round(k * 255);
    if (k > 0.5) area += 1;
  }
  return area;
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function defaultLoadImage(url: string): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('logo image failed to load'));
    image.src = url;
  });
}

function hexToken(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function within(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const frac = (value: number): number => value - Math.floor(value);
/** 0 → 1 with no speed at either end, and none of the change in the first stretch: a lane runs
 * level for a while before it bends into its node. */
const bend = (a: number): number => (a <= 0 ? 0 : a >= 1 ? 1 : a * a * a * (a * (6 * a - 15) + 10));

/** A deterministic random sequence, so every showing of the film is the same film. */
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

/** Fills `canvas` pixel by pixel: `shade(u, v)` gives [whiteness, alpha] for u 0..1 along it and
 * v -1..1 across it. Leaves it empty where there is no pixel access (a test's stand-in canvas). */
function paintPixels(
  canvas: HTMLCanvasElement,
  rgb: readonly [number, number, number],
  shade: (u: number, v: number) => readonly [number, number],
): void {
  const g = contextOf(canvas);
  const image = g?.createImageData?.(canvas.width, canvas.height);
  if (!g || !image?.data) return;
  const { width, height } = canvas;
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5 - height / 2) / (height / 2);
    for (let x = 0; x < width; x += 1) {
      const [white, alpha] = shade(x / (width - 1), v);
      const p = (y * width + x) * 4;
      const k = clamp01(white);
      image.data[p] = rgb[0] + (255 - rgb[0]) * k;
      image.data[p + 1] = rgb[1] + (255 - rgb[1]) * k;
      image.data[p + 2] = rgb[2] + (255 - rgb[2]) * k;
      image.data[p + 3] = clamp01(alpha) * 255;
    }
  }
  g.putImageData(image, 0, 0);
}

/** A streak of light: transparent at its tail, white-hot along its middle towards the head. */
function cometSprite(rgb: readonly [number, number, number]): HTMLCanvasElement {
  const canvas = makeCanvas(128, 32);
  paintPixels(canvas, rgb, (u, v) => {
    const body = u ** 2.2 * Math.exp(-(v * v) / 0.11);
    const core = u ** 4.5 * Math.exp(-(v * v) / 0.012);
    return [core * 1.25, body * 0.8 + core];
  });
  return canvas;
}

/** The beam out of the arrow: bright at the tip, thinning out towards the window's edge. */
function beamSprite(rgb: readonly [number, number, number]): HTMLCanvasElement {
  const canvas = makeCanvas(128, 32);
  paintPixels(canvas, rgb, (u, v) => {
    const far = 1 - 0.72 * u ** 0.7;
    const body = Math.exp(-(v * v) / 0.14) * far;
    const core = Math.exp(-(v * v) / 0.006) * far;
    return [core, body * 0.36 + core];
  });
  return canvas;
}

export class SetupLogoIntro {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly options: LogoIntroOptions;
  private readonly variant: LogoIntroVariant;
  private readonly palette: Palette;
  private readonly gate: number;
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
  private finished = false;
  private handedOff = false;
  private clock = 0;
  private skipAt: number | null = null;
  private loadTimer = 0;
  private observer: ResizeObserver | null = null;
  private unwatchPixelRatio: () => void = () => {};
  private shownOpacity = 1;
  private shownScale = 1;

  // One frame's values now, and a moment ago (for the streaks) — the same two objects every frame.
  private readonly now = createLogoFrame();
  private readonly then = createLogoFrame();
  private readonly box: Box = {
    cx: 0,
    cy: 0,
    gx: 0,
    gy: 0,
    gw: 0,
    gh: 0,
    unit: 1,
    hero: 1,
    zoom: 1,
  };
  private readonly boxThen: Box = {
    cx: 0,
    cy: 0,
    gx: 0,
    gy: 0,
    gw: 0,
    gh: 0,
    unit: 1,
    hero: 1,
    zoom: 1,
  };
  private L: Layout = {
    w: 0,
    h: 0,
    cx: 0,
    heroY: 0,
    cardY: 0,
    gh: 0,
    heroScale: 1,
    wordSize: 0,
    wordY: 0,
    taglineSize: 0,
    taglineY: 0,
    counterSize: 0,
    cardFan: 0,
  };

  // Prepared once.
  private ready = false;
  private glyph: HTMLCanvasElement | null = null;
  private glyphWhite: HTMLCanvasElement | null = null;
  private glyphCool: HTMLCanvasElement | null = null;
  private glyphWarm: HTMLCanvasElement | null = null;
  private band: HTMLCanvasElement | null = null;
  private edge: HTMLCanvasElement | null = null;
  private scratch: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private readonly sprites = new Map<string, HTMLCanvasElement>();
  private comets: HTMLCanvasElement[] = [];
  private cometWhite: HTMLCanvasElement | null = null;
  private beamImage: HTMLCanvasElement | null = null;
  private text: TextAssets | null = null;
  /** What the letters and digits were last drawn for (the sizes); changes only with the window. */
  private textKey = '';
  private backdrop: CanvasGradient | null = null;
  private bloom: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }[] = [];

  // The hundred runners, as parallel arrays.
  private readonly lane = new Float32Array(LOGO_RUNNERS);
  private readonly depth = new Float32Array(LOGO_RUNNERS);
  private readonly speed = new Float32Array(LOGO_RUNNERS);
  private readonly joinClock = new Float32Array(LOGO_RUNNERS);
  private readonly group = new Uint8Array(LOGO_RUNNERS);
  /** Its mark on its lane (0 = the window's left edge, 1 = the node), and its turn in the rush. */
  private readonly mark = new Float32Array(LOGO_RUNNERS);
  private readonly turn = new Float32Array(LOGO_RUNNERS);
  private readonly phase = new Float32Array(LOGO_RUNNERS);
  private readonly glintRate = new Float32Array(LOGO_RUNNERS);
  // One frame's positions (no allocation per frame).
  private readonly px = new Float32Array(LOGO_RUNNERS);
  private readonly py = new Float32Array(LOGO_RUNNERS);
  private readonly qx = new Float32Array(LOGO_RUNNERS);
  private readonly qy = new Float32Array(LOGO_RUNNERS);
  private readonly pa = new Float32Array(LOGO_RUNNERS);
  private readonly qa = new Float32Array(LOGO_RUNNERS);
  private readonly point = new Float32Array(2);
  // Sparks and dust.
  private readonly sparkAngle = new Float32Array(SPARKS);
  private readonly sparkReach = new Float32Array(SPARKS);
  private readonly sparkPace = new Float32Array(SPARKS);
  private readonly dustX = new Float32Array(DUST);
  private readonly dustY = new Float32Array(DUST);
  private readonly dustZ = new Float32Array(DUST);
  private readonly farLane = new Float32Array(FAR + NEAR);
  private readonly farSpeed = new Float32Array(FAR + NEAR);
  private readonly farPhase = new Float32Array(FAR + NEAR);

  private readonly onResize = () => this.resize();
  private readonly onPixelRatio = () => {
    if ((window.devicePixelRatio || 1) !== this.ratio) this.resize();
  };
  private readonly onVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  constructor(canvas: HTMLCanvasElement, options: LogoIntroOptions) {
    this.canvas = canvas;
    this.options = options;
    this.variant = options.variant;
    this.gate = logoReadyGateAt(options.variant);
    this.palette = { bg: hexToken('--setup-bg', '#05070a'), bgGlow: '#0c1326' };
    this.ctx = contextOf(canvas);
    if (this.ctx === null) {
      // No drawing surface: no film, straight to the Setup.
      queueMicrotask(() => this.finish());
      return;
    }
    this.cast();
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(canvas.parentElement ?? canvas);
    } else {
      window.addEventListener('resize', this.onResize);
    }
    // (After it, the letters and digits are drawn again for the new ratio, as after any resize.)
    this.unwatchPixelRatio = watchPixelRatio(this.onPixelRatio);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.loadTimer = window.setTimeout(() => {
      if (!this.ready) this.finish();
    }, LOAD_TIMEOUT_MS);
    void this.prepare();
    this.start();
  }

  /** True while a frame is scheduled. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Time into the film (ms), for tests. */
  get elapsed(): number {
    return this.clock;
  }

  /** Ends the film quickly (a click or a key): a short fade, and the Setup comes in at once. */
  skip(): void {
    if (this.finished || this.destroyed) return;
    if (!this.ready) {
      this.finish();
      return;
    }
    if (this.skipAt === null) {
      this.skipAt = this.clock;
      this.options.sound?.fade(LOGO_SKIP_MS);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.options.sound?.stop();
    window.clearTimeout(this.loadTimer);
    this.observer?.disconnect();
    this.observer = null;
    this.unwatchPixelRatio();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.sprites.clear();
    this.comets = [];
    this.bloom = [];
    this.glyph = this.glyphWhite = this.glyphCool = this.glyphWarm = null;
    this.band = this.edge = this.scratch = this.cometWhite = this.beamImage = null;
    this.scratchCtx = null;
    this.text = null;
    this.backdrop = null;
  }

  // ---------- life ----------

  private finish(): void {
    if (this.finished || this.destroyed) return;
    this.finished = true;
    this.stop();
    this.options.sound?.stop();
    window.clearTimeout(this.loadTimer);
    if (!this.handedOff) {
      this.handedOff = true;
      this.options.onHandoff();
    }
    this.options.onDone();
  }

  private start(): void {
    if (this.running || this.destroyed || this.finished || this.ctx === null) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.running = true;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frame);
    // No picture, no sound (it goes on with the next frame).
    this.options.sound?.pause();
  }

  private readonly tick = (now: number) => {
    if (!this.running) return;
    try {
      this.onPixelRatio();
      // A long stall (a busy machine) moves the film on by at most a tenth of a second.
      const dt = Math.max(0, Math.min(100, now - this.last));
      this.last = now;
      let next = this.clock + dt;
      if (!this.ready) next = Math.min(next, this.gate);
      this.clock = next;
      this.options.sound?.sync(this.clock);
      const frame = logoIntroFrameInto(this.now, this.variant, this.clock, this.skipAt);
      if (frame.handoff && !this.handedOff) {
        this.handedOff = true;
        this.options.onHandoff();
      }
      if (frame.done) {
        this.clear();
        this.finish();
        return;
      }
      this.draw(frame);
    } catch {
      // A drawing failure must never hold the Setup back.
      this.finish();
      return;
    }
    if (this.running) this.frame = requestAnimationFrame(this.tick);
  };

  // ---------- preparation ----------

  /** Gives every runner, spark and speck of dust its part. The same every time. */
  private cast(): void {
    const rnd = random(1907);
    const n = LOGO_RUNNERS;
    const members: number[][] = [[], [], []];
    for (let i = 0; i < n; i += 1) {
      // The cursor itself runs the middle lane; the rest are spread evenly down the window.
      const lane = i === 0 ? 0.5 : frac(0.5 + i * 0.6180339887);
      this.lane[i] = lane;
      // The first few out are close to the eye: large, bright and fast while the window is empty.
      this.depth[i] = i === 0 ? 1 : i < 9 ? 0.72 + 0.28 * rnd() : rnd();
      const k = lane < 1 / 3 ? 0 : lane < 2 / 3 ? 1 : 2;
      this.group[i] = k;
      members[k]!.push(i);
      // It comes in at the left edge when its turn comes; the nearer it is, the faster it passes.
      this.joinClock[i] = runClockAt(runnerJoinAt(i) + (i === 0 ? 260 : 0));
      this.speed[i] = 1.35 + 1.5 * this.depth[i]! + 0.3 * rnd();
      this.phase[i] = rnd();
      this.glintRate[i] = 0.7 + 0.7 * rnd();
    }
    for (const list of members) {
      list.sort((a, b) => this.lane[a]! - this.lane[b]!);
      list.forEach((i, rank) => {
        // Their marks: ranks across the lanes, like a starting grid. The front rank goes first.
        const row = rank % RANKS;
        this.mark[i] = 0.1 + 0.105 * row;
        this.turn[i] = (1 - row / (RANKS - 1)) * 0.82 + 0.18 * rnd();
      });
    }
    for (let j = 0; j < SPARKS; j += 1) {
      const side = rnd() - 0.5;
      this.sparkAngle[j] = side * Math.abs(side) * 4.4;
      this.sparkReach[j] = 0.3 + 0.9 * rnd();
      this.sparkPace[j] = 1 + 0.7 * rnd();
    }
    for (let j = 0; j < FAR + NEAR; j += 1) {
      this.farLane[j] = rnd();
      this.farSpeed[j] = j < FAR ? 0.35 + 0.55 * rnd() : 3.6 + 1.8 * rnd();
      this.farPhase[j] = rnd();
    }
    for (let j = 0; j < DUST; j += 1) {
      this.dustX[j] = rnd();
      this.dustY[j] = rnd();
      this.dustZ[j] = rnd();
    }
  }

  private async prepare(): Promise<void> {
    try {
      const load = this.options.loadImage ?? defaultLoadImage;
      const image = await load(this.options.iconUrl);
      if (this.destroyed || this.finished) return;
      if (!this.cutOutLogo(image)) {
        this.finish();
        return;
      }
      this.makeLights();
      // The name and the counter are drawn once, in the bundled font: wait for it (briefly), so
      // they are not another font's shapes for the whole film.
      const fonts = typeof document === 'undefined' ? undefined : document.fonts;
      await waitForFonts(
        fonts,
        [`700 64px ${FONT_SANS}`, `500 16px ${FONT_SANS}`],
        FONT_WAIT_MS,
        `${LOGO_WORD}${LOGO_TAGLINE}0123456789`,
      );
      if (this.destroyed || this.finished) return;
      this.ready = true;
      window.clearTimeout(this.loadTimer);
    } catch {
      this.finish();
    }
  }

  /** Cuts the coloured logo out of the icon's dark plate, and makes its white and tinted twins. */
  private cutOutLogo(image: CanvasImageSource): boolean {
    const source = makeCanvas(SOURCE_SIZE, SOURCE_SIZE);
    const sctx = source.getContext('2d', { willReadFrequently: true });
    if (!sctx) return false;
    sctx.drawImage(image, 0, 0, SOURCE_SIZE, SOURCE_SIZE);
    const data = sctx.getImageData(CROP.x, CROP.y, CROP.w, CROP.h);
    const pixels = data?.data;
    if (!pixels || pixels.length < CROP.w * CROP.h * 4) return false;
    if (keepLogoPixels(pixels) < 200) return false;
    const glyph = makeCanvas(CROP.w, CROP.h);
    glyph.getContext('2d')?.putImageData(data, 0, 0);
    this.glyph = glyph;
    const tinted = (color: string): HTMLCanvasElement => {
      const canvas = makeCanvas(CROP.w, CROP.h);
      const g = canvas.getContext('2d');
      if (g) {
        g.drawImage(glyph, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = color;
        g.fillRect(0, 0, CROP.w, CROP.h);
      }
      return canvas;
    };
    this.glyphWhite = tinted(WHITE);
    this.glyphCool = tinted('#2fd4ff');
    this.glyphWarm = tinted('#c05bff');
    return true;
  }

  private makeLights(): void {
    this.comets = NODE_RGB.map((rgb) => cometSprite(rgb));
    this.cometWhite = cometSprite([214, 228, 255]);
    this.beamImage = beamSprite(ARROW_RGB);
    // The light band that runs across the logo and the name: a soft white stripe.
    const band = makeCanvas(160, 4);
    const bctx = band.getContext('2d');
    if (bctx) {
      const gradient = bctx.createLinearGradient(0, 0, 160, 0);
      gradient.addColorStop(0, 'rgba(255,255,255,0)');
      gradient.addColorStop(0.5, 'rgba(255,255,255,0.95)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      bctx.fillStyle = gradient;
      bctx.fillRect(0, 0, 160, 4);
    }
    this.band = band;
    // The wipe's soft edge: opaque on the left, clear on the right.
    const edge = makeCanvas(64, 4);
    const ectx = edge.getContext('2d');
    if (ectx) {
      const gradient = ectx.createLinearGradient(0, 0, 64, 0);
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ectx.fillStyle = gradient;
      ectx.fillRect(0, 0, 64, 4);
    }
    this.edge = edge;
    this.scratch = makeCanvas(8, 8);
    this.scratchCtx = this.scratch.getContext('2d');
  }

  /** Draws the name's letters and the counter's digits once, for this window size. */
  private buildText(): void {
    const L = this.L;
    const dpr = this.dpr;
    const key = this.textKey;
    const measure = makeCanvas(4, 4).getContext('2d');
    if (!measure) return;
    const size = L.wordSize;
    const font = `700 ${size}px ${FONT_SANS}`;
    const spacing = `${(-0.022 * size).toFixed(2)}px`;
    const tighten = (g: CanvasRenderingContext2D) => {
      if ('letterSpacing' in g) g.letterSpacing = spacing;
    };
    measure.font = font;
    tighten(measure);
    const pad = Math.ceil(size * 0.4);
    const height = Math.ceil(size * 1.3) + pad;
    const total = measure.measureText(LOGO_WORD).width;
    const letters: TextAssets['letters'] = [];
    const whole = makeCanvas((total + pad * 2) * dpr, height * dpr);
    const wctx = whole.getContext('2d');
    const paint = (g: CanvasRenderingContext2D, text: string) => {
      g.font = font;
      g.textBaseline = 'middle';
      g.fillStyle = INK;
      g.fillText(text, 0, 0);
    };
    if (wctx) {
      wctx.setTransform(dpr, 0, 0, dpr, pad * dpr, (height / 2) * dpr);
      tighten(wctx);
      paint(wctx, LOGO_WORD);
    }
    for (let index = 0; index < LOGO_WORD.length; index += 1) {
      const ch = LOGO_WORD[index]!;
      const x = measure.measureText(LOGO_WORD.slice(0, index)).width;
      const w = measure.measureText(LOGO_WORD.slice(0, index + 1)).width - x;
      const canvas = makeCanvas((w + pad * 2) * dpr, height * dpr);
      const g = canvas.getContext('2d');
      if (g && ch !== ' ') {
        g.setTransform(dpr, 0, 0, dpr, pad * dpr, (height / 2) * dpr);
        paint(g, ch);
      }
      letters.push({ canvas, x, w });
    }
    // The counter's digits: outlined numerals, all one width.
    const csize = L.counterSize;
    const cfont = `700 ${csize}px ${FONT_SANS}`;
    measure.font = cfont;
    if ('letterSpacing' in measure) measure.letterSpacing = '0px';
    let digitW = 0;
    for (let d = 0; d < 10; d += 1) digitW = Math.max(digitW, measure.measureText(String(d)).width);
    digitW = Math.ceil(digitW * 1.04);
    const digitH = Math.ceil(csize * 1.1);
    const digits: HTMLCanvasElement[] = [];
    for (let d = 0; d < 10; d += 1) {
      const canvas = makeCanvas(digitW * dpr, digitH * dpr);
      const g = canvas.getContext('2d');
      if (g) {
        g.setTransform(dpr, 0, 0, dpr, (digitW / 2) * dpr, (digitH / 2) * dpr);
        g.font = cfont;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.lineJoin = 'round';
        g.fillStyle = 'rgba(120,160,255,0.16)';
        g.fillText(String(d), 0, csize * 0.04);
        g.lineWidth = Math.max(1.25, csize * 0.011);
        g.strokeStyle = 'rgba(196,214,255,0.95)';
        g.strokeText(String(d), 0, csize * 0.04);
      }
      digits.push(canvas);
    }
    this.text = { key, letters, whole, width: total, height, pad, size, digits, digitW, digitH };
  }

  // ---------- size ----------

  private resize(): void {
    // Noted first, whether or not there is a box to size: one look per change, not one a frame.
    this.ratio = window.devicePixelRatio || 1;
    const box = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect();
    const width = box.width;
    const height = box.height;
    if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
      this.sized = false;
      return;
    }
    this.width = width;
    this.height = height;
    // Cap the pixels behind the canvas: a huge window gets a lower resolution, not hundreds of MB.
    const cap = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
    this.dpr = Math.max(0.25, Math.min(2, this.ratio, cap));
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.sized = true;
    this.L = this.layout();
    this.textKey = `${this.L.wordSize.toFixed(1)}|${this.L.counterSize.toFixed(1)}|${this.dpr}`;
    const ctx = this.ctx;
    if (ctx) {
      const L = this.L;
      const gradient = ctx.createRadialGradient(
        L.cx,
        L.heroY,
        0,
        L.cx,
        L.heroY,
        Math.hypot(width, height) * 0.62,
      );
      if (gradient) {
        gradient.addColorStop(0, this.palette.bgGlow);
        gradient.addColorStop(0.55, '#070b14');
        gradient.addColorStop(1, this.palette.bg);
      }
      this.backdrop = gradient ?? null;
    }
    // The glow's four small copies of the frame.
    this.bloom = [];
    let w = this.canvas.width;
    let h = this.canvas.height;
    for (let level = 0; level < BLOOM_WEIGHTS.length; level += 1) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      const canvas = makeCanvas(w, h);
      const bctx = contextOf(canvas);
      if (!bctx) {
        this.bloom = [];
        break;
      }
      this.bloom.push({ canvas, ctx: bctx });
    }
  }

  private layout(): Layout {
    const w = this.width;
    const h = this.height;
    const gh = within(Math.min(w * 0.23, h * 0.32), 72, 320);
    // "Sprint Coder" is about 6.3 times as wide as its size: it must fit the window.
    const wordSize = within(Math.min(gh * 0.37, (w * 0.84) / 6.3), 18, 110);
    const taglineSize = within(wordSize * 0.2, 11, 19);
    const block = gh + wordSize * 1.62 + taglineSize * 2.6;
    const cardY = h * 0.49 - block / 2 + gh / 2;
    const wordY = cardY + gh / 2 + wordSize * 1.02;
    // The lanes sweep in from the whole left edge, but never across the name: the lowest one must
    // pass above the name's first letter.
    const unit = gh / CROP.h;
    const nx = w / 2 - (gh * (CROP.w / CROP.h)) / 2 + (NODES[2]![0] - CROP.x) * unit;
    const ny = cardY - gh / 2 + (NODES[2]![1] - CROP.y) * unit;
    const x0 = -w * LANE_START;
    const b = bend((w / 2 - wordSize * 3.3 - x0) / (nx - x0));
    const lowest = b < 0.97 ? (wordY - wordSize * 0.85 - ny * b) / (1 - b) : h;
    const cardFan = within(lowest - cardY, gh * 0.6, h * 0.45);
    return {
      w,
      h,
      cx: w / 2,
      heroY: h * 0.5,
      cardY,
      gh,
      heroScale: within((h * 0.44) / gh, 1.05, 1.42),
      wordSize,
      wordY,
      taglineSize,
      taglineY: wordY + wordSize * 0.6 + taglineSize * 1.55,
      counterSize: within(Math.min(h * 0.4, w * 0.2), 60, 380),
      cardFan,
    };
  }

  /** Where the logo is for frame `f`: large in the middle, or in its place on the card. */
  private place(f: LogoIntroFrame, box: Box): void {
    const L = this.L;
    const size = L.gh * lerp(1, L.heroScale, f.hero);
    box.hero = f.hero;
    box.zoom = f.zoom;
    box.cx = L.cx;
    box.cy = lerp(L.cardY, L.heroY, f.hero);
    box.gh = size;
    box.gw = size * (CROP.w / CROP.h);
    box.gx = box.cx - box.gw / 2;
    box.gy = box.cy - box.gh / 2;
    box.unit = size / CROP.h;
  }

  // ---------- drawing ----------

  private sprite(color: string): HTMLCanvasElement {
    let sprite = this.sprites.get(color);
    if (sprite) return sprite;
    sprite = makeCanvas(64, 64);
    const g = sprite.getContext('2d');
    const gradient = g?.createRadialGradient(32, 32, 0, 32, 32, 32);
    if (g && gradient) {
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.2, `${color}99`);
      gradient.addColorStop(0.55, `${color}22`);
      gradient.addColorStop(1, `${color}00`);
      g.fillStyle = gradient;
      g.fillRect(0, 0, 64, 64);
    }
    this.sprites.set(color, sprite);
    return sprite;
  }

  private glow(
    ctx: CanvasRenderingContext2D,
    color: string,
    x: number,
    y: number,
    size: number,
  ): void {
    ctx.drawImage(this.sprite(color), x - size / 2, y - size / 2, size, size);
  }

  private clear(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** The camera: everything is drawn scaled about the logo's centre. */
  private aim(ctx: CanvasRenderingContext2D, box: Box): void {
    const k = this.dpr * box.zoom;
    ctx.setTransform(
      k,
      0,
      0,
      k,
      this.dpr * box.cx * (1 - box.zoom),
      this.dpr * box.cy * (1 - box.zoom),
    );
  }

  private draw(f: LogoIntroFrame): void {
    const ctx = this.ctx;
    if (ctx === null || !this.sized) return;
    if (this.text?.key !== this.textKey) this.buildText();
    // A skip (and the still card's leaving) fades the whole film: the canvas itself, not each part.
    if (f.opacity !== this.shownOpacity || f.scale !== this.shownScale) {
      this.shownOpacity = f.opacity;
      this.shownScale = f.scale;
      this.canvas.style.opacity = f.opacity.toFixed(3);
      this.canvas.style.transform = f.scale === 1 ? '' : `scale(${f.scale.toFixed(4)})`;
    }
    const box = this.box;
    this.place(f, box);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.variant === 'still') {
      this.aim(ctx, box);
      this.drawGlyph(ctx, f, box, f.content);
      this.drawName(ctx, f, box, f.content, true);
      this.drawVeil(ctx);
      return;
    }

    const then = logoIntroFrameInto(
      this.then,
      this.variant,
      Math.max(0, f.time - EXPOSURE_MS),
      this.skipAt,
    );
    this.place(then, this.boxThen);

    // ----- 1: everything that glows -----
    this.aim(ctx, box);
    ctx.globalCompositeOperation = 'lighter';
    if (f.counter > 0.001) this.drawCounter(ctx, f);
    if (f.lanes > 0.001) this.drawLanes(ctx, f, box);
    if (f.beam > 0.001) this.drawBeam(ctx, f, box);
    if (f.caret > 0.001 || f.dash >= 0) this.drawCursor(ctx, f);
    if (f.runRate > 0.001) this.drawDepth(ctx, f);
    if (f.runners > 0) this.drawRunners(ctx, f, then, box);
    if (f.dust > 0.001) this.drawDust(ctx, f);
    if (f.sparks > 0 || f.shock > 0) this.drawSparks(ctx, f, box);
    this.drawGlyph(ctx, f, box, 1);
    if (f.type > 0) this.drawName(ctx, f, box, 0.28, false);

    // ----- 2: the glow -----
    this.addBloom(ctx);

    // ----- 3: what must stay crisp, and the lights in front of it -----
    this.aim(ctx, box);
    if (f.fringe > 0.01 && this.glyphCool && this.glyphWarm) {
      const shift = box.gw * 0.045 * f.fringe;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.75 * f.fringe;
      ctx.drawImage(this.glyphCool, box.gx - shift, box.gy, box.gw, box.gh);
      ctx.drawImage(this.glyphWarm, box.gx + shift, box.gy, box.gw, box.gh);
    }
    this.drawGlyph(ctx, f, box, 1);
    this.drawGlyphLights(ctx, f, box);
    if (f.type > 0 || f.pen > 0) this.drawName(ctx, f, box, 1, true);
    if (f.flash > 0.01) this.drawFlash(ctx, f, box);

    // ----- 4: the dark behind it all, and the wipe that takes it away -----
    this.drawVeil(ctx);
    if (f.wipe > 0) this.drawWipe(ctx, f);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** The frame's own light, blurred and added back: shrink it step by step, then add the small
   * copies on top (stretched back up, they are the blur). */
  private addBloom(ctx: CanvasRenderingContext2D): void {
    if (this.bloom.length === 0) return;
    let from: HTMLCanvasElement = this.canvas;
    for (const level of this.bloom) {
      level.ctx.globalCompositeOperation = 'copy';
      level.ctx.drawImage(from, 0, 0, level.canvas.width, level.canvas.height);
      from = level.canvas;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    for (let index = 0; index < this.bloom.length; index += 1) {
      const weight = BLOOM_WEIGHTS[index]!;
      if (weight <= 0) continue;
      ctx.globalAlpha = weight;
      ctx.drawImage(this.bloom[index]!.canvas, 0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.globalAlpha = 1;
  }

  private drawVeil(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.backdrop ?? this.palette.bg;
    ctx.fillRect(0, 0, this.L.w, this.L.h);
  }

  /** The leaving: a slanted edge of light crosses the window, and behind it there is no film. */
  private drawWipe(ctx: CanvasRenderingContext2D, f: LogoIntroFrame): void {
    const L = this.L;
    const slant = -0.22;
    const soft = Math.max(60, L.w * 0.09);
    // In slanted coordinates x' = x - slant * y, the edge is the vertical line x' = front.
    const front =
      -soft + (L.w + soft * 2 + Math.abs(slant) * L.h) * f.wipe - (slant < 0 ? 0 : slant * L.h);
    ctx.setTransform(this.dpr, 0, slant * this.dpr, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(-L.w, -10, front - soft + L.w, L.h + 20);
    if (this.edge) ctx.drawImage(this.edge, front - soft, -10, soft, L.h + 20);
    // The edge itself: a line of light with a soft glow before and behind it.
    ctx.globalCompositeOperation = 'lighter';
    const alive = Math.sin(Math.PI * clamp01(f.wipe)) ** 0.6;
    if (this.band) {
      ctx.globalAlpha = 0.5 * alive;
      ctx.drawImage(this.band, front - soft * 1.1, -10, soft * 1.5, L.h + 20);
      ctx.globalAlpha = 0.95 * alive;
      ctx.drawImage(this.band, front - soft * 0.42, -10, soft * 0.16, L.h + 20);
    }
  }

  /** The counter behind the race: three outlined digits and what they count. */
  private drawCounter(ctx: CanvasRenderingContext2D, f: LogoIntroFrame): void {
    const text = this.text;
    if (!text) return;
    const L = this.L;
    const count = Math.max(0, Math.min(999, f.count));
    const level = f.counter * ((count >= LOGO_RUNNERS ? 0.42 : 0.3) + 0.5 * f.countFlash);
    const grow = 1 + 0.04 * f.countFlash;
    const dw = text.digitW * grow;
    const dh = text.digitH * grow;
    const left = L.cx - (dw * 3) / 2;
    const top = L.heroY - dh / 2;
    for (let k = 0; k < 3; k += 1) {
      const leading = (k === 0 && count < 100) || (k === 1 && count < 10);
      ctx.globalAlpha = level * (leading ? 0.26 : 1);
      ctx.drawImage(
        text.digits[
          k === 0
            ? Math.floor(count / 100) % 10
            : k === 1
              ? Math.floor(count / 10) % 10
              : count % 10
        ]!,
        left + dw * k,
        top,
        dw,
        dh,
      );
    }
    // What is being counted.
    const size = within(L.counterSize * 0.062, 11, 20);
    ctx.globalAlpha = f.counter * 0.62;
    ctx.fillStyle = '#b9c8ee';
    ctx.font = `500 ${size}px ${FONT_SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(size * 0.42).toFixed(2)}px`;
    ctx.fillText(COUNTER_LABEL, L.cx + size * 0.21, top + dh + size * 1.1);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.textAlign = 'start';
  }

  /** The waiting cursor, and its dash across the window. */
  private drawCursor(ctx: CanvasRenderingContext2D, f: LogoIntroFrame): void {
    const L = this.L;
    const x = L.cx;
    const y = L.heroY;
    const tall = within(L.h * 0.085, 34, 76);
    const wide = Math.max(3, tall * 0.075);
    if (f.caret > 0.001) {
      const c = f.charge;
      // Gathering itself: it draws back a little and leans into the run, like a sprinter on the
      // blocks, and the light around it swells.
      const h = tall * (1 - 0.18 * c);
      const w = wide * (1 + 0.9 * c);
      const back = tall * 0.22 * c;
      ctx.save();
      ctx.translate(x - back, y);
      ctx.transform(1, 0, -0.36 * c, 1, 0, 0);
      ctx.globalAlpha = f.caret;
      ctx.fillStyle = '#eaf2ff';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
      ctx.globalAlpha = f.caret * (0.5 + 0.2 * c);
      this.glow(ctx, '#7fb2ff', x - back, y, tall * (2.2 + 2.2 * c));
      if (c > 0.01) {
        ctx.globalAlpha = f.caret * c * 0.3;
        this.glow(ctx, WHITE, x - back, y, tall * (0.5 + 0.4 * c));
        // A flare along the line it is about to run.
        const flare = L.w * (0.12 + 0.75 * c);
        ctx.globalAlpha = f.caret * c * 0.85;
        ctx.drawImage(this.sprite('#a9c6ff'), x - flare / 2, y - 2 - 3 * c, flare, 4 + 6 * c);
      }
    }
    if (f.dash >= 0 && this.cometWhite) {
      // Off it goes: a bar of light from where it stood to past the right edge, thinning out.
      const head = x + (L.w * 0.5 + 160) * (1 - (1 - f.dash) ** 4);
      const tail = x + (L.w * 0.5 + 160) * f.dash ** 2.2;
      const fade = 1 - f.dash ** 3;
      const thick = tall * (0.55 - 0.3 * f.dash);
      ctx.globalAlpha = fade;
      ctx.drawImage(this.cometWhite, tail, y - thick / 2, Math.max(1, head - tail), thick);
      ctx.globalAlpha = fade * 0.9;
      this.glow(ctx, WHITE, head, y, tall * 1.5);
      // The kick-off flash where it stood.
      const kick = (1 - f.dash) ** 2.5;
      ctx.globalAlpha = kick * 0.9;
      this.glow(ctx, '#9fc2ff', x, y, tall * (5 + 6 * f.dash));
      ctx.globalAlpha = kick * 0.8;
      ctx.drawImage(this.sprite('#cfe0ff'), x - L.w * 0.5, y - 8, L.w, 16);
    }
  }

  /** The point at `a` along runner `i`'s lane (0 = left of the window, 1 = its node). */
  private lanePoint(i: number, a: number, box: Box): void {
    const L = this.L;
    const k = this.group[i]!;
    const node = NODES[k]!;
    const nx = box.gx + (node[0] - CROP.x) * box.unit;
    const ny = box.gy + (node[1] - CROP.y) * box.unit;
    const x0 = -L.w * LANE_START;
    // Where the lane meets the left edge: its own height down the window while the logo is large
    // (the lane it ran in); once the card is up, as much of that as clears the name.
    const y0 = box.cy + (this.lane[i]! - 0.5) * 2 * lerp(L.cardFan, L.h * 0.45, box.hero);
    this.point[0] = x0 + (nx - x0) * a;
    this.point[1] = y0 + (ny - y0) * bend(a);
  }

  /** Where every runner is in frame `f`, and how visible (0 = not yet in, or already home). */
  private runnerPositions(
    f: LogoIntroFrame,
    box: Box,
    outX: Float32Array,
    outY: Float32Array,
    outA: Float32Array,
  ): void {
    const L = this.L;
    const short = this.variant === 'short';
    for (let i = 0; i < LOGO_RUNNERS; i += 1) {
      let x = 0;
      let y = 0;
      let alpha = 1;
      if (f.stage < 1) {
        // Racing across the window, round and round — or coasting to a stop.
        const raw = (f.runClock - this.joinClock[i]!) * this.speed[i]!;
        if (raw < 0) alpha = 0;
        x = (frac(raw / WRAP_SPAN) * WRAP_SPAN - WRAP_MARGIN) * L.w;
        y = (0.05 + 0.9 * this.lane[i]!) * L.h;
      }
      if (f.stage > 0) {
        // On its mark on its lane; then the rush into the node.
        const mark = short ? this.mark[i]! * 0.5 - 0.62 : this.mark[i]!;
        const go = rushProgress(f.rush, this.turn[i]!);
        if (go >= 1) alpha = 0;
        const a = mark - 0.035 * f.pull + (1 - mark) * go;
        this.lanePoint(i, a, box);
        x = lerp(x, this.point[0]!, f.stage);
        y = lerp(y, this.point[1]!, f.stage);
      }
      outX[i] = x;
      outY[i] = y;
      outA[i] = alpha;
    }
  }

  private drawRunners(
    ctx: CanvasRenderingContext2D,
    f: LogoIntroFrame,
    then: LogoIntroFrame,
    box: Box,
  ): void {
    const L = this.L;
    this.runnerPositions(f, box, this.px, this.py, this.pa);
    this.runnerPositions(then, this.boxThen, this.qx, this.qy, this.qa);
    const k = this.dpr * box.zoom;
    const ex = this.dpr * box.cx * (1 - box.zoom);
    const ey = this.dpr * box.cy * (1 - box.zoom);
    const longest = L.w * (WRAP_MARGIN + 0.1);
    const twinkleAt = f.time * 0.006;
    for (let i = 0; i < LOGO_RUNNERS; i += 1) {
      const alpha = this.pa[i]!;
      if (alpha <= 0) continue;
      const x = this.px[i]!;
      const y = this.py[i]!;
      const d = this.depth[i]!;
      let dx = x - this.qx[i]!;
      let dy = y - this.qy[i]!;
      // Just in, or just come round: the streak is as long as its speed says.
      if (this.qa[i]! <= 0 || dx < -L.w * 0.5) {
        dx = this.speed[i]! * f.runRate * (EXPOSURE_MS / 1000) * L.w;
        dy = 0;
      }
      let length = Math.hypot(dx, dy);
      const near = 0.4 + 0.6 * d;
      const sprite = this.comets[this.group[i]!];
      if (length > 2 && sprite) {
        const cos = dx / length;
        const sin = dy / length;
        if (length > longest) length = longest;
        const thick = 5 + 15 * d;
        ctx.setTransform(k * cos, k * sin, -k * sin, k * cos, k * x + ex, k * y + ey);
        ctx.globalAlpha = alpha * near;
        ctx.drawImage(sprite, -length, -thick / 2, length, thick);
      }
      // The light itself: a white point in a halo of its colour (all there is of it at rest).
      ctx.setTransform(k, 0, 0, k, ex, ey);
      const rest = 1 - clamp01(length / 40);
      const twinkle = 1 - 0.3 * rest * (0.5 + 0.5 * Math.sin(twinkleAt + this.phase[i]! * 40));
      ctx.globalAlpha = alpha * near * twinkle * 0.9;
      this.glow(ctx, NODE_HEX[this.group[i]!]!, x, y, 14 + 34 * d);
      ctx.globalAlpha = alpha * (0.55 + 0.45 * d) * twinkle;
      this.glow(ctx, WHITE, x, y, 5 + 9 * d);
    }
    ctx.setTransform(k, 0, 0, k, ex, ey);
  }

  /** Depth for the race: many small lights far behind the runners, drifting slowly, and a few
   * huge soft ones flashing past close to the eye. They come with the crowd and stop with it. */
  private drawDepth(ctx: CanvasRenderingContext2D, f: LogoIntroFrame): void {
    const L = this.L;
    const crowd = clamp01((f.count - 2) / 28) * (1 - f.stage);
    if (crowd <= 0.001) return;
    const shutter = f.runRate * (EXPOSURE_MS / 1000) * L.w;
    ctx.lineCap = 'round';
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g += 1) {
      ctx.strokeStyle = NODE_HEX[g]!;
      ctx.globalAlpha = 0.34 * crowd;
      ctx.beginPath();
      for (let j = g; j < FAR; j += 3) {
        // Coloured like the lane they are in: the whole window is the logo's blue-to-violet.
        const lane = (g + this.farLane[j]!) / 3;
        const x =
          (frac(this.farPhase[j]! + (f.runClock * this.farSpeed[j]!) / 1.2) * 1.2 - 0.1) * L.w;
        const y = (0.02 + 0.96 * lane) * L.h;
        ctx.moveTo(x - Math.max(1.5, this.farSpeed[j]! * shutter), y);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Close to the eye: out of focus, so only a wide soft smear of colour.
    for (let j = FAR; j < FAR + NEAR; j += 1) {
      const lane = this.farLane[j]!;
      const x = (frac(this.farPhase[j]! + (f.runClock * this.farSpeed[j]!) / 3) * 3 - 1) * L.w;
      const thick = L.h * (0.1 + 0.08 * this.farPhase[j]!);
      // (As everything stops it does not shrink to a sliver: it only fades.)
      const length = Math.max(
        thick * 1.6,
        L.w * (0.28 + 0.3 * this.farPhase[j]!) * clamp01(f.runRate),
      );
      ctx.globalAlpha = 0.2 * crowd * clamp01(f.runRate * 1.4);
      ctx.drawImage(
        this.sprite(NODE_HEX[lane < 1 / 3 ? 0 : lane < 2 / 3 ? 1 : 2]!),
        x - length / 2,
        (0.04 + 0.92 * lane) * L.h - thick / 2,
        length,
        thick,
      );
    }
  }

  /** The hundred lanes into the logo's three nodes, and the lights flowing along them. */
  private drawLanes(ctx: CanvasRenderingContext2D, f: LogoIntroFrame, box: Box): void {
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let g = 0; g < 3; g += 1) {
      ctx.strokeStyle = NODE_HEX[g]!;
      ctx.globalAlpha = f.lanes * 0.34;
      ctx.beginPath();
      for (let i = 0; i < LOGO_RUNNERS; i += 1) {
        if (this.group[i] !== g) continue;
        for (let step = 0; step <= LANE_STEPS; step += 1) {
          this.lanePoint(i, step / LANE_STEPS, box);
          if (step === 0) ctx.moveTo(this.point[0]!, this.point[1]!);
          else ctx.lineTo(this.point[0]!, this.point[1]!);
        }
      }
      ctx.stroke();
    }
    if (f.glints <= 0.001) return;
    const k = this.dpr * box.zoom;
    const ex = this.dpr * box.cx * (1 - box.zoom);
    const ey = this.dpr * box.cy * (1 - box.zoom);
    for (let i = 0; i < LOGO_RUNNERS; i += 1) {
      const sprite = this.comets[this.group[i]!];
      if (!sprite) continue;
      const a = frac(f.time * 0.00042 * this.glintRate[i]! + this.phase[i]!);
      const seen = Math.sin(Math.PI * a) ** 0.7;
      this.lanePoint(i, a - 0.06, box);
      const tx = this.point[0]!;
      const ty = this.point[1]!;
      this.lanePoint(i, a, box);
      const x = this.point[0]!;
      const y = this.point[1]!;
      const length = Math.hypot(x - tx, y - ty);
      if (length < 1) continue;
      const cos = (x - tx) / length;
      const sin = (y - ty) / length;
      ctx.setTransform(k * cos, k * sin, -k * sin, k * cos, k * x + ex, k * y + ey);
      ctx.globalAlpha = f.glints * seen * (0.35 + 0.5 * this.depth[i]!);
      ctx.drawImage(sprite, -length, -3.5, length, 7);
    }
    ctx.setTransform(k, 0, 0, k, ex, ey);
  }

  /** The beam out of the arrow's tip to the window's right edge, and the pulses racing along it. */
  private drawBeam(ctx: CanvasRenderingContext2D, f: LogoIntroFrame, box: Box): void {
    const L = this.L;
    const tipX = box.gx + (TIP[0] - CROP.x) * box.unit;
    const tipY = box.gy + (TIP[1] - CROP.y) * box.unit;
    const far = L.w * 1.08 + 40;
    const reach = f.beamShot >= 0 ? (far - tipX) * easeOutCubic(f.beamShot) : far - tipX;
    if (this.beamImage && reach > 1) {
      const thick = box.gh * (0.12 + 0.1 * f.beam);
      ctx.globalAlpha = f.beam;
      ctx.drawImage(this.beamImage, tipX - 4, tipY - thick / 2, reach, thick);
    }
    if (f.beamShot >= 0) {
      ctx.globalAlpha = 1;
      this.glow(ctx, WHITE, tipX + reach, tipY, box.gh * 0.36);
      return;
    }
    // Pulses of light racing out along it.
    const pulse = this.sprite(WHITE);
    for (let j = 0; j < 3; j += 1) {
      const a = frac(f.time * 0.00085 + j * 0.37);
      const x = tipX + (far - tipX + 300) * a * a;
      const length = 120 + 260 * a;
      ctx.globalAlpha = f.beam * 0.7 * Math.min(1, a * 6);
      ctx.drawImage(pulse, x - length / 2, tipY - 4.5, length, 9);
    }
  }

  private drawDust(ctx: CanvasRenderingContext2D, f: LogoIntroFrame): void {
    const L = this.L;
    const sprite = this.sprite('#cfdcff');
    for (let j = 0; j < DUST; j += 1) {
      const z = this.dustZ[j]!;
      const x = frac(this.dustX[j]! + f.time * 0.000012 * (0.4 + z)) * (L.w + 40) - 20;
      const y = frac(this.dustY[j]! - f.time * 0.000006 * (0.3 + z)) * (L.h + 40) - 20;
      const size = 2.5 + 7 * z * z;
      const twinkle = 0.6 + 0.4 * Math.sin(f.time * 0.0021 * (0.6 + z) + j * 2.4);
      ctx.globalAlpha = f.dust * (0.1 + 0.4 * z) * twinkle;
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    }
  }

  /** The impact at the arrow's tip: sparks thrown forwards, and a ring running out. */
  private drawSparks(ctx: CanvasRenderingContext2D, f: LogoIntroFrame, box: Box): void {
    const L = this.L;
    const tipX = box.gx + (TIP[0] - CROP.x) * box.unit;
    const tipY = box.gy + (TIP[1] - CROP.y) * box.unit;
    if (f.sparks > 0) {
      // Each spark is a small streak of light flying out ahead of the arrow, slowing as it goes.
      const reach = Math.max(L.w * 0.3, box.gh * 1.5);
      const k = this.dpr * box.zoom;
      const ex = this.dpr * box.cx * (1 - box.zoom);
      const ey = this.dpr * box.cy * (1 - box.zoom);
      for (let j = 0; j < SPARKS; j += 1) {
        const e = clamp01(f.sparks * this.sparkPace[j]!);
        if (e >= 1) continue;
        const sprite = j % 3 === 0 ? this.cometWhite : this.comets[j % 3 === 1 ? 0 : 2];
        if (!sprite) continue;
        const r = reach * this.sparkReach[j]!;
        const head = r * easeOutCubic(e);
        const length = Math.max(3, head - r * easeOutCubic(Math.max(0, e - 0.09)));
        const cos = Math.cos(this.sparkAngle[j]!);
        const sin = Math.sin(this.sparkAngle[j]!);
        ctx.setTransform(
          k * cos,
          k * sin,
          -k * sin,
          k * cos,
          k * (tipX + cos * head) + ex,
          k * (tipY + sin * head) + ey,
        );
        ctx.globalAlpha = Math.min(1, (1 - e) * 1.8);
        const thick = 4 + 5 * this.sparkReach[j]!;
        ctx.drawImage(sprite, -length, -thick / 2, length, thick);
      }
      ctx.setTransform(k, 0, 0, k, ex, ey);
    }
    if (f.shock > 0) {
      const e = easeOutCubic(f.shock);
      const size = Math.max(L.w, L.h) * 0.6 * e;
      ctx.globalAlpha = (1 - f.shock) ** 2 * 0.55;
      ctx.strokeStyle = '#bcd0ff';
      ctx.lineWidth = 0.75 + 3.5 * (1 - f.shock) ** 2;
      ctx.beginPath();
      ctx.ellipse(tipX, tipY, size, size * 0.86, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** The logo: all of it once the light has struck the tip; before that, as much of it as the
   * light has reached — its nodes, then down its branches, then along the arrow. */
  private drawGlyph(
    ctx: CanvasRenderingContext2D,
    f: LogoIntroFrame,
    box: Box,
    alpha: number,
  ): void {
    const glyph = this.glyph;
    if (!glyph || alpha <= 0.001) return;
    ctx.globalCompositeOperation = 'source-over';
    if (f.glyph || this.variant === 'still') {
      ctx.globalAlpha = alpha;
      ctx.drawImage(glyph, box.gx, box.gy, box.gw, box.gh);
      ctx.globalCompositeOperation = 'lighter';
      return;
    }
    const lit = f.nodes[0] > 0 || f.nodes[1] > 0 || f.nodes[2] > 0;
    const scratch = this.scratch;
    const sctx = this.scratchCtx;
    if (!lit || !scratch || !sctx) {
      ctx.globalCompositeOperation = 'lighter';
      return;
    }
    const k = Math.min(1.6, box.unit * box.zoom * this.dpr);
    const sw = Math.ceil(CROP.w * k);
    const sh = Math.ceil(CROP.h * k);
    if (scratch.width < sw || scratch.height < sh) {
      scratch.width = Math.max(scratch.width, sw);
      scratch.height = Math.max(scratch.height, sh);
    }
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    sctx.setTransform(k, 0, 0, k, -CROP.x * k, -CROP.y * k);
    sctx.fillStyle = '#fff';
    sctx.strokeStyle = '#fff';
    sctx.lineCap = 'round';
    for (let n = 0; n < 3; n += 1) {
      const pop = f.nodes[n]!;
      if (pop <= 0) continue;
      const node = NODES[n]!;
      sctx.beginPath();
      sctx.arc(
        node[0],
        node[1],
        (NODE_RADIUS + 12) * Math.min(1, easeOutBack(pop)),
        0,
        Math.PI * 2,
      );
      sctx.fill();
    }
    if (f.branch > 0) {
      for (const branch of BRANCHES) {
        sctx.lineWidth = branch.width;
        sctx.beginPath();
        sctx.moveTo(branch.from[0], branch.from[1]);
        sctx.lineTo(
          lerp(branch.from[0], branch.to[0], f.branch) + 0.1,
          lerp(branch.from[1], branch.to[1], f.branch),
        );
        sctx.stroke();
      }
    }
    if (f.trunk > 0) {
      sctx.lineWidth = TRUNK.width;
      sctx.beginPath();
      sctx.moveTo(TRUNK.from[0], TRUNK.from[1]);
      sctx.lineTo(lerp(TRUNK.from[0], TRUNK.to[0], f.trunk) + 0.1, TRUNK.from[1]);
      sctx.stroke();
    }
    sctx.globalCompositeOperation = 'source-in';
    sctx.drawImage(glyph, CROP.x, CROP.y, CROP.w, CROP.h);
    ctx.globalAlpha = alpha;
    ctx.drawImage(scratch, 0, 0, sw, sh, box.gx, box.gy, box.gw, box.gh);
    ctx.globalCompositeOperation = 'lighter';
  }

  /** The lights on the logo: each node as it lights up, the heads of the light running down the
   * branches and the arrow, and after the impact the white heat and the shine across it. */
  private drawGlyphLights(ctx: CanvasRenderingContext2D, f: LogoIntroFrame, box: Box): void {
    ctx.globalCompositeOperation = 'lighter';
    if (!f.glyph && this.variant !== 'still') {
      ctx.lineCap = 'round';
      for (let n = 0; n < 3; n += 1) {
        const pop = f.nodes[n]!;
        if (pop <= 0) continue;
        const node = NODES[n]!;
        this.spot(box, node[0], node[1]);
        const x = this.point[0]!;
        const y = this.point[1]!;
        const r = NODE_RADIUS * box.unit;
        if (pop < 1) {
          // Lighting up: a white flash, and a ring thrown off.
          const e = easeOutCubic(pop);
          ctx.globalAlpha = (1 - pop) ** 1.3;
          this.glow(ctx, WHITE, x, y, r * (3 + 4 * e));
          ctx.globalAlpha = (1 - pop) ** 1.5 * 0.9;
          ctx.strokeStyle = NODE_HEX[n]!;
          ctx.lineWidth = 1 + 3 * (1 - pop);
          ctx.beginPath();
          ctx.arc(x, y, r * (1 + 1.5 * e), 0, Math.PI * 2);
          ctx.stroke();
        }
        // Lit, and taking in the runners still arriving.
        ctx.globalAlpha = 0.5 * (1 - f.branch);
        this.glow(ctx, NODE_HEX[n]!, x, y, r * 5.5);
      }
      if (f.branch > 0 && f.trunk <= 0) {
        for (let n = 0; n < 3; n += 1) {
          const branch = BRANCHES[n]!;
          this.spot(
            box,
            lerp(branch.from[0], branch.to[0], f.branch),
            lerp(branch.from[1], branch.to[1], f.branch),
          );
          ctx.globalAlpha = 0.85;
          this.glow(ctx, NODE_HEX[n]!, this.point[0]!, this.point[1]!, box.gh * 0.7);
          ctx.globalAlpha = 0.95;
          this.glow(ctx, WHITE, this.point[0]!, this.point[1]!, box.gh * 0.3);
        }
      }
      if (f.trunk > 0) {
        this.spot(
          box,
          Math.min(TIP[0], lerp(TRUNK.from[0], TRUNK.to[0], f.trunk) + TRUNK.width * 0.4),
          TRUNK.from[1],
        );
        ctx.globalAlpha = 0.9;
        this.glow(ctx, ARROW_HEX, this.point[0]!, this.point[1]!, box.gh * (0.9 + 0.5 * f.trunk));
        ctx.globalAlpha = 1;
        this.glow(ctx, WHITE, this.point[0]!, this.point[1]!, box.gh * (0.36 + 0.3 * f.trunk));
      }
      return;
    }
    if (f.overdrive > 0.01 && this.glyphWhite) {
      ctx.globalAlpha = 0.92 * f.overdrive;
      ctx.drawImage(this.glyphWhite, box.gx, box.gy, box.gw, box.gh);
    }
    if (f.sheen >= 0 && this.glyph)
      this.drawShine(ctx, this.glyph, box.gx, box.gy, box.gw, box.gh, f.sheen, 0.8, -0.5);
  }

  /** Where a point of the master image is on screen, into `this.point`. */
  private spot(box: Box, x: number, y: number): void {
    this.point[0] = box.gx + (x - CROP.x) * box.unit;
    this.point[1] = box.gy + (y - CROP.y) * box.unit;
  }

  /** The flash of the impact: the whole window lifts, a burst at the tip, a flare along the axis. */
  private drawFlash(ctx: CanvasRenderingContext2D, f: LogoIntroFrame, box: Box): void {
    const L = this.L;
    const tipX = box.gx + (TIP[0] - CROP.x) * box.unit;
    const tipY = box.gy + (TIP[1] - CROP.y) * box.unit;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = f.flash * 0.13;
    ctx.fillStyle = '#a8c0ff';
    ctx.fillRect(-L.w * 0.1, -L.h * 0.1, L.w * 1.2, L.h * 1.2);
    const size = Math.max(L.w, L.h) * (0.3 + 0.6 * f.flash);
    ctx.globalAlpha = f.flash;
    this.glow(ctx, WHITE, tipX, tipY, size);
    ctx.globalAlpha = f.flash * 0.9;
    const tall = 14 + 44 * f.flash;
    ctx.drawImage(this.sprite('#cfe0ff'), tipX - L.w * 1.1, tipY - tall / 2, L.w * 2.2, tall);
  }

  /** A light band across `mask` (the logo or the name), drawn added onto the picture. */
  private drawShine(
    ctx: CanvasRenderingContext2D,
    mask: HTMLCanvasElement,
    x: number,
    y: number,
    w: number,
    h: number,
    at: number,
    alpha: number,
    slant: number,
  ): void {
    const scratch = this.scratch;
    const sctx = this.scratchCtx;
    if (!scratch || !sctx || !this.band || w < 1 || h < 1) return;
    const sw = Math.ceil(Math.min(w * this.dpr, 2048));
    const sh = Math.ceil((sw * h) / w);
    if (scratch.width < sw || scratch.height < sh) {
      scratch.width = Math.max(scratch.width, sw);
      scratch.height = Math.max(scratch.height, sh);
    }
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    const bandW = Math.max(sw * 0.3, sh * 0.9);
    const cx = -bandW + (sw + bandW * 2) * at;
    sctx.setTransform(1, 0, slant, 1, cx - slant * sh * 0.5, 0);
    sctx.drawImage(this.band, -bandW / 2, 0, bandW, sh);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(mask, 0, 0, sw, sh);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    ctx.drawImage(scratch, 0, 0, sw, sh, x, y, w, h);
  }

  /** "Sprint Coder", written by the cursor letter by letter, and the line under it. `crisp` is
   * the real drawing; without it only the letters are drawn (faintly), as the source of their glow. */
  private drawName(
    ctx: CanvasRenderingContext2D,
    f: LogoIntroFrame,
    box: Box,
    alpha: number,
    crisp: boolean,
  ): void {
    const text = this.text;
    if (!text) return;
    const L = this.L;
    const left = L.cx - text.width / 2;
    // The name keeps its place under the logo as the logo settles.
    const wordY = L.wordY + (box.cy - L.cardY);
    const top = wordY - text.height / 2;
    const n = text.letters.length;
    ctx.globalCompositeOperation = 'source-over';
    if (f.type >= 1) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(text.whole, left - text.pad, top, text.width + text.pad * 2, text.height);
    } else {
      for (let i = 0; i < n; i += 1) {
        const letter = text.letters[i]!;
        const p = letterProgress(f.type, i, n);
        if (p <= 0) continue;
        const e = easeOutCubic(p);
        // Each letter lands: a little large and low, into place.
        const grow = 1 + 0.2 * (1 - e);
        const w = (letter.w + text.pad * 2) * grow;
        const h = text.height * grow;
        const x = left + letter.x + letter.w / 2;
        const y = wordY + text.size * 0.1 * (1 - e);
        if (crisp && p < 1) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = alpha * (1 - p) * 0.32;
          this.glow(ctx, '#dbe7ff', x, wordY, text.size * 1.15);
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = alpha * clamp01(p * 4.5);
        ctx.drawImage(letter.canvas, x - w / 2, y - h / 2, w, h);
      }
    }
    if (!crisp) {
      ctx.globalCompositeOperation = 'lighter';
      return;
    }
    if (f.shine >= 0) {
      this.drawShine(
        ctx,
        text.whole,
        left - text.pad,
        top,
        text.width + text.pad * 2,
        text.height,
        f.shine,
        0.75 * alpha,
        -0.35,
      );
    }
    // The writing cursor: just after the last letter it has written.
    if (f.pen > 0.001) {
      const written = Math.min(n, f.type * (n + 1.2));
      const index = Math.min(n - 1, Math.floor(written));
      const letter = text.letters[index]!;
      const within1 = clamp01(written - index);
      const x =
        written >= n ? left + text.width : left + letter.x + letter.w * easeOutCubic(within1);
      const bar = Math.max(2.5, text.size * 0.07);
      const tall = text.size * 0.98;
      const px = x + text.size * 0.1;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = f.pen * 0.5;
      this.glow(ctx, '#8fb8ff', px, wordY, tall * 1.25);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = f.pen;
      ctx.fillStyle = '#eaf2ff';
      ctx.fillRect(px - bar / 2, wordY - tall / 2, bar, tall);
    }
    // The line under the name: spaced wide, drawing together as it appears.
    if (f.tagline > 0.001) {
      const t = f.tagline;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha * t * 0.78;
      ctx.fillStyle = '#c3cbe0';
      ctx.font = `500 ${L.taglineSize}px ${FONT_SANS}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const spacing = (0.46 - 0.2 * t) * L.taglineSize;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing.toFixed(2)}px`;
      ctx.fillText(LOGO_TAGLINE, L.cx + spacing / 2, L.taglineY + (box.cy - L.cardY) + (1 - t) * 6);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.textAlign = 'start';
    }
    ctx.globalCompositeOperation = 'lighter';
  }
}

/** Set once the full film has been seen (or skipped): later Setups get the short one. */
export const LOGO_INTRO_SEEN_KEY = 'sprint-coder:logo-intro-seen-v1';

export function readLogoIntroSeen(): boolean {
  try {
    return window.localStorage.getItem(LOGO_INTRO_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLogoIntroSeen(): void {
  try {
    window.localStorage.setItem(LOGO_INTRO_SEEN_KEY, '1');
  } catch {
    // Storage off: the film is simply shown again next time.
  }
}
