// The sound of the logo film: about ten seconds of synthesized sound that follows the picture —
// a quiet bed under the waiting cursor, a rising texture and quickening notes as the race fills
// the window, a sudden hush when time stops, three notes as the logo's nodes light, a warm chord
// at the impact, soft key ticks as the name is written, and a tail that dies away with the wipe.
//
// Nothing is recorded: every sound is made with Web Audio (oscillators, filtered noise, a
// generated reverb), so no audio file ships. The score — what sounds when — is plain data on the
// film's own time line (`logoSoundScore`), fixed by tests; `scheduleLogoSound` turns it into
// audio nodes on any audio context, so the very same sound can be played live (`LogoSoundPlayer`)
// or rendered to a buffer (`renderLogoSoundOffline`, for checking its level and for a recording).

import { LOGO_TIMELINES, type LogoIntroVariant, type LogoSceneId } from './setup-logo-timeline';
import { readSoundEffectPreferences } from './ui-sound';

// ---------- the score ----------

/** A pitched sound: one oscillator (two, a few cents apart, with `chorus`), its pitch gliding
 * from `freq` to `freqTo` over `glide` ms, shaped by attack / hold / release (ms). */
export type LogoTone = Readonly<{
  kind: 'tone';
  at: number;
  wave: 'sine' | 'triangle';
  freq: number;
  freqTo?: number;
  glide?: number;
  attack: number;
  hold: number;
  release: number;
  level: number;
  /** Low-pass over it, sliding from `cutoff` to `cutoffTo` (Hz) over the glide. */
  cutoff?: number;
  cutoffTo?: number;
  chorus?: boolean;
  pan?: number;
  panTo?: number;
  /** How much of it goes into the reverb, 0..1. */
  send: number;
}>;

/** A breath of noise through a filter whose frequency slides from `freq` to `freqTo` (a whoosh,
 * a tick, a thump). */
export type LogoNoise = Readonly<{
  kind: 'noise';
  at: number;
  band: 'bandpass' | 'lowpass' | 'highpass';
  freq: number;
  freqTo?: number;
  glide?: number;
  q: number;
  attack: number;
  hold: number;
  release: number;
  level: number;
  pan?: number;
  panTo?: number;
  send: number;
}>;

/** The bed: a held chord whose loudness and brightness follow `points` ([film ms, level,
 * low-pass Hz], joined by straight lines). */
export type LogoPad = Readonly<{
  kind: 'pad';
  at: number;
  /** [frequency, weight]: how much of each note is in the chord. */
  notes: readonly (readonly [number, number])[];
  points: readonly (readonly [number, number, number])[];
  send: number;
}>;

export type LogoSoundEvent = LogoTone | LogoNoise | LogoPad;

/** Frequency of a MIDI note (69 = A4 = 440 Hz). The film is in D major. */
const note = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const D2 = note(38);
const D3 = note(50);
const A3 = note(57);
const D4 = note(62);
const FS4 = note(66);
const A4 = note(69);
const D5 = note(74);
const E5 = note(76);
const FS5 = note(78);
const A5 = note(81);
const D6 = note(86);
const E6 = note(88);
const FS6 = note(90);
const A6 = note(93);

/** The notes that tick up with the counter: rising waves through the chord. */
const COUNT_NOTES = [D5, FS5, A5, D6, FS5, A5, D6, FS6, A5, D6, FS6, A6, D6, A6] as const;
/** The bed's chord: D and A in the tenor, with only a little of the low D under them (small
 * speakers cannot play it; large ones must not boom). */
const BED_NOTES: LogoPad['notes'] = [
  [D2, 0.3],
  [D3, 1],
  [A3, 0.8],
];
/** How many runners are heard passing, and how many ranks tick as they line up. */
const RUN_PASSES = 14;
const LINE_UP_RANKS = 6;
/** The impact's chord, low to high: D with its ninth — [frequency, level, left/right]. */
const IMPACT_CHORD: readonly (readonly [number, number, number])[] = [
  [D3, 0.26, 0],
  [A3, 0.26, -0.35],
  [FS4, 0.24, 0.35],
  [A4, 0.2, -0.5],
  [D5, 0.16, 0.5],
  [E5, 0.13, 0.15],
];
const IMPACT_SPARKLE: readonly (readonly [number, number])[] = [
  [D6, 0.3],
  [FS6, -0.3],
  [A6, 0.5],
];
export const LOGO_WORD_LETTERS = 12;
/** Where the space is in "Sprint Coder" (no key tick for it). */
const WORD_SPACE = 6;

