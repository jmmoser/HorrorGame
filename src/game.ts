import * as THREE from 'three';
import { FLOORS } from './world/specs';
import { PALETTES } from './world/palette';
import {
  buildFloor,
  makeCollider,
  type ActiveTarget,
  type BuiltFloor,
  type MundaneTarget,
  type NoticeTarget,
} from './world/builder';
import { fillTokens } from './world/discrepancies';
import { AMENDMENTS, MUNDANE_TOASTS, MUNDANE_TOAST_WEARY, mundaneEntry } from './world/mundane';
import { CS, WALL_H, cellCenter, charAt, facingToYaw, isWalkable } from './world/grid';
import { setTextureAnisotropy } from './world/textures';
import { floorRng, hashCombine, mulberry32 } from './core/rng';
import type { AlterationDef, EntryKind, LedgerEntry, SaveData } from './core/types';
import { caseNumber, eraseSave, writeSave } from './core/save';
import { Controls } from './player/controls';
import { Player } from './player/player';
import { AudioEngine } from './audio/audio';
import { Haptics } from './audio/haptics';
import { Pipeline } from './render/pipeline';
import { GRADES } from './render/grades';
import { assignShadowCasters, gatherVolumetricLights } from './render/lighting';
import { loadSettings, resolveProfile, saveSettings, type QualityProfile, type Settings } from './render/quality';
import { Hud } from './ui/hud';
import { LedgerUI } from './ui/ledger';
import { SettingsUI } from './ui/settings';
import { shareCard } from './ui/share';

type State = 'idle' | 'arriving' | 'play' | 'departing' | 'ending';

const INTERACT_DIST = 5.0;
/** seconds the inspector spends framing an observation before it is written */
const DOC_TIME = 1.0;
/** attention gained per act of documentation — the building reads the ledger */
const ATTN = { real: 0.1, overQuota: 0.25, amend: 0.2, mundane: 0.07, notice: 0.04 };
/** crossing these makes the building answer with an alteration of its own */
const ATTN_THRESHOLDS = [0.3, 0.6];

type AlterationKind = AlterationDef['kind'];

interface PendingAlteration {
  anchor: string;
  kind: AlterationKind;
  hiddenFor: number;
}

/** an altered prop, loggable a second time as an amendment */
interface AmendTarget {
  anchor: string;
  kind: AlterationKind;
  hit: THREE.Mesh;
  id: string;
  logged: boolean;
}

type InteractHit =
  | { kind: 'target'; target: ActiveTarget }
  | { kind: 'mundane'; target: MundaneTarget }
  | { kind: 'notice'; target: NoticeTarget }
  | { kind: 'amend'; target: AmendTarget }
  | { kind: 'call' }
  | { kind: 'panel' };

export class Game {
  readonly audio = new AudioEngine();
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private pipeline: Pipeline;
  private controls: Controls;
  private player: Player;
  private haptics = new Haptics();
  private hud = new Hud();
  private ledgerUI = new LedgerUI();
  private settingsUI = new SettingsUI();
  private ambient = new THREE.AmbientLight(0xffffff, 0.5);
  private flashlight = new THREE.SpotLight(0xfff2dc, 0, 20, 0.74, 0.92, 1.15);
  private flashTarget = new THREE.Object3D();
  private flashBase = 40;
  private settings: Settings;
  private profile: QualityProfile;

