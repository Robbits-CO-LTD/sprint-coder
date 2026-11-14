import { describe, expect, it } from 'vitest';
import {
  chooseLogoIntro,
  createLogoFrame,
  letterProgress,
  LOGO_RUNNERS,
  LOGO_SKIP_MS,
  LOGO_TIMELINES,
  logoHandoffAt,
  logoIntroDuration,
  logoIntroFrame,
  logoIntroFrameInto,
  logoReadyGateAt,
  RUN_CLOCK_END,
  runClockAt,
  runnerCountAt,
  runnerJoinAt,
  runRateAt,
  rushProgress,
  type LogoIntroVariant,
  type LogoSceneId,
} from './setup-logo-timeline';

const VARIANTS: readonly LogoIntroVariant[] = ['full', 'short', 'still'];
const startOf = (variant: LogoIntroVariant, id: LogoSceneId): number =>
  LOGO_TIMELINES[variant].find((scene) => scene.id === id)!.start;
/** Every 10 ms of a film, as frames. */
const sweep = (variant: LogoIntroVariant, skipAt: number | null = null) => {
  const frames = [];
  for (let time = 0; time <= logoIntroDuration(variant) + 20; time += 10)
    frames.push(logoIntroFrame(variant, time, skipAt));
  return frames;
};

describe('the logo film: its length and scenes', () => {
  it('the full film is ten seconds, the short one about three, the still one under two', () => {
    expect(logoIntroDuration('full')).toBe(10_000);
    expect(logoIntroDuration('short')).toBeGreaterThanOrEqual(3000);
    expect(logoIntroDuration('short')).toBeLessThanOrEqual(3600);
    expect(logoIntroDuration('still')).toBeLessThanOrEqual(1800);
    // The still card itself (apart from fading in and out) is up for about a second.
    expect(LOGO_TIMELINES.still.find((scene) => scene.id === 'hold')!.duration).toBe(1000);
  });

  it('scenes follow one another with no gap, in the story’s order', () => {
    expect(LOGO_TIMELINES.full.map((scene) => scene.id)).toEqual([
      'spark',
      'run',
      'brake',
      'rush',
      'flow',
      'impact',
      'name',
      'hold',
      'handoff',
    ]);
    expect(LOGO_TIMELINES.short.map((scene) => scene.id)).toEqual([
      'rush',
      'flow',
      'impact',
      'name',
      'hold',
      'handoff',
    ]);
    for (const variant of VARIANTS) {
      let at = 0;
      for (const scene of LOGO_TIMELINES[variant]) {
        expect(scene.start).toBe(at);
        expect(scene.duration).toBeGreaterThan(0);
        at += scene.duration;
      }
      expect(at).toBe(logoIntroDuration(variant));
      // Every film ends by handing over to the Setup.
      expect(LOGO_TIMELINES[variant].at(-1)!.id).toBe('handoff');
      expect(logoHandoffAt(variant)).toBe(startOf(variant, 'handoff'));
    }
  });

  it('reports the scene and the progress through it', () => {
    expect(logoIntroFrame('full', 0).scene).toBe('spark');
    expect(logoIntroFrame('full', startOf('full', 'run')).scene).toBe('run');
    expect(logoIntroFrame('full', startOf('full', 'impact') + 400)).toMatchObject({
      scene: 'impact',
      progress: 0.5,
    });
    expect(logoIntroFrame('full', 99_999)).toMatchObject({ scene: 'handoff', progress: 1 });
    expect(logoIntroFrame('full', -50)).toMatchObject({ scene: 'spark', progress: 0 });
  });

  it('waits for the logo only where nothing needs it yet', () => {
    // The full film can show its waiting cursor without the logo; the others need it at once.
    expect(logoReadyGateAt('full')).toBe(startOf('full', 'run'));
    expect(logoReadyGateAt('short')).toBe(0);
    expect(logoReadyGateAt('still')).toBe(0);
  });
});

describe('which film plays', () => {
  it('the full film until it has been seen, the short one after; with reduced motion the still card, then nothing', () => {
    expect(chooseLogoIntro({ animate: true, seen: false })).toBe('full');
    expect(chooseLogoIntro({ animate: true, seen: true })).toBe('short');
    expect(chooseLogoIntro({ animate: false, seen: false })).toBe('still');
    expect(chooseLogoIntro({ animate: false, seen: true })).toBeNull();
  });

  it('does not depend on which form the Setup takes: only on whether the film was seen', () => {
    // (The Setup's form — first run, or over the app — is not even asked for.)
    expect(chooseLogoIntro.length).toBe(1);
    const asked = Object.keys({ animate: true, seen: false } satisfies Parameters<
      typeof chooseLogoIntro
    >[0]);
    expect(asked).toEqual(['animate', 'seen']);
  });
});