type Envelope = readonly [attack: number, hold: number, release: number];
type ToneOptions = Partial<
  Pick<LogoTone, 'freqTo' | 'glide' | 'cutoff' | 'cutoffTo' | 'chorus' | 'pan' | 'panTo'>
>;
type NoiseOptions = Partial<Pick<LogoNoise, 'freqTo' | 'glide' | 'pan' | 'panTo'>>;

const tone = (
  at: number,
  wave: LogoTone['wave'],
  freq: number,
  [attack, hold, release]: Envelope,
  level: number,
  send: number,
  options: ToneOptions = {},
): LogoTone => ({ kind: 'tone', at, wave, freq, attack, hold, release, level, send, ...options });

const noise = (
  at: number,
  band: LogoNoise['band'],
  freq: number,
  q: number,
  [attack, hold, release]: Envelope,
  level: number,
  send: number,
  options: NoiseOptions = {},
): LogoNoise => ({
  kind: 'noise',
  at,
  band,
  freq,
  q,
  attack,
  hold,
  release,
  level,
  send,
  ...options,
});

/**
 * What sounds when, in ms of the film `variant` (sorted by time). The still card has no sound.
 * Every time is tied to the film's own scenes, so the sound cannot drift from the picture when
 * the film is retimed.
 */
export function logoSoundScore(variant: LogoIntroVariant): readonly LogoSoundEvent[] {
  if (variant === 'still') return [];
  const scenes = LOGO_TIMELINES[variant];
  const scene = (id: LogoSceneId) => scenes.find((each) => each.id === id);
  const last = scenes[scenes.length - 1]!;
  const total = last.start + last.duration;
  const rush = scene('rush')!;
  const flow = scene('flow')!;
  const impact = scene('impact')!.start;
  const name = scene('name')!;
  const hold = scene('hold')!.start;
  const handoff = scene('handoff')!;
  const run = scene('run');
  const brake = scene('brake');
  const events: LogoSoundEvent[] = [];
  const add = (...more: LogoSoundEvent[]) => events.push(...more);

  // ----- the bed: low D and A, swelling with the picture -----
  const afterImpact: LogoPad['points'] = [
    [impact - 20, 0.3, 2200],
    [impact + 60, 0.24, 1800],
    [impact + 1500, 0.14, 1100],
    [hold + 400, 0.08, 700],
    [handoff.start + handoff.duration * 0.6, 0.03, 400],
    [total - 50, 0, 300],
  ];
  if (run && brake) {
    add({
      kind: 'pad',
      at: 150,
      notes: BED_NOTES,
      points: [
        [150, 0, 300],
        [run.start - 50, 0.09, 420],
        [run.start + 300, 0.13, 560],
        [brake.start - 50, 0.3, 1500],
        [brake.start + 160, 0.07, 460],
        [rush.start - 60, 0.06, 440],
        [flow.start, 0.2, 1000],
        ...afterImpact,
      ],
      send: 0.35,
    });

    // ----- the cursor: a pip each time it appears, then it gathers itself -----
    add(tone(130, 'sine', E6, [2, 8, 60], 0.06, 0.6), tone(730, 'sine', E6, [2, 8, 60], 0.07, 0.6));
    const charge = run.start - 370;
    add(
      tone(charge, 'triangle', D3, [300, 40, 40], 0.1, 0.3, {
        freqTo: D4,
        glide: 370,
        cutoff: 900,
      }),
      noise(charge, 'bandpass', 500, 1.5, [330, 20, 60], 0.05, 0.3, { freqTo: 2500, glide: 370 }),
    );

    // ----- off it goes: a rush of air to the right, and one clear note -----
    add(
      noise(run.start, 'bandpass', 900, 0.9, [15, 90, 320], 0.18, 0.45, {
        freqTo: 5200,
        glide: 380,
        pan: -0.1,
        panTo: 0.9,
      }),
      tone(run.start, 'sine', D5, [3, 20, 500], 0.1, 0.6, { pan: 0.2 }),
    );

    // ----- the race: notes quickening with the counter, runners passing, a rising bed -----
    const firstTick = run.start + 330;
    const countFull = run.start + run.duration * 0.66 + 210;
    COUNT_NOTES.forEach((freq, k) => {
      const u = k / (COUNT_NOTES.length - 1);
      // Closer and closer together.
      const at = firstTick + (countFull - 60 - firstTick) * (0.5 * u + 0.5 * (1 - (1 - u) ** 1.35));
      add(tone(at, 'sine', freq, [2, 6, 110], 0.08 + 0.06 * u, 0.5, { pan: -0.4 + 0.8 * u }));
    });
    // One hundred.
    add(
      tone(countFull, 'sine', D6, [2, 10, 700], 0.13, 0.7, { pan: -0.2 }),
      tone(countFull, 'sine', A6, [2, 10, 700], 0.09, 0.7, { pan: 0.2 }),
    );
    for (let k = 0; k < RUN_PASSES; k += 1) {
      const u = k / (RUN_PASSES - 1);
      const at = run.start + 350 + (run.duration - 500) * (1 - (1 - u) ** 1.7);
      add(
        noise(at, 'bandpass', 700, 1.4, [60, 20, 160], 0.08 + 0.06 * u, 0.25, {
          freqTo: 2200 + 120 * k,
          glide: 240,
          pan: -0.8,
          panTo: 0.8,
        }),
      );
    }
    const rise = run.duration - 50;
    const shimmer: Envelope = [brake.start - countFull - 60, 30, 110];
    add(
      noise(run.start + 50, 'bandpass', 350, 0.8, [rise - 100, 100, 110], 0.14, 0.3, {
        freqTo: 3800,
        glide: rise,
      }),
      tone(run.start + 50, 'triangle', D3, [rise - 200, 200, 100], 0.09, 0.4, {
        freqTo: D4,
        glide: rise,
        cutoff: 1200,
        chorus: true,
      }),
      // A high shimmer over the full flood.
      tone(countFull + 30, 'sine', D6, shimmer, 0.022, 0.6, { pan: -0.3 }),
      tone(countFull + 30, 'sine', A6, shimmer, 0.022, 0.6, { pan: 0.3 }),
    );

    // ----- time stops: everything falls away; the hundred line up; a breath in -----
    add(
      tone(brake.start, 'triangle', 660, [5, 300, 250], 0.09, 0.5, {
        freqTo: 165,
        glide: 450,
        cutoff: 1400,
        cutoffTo: 300,
      }),
      tone(brake.start, 'sine', 110, [3, 30, 260], 0.16, 0.1, { freqTo: 65, glide: 200 }),
    );
    const lineUp = brake.start + brake.duration * 0.44;
    for (let k = 0; k < LINE_UP_RANKS; k += 1) {
      const at = lineUp + 78 * k;
      const pan = -0.6 + 0.1 * k;
      add(
        noise(at, 'bandpass', 3200, 4, [1, 4, 28], 0.05, 0.3, { pan }),
        tone(at, 'sine', k % 2 === 0 ? D6 : A5, [1, 3, 45], 0.028, 0.4, { pan }),
      );
    }
    add(
      noise(rush.start - 110, 'bandpass', 1800, 1.2, [100, 5, 15], 0.07, 0.2, {
        freqTo: 600,
        glide: 110,
        pan: 0,
        panTo: -0.5,
      }),
    );
  } else {
    add({
      kind: 'pad',
      at: 0,
      notes: BED_NOTES,
      points: [[0, 0, 400], [rush.start + rush.duration * 0.45, 0.18, 900], ...afterImpact],
      send: 0.35,
    });
  }

  // ----- go: they pour in from the left; the three nodes light as three rising notes -----
  const pour = rush.duration - 40;
  add(
    noise(rush.start, 'bandpass', 500, 0.9, [rush.duration * 0.63, 60, 240], 0.2, 0.4, {
      freqTo: 6000,
      glide: pour,
      pan: -0.9,
      panTo: 0,
    }),
    tone(rush.start, 'triangle', D3, [rush.duration * 0.66, 40, 200], 0.11, 0.4, {
      freqTo: D5,
      glide: pour,
      cutoff: 2500,
    }),
  );
  [D5, FS5, A5].forEach((freq, k) => {
    const at = rush.start + rush.duration * (0.5 + 0.085 * k);
    const pan = -0.25 + 0.25 * k;
    add(
      tone(at, 'triangle', freq, [2, 15, 650], 0.2, 0.65, { pan }),
      tone(at, 'sine', freq * 2, [2, 10, 400], 0.06, 0.7, { pan }),
    );
  });

  // ----- the light runs down the branches and along the arrow: one rise into the impact -----
  const climb: Envelope = [flow.duration - 60, 40, 50];
  const up = { glide: flow.duration };
  add(
    noise(flow.start, 'bandpass', 900, 0.8, climb, 0.24, 0.35, { freqTo: 7000, ...up }),
    tone(flow.start, 'sine', A4, climb, 0.13, 0.4, { freqTo: A5, ...up }),
    tone(flow.start, 'triangle', A3, climb, 0.14, 0.4, { freqTo: A4, cutoff: 3000, ...up }),
  );

  // ----- the impact: a soft thump, and a wide D chord that rings on -----
  add(
    tone(impact, 'sine', 110, [4, 120, 800], 0.4, 0.1, { freqTo: 55, glide: 420 }),
    noise(impact, 'lowpass', 1800, 0.7, [2, 25, 220], 0.32, 0.3, { freqTo: 300, glide: 200 }),
    noise(impact, 'highpass', 5000, 0.7, [3, 30, 500], 0.16, 0.7, { pan: 0, panTo: 0.6 }),
    // The beam out of the arrow's tip.
    noise(impact + 10, 'bandpass', 3000, 3, [8, 60, 240], 0.1, 0.5, {
      freqTo: 9000,
      glide: 260,
      pan: 0.1,
      panTo: 0.9,
    }),
  );
  for (const [freq, level, pan] of IMPACT_CHORD)
    add(
      tone(impact, 'triangle', freq, [12, 500, 2800], level, 0.55, {
        cutoff: 3400,
        cutoffTo: 1100,
        glide: 3000,
        chorus: true,
        pan,
      }),
    );
  IMPACT_SPARKLE.forEach(([freq, pan], k) =>
    add(tone(impact + 50 * k, 'sine', freq, [6, 60, 1600], 0.09, 0.8, { pan })),
  );

  // ----- the name: one soft key for each letter -----
  for (let i = 0; i < LOGO_WORD_LETTERS; i += 1) {
    if (i === WORD_SPACE) continue;
    const at = name.start + name.duration * (0.38 + (0.5 * i) / (LOGO_WORD_LETTERS + 1.2));
    const pan = -0.25 + (0.5 * i) / (LOGO_WORD_LETTERS - 1);
    add(
      noise(at, 'bandpass', 2600, 3.5, [1, 3, 22], 0.06, 0.25, { pan }),
      tone(at, 'sine', i % 2 === 0 ? FS6 : A6, [1, 2, 40], 0.02, 0.3, { pan }),
    );
  }

  // ----- the card is complete: four notes of the chord, like a glint, over a low D -----
  [A4, D5, FS5, A5].forEach((freq, k) =>
    add(
      tone(hold - 20 + 70 * k, 'sine', freq, [4, 30, 1500], 0.12 - 0.01 * k, 0.75, {
        pan: -0.3 + 0.2 * k,
      }),
    ),
  );
  add(tone(hold - 20, 'sine', D3, [60, 100, 1800], 0.1, 0.4));

  // ----- the wipe: air crossing from left to right -----
  const cross: Envelope = [handoff.duration * 0.38, 60, handoff.duration * 0.4];
  add(
    noise(handoff.start, 'bandpass', 800, 1, cross, 0.07, 0.3, {
      freqTo: 3600,
      glide: handoff.duration * 0.8,
      pan: -0.9,
      panTo: 0.9,
    }),
  );

  return events.sort((a, b) => a.at - b.at);
}