  private save: SaveData;
  private built: BuiltFloor | null = null;
  private collide: ReturnType<typeof makeCollider> | null = null;
  private state: State = 'idle';
  private stateT = 0;
  private time = 0;
  private depthShown = 1;
  private pending: PendingAlteration[] = [];
  /** the act of documentation: aim, hold the frame, then the pencil */
  private documenting: { hit: InteractHit; t: number } | null = null;
  private baseFov: number;
  /** eased 0..1 — how far into the held frame the shallow focus has gone */
  private docFocus = 0;
  /** per-floor: how much the building has noticed the documentation */
  private attention = 0;
  private attnCrossed = 0;
  private alteredAnchors = new Set<string>();
  private amendTargets: AmendTarget[] = [];
  private mundaneCount = 0;
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
    this.settings = loadSettings();
    this.profile = resolveProfile(this.settings);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // AA is the scene buffer's job now (MSAA where the tier affords it)
      antialias: false,
      powerPreference: 'high-performance',
    });

    // grazing angles are the default view down a corridor; take all the
    // anisotropic filtering the device will give
    setTextureAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    this.controls = new Controls(canvas);
    this.camera = new THREE.PerspectiveCamera(this.controls.isTouch ? 73 : 68, 1, 0.05, 60);
    this.baseFov = this.camera.fov;
    this.player = new Player(this.camera, this.controls);
    this.pipeline = new Pipeline(this.renderer, this.scene, this.camera, this.profile);
    this.pipeline.adaptive = this.settings.adaptiveResolution;
    this.pipeline.setFilmEffects(this.settings.filmEffects);
    this.applyPlayerSettings();
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.scene.add(this.ambient);
    this.scene.add(this.flashlight);
    this.scene.add(this.flashTarget);
    this.flashlight.target = this.flashTarget;
    // the beam the player aims is the one whose shadow they will notice
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(this.profile.shadowMapSize, this.profile.shadowMapSize);
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.camera.far = 22;
    this.flashlight.shadow.bias = -0.0012;
    this.flashlight.shadow.normalBias = 0.03;
    this.pipeline.setShadowSource(this.flashlight);

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
      await shareCard(this.save.floor, entry, caseNumber(this.save.seed));
    };
    this.ledgerUI.onAlteredTap = () => this.logLedgerDiscrepancy();

    this.audio.onCaption = (text) => this.hud.showCaption(text);
    this.settingsUI.onChange = (s) => this.applySettings(s);
    this.settingsUI.onClose = () => this.toggleSettings();
    document.getElementById('settings-btn')!.addEventListener('click', () => this.toggleSettings());
    window.addEventListener('keydown', (e) => {
      // Escape is the pause key everywhere; it also backs out of the ledger
      if (e.key !== 'Escape') return;
      if (this.ledgerUI.isOpen) this.toggleLedger();
      else this.toggleSettings();
    });

    window.addEventListener('visibilitychange', () => {
      if (document.hidden) this.persist();
    });
    window.addEventListener('pagehide', () => this.persist());
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.pipeline.setSize(w, h, window.devicePixelRatio || 1);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- settings

  get currentSettings(): Settings {
    return { ...this.settings };
  }

  applySettings(next: Settings) {
    const qualityChanged = next.quality !== this.settings.quality;
    this.settings = { ...next };
    saveSettings(this.settings);

    if (qualityChanged) {
      this.profile = resolveProfile(this.settings);
      this.pipeline.setProfile(this.profile);
      this.flashlight.shadow.mapSize.set(this.profile.shadowMapSize, this.profile.shadowMapSize);
      this.flashlight.shadow.map?.dispose();
      this.flashlight.shadow.map = null;
      if (this.built) assignShadowCasters(this.built.fixtureLights, this.profile);
      this.resize();
    }
    this.pipeline.adaptive = this.settings.adaptiveResolution;
    this.pipeline.setFilmEffects(this.settings.filmEffects);
    this.applyPlayerSettings();
  }

  private applyPlayerSettings() {
    this.controls.sensitivity = this.settings.lookSensitivity;
    this.controls.invertY = this.settings.invertY;
    this.player.headBob = this.settings.headBob;
    this.audio.setMasterVolume(this.settings.masterVolume);
    this.audio.captions = this.settings.captions;
    this.haptics.enabled = this.settings.haptics;
    this.baseFov = (this.controls.isTouch ? 73 : 68) + this.settings.fovOffset;
    this.hud.setFpsVisible(this.settings.showFps);
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
    this.documenting = null;
    this.hud.setDocProgress(null);
    this.attention = 0;
    this.attnCrossed = 0;
    this.alteredAnchors = new Set();
    this.amendTargets = [];
    this.mundaneCount = 0;
    if (floorNum > FLOORS.length) {
      this.beginEnding();
      return;
    }
    const spec = FLOORS[floorNum - 1];
    const palette = PALETTES[spec.palette];
    const built = buildFloor(spec, this.save.seed);
    this.built = built;
    this.scene.add(built.group);
    // volumetric in-scattering now supplies most of the near-field haze, so the
    // exponential fog steps back to being a draw-distance fade
    this.scene.fog = new THREE.FogExp2(
      palette.fog,
      palette.fogDensity * (this.profile.volumetrics ? 0.6 : 1),
    );
    this.scene.background = new THREE.Color(palette.fog);
    this.ambient.color.set(palette.ambient);
    this.ambient.intensity = palette.ambientIntensity;
    this.flashlight.color.set(palette.flashlight);
    this.flashlight.intensity = this.flashBase;
    this.pipeline.setGrade(GRADES[spec.palette]);
    this.pipeline.setCeilingHeight(spec.ceilingHeight);
    assignShadowCasters(built.fixtureLights, this.profile);
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
        if (alt) this.applyAlterationNow(alt.anchor, alt.kind);
      }
    }
    // restore mundane logs and transcriptions (resume)
    for (const m of built.mundanes) {
      m.logged = this.save.logged.includes(`m-f${spec.floor}-${m.anchor}`);
      if (m.logged) this.mundaneCount += 1;
    }
    for (const n of built.notices) {
      n.logged = this.save.logged.includes(`note-f${spec.floor}-${n.anchor}`);
    }
    // recompute the building's attention from what was already logged here,
    // replaying any responses it had already made
    this.recomputeAttention(spec.floor, spec.quota);

    // spawn inside the car, facing the doors
    const el = built.grid.elevator;
    const yaw = facingToYaw(el.doorDir) + Math.PI; // props face +z; camera -z
    this.player.teleport(el.cx, el.cz, yaw);
    this.player.frozen = true;
    this.exitedCar = false;
    this.insideCarSince = 0;

    this.hud.setDepth(spec.floor);
    window.setTimeout(() => {
      if (this.built === built) this.hud.showFloorCard(spec.floor, spec.name, spec.schedule);
    }, 1600);
    this.depthShown = spec.floor;
    this.haptics.setDepth(spec.floor);
    this.audio.setFloor(spec, spec.floor, floorRng(this.save.seed, spec.floor * 977));
    this.audio.attachSpots(built.audioSpots);

    // floor 5: the ledger has been edited while the inspector was descending
    if (spec.floor === 5 && !this.save.ledgerAltered && this.save.ledger.length > 0) {
      const first =
        this.save.ledger.find((e) => (e.kind ?? 'discrepancy') === 'discrepancy') ??
        this.save.ledger[0];
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

  private writeEntry(
    id: string,
    floor: number,
    text: string,
    kind: EntryKind = 'discrepancy',
    anchor?: string,
    track = true,
  ): LedgerEntry {
    const s = Math.floor(this.save.elapsed);
    const stamp = [
      String(Math.floor(s / 3600)).padStart(2, '0'),
      String(Math.floor((s % 3600) / 60)).padStart(2, '0'),
      String(s % 60).padStart(2, '0'),
    ].join(':');
    const entry: LedgerEntry = { id, floor, stamp, text: fillTokens(text), kind, anchor };
    this.save.ledger.push(entry);
    if (track) this.save.logged.push(id);
    return entry;
  }

  private logTarget(t: ActiveTarget) {
    if (t.logged || !this.built) return;
    t.logged = true;
    this.writeEntry(t.sel.def.id, this.built.spec.floor, t.sel.entry, 'discrepancy', t.sel.def.anchor);
    this.audio.pencil();
    this.hud.showToast(t.sel.def.toast);
    this.hud.pulseTab();
    const alt = t.sel.def.alteration;
    if (alt) this.pending.push({ anchor: alt.anchor, kind: alt.kind, hiddenFor: 0 });
    const { logged, quota } = this.selectedQuotaProgress();
    this.bumpAttention(logged > quota ? ATTN.overQuota : ATTN.real);
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

  private logMundane(m: MundaneTarget) {
    if (m.logged || !this.built) return;
    m.logged = true;
    const floor = this.built.spec.floor;
    const anchor = this.built.spec.anchors[m.anchor];
    const rng = mulberry32(hashCombine(this.save.seed, floor * 333 + m.anchor.charCodeAt(0)));
    const text = (anchor && mundaneEntry(anchor, rng)) ?? 'As filed. No deviation.';
    this.writeEntry(`m-f${floor}-${m.anchor}`, floor, text, 'mundane', m.anchor);
    this.audio.pencil();
    this.mundaneCount += 1;
    this.hud.showToast(
      this.mundaneCount >= 3
        ? MUNDANE_TOAST_WEARY
        : MUNDANE_TOASTS[(this.mundaneCount - 1) % MUNDANE_TOASTS.length],
    );
    this.bumpAttention(ATTN.mundane);
    this.persist();
  }

  private logNotice(n: NoticeTarget) {
    if (n.logged || !this.built) return;
    n.logged = true;
    const floor = this.built.spec.floor;
    this.writeEntry(`note-f${floor}-${n.anchor}`, floor, n.entry, 'notice', n.anchor);
    this.audio.pencil();
    this.hud.showToast('transcribed into the ledger');
    this.hud.pulseTab();
    this.bumpAttention(ATTN.notice);
    this.persist();
  }

  private logAmend(a: AmendTarget) {
    if (a.logged || !this.built) return;
    a.logged = true;
    const floor = this.built.spec.floor;
    this.writeEntry(a.id, floor, AMENDMENTS[a.kind].entry, 'amend', a.anchor);
    this.audio.pencil();
    this.hud.showToast(AMENDMENTS[a.kind].toast);
    this.hud.pulseTab();
    this.bumpAttention(ATTN.amend);
    this.persist();
  }

  // ------------------------------------------------- the building's answers

  /** apply an alteration immediately and make the changed prop re-loggable */
  private applyAlterationNow(anchor: string, kind: AlterationKind) {
    const built = this.built;
    if (!built) return;
    const prop = built.props.get(anchor);
    if (!prop?.applyAlteration) return;
    prop.applyAlteration(kind);
    this.alteredAnchors.add(anchor);
    if (!prop.hit) return;
    const id = `amend-f${built.spec.floor}-${anchor}`;
    if (this.amendTargets.some((a) => a.id === id)) return;
    this.amendTargets.push({
      anchor,
      kind,
      hit: prop.hit,
      id,
      logged: this.save.logged.includes(id),
    });
  }

  private bumpAttention(v: number) {
    this.attention += v;
    while (
      this.attnCrossed < ATTN_THRESHOLDS.length &&
      this.attention >= ATTN_THRESHOLDS[this.attnCrossed]
    ) {
      this.attnCrossed += 1;
      this.queueAmbientAlteration(this.attnCrossed);
      this.audio.provoke();
    }
    this.audio.setAttention(Math.min(1, this.attention));
  }

  /** the building answers documentation with a change of its own — queued
   *  through the same never-on-screen machinery as authored alterations */
  private queueAmbientAlteration(idx: number, instant = false) {
    const built = this.built;
    if (!built) return;
    const pick = this.pickAmbientAlteration(idx);
    if (!pick) return;
    if (instant) this.applyAlterationNow(pick.anchor, pick.kind);
    else this.pending.push({ anchor: pick.anchor, kind: pick.kind, hiddenFor: 0 });
  }

  private pickAmbientAlteration(idx: number): { anchor: string; kind: AlterationKind } | null {
    const built = this.built;
    if (!built) return null;
    const targetAnchors = new Set(built.targets.map((t) => t.sel.def.anchor));
    const candidates: Array<{ anchor: string; kind: AlterationKind }> = [];
    for (const [letter, def] of Object.entries(built.spec.anchors)) {
      const prop = built.props.get(letter);
      if (!prop?.applyAlteration || !prop.hit) continue;
      if (this.alteredAnchors.has(letter) || targetAnchors.has(letter)) continue;
      if (this.pending.some((p) => p.anchor === letter)) continue;
      if (def.role === 'door') candidates.push({ anchor: letter, kind: 'door-ajar' });
      else if (def.role === 'chair') candidates.push({ anchor: letter, kind: 'chair-turned' });
      else if (def.role === 'light') {
        candidates.push({ anchor: letter, kind: prop.lit ? 'light-off' : 'light-on' });
      }
    }
    if (candidates.length === 0) return null;
    const rng = floorRng(this.save.seed, built.spec.floor * 131 + idx * 17);
    return candidates[Math.floor(rng() * candidates.length)];
  }

  /** on resume: rebuild attention from the ids already logged on this floor
   *  and re-apply any responses the building had already made */
  private recomputeAttention(floor: number, quota: number) {
    const ids = this.save.logged;
    const real = ids.filter((id) => id.startsWith(`f${floor}-`)).length;
    const mundane = ids.filter((id) => id.startsWith(`m-f${floor}-`)).length;
    const amends = ids.filter((id) => id.startsWith(`amend-f${floor}-`)).length;
    const notes = ids.filter((id) => id.startsWith(`note-f${floor}-`)).length;
    this.attention =
      ATTN.real * Math.min(real, quota) +
      ATTN.overQuota * Math.max(0, real - quota) +
      ATTN.mundane * mundane +
      ATTN.amend * amends +
      ATTN.notice * notes;
    while (
      this.attnCrossed < ATTN_THRESHOLDS.length &&
      this.attention >= ATTN_THRESHOLDS[this.attnCrossed]
    ) {
      this.attnCrossed += 1;
      this.queueAmbientAlteration(this.attnCrossed, true);
    }
    this.audio.setAttention(Math.min(1, this.attention));
  }

  /** the inspector walks only while playing, with nothing open over the world */
  private canMove(): boolean {
    return (
      this.state === 'play' &&
      !this.ledgerUI.isOpen &&
      !this.settingsUI.isOpen &&
      this.documenting === null
    );
  }

  private cancelDocumenting() {
    if (!this.documenting) return;
    this.documenting = null;
    this.hud.setDocProgress(null);
    this.player.frozen = !this.canMove();
  }

  private commitDocumenting(hit: InteractHit) {
    if (hit.kind === 'target') this.logTarget(hit.target);
    else if (hit.kind === 'mundane') this.logMundane(hit.target);
    else if (hit.kind === 'notice') this.logNotice(hit.target);
    else if (hit.kind === 'amend') this.logAmend(hit.target);
  }

  private inspect() {
    if (this.state !== 'play' || !this.built || this.ledgerUI.isOpen || this.documenting) return;
    const hit = this.raycastInteract();
    if (!hit) return;
    if (hit.kind === 'target' || hit.kind === 'mundane' || hit.kind === 'notice' || hit.kind === 'amend') {
      // documentation is an act, not a tap: hold the frame, then the pencil
      this.documenting = { hit, t: 0 };
      this.player.frozen = true;
      this.hud.setDocProgress(0);
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

  private raycastInteract(): InteractHit | null {
    if (!this.built) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = INTERACT_DIST;
    const meshes: THREE.Mesh[] = [];
    const targets = new Map<THREE.Mesh, ActiveTarget>();
    const mundanes = new Map<THREE.Mesh, MundaneTarget>();
    const notices = new Map<THREE.Mesh, NoticeTarget>();
    const amends = new Map<THREE.Mesh, AmendTarget>();
    for (const a of this.amendTargets) {
      if (!a.logged) {
        meshes.push(a.hit);
        amends.set(a.hit, a);
      }
    }
    for (const t of this.built.targets) {
      if (!t.logged) {
        meshes.push(t.hit);
        targets.set(t.hit, t);
      }
    }
    for (const n of this.built.notices) {
      if (!n.logged) {
        meshes.push(n.hit);
        notices.set(n.hit, n);
      }
    }
    for (const m of this.built.mundanes) {
      // an altered prop is an amendment now, not a "no deviation"
      if (!m.logged && !this.alteredAnchors.has(m.anchor)) {
        meshes.push(m.hit);
        mundanes.set(m.hit, m);
      }
    }
    meshes.push(this.built.elevator.buttonHit, this.built.elevator.panelHit);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    // don't let hitboxes read through walls
    const wallD = this.aimDistance(this.raycaster.ray.origin, this.raycaster.ray.direction);
    for (const h of hits) {
      if (h.distance > wallD + 0.6) break;
      const mesh = h.object as THREE.Mesh;
      const a = amends.get(mesh);
      if (a) return { kind: 'amend', target: a };
      const t = targets.get(mesh);
      if (t) return { kind: 'target', target: t };
      const n = notices.get(mesh);
      if (n) return { kind: 'notice', target: n };
      const m = mundanes.get(mesh);
      if (m) return { kind: 'mundane', target: m };
      if (mesh === this.built.elevator.buttonHit) return { kind: 'call' };
      if (mesh === this.built.elevator.panelHit) return { kind: 'panel' };
    }
    return null;
  }

  /** approximate distance to whatever the beam center lands on: floor,
   *  ceiling, or the first wall cell along the view ray. cheap grid march,
   *  no raycast against geometry. */
  private aimDistance(origin: THREE.Vector3, dir: THREE.Vector3): number {
    const MAX = 8;
    let d = MAX;
    if (dir.y < -1e-4) d = Math.min(d, -origin.y / dir.y);
    else if (dir.y > 1e-4) d = Math.min(d, (WALL_H - origin.y) / dir.y);
    const rows = this.built?.grid.rows;
    if (rows) {
      const step = 0.25;
      for (let t = step; t < d; t += step) {
        const cx = Math.floor((origin.x + dir.x * t) / CS);
        const cz = Math.floor((origin.z + dir.z * t) / CS);
        if (!isWalkable(charAt(rows, cx, cz))) {
          d = t;
          break;
        }
      }
    }
    return d;
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
    this.cancelDocumenting();
    this.fileFloor();
    this.state = 'departing';
    this.stateT = 0;
    this.player.frozen = true;
    this.built.elevator.closeDoors();
    this.audio.doorSlide(false);
  }

  /** the closing ritual: a filed summary line ruled under the floor's entries */
  private fileFloor() {
    if (!this.built) return;
    const f = this.built.spec.floor;
    const id = `filed-f${f}`;
    if (this.save.ledger.some((e) => e.id === id)) return;
    const onFloor = this.save.ledger.filter((e) => e.floor === f);
    const count = (k: EntryKind) => onFloor.filter((e) => (e.kind ?? 'discrepancy') === k).length;
    const disc = count('discrepancy');
    const amends = count('amend');
    const obs = count('mundane') + count('notice');
    this.writeEntry(
      id,
      f,
      `FLOOR −${String(f).padStart(2, '0')} FILED · ${disc} DISCREPANCIES · ${amends} AMENDMENTS · ${obs} OBSERVATIONS`,
      'filed',
      undefined,
      false,
    );
  }

  private beginEnding() {
    // there is no floor six on the schedule
    this.state = 'ending';
    this.stateT = 0;
    this.endingTimer = 0;
    this.setFade(true);
    this.audio.duck();
    this.haptics.stop();
    const countKind = (k: EntryKind) =>
      this.save.ledger.filter((e) => (e.kind ?? 'discrepancy') === k).length;
    const disc = countKind('discrepancy');
    const amends = countKind('amend');
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
        <p class="title-visitor" style="display:block">
          ${disc} DISCREPANCIES · ${amends} AMENDMENTS · ${caseNumber(this.save.seed)}
        </p>
        <button id="btn-end-share" class="ghost-btn">tear out a page</button>
        <button id="btn-end-new" class="ghost-btn">request reassignment</button>
      </div>`;
    document.getElementById('btn-end-share')!.addEventListener('click', async () => {
      const entry = this.save.ledger.length
        ? this.save.ledger[this.save.ledger.length - 1]
        : null;
      await shareCard(this.depthShown, entry, caseNumber(this.save.seed));
    });
    // a new case number: a different building, wearing the same building
    document.getElementById('btn-end-new')!.addEventListener('click', () => {
      eraseSave();
      location.reload();
    });
    this.hud.hide();
    this.controls.enabled = false;
    document.getElementById('touch-ui')!.classList.add('hidden');
    this.persist();
  }

  // ---------------------------------------------------------------- ledger

  private toggleSettings() {
    if (this.settingsUI.isOpen) {
      this.settingsUI.close();
      this.controls.enabled = true;
      this.player.frozen = !this.canMove();
    } else if (this.state === 'play' || this.state === 'arriving') {
      this.cancelDocumenting();
      if (this.ledgerUI.isOpen) this.ledgerUI.close();
      this.settingsUI.open(this.settings);
      // the pointer belongs to the form while the form is open
      this.controls.enabled = false;
      this.player.frozen = true;
    }
  }

  private toggleLedger() {
    if (this.ledgerUI.isOpen) {
      this.ledgerUI.close();
      this.player.frozen = !this.canMove();
    } else if (this.state === 'play' || this.state === 'arriving') {
      this.openLedger();
    }
  }

  private openLedger() {
    if (!this.built) return;
    this.cancelDocumenting();
    this.audio.pageTurn();
    const { logged, quota } = this.selectedQuotaProgress();
    this.ledgerUI.open(
      this.save.ledger,
      this.built.spec.floor,
      logged,
      quota,
      this.built.spec.map,
      this.built.spec.schedule,
      caseNumber(this.save.seed),
    );
    this.player.frozen = true;
  }

  // ---------------------------------------------------------------- update

  private update(dt: number) {
    this.time += dt;
    this.stateT += dt;
    const built = this.built;
    if (!built) {
      if (this.state === 'ending') this.updateEnding(dt);
      this.pipeline.render(dt);
      return;
    }

    // elevator doors always animate
    const el = built.grid.elevator;
    built.elevator.updateDoors(dt, el.doorX, el.doorZ, el.doorW / 2);

    if (this.state === 'arriving') {
      if (this.stateT > 1.6) {
        this.state = 'play';
        this.player.frozen = !this.canMove();
      }
    } else if (this.state === 'play') {
      this.save.elapsed += dt;
      this.player.frozen = !this.canMove();

      // the act of documentation: hold the frame until the pencil moves
      if (this.documenting) {
        this.documenting.t += dt;
        this.hud.setDocProgress(this.documenting.t / DOC_TIME);
        if (this.documenting.t >= DOC_TIME) {
          const hit = this.documenting.hit;
          this.documenting = null;
          this.hud.setDocProgress(null);
          this.commitDocumenting(hit);
          this.player.frozen = !this.canMove();
        }
      }

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

    // documenting narrows the frame a breath — attention made physical
    const fovTarget = this.documenting ? this.baseFov - 4 : this.baseFov;
    if (Math.abs(this.camera.fov - fovTarget) > 0.01) {
      this.camera.fov += (fovTarget - this.camera.fov) * Math.min(1, dt * 6);
      this.camera.updateProjectionMatrix();
    }

    // flashlight follows the camera with a breath of lag
    const camPos = this.camera.position;
    this.flashlight.position.lerp(
      new THREE.Vector3(camPos.x, camPos.y - 0.12, camPos.z),
      Math.min(1, dt * 20),
    );
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const targetPos = camPos.clone().add(fwd.multiplyScalar(6));
    this.flashTarget.position.lerp(targetPos, Math.min(1, dt * 9));

    // auto-dim toward near surfaces so paper at arm's length stays paper,
    // never a white bloom. iris-like: eases in and out.
    const aim = this.aimDistance(camPos, fwd);
    const dimTarget = this.flashBase * THREE.MathUtils.clamp(aim / 3.2, 0.25, 1);
    this.flashlight.intensity += (dimTarget - this.flashlight.intensity) * Math.min(1, dt * 7);

    // the frame the inspector is holding is the frame that is sharp
    const docT = this.documenting ? Math.min(1, this.documenting.t / DOC_TIME) : 0;
    this.docFocus += (docT - this.docFocus) * Math.min(1, dt * 5);
    this.pipeline.setDof(this.docFocus * 0.85, Math.max(0.8, aim), 1.4);

    // light the dust: the flashlight first, then whatever fixtures are near
    this.pipeline.setVolumetricLights(
      gatherVolumetricLights(this.flashlight, built.fixtureLights, camPos, this.profile),
    );

    // props
    for (const u of built.updatables) u(dt, this.time);

    // reticle
    if (this.state === 'play' && !this.ledgerUI.isOpen && !this.settingsUI.isOpen) {
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
          this.applyAlterationNow(p.anchor, p.kind);
          return false;
        }
        return true;
      });
    }

    // audio
    const playerV = new THREE.Vector3(this.player.pos.x, 1.5, this.player.pos.y);
    this.audio.updateListener(this.camera, playerV);
    // stepping into the car swaps the floor's tail for a small metal box; a
    // closed door seals it. The crossfade is what sells the elevator as a room.
    const carness = this.playerInsideCar()
      ? built.elevator.doorsClosed
        ? 1
        : 0.6
      : Math.max(0, 1 - (this.distToCar() - 1.2) / 2.2);
    this.audio.setEnclosure(carness);
    if (this.state === 'play') {
      this.audio.tick(playerV, () => {
        // an interested building lets its sounds come closer
        const minD = 8 - 5 * this.audio.attention;
        const candidates = this.walkableCenters.filter((c) => {
          const d = c.distanceTo(playerV);
          return d > minD && d < 26;
        });
        if (candidates.length === 0) return null;
        return candidates[Math.floor(Math.random() * candidates.length)];
      });
    }

    // periodic autosave
    if (this.time - this.lastSaveWrite > 20 && this.state === 'play') {
      this.persist();
    }

    this.hud.setFps(this.pipeline.smoothedFrameMs);
    this.pipeline.render(dt);
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
      logMundane: () => {
        const m = this.built?.mundanes.find((x) => !x.logged && !this.alteredAnchors.has(x.anchor));
        if (m) this.logMundane(m);
      },
      logNotice: () => {
        const n = this.built?.notices.find((x) => !x.logged);
        if (n) this.logNotice(n);
      },
      applyAlteration: (anchor: string, kind: AlterationKind) =>
        this.applyAlterationNow(anchor, kind),
      logAmend: () => {
        const a = this.amendTargets.find((x) => !x.logged);
        if (a) this.logAmend(a);
      },
      attention: () => this.attention,
      pipeline: this.pipeline,
      volSample: () => {
        const ls = gatherVolumetricLights(
          this.flashlight,
          this.built?.fixtureLights ?? [],
          this.camera.position,
          this.profile,
        );
        return ls.map((l) => ({
          pos: l.position.toArray().map((n) => +n.toFixed(2)),
          col: l.color.toArray().map((n) => +n.toFixed(4)),
          range: l.range,
          cos: [+l.cosOuter.toFixed(3), +l.cosInner.toFixed(3)],
        }));
      },
      setDebugView: (v: 'none' | 'ao' | 'vol' | 'bloom' | 'depth' | 'scene', gain = 1) => {
        this.pipeline.debugView = v;
        this.pipeline.debugGain = gain;
      },
      setVolShadow: (on: boolean) => {
        this.pipeline.debugNoVolShadow = !on;
      },
      amendTargets: () => this.amendTargets,
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
