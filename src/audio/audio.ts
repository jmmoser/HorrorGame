import * as THREE from 'three';
import type { FloorSpec, OccupancyKind } from '../core/types';
import type { Rng } from '../core/rng';

// The entire soundscape is synthesized: room tone, ventilation, a sub-bass
// drone that thickens with depth, footsteps, and sourced "occupancy" events
// that always come from somewhere the player cannot see — and stop if
// approached. No files, no network, no sudden volume. Ever.

const MASTER_LEVEL = 0.6;

/** caption text per occupancy sound, in the register of the ledger itself */
const OCCUPANCY_CAPTION: Record<OccupancyKind, string> = {
  'phone-ring': 'a telephone ringing',
  'chair-scrape': 'a chair dragged across a floor',
  knock: 'three knocks',
  below: 'movement',
  footsteps: 'unhurried footsteps, walking away',
  whisper: 'a voice, too quiet to be words',
};

interface OccupancySource {
  panner: PannerNode;
  stop: () => void;
  pos: THREE.Vector3;
  until: number;
}

/** How each floor's architecture answers a sound. Seconds of tail, how dark
 *  the tail is, and whether the space flutters — two parallel hard walls close
 *  together ring, and a residential corridor is exactly that. */
interface SpaceProfile {
  seconds: number;
  /** low-pass corner of the tail: soft furnishings and paper eat the top */
  damping: number;
  /** metres between the reflecting walls, or 0 for no discrete flutter */
  flutter: number;
  /** how much of the tail reaches the ear */
  wet: number;
}

