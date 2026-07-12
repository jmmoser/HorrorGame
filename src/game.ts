import * as THREE from 'three';
import { FLOORS } from './world/specs';
import { PALETTES } from './world/palette';
import { buildFloor, makeCollider, type ActiveTarget, type BuiltFloor } from './world/builder';
import { fillTokens } from './world/discrepancies';
import { CS, cellCenter, facingToYaw, isWalkable } from './world/grid';
import { floorRng } from './core/rng';
import type { LedgerEntry, SaveData } from './core/types';
import { writeSave } from './core/save';
import { Controls } from './player/controls';
import { Player } from './player/player';
import { AudioEngine } from './audio/audio';
import { Haptics } from './audio/haptics';
import { PostFX } from './render/post';
import { Hud } from './ui/hud';
import { LedgerUI } from './ui/ledger';
import { shareCard } from './ui/share';

type State = 'idle' | 'arriving' | 'play' | 'departing' | 'ending';

const INTERACT_DIST = 3.4;

interface PendingAlteration {
  anchor: string;
  kind: 'door-ajar' | 'light-off' | 'light-on' | 'chair-turned';
  hiddenFor: number;
}

export class Game {
  readonly audio = new AudioEngine();
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private post: PostFX;
  private controls: Controls;
  private player: Player;
  private haptics = new Haptics();
  private hud = new Hud();
  private ledgerUI = new LedgerUI();
  private ambient = new THREE.AmbientLight(0xffffff, 0.5);
  private flashlight = new THREE.SpotLight(0xfff2dc, 0, 20, 0.66, 0.92, 1.15);
  private flashTarget = new THREE.Object3D();

  private save: SaveData;
  private built: BuiltFloor | null = null;
  private collide: ReturnType<typeof makeCollider> | null = null;
  private state: State = 'idle';
  private stateT = 0;
  private time = 0;
  private depthShown = 1;
  private pending: PendingAlteration[] = [];
  private walkableCenters: THREE.Vector3[] = [];
  private raycaster = new THREE.Raycaster();
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private exitedCar = false;
  private insideCarSince = 0;
  private endingTimer = 0;
  private lastSaveWrite = 0;
  private fader = document.getElementById('fader')!;

