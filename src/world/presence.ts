import * as THREE from 'three';
import { CS, cellCenter, charAt, isWalkable, type Grid } from './grid';
import type { Rng } from '../core/rng';

// THE OCCUPANT.
//
// The building has been empty for thirty years. It is not empty now, and it
// has never once been caught arriving. Every rule below exists to keep that
// true:
//
//   - it is only ever placed where the camera cannot see it, and it is only
//     ever removed where the camera cannot see it. It does not fade in. It
//     does not walk. You turn, and the corridor is not the corridor you left.
//   - it never approaches. If the inspector walks toward it, it is simply not
//     there by the time they arrive — resolved off-screen, like everything
//     else in this building.
//   - it never touches, never chases, never ends the inspection. There is no
//     failure state here. There is only the record, and what gets into it.
//   - the longer it is held in view the less of it there is. Look too long and
//     you lose it, the way you lose a word you have said too many times.
//
// Two forms. Below the halfway mark it has no body at all: an occluder with
// colour writes off, so the only thing in the frame is a second shadow with
// nothing at the top of it. Past that it has a body, and stands at the far
// end of whatever you have just turned to face.

export type PresenceForm = 'shadow' | 'figure';

interface Placement {
  pos: THREE.Vector3;
  yaw: number;
  form: PresenceForm;
}

export interface PresenceContext {
  camera: THREE.PerspectiveCamera;
  frustum: THREE.Frustum;
  player: THREE.Vector3;
  /** unit forward, flattened */
  forward: THREE.Vector3;
  dread: number;
  /** false while a menu is open, in the car, mid-transition */
  allowed: boolean;
}

/** what the presence did this frame, for the game to react to */
export type PresenceEvent = 'seen' | 'lost' | null;

/** the smallest gap it will ever leave between itself and the inspector */
const MIN_RANGE = 3.2;
/** how long it survives being looked at before it stops being there */
const LOOK_LIMIT = 2.4;
/** it gives up on being noticed after this long and moves on */
const PATIENCE = 34;

function buildBody(): { group: THREE.Group; meshes: THREE.Mesh[] } {
  const g = new THREE.Group();
  // Dark enough to be nothing at all outside the beam, light enough that when
  // the beam does land on it the shape resolves into a person rather than
  // staying a doorway-shaped hole. That margin is narrow and it is the whole
  // difference between a scare and a rendering artefact.
  const m = new THREE.MeshStandardMaterial({ color: 0x35363d, roughness: 0.94, metalness: 0 });
  const meshes: THREE.Mesh[] = [];
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    meshes.push(mesh);
    return mesh;
  };
  // a little too tall, a little too narrow, standing the way nobody stands
  add(new THREE.CylinderGeometry(0.085, 0.1, 0.92, 7), -0.11, 0.46, 0);
  add(new THREE.CylinderGeometry(0.085, 0.1, 0.92, 7), 0.11, 0.46, 0);
  add(new THREE.CylinderGeometry(0.19, 0.23, 0.74, 9), 0, 1.27, 0);
  // shoulders wide enough to read as shoulders at fifteen metres
  add(new THREE.BoxGeometry(0.52, 0.11, 0.21), 0, 1.62, 0);
  // arms hanging straight, hands past the knee
  add(new THREE.CylinderGeometry(0.055, 0.045, 0.86, 6), -0.27, 1.18, 0.01);
  add(new THREE.CylinderGeometry(0.055, 0.045, 0.86, 6), 0.27, 1.18, 0.01);
  const head = add(new THREE.SphereGeometry(0.125, 12, 10), 0, 1.79, 0);
  head.scale.set(0.92, 1.18, 0.92);
  return { group: g, meshes };
}

export class Presence {
  readonly group = new THREE.Group();
  private body: THREE.Group;
  private meshes: THREE.Mesh[];
  private grid: Grid;
  private rng: Rng;

