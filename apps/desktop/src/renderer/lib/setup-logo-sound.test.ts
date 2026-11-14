// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLogoSoundBus,
  LOGO_SOUND_DEFAULT_LEVEL,
  LOGO_WORD_LETTERS,
  LogoSoundPlayer,
  logoSoundLevel,
  logoSoundScore,
  scheduleLogoSound,
  type LogoPad,
  type LogoSoundEvent,
  type LogoTone,
} from './setup-logo-sound';
import {
  letterProgress,
  LOGO_TIMELINES,
  logoIntroDuration,
  logoIntroFrame,
  runnerCountAt,
  type LogoIntroVariant,
  type LogoSceneId,
} from './setup-logo-timeline';

const SOUND_KEY = 'sprint-coder:sound-effects';
const scene = (variant: LogoIntroVariant, id: LogoSceneId) =>
  LOGO_TIMELINES[variant].find((each) => each.id === id)!;
const tones = (score: readonly LogoSoundEvent[]) =>
  score.filter((event): event is LogoTone => event.kind === 'tone');
const pad = (score: readonly LogoSoundEvent[]) =>
  score.find((event): event is LogoPad => event.kind === 'pad')!;
/** The bed's level at `ms` (its points joined by straight lines). */
function bedLevel(bed: LogoPad, ms: number): number {
  for (let k = 1; k < bed.points.length; k += 1) {
    const a = bed.points[k - 1]!;
    const b = bed.points[k]!;
    if (ms <= b[0]) return a[1] + ((b[1] - a[1]) * (ms - a[0])) / (b[0] - a[0]);
  }
  return bed.points.at(-1)![1];
}

// ---------- a stand-in audio context ----------

type Call = readonly [string, ...number[]];
function param(value = 0) {
  const calls: Call[] = [];
  return {
    value,
    calls,
    setValueAtTime(v: number, t: number) {
      calls.push(['set', v, t]);
      this.value = v;
    },
    linearRampToValueAtTime(v: number, t: number) {
      calls.push(['ramp', v, t]);
    },
    exponentialRampToValueAtTime(v: number, t: number) {
      calls.push(['exp', v, t]);
    },
    setTargetAtTime(v: number, t: number, c: number) {
      calls.push(['target', v, t, c]);
    },
    cancelScheduledValues(t: number) {
      calls.push(['cancel', t]);
    },
  };
}
type FakeSource = { kind: string; started: number | null; stopped: number | null };

