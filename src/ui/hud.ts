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
  private fps = document.getElementById('fps-readout')!;
  private caption = document.getElementById('caption-line')!;
  private captionTimer: number | null = null;
  private fpsVisible = false;
  private fpsAccum = 0;
  private static DOC_CIRC = 75.4;
  private handPrompt = document.getElementById('hand-prompt')!;
  private handVerb = document.getElementById('hand-verb')!;
  private handAlt = document.getElementById('hand-alt')!;
  private verbs = document.getElementById('verbs')!;
  private btnHand = document.getElementById('btn-hand')!;
  private btnLamp = document.getElementById('btn-lamp')!;
  private btnListen = document.getElementById('btn-listen')!;
  private listenVeil = document.getElementById('listen-veil')!;
  private lastPrompt = '';

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

  /** the on-screen verb buttons are for thumbs; a keyboard has its own */
  setVerbsVisible(on: boolean) {
    this.verbs.classList.toggle('hidden', !on);
  }

  /**
   * What the hand could do to whatever the reticle is on. Two lines at most:
   * the tap verb and the hold verb. Written in lower case, because the HUD is
   * the inspector's own thinking and the inspector is not shouting.
   */
  setHandPrompt(primary: string | null, secondary: string | null) {
    const key = `${primary ?? ''}|${secondary ?? ''}`;
    if (key === this.lastPrompt) return;
    this.lastPrompt = key;
    if (!primary) {
      this.handPrompt.classList.add('hidden');
      this.btnHand.classList.remove('armed');
      return;
    }
    this.handVerb.textContent = primary;
    if (secondary) {
      this.handAlt.textContent = `hold — ${secondary}`;
      this.handAlt.classList.remove('hidden');
    } else {
      this.handAlt.classList.add('hidden');
    }
    this.handPrompt.classList.remove('hidden');
    this.btnHand.classList.add('armed');
  }

  /** 0..1 progress of the hold that switches the hand to its second verb */
  setHandHold(p: number) {
    this.btnHand.classList.toggle('holding', p >= 1);
  }

  setLampOff(off: boolean) {
    this.btnLamp.classList.toggle('off', off);
  }

  /** the frame closes down a little while the inspector is listening */
  setListening(v: number) {
    this.listenVeil.classList.toggle('hidden', v < 0.01);
    this.listenVeil.style.opacity = String(Math.min(1, v));
    this.btnListen.classList.toggle('holding', v > 0.5);
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

  /** name a sound the player just heard; only ever called when captions are on */
  showCaption(text: string) {
    this.caption.textContent = text;
    this.caption.classList.remove('hidden');
    this.caption.style.opacity = '1';
    if (this.captionTimer) clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => {
      this.caption.style.opacity = '0';
      this.captionTimer = window.setTimeout(() => this.caption.classList.add('hidden'), 600);
    }, 4200);
  }

  setFpsVisible(on: boolean) {
    this.fpsVisible = on;
    this.fps.classList.toggle('hidden', !on);
  }

  /** throttled so the readout itself isn't the thing costing frames */
  setFps(frameMs: number) {
    if (!this.fpsVisible) return;
    this.fpsAccum += 1;
    if (this.fpsAccum < 15) return;
    this.fpsAccum = 0;
    this.fps.textContent = `${Math.round(1000 / Math.max(frameMs, 0.1))} FPS`;
  }

  onLedgerTab(fn: () => void) {
    this.tab.addEventListener('click', fn);
  }
}