describe('the full film, moment by moment', () => {
  const frames = sweep('full');
  const at = (time: number) => logoIntroFrame('full', time);

  it('opens on a cursor that blinks, then gathers itself, and nothing else', () => {
    expect(at(0).caret).toBe(0);
    expect(at(400).caret).toBe(1);
    expect(at(660).caret).toBe(0); // the blink
    expect(at(900).caret).toBe(1);
    expect(at(600).charge).toBe(0);
    expect(at(1100).charge).toBeGreaterThan(0.5);
    const waiting = at(900);
    expect(waiting).toMatchObject({ count: 0, counter: 0, lanes: 0, beam: 0, glyph: false });
    expect(waiting.runRate).toBe(0);
    // Once it runs, the cursor is gone and its dash is on.
    const off = at(startOf('full', 'run') + 100);
    expect(off.caret).toBe(0);
    expect(off.dash).toBeGreaterThan(0);
    expect(at(startOf('full', 'run') + 450).dash).toBe(-1);
  });

  it('the counter runs from 1 to 100 and never goes back', () => {
    expect(runnerCountAt(startOf('full', 'run') - 1)).toBe(0);
    expect(runnerCountAt(startOf('full', 'run'))).toBe(1);
    let last = 0;
    for (const frame of frames) {
      expect(frame.count).toBeGreaterThanOrEqual(last);
      last = frame.count;
    }
    expect(at(startOf('full', 'brake')).count).toBe(LOGO_RUNNERS);
    // It reaches 100 with a good part of the race still to run (the flood at full speed).
    expect(at(startOf('full', 'run') + 0.8 * 2450).count).toBe(LOGO_RUNNERS);
  });

  it('runners set off one, then a few, then a flood — all of them within the run', () => {
    expect(runnerJoinAt(0)).toBe(startOf('full', 'run'));
    let last = runnerJoinAt(0);
    for (let i = 1; i < LOGO_RUNNERS; i += 1) {
      const join = runnerJoinAt(i);
      expect(join).toBeGreaterThan(last);
      last = join;
    }
    expect(last).toBeLessThan(startOf('full', 'brake') - 800);
    // Half of them set off in the last fifth of that stretch.
    const span = last - runnerJoinAt(1);
    expect(runnerJoinAt(50) - runnerJoinAt(1)).toBeGreaterThan(span * 0.8);
  });

  it('the race speeds up all the way, then time stops', () => {
    const run = startOf('full', 'run');
    const brake = startOf('full', 'brake');
    expect(runRateAt(run - 1)).toBe(0);
    for (let time = run + 50; time <= brake; time += 50)
      expect(runRateAt(time)).toBeGreaterThan(runRateAt(time - 50));
    // The brake: slower and slower, to a full stop before the line-up ends.
    for (let time = brake + 50; time <= brake + 400; time += 50)
      expect(runRateAt(time)).toBeLessThan(runRateAt(time - 50));
    expect(runRateAt(brake + 600)).toBe(0);
    // The runners' clock only ever goes forwards, smoothly, and ends where it stopped.
    let last = -1;
    for (let time = 0; time <= 10_000; time += 10) {
      const clock = runClockAt(time);
      expect(clock).toBeGreaterThanOrEqual(last);
      expect(clock - Math.max(0, last)).toBeLessThan(0.03);
      last = clock;
    }
    expect(runClockAt(brake + 600)).toBe(RUN_CLOCK_END);
    expect(at(9000).runClock).toBe(RUN_CLOCK_END);
  });

  it('they hang where they stopped, line up, draw back, and go', () => {
    const brake = startOf('full', 'brake');
    expect(at(brake + 200).stage).toBe(0);
    expect(at(brake + 600).stage).toBeGreaterThan(0);
    expect(at(brake + 600).stage).toBeLessThan(1);
    expect(at(brake + 900).stage).toBe(1);
    expect(at(brake + 700).pull).toBe(0);
    expect(at(startOf('full', 'rush') - 1).pull).toBeGreaterThan(0.9);
    expect(at(startOf('full', 'rush') + 200).pull).toBe(0);
    for (const frame of frames) {
      expect(frame.stage).toBeGreaterThanOrEqual(0);
      expect(frame.stage).toBeLessThanOrEqual(1);
    }
    // The runners are there until the light is in the logo; the counter leaves as they pour in.
    expect(at(startOf('full', 'flow') - 1).runners).toBe(1);
    expect(at(startOf('full', 'flow')).runners).toBe(0);
    expect(at(startOf('full', 'rush')).counter).toBe(1);
    expect(at(startOf('full', 'flow')).counter).toBe(0);
  });

  it('the logo lights node by node, then down its branches, then along the arrow to the impact', () => {
    const rush = startOf('full', 'rush');
    const flow = startOf('full', 'flow');
    const impact = startOf('full', 'impact');
    expect(at(rush + 200).nodes).toEqual([0, 0, 0]);
    const lighting = at(rush + 400);
    expect(lighting.nodes[0]).toBeGreaterThan(lighting.nodes[1]);
    expect(lighting.nodes[1]).toBeGreaterThan(lighting.nodes[2]);
    expect(at(flow + 150).nodes).toEqual([1, 1, 1]);
    // Branches first; the arrow only once they have nearly met.
    expect(at(flow).branch).toBe(0);
    expect(at(flow + 200).branch).toBeGreaterThan(0);
    expect(at(flow + 200).trunk).toBe(0);
    expect(at(flow + 420).branch).toBe(1);
    expect(at(impact - 1).trunk).toBeGreaterThan(0.95);
    // The arrow accelerates into the tip: more ground in its second half than its first.
    const half = at(flow + 480).trunk;
    expect(half).toBeLessThan(0.3);
    // Nothing of the impact before it; all of the logo from it.
    const before = at(impact - 1);
    expect(before).toMatchObject({ glyph: false, flash: 0, shock: 0, sparks: 0, beam: 0 });
    expect(before.beamShot).toBe(-1);
    const struck = at(impact + 30);
    expect(struck.glyph).toBe(true);
    expect(struck.flash).toBeGreaterThan(0.8);
    expect(struck.overdrive).toBeGreaterThan(0.8);
    expect(struck.beamShot).toBeGreaterThan(0);
    expect(struck.zoom).toBeGreaterThan(at(impact - 1).zoom);
    // It dies away: the flash within half a second, the heat a little later.
    expect(at(impact + 500).flash).toBe(0);
    expect(at(impact + 600).overdrive).toBe(0);
    expect(at(impact + 300).beamShot).toBe(-1);
    expect(at(impact + 800).beam).toBeGreaterThan(0.5);
  });

  it('the logo makes room, the name is written, the card holds', () => {
    const name = startOf('full', 'name');
    const hold = startOf('full', 'hold');
    expect(at(name).hero).toBe(1);
    expect(at(name).type).toBe(0);
    expect(at(name + 900).hero).toBe(0);
    let last = 0;
    for (let time = name; time <= hold; time += 10) {
      const type = at(time).type;
      expect(type).toBeGreaterThanOrEqual(last);
      last = type;
    }
    expect(at(hold).type).toBe(1);
    // The writing cursor is there while it writes, blinks once, and is gone before the wipe.
    expect(at(name + 700).pen).toBe(1);
    expect(at(hold + 0.3 * 1350).pen).toBe(0);
    expect(at(hold + 0.5 * 1350).pen).toBe(1);
    expect(at(startOf('full', 'handoff')).pen).toBe(0);
    expect(at(hold + 400).tagline).toBe(1);
    // On the card everything has settled except the slow drift in.
    const card = at(hold + 900);
    expect(card).toMatchObject({ hero: 0, type: 1, tagline: 1, flash: 0, overdrive: 0, wipe: 0 });
    expect(card.zoom).toBeGreaterThan(1);
    expect(card.zoom).toBeLessThan(1.04);
    expect(card.lanes).toBeGreaterThan(0.4);
    expect(card.glints).toBe(1);
  });

  it('hands over with a wipe, and only then; ends exactly at its length', () => {
    const handoff = logoHandoffAt('full');
    expect(at(handoff - 1)).toMatchObject({ handoff: false, wipe: 0, done: false });
    expect(at(handoff)).toMatchObject({ handoff: true, done: false });
    let last = 0;
    for (let time = handoff; time <= 10_000; time += 10) {
      const wipe = at(time).wipe;
      expect(wipe).toBeGreaterThanOrEqual(last);
      last = wipe;
    }
    expect(at(9999)).toMatchObject({ done: false });
    expect(at(10_000)).toMatchObject({ done: true, wipe: 1 });
    // Without a skip the film is never faded.
    for (const frame of frames) expect(frame).toMatchObject({ opacity: 1, scale: 1 });
  });

  it('keeps every value in range and never jumps (except where it is meant to cut)', () => {
    const unit = [
      'content',
      'caret',
      'charge',
      'runners',
      'counter',
      'countFlash',
      'stage',
      'pull',
      'rush',
      'lanes',
      'glints',
      'beam',
      'branch',
      'trunk',
      'hero',
      'flash',
      'shock',
      'sparks',
      'overdrive',
      'fringe',
      'type',
      'pen',
      'tagline',
      'dust',
      'wipe',
    ] as const;
    for (const frame of frames) {
      for (const key of unit) {
        expect(Number.isFinite(frame[key]), `${key} at ${frame.time}`).toBe(true);
        expect(frame[key], `${key} at ${frame.time}`).toBeGreaterThanOrEqual(0);
        expect(frame[key], `${key} at ${frame.time}`).toBeLessThanOrEqual(1);
      }
      expect(frame.zoom).toBeGreaterThanOrEqual(1);
      expect(frame.zoom).toBeLessThan(1.16);
    }
    // The moves that carry the eye are continuous: the camera, the logo's place, the line-up.
    for (let i = 1; i < frames.length; i += 1) {
      for (const key of ['hero', 'stage', 'wipe', 'type', 'branch'] as const) {
        expect(
          Math.abs(frames[i]![key] - frames[i - 1]![key]),
          `${key} at ${frames[i]!.time}`,
        ).toBeLessThan(0.08);
      }
      // (The camera's kick at the impact is the one sharp move: a few hundredths in a frame.)
      expect(Math.abs(frames[i]!.zoom - frames[i - 1]!.zoom)).toBeLessThan(0.05);
    }
  });
});