class FakeContext {
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  sampleRate = 8000; // small buffers: the fake makes no sound
  destination = {};
  baseLatency = 0;
  outputLatency = 0;
  sources: FakeSource[] = [];
  gains: ReturnType<typeof param>[] = [];
  suspends = 0;
  resumes = 0;
  closes = 0;
  private node<T extends object>(extra: T) {
    return { connect: vi.fn(), disconnect: vi.fn(), ...extra };
  }
  private source(kind: string) {
    const record: FakeSource = { kind, started: null, stopped: null };
    this.sources.push(record);
    return {
      start: (t = 0) => {
        record.started = t;
      },
      stop: (t = this.currentTime) => {
        record.stopped = t;
      },
    };
  }
  createGain() {
    const gain = param(1);
    this.gains.push(gain);
    return this.node({ gain });
  }
  createOscillator() {
    return this.node({
      type: 'sine',
      frequency: param(440),
      detune: param(0),
      ...this.source('osc'),
    });
  }
  createBufferSource() {
    return this.node({ buffer: null, loop: false, ...this.source('noise') });
  }
  createBiquadFilter() {
    return this.node({ type: 'lowpass', frequency: param(350), Q: param(1) });
  }
  createStereoPanner() {
    return this.node({ pan: param(0) });
  }
  createConvolver() {
    return this.node({ buffer: null });
  }
  createDynamicsCompressor() {
    return this.node({
      threshold: param(-24),
      knee: param(30),
      ratio: param(12),
      attack: param(0.003),
      release: param(0.25),
    });
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  suspend() {
    this.suspends += 1;
    this.state = 'suspended';
    return Promise.resolve();
  }
  resume() {
    this.resumes += 1;
    if (this.allowed) this.state = 'running';
    return Promise.resolve();
  }
  close() {
    this.closes += 1;
    this.state = 'closed';
    return Promise.resolve();
  }
  /** False: like a page that may not play sound before a user gesture. */
  allowed = true;
}
const asContext = (fake: FakeContext) => fake as unknown as AudioContext;

function player(variant: LogoIntroVariant = 'full', level = 0.5, fake = new FakeContext()) {
  const create = vi.fn(() => asContext(fake));
  return { sound: new LogoSoundPlayer({ variant, level, createContext: create }), fake, create };
}
/** The film's volume control: the first gain made (see createLogoSoundBus). */
const master = (fake: FakeContext) => fake.gains[0]!;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('the score: what sounds when', () => {
  it('the still card has no sound; the other films do, and the same every time', () => {
    expect(logoSoundScore('still')).toEqual([]);
    for (const variant of ['full', 'short'] as const) {
      const score = logoSoundScore(variant);
      expect(score.length).toBeGreaterThan(30);
      expect(logoSoundScore(variant)).toEqual(score);
    }
  });

  it('is in time order, starts nothing after the film ends, and keeps every figure in range', () => {
    for (const variant of ['full', 'short'] as const) {
      const score = logoSoundScore(variant);
      const total = logoIntroDuration(variant);
      let last = -1;
      for (const event of score) {
        expect(event.at).toBeGreaterThanOrEqual(last);
        last = event.at;
        expect(event.at).toBeGreaterThanOrEqual(0);
        expect(event.at).toBeLessThan(total);
        expect(event.send).toBeGreaterThanOrEqual(0);
        expect(event.send).toBeLessThanOrEqual(1);
        if (event.kind === 'pad') continue;
        expect(event.level).toBeGreaterThan(0);
        expect(event.level).toBeLessThanOrEqual(0.6);
        expect(event.freq).toBeGreaterThan(40);
        expect(event.freq).toBeLessThan(12_000);
        for (const pan of [event.pan ?? 0, event.panTo ?? 0]) {
          expect(pan).toBeGreaterThanOrEqual(-1);
          expect(pan).toBeLessThanOrEqual(1);
        }
        // Nothing is still being struck when the film is over (tails may ring a little past it).
        expect(event.at + event.attack + event.hold).toBeLessThanOrEqual(total + 1);
      }
    }
  });

  it('the bed is silent at both ends, swells with the race, and drops away when time stops', () => {
    const bed = pad(logoSoundScore('full'));
    expect(bed.points[0]![1]).toBe(0);
    expect(bed.points.at(-1)![1]).toBe(0);
    expect(bed.points.at(-1)![0]).toBeLessThanOrEqual(logoIntroDuration('full'));
    for (let k = 1; k < bed.points.length; k += 1)
      expect(bed.points[k]![0]).toBeGreaterThan(bed.points[k - 1]![0]);
    const brake = scene('full', 'brake').start;
    const run = scene('full', 'run').start;
    // Quiet under the waiting cursor; several times louder by the end of the race.
    expect(bedLevel(bed, run - 100)).toBeLessThan(0.1);
    expect(bedLevel(bed, brake - 60)).toBeGreaterThan(2 * bedLevel(bed, run - 100));
    // The hush: within a fifth of a second of the brake it is under half of what it was.
    expect(bedLevel(bed, brake + 200)).toBeLessThan(0.5 * bedLevel(bed, brake - 60));
    // Then it climbs again into the impact, its loudest moment, and dies away after it.
    const impact = scene('full', 'impact').start;
    const loudest = Math.max(...bed.points.map((point) => point[1]));
    expect(bedLevel(bed, impact - 20)).toBe(loudest);
    expect(bedLevel(bed, impact + 3000)).toBeLessThan(0.5 * loudest);
  });

  it('the counter is heard: notes closer and closer together, and an accent as it reaches 100', () => {
    const score = logoSoundScore('full');
    const run = scene('full', 'run');
    const brake = scene('full', 'brake').start;
    // The accent: two notes together at the moment the counter shows 100.
    const accents = tones(score).filter(
      (event) => event.release === 700 && event.at > run.start && event.at < brake,
    );
    expect(accents).toHaveLength(2);
    const full = accents[0]!.at;
    expect(accents[1]!.at).toBe(full);
    expect(runnerCountAt(full)).toBe(100);
    expect(runnerCountAt(full - 150)).toBeLessThan(100);
    // The ticks before it.
    const ticks = tones(score).filter(
      (event) => event.release === 110 && event.hold === 6 && event.at < full,
    );
    expect(ticks).toHaveLength(14);
    expect(ticks[0]!.at).toBeGreaterThan(run.start + 200);
    const gaps = ticks.slice(1).map((tick, k) => tick.at - ticks[k]!.at);
    for (let k = 1; k < gaps.length; k += 1) expect(gaps[k]!).toBeLessThan(gaps[k - 1]!);
    expect(gaps.at(-1)!).toBeGreaterThan(40);
    // Louder as they come, and moving to the right like the runners.
    expect(ticks.at(-1)!.level).toBeGreaterThan(ticks[0]!.level);
    expect(ticks.at(-1)!.pan!).toBeGreaterThan(ticks[0]!.pan!);
  });

  it('each of the logo’s three nodes lights with a note, rising, exactly as the picture lights it', () => {
    for (const variant of ['full', 'short'] as const) {
      const rush = scene(variant, 'rush');
      const notes = tones(logoSoundScore(variant)).filter(
        (event) => event.wave === 'triangle' && event.release === 650,
      );
      expect(notes).toHaveLength(3);
      notes.forEach((event, k) => {
        expect(event.at).toBeCloseTo(rush.start + rush.duration * (0.5 + 0.085 * k), 6);
        // The picture: that node is dark just before, and lighting just after.
        expect(logoIntroFrame(variant, event.at - 1).nodes[k]).toBe(0);
        expect(logoIntroFrame(variant, event.at + 30).nodes[k]).toBeGreaterThan(0);
        if (k > 0) expect(event.freq).toBeGreaterThan(notes[k - 1]!.freq);
      });
      // D, F sharp, A: the chord that the impact then plays in full.
      expect(notes[1]!.freq / notes[0]!.freq).toBeCloseTo(2 ** (4 / 12), 5);
      expect(notes[2]!.freq / notes[0]!.freq).toBeCloseTo(2 ** (7 / 12), 5);
    }
  });

  it('the impact is one moment: the thump, the chord and the air all start with the flash', () => {
    for (const variant of ['full', 'short'] as const) {
      const impact = scene(variant, 'impact').start;
      const score = logoSoundScore(variant);
      const struck = score.filter((event) => event.at === impact);
      // The chord (six voices that ring for seconds), a low thump, and two breaths of noise.
      const chord = tones(struck).filter((event) => event.release === 2800);
      expect(chord).toHaveLength(6);
      expect(chord.every((event) => event.chorus === true)).toBe(true);
      expect(tones(struck).some((event) => event.freq < 120 && event.level >= 0.3)).toBe(true);
      expect(struck.filter((event) => event.kind === 'noise').length).toBeGreaterThanOrEqual(2);
      expect(logoIntroFrame(variant, impact + 30).flash).toBeGreaterThan(0.8);
      // It is the loudest thing in the score.
      const loudest = Math.max(...tones(score).map((event) => event.level));
      expect(tones(struck).some((event) => event.level === loudest)).toBe(true);
      // Nothing else is struck in the half second after it, so it rings alone.
      const after = score.filter(
        (event) => event.kind !== 'pad' && event.at > impact + 120 && event.at < impact + 620,
      );
      expect(after).toEqual([]);
    }
  });

  it('each letter of the name has a soft key tick as it lands (none for the space)', () => {
    for (const variant of ['full', 'short'] as const) {
      const name = scene(variant, 'name');
      const ticks = logoSoundScore(variant).filter(
        (event) => event.kind === 'noise' && event.release === 22 && event.at >= name.start,
      );
      expect(ticks).toHaveLength(LOGO_WORD_LETTERS - 1);
      const letters = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11];
      ticks.forEach((tick, k) => {
        const i = letters[k]!;
        const typeAt = (ms: number) => logoIntroFrame(variant, ms).type;
        expect(letterProgress(typeAt(tick.at - 1), i, LOGO_WORD_LETTERS)).toBe(0);
        expect(letterProgress(typeAt(tick.at + 20), i, LOGO_WORD_LETTERS)).toBeGreaterThan(0);
        // Far softer than the impact.
        expect(tick.kind !== 'pad' && tick.level).toBeLessThan(0.1);
      });
    }
  });

  it('the short film has the gathering, the impact, the name and the wipe — and no race', () => {
    const score = logoSoundScore('short');
    expect(score[0]!.at).toBe(0);
    // No counter ticks, no cursor.
    expect(tones(score).filter((event) => event.release === 110 && event.hold === 6)).toEqual([]);
    const wipe = score.filter(
      (event) => event.kind === 'noise' && event.at === scene('short', 'handoff').start,
    );
    expect(wipe).toHaveLength(1);
    // The wipe crosses from left to right, like the picture's.
    expect(wipe[0]!.kind === 'noise' && wipe[0]!.pan).toBeLessThan(0);
    expect(wipe[0]!.kind === 'noise' && wipe[0]!.panTo).toBeGreaterThan(0);
    expect(score.length).toBeLessThan(logoSoundScore('full').length);
  });
});

