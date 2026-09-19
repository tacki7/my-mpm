// The stands of a tandem side by side in the roll-bite area. The current stand is drawn in the live canvas
// (#bite: zoom, pan, clicks and the overview stay with it), moved into that stand's slot; a finished stand
// keeps its last frame; a stand still to come is an empty slot with its number. All the views share the
// live view's state (zoom, pan, exaggeration mode), one scale (the first stand's) and one colour range.
// One stand: nothing here is used and the page is as before.
import type { Frame, Geometry } from './protocol.ts';
import { BiteView, fieldRange } from './view.ts';

interface Slot {
  el: HTMLElement;
  label: HTMLElement;
  canvas: HTMLCanvasElement;
  view: BiteView;
}

export class StandViews {
  private readonly bite: HTMLElement;
  private readonly live: BiteView;
  private readonly liveCanvas: HTMLCanvasElement;
  private row: HTMLElement | null = null;
  private slots: Slot[] = [];
  stands = 1;
  current = 0;

  constructor(bite: HTMLElement, live: BiteView, liveCanvas: HTMLCanvasElement) {
    this.bite = bite;
    this.live = live;
    this.liveCanvas = liveCanvas;
  }

  get active(): boolean {
    return this.stands > 1;
  }

  /** a new run of `stands` stands, the first with geometry g */
  setup(stands: number, g: Geometry): void {
    if (this.row) {
      // the live canvas back where it was, the old slots away
      this.bite.prepend(this.liveCanvas);
      this.row.remove();
      this.row = null;
      this.slots = [];
    }
    this.stands = stands;
    this.current = 0;
    this.live.scaleFrom = null;
    this.live.rangeOverride = null;
    if (stands <= 1) return;
    this.live.scaleFrom = g;
    const row = document.createElement('div');
    row.className = 'stand-row';
    for (let k = 0; k < stands; k++) {
      const el = document.createElement('div');
      el.className = 'stand-slot';
      el.dataset.stand = String(k + 1);
      const canvas = document.createElement('canvas');
      canvas.className = 'stand-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'stand-label';
      label.textContent = `#${k + 1}`;
      el.append(canvas, label);
      row.append(el);
      const view = new BiteView(canvas);
      view.state = this.live.state; // zoom, pan and exaggeration mode are the live view's
      view.scaleFrom = g;
      this.slots.push({ el, label, canvas, view });
    }
    this.bite.prepend(row);
    this.row = row;
    this.place();
  }

  /** stand k is over: its slot keeps this frame */
  hold(k: number, frame: Frame, g: Geometry): void {
    const s = this.slots[k];
    if (!s) return;
    s.view.frame = frame;
    s.view.geometry = g;
  }

  /** the live view moves on to stand k */
  setCurrent(k: number): void {
    this.current = k;
    this.place();
  }

  private place(): void {
    this.slots.forEach((s, k) => {
      s.el.classList.toggle('current', k === this.current);
      s.el.classList.toggle('done', k < this.current);
      s.canvas.hidden = k === this.current;
      s.label.textContent = k < this.current ? `#${k + 1}` : k === this.current ? `#${k + 1}（計算中）` : `#${k + 1}（まだ）`;
    });
    const slot = this.slots[this.current];
    if (slot) slot.el.prepend(this.liveCanvas);
    this.resize();
  }

  resize(): void {
    this.live.resize();
    for (const s of this.slots) if (!s.canvas.hidden) s.view.resize();
  }

  /** the frames on show: the finished stands' and the live one */
  frames(): Frame[] {
    const out: Frame[] = [];
    this.slots.forEach((s, k) => {
      if (k < this.current && s.view.frame) out.push(s.view.frame);
    });
    if (this.live.frame) out.push(this.live.frame);
    return out;
  }

  /** before drawing: one colour range over the frames on show (those of the field on show) */
  prepare(): void {
    if (!this.active) return;
    const shown = this.frames();
    const field = this.live.frame?.field;
    const same = shown.filter((f) => f.field === field);
    const range = same.length ? fieldRange(same) : null;
    this.live.rangeOverride = range;
    for (const s of this.slots) s.view.rangeOverride = range;
  }

  /** the finished stands' pictures (the live one is drawn by the page) */
  draw(): void {
    if (!this.active) return;
    this.slots.forEach((s, k) => {
      if (s.canvas.hidden) return;
      if (k > this.current) {
        s.view.frame = null;
        s.view.geometry = null;
      }
      s.view.draw();
    });
  }
}
