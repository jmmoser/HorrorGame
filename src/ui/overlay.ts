import { faceCanvas, FACE_KINDS, type FaceKind } from '../world/faces';

// The layer above the building.
//
// Everything here happens *to the inspector*, not in the room: a face across
// the whole frame for four hundredths of a second, the light going out, a word
// written over the world in the same pencil as the ledger. It is DOM rather
// than a render pass because it must be able to land on the very next frame,
// and because it must still land when the GL context is having a bad time.

export type WashColor = 'blood' | 'black' | 'white' | 'bone';

const WASHES: Record<WashColor, string> = {
  blood: 'rgba(96, 6, 8, 0.62)',
  black: 'rgba(0, 0, 0, 1)',
  white: 'rgba(238, 236, 230, 0.9)',
  bone: 'rgba(190, 182, 160, 0.5)',
};

/** how many pre-drawn faces are kept warm; a repeated face is a texture */
const FACE_POOL = 6;

export class Overlay {
  private root = document.getElementById('dread')!;
  private canvas = document.getElementById('dread-canvas') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d')!;
  private wash = document.getElementById('dread-wash')!;
  private word = document.getElementById('dread-word')!;
  private faces: HTMLCanvasElement[] = [];
  private faceTimer: number | null = null;
  private washTimer: number | null = null;
  private wordTimer: number | null = null;
  private w = 1;
  private h = 1;
  /** the comfort setting: nothing here fires when false */
  enabled = true;

  constructor(seed: number) {
    for (let i = 0; i < FACE_POOL; i++) {
      this.faces.push(faceCanvas(FACE_KINDS[i % FACE_KINDS.length], seed + i * 7919));
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize() {
    // half-resolution backing store: this is on screen for two frames and is
    // covered in noise, and a full-DPR clear on a phone is a real cost
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * 0.5;
    this.w = Math.max(1, Math.round(window.innerWidth * dpr));
    this.h = Math.max(1, Math.round(window.innerHeight * dpr));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
  }

  /**
   * A face, across everything, for a handful of frames. `fill` is how much of
   * the frame the head occupies — at 1.4 you are inside it.
   */
  flashFace(opts: { ms?: number; fill?: number; kind?: FaceKind; static?: number } = {}) {
    if (!this.enabled) return;
    const ms = opts.ms ?? 90;
    const fill = opts.fill ?? 1.05;
    const src =
      opts.kind !== undefined
        ? faceCanvas(opts.kind, Math.floor(Math.random() * 1e9))
        : this.faces[Math.floor(Math.random() * this.faces.length)];

    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    g.fillStyle = '#050505';
    g.fillRect(0, 0, this.w, this.h);

    if (opts.static) this.paintStatic(opts.static);

    // sized off the short edge, so `fill` means what it says on both a phone
    // held upright and a desktop letterbox: 1.0 is a whole face, 2.0 is inside it
    const size = Math.min(this.w, this.h) * fill * 1.25;
    g.save();
    g.translate(this.w / 2 + (Math.random() - 0.5) * this.w * 0.06, this.h / 2);
    g.rotate((Math.random() - 0.5) * 0.14);
    g.drawImage(src, -size / 2, -size / 2, size, size);
    g.restore();

    this.root.classList.add('on');
    this.canvas.style.opacity = '1';
    if (this.faceTimer) clearTimeout(this.faceTimer);
    this.faceTimer = window.setTimeout(() => {
      this.canvas.style.opacity = '0';
      this.root.classList.remove('on');
    }, ms);
  }

  /** dead signal: the frame the building is not currently paying for */
  flashStatic(ms = 120, density = 1) {
    if (!this.enabled) return;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    this.paintStatic(density);
    this.canvas.style.opacity = '1';
    if (this.faceTimer) clearTimeout(this.faceTimer);
    this.faceTimer = window.setTimeout(() => {
      this.canvas.style.opacity = '0';
    }, ms);
  }

  private paintStatic(density: number) {
    const g = this.ctx;
    const cell = 3;
    const cols = Math.ceil(this.w / cell);
    const rows = Math.ceil(this.h / cell);
    const count = Math.floor(cols * rows * 0.5 * Math.min(1, density));
    for (let i = 0; i < count; i++) {
      const v = Math.random();
      g.fillStyle = v > 0.72 ? '#d8d2c4' : v > 0.45 ? '#4a4740' : '#0a0a0a';
      g.fillRect(
        Math.floor(Math.random() * cols) * cell,
        Math.floor(Math.random() * rows) * cell,
        cell,
        cell,
      );
    }
    // torn tracking bars
    for (let i = 0; i < 4; i++) {
      const y = Math.random() * this.h;
      g.fillStyle = `rgba(216,210,196,${0.05 + Math.random() * 0.12})`;
      g.fillRect(0, y, this.w, 2 + Math.random() * 14);
    }
  }

  /** a colour over everything, fading out over `ms` */
  flashWash(color: WashColor, ms = 260, alpha = 1) {
    if (!this.enabled && color !== 'black') return;
    this.wash.style.transition = 'none';
    this.wash.style.background = WASHES[color];
    this.wash.style.opacity = String(alpha);
    void this.wash.offsetWidth;
    this.wash.style.transition = `opacity ${ms}ms ease-out`;
    this.wash.style.opacity = '0';
    if (this.washTimer) clearTimeout(this.washTimer);
    this.washTimer = window.setTimeout(() => {
      this.wash.style.transition = 'none';
    }, ms + 40);
  }

  /** the building writing on the inside of the frame */
  stabWord(text: string, ms = 700) {
    if (!this.enabled) return;
    this.word.textContent = text;
    this.word.style.transition = 'none';
    this.word.style.opacity = '0.92';
    this.word.style.transform = `translate(-50%, -50%) rotate(${(Math.random() - 0.5) * 5}deg) scale(${0.9 + Math.random() * 0.35})`;
    void this.word.offsetWidth;
    this.word.style.transition = `opacity ${ms}ms ease-in`;
    this.word.style.opacity = '0';
    if (this.wordTimer) clearTimeout(this.wordTimer);
    this.wordTimer = window.setTimeout(() => {
      this.word.textContent = '';
    }, ms + 60);
  }

  /** everything off, immediately — used when the inspection is over */
  clear() {
    if (this.faceTimer) clearTimeout(this.faceTimer);
    if (this.washTimer) clearTimeout(this.washTimer);
    if (this.wordTimer) clearTimeout(this.wordTimer);
    this.canvas.style.opacity = '0';
    this.wash.style.opacity = '0';
    this.word.textContent = '';
    this.root.classList.remove('on');
  }
}
