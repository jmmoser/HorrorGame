import * as THREE from 'three';
import type { Controls } from './controls';

const WALK_SPEED = 1.75; // m/s. an inspector's pace, not a soldier's.
const EYE_HEIGHT = 1.62;
const RADIUS = 0.32;

export type CollideFn = (x: number, z: number, r: number) => { x: number; z: number };

export class Player {
  pos = new THREE.Vector2(0, 0);
  yaw = 0;
  pitch = 0;
  frozen = true;
  /** callback per footstep with current speed 0..1 */
  onStep: ((intensity: number) => void) | null = null;

  private vel = new THREE.Vector2(0, 0);
  private bobPhase = 0;
  private stepAccum = 0;
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
      const sens = 0.0021;
      this.yaw -= look.dx * sens;
      this.pitch -= look.dy * sens;
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

    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.y + this.vel.y * dt;
    const resolved = collide(nx, nz, RADIUS);
    this.pos.set(resolved.x, resolved.z);

    const speed = Math.hypot(this.vel.x, this.vel.y) / WALK_SPEED;
    // head bob — subtle, slower than the usual game trot
    this.bobPhase += dt * (4.6 * speed);
    this.stepAccum += Math.hypot(this.vel.x * dt, this.vel.y * dt);
    if (this.stepAccum > 0.82) {
      this.stepAccum = 0;
      if (speed > 0.12) this.onStep?.(speed);
    }
    const bobY = Math.sin(this.bobPhase * Math.PI) * 0.022 * speed;
    const bobX = Math.cos(this.bobPhase * Math.PI * 0.5) * 0.012 * speed;

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
