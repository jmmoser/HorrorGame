import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FloorSpec } from '../core/types';
import { hashCombine, mulberry32 } from '../core/rng';
import { PALETTES } from './palette';
import {
  CS,
  DIRS,
  applyStretch,
  buildGrid,
  cellCenter,
  charAt,
  facingToYaw,
  isWalkable,
  opposite,
  parseRows,
  type Grid,
} from './grid';
import { buildProp, type PropInstance } from './props';
import { ceilingTexture, floorTexture, puffTexture, wallTexture } from './textures';
import { selectForFloor, type SelectedDiscrepancy } from './discrepancies';

export interface ActiveTarget {
  sel: SelectedDiscrepancy;
  hit: THREE.Mesh;
  prop: PropInstance;
  logged: boolean;
  worldPos: THREE.Vector3;
}

export interface BuiltFloor {
  spec: FloorSpec;
  group: THREE.Group;
  grid: Grid;
  updatables: Array<(dt: number, time: number) => void>;
  targets: ActiveTarget[];
  /** the guaranteed anchor-less discrepancy (floor 5's altered ledger), if any */
  ledgerDiscrepancy: SelectedDiscrepancy | null;
  elevator: ElevatorRig;
  props: Map<string, PropInstance>;
  audioSpots: Array<{ kind: 'dialtone' | 'drip'; pos: THREE.Vector3 }>;
  litPositions: THREE.Vector3[];
  dispose: () => void;
}

// ------------------------------------------------------------ elevator rig

export class ElevatorRig {
  group = new THREE.Group();
  buttonHit: THREE.Mesh;
  panelHit: THREE.Mesh;
  private doorL: THREE.Mesh;
  private doorR: THREE.Mesh;
  private buttonLamp: THREE.MeshStandardMaterial;
  private carLight: THREE.PointLight;
  /** 0 closed .. 1 open */
  private openness = 1;
  private targetOpenness = 1;
  callActive = false;
  private axis: 'x' | 'z';
  private slide: number;

