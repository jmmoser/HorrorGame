import type { Watcher } from './watcher';

// The escalation director.
//
// The original inspection trusted the player to get frightened on their own
// time. The build after it did the opposite and fired something every one to
// three seconds, which is how you teach someone to stop flinching inside a
// single floor. This one is neither. It runs a cycle, and the cycle is the
// thing:
//
//   stalk   — ordinary time. the floor is a floor.
//   tell    — the building takes a breath and holds it. the room tone thins
//             out, the flashlight stops flickering for the first time since
//             you arrived, the frame goes unnaturally still. nothing happens.
//             nothing keeps happening.
//   strike  — it lands. sometimes once. sometimes four times inside a second.
//   void    — real silence afterwards, long enough to be sure it is over.
//
// A tell resolves into nothing about a quarter of the time, which is the part
// that does the work: after the third dry one the held breath stops being a
// warning and starts being a place the player has to live. And what lands at
// the end of it is chosen by the Watcher — measured against what this
// particular person has actually flinched at — so the building's best move is
// whatever their own hands told it their worst one is.
//
// The director does not *do* anything itself. It decides, and hands the
// decision to the game through `onScare`, which is what keeps the audio, the
// overlay and the renderer from having to know about each other.

export type DreadLevel = 'off' | 'unsettling' | 'severe' | 'nightmare';

export const DREAD_LEVELS: DreadLevel[] = ['off', 'unsettling', 'severe', 'nightmare'];

export type ScareKind =
  /** a face across the whole frame, for four hundredths of a second */
  | 'face'
  /** the face, but held, and much too close */
  | 'face-hold'
  /** signal loss */
  | 'static'
  /** something said, at ear distance, in the room you are in */
  | 'whisper'
  /** something that is not saying anything */
  | 'scream'
  /** a body-weight impact on the other side of a wall */
  | 'bang'
  /** breathing that is keeping time with yours and then stops */
  | 'breath'
  /** the flashlight failing, and the fixtures with it */
  | 'blackout'
  /** the building writing across the frame */
  | 'word'
  /** something crosses the beam at the edge of the light */
  | 'shadow'
  /** your head is turned for you */
  | 'headsnap'
  /** the floor drops a metre and catches itself */
  | 'lurch'
  /** footsteps behind you, in your rhythm, that take one more than you did */
  | 'follow'
  /** it is put in the one place you are not looking, and nothing announces it */
  | 'stare'
  /** the building writes an entry about you, in your ledger, in your hand */
  | 'observed'
  /** the room quietly gets smaller. no sound at all. */
  | 'closer';

export type DreadPhase = 'stalk' | 'tell' | 'strike' | 'void';

interface Tuning {
  /** master multiplier on everything the director outputs */
  scale: number;
  /** floor under the computed intensity — how bad it is at its calmest */
  floorIntensity: number;
  /** seconds of ordinary time at intensity 0 → at intensity 1 */
  gap: [number, number];
  /** how long the building can hold a breath, at intensity 0 → 1 */
  tell: [number, number];
  presence: boolean;
}

const TUNING: Record<DreadLevel, Tuning> = {
  // the inspection as it was originally filed: quiet, slow, no one else here
  off: { scale: 0, floorIntensity: 0, gap: [999, 999], tell: [0, 0], presence: false },
  unsettling: { scale: 0.4, floorIntensity: 0.1, gap: [30, 15], tell: [2.5, 4.5], presence: true },
  severe: { scale: 0.72, floorIntensity: 0.3, gap: [15, 6], tell: [2.6, 5.5], presence: true },
  nightmare: { scale: 1, floorIntensity: 0.52, gap: [8, 3], tell: [2.6, 6], presence: true },
};

/** everything the renderer, the camera and the overlay read each frame */
export interface DreadFrame {
  /** camera translation, metres */
  shakeX: number;
  shakeY: number;
  shakeZ: number;
  /** camera roll, radians — the horizon is not to be trusted */
  roll: number;
  /** yaw/pitch jitter, radians */
  jitterYaw: number;
  jitterPitch: number;
  /** degrees added to the field of view */
  fovKick: number;
  /** barrel/pinch breathing on the composite */
  warp: number;
  /** VHS noise and tearing in the composite */
  staticAmt: number;
  /** how much of the frame has gone to blood */
  red: number;
  /** a white/inverted stab, decays fast */
  flash: number;
  /** extra chromatic separation */
  ca: number;
  /** the vignette closing in */
  dark: number;
  /** 0..1 heartbeat phase amplitude — throbs the frame */
  pulse: number;
  /** multiplier on the flashlight, 0 while the light is out */
  light: number;
  /** 0..1 the held breath: the mix thins and the frame stops moving */
  hush: number;
  /** 0..1 the walls, quietly, closer than they were */
  closer: number;
}

