import { DEFAULT_SETTINGS, detectTier, type QualityTier, type Settings } from '../render/quality';

// The inspection's own paperwork: a filed form, not a game menu. Same
// typewriter, same ink, same municipal tone as the ledger — opening it should
// feel like turning to the back of the clipboard, not like leaving the
// building.

type Field =
  | { kind: 'choice'; key: keyof Settings; label: string; note?: string; options: Array<{ value: string; label: string }> }
  | { kind: 'toggle'; key: keyof Settings; label: string; note?: string }
  | { kind: 'range'; key: keyof Settings; label: string; note?: string; min: number; max: number; step: number; format: (v: number) => string };

interface Section {
  title: string;
  fields: Field[];
}

const SECTIONS: Section[] = [
  {
    title: 'I · IMAGE',
    fields: [
      {
        kind: 'choice',
        key: 'quality',
        label: 'detail',
        note: 'shadows, occlusion, light in the air',
        options: [
          { value: 'auto', label: 'auto' },
          { value: 'low', label: 'low' },
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
          { value: 'ultra', label: 'ultra' },
        ],
      },
      {
        kind: 'toggle',
        key: 'adaptiveResolution',
        label: 'steady frame',
        note: 'trades resolution to hold the frame rate',
      },
      {
        kind: 'toggle',
        key: 'filmEffects',
        label: 'film',
        note: 'grain, vignette, lens aberration',
      },
      { kind: 'toggle', key: 'showFps', label: 'frame counter' },
    ],
  },
  {
    title: 'II · CONTROL',
    fields: [
      {
        kind: 'range',
        key: 'lookSensitivity',
        label: 'look speed',
        min: 0.3,
        max: 2.5,
        step: 0.05,
        format: (v) => `${v.toFixed(2)}×`,
      },
      { kind: 'toggle', key: 'invertY', label: 'invert vertical' },
      {
        kind: 'range',
        key: 'fovOffset',
        label: 'field of view',
        note: 'degrees added to the default',
        min: -10,
        max: 20,
        step: 1,
        format: (v) => `${v > 0 ? '+' : ''}${v}°`,
      },
    ],
  },
  {
    title: 'III · COMFORT',
    fields: [
      {
        kind: 'range',
        key: 'masterVolume',
        label: 'volume',
        note: 'the sound is half the inspection',
        min: 0,
        max: 1,
        step: 0.05,
        format: (v) => `${Math.round(v * 100)}%`,
      },
      { kind: 'toggle', key: 'headBob', label: 'head movement', note: 'off for motion comfort' },
      { kind: 'toggle', key: 'haptics', label: 'haptics', note: 'the heartbeat, on devices that can' },
      {
        kind: 'toggle',
        key: 'captions',
        label: 'sound captions',
        note: 'names what the building does, in text',
      },
    ],
  },
];

export class SettingsUI {
  private root = document.getElementById('settings')!;
  private current: Settings = { ...DEFAULT_SETTINGS };
  onChange: ((s: Settings) => void) | null = null;
  onClose: (() => void) | null = null;

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(settings: Settings) {
    this.current = { ...settings };
    this.render();
    this.root.classList.remove('hidden');
  }

  close() {
    this.root.classList.add('hidden');
  }

  private commit(patch: Partial<Settings>) {
    this.current = { ...this.current, ...patch };
    this.onChange?.(this.current);
    this.render();
  }

  private render() {
    const detected = detectTier();
    this.root.innerHTML = '';

    const page = document.createElement('div');
    page.id = 'settings-page';

    const head = document.createElement('div');
    head.className = 'settings-head';
    head.innerHTML =
      '<span>MUNICIPAL SURVEY — INSPECTOR PREFERENCES</span><span>FORM 7-B</span>';
    page.appendChild(head);

    for (const section of SECTIONS) {
      const h = document.createElement('div');
      h.className = 'settings-section';
      h.textContent = section.title;
      page.appendChild(h);

      for (const field of section.fields) {
        page.appendChild(this.renderField(field, detected));
      }
    }

    const foot = document.createElement('div');
    foot.className = 'settings-foot';

    const reset = document.createElement('button');
    reset.className = 'paper-btn';
    reset.textContent = 'restore defaults';
    reset.addEventListener('click', () => this.commit({ ...DEFAULT_SETTINGS }));

    const close = document.createElement('button');
    close.className = 'paper-btn';
    close.textContent = 'back to the floor';
    close.addEventListener('click', () => this.onClose?.());

    foot.append(reset, close);
    page.appendChild(foot);
    this.root.appendChild(page);
  }

  private renderField(field: Field, detected: QualityTier): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const label = document.createElement('div');
    label.className = 'settings-label';
    label.textContent = field.label;
    if (field.note) {
      const note = document.createElement('span');
      note.className = 'settings-note';
      note.textContent = field.note;
      label.appendChild(note);
    }
    row.appendChild(label);

    const control = document.createElement('div');
    control.className = 'settings-control';

    if (field.kind === 'choice') {
      for (const opt of field.options) {
        const b = document.createElement('button');
        b.className = 'settings-opt';
        // say out loud what 'auto' decided, so it isn't a black box
        b.textContent =
          opt.value === 'auto' && field.key === 'quality' ? `auto · ${detected}` : opt.label;
        if (this.current[field.key] === opt.value) b.classList.add('on');
        b.addEventListener('click', () =>
          this.commit({ [field.key]: opt.value } as unknown as Partial<Settings>),
        );
        control.appendChild(b);
      }
    } else if (field.kind === 'toggle') {
      const on = this.current[field.key] === true;
      const b = document.createElement('button');
      b.className = `settings-opt wide ${on ? 'on' : ''}`;
      b.textContent = on ? 'yes' : 'no';
      b.addEventListener('click', () =>
        this.commit({ [field.key]: !on } as unknown as Partial<Settings>),
      );
      control.appendChild(b);
    } else {
      const value = this.current[field.key] as number;
      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'settings-range';
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = String(field.step);
      input.value = String(value);
      const readout = document.createElement('span');
      readout.className = 'settings-value';
      readout.textContent = field.format(value);
      // live while dragging, but only re-render (and re-lay-out) on release
      input.addEventListener('input', () => {
        const v = Number(input.value);
        readout.textContent = field.format(v);
        this.current = { ...this.current, [field.key]: v };
        this.onChange?.(this.current);
      });
      control.append(input, readout);
    }

    row.appendChild(control);
    return row;
  }
}
