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

export interface AlterationDef {
  /** anchor letter of the prop that will silently change */
  anchor: string;
  kind: 'door-ajar' | 'light-off' | 'light-on' | 'chair-turned';
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
  /** long-hallway support: rows of the map duplicated when active */
  stretch?: { row: number; count: number };
  /** ambience mix 0..1 */
  hum: number;
  /** occupancy sound events on this floor */
  occupancy: ('phone-ring' | 'chair-scrape' | 'knock' | 'below')[];
  ceilingHeight: number;
}

export interface LedgerEntry {
  id: string;
  floor: number;
  /** in-game timestamp string, e.g. "−03 · 00:41:22" */
  stamp: string;
  text: string;
  /** set true when the building rewrites it */
  altered?: boolean;
  originalText?: string;
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