describe('a skip', () => {
  it('lets the Setup in at once and fades the film out quickly, from anywhere in it', () => {
    for (const skipAt of [0, 700, 3000, 5750, 7000, 9500]) {
      expect(logoIntroFrame('full', skipAt - 1 < 0 ? 0 : skipAt - 1).opacity).toBe(1);
      const first = logoIntroFrame('full', skipAt, skipAt);
      expect(first).toMatchObject({ handoff: true, opacity: 1 });
      let last = 1;
      for (let time = skipAt; time <= skipAt + LOGO_SKIP_MS; time += 20) {
        const frame = logoIntroFrame('full', time, skipAt);
        expect(frame.opacity).toBeLessThanOrEqual(last);
        expect(frame.scale).toBeGreaterThanOrEqual(1);
        last = frame.opacity;
      }
      expect(logoIntroFrame('full', skipAt + LOGO_SKIP_MS - 1, skipAt).done).toBe(
        skipAt + LOGO_SKIP_MS - 1 >= 10_000,
      );
      expect(logoIntroFrame('full', skipAt + LOGO_SKIP_MS, skipAt)).toMatchObject({
        done: true,
        opacity: 0,
      });
    }
  });

  it('keeps the film moving while it fades (no frozen picture)', () => {
    const during = logoIntroFrame('full', 3200, 3000);
    const without = logoIntroFrame('full', 3200);
    expect(during.runClock).toBe(without.runClock);
    expect(during.count).toBe(without.count);
  });

  it('a skip asked for before its time changes nothing yet', () => {
    expect(logoIntroFrame('full', 1000, 2000)).toEqual(logoIntroFrame('full', 1000));
  });
});