  constructor(grid: Grid, ceilingH: number) {
    const el = grid.elevator;
    const along: 'x' | 'z' = el.doorDir === 'n' || el.doorDir === 's' ? 'x' : 'z';
    this.axis = along;
    this.slide = el.doorW / 2 - 0.06;

    const metal = new THREE.MeshStandardMaterial({ color: 0x55524c, metalness: 0.55, roughness: 0.45 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2e2c29, metalness: 0.4, roughness: 0.6 });

    // car floor + ceiling plates
    const minX = Math.min(...el.cells.map(([x]) => x)) * CS;
    const maxX = (Math.max(...el.cells.map(([x]) => x)) + 1) * CS;
    const minZ = Math.min(...el.cells.map(([, z]) => z)) * CS;
    const maxZ = (Math.max(...el.cells.map(([, z]) => z)) + 1) * CS;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX - 0.1, 0.04, maxZ - minZ - 0.1), darkMetal);
    plate.position.set((minX + maxX) / 2, 0.02, (minZ + maxZ) / 2);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX - 0.1, 0.04, maxZ - minZ - 0.1), darkMetal);
    roof.position.set((minX + maxX) / 2, 2.25, (minZ + maxZ) / 2);
    this.group.add(plate, roof);

    // the car light: the one warm thing in the building
    this.carLight = new THREE.PointLight(0xffe6c0, 5, 6, 1.6);
    this.carLight.position.set(el.cx, 2.1, el.cz);
    this.group.add(this.carLight);
    const lightPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffe2b8, emissiveIntensity: 1.2 }),
    );
    lightPanel.rotation.x = Math.PI / 2;
    // keep clear of the roof plate's underside (y=2.23) or the two z-fight
    lightPanel.position.set(el.cx, 2.2, el.cz);
    this.group.add(lightPanel);

    // sliding doors across the opening
    const panelW = el.doorW / 2;
    const doorGeo =
      along === 'x'
        ? new THREE.BoxGeometry(panelW, 2.24, 0.09)
        : new THREE.BoxGeometry(0.09, 2.24, panelW);
    this.doorL = new THREE.Mesh(doorGeo, metal);
    this.doorR = new THREE.Mesh(doorGeo, metal.clone());
    const lintel =
      along === 'x'
        ? new THREE.BoxGeometry(el.doorW + 0.3, ceilingH - 2.24 + 0.06, 0.24)
        : new THREE.BoxGeometry(0.24, ceilingH - 2.24 + 0.06, el.doorW + 0.3);
    const lintelMesh = new THREE.Mesh(lintel, darkMetal);
    lintelMesh.position.set(el.doorX, 2.24 + (ceilingH - 2.24) / 2, el.doorZ);
    this.group.add(this.doorL, this.doorR, lintelMesh);
    this.updateDoors(0, el.doorX, el.doorZ, el.doorW / 2);

    // call button beside the opening, on the outside wall
    const outward = DIRS[el.doorDir];
    const sideways = along === 'x' ? [1, 0] : [0, 1];
    const bx = el.doorX + sideways[0] * (el.doorW / 2 + 0.35) + outward[0] * 0.14;
    const bz = el.doorZ + sideways[1] * (el.doorW / 2 + 0.35) + outward[1] * 0.14;
    const buttonPlate = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.12), darkMetal);
    buttonPlate.position.set(bx, 1.12, bz);
    this.buttonLamp = new THREE.MeshStandardMaterial({
      color: 0x1a1917,
      emissive: 0xc27b2e,
      emissiveIntensity: 0,
    });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), this.buttonLamp);
    lamp.position.set(bx + outward[0] * 0.07, 1.12, bz + outward[1] * 0.07);
    this.group.add(buttonPlate, lamp);
    this.buttonHit = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.7, 0.5),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.buttonHit.position.set(bx + outward[0] * 0.2, 1.12, bz + outward[1] * 0.2);
    this.group.add(this.buttonHit);

    // button panel inside the car (descend control)
    const px = el.cx - outward[0] * 0.2 - sideways[0] * (el.doorW / 2 - 0.35);
    const pz = el.cz - outward[1] * 0.2 - sideways[1] * (el.doorW / 2 - 0.35);
    this.panelHit = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 1.0, 0.6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.panelHit.position.set(px, 1.2, pz);
    this.group.add(this.panelHit);
  }

  setCallActive(active: boolean) {
    this.callActive = active;
    this.buttonLamp.emissiveIntensity = active ? 1.8 : 0;
  }

  openDoors() {
    this.targetOpenness = 1;
  }

  closeDoors() {
    this.targetOpenness = 0;
  }

  get doorsOpen(): boolean {
    return this.openness > 0.95;
  }

  get doorsClosed(): boolean {
    return this.openness < 0.03;
  }

  get moving(): boolean {
    return Math.abs(this.openness - this.targetOpenness) > 0.01;
  }

  updateDoors(dt: number, doorX: number, doorZ: number, panelW: number) {
    const speed = 0.55; // slow doors. everything here is slow.
    if (this.openness < this.targetOpenness) {
      this.openness = Math.min(this.targetOpenness, this.openness + dt * speed);
    } else if (this.openness > this.targetOpenness) {
      this.openness = Math.max(this.targetOpenness, this.openness - dt * speed);
    }
    const shift = panelW / 2 + this.openness * this.slide;
    if (this.axis === 'x') {
      this.doorL.position.set(doorX - shift, 1.12, doorZ);
      this.doorR.position.set(doorX + shift, 1.12, doorZ);
    } else {
      this.doorL.position.set(doorX, 1.12, doorZ - shift);
      this.doorR.position.set(doorX, 1.12, doorZ + shift);
    }
  }

  /** collision segment across the opening while doors are not fully open */
  blocker(doorX: number, doorZ: number, doorW: number): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    if (this.doorsOpen) return null;
    const t = 0.25;
    if (this.axis === 'x') {
      return { minX: doorX - doorW / 2, maxX: doorX + doorW / 2, minZ: doorZ - t, maxZ: doorZ + t };
    }
    return { minX: doorX - t, maxX: doorX + t, minZ: doorZ - doorW / 2, maxZ: doorZ + doorW / 2 };
  }
}

// ------------------------------------------------------------ floor builder

