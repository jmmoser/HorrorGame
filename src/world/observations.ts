import type { ScareKind } from '../core/dread';

// The building keeps a ledger too, and it only has one subject.
//
// Everything else in this game frightens the inspector by doing something to
// the room. This does not touch the room. It writes a line in the inspector's
// own ledger, in the inspector's own format, numbered in the inspector's own
// sequence — and the line is about the inspector. What they are doing right
// now. How many times they have checked behind themselves on this floor. How
// long they have been standing in a corridor not writing anything. What the
// actual clock on their actual wall says.
//
// It is the cheapest system in the build and it is the one that follows people
// out of the room, because it is the only one that cannot be dismissed as
// something that happened to the character. The character does not have a
// clock. The player does.
//
// The register is deliberately municipal — flat, clerical, third person, no
// adjectives and no pronouns. A survey office does not editorialise about the
// person it is recording, and the absence of any voice at all is what makes it
// read as a file rather than a threat.

export interface ObservationContext {
  floor: number;
  /** seconds the inspector has been standing still */
  stillFor: number;
  /** seconds since anything was written down */
  sinceLog: number;
  /** completed checks over the shoulder on this floor */
  lookBacks: number;
  /** seconds on this floor */
  floorT: number;
  /** seconds inside the building, total */
  elapsed: number;
  /** entries in the ledger so far */
  entries: number;
  /** 0..1, what the watcher makes of them */
  fear: number;
  /** the kind this player has flinched hardest at, once it is known */
  worst: ScareKind | null;
  /** props the building has changed since they were recorded, not yet noticed */
  unamended: number;
  /** true when this is being written while the ledger is open in front of them */
  reading: boolean;
  /** the last thing written about them, so the file does not stutter */
  last: string | null;
  rng: () => number;
}

/** what the building has decided it knows, phrased as a finding */
const WORST_LINE: Record<ScareKind, string> = {
  face: 'the inspector responds to faces. noted for the remaining floors.',
  'face-hold': 'the inspector will not look away. this has been recorded as consent.',
  static: 'the inspector distrusts the picture more than the room. correct.',
  whisper: 'the inspector reacts to speech at the left ear. the left ear is preferred.',
  scream: 'the inspector orients toward screaming rather than away. unusual. useful.',
  bang: 'the inspector startles at impacts through walls. there are many walls.',
  breath: 'the inspector holds their own breath to listen for the other one.',
  blackout: 'the inspector is afraid of the dark. the building has a great deal of it.',
  word: 'the inspector reads everything put in front of them. including this.',
  shadow: 'the inspector watches the edge of the beam. the beam has edges everywhere.',
  headsnap: 'the inspector resists being turned. the resistance is noted and is not required.',
  lurch: 'the inspector does not trust the floor. the floor is the oldest part of the building.',
  follow: 'the inspector counts footsteps. the count has never been correct.',
  stare: 'the inspector checks behind themselves. it is always the wrong direction.',
  observed: 'the inspector reads their own ledger for reassurance. this entry is in it.',
  closer: 'the inspector has not noticed the rooms. good.',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** the clock on the wall the player is actually sitting in front of */
function wallClock(offsetSeconds = 0): string {
  const d = new Date(Date.now() + offsetSeconds * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface Line {
  /** may this be written right now */
  when: (c: ObservationContext) => boolean;
  weight: number;
  text: (c: ObservationContext) => string;
  /**
   * Seconds ahead of the inspector's own clock this entry is stamped. The
   * ledger's own timestamps count up from arrival, so an entry from further
   * along than the inspector has got is not a mistake anyone can explain.
   */
  ahead?: number;
}

const LINES: Line[] = [
  {
    when: (c) => c.stillFor > 4,
    weight: 3,
    text: (c) =>
      `${wallClock()} — the inspector has stopped in floor −${pad(c.floor)}. ` +
      `standing. listening. ${Math.floor(c.stillFor)} seconds so far.`,
  },
  {
    when: (c) => c.lookBacks >= 3,
    weight: 3,
    text: (c) =>
      `the inspector has checked behind themselves ${c.lookBacks} times on this floor. ` +
      `on ${c.lookBacks - 1} of those occasions there was no reason to.`,
  },
  {
    when: (c) => c.sinceLog > 55,
    weight: 2,
    text: (c) =>
      `no entry from the inspector for ${Math.floor(c.sinceLog / 5) * 5} seconds. ` +
      `the inspector is not surveying. the inspector is looking for something.`,
  },
  {
    when: (c) => c.reading,
    weight: 4,
    text: () => 'the inspector is reading this entry. the inspector has read it twice.',
  },
  {
    when: (c) => c.elapsed >= 120,
    weight: 2,
    text: (c) =>
      `${wallClock()}. floor −${pad(c.floor)}. the inspector has been in the building ` +
      `for ${Math.floor(c.elapsed / 60)} minutes and has not asked who filed the schedule.`,
  },
  {
    when: (c) => c.entries >= 6,
    weight: 2,
    text: (c) =>
      `${c.entries} entries in the inspector's hand. ` +
      `the handwriting has changed since floor −01. the inspector has not noticed.`,
  },
  {
    when: (c) => c.worst !== null,
    weight: 3,
    text: (c) => WORST_LINE[c.worst!],
  },
  {
    // the one line in the file that is also a lead: something the inspector
    // recorded is no longer as recorded, and the inspector has not been back
    when: (c) => c.unamended > 0,
    weight: 4,
    text: (c) =>
      c.unamended === 1
        ? 'one item on this floor is no longer as the inspector recorded it. the inspector has not gone back to look.'
        : `${c.unamended} items on this floor are no longer as the inspector recorded them. the inspector has not gone back to look.`,
  },
  {
    when: (c) => c.fear > 0.5,
    weight: 2,
    text: () =>
      'the inspector\'s pulse is legible from the corridor. ' +
      'recorded at the door of every room entered since.',
  },
  {
    // stamped from later than the inspector has reached
    when: (c) => c.floorT > 40,
    weight: 2,
    ahead: 180,
    text: (c) =>
      `floor −${pad(c.floor + 1)}. the inspector is no longer writing. ` +
      `the ledger is being completed on their behalf.`,
  },
  {
    when: (c) => c.floor >= 3,
    weight: 2,
    ahead: 420,
    text: () =>
      `${wallClock(420)} — inspection concluded. the inspector was cooperative throughout.`,
  },
  {
    when: () => true,
    weight: 1,
    text: () =>
      'the inspector believes the building is empty. this belief is recorded here ' +
      'so that it can be shown to them later.',
  },
];

/** the line, and how far ahead of the inspector's clock to stamp it */
export interface Observation {
  text: string;
  /** seconds to add to the inspector's elapsed time when stamping this */
  ahead: number;
}

/**
 * Pick something true about the person currently playing. Two lines are
 * unconditional, so the eligible set is never empty.
 */
export function observation(ctx: ObservationContext): Observation {
  const eligible = LINES.filter((l) => l.when(ctx));
  // A file that says the same sentence twice running is a file with a fault in
  // it, and a fault is something the player can be annoyed by instead of
  // frightened by. Only drop the repeat if there is something else to say.
  const fresh = eligible.filter((l) => l.text(ctx) !== ctx.last);
  const pool = fresh.length ? fresh : eligible;
  const total = pool.reduce((a, l) => a + l.weight, 0);
  let roll = ctx.rng() * total;
  let chosen = pool[pool.length - 1];
  for (const l of pool) {
    roll -= l.weight;
    if (roll <= 0) {
      chosen = l;
      break;
    }
  }
  return { text: chosen.text(ctx), ahead: chosen.ahead ?? 0 };
}
