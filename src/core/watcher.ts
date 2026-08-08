import type { ScareKind } from './dread';

// The building watches back.
//
// The previous build's answer to "make it scarier" was rate: something landed
// every one to three seconds. That is the one thing that reliably makes a
// horror game *less* frightening. A shock every two seconds is a metronome,
// and a metronome is a thing you can stand inside of. Within a floor the
// player stops flinching, and a player who has stopped flinching is playing a
// light show.
//
// So this build spends its escalation somewhere else. It measures what the
// inspector actually does with their hands in the two seconds after each
// shock — how far they spun, how hard they stopped, whether they backed away —
// and it keeps the score. What works on this particular person gets used
// again. What they have learned to sit through gets retired. And when the
// score says they have settled, the building stops rather than starts,
// because the withheld one is worth more than the one that arrives.
//
// Nothing here is sent anywhere. It lives for one session, in memory, and it
// exists so that the floor can be about the person on it.

/** how long after a shock the reaction is still attributable to it */
const WINDOW = 1.7;
/** a reaction score below this counts as "they sat through it" */
const NUMB = 0.22;
/** speed01 under this is a player who has stopped walking */
const STILL = 0.06;

interface Pending {
  kind: ScareKind;
  t: number;
  /** yaw when it landed, and total absolute yaw travelled since */
  yaw0: number;
  spin: number;
  peakTurn: number;
  /** speed the frame before it landed */
  speed0: number;
  stillT: number;
  fled: number;
}

export interface WatcherState {
  /** 0..1 — how frightened this player currently is, by their own hands */
  fear: number;
  /** 0..1 — how settled they have become. high means it is time. */
  composure: number;
}

export class Watcher {
  /** per-kind EMA of how hard this player reacts. starts neutral. */
  private reaction = new Map<ScareKind, number>();
  /** how many times each kind has been spent, so a novel one can be favoured */
  private used = new Map<ScareKind, number>();
  private pending: Pending[] = [];

  /** 0..1, the running estimate of how frightened they are */
  fear = 0;
  /** 0..1, how far they have settled back down since the last thing landed */
  composure = 0.5;

  // --- raw behaviour, kept so the building can quote it back at them
  /** seconds the inspector has been standing still */
  stillFor = 0;
  /** seconds since they last wrote anything in the ledger */
  sinceLog = 0;
  /** completed >120° sweeps and back inside 1.4s — checking behind themselves */
  lookBacks = 0;
  /** seconds since the floor loaded */
  floorT = 0;

  private lastYaw = 0;
  private turnAccum = 0;
  private turnT = 0;
  private turnSign = 0;

  /** a fresh floor: behaviour resets, the model of the person does not */
  resetFloor() {
    this.stillFor = 0;
    this.sinceLog = 0;
    this.lookBacks = 0;
    this.floorT = 0;
    this.pending.length = 0;
  }

  /** wipe the model as well — used when the exposure setting turns it all off */
  reset() {
    this.resetFloor();
    this.reaction.clear();
    this.used.clear();
    this.fear = 0;
    this.composure = 0.5;
  }