export function buildFloor(spec: FloorSpec, seed: number): BuiltFloor {
  const palette = PALETTES[spec.palette];
  const group = new THREE.Group();
  const updatables: Array<(dt: number, time: number) => void> = [];
  const disposables: Array<{ dispose: () => void }> = [];

  const selected = selectForFloor(spec, seed);
  const selectedByAnchor = new Map(
    selected.filter((s) => s.def.anchor).map((s) => [s.def.anchor, s]),
  );
  const ledgerDiscrepancy = selected.find((s) => s.def.type === 'ledger-altered') ?? null;
  // light-burning: the impossible light must be the ONLY one burning up here,
  // or the entry ("the building has had no power since 1996") reads as noise
  const burningLight = selected.find((s) => s.def.type === 'light-burning') ?? null;

  // long-hallway: the map itself is longer than the blueprint says
  const stretchActive = selected.some((s) => s.def.type === 'long-hallway');
  const baseRows = parseRows(spec.map);
  const rows = stretchActive ? applyStretch(baseRows, spec.stretch) : baseRows;
  const grid = buildGrid(rows);
  const H = spec.ceilingHeight;

  // ---- surfaces
  const wallTex = wallTexture(palette, seed + spec.floor);
  const floorTex = floorTexture(palette, seed + spec.floor);
  const ceilTex = ceilingTexture(palette, seed + spec.floor);
  floorTex.repeat.set(grid.w, grid.h);
  ceilTex.repeat.set(grid.w / 2, grid.h / 2);
  disposables.push(wallTex, floorTex, ceilTex);

  const floorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(grid.w * CS, grid.h * CS),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.96 }),
  );
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.set((grid.w * CS) / 2, 0, (grid.h * CS) / 2);
  const ceilMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(grid.w * CS, grid.h * CS),
    new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.95 }),
  );
  ceilMesh.rotation.x = Math.PI / 2;
  ceilMesh.position.set((grid.w * CS) / 2, H, (grid.h * CS) / 2);
  group.add(floorMesh, ceilMesh);

  // ---- walls: one merged mesh of boxes for every wall cell that faces air
  const wallGeos: THREE.BufferGeometry[] = [];
  for (let z = 0; z < grid.h; z++) {
    for (let x = 0; x < grid.w; x++) {
      if (rows[z][x] !== '#') continue;
      let exposed = false;
      for (const [dx, dz] of Object.values(DIRS)) {
        if (isWalkable(charAt(rows, x + dx, z + dz))) exposed = true;
      }
      if (!exposed) continue;
      const g = new THREE.BoxGeometry(CS, H, CS);
      const c = cellCenter(x, z);
      g.translate(c.x, H / 2, c.z);
      wallGeos.push(g);
    }
  }
  const wallsGeo = mergeGeometries(wallGeos);
  const walls = new THREE.Mesh(
    wallsGeo,
    new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.94 }),
  );
  group.add(walls);
  disposables.push(wallsGeo);
  wallGeos.forEach((g) => g.dispose());

  // ---- props
  const props = new Map<string, PropInstance>();
  const targets: ActiveTarget[] = [];
  const audioSpots: BuiltFloor['audioSpots'] = [];
  const litPositions: THREE.Vector3[] = [];
  const WALL_MOUNTED = new Set(['door', 'window', 'roomplate', 'clock', 'calendar', 'sink']);

  for (const [letter, anchor] of Object.entries(spec.anchors)) {
    let cx = -1;
    let cz = -1;
    for (let z = 0; z < grid.h; z++) {
      const x = rows[z].indexOf(letter);
      if (x >= 0) {
        cx = x;
        cz = z;
        break;
      }
    }
    if (cx < 0) continue;
    const sel = selectedByAnchor.get(letter);
    const wrong = sel !== undefined;
    if (anchor.absentWhenNormal && !wrong) continue;

    const propSeed = hashCombine(seed, spec.floor * 100000 + letter.charCodeAt(0));
    let effectiveAnchor =
      anchor.wrongLabel !== undefined && wrong ? { ...anchor, label: anchor.wrongLabel } : anchor;
    if (anchor.role === 'light' && burningLight && burningLight.def.anchor !== letter) {
      effectiveAnchor = { ...effectiveAnchor, lit: false, flicker: false };
    }
    const prop = buildProp({
      palette,
      rng: mulberry32(propSeed),
      seed: propSeed,
      wrong,
      anchor: effectiveAnchor,
    });

    const c = cellCenter(cx, cz);
    const yaw = facingToYaw(anchor.facing);
    if (anchor.role === 'light') {
      prop.group.position.set(c.x, H - 0.06, c.z);
    } else if (WALL_MOUNTED.has(anchor.role)) {
      const back = DIRS[opposite(anchor.facing)];
      prop.group.position.set(c.x + back[0] * (CS / 2 - 0.01), 0, c.z + back[1] * (CS / 2 - 0.01));
    } else {
      prop.group.position.set(c.x, 0, c.z);
    }
    prop.group.rotation.y = yaw;
    group.add(prop.group);
    props.set(letter, prop);
    if (prop.update) updatables.push(prop.update);
    if (prop.light) {
      const p = new THREE.Vector3();
      prop.group.updateMatrixWorld();
      p.setFromMatrixPosition(prop.group.matrixWorld);
      litPositions.push(p);
    }
    if (prop.audioKind && wrong) {
      const p = new THREE.Vector3(c.x, 1.0, c.z);
      audioSpots.push({ kind: prop.audioKind, pos: p });
    }
    if (sel && prop.hit) {
      targets.push({
        sel,
        hit: prop.hit,
        prop,
        logged: false,
        worldPos: new THREE.Vector3(c.x, 1.2, c.z),
      });
    }
  }

  // ---- dust motes drifting under the lit fixtures
  if (litPositions.length > 0) {
    const tex = puffTexture();
    const motes: THREE.Sprite[] = [];
    const rng = mulberry32(hashCombine(seed, spec.floor * 31));
    for (const lp of litPositions) {
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.05 + rng() * 0.05, depthWrite: false }),
        );
        s.scale.setScalar(0.05 + rng() * 0.08);
        s.position.set(lp.x + (rng() - 0.5) * 1.6, lp.y - 0.3 - rng() * 1.2, lp.z + (rng() - 0.5) * 1.6);
        s.userData.base = s.position.clone();
        s.userData.ph = rng() * 10;
        group.add(s);
        motes.push(s);
      }
    }
    updatables.push((_dt, time) => {
      for (const m of motes) {
        const b = m.userData.base as THREE.Vector3;
        const ph = m.userData.ph as number;
        m.position.set(
          b.x + Math.sin(time * 0.13 + ph) * 0.3,
          b.y + Math.sin(time * 0.07 + ph * 2) * 0.25,
          b.z + Math.cos(time * 0.1 + ph) * 0.3,
        );
      }
    });
  }

  // ---- elevator
  const elevator = new ElevatorRig(grid, H);
  group.add(elevator.group);

  return {
    spec,
    group,
    grid,
    updatables,
    targets,
    ledgerDiscrepancy,
    elevator,
    props,
    audioSpots,
    litPositions,
    dispose: () => {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
          o.geometry?.dispose?.();
          const m = (o as THREE.Mesh).material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose?.();
        }
      });
      disposables.forEach((d) => d.dispose());
    },
  };
}

