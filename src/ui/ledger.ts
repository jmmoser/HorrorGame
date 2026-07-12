import type { LedgerEntry } from '../core/types';
import { parseRows } from '../world/grid';

// The ledger: the inspector's own record, and eventually the thing that
// cannot be trusted. Blueprint is drawn from the AUTHORED map — when the
// building disagrees with it, the building is what's lying. Probably.

export class LedgerUI {
  private root = document.getElementById('ledger')!;
  private entriesEl = document.getElementById('ledger-entries')!;
  private quotaEl = document.getElementById('ledger-quota')!;
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

  open(entries: LedgerEntry[], floor: number, logged: number, quota: number, map: string) {
    this.quotaEl.textContent = `FLOOR −${String(floor).padStart(2, '0')} · ${logged} OF ${quota} LOGGED`;
    this.drawBlueprint(map);
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
    entries.forEach((e, i) => {
      const div = document.createElement('div');
      div.className = 'entry' + (e.altered ? ' altered' : '');
      const meta = document.createElement('div');
      meta.className = 'entry-meta';
      meta.textContent = `NO. ${String(i + 1).padStart(3, '0')} · FLOOR −${String(e.floor).padStart(2, '0')} · ${e.stamp}`;
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

  private drawBlueprint(map: string) {
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
    g.fillStyle = 'rgba(58,54,44,0.9)';
    g.font = '11px "Courier New", monospace';
    g.textAlign = 'left';
    g.fillText('AS FILED — DO NOT AMEND', ox, oy - 8);
  }
}
