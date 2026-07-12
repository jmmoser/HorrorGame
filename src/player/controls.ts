// Input: WASD + pointer lock on desktop; left-thumb stick + right-thumb look
// on mobile, with gyroscope as an additive layer — the building shifts a
// little when the player physically moves.

export class Controls {
  readonly isTouch: boolean;
  /** strafe (-1..1), forward (-1..1) */
  move = { x: 0, y: 0 };
  /** accumulated look deltas in px, consumed each frame */
  lookDX = 0;
  lookDY = 0;
  /** additive gyro offsets in radians */
  gyroYaw = 0;
  gyroPitch = 0;
  /** fired on click (locked) or clean tap */
  onInspect: (() => void) | null = null;
  enabled = false;

  private keys = new Set<string>();
  private canvas: HTMLCanvasElement;
  private gyroBaseB: number | null = null;
  private gyroBaseG: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (this.isTouch) this.bindTouch();
    else this.bindDesktop();
  }

  // ------------------------------------------------------------- desktop
  private bindDesktop() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.updateKeys();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.updateKeys();
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.updateKeys();
    });
    this.canvas.addEventListener('click', () => {
      if (!this.enabled) return;
      if (document.pointerLockElement === this.canvas) {
        this.onInspect?.();
      } else {
        this.canvas.requestPointerLock?.();
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas || !this.enabled) return;
      this.lookDX += e.movementX;
      this.lookDY += e.movementY;
    });
  }

  private updateKeys() {
    const k = this.keys;
    const x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    this.move.x = x;
    this.move.y = y;
  }

  // --------------------------------------------------------------- touch
  private bindTouch() {
    const stickZone = document.getElementById('stick-zone')!;
    const lookZone = document.getElementById('look-zone')!;
    const base = document.getElementById('stick-base')!;
    const nub = document.getElementById('stick-nub')!;

    let stickId = -1;
    let sx = 0;
    let sy = 0;
    const R = 44;

    stickZone.addEventListener('touchstart', (e) => {
      if (!this.enabled || stickId !== -1) return;
      const t = e.changedTouches[0];
      stickId = t.identifier;
      sx = t.clientX;
      sy = t.clientY;
      base.style.display = 'block';
      base.style.left = `${sx - 48}px`;
      base.style.top = `${sy - 48}px`;
      nub.style.transform = 'translate(0px, 0px)';
      e.preventDefault();
    }, { passive: false });

    stickZone.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== stickId) continue;
        let dx = t.clientX - sx;
        let dy = t.clientY - sy;
        const d = Math.hypot(dx, dy);
        if (d > R) {
          dx = (dx / d) * R;
          dy = (dy / d) * R;
        }
        nub.style.transform = `translate(${dx}px, ${dy}px)`;
        this.move.x = dx / R;
        this.move.y = -dy / R;
      }
      e.preventDefault();
    }, { passive: false });

    const endStick = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== stickId) continue;
        stickId = -1;
        this.move.x = 0;
        this.move.y = 0;
        base.style.display = 'none';
      }
    };
    stickZone.addEventListener('touchend', endStick);
    stickZone.addEventListener('touchcancel', endStick);

    let lookId = -1;
    let lx = 0;
    let ly = 0;
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let moved = 0;

    lookZone.addEventListener('touchstart', (e) => {
      if (!this.enabled || lookId !== -1) return;
      const t = e.changedTouches[0];
      lookId = t.identifier;
      lx = startX = t.clientX;
      ly = startY = t.clientY;
      startT = performance.now();
      moved = 0;
      e.preventDefault();
    }, { passive: false });

    lookZone.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== lookId) continue;
        this.lookDX += (t.clientX - lx) * 2.2;
        this.lookDY += (t.clientY - ly) * 2.2;
        moved += Math.abs(t.clientX - lx) + Math.abs(t.clientY - ly);
        lx = t.clientX;
        ly = t.clientY;
      }
      e.preventDefault();
    }, { passive: false });

    const endLook = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== lookId) continue;
        lookId = -1;
        const dt = performance.now() - startT;
        const dist = Math.hypot(t.clientX - startX, t.clientY - startY);
        if (dt < 300 && dist < 14 && moved < 22 && this.enabled) this.onInspect?.();
      }
    };
    lookZone.addEventListener('touchend', endLook);
    lookZone.addEventListener('touchcancel', endLook);

    window.addEventListener('deviceorientation', (e) => {
      if (e.beta === null || e.gamma === null) return;
      // additive layer with a slow-recentering baseline: lean, don't steer
      if (this.gyroBaseB === null || this.gyroBaseG === null) {
        this.gyroBaseB = e.beta;
        this.gyroBaseG = e.gamma;
      }
      this.gyroBaseB += (e.beta - this.gyroBaseB) * 0.005;
      this.gyroBaseG += (e.gamma - this.gyroBaseG) * 0.005;
      const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
      const target = window.innerWidth > window.innerHeight ? e.beta - this.gyroBaseB : e.gamma - this.gyroBaseG;
      const targetP = window.innerWidth > window.innerHeight ? e.gamma - this.gyroBaseG : e.beta - this.gyroBaseB;
      this.gyroYaw += (clamp(-target * 0.006, 0.12) - this.gyroYaw) * 0.12;
      this.gyroPitch += (clamp(-targetP * 0.004, 0.08) - this.gyroPitch) * 0.12;
    });
  }

  /** iOS needs an in-gesture permission request for the gyroscope */
  static async requestGyro(): Promise<void> {
    const doe = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    try {
      if (typeof doe.requestPermission === 'function') await doe.requestPermission();
    } catch {
      // denied or unsupported — drag look still works
    }
  }

  consumeLook(): { dx: number; dy: number } {
    const d = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return d;
  }
}
