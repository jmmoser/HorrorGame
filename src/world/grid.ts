import type { Facing, FloorSpec } from '../core/types';

// Floors are authored as ASCII maps. '#' wall, '.' floor, 'E' elevator car,
// any letter = a walkable cell carrying a prop anchor. One cell = 2m.

export const CS = 2;
export const WALL_H = 2.7;

export interface Grid {
  w: number;
  h: number;
  rows: string[];
  elevator: {
    cells: Array<[number, number]>;
    /** direction the doors face (out of the car) */
    doorDir: Facing;
    /** world-space center of the car */
    cx: number;
    cz: number;
    /** world-space center of the door plane */
    doorX: number;
    doorZ: number;
    /** width of the opening in world units */
    doorW: number;
  };
}

export const DIRS: Record<Facing, [number, number]> = {
  n: [0, -1],
  s: [0, 1],
  w: [-1, 0],
  e: [1, 0],
};

export function opposite(f: Facing): Facing {
  return f === 'n' ? 's' : f === 's' ? 'n' : f === 'e' ? 'w' : 'e';
}

export function facingToYaw(f: Facing): number {
  // props are modeled facing +z
  switch (f) {
    case 's': return 0;
    case 'n': return Math.PI;
    case 'e': return Math.PI / 2;
    case 'w': return -Math.PI / 2;
  }
}

export function cellCenter(cx: number, cz: number): { x: number; z: number } {
  return { x: (cx + 0.5) * CS, z: (cz + 0.5) * CS };
}

export function parseRows(map: string): string[] {
  return map
    .split('\n')
    .map((r) => r.trimEnd())
    .filter((r) => r.length > 0);
}

export function applyStretch(rows: string[], stretch?: { row: number; count: number }): string[] {
  if (!stretch) return rows;
  const out = rows.slice(0, stretch.row + 1);
  for (let i = 0; i < stretch.count; i++) out.push(rows[stretch.row]);
  return out.concat(rows.slice(stretch.row + 1));
}

export function isWalkable(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '#';
}

export function charAt(rows: string[], cx: number, cz: number): string | undefined {
  if (cz < 0 || cz >= rows.length) return undefined;
  if (cx < 0 || cx >= rows[cz].length) return undefined;
  return rows[cz][cx];
}

export function buildGrid(rows: string[]): Grid {
  const h = rows.length;
  const w = rows[0].length;
  const cells: Array<[number, number]> = [];
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (rows[z][x] === 'E') cells.push([x, z]);
    }
  }
  if (cells.length === 0) throw new Error('map has no elevator');
  // door side: the direction in which any E cell touches a walkable non-E cell
  let doorDir: Facing | null = null;
  const openCells: Array<[number, number]> = [];
  for (const [x, z] of cells) {
    for (const dir of Object.keys(DIRS) as Facing[]) {
      const [dx, dz] = DIRS[dir];
      const ch = charAt(rows, x + dx, z + dz);
      if (isWalkable(ch) && ch !== 'E') {
        doorDir = dir;
        openCells.push([x, z]);
      }
    }
  }
  if (!doorDir) throw new Error('elevator has no opening');
  let sx = 0;
  let sz = 0;
  for (const [x, z] of cells) {
    sx += x + 0.5;
    sz += z + 0.5;
  }
  const cx = (sx / cells.length) * CS;
  const cz = (sz / cells.length) * CS;
  let dsx = 0;
  let dsz = 0;
  for (const [x, z] of openCells) {
    const [dx, dz] = DIRS[doorDir];
    dsx += (x + 0.5 + dx * 0.5) * CS;
    dsz += (z + 0.5 + dz * 0.5) * CS;
  }
  return {
    w,
    h,
    rows,
    elevator: {
      cells,
      doorDir,
      cx,
      cz,
      doorX: dsx / openCells.length,
      doorZ: dsz / openCells.length,
      doorW: openCells.length * CS,
    },
  };
}

export function findAnchorCell(rows: string[], letter: string): [number, number] | null {
  for (let z = 0; z < rows.length; z++) {
    const x = rows[z].indexOf(letter);
    if (x >= 0) return [x, z];
  }
  return null;
}

const WALL_MOUNTED = new Set(['door', 'window', 'roomplate', 'clock', 'calendar', 'sink']);

