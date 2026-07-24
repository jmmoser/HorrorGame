// The only permanent UI during play: depth counter, a 3px reticle, the ledger
// tab. Everything else is the building.

export class Hud {
  private root = document.getElementById('hud')!;
  private depthNum = document.getElementById('depth-num')!;
  private reticle = document.getElementById('reticle')!;
  private tab = document.getElementById('ledger-tab')!;
  private toast = document.getElementById('log-toast')!;
  private toastTimer: number | null = null;
  private docRing = document.getElementById('doc-ring')!;
  private docRingFill = document.getElementById('doc-ring-fill')!;
  private floorCard = document.getElementById('floor-card')!;
  private floorCardName = document.getElementById('floor-card-name')!;
  private floorCardSched = document.getElementById('floor-card-sched')!;
  private floorCardTimer: number | null = null;
  private static DOC_CIRC = 75.4;

  show() {
    this.root.classList.remove('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
  }

  setDepth(floor: number) {
    this.depthNum.textContent = `−${String(floor).padStart(2, '0')}`;
  }

  setOnTarget(on: boolean) {
    this.reticle.classList.toggle('on-target', on);
  }

  /** documenting ring around the reticle; progress 0..1, null hides it */
  setDocProgress(p: number | null) {
    if (p === null) {
      this.docRing.classList.add('hidden');
      return;
    }
    this.docRing.classList.remove('hidden');
    this.docRingFill.setAttribute(
      'stroke-dashoffset',
      String(Hud.DOC_CIRC * (1 - Math.min(1, Math.max(0, p)))),
    );
  }

  /** floor arrival card: name + the filed schedule, fading after a beat */
  showFloorCard(floor: number, name: string, schedule: string[]) {
    this.floorCardName.textContent = `FLOOR −${String(floor).padStart(2, '0')} · ${name}`;
    this.floorCardSched.innerHTML = '';
    for (const line of schedule) {
      const div = document.createElement('div');
      div.textContent = line;
      this.floorCardSched.appendChild(div);
    }
    this.floorCard.classList.remove('hidden');
    this.floorCard.classList.remove('leaving');
    if (this.floorCardTimer) clearTimeout(this.floorCardTimer);
    this.floorCardTimer = window.setTimeout(() => {
      this.floorCard.classList.add('leaving');
      this.floorCardTimer = window.setTimeout(
        () => this.floorCard.classList.add('hidden'),
        1600,
      );
    }, 7000);
  }

  pulseTab() {
    this.tab.classList.remove('pulse');
    // restart the animation
    void (this.tab as HTMLElement).offsetWidth;
    this.tab.classList.add('pulse');
  }

  showToast(text: string) {
    this.toast.textContent = text;
    this.toast.classList.remove('hidden');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    // re-trigger CSS animation
    this.toast.style.animation = 'none';
    void this.toast.offsetWidth;
    this.toast.style.animation = '';
    this.toastTimer = window.setTimeout(() => this.toast.classList.add('hidden'), 3600);
  }

  onLedgerTab(fn: () => void) {
    this.tab.addEventListener('click', fn);
  }
}