  constructor(canvas: HTMLCanvasElement, save: SaveData) {
    this.save = save;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.controls = new Controls(canvas);
    this.camera = new THREE.PerspectiveCamera(this.controls.isTouch ? 73 : 68, 1, 0.05, 60);
    this.player = new Player(this.camera, this.controls);
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.scene.add(this.ambient);
    this.scene.add(this.flashlight);
    this.scene.add(this.flashTarget);
    this.flashlight.target = this.flashTarget;

    this.controls.onInspect = () => this.inspect();
    this.player.onStep = (i) => {
      if (this.built) this.audio.footstep(i, this.built.spec.palette);
    };

    this.hud.onLedgerTab(() => this.toggleLedger());
    this.ledgerUI.onClose = () => this.toggleLedger();
    this.ledgerUI.onShare = async () => {
      const entry = this.save.ledger.length
        ? this.save.ledger[this.save.ledger.length - 1]
        : null;
      await shareCard(this.save.floor, entry);
    };
    this.ledgerUI.onAlteredTap = () => this.logLedgerDiscrepancy();

    window.addEventListener('visibilitychange', () => {
      if (document.hidden) this.persist();
    });
    window.addEventListener('pagehide', () => this.persist());
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.controls.isTouch ? 1.75 : 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.post.setSize(w * pr, h * pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- lifecycle

  start() {
    this.controls.enabled = true;
    this.hud.show();
    if (this.controls.isTouch) document.getElementById('touch-ui')!.classList.remove('hidden');
    this.haptics.start();
    this.loadFloor(this.save.floor);
    const loop = (last: number) => {
      requestAnimationFrame((now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        this.update(dt);
        loop(now);
      });
    };
    loop(performance.now());
  }

  private setFade(dark: boolean, instant = false) {
    this.fader.style.transition = instant ? 'none' : 'opacity 1.4s ease';
    this.fader.style.opacity = dark ? '1' : '0';
  }

  private loadFloor(floorNum: number) {
    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.dispose();
      this.built = null;
    }
    this.pending = [];
    if (floorNum > FLOORS.length) {
      this.beginEnding();
      return;
    }
    const spec = FLOORS[floorNum - 1];
    const palette = PALETTES[spec.palette];
    const built = buildFloor(spec, this.save.seed);
    this.built = built;
    this.scene.add(built.group);
    this.scene.fog = new THREE.FogExp2(palette.fog, palette.fogDensity);
    this.scene.background = new THREE.Color(palette.fog);
    this.ambient.color.set(palette.ambient);
    this.ambient.intensity = palette.ambientIntensity;
    this.flashlight.color.set(palette.flashlight);
    this.flashlight.intensity = 24;
    this.collide = makeCollider(built);

    // walkable centers for occupancy sound placement
    this.walkableCenters = [];
    for (let z = 0; z < built.grid.h; z++) {
      for (let x = 0; x < built.grid.w; x++) {
        if (isWalkable(built.grid.rows[z][x]) && built.grid.rows[z][x] !== 'E') {
          const c = cellCenter(x, z);
          this.walkableCenters.push(new THREE.Vector3(c.x, 1.3, c.z));
        }
      }
    }

    // restore already-logged discrepancies (resume) — including alterations
    for (const t of built.targets) {
      if (this.save.logged.includes(t.sel.def.id)) {
        t.logged = true;
        const alt = t.sel.def.alteration;
        if (alt) built.props.get(alt.anchor)?.applyAlteration?.(alt.kind);
      }
    }

    // spawn inside the car, facing the doors
    const el = built.grid.elevator;
    const yaw = facingToYaw(el.doorDir) + Math.PI; // props face +z; camera -z
    this.player.teleport(el.cx, el.cz, yaw);
    this.player.frozen = true;
    this.exitedCar = false;
    this.insideCarSince = 0;

    this.hud.setDepth(spec.floor);
    this.depthShown = spec.floor;
    this.haptics.setDepth(spec.floor);
    this.audio.setFloor(spec, spec.floor, floorRng(this.save.seed, spec.floor * 977));
    this.audio.attachSpots(built.audioSpots);

    // floor 5: the ledger has been edited while the inspector was descending
    if (spec.floor === 5 && !this.save.ledgerAltered && this.save.ledger.length > 0) {
      const first = this.save.ledger[0];
      first.originalText = first.text;
      first.altered = true;
      const firstSentence = first.text.split('.')[0];
      first.text =
        `${firstSentence}. I checked again on the way down. There was nothing there. ` +
        `There was never anything there. The floor is correct. The floor was always correct. ` +
        `I do not know why I wrote what I wrote.`;
      this.save.ledgerAltered = true;
      window.setTimeout(() => this.hud.pulseTab(), 9000);
    }

    this.state = 'arriving';
    this.stateT = 0;
    this.setFade(true, true);
    requestAnimationFrame(() => requestAnimationFrame(() => this.setFade(false)));
    built.elevator.closeDoors();
    // doors open shortly after the settle
    window.setTimeout(() => {
      built.elevator.openDoors();
      this.audio.doorSlide(true);
      this.audio.arrivalSettle();
    }, 1200);
    this.refreshQuota(false);
    this.persist();
  }

  // ------------------------------------------------------------ discovery

  private selectedQuotaProgress(): { logged: number; quota: number } {
    if (!this.built) return { logged: 0, quota: 1 };
    const ids = this.built.targets.map((t) => t.sel.def.id);
    if (this.built.ledgerDiscrepancy) ids.push(this.built.ledgerDiscrepancy.def.id);
    const logged = ids.filter((id) => this.save.logged.includes(id)).length;
    return { logged, quota: this.built.spec.quota };
  }

  private refreshQuota(announce: boolean) {
    if (!this.built) return;
    const { logged, quota } = this.selectedQuotaProgress();
    const met = logged >= quota;
    if (met && !this.built.elevator.callActive) {
      this.built.elevator.setCallActive(true);
      if (announce) {
        this.audio.quotaCue();
        window.setTimeout(() => this.hud.showToast('the call button is lit'), 1800);
      }
    }
  }

  private writeEntry(id: string, floor: number, text: string): LedgerEntry {
    const s = Math.floor(this.save.elapsed);
    const stamp = [
      String(Math.floor(s / 3600)).padStart(2, '0'),
      String(Math.floor((s % 3600) / 60)).padStart(2, '0'),
      String(s % 60).padStart(2, '0'),
    ].join(':');
    const entry: LedgerEntry = { id, floor, stamp, text: fillTokens(text) };
    this.save.ledger.push(entry);
    this.save.logged.push(id);
    return entry;
  }

  private logTarget(t: ActiveTarget) {
    if (t.logged || !this.built) return;
    t.logged = true;
    this.writeEntry(t.sel.def.id, this.built.spec.floor, t.sel.entry);
    this.audio.pencil();
    this.hud.showToast(t.sel.def.toast);
    this.hud.pulseTab();
    const alt = t.sel.def.alteration;
    if (alt) this.pending.push({ anchor: alt.anchor, kind: alt.kind, hiddenFor: 0 });
    this.refreshQuota(true);
    this.persist();
  }

  private logLedgerDiscrepancy() {
    if (!this.built?.ledgerDiscrepancy) return;
    const sel = this.built.ledgerDiscrepancy;
    if (this.save.logged.includes(sel.def.id)) return;
    this.writeEntry(sel.def.id, this.built.spec.floor, sel.entry);
    this.audio.pencil();
    this.hud.showToast(sel.def.toast);
    this.refreshQuota(true);
    this.persist();
    // re-render the open ledger with the new entry
    if (this.ledgerUI.isOpen) this.openLedger();
  }

  private inspect() {
    if (this.state !== 'play' || !this.built || this.ledgerUI.isOpen) return;
    const hit = this.raycastInteract();
    if (!hit) return;
    if (hit.kind === 'target') {
      this.logTarget(hit.target);
    } else if (hit.kind === 'call') {
      if (this.built.elevator.callActive) {
        this.audio.buttonPress();
        if (this.built.elevator.doorsClosed) {
          this.built.elevator.openDoors();
          this.audio.doorSlide(true);
        }
      } else {
        this.audio.deadClick();
      }
    } else if (hit.kind === 'panel') {
      if (this.built.elevator.callActive && this.playerInsideCar()) {
        this.audio.buttonPress();
        this.beginDeparture();
      } else {
        this.audio.deadClick();
      }
    }
  }

  private raycastInteract():
    | { kind: 'target'; target: ActiveTarget }
    | { kind: 'call' }
    | { kind: 'panel' }
    | null {
    if (!this.built) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = INTERACT_DIST;
    const meshes: THREE.Mesh[] = [];
    const lookup = new Map<THREE.Mesh, ActiveTarget>();
    for (const t of this.built.targets) {
      if (!t.logged) {
        meshes.push(t.hit);
        lookup.set(t.hit, t);
      }
    }
    meshes.push(this.built.elevator.buttonHit, this.built.elevator.panelHit);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const first = hits[0].object as THREE.Mesh;
    const t = lookup.get(first);
    if (t) return { kind: 'target', target: t };
    if (first === this.built.elevator.buttonHit) return { kind: 'call' };
    if (first === this.built.elevator.panelHit) return { kind: 'panel' };
    return null;
  }

  // -------------------------------------------------------------- elevator

  private playerInsideCar(): boolean {
    if (!this.built) return false;
    return this.built.grid.elevator.cells.some(([x, z]) => {
      const minX = x * CS;
      const minZ = z * CS;
      return (
        this.player.pos.x >= minX &&
        this.player.pos.x <= minX + CS &&
        this.player.pos.y >= minZ &&
        this.player.pos.y <= minZ + CS
      );
    });
  }

  private distToCar(): number {
    if (!this.built) return Infinity;
    const el = this.built.grid.elevator;
    return Math.hypot(this.player.pos.x - el.cx, this.player.pos.y - el.cz);
  }

  private beginDeparture() {
    if (!this.built || this.state !== 'play') return;
    this.state = 'departing';
    this.stateT = 0;
    this.player.frozen = true;
    this.built.elevator.closeDoors();
    this.audio.doorSlide(false);
  }

  private beginEnding() {
    // there is no floor six on the schedule
    this.state = 'ending';
    this.stateT = 0;
    this.endingTimer = 0;
    this.setFade(true);
    this.audio.duck();
    this.haptics.stop();
    const title = document.getElementById('title')!;
    title.classList.remove('hidden');
    title.classList.remove('fading');
    title.innerHTML = `
      <div class="title-inner">
        <p class="title-over">MUNICIPAL SURVEY — STRUCTURE 7</p>
        <h1 class="title-name" id="ending-depth">FLOOR −06</h1>
        <p class="title-brief">
          The schedule ends at floor five.<br/>
          The elevator has not stopped.<br/><br/>
          The inspection continues.
        </p>
        <button id="btn-end-share" class="ghost-btn">tear out a page</button>
      </div>`;
    document.getElementById('btn-end-share')!.addEventListener('click', async () => {
      const entry = this.save.ledger.length
        ? this.save.ledger[this.save.ledger.length - 1]
        : null;
      await shareCard(this.depthShown, entry);
    });
    this.hud.hide();
    this.controls.enabled = false;
    document.getElementById('touch-ui')!.classList.add('hidden');
    this.persist();
  }

  // ---------------------------------------------------------------- ledger

  private toggleLedger() {
    if (this.ledgerUI.isOpen) {
      this.ledgerUI.close();
      this.player.frozen = this.state !== 'play';
    } else if (this.state === 'play' || this.state === 'arriving') {
      this.openLedger();
    }
  }

  private openLedger() {
    if (!this.built) return;
    this.audio.pageTurn();
    const { logged, quota } = this.selectedQuotaProgress();
    this.ledgerUI.open(this.save.ledger, this.built.spec.floor, logged, quota, this.built.spec.map);
    this.player.frozen = true;
  }

  // ---------------------------------------------------------------- update

  private update(dt: number) {
    this.time += dt;
    this.stateT += dt;
    const built = this.built;
    if (!built) {
      if (this.state === 'ending') this.updateEnding(dt);
      this.post.render(dt);
      return;
    }

    // elevator doors always animate
    const el = built.grid.elevator;
    built.elevator.updateDoors(dt, el.doorX, el.doorZ, el.doorW / 2);

    if (this.state === 'arriving') {
      if (this.stateT > 1.6) {
        this.state = 'play';
        this.player.frozen = this.ledgerUI.isOpen;
      }
    } else if (this.state === 'play') {
      this.save.elapsed += dt;
      if (!this.ledgerUI.isOpen) this.player.frozen = false;

      // close doors behind the player once they've stepped away
      if (!this.exitedCar && this.distToCar() > 2.8) {
        this.exitedCar = true;
        if (!built.elevator.callActive) {
          built.elevator.closeDoors();
          this.audio.doorSlide(false);
        }
      }
      // auto-departure: stand in the car with the doors open and the call lit
      if (built.elevator.callActive && built.elevator.doorsOpen && this.playerInsideCar()) {
        this.insideCarSince += dt;
        if (this.insideCarSince > 1.4) this.beginDeparture();
      } else {
        this.insideCarSince = 0;
      }
    } else if (this.state === 'departing') {
      if (built.elevator.doorsClosed && this.stateT > 0.5) {
        // descend
        this.setFade(true);
        this.audio.descend(3.4);
        this.audio.duck();
        const next = built.spec.floor + 1;
        window.setTimeout(() => this.hud.setDepth(Math.min(next, 99)), 1700);
        this.state = 'idle';
        window.setTimeout(() => {
          this.save.floor = next;
          this.persist();
          this.loadFloor(next);
        }, 3400);
      }
    }

    if (this.collide) this.player.update(dt, this.collide);

    // flashlight follows the camera with a breath of lag
    const camPos = this.camera.position;
    this.flashlight.position.lerp(
      new THREE.Vector3(camPos.x, camPos.y - 0.12, camPos.z),
      Math.min(1, dt * 20),
    );
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const targetPos = camPos.clone().add(fwd.multiplyScalar(6));
    this.flashTarget.position.lerp(targetPos, Math.min(1, dt * 9));

    // props
    for (const u of built.updatables) u(dt, this.time);

    // reticle
    if (this.state === 'play' && !this.ledgerUI.isOpen) {
      this.hud.setOnTarget(this.raycastInteract() !== null);
    } else {
      this.hud.setOnTarget(false);
    }

    // silent alterations: applied only when provably unseen
    if (this.pending.length > 0) {
      this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreen);
      const playerV = new THREE.Vector3(this.player.pos.x, 1.2, this.player.pos.y);
      this.pending = this.pending.filter((p) => {
        const prop = built.props.get(p.anchor);
        if (!prop?.applyAlteration) return false;
        const pos = new THREE.Vector3();
        prop.group.getWorldPosition(pos);
        pos.y = 1.2;
        const unseen = !this.frustum.containsPoint(pos) && playerV.distanceTo(pos) > 5.5;
        p.hiddenFor = unseen ? p.hiddenFor + dt : 0;
        if (p.hiddenFor > 1.6) {
          prop.applyAlteration(p.kind);
          return false;
        }
        return true;
      });
    }

    // audio
    const playerV = new THREE.Vector3(this.player.pos.x, 1.5, this.player.pos.y);
    this.audio.updateListener(this.camera, playerV);
    if (this.state === 'play') {
      this.audio.tick(playerV, () => {
        const candidates = this.walkableCenters.filter((c) => {
          const d = c.distanceTo(playerV);
          return d > 8 && d < 26;
        });
        if (candidates.length === 0) return null;
        return candidates[Math.floor(Math.random() * candidates.length)];
      });
    }

    // periodic autosave
    if (this.time - this.lastSaveWrite > 20 && this.state === 'play') {
      this.persist();
    }

    this.post.render(dt);
  }