describe('when the film’s sound may play', () => {
  const stored = (value: unknown) => localStorage.setItem(SOUND_KEY, JSON.stringify(value));

  it('nothing chosen yet (a first launch): the default, modest level', () => {
    expect(logoSoundLevel('full')).toBe(LOGO_SOUND_DEFAULT_LEVEL);
    expect(logoSoundLevel('short')).toBe(LOGO_SOUND_DEFAULT_LEVEL);
    expect(LOGO_SOUND_DEFAULT_LEVEL).toBeLessThanOrEqual(0.5);
  });

  it('sound effects switched off by the user: silent', () => {
    stored({ enabled: false, volume: 0.5 });
    expect(logoSoundLevel('full')).toBeNull();
    expect(logoSoundLevel('short')).toBeNull();
  });

  it('switched on: the user’s volume, relative to the default one, never above full', () => {
    stored({ enabled: true, volume: 0.2 });
    expect(logoSoundLevel('full')).toBe(LOGO_SOUND_DEFAULT_LEVEL);
    stored({ enabled: true, volume: 0.1 });
    expect(logoSoundLevel('full')).toBeCloseTo(LOGO_SOUND_DEFAULT_LEVEL / 2, 6);
    stored({ enabled: true, volume: 0.5 });
    expect(logoSoundLevel('full')).toBe(1);
  });

  it('reduced motion (the still card): silent, whatever is stored', () => {
    expect(logoSoundLevel('still')).toBeNull();
    stored({ enabled: true, volume: 0.5 });
    expect(logoSoundLevel('still')).toBeNull();
  });

  it('a stored choice that cannot be read counts as off; so does storage that fails', () => {
    localStorage.setItem(SOUND_KEY, 'not json');
    expect(logoSoundLevel('full')).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(logoSoundLevel('full')).toBeNull();
  });

  it('never changes the stored choice', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    logoSoundLevel('full');
    logoSoundLevel('short');
    logoSoundLevel('still');
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(SOUND_KEY)).toBeNull();
  });
});