  /** called every frame with what the inspector's hands are doing */
  sample(dt: number, yaw: number, speed01: number) {
    if (dt <= 0) return;
    this.floorT += dt;
    this.sinceLog += dt;
    this.stillFor = speed01 < STILL ? this.stillFor + dt : 0;

    // shortest-arc yaw delta: the player can cross ±π on any frame
    const d = ((yaw - this.lastYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.lastYaw = yaw;
    const rate = Math.abs(d) / dt;

    // a look-back is a large sweep one way that reverses soon after. tracked
    // as one accumulator that resets on a direction change or a pause.
    const sign = Math.sign(d);
    if (sign !== 0 && sign !== this.turnSign) {
      if (this.turnSign !== 0 && this.turnAccum > 2.1 && this.turnT < 1.4) this.lookBacks += 1;
      this.turnSign = sign;
      this.turnAccum = 0;
      this.turnT = 0;
    }
    this.turnAccum += Math.abs(d);
    this.turnT += dt;
    if (this.turnT > 1.4) {
      this.turnAccum = 0;
      this.turnT = 0;
      this.turnSign = 0;
    }

    for (let n = this.pending.length - 1; n >= 0; n--) {
      const p = this.pending[n];
      p.t += dt;
      p.spin += Math.abs(d);
      p.peakTurn = Math.max(p.peakTurn, rate);
      if (speed01 < STILL) p.stillT += dt;
      p.fled = Math.max(p.fled, speed01 - p.speed0);
      if (p.t >= WINDOW) {
        this.settle(p);
        this.pending.splice(n, 1);
      }
    }

    // fear bleeds off on its own; composure is what grows back into the gap.
    // The rates are deliberately slow — this is the shape of a floor, not of
    // a moment, and a player who is genuinely rattled stays rattled.
    this.fear = Math.max(0, this.fear - dt * 0.055);
    this.composure = Math.min(1, this.composure + dt * (0.035 + (1 - this.fear) * 0.05));
  }

  /** the director spent a scare; start watching for what it cost them */
  mark(kind: ScareKind, speed01: number, yaw: number) {
    this.used.set(kind, (this.used.get(kind) ?? 0) + 1);
    this.pending.push({
      kind, t: 0, yaw0: yaw, spin: 0, peakTurn: 0, speed0: speed01, stillT: 0, fled: 0,
    });
    // it landed: whatever calm they had built is spent, pending the verdict
    this.composure = Math.max(0, this.composure - 0.34);
  }

  /** the inspector wrote something down */
  noteLog() {
    this.sinceLog = 0;
  }

  /** the window closed — score it and fold it into the model */
  private settle(p: Pending) {
    // Four tells, and they are the four a frightened person actually gives.
    // Spin: they looked for it. Flinch: the speed of the first movement, which
    // is the one thing nobody fakes. Freeze: they stopped dead, which is the
    // commonest and the most easily missed. Flight: they ran.
    const spin = Math.min(1, p.spin / (Math.PI * 1.25));
    const flinch = Math.min(1, p.peakTurn / 5.5);
    const froze = p.speed0 > STILL ? Math.min(1, p.stillT / (WINDOW * 0.6)) : 0;
    const fled = Math.min(1, Math.max(0, p.fled) / 0.55);
    const score = Math.min(1, spin * 0.42 + flinch * 0.3 + froze * 0.34 + fled * 0.3);

    const prev = this.reaction.get(p.kind) ?? 0.5;
    // Asymmetric: one big reaction is strong evidence, one shrug is weaker
    // evidence but still evidence. People are startled by different things and
    // only sometimes by the same thing twice, so the model is quick to learn
    // and slower — but not much slower — to forget.
    const alpha = score > prev ? 0.45 : 0.28;
    this.reaction.set(p.kind, prev + (score - prev) * alpha);

    this.fear = Math.min(1, this.fear + score * 0.5);
    // it landed on someone who was already going to sit through it: give the
    // calm straight back, so the director reads "settled" and holds its fire
    if (score < NUMB) this.composure = Math.min(1, this.composure + 0.3);
  }

  /**
   * How much this player is worth showing `kind` right now. Never zero — a
   * kind that is never spent is never re-measured, and a player who works out
   * that one particular thing has stopped happening has worked out that
   * something is choosing.
   */
  weight(kind: ScareKind): number {
    const r = this.reaction.get(kind) ?? 0.5;
    const n = this.used.get(kind) ?? 0;
    // The first outing of anything is worth more than the fifth — but novelty
    // is a thumb on the scale, not a multiplier on what has been learned.
    // Scaling the learned term by novelty would quietly retire the very thing
    // the model just proved works on this person, which is backwards.
    const novelty = 1 / (1 + n * 0.22);
    return (0.25 + r * 1.9) * (0.78 + 0.22 * novelty);
  }

  /** the kind this player is most afraid of, once there is enough to say so */
  worst(): ScareKind | null {
    let best: ScareKind | null = null;
    let bestV = 0.62;
    for (const [kind, v] of this.reaction) {
      if ((this.used.get(kind) ?? 0) >= 2 && v > bestV) {
        bestV = v;
        best = kind;
      }
    }
    return best;
  }

  get state(): WatcherState {
    return { fear: this.fear, composure: this.composure };
  }
}
