import * as THREE from 'three';
import type { Palette } from '../core/types';
import { mulberry32, type Rng } from '../core/rng';

// Every surface in the building is a canvas texture generated at load time:
// grime, water stains, dust. No shipped image assets, everything offline-safe.

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function shade(n: number, f: number): string {
  const r = Math.min(255, ((n >> 16) & 255) * f);
  const g = Math.min(255, ((n >> 8) & 255) * f);
  const b = Math.min(255, (n & 255) * f);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function grain(g: CanvasRenderingContext2D, w: number, h: number, rng: Rng, alpha: number, passes = 900) {
  for (let i = 0; i < passes; i++) {
    const v = rng();
    g.fillStyle = v > 0.5 ? `rgba(255,255,255,${alpha * rng()})` : `rgba(0,0,0,${alpha * rng()})`;
    g.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }
}

function stains(g: CanvasRenderingContext2D, w: number, h: number, rng: Rng, count: number, dark = 0.16) {
  for (let i = 0; i < count; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 8 + rng() * 42;
    const grd = g.createRadialGradient(x, y, r * 0.2, x, y, r);
    grd.addColorStop(0, `rgba(0,0,0,${dark * rng()})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function toTexture(c: HTMLCanvasElement, repeat = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISOTROPY;
  return t;
}

/** non-colour data: normals and roughness must not be sRGB-decoded */
function toDataTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = ANISOTROPY;
  return t;
}

/** set once from the renderer's capabilities — sharp grazing angles matter a
 *  lot in a game that is mostly long corridors seen edge-on */
let ANISOTROPY = 4;
export function setTextureAnisotropy(max: number) {
  ANISOTROPY = Math.min(16, Math.max(1, max));
}

// ---------------------------------------------------------- surface relief

/**
 * A surface is three canvases: what colour it is, how it is shaped, and how
 * polished it is. The shape one is a height field, and the normal map is its
 * Sobel derivative — which is what turns a flat quad into plaster that catches
 * the flashlight at a grazing angle.
 */
export interface SurfaceMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  normalScale: number;
  dispose: () => void;
}

/** wrapping separable box blur — a height field sampled per-texel produces a
 *  normal map that sparkles at grazing angles, which is exactly the angle this
 *  game is always at. Soften it before taking the derivative. */
function blurHeight(src: Uint8ClampedArray, w: number, h: number, radius: number): Float32Array {
  const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = src[i * 4];
  const b = new Float32Array(w * h);
  const n = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[y * w + ((x + k + w) % w)];
      b[y * w + x] = sum / n;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += b[((y + k + h) % h) * w + x];
      a[y * w + x] = sum / n;
    }
  }
  return a;
}

function normalFromHeight(height: HTMLCanvasElement, strength: number, blur: number): HTMLCanvasElement {
  const w = height.width;
  const h = height.height;
  const raw = height.getContext('2d')!.getImageData(0, 0, w, h).data;
  const src = blurHeight(raw, w, h, blur);
  const { c, g } = makeCanvas(w, h);
  const out = g.createImageData(w, h);
  // wrap the sampling so the map tiles without a visible seam
  const at = (x: number, y: number) => src[((y + h) % h) * w + ((x + w) % w)] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * w + x) * 4;
      out.data[i] = (nx * 0.5 + 0.5) * 255;
      out.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      out.data[i + 2] = (nz / len) * 0.5 * 255 + 127.5;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}

function makeSurface(
  size: number,
  normalScale: number,
  blur: number,
  draw: (albedo: CanvasRenderingContext2D, height: CanvasRenderingContext2D, rough: CanvasRenderingContext2D, rng: Rng) => void,
  seed: number,
): SurfaceMaps {
  const rng = mulberry32(seed);
  const a = makeCanvas(size, size);
  // Relief and gloss are both low-frequency by the time they reach the eye, and
  // the blur+Sobel below is the expensive part of loading a floor. Draw them at
  // half size under a scale transform, so the drawing code below can keep
  // working in albedo coordinates.
  const half = size >> 1;
  const hgt = makeCanvas(half, half);
  const rgh = makeCanvas(half, half);
  hgt.g.fillStyle = '#808080';
  hgt.g.fillRect(0, 0, half, half);
  rgh.g.fillStyle = '#e0e0e0';
  rgh.g.fillRect(0, 0, half, half);
  hgt.g.setTransform(0.5, 0, 0, 0.5, 0, 0);
  rgh.g.setTransform(0.5, 0, 0, 0.5, 0, 0);
  draw(a.g, hgt.g, rgh.g, rng);
  const map = toTexture(a.c);
  const normalMap = toDataTexture(normalFromHeight(hgt.c, 2.2, Math.max(1, Math.round(blur / 2))));
  const roughnessMap = toDataTexture(rgh.c);
  return {
    map,
    normalMap,
    roughnessMap,
    normalScale,
    dispose: () => {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}

/** speckled plaster/aggregate relief — the base texture of every hard surface */
function speckle(
  h: CanvasRenderingContext2D,
  size: number,
  rng: Rng,
  count: number,
  amp: number,
  rMin = 1.8,
  rSpan = 5.5,
) {
  for (let i = 0; i < count; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = rMin + rng() * rSpan;
    const v = 128 + (rng() - 0.5) * 2 * amp;
    h.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
    h.beginPath();
    h.arc(x, y, r, 0, Math.PI * 2);
    h.fill();
  }
}

export function wallSurface(p: Palette, seed: number): SurfaceMaps {
  return makeSurface(512, 0.42, 2, (g, h, r, rng) => {
    g.fillStyle = hex(p.wall);
    g.fillRect(0, 0, 512, 512);
    // vertical drag marks / paint unevenness, cut slightly into the plaster
    for (let x = 0; x < 512; x += 4) {
      if (rng() > 0.6) {
        g.fillStyle = `rgba(0,0,0,${0.03 + 0.05 * rng()})`;
        g.fillRect(x, 0, 2, 512);
        h.fillStyle = 'rgba(0,0,0,0.10)';
        h.fillRect(x, 0, 2, 512);
      }
    }
    stains(g, 512, 512, rng, 9, 0.12);
    // water damage is where thirty years of paint went soft: darker, glossier
    for (let i = 0; i < 5; i++) {
      const x = rng() * 512;
      const y = rng() * 512;
      const rad = 30 + rng() * 70;
      const grd = r.createRadialGradient(x, y, rad * 0.2, x, y, rad);
      grd.addColorStop(0, 'rgba(120,120,120,0.55)');
      grd.addColorStop(1, 'rgba(224,224,224,0)');
      r.fillStyle = grd;
      r.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // the dado rail scuff, at the height a trolley hits a wall for thirty years
    g.fillStyle = 'rgba(0,0,0,0.10)';
    g.fillRect(0, 352, 512, 8);
    h.fillStyle = 'rgba(0,0,0,0.35)';
    h.fillRect(0, 352, 512, 4);
    h.fillStyle = 'rgba(255,255,255,0.30)';
    h.fillRect(0, 356, 512, 4);
    speckle(h, 512, rng, 900, 16);
    grain(g, 512, 512, rng, 0.05, 2600);
  }, seed ^ 0x57a11);
}

export function floorSurface(p: Palette, seed: number): SurfaceMaps {
  return makeSurface(512, 0.55, 2, (g, h, r, rng) => {
    g.fillStyle = hex(p.floor);
    g.fillRect(0, 0, 512, 512);
    // tile seams — real grooves, which is what makes a floor read as tiled
    // rather than as a photograph of a tiled floor
    g.strokeStyle = 'rgba(0,0,0,0.22)';
    h.strokeStyle = 'rgba(0,0,0,0.85)';
    r.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 2;
    h.lineWidth = 4;
    r.lineWidth = 5;
    for (let i = 0; i <= 512; i += 128) {
      for (const ctx of [g, h, r]) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
      }
    }
    // per-tile shade variation: no two tiles aged the same
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = 0; tx < 4; tx++) {
        g.fillStyle = `rgba(0,0,0,${rng() * 0.07})`;
        g.fillRect(tx * 128 + 2, ty * 128 + 2, 124, 124);
      }
    }
    stains(g, 512, 512, rng, 16, 0.2);
    // thirty years of dust film, and a polished path where feet went
    g.fillStyle = 'rgba(120,110,90,0.10)';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 4; i++) {
      const x = rng() * 512;
      const y = rng() * 512;
      const rad = 60 + rng() * 90;
      const grd = r.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(96,96,96,0.5)');
      grd.addColorStop(1, 'rgba(224,224,224,0)');
      r.fillStyle = grd;
      r.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    speckle(h, 512, rng, 700, 12);
    grain(g, 512, 512, rng, 0.06, 2800);
  }, seed ^ 0xf100e);
}

export function ceilingSurface(p: Palette, seed: number): SurfaceMaps {
  // the ceiling is uniformly matte — nothing up there has been touched
  return makeSurface(512, 0.34, 2, (g, h, _r, rng) => {
    g.fillStyle = hex(p.ceiling);
    g.fillRect(0, 0, 512, 512);
    // suspended ceiling grid: the T-bar sits proud, the tile sits back
    g.strokeStyle = 'rgba(0,0,0,0.28)';
    g.lineWidth = 3;
    h.strokeStyle = 'rgba(255,255,255,0.75)';
    h.lineWidth = 6;
    for (let i = 0; i <= 512; i += 256) {
      for (const ctx of [g, h]) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
      }
    }
    // mineral fibre tile: pitted, and the pits are the whole look
    speckle(h, 512, rng, 4200, 15, 0.8, 2.6);
    // sagging water damage in a corner of some tiles
    stains(g, 512, 512, rng, 7, 0.25);
    for (let i = 0; i < 3; i++) {
      const x = rng() * 512;
      const y = rng() * 512;
      const rad = 40 + rng() * 60;
      const grd = h.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(0,0,0,0.45)');
      grd.addColorStop(1, 'rgba(128,128,128,0)');
      h.fillStyle = grd;
      h.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    grain(g, 512, 512, rng, 0.04, 2200);
  }, seed ^ 0xce111);
}

/** City seen through glass. mood decides how wrong it is allowed to look. */
export function windowTexture(
  mood: 'overcast-night' | 'sodium-haze' | 'moonlit' | 'void' | 'daylight',
  seed: number,
): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0x319d0);
  const { c, g } = makeCanvas(256, 320);
  if (mood === 'daylight') {
    // flat overexposed noon — deeply wrong at 3am in a condemned building
    const grd = g.createLinearGradient(0, 0, 0, 320);
    grd.addColorStop(0, '#cfd8d2');
    grd.addColorStop(1, '#9fb0a4');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 320);
    g.fillStyle = 'rgba(255,255,250,0.85)';
    g.beginPath();
    g.arc(190, 60, 26, 0, Math.PI * 2);
    g.fill();
  } else if (mood === 'void') {
    g.fillStyle = '#020203';
    g.fillRect(0, 0, 256, 320);
  } else {
    const top = mood === 'sodium-haze' ? '#1c1006' : mood === 'moonlit' ? '#0a1220' : '#0b0d10';
    const bottom = mood === 'sodium-haze' ? '#3a2410' : mood === 'moonlit' ? '#16233a' : '#15181d';
    const grd = g.createLinearGradient(0, 0, 0, 320);
    grd.addColorStop(0, top);
    grd.addColorStop(1, bottom);
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 320);
    if (mood === 'moonlit') {
      g.fillStyle = 'rgba(220,232,255,0.75)';
      g.beginPath();
      g.arc(72, 58, 14, 0, Math.PI * 2);
      g.fill();
    }
  }
  if (mood !== 'void') {
    // distant towers, all dark. nobody is home anywhere.
    for (let i = 0; i < 9; i++) {
      const bw = 20 + rng() * 40;
      const bh = 70 + rng() * 150;
      const bx = rng() * 256;
      g.fillStyle = mood === 'daylight' ? 'rgba(70,80,74,0.85)' : 'rgba(3,3,5,0.92)';
      g.fillRect(bx, 320 - bh, bw, bh);
      if (mood !== 'daylight' && rng() > 0.86) {
        // one lit window somewhere far away
        g.fillStyle = mood === 'sodium-haze' ? 'rgba(255,170,80,0.5)' : 'rgba(190,210,255,0.4)';
        g.fillRect(bx + 4 + rng() * (bw - 8), 320 - bh + 8 + rng() * (bh - 16), 2, 3);
      }
    }
  }
  // glass film
  g.fillStyle = 'rgba(140,140,130,0.05)';
  g.fillRect(0, 0, 256, 320);
  grain(g, 256, 320, rng, 0.05, 500);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function calendarTexture(current: boolean, seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0xca1);
  const { c, g } = makeCanvas(192, 256);
  g.fillStyle = current ? '#cfc6ab' : '#b8ad8e';
  g.fillRect(0, 0, 192, 256);
  const now = new Date();
  const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  const month = current ? months[now.getMonth()] : 'MARCH';
  const year = current ? String(now.getFullYear()) : '1996';
  g.fillStyle = '#2e2a20';
  g.font = 'bold 20px "Courier New", monospace';
  g.textAlign = 'center';
  g.fillText(month, 96, 34);
  g.font = '14px "Courier New", monospace';
  g.fillText(year, 96, 54);
  // day grid
  g.font = '11px "Courier New", monospace';
  const first = current ? new Date(now.getFullYear(), now.getMonth(), 1).getDay() : 5;
  const days = current ? new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() : 31;
  for (let d = 1; d <= days; d++) {
    const idx = first + d - 1;
    const col = idx % 7;
    const row = (idx / 7) | 0;
    const x = 20 + col * 22;
    const y = 86 + row * 26;
    g.fillStyle = '#2e2a20';
    g.fillText(String(d), x, y);
    if (current && d === now.getDate()) {
      g.strokeStyle = '#6b1d12';
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(x - 1, y - 4, 9.5, 0, Math.PI * 2);
      g.stroke();
    }
  }
  if (!current) {
    stains(g, 192, 256, rng, 6, 0.22);
    g.fillStyle = 'rgba(90,70,40,0.18)';
    g.fillRect(0, 0, 192, 256);
  }
  grain(g, 192, 256, rng, 0.05, 300);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function clockFaceTexture(seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0xc10c);
  const { c, g } = makeCanvas(128, 128);
  g.fillStyle = '#c8c2ae';
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#26231c';
  g.font = 'bold 13px "Courier New", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let h = 1; h <= 12; h++) {
    const a = (h / 12) * Math.PI * 2 - Math.PI / 2;
    g.fillText(String(h), 64 + Math.cos(a) * 48, 64 + Math.sin(a) * 48);
  }
  grain(g, 128, 128, rng, 0.05, 160);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function roomPlateTexture(label: string, seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0x9147e);
  const { c, g } = makeCanvas(128, 64);
  g.fillStyle = '#6d6858';
  g.fillRect(0, 0, 128, 64);
  g.strokeStyle = '#3a362c';
  g.strokeRect(3, 3, 122, 58);
  g.fillStyle = '#211f19';
  g.font = 'bold 26px "Courier New", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 34);
  grain(g, 128, 64, rng, 0.06, 120);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function doorTexture(p: Palette, seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0xd002);
  const { c, g } = makeCanvas(128, 256);
  g.fillStyle = shade(p.trim, 1.5);
  g.fillRect(0, 0, 128, 256);
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.lineWidth = 2;
  g.strokeRect(14, 16, 100, 100);
  g.strokeRect(14, 132, 100, 106);
  stains(g, 128, 256, rng, 4, 0.18);
  grain(g, 128, 256, rng, 0.05, 260);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** rotary telephone dial: metal face, ten finger holes, worn center card */
export function phoneDialTexture(seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0xd1a1);
  const { c, g } = makeCanvas(128, 128);
  g.fillStyle = '#9a9484';
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  // finger holes with digits beside them
  g.font = 'bold 9px "Courier New", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < 10; i++) {
    // classic dial: holes sweep from ~60° down around to ~300°
    const a = ((i / 10) * 0.83 + 0.31) * Math.PI * 2;
    const hx = 64 + Math.cos(a) * 44;
    const hy = 64 + Math.sin(a) * 44;
    g.fillStyle = '#14120e';
    g.beginPath();
    g.arc(hx, hy, 10, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#26231c';
    const digit = i === 9 ? '0' : String(i + 1);
    g.fillText(digit, 64 + Math.cos(a) * 24, 64 + Math.sin(a) * 24);
  }
  // center card, yellowed, number long illegible
  g.fillStyle = '#c9c0a6';
  g.beginPath();
  g.arc(64, 64, 13, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#4a453a';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(64, 64, 13, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(40,36,28,0.7)';
  g.fillRect(56, 62, 16, 2);
  grain(g, 128, 128, rng, 0.06, 160);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** soft round puff used for steam / cigarette smoke / dust motes */
export function puffTexture(): THREE.CanvasTexture {
  const { c, g } = makeCanvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(235,235,230,0.5)');
  grd.addColorStop(0.6, 'rgba(220,220,215,0.16)');
  grd.addColorStop(1, 'rgba(210,210,205,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function footprintTexture(): THREE.CanvasTexture {
  const { c, g } = makeCanvas(64, 128);
  g.fillStyle = 'rgba(15,13,10,0.55)';
  // sole
  g.beginPath();
  g.ellipse(32, 44, 17, 30, 0, 0, Math.PI * 2);
  g.fill();
  // heel
  g.beginPath();
  g.ellipse(32, 102, 13, 16, 0, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

/** typed page — fresh or thirty years yellowed */
export function paperTexture(fresh: boolean, seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0x9a9e2);
  const { c, g } = makeCanvas(96, 128);
  g.fillStyle = fresh ? '#efece2' : '#a4977a';
  g.fillRect(0, 0, 96, 128);
  g.fillStyle = fresh ? 'rgba(30,30,30,0.7)' : 'rgba(40,35,25,0.5)';
  for (let y = 18; y < 118; y += 9) {
    const w = 60 + rng() * 26;
    g.fillRect(12, y, fresh && y > 90 ? 0 : w, 2);
  }
  if (!fresh) stains(g, 96, 128, rng, 3, 0.2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** a pinned notice: aged paper, short typed lines, legible at arm's length */
export function noticeTexture(lines: string[], seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0x0071ce);
  const { c, g } = makeCanvas(256, 320);
  g.fillStyle = '#b6ac92';
  g.fillRect(0, 0, 256, 320);
  g.strokeStyle = 'rgba(60,52,38,0.5)';
  g.lineWidth = 3;
  g.strokeRect(6, 6, 244, 308);
  // rusted pin shadow at the top
  g.fillStyle = '#4a3524';
  g.beginPath();
  g.arc(128, 22, 6, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(35,30,22,0.88)';
  g.font = 'bold 22px "Courier New", monospace';
  g.textAlign = 'center';
  const top = 160 - (lines.length - 1) * 17;
  lines.forEach((line, i) => g.fillText(line, 128, top + i * 34));
  stains(g, 256, 320, rng, 4, 0.14);
  grain(g, 256, 320, rng, 0.05, 340);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