describe('from the score to audio nodes', () => {
  it('starts one source per voice at its time, with the master at the level asked for', () => {
    const fake = new FakeContext();
    const bus = createLogoSoundBus(asContext(fake), 0.4);
    expect(bus.master.gain.value).toBe(0.4);
    const score = logoSoundScore('full');
    const sources = scheduleLogoSound(asContext(fake), bus, score, 2);
    expect(sources.length).toBe(fake.sources.length);
    expect(sources.length).toBeGreaterThan(score.length);
    for (const source of fake.sources) {
      expect(source.started).not.toBeNull();
      expect(source.started!).toBeGreaterThanOrEqual(2);
      // Every source is told when to stop: none is left running after the film.
      expect(source.stopped).not.toBeNull();
      expect(source.stopped!).toBeGreaterThan(source.started!);
      expect(source.stopped!).toBeLessThan(2 + logoIntroDuration('full') / 1000 + 6);
    }
    // The first sound (the cursor's pip) is at its film time after the origin.
    const first = Math.min(...fake.sources.map((source) => source.started!));
    expect(first).toBeCloseTo(2 + score[0]!.at / 1000, 3);
  });

  it('joining late leaves out what has already sounded, and picks the bed up where it is', () => {
    const fake = new FakeContext();
    fake.currentTime = 10;
    const bus = createLogoSoundBus(asContext(fake), 0.5);
    // The film began 5 s ago.
    scheduleLogoSound(asContext(fake), bus, logoSoundScore('full'), 5);
    for (const source of fake.sources) expect(source.started!).toBeGreaterThanOrEqual(10 - 0.02);
    const all = new FakeContext();
    scheduleLogoSound(
      asContext(all),
      createLogoSoundBus(asContext(all), 0.5),
      logoSoundScore('full'),
      0,
    );
    expect(fake.sources.length).toBeLessThan(all.sources.length);
    // The bed's oscillators (three notes, three voices each) are among them, starting now.
    expect(
      fake.sources.filter((source) => source.kind === 'osc' && source.started === 10),
    ).toHaveLength(9);
  });
});