// ---------- when it may play ----------

const SOUND_PREFERENCE_KEY = 'sprint-coder:sound-effects';
/** How loud the film plays with the app's default sound volume (0.2): well below full scale. */
export const LOGO_SOUND_DEFAULT_LEVEL = 0.5;
const DEFAULT_VOLUME = 0.2;

/**
 * How loud the film's sound should be (0..1), or null for silence.
 *   - "効果音" switched off by the user (a stored choice): silent.
 *   - Nothing chosen yet (a first launch — when the film is most often seen): the default level.
 *     The film shows a mute button, since nobody asked for sound.
 *   - Switched on: the user's volume, relative to the default one (and never above full).
 *   - Reduced motion (the still card): silent, like the picture.
 * Reading this never changes the stored choice.
 */
export function logoSoundLevel(variant: LogoIntroVariant): number | null {
  if (variant === 'still') return null;
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(SOUND_PREFERENCE_KEY);
  } catch {
    return null;
  }
  if (stored === null) return LOGO_SOUND_DEFAULT_LEVEL;
  const preferences = readSoundEffectPreferences();
  if (!preferences.enabled) return null;
  return Math.min(1, LOGO_SOUND_DEFAULT_LEVEL * (preferences.volume / DEFAULT_VOLUME));
}

// ---------- from the score to audio nodes ----------

