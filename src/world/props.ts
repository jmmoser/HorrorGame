import * as THREE from 'three';
import type { AnchorDef, Palette } from '../core/types';
import type { Rng } from '../core/rng';
import {
  calendarTexture,
  clockFaceTexture,
  doorTexture,
  footprintTexture,
  paperTexture,
  puffTexture,
  roomPlateTexture,
  windowTexture,
} from './textures';

// Props are built from primitives and canvas textures. Each wrongable role has
// a normal variant (the world as it should be) and a wrong variant (the
// discrepancy). The difference is always small. That is the point.

export interface PropInstance {
  group: THREE.Group;
  update?: (dt: number, time: number) => void;
  /** invisible raycast target when this prop is a loggable discrepancy */
  hit?: THREE.Mesh;
  /** silent post-log floor mutation */
  applyAlteration?: (kind: 'door-ajar' | 'light-off' | 'light-on' | 'chair-turned') => void;
  light?: THREE.PointLight;
  audioKind?: 'dialtone' | 'drip';
}

export interface PropContext {
  palette: Palette;
  rng: Rng;
  seed: number;
  wrong: boolean;
  anchor: AnchorDef;
}

function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.04, ...opts });
}

function hitbox(w: number, h: number, d: number, y = h / 2): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  m.position.y = y;
  m.name = 'hitbox';
  return m;
}

function steamColumn(count: number, speed: number, size: number, opacity: number) {
  const tex = puffTexture();
  const sprites: THREE.Sprite[] = [];
  const grp = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }),
    );
    s.scale.setScalar(size);
    grp.add(s);
    sprites.push(s);
  }
  const update = (_dt: number, time: number) => {
    sprites.forEach((s, i) => {
      const t = (time * speed + i / count) % 1;
      s.position.y = t * 0.5;
      s.position.x = Math.sin((time + i * 7) * 1.3) * 0.02;
      (s.material as THREE.SpriteMaterial).opacity = opacity * Math.sin(t * Math.PI);
      s.scale.setScalar(size * (0.6 + t));
    });
  };
  return { grp, update };
}

// ---------------------------------------------------------------- furniture

function buildDesk(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const wood = mat(0x4d4234);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.75), wood);
  top.position.y = 0.74;
  const sideGeo = new THREE.BoxGeometry(0.05, 0.72, 0.7);
  const l = new THREE.Mesh(sideGeo, wood);
  l.position.set(-0.7, 0.36, 0);
  const r = new THREE.Mesh(sideGeo, wood);
  r.position.set(0.7, 0.36, 0);
  g.add(top, l, r);
  if (ctx.rng() > 0.4) {
    const blotter = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.008, 0.3),
      mat(0x35332c),
    );
    blotter.position.set((ctx.rng() - 0.5) * 0.5, 0.77, 0.05);
    g.add(blotter);
  }
  return { group: g };
}

function buildChair(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const m0 = mat(0x3b382f);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.44), m0);
  seat.position.y = 0.45;
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.5, 0.05), m0);
  back.position.set(0, 0.72, -0.2);
  const legGeo = new THREE.BoxGeometry(0.035, 0.45, 0.035);
  g.add(seat, back);
  for (const [x, z] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) {
    const leg = new THREE.Mesh(legGeo, m0);
    leg.position.set(x, 0.225, z);
    g.add(leg);
  }
  g.rotation.y = (ctx.rng() - 0.5) * 0.9;
  const inner = g;
  return {
    group: g,
    applyAlteration: (kind) => {
      // turned to face the door the player came through — discovered, never seen
      if (kind === 'chair-turned') inner.rotation.y += Math.PI;
    },
  };
}

function buildCabinet(): PropInstance {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.35, 0.5), mat(0x5d5a50, { metalness: 0.25, roughness: 0.6 }));
  body.position.y = 0.675;
  g.add(body);
  const handle = new THREE.BoxGeometry(0.16, 0.02, 0.02);
  for (let i = 0; i < 4; i++) {
    const h = new THREE.Mesh(handle, mat(0x2c2a24, { metalness: 0.5, roughness: 0.4 }));
    h.position.set(0, 0.3 + i * 0.31, 0.26);
    g.add(h);
  }
  return { group: g };
}

function buildShelf(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const frame = mat(0x4a463c);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 2.0, 0.36), frame);
  body.position.y = 1.0;
  g.add(body);
  const boxGeo = new THREE.BoxGeometry(0.2, 0.26, 0.3);
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 4; i++) {
      if (ctx.rng() > 0.62) continue;
      const b = new THREE.Mesh(boxGeo, mat(0x6a5c44));
      b.position.set(-0.36 + i * 0.24, 0.36 + s * 0.44, 0.05);
      g.add(b);
    }
  }
  return { group: g };
}