export interface DreadContext {
  /** which floor, 1..5 */
  depth: number;
  /** 0..1, the building's interest in the ledger */
  attention: number;
  /** metres to the presence, Infinity when it is not on the floor */
  presenceDistance: number;
  /** true when it is on screen with nothing in between */
  presenceVisible: boolean;
  /** 0..1 walking speed — standing still is worse */
  speed: number;
  /** true while the inspector is holding a frame to document it */
  documenting: boolean;
  /** the inspector's heading, for the watcher */
  yaw: number;
}

const ZERO: DreadFrame = {
  shakeX: 0, shakeY: 0, shakeZ: 0, roll: 0, jitterYaw: 0, jitterPitch: 0,
  fovKick: 0, warp: 0, staticAmt: 0, red: 0, flash: 0, ca: 0, dark: 0,
  pulse: 0, light: 1, hush: 0, closer: 0,
};

/** weight, and the minimum seconds before the same thing may happen again */
const SCARES: Array<{ kind: ScareKind; weight: number; cooldown: number; minIntensity: number }> = [
  { kind: 'face', weight: 11, cooldown: 12, minIntensity: 0 },
  { kind: 'face-hold', weight: 7, cooldown: 42, minIntensity: 0.45 },
  { kind: 'static', weight: 9, cooldown: 7, minIntensity: 0 },
  { kind: 'whisper', weight: 14, cooldown: 8, minIntensity: 0 },
  { kind: 'scream', weight: 10, cooldown: 15, minIntensity: 0.25 },
  { kind: 'bang', weight: 12, cooldown: 9, minIntensity: 0 },
  { kind: 'breath', weight: 11, cooldown: 11, minIntensity: 0 },
  { kind: 'blackout', weight: 8, cooldown: 21, minIntensity: 0.2 },
  { kind: 'word', weight: 7, cooldown: 17, minIntensity: 0.15 },
  { kind: 'shadow', weight: 11, cooldown: 10, minIntensity: 0 },
  { kind: 'headsnap', weight: 6, cooldown: 30, minIntensity: 0.5 },
  { kind: 'lurch', weight: 6, cooldown: 19, minIntensity: 0.35 },
  // the quiet half. none of these announce themselves, and between them they
  // are the reason the loud half still works on the fourth floor.
  { kind: 'follow', weight: 13, cooldown: 16, minIntensity: 0.1 },
  { kind: 'stare', weight: 12, cooldown: 36, minIntensity: 0.2 },
  { kind: 'observed', weight: 10, cooldown: 34, minIntensity: 0.18 },
  { kind: 'closer', weight: 9, cooldown: 20, minIntensity: 0.12 },
];

/** kinds that must never be stacked into a volley — they need their own air */
const NEVER_IN_VOLLEY: ScareKind[] = ['stare', 'observed', 'closer', 'follow', 'face-hold'];

export class Dread {
  level: DreadLevel = 'nightmare';
  /** 0..1 — how far gone the floor is right now */
  intensity = 0;
  readonly frame: DreadFrame = { ...ZERO };
  onScare: ((kind: ScareKind, intensity: number) => void) | null = null;
  /** fired on each heartbeat, so the audio and the haptics can land on it */
  onBeat: ((intensity: number) => void) | null = null;
  /** fired when the building starts holding its breath, and when it stops */
  onPhase: ((phase: DreadPhase, seconds: number) => void) | null = null;
  /** the model of the person playing; selection and pacing both read it */
  watcher: Watcher | null = null;

  /** where in the cycle the floor currently is */
  phase: DreadPhase = 'stalk';

  private t = 0;
  private phaseT = 0;
  private phaseEnd = 4;
  private cooldowns = new Map<ScareKind, number>();
  private floorT = 0;
  private depth = 1;
  /** queued members of a volley: absolute times and what to fire */
  private volley: Array<{ at: number; kind: ScareKind }> = [];
  /** impulse decays: shake, flash, static, red, light-out */
  private shakeAmp = 0;
  private flashAmp = 0;
  private staticAmp = 0;
  private redAmp = 0;
  private lightOut = 0;
  private beatPhase = 0;
  private lurch = 0;
  private closerAmp = 0;
  private hush = 0;
  /** set by the game when it wants the director quiet (elevator, ending) */
  suspended = false;

