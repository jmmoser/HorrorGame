// Quality tiers and the persisted settings the player can change.
//
// The building runs on everything from a four-year-old phone to a desktop GPU,
// and the horror depends on a steady frame — a hitch reads as a jump scare.
// So: a conservative auto-detected tier, an explicit override, and a resolution
// governor that gives back pixels before it gives back frames.

import type { DreadLevel } from '../core/dread';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityProfile {
  tier: QualityTier;
  /** multiplier on device pixel ratio for the 3D buffer */
  renderScale: number;
  /** hard cap on device pixel ratio regardless of scale */
  maxPixelRatio: number;
  /** MSAA samples on the scene buffer (0 = off) */
  msaa: number;
  shadows: boolean;
  shadowMapSize: number;
  /** how many fixture lights may cast shadows at once */
  shadowCasters: number;
  ao: boolean;
  aoSamples: number;
  /** AO buffer size relative to the scene buffer */
  aoScale: number;
  volumetrics: boolean;
  volSteps: number;
  volScale: number;
  /** how many fixture lights contribute in-scattering */
  volLights: number;
  bloom: boolean;
  bloomMips: number;
  dof: boolean;
}

const PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    tier: 'low',
    renderScale: 0.75,
    maxPixelRatio: 1.5,
    msaa: 0,
    shadows: false,
    shadowMapSize: 512,
    shadowCasters: 0,
    ao: true,
    aoSamples: 6,
    aoScale: 0.5,
    volumetrics: false,
    volSteps: 0,
    volScale: 0.5,
    volLights: 0,
    bloom: true,
    bloomMips: 4,
    dof: false,
  },
  medium: {
    tier: 'medium',
    renderScale: 0.9,
    maxPixelRatio: 1.75,
    msaa: 0,
    shadows: true,
    shadowMapSize: 512,
    shadowCasters: 1,
    ao: true,
    aoSamples: 8,
    aoScale: 0.5,
    volumetrics: true,
    volSteps: 12,
    volScale: 0.5,
    volLights: 2,
    bloom: true,
    bloomMips: 5,
    dof: true,
  },
  high: {
    tier: 'high',
    renderScale: 1,
    maxPixelRatio: 2,
    msaa: 4,
    shadows: true,
    shadowMapSize: 1024,
    shadowCasters: 3,
    ao: true,
    aoSamples: 12,
    aoScale: 1,
    volumetrics: true,
    volSteps: 20,
    volScale: 0.5,
    volLights: 4,
    bloom: true,
    bloomMips: 5,
    dof: true,
  },
  ultra: {
    tier: 'ultra',
    renderScale: 1,
    maxPixelRatio: 2,
    msaa: 4,
    shadows: true,
    shadowMapSize: 2048,
    shadowCasters: 5,
    ao: true,
    aoSamples: 20,
    aoScale: 1,
    volumetrics: true,
    volSteps: 32,
    volScale: 0.5,
    volLights: 6,
    bloom: true,
    bloomMips: 6,
    dof: true,
  },
};

export function profileFor(tier: QualityTier): QualityProfile {
  return { ...PROFILES[tier] };
}

/** What the hardware looks like it can take, before the player overrides it. */
export function detectTier(): QualityTier {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? (coarse ? 4 : 8);
  const cores = navigator.hardwareConcurrency ?? (coarse ? 4 : 8);

  // The renderer string is the only real signal about the GPU. Software
  // rasterizers (headless CI, remote desktops) must land on 'low' or the
  // volumetric pass alone will take a second a frame.
  let renderer = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).toLowerCase();
  } catch {
    /* blocked by privacy settings — fall through to the heuristics */
  }
  if (/swiftshader|llvmpipe|software|basic render|mesa offscreen/.test(renderer)) return 'low';

  if (coarse) {
    // Phones: Apple's tile GPUs carry the volumetric pass; be careful elsewhere.
    if (/apple (a1[4-9]|m\d)/.test(renderer)) return 'high';
    if (mem >= 6 && cores >= 6) return 'medium';
    return 'low';
  }
  if (mem >= 8 && cores >= 8) return 'high';
  if (mem >= 4) return 'medium';
  return 'low';
}

// ------------------------------------------------------------- user settings

export interface Settings {
  /** 'auto' re-detects on every launch; anything else is the player's choice */
  quality: QualityTier | 'auto';
  /** let the renderer trade resolution for a steady frame */
  adaptiveResolution: boolean;
  masterVolume: number;
  lookSensitivity: number;
  invertY: boolean;
  /** extra field of view, degrees, added to the base */
  fovOffset: number;
  /** film grain / chromatic aberration / vignette — off for comfort */
  filmEffects: boolean;
  headBob: boolean;
  haptics: boolean;
  /** print sound events as text — the audio is half the game */
  captions: boolean;
  showFps: boolean;
  /**
   * How hard the building comes at you. 'nightmare' is the default and the
   * intended experience: a presence on every floor, a scare every couple of
   * seconds, and a frame that never settles. 'off' restores the original
   * inspection — no entity, no stingers, no flashes — for players who want
   * the slow version, and for anyone who cannot safely take the strobing.
   */
  dread: DreadLevel;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto',
  adaptiveResolution: true,
  masterVolume: 1,
  lookSensitivity: 1,
  invertY: false,
  fovOffset: 0,
  filmEffects: true,
  headBob: true,
  haptics: true,
  captions: false,
  showFps: false,
  dread: 'nightmare',
};

const KEY = 'descent-ledger-settings-v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage denied — the settings last as long as the session */
  }
}

export function resolveProfile(s: Settings): QualityProfile {
  return profileFor(s.quality === 'auto' ? detectTier() : s.quality);
}
