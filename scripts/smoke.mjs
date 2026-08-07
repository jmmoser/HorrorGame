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

  // floor 1 also exercises the judgment systems: a mundane log, a notice
  // transcription, and an amendment on a building-altered prop
  if (floor === 1) {
    const extras = await page.evaluate(() => {
      const d = window.__game.debug;
      d.logMundane();
      d.logNotice();
      d.applyAlteration('v', 'door-ajar');
      d.logAmend();
      const kinds = d.save.ledger.map((e) => e.kind ?? 'discrepancy');
      return { kinds, attention: d.attention(), amendables: d.amendTargets().length };
    });
    console.log(`floor 1 extras: kinds=[${extras.kinds.join(', ')}] attention=${extras.attention.toFixed(2)}`);
    for (const want of ['mundane', 'notice', 'amend']) {
      if (!extras.kinds.includes(want)) errors.push(`floor 1: missing ${want} entry after debug drive`);
    }
    if (!(extras.attention > 0)) errors.push('floor 1: attention did not rise');

    // collision: a solid prop has to stop the walk — position AND stride.
    // walking on the spot against a desk kept the footsteps playing once.
    const bump = await page.evaluate(async () => {
      const d = window.__game.debug;
      const ob = d.built.obstacles[0];
      // stand just short of the box and push straight into it
      d.teleport((ob.minX + ob.maxX) / 2, ob.minZ - 0.6, 0);
      d.player.frozen = false;
      let steps = 0;
      const prev = d.player.onStep;
      d.player.onStep = () => steps++;
      const from = { x: d.player.pos.x, z: d.player.pos.y };
      const t0 = performance.now();
      while (performance.now() - t0 < 1500) {
        window.__game.controls.move.x = 0;
        window.__game.controls.move.y = -1;
        await new Promise((r) => requestAnimationFrame(r));
      }
      window.__game.controls.move.x = 0;
      window.__game.controls.move.y = 0;
      d.player.onStep = prev;
      const moved = Math.hypot(d.player.pos.x - from.x, d.player.pos.y - from.z);
      return { moved, steps, speed: d.player.speed01 };
    });
    console.log(
      `floor 1 collision: pushed into prop, moved=${bump.moved.toFixed(2)}m ` +
        `steps=${bump.steps} speed=${bump.speed.toFixed(2)}`,
    );
    if (bump.moved > 0.7) errors.push('floor 1: player walked through a solid prop');
    if (bump.speed > 0.15) errors.push('floor 1: player still "walking" while blocked by a prop');
    if (bump.steps > 1) errors.push(`floor 1: ${bump.steps} footsteps while blocked by a prop`);

    // the hand: every door offers a verb, and the building takes back
    // whatever the inspector sets right
    const hand = await page.evaluate(async () => {
      const d = window.__game.debug;
      const doors = d.hands().filter((h) => h.role === 'door');
      const chair = d.hands().find((h) => h.role === 'chair');
      d.applyAlteration('A', 'chair-turned');
      const chairActions = d.hands().find((h) => h.anchor === 'A')?.actions ?? [];
      d.hand('A', 'turn-chair');
      const afterTurn = d.hands().find((h) => h.anchor === 'A')?.actions ?? [];
      d.hand('v', 'knock');
      return {
        doors: doors.length,
        doorVerbs: doors[0]?.actions ?? [],
        chairFound: !!chair,
        chairActions,
        afterTurn,
      };
    });
    console.log(
      `floor 1 hand: ${hand.doors} doors, verbs=[${hand.doorVerbs.join(', ')}], ` +
        `turned chair offered [${hand.chairActions.join(', ')}] → [${hand.afterTurn.join(', ')}]`,
    );
    if (hand.doors === 0) errors.push('floor 1: no doors offered a hand verb');
    if (!hand.doorVerbs.includes('knock')) errors.push('floor 1: a door did not offer knock');
    if (!hand.chairActions.includes('turn-chair')) {
      errors.push('floor 1: a turned chair did not offer to be turned back');
    }
    if (hand.afterTurn.length !== 0) errors.push('floor 1: chair still offers turn-back after being turned back');

    // the lamp, dark adaptation, and the writing that is only there in the dark
    const dark = await page.evaluate(async () => {
      const d = window.__game.debug;
      const before = d.marks();
      d.setLamp(false);
      d.setDarkAdapt(1);
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      d.logMark();
      const after = d.marks();
      d.setLamp(true);
      return {
        count: before.length,
        loggedBefore: before.filter((m) => m.logged).length,
        loggedAfter: after.filter((m) => m.logged).length,
        kinds: d.save.ledger.map((e) => e.kind ?? 'discrepancy'),
      };
    });
    console.log(`floor 1 dark: ${dark.count} mark(s), transcribed ${dark.loggedBefore} → ${dark.loggedAfter}`);
    if (dark.count === 0) errors.push('floor 1: no dark-only writing on the floor');
    if (dark.loggedAfter !== 1) errors.push('floor 1: dark-only writing was not transcribable');

    // the ledger is not safe: the building rewrites an entry, and noticing it
    // is worth an amendment
    const revised = await page.evaluate(() => {
      const d = window.__game.debug;
      d.reviseLedger();
      const altered = d.save.ledger.filter((e) => e.altered);
      const before = d.save.ledger.length;
      d.logRevision();
      return {
        altered: altered.length,
        text: altered[0]?.text?.slice(0, 70) ?? null,
        grew: d.save.ledger.length - before,
      };
    });
    console.log(`floor 1 ledger: ${revised.altered} altered, amended=${revised.grew}` +
      (revised.text ? ` "${revised.text}…"` : ''));
    if (revised.altered === 0) errors.push('floor 1: the building never rewrote an entry');

    // the occupant: placed only where the camera is not, removed the same way
    const occ = await page.evaluate(async () => {
      const d = window.__game.debug;
      d.summonPresence();
      const seenAt = [];
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const p = d.presence();
        if (p?.present) {
          seenAt.push(p.currentForm);
          break;
        }
      }
      return { appeared: seenAt.length > 0, form: seenAt[0] ?? null };
    });
    console.log(`floor 1 occupant: appeared=${occ.appeared} form=${occ.form}`);
    if (!occ.appeared) errors.push('floor 1: the occupant never took the floor');
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
