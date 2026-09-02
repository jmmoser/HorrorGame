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
import { Overlay } from './ui/overlay';
import { shareCard } from './ui/share';
import { Dread, type DreadLevel, type DreadPhase, type ScareKind } from './core/dread';
import { Watcher } from './core/watcher';
import { Presence } from './world/presence';
import { observation } from './world/observations';

type State = 'idle' | 'arriving' | 'play' | 'departing' | 'ending';

const INTERACT_DIST = 5.0;
/** the figure is documented from further off than a desk — nobody walks up to it */
const FIGURE_DIST = 9.0;
/** seconds the inspector spends framing an observation before it is written */
const DOC_TIME = 1.0;
/** the figure takes longer to get down on paper. the hands are not steady. */
const DOC_TIME_FIGURE = 1.8;
/** what is filed when the inspector documents it on a floor with no line of its own */
const FIGURE_ENTRY_DEFAULT =
  'A figure, standing, facing me. Too tall. It is not on the schedule. Logged.';
/** what the car does to the record, one entry per floor, below the schedule */
const ENDING_REWRITES = [
  'There was nothing on this floor. I have checked. I was alone. The floor is correct.',
  'No deviation. No deviation. No deviation. The schedule is correct and always was.',
  'I did not write the entry above this one. I am writing this one. I am sure of that.',
  'The inspector was cooperative throughout. The inspector signed out.',
  'FLOOR — FILED · 0 DISCREPANCIES · 0 AMENDMENTS · 0 OBSERVATIONS',
];
/** seconds between floors, once there are no more floors */
const ENDING_TICK = 7;
/** attention gained per act of documentation — the building reads the ledger */
const ATTN = { real: 0.1, overQuota: 0.25, amend: 0.2, mundane: 0.07, notice: 0.04 };
/** crossing these makes the building answer with an alteration of its own */
const ATTN_THRESHOLDS = [0.3, 0.6];

/** how loud the scare bus runs at each exposure setting */
const DREAD_AUDIO: Record<DreadLevel, number> = {
  off: 0,
  unsettling: 0.45,
  severe: 0.75,
  nightmare: 1,
};

/** what the building writes across the frame. all of it is in the ledger's
 *  own register, which is what makes it worse than a threat would be. */
