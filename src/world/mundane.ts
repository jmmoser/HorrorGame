import type { AlterationDef, AnchorDef, PropRole } from '../core/types';
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

export const AMENDMENTS: Record<
  AlterationDef['kind'],
  { entry: string; toast: string }
> = {
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