/** A deterministic random sequence: the same noise and the same reverb every time. */
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

/** Scales the whole score so that, at level 1, its loudest moment stays under full scale (the
 * figure comes from rendering it: see `renderLogoSoundOffline`). */
const SCORE_GAIN = 0.355;
const REVERB_SECONDS = 2.6;
const REVERB_RETURN = 0.8;

export type LogoSoundBus = Readonly<{
  /** Where voices go, and where what they send to the reverb goes. */
  input: GainNode;
  reverb: GainNode;
  /** The film's volume: ramp this to fade or mute. */
  master: GainNode;
}>;

/** The mix: voices → master → a limiter (which only acts if something goes wrong) → out; with a
 * generated hall beside it. */
export function createLogoSoundBus(ctx: BaseAudioContext, level: number): LogoSoundBus {
  const master = ctx.createGain();
  master.gain.value = level;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.12;
  master.connect(limiter);
  limiter.connect(ctx.destination);
  const input = ctx.createGain();
  input.gain.value = SCORE_GAIN;
  input.connect(master);
  // The hall: noise dying away, darker as it goes.
  const length = Math.max(1, Math.floor(ctx.sampleRate * REVERB_SECONDS));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    const rnd = random(4111 + channel * 97);
    const predelay = Math.floor(ctx.sampleRate * 0.012);
    let low = 0;
    for (let i = predelay; i < length; i += 1) {
      const t = (i - predelay) / ctx.sampleRate;
      const dry = (rnd() * 2 - 1) * Math.exp(-t / 0.5);
      // A one-pole low-pass that closes with time.
      low += (dry - low) * (0.55 * Math.exp(-t / 0.9) + 0.08);
      data[i] = low;
    }
  }
  const hall = ctx.createConvolver();
  hall.buffer = impulse;
  const reverb = ctx.createGain();
  reverb.gain.value = SCORE_GAIN;
  const back = ctx.createGain();
  back.gain.value = REVERB_RETURN;
  reverb.connect(hall);
  hall.connect(back);
  back.connect(master);
  return { input, reverb, master };
}

