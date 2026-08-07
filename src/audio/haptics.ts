// Mobile haptics: a faint heartbeat that very slowly quickens with depth and
// with the building's grip, and occasionally desynchronizes from the audio
// breathing. Android Chrome only — everywhere else this is silently inert.
//
// It is never used as a stinger. A phone that jolts in the hand is a jump
// scare with extra steps. The only thing it ever does is beat, and the only
// thing that changes is how fast.

export class Haptics {
  private timer: number | null = null;
  private depth = 1;
  private dread = 0;
  private supported = 'vibrate' in navigator;
  /** player setting; the device still has to support it */
  enabled = true;

  setDepth(depth: number) {
    this.depth = depth;
  }

  /** the grip. It does not add a new sensation, it takes the resting one and
   *  will not let it rest. */
  setDread(v: number) {
    this.dread = Math.max(0, Math.min(1, v));
  }

  start() {
    if (!this.supported || this.timer !== null) return;
    const beat = () => {
      // 54 bpm at the surface, creeping toward 72 with depth, and toward 104
      // when the building is paying attention. Still a heart. Still not fast.
      const bpm = Math.min(72, 54 + this.depth * 2.2) + this.dread * 32;
      let interval = 60000 / bpm;
      // occasional desync: one beat lands early, for no reason it will explain
      if (Math.random() < 0.06 + this.dread * 0.1) interval *= 0.72;
      if (!document.hidden && this.enabled) {
        try {
          // the second beat gets heavier as the grip closes — lub … DUB
          navigator.vibrate([16, 90, 10 + Math.round(this.dread * 16)]);
        } catch {
          this.enabled = false;
        }
      }
      this.timer = window.setTimeout(beat, interval);
    };
    this.timer = window.setTimeout(beat, 1000);
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