/** Author-time sanity checks. Run in dev and by scripts/validate-floors. */
export function validateSpec(spec: FloorSpec): string[] {
  const errors: string[] = [];
  const rows = parseRows(spec.map);
  const w = rows[0]?.length ?? 0;
  rows.forEach((r, i) => {
    if (r.length !== w) errors.push(`row ${i} has length ${r.length}, expected ${w}`);
  });
  // sealed border
  for (let x = 0; x < w; x++) {
    if (rows[0][x] !== '#') errors.push(`top border open at col ${x}`);
    if (rows[rows.length - 1][x] !== '#') errors.push(`bottom border open at col ${x}`);
  }
  for (let z = 0; z < rows.length; z++) {
    if (rows[z][0] !== '#') errors.push(`left border open at row ${z}`);
    if (rows[z][w - 1] !== '#') errors.push(`right border open at row ${z}`);
  }
  // anchors exist, are unique, and are defined
  const seen = new Map<string, number>();
  for (let z = 0; z < rows.length; z++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[z][x];
      if (ch === '#' || ch === '.' || ch === 'E') continue;
      seen.set(ch, (seen.get(ch) ?? 0) + 1);
      if (!spec.anchors[ch]) errors.push(`map letter '${ch}' at ${x},${z} has no anchor def`);
    }
  }
  for (const [ch, n] of seen) if (n > 1) errors.push(`anchor '${ch}' appears ${n} times`);
  for (const ch of Object.keys(spec.anchors)) {
    if (!seen.has(ch)) errors.push(`anchor '${ch}' defined but not on map`);
  }
  // wall-mounted anchors need a wall behind them
  for (const [ch, def] of Object.entries(spec.anchors)) {
    const cell = findAnchorCell(rows, ch);
    if (!cell) continue;
    if (WALL_MOUNTED.has(def.role)) {
      const back = opposite(def.facing);
      const [dx, dz] = DIRS[back];
      if (charAt(rows, cell[0] + dx, cell[1] + dz) !== '#') {
        errors.push(`wall-mounted anchor '${ch}' (${def.role}) has no wall behind it`);
      }
    }
  }
  // discrepancy pool references
  for (const d of spec.pool) {
    if (d.type !== 'ledger-altered' && !spec.anchors[d.anchor]) {
      errors.push(`discrepancy ${d.id} references unknown anchor '${d.anchor}'`);
    }
    if (d.alteration && !spec.anchors[d.alteration.anchor]) {
      errors.push(`discrepancy ${d.id} alteration references unknown anchor '${d.alteration.anchor}'`);
    }
  }
  // ledger-altered discrepancies are always active on top of spawnCount
  const anchored = spec.pool.filter((d) => d.type !== 'ledger-altered').length;
  const guaranteed = spec.pool.length - anchored;
  if (spec.spawnCount + guaranteed < spec.quota) {
    errors.push(`spawnCount ${spec.spawnCount} + guaranteed ${guaranteed} < quota ${spec.quota}`);
  }
  if (anchored < spec.spawnCount) {
    errors.push('pool smaller than spawnCount');
  }
  // elevator must open on exactly one side — a second opening makes the
  // door/button placement in buildGrid ambiguous (and once put a call button
  // inside a wall)
  {
    const dirs = new Set<Facing>();
    for (let z = 0; z < rows.length; z++) {
      for (let x = 0; x < w; x++) {
        if (rows[z][x] !== 'E') continue;
        for (const dir of Object.keys(DIRS) as Facing[]) {
          const [dx, dz] = DIRS[dir];
          const ch = charAt(rows, x + dx, z + dz);
          if (isWalkable(ch) && ch !== 'E') dirs.add(dir);
        }
      }
    }
    if (dirs.size > 1) {
      errors.push(`elevator opens on multiple sides: ${[...dirs].join(', ')}`);
    }
  }
  // everything reachable from the elevator
  try {
    const grid = buildGrid(rows);
    const start = grid.elevator.cells[0];
    const visited = new Set<string>();
    const queue: Array<[number, number]> = [start];
    visited.add(start.join(','));
    while (queue.length) {
      const [x, z] = queue.pop()!;
      for (const [dx, dz] of Object.values(DIRS)) {
        const nx = x + dx;
        const nz = z + dz;
        const key = `${nx},${nz}`;
        if (visited.has(key)) continue;
        if (!isWalkable(charAt(rows, nx, nz))) continue;
        visited.add(key);
        queue.push([nx, nz]);
      }
    }
    for (const [ch] of seen) {
      const cell = findAnchorCell(rows, ch)!;
      if (!visited.has(cell.join(','))) errors.push(`anchor '${ch}' unreachable from elevator`);
    }
  } catch (e) {
    errors.push(String(e));
  }
  // stretch row must exist and stay enclosed
  if (spec.stretch) {
    const r = rows[spec.stretch.row];
    if (!r) errors.push(`stretch row ${spec.stretch.row} out of range`);
    else if (r[0] !== '#' || r[w - 1] !== '#') errors.push('stretch row not wall-bounded');
  }
  return errors;
}