/** A note with width: the note itself, and a little of it a few cents flat and sharp — [cents,
 * share]. The side voices are kept small, so the three drift against each other as a slow shimmer
 * and never cancel into a throb. */
const CHORUS: readonly (readonly [number, number])[] = [
  [0, 0.7],
  [-7, 0.16],
  [7, 0.16],
];
const SOLO: readonly (readonly [number, number])[] = [[0, 1]];

/** Two seconds of white noise, shared by every breath of noise in the score. */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rnd = random(9029);
  for (let i = 0; i < length; i += 1) data[i] = rnd() * 2 - 1;
  return buffer;
}

/** Shapes `gain`: silent → `level` over the attack, held, then dying away. Returns when it ends. */
function shape(
  gain: AudioParam,
  at: number,
  event: { attack: number; hold: number; release: number; level: number },
): number {
  const attack = Math.max(0.001, event.attack / 1000);
  const top = at + attack;
  const off = top + event.hold / 1000;
  gain.setValueAtTime(0, Math.max(0, at - 0.001));
  gain.linearRampToValueAtTime(event.level, top);
  gain.setValueAtTime(event.level, off);
  // An exponential tail: inaudible after about five time-constants.
  const tail = Math.max(0.004, event.release / 1000);
  gain.setTargetAtTime(0, off, tail / 4.6);
  return off + tail * 1.6;
}