function buildBench(): PropInstance {
  const g = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.45), mat(0x51452f));
  seat.position.y = 0.42;
  const legGeo = new THREE.BoxGeometry(0.06, 0.42, 0.4);
  const l = new THREE.Mesh(legGeo, mat(0x38322a));
  l.position.set(-0.7, 0.21, 0);
  const r = new THREE.Mesh(legGeo, mat(0x38322a));
  r.position.set(0.7, 0.21, 0);
  g.add(seat, l, r);
  return { group: g };
}

function buildCart(): PropInstance {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.55, 0.45), mat(0x6a6a62, { metalness: 0.3, roughness: 0.55 }));
  body.position.y = 0.5;
  g.add(body);
  const wheelGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.04, 8);
  for (const [x, z] of [[-0.3, -0.16], [0.3, -0.16], [-0.3, 0.16], [0.3, 0.16]]) {
    const w = new THREE.Mesh(wheelGeo, mat(0x1f1e1a));
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.07, z);
    g.add(w);
  }
  return { group: g };
}

// ------------------------------------------------------------ wall-mounted

function buildDoor(ctx: PropContext): PropInstance {
  // decorative door set into the wall face. behind it: nothing, ever.
  const g = new THREE.Group();
  const frameM = mat(ctx.palette.trim);
  const jamb = new THREE.BoxGeometry(0.09, 2.12, 0.1);
  const l = new THREE.Mesh(jamb, frameM);
  l.position.set(-0.51, 1.06, 0.03);
  const r = new THREE.Mesh(jamb, frameM);
  r.position.set(0.51, 1.06, 0.03);
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.11, 0.09, 0.1), frameM);
  head.position.set(0, 2.16, 0.03);
  const slabPivot = new THREE.Group();
  slabPivot.position.set(-0.465, 0, 0.02);
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(0.93, 2.06, 0.05),
    new THREE.MeshStandardMaterial({ map: doorTexture(ctx.palette, ctx.seed), roughness: 0.85 }),
  );
  slab.position.set(0.465, 1.06, 0);
  slabPivot.add(slab);
  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 8, 6),
    mat(0x8a8578, { metalness: 0.6, roughness: 0.35 }),
  );
  knob.position.set(0.82, 1.02, 0.06);
  slabPivot.add(knob);
  // the void behind the door, revealed only if the building opens it
  const voidPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 2.08),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  voidPlane.position.set(0, 1.05, -0.01);
  voidPlane.visible = false;
  g.add(l, r, head, slabPivot, voidPlane);
  const hit = hitbox(1.1, 2.2, 0.5, 1.05);
  hit.position.z = 0.2;
  g.add(hit);
  return {
    group: g,
    hit,
    applyAlteration: (kind) => {
      if (kind === 'door-ajar') {
        slabPivot.rotation.y = -0.62;
        voidPlane.visible = true;
      }
    },
  };
}

function buildWindow(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const mood = ctx.wrong ? 'daylight' : ctx.palette.windowMood;
  const frameM = mat(0x2b2822, { roughness: 0.7 });
  const side = new THREE.BoxGeometry(0.07, 1.5, 0.12);
  const l = new THREE.Mesh(side, frameM);
  l.position.set(-0.62, 1.55, 0.02);
  const r = new THREE.Mesh(side, frameM);
  r.position.set(0.62, 1.55, 0.02);
  const bar = new THREE.BoxGeometry(1.31, 0.07, 0.12);
  const top = new THREE.Mesh(bar, frameM);
  top.position.set(0, 2.28, 0.02);
  const bottom = new THREE.Mesh(bar, frameM);
  bottom.position.set(0, 0.82, 0.02);
  const mid = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.44, 0.06), frameM);
  mid.position.set(0, 1.55, 0.03);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(1.22, 1.42),
    new THREE.MeshBasicMaterial({ map: windowTexture(mood, ctx.seed), toneMapped: false }),
  );
  glass.position.set(0, 1.55, 0.005);
  // daylight leaks: wrong windows softly light the room in front of them
  if (ctx.wrong) {
    const leak = new THREE.PointLight(0xcfd8cf, 3.2, 5.5, 2);
    leak.position.set(0, 1.6, 0.7);
    g.add(leak);
  }
  g.add(l, r, top, bottom, mid, glass);
  const hit = hitbox(1.4, 1.7, 0.6, 1.55);
  hit.position.z = 0.25;
  g.add(hit);
  return { group: g, hit };
}