describe('the short film', () => {
  const frames = sweep('short');

  it('starts with the runners already lined up, and has no race, cursor or counter', () => {
    const first = logoIntroFrame('short', 0);
    expect(first).toMatchObject({ scene: 'rush', stage: 1, runners: 1, glyph: false });
    for (const frame of frames) {
      expect(frame).toMatchObject({ caret: 0, counter: 0, runRate: 0, dash: -1 });
      expect(frame.runClock).toBe(RUN_CLOCK_END);
    }
  });

  it('goes through the same impact, name and wipe', () => {
    const impact = startOf('short', 'impact');
    expect(logoIntroFrame('short', impact - 1).glyph).toBe(false);
    expect(logoIntroFrame('short', impact + 30).flash).toBeGreaterThan(0.8);
    expect(logoIntroFrame('short', startOf('short', 'hold')).type).toBe(1);
    expect(logoIntroFrame('short', logoIntroDuration('short'))).toMatchObject({
      done: true,
      wipe: 1,
    });
    expect(logoIntroFrame('short', logoHandoffAt('short') - 1).handoff).toBe(false);
  });
});

describe('the still card (reduced motion)', () => {
  const frames = sweep('still');

  it('shows the finished logo and name with nothing moving: only a fade in and a fade out', () => {
    for (const frame of frames) {
      expect(frame).toMatchObject({
        glyph: true,
        hero: 0,
        type: 1,
        tagline: 1,
        zoom: 1,
        scale: 1,
        wipe: 0,
        caret: 0,
        runners: 0,
        counter: 0,
        lanes: 0,
        glints: 0,
        beam: 0,
        flash: 0,
        sparks: 0,
        shock: 0,
        overdrive: 0,
        fringe: 0,
        pen: 0,
        dust: 0,
        runRate: 0,
      });
      expect(frame.sheen).toBe(-1);
      expect(frame.shine).toBe(-1);
      expect(frame.beamShot).toBe(-1);
      expect(frame.nodes).toEqual([1, 1, 1]);
    }
    expect(logoIntroFrame('still', 0).content).toBe(0);
    expect(logoIntroFrame('still', 300).content).toBe(1);
    expect(logoIntroFrame('still', 1299)).toMatchObject({ content: 1, opacity: 1, handoff: false });
    expect(logoIntroFrame('still', 1300).handoff).toBe(true);
    expect(logoIntroFrame('still', 1500).opacity).toBeLessThan(1);
    expect(logoIntroFrame('still', 1700)).toMatchObject({ opacity: 0, done: true });
  });
});

