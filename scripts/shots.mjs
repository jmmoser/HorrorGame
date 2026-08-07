// Visual iteration harness. Boots the game on a fixed seed and captures a
// fixed set of vantage points per floor, so renderer changes can be compared
// frame-for-frame. Not a test — a contact sheet.
//
//   node scripts/shots.mjs [outDir] [--floors 1,2,5] [--seed 0x...]
//
// Screenshots land in <outDir>/f<N>-<vantage>.png.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? 'scratch/shots';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const floors = flag('floors', '1,2,3,4,5').split(',').map(Number);
const SEED = Number(flag('seed', '305419896'));

await mkdir(outDir, { recursive: true });

const server = await createServer({ server: { port: 4179 }, logLevel: 'silent' });
await server.listen();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const VW = Number(flag('w', '1280'));
const VH = Number(flag('h', '720'));
const page = await browser.newPage({ viewport: { width: VW, height: VH } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

// Pin the seed by fixing the first Math.random() the fresh save draws from,
// so a run starts clean but always walks the same building.
await page.addInitScript((seed) => {
  const real = Math.random;
  let first = true;
  Math.random = () => {
    if (first) {
      first = false;
      return seed / 0x100000000;
    }
    return real();
  };
}, SEED);

const QUALITY = flag('quality', 'high');
// extra contact-sheet frames of the intermediate buffers, e.g. --views ao,vol
const VIEWS = (flag('views', '') || '').split(',').filter(Boolean);
await page.goto('http://localhost:4179/');
await page.evaluate((q) => {
  localStorage.clear();
  localStorage.setItem(
    'descent-ledger-settings-v1',
    JSON.stringify({ quality: q, adaptiveResolution: false }),
  );
}, QUALITY);
await page.reload();
await page.waitForSelector('#gate-continue');
await page.click('#gate-continue');
await page.waitForSelector('#btn-begin');
await page.click('#btn-begin');

const waitFloor = (f) =>
  page.waitForFunction(
    (n) => window.__game?.debug.state === 'play' && window.__game.debug.built?.spec.floor === n,
    f,
    { timeout: 180000 },
  );

// Vantages are chosen in-page: the elevator mouth, the longest sightline on the
// floor, and the most prop-dense cell. Picking them from the live grid keeps
// them meaningful when floors are edited.
const VANTAGE_PICKER = () => {
  const d = window.__game.debug;
  const g = d.built.grid;
  // derive the cell size from the elevator rather than hardcoding it
  const CS = g.elevator.cz / (g.elevator.cells[0][1] + 0.5);
  const walk = (x, z) => {
    const r = g.rows[z];
    const c = r && r[x];
    return !!c && c !== '#' && c !== ' ';
  };
  const center = (x, z) => ({ x: x * CS + CS / 2, z: z * CS + CS / 2 });
  const out = [];

  // 1. standing in the elevator mouth, looking out
  // camera looks down -z at yaw 0, so a heading (dx,dz) is atan2(-dx,-dz)
  const el = g.elevator;
  const outward = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[el.doorDir];
  out.push({ name: 'car', x: el.cx, z: el.cz, yaw: Math.atan2(-outward[0], -outward[1]) });

  // 2. longest unobstructed straight run — the corridor money shot
  let best = { len: -1 };
  for (let z = 0; z < g.h; z++) {
    for (let x = 0; x < g.w; x++) {
      if (!walk(x, z)) continue;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        let len = 0;
        while (walk(x + dx * (len + 1), z + dz * (len + 1))) len++;
        if (len > best.len) {
          const c = center(x, z);
          best = { len, name: 'sightline', x: c.x, z: c.z, yaw: Math.atan2(-dx, -dz) };
        }
      }
    }
  }
  if (best.len > 0) out.push(best);

  // 3. facing the densest cluster of props, from a walkable cell near it
  const anchors = Object.keys(d.built.spec.anchors);
  const props = [];
  for (let z = 0; z < g.h; z++) {
    for (let x = 0; x < g.w; x++) {
      if (anchors.includes(g.rows[z][x])) {
        const c = center(x, z);
        props.push({ x: c.x, z: c.z });
      }
    }
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  if (props.length) {
    let bestP = null;
    for (const p of props) {
      const n = props.filter((q) => dist(q, p) < 4).length;
      if (!bestP || n > bestP.n) bestP = { n, p };
    }
    const p = bestP.p;
    // back off along the axis with room
    for (const [dx, dz] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const gx = Math.floor(p.x / CS) + dx * 2;
      const gz = Math.floor(p.z / CS) + dz * 2;
      if (walk(gx, gz)) {
        const c = center(gx, gz);
        out.push({
          name: 'props',
          x: c.x,
          z: c.z,
          yaw: Math.atan2(-(p.x - c.x), -(p.z - c.z)),
        });
        break;
      }
    }
  }
  return out;
};

const last = Math.max(...floors);
for (let floor = 1; floor <= last; floor++) {
  await waitFloor(floor);
  const vantages = floors.includes(floor) ? await page.evaluate(VANTAGE_PICKER) : [];
  for (const v of vantages) {
    await page.evaluate((vv) => window.__game.debug.teleport(vv.x, vv.z, vv.yaw), v);
    // let exposure / light adaptation / dust settle
    await page.waitForTimeout(1400);
    await page.evaluate(() => {
      document.getElementById('floor-card')?.classList.add('hidden');
      document.getElementById('hud')?.classList.toggle('hidden', true);
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${outDir}/f${floor}-${v.name}.png` });
    for (const view of VIEWS) {
      await page.evaluate((vv) => window.__game.debug.setDebugView(vv), view);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${outDir}/f${floor}-${v.name}-${view}.png` });
    }
    if (VIEWS.length) await page.evaluate(() => window.__game.debug.setDebugView('none'));
  }
  if (vantages.length) console.log(`floor ${floor}: ${vantages.map((v) => v.name).join(', ')}`);
  if (floor !== last) {
    await page.evaluate(() => {
      window.__game.debug.logAllTargets();
      window.__game.debug.depart();
    });
  }
}

if (errors.length) console.error('page errors:', errors);
await browser.close();
await server.close();
console.log(`shots → ${outDir}`);