  private here = false;
  private form: PresenceForm = 'shadow';
  /** seconds it has been continuously inside the frustum and unoccluded */
  private seenFor = 0;
  /** true once the inspector has actually had it in frame */
  private noticed = false;
  private aliveFor = 0;
  private nextAt = 0;
  /** shadow-casting fixtures on this floor, for placing the bodiless form */
  private casters: THREE.Vector3[] = [];

  constructor(grid: Grid, rng: Rng) {
    this.grid = grid;
    this.rng = rng;
    const built = buildBody();
    this.body = built.group;
    this.meshes = built.meshes;
    this.body.visible = false;
    this.group.add(this.body);
    for (const mesh of this.meshes) {
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.userData.noAlter = true;
    }
    // it is not on the schedule for a while yet
    this.nextAt = 55 + rng() * 50;
  }

  /** the lit fixtures whose shadow maps can carry a shape that has no body */
  setShadowCasters(positions: THREE.Vector3[]) {
    this.casters = positions;
  }

  get present(): boolean {
    return this.here;
  }

  get currentForm(): PresenceForm {
    return this.form;
  }

  /** distance to the inspector, or Infinity when there is nothing there */
  distanceTo(p: THREE.Vector3): number {
    if (!this.here) return Infinity;
    return Math.hypot(this.body.position.x - p.x, this.body.position.z - p.z);
  }

  /** the building putting it somewhere on purpose — the elevator, a doorway */
  placeAt(pos: THREE.Vector3, yaw: number, form: PresenceForm = 'figure') {
    this.apply({ pos: pos.clone(), yaw, form });
  }

  /** the building has decided it would like to be found. Pull the next
   *  placement in, but never make it instant — arriving is the one thing it
   *  is never allowed to be caught doing. */
  nextSoon(seconds: number) {
    if (this.here) return;
    this.nextAt = Math.min(this.nextAt, seconds);
  }

  dismiss() {
    this.here = false;
    this.noticed = false;
    this.seenFor = 0;
    this.body.visible = false;
  }

  update(dt: number, ctx: PresenceContext): PresenceEvent {
    if (!ctx.allowed) {
      // never resolve anything while the world is paused behind a page of UI
      return null;
    }
    this.nextAt -= dt * (0.45 + ctx.dread * 2.2);

    if (!this.here) {
      if (this.nextAt <= 0) {
        const place = this.choose(ctx);
        if (place) this.apply(place);
        // if there was nowhere it could stand unseen, try again shortly
        this.nextAt = place ? 0 : 3 + this.rng() * 4;
      }
      return null;
    }

    this.aliveFor += dt;
    const inView = this.inView(ctx);
    let event: PresenceEvent = null;

    if (inView) {
      if (!this.noticed) {
        this.noticed = true;
        event = 'seen';
      }
      this.seenFor += dt;
    } else {
      this.seenFor = Math.max(0, this.seenFor - dt * 0.6);
      // it only ever leaves while nobody is looking
      const tooClose = this.distanceTo(ctx.player) < MIN_RANGE;
      const staredOut = this.noticed && this.seenFor <= 0.01 && this.aliveFor > 1.2;
      if (tooClose || staredOut || this.aliveFor > PATIENCE) {
        if (this.noticed) event = 'lost';
        this.retire(ctx.dread);
        return event;
      }
    }

    // held in the frame too long: it thins, the way a word you repeat stops
    // being a word. Never a cut — the frame has to stay honest.
    if (this.seenFor > LOOK_LIMIT) {
      const t = (this.seenFor - LOOK_LIMIT) / 0.9;
      this.setThinness(1 - t);
      if (t >= 1) {
        this.retire(ctx.dread);
        return 'lost';
      }
    } else {
      this.setThinness(1);
    }
    return event;
  }

  private retire(dread: number) {
    this.dismiss();
    this.aliveFor = 0;
    // interested buildings do not wait as long
    this.nextAt = (34 + this.rng() * 46) * (1 - 0.62 * dread);
  }

  private setThinness(v: number) {
    const o = Math.max(0, Math.min(1, v));
    for (const mesh of this.meshes) {
      const m = mesh.material as THREE.MeshStandardMaterial;
      m.transparent = o < 0.999;
      m.opacity = o;
    }
  }