function buildRoomPlate(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.17),
    new THREE.MeshStandardMaterial({
      map: roomPlateTexture(ctx.anchor.label ?? '000', ctx.seed),
      roughness: 0.6,
      metalness: 0.2,
    }),
  );
  plate.position.set(0, 1.62, 0.012);
  g.add(plate);
  const hit = hitbox(0.5, 0.4, 0.4, 1.62);
  hit.position.z = 0.18;
  g.add(hit);
  return { group: g, hit };
}

function buildClock(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 0.06, 24),
    mat(0x33302a, { metalness: 0.3, roughness: 0.5 }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.set(0, 1.95, 0.03);
  const face = new THREE.Mesh(
    new THREE.CircleGeometry(0.21, 24),
    new THREE.MeshStandardMaterial({ map: clockFaceTexture(ctx.seed), roughness: 0.8 }),
  );
  face.position.set(0, 1.95, 0.065);
  const handM = mat(0x1a1813);
  const hour = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.11, 0.008), handM);
  hour.geometry.translate(0, 0.05, 0);
  hour.position.set(0, 1.95, 0.07);
  const minute = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.17, 0.008), handM);
  minute.geometry.translate(0, 0.08, 0);
  minute.position.set(0, 1.95, 0.075);
  // stopped at 4:17 for thirty years — unless it isn't
  hour.rotation.z = -((4 + 17 / 60) / 12) * Math.PI * 2;
  minute.rotation.z = -(17 / 60) * Math.PI * 2;
  g.add(rim, face, hour, minute);
  const hit = hitbox(0.6, 0.6, 0.5, 1.95);
  hit.position.z = 0.2;
  g.add(hit);
  const update = ctx.wrong
    ? (_dt: number, time: number) => {
        // running backward, slightly too fast to be a clock
        minute.rotation.z = (time * 0.11) % (Math.PI * 2);
        hour.rotation.z = (time * 0.011) % (Math.PI * 2);
      }
    : undefined;
  return { group: g, hit, update };
}

function buildCalendar(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const page = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.46),
    new THREE.MeshStandardMaterial({ map: calendarTexture(ctx.wrong, ctx.seed), roughness: 0.9 }),
  );
  page.position.set(0, 1.55, 0.012);
  g.add(page);
  const hit = hitbox(0.5, 0.7, 0.45, 1.55);
  hit.position.z = 0.2;
  g.add(hit);
  return { group: g, hit };
}

function buildLightFixture(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const lit = ctx.wrong || ctx.anchor.lit === true;
  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(1.25, 0.09, 0.32),
    mat(0x3f3d36, { metalness: 0.3, roughness: 0.5 }),
  );
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(1.15, 0.24),
    new THREE.MeshStandardMaterial({
      color: 0x111111,
      emissive: ctx.palette.fixture,
      emissiveIntensity: lit ? 1.6 : 0.0,
      roughness: 0.4,
    }),
  );
  panel.rotation.x = Math.PI / 2;
  panel.position.y = -0.05;
  g.add(housing, panel);
  let light: THREE.PointLight | undefined;
  if (lit) {
    light = new THREE.PointLight(ctx.palette.lamp, ctx.palette.lampIntensity, 11, 1.8);
    light.position.y = -0.4;
    g.add(light);
  }
  let update: PropInstance['update'];
  if (lit && ctx.anchor.flicker) {
    const baseI = light!.intensity;
    update = (_dt, time) => {
      // irregular fluorescent stutter — never a hard cut to black
      const n =
        Math.sin(time * 31.7) * Math.sin(time * 8.9 + 2.0) > 0.86
          ? 0.35 + 0.3 * Math.sin(time * 87)
          : 1;
      light!.intensity = baseI * n;
      (panel.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.6 * n;
    };
  }
  const hit = ctx.wrong ? hitbox(1.4, 0.8, 0.8, -0.2) : undefined;
  if (hit) g.add(hit);
  return {
    group: g,
    hit,
    light,
    update,
    applyAlteration: (kind) => {
      if (kind === 'light-off') {
        if (light) light.intensity = 0;
        (panel.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
        update = undefined;
      }
      if (kind === 'light-on') {
        if (light) light.intensity = ctx.palette.lampIntensity;
        (panel.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.6;
      }
    },
  };
}

// ------------------------------------------------------------- desk things

/** small table under desk-top props so they never float */
function sideTable(g: THREE.Group) {
  const wood = mat(0x453b2e);
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.045, 0.55), wood);
  top.position.y = 0.745;
  g.add(top);
  const legGeo = new THREE.BoxGeometry(0.045, 0.72, 0.045);
  for (const [x, z] of [[-0.31, -0.22], [0.31, -0.22], [-0.31, 0.22], [0.31, 0.22]]) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(x, 0.36, z);
    g.add(leg);
  }
}

