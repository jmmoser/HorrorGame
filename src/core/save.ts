import type { SaveData } from './types';

const KEY = 'descent-ledger-v1';

export function freshSave(): SaveData {
  return {
    v: 1,
    seed: (Math.random() * 0xffffffff) >>> 0,
    floor: 1,
    ledger: [],
    logged: [],
    elapsed: 0,
    ledgerAltered: false,
    startedAt: Date.now(),
  };
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    if (data.v !== 1 || typeof data.seed !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage denied or full — the building keeps its own records.
  }
}

/** the seed, worn as a case number — printed on the ledger, the share card,
 *  and the title screen. two inspectors with the same case number walk the
 *  same building. */
export function caseNumber(seed: number): string {
  return `CASE S7-${(seed >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * The inverse of `caseNumber`. Accepts what a player will actually paste: the
 * printed form, the bare hex, lower case, with or without the CASE/S7 prefix,
 * and with the kind of stray whitespace that survives a copy out of a chat
 * window. Returns null if it isn't a case number at all.
 */
export function parseCaseNumber(input: string): number | null {
  const cleaned = input.trim().toUpperCase().replace(/[\s\u2013\u2014]/g, '');
  const m = /^(?:CASE)?-?(?:S7)?-?([0-9A-F]{1,8})$/.exec(cleaned);
  if (!m) return null;
  const seed = parseInt(m[1], 16);
  return Number.isFinite(seed) ? seed >>> 0 : null;
}

export function saveForSeed(seed: number): SaveData {
  return { ...freshSave(), seed: seed >>> 0 };
}

export function eraseSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