function place(
  ctx: BaseAudioContext,
  bus: LogoSoundBus,
  from: AudioNode,
  at: number,
  seconds: number,
  event: { pan?: number; panTo?: number; send: number },
): void {
  let out = from;
  if ((event.pan ?? 0) !== 0 || event.panTo !== undefined) {
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(event.pan ?? 0, at);
    if (event.panTo !== undefined) panner.pan.linearRampToValueAtTime(event.panTo, at + seconds);
    from.connect(panner);
    out = panner;
  }
  out.connect(bus.input);
  if (event.send > 0) {
    const send = ctx.createGain();
    send.gain.value = event.send;
    out.connect(send);
    send.connect(bus.reverb);
  }
}

/**
 * Makes the audio nodes for `score` on `ctx`, to sound from `origin` (the context time of the
 * film's first moment). Sounds whose time has already passed are left out, so a late start joins
 * the film where it is. Returns every source it started, so they can be stopped early.
 */
export function scheduleLogoSound(
  ctx: BaseAudioContext,
  bus: LogoSoundBus,
  score: readonly LogoSoundEvent[],
  origin: number,
): AudioScheduledSourceNode[] {
  const sources: AudioScheduledSourceNode[] = [];
  const now = ctx.currentTime;
  let noise: AudioBuffer | null = null;
  for (const event of score) {
    const at = origin + event.at / 1000;
    if (event.kind === 'pad') {
      const last = event.points[event.points.length - 1]!;
      const end = origin + last[0] / 1000;
      if (end <= now) continue;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.5;
      const gain = ctx.createGain();
      // Start from where the bed would be by now.
      let level = event.points[0]![1];
      let cutoff = event.points[0]![2];
      for (let k = 1; k < event.points.length; k += 1) {
        const a = event.points[k - 1]!;
        const b = event.points[k]!;
        const ta = origin + a[0] / 1000;
        const tb = origin + b[0] / 1000;
        if (tb <= now) {
          level = b[1];
          cutoff = b[2];
        } else if (ta < now) {
          const u = (now - ta) / (tb - ta);
          level = a[1] + (b[1] - a[1]) * u;
          cutoff = a[2] + (b[2] - a[2]) * u;
        }
      }
      const begin = Math.max(now, origin + event.points[0]![0] / 1000);
      gain.gain.setValueAtTime(level, begin);
      filter.frequency.setValueAtTime(cutoff, begin);
      for (const [ms, toLevel, toCutoff] of event.points) {
        const t = origin + ms / 1000;
        if (t <= begin) continue;
        gain.gain.linearRampToValueAtTime(toLevel, t);
        filter.frequency.linearRampToValueAtTime(toCutoff, t);
      }
      for (const [freq, weight] of event.notes) {
        const part = ctx.createGain();
        part.gain.value = weight;
        part.connect(filter);
        for (const [cents, share] of CHORUS) {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          osc.detune.value = cents;
          const voice = ctx.createGain();
          voice.gain.value = share;
          osc.connect(voice);
          voice.connect(part);
          osc.start(begin);
          osc.stop(end + 0.05);
          sources.push(osc);
        }
      }
      filter.connect(gain);
      place(ctx, bus, gain, begin, 0, event);
      continue;
    }
    // A short sound that has already begun is left out rather than cut in half-way.
    if (at < now - 0.02) continue;
    const gain = ctx.createGain();
    const end = shape(gain.gain, at, event);
    const glide = (event.glide ?? 0) / 1000;
    if (event.kind === 'tone') {
      let voice: AudioNode = gain;
      if (event.cutoff !== undefined) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 0.7;
        filter.frequency.setValueAtTime(event.cutoff, at);
        if (event.cutoffTo !== undefined && glide > 0)
          filter.frequency.exponentialRampToValueAtTime(event.cutoffTo, at + glide);
        filter.connect(gain);
        voice = filter;
      }
      for (const [cents, share] of event.chorus ? CHORUS : SOLO) {
        const osc = ctx.createOscillator();
        osc.type = event.wave;
        osc.frequency.setValueAtTime(event.freq, at);
        if (event.freqTo !== undefined && glide > 0)
          osc.frequency.exponentialRampToValueAtTime(event.freqTo, at + glide);
        osc.detune.value = cents;
        if (share === 1) osc.connect(voice);
        else {
          const part = ctx.createGain();
          part.gain.value = share;
          osc.connect(part);
          part.connect(voice);
        }
        osc.start(at);
        osc.stop(end);
        sources.push(osc);
      }
    } else {
      noise ??= noiseBuffer(ctx);
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = event.band;
      filter.Q.value = event.q;
      filter.frequency.setValueAtTime(event.freq, at);
      if (event.freqTo !== undefined && glide > 0)
        filter.frequency.exponentialRampToValueAtTime(event.freqTo, at + glide);
      source.connect(filter);
      filter.connect(gain);
      // Each breath starts somewhere else in the noise, so no two are the same.
      source.start(at, (event.at * 0.0137) % 1.7);
      source.stop(end);
      sources.push(source);
    }
    place(ctx, bus, gain, at, Math.max(glide, (event.attack + event.hold) / 1000), event);
  }
  return sources;
}

