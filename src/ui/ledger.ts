import type { LedgerEntry } from '../core/types';
import { findAnchorCell, parseRows } from '../world/grid';

// The ledger: the inspector's own record, and eventually the thing that
// cannot be trusted. Blueprint is drawn from the AUTHORED map — when the
// building disagrees with it, the building is what's lying. Probably.
// Logged discrepancies and amendments are marked on the drawing in red ink,
// where the inspector found them. The schedule block above the blueprint is
// the baseline the player checks the floor against.

const KIND_LABEL: Record<string, string> = {
  mundane: 'NO DEVIATION',
  amend: 'AMENDMENT',
  notice: 'TRANSCRIPT',
};

export class LedgerUI {
  private root = document.getElementById('ledger')!;
  private entriesEl = document.getElementById('ledger-entries')!;
  private quotaEl = document.getElementById('ledger-quota')!;
  private caseEl = document.getElementById('ledger-case')!;
  private schedEl = document.getElementById('ledger-schedule')!;
  private blueprint = document.getElementById('blueprint') as HTMLCanvasElement;
  /** set while an altered entry is waiting to be noticed */
  onAlteredTap: ((entry: LedgerEntry) => void) | null = null;
  onClose: (() => void) | null = null;
  onShare: (() => void) | null = null;

  constructor() {
    document.getElementById('btn-close-ledger')!.addEventListener('click', () => this.onClose?.());
    document.getElementById('btn-share')!.addEventListener('click', () => this.onShare?.());
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(
    entries: LedgerEntry[],
    floor: number,
    logged: number,
    quota: number,
    map: string,
    schedule: string[],
    caseNum: string,
  ) {
    this.quotaEl.textContent = `FLOOR −${String(floor).padStart(2, '0')} · ${logged} OF ${quota} LOGGED`;
    this.caseEl.textContent = caseNum;
    this.schedEl.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'sched-head';
    head.textContent = 'SCHEDULE — AS FILED';
    this.schedEl.appendChild(head);
    for (const line of schedule) {
      const div = document.createElement('div');
      div.className = 'sched-line';
      div.textContent = line;
      this.schedEl.appendChild(div);
    }
    this.drawBlueprint(map, entries, floor);
    this.renderEntries(entries);
    this.root.classList.remove('hidden');
  }

  close() {
    this.root.classList.add('hidden');
  }

  private renderEntries(entries: LedgerEntry[]) {
    this.entriesEl.innerHTML = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'entry-empty';
      empty.textContent = 'no discrepancies logged yet';
      this.entriesEl.appendChild(empty);
      return;
    }
    let no = 0;
    entries.forEach((e) => {
      const kind = e.kind ?? 'discrepancy';
      if (kind === 'filed') {
        const div = document.createElement('div');
        div.className = 'entry-filed';
        div.textContent = e.text;
        this.entriesEl.appendChild(div);
        return;
      }
      no += 1;
      const div = document.createElement('div');
      div.className = `entry entry-${kind}` + (e.altered ? ' altered' : '');
      const meta = document.createElement('div');
      meta.className = 'entry-meta';
      const label = KIND_LABEL[kind] ? ` · ${KIND_LABEL[kind]}` : '';
      meta.textContent = `NO. ${String(no).padStart(3, '0')} · FLOOR −${String(e.floor).padStart(2, '0')} · ${e.stamp}${label}`;
      const body = document.createElement('div');
      body.textContent = e.text;
      div.appendChild(meta);
      div.appendChild(body);
      if (e.altered) {
        div.title = 'this is not what I wrote';
        div.addEventListener('click', () => this.onAlteredTap?.(e));
      }
      this.entriesEl.appendChild(div);
    });
  }

  private drawBlueprint(map: string, entries: LedgerEntry[], floor: number) {
    const rows = parseRows(map);
    const g = this.blueprint.getContext('2d')!;
    const W = this.blueprint.width;
    const H = this.blueprint.height;
    g.clearRect(0, 0, W, H);
    const cw = rows[0].length;
    const ch = rows.length;
    const s = Math.min((W - 40) / cw, (H - 60) / ch);
    const ox = (W - cw * s) / 2;
    const oy = (H - ch * s) / 2 + 8;

    // hand-drafted feel: slightly translucent ink, hairline grid
    g.strokeStyle = 'rgba(58,54,44,0.16)';
    g.lineWidth = 1;
    for (let x = 0; x <= cw; x += 2) {
      g.beginPath();
      g.moveTo(ox + x * s, oy);
      g.lineTo(ox + x * s, oy + ch * s);
      g.stroke();
    }
    for (let z = 0; z <= ch; z += 2) {
      g.beginPath();
      g.moveTo(ox, oy + z * s);
      g.lineTo(ox + cw * s, oy + z * s);
      g.stroke();
    }
    for (let z = 0; z < ch; z++) {
      for (let x = 0; x < cw; x++) {
        const c = rows[z][x];
        if (c === '#') {
          g.fillStyle = 'rgba(58,54,44,0.78)';
          g.fillRect(ox + x * s, oy + z * s, s, s);
        } else if (c === 'E') {
          g.fillStyle = 'rgba(107,29,18,0.35)';
          g.fillRect(ox + x * s + 1, oy + z * s + 1, s - 2, s - 2);
        }
      }
    }

    // red-ink marks where this floor's discrepancies and amendments were found.
    // marks live on the AUTHORED drawing — the world may disagree.
    let no = 0;
    for (const e of entries) {
      const kind = e.kind ?? 'discrepancy';
      if (kind === 'filed') continue;
      no += 1;
      if (e.floor !== floor || !e.anchor) continue;
      if (kind !== 'discrepancy' && kind !== 'amend') continue;
      const cell = findAnchorCell(rows, e.anchor);
      if (!cell) continue;
      const mx = ox + (cell[0] + 0.5) * s;
      const my = oy + (cell[1] + 0.5) * s;
      g.strokeStyle = kind === 'amend' ? 'rgba(122,32,32,0.55)' : 'rgba(122,32,32,0.85)';
      g.lineWidth = 1.4;
      g.beginPath();
      // a slightly unsteady hand-drawn circle
      for (let a = 0; a <= Math.PI * 2 + 0.2; a += 0.4) {
        const r = s * 0.85 + Math.sin(a * 3 + no) * 0.8;
        const px = mx + Math.cos(a) * r;
        const py = my + Math.sin(a) * r;
        if (a === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
      g.fillStyle = 'rgba(122,32,32,0.9)';
      g.font = '10px "Courier New", monospace';
      g.textAlign = 'left';
      g.fillText(String(no), mx + s * 0.95, my - s * 0.5);
    }

    g.fillStyle = 'rgba(58,54,44,0.9)';
    g.font = '11px "Courier New", monospace';
    g.textAlign = 'left';
    g.fillText('AS FILED — DO NOT AMEND', ox, oy - 8);
  }
}
