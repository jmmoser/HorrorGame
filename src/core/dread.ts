// The escalation director.
//
// The original inspection trusted the player to get frightened on their own
// time. This does not. It keeps a running intensity for the floor — depth,
// attention, how long you have been standing still, how close the thing is —
// and spends it continuously: the frame never sits still, the light is never
// reliable, and something lands every few seconds whether or not you were
// ready for it.
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
  | 'lurch';

interface Tuning {
  /** master multiplier on everything the director outputs */
  scale: number;
  /** floor under the computed intensity — how bad it is at its calmest */
  floorIntensity: number;
  /** seconds between scares at intensity 0 → at intensity 1 */
  gap: [number, number];
  presence: boolean;
}

const TUNING: Record<DreadLevel, Tuning> = {
  // the inspection as it was originally filed: quiet, slow, no one else here
  off: { scale: 0, floorIntensity: 0, gap: [999, 999], presence: false },
  unsettling: { scale: 0.4, floorIntensity: 0.1, gap: [26, 12], presence: true },
  severe: { scale: 0.72, floorIntensity: 0.3, gap: [13, 5], presence: true },
  nightmare: { scale: 1, floorIntensity: 0.52, gap: [6.5, 1.5], presence: true },
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
}

const ZERO: DreadFrame = {
  shakeX: 0, shakeY: 0, shakeZ: 0, roll: 0, jitterYaw: 0, jitterPitch: 0,
  fovKick: 0, warp: 0, staticAmt: 0, red: 0, flash: 0, ca: 0, dark: 0,
  pulse: 0, light: 1,
};

/** weight, and the minimum seconds before the same thing may happen again */
const SCARES: Array<{ kind: ScareKind; weight: number; cooldown: number; minIntensity: number }> = [
  { kind: 'face', weight: 20, cooldown: 3.5, minIntensity: 0 },
  { kind: 'face-hold', weight: 7, cooldown: 22, minIntensity: 0.45 },
  { kind: 'static', weight: 12, cooldown: 5, minIntensity: 0 },
  { kind: 'whisper', weight: 16, cooldown: 6, minIntensity: 0 },
  { kind: 'scream', weight: 11, cooldown: 12, minIntensity: 0.25 },
  { kind: 'bang', weight: 14, cooldown: 7, minIntensity: 0 },
  { kind: 'breath', weight: 12, cooldown: 9, minIntensity: 0 },
  { kind: 'blackout', weight: 9, cooldown: 17, minIntensity: 0.2 },
  { kind: 'word', weight: 8, cooldown: 14, minIntensity: 0.15 },
  { kind: 'shadow', weight: 13, cooldown: 8, minIntensity: 0 },
  { kind: 'headsnap', weight: 6, cooldown: 26, minIntensity: 0.5 },
  { kind: 'lurch', weight: 7, cooldown: 15, minIntensity: 0.35 },
];

export class Dread {
  level: DreadLevel = 'nightmare';
  /** 0..1 — how far gone the floor is right now */
  intensity = 0;
  readonly frame: DreadFrame = { ...ZERO };
  onScare: ((kind: ScareKind, intensity: number) => void) | null = null;
  /** fired on each heartbeat, so the audio and the haptics can land on it */
  onBeat: ((intensity: number) => void) | null = null;

