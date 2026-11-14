// The timing of the logo film, apart from any drawing: which scene runs when, and what every
// moving part's value is at a given time. Pure functions only, so the whole film can be checked in
// tests (its length, the order of the scenes, a skip, the still version) without a canvas.
//
// The full film (10 s) tells the product in one shot — many run at once, and become one:
//
//   spark    a text cursor waits in the dark, blinks, gathers itself …
//   run      … and sprints off. Others follow: 3, 10, 40, 100 lights racing across the window,
//            faster and faster, while a counter runs up to 100.
//   brake    time stops. The hundred hang in the air, then line up on their marks.
//   rush     go: they pour along a hundred lanes into the logo's three nodes.
//   flow     the light runs down the three branches, meets, and shoots along the arrow.
//   impact   it strikes the tip: a flash, a beam out to the right, the real logo.
//   name     the logo makes room and the cursor from the start comes back to write the name.
//   hold     the finished card, alive: light keeps flowing in through the lanes and out the arrow.
//   handoff  a wipe of light, left to right, leaves the Setup behind it.

export type LogoIntroVariant = 'full' | 'short' | 'still';

export type LogoSceneId =
  'spark' | 'run' | 'brake' | 'rush' | 'flow' | 'impact' | 'name' | 'hold' | 'handoff';

export type LogoScene = Readonly<{ id: LogoSceneId; start: number; duration: number }>;

const SCENE_ORDER: readonly LogoSceneId[] = [
  'spark',
  'run',
  'brake',
  'rush',
  'flow',
  'impact',
  'name',
  'hold',
  'handoff',
];

function plan(parts: readonly (readonly [LogoSceneId, number])[]): readonly LogoScene[] {
  let start = 0;
  return parts.map(([id, duration]) => {
    const scene = { id, start, duration };
    start += duration;
    return scene;
  });
}

/** Scene lengths in ms. The full film is for the very first Setup; the short one for a Setup
 * shown again (a replay from Settings, or a first Setup that was left and reopened); the still
 * one, with reduced motion, only fades the finished card in and out. */
export const LOGO_TIMELINES: Readonly<Record<LogoIntroVariant, readonly LogoScene[]>> = {
  full: plan([
    ['spark', 1150],
    ['run', 2450],
    ['brake', 950],
    ['rush', 600],
    ['flow', 600],
    ['impact', 800],
    ['name', 1300],
    ['hold', 1350],
    ['handoff', 800],
  ]),
  short: plan([
    ['rush', 560],
    ['flow', 480],
    ['impact', 520],
    ['name', 900],
    ['hold', 380],
    ['handoff', 600],
  ]),
  still: plan([
    ['name', 300],
    ['hold', 1000],
    ['handoff', 400],
  ]),
};

/** A skip ends the film this quickly (a short fade, not a cut). */
export const LOGO_SKIP_MS = 420;
/** How many lights run (the product's "up to 100 at once"). */
export const LOGO_RUNNERS = 100;

type SceneTable = Partial<Record<LogoSceneId, LogoScene>>;
const TABLES: Readonly<Record<LogoIntroVariant, SceneTable>> = {
  full: Object.fromEntries(LOGO_TIMELINES.full.map((scene) => [scene.id, scene])),
  short: Object.fromEntries(LOGO_TIMELINES.short.map((scene) => [scene.id, scene])),
  still: Object.fromEntries(LOGO_TIMELINES.still.map((scene) => [scene.id, scene])),
};

export function logoIntroDuration(variant: LogoIntroVariant): number {
  const scenes = LOGO_TIMELINES[variant];
  const last = scenes[scenes.length - 1]!;
  return last.start + last.duration;
}

/** When the Setup itself starts to come in (the film's last scene runs over it). */
export function logoHandoffAt(variant: LogoIntroVariant): number {
  return TABLES[variant].handoff!.start;
}

/** Where the film may not go on until the logo and the word are ready to draw: the full film
 * waits at the end of its first scene (the cursor simply keeps waiting), the others at the start. */
export function logoReadyGateAt(variant: LogoIntroVariant): number {
  return variant === 'full' ? TABLES.full.run!.start : 0;
}

/**
 * Which film to play, if any. What decides is whether this person has seen the full film — not
 * which form the Setup takes: the full one plays before the first Setup someone meets, be it the
 * first run's (a new installation) or the one laid over the app at launch (someone who updated
 * from an older version — most people). Once seen (or skipped), every later Setup — Settings'
 * "セットアップをもう一度", a first Setup left and reopened — gets the short one. With reduced
 * motion, someone who has not seen it gets the still card, and nothing after that.
 */