/** The film's whole sound as a buffer (stereo): the same nodes as the live sound, rendered
 * faster than real time. For checking its level, and for a recording of the film. */
export async function renderLogoSoundOffline(
  variant: LogoIntroVariant,
  level: number = LOGO_SOUND_DEFAULT_LEVEL,
  sampleRate = 48_000,
): Promise<AudioBuffer> {
  const scenes = LOGO_TIMELINES[variant];
  const last = scenes[scenes.length - 1]!;
  // A little past the film's end, for the hall's tail.
  const seconds = (last.start + last.duration) / 1000 + 0.6;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const bus = createLogoSoundBus(ctx, level);
  scheduleLogoSound(ctx, bus, logoSoundScore(variant), 0);
  return ctx.startRendering();
}

// ---------- playing it with the film ----------

/** What the film asks of its sound. */
export type LogoIntroSound = Readonly<{
  /** Called every frame with the film's time (ms): starts the sound, and keeps it with the film. */
  sync(filmMs: number): void;
  /** The film's clock stopped (the window is hidden): no sound until the next `sync`. */
  pause(): void;
  /** Fade out over `ms` (a skip). */
  fade(ms: number): void;
  /** The film is over or gone: silence at once, and nothing left behind. */
  stop(): void;
}>;

/** The sound may run this far ahead of the film before it is held back, and is let go again once
 * the film has caught up to within the second figure (ms). */
const HOLD_AHEAD_MS = 90;
const RELEASE_AHEAD_MS = 20;
/** A sound that cannot start within this much of the film's beginning stays silent: joining a
 * rising passage half-way would only be noise. */
