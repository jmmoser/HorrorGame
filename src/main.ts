import './styles.css';
import { Game, devValidate } from './game';
import { Controls } from './player/controls';
import { caseNumber, freshSave, loadSave, parseCaseNumber, saveForSeed } from './core/save';
import { inboundCase, inboundShareFloor } from './ui/share';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });
devValidate();

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const gate = document.getElementById('gate')!;
const title = document.getElementById('title')!;
const btnBegin = document.getElementById('btn-begin')!;
const btnResume = document.getElementById('btn-resume')!;

let game: Game | null = null;
/** set when the player took someone else's case, or arrived on a case link */
let assignedSeed: number | null = null;

function showTitle() {
  gate.classList.add('fading');
  window.setTimeout(() => gate.classList.add('hidden'), 1300);
  title.classList.remove('hidden');

  // the controls, said once, in the register of the form. a game that never
  // says how it is played reads as a game that was not finished.
  const touch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  document.getElementById('title-controls')!.textContent = touch
    ? 'LEFT THUMB WALKS · RIGHT THUMB LOOKS · TAP TO DOCUMENT'
    : 'W A S D WALKS · MOUSE LOOKS · CLICK TO DOCUMENT · ESC PAUSES';

  const existing = loadSave();
  if (existing && (existing.floor > 1 || existing.ledger.length > 0)) {
    btnResume.classList.remove('hidden');
    document.getElementById('resume-floor')!.textContent = `−${String(existing.floor).padStart(2, '0')}`;
    btnBegin.textContent = 'begin again';
    // the case number is the seed — same case, same building. compare notes.
    const caseEl = document.getElementById('title-case')!;
    caseEl.textContent = caseNumber(existing.seed);
    caseEl.classList.remove('hidden');
  }

  const inbound = inboundShareFloor();
  if (inbound) {
    const v = document.getElementById('title-visitor')!;
    v.textContent = `AN INSPECTOR REACHED FLOOR −${String(inbound).padStart(2, '0')} BEFORE YOU.`;
    v.classList.remove('hidden');
  }

  // A share link carries the case, so following one puts you in the same
  // building rather than merely a building with the same number on it.
  const linked = inboundCase();
  const linkedSeed = linked ? parseCaseNumber(linked) : null;
  if (linkedSeed !== null) {
    assignedSeed = linkedSeed;
    const caseEl = document.getElementById('title-case')!;
    caseEl.textContent = `ASSIGNED — ${caseNumber(linkedSeed)}`;
    caseEl.classList.remove('hidden');
    btnBegin.textContent = 'accept assignment';
  }
}

function bindCaseEntry() {
  const toggle = document.getElementById('btn-case')!;
  const form = document.getElementById('case-form') as HTMLFormElement;
  const input = document.getElementById('case-input') as HTMLInputElement;
  const error = document.getElementById('case-error')!;

  toggle.addEventListener('click', () => {
    toggle.classList.add('hidden');
    form.classList.remove('hidden');
    input.focus();
  });
  input.addEventListener('input', () => error.classList.add('hidden'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const seed = parseCaseNumber(input.value);
    if (seed === null) {
      error.classList.remove('hidden');
      return;
    }
    assignedSeed = seed;
    void begin(false);
  });
}

async function begin(resume: boolean) {
  if (game) return;
  const save = resume
    ? (loadSave() ?? freshSave())
    : assignedSeed !== null
      ? saveForSeed(assignedSeed)
      : freshSave();
  game = new Game(canvas, save);
  if (import.meta.env.DEV) {
    (window as unknown as { __game: Game }).__game = game;
  }
  // audio + gyro permissions ride the same tap
  game.audio.unlock();
  await Controls.requestGyro();
  title.classList.add('fading');
  window.setTimeout(() => title.classList.add('hidden'), 1300);
  game.start();
}

bindCaseEntry();
document.getElementById('gate-continue')!.addEventListener('click', () => {
  // gesture #1: unlock what we can early (some browsers require it here)
  showTitle();
});
btnBegin.addEventListener('click', () => void begin(false));
btnResume.addEventListener('click', () => void begin(true));
