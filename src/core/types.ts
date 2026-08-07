export type PaletteName =
  | 'fluorescent-green'
  | 'sodium-orange'
  | 'moonlight-blue'
  | 'tungsten-dust'
  | 'terminal-white';

export interface Palette {
  name: PaletteName;
  /** scene fog + clear color */
  fog: number;
  fogDensity: number;
  ambient: number;
  ambientIntensity: number;
  /** point light color for fixtures on this floor */
  lamp: number;
  lampIntensity: number;
  wall: number;
  floor: number;
  ceiling: number;
  trim: number;
  /** emissive color of lit fixtures */
  fixture: number;
  /** what the windows show by default on this floor */
  windowMood: 'overcast-night' | 'sodium-haze' | 'moonlit' | 'void';
  flashlight: number;
}

export type Facing = 'n' | 's' | 'e' | 'w';

export type PropRole =
  // furniture — never wrong, just the world
  | 'desk'
  | 'chair'
  | 'cabinet'
  | 'shelf'
  | 'bench'
  | 'cart'
  // wall paper — readable, transcribable, never wrong
  | 'notice'
  // writing that is only there when the flashlight is not
  | 'mark'
  // wrongable anchors
  | 'door'
  | 'window'
  | 'roomplate'
  | 'light'
  | 'clock'
  | 'calendar'
  | 'coffee'
  | 'phone'
  | 'plant'
  | 'paper'
  | 'ashtray'
  | 'sink'
  | 'footprints'
  | 'stretchmark'
  | 'twinroom';

export interface AnchorDef {
  role: PropRole;
  facing: Facing;
  /** for role 'light': whether this fixture carries a real PointLight */
  lit?: boolean;
  /** for role 'light': flicker behavior */
  flicker?: boolean;
  /** for role 'roomplate' / 'door': label text */
  label?: string;
  /** for role 'roomplate': label shown when this anchor is the discrepancy */
  wrongLabel?: string;
  /** spawn nothing unless a discrepancy selects this anchor (extra door etc.) */
  absentWhenNormal?: boolean;
  /** for role 'notice': the printed lines and the transcription entry */
  notice?: { lines: string[]; entry: string };
  /** for role 'mark': what is written there, and what the inspector makes of
   *  it. Only legible with the flashlight off and the eye given time. */
  mark?: { lines: string[]; entry: string };
  /** for role 'door': the handle turns. Most of them do not. */
  openable?: boolean;
}

/** the verbs the inspector's hand has. Documenting is the job; this is the
 *  part of the job nobody files a form for. */
export type HandVerb =
  | 'open-door'
  | 'try-handle'
  | 'knock'
  | 'close-door'
  | 'turn-chair'
  | 'replace-handset'
  | 'lift-handset';

export type HandResult =
  | 'opened'
  | 'locked'
  | 'knocked'
  | 'closed'
  | 'turned'
  | 'replaced'
  | 'lifted'
  | 'none';

export interface PropAction {
  id: HandVerb;
  label: string;
}

export type DiscrepancyType =
  | 'extra-door'
  | 'long-hallway'
  | 'wrong-window'
  | 'repeated-room'
  | 'duplicate-roomplate'
  | 'light-burning'
  | 'steaming-coffee'
  | 'current-calendar'
  | 'backward-clock'
  | 'fresh-footprints'
  | 'living-plant'
  | 'phone-off-hook'
  | 'fresh-paper'
  | 'smoldering-ashtray'
  | 'dripping-sink'
  | 'ledger-altered';

export type AlterationKind =
  | 'door-ajar'
  | 'light-off'
  | 'light-on'
  | 'chair-turned'
  | 'handset-lifted';

export interface AlterationDef {
  /** anchor letter of the prop that will silently change */
  anchor: string;
  kind: AlterationKind;
}

export interface DiscrepancyDef {
  id: string;
  type: DiscrepancyType;
  tier: 1 | 2 | 3;
  anchor: string;
  /** ledger entry, written in the inspector's voice */
  entry: string;
  /** short line shown when logged */
  toast: string;
  /** rare community-bait variant (<1% of players) */
  rare?: { chance: number; entry: string };
  /** a change applied to the floor after logging — never on screen */
  alteration?: AlterationDef;
}

/** the sounds of a building that has been empty for thirty years and is not.
 *  Every one of them is sourced somewhere the inspector cannot see, and every
 *  one of them stops if the inspector goes and looks. */
export type OccupancyKind =
  | 'phone-ring'
  | 'chair-scrape'
  | 'knock'
  | 'below'
  | 'footsteps'
  | 'whisper';

export interface FloorSpec {
  floor: number;
  name: string;
  palette: PaletteName;
  quota: number;
  /** how many from the pool actually spawn (>= quota) */
  spawnCount: number;
  map: string;
  anchors: Record<string, AnchorDef>;
  pool: DiscrepancyDef[];
  /** the filed schedule for this floor — the baseline the player can check
   *  the building against. shown on arrival and in the ledger. */
  schedule: string[];
  /** long-hallway support: rows of the map duplicated when active */
  stretch?: { row: number; count: number };
  /** ambience mix 0..1 */
  hum: number;
  /** occupancy sound events on this floor */
  occupancy: OccupancyKind[];
  ceilingHeight: number;
}

export type EntryKind = 'discrepancy' | 'mundane' | 'amend' | 'notice' | 'filed';

export interface LedgerEntry {
  id: string;
  floor: number;
  /** in-game timestamp string, e.g. "−03 · 00:41:22" */
  stamp: string;
  text: string;
  /** what sort of record this is; absent in old saves = 'discrepancy' */
  kind?: EntryKind;
  /** map anchor letter this entry was logged at, for blueprint marks */
  anchor?: string;
  /** set true when the building rewrites it */
  altered?: boolean;
  originalText?: string;
  /** id the amendment gets when the inspector notices the rewrite */
  revisionId?: string;
}

export interface SaveData {
  v: 1;
  seed: number;
  floor: number;
  ledger: LedgerEntry[];
  /** discrepancy ids logged, across all floors */
  logged: string[];
  /** seconds spent inside the building */
  elapsed: number;
  /** floor-5 climax bookkeeping */
  ledgerAltered: boolean;
  startedAt: number;
}
