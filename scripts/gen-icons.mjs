// Generates the PWA icons without any native dependencies: raw RGBA pixels,
// hand-encoded into PNG via node's zlib. The icon is the ledger motif — a dark
// field with a descending column of survey tick marks fading into black.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };

  // near-black field with faint paper-grain noise
  let noise = 12345;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      const n = (noise >> 16) % 6;
      set(x, y, 8 + n, 8 + n, 9 + n);
    }
  }

  // descending sodium-orange tick marks, dimming with depth
  const ticks = 7;
  const w = Math.round(size * 0.34);
  const th = Math.max(2, Math.round(size * 0.028));
  for (let t = 0; t < ticks; t++) {
    const y0 = Math.round(size * (0.16 + t * 0.1));
    const fade = 1 - t / (ticks + 1.5);
    const r = Math.round(203 * fade);
    const g = Math.round(124 * fade);
    const b = Math.round(38 * fade);
    const inset = Math.round(t * size * 0.012);
    for (let dy = 0; dy < th; dy++) {
      for (let x = 0; x < w - inset; x++) {
        set(Math.round(size * 0.33) + inset + x, y0 + dy, r, g, b);
      }
    }
  }

  // the arrow head: descent terminates in a point
  const ay = Math.round(size * 0.855);
  const half = Math.round(size * 0.07);
  for (let dy = 0; dy < half; dy++) {
    for (let dx = -(half - dy); dx <= half - dy; dx++) {
      set(Math.round(size / 2) + dx, ay + dy, 46, 30, 12);
    }
  }
  return px;
}

mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  const png = encodePNG(size, drawIcon(size));
  writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), png);
  console.log(`icon-${size}.png (${png.length} bytes)`);
}