export function chooseLogoIntro(input: {
  animate: boolean;
  seen: boolean;
}): LogoIntroVariant | null {
  if (!input.animate) return input.seen ? null : 'still';
  return input.seen ? 'short' : 'full';
}

// ---------- easing ----------

export const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const easeInCubic = (t: number): number => t * t * t;
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
/** Passes the end a little and comes back: momentum, not a mechanical stop. */
export const easeOutBack = (t: number, s = 1.4): number =>
  1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
const span = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
/** A pulse that rises quickly and dies away: 0 → 1 at `peak` → 0 at 1. */
const pulse = (t: number, peak: number) =>
  t <= 0 || t >= 1 ? 0 : t < peak ? easeOutCubic(t / peak) : (1 - (t - peak) / (1 - peak)) ** 2;

// ---------- the run ----------

const RUN = TABLES.full.run!;
const BRAKE = TABLES.full.brake!;
/** How fast the runners' own clock goes at the start and the end of the run. */
const RATE_START = 0.95;
const RATE_TOP = 2;
/** The part of the brake in which they come to a stop. */
const BRAKE_STOP = 0.46;
/** The cursor's own dash, at the very start of the run. */
export const LOGO_DASH_MS = 420;

/** The runners' clock, in seconds, at `time` ms of the full film: it runs faster and faster
 * through the run, then stops within the first part of the brake. Their positions are functions of
 * this clock, so slowing it is slowing all of them at once — the freeze. */
export function runClockAt(time: number): number {
  const runSeconds = RUN.duration / 1000;
  const u = clamp01((time - RUN.start) / RUN.duration);
  const atRunEnd = runSeconds * (RATE_START + (RATE_TOP - RATE_START) / 3);
  if (time <= RUN.start + RUN.duration)
    return runSeconds * (RATE_START * u + ((RATE_TOP - RATE_START) * u * u * u) / 3);
  const stopSeconds = (BRAKE.duration * BRAKE_STOP) / 1000;
  const w = clamp01((time - BRAKE.start) / (BRAKE.duration * BRAKE_STOP));
  return atRunEnd + (RATE_TOP * stopSeconds * (1 - (1 - w) ** 3)) / 3;
}

/** The clock's value once everything has stopped. */
export const RUN_CLOCK_END = runClockAt(BRAKE.start + BRAKE.duration);

/** How fast the runners' clock is going at `time` (0 = stopped, 1 = an easy run). */
export function runRateAt(time: number): number {
  if (time < RUN.start) return 0;
  if (time <= RUN.start + RUN.duration) {
    const u = (time - RUN.start) / RUN.duration;
    return RATE_START + (RATE_TOP - RATE_START) * u * u;
  }
  const w = clamp01((time - BRAKE.start) / (BRAKE.duration * BRAKE_STOP));
  return RATE_TOP * (1 - w) ** 2;
}

/** The first to follow the cursor sets off this long after it (the rest ever closer together). */
const FIRST_FOLLOWER_MS = 150;

/** When runner `index` (0 = the cursor itself) sets off, in ms of the full film: one, then a few,
 * then a flood — the count doubles at an even pace. */
export function runnerJoinAt(index: number): number {
  if (index <= 0) return RUN.start;
  const u = Math.log(index + 1) / Math.log(LOGO_RUNNERS);
  return RUN.start + FIRST_FOLLOWER_MS + (RUN.duration * 0.56 - FIRST_FOLLOWER_MS) * u;
}

/** The number on the counter at `time` of the full film: 0 before the run, 100 from its end. */
export function runnerCountAt(time: number): number {
  if (time < RUN.start) return 0;
  const u = clamp01((time - RUN.start - LOGO_DASH_MS * 0.5) / (RUN.duration * 0.66));
  return Math.max(1, Math.min(LOGO_RUNNERS, Math.round(LOGO_RUNNERS ** u)));
}

/** When the counter reaches 100. */
const COUNT_FULL_AT = RUN.start + LOGO_DASH_MS * 0.5 + RUN.duration * 0.66;

// ---------- one frame ----------

