import type { FloorSpec } from '../core/types';

// The five floors of the vertical slice, hand-authored. One palette each.
// '#' wall · '.' floor · 'E' elevator car · letters are prop anchors.
// Ledger entry text supports tokens: {TODAY} {TIME} — filled when logged.

export const FLOORS: FloorSpec[] = [
  // ---------------------------------------------------------------- floor 1
  {
    floor: 1,
    name: 'COMMERCIAL — LETTINGS OFFICE',
    palette: 'fluorescent-green',
    quota: 3,
    spawnCount: 4,
    ceilingHeight: 2.7,
    hum: 0.5,
    occupancy: [],
    map: `
#######################
#..q..#...w..#..x...H.#
#.aLk.#C.BM..#...FN...#
#..A..#......#...G...p#
###.#####.#######.#####
#.r..Ou.s..P..d.t...v.#
####.#####EE######.####
#.......######V.......#
#I......######......T.#
#....K..######........#
#J......######........#
#.......######.......W#
#######################
`,
    anchors: {
      q: { role: 'window', facing: 's' },
      w: { role: 'window', facing: 's' },
      x: { role: 'window', facing: 's' },
      a: { role: 'desk', facing: 's' },
      k: { role: 'coffee', facing: 's' },
      A: { role: 'chair', facing: 'n' },
      L: { role: 'light', facing: 's', lit: false },
      C: { role: 'shelf', facing: 'e' },
      B: { role: 'desk', facing: 's' },
      M: { role: 'light', facing: 's', lit: true },
      F: { role: 'desk', facing: 's' },
      N: { role: 'light', facing: 's', lit: true, flicker: true },
      G: { role: 'chair', facing: 'n' },
      H: { role: 'cabinet', facing: 's' },
      p: { role: 'plant', facing: 'w' },
      r: { role: 'roomplate', facing: 's', label: '101' },
      s: { role: 'roomplate', facing: 's', label: '104' },
      t: { role: 'roomplate', facing: 's', label: '105', wrongLabel: '104' },
      O: { role: 'light', facing: 's', lit: true },
      P: { role: 'light', facing: 's', lit: true },
      u: { role: 'door', facing: 'n' },
      v: { role: 'door', facing: 'n' },
      d: { role: 'door', facing: 'n', absentWhenNormal: true },
      I: { role: 'shelf', facing: 'e' },
      J: { role: 'shelf', facing: 'e' },
      K: { role: 'cart', facing: 's' },
      V: { role: 'cabinet', facing: 's' },
      T: { role: 'bench', facing: 'w' },
      W: { role: 'plant', facing: 'n' },
    },
    pool: [
      {
        id: 'f1-door',
        type: 'extra-door',
        tier: 1,
        anchor: 'd',
        entry:
          'A door in the south corridor wall. The blueprint shows unbroken wall — I have measured twice. The door is real. The blueprint is signed.',
        toast: 'logged: a door that is not on the blueprint',
        alteration: { anchor: 'u', kind: 'door-ajar' },
      },
      {
        id: 'f1-window',
        type: 'wrong-window',
        tier: 1,
        anchor: 'w',
        entry:
          'The window in 104 shows full daylight. Inspection began after dark. The windows in 101 and 105 agree that it is night.',
        toast: 'logged: the light outside is wrong',
      },
      {
        id: 'f1-plate',
        type: 'duplicate-roomplate',
        tier: 1,
        anchor: 't',
        entry:
          'Two rooms on this floor are numbered 104. The schedule lists 101 through 105. There is no 105. I have walked the floor twice looking for it.',
        toast: 'logged: 104, again',
      },
      {
        id: 'f1-coffee',
        type: 'steaming-coffee',
        tier: 2,
        anchor: 'k',
        entry:
          'A cup of coffee on the desk in 101, still steaming. This structure has been sealed for thirty years. Logged from arm’s length.',
        toast: 'logged: still warm',
        rare: {
          chance: 0.007,
          entry:
            'A cup of coffee on the desk in 101, still steaming. It is my mug. The one from my kitchen. The chip on the handle is the same chip. Logged.',
        },
      },
    ],
  },

  // ---------------------------------------------------------------- floor 2
  {
    floor: 2,
    name: 'RESIDENTIAL — LONG CORRIDOR',
    palette: 'sodium-orange',
    quota: 3,
    spawnCount: 4,
    ceilingHeight: 2.5,
    hum: 0.35,
    occupancy: ['phone-ring'],
    stretch: { row: 11, count: 3 },
    map: `
###############
######EE#######
#####W.Y..#####
#p...q#.#######
#..o..#A#######
#r.....H#######
#....s#B#######
#######.#######
#m....#C#######
#t.....I#######
#..u..#D#######
#######.#######
#v....#F#######
#n.....J#######
#....w#G#######
#######.#######
#######z#######
###############
`,
    anchors: {
      W: { role: 'cart', facing: 'e' },
      Y: { role: 'light', facing: 's', lit: true },
      p: { role: 'bench', facing: 'e' },
      q: { role: 'plant', facing: 'w' },
      o: { role: 'light', facing: 's', lit: false },
      r: { role: 'chair', facing: 'e' },
      s: { role: 'cabinet', facing: 'n' },
      A: { role: 'door', facing: 'w', label: '2E' },
      H: { role: 'light', facing: 's', lit: true },
      m: { role: 'calendar', facing: 's' },
      t: { role: 'desk', facing: 'e' },
      u: { role: 'chair', facing: 'n' },
      B: { role: 'door', facing: 'w', label: '2F' },
      C: { role: 'door', facing: 'w', label: '2G' },
      I: { role: 'light', facing: 's', lit: true, flicker: true },
      v: { role: 'shelf', facing: 'e' },
      n: { role: 'phone', facing: 'e' },
      w: { role: 'bench', facing: 'n' },
      D: { role: 'door', facing: 'w', label: '2H' },
      F: { role: 'door', facing: 'w', label: '2J' },
      G: { role: 'door', facing: 'w', label: '2K' },
      J: { role: 'light', facing: 's', lit: false },
      z: { role: 'stretchmark', facing: 'n', absentWhenNormal: true },
    },
    pool: [
      {
        id: 'f2-hall',
        type: 'long-hallway',
        tier: 1,
        anchor: 'z',
        entry:
          'This corridor measures forty-one meters. The corridor directly above it measures thirty-five. Same shaft. Same footprint. I paced it twice, both directions. Both times it was longer coming back.',
        toast: 'logged: the corridor is too long',
      },
      {
        id: 'f2-light',
        type: 'light-burning',
        tier: 1,
        anchor: 'o',
        entry:
          'The ceiling fixture in unit 2B is burning. Every other fixture on this floor is dead. The building has had no power since 1996. I checked the meter riser myself on the way in. It is cut at the street.',
        toast: 'logged: a light with no power',
        alteration: { anchor: 'H', kind: 'light-on' },
      },
      {
        id: 'f2-calendar',
        type: 'current-calendar',
        tier: 2,
        anchor: 'm',
        entry:
          'A wall calendar in unit 2C. It shows {TODAY}. Today. The ring is around today’s date. The paper is new.',
        toast: 'logged: today’s date',
      },
      {
        id: 'f2-phone',
        type: 'phone-off-hook',
        tier: 2,
        anchor: 'n',
        entry:
          'The handset in unit 2D is off the hook, laid beside the cradle, facing up. There is a dial tone. The line was disconnected before I was hired. I did not pick it up.',
        toast: 'logged: a dial tone',
        rare: {
          chance: 0.007,
          entry:
            'The handset in unit 2D is off the hook, laid beside the cradle, facing up. There is a dial tone. It stopped when I entered the room, the way a person stops talking.',
        },
      },
    ],
  },

  // ---------------------------------------------------------------- floor 3
  {
    floor: 3,
    name: 'COMMERCIAL — OPEN PLAN',
    palette: 'moonlight-blue',
    quota: 4,
    spawnCount: 5,
    ceilingHeight: 2.7,
    hum: 0.3,
    occupancy: ['chair-scrape', 'below'],
    map: `
#######################
#...a.....b.....c....p#
#....L.....M.....N....#
#..dD.....q.....gh....#
#k............f.......#
#......t........u.....#
#.....................#
##.################.###
#.....................#
#EE###.########.#######
###y.....###Y.z...#####
###..v...###..V...#####
###..x...###..X...#####
###......###......#####
#######################
`,
    anchors: {
      a: { role: 'window', facing: 's' },
      b: { role: 'window', facing: 's' },
      c: { role: 'window', facing: 's' },
      p: { role: 'plant', facing: 'w' },
      L: { role: 'light', facing: 's', lit: true },
      M: { role: 'light', facing: 's', lit: true, flicker: true },
      N: { role: 'light', facing: 's', lit: false },
      d: { role: 'desk', facing: 's' },
      D: { role: 'chair', facing: 'n' },
      q: { role: 'paper', facing: 's' },
      g: { role: 'desk', facing: 's' },
      h: { role: 'chair', facing: 'n' },
      k: { role: 'clock', facing: 'e' },
      f: { role: 'footprints', facing: 's', absentWhenNormal: true },
      t: { role: 'cabinet', facing: 's' },
      u: { role: 'shelf', facing: 's' },
      y: { role: 'cabinet', facing: 'e' },
      v: { role: 'desk', facing: 'n' },
      x: { role: 'chair', facing: 's' },
      Y: { role: 'cabinet', facing: 'e' },
      V: { role: 'desk', facing: 'n' },
      X: { role: 'chair', facing: 's' },
      z: { role: 'twinroom', facing: 's', absentWhenNormal: true },
    },
    pool: [
      {
        id: 'f3-twin',
        type: 'repeated-room',
        tier: 1,
        anchor: 'z',
        entry:
          'The south rooms. The left one and the right one are the same room. Not similar — the same. The scratch across the desk is the same scratch. The dust lies the same way. I logged only one of them. It did not feel like a choice.',
        toast: 'logged: the same room, twice',
        alteration: { anchor: 'x', kind: 'chair-turned' },
      },
      {
        id: 'f3-clock',
        type: 'backward-clock',
        tier: 2,
        anchor: 'k',
        entry:
          'The wall clock by the west wall is running. Backward. The sweep is smooth, unhurried. A broken clock does not move smoothly. This one has had practice.',
        toast: 'logged: the clock runs backward',
      },
      {
        id: 'f3-plant',
        type: 'living-plant',
        tier: 2,
        anchor: 'p',
        entry:
          'A potted plant in the northeast corner, green and full. The soil is dark — watered within the week. The building has been sealed for thirty years. Something waters it.',
        toast: 'logged: something waters it',
      },
      {
        id: 'f3-paper',
        type: 'fresh-paper',
        tier: 2,
        anchor: 'q',
        entry:
          'A page in the typewriter, stopped mid-sentence. The paper is new — white, not yellow. The ink is fresh. The ribbon should have dried out decades ago.',
        toast: 'logged: the page is new',
        rare: {
          chance: 0.006,
          entry:
            'A page in the typewriter, stopped mid-sentence. The paper is new. My surname is in the sentence. I did not read the rest of it.',
        },
      },
      {
        id: 'f3-steps',
        type: 'fresh-footprints',
        tier: 2,
        anchor: 'f',
        entry:
          'Footprints in the dust between the desk rows. They start at nothing and stop at nothing. The stride is shorter than mine. Bare feet.',
        toast: 'logged: footprints in the dust',
      },
    ],
  },

  // ---------------------------------------------------------------- floor 4
  {
    floor: 4,
    name: 'RECORDS — ARCHIVE STACKS',
    palette: 'tungsten-dust',
    quota: 4,
    spawnCount: 5,
    ceilingHeight: 2.5,
    hum: 0.55,
    occupancy: ['knock', 'below'],
    map: `
#####################
########EE###########
#......L....M.......#
###.#####.#######.###
#s...t..#.uk....#.w.#
#.......#.......#...#
#a......#.v.....#.b.#
#####.###.#####.##.##
#...................#
#.N....d....P.....O.#
###.#####.#####.#####
#c....##y..x##.....f#
#......#....#...Q...#
#g.....#.h..#......e#
#####################
`,
    anchors: {
      L: { role: 'light', facing: 's', lit: true },
      M: { role: 'light', facing: 's', lit: true, flicker: true },
      s: { role: 'shelf', facing: 'e' },
      t: { role: 'shelf', facing: 'e' },
      a: { role: 'cabinet', facing: 'e' },
      u: { role: 'cabinet', facing: 's' },
      k: { role: 'clock', facing: 's' },
      v: { role: 'desk', facing: 's' },
      w: { role: 'sink', facing: 's' },
      b: { role: 'plant', facing: 'w' },
      N: { role: 'light', facing: 's', lit: true },
      d: { role: 'door', facing: 'n', absentWhenNormal: true },
      P: { role: 'light', facing: 's', lit: false },
      O: { role: 'light', facing: 's', lit: false },
      c: { role: 'shelf', facing: 's' },
      y: { role: 'desk', facing: 's' },
      x: { role: 'ashtray', facing: 's' },
      f: { role: 'footprints', facing: 'w', absentWhenNormal: true },
      Q: { role: 'bench', facing: 'n' },
      g: { role: 'cart', facing: 'e' },
      h: { role: 'chair', facing: 'n' },
      e: { role: 'shelf', facing: 'w' },
    },
    pool: [
      {
        id: 'f4-drip',
        type: 'dripping-sink',
        tier: 2,
        anchor: 'w',
        entry:
          'The sink in the north washroom is dripping. Slow, patient, regular. The risers were drained in 1996 — I have the decommission sheet in my case. The stain under the drain is fresh.',
        toast: 'logged: the water still runs',
        alteration: { anchor: 'L', kind: 'light-off' },
      },
      {
        id: 'f4-smoke',
        type: 'smoldering-ashtray',
        tier: 2,
        anchor: 'x',
        entry:
          'An ashtray on the records desk. One cigarette, still lit, half an inch of ash unbroken. Whoever set it down did so gently, and recently, and is not here.',
        toast: 'logged: still burning',
      },
      {
        id: 'f4-door',
        type: 'extra-door',
        tier: 1,
        anchor: 'd',
        entry:
          'A door in the south wall of the cross-corridor. It is not on the blueprint. It is not on the fire plan either, and fire plans do not lie about doors.',
        toast: 'logged: another door that should not exist',
      },
      {
        id: 'f4-steps',
        type: 'fresh-footprints',
        tier: 2,
        anchor: 'f',
        entry:
          'Footprints in the southeast stack, close along the shelving, heel to toe, like someone walking a line. They are on top of my own prints. I have not been down that aisle yet.',
        toast: 'logged: prints over mine',
      },
      {
        id: 'f4-clock',
        type: 'backward-clock',
        tier: 2,
        anchor: 'k',
        entry:
          'The clock above the index cabinets is running backward, faster than the one two floors up. As if it has further to go.',
        toast: 'logged: backward, faster',
      },
    ],
  },

  // ---------------------------------------------------------------- floor 5
  {
    floor: 5,
    name: 'RECEPTION — LOWER LOBBY',
    palette: 'terminal-white',
    quota: 4,
    spawnCount: 3,
    ceilingHeight: 2.7,
    hum: 0.2,
    occupancy: ['below', 'chair-scrape'],
    map: `
###############
######EE#######
#.....L......##
#..a.....b...##
#....t.......##
##.####.####.##
#..M..#.#..N..#
#w....#.#....q#
#..c..#.#....k#
#.....#.#.....#
##.####.####.##
#.....p.......#
#..d.....D...##
###############
`,
    anchors: {
      L: { role: 'light', facing: 's', lit: true, flicker: true },
      a: { role: 'bench', facing: 's' },
      b: { role: 'bench', facing: 's' },
      t: { role: 'coffee', facing: 's' },
      M: { role: 'light', facing: 's', lit: false },
      N: { role: 'light', facing: 's', lit: false },
      w: { role: 'window', facing: 'e' },
      q: { role: 'window', facing: 'w' },
      c: { role: 'cabinet', facing: 'e' },
      k: { role: 'clock', facing: 'w' },
      p: { role: 'footprints', facing: 'n', absentWhenNormal: true },
      d: { role: 'chair', facing: 'n' },
      D: { role: 'chair', facing: 'n' },
    },
    pool: [
      {
        id: 'f5-coffee',
        type: 'steaming-coffee',
        tier: 2,
        anchor: 't',
        entry:
          'A cup of coffee on the reception counter. Steaming. I have stopped writing down why this is impossible. It knows why.',
        toast: 'logged: still steaming',
      },
      {
        id: 'f5-window',
        type: 'wrong-window',
        tier: 1,
        anchor: 'w',
        entry:
          'The west windows on this floor show noon. Flat, shadowless noon. It is {TIME}. It is not noon.',
        toast: 'logged: noon, at the wrong hour',
      },
      {
        id: 'f5-steps',
        type: 'fresh-footprints',
        tier: 2,
        anchor: 'p',
        entry:
          'Footprints circle the waiting benches and stop directly behind where I am standing to write this sentence.',
        toast: 'logged: they stop behind me',
      },
      {
        id: 'f5-ledger',
        type: 'ledger-altered',
        tier: 3,
        anchor: '',
        entry:
          'Entry no. 1 of this ledger is not what I wrote. The handwriting is mine. The words are not. I am logging my own ledger as a discrepancy. There is no form for this.',
        toast: 'logged: this ledger',
      },
    ],
  },
];