  get tuning(): Tuning {
    return TUNING[this.level];
  }

  get presenceAllowed(): boolean {
    return this.tuning.presence;
  }

  setLevel(level: DreadLevel) {
    this.level = level;
    if (level === 'off') {
      Object.assign(this.frame, ZERO);
      this.intensity = 0;
      this.shakeAmp = this.flashAmp = this.staticAmp = this.redAmp = this.lightOut = 0;
      this.lurch = 0;
      this.closerAmp = 0;
      this.hush = 0;
      this.volley.length = 0;
      this.watcher?.reset();
    }
  }

  setFloor(depth: number) {
    this.depth = depth;
    this.floorT = 0;
    this.cooldowns.clear();
    this.volley.length = 0;
    this.hush = 0;
    this.closerAmp = 0;
    this.watcher?.resetFloor();
    // A short stalk, not a tell: `update` is suspended until the arrival fade
    // lifts, so a tell entered here would have already announced itself to an
    // empty screen. This way the floor's first held breath begins in play,
    // and still begins before the schedule has finished being read.
    this.phase = 'stalk';
    this.phaseT = 0;
    this.phaseEnd = 2.5 + Math.random() * 2;
  }

  /** an out-of-band shock — the presence arriving, a logged discrepancy */
  kick(amount: number, opts: { flash?: number; static?: number; red?: number } = {}) {
    if (this.level === 'off') return;
    const s = this.tuning.scale;
    this.shakeAmp = Math.min(1.4, this.shakeAmp + amount * s);
    if (opts.flash) this.flashAmp = Math.min(1, this.flashAmp + opts.flash * s);
    if (opts.static) this.staticAmp = Math.min(1, this.staticAmp + opts.static * s);
    if (opts.red) this.redAmp = Math.min(1, this.redAmp + opts.red * s);
  }

  /** put the light out for `seconds` */
  killLight(seconds: number) {
    if (this.level === 'off') return;
    this.lightOut = Math.max(this.lightOut, seconds);
  }

  /** the floor drops and catches itself */
  dropFloor() {
    if (this.level === 'off') return;
    this.lurch = 1;
  }

  /** the walls, without being seen to, come in */
  contract(amount = 1) {
    if (this.level === 'off') return;
    this.closerAmp = Math.min(1, this.closerAmp + amount * this.tuning.scale);
  }

  update(dt: number, ctx: DreadContext) {
    this.t += dt;
    this.floorT += dt;
    const tune = this.tuning;
    if (this.level === 'off' || this.suspended) {
      Object.assign(this.frame, ZERO);
      if (this.level !== 'off') this.decay(dt);
      return;
    }

    this.watcher?.sample(dt, ctx.yaw, ctx.speed);

    // ---- intensity: everything the floor knows about how bad this is
    const depth = (this.depth - 1) / 4; // 0 on floor 1, 1 on floor 5
    const settle = Math.min(1, this.floorT / 45); // it builds while you work
    const near = Number.isFinite(ctx.presenceDistance)
      ? Math.max(0, 1 - ctx.presenceDistance / 16)
      : 0;
    // `near` is deliberately modest: proximity feeding intensity feeding
    // shorter timers feeding proximity is the loop that once kept the figure
    // permanently in the inspector's face, and a monster with no absences is
    // wallpaper.
    const raw =
      tune.floorIntensity +
      depth * 0.22 +
      ctx.attention * 0.26 +
      settle * 0.14 +
      near * 0.28 +
      (ctx.presenceVisible ? 0.12 : 0) +
      (ctx.speed < 0.05 ? 0.06 : 0);
    this.intensity = Math.max(0, Math.min(1, raw)) * tune.scale;

    // ---- the heartbeat: it is yours until it is not.
    // It keeps running through the held breath — during a tell it is the only
    // thing left in the mix, which is the point of taking everything else out.
    const bpm = 58 + this.intensity * 96 + this.hush * 14;
    const prev = this.beatPhase;
    this.beatPhase = (this.beatPhase + (dt * bpm) / 60) % 1;
    if (this.beatPhase < prev) this.onBeat?.(this.intensity);

    this.runPhases(dt, ctx);
    this.decay(dt);
    this.compose(dt, ctx);
  }

