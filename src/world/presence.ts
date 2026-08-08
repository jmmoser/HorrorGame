import * as THREE from 'three';
import { mulberry32, type Rng } from '../core/rng';
import { faceTexture, FACE_KINDS } from './faces';

// There is something on the floor with you.
//
// It is built from the same primitives as the furniture, because it is trying
// to be furniture: too tall, too thin, standing at the end of sightlines. Its
// rules are the old ones, and they are the ones that work — it does not move
// while you are looking at it, it is closer every time you look away, and once
// it is close enough it stops obeying any of that.
//
// Three things were added when the building stopped being polite about it.
// It no longer walks at where you are; it walks at where you are going to be,
// which is why corners stopped working. When it moves unseen it can choose the
// one bearing you are not covering rather than merely a nearer one, so the
// scare is the turn you took yourself. And when you stop to document something
// it stops too, and raises its hands to the same height as yours, and holds
// them there, because whatever else it is doing on this floor it is also
// keeping a record.
//
// It never kills you. There is still no game over. What it does instead is
// arrive.

export type PresenceState = 'gone' | 'lurking' | 'stalking' | 'charging' | 'contact';

export interface PresenceContext {
  /** where the inspector is standing, world space */
  player: THREE.Vector3;
  /** the live view frustum, already built for this frame */
  frustum: THREE.Frustum;
  /** true when nothing solid stands between the two points */
  lineOfSight: (from: THREE.Vector3, to: THREE.Vector3) => boolean;
  /** slide-along-walls collision, same one the player uses */
  collide: (x: number, z: number, r: number) => { x: number; z: number };
  /** somewhere walkable at least `min` metres away, or null */
  pickCell: (min: number, max: number) => THREE.Vector3 | null;
  /** 0..1 — how far gone this floor is */
  intensity: number;
  /** the inspector's velocity on the floor plane, m/s — it aims at this */
  playerVel: { x: number; z: number };
  /** true while the inspector is holding a frame. it holds one too. */
  documenting: boolean;
}

const HEIGHT = 2.34;
const BODY_R = 0.12;

export class Presence {
  readonly group = new THREE.Group();
  state: PresenceState = 'gone';
  /** world position on the floor plane */
  pos = new THREE.Vector3(0, 0, 0);
  /** true on the frame the player can actually see it */
  seen = false;
  /** how long it has been continuously in view */
  seenFor = 0;
  /** metres, player to figure */
  distance = Infinity;

  /** fired the first frame a hidden figure becomes visible */
  onSighting: ((distance: number) => void) | null = null;
  /** fired when it reaches the inspector */
  onContact: (() => void) | null = null;
  /** fired when it moves while unobserved and ends up much closer */
  onBlink: ((distance: number) => void) | null = null;

  private rng: Rng;
  private head: THREE.Mesh;
  private face: THREE.Mesh;
  private faceMat: THREE.MeshBasicMaterial;
  private limbs: THREE.Object3D[] = [];
  private textures: THREE.Texture[] = [];
  private timer = 0;
  private stateT = 0;
  private lastDistance = Infinity;
  private yaw = 0;
  private stride = 0;
  /** 0..1 eased — how far into copying the inspector's pose it currently is */
  private mimic = 0;
  /** the floor's intensity as of the last frame, for decisions made outside it */
  private lastI = 0;
  /** suppressed entirely — the comfort setting, or between floors */
  enabled = true;

  constructor(seed: number) {
    this.rng = mulberry32(seed >>> 0);
    const rng = this.rng;

    // Charcoal, not black: a true black silhouette disappears into the fog and
    // the whole point is that you can just make it out.
    const skin = new THREE.MeshStandardMaterial({
      color: 0x14120f,
      roughness: 0.96,
      metalness: 0.0,
      emissive: 0x0b0a09,
      emissiveIntensity: 1,
    });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(BODY_R, 0.86, 4, 10), skin);
    torso.position.y = 1.42;
    this.group.add(torso);

    const hips = new THREE.Mesh(new THREE.CapsuleGeometry(BODY_R * 0.9, 0.18, 4, 8), skin);
    hips.position.y = 0.94;
    this.group.add(hips);