const DREAD_WORDS = [
  'STOP WRITING',
  'YOU ARE NOT ALONE ON THIS FLOOR',
  'I READ IT',
  'PUT IT DOWN',
  'IT IS BEHIND YOU',
  'THERE IS NO FLOOR SIX',
  'LOOK UP',
  'YOU HAVE BEEN HERE BEFORE',
  'DO NOT FILE THIS',
  'IT KNOWS YOUR CASE NUMBER',
];

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
  | { kind: 'figure' }
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
  private contextLost = false;
  private fader = document.getElementById('fader')!;

  // ---- the escalation
  private dread = new Dread();
  /** the model of the person playing: what they flinch at, and how settled
   *  they have become since the last thing that worked */
  private watcher = new Watcher();
  private overlay: Overlay;
  private presence: Presence | null = null;
  /** last frame's floor position, for the velocity the presence aims ahead of */
  private lastPlayerPos = new THREE.Vector2();
  private playerVel = { x: 0, z: 0 };
  /** the building turning the inspector's head: target yaw and remaining time */
  private snap: { yaw: number; t: number } | null = null;
  /** ambient intensity before the light goes out, so it can come back */
  private ambientBase = 0.5;
  /** the flashlight's eased level, before the director's flicker is applied */
  private flashSmooth = 40;
  /** the eased field of view, before the director's kick is added */
  private fovSmooth = 0;
  /** one contact per floor is enough; more than that and it is a mechanic */
  private contactsThisFloor = 0;
  /** below the schedule: how many entries the car has taken so far */
  private endingRewrites = 0;
  private endingCardShown = false;

  constructor(canvas: HTMLCanvasElement, save: SaveData) {
    this.save = save;
    // the faces are drawn now, while the title is still fading: the first
    // flash must not be the frame that pays for generating it
    this.overlay = new Overlay(save.seed);
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

    this.dread.watcher = this.watcher;
    this.dread.onScare = (kind, intensity) => this.scare(kind, intensity);
    this.dread.onBeat = (intensity) => {
      this.audio.heartbeat(intensity);
      if (intensity > 0.72 && Math.random() < 0.25) this.haptics.jolt('small');
    };
    this.dread.onPhase = (phase, seconds) => this.onPhase(phase, seconds);

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
    this.controls.sensitivity = this.settings.lookSensitivity;
    this.controls.invertY = this.settings.invertY;
    this.player.headBob = this.settings.headBob;
    this.audio.setMasterVolume(this.settings.masterVolume);
    this.audio.captions = this.settings.captions;
    this.haptics.enabled = this.settings.haptics;
    this.baseFov = (this.controls.isTouch ? 73 : 68) + this.settings.fovOffset;
    this.hud.setFpsVisible(this.settings.showFps);

    // exposure: one setting drives the director, the scare bus, the overlay
    // and whether there is anything on the floor with you
    const level = this.settings.dread;
    this.dread.setLevel(level);
    this.audio.setDreadScale(DREAD_AUDIO[level]);
    this.overlay.enabled = level !== 'off';
    if (this.presence) this.presence.enabled = this.dread.presenceAllowed;
    if (level === 'off') {
      this.overlay.clear();
      this.pipeline.setDread(this.dread.frame);
      this.ambient.intensity = this.ambientBase;
    }
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
    this.contactsThisFloor = 0;
    this.snap = null;
    this.overlay.clear();
    if (this.presence) {
      this.scene.remove(this.presence.group);
      this.presence.dispose();
      this.presence = null;
    }
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
    this.ambientBase = palette.ambientIntensity;
    this.ambient.intensity = palette.ambientIntensity;
    this.flashlight.color.set(palette.flashlight);
    this.flashlight.intensity = this.flashBase;
    this.flashSmooth = this.flashBase;
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
    this.hud.setQuota(this.selectedQuotaProgress());

    // spawn inside the car, facing the doors
    const el = built.grid.elevator;
    const yaw = facingToYaw(el.doorDir) + Math.PI; // props face +z; camera -z
    this.player.teleport(el.cx, el.cz, yaw);
    // the velocity the figure aims ahead of is a difference between frames;
    // seed it from the new floor so arriving is not read as a sprint
    this.lastPlayerPos.copy(this.player.pos);
    this.playerVel.x = this.playerVel.z = 0;
    this.player.frozen = true;
    this.exitedCar = false;
    this.insideCarSince = 0;

    // ---- there is something on this floor, and it is not on the schedule
    this.dread.setFloor(spec.floor);
    const presence = new Presence(hashCombine(this.save.seed, spec.floor * 7717 + 13));
    presence.enabled = this.dread.presenceAllowed;
    presence.onSighting = (d) => this.onSighting(d);
    presence.onBlink = () => {
      this.audio.staticBurst(0.1);
      this.dread.kick(0.35, { static: 0.45 });
    };
    presence.onContact = () => this.onContact();
    // filed on a previous visit (resume): it stays filed for a long while
    if (this.save.logged.includes(this.figureId(spec.floor))) presence.banish(60, 90);
    this.scene.add(presence.group);
    this.presence = presence;

    this.hud.setDepth(spec.floor);
    window.setTimeout(() => {
      if (this.built !== built) return;
      // the first floor also carries the field procedure — the only place the
      // game says how it is played, and it says it as a form would
      const procedure =
        spec.floor === 1
          ? [
              'FIELD PROCEDURE 7-A',
              'AIM AT ANYTHING · TAP TO DOCUMENT',
              'LOG WHAT THE SCHEDULE DOES NOT LIST',
              'THE CALL BUTTON LIGHTS AT QUOTA',
            ]
          : [];
      this.hud.showFloorCard(spec.floor, spec.name, spec.schedule, procedure);
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

  /** the ledger id of the figure, filed, on a given floor */
  private figureId(floor: number): string {
    return `f${floor}-figure`;
  }

  private selectedQuotaProgress(): { logged: number; quota: number } {
    if (!this.built) return { logged: 0, quota: 1 };
    const ids = this.built.targets.map((t) => t.sel.def.id);
    if (this.built.ledgerDiscrepancy) ids.push(this.built.ledgerDiscrepancy.def.id);
    // the thing that is not on the schedule is, once filed, the best finding
    // on the floor
    ids.push(this.figureId(this.built.spec.floor));
    const logged = ids.filter((id) => this.save.logged.includes(id)).length;
    return { logged, quota: this.built.spec.quota };
  }

  private refreshQuota(announce: boolean) {
    if (!this.built) return;
    const progress = this.selectedQuotaProgress();
    const { logged, quota } = progress;
    this.hud.setQuota(progress);
    const met = logged >= quota;
    if (met && !this.built.elevator.callActive) {
      this.built.elevator.setCallActive(true);
      if (announce) {
        this.audio.quotaCue();
        window.setTimeout(() => this.hud.showToast('the call button is lit'), 1800);
      }
    } else if (!met && this.built.elevator.callActive) {
      // a page has gone: the building withdraws the offer
      this.built.elevator.setCallActive(false);
      if (announce) {
        this.audio.deadClick();
        window.setTimeout(() => this.hud.showToast('the call button has gone dark'), 3200);
      }
    }
  }

  /** a one-time line of field guidance, shown once per inspector, ever */
  private hint(key: string, text: string, delayMs = 0) {
    const seen = (this.save.hints ??= []);
    if (seen.includes(key)) return;
    seen.push(key);
    window.setTimeout(() => {
      if (this.state === 'play') this.hud.showToast(text);
    }, delayMs);
    this.persist();
  }

  private writeEntry(
    id: string,
    floor: number,
    text: string,
    kind: EntryKind = 'discrepancy',
    anchor?: string,
    track = true,
    /** seconds past the inspector's own clock to stamp this from */
    ahead = 0,
  ): LedgerEntry {
    const s = Math.floor(this.save.elapsed + ahead);
    const stamp = [
      String(Math.floor(s / 3600)).padStart(2, '0'),
      String(Math.floor((s % 3600) / 60)).padStart(2, '0'),
      String(s % 60).padStart(2, '0'),
    ].join(':');
    const entry: LedgerEntry = { id, floor, stamp, text: fillTokens(text), kind, anchor };
    this.save.ledger.push(entry);
    if (track) this.save.logged.push(id);
    // the watcher counts silence in the record — but only the inspector's own
    // handwriting resets that clock
    if (kind !== 'observed' && kind !== 'filed') this.watcher.noteLog();
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

  /**
   * The inspector has held the ledger on it long enough to write it down.
   * It goes — for most of the floor — and the record gains the only entry in
   * it that describes something looking back.
   */
  private logFigure() {
    const built = this.built;
    const p = this.presence;
    if (!built || !p) return;
    const id = this.figureId(built.spec.floor);
    if (this.save.logged.includes(id)) return;
    this.writeEntry(id, built.spec.floor, built.spec.figure ?? FIGURE_ENTRY_DEFAULT);
    this.audio.pencil();
    this.hud.showToast('logged: it is not on the schedule');
    this.hud.pulseTab();
    p.file(this.dread.intensity);
    this.audio.staticBurst(0.14);
    this.dread.kick(0.45, { static: 0.4 });
    this.haptics.jolt('small');
    // the building reads this one too, and it is the entry it minds most
    this.bumpAttention(ATTN.real + ATTN.amend);
    this.refreshQuota(true);
    this.persist();
  }

  /**
   * It reached the inspector, and it took something: the most recent page
   * written on this floor. The entry stays in the book, struck through, and
   * whatever it recorded is unrecorded again — the call button can go dark,
   * and the desk or the door or the figure has to be documented a second
   * time. There is still no death. There is, now, a cost.
   */
  private tearPage(): LedgerEntry | null {
    const built = this.built;
    if (!built) return null;
    const floor = built.spec.floor;
    for (let n = this.save.ledger.length - 1; n >= 0; n--) {
      const e = this.save.ledger[n];
      if (e.floor !== floor || e.torn) continue;
      const kind = e.kind ?? 'discrepancy';
      if (kind === 'filed' || kind === 'observed') continue;
      // the rewritten entry is the building's, and it does not take its own
      if (e.altered) continue;
      if (built.ledgerDiscrepancy && e.id === built.ledgerDiscrepancy.def.id) continue;
      e.torn = true;
      const idx = this.save.logged.indexOf(e.id);
      if (idx >= 0) this.save.logged.splice(idx, 1);
      for (const t of built.targets) if (t.sel.def.id === e.id) t.logged = false;
      for (const m of built.mundanes) {
        if (`m-f${floor}-${m.anchor}` === e.id) {
          m.logged = false;
          this.mundaneCount = Math.max(0, this.mundaneCount - 1);
        }
      }
      for (const nt of built.notices) if (`note-f${floor}-${nt.anchor}` === e.id) nt.logged = false;
      for (const a of this.amendTargets) if (a.id === e.id) a.logged = false;
      return e;
    }
    return null;
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
      // and it comes to see what is being written
      this.presence?.hurry();
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
    if (hit.kind === 'figure') {
      this.logFigure();
      return;
    }
    if (hit.kind === 'target') this.logTarget(hit.target);
    else if (hit.kind === 'mundane') this.logMundane(hit.target);
    else if (hit.kind === 'notice') this.logNotice(hit.target);
    else if (hit.kind === 'amend') this.logAmend(hit.target);
    // The pencil coming off the page was always the building's favourite
    // moment to make a sound. A sound is all it gets: documentation is the
    // loop the player lives in, and anything louder here becomes a filing fee.
    if (Math.random() < 0.12 + this.dread.intensity * 0.25) {
      this.scare(Math.random() < 0.3 ? 'whisper' : 'breath', this.dread.intensity);
    }
  }

  private inspect() {
    if (this.state !== 'play' || !this.built || this.ledgerUI.isOpen || this.documenting) return;
    const hit = this.raycastInteract();
    if (!hit) return;
    if (
      hit.kind === 'target' ||
      hit.kind === 'mundane' ||
      hit.kind === 'notice' ||
      hit.kind === 'amend' ||
      hit.kind === 'figure'
    ) {
      // documentation is an act, not a tap: hold the frame, then the pencil
      this.documenting = { hit, t: 0 };
      this.player.frozen = true;
      this.hud.setDocProgress(0);
      if (hit.kind === 'figure') this.audio.staticBurst(0.06);
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
    // the figure can be aimed at from further off than anything else, but
    // only while it is holding still for it
    const p = this.presence;
    const figureHit =
      p && p.documentable && !this.save.logged.includes(this.figureId(this.built.spec.floor))
        ? p.hit
        : null;
    if (figureHit) {
      meshes.push(figureHit);
      this.raycaster.far = FIGURE_DIST;
    }
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    // don't let hitboxes read through walls
    const wallD = this.aimDistance(this.raycaster.ray.origin, this.raycaster.ray.direction);
    for (const h of hits) {
      if (h.distance > wallD + 0.6) break;
      const mesh = h.object as THREE.Mesh;
      if (mesh === figureHit) return { kind: 'figure' };
      if (h.distance > INTERACT_DIST) continue;
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
    // torn pages are stubs, not findings; the filed line counts what is left
    const onFloor = this.save.ledger.filter((e) => e.floor === f && !e.torn);
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

  /**
   * There is no floor six on the schedule. There is, it turns out, a floor
   * six, and a seven, and the doors do not open on any of them. The inspector
   * stays in the car. The counter keeps counting. And every floor the car
   * passes, one more entry in the ledger stops being the inspector's.
   */
  private beginEnding() {
    if (!this.built) return;
    this.state = 'ending';
    this.stateT = 0;
    this.endingTimer = 0;
    this.endingRewrites = 0;
    this.endingCardShown = false;
    this.cancelDocumenting();
    this.player.frozen = true;
    this.overlay.clear();
    this.snap = null;
    this.dread.suspended = true;
    this.haptics.stop();
    this.depthShown = FLOORS.length;
    this.hud.setQuota(null);
    // the doors stay shut. the light comes back up on the inside of the car.
    this.built.elevator.closeDoors();
    this.setFade(false);
    this.audio.descend(ENDING_TICK * ENDING_REWRITES.length + 6);
    this.persist();
  }

  private updateEnding(dt: number) {
    const built = this.built;
    if (!built) return;
    this.endingTimer += dt;
    const el = built.elevator;
    // the car light: steady, then not
    const failing = Math.max(0, (this.endingTimer - ENDING_TICK * 3) / (ENDING_TICK * 2));
    el.setCarLight(
      Math.max(0, 1 - failing) * (Math.random() < 0.03 * (1 + failing * 8) ? 0.25 : 1),
    );
    const depth = FLOORS.length + 1 + Math.floor(this.endingTimer / ENDING_TICK);
    if (depth !== this.depthShown) {
      this.depthShown = depth;
      this.hud.setDepth(depth);
      this.audio.arrivalSettle();
      this.rewriteOne();
    }
    if (this.endingRewrites >= ENDING_REWRITES.length && !this.endingCardShown) {
      this.endingCardShown = true;
      el.setCarLight(0);
      this.setFade(true);
      window.setTimeout(() => this.showEndingCard(), 2600);
    }
  }

  /** the car takes one more entry, in the inspector's own hand */
  private rewriteOne() {
    const line = ENDING_REWRITES[this.endingRewrites];
    if (line === undefined) return;
    const target = this.save.ledger.find((e) => {
      const k = e.kind ?? 'discrepancy';
      return !e.altered && !e.torn && k !== 'filed' && k !== 'observed';
    });
    if (target) {
      target.originalText = target.text;
      target.text = line;
      target.altered = true;
      this.audio.deadClick();
      this.hud.pulseTab();
      if (this.ledgerUI.isOpen) this.openLedger();
    }
    this.endingRewrites += 1;
    this.persist();
  }

  private showEndingCard() {
    this.audio.duck();
    this.overlay.clear();
    this.camera.rotation.z = 0;
    this.pipeline.setDread({
      warp: 0, shakeX: 0, shakeY: 0, staticAmt: 0,
      red: 0, flash: 0, ca: 0, dark: 0, pulse: 0,
    });
    const countKind = (k: EntryKind) =>
      this.save.ledger.filter((e) => (e.kind ?? 'discrepancy') === k && !e.torn).length;
    const disc = countKind('discrepancy');
    const amends = countKind('amend');
    const taken = this.save.ledger.filter((e) => e.altered || e.torn).length;
    const title = document.getElementById('title')!;
    title.classList.remove('hidden');
    title.classList.remove('fading');
    title.innerHTML = `
      <div class="title-inner">
        <p class="title-over">MUNICIPAL SURVEY — STRUCTURE 7</p>
        <h1 class="title-name" id="ending-depth">FLOOR −${String(this.depthShown).padStart(2, '0')}</h1>
        <p class="title-brief">
          The schedule ends at floor five.<br/>
          The elevator has not stopped.<br/><br/>
          The inspection continues.
        </p>
        <p class="title-visitor" style="display:block">
          ${disc} DISCREPANCIES · ${amends} AMENDMENTS · ${taken} ENTRIES NO LONGER YOURS<br/>
          ${caseNumber(this.save.seed)}
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
    if (this.ledgerUI.isOpen) this.ledgerUI.close();
    this.controls.enabled = false;
    document.getElementById('touch-ui')!.classList.add('hidden');
    // the counter does not stop, even here
    window.setInterval(() => {
      this.depthShown += 1;
      const elDepth = document.getElementById('ending-depth');
      if (elDepth) elDepth.textContent = `FLOOR −${String(this.depthShown).padStart(2, '0')}`;
    }, ENDING_TICK * 1000);
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
    } else if (this.state === 'play' || this.state === 'arriving' || this.state === 'ending') {
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

  // ------------------------------------------------------------- escalation

  /** is there anything solid on the straight line between these two points? */
  private lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const rows = this.built?.grid.rows;
    if (!rows) return false;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return true;
    const steps = Math.ceil(dist / 0.28);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const cx = Math.floor((from.x + dx * t) / CS);
      const cz = Math.floor((from.z + dz * t) / CS);
      if (!isWalkable(charAt(rows, cx, cz))) return false;
    }
    return true;
  }

  /** a walkable cell centre this far from the inspector, or null */
  private pickCell(min: number, max: number): THREE.Vector3 | null {
    const p = new THREE.Vector3(this.player.pos.x, 1.3, this.player.pos.y);
    const candidates = this.walkableCenters.filter((c) => {
      const d = c.distanceTo(p);
      return d >= min && d <= max;
    });
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** somewhere out of sight to put a sound: behind a wall, or behind you */
  private pickUnseenSpot(min: number, max: number): THREE.Vector3 {
    const eye = new THREE.Vector3(this.player.pos.x, 1.5, this.player.pos.y);
    for (let i = 0; i < 8; i++) {
      const c = this.pickCell(min, max);
      if (c && !this.lineOfSight(eye, c)) return c;
    }
    // nothing hidden nearby: put it directly behind the inspector's head
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    return eye.clone().add(back.multiplyScalar(1.4));
  }

  /**
   * The director decided; this is what it costs. Every branch here is a
   * deliberate spike — image, sound and camera together, because any one of
   * them alone is something a player learns to tune out inside a floor.
   */
  private scare(kind: ScareKind, i: number) {
    if (this.state !== 'play') return;
    const strong = 0.4 + i * 0.6;

    switch (kind) {
      case 'face':
        this.overlay.flashFace({ ms: 55 + i * 45, fill: 0.85 + i * 0.5, static: 0.7 });
        this.audio.stinger(i);
        this.audio.staticBurst(0.09);
        this.dread.kick(0.55 + i * 0.4, { flash: 0.55, static: 0.5 });
        this.haptics.jolt('hard');
        break;

      case 'face-hold':
        // held long enough to be looked at, which is the mistake
        this.overlay.flashFace({ ms: 380, fill: 1.75, static: 0.25 });
        this.audio.scream(1);
        this.dread.kick(1.1, { flash: 0.7, static: 0.7, red: 0.55 });
        this.dread.killLight(1.4);
        this.haptics.jolt('contact');
        break;

      case 'static':
        this.overlay.flashStatic(70 + Math.random() * 140, 1);
        this.audio.staticBurst(0.2);
        this.dread.kick(0.3, { static: 0.9 });
        break;

      case 'whisper':
        this.audio.whisper(3 + Math.floor(Math.random() * 4));
        this.dread.kick(0.14);
        if (this.settings.captions) this.hud.showCaption('something said, close');
        break;

      case 'scream':
        this.audio.scream(strong, this.pickUnseenSpot(3, 14));
        this.overlay.flashWash('blood', 620, 0.75);
        this.dread.kick(0.85, { red: 0.5 });
        this.haptics.jolt('hard');
        if (this.settings.captions) this.hud.showCaption('screaming — close, indoors');
        break;

      case 'bang':
        this.audio.bang(this.pickUnseenSpot(2.5, 9), 0.8 + i * 0.6);
        this.dread.kick(0.7, { static: 0.15 });
        this.haptics.jolt('hard');
        if (this.settings.captions) this.hud.showCaption('an impact against a wall');
        break;

      case 'breath':
        this.audio.breath(2 + Math.floor(Math.random() * 3));
        this.dread.kick(0.1);
        if (this.settings.captions) this.hud.showCaption('breathing, at the ear');
        break;

      case 'blackout': {
        const dur = 1.1 + i * 2.2;
        this.dread.killLight(dur);
        this.audio.staticBurst(0.3);
        this.audio.subDrop(dur);
        // The light comes back on something that was not there when it went
        // out — the figure itself, down the beam, not a picture of one. It is
        // simply standing there when the filament warms; the sighting logic
        // provides the sting the moment the player registers it.
        window.setTimeout(() => {
          if (this.state !== 'play') return;
          const p = this.presence;
          if (p && p.enabled && p.state === 'gone' && this.collide) {
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
            const eye = new THREE.Vector3(this.player.pos.x, 1.5, this.player.pos.y);
            for (let d = 9.5; d >= 4.5; d -= 1.2) {
              const x = this.player.pos.x + fwd.x * d;
              const z = this.player.pos.y + fwd.z * d;
              const hit = this.collide(x, z, 0.3);
              if (Math.hypot(hit.x - x, hit.z - z) > 0.02) continue;
              if (!this.lineOfSight(eye, new THREE.Vector3(x, 1.9, z))) continue;
              p.place(new THREE.Vector3(x, 0, z), 'lurking');
              break;
            }
          }
          this.dread.kick(0.5, { static: 0.45 });
        }, dur * 1000);
        break;
      }

      case 'word':
        this.overlay.stabWord(DREAD_WORDS[Math.floor(Math.random() * DREAD_WORDS.length)], 900);
        this.audio.whisper(2);
        this.dread.kick(0.25, { static: 0.3 });
        break;

      case 'shadow': {
        // something crosses the beam, just inside the light, and is gone
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const at = new THREE.Vector3(this.player.pos.x, 0, this.player.pos.y).add(
          fwd.multiplyScalar(5 + Math.random() * 3),
        );
        const p = this.presence;
        if (p && p.enabled && p.state === 'gone') {
          p.place(at, 'lurking');
          window.setTimeout(() => p.banish(6, 14), 260 + Math.random() * 180);
        }
        this.audio.bang(at, 0.35);
        this.dread.kick(0.4, { static: 0.25 });
        break;
      }

      case 'headsnap': {
        // you did not turn your head. something turned it.
        const p = this.presence;
        const to =
          p && p.state !== 'gone'
            ? Math.atan2(-(p.pos.x - this.player.pos.x), -(p.pos.z - this.player.pos.y))
            : this.player.yaw + Math.PI * (0.55 + Math.random() * 0.9);
        this.snap = { yaw: to, t: 0.3 };
        this.audio.stinger(1);
        this.dread.kick(0.9, { static: 0.4 });
        this.haptics.jolt('hard');
        break;
      }

      case 'lurch':
        this.dread.dropFloor();
        this.audio.subDrop(1.4);
        this.audio.bang(undefined, 1.1);
        this.haptics.jolt('hard');
        break;

      case 'follow': {
        // steps behind, in the inspector's own rhythm — and one more than
        // they took. no stinger, no shake: the fright is arithmetic.
        const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
        const at = new THREE.Vector3(this.player.pos.x, 0, this.player.pos.y).add(
          back.multiplyScalar(2.4 + Math.random() * 1.6),
        );
        this.audio.followSteps(at, 4 + Math.floor(Math.random() * 3), 0.42 - i * 0.1);
        if (this.settings.captions) this.hud.showCaption('footsteps, behind — matching');
        break;
      }

      case 'stare': {
        // Put it in the one bearing they are not covering, silently, and then
        // do nothing whatsoever. This is the only scare in the file the
        // building does not spring: the player springs it, on their own
        // schedule, by deciding to turn around. Some never do.
        const p = this.presence;
        if (!p || !p.enabled || !this.collide) break;
        // never yank one that is already committed — a charge that teleports
        // is a glitch, and a glitch is the one thing that breaks the spell
        if (p.state !== 'gone' && p.state !== 'lurking') break;
        const spot = p.blindSpot(this.presenceContext(), 3.5, 6.5);
        if (spot) p.place(spot, 'lurking');
        break;
      }

      case 'observed':
        this.writeObservation();
        break;

      case 'closer':
        // the walls, without ever being seen to move. no sound at all.
        this.dread.contract(0.55 + i * 0.45);
        if (this.settings.captions) this.hud.showCaption('the room is smaller');
        break;
    }
  }

  /**
   * The building takes a breath and holds it. Everything that has been running
   * since the headphones went on — room tone, ventilation, the descent drone,
   * the flashlight's bad connection, the camera's permanent sway — stops at
   * once, and what fills the gap is a tone below hearing and the inspector's
   * own pulse. About a quarter of these resolve into nothing at all, which is
   * what makes the other three quarters unlivable.
   */
  private onPhase(phase: DreadPhase, seconds: number) {
    if (this.state !== 'play') return;
    if (phase === 'tell') {
      this.audio.swell(seconds);
      this.haptics.jolt('small');
    }
  }

  /** the building writes in the inspector's ledger, about the inspector */
  private writeObservation() {
    if (!this.built) return;
    const floor = this.built.spec.floor;
    const obs = observation({
      floor,
      stillFor: this.watcher.stillFor,
      sinceLog: this.watcher.sinceLog,
      lookBacks: this.watcher.lookBacks,
      floorT: this.watcher.floorT,
      elapsed: this.save.elapsed,
      // only the inspector's own handwriting counts here — the whole point of
      // the line about the handwriting is that these are not in it
      entries: this.save.ledger.filter((e) => {
        const k = e.kind ?? 'discrepancy';
        return k !== 'filed' && k !== 'observed';
      }).length,
      fear: this.watcher.fear,
      worst: this.watcher.worst(),
      unamended: this.amendTargets.filter((a) => !a.logged).length,
      reading: this.ledgerUI.isOpen,
      last: [...this.save.ledger].reverse().find((e) => e.kind === 'observed')?.text ?? null,
      rng: Math.random,
    });
    // `ahead` stamps it from further along than the inspector has reached.
    // Nothing in the fiction can produce a timestamp the clock has not got to.
    this.writeEntry(
      `obs-f${floor}-${this.save.ledger.length}`,
      floor,
      obs.text,
      'observed',
      undefined,
      false,
      obs.ahead,
    );
    // the pencil sound is the inspector's. this is not the pencil.
    this.audio.deadClick();
    this.hud.pulseTab();
    if (this.ledgerUI.isOpen) this.openLedger();
    this.persist();
  }

  /** everything the figure needs to decide with, rebuilt from live state */
  private presenceContext() {
    return {
      player: new THREE.Vector3(this.player.pos.x, 1.5, this.player.pos.y),
      frustum: this.frustum,
      lineOfSight: (a: THREE.Vector3, b: THREE.Vector3) => this.lineOfSight(a, b),
      collide: this.collide ?? ((x: number, z: number) => ({ x, z })),
      pickCell: (min: number, max: number) => this.pickCell(min, max),
      intensity: this.dread.intensity,
      playerVel: this.playerVel,
      documenting: this.documenting !== null,
      documentingIt: this.documenting?.hit.kind === 'figure',
    };
  }

  /** the first frame it is in view with nothing in the way */
  private onSighting(distance: number) {
    if (this.state !== 'play') return;
    const near = Math.max(0, Math.min(1, 1 - distance / 22));
    this.audio.stinger(0.4 + near * 0.6);
    this.dread.kick(0.35 + near * 0.7, { static: 0.3 + near * 0.4 });
    this.haptics.jolt(near > 0.5 ? 'hard' : 'small');
    if (this.settings.captions) {
      this.hud.showCaption(`something is standing there — ${Math.round(distance)}m`);
    }
    // once, ever: the thing that is not on the schedule can be put on it
    this.hint('figure', 'it is not on the schedule. it can be documented — if it holds still.', 1400);
  }

  /** it has arrived. there is still no game over; that is not the same as safe. */
  private onContact() {
    if (this.state !== 'play') return;
    this.contactsThisFloor += 1;
    const pos = this.presence
      ? new THREE.Vector3(this.presence.pos.x, 1.6, this.presence.pos.z)
      : undefined;
    // No screen-filling face here either. The arrival is the light dying, the
    // sound at zero distance, the head being turned for you, and blood in the
    // frame — the figure was just *there*, which is worse than a picture.
    this.overlay.flashStatic(240, 1);
    this.overlay.flashWash('blood', 1600, 1);
    this.audio.contact(pos);
    this.dread.kick(1.4, { flash: 1, static: 1, red: 1 });
    this.dread.killLight(2.6);
    this.haptics.jolt('contact');
    // the inspector is spun around by it, and it is not there when they land
    this.snap = { yaw: this.player.yaw + Math.PI * (Math.random() > 0.5 ? 1 : -1), t: 0.45 };
    // and it has taken the last page written on this floor
    const torn = this.tearPage();
    if (torn) {
      this.audio.pageTurn();
      window.setTimeout(() => this.audio.pageTurn(), 130);
      this.hud.pulseTab();
      this.refreshQuota(true);
      this.persist();
    }
    window.setTimeout(() => {
      if (this.state !== 'play') return;
      this.hud.showToast(
        torn
          ? 'nothing was there. a page is missing from the ledger.'
          : 'nothing was there. the record shows nothing.',
      );
    }, 2600);
    if (torn) this.hint('torn', 'what it takes has to be documented again.', 6400);
    // after the first arrival it stays away longer, so the floor can breathe
    if (this.contactsThisFloor >= 2) this.presence?.banish(45, 70);
  }

  /** the director, the thing on the floor, and what they do to the frame */
  private updateDread(dt: number) {
    const built = this.built;
    if (!built) return;
    const playing = this.state === 'play' && !this.settingsUI.isOpen;
    this.dread.suspended = !playing;

    // one frustum per frame, built after the walk cycle has moved the camera:
    // the presence's whole behaviour hangs off whether it is inside it
    this.camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    // where they are heading, not where they are: what the figure aims at
    const dx = this.player.pos.x - this.lastPlayerPos.x;
    const dz = this.player.pos.y - this.lastPlayerPos.y;
    const k = dt > 0 ? Math.min(1, dt * 6) : 0;
    this.playerVel.x += (dx / Math.max(dt, 1e-4) - this.playerVel.x) * k;
    this.playerVel.z += (dz / Math.max(dt, 1e-4) - this.playerVel.z) * k;
    this.lastPlayerPos.copy(this.player.pos);

    const p = this.presence;
    if (p) {
      const allowed = this.dread.presenceAllowed;
      if (p.enabled && !allowed) p.banish(10, 20);
      p.enabled = allowed;
      if (allowed && playing && this.collide) p.update(dt, this.time, this.presenceContext());
    }

    this.dread.update(dt, {
      depth: built.spec.floor,
      attention: Math.min(1, this.attention),
      presenceDistance: p && p.state !== 'gone' ? p.distance : Infinity,
      presenceVisible: p?.seen ?? false,
      speed: this.player.speed01,
      documenting: this.documenting !== null,
      yaw: this.player.yaw,
    });

    // the held breath, in the mix: the bed withdraws and comes back by degrees
    this.audio.setHush(this.dread.frame.hush);

    this.applyDread(dt);

    // the room lights go with the flashlight — a floor that only loses its
    // torch still reads as a floor, and this must not
    this.ambient.intensity = this.ambientBase * (0.22 + 0.78 * this.dread.frame.light);
  }

  /** camera + light + composite, all driven off the director's frame */
  private applyDread(dt: number) {
    const f = this.dread.frame;

    // the building turning the inspector's head
    if (this.snap) {
      const step = Math.min(dt, this.snap.t);
      const d = ((this.snap.yaw - this.player.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this.player.yaw += d * (step / this.snap.t);
      this.snap.t -= step;
      if (this.snap.t <= 1e-4) this.snap = null;
    }

    // shake rides on top of whatever the walk cycle already did
    this.camera.position.x += f.shakeX;
    this.camera.position.y += f.shakeY;
    this.camera.position.z += f.shakeZ;
    this.camera.rotation.z = f.roll;
    this.camera.rotation.y += f.jitterYaw;
    this.camera.rotation.x += f.jitterPitch;

    this.pipeline.setDread(f);
  }

  // ---------------------------------------------------------------- update

  private update(dt: number) {
    this.time += dt;
    this.stateT += dt;
    const built = this.built;
    if (!built) {
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
      if (this.documenting?.hit.kind === 'figure' && !this.presence?.documentable) {
        // it has to keep holding still for it. if it moves off, or comes, the
        // page is blank and the inspector's hands are free again
        this.cancelDocumenting();
        this.hud.showToast('it moved.');
      }
      if (this.documenting) {
        const docTime = this.documenting.hit.kind === 'figure' ? DOC_TIME_FIGURE : DOC_TIME;
        this.documenting.t += dt;
        this.hud.setDocProgress(this.documenting.t / docTime);
        if (this.documenting.t >= docTime) {
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
        // The car has been the one place in the building where nothing
        // happens, and the player has spent four floors learning that. Below
        // floor three it stops being true — sealed in a metal box, in the
        // dark, frozen, with the doors shut, and something breathing in it.
        if (next >= 4 && this.dread.presenceAllowed) {
          window.setTimeout(() => this.audio.intrusion(), 1400);
        }
        this.state = 'idle';
        window.setTimeout(() => {
          this.save.floor = next;
          this.persist();
          if (next > FLOORS.length) this.beginEnding();
          else this.loadFloor(next);
        }, 3400);
      }
    } else if (this.state === 'ending') {
      this.updateEnding(dt);
    }

    if (this.collide) this.player.update(dt, this.collide);
    // the director gets the camera after the walk cycle and before the light
    this.updateDread(dt);

    // documenting narrows the frame a breath — attention made physical.
    // The director's kick is added *after* the smoothing, so a shock snaps
    // and the breath still eases.
    const fovBase = this.documenting ? this.baseFov - 4 : this.baseFov;
    if (this.fovSmooth <= 0) this.fovSmooth = fovBase;
    this.fovSmooth += (fovBase - this.fovSmooth) * Math.min(1, dt * 6);
    const fovTarget = this.fovSmooth + this.dread.frame.fovKick;
    if (Math.abs(this.camera.fov - fovTarget) > 0.01) {
      this.camera.fov = fovTarget;
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
    this.flashSmooth += (dimTarget - this.flashSmooth) * Math.min(1, dt * 7);
    // the iris eases; the fault does not. a flicker that fades is a dimmer.
    this.flashlight.intensity = this.flashSmooth * this.dread.frame.light;

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
      logFigure: () => this.logFigure(),
      contact: () => this.onContact(),
      tornEntries: () => this.save.ledger.filter((e) => e.torn).length,
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
      dread: this.dread,
      watcher: this.watcher,
      presence: () => this.presence,
      /** hold a face on screen long enough for a slow capture to catch it */
      overlayFace: (ms = 6000, fill = 1.2) => this.overlay.flashFace({ ms, fill, static: 0.5 }),
      /** fire a specific scare on demand, for the contact sheet and the smoke */
      scare: (kind: ScareKind, intensity = 1) => this.scare(kind, intensity),
      /** put the presence somewhere the inspector can actually see it, and
       *  turn the inspector to face it — the state under test is "in view" */
      summon: (min = 4, max = 9) => {
        const p = this.presence;
        if (!p) return null;
        const eye = new THREE.Vector3(this.player.pos.x, 1.5, this.player.pos.y);
        let at: THREE.Vector3 | null = null;
        for (let i = 0; i < 60 && !at; i++) {
          const c = this.pickCell(min, max);
          if (c && this.lineOfSight(eye, new THREE.Vector3(c.x, 2.1, c.z))) at = c;
        }
        if (!at) return null;
        p.enabled = true;
        p.place(at, 'lurking');
        this.player.yaw = Math.atan2(-(at.x - this.player.pos.x), -(at.z - this.player.pos.y));
        this.player.pitch = 0;
        return { x: +at.x.toFixed(2), z: +at.z.toFixed(2) };
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
