import * as THREE from 'three';
import type { VolumetricLight } from './pipeline';
import type { QualityProfile } from './quality';

/**
 * Who casts a shadow, and whose light the dust catches.
 *
 * Shadow casters are chosen once, when the floor is built, and never change
 * while the player is on it. That is deliberate: toggling `castShadow` on a
 * live light changes three's shadow counts, which recompiles every material on
 * the floor. A hitch in a game with no jump scares reads as a jump scare.
 */

/** farthest-point sampling — spreads the budget over the floor instead of
 *  clustering it wherever the fixtures happen to be dense */
export function pickSpread(lights: THREE.SpotLight[], count: number): THREE.SpotLight[] {
  if (count <= 0 || lights.length === 0) return [];
  if (lights.length <= count) return [...lights];
  const pos = lights.map((l) => l.getWorldPosition(new THREE.Vector3()));
  const chosen = [0];
  while (chosen.length < count) {
    let best = -1;
    let bestD = -1;
    for (let i = 0; i < lights.length; i++) {
      if (chosen.includes(i)) continue;
      let d = Infinity;
      for (const c of chosen) d = Math.min(d, pos[i].distanceToSquared(pos[c]));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) break;
    chosen.push(best);
  }
  return chosen.map((i) => lights[i]);
}

/** call once per floor, after the group is in the scene */
export function assignShadowCasters(fixtures: THREE.SpotLight[], profile: QualityProfile): void {
  for (const l of fixtures) l.castShadow = false;
  if (!profile.shadows) return;
  const lit = fixtures.filter((l) => l.intensity > 0);
  for (const l of pickSpread(lit, profile.shadowCasters)) {
    l.castShadow = true;
    l.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
  }
}

const _wp = new THREE.Vector3();
const _wd = new THREE.Vector3();

function spotToVolumetric(light: THREE.SpotLight, gain: number): VolumetricLight {
  light.getWorldPosition(_wp);
  light.target.getWorldPosition(_wd);
  const dir = _wd.clone().sub(_wp).normalize();
  const cosOuter = Math.cos(light.angle);
  // penumbra pulls the inner cone in; matches three's spot falloff closely
  const cosInner = Math.cos(light.angle * (1 - light.penumbra));
  return {
    position: _wp.clone(),
    direction: dir,
    color: light.color.clone().multiplyScalar(light.intensity * gain),
    range: light.distance || 12,
    cosOuter,
    cosInner: Math.max(cosInner, cosOuter + 1e-3),
    spot: true,
  };
}

/**
 * The flashlight is always index 0 — the march only shadow-samples that one,
 * and it is the beam the player is actually aiming. Fixtures fill the rest of
 * the budget nearest-first.
 */
export function gatherVolumetricLights(
  flashlight: THREE.SpotLight,
  fixtures: THREE.SpotLight[],
  cameraPos: THREE.Vector3,
  profile: QualityProfile,
): VolumetricLight[] {
  const out: VolumetricLight[] = [];
  if (flashlight.intensity > 0) {
    // The flashlight is very bright so that surfaces read; scattering it at
    // full strength would fill the frame with milk. Scale it down hard.
    out.push(spotToVolumetric(flashlight, 0.06));
  }
  const budget = Math.max(0, profile.volLights - out.length);
  if (budget > 0) {
    const near = fixtures
      .filter((l) => l.intensity > 0)
      .map((l) => ({ l, d: l.getWorldPosition(_wp).distanceToSquared(cameraPos) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, budget);
    for (const { l } of near) out.push(spotToVolumetric(l, 0.1));
  }
  return out;
}