export type LogoIntroFrame = {
  /** Time in the film (ms), as asked. */
  time: number;
  scene: LogoSceneId;
  /** Progress through the current scene, 0..1. */
  progress: number;
  /** Opacity of everything drawn in light (only the still card fades in with it), 0..1. */
  content: number;

  /** The waiting cursor: its opacity (it blinks), and how far it has gathered itself, 0..1. */
  caret: number;
  charge: number;
  /** The cursor's dash across the window at the start of the run: -1 none, else 0..1. */
  dash: number;

  /** The runners' clock (seconds) and its speed. */
  runClock: number;
  runRate: number;
  /** How present the runners are, 0..1 (gone once they are all in the logo). */
  runners: number;
  /** The number on the counter and its opacity; `countFlash` peaks as it reaches 100. */
  count: number;
  counter: number;
  countFlash: number;
  /** From hanging where they stopped (0) to lined up on their marks (1). */
  stage: number;
  /** The draw-back before the rush, 0..1. */
  pull: number;
  /** Progress of the rush into the nodes (each runner adds its own delay, see `rushProgress`). */
  rush: number;

  /** Brightness of the hundred lanes into the logo, of the lights flowing along them, and of the
   * beam out of the arrow's tip, 0..1. */
  lanes: number;
  glints: number;
  beam: number;
  /** The first shot of the beam: -1 none, else 0..1 across to the window's edge. */
  beamShot: number;

  /** Each node lighting up (top, middle, bottom), 0..1. */
  nodes: [number, number, number];
  /** The light's progress down the three branches, then along the arrow to its tip, 0..1. */
  branch: number;
  trunk: number;
  /** The whole logo is there (from the impact on). */
  glyph: boolean;
  /** 1 = the logo large in the middle of the window, 0 = in its place on the finished card. */
  hero: number;
  /** The impact: the flash, the ring, the sparks' progress (0 none), the logo white-hot, its
   * colours split apart, and the shine across it (-1 none, else 0..1). */
  flash: number;
  shock: number;
  sparks: number;
  overdrive: number;
  fringe: number;
  sheen: number;
  /** Camera scale: 1 = rest. */
  zoom: number;

  /** How much of the name is written, 0..1 (each letter adds its own delay, see `letterProgress`). */
  type: number;
  /** The writing cursor's opacity, 0..1. */
  pen: number;
  /** The line under the name, 0..1. */
  tagline: number;
  /** A gleam across the name while the card holds: -1 none, else 0..1. */
  shine: number;
  /** Dust in the air after the impact, 0..1. */
  dust: number;

  /** The wipe that leaves the Setup behind it, 0..1 across the window. */
  wipe: number;
  /** Opacity and scale of the whole film (a skip, and the still card's leaving). */
  opacity: number;
  scale: number;
  /** The Setup may come in now. */
  handoff: boolean;
  /** The film is over: nothing more to draw. */
  done: boolean;
};

export function createLogoFrame(): LogoIntroFrame {
  return {
    time: 0,
    scene: 'spark',
    progress: 0,
    content: 1,
    caret: 0,
    charge: 0,
    dash: -1,
    runClock: 0,
    runRate: 0,
    runners: 0,
    count: 0,
    counter: 0,
    countFlash: 0,
    stage: 0,
    pull: 0,
    rush: 0,
    lanes: 0,
    glints: 0,
    beam: 0,
    beamShot: -1,
    nodes: [0, 0, 0],
    branch: 0,
    trunk: 0,
    glyph: false,
    hero: 1,
    flash: 0,
    shock: 0,
    sparks: 0,
    overdrive: 0,
    fringe: 0,
    sheen: -1,
    zoom: 1,
    type: 0,
    pen: 0,
    tagline: 0,
    shine: -1,
    dust: 0,
    wipe: 0,
    opacity: 1,
    scale: 1,
    handoff: false,
    done: false,
  };
}

/** How long a node takes to light up. */
const NODE_POP_MS = 230;

/**
 * Every moving part's value at `time` ms into the film, written into `out` (so a renderer can ask
 * every frame without making anything new). `skipAt` is when a skip was asked for, if one was:
 * from then on the film fades out over LOGO_SKIP_MS while it keeps moving, and the Setup comes in
 * at once.
 */
