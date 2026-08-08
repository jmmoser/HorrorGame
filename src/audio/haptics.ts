// Mobile haptics: a faint heartbeat that very slowly quickens with depth and
// occasionally desynchronizes from the audio breathing. Android Chrome only —
// everywhere else this is silently inert.

export class Haptics {
  private timer: number | null = null;
  private depth = 1;
  private supported = 'vibrate' in navigator;
  /** player setting; the device still has to support it */
  enabled = true;

  setDepth(depth: number) {
    this.depth = depth;
  }

  start() {
    if (!this.supported || this.timer !== null) return;
    const beat = () => {
      // 54 bpm at the surface, creeping toward 72 with depth
      const bpm = Math.min(72, 54 + this.depth * 2.2);
      let interval = 60000 / bpm;
      // occasional desync: one beat lands early, for no reason it will explain
      if (Math.random() < 0.06) interval *= 0.72;
      if (!document.hidden) {
        try {
          navigator.vibrate([16, 90, 10]); // lub … dub
        } catch {
          this.enabled = false;
        }
      }
      this.timer = window.setTimeout(beat, interval);
    };
    this.timer = window.setTimeout(beat, 1000);
  }

  /** a scare landing: not the heartbeat, and not faint */
  jolt(strength: 'small' | 'hard' | 'contact' = 'small') {
    if (!this.supported || !this.enabled || document.hidden) return;
    const pattern =
      strength === 'contact'
        ? [40, 30, 60, 30, 240]
        : strength === 'hard'
          ? [30, 40, 90]
          : [24];
    try {
      navigator.vibrate(pattern);
    } catch {
      this.enabled = false;
    }
  }

  stop() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      navigator.vibrate?.(0);
    } catch {
      /* ignore */
    }
  }
}
