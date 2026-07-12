import type { DiscrepancyDef, FloorSpec } from '../core/types';
import { floorRng, hashCombine, mulberry32, shuffled } from '../core/rng';

// The wrongness pass. Each floor's pool is shuffled with the player's stable
// seed and a subset spawns. Rare variants (<1% of players) roll on their own
// stream so communities can compare floors that "shouldn't" match.

export interface SelectedDiscrepancy {
  def: DiscrepancyDef;
  /** entry text after any rare-variant substitution */
  entry: string;
}

export function selectForFloor(spec: FloorSpec, seed: number): SelectedDiscrepancy[] {
  const rng = floorRng(seed, spec.floor);
  const anchored = spec.pool.filter((d) => d.type !== 'ledger-altered');
  const guaranteed = spec.pool.filter((d) => d.type === 'ledger-altered');
  const chosen = shuffled(anchored, rng).slice(0, spec.spawnCount).concat(guaranteed);
  return chosen.map((def) => {
    let entry = def.entry;
    if (def.rare) {
      const rareRoll = mulberry32(hashCombine(seed, spec.floor * 7919 + def.id.length * 131))();
      if (rareRoll < def.rare.chance) entry = def.rare.entry;
    }
    return { def, entry };
  });
}

/** Fill runtime tokens the moment an entry is written into the ledger. */
export function fillTokens(text: string): string {
  const now = new Date();
  const today = now.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return text.replaceAll('{TODAY}', today).replaceAll('{TIME}', time);
}