  private apply(p: Placement) {
    this.here = true;
    this.noticed = false;
    this.seenFor = 0;
    this.aliveFor = 0;
    this.form = p.form;
    this.body.position.copy(p.pos);
    this.body.rotation.y = p.yaw;
    this.body.visible = true;
    this.setThinness(1);
    const bodiless = p.form === 'shadow';
    for (const mesh of this.meshes) {
      const m = mesh.material as THREE.MeshStandardMaterial;
      // no colour, no depth — the frame gets the shadow and nothing else
      m.colorWrite = !bodiless;
      m.depthWrite = !bodiless;
      m.needsUpdate = true;
    }
  }

  /** inside the frustum, and with floor between here and there */
  private inView(ctx: PresenceContext): boolean {
    const p = this.body.position;
    const chest = new THREE.Vector3(p.x, 1.3, p.z);
    if (!ctx.frustum.containsPoint(chest)) return false;
    if (this.form === 'shadow') return false; // there is nothing to see
    return this.clearLine(ctx.player.x, ctx.player.z, p.x, p.z);
  }

  /** grid march: is every cell between these two points walkable */
  private clearLine(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const d = Math.hypot(dx, dz);
    const steps = Math.ceil(d / (CS * 0.4));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const cx = Math.floor((ax + dx * t) / CS);
      const cz = Math.floor((az + dz * t) / CS);
      if (!isWalkable(charAt(this.grid.rows, cx, cz))) return false;
    }
    return true;
  }

  /**
   * Somewhere the camera is not looking. For the bodiless form that means
   * close and off to one side, where the flashlight or a fixture will find it
   * and put its shadow into the frame. For the standing form it means far, in
   * clear line of sight, so that turning around is the whole event.
   */
  private choose(ctx: PresenceContext): Placement | null {
    const form: PresenceForm = ctx.dread < 0.34 ? 'shadow' : 'figure';
    const near = form === 'shadow';
    const minD = near ? MIN_RANGE : 7.5;
    const maxD = near ? 7.0 : 21;
    const cells: Array<{ x: number; z: number; score: number }> = [];
    for (let z = 0; z < this.grid.h; z++) {
      for (let x = 0; x < this.grid.w; x++) {
        const ch = this.grid.rows[z][x];
        if (!isWalkable(ch) || ch === 'E') continue;
        const c = cellCenter(x, z);
        const d = Math.hypot(c.x - ctx.player.x, c.z - ctx.player.z);
        if (d < minD || d > maxD) continue;
        const chest = new THREE.Vector3(c.x, 1.3, c.z);
        // the whole point: it is never placed anywhere the frame can reach
        if (ctx.frustum.containsPoint(chest)) continue;
        if (!this.clearLine(ctx.player.x, ctx.player.z, c.x, c.z)) continue;
        const to = new THREE.Vector3(c.x - ctx.player.x, 0, c.z - ctx.player.z).normalize();
        const facing = to.dot(ctx.forward);
        let score = this.rng();
        if (near) {
          // just past the edge of the frame, where a beam still reaches
          score += 1.6 - Math.abs(facing - 0.55) * 2.2;
          for (const cst of this.casters) {
            if (cst.distanceTo(chest) < 6.5) score += 0.9;
          }
        } else {
          // behind, so that finding it is something the inspector did
          score += (0.2 - facing) * 1.4 + d * 0.045;
        }
        cells.push({ x: c.x, z: c.z, score });
      }
    }
    if (cells.length === 0) return null;
    cells.sort((a, b) => b.score - a.score);
    const pick = cells[Math.floor(this.rng() * Math.min(4, cells.length))];
    // it is always already facing the inspector. it did not have to turn.
    const yaw = Math.atan2(ctx.player.x - pick.x, ctx.player.z - pick.z) + Math.PI;
    return { pos: new THREE.Vector3(pick.x, 0, pick.z), yaw, form };
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
