// The only permanent UI during play: depth counter, a 3px reticle, the ledger
// tab. Everything else is the building.

export class Hud {
  private root = document.getElementById('hud')!;
  private depthNum = document.getElementById('depth-num')!;
  private reticle = document.getElementById('reticle')!;
  private tab = document.getElementById('ledger-tab')!;
  private toast = document.getElementById('log-toast')!;
  private toastTimer: number | null = null;

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
