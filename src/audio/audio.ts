import * as THREE from 'three';
import type { FloorSpec } from '../core/types';
import type { Rng } from '../core/rng';

// The entire soundscape is synthesized: room tone, ventilation, a sub-bass
// drone that thickens with depth, footsteps, and sourced "occupancy" events
// that always come from somewhere the player cannot see — and stop if
// approached. No files, no network, no sudden volume. Ever.

const MASTER_LEVEL = 0.6;

interface OccupancySource {
  panner: PannerNode;
  stop: () => void;
  pos: THREE.Vector3;
  until: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private humGain!: GainNode;
  private droneGain!: GainNode;
  private roomGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private active: OccupancySource[] = [];
  private spotNodes: Array<{ stop: () => void }> = [];
  private nextEventAt = 0;
  private floorSpec: FloorSpec | null = null;
  private rng: Rng = Math.random;
  private listenerPos = new THREE.Vector3();

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** must be called from a user gesture */
  unlock() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = MASTER_LEVEL;
    this.master.connect(ctx.destination);

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
  }

  private ramp(param: AudioParam, v: number, t: number) {
    if (!this.ctx) return;
    param.cancelScheduledValues(this.ctx.currentTime);
    param.setTargetAtTime(v, this.ctx.currentTime, t);
  }

  setFloor(spec: FloorSpec, depth: number, rng: Rng) {
    this.floorSpec = spec;
    this.rng = rng;
    if (!this.ctx) return;
    this.ramp(this.roomGain.gain, 0.014, 3);
    this.ramp(this.humGain.gain, 0.008 * spec.hum + 0.002, 3);
    this.ramp(this.droneGain.gain, Math.min(0.05, 0.004 + depth * 0.006), 6);
    this.nextEventAt = performance.now() / 1000 + 20 + this.rng() * 30;
    this.stopSpots();
  }

  /** quiet between floors */
  duck() {
    if (!this.ctx) return;
    this.ramp(this.roomGain.gain, 0.004, 1.2);
    this.ramp(this.humGain.gain, 0.002, 1.2);
    this.stopOccupancy();
    this.stopSpots();
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
    src.connect(f).connect(g).connect(opts.out ?? this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + opts.dur + 0.1);
  }

  private stepParity = false;

  footstep(intensity: number, surface: FloorSpec['palette']) {
    const soft = surface === 'sodium-orange' || surface === 'tungsten-dust'; // carpet-ish floors
    // alternate feet land slightly differently; every step rolls its own
    // timbre and level so a walk never turns into a metronome
    this.stepParity = !this.stepParity;
    const foot = this.stepParity ? 1 : 0.85;
    this.burst({
      dur: 0.07 + Math.random() * 0.07,
      filter: 'bandpass',
      freq: (soft ? 200 + Math.random() * 180 : 560 + Math.random() * 700) * foot,
      q: (soft ? 0.7 : 1.4) * (0.85 + Math.random() * 0.4),
      gain: (soft ? 0.03 : 0.045) * (0.5 + intensity * 0.5) * (0.72 + Math.random() * 0.38),
    });
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
    src.connect(lp).connect(g).connect(this.master);
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
      panner.connect(this.master);
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
      this.nextEventAt = now + 40 + this.rng() * 70;
      const kind = this.floorSpec.occupancy[Math.floor(this.rng() * this.floorSpec.occupancy.length)];
      const pos = kind === 'below'
        ? playerPos.clone().add(new THREE.Vector3((this.rng() - 0.5) * 6, -2.6, (this.rng() - 0.5) * 6))
        : pickSpot();
      if (pos) this.playOccupancy(kind, pos);
    }
  }

  private playOccupancy(kind: 'phone-ring' | 'chair-scrape' | 'knock' | 'below', pos: THREE.Vector3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const panner = this.makePanner(pos);
    panner.connect(this.master);
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