  // ------------------------------------------------------------ the cycle

  private enter(phase: DreadPhase, seconds: number) {
    this.phase = phase;
    this.phaseT = 0;
    this.phaseEnd = seconds;
    this.onPhase?.(phase, seconds);
  }

  /** ordinary time, shortened by how settled the player has become */
  private stalkSeconds(): number {
    const [slow, fast] = this.tuning.gap;
    const base = slow + (fast - slow) * this.intensity;
    const composure = this.watcher?.composure ?? 0.5;
    // Settled means it is time. Rattled means wait — a frightened player
    // spends the wait frightening themselves, and does it better than we do.
    return base * (1.35 - composure * 0.8) * (0.7 + Math.random() * 0.6);
  }

  private runPhases(dt: number, ctx: DreadContext) {
    this.phaseT += dt;

    // a volley in flight is fired on its own clock, regardless of phase
    while (this.volley.length && this.t >= this.volley[0].at) {
      const next = this.volley.shift()!;
      this.fire(next.kind, ctx);
    }

    if (this.phaseT < this.phaseEnd) return;

    switch (this.phase) {
      case 'stalk': {
        // Not everything is announced. If every shock came after a held
        // breath the breath would be a countdown, and a countdown is a thing
        // you brace against.
        const announced = Math.random() < 0.42 + this.intensity * 0.36;
        if (announced) {
          const [lo, hi] = this.tuning.tell;
          this.enter('tell', lo + (hi - lo) * this.intensity * Math.random() + Math.random() * 1.5);
        } else {
          this.strike(ctx);
        }
        break;
      }

      case 'tell': {
        // The dry one. It is the most valuable event in the cycle and it
        // consists of nothing happening at all.
        const composure = this.watcher?.composure ?? 0.5;
        if (Math.random() < 0.24 + composure * 0.18) {
          this.enter('void', 2.5 + Math.random() * 4);
        } else {
          this.strike(ctx);
        }
        break;
      }

      case 'strike':
        this.enter('void', this.voidSeconds());
        break;

      case 'void':
        this.enter('stalk', this.stalkSeconds());
        break;
    }
  }

  /** real silence afterwards — longer the more frightened they already are */
  private voidSeconds(): number {
    const fear = this.watcher?.fear ?? 0;
    return 2.4 + Math.random() * 3.6 + fear * 6;
  }

  /** fire one, or several inside a second — and then go quiet */
  private strike(ctx: DreadContext) {
    const first = this.pick();
    this.enter('strike', 0.9);
    if (!first) return;
    this.fire(first, ctx);

    // a burst: rare, never announced, and never built out of the quiet kinds,
    // which are ruined by company
    if (NEVER_IN_VOLLEY.includes(first)) return;
    if (this.intensity < 0.55 || Math.random() > this.intensity * 0.45) return;
    const extra = 1 + Math.floor(Math.random() * 3);
    let at = this.t;
    for (let n = 0; n < extra; n++) {
      const kind = this.pick();
      if (!kind || NEVER_IN_VOLLEY.includes(kind)) continue;
      at += 0.1 + Math.random() * 0.38;
      this.volley.push({ at, kind });
      this.cooldowns.set(kind, at);
    }
    this.phaseEnd = Math.max(this.phaseEnd, at - this.t + 0.5);
  }

  private fire(kind: ScareKind, ctx: DreadContext) {
    this.cooldowns.set(kind, this.t);
    this.watcher?.mark(kind, ctx.speed, ctx.yaw);
    this.onScare?.(kind, this.intensity);
  }

  private decay(dt: number) {
    const k = (v: number, rate: number) => Math.max(0, v - dt * rate);
    this.shakeAmp = k(this.shakeAmp, 1.5);
    this.flashAmp = k(this.flashAmp, 6);
    this.staticAmp = k(this.staticAmp, 2.6);
    this.redAmp = k(this.redAmp, 0.7);
    this.lightOut = k(this.lightOut, 1);
    this.lurch = k(this.lurch, 1.8);
    // the walls give the metre back slowly enough that you are never sure
    // they took it
    this.closerAmp = k(this.closerAmp, 0.11);
  }

