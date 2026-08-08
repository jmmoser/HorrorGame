import * as THREE from 'three';
import { mulberry32, type Rng } from '../core/rng';

// The building's face, drawn rather than shipped — same rule as every other
// surface here. Four registers: a flat stare, a scream, a grin, and the wet
// one. They are used two ways: mapped onto the presence's head, and thrown
// across the whole screen for two frames at a time.
//
// Two things decide whether this reads as a face or as a mask, and both were
// learned the hard way. The silhouette has to have a jaw — an ellipse is an
// egg and an egg is a prop. And every shadow on it has to be blurred into the
// skin rather than filled as a shape, because a hard-edged brow is a domino
// mask and a domino mask is a costume.
//
// Everything is drawn on transparent black so the overlay can composite a
// face over static without a matte.

export type FaceKind = 'stare' | 'scream' | 'grin' | 'weep';

export const FACE_KINDS: FaceKind[] = ['stare', 'scream', 'grin', 'weep'];

const SIZE = 512;

interface Head {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** the outline: cranium, temples, cheekbone, and a jaw that runs to a chin */
function skullPath(g: CanvasRenderingContext2D, hd: Head, rng: Rng) {
  const { cx, cy, w, h } = hd;
  // a few per-side percent of asymmetry. symmetry is the other thing that
  // reads as manufactured.
  const l = 1 + (rng() - 0.5) * 0.07;
  const r = 1 + (rng() - 0.5) * 0.07;
  g.beginPath();
  g.moveTo(cx, cy - h);
  g.bezierCurveTo(cx - w * 1.02 * l, cy - h * 0.9, cx - w * 1.0 * l, cy - h * 0.08, cx - w * 0.78 * l, cy + h * 0.30);
  g.bezierCurveTo(cx - w * 0.60 * l, cy + h * 0.70, cx - w * 0.30, cy + h * 0.96, cx, cy + h);
  g.bezierCurveTo(cx + w * 0.30, cy + h * 0.96, cx + w * 0.60 * r, cy + h * 0.70, cx + w * 0.78 * r, cy + h * 0.30);
  g.bezierCurveTo(cx + w * 1.0 * r, cy - h * 0.08, cx + w * 1.02 * r, cy - h * 0.9, cx, cy - h);
  g.closePath();
}

/** a shadow pressed into the skin, never a shape laid on top of it */
function bruise(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  alpha: number,
  blur: number,
) {
  g.save();
  g.filter = `blur(${blur}px)`;
  g.fillStyle = `rgba(6,5,5,${alpha})`;
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** an eye socket: a pit, not an eye. the pinprick is optional and worse. */
function socket(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  rng: Rng,
  pin: boolean,
) {
  // the orbit — a wide soft hollow the eye sits at the bottom of
  bruise(g, x, y, rx * 1.9, ry * 2.0, 0.62, rx * 0.55);
  // the eye itself: hard, and blacker than anything else in the frame
  g.save();
  g.filter = `blur(${rx * 0.10}px)`;
  g.fillStyle = 'rgba(0,0,0,1)';
  g.beginPath();
  g.ellipse(x, y, rx, ry, (rng() - 0.5) * 0.25, 0, Math.PI * 2);
  g.fill();
  g.restore();

  if (pin) {
    // a wet catchlight where an eye would be, far too small and slightly off
    g.fillStyle = 'rgba(236,232,222,0.9)';
    g.beginPath();
    g.arc(x + (rng() - 0.5) * rx * 0.6, y - ry * 0.22, rx * 0.095, 0, Math.PI * 2);
    g.fill();
  }
}

/** the mouth: always a hole. teeth are optional and never even. */
function mouth(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  rng: Rng,
  teeth: boolean,
) {
  bruise(g, x, y, rx * 1.45, ry * 1.7, 0.5, rx * 0.4);
  g.save();
  g.filter = `blur(${Math.max(1, rx * 0.06)}px)`;
  g.fillStyle = '#000';
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  if (!teeth) return;
  const n = 8 + Math.floor(rng() * 5);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const tx = x - rx * 0.88 + t * rx * 1.76;
    // no two the same width, and a couple missing outright
    if (rng() > 0.88) continue;
    const w = rx * (0.055 + rng() * 0.035);
    const hgt = ry * (0.45 + rng() * 0.8);
    g.fillStyle = `rgba(${168 + rng() * 40 | 0},${160 + rng() * 38 | 0},${132 + rng() * 34 | 0},0.8)`;
    g.beginPath();
    g.moveTo(tx - w, y - ry * 0.96);
    g.lineTo(tx + w, y - ry * 0.96);
    g.lineTo(tx + (rng() - 0.5) * w * 1.4, y - ry * 0.96 + hgt);
    g.closePath();
    g.fill();
    if (rng() > 0.5) {
      g.beginPath();
      g.moveTo(tx - w, y + ry * 0.94);
      g.lineTo(tx + w, y + ry * 0.94);
      g.lineTo(tx + (rng() - 0.5) * w * 1.4, y + ry * 0.94 - hgt * 0.7);
      g.closePath();
      g.fill();
    }
  }
}

/** dark wet runs from a point, downward */
function runs(g: CanvasRenderingContext2D, x: number, y: number, rng: Rng, count: number, len: number) {
  for (let i = 0; i < count; i++) {
    const sx = x + (rng() - 0.5) * 34;
    const w = 1.5 + rng() * 5;
    const l = len * (0.35 + rng());
    const grd = g.createLinearGradient(sx, y, sx, y + l);
    grd.addColorStop(0, 'rgba(28,7,7,0.82)');
    grd.addColorStop(0.7, 'rgba(20,6,6,0.35)');
    grd.addColorStop(1, 'rgba(20,6,6,0)');
    g.fillStyle = grd;
    g.fillRect(sx - w / 2, y, w, l);
  }
}

/**
 * Draw a face onto a fresh canvas. `kind` sets the register; the seed varies
 * proportion, asymmetry and blemish so no two flashes are the same image — a
 * repeated face is a texture, and a texture is something you get used to.
 */
export function faceCanvas(kind: FaceKind, seed: number): HTMLCanvasElement {
  const rng = mulberry32(seed >>> 0);
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext('2d')!;

  const hd: Head = {
    cx: SIZE / 2 + (rng() - 0.5) * 12,
    cy: SIZE * 0.5,
    w: SIZE * (0.255 + rng() * 0.025),
    h: SIZE * (0.425 + rng() * 0.045),
  };
  const { cx, cy, w, h } = hd;

  // --- the skin. Lit from below and in front, because that is where the
  // inspector is holding the torch, and it is the wrong way to light a face.
  skullPath(g, hd, rng);
  const skin = g.createLinearGradient(0, cy - h, 0, cy + h);
  skin.addColorStop(0, '#2a2722');
  skin.addColorStop(0.30, '#6c6557');
  skin.addColorStop(0.62, '#d8d1be');
  skin.addColorStop(0.86, '#a79d8a');
  skin.addColorStop(1, '#3a352c');
  g.fillStyle = skin;
  g.fill();

  // everything from here lives inside the skull, so nothing has an edge that
  // is not the silhouette's edge
  g.save();
  skullPath(g, hd, mulberry32(seed >>> 0));
  g.clip();

  // rim darkening: the sides of the head fall away from the torch
  const rim = g.createLinearGradient(cx - w, 0, cx + w, 0);
  rim.addColorStop(0, 'rgba(5,5,4,0.92)');
  rim.addColorStop(0.24, 'rgba(5,5,4,0)');
  rim.addColorStop(0.76, 'rgba(5,5,4,0)');
  rim.addColorStop(1, 'rgba(5,5,4,0.92)');
  g.fillStyle = rim;
  g.fillRect(cx - w * 1.1, cy - h * 1.1, w * 2.2, h * 2.2);

  // the hollows: temples, under the cheekbones, under the jaw
  bruise(g, cx - w * 0.86, cy - h * 0.28, w * 0.30, h * 0.22, 0.5, 26);
  bruise(g, cx + w * 0.86, cy - h * 0.28, w * 0.30, h * 0.22, 0.5, 26);
  bruise(g, cx - w * 0.66, cy + h * 0.18, w * 0.34, h * 0.20, 0.58, 30);
  bruise(g, cx + w * 0.66, cy + h * 0.18, w * 0.34, h * 0.20, 0.58, 30);
  bruise(g, cx, cy + h * 0.86, w * 0.55, h * 0.16, 0.45, 30);

  const eyeY = cy - h * 0.14;
  const eyeDx = w * 0.50;
  const mouthY = cy + h * 0.46;

  if (kind === 'stare') {
    socket(g, cx - eyeDx, eyeY, w * 0.25, h * 0.175, rng, true);
    socket(g, cx + eyeDx, eyeY, w * 0.25, h * 0.175, rng, true);
    mouth(g, cx, mouthY, w * 0.27, h * 0.028, rng, false);
  } else if (kind === 'scream') {
    socket(g, cx - eyeDx, eyeY, w * 0.29, h * 0.215, rng, false);
    socket(g, cx + eyeDx, eyeY, w * 0.29, h * 0.215, rng, false);
    mouth(g, cx, mouthY + h * 0.10, w * 0.33, h * 0.29, rng, false);
    runs(g, cx, mouthY + h * 0.36, rng, 5, h * 0.5);
  } else if (kind === 'grin') {
    socket(g, cx - eyeDx, eyeY, w * 0.21, h * 0.135, rng, true);
    socket(g, cx + eyeDx, eyeY, w * 0.21, h * 0.135, rng, true);
    mouth(g, cx, mouthY, w * 0.62, h * 0.10, rng, true);
  } else {
    socket(g, cx - eyeDx, eyeY, w * 0.27, h * 0.19, rng, false);
    socket(g, cx + eyeDx, eyeY, w * 0.27, h * 0.19, rng, false);
    mouth(g, cx, mouthY, w * 0.21, h * 0.085, rng, false);
    runs(g, cx - eyeDx, eyeY + h * 0.10, rng, 4, h * 0.85);
    runs(g, cx + eyeDx, eyeY + h * 0.10, rng, 4, h * 0.85);
  }

  // the brow goes on last and blurred, so it overhangs the sockets the way a
  // skull does instead of sitting on the forehead like a band
  g.save();
  g.filter = 'blur(22px)';
  g.fillStyle = 'rgba(3,3,3,0.88)';
  g.beginPath();
  g.ellipse(cx, eyeY - h * 0.16, w * 0.98, h * 0.14, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // nose: two holes and the shadow of a bridge that is not there any more
  bruise(g, cx, cy + h * 0.12, w * 0.16, h * 0.16, 0.4, 16);
  g.fillStyle = 'rgba(0,0,0,0.8)';
  for (const s of [-1, 1]) {
    g.save();
    g.filter = 'blur(2px)';
    g.beginPath();
    g.ellipse(cx + s * w * 0.115, cy + h * 0.235, w * 0.052, h * 0.032, s * 0.3, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // blotch, and the faintest suggestion of what is under the skin
  for (let i = 0; i < 30; i++) {
    const x = cx + (rng() - 0.5) * w * 2;
    const y = cy + (rng() - 0.5) * h * 2;
    const r = 8 + rng() * 40;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(22,18,15,${0.08 + rng() * 0.2})`);
    grd.addColorStop(1, 'rgba(22,18,15,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.strokeStyle = 'rgba(12,10,9,0.10)';
  g.lineWidth = 1.1;
  for (let i = 0; i < 9; i++) {
    const x = cx + (rng() - 0.5) * w * 1.8;
    g.beginPath();
    g.moveTo(x, cy - h * (0.2 + rng() * 0.55));
    g.quadraticCurveTo(x + (rng() - 0.5) * 16, cy, x + (rng() - 0.5) * 20, cy + h * rng() * 0.55);
    g.stroke();
  }

  // grain, inside the skin only
  for (let i = 0; i < 3000; i++) {
    const v = rng();
    g.fillStyle = v > 0.5 ? `rgba(255,255,255,${0.16 * rng()})` : `rgba(0,0,0,${0.22 * rng()})`;
    g.fillRect(cx + (rng() - 0.5) * w * 2.2, cy + (rng() - 0.5) * h * 2.2, 1 + rng() * 2.5, 1 + rng() * 2.5);
  }

  g.restore();
  return c;
}

/** the presence's head wears one of these */
export function faceTexture(kind: FaceKind, seed: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(faceCanvas(kind, seed));
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