describe('helpers', () => {
  it('writes into the object it is given, and makes nothing new', () => {
    const out = createLogoFrame();
    const nodes = out.nodes;
    const result = logoIntroFrameInto(out, 'full', 5000);
    expect(result).toBe(out);
    expect(result.nodes).toBe(nodes);
    expect(out).toEqual(logoIntroFrame('full', 5000));
    // The same object asked again for another time holds only that time's values.
    logoIntroFrameInto(out, 'full', 300, null);
    expect(out).toEqual(logoIntroFrame('full', 300));
  });

  it('rushProgress: the front of the queue goes first; everyone accelerates all the way in', () => {
    expect(rushProgress(0, 0)).toBe(0);
    expect(rushProgress(1, 0)).toBe(1);
    expect(rushProgress(1, 1)).toBe(1);
    expect(rushProgress(0.3, 0)).toBeGreaterThan(0);
    expect(rushProgress(0.3, 1)).toBe(0);
    // The last in the queue has not moved while the first is half-way.
    expect(rushProgress(0.42, 1)).toBe(0);
    for (const order of [0, 0.5, 1]) {
      let last = 0;
      let lastStep = 0;
      for (let rush = 0; rush <= 1.0001; rush += 0.02) {
        const value = rushProgress(rush, order);
        expect(value).toBeGreaterThanOrEqual(last);
        if (value > 0 && value < 1 && last > 0)
          expect(value - last).toBeGreaterThanOrEqual(lastStep - 1e-9);
        lastStep = value - last;
        last = value;
      }
    }
  });

  it('letterProgress: letters come in left to right, and all are in when the name is written', () => {
    const count = 12;
    expect(letterProgress(0, 0, count)).toBe(0);
    for (let i = 0; i < count; i += 1) expect(letterProgress(1, i, count)).toBe(1);
    for (const type of [0.2, 0.5, 0.8]) {
      for (let i = 1; i < count; i += 1)
        expect(letterProgress(type, i, count)).toBeLessThanOrEqual(
          letterProgress(type, i - 1, count),
        );
    }
    // Half-way through, the first letters are in and the last have not started.
    expect(letterProgress(0.5, 0, count)).toBe(1);
    expect(letterProgress(0.5, count - 1, count)).toBe(0);
    expect(letterProgress(0.5, 3, 0)).toBe(1);
  });
});
