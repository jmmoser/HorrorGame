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
  t.anisotropy = 2;
  return t;
}

export function wallTexture(p: Palette, seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0x57a11);
  const { c, g } = makeCanvas(256, 256);
  g.fillStyle = hex(p.wall);
  g.fillRect(0, 0, 256, 256);
  // vertical drag marks / paint unevenness
  for (let x = 0; x < 256; x += 2) {
    g.fillStyle = `rgba(0,0,0,${0.03 + 0.05 * rng()})`;
    if (rng() > 0.6) g.fillRect(x, 0, 1, 256);
  }
  stains(g, 256, 256, rng, 7, 0.12);
  // scuff line at "waist height"
  g.fillStyle = 'rgba(0,0,0,0.10)';
  g.fillRect(0, 176, 256, 4);
  grain(g, 256, 256, rng, 0.05);
  return toTexture(c);
}

export function floorTexture(p: Palette, seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0xf100e);
  const { c, g } = makeCanvas(256, 256);
  g.fillStyle = hex(p.floor);
  g.fillRect(0, 0, 256, 256);
  // tile seams
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  g.lineWidth = 1;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  stains(g, 256, 256, rng, 12, 0.2);
  // thirty years of dust film
  g.fillStyle = 'rgba(120,110,90,0.10)';
  g.fillRect(0, 0, 256, 256);
  grain(g, 256, 256, rng, 0.06);
  return toTexture(c);
}

export function ceilingTexture(p: Palette, seed: number): THREE.CanvasTexture {
  const rng = mulberry32(seed ^ 0xce111);
  const { c, g } = makeCanvas(256, 256);
  g.fillStyle = hex(p.ceiling);
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  for (let i = 0; i <= 256; i += 128) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  // sagging water damage in a corner of some tiles
  stains(g, 256, 256, rng, 5, 0.25);
  grain(g, 256, 256, rng, 0.04);
  return toTexture(c);
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
  g.fillStyle = current ? '#ddd6c2' : '#b8ad8e';
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
