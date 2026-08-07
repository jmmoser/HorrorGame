import * as THREE from 'three';
import { PLAYER_RADIUS } from '../world/grid';
import type { Controls } from './controls';

const WALK_SPEED = 3.1; // m/s. purposeful, but still an inspector, not a soldier.
const EYE_HEIGHT = 1.62;
const RADIUS = PLAYER_RADIUS;

export type CollideFn = (x: number, z: number, r: number) => { x: number; z: number };

export class Player {
  pos = new THREE.Vector2(0, 0);
  yaw = 0;
  pitch = 0;
  frozen = true;
  /** motion-comfort setting — the walk cycle still runs, the camera just
   *  stops riding it (footstep timing must not change) */
  headBob = true;
  /** callback per footstep with current speed 0..1 */
  onStep: ((intensity: number) => void) | null = null;

  private vel = new THREE.Vector2(0, 0);
  private bobPhase = 0;
  private stepAccum = 0;
  private nextStepAt = 0.9;
  private camera: THREE.PerspectiveCamera;
  private controls: Controls;

  constructor(camera: THREE.PerspectiveCamera, controls: Controls) {
    this.camera = camera;
    this.controls = controls;
  }

  teleport(x: number, z: number, yaw: number) {
    this.pos.set(x, z);
    this.yaw = yaw;
    this.pitch = 0;
    this.vel.set(0, 0);
  }

  update(dt: number, collide: CollideFn) {
    const look = this.controls.consumeLook();
    if (!this.frozen) {
      const sens = 0.0021 * this.controls.sensitivity;
      this.yaw -= look.dx * sens;
      this.pitch -= look.dy * sens * (this.controls.invertY ? -1 : 1);
      this.pitch = Math.max(-1.25, Math.min(1.25, this.pitch));
    }

    // movement in yaw space
    let mx = 0;
    let my = 0;
    if (!this.frozen) {
      mx = this.controls.move.x;
      my = this.controls.move.y;
      const len = Math.hypot(mx, my);
      if (len > 1) {
        mx /= len;
        my /= len;
      }
    }
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward is -z in camera space
    const tx = (mx * cos - my * sin) * WALK_SPEED;
    const tz = (-mx * sin - my * cos) * WALK_SPEED;
    const accel = 10;
    this.vel.x += (tx - this.vel.x) * Math.min(1, accel * dt);
    this.vel.y += (tz - this.vel.y) * Math.min(1, accel * dt);

    const fromX = this.pos.x;
    const fromZ = this.pos.y;
    const nx = fromX + this.vel.x * dt;
    const nz = fromZ + this.vel.y * dt;
    const resolved = collide(nx, nz, RADIUS);
    this.pos.set(resolved.x, resolved.z);

    // keep the velocity honest about what actually happened: leaning into a
    // desk must stop the stride and the head-bob, not walk on the spot. a
    // push-out can also move us further than we asked for — never let that
    // read as speed.
    if (dt > 1e-5) {
      const want = Math.hypot(this.vel.x, this.vel.y);
      const gx = (this.pos.x - fromX) / dt;
      const gz = (this.pos.y - fromZ) / dt;
      const got = Math.hypot(gx, gz);
      const scale = got > want ? (got > 1e-6 ? want / got : 0) : 1;
      this.vel.set(gx * scale, gz * scale);
    }

    const speed = Math.hypot(this.vel.x, this.vel.y) / WALK_SPEED;
    // head bob — subtle, slower than the usual game trot
    this.bobPhase += dt * (4.6 * speed);
    this.stepAccum += Math.hypot(this.vel.x * dt, this.vel.y * dt);
    if (this.stepAccum > this.nextStepAt) {
      this.stepAccum = 0;
      // strides are never metronome-even
      this.nextStepAt = 0.84 + Math.random() * 0.18;
      if (speed > 0.12) this.onStep?.(speed);
    }
    const bobAmp = this.headBob ? 1 : 0;
    const bobY = Math.sin(this.bobPhase * Math.PI) * 0.022 * speed * bobAmp;
    const bobX = Math.cos(this.bobPhase * Math.PI * 0.5) * 0.012 * speed * bobAmp;

    this.camera.position.set(this.pos.x + bobX * cos, EYE_HEIGHT + bobY, this.pos.y + bobX * sin);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw + this.controls.gyroYaw;
    this.camera.rotation.x = this.pitch + this.controls.gyroPitch;
    this.camera.rotation.z = 0;
  }

  get speed01(): number {
    return Math.hypot(this.vel.x, this.vel.y) / WALK_SPEED;
  }
}
