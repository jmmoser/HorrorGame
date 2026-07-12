// Headless end-to-end smoke test. Boots the game, then uses the dev hooks
// (window.__game.debug) to play the entire vertical slice: log every
// discrepancy on all five floors, ride the elevator down each time, and land
// on the ending screen. Screenshots each floor for visual review.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 4173 } });
await server.listen();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

const waitForFloor = async (n) => {
  try {
    await page.waitForFunction(
      (f) => {
        const g = window.__game;
        return g && g.debug.state === 'play' && g.debug.built?.spec.floor === f;
      },
      n,
      { timeout: 150000 },
    );
  } catch (e) {
    const dump = await page.evaluate(async () => {
      const d1 = window.__game?.debug;
      const a = d1 ? { state: d1.state, stateT: d1.stateT, time: d1.time, floor: d1.built?.spec.floor } : 'no game';
      await new Promise((r) => setTimeout(r, 2000));
      const d2 = window.__game?.debug;
      const b = d2 ? { state: d2.state, stateT: d2.stateT, time: d2.time } : 'no game';
      return { before: a, after2s: b };
    });
    console.error(`STALLED waiting for floor ${n}:`, JSON.stringify(dump));
    console.error('page errors so far:', errors);
    await page.screenshot({ path: 'scratch/stall.png' });
    throw e;
  }
};

await page.goto('http://localhost:4173/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('#gate-continue');
await page.click('#gate-continue');
await page.waitForSelector('#btn-begin');
await page.screenshot({ path: 'scratch/shot-title.png' });
await page.click('#btn-begin');

for (let floor = 1; floor <= 5; floor++) {
  await waitForFloor(floor);
  // step out of the elevator and look around
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1800);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `scratch/floor-${floor}.png` });

  const info = await page.evaluate(() => {
    const d = window.__game.debug;
    return {
      floor: d.built.spec.floor,
      targets: d.built.targets.map((t) => t.sel.def.id),
      ledgerDisc: d.built.ledgerDisc !== undefined,
      quota: d.built.spec.quota,
      entries: d.save.ledger.length,
      alteredEntry: d.save.ledger.find((e) => e.altered)?.text ?? null,
    };
  });
  console.log(`floor ${floor}: targets=[${info.targets.join(', ')}] quota=${info.quota} entries=${info.entries}` +
    (info.alteredEntry ? ` ALTERED="${info.alteredEntry.slice(0, 60)}…"` : ''));

  // open the ledger once on floor 1 and 5 for screenshots
  if (floor === 1 || floor === 5) {
    await page.click('#ledger-tab');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `scratch/ledger-${floor}.png` });
    await page.click('#btn-close-ledger');
    await page.waitForTimeout(300);
  }

  await page.evaluate(() => window.__game.debug.logAllTargets());
  await page.waitForTimeout(600);
  const callActive = await page.evaluate(() => window.__game.debug.built.elevator.callActive);
  if (!callActive) {
    errors.push(`floor ${floor}: call button not active after logging all targets`);
    break;
  }
  await page.evaluate(() => window.__game.debug.depart());
}

// the ending
await page.waitForFunction(() => window.__game?.debug.state === 'ending', { timeout: 150000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'scratch/ending.png' });

const finalSave = await page.evaluate(() => {
  const d = window.__game.debug;
  return { entries: d.save.ledger.length, logged: d.save.logged.length, altered: d.save.ledgerAltered };
});
console.log('final save:', JSON.stringify(finalSave));

// screenshot pixel sanity: floor shots must not be pure black
import { readFileSync } from 'node:fs';
const png = readFileSync('scratch/floor-1.png');
if (png.length < 20000) errors.push('floor-1 screenshot suspiciously small (likely black)');

// resume flow: reload, expect resume button
await page.reload();
await page.click('#gate-continue');
await page.waitForSelector('#btn-resume:not(.hidden)', { timeout: 5000 }).catch(() => {
  errors.push('resume button missing after reload');
});

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
await server.close();

if (errors.length > 0 || finalSave.entries < 15 || !finalSave.altered) {
  console.error('SMOKE FAILED');
  process.exit(1);
}
console.log('SMOKE OK — full slice completed: 5 floors, ledger altered, ending reached');
process.exit(0);
