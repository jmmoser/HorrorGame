import './styles.css';
import { Game, devValidate } from './game';
import { Controls } from './player/controls';
import { freshSave, loadSave } from './core/save';
import { inboundShareFloor } from './ui/share';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });
devValidate();

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const gate = document.getElementById('gate')!;
const title = document.getElementById('title')!;
const btnBegin = document.getElementById('btn-begin')!;
const btnResume = document.getElementById('btn-resume')!;

let game: Game | null = null;

function showTitle() {
  gate.classList.add('fading');
  window.setTimeout(() => gate.classList.add('hidden'), 1300);
  title.classList.remove('hidden');

  const existing = loadSave();
  if (existing && (existing.floor > 1 || existing.ledger.length > 0)) {
    btnResume.classList.remove('hidden');
    document.getElementById('resume-floor')!.textContent = `−${String(existing.floor).padStart(2, '0')}`;
    btnBegin.textContent = 'begin again';
  }

  const inbound = inboundShareFloor();
  if (inbound) {
    const v = document.getElementById('title-visitor')!;
    v.textContent = `AN INSPECTOR REACHED FLOOR −${String(inbound).padStart(2, '0')} BEFORE YOU.`;
    v.classList.remove('hidden');
  }
}

async function begin(resume: boolean) {
  if (game) return;
  const save = resume ? (loadSave() ?? freshSave()) : freshSave();
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

document.getElementById('gate-continue')!.addEventListener('click', () => {
  // gesture #1: unlock what we can early (some browsers require it here)
  showTitle();
});
btnBegin.addEventListener('click', () => void begin(false));
btnResume.addEventListener('click', () => void begin(true));
