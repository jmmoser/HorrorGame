import type { LedgerEntry } from '../core/types';

// The share card: a torn-out ledger page. Depth + one logged discrepancy +
// the URL. This is the growth mechanic — the page must look like evidence.

function drawCard(floor: number, entry: LedgerEntry | null): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1080;
  c.height = 1350;
  const g = c.getContext('2d')!;

  g.fillStyle = '#0a0a0a';
  g.fillRect(0, 0, 1080, 1350);

  // the page, slightly rotated, torn at the top
  g.save();
  g.translate(540, 700);
  g.rotate(-0.012);
  g.translate(-460, -560);
  g.fillStyle = '#cfc7b2';
  g.shadowColor = 'rgba(0,0,0,0.8)';
  g.shadowBlur = 60;
  g.beginPath();
  // torn top edge
  g.moveTo(0, 26);
  for (let x = 0; x <= 920; x += 46) {
    g.lineTo(x + 23, 26 + (Math.sin(x * 0.7) * 9 + (x % 92 === 0 ? 14 : 0)));
  }
  g.lineTo(920, 26);
  g.lineTo(920, 1120);
  g.lineTo(0, 1120);
  g.closePath();
  g.fill();
  g.shadowBlur = 0;

  g.fillStyle = '#55503f';
  g.font = '26px "Courier New", monospace';
  g.textAlign = 'left';
  g.fillText('MUNICIPAL SURVEY — STRUCTURE 7', 70, 120);
  g.fillText('INSPECTION LEDGER — PAGE TORN OUT', 70, 158);
  g.strokeStyle = '#a99f85';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(70, 186);
  g.lineTo(850, 186);
  g.stroke();

  g.fillStyle = '#2e2a20';
  g.font = 'bold 150px "Courier New", monospace';
  g.fillText(`FLOOR`, 70, 360);
  g.fillText(`−${String(floor).padStart(2, '0')}`, 70, 520);

  g.font = '30px "Courier New", monospace';
  g.fillStyle = '#3a372f';
  const text = entry
    ? `NO. — · FLOOR −${String(entry.floor).padStart(2, '0')} · ${entry.stamp}\n\n${entry.text}`
    : 'No discrepancies logged.\n\nYet.';
  const words = text.split(/\s+/);
  let line = '';
  let y = 640;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > 780) {
      g.fillText(line, 70, y);
      y += 44;
      line = w;
      if (y > 1040) break;
    } else {
      line = test;
    }
  }
  if (y <= 1040) g.fillText(line, 70, y);

  g.restore();

  g.fillStyle = 'rgba(216,210,196,0.8)';
  g.font = '30px "Courier New", monospace';
  g.textAlign = 'center';
  g.fillText('the elevator only goes down', 540, 1250);
  g.font = '24px "Courier New", monospace';
  g.fillStyle = 'rgba(216,210,196,0.5)';
  g.fillText(shareUrl(floor).replace(/^https?:\/\//, ''), 540, 1300);
  return c;
}

export function shareUrl(floor: number): string {
  return `${location.origin}${location.pathname}?f=${floor}`;
}

export async function shareCard(floor: number, entry: LedgerEntry | null): Promise<'shared' | 'downloaded'> {
  const canvas = drawCard(floor, entry);
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
  );
  const file = new File([blob], `descent-ledger-floor-${floor}.png`, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({
        files: [file],
        title: 'The Descent Ledger',
        text: `Floor −${String(floor).padStart(2, '0')}. The elevator only goes down. ${shareUrl(floor)}`,
      });
      return 'shared';
    } catch {
      // fall through to download (user may have cancelled — still give them the page)
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(a.href);
  try {
    await navigator.clipboard.writeText(shareUrl(floor));
  } catch {
    /* clipboard denied — the download is enough */
  }
  return 'downloaded';
}

/** floor number from an inbound share link, if any */
export function inboundShareFloor(): number | null {
  const f = new URLSearchParams(location.search).get('f');
  if (!f) return null;
  const n = parseInt(f, 10);
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
}