const LATE_START_MS = 400;
const MUTE_FADE_MS = 220;
/** About how long a drawn frame takes to be seen, and the most the sound is ever brought forward. */
const PICTURE_LATENCY_S = 0.02;
const MAX_LEAD_S = 0.12;

export class LogoSoundPlayer implements LogoIntroSound {
  private readonly variant: LogoIntroVariant;
  private readonly level: number;
  private readonly create: () => AudioContext;
  private ctx: AudioContext | null = null;
  private bus: LogoSoundBus | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  /** The context time of the film's first moment, once the sound is scheduled. */
  private origin: number | null = null;
  /** How much earlier than the picture the sound is scheduled (s), to make up for its latency. */
  private lead = 0;
  private held = false;
  private paused = false;
  private muted = false;
  private stopped = false;
  private failed = false;

  constructor(options: {
    variant: LogoIntroVariant;
    level: number;
    /** For tests: how the audio context is made. */
    createContext?: () => AudioContext;
  }) {
    this.variant = options.variant;
    this.level = options.level;
    this.create = options.createContext ?? (() => new AudioContext());
  }

  /** True while there is (or may yet be) something to hear: for showing the mute button. */
  get audible(): boolean {
    return !this.muted && !this.stopped && !this.failed;
  }

  sync(filmMs: number): void {
    if (this.stopped || this.failed) return;
    try {
      if (this.ctx === null) this.ctx = this.create();
      const ctx = this.ctx;
      if (this.paused) {
        this.paused = false;
        if (!this.held) void ctx.resume().catch(() => undefined);
      }
      if (this.origin === null) {
        // Not allowed to sound yet (no user gesture where one is required): ask, and wait.
        if (ctx.state !== 'running') {
          if (filmMs > LATE_START_MS) this.failed = true;
          else void ctx.resume().catch(() => undefined);
          if (this.failed) this.release();
          return;
        }
        if (filmMs > LATE_START_MS) {
          this.failed = true;
          this.release();
          return;
        }
        // Sound takes a moment to reach the ear (the device's output latency) — longer than a
        // frame takes to reach the eye. It is scheduled that much early, so the impact is heard
        // when it is seen.
        const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
        this.lead = Math.max(0, Math.min(MAX_LEAD_S, latency - PICTURE_LATENCY_S));
        this.origin = ctx.currentTime - filmMs / 1000 - this.lead;
        this.bus = createLogoSoundBus(ctx, this.muted ? 0 : this.level);
        this.sources = scheduleLogoSound(ctx, this.bus, logoSoundScore(this.variant), this.origin);
        return;
      }
      // The film can only fall behind the sound (a stall, or its wait for the logo): hold the
      // sound until the film has caught up.
      const ahead = (ctx.currentTime - this.origin - this.lead) * 1000 - filmMs;
      if (!this.held && ahead > HOLD_AHEAD_MS) {
        this.held = true;
        void ctx.suspend().catch(() => undefined);
      } else if (this.held && ahead <= RELEASE_AHEAD_MS) {
        this.held = false;
        void ctx.resume().catch(() => undefined);
      }
    } catch {
      // Sound is an extra: a failure leaves the film silent, never stuck.
      this.failed = true;
      this.release();
    }
  }

  pause(): void {
    if (this.stopped || this.ctx === null || this.paused) return;
    this.paused = true;
    void this.ctx.suspend().catch(() => undefined);
  }

  /** Silence for the rest of this film (the mute button): a short fade, not a cut. */
  mute(): void {
    if (this.muted) return;
    this.muted = true;
    this.fade(MUTE_FADE_MS);
  }

  fade(ms: number): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (this.stopped || ctx === null || bus === null) return;
    try {
      const now = ctx.currentTime;
      bus.master.gain.cancelScheduledValues(now);
      bus.master.gain.setValueAtTime(bus.master.gain.value, now);
      bus.master.gain.linearRampToValueAtTime(0, now + Math.max(0.01, ms / 1000));
    } catch {
      // Already closing.
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.release();
  }

  private release(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Not started yet, or already over.
      }
    }
    this.sources = [];
    this.bus = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx !== null && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }
}
