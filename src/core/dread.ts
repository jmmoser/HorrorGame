// Dread is the building's grip, expressed as one number.
//
// It is deliberately slow. Everything that raises it raises it by a little,
// and everything that lowers it lowers it by less — so a floor gets worse the
// longer you stay on it, and the only real relief is the elevator. Nothing
// here ever steps: `value` chases `target` with a long time constant, because
// a sudden change in the frame is a jump scare and this game does not have
// those. It has the other thing.

/** how fast the smoothed value chases its target, per second */
const ATTACK = 0.34;
const RELEASE = 0.13;
/** event contributions bleed off with this half-life, in seconds */
const SPIKE_HALFLIFE = 22;

export class Dread {
  /** 0..1, smoothed — this is what the renderer, audio and haptics read */
  value = 0;
  /** un-smoothed floor from the persistent inputs (attention, depth) */
  private base = 0;
  /** decaying sum of one-off frights */
  private spikes = 0;
  /** 0..1 how long the inspector has been standing in their own dark */
  private darkT = 0;

  /** the slow floor: how interested the building is, and how deep we are */
  setBase(attention: number, depth: number) {
    this.base = Math.min(1, attention * 0.52 + (depth - 1) * 0.075);
  }

  /** something happened. knocking, running, opening a door, being looked at. */
  bump(v: number) {
    this.spikes = Math.min(1, this.spikes + v);
  }

  /** the inspector's own dark, which the building treats as an invitation */
  setDark(inDark: boolean, dt: number) {
    const t = inDark ? 1 : 0;
    this.darkT += (t - this.darkT) * Math.min(1, dt * (inDark ? 0.18 : 0.9));
  }

  update(dt: number) {
    this.spikes *= Math.pow(0.5, dt / SPIKE_HALFLIFE);
    const target = Math.min(1, this.base + this.spikes + this.darkT * 0.22);
    const k = target > this.value ? ATTACK : RELEASE;
    this.value += (target - this.value) * Math.min(1, dt * k);
  }

  /** the elevator is the one place the building lets go */
  relieve(dt: number) {
    this.spikes *= Math.pow(0.5, dt / 3);
    this.value += (0 - this.value) * Math.min(1, dt * 0.5);
  }

  reset() {
    this.value = 0;
    this.base = 0;
    this.spikes = 0;
    this.darkT = 0;
  }
}