function buildCoffee(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  sideTable(g);
  // sits on the table surface: origin at floor, cup at table height
  const y = 0.77;
  const cup = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.038, 0.1, 12),
    mat(ctx.wrong ? 0xb9b4a6 : 0x847e6f),
  );
  cup.position.set(0, y + 0.05, 0);
  g.add(cup);
  let update: PropInstance['update'];
  if (ctx.wrong) {
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(0.038, 12),
      new THREE.MeshStandardMaterial({ color: 0x1d1208, roughness: 0.25 }),
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(0, y + 0.096, 0);
    g.add(fill);
    const steam = steamColumn(3, 0.35, 0.09, 0.4);
    steam.grp.position.set(0, y + 0.12, 0);
    g.add(steam.grp);
    update = steam.update;
  } else {
    // thirty-year-old dust ring beside an empty mug
    cup.rotation.z = 0.12;
  }
  const hit = hitbox(0.45, 0.5, 0.45, y + 0.1);
  g.add(hit);
  return { group: g, hit, update };
}

function buildPhone(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  sideTable(g);
  const y = 0.77;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.09, 0.17), mat(0x27251f));
  base.position.set(0, y + 0.045, 0);
  g.add(base);
  const handset = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.045, 0.055), mat(0x2d2b24));
  if (ctx.wrong) {
    // off the hook, laid carefully beside the base. facing up.
    handset.position.set(0.22, y + 0.025, 0.04);
    handset.rotation.y = 0.5;
  } else {
    handset.position.set(0, y + 0.11, 0);
  }
  g.add(handset);
  const hit = hitbox(0.55, 0.5, 0.5, y + 0.1);
  g.add(hit);
  return { group: g, hit, audioKind: ctx.wrong ? 'dialtone' : undefined };
}

function buildPlant(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.26, 10), mat(0x5a4632));
  pot.position.y = 0.13;
  g.add(pot);
  const leafM = mat(ctx.wrong ? 0x2e5c33 : 0x4a3d28, { roughness: 0.85 });
  for (let i = 0; i < 6; i++) {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.5 + ctx.rng() * 0.3, 5), leafM);
    const a = (i / 6) * Math.PI * 2;
    leaf.position.set(Math.cos(a) * 0.07, 0.45, Math.sin(a) * 0.07);
    leaf.rotation.set(Math.cos(a) * (ctx.wrong ? 0.35 : 0.8), 0, Math.sin(a) * (ctx.wrong ? 0.35 : 0.8));
    g.add(leaf);
  }
  const hit = hitbox(0.5, 1.0, 0.5);
  g.add(hit);
  return { group: g, hit };
}

function buildPaper(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  sideTable(g);
  const y = 0.77;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.13, 0.3), mat(0x35332c, { metalness: 0.25, roughness: 0.55 }));
  body.position.set(0, y + 0.065, 0);
  g.add(body);
  const page = new THREE.Mesh(
    new THREE.PlaneGeometry(0.2, 0.26),
    new THREE.MeshStandardMaterial({
      map: paperTexture(ctx.wrong, ctx.seed),
      roughness: 0.95,
      side: THREE.DoubleSide,
    }),
  );
  page.position.set(0, y + 0.24, -0.1);
  page.rotation.x = -0.28;
  g.add(page);
  const hit = hitbox(0.55, 0.6, 0.5, y + 0.15);
  g.add(hit);
  return { group: g, hit };
}

