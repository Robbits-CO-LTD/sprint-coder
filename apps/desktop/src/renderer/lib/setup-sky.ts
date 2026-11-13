// The Setup's living background: one full-window canvas with drifting specks, a light that follows
// the pointer, ripples that cross the whole window when something is chosen, the Team's cursors
// racing with trails, confetti from both sides, and the opening where the specks gather into the
// product's name.
//
// One requestAnimationFrame loop, owned here. It stops while the page is hidden and for good on
// `destroy()`, which also removes every listener this object added. Without motion (`animate`
// false) nothing loops: one still frame is drawn, and again after a resize. Only cheap drawing is
// used — arcs, lines and a pre-rendered glow sprite with additive blending; no canvas shadows or
// filters.

export type SkyTheme = Readonly<{
  /** Two colours the specks and glows take, as hex. */
  colors: readonly [string, string];
  /** Speck speed multiplier. */
  speed: number;
}>;

export type SkyTeamMode = 'explicit' | 'auto' | 'proactive';

type Speck = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  tone: 0 | 1;
  alpha: number;
  /** Opening: where this speck settles inside the word. */
  hx?: number | undefined;
  hy?: number | undefined;
};

type Ripple = { x: number; y: number; born: number; color: string };

type Comet = {
  color: string;
  label: string;
  lane: number;
  speed: number;
  x: number;
  phase: number;
  trail: { x: number; y: number }[];
  /** 0..1, how present it is (fades in when it joins, out when it leaves). */
  life: number;
  leaving: boolean;
  /** Joins from the left (-1) or right (+1) edge, then settles into its lane. */
  from: -1 | 1;
  /** 'helper' comets in "おまかせ" come and go with the big job. */
  helper: boolean;
  present?: boolean;
  /** Still on its way to its place in the formation. */
  catching?: boolean;
  /** Where it runs relative to the leader (pixels; behind is negative). While catching up this
   * eases towards its place in the formation; once there it stays, so the cursor keeps the leader's
   * pace and wraps round the window with it. Unset when it runs on its own (no leader, or leaving). */
  offset?: number | undefined;
};

type Confetto = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
  born: number;
};

export type SkyTeamPalette = Readonly<{ leader: string; workers: readonly string[] }>;

const TAU = Math.PI * 2;
const MAX_SPECKS = 170;
/** Matches the Team board's loop (SetupAnimation's TEAM_CYCLE), so the big job lands on both. */
const AUTO_CYCLE_MS = 5200;
/** At most this many pixels behind the canvas (about 2560×1600). */
const MAX_CANVAS_PIXELS = 4_200_000;

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