const SPACES: Record<FloorSpec['palette'], SpaceProfile> = {
  // partitioned offices: broken up, carpet tiles, nothing rings for long
  'fluorescent-green': { seconds: 1.1, damping: 2600, flutter: 0, wet: 0.3 },
  // a long residential corridor between two parallel plaster walls
  'sodium-orange': { seconds: 1.5, damping: 2000, flutter: 2.4, wet: 0.38 },
  // open plan, hard floor, glass on one side — the brightest tail here
  'moonlight-blue': { seconds: 2.0, damping: 4200, flutter: 0, wet: 0.42 },
  // archive stacks: thirty years of paper is the best absorber in the building
  'tungsten-dust': { seconds: 0.75, damping: 1400, flutter: 0, wet: 0.24 },
  // the lower lobby, and whatever the lower lobby opens onto
  'terminal-white': { seconds: 3.0, damping: 1700, flutter: 0, wet: 0.5 },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  /** everything sourced in the world goes through here: it is what gets a tail.
   *  The room tone, hum and drone bypass it — they are already the room. */
  private bus!: GainNode;
  private convSpace!: ConvolverNode;
  private convCar!: ConvolverNode;
  private wetSpace!: GainNode;
  private wetCar!: GainNode;
  private humGain!: GainNode;
  private droneGain!: GainNode;
  private roomGain!: GainNode;
  /** the inspector's own lungs, which are the loudest thing down here */
  private breathGain!: GainNode;
  private breathDepth!: GainNode;
  private breathLfo!: OscillatorNode;
  /** how far into "stopped to listen" we are, 0..1 */
  private listenAmt = 0;
  private listenTarget = 0;
  private dread = 0;
  /** the depth-driven floor under the drone, before dread adds to it */
  private droneBase = 0.004;
  private noiseBuf!: AudioBuffer;
  private active: OccupancySource[] = [];
  private spotNodes: Array<{ stop: () => void }> = [];
  private nextEventAt = 0;
  private floorSpec: FloorSpec | null = null;
  private rng: Rng = Math.random;
  private listenerPos = new THREE.Vector3();
  /** 0..1 — how interested the building currently is. raises event density. */
  private attn = 0;
  private ducked = false;
  private masterVolume = 1;
  /** print sound events as text — the audio carries half the game */
  captions = false;
  /** called with a caption whenever a sound the player should notice happens */
  onCaption: ((text: string) => void) | null = null;

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** must be called from a user gesture */
  unlock() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = MASTER_LEVEL * this.masterVolume;
    this.master.connect(ctx.destination);

    // dry path plus two parallel tails: the floor's space, and the car. The
    // car is a separate convolver rather than a swapped buffer so stepping in
    // and out of it can crossfade instead of clicking.
    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    this.convSpace = ctx.createConvolver();
    this.convCar = ctx.createConvolver();
    this.convCar.buffer = this.makeImpulse({ seconds: 0.36, damping: 3200, flutter: 1.6, wet: 1 });
    this.wetSpace = ctx.createGain();
    this.wetSpace.gain.value = 0.32;
    this.wetCar = ctx.createGain();
    this.wetCar.gain.value = 0;
    this.bus.connect(this.convSpace).connect(this.wetSpace).connect(this.master);
    this.bus.connect(this.convCar).connect(this.wetCar).connect(this.master);

    // shared noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // pinkish: integrate white slightly
      last = last * 0.96 + (Math.random() * 2 - 1) * 0.04;
      d[i] = last * 6;
    }

    // room tone
    const room = ctx.createBufferSource();
    room.buffer = this.noiseBuf;
    room.loop = true;
    const roomLP = ctx.createBiquadFilter();
    roomLP.type = 'lowpass';
    roomLP.frequency.value = 320;
    this.roomGain = ctx.createGain();
    this.roomGain.gain.value = 0.0;
    room.connect(roomLP).connect(this.roomGain).connect(this.master);
    room.start();

    // ventilation hum
    const hum1 = ctx.createOscillator();
    hum1.frequency.value = 58;
    const hum2 = ctx.createOscillator();
    hum2.frequency.value = 116.3;
    const humMix = ctx.createGain();
    humMix.gain.value = 0.35;
    hum2.connect(humMix);
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0.0;
    hum1.connect(this.humGain);
    humMix.connect(this.humGain);
    this.humGain.connect(this.master);
    hum1.start();
    hum2.start();

    // the descent drone — one sustained sub tone, thickening with depth
    const drone = ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 38;
    const drone2 = ctx.createOscillator();
    drone2.type = 'sine';
    drone2.frequency.value = 38.7; // slow beating
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0;
    drone.connect(this.droneGain);
    drone2.connect(this.droneGain);
    this.droneGain.connect(this.master);
    drone.start();
    drone2.start();

    // the inspector's breathing. Silent at rest, and the price of the run:
    // once it is up, it is the only thing close enough to hear.
    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuf;
    air.loop = true;
    const airBand = ctx.createBiquadFilter();
    airBand.type = 'bandpass';
    airBand.frequency.value = 520;
    airBand.Q.value = 0.8;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    this.breathLfo = ctx.createOscillator();
    this.breathLfo.frequency.value = 0.42;
    this.breathDepth = ctx.createGain();
    this.breathDepth.gain.value = 0;
    this.breathLfo.connect(this.breathDepth).connect(this.breathGain.gain);
    air.connect(airBand).connect(this.breathGain).connect(this.master);
    air.start();
    this.breathLfo.start();
  }

  /**
   * An impulse response as decaying filtered noise, plus — for spaces with two
   * parallel walls — a handful of discrete early taps at the round-trip time
   * between them. That flutter is what makes a corridor sound like a corridor
   * rather than like a plate.
   */
  private makeImpulse(p: SpaceProfile): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * p.seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      // one-pole low pass over the noise, so the tail is dark from the start
      const k = Math.exp((-2 * Math.PI * p.damping) / rate);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, 2.4) * Math.exp(-t * 3.2);
        last = last * k + (Math.random() * 2 - 1) * (1 - k);
        d[i] = last * env;
      }
      if (p.flutter > 0) {
        // 343 m/s there and back, decaying, slightly detuned per ear
        const period = Math.floor(((2 * p.flutter) / 343) * rate * (ch === 0 ? 1 : 1.03));
        for (let n = 1; n * period < len; n++) {
          const idx = n * period;
          d[idx] += Math.pow(0.62, n) * (Math.random() * 0.4 + 0.8) * 0.5;
        }
      }
    }
    return buf;
  }

  /** 0 = out on the floor, 1 = sealed in the car */
  setEnclosure(inCar: number) {
    if (!this.ctx || !this.floorSpec) return;
    const p = SPACES[this.floorSpec.palette];
    const a = Math.max(0, Math.min(1, inCar));
    this.ramp(this.wetSpace.gain, p.wet * (1 - a), 0.35);
    this.ramp(this.wetCar.gain, 0.5 * a, 0.35);
  }

  private ramp(param: AudioParam, v: number, t: number) {
    if (!this.ctx) return;
    param.cancelScheduledValues(this.ctx.currentTime);
    param.setTargetAtTime(v, this.ctx.currentTime, t);
  }

  setFloor(spec: FloorSpec, depth: number, rng: Rng) {
    this.floorSpec = spec;
    this.rng = rng;
    this.attn = 0;
    this.ducked = false;
    if (!this.ctx) return;
    this.ramp(this.roomGain.gain, 0.014, 3);
    this.ramp(this.humGain.gain, 0.008 * spec.hum + 0.002, 3);
    this.droneBase = Math.min(0.05, 0.004 + depth * 0.006);
    this.ramp(this.droneGain.gain, this.droneBase, 6);
    this.nextEventAt = performance.now() / 1000 + 20 + this.rng() * 30;
    this.stopSpots();
    // the floor's own tail — offices are dead, the lower lobby is not
    const space = SPACES[spec.palette];
    this.convSpace.buffer = this.makeImpulse(space);
    this.ramp(this.wetSpace.gain, space.wet, 0.6);
    this.ramp(this.wetCar.gain, 0, 0.6);
  }

  setMasterVolume(v: number) {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.ctx) this.ramp(this.master.gain, MASTER_LEVEL * this.masterVolume, 0.25);
  }

  /** quiet between floors */
  duck() {
    if (!this.ctx) return;
    this.ducked = true;
    this.ramp(this.roomGain.gain, 0.004, 1.2);
    this.ramp(this.humGain.gain, 0.002, 1.2);
    this.ramp(this.breathGain.gain, 0, 1.2);
    this.ramp(this.breathDepth.gain, 0, 1.2);
    this.ramp(this.bus.gain, 1, 0.6);
    this.listenAmt = 0;
    this.listenTarget = 0;
    this.stopOccupancy();
    this.stopSpots();
  }

  /** the building's interest. more of it = occupancy sooner, closer, and a
   *  slightly thicker room. always gradual, never a spike. */
  setAttention(a: number) {
    this.attn = Math.max(0, Math.min(1, a));
    if (!this.ctx || this.ducked) return;
    this.ramp(this.roomGain.gain, 0.014 + this.attn * 0.006, 5);
  }

  /**
   * The grip, once a frame. Everything here has a time constant measured in
   * seconds: the drone thickens, the room closes in, and stopping to listen
   * pulls the room tone out from under the world so the world can be heard.
   */
  setMood(dread: number, breath: number, listening: boolean, dt: number) {
    this.dread = Math.max(0, Math.min(1, dread));
    if (!this.ctx || this.ducked) return;
    this.listenTarget = listening ? 1 : 0;
    this.listenAmt += (this.listenTarget - this.listenAmt) * Math.min(1, dt * (listening ? 2.4 : 1.6));
    const l = this.listenAmt;

    // breathing: level and rate both ride the run
    const b = Math.max(0, Math.min(1, breath));
    this.breathGain.gain.setTargetAtTime(b * b * 0.03, this.ctx.currentTime, 0.25);
    this.breathDepth.gain.setTargetAtTime(b * b * 0.028, this.ctx.currentTime, 0.25);
    this.breathLfo.frequency.setTargetAtTime(0.4 + b * 0.62, this.ctx.currentTime, 0.6);

    // listening: the room gets out of the way, the world comes forward
    this.ramp(this.roomGain.gain, (0.014 + this.dread * 0.01) * (1 - 0.75 * l), 0.5);
    this.ramp(this.humGain.gain, (0.008 * (this.floorSpec?.hum ?? 0.4) + 0.002) * (1 - 0.6 * l), 0.5);
    this.ramp(this.bus.gain, 1 + l * 1.5, 0.5);
    this.ramp(this.droneGain.gain, this.droneBase + this.dread * 0.03, 4);
  }

  /** how attentive the listener currently is, 0..1 — the HUD dims for it */
  get listenLevel(): number {
    return this.listenAmt;
  }

  get attention(): number {
    return this.attn;
  }

  /** pull the next occupancy event close — a response, not an ambush */
  provoke() {
    const now = performance.now() / 1000;
    this.nextEventAt = Math.min(this.nextEventAt, now + 8 + this.rng() * 9);
  }

  // -------------------------------------------------------------- one-shots

  private burst(opts: {
    dur: number;
    filter: 'lowpass' | 'bandpass' | 'highpass';
    freq: number;
    q?: number;
    gain: number;
    attack?: number;
    out?: AudioNode;
  }) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = opts.filter;
    f.frequency.value = opts.freq;
    f.Q.value = opts.q ?? 0.9;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.008));
    g.gain.exponentialRampToValueAtTime(0.0004, t + opts.dur);
    src.connect(f).connect(g).connect(opts.out ?? this.bus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + opts.dur + 0.1);
  }

  private stepParity = false;

  footstep(intensity: number, surface: FloorSpec['palette'], running = false) {
    const soft = surface === 'sodium-orange' || surface === 'tungsten-dust'; // carpet-ish floors
    // alternate feet land slightly differently; every step rolls its own
    // timbre and level so a walk never turns into a metronome
    this.stepParity = !this.stepParity;
    const foot = this.stepParity ? 1 : 0.85;
    // A run is not a louder walk, it is a heavier one: the heel arrives first
    // and the whole corridor gets told about it. This is the mechanic — the
    // sound the player makes is the sound the building is listening for.
    const heft = running ? 2.4 : 1;
    this.burst({
      dur: (0.07 + Math.random() * 0.07) * (running ? 1.5 : 1),
      filter: 'bandpass',
      freq: (soft ? 200 + Math.random() * 180 : 560 + Math.random() * 700) * foot * (running ? 0.8 : 1),
      q: (soft ? 0.7 : 1.4) * (0.85 + Math.random() * 0.4),
      gain: (soft ? 0.03 : 0.045) * heft * (0.5 + intensity * 0.5) * (0.72 + Math.random() * 0.38),
    });
    if (running) {
      // the low thump under the heel, which is what carries down a corridor
      this.burst({ dur: 0.18, filter: 'lowpass', freq: 130, gain: 0.05, attack: 0.004 });
    }
  }

  // ------------------------------------------------------ the hand's sounds

  /** a handle turned against a lock that is thirty years past caring */
  handleRattle() {
    this.burst({ dur: 0.1, filter: 'bandpass', freq: 1500, q: 5, gain: 0.05 });
    setTimeout(() => this.burst({ dur: 0.14, filter: 'bandpass', freq: 1150, q: 4, gain: 0.045 }), 110);
    setTimeout(() => this.burst({ dur: 0.09, filter: 'lowpass', freq: 400, gain: 0.035 }), 220);
  }

  /** a door being opened, or shut, by a hand that is definitely the player's */
  doorSwing(opening: boolean) {
    this.burst({
      dur: opening ? 1.5 : 0.9,
      filter: 'lowpass',
      freq: 300,
      gain: 0.032,
      attack: opening ? 0.35 : 0.12,
    });
    if (!opening) {
      setTimeout(() => this.burst({ dur: 0.12, filter: 'lowpass', freq: 220, gain: 0.06 }), 820);
    }
  }

  /** three knocks, by the inspector, on a door in front of them */
  knock() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        this.burst({ dur: 0.11, filter: 'lowpass', freq: 220, gain: 0.1, attack: 0.003 });
        this.burst({ dur: 0.05, filter: 'bandpass', freq: 1400, q: 3, gain: 0.03 });
      }, i * 300);
    }
  }

  /**
   * The answer. Same rhythm, from the far side, quieter than the knock that
   * asked for it — which is the only reason it is bearable. Positional, so on
   * headphones it comes from the door, or from wherever the building would
   * rather you looked.
   */
  knockBack(pos: THREE.Vector3, delay: number) {
    if (!this.ctx) return;
    const panner = this.makePanner(pos);
    panner.connect(this.bus);
    for (let i = 0; i < 3; i++) {
      setTimeout(
        () => {
          if (!this.ctx) return;
          this.burst({ dur: 0.13, filter: 'lowpass', freq: 170, gain: 0.13, attack: 0.006, out: panner });
        },
        delay * 1000 + i * 306,
      );
    }
    setTimeout(() => panner.disconnect(), delay * 1000 + 2200);
    if (this.captions) {
      setTimeout(() => this.onCaption?.('three knocks — answered'), delay * 1000);
    }
  }

  /** lifting a handset off a line that was cut before the player was born */
  handsetLift() {
    this.burst({ dur: 0.06, filter: 'bandpass', freq: 1100, q: 4, gain: 0.045 });
  }

  /**
   * What is on a dead line at depth. Not a voice — a carrier, and one slow
   * breath on top of it. It fades out on its own; nothing here is ever cut.
   */
  deadLine(interested: boolean) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(interested ? 0.02 : 0.008, t + 0.6);
    g.gain.setValueAtTime(interested ? 0.02 : 0.008, t + (interested ? 3.4 : 1.2));
    g.gain.exponentialRampToValueAtTime(0.0002, t + (interested ? 5.2 : 2.0));
    g.connect(this.master);
    const o = ctx.createOscillator();
    o.frequency.value = 61;
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noiseBuf;
    hiss.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 900;
    hp.Q.value = 0.6;
    const hg = ctx.createGain();
    hg.gain.value = 0.35;
    o.connect(g);
    hiss.connect(hp).connect(hg).connect(g);
    o.start(t);
    hiss.start(t, Math.random());
    const end = t + (interested ? 5.6 : 2.4);
    o.stop(end);
    hiss.stop(end);
    if (interested) this.breathOnce(2.0, 0.9, this.master);
  }

  /** one slow breath. Never sharp, never sudden, never quite the player's. */
  private breathOnce(at: number, level: number, out: AudioNode) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 480;
    f.Q.value = 0.9;
    const g = ctx.createGain();
    const t = ctx.currentTime + at;
    // in, hold, out — the shape is what makes it a lung and not a noise burst
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.03 * level, t + 0.65);
    g.gain.linearRampToValueAtTime(0.012 * level, t + 0.95);
    g.gain.linearRampToValueAtTime(0.026 * level, t + 1.5);
    g.gain.exponentialRampToValueAtTime(0.0002, t + 2.4);
    f.frequency.setValueAtTime(360, t);
    f.frequency.linearRampToValueAtTime(700, t + 0.65);
    f.frequency.linearRampToValueAtTime(300, t + 2.2);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + 2.6);
  }

  /** a breath that is not the inspector's, from somewhere in the room */
  breathAt(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const panner = this.makePanner(pos);
    panner.connect(this.bus);
    this.breathOnce(0, 1.6, panner);
    setTimeout(() => panner.disconnect(), 3200);
    if (this.captions) this.onCaption?.('breathing — close');
  }

  /** every tube on the floor letting go at once. Tubes ring when they die. */
  lightsDie() {
    if (!this.ctx) return;
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        this.burst({ dur: 0.9, filter: 'bandpass', freq: 2400 + Math.random() * 1800, q: 9, gain: 0.035, attack: 0.02 });
      }, i * 120 + Math.random() * 90);
    }
    this.burst({ dur: 2.6, filter: 'lowpass', freq: 90, gain: 0.05, attack: 0.5 });
    if (this.captions) this.onCaption?.('the fixtures letting go');
  }

  /** the sound of a floor deciding something, under the audible floor */
  swell(seconds: number, level = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(31, t);
    o.frequency.linearRampToValueAtTime(24, t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // long attack, longer release. There is no transient anywhere in here.
    g.gain.exponentialRampToValueAtTime(0.055 * level, t + seconds * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0002, t + seconds);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + seconds + 0.2);
  }

  pencil() {
    // logging an entry: graphite on paper, two strokes
    this.burst({ dur: 0.12, filter: 'highpass', freq: 2600, gain: 0.035 });
    setTimeout(() => this.burst({ dur: 0.16, filter: 'highpass', freq: 2200, gain: 0.03 }), 140);
  }

  pageTurn() {
    this.burst({ dur: 0.22, filter: 'highpass', freq: 1400, gain: 0.04, attack: 0.05 });
  }

  deadClick() {
    this.burst({ dur: 0.03, filter: 'bandpass', freq: 1800, q: 4, gain: 0.05 });
  }

  buttonPress() {
    this.burst({ dur: 0.06, filter: 'bandpass', freq: 900, q: 3, gain: 0.06 });
  }

  doorSlide(opening: boolean) {
    if (!this.ctx) return;
    this.burst({
      dur: 2.4,
      filter: 'lowpass',
      freq: opening ? 420 : 360,
      gain: 0.05,
      attack: 0.4,
    });
  }

  /** descent rumble, ramps in and out over `dur` seconds */
  descend(dur: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 90;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + dur * 0.3);
    g.gain.setValueAtTime(0.09, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    src.connect(lp).connect(g).connect(this.bus);
    src.start(t);
    src.stop(t + dur + 0.2);
  }

  arrivalSettle() {
    this.burst({ dur: 0.5, filter: 'lowpass', freq: 120, gain: 0.07, attack: 0.02 });
  }

  quotaCue() {
    // the elevator remembering it exists: a distant, soft mechanical breath
    this.burst({ dur: 1.6, filter: 'lowpass', freq: 200, gain: 0.03, attack: 0.5 });
  }

  // ----------------------------------------------------------- positional

  private makePanner(pos: THREE.Vector3): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 1.5;
    p.rolloffFactor = 1.6;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    return p;
  }

  /** persistent quiet loops tied to wrong props (dial tone, dripping) */
  attachSpots(spots: Array<{ kind: 'dialtone' | 'drip'; pos: THREE.Vector3 }>) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (const s of spots) {
      const panner = this.makePanner(s.pos);
      panner.connect(this.bus);
      if (s.kind === 'dialtone') {
        const o1 = ctx.createOscillator();
        o1.frequency.value = 350;
        const o2 = ctx.createOscillator();
        o2.frequency.value = 440;
        const g = ctx.createGain();
        g.gain.value = 0.012;
        o1.connect(g);
        o2.connect(g);
        g.connect(panner);
        o1.start();
        o2.start();
        this.spotNodes.push({
          stop: () => {
            o1.stop();
            o2.stop();
            panner.disconnect();
          },
        });
      } else {
        // drip: a scheduled loop of tiny filtered ticks
        let alive = true;
        const g = ctx.createGain();
        g.gain.value = 1;
        g.connect(panner);
        const drip = () => {
          if (!alive || !this.ctx) return;
          this.burst({ dur: 0.05, filter: 'bandpass', freq: 2100, q: 6, gain: 0.09, out: g });
          setTimeout(drip, 1400 + Math.random() * 900);
        };
        setTimeout(drip, 800);
        this.spotNodes.push({
          stop: () => {
            alive = false;
            panner.disconnect();
          },
        });
      }
    }
  }

  private stopSpots() {
    this.spotNodes.forEach((s) => s.stop());
    this.spotNodes = [];
  }

  // ------------------------------------------------------------ occupancy

  updateListener(camera: THREE.Camera, pos: THREE.Vector3) {
    this.listenerPos.copy(pos);
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    }
  }

  /** call every frame during play */
  tick(playerPos: THREE.Vector3, pickSpot: () => THREE.Vector3 | null) {
    if (!this.ctx || !this.floorSpec) return;
    const now = performance.now() / 1000;
    // occupancy sounds stop if approached — they were never really there
    this.active = this.active.filter((a) => {
      if (playerPos.distanceTo(a.pos) < 4 || now > a.until) {
        a.stop();
        return false;
      }
      return true;
    });
    if (now >= this.nextEventAt && this.floorSpec.occupancy.length > 0) {
      this.nextEventAt = now + (40 + this.rng() * 70) * (1 - 0.65 * this.attn);
      const kind = this.floorSpec.occupancy[Math.floor(this.rng() * this.floorSpec.occupancy.length)];
      const pos = kind === 'below'
        ? playerPos.clone().add(new THREE.Vector3((this.rng() - 0.5) * 6, -2.6, (this.rng() - 0.5) * 6))
        : pickSpot();
      if (pos) {
        this.playOccupancy(kind, pos);
        // captions name the sound and where it came from — never that it is
        // "behind you", which would be a threat the game does not make
        if (this.captions) {
          const dir = kind === 'below' ? 'one floor below' : this.bearing(playerPos, pos);
          this.onCaption?.(`${OCCUPANCY_CAPTION[kind]} — ${dir}`);
        }
      }
    }
  }

  /** which way a sound came from, in the flat language of a filed report */
  private bearing(from: THREE.Vector3, to: THREE.Vector3): string {
    const d = to.clone().sub(from);
    const dist = Math.hypot(d.x, d.z);
    const far = dist > 15 ? 'far off' : dist > 8 ? 'some way off' : 'close';
    return `${far}, ${Math.round(dist)}m`;
  }

  private playOccupancy(kind: OccupancyKind, pos: THREE.Vector3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const panner = this.makePanner(pos);
    panner.connect(this.bus);
    let stopped = false;
    const cleanup: Array<() => void> = [() => panner.disconnect()];
    const stop = () => {
      if (stopped) return;
      stopped = true;
      cleanup.forEach((f) => f());
    };

    if (kind === 'phone-ring') {
      // an old two-bell ring, far away, 2-4 rings then silence
      const rings = 2 + Math.floor(this.rng() * 3);
      const g = ctx.createGain();
      g.gain.value = 0;
      const o = ctx.createOscillator();
      o.frequency.value = 1180;
      const o2 = ctx.createOscillator();
      o2.frequency.value = 1520;
      const trem = ctx.createGain();
      trem.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 21;
      lfo.connect(trem.gain);
      o.connect(trem);
      o2.connect(trem);
      trem.connect(g).connect(panner);
      const t0 = ctx.currentTime + 0.05;
      for (let i = 0; i < rings; i++) {
        g.gain.setValueAtTime(0.014, t0 + i * 2.4);
        g.gain.setValueAtTime(0.0001, t0 + i * 2.4 + 1.1);
      }
      o.start();
      o2.start();
      lfo.start();
      const end = t0 + rings * 2.4;
      o.stop(end);
      o2.stop(end);
      lfo.stop(end);
      cleanup.push(() => {
        try {
          o.stop();
          o2.stop();
          lfo.stop();
        } catch {
          /* already stopped */
        }
      });
      this.active.push({ panner, stop, pos, until: performance.now() / 1000 + rings * 2.4 + 0.5 });
    } else if (kind === 'chair-scrape') {
      this.burst({ dur: 0.7, filter: 'bandpass', freq: 300, q: 2.5, gain: 0.16, attack: 0.12, out: panner });
      this.active.push({ panner, stop, pos, until: performance.now() / 1000 + 1.2 });
    } else if (kind === 'knock') {
      const t = ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          if (!stopped) this.burst({ dur: 0.09, filter: 'lowpass', freq: 160, gain: 0.18, out: panner });
        }, i * 380);
      }
      void t;
      this.active.push({ panner, stop, pos, until: performance.now() / 1000 + 1.8 });
    } else if (kind === 'footsteps') {
      // someone crossing a room and not arriving anywhere. The stride is even.
      // It never gets closer, which is the part that stays with you.
      const n = 5 + Math.floor(this.rng() * 5);
      for (let i = 0; i < n; i++) {
        setTimeout(() => {
          if (stopped) return;
          this.burst({
            dur: 0.09,
            filter: 'bandpass',
            freq: 320 + this.rng() * 260,
            q: 1.2,
            gain: 0.11 * (1 - i / (n + 3)),
            out: panner,
          });
        }, i * (540 + this.rng() * 60));
      }
      this.active.push({ panner, stop, pos, until: performance.now() / 1000 + n * 0.6 + 0.5 });
    } else if (kind === 'whisper') {
      // formant-shaped noise: the shape of speech with none of the content.
      // If it ever resolved into a word the game would have said something.
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 620;
      f1.Q.value = 7;
      const f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 1180;
      f2.Q.value = 9;
      const g = ctx.createGain();
      const t0 = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.05, t0 + 0.5);
      // the "syllables" are just the formants walking
      for (let i = 0; i < 9; i++) {
        const at = t0 + 0.5 + i * 0.31;
        f1.frequency.linearRampToValueAtTime(430 + this.rng() * 420, at);
        f2.frequency.linearRampToValueAtTime(950 + this.rng() * 900, at);
        g.gain.linearRampToValueAtTime(0.018 + this.rng() * 0.038, at);
      }
      g.gain.exponentialRampToValueAtTime(0.0002, t0 + 3.9);
      src.connect(f1).connect(f2).connect(g).connect(panner);
      src.start(t0, Math.random());
      src.stop(t0 + 4.1);
      cleanup.push(() => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      });
      this.active.push({ panner, stop, pos, until: performance.now() / 1000 + 4.2 });
    } else {
      // 'below': movement on the floor beneath — muffled, unhurried
      this.burst({ dur: 0.5, filter: 'lowpass', freq: 110, gain: 0.2, attack: 0.06, out: panner });
      setTimeout(() => {
        if (!stopped) this.burst({ dur: 0.9, filter: 'lowpass', freq: 90, gain: 0.16, attack: 0.2, out: panner });
      }, 900);
      this.active.push({ panner, stop, pos, until: performance.now() / 1000 + 2.4 });
    }
  }

  private stopOccupancy() {
    this.active.forEach((a) => a.stop());
    this.active = [];
  }
}