  /** build the frame the renderer and the camera will actually use */
  private compose(dt: number, ctx: DreadContext) {
    const f = this.frame;
    const i = this.intensity;
    const t = this.t;

    // The held breath, eased. It goes on faster than it comes off: the
    // building stops all at once and starts again by degrees.
    const hushWant = this.phase === 'tell' ? 1 : this.phase === 'void' ? 0.42 : 0;
    const rate = hushWant > this.hush ? 3.2 : 1.1;
    this.hush += (hushWant - this.hush) * Math.min(1, dt * rate);
    f.hush = this.hush;
    // `still` is the multiplier everything restless is scaled by. At a full
    // hush the frame is dead flat, which after ten minutes of a camera that
    // has never once sat still reads as something being wrong with the world
    // rather than with the picture.
    const still = 1 - this.hush * 0.94;

    // a low, constant, wrong sway — the building is never square
    const swayX = Math.sin(t * 0.61) * 0.006 + Math.sin(t * 2.13) * 0.002;
    const swayY = Math.sin(t * 0.83 + 1.4) * 0.005;
    // the heartbeat, felt in the neck. it is the one thing the hush spares.
    const beat = Math.pow(Math.max(0, Math.sin(this.beatPhase * Math.PI * 2)), 6);
    f.pulse = beat * (0.25 + i * 0.75) * (1 + this.hush * 0.5);

    const amp = this.shakeAmp;
    const r = () => Math.random() - 0.5;
    f.shakeX = (swayX + r() * amp * 0.16) * (0.4 + i) * still;
    f.shakeY = (swayY + r() * amp * 0.16 + this.lurch * -0.55) * (0.4 + i) * still;
    f.shakeZ = r() * amp * 0.1 * still;
    f.roll = (Math.sin(t * 0.37) * 0.012 + r() * amp * 0.09) * (0.3 + i * 1.6) * still;
    f.jitterYaw = r() * amp * 0.05 * still;
    f.jitterPitch = r() * amp * 0.04 * still;

    // the walls: the tell brings them in a little, `closer` brings them in a
    // lot, and neither is ever shown moving
    f.closer = Math.min(1, this.closerAmp + this.hush * 0.22);
    f.fovKick = -amp * 5 + beat * i * 2.2 + this.lurch * 7 - f.closer * 9;

    f.warp = (i * 0.10 + beat * i * 0.14 + this.staticAmp * 0.2) * still;
    // Signal loss is an *event*. A permanent floor under it tears every frame
    // in the same place, and a tear that is always there is a screen, not a
    // fright — so the resting level stays under the shader's knee.
    f.staticAmt = Math.min(1, this.staticAmp + (i * 0.035 + (ctx.documenting ? 0.03 : 0)) * still);
    f.red = Math.min(1, this.redAmp + i * 0.055);
    f.flash = this.flashAmp;
    f.ca = (i * 0.9 + this.staticAmp * 2.2 + beat * i * 0.7) * still;
    f.dark = i * 0.42 + beat * i * 0.18 + f.closer * 0.3;

    // The light: a bad connection at the best of times, and out entirely when
    // the building decides. Never a hard switch — a filament has to cool.
    // During a tell the fault simply stops, which is worse than the fault.
    const flicker =
      this.lightOut > 0
        ? Math.max(0, Math.random() - 0.86) * 2
        : 1 - Math.max(0, Math.random() - (1 - i * 0.16 * still)) * 3.4;
    f.light = Math.max(0, Math.min(1, flicker));
  }

  private pick(): ScareKind | null {
    const eligible = SCARES.filter(
      (s) =>
        this.intensity >= s.minIntensity * this.tuning.scale &&
        this.t - (this.cooldowns.get(s.kind) ?? -999) >= s.cooldown,
    );
    if (eligible.length === 0) return null;

    // The signature move: once the model is confident about what this person
    // is worst with, the building starts reaching for it on purpose.
    const w = this.watcher;
    if (w && this.intensity > 0.45 && Math.random() < 0.28) {
      const worst = w.worst();
      if (worst && eligible.some((s) => s.kind === worst)) return worst;
    }

    const weighted = eligible.map((s) => s.weight * (w?.weight(s.kind) ?? 1));
    const total = weighted.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let n = 0; n < eligible.length; n++) {
      roll -= weighted[n];
      if (roll <= 0) return eligible[n].kind;
    }
    return eligible[eligible.length - 1].kind;
  }
}