  private updateEnding(dt: number) {
    this.endingTimer += dt;
    // the counter does not stop
    const depth = 6 + Math.floor(this.endingTimer / 7);
    if (depth !== this.depthShown) {
      this.depthShown = depth;
      const elDepth = document.getElementById('ending-depth');
      if (elDepth) elDepth.textContent = `FLOOR −${String(depth).padStart(2, '0')}`;
      this.audio.arrivalSettle();
    }
  }

  private persist() {
    this.lastSaveWrite = this.time;
    writeSave(this.save);
  }

  /** dev/test hooks — used by the smoke test to drive the full loop */
  get debug() {
    return {
      state: this.state,
      stateT: this.stateT,
      time: this.time,
      save: this.save,
      built: this.built,
      player: this.player,
      teleport: (x: number, z: number, yaw: number) => this.player.teleport(x, z, yaw),
      logAllTargets: () => {
        this.built?.targets.forEach((t) => this.logTarget(t));
        this.logLedgerDiscrepancy();
      },
      depart: () => {
        if (this.built) {
          const el = this.built.grid.elevator;
          this.player.teleport(el.cx, el.cz, 0);
          this.beginDeparture();
        }
      },
    };
  }
}

// dev-only self-check: all floor specs must validate
export function devValidate(): void {
  if (import.meta.env.DEV) {
    void import('./world/grid').then(({ validateSpec }) => {
      for (const spec of FLOORS) {
        for (const err of validateSpec(spec)) {
          console.error(`[floor ${spec.floor}] ${err}`);
        }
      }
    });
  }
}