    // arms that hang too far, legs that are mostly shin
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.19, 1.82, 0);
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.52, 3, 6), skin);
      upper.position.y = -0.29;
      const fore = new THREE.Group();
      fore.position.y = -0.56;
      const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.60, 3, 6), skin);
      lower.position.y = -0.32;
      const hand = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.16, 3, 6), skin);
      hand.position.y = -0.68;
      fore.add(lower, hand);
      arm.add(upper, fore);
      this.group.add(arm);
      this.limbs.push(arm);

      const leg = new THREE.Group();
      leg.position.set(side * 0.10, 0.94, 0);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.40, 3, 6), skin);
      thigh.position.y = -0.24;
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.46, 3, 6), skin);
      shin.position.y = -0.70;
      leg.add(thigh, shin);
      this.group.add(leg);
      this.limbs.push(leg);
    }

    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 10), skin);
    this.head.position.y = HEIGHT - 0.11;
    this.head.scale.set(0.92, 1.22, 0.92);
    this.group.add(this.head);

    // The face is unlit on purpose. Everything else on this floor is subject to
    // the flashlight; the face is the one thing that is the same brightness at
    // twenty metres as it is at one, which is why you find it first.
    const kind = FACE_KINDS[Math.floor(rng() * FACE_KINDS.length)];
    const tex = faceTexture(kind, seed ^ 0x9e37);
    this.textures.push(tex);
    this.faceMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.94,
    });
    // over-bright in linear space: the composite tonemaps the whole frame, and
    // a face at 1.0 comes out of ACES as a grey smudge at fifteen metres
    this.faceMat.color.setScalar(2.6);
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), this.faceMat);
    this.face.position.set(0, HEIGHT - 0.10, 0.13);
    this.face.renderOrder = 3;
    this.group.add(this.face);

    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = o !== this.face;
        o.receiveShadow = false;
      }
    });
    this.group.visible = false;
    this.timer = 8 + rng() * 10;
  }

  /** put it back in the walls and start the clock again */
  banish(minDelay = 14, maxDelay = 26) {
    this.state = 'gone';
    this.stateT = 0;
    this.seen = false;
    this.seenFor = 0;
    this.distance = Infinity;
    this.lastDistance = Infinity;
    this.group.visible = false;
    this.timer = minDelay + this.rng() * (maxDelay - minDelay);
  }

  /** drop it at a specific spot, already visible — used for staged scares */
  place(at: THREE.Vector3, state: PresenceState = 'lurking') {
    this.pos.set(at.x, 0, at.z);
    this.group.position.copy(this.pos);
    this.group.visible = true;
    this.state = state;
    this.stateT = 0;
    this.seenFor = 0;
    this.lastDistance = Infinity;
  }

  update(dt: number, time: number, ctx: PresenceContext) {
    if (!this.enabled) {
      if (this.group.visible) this.group.visible = false;
      this.state = 'gone';
      this.seen = false;
      this.distance = Infinity;
      return;
    }

    this.stateT += dt;
    const i = ctx.intensity;
    this.lastI = i;

    if (this.state === 'gone') {
      this.timer -= dt * (0.5 + i * 1.3);
      if (this.timer <= 0) this.spawn(ctx);
      this.seen = false;
      this.distance = Infinity;
      return;
    }

    // --- am I being looked at?
    const head = new THREE.Vector3(this.pos.x, HEIGHT - 0.2, this.pos.z);
    this.distance = Math.hypot(ctx.player.x - this.pos.x, ctx.player.z - this.pos.z);
    const inFrame = ctx.frustum.containsPoint(head);
    const visible = inFrame && ctx.lineOfSight(ctx.player, head);
    if (visible && !this.seen && this.state !== 'charging') {
      this.onSighting?.(this.distance);
    }
    this.seen = visible;
    this.seenFor = visible ? this.seenFor + dt : 0;

    // --- always face the inspector. it has no other interest.
    const want = Math.atan2(ctx.player.x - this.pos.x, ctx.player.z - this.pos.z);
    const turn = visible ? 3.5 : 14;
    let d = ((want - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.yaw += d * Math.min(1, dt * turn);
    this.group.rotation.y = this.yaw;

    // the face plate is a billboard on a body that is not
    this.face.rotation.y = 0;

    if (this.state === 'lurking') {
      // it waits to be found. once found, it stops waiting.
      if (this.seenFor > 1.1 - i * 0.7 || this.stateT > 16 - i * 9) {
        this.state = 'stalking';
        this.stateT = 0;
      }
    } else if (this.state === 'stalking') {
      this.stalk(dt, ctx, visible, i);
    } else if (this.state === 'charging') {
      this.charge(dt, ctx, i);
    }

    // --- gait, or the absence of one
    //
    // The mimicry is worth more than any pose in the file: while the inspector
    // is holding a frame to document a chair, this stops mid-stride and raises
    // its hands to exactly the height the inspector's are at, and does not
    // move again until they are finished. It is not attacking. It is filing.
    this.mimic += ((ctx.documenting ? 1 : 0) - this.mimic) * Math.min(1, dt * 5.5);
    const moving = this.state === 'stalking' || this.state === 'charging';
    const rate = this.state === 'charging' ? 13 : 3.4;
    if (moving && (!visible || this.state === 'charging')) this.stride += dt * rate;
    for (let n = 0; n < this.limbs.length; n++) {
      // limbs are [arm, leg] per side: even indices are arms, and a walk is
      // contralateral — the left arm goes with the right leg
      const isArm = n % 2 === 0;
      const rightSide = n >= 2;
      const phase = (isArm ? +rightSide : +!rightSide) * Math.PI;
      const swing = Math.sin(this.stride + phase) * (isArm ? 0.34 : 0.5);
      const walk = swing * (this.state === 'charging' ? 1.9 : 1);
      // the held pose: forearms up, elbows in, holding nothing at eye level
      const held = isArm ? -1.42 : 0;
      this.limbs[n].rotation.x = walk * (1 - this.mimic) + held * this.mimic;
      if (isArm) {
        const drift = Math.sin(time * 0.7 + n) * 0.12;
        this.limbs[n].rotation.z = drift * (1 - this.mimic) + (rightSide ? -0.3 : 0.3) * this.mimic;
      }
    }
    // a head that tilts a few degrees further every time you check
    this.head.rotation.z = Math.sin(time * 0.23) * 0.10 + (this.state === 'charging' ? 0.5 : 0);
    this.face.rotation.z = this.head.rotation.z;

    // it is brighter the closer it gets, which is not how faces work — and
    // while it is copying the inspector it is brighter still
    this.faceMat.opacity = THREE.MathUtils.clamp(
      0.7 + (12 - this.distance) * 0.03 + this.mimic * 0.3,
      0.55,
      1,
    );

    this.group.position.copy(this.pos);
  }

  /**
   * A walkable spot on a ring around the inspector that is currently outside
   * the view frustum but has a clear line to them — the one bearing they are
   * not covering. Put something here and the fright is entirely self-inflicted:
   * nothing happens until they decide, on their own, to turn around.
   */
  blindSpot(ctx: PresenceContext, min = 3.4, max = 6): THREE.Vector3 | null {
    const start = this.rng() * Math.PI * 2;
    const probe = new THREE.Vector3();
    for (let n = 0; n < 16; n++) {
      const a = start + (n / 16) * Math.PI * 2;
      const d = min + this.rng() * (max - min);
      const x = ctx.player.x + Math.cos(a) * d;
      const z = ctx.player.z + Math.sin(a) * d;
      // walkable means collision gives the point back unchanged
      const hit = ctx.collide(x, z, BODY_R + 0.14);
      if (Math.hypot(hit.x - x, hit.z - z) > 0.02) continue;
      probe.set(x, HEIGHT - 0.2, z);
      if (ctx.frustum.containsPoint(probe)) continue;
      if (!ctx.lineOfSight(ctx.player, probe)) continue;
      return new THREE.Vector3(x, 0, z);
    }
    return null;
  }

  // --------------------------------------------------------------- behaviour

  private spawn(ctx: PresenceContext) {
    const i = ctx.intensity;
    // close enough to be found, far enough to still be a shape
    const at = ctx.pickCell(10 - i * 3, 24) ?? ctx.pickCell(6, 30);
    if (!at) {
      this.timer = 6;
      return;
    }
    this.pos.set(at.x, 0, at.z);
    this.group.position.copy(this.pos);
    this.group.visible = true;
    this.state = 'lurking';
    this.stateT = 0;
    this.seenFor = 0;
    this.lastDistance = this.distance = Math.hypot(ctx.player.x - at.x, ctx.player.z - at.z);
    this.yaw = Math.atan2(ctx.player.x - at.x, ctx.player.z - at.z);
  }

  /** the rule, and the way the rule stops applying */
  private stalk(dt: number, ctx: PresenceContext, visible: boolean, i: number) {
    // Observed, it holds — mostly. Past the halfway mark it creeps while you
    // watch, which is the moment the floor stops having rules. While the
    // inspector is documenting it holds absolutely, whatever the intensity:
    // it has something else to do with its hands.
    const watchedSpeed = i > 0.5 ? (i - 0.5) * 1.9 : 0;
    const speed = ctx.documenting && visible ? 0 : visible ? watchedSpeed : 1.5 + i * 2.6;

    if (speed > 0.001) this.step(dt, speed, ctx);

    // unobserved, it also skips: a step you never saw it take
    if (!visible) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 6 - i * 2.6;
        // Past halfway it stops settling for "nearer" and starts choosing the
        // bearing that is not covered — which is usually directly behind.
        const behind = i > 0.5 && this.rng() < (i - 0.5) * 1.2 ? this.blindSpot(ctx, 3.4, 6.2) : null;
        const jump =
          behind ??
          ctx.pickCell(Math.max(3, this.distance - 5), Math.max(5, this.distance - 1.5));
        if (jump && !ctx.frustum.containsPoint(new THREE.Vector3(jump.x, 1.5, jump.z))) {
          this.pos.set(jump.x, 0, jump.z);
          this.distance = Math.hypot(ctx.player.x - jump.x, ctx.player.z - jump.z);
          if (this.lastDistance - this.distance > 3) this.onBlink?.(this.distance);
          this.lastDistance = this.distance;
        }
      }
    }

    // close and watched: it gives up pretending and comes
    if (i > 0.45 && this.distance < 8 && visible && this.stateT > 5.5) {
      this.state = 'charging';
      this.stateT = 0;
    }
    if (this.distance < 1.9) this.contact();
  }

  private charge(dt: number, ctx: PresenceContext, i: number) {
    this.step(dt, 4.4 + i * 2.6, ctx);
    if (this.distance < 1.5 || this.stateT > 9) this.contact();
  }

  private contact() {
    this.state = 'contact';
    // How long it stays gone afterwards is the whole difference between a
    // floor with a monster on it and a floor that has been given to one.
    // Arriving always costs it real time — even deep in, the inspector gets
    // the corridor back long enough to walk it. Banish before the callback:
    // the game may impose a longer exile in `onContact`, and it must win.
    const i = this.lastI;
    this.banish(32 - i * 16, 55 - i * 27);
    this.onContact?.();
  }

  /**
   * Walk at where the inspector is going to be, sliding off whatever it walks
   * into. Aiming at where they *are* is what makes a pursuer trail politely
   * along behind and lose every corner; aiming at the intercept is what makes
   * it appear at the far end of the corridor you were about to turn into. The
   * lead is capped so it does not sprint at empty floor when they change
   * their mind, which they will.
   */
  private step(dt: number, speed: number, ctx: PresenceContext) {
    const raw = Math.hypot(ctx.player.x - this.pos.x, ctx.player.z - this.pos.z) || 1;
    const lead = Math.min(2.2, raw / Math.max(speed, 0.6));
    const dx = ctx.player.x + ctx.playerVel.x * lead - this.pos.x;
    const dz = ctx.player.z + ctx.playerVel.z * lead - this.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    let nx = this.pos.x + (dx / len) * speed * dt;
    let nz = this.pos.z + (dz / len) * speed * dt;
    let r = ctx.collide(nx, nz, BODY_R + 0.14);
    // if the wall ate the whole step, try sliding along it rather than standing
    // there vibrating — a stuck figure is a prop, and props are not frightening
    if (Math.hypot(r.x - this.pos.x, r.z - this.pos.z) < speed * dt * 0.25) {
      const side = Math.sign(Math.sin(this.stride * 0.7 + 1)) || 1;
      nx = this.pos.x + (-dz / len) * speed * dt * side;
      nz = this.pos.z + (dx / len) * speed * dt * side;
      r = ctx.collide(nx, nz, BODY_R + 0.14);
    }
    this.pos.set(r.x, 0, r.z);
    this.distance = Math.hypot(ctx.player.x - r.x, ctx.player.z - r.z);
    this.lastDistance = this.distance;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
    this.textures.forEach((t) => t.dispose());
  }
}