export class SetupSky {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly animate: boolean;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private frame = 0;
  private last = 0;
  private running = false;
  private sized = false;
  private destroyed = false;
  private specks: Speck[] = [];
  private targetCount = 90;
  private theme: SkyTheme = { colors: ['#8ab0f0', '#d4a7ff'], speed: 1 };
  private sprites = new Map<string, HTMLCanvasElement>();
  private pointer: { x: number; y: number; seen: number } | null = null;
  private ripples: Ripple[] = [];
  private comets: Comet[] = [];
  private teamMode: SkyTeamMode | null = null;
  private laneCenter = 0.5;
  /** Gap between lanes as a fraction of the height. */
  private laneSpread = 0.05;
  private teamSince = 0;
  private team: SkyTeamPalette = { leader: '#2563EB', workers: ['#16A34A', '#EA580C', '#9333EA'] };
  private confetti: Confetto[] = [];
  private warpUntil = 0;
  private warpDir = 1;
  private intro: { start: number; word: string } | null = null;
  private implodeAt = 0;
  private observer: ResizeObserver | null = null;
  private readonly onResize = () => this.resize();
  private readonly onVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  constructor(canvas: HTMLCanvasElement, options: { animate: boolean }) {
    this.canvas = canvas;
    this.animate = options.animate;
    this.ctx = contextOf(canvas);
    // Follow the size of the box the canvas sits in (a dialog that opens later, a window that is
    // resized). Where there is no ResizeObserver, the window's resize stands in.
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(canvas.parentElement ?? canvas);
    } else {
      window.addEventListener('resize', this.onResize);
    }
    if (this.animate) document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.seed();
    if (this.animate) this.start();
    else this.drawStill();
  }

  /** True while a frame is scheduled — for tests and for the "nothing left running" check. */
  get isRunning(): boolean {
    return this.running;
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.specks = [];
    this.comets = [];
    this.confetti = [];
    this.ripples = [];
    this.sprites.clear();
  }

  setTheme(theme: SkyTheme): void {
    this.theme = theme;
    if (!this.animate) this.drawStill();
  }

  setDensity(count: number): void {
    this.targetCount = Math.max(20, Math.min(MAX_SPECKS, Math.round(count)));
    if (!this.animate) {
      this.seed();
      this.drawStill();
    }
  }

  setTeamPalette(palette: SkyTeamPalette): void {
    this.team = palette;
  }

  setPointer(x: number, y: number): void {
    this.pointer = { x, y, seen: performance.now() };
  }

  ripple(x: number, y: number, color?: string): void {
    if (!this.animate) return;
    this.ripples.push({ x, y, born: performance.now(), color: color ?? this.theme.colors[0] });
    if (this.ripples.length > 6) this.ripples.shift();
    // The specks are pushed outwards by the wave.
    for (const speck of this.specks) {
      const dx = speck.x - x;
      const dy = speck.y - y;
      const distance = Math.hypot(dx, dy) || 1;
      const push = Math.max(0, 1 - distance / 520) * 3.2;
      speck.vx += (dx / distance) * push;
      speck.vy += (dy / distance) * push;
    }
  }

  /** A camera move to the next place: the specks streak sideways for a moment. */
  warp(direction: 1 | -1): void {
    if (!this.animate) return;
    this.warpDir = direction;
    this.warpUntil = performance.now() + 760;
  }

  /** center is where the formation runs, as a fraction of the height (clear of the scene). */
  setTeam(mode: SkyTeamMode | null, center = 0.5, spread = 0.05): void {
    this.laneCenter = center;
    this.laneSpread = spread;
    const now = performance.now();
    if (mode === this.teamMode) return;
    this.teamMode = mode;
    this.teamSince = now;
    const wanted = mode === null ? [] : this.cometPlan(mode);
    // Keep a cursor only if the new plan has the very same one — same lane, colour and role (a
    // teammate who comes and goes with the big job is not one who is always there). Cursors already
    // on their way out never count, so a quick back-and-forth brings fresh ones in.
    for (const comet of this.comets) {
      if (comet.leaving) continue;
      const keep = wanted.findIndex(
        (w) =>
          w.label === comet.label &&
          w.lane === comet.lane &&
          w.color === comet.color &&
          w.helper === comet.helper,
      );
      if (keep === -1) comet.leaving = true;
      else wanted.splice(keep, 1);
    }
    for (const plan of wanted) this.comets.push(this.makeComet(plan));
    if (!this.animate) this.drawStill();
  }

  /** The Team cursors that are staying (not on their way out), for checking the picture in tests. */
  activeTeam(): readonly {
    label: string;
    lane: number;
    helper: boolean;
    x: number;
    catching: boolean;
  }[] {
    return this.comets
      .filter((comet) => !comet.leaving)
      .map(({ label, lane, helper, x, catching }) => ({
        label,
        lane,
        helper,
        x,
        catching: catching === true,
      }));
  }

  /** Confetti thrown up from both bottom corners. */
  celebrate(): void {
    if (!this.animate) return;
    const now = performance.now();
    const colors = [...this.theme.colors, this.team.leader, ...this.team.workers, '#f2c46d'];
    for (let side = 0; side < 2; side += 1) {
      for (let index = 0; index < 70; index += 1) {
        this.confetti.push({
          x: side === 0 ? this.width * 0.02 : this.width * 0.98,
          y: this.height + 10,
          vx: (side === 0 ? 1 : -1) * (2.5 + Math.random() * 7.5),
          vy: -(14 + Math.random() * 10) * Math.min(1.25, this.height / 760),
          rot: Math.random() * TAU,
          vr: (Math.random() - 0.5) * 0.4,
          w: 5 + Math.random() * 5,
          h: 8 + Math.random() * 7,
          color: colors[index % colors.length]!,
          born: now + Math.random() * 240,
        });
      }
    }
  }

  /** The opening: specks gather into `word`, a light runs across it, and it dissolves. */
  playIntro(word: string): void {
    if (!this.animate || this.ctx === null) return;
    const points = this.sampleWord(word);
    if (points.length === 0) return;
    this.intro = { start: performance.now(), word };
    while (this.specks.length < points.length) this.specks.push(this.makeSpeck(true));
    this.specks.forEach((speck, index) => {
      const point = points[index % points.length]!;
      speck.hx = point.x;
      speck.hy = point.y;
    });
  }

  /** Ends the opening at once (a click or key during it). */
  finishIntro(): void {
    if (this.intro === null) return;
    this.intro = null;
    // The word bursts: every speck flies outwards from the middle and then drifts on.
    const cx = this.width / 2;
    const cy = this.height * 0.42;
    for (const speck of this.specks) {
      speck.hx = undefined;
      speck.hy = undefined;
      const dx = speck.x - cx;
      const dy = speck.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const power = 6 + Math.random() * 10;
      speck.vx = (dx / d) * power;
      speck.vy = (dy / d) * power - 1;
    }
  }

  /** Leaving for the app: everything rushes to the middle and fades. */
  implode(): void {
    if (!this.animate) return;
    this.implodeAt = performance.now();
  }

  /** The hand-off did not happen (the first Task could not be made): the sky comes back. */
  recover(): void {
    this.implodeAt = 0;
    for (const speck of this.specks) {
      speck.x = Math.random() * this.width;
      speck.y = Math.random() * this.height;
    }
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
      const dt = Math.min(48, now - this.last) / 16.67;
      this.last = now;
      this.step(now, dt);
      this.draw(now);
    } catch {
      // A drawing failure must not leave a half-running loop: stop, and keep the last picture.
      this.running = false;
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private resize(): void {
    const box = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect();
    const width = box.width;
    const height = box.height;
    // Not laid out yet (a dialog not open), or nonsense: draw nothing until there is a size.
    if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
      this.sized = false;
      return;
    }
    // Keep the specks where they were, in proportion — a resize must not reshuffle the picture.
    if (this.sized && this.width > 0 && this.height > 0) {
      const sx = width / this.width;
      const sy = height / this.height;
      for (const speck of this.specks) {
        speck.x *= sx;
        speck.y *= sy;
      }
    }
    this.width = width;
    this.height = height;
    // Cap the pixels behind the canvas: a huge window gets a lower resolution, not hundreds of MB.
    const cap = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
    this.dpr = Math.max(0.25, Math.min(2, window.devicePixelRatio || 1, cap));
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    const firstSize = !this.sized;
    this.sized = true;
    if (firstSize && this.specks.length > 0) this.seed();
    if (!this.animate) this.drawStill();
  }

  /** The canvas's backing size, for tests. */
  get backingSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  private seed(): void {
    this.specks = Array.from({ length: this.targetCount }, () => this.makeSpeck(false));
  }

  private makeSpeck(anywhere: boolean): Speck {
    return {
      x: Math.random() * this.width,
      y: anywhere ? Math.random() * this.height : Math.random() * this.height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: -0.15 - Math.random() * 0.35,
      r: 0.6 + Math.random() * 1.8,
      tone: Math.random() < 0.5 ? 0 : 1,
      alpha: 0.25 + Math.random() * 0.6,
    };
  }

  private cometPlan(
    mode: SkyTeamMode,
  ): { label: string; lane: number; color: string; helper: boolean }[] {
    const leader = { label: 'AI', lane: 0, color: this.team.leader, helper: false };
    const worker = (index: number, lane: number, helper: boolean) => ({
      label: '仲間',
      lane,
      color: this.team.workers[index % this.team.workers.length]!,
      helper,
    });
    if (mode === 'explicit') return [leader];
    if (mode === 'auto') return [leader, worker(0, -1, true), worker(1, 1, true)];
    return [
      leader,
      worker(0, -1, false),
      worker(1, 1, false),
      worker(2, -2, false),
      worker(0, 2, false),
    ];
  }

  private makeComet(plan: { label: string; lane: number; color: string; helper: boolean }): Comet {
    const from: -1 | 1 = plan.lane < 0 ? -1 : 1;
    return {
      color: plan.color,
      label: plan.label,
      lane: plan.lane,
      speed: 6.5,
      x: plan.lane === 0 ? -40 : from === -1 ? -60 : this.width + 60,
      phase: Math.random() * TAU,
      trail: [],
      life: 0,
      leaving: false,
      from,
      helper: plan.helper,
    };
  }

  private step(now: number, dt: number): void {
    // Specks: drift, follow the theme's speed, settle into the word during the opening.
    const warping = now < this.warpUntil;
    const warpForce = warping ? ((this.warpUntil - now) / 760) * 9 : 0;
    const imploding = this.implodeAt > 0;
    const introAge = this.intro ? now - this.intro.start : 0;
    if (this.intro && introAge > 1850) this.finishIntro();
    const gathering = this.intro !== null && introAge < 1850;
    while (!this.intro && this.specks.length > this.targetCount) this.specks.pop();
    while (this.specks.length < this.targetCount) this.specks.push(this.makeSpeck(true));
    for (const speck of this.specks) {
      if (gathering && speck.hx !== undefined && speck.hy !== undefined) {
        const pull = Math.min(1, introAge / 1100);
        speck.x += (speck.hx - speck.x) * (0.06 + pull * 0.14) * dt;
        speck.y += (speck.hy - speck.y) * (0.06 + pull * 0.14) * dt;
        continue;
      }
      if (imploding) {
        speck.x += (this.width / 2 - speck.x) * 0.12 * dt;
        speck.y += (this.height / 2 - speck.y) * 0.12 * dt;
        continue;
      }
      speck.vx *= 0.96;
      speck.vy = speck.vy * 0.96 + (-0.3 * this.theme.speed - speck.vy) * 0.04;
      if (this.pointer) {
        const dx = speck.x - this.pointer.x;
        const dy = speck.y - this.pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 150 * 150 && d2 > 1) {
          const d = Math.sqrt(d2);
          speck.vx += (dx / d) * 0.14;
          speck.vy += (dy / d) * 0.14;
        }
      }
      speck.x += (speck.vx * this.theme.speed + (warping ? -this.warpDir * warpForce : 0)) * dt;
      speck.y += speck.vy * dt;
      if (speck.y < -10) {
        speck.y = this.height + 10;
        speck.x = Math.random() * this.width;
      }
      if (speck.x < -20) speck.x += this.width + 40;
      if (speck.x > this.width + 20) speck.x -= this.width + 40;
    }

    // Team cursors.
    const autoPhase =
      this.teamMode === 'auto' ? ((now - this.teamSince) % AUTO_CYCLE_MS) / AUTO_CYCLE_MS : 0;
    const bigJob = autoPhase > 0.3 && autoPhase < 0.82;
    // Every cursor runs left to right and wraps round from just past the right edge to just
    // before the left one.
    const span = this.width + 160;
    const wrap = (x: number) => ((((x + 80) % span) + span) % span) - 80;
    const leader = this.comets.find((comet) => comet.lane === 0 && !comet.leaving);
    const leaderFrom = leader?.x ?? 0;
    if (leader) leader.x = wrap(leader.x + leader.speed * dt);
    for (const comet of this.comets) {
      const present = !comet.leaving && (!comet.helper || bigJob);
      if (present && !comet.present && comet.lane !== 0) {
        // Arriving: dive in from the window's left or right edge towards the leader.
        comet.x = comet.from === -1 ? -60 : this.width + 60;
        comet.catching = true;
        comet.offset = leader ? comet.x - leader.x : undefined;
        comet.trail = [];
      }
      comet.present = present;
      comet.life += ((present ? 1 : 0) - comet.life) * 0.08 * dt;
      const before = comet === leader ? leaderFrom : comet.x;
      if (comet === leader) {
        // Moved above, before the others take their places from it.
      } else if (leader && !comet.leaving && comet.offset !== undefined) {
        // Placed relative to the leader, so its wrapping round the window never pulls anyone back.
        if (comet.catching) {
          const place = -50 - Math.abs(comet.lane) * 64;
          let move = (place - comet.offset) * 0.075 * dt;
          // One arriving from the left only ever runs forwards (at worst it keeps still).
          if (comet.from === -1) move = Math.max(move, -leader.speed * dt);
          comet.offset += move;
          if (Math.abs(place - comet.offset) < 1) {
            comet.offset = place;
            comet.catching = false;
          }
        }
        comet.x = wrap(leader.x + comet.offset);
      } else {
        // On its own (no leader, or on its way out): keeps running at its own pace.
        comet.catching = false;
        comet.offset = undefined;
        comet.x = wrap(comet.x + comet.speed * dt);
      }
      // Wrapped round: the trail starts again rather than streaking across the window.
      if (comet.x < before - span / 2) comet.trail = [];
      comet.phase += 0.03 * dt;
      const pos = this.cometPosition(comet);
      comet.trail.push(pos);
      if (comet.trail.length > 44) comet.trail.shift();
    }
    this.comets = this.comets.filter((comet) => !(comet.leaving && comet.life < 0.02));

    // Confetti.
    for (const piece of this.confetti) {
      if (now < piece.born) continue;
      piece.vy += 0.32 * dt;
      piece.vx *= 0.99;
      piece.vy *= 0.99;
      piece.x += piece.vx * dt;
      piece.y += piece.vy * dt;
      piece.rot += piece.vr * dt;
    }
    this.confetti = this.confetti.filter(
      (piece) => piece.y < this.height + 40 && now - piece.born < 4200,
    );
    this.ripples = this.ripples.filter((ripple) => now - ripple.born < 1500);
  }

  private cometPosition(comet: Comet): { x: number; y: number } {
    const mid = this.height * this.laneCenter;
    const laneGap = this.height * this.laneSpread;
    // Helpers swoop in from above or below the leader's line.
    const offset = comet.lane * laneGap * (comet.helper ? comet.life : 1);
    const y = mid + offset + Math.sin(comet.phase + comet.x * 0.004) * Math.min(28, laneGap * 0.4);
    return { x: comet.x, y };
  }

  // ---------- drawing ----------

  private sprite(color: string): HTMLCanvasElement {
    let sprite = this.sprites.get(color);
    if (sprite) return sprite;
    sprite = document.createElement('canvas');
    sprite.width = 64;
    sprite.height = 64;
    const g = sprite.getContext('2d');
    if (g) {
      const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.25, `${color}aa`);
      gradient.addColorStop(1, `${color}00`);
      g.fillStyle = gradient;
      g.fillRect(0, 0, 64, 64);
    }
    this.sprites.set(color, sprite);
    return sprite;
  }

  private drawStill(): void {
    // A single, composed frame: the specks where they are, the Team's cursors mid-run.
    for (const comet of this.comets) {
      comet.life = comet.leaving ? 0 : 1;
      comet.x = this.width * (0.3 + Math.abs(comet.lane) * 0.12);
      comet.trail = Array.from({ length: 24 }, (_, index) => {
        const ghost = { ...comet, x: comet.x - (23 - index) * 14 };
        return this.cometPosition(ghost);
      });
    }
    this.comets = this.comets.filter((comet) => !comet.leaving);
    this.draw(performance.now());
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    if (ctx === null || !this.sized) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'lighter';

    const fade = this.implodeAt > 0 ? Math.max(0, 1 - (now - this.implodeAt) / 520) : 1;
    ctx.globalAlpha = fade;

    // Pointer light.
    if (this.pointer && this.animate) {
      const age = (now - this.pointer.seen) / 2400;
      if (age < 1) {
        const size = 420;
        ctx.globalAlpha = fade * 0.22 * (1 - age);
        ctx.drawImage(
          this.sprite(this.theme.colors[0]),
          this.pointer.x - size / 2,
          this.pointer.y - size / 2,
          size,
          size,
        );
      }
    }

    // Specks (streaks while warping or imploding).
    const warping = now < this.warpUntil;
    const introAge = this.intro ? now - this.intro.start : -1;
    for (const speck of this.specks) {
      const color = this.theme.colors[speck.tone];
      let alpha = speck.alpha;
      if (introAge >= 0 && speck.hx !== undefined) {
        alpha = Math.min(1, 0.4 + introAge / 900);
        // The light running across the word.
        const sweep = ((introAge - 1150) / 600) * (this.width * 0.7) + this.width * 0.15;
        if (introAge > 1150 && Math.abs(speck.x - sweep) < 50) alpha = 1;
      }
      ctx.globalAlpha = fade * alpha;
      if (warping) {
        ctx.strokeStyle = color;
        ctx.lineWidth = speck.r;
        ctx.beginPath();
        ctx.moveTo(speck.x, speck.y);
        ctx.lineTo(speck.x + this.warpDir * 26 * speck.r, speck.y);
        ctx.stroke();
      } else {
        const size = speck.r * 7;
        ctx.drawImage(this.sprite(color), speck.x - size / 2, speck.y - size / 2, size, size);
      }
    }

    // Intro light sweep.
    if (introAge > 1100 && introAge < 1800) {
      const t = (introAge - 1100) / 700;
      const x = this.width * (0.1 + t * 0.8);
      ctx.globalAlpha = 0.5 * Math.sin(t * Math.PI);
      ctx.drawImage(this.sprite('#ffffff'), x - 160, this.height * 0.42 - 160, 320, 320);
    }

    // Ripples across the window.
    for (const ripple of this.ripples) {
      const t = (now - ripple.born) / 1500;
      const radius = 20 + t * Math.hypot(this.width, this.height);
      ctx.globalAlpha = fade * 0.55 * (1 - t) * (1 - t);
      ctx.strokeStyle = ripple.color;
      ctx.lineWidth = 2 + 10 * (1 - t);
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, radius, 0, TAU);
      ctx.stroke();
    }

    // Team cursors with trails.
    for (const comet of this.comets) {
      if (comet.life < 0.02 || comet.trail.length < 2) continue;
      ctx.lineCap = 'round';
      for (let index = 1; index < comet.trail.length; index += 1) {
        const a = comet.trail[index - 1]!;
        const b = comet.trail[index]!;
        if (Math.abs(b.x - a.x) > 260) continue;
        const k = index / comet.trail.length;
        ctx.globalAlpha = fade * comet.life * k * 0.85;
        ctx.strokeStyle = comet.color;
        ctx.lineWidth = 1 + k * 8;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const head = comet.trail[comet.trail.length - 1]!;
      ctx.globalAlpha = fade * comet.life * 0.9;
      ctx.drawImage(this.sprite(comet.color), head.x - 70, head.y - 70, 140, 140);
      this.drawPointer(ctx, head.x, head.y, comet.color, comet.label, fade * comet.life);
    }

    // Confetti.
    ctx.globalCompositeOperation = 'source-over';
    for (const piece of this.confetti) {
      if (now < piece.born) continue;
      ctx.globalAlpha = Math.max(0, 1 - (now - piece.born) / 4200);
      ctx.save();
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.rot);
      ctx.scale(1, Math.cos(piece.rot * 2));
      ctx.fillStyle = piece.color;
      ctx.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private drawPointer(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    label: string,
    alpha: number,
  ): void {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    ctx.save();
    ctx.translate(x - 2, y - 4);
    ctx.scale(2.6, 2.6);
    ctx.beginPath();
    ctx.moveTo(0.5, 0.5);
    ctx.lineTo(0.5, 9.5);
    ctx.lineTo(2.9, 7.3);
    ctx.lineTo(4.5, 10.6);
    ctx.lineTo(6, 10);
    ctx.lineTo(4.4, 6.6);
    ctx.lineTo(7.5, 6.6);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();
    ctx.font = '600 11px system-ui, sans-serif';
    const width = ctx.measureText(label).width + 12;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect?.(x + 14, y + 16, width, 18, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 20, y + 29);
    ctx.globalCompositeOperation = 'lighter';
  }

  private sampleWord(word: string): { x: number; y: number }[] {
    const scratch = document.createElement('canvas');
    const w = Math.max(1, Math.round(this.width));
    const h = Math.max(1, Math.round(this.height));
    scratch.width = w;
    scratch.height = h;
    const g = scratch.getContext('2d');
    if (g === null) return [];
    const size = Math.min(w * 0.085, 120);
    g.fillStyle = '#fff';
    g.font = `800 ${size}px system-ui, "Segoe UI", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(word, w / 2, h * 0.42);
    const data = g.getImageData(0, 0, w, h).data;
    const points: { x: number; y: number }[] = [];
    const gap = Math.max(4, Math.round(size / 15));
    for (let y = 0; y < h; y += gap) {
      for (let x = 0; x < w; x += gap) {
        if (data[(y * w + x) * 4 + 3]! > 128) points.push({ x, y });
      }
    }
    // Keep the count bounded however large the window is.
    const step = Math.max(1, Math.ceil(points.length / 900));
    return points.filter((_, index) => index % step === 0);
  }
}