/** grid + elevator-door collision for the player capsule */
export function makeCollider(built: BuiltFloor) {
  const { grid, elevator } = built;
  const el = grid.elevator;
  return (x: number, z: number, r: number): { x: number; z: number } => {
    let px = x;
    let pz = z;
    // resolve against wall cells around the player
    const cx = Math.floor(px / CS);
    const cz = Math.floor(pz / CS);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ch = charAt(grid.rows, cx + dx, cz + dz);
        if (isWalkable(ch)) continue;
        const minX = (cx + dx) * CS;
        const maxX = minX + CS;
        const minZ = (cz + dz) * CS;
        const maxZ = minZ + CS;
        const nx = Math.max(minX, Math.min(px, maxX));
        const nz = Math.max(minZ, Math.min(pz, maxZ));
        const ddx = px - nx;
        const ddz = pz - nz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < r * r && d2 > 1e-9) {
          const d = Math.sqrt(d2);
          px = nx + (ddx / d) * r;
          pz = nz + (ddz / d) * r;
        } else if (d2 <= 1e-9) {
          // player center inside the box: push out along smallest axis
          px += r;
        }
      }
    }
    // elevator doors
    const b = elevator.blocker(el.doorX, el.doorZ, el.doorW);
    if (b) {
      const nx = Math.max(b.minX, Math.min(px, b.maxX));
      const nz = Math.max(b.minZ, Math.min(pz, b.maxZ));
      const ddx = px - nx;
      const ddz = pz - nz;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < r * r && d2 > 1e-9) {
        const d = Math.sqrt(d2);
        px = nx + (ddx / d) * r;
        pz = nz + (ddz / d) * r;
      }
    }
    return { x: px, z: pz };
  };
}
