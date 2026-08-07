import * as THREE from 'three';
import { FLOORS } from './world/specs';
import { PALETTES } from './world/palette';
import {
  buildFloor,
  makeCollider,
  type ActiveTarget,
  type BuiltFloor,
  type HandTarget,
  type MarkTarget,
  type MundaneTarget,
  type NoticeTarget,
} from './world/builder';
import type { PropInstance } from './world/props';
import { fillTokens } from './world/discrepancies';
import {
  AMENDMENTS,
  MUNDANE_TOASTS,
  MUNDANE_TOAST_WEARY,
  REVISION_AMENDMENT,
  interpolatedEntry,
  mundaneEntry,
  reviseEntry,
} from './world/mundane';
import { CS, WALL_H, cellCenter, charAt, facingToYaw, isWalkable } from './world/grid';
import { setTextureAnisotropy } from './world/textures';
import { floorRng, hashCombine, mulberry32 } from './core/rng';
import { Dread } from './core/dread';
import type {
  AlterationKind,
  EntryKind,
  HandVerb,
  LedgerEntry,
  PropAction,
  SaveData,
} from './core/types';
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
/**
 * Attention gained per act. Documenting is the job and costs the least;
 * touching the building costs more, because a record is a claim about the
 * floor and a hand is a change to it.
 */