export function logoIntroFrameInto(
  out: LogoIntroFrame,
  variant: LogoIntroVariant,
  time: number,
  skipAt: number | null = null,
): LogoIntroFrame {
  const total = logoIntroDuration(variant);
  const t = Math.max(0, Math.min(time, total));
  const scenes = LOGO_TIMELINES[variant];
  const table = TABLES[variant];
  let current = scenes[scenes.length - 1]!;
  for (const scene of scenes) {
    if (t < scene.start + scene.duration) {
      current = scene;
      break;
    }
  }
  const first = SCENE_ORDER.indexOf(scenes[0]!.id);
  // A scene this version of the film leaves out counts as over if it comes before the first one.
  const at = (id: LogoSceneId): number => {
    const scene = table[id];
    if (!scene) return SCENE_ORDER.indexOf(id) < first ? 1 : 0;
    return clamp01((t - scene.start) / scene.duration);
  };
  /** ms since scene `id` began: negative before it, +Infinity if it was left out as over. */
  const since = (id: LogoSceneId): number => {
    const scene = table[id];
    if (!scene) return SCENE_ORDER.indexOf(id) < first ? Number.POSITIVE_INFINITY : -1;
    return t - scene.start;
  };

  const full = variant === 'full';
  const still = variant === 'still';
  const run = at('run');
  const brake = at('brake');
  const rush = at('rush');
  const flow = at('flow');
  const name = at('name');
  const hold = at('hold');
  const leave = at('handoff');
  const sinceRush = since('rush');
  const sinceFlow = since('flow');
  const sinceImpact = since('impact');
  const sinceName = since('name');

  out.time = time;
  out.scene = current.id;
  out.progress = clamp01((t - current.start) / current.duration);
  out.content = still ? easeOutCubic(name) : 1;

  // The cursor: on, off, on again — then it gathers itself (the held breath before the sprint).
  if (full && t < RUN.start) {
    out.caret =
      t < 120
        ? 0
        : t < 240
          ? (t - 120) / 120
          : t < 540
            ? 1
            : t < 600
              ? 1 - (t - 540) / 60
              : t < 720
                ? 0
                : t < 780
                  ? (t - 720) / 60
                  : 1;
    out.charge = easeInCubic(span(t, 780, RUN.start));
  } else {
    out.caret = 0;
    out.charge = 0;
  }
  const dashMs = full ? t - RUN.start : -1;
  out.dash = dashMs >= 0 && dashMs < LOGO_DASH_MS ? dashMs / LOGO_DASH_MS : -1;

  // The run, the stop, the line-up.
  out.runClock = full ? runClockAt(t) : RUN_CLOCK_END;
  out.runRate = full ? runRateAt(t) : 0;
  out.runners = still || sinceFlow >= 0 ? 0 : 1;
  out.count = full ? runnerCountAt(t) : LOGO_RUNNERS;
  out.counter = full
    ? easeOutCubic(span(run, 0.08, 0.2)) * (1 - easeOutCubic(span(rush, 0, 0.45)))
    : 0;
  out.countFlash = full ? pulse(span(t, COUNT_FULL_AT, COUNT_FULL_AT + 700), 0.12) : 0;
  out.stage = full ? easeInOutCubic(span(brake, 0.4, 0.9)) : 1;
  out.pull = still
    ? 0
    : (full ? easeOutCubic(span(brake, 0.88, 1)) : 1) * (1 - easeOutCubic(span(rush, 0, 0.14)));
  out.rush = rush;

  // The lanes, the lights along them, the beam.
  const struck = sinceImpact >= 0;
  out.lanes = still
    ? 0
    : struck
      ? 0.58 + 0.42 * (1 - easeOutCubic(span(sinceImpact, 0, 900)))
      : sinceFlow >= 0
        ? 0.7
        : 0.2 * out.stage + 0.5 * easeInCubic(rush);
  out.glints = still ? 0 : struck ? 1 : 0.6 * flow;
  out.beam = still || !struck ? 0 : 0.6 + 0.4 * (1 - easeOutCubic(span(sinceImpact, 0, 700)));
  out.beamShot = !still && struck && sinceImpact < 200 ? sinceImpact / 200 : -1;

  // The logo: nodes, branches, the arrow, the impact.
  const rushMs = table.rush?.duration ?? 600;
  for (let k = 0; k < 3; k += 1) {
    out.nodes[k] = still ? 1 : clamp01((sinceRush - rushMs * (0.5 + 0.085 * k)) / NODE_POP_MS);
  }
  out.branch = still ? 1 : easeInOutCubic(span(flow, 0, 0.66));
  out.trunk = still ? 1 : span(flow, 0.6, 1) ** 2.6;
  out.glyph = struck;
  out.hero = still ? 0 : 1 - easeInOutCubic(span(name, 0, 0.56));
  out.flash = still || !struck ? 0 : pulse(span(sinceImpact, 0, 460), 0.07);
  out.shock = still || !struck || sinceImpact >= 700 ? 0 : Math.max(0.0001, sinceImpact / 700);
  out.sparks = still || !struck || sinceImpact >= 950 ? 0 : Math.max(0.0001, sinceImpact / 950);
  out.overdrive = still || !struck ? 0 : 1 - easeOutCubic(span(sinceImpact, 0, 560));
  out.fringe = still || !struck ? 0 : 1 - easeOutCubic(span(sinceImpact, 0, 320));
  out.sheen = !still && sinceImpact > 240 && sinceImpact < 800 ? span(sinceImpact, 240, 800) : -1;
  // The camera creeps in as the light gathers, kicks at the impact, settles, then drifts in very
  // slowly for as long as the card is up.
  const creep = struck
    ? 0.04 * (1 - easeOutCubic(span(sinceImpact, 0, 650)))
    : 0.04 * easeInCubic(span(sinceRush, 0, rushMs + (table.flow?.duration ?? 600)));
  const kick = struck ? 0.075 * pulse(span(sinceImpact, 0, 560), 0.09) : 0;
  const drift = sinceName >= 0 ? 0.03 * span(t, table.name!.start, total) : 0;
  out.zoom = still ? 1 : (1 + creep + kick) * (1 + drift);

  // The name, the line under it, the dust.
  out.type = still ? 1 : span(name, 0.38, 0.88);
  out.pen = still
    ? 0
    : sinceName < 0
      ? 0
      : hold <= 0
        ? span(name, 0.3, 0.36)
        : hold < 0.2
          ? 1
          : hold < 0.26
            ? 1 - (hold - 0.2) / 0.06
            : hold < 0.4
              ? 0
              : hold < 0.46
                ? (hold - 0.4) / 0.06
                : hold < 0.62
                  ? 1
                  : 1 - span(hold, 0.62, 0.72);
  const nameMs = table.name!.duration;
  out.tagline = still ? 1 : easeOutCubic(span(sinceName, nameMs * 0.8, nameMs * 0.8 + 560));
  out.shine = !still && hold > 0.1 && hold < 0.6 ? span(hold, 0.1, 0.6) : -1;
  out.dust = still || !struck ? 0 : easeOutCubic(span(sinceImpact, 80, 1400));

  // The leaving.
  out.wipe = still ? 0 : easeInOutCubic(leave);
  out.opacity = still ? 1 - easeInCubic(leave) : 1;
  out.scale = 1;
  out.handoff = t >= logoHandoffAt(variant);
  out.done = time >= total;

  if (skipAt !== null && time >= skipAt) {
    const k = clamp01((time - skipAt) / LOGO_SKIP_MS);
    out.opacity *= 1 - easeOutCubic(k);
    out.scale = 1 + 0.05 * easeOutCubic(k);
    out.handoff = true;
    out.done = out.done || k >= 1;
  }
  return out;
}

/** A new frame object for `time` — for tests and one-off questions; a renderer keeps one object
 * and uses `logoIntroFrameInto`. */
export function logoIntroFrame(
  variant: LogoIntroVariant,
  time: number,
  skipAt: number | null = null,
): LogoIntroFrame {
  return logoIntroFrameInto(createLogoFrame(), variant, time, skipAt);
}

/** The part of the rush over which the runners set off one after another. */
const RUSH_STAGGER = 0.42;

/**
 * How far one runner has come on its way into its node, from the rush's progress: 0 = still on
 * its mark, 1 = in. `order` (0..1) is its place in the queue (the nearest go first). Each
 * accelerates all the way in — nothing slows down before it hits.
 */
export function rushProgress(rush: number, order: number): number {
  const local = clamp01((rush - clamp01(order) * RUSH_STAGGER) / (1 - RUSH_STAGGER));
  return local ** 2.3;
}

/** How far letter `index` of `count` has come in (0..1), from how much of the name is written. */
export function letterProgress(type: number, index: number, count: number): number {
  if (count <= 0 || type >= 1) return 1;
  return clamp01((type * (count + 1.2) - index) / 2.2);
}