  private t = 0;
  private nextScareAt = 4;
  private cooldowns = new Map<ScareKind, number>();
  private floorT = 0;
  private depth = 1;
  /** impulse decays: shake, flash, static, red, light-out */
  private shakeAmp = 0;
  private flashAmp = 0;
  private staticAmp = 0;
  private redAmp = 0;
  private lightOut = 0;
  private beatPhase = 0;
  private lurch = 0;
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
    }
  }

  setFloor(depth: number) {
    this.depth = depth;
    this.floorT = 0;
    this.cooldowns.clear();
    // the first one lands before you have finished reading the schedule
    this.nextScareAt = this.t + 2.5;
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

  update(dt: number, ctx: DreadContext) {
    this.t += dt;
    this.floorT += dt;
    const tune = this.tuning;
    if (this.level === 'off' || this.suspended) {
      Object.assign(this.frame, ZERO);
      if (this.level !== 'off') this.decay(dt);
      return;
    }

    // ---- intensity: everything the floor knows about how bad this is
    const depth = (this.depth - 1) / 4; // 0 on floor 1, 1 on floor 5
    const settle = Math.min(1, this.floorT / 45); // it builds while you work
    const near = Number.isFinite(ctx.presenceDistance)
      ? Math.max(0, 1 - ctx.presenceDistance / 16)
      : 0;
    const raw =
      tune.floorIntensity +
      depth * 0.22 +
      ctx.attention * 0.26 +
      settle * 0.14 +
      near * 0.42 +
      (ctx.presenceVisible ? 0.16 : 0) +
      (ctx.speed < 0.05 ? 0.06 : 0);
    this.intensity = Math.max(0, Math.min(1, raw)) * tune.scale;

    // ---- the heartbeat: it is yours until it is not
    const bpm = 58 + this.intensity * 96;
    const prev = this.beatPhase;
    this.beatPhase = (this.beatPhase + (dt * bpm) / 60) % 1;
    if (this.beatPhase < prev) this.onBeat?.(this.intensity);

    // ---- scheduling
    const [slow, fast] = tune.gap;
    if (this.t >= this.nextScareAt) {
      const kind = this.pick();
      const gap = slow + (fast - slow) * this.intensity;
      this.nextScareAt = this.t + gap * (0.55 + Math.random() * 0.9);
      if (kind) {
        this.cooldowns.set(kind, this.t);
        this.onScare?.(kind, this.intensity);
      }
    }

    this.decay(dt);
    this.compose(dt, ctx);
  }

  private decay(dt: number) {
    const k = (v: number, rate: number) => Math.max(0, v - dt * rate);
    this.shakeAmp = k(this.shakeAmp, 1.5);
    this.flashAmp = k(this.flashAmp, 6);
    this.staticAmp = k(this.staticAmp, 2.6);
    this.redAmp = k(this.redAmp, 0.7);
    this.lightOut = k(this.lightOut, 1);
    this.lurch = k(this.lurch, 1.8);
  }

  /** build the frame the renderer and the camera will actually use */
  private compose(dt: number, ctx: DreadContext) {
    const f = this.frame;
    const i = this.intensity;
    const t = this.t;

    // a low, constant, wrong sway — the building is never square
    const swayX = Math.sin(t * 0.61) * 0.006 + Math.sin(t * 2.13) * 0.002;
    const swayY = Math.sin(t * 0.83 + 1.4) * 0.005;
    // the heartbeat, felt in the neck
    const beat = Math.pow(Math.max(0, Math.sin(this.beatPhase * Math.PI * 2)), 6);
    f.pulse = beat * (0.25 + i * 0.75);

    const amp = this.shakeAmp;
    const r = () => Math.random() - 0.5;
    f.shakeX = (swayX + r() * amp * 0.16) * (0.4 + i);
    f.shakeY = (swayY + r() * amp * 0.16 + this.lurch * -0.55) * (0.4 + i);
    f.shakeZ = r() * amp * 0.1;
    f.roll = (Math.sin(t * 0.37) * 0.012 + r() * amp * 0.09) * (0.3 + i * 1.6);
    f.jitterYaw = r() * amp * 0.05;
    f.jitterPitch = r() * amp * 0.04;
    f.fovKick = -amp * 5 + beat * i * 2.2 + this.lurch * 7;

    f.warp = i * 0.10 + beat * i * 0.14 + this.staticAmp * 0.2;
    // Signal loss is an *event*. A permanent floor under it tears every frame
    // in the same place, and a tear that is always there is a screen, not a
    // fright — so the resting level stays under the shader's knee.
    f.staticAmt = Math.min(1, this.staticAmp + i * 0.035 + (ctx.documenting ? 0.03 : 0));
    f.red = Math.min(1, this.redAmp + i * 0.055);
    f.flash = this.flashAmp;
    f.ca = i * 0.9 + this.staticAmp * 2.2 + beat * i * 0.7;
    f.dark = i * 0.42 + beat * i * 0.18;

    // the light: a bad connection at the best of times, and out entirely when
    // the building decides. never a hard switch — a filament has to cool.
    const flicker =
      this.lightOut > 0
        ? Math.max(0, Math.random() - 0.86) * 2
        : 1 - Math.max(0, Math.random() - (1 - i * 0.16)) * 3.4;
    f.light = Math.max(0, Math.min(1, flicker));
    void dt;
  }

  private pick(): ScareKind | null {
    const eligible = SCARES.filter(
      (s) =>
        this.intensity >= s.minIntensity * this.tuning.scale &&
        this.t - (this.cooldowns.get(s.kind) ?? -999) >= s.cooldown,
    );
    if (eligible.length === 0) return null;
    const total = eligible.reduce((a, s) => a + s.weight, 0);
    let roll = Math.random() * total;
    for (const s of eligible) {
      roll -= s.weight;
      if (roll <= 0) return s.kind;
    }
    return eligible[eligible.length - 1].kind;
  }
}