describe('LogoSoundPlayer (the sound with the film)', () => {
  it('makes nothing until the film’s first frame; then schedules the whole score once', () => {
    const { sound, fake, create } = player('full', 0.5);
    expect(create).not.toHaveBeenCalled();
    expect(sound.audible).toBe(true);
    sound.sync(0);
    expect(create).toHaveBeenCalledTimes(1);
    const started = fake.sources.length;
    expect(started).toBeGreaterThan(100);
    expect(master(fake).value).toBe(0.5);
    fake.currentTime = 0.5;
    sound.sync(500);
    sound.sync(516);
    expect(fake.sources.length).toBe(started);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('schedules the sound early by the device’s latency, so it is heard when it is seen', () => {
    const first = (fake: FakeContext) => Math.min(...fake.sources.map((source) => source.started!));
    const plain = player();
    plain.fake.currentTime = 1;
    plain.sound.sync(0);
    // No latency reported: the cursor's first pip (130 ms into the film) is at 1.13 s.
    expect(first(plain.fake)).toBeCloseTo(1.13, 3);
    // 10 ms + 60 ms to the ear, about 20 ms to the eye: 50 ms early.
    const late = player();
    late.fake.currentTime = 1;
    late.fake.baseLatency = 0.01;
    late.fake.outputLatency = 0.06;
    late.sound.sync(0);
    expect(first(late.fake)).toBeCloseTo(1.08, 3);
    // In step with the film: neither held nor let go, as time passes at the same pace.
    late.fake.currentTime = 2;
    late.sound.sync(1000);
    expect(late.fake.suspends).toBe(0);
    // An absurd latency is not followed all the way.
    const absurd = player();
    absurd.fake.currentTime = 1;
    absurd.fake.outputLatency = 2;
    absurd.sound.sync(0);
    expect(first(absurd.fake)).toBeGreaterThan(1);
  });

  it('holds the sound back when it runs ahead of the film, and lets it go when the film catches up', () => {
    const { sound, fake } = player();
    sound.sync(0);
    // The film waits (for its logo) at 1150 ms while a second passes.
    fake.currentTime = 1.2;
    sound.sync(1150);
    expect(fake.suspends).toBe(0);
    fake.currentTime = 1.4;
    sound.sync(1150);
    expect(fake.suspends).toBe(1);
    expect(fake.state).toBe('suspended');
    // Held: asking again does not suspend again.
    sound.sync(1150);
    expect(fake.suspends).toBe(1);
    // (While suspended the audio clock stands still.) The film catches up.
    sound.sync(1300);
    expect(fake.resumes).toBe(0);
    sound.sync(1385);
    expect(fake.resumes).toBe(1);
    expect(fake.state).toBe('running');
    // In step again: nothing more happens.
    fake.currentTime = 1.5;
    sound.sync(1460);
    expect(fake.suspends).toBe(1);
    expect(fake.resumes).toBe(1);
  });

  it('pauses with the film (the window hidden) and goes on at its next frame', () => {
    const { sound, fake } = player();
    sound.sync(0);
    fake.currentTime = 2;
    sound.sync(2000);
    sound.pause();
    sound.pause();
    expect(fake.suspends).toBe(1);
    sound.sync(2016);
    expect(fake.resumes).toBe(1);
    // A pause before the sound ever started does nothing.
    const fresh = player();
    fresh.sound.pause();
    expect(fresh.create).not.toHaveBeenCalled();
  });

  it('mute: a short fade to silence, and it stays silent', () => {
    const { sound, fake } = player('full', 0.5);
    sound.sync(0);
    fake.currentTime = 3;
    sound.sync(3000);
    sound.mute();
    expect(sound.audible).toBe(false);
    const ramp = master(fake)
      .calls.filter((call) => call[0] === 'ramp')
      .at(-1)!;
    expect(ramp[1]).toBe(0);
    expect(ramp[2]! - 3).toBeGreaterThan(0.1);
    expect(ramp[2]! - 3).toBeLessThanOrEqual(0.3);
    // Muting twice, or fading later (a skip), raises nothing.
    const before = master(fake).calls.length;
    sound.mute();
    expect(master(fake).calls.length).toBe(before);
    sound.fade(420);
    for (const call of master(fake).calls.filter((each) => each[0] === 'ramp'))
      expect(call[1]).toBe(0);
    // The film goes on; the context is kept until the film stops it.
    expect(fake.closes).toBe(0);
  });

  it('muted before the sound has started: it starts silent', () => {
    const { sound, fake } = player('full', 0.5);
    sound.mute();
    sound.sync(0);
    expect(master(fake).value).toBe(0);
  });

  it('a skip fades it out over the skip’s length', () => {
    const { sound, fake } = player('short', 0.8);
    sound.sync(0);
    fake.currentTime = 1;
    sound.fade(420);
    const calls = master(fake).calls;
    expect(calls.at(-3)).toEqual(['cancel', 1]);
    expect(calls.at(-2)).toEqual(['set', 0.8, 1]);
    expect(calls.at(-1)).toEqual(['ramp', 0, 1.42]);
  });

  it('stop: every source is stopped, the context is closed, and nothing can start it again', () => {
    const { sound, fake, create } = player();
    sound.sync(0);
    fake.currentTime = 4;
    sound.stop();
    expect(fake.closes).toBe(1);
    expect(fake.state).toBe('closed');
    for (const source of fake.sources) expect(source.stopped).not.toBeNull();
    expect(sound.audible).toBe(false);
    sound.sync(4016);
    sound.pause();
    sound.fade(100);
    sound.mute();
    sound.stop();
    expect(create).toHaveBeenCalledTimes(1);
    expect(fake.closes).toBe(1);
    // Stopped before it ever started: nothing was made.
    const never = player();
    never.sound.stop();
    never.sound.sync(0);
    expect(never.create).not.toHaveBeenCalled();
  });

  it('where sound may not start without a user gesture: it asks, joins if allowed at once, else stays silent', () => {
    // Allowed a moment later (within the film's first moments): it starts, in step.
    const soon = player();
    soon.fake.state = 'suspended';
    soon.fake.allowed = false;
    soon.sound.sync(0);
    expect(soon.fake.resumes).toBe(1);
    expect(soon.fake.sources).toHaveLength(0);
    soon.fake.allowed = true;
    soon.sound.sync(100);
    expect(soon.fake.state).toBe('running');
    soon.sound.sync(116);
    expect(soon.fake.sources.length).toBeGreaterThan(100);
    // Never allowed: the film plays silent, and the context is not kept.
    const never = player();
    never.fake.state = 'suspended';
    never.fake.allowed = false;
    never.sound.sync(0);
    never.sound.sync(300);
    expect(never.sound.audible).toBe(true);
    never.sound.sync(450);
    expect(never.sound.audible).toBe(false);
    expect(never.fake.closes).toBe(1);
    expect(never.fake.sources).toHaveLength(0);
    never.sound.sync(5000);
    expect(never.create).toHaveBeenCalledTimes(1);
  });

  it('a failure to make sound leaves the film silent, never broken', () => {
    const sound = new LogoSoundPlayer({
      variant: 'full',
      level: 0.5,
      createContext: () => {
        throw new Error('no audio device');
      },
    });
    expect(() => sound.sync(0)).not.toThrow();
    expect(sound.audible).toBe(false);
    expect(() => {
      sound.sync(16);
      sound.pause();
      sound.fade(100);
      sound.mute();
      sound.stop();
    }).not.toThrow();
  });
});