function buildAshtray(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  sideTable(g);
  const y = 0.77;
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.03, 12), mat(0x4f4c44, { metalness: 0.3, roughness: 0.4 }));
  dish.position.set(0, y + 0.015, 0);
  g.add(dish);
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.06, 6), mat(ctx.wrong ? 0xd8d2c2 : 0x8f887a));
  butt.rotation.z = Math.PI / 2.3;
  butt.position.set(0.03, y + 0.04, 0);
  g.add(butt);
  let update: PropInstance['update'];
  if (ctx.wrong) {
    const ember = new THREE.Mesh(
      new THREE.SphereGeometry(0.007, 6, 4),
      new THREE.MeshStandardMaterial({ color: 0x1a0a04, emissive: 0xc2521e, emissiveIntensity: 1.4 }),
    );
    ember.position.set(0.058, y + 0.028, 0);
    g.add(ember);
    const smoke = steamColumn(4, 0.12, 0.07, 0.3);
    smoke.grp.position.set(0.055, y + 0.05, 0);
    g.add(smoke.grp);
    const sUpd = smoke.update;
    update = (dt, time) => {
      sUpd(dt, time);
      (ember.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.0 + 0.6 * Math.sin(time * 2.4);
    };
  }
  const hit = hitbox(0.45, 0.45, 0.45, y + 0.08);
  g.add(hit);
  return { group: g, hit, update };
}

function buildSink(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  const basin = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.42), mat(0x9c988c, { metalness: 0.15, roughness: 0.5 }));
  basin.position.set(0, 0.85, 0.24);
  const tap = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.24, 8), mat(0x77746a, { metalness: 0.6, roughness: 0.35 }));
  tap.position.set(0, 1.05, 0.16);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.14, 8), mat(0x77746a, { metalness: 0.6, roughness: 0.35 }));
  spout.rotation.x = Math.PI / 2;
  spout.position.set(0, 1.16, 0.23);
  g.add(basin, tap, spout);
  if (ctx.wrong) {
    // the stain is fresh. the water ran recently. the water still runs.
    const stain = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 12),
      new THREE.MeshStandardMaterial({ color: 0x201a12, roughness: 0.3, transparent: true, opacity: 0.75 }),
    );
    stain.rotation.x = -Math.PI / 2;
    stain.position.set(0, 0.012, 0.4);
    g.add(stain);
  }
  const hit = hitbox(0.7, 0.7, 0.7, 0.9);
  hit.position.z = 0.25;
  g.add(hit);
  return { group: g, hit, audioKind: ctx.wrong ? 'drip' : undefined };
}

function buildFootprints(ctx: PropContext): PropInstance {
  const g = new THREE.Group();
  if (!ctx.wrong) return { group: g }; // undisturbed dust
  const tex = footprintTexture();
  const stepGeo = new THREE.PlaneGeometry(0.11, 0.28);
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  // a walk that starts nowhere and stops mid-room
  let x = 0;
  let z = 1.6;
  let heading = -0.15 + ctx.rng() * 0.3;
  for (let i = 0; i < 9; i++) {
    const p = new THREE.Mesh(stepGeo, m);
    p.rotation.x = -Math.PI / 2;
    p.rotation.z = -heading + (i % 2 === 0 ? 0.08 : -0.08);
    p.position.set(x + (i % 2 === 0 ? -0.11 : 0.11), 0.012 + i * 0.0002, z);
    g.add(p);
    x += Math.sin(heading) * 0.36;
    z -= Math.cos(heading) * 0.36;
    heading += (ctx.rng() - 0.5) * 0.22;
  }
  const hit = hitbox(1.4, 0.7, 2.6, 0.3);
  hit.position.z = 0.6;
  g.add(hit);
  return { group: g, hit };
}

function buildInvisibleTarget(): PropInstance {
  const g = new THREE.Group();
  const hit = hitbox(1.9, 2.3, 1.2, 1.15);
  g.add(hit);
  return { group: g, hit };
}

// ------------------------------------------------------------------ factory

export function buildProp(ctx: PropContext): PropInstance {
  switch (ctx.anchor.role) {
    case 'desk': return buildDesk(ctx);
    case 'chair': return buildChair(ctx);
    case 'cabinet': return buildCabinet();
    case 'shelf': return buildShelf(ctx);
    case 'bench': return buildBench();
    case 'cart': return buildCart();
    case 'door': return buildDoor(ctx);
    case 'window': return buildWindow(ctx);
    case 'roomplate': return buildRoomPlate(ctx);
    case 'light': return buildLightFixture(ctx);
    case 'clock': return buildClock(ctx);
    case 'calendar': return buildCalendar(ctx);
    case 'coffee': return buildCoffee(ctx);
    case 'phone': return buildPhone(ctx);
    case 'plant': return buildPlant(ctx);
    case 'paper': return buildPaper(ctx);
    case 'ashtray': return buildAshtray(ctx);
    case 'sink': return buildSink(ctx);
    case 'footprints': return buildFootprints(ctx);
    case 'stretchmark':
    case 'twinroom':
      return buildInvisibleTarget();
  }
}
