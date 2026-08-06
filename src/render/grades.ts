import * as THREE from 'three';
import type { PaletteName } from '../core/types';
import type { Grade } from './pipeline';

// One grade per floor, applied after the tonemap. The palettes already control
// what colour the lights are; this controls what the *film* did with them —
// where the blacks sit, how far the highlights are allowed to go, and how much
// dust is in the air for the beams to find.
//
// Component values are linear multipliers, so they are constructed from floats
// rather than hex (hex would be colour-managed into linear on the way in).

const rgb = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

export const GRADES: Record<PaletteName, Grade> = {
  // Office fluorescents: clean, clinical, a little sick. Tight beams — the air
  // up here is the least disturbed in the building.
  'fluorescent-green': {
    exposure: 1.3,
    lift: rgb(0.010, 0.016, 0.012),
    gain: rgb(0.98, 1.0, 0.96),
    gamma: 1.12,
    saturation: 0.8,
    shadowTint: rgb(0.86, 0.98, 0.9),
    highlightTint: rgb(1.0, 1.0, 0.96),
    fogDensity: 0.055,
    anisotropy: 0.7,
    bloomStrength: 0.5,
  },
  // Sodium corridor: the warmest floor, and the dustiest-looking. Beams read
  // almost solid.
  'sodium-orange': {
    exposure: 1.34,
    lift: rgb(0.016, 0.010, 0.006),
    gain: rgb(1.0, 0.95, 0.86),
    gamma: 1.1,
    saturation: 0.84,
    shadowTint: rgb(0.95, 0.86, 0.74),
    highlightTint: rgb(1.0, 0.94, 0.82),
    fogDensity: 0.075,
    anisotropy: 0.76,
    bloomStrength: 0.62,
  },
  // Moonlight open plan: the coldest, cleanest air. Long sightlines, so the
  // beams stay thin and the blacks stay blue rather than black.
  'moonlight-blue': {
    exposure: 1.36,
    lift: rgb(0.008, 0.012, 0.022),
    gain: rgb(0.94, 0.97, 1.0),
    gamma: 1.14,
    saturation: 0.74,
    shadowTint: rgb(0.78, 0.88, 1.0),
    highlightTint: rgb(0.96, 0.98, 1.0),
    fogDensity: 0.05,
    anisotropy: 0.66,
    bloomStrength: 0.58,
  },
  // Archive stacks: thirty years of paper dust, tungsten, and no ventilation.
  // The heaviest air in the building.
  'tungsten-dust': {
    exposure: 1.3,
    lift: rgb(0.016, 0.012, 0.008),
    gain: rgb(1.0, 0.94, 0.84),
    gamma: 1.08,
    saturation: 0.8,
    shadowTint: rgb(0.94, 0.86, 0.72),
    highlightTint: rgb(1.0, 0.95, 0.85),
    fogDensity: 0.095,
    anisotropy: 0.8,
    bloomStrength: 0.6,
  },
  // The lower lobby: almost no light left to grade. Blacks are crushed, the
  // little that survives is neutral, and the flashlight is the whole picture.
  'terminal-white': {
    exposure: 1.4,
    lift: rgb(0.006, 0.006, 0.008),
    gain: rgb(0.96, 0.97, 1.0),
    gamma: 1.16,
    saturation: 0.6,
    shadowTint: rgb(0.88, 0.9, 0.95),
    highlightTint: rgb(1.0, 1.0, 1.0),
    fogDensity: 0.085,
    anisotropy: 0.74,
    bloomStrength: 0.52,
  },
};
