import type { AlterationKind, AnchorDef, PropRole } from '../core/types';
import type { Rng } from '../core/rng';

// Everything is loggable. Logging a thing that is *correct* writes one of
// these — the inspector doing the job properly, and the record getting
// noisier for it. The building reads every entry either way.

const MUNDANE: Partial<Record<PropRole, string[]>> = {
  desk: [
    'Desk. Standard municipal issue. Dust lies even and undisturbed. No deviation.',
    'A desk. Drawers shut, blotter square. Exactly where the plan says it is. Noted.',
  ],
  chair: [
    'A chair, where a chair should be. Logged for completeness. I am aware of how that sounds.',
    'Chair. Angle consistent with someone leaving unhurried, thirty years ago. No deviation.',
  ],
  cabinet: [
    'Filing cabinet, four drawers, all shut. I did not open them. The schedule does not require me to open them.',
  ],
  shelf: [
    'Shelving as filed. Boxes sagging at the rate boxes should sag. Gaps where things were taken the ordinary way. No deviation.',
  ],
  bench: [
    'A waiting bench. Nothing has waited on it for thirty years. Nothing waited on it while I watched. Noted.',
  ],
  cart: ['A mail cart, parked square against the wall. Wheels seized. Correct.'],
  door: [
    'A door, present on the blueprint, shut. I tried the handle with one knuckle. Locked. Correct.',
  ],
  window: [
    'Window shows night, as it should. The glass is cold, as it should be. No deviation.',
  ],
  roomplate: [
    'Room plate matches the schedule. Number correct. Font correct. I checked the font. Noted.',
  ],
  clock: [
    'Wall clock stopped at 4:17, same as the 1996 survey photograph. Consistency is a virtue. Noted.',
  ],
  calendar: [
    'Wall calendar, March 1996, corners curled. Correct month. Correct decade. No deviation.',
  ],
  coffee: ['An empty mug and a dust ring beside it. Thirty years of nothing. As it should be.'],
  phone: [
    'Handset in its cradle. The line is dead. I lifted it one inch to confirm and set it back the way you replace something you regret touching.',
  ],
  plant: [
    'A dead plant. Brown, dropped leaves, dry soil. Dead the way thirty years makes things dead. Correct.',
  ],
  paper: ['A typewriter with a yellowed page. The ink faded before I was hired. No deviation.'],
  ashtray: [
    'An ashtray, cold. One filter gone grey. Smoked by someone with a lease and a life. Noted.',
  ],
  sink: [
    'Washroom sink, dry. Drain stained the old way, not the new way. Risers empty. Correct.',
  ],
};

const LIT_FIXTURE =
  'Fixture burning steady. Emergency circuit — the explanation I have chosen to accept. No deviation.';
const DEAD_FIXTURE =
  'A dead fixture. Thirty years dark. This is the correct condition for a fixture in this building.';

/** entry text for logging a prop that is exactly what it should be */
export function mundaneEntry(anchor: AnchorDef, rng: Rng): string | null {
  if (anchor.role === 'light') return anchor.lit ? LIT_FIXTURE : DEAD_FIXTURE;
  const pool = MUNDANE[anchor.role];
  if (!pool) return null;
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

export const MUNDANE_TOASTS = [
  'noted: no deviation',
  'noted: as filed',
  'noted: correct',
];

/** the toast turns on the inspector after enough of these on one floor */
export const MUNDANE_TOAST_WEARY = 'noted: nothing is wrong here. logged anyway.';

// ------------------------------------------------------------- amendments
// A prop the building silently changed can be logged AGAIN. The amendment is
// the payoff for noticing — and the building notices being noticed.

export const AMENDMENTS: Record<AlterationKind, { entry: string; toast: string }> = {
  'handset-lifted': {
    entry:
      'Amendment. The handset I replaced in its cradle — I have the entry, I have the time — is lying beside the base again, cups up, exactly as I first found it. Laid down, not dropped. Somebody is being tidy about this.',
    toast: 'amended: I put that back',
  },
  'door-ajar': {
    entry:
      'Amendment. A door on this floor is standing open. It was shut when I arrived — my own earlier entry says so. I have been alone here the entire time.',
    toast: 'amended: that door was closed',
  },
  'light-off': {
    entry:
      'Amendment. A fixture that was burning when I arrived has gone dark. I did not hear it die. Tubes ring when they die.',
    toast: 'amended: that light was on',
  },
  'light-on': {
    entry:
      'Amendment. A fixture that was dead when I arrived is now burning. There is still no power. I have stopped expecting that to matter.',
    toast: 'amended: that light was off',
  },
  'chair-turned': {
    entry:
      'Amendment. A chair on this floor has turned to face the elevator. I did not see it happen. Nothing here happens while I am looking.',
    toast: 'amended: the chair has turned',
  },
};

// ------------------------------------------------------------- the record
// The ledger is the only thing the inspector brought in and the only thing
// they will carry out, which makes it the obvious thing to get at. Past a
// certain amount of attention the building stops answering documentation with
// furniture and starts answering it with edits.
//
// A revision keeps the first sentence. That is what makes it work: the entry
// is recognisably yours right up until it isn't, and you have to read to the
// end to find where you stopped writing it.

const REVISIONS: string[] = [
  '{FIRST}. This entry has been reviewed and found accurate. The inspector is thorough. The inspector should continue.',
  '{FIRST}. Correction: not a discrepancy. A feature of the structure, present since before the structure. Filed in error. Apologies for the trouble.',
  '{FIRST}. I went back to check. It is still there. It is nearer the door than it was, and the door is the one I came in by.',
  '{FIRST}. The inspector was alone at the time of writing. This has been confirmed. This will continue to be confirmed for as long as it is true.',
  '{FIRST}. I have read this entry four times now and each time there is one more sentence in it that I did not write, and each time I cannot tell you which one.',
];

/** entries that were never the inspector's, written in the inspector's hand */
const INTERPOLATIONS: string[] = [
  'I did not write this entry. It is in my handwriting. It says, in full: THE INSPECTION IS GOING WELL.',
  'This entry is numbered and dated and is not mine. It records the position of the inspector at the time of writing, to the nearest metre, from behind.',
  'An entry between two of my own, in my hand, in my pencil: "he has stopped hurrying. good."',
  'An entry I did not make: a list of the doors I have not opened yet. It is shorter than it was on the floor above.',
];

/** the building's edit of one of the inspector's own entries */
export function reviseEntry(text: string, rng: Rng): string {
  const first = text.split('.')[0];
  return REVISIONS[Math.floor(rng() * REVISIONS.length) % REVISIONS.length].replace('{FIRST}', first);
}

/** a whole entry the inspector did not write */
export function interpolatedEntry(rng: Rng): string {
  return INTERPOLATIONS[Math.floor(rng() * INTERPOLATIONS.length) % INTERPOLATIONS.length];
}

/** what the inspector writes when they catch the ledger having been edited */
export const REVISION_AMENDMENT = {
  entry:
    'Amendment. An earlier entry in this ledger has been altered. I have compared it against my own memory of writing it, which is the only copy there is, which is the problem. The hand is mine. The sentence is not. Logging the ledger as a discrepancy against itself.',
  toast: 'amended: that is not what I wrote',
};
