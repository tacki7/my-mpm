// Zoom and pan of the roll-bite view: the wheel zooms about the pointer, a drag
// pans, a double click (or 元に戻す, or 0) goes back to the default window; with
// the canvas focused, + − and the arrows do the same. The toolbar also chooses
// the thickness exaggeration and turns the principal-direction glyphs on.
import type { BiteView, Exaggeration } from './view.ts';

export interface ViewControlsOptions {
  canvas: HTMLCanvasElement;
  toolbar: HTMLElement;
  view: BiteView;
  /** the view changed: redraw */
  redraw: () => void;
  /** the principal-direction glyphs were turned on or off (the worker sends the stresses) */
  onDirs: (on: boolean) => void;
}

const STEP = 1.25; // zoom per key press or button

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function attachViewControls({ canvas, toolbar, view, redraw, onDirs }: ViewControlsOptions): void {
  const change = (fn: () => void) => {
    fn();
    redraw();
  };

  // ── toolbar ───────────────────────────────────────────────────────────────
  const button = (text: string, label: string, fn: () => void) => {
    const b = el('button', undefined, text);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', () => change(fn));
    toolbar.append(b);
    return b;
  };
  button('＋', '拡大', () => view.zoomBy(STEP));
  button('−', '縮小', () => view.zoomBy(1 / STEP));
  button('元に戻す', '初めの表示に戻す（ダブルクリック、0 キーでも）', () => view.resetView());

  const exRow = el('label', 'view-ex');
  exRow.append(el('span', undefined, '板厚方向'));
  const ex = el('select');
  ex.name = 'exaggeration';
  for (const [v, t] of [
    ['auto', '自動'],
    ['1', '1 倍'],
    ['2', '2 倍'],
    ['4', '4 倍'],
  ]) {
    const o = el('option', undefined, t);
    o.value = v;
    ex.append(o);
  }
  ex.addEventListener('change', () =>
    change(() => (view.state.exMode = (ex.value === 'auto' ? 'auto' : Number(ex.value)) as Exaggeration)),
  );
  exRow.append(ex);
  toolbar.append(exRow);

  const dirRow = el('label', 'view-dirs');
  const dirs = el('input');
  dirs.type = 'checkbox';
  dirs.name = 'dirs';
  dirs.addEventListener('change', () => {
    view.state.dirs = dirs.checked;
    onDirs(dirs.checked);
    redraw();
  });
  dirRow.append(dirs, el('span', undefined, '主応力の向き'));
  dirRow.title = '十字の腕が主応力の向き。銅は引張、青は圧縮、長いほど大きい';
  toolbar.append(dirRow);

  // ── pointer ───────────────────────────────────────────────────────────────
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'ロールバイト。ホイールで拡大、ドラッグで移動、ダブルクリックで元に戻す');
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // a notch of a mouse wheel is about 100 (pixels); trackpads send small steps
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      change(() => view.zoomAt(e.clientX, e.clientY, Math.exp(-d * 0.0015)));
    },
    { passive: false },
  );
  let drag: { x: number; y: number; moved: boolean; id: number } | null = null;
  let swallowClick = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    change(() => view.panBy(dx, dy));
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    swallowClick = drag.moved;
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // a drag is not a click (other listeners pick points on click)
  canvas.addEventListener(
    'click',
    (e) => {
      if (swallowClick) {
        e.stopImmediatePropagation();
        swallowClick = false;
      }
    },
    { capture: true },
  );
  canvas.addEventListener('dblclick', () => change(() => view.resetView()));

  // ── keys (with the canvas focused) ────────────────────────────────────────
  canvas.addEventListener('keydown', (e) => {
    const r = canvas.getBoundingClientRect();
    const k = e.key;
    let fn: (() => void) | null = null;
    if (k === '+' || k === '=') fn = () => view.zoomBy(STEP);
    else if (k === '-' || k === '_') fn = () => view.zoomBy(1 / STEP);
    else if (k === '0') fn = () => view.resetView();
    else if (k === 'ArrowLeft') fn = () => view.panBy(0.1 * r.width, 0);
    else if (k === 'ArrowRight') fn = () => view.panBy(-0.1 * r.width, 0);
    else if (k === 'ArrowUp') fn = () => view.panBy(0, 0.1 * r.height);
    else if (k === 'ArrowDown') fn = () => view.panBy(0, -0.1 * r.height);
    if (!fn) return;
    e.preventDefault();
    change(fn);
  });
}