const ATTN = {
  real: 0.1,
  overQuota: 0.25,
  amend: 0.2,
  mundane: 0.07,
  notice: 0.04,
  mark: 0.12,
  hand: 0.06,
  door: 0.14,
  knock: 0.22,
  hurry: 0.02,
};
/** crossing these makes the building answer with something of its own */
const ATTN_THRESHOLDS = [0.3, 0.6, 0.95, 1.4];
/** seconds in the dark before the eye is any use, and the writing shows */
const DARK_ADAPT_TIME = 14;

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
  | { kind: 'mark'; target: MarkTarget }
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
  private contextLost = false;
  private fader = document.getElementById('fader')!;

  // ---- the parts of the inspection nobody files a form for
  private dread = new Dread();
  /** the flashlight is the player's to switch off, and switching it off is
   *  the only way to read half of what is written down here */
  private lampOn = true;
  /** 0..1 — how far the eye has come in the inspector's own dark */
  private darkAdapt = 0;
  private handTarget: { target: HandTarget; actions: PropAction[] } | null = null;
  /** anchors the inspector has personally put back the way the record says */
  private setRight = new Set<string>();
  /** queued answers to knocks — the building never replies immediately */
  private answers: Array<{ at: number; pos: THREE.Vector3 }> = [];
  /** how many entries the building has rewritten this run */
  private revisions = 0;
  private lastRevisionAt = -999;
  /** the presence was in frame; used once per sighting */
  private sightings = 0;
  private lastBreathAt = -999;
  /** somewhere the building would like to be standing, once nobody is looking */
  private pendingPresence: { pos: THREE.Vector3; until: number } | null = null;

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
    this.controls.onHand = (secondary) => this.useHand(secondary);
    this.controls.onLamp = () => this.toggleLamp();
    this.player.onStep = (i, running) => {
      if (!this.built) return;
      this.audio.footstep(i, this.built.spec.palette, running);
      // A run is a sound, and a sound is a claim on the building's attention.
      // This is the whole bargain of the hurry: it is faster and it is heard.
      if (running) {
        this.attention += ATTN.hurry;
        this.dread.bump(0.012);
        this.audio.setAttention(Math.min(1, this.attention));
      }
    };

    this.hud.onLedgerTab(() => this.toggleLedger());
    this.ledgerUI.onClose = () => this.toggleLedger();
    this.ledgerUI.onShare = async () => {
      const entry = this.save.ledger.length
        ? this.save.ledger[this.save.ledger.length - 1]
        : null;
      await shareCard(this.save.floor, entry, caseNumber(this.save.seed));
    };
    this.ledgerUI.onAlteredTap = (entry) => this.logAlteredEntry(entry);

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

    // A backgrounded PWA or a driver reset can take the GL context away.
    // Without preventDefault the browser never offers it back, and without a
    // rebuild the inspector comes back to a black corridor.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.persist();
      this.setFade(true, true);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.pipeline.rebuildAfterContextLoss();
      setTextureAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
      this.resize();
      // three re-uploads textures and geometry itself, but the floor's canvas
      // sources and shadow maps are cleanest to rebuild from the save
      if (this.state !== 'ending') this.loadFloor(this.save.floor);
    });
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
    // turning the occupant off has to take effect on the frame it is turned
    // off, not on the next floor — that is the entire point of the setting
    if (!this.settings.occupant) {
      this.built?.presence.dismiss();
      this.pendingPresence = null;
    }
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
    // the verb buttons are for thumbs; a keyboard already has E / F / Q
    this.hud.setVerbsVisible(this.controls.isTouch);
    if (this.controls.isTouch) document.getElementById('touch-ui')!.classList.remove('hidden');
    this.haptics.start();
    this.loadFloor(this.save.floor);
    const loop = (last: number) => {
      requestAnimationFrame((now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        // nothing to draw into, and every GL call would throw
        if (!this.contextLost) this.update(dt);
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
    this.handTarget = null;
    this.setRight = new Set();
    this.answers = [];
    this.pendingPresence = null;
    this.sightings = 0;
    this.lastBreathAt = -999;
    // the lamp comes back on between floors: the elevator is the one place
    // that has ever been on the inspector's side
    this.lampOn = true;
    this.darkAdapt = 0;
    this.hud.setLampOff(false);
    this.hud.setHandPrompt(null, null);
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
    for (const m of built.marks) {
      m.logged = this.save.logged.includes(`mark-f${spec.floor}-${m.anchor}`);
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
    // Floor one is the tutorial and is not allowed to say so. Two lines, once
    // per case, in the inspector's own register — the lamp in particular gates
    // an entire layer of the building and nothing else would ever teach it.
    if (spec.floor === 1 && this.save.ledger.length === 0) {
      const hint = (at: number, text: string) =>
        window.setTimeout(() => {
          if (this.built === built && this.state === 'play') this.hud.showToast(text);
        }, at);
      hint(26000, 'the hand reaches what the pencil cannot. handles, chairs, handsets.');
      hint(52000, 'the lamp switches off. some of this building is only there in the dark.');
    }
    this.depthShown = spec.floor;
    this.haptics.setDepth(spec.floor);
    this.audio.setFloor(spec, spec.floor, floorRng(this.save.seed, spec.floor * 977));
    this.audio.attachSpots(built.audioSpots);

    // floor 5: the ledger has been edited while the inspector was descending
    if (spec.floor === 5 && !this.save.ledgerAltered && this.save.ledger.length > 0) {
      // the climax needs an entry the inspector definitely wrote: anything the
      // building has already been at is not evidence of anything any more
      const own = (e: LedgerEntry) => !e.altered && !e.revisionId && !e.originalText;
      const first =
        this.save.ledger.find((e) => (e.kind ?? 'discrepancy') === 'discrepancy' && own(e)) ??
        this.save.ledger.find(own) ??
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

  /** writing that is only there in the dark, transcribed while it is */
  private logMark(m: MarkTarget) {
    if (m.logged || !this.built) return;
    m.logged = true;
    const floor = this.built.spec.floor;
    this.writeEntry(`mark-f${floor}-${m.anchor}`, floor, m.entry, 'notice', m.anchor);
    this.audio.pencil();
    this.hud.showToast('transcribed — it was there the whole time');
    this.hud.pulseTab();
    // reading what the building wrote is the most attention any single act
    // in this game buys. It is also the best writing in the building.
    this.bumpAttention(ATTN.mark);
    this.dread.bump(0.12);
    this.persist();
  }

  /**
   * The inspector notices the ledger has been edited. This is the one place
   * the game rewards suspicion of its own UI: re-reading old entries is a
   * verb, and it pays.
   */
  private logAlteredEntry(entry: LedgerEntry) {
    if (!this.built) return;
    // the authored floor-5 climax still has its own entry
    if (!entry.revisionId) {
      this.logLedgerDiscrepancy();
      return;
    }
    if (this.save.logged.includes(entry.revisionId)) return;
    entry.altered = false;
    this.writeEntry(entry.revisionId, this.built.spec.floor, REVISION_AMENDMENT.entry, 'amend');
    this.audio.pencil();
    this.hud.showToast(REVISION_AMENDMENT.toast);
    this.bumpAttention(ATTN.amend);
    this.dread.bump(0.16);
    this.persist();
    if (this.ledgerUI.isOpen) this.openLedger();
  }

  /**
   * The building's answer to being written about: it writes back, in the
   * inspector's hand, in the inspector's own ledger, while the ledger is shut
   * in the inspector's case. Never while the page is open — the edit is only
   * ever discovered, like everything else here.
   */
  private reviseLedger() {
    if (this.ledgerUI.isOpen) return;
    if (this.time - this.lastRevisionAt < 40) return;
    const rng = mulberry32(
      hashCombine(this.save.seed, 4409 + this.revisions * 131 + (this.built?.spec.floor ?? 0)),
    );
    const candidates = this.save.ledger.filter((e) => {
      const kind = e.kind ?? 'discrepancy';
      return !e.altered && !e.revisionId && (kind === 'discrepancy' || kind === 'mundane');
    });
    if (candidates.length === 0) return;
    this.lastRevisionAt = this.time;
    this.revisions += 1;
    if (rng() < 0.3) {
      // Not an edit — an addition. Numbered, dated, in the right handwriting.
      // It is flagged the same way a rewrite is, because from the inspector's
      // side there is no difference: this is not what I wrote.
      const id = `interp-${this.revisions}-${this.save.seed & 0xffff}`;
      const entry = this.writeEntry(
        id,
        this.built?.spec.floor ?? this.save.floor,
        interpolatedEntry(rng),
        'discrepancy',
        undefined,
        false,
      );
      entry.altered = true;
      entry.revisionId = `rev-${id}`;
    } else {
      const victim = candidates[Math.floor(rng() * candidates.length)];
      victim.originalText = victim.text;
      victim.text = reviseEntry(victim.text, rng);
      victim.altered = true;
      victim.revisionId = `rev-${victim.id}`;
    }
    this.hud.pulseTab();
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
      this.escalate(this.attnCrossed);
    }
    this.audio.setAttention(Math.min(1, this.attention));
  }

  /**
   * The building's replies get less like furniture as it goes.
   *
   *   1  something is different somewhere. Standard.
   *   2  it starts standing where you are about to look.
   *   3  it takes the floor's lights, all at once, slowly, with the sound
   *      tubes make when they let go. Not a cut — a decision.
   *   4  it edits the ledger.
   *
   * None of these can kill the inspector, because nothing here can. All of
   * them make the floor harder to finish, and every one of them is something
   * the player did to themselves by being thorough.
   */
  private escalate(level: number) {
    const built = this.built;
    if (!built) return;
    this.dread.bump(0.18 + level * 0.06);
    if (level === 2) {
      // it will be somewhere behind them within the minute
      built.presence.nextSoon(4);
    } else if (level === 3) {
      this.audio.swell(9, 1);
      window.setTimeout(() => this.killTheLights(), 2600);
    } else if (level >= 4) {
      this.audio.swell(11, 1);
      this.reviseLedger();
      built.presence.nextSoon(8);
    }
  }

  /**
   * Every fixture on the floor lets go together. The intensities are ramped
   * over a second and a half rather than zeroed, because a hitch and a hard
   * cut both read as a jump scare and neither is the point: the point is that
   * the floor is darker now and stays darker, and the flashlight is suddenly
   * the only thing there is, and switching *that* off was a mechanic you were
   * using two minutes ago.
   */
  private killTheLights() {
    const built = this.built;
    if (!built || this.state !== 'play') return;
    const dying: Array<{ anchor: string; prop: PropInstance }> = [];
    for (const [letter, prop] of built.props) {
      if (!prop.light || !prop.lit || !prop.setDim) continue;
      dying.push({ anchor: letter, prop });
      // stop the flicker loop fighting the fade, and make the fixture honest
      // about what it is now so an amendment can be written against it
      prop.lit = false;
      this.alteredAnchors.add(letter);
    }
    if (dying.length === 0) return;
    this.audio.lightsDie();
    const t0 = this.time;
    let finished = false;
    built.updatables.push(() => {
      if (finished) return;
      const k = Math.min(1, (this.time - t0) / 1.5);
      for (const d of dying) d.prop.setDim?.(1 - k);
      if (k >= 1) {
        finished = true;
        for (const d of dying) d.prop.applyAlteration?.('light-off');
        // one of them is left amendable, so the blackout is still worth an
        // entry. Registering all five would put five identical amendments in
        // the ledger, and the ledger is the thing this game is protecting.
        this.applyAlterationNow(dying[0].anchor, 'light-off');
      }
    });
    this.hud.showToast('the floor has gone dark');
  }

  /** the queued answers to the inspector's knocking, which never come at once */
  private serviceAnswers() {
    if (this.answers.length === 0) return;
    this.answers = this.answers.filter((a) => {
      if (this.time < a.at) return true;
      this.audio.knockBack(a.pos, 0);
      this.dread.bump(0.24);
      this.haptics.setDread(Math.min(1, this.dread.value));
      return false;
    });
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
    const marks = ids.filter((id) => id.startsWith(`mark-f${floor}-`)).length;
    this.attention =
      ATTN.real * Math.min(real, quota) +
      ATTN.overQuota * Math.max(0, real - quota) +
      ATTN.mundane * mundane +
      ATTN.amend * amends +
      ATTN.notice * notes +
      ATTN.mark * marks;
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
    else if (hit.kind === 'mark') this.logMark(hit.target);
    else if (hit.kind === 'amend') this.logAmend(hit.target);
  }

  private inspect() {
    if (this.state !== 'play' || !this.built || this.ledgerUI.isOpen || this.documenting) return;
    const hit = this.raycastInteract();
    if (!hit) return;
    if (hit.kind !== 'call' && hit.kind !== 'panel') {
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

  // ------------------------------------------------------------- the lamp

  /**
   * The flashlight is a choice. Off, the corridor is a rumour and the eye
   * takes fourteen seconds to become worth anything — and then the walls have
   * writing on them that the beam was bleaching out the whole time.
   *
   * The intensity is ramped rather than set, in `update`: a hard cut to black
   * is the same event as a hard cut to white, and this game does not make
   * either of them.
   */
  private toggleLamp() {
    if (this.state !== 'play') return;
    this.lampOn = !this.lampOn;
    this.hud.setLampOff(!this.lampOn);
    this.audio.deadClick();
    if (this.lampOn) {
      this.darkAdapt = 0;
    } else {
      // switching your own light off in a building that is paying attention
      this.dread.bump(0.1);
      this.hud.showToast('lamp off — give it a moment');
    }
  }

  // ------------------------------------------------------------- the hand

  /** what the reticle is on, if the hand can do anything to it */
  private findHandTarget(): { target: HandTarget; actions: PropAction[] } | null {
    if (!this.built) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = INTERACT_DIST;
    const byMesh = new Map<THREE.Mesh, HandTarget>();
    const meshes: THREE.Mesh[] = [];
    for (const h of this.built.hands) {
      meshes.push(h.hit);
      byMesh.set(h.hit, h);
    }
    if (meshes.length === 0) return null;
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const wallD = this.aimDistance(this.raycaster.ray.origin, this.raycaster.ray.direction);
    for (const hit of hits) {
      if (hit.distance > wallD + 0.6) break;
      const t = byMesh.get(hit.object as THREE.Mesh);
      if (!t) continue;
      const actions = t.prop.actions?.() ?? [];
      if (actions.length > 0) return { target: t, actions };
    }
    return null;
  }

  private useHand(secondary: boolean) {
    if (this.state !== 'play' || this.ledgerUI.isOpen || this.settingsUI.isOpen) return;
    const found = this.handTarget;
    if (!found) return;
    const action = secondary ? (found.actions[1] ?? found.actions[0]) : found.actions[0];
    this.performHand(found.target, action.id);
  }

  private performHand(t: HandTarget, verb: HandVerb) {
    const result = t.prop.act?.(verb) ?? 'none';
    if (result === 'none') return;
    // the reticle's idea of what is possible is a frame stale now
    this.handTarget = null;
    switch (result) {
      case 'locked':
        this.audio.handleRattle();
        this.hud.showToast('locked. thirty years locked.');
        this.bumpAttention(ATTN.hand);
        this.dread.bump(0.03);
        break;
      case 'opened':
        this.audio.doorSwing(true);
        this.hud.showToast('open. there is nothing behind it.');
        this.bumpAttention(ATTN.door);
        this.dread.bump(0.16);
        // a door the inspector opened is a door the building can stand in
        this.offerDoorway(t);
        break;
      case 'closed':
        this.audio.doorSwing(false);
        this.hud.showToast('shut. as filed.');
        this.setRight.add(t.anchor);
        this.bumpAttention(ATTN.hand);
        break;
      case 'knocked':
        this.audio.knock();
        this.bumpAttention(ATTN.knock);
        this.dread.bump(0.14);
        this.maybeAnswer(t.pos);
        break;
      case 'turned':
        this.audio.handleRattle();
        this.hud.showToast('turned back. as filed.');
        this.setRight.add(t.anchor);
        this.bumpAttention(ATTN.hand);
        break;
      case 'replaced':
        this.audio.handsetLift();
        this.hud.showToast('replaced in the cradle. as filed.');
        this.setRight.add(t.anchor);
        this.bumpAttention(ATTN.hand);
        break;
      case 'lifted': {
        // a line cut before the inspector was hired. Usually nothing is on it.
        this.audio.handsetLift();
        const interested = this.dread.value > 0.5;
        window.setTimeout(() => this.audio.deadLine(interested), 260);
        this.hud.showToast(interested ? 'the line is not dead' : 'dead. as filed.');
        this.bumpAttention(ATTN.hand);
        if (interested) this.dread.bump(0.2);
        break;
      }
    }
    // whatever the inspector puts right, the building has an opinion about
    if (result === 'closed' || result === 'turned' || result === 'replaced') {
      this.queueUndo(t);
    }
    this.persist();
  }

  /**
   * The inspector tidied something. The building will untidy it — off-screen,
   * through the same machinery as every other alteration — and then it is an
   * amendment, and the amendment is the best entry in the ledger, and writing
   * it costs attention. Every loop in this game closes like that.
   */
  private queueUndo(t: HandTarget) {
    const kind: AlterationKind | null =
      t.role === 'door' ? 'door-ajar'
      : t.role === 'chair' ? 'chair-turned'
      : t.role === 'phone' ? 'handset-lifted'
      : null;
    if (!kind) return;
    if (this.pending.some((p) => p.anchor === t.anchor)) return;
    this.alteredAnchors.delete(t.anchor);
    this.amendTargets = this.amendTargets.filter((a) => a.anchor !== t.anchor);
    this.pending.push({ anchor: t.anchor, kind, hiddenFor: 0 });
  }

  /**
   * A knock is a question. Whether it gets an answer is the only genuinely
   * random thing in this building, and the odds are the building's mood.
   */
  private maybeAnswer(pos: THREE.Vector3) {
    const chance = 0.18 + this.dread.value * 0.62;
    if (Math.random() > chance) return;
    // never immediately. The pause is what makes it an answer and not an echo.
    this.answers.push({ at: this.time + 2.2 + Math.random() * 4.5, pos: pos.clone() });
  }

  /**
   * An opened door is a place something can be standing when you look back.
   * Queued, never placed: the whole contract is that it is never seen
   * arriving, and the inspector is looking straight at the door they just
   * opened. It waits for them to look away. It is good at waiting.
   */
  private offerDoorway(t: HandTarget) {
    if (this.dread.value < 0.3) return;
    if (Math.random() > 0.35 + this.dread.value * 0.4) return;
    this.pendingPresence = { pos: new THREE.Vector3(t.pos.x, 0, t.pos.z), until: this.time + 90 };
  }

  private raycastInteract(): InteractHit | null {
    if (!this.built) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = INTERACT_DIST;
    const meshes: THREE.Mesh[] = [];
    const targets = new Map<THREE.Mesh, ActiveTarget>();
    const mundanes = new Map<THREE.Mesh, MundaneTarget>();
    const notices = new Map<THREE.Mesh, NoticeTarget>();
    const marks = new Map<THREE.Mesh, MarkTarget>();
    const amends = new Map<THREE.Mesh, AmendTarget>();
    // writing that is not currently legible is not currently transcribable —
    // the inspector cannot copy out what the inspector cannot read
    if (this.darkAdapt > 0.55) {
      for (const m of this.built.marks) {
        if (m.logged) continue;
        meshes.push(m.hit);
        marks.set(m.hit, m);
      }
    }
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
      const k = marks.get(mesh);
      if (k) return { kind: 'mark', target: k };
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
    // never a white bloom. iris-like: eases in and out. A lamp the inspector
    // has switched off is the same curve with the target at zero — the beam
    // dies over about half a second, the way a filament does.
    const aim = this.aimDistance(camPos, fwd);
    const dimTarget = this.lampOn
      ? this.flashBase * THREE.MathUtils.clamp(aim / 3.2, 0.25, 1)
      : 0;
    this.flashlight.intensity += (dimTarget - this.flashlight.intensity) * Math.min(1, dt * 7);

    // the eye in the inspector's own dark. Slow both ways, and instantly
    // spent the moment the lamp comes back — which is what makes switching it
    // off a decision rather than a toggle.
    if (this.lampOn) {
      this.darkAdapt = Math.max(0, this.darkAdapt - dt * 1.6);
    } else if (this.state === 'play') {
      this.darkAdapt = Math.min(1, this.darkAdapt + dt / DARK_ADAPT_TIME);
    }
    for (const m of built.marks) m.prop.setReveal?.(Math.max(0, this.darkAdapt * 1.25 - 0.25));
    this.dread.setDark(!this.lampOn && this.state === 'play', dt);

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

    // reticle, and what the hand could do to whatever it is on
    const live = this.state === 'play' && !this.ledgerUI.isOpen && !this.settingsUI.isOpen;
    if (live) {
      this.hud.setOnTarget(this.raycastInteract() !== null);
      this.handTarget = this.findHandTarget();
      const acts = this.handTarget?.actions ?? [];
      this.hud.setHandPrompt(acts[0]?.label ?? null, acts[1]?.label ?? null);
      this.hud.setHandHold(this.controls.handHold);
    } else {
      this.hud.setOnTarget(false);
      this.handTarget = null;
      this.hud.setHandPrompt(null, null);
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

    // ---- the grip, and the thing that is on this floor with the inspector
    const playerV = new THREE.Vector3(this.player.pos.x, 1.5, this.player.pos.y);
    const inCar = this.playerInsideCar();
    this.dread.setBase(Math.min(1, this.attention), built.spec.floor);
    if (inCar && built.elevator.doorsClosed) this.dread.relieve(dt);
    else this.dread.update(dt);
    this.serviceAnswers();
    this.updatePresence(dt, playerV, live);

    // documenting is a held frame and a held breath; you cannot hurry through
    // a doorway you are photographing, and you cannot hurry inside the car
    this.player.canHurry = this.state === 'play' && !this.documenting && !inCar;

    this.pipeline.setMood(this.dread.value, this.darkAdapt);
    this.haptics.setDread(this.dread.value);
    this.hud.setListening(this.audio.listenLevel);

    // past a certain interest the building stops answering with furniture
    if (this.state === 'play' && this.attention > 0.85 && Math.random() < dt * 0.012) {
      this.reviseLedger();
    }

    // audio
    this.audio.updateListener(this.camera, playerV);
    this.audio.setMood(
      this.dread.value,
      this.player.breath,
      this.controls.listening && this.player.still && this.state === 'play',
      dt,
    );
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

  /**
   * The occupant, once a frame.
   *
   * The frustum is rebuilt here rather than shared with the alteration pass
   * because the alteration pass only runs when something is queued, and this
   * has to be right on every frame the building is allowed to move — the one
   * guarantee the whole thing rests on is that it is never placed or removed
   * anywhere the camera could have seen it happen.
   */
  private updatePresence(dt: number, playerV: THREE.Vector3, live: boolean) {
    const built = this.built;
    if (!built) return;
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    fwd.y = 0;
    fwd.normalize();

    // a doorway the inspector opened, waiting for them to look somewhere else
    if (this.pendingPresence) {
      const p = this.pendingPresence;
      const chest = new THREE.Vector3(p.pos.x, 1.3, p.pos.z);
      if (this.time > p.until) {
        this.pendingPresence = null;
      } else if (!this.frustum.containsPoint(chest) && playerV.distanceTo(chest) > 4) {
        const yaw = Math.atan2(playerV.x - p.pos.x, playerV.z - p.pos.z) + Math.PI;
        built.presence.placeAt(p.pos, yaw, 'figure');
        this.pendingPresence = null;
      }
    }

    const event = built.presence.update(dt, {
      camera: this.camera,
      frustum: this.frustum,
      player: playerV,
      forward: fwd,
      dread: this.dread.value,
      // it does not resolve anything behind an open page, or in the car, or
      // between floors. The elevator is the one honest room in the building.
      allowed: live && this.settings.occupant && !this.playerInsideCar(),
    });

    if (event === 'seen') {
      this.sightings += 1;
      // the second time is worse than the first, and the building knows it
      this.dread.bump(0.3 + Math.min(0.25, this.sightings * 0.08));
      // no sting, ever. A sub-bass swell, long attack, already under the
      // floor before it was seen — the frame catches up with the sound.
      this.audio.swell(7 + Math.min(6, this.sightings * 2), 0.8);
      this.bumpAttention(ATTN.notice);
      if (this.settings.captions) this.hud.showCaption('someone is standing there');
    }

    // stopping to listen, in the dark, near it: the one thing it does with
    // sound. Rationed hard — twice a floor at most, and never twice in a row.
    const near = built.presence.distanceTo(playerV);
    if (
      this.controls.listening &&
      this.player.still &&
      near < 11 &&
      this.time - this.lastBreathAt > 45 &&
      this.state === 'play'
    ) {
      this.lastBreathAt = this.time;
      const p = new THREE.Vector3(playerV.x, 1.5, playerV.z).addScaledVector(fwd, -1.1);
      this.audio.breathAt(p);
      this.dread.bump(0.3);
    }
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
      logMark: () => {
        const m = this.built?.marks.find((x) => !x.logged);
        if (m) this.logMark(m);
      },
      marks: () => this.built?.marks.map((m) => ({ anchor: m.anchor, logged: m.logged })) ?? [],
      hands: () =>
        this.built?.hands.map((h) => ({
          anchor: h.anchor,
          role: h.role,
          actions: (h.prop.actions?.() ?? []).map((a) => a.id),
        })) ?? [],
      hand: (anchor: string, verb: HandVerb) => {
        const t = this.built?.hands.find((h) => h.anchor === anchor);
        if (t) this.performHand(t, verb);
      },
      setLamp: (on: boolean) => {
        if (this.lampOn !== on) this.toggleLamp();
      },
      setDarkAdapt: (v: number) => {
        this.darkAdapt = v;
      },
      dread: () => this.dread.value,
      presence: () => this.built?.presence ?? null,
      summonPresence: () => this.built?.presence.nextSoon(0),
      escalate: (level: number) => this.escalate(level),
      reviseLedger: () => {
        this.lastRevisionAt = -999;
        this.reviseLedger();
      },
      logRevision: () => {
        const e = this.save.ledger.find((x) => x.altered && x.revisionId);
        if (e) this.logAlteredEntry(e);
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
