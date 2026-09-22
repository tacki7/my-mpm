// The 「2 次元」「3 次元」 tabs and the three-dimensional page: the strip's width, length and grid in the
// conditions panel (stands, handoff, roll flattening, constant reduction and the length 'steady' are the shared
// panel's, as in the 2 次元 tab), the 3D worker, its picture (solidView.ts), the results table, the three graphs (roll force,
// the load across the width, the contact pressure over the bite) and the conditions URL with the 3D keys.
// Everything the page had before is the 2 次元 tab, left as it is; main.ts routes the shared buttons here while
// the 3 次元 tab is shown.
import { cloneParams, type SimParams } from '../mpm/params.ts';
import type { SolidPhase, SolidSettings } from '../mpm/solid/sim3.ts';
import type { SolidSteady } from '../mpm/solid/steady.ts';
import type { Stand3Result } from '../mpm/solid/tandem3.ts';
import { drawChart } from './charts.ts';
import { css, split, temper } from './colormap.ts';
import { checkRange } from './fieldCheck.ts';
import { uiFont } from './font.ts';
import { say } from './liveText.ts';
import { Eta, etaText, standGrowth } from './eta.ts';
import { edited, showNumber } from './numberInput.ts';
import { conditionsQuery } from './query.ts';
import { radioGroup } from './radioGroup.ts';
import type { FromSolidWorker, SolidFieldName, SolidFrame, SolidGeometry, ToSolidWorker } from './solidProtocol.ts';
import { SolidStandTable } from './solidStandTable.ts';
import { stopPhrase } from './standTable.ts';
import { Explorer, standColor } from './explorer.ts';
import { SOLID_FIELDS, SolidView, solidFieldInfo, type ViewPreset } from './solidView.ts';

export type Dim = '2' | '3';

const mm = 1e-3;
const INK = '#1d2a3a';
const STEEL = '#5f6b75';

const phaseText: Record<SolidPhase, string> = {
  approach: 'ロールに向かっている',
  bite: '噛み込み中',
  adjusting: 'ロールを調整中（偏平・ギャップ）',
  steady: '定常圧延',
  'tail-out': '尾端が抜けるところ',
  done: '圧延が終わった',
  stalled: '板が止まった（噛み込めない）',
};

/** the 3D page's own settings: the strip and the grid (the rest are the conditions both tabs share) */
export interface SolidPageSettings {
  /** strip width, length [m] */
  width: number;
  length: number;
  /** grid cells through the thickness (even: the mid-thickness is a grid plane) */
  cells: number;
  planeStrain: boolean;
}

interface NumberField {
  key: 'width' | 'length' | 'cells';
  query: string;
  label: string;
  unit: string;
  step: number;
  min: number;
  max: number;
  scale: number;
  hint?: string;
}

const NUMBERS: NumberField[] = [
  { key: 'width', query: 'W3', label: '板幅', unit: 'mm', step: 1, min: 2, max: 200, scale: mm, hint: '解くのは 1/4（板幅と板厚の中央で鏡映）。時間は板幅に比例: 8 mm で約 2.5 分、40 mm で約 14 分、200 mm は 1 時間以上' },
  { key: 'length', query: 'L3', label: '板の長さ', unit: 'mm', step: 1, min: 6, max: 40, scale: mm, hint: '定常の読みには 12 mm ほど要る。「板の長さの取り方」が「定常状態になるまで」なら自動' },
  { key: 'cells', query: 'cells3', label: '板厚方向のセル数', unit: '', step: 2, min: 4, max: 8, scale: 1, hint: '偶数。4 で約 2〜3 分、6 で約 14 分' },
];

const DEFAULTS: SolidPageSettings = { width: 8 * mm, length: 12 * mm, cells: 4, planeStrain: false };

function checked(s: SolidPageSettings): SolidPageSettings {
  const clamp = (v: number, f: NumberField) => Math.min(f.max * f.scale, Math.max(f.min * f.scale, v));
  const cells = 2 * Math.round(clamp(s.cells, NUMBERS[2]) / 2);
  return { width: clamp(s.width, NUMBERS[0]), length: clamp(s.length, NUMBERS[1]), cells, planeStrain: s.planeStrain };
}

function settingsOf(q: URLSearchParams): SolidPageSettings {
  const s = { ...DEFAULTS };
  for (const f of NUMBERS) {
    const v = parseFloat(q.get(f.query) ?? '');
    if (Number.isFinite(v) && v >= f.min && v <= f.max) s[f.key] = v * f.scale;
  }
  s.planeStrain = q.get('ps3') === '1';
  return checked(s);
}

/** the conditions of the panel the 3D model does not have: their rows are hidden in the 3 次元 tab */
/** the section-only conditions the 3D model has as well: their rows stay in the 3 次元 tab */
const ALSO_IN_3D = ['stands', 'handoff', 'control', 'flatten', 'rollE', 'length'];
const NOT_IN_3D = ['L', 'tb', 'tf', 'cells', 'yield', 'nucleation', 'f0', 'fc', 'failure', 'crack'];

export interface SolidModeOptions {
  query: URLSearchParams;
  panelRoot: HTMLElement;
  /** the conditions both tabs share (the panel's unapplied edits stay pending) */
  conditions(): SimParams;
  presetId(): string;
  preset(): SimParams;
  onEdit(): void;
  /** called after the tab changed */
  onDim(dim: Dim): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class SolidMode {
  dim: Dim = '2';
  settings: SolidPageSettings;
  private readonly o: SolidModeOptions;
  private readonly view: SolidView;
  private worker: Worker | null = null;
  /** the stand running now (a tandem sends one per stand) and every stand's so far */
  private geometry: SolidGeometry | null = null;
  private geometries: SolidGeometry[] = [];
  private standResults: Stand3Result[] = [];
  private standTable!: SolidStandTable;
  /** the stress state and the fracture locus of the first crack's and the most damaged point */
  private explorer!: Explorer;
  private last: SolidFrame | null = null;
  private params: SimParams | null = null;
  private field: SolidFieldName;
  private running = false;
  private frames = 0;
  /** the time the run still needs, beside the clock (src/app/eta.ts) */
  private eta = new Eta();
  private dirty = false;
  private chartsDirty = false;
  private awaitingReady = false;
  private readonly stopAfter: number | null;
  private readonly inputs = new Map<NumberField['key'], HTMLInputElement>();
  private planeStrainBox!: HTMLInputElement;
  private readonly checks: (() => void)[] = [];
  private readonly tabButtons: HTMLButtonElement[] = [];
  private shown: SolidPageSettings | null = null;
  /** a few words for a screen reader under each graph (canvases are not read), written when the steady reading first comes and at the end */
  private readonly summaries: HTMLElement[] = [];
  private summaryMoment = '';

  constructor(o: SolidModeOptions, stopAfter: number | null) {
    this.o = o;
    this.stopAfter = stopAfter;
    this.settings = settingsOf(o.query);
    this.field = (SOLID_FIELDS.find((f) => f.id === o.query.get('f3'))?.id ?? 'seq') as SolidFieldName;
    this.view = new SolidView(this.$<HTMLCanvasElement>('solid-canvas'));
    document.body.dataset.dim = '2';
    this.buildDimTabs();
    this.buildSettings();
    this.buildFieldTabs();
    this.buildTools();
    this.buildPointer();
    this.buildUrl();
    this.standTable = new SolidStandTable(this.$('solid-stand-section'), this.$('solid-stand-results'));
    this.explorer = new Explorer(
      this.$('solid-explorer'),
      this.$('solid-locus'),
      () => {},
      () => {
        this.chartsDirty = true;
      },
      { roles: ['first-crack', 'max-damage'], hint: '最初に亀裂になった点と、損傷がいちばん大きい点。3 次元では点は選べない' },
    );
    for (const id of ['solid-chart-force', 'solid-chart-width', 'solid-chart-map']) {
      const p = el('p', 'sr-only solid-chart-summary');
      this.$(id).parentElement!.append(p);
      this.summaries.push(p);
    }
    // the canvas itself as well as the stage: the charts' row under it grows (a legend, a summary) without the
    // stage changing, and the picture would be drawn at the old size and squashed by the CSS
    const ro = new ResizeObserver(() => {
      this.view.resize();
      this.dirty = this.chartsDirty = true;
    });
    ro.observe(this.$('solid-stage'));
    ro.observe(this.$('solid-canvas'));
    requestAnimationFrame(() => this.drawLoop());
  }

  private $<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }

  get active(): boolean {
    return this.dim === '3';
  }

  get started(): boolean {
    return this.worker !== null;
  }

  // ── building ───────────────────────────────────────────────────────────────
  /** the two index tabs, standing on the masthead's ink rule */
  private buildDimTabs(): void {
    const nav = this.$('dim-tabs');
    for (const [dim, label, about] of [
      ['2', '2 次元', '板の断面（平面ひずみ）と平面図。板幅方向の変形は考えない'],
      ['3', '3 次元', '板幅方向の変形（幅広がり・幅方向の荷重分布）も解く'],
    ] as [Dim, string, string][]) {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.id = `dim-tab-${dim}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(dim === this.dim));
      b.setAttribute('aria-controls', 'dim-panel');
      b.tabIndex = dim === this.dim ? 0 : -1;
      b.title = about;
      b.dataset.dim = dim;
      b.addEventListener('click', () => this.setDim(dim));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const next: Dim = e.key === 'Home' ? '2' : e.key === 'End' ? '3' : this.dim === '2' ? '3' : '2';
        this.setDim(next);
        this.tabButtons.find((t) => t.dataset.dim === next)?.focus();
      });
      nav.append(b);
      this.tabButtons.push(b);
    }
  }

  private buildSettings(): void {
    const fs = el('fieldset', 'group dim3-only');
    fs.append(el('legend', undefined, '板と格子（3 次元）'));
    for (const f of NUMBERS) {
      const row = el('label', 'field');
      row.append(el('span', 'field-label', f.label));
      const box = el('span', 'field-input');
      const inp = el('input');
      inp.type = 'number';
      inp.name = `solid-${f.key}`;
      inp.step = String(f.step);
      inp.min = String(f.min);
      inp.max = String(f.max);
      inp.addEventListener('input', () => this.o.onEdit());
      box.append(inp);
      if (f.unit) box.append(el('span', 'unit', f.unit));
      row.append(box);
      if (f.hint) row.append(el('span', 'hint', f.hint));
      this.checks.push(checkRange(inp, row, () => [f.min, f.max], f.unit));
      fs.append(row);
      this.inputs.set(f.key, inp);
    }
    const ps = el('label', 'field check');
    this.planeStrainBox = el('input');
    this.planeStrainBox.type = 'checkbox';
    this.planeStrainBox.name = 'solid-plane-strain';
    this.planeStrainBox.addEventListener('change', () => this.o.onEdit());
    ps.append(this.planeStrainBox, el('span', undefined, '板幅方向を止めて解く（平面ひずみ）'));
    ps.title = '板幅方向の速度を 0 にする。2 次元の断面と同じ問題になるので、3 次元の計算の確かめに使う';
    fs.append(ps);
    fs.append(el('p', 'hint', 'スタンド数（タンデム）・ロール偏平・圧下率一定・板の長さの取り方は「板とロール」の欄で、2 次元と共通。張力（「潤滑と張力」の欄）も効く。GTN・亀裂の面は 3 次元には無い（亀裂になった点は応力を失うだけで、面は開かない）'));
    const note = this.o.panelRoot.querySelector('.note-more') ?? this.o.panelRoot.querySelector('.preset-note');
    if (note) note.after(fs);
    else this.o.panelRoot.prepend(fs);
    // the rows of the shared panel the 3D model has no use for
    for (const name of NOT_IN_3D) {
      const c = this.o.panelRoot.querySelector(`[name="${name}"]`);
      c?.closest('label')?.classList.add('dim2-only');
    }
    for (const name of ALSO_IN_3D) this.o.panelRoot.querySelector(`[name="${name}"]`)?.closest('label')?.classList.add('solid-too');
    // the length 'steady': the 3D length is then not an input either
    this.lengthSelect?.addEventListener('change', () => this.lockLength());
    this.o.panelRoot.querySelector('[name="f0"]')?.closest('details')?.classList.add('dim2-only');
    this.showSettings(this.settings);
  }

  private get lengthSelect(): HTMLSelectElement | null {
    return this.o.panelRoot.querySelector<HTMLSelectElement>('select[name="length"]');
  }

  /** with the length 'steady' the field is off, and shows the length worked out once the run is ready */
  private lockLength(): void {
    const auto = this.lengthSelect?.value === 'steady';
    const L = this.inputs.get('length')!;
    L.disabled = auto;
    L.title = auto ? '「定常状態になるまで」では自動で決まる（用意ができると、決まった長さが出る）' : '';
    if (!auto && this.shown) showNumber(L, this.shown.length / mm);
  }

  private showSettings(s: SolidPageSettings): void {
    this.shown = { ...s };
    for (const f of NUMBERS) showNumber(this.inputs.get(f.key)!, s[f.key] / f.scale);
    this.planeStrainBox.checked = s.planeStrain;
    this.lockLength();
    for (const c of this.checks) c();
  }

  private readSettings(): SolidPageSettings {
    const s = { ...(this.shown ?? this.settings) };
    for (const f of NUMBERS) {
      const inp = this.inputs.get(f.key)!;
      if (!edited(inp)) continue;
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) s[f.key] = v * f.scale;
    }
    s.planeStrain = this.planeStrainBox.checked;
    return checked(s);
  }

  private buildFieldTabs(): void {
    const tabs = this.$('solid-tabs');
    for (const f of SOLID_FIELDS) {
      const b = el('button', undefined, f.tab ?? f.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.field = f.id;
      b.addEventListener('click', () => this.setField(f.id));
      tabs.append(b);
    }
    this.markFieldTabs();
    radioGroup(tabs);
  }

  private markFieldTabs(): void {
    for (const b of this.$('solid-tabs').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.field === this.field));
  }

  private buildTools(): void {
    const tools = this.$('solid-tools');
    const looks = el('div', 'look-from');
    looks.setAttribute('role', 'radiogroup');
    looks.setAttribute('aria-label', '見る向き');
    for (const [id, label] of [
      ['oblique', '斜めから'],
      ['top', '上から'],
      ['side', '横から'],
      ['front', '出側から'],
    ] as [ViewPreset, string][]) {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.look = id;
      b.setAttribute('aria-checked', String(id === 'oblique'));
      b.addEventListener('click', () => {
        this.view.setPreset(id);
        this.markLook(id);
        this.dirty = true;
      });
      looks.append(b);
    }
    radioGroup(looks);
    const toggle = (label: string, title: string, on: boolean, set: (v: boolean) => void): HTMLButtonElement => {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', () => {
        const v = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(v));
        set(v);
        this.dirty = true;
      });
      return b;
    };
    const cut = toggle('板幅の中央で切る', '手前の半分を外して、板幅の中央の断面の色を見る', false, (v) => (this.view.cut = v));
    cut.id = 'solid-cut';
    const rolls = toggle('ロール', 'ロールを描く・描かない', true, (v) => (this.view.rolls = v));
    rolls.id = 'solid-rolls';
    const whole = toggle('全体を見る', '板の全長を入れて見る（もう一度押すとロールバイトに戻る）', false, (v) => (this.view.fit = v ? 'strip' : 'bite'));
    whole.id = 'solid-whole';
    const thick = el('label', 'thick-scale');
    thick.append(el('span', undefined, '板厚の倍率'));
    const sel = el('select');
    sel.id = 'solid-yscale';
    for (const k of [1, 2, 4]) {
      const o = el('option', undefined, `× ${k}`);
      o.value = String(k);
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      this.view.yScale = Number(sel.value);
      this.dirty = true;
    });
    thick.append(sel);
    tools.prepend(looks, cut, rolls, whole, thick);
  }

  private markLook(id: ViewPreset | null): void {
    for (const b of this.$('solid-tools').querySelectorAll<HTMLButtonElement>('.look-from button')) b.setAttribute('aria-checked', String(b.dataset.look === id));
  }

  /** drag turns the drawing, the wheel zooms, a double click puts it back; the arrow keys and + − do the same */
  private buildPointer(): void {
    const c = this.$<HTMLCanvasElement>('solid-canvas');
    let drag: { x: number; y: number; pan: boolean } | null = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 };
      c.setPointerCapture(e.pointerId);
      c.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.pan) {
        this.view.panX += dx;
        this.view.panY += dy;
      } else {
        // the strip follows the hand: a drag to the right brings its left side round
        this.view.rotate(-dx * 0.008, dy * 0.008);
        this.markLook(null);
      }
      this.dirty = true;
    });
    const end = () => {
      drag = null;
      c.classList.remove('dragging');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.view.zoom = Math.min(12, Math.max(0.4, this.view.zoom * Math.exp(-e.deltaY * 0.0015)));
        this.dirty = true;
      },
      { passive: false },
    );
    c.addEventListener('dblclick', () => {
      this.view.reset();
      this.markLook('oblique');
      this.dirty = true;
    });
    c.addEventListener('keydown', (e) => {
      const step = 5 * (Math.PI / 180);
      if (e.key === 'ArrowLeft') this.view.rotate(step, 0);
      else if (e.key === 'ArrowRight') this.view.rotate(-step, 0);
      else if (e.key === 'ArrowUp') this.view.rotate(0, step);
      else if (e.key === 'ArrowDown') this.view.rotate(0, -step);
      else if (e.key === '+' || e.key === ';') this.view.zoom = Math.min(12, this.view.zoom * 1.2);
      else if (e.key === '-') this.view.zoom = Math.max(0.4, this.view.zoom / 1.2);
      else if (e.key === '0') this.view.reset();
      else return;
      e.preventDefault();
      this.markLook(e.key === '0' ? 'oblique' : null);
      this.dirty = true;
    });
  }

  private buildUrl(): void {
    const box = this.$('solid-export');
    const status = el('p', 'export-status');
    status.setAttribute('aria-live', 'polite');
    const url = el('input');
    url.type = 'text';
    url.readOnly = true;
    url.hidden = true;
    url.setAttribute('aria-label', '今の条件で 3 次元のタブが始まる URL');
    const copy = el('button', undefined, '条件の URL をコピー');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const u = new URL(location.href);
      u.search = this.query().toString();
      url.value = u.href;
      url.hidden = false;
      try {
        await navigator.clipboard.writeText(u.href);
        status.textContent = '条件の URL をコピーした。開くと同じ条件の 3 次元のタブで始まる';
      } catch {
        status.textContent = 'クリップボードに書けなかった。下の欄の URL を選んでコピーする';
      }
    });
    const row = el('div', 'export-url');
    row.append(copy, url);
    box.append(el('h2', undefined, '結果の書き出し'), row, status);
  }

  /** the conditions URL: the shared keys, and the tab and the 3D settings */
  query(): URLSearchParams {
    const q = conditionsQuery(this.o.presetId(), this.o.preset(), this.params3d ?? this.o.conditions());
    for (const k of ['L', 'cells']) q.delete(k);
    q.set('dim', '3');
    for (const f of NUMBERS) q.set(f.query, String(+(this.settings[f.key] / f.scale).toFixed(3)));
    if (this.settings.planeStrain) q.set('ps3', '1');
    if (this.field !== 'seq') q.set('f3', this.field);
    return q;
  }

  /** the shared conditions as they were when the 3D run started (without the 3D overrides) */
  private params3d: SimParams | null = null;

  // ── tab, worker ────────────────────────────────────────────────────────────
  setDim(dim: Dim): void {
    if (dim === this.dim) return;
    this.dim = dim;
    document.body.dataset.dim = dim;
    for (const b of this.tabButtons) {
      const on = b.dataset.dim === dim;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.$('dim-panel').setAttribute('aria-labelledby', `dim-tab-${dim}`);
    if (dim === '3') {
      if (!this.worker) this.restart(this.o.conditions(), false);
      this.showClock();
      this.view.resize();
      this.dirty = this.chartsDirty = true;
      this.updateButtons();
    } else if (this.running) this.pause();
    this.o.onDim(dim);
  }

  private send(m: ToSolidWorker): void {
    this.worker?.postMessage(m);
  }

  private startWorker(): void {
    this.worker = new Worker(new URL('./solid.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromSolidWorker>) => {
      const m = e.data;
      if (m.type === 'ready') {
        this.geometry = m.geometry;
        this.geometries[m.geometry.stand] = m.geometry;
        this.view.geometry = m.geometry;
        this.dirty = this.chartsDirty = true;
        // a tandem's next stand: the run goes on
        if (m.geometry.stand > 0) return;
        this.awaitingReady = false;
        if (this.params?.rolling.lengthMode === 'steady') showNumber(this.inputs.get('length')!, m.geometry.sheetLength / mm);
        this.updateIdle();
        if (this.o.query.get('autorun') === '1' && this.frames === 0 && this.active) this.run();
      } else if (m.type === 'stand') {
        if (!this.awaitingReady) this.standResults[m.result.stand] = m.result;
      } else if (m.type === 'frame') {
        if (!this.awaitingReady) this.onFrame(m);
      } else if (m.type === 'error') this.showError(m.message);
    };
    this.worker.onerror = (e) => this.showError(e.message);
  }

  /** start over with these shared conditions and the 3D settings: the panel's, or (readPanel false) the ones shown */
  restart(params: SimParams, readPanel = true): void {
    if (!this.worker) this.startWorker();
    this.settings = readPanel ? this.readSettings() : this.settings;
    this.showSettings(this.settings);
    this.params3d = cloneParams(params);
    const P = cloneParams(params);
    // what the 3D model has of its own, and what it does not have at all
    P.rolling.sheetLength = this.settings.length;
    P.numerics.cellsThrough = this.settings.cells;
    this.params = P;
    this.eta.reset();
    this.geometries = [];
    this.standResults = [];
    this.last = null;
    this.view.frame = null;
    this.running = false;
    this.frames = 0;
    this.awaitingReady = true;
    const solid: SolidSettings = { width: this.settings.width, planeStrain: this.settings.planeStrain };
    this.send({ type: 'init', params: P, solid, stands: P.rolling.stands ?? 1, handoff: P.rolling.handoff ?? 'done', field: this.field, stopAfter: this.stopAfter });
    this.standTable.update(1, [], 0, false, null, null);
    this.explorer.reset();
    this.updateButtons();
    this.$('solid-results').replaceChildren();
    this.summaryMoment = '';
    for (const p of this.summaries) p.textContent = '';
    say(this.$('solid-phase'), '格子と点を用意している');
  }

  applyConditions(params: SimParams): void {
    if (this.started) return this.restart(params);
    this.settings = this.readSettings();
    this.showSettings(this.settings);
  }

  run(): void {
    if (!this.worker) return;
    this.running = true;
    this.send({ type: 'run' });
    this.updateButtons();
  }

  pause(): void {
    this.running = false;
    this.send({ type: 'pause' });
    this.updateButtons();
  }

  setField(id: SolidFieldName): void {
    this.field = id;
    this.markFieldTabs();
    this.send({ type: 'field', field: id });
    this.dirty = true;
  }

  private get finished(): boolean {
    return this.last?.diag.finished === true;
  }

  updateButtons(): void {
    if (!this.active) return;
    (this.$('run') as HTMLButtonElement).disabled = this.running || this.finished || this.awaitingReady;
    (this.$('pause') as HTMLButtonElement).disabled = !this.running;
    this.$('run').textContent = this.frames > 1 && !this.finished ? '続ける' : '圧延を始める';
  }

  showClock(): void {
    if (!this.active) return;
    const d = this.last?.diag;
    this.$('clock').textContent = `t = ${((d?.t ?? 0) * 1e3).toFixed(2)} ms　${(d?.step ?? 0).toLocaleString()} step`;
    this.$('eta').textContent = etaText(this.eta.seconds, this.frames > 1, this.finished);
  }

  private showError(msg: string): void {
    this.$('solid-phase').textContent = `計算が止まった: ${msg}`;
    this.running = false;
    this.awaitingReady = false;
    this.updateButtons();
  }

  // ── frames ─────────────────────────────────────────────────────────────────
  /** ready, not started yet: what is about to be solved */
  private updateIdle(): void {
    const g = this.geometry!;
    this.updateButtons();
    say(this.$('solid-phase'), `用意ができた（${g.stands > 1 ? `${g.stands} スタンドの #1、` : ''}${g.n.toLocaleString()} 点）。「圧延を始める」で計算する`);
    this.$('solid-results-note').textContent = NOTE;
  }

  private onFrame(f: SolidFrame): void {
    this.last = f;
    const roll = this.params?.rolling;
    this.eta.update(performance.now(), f.running, f.diag.progress, f.diag.stand, roll?.stands ?? 1, standGrowth(roll?.reduction ?? 0, roll?.handoff ?? 'done', true));
    this.frames++;
    this.running = f.running;
    this.view.frame = f;
    // rolls that follow the pass: the picture's rolls are the ones now
    const g0 = this.geometry;
    if (g0 && (g0.gap !== f.diag.gap || g0.rollRadius !== f.diag.rollRadius)) this.view.geometry = { ...g0, gap: f.diag.gap, rollRadius: f.diag.rollRadius };
    this.dirty = this.chartsDirty = true;
    this.updateButtons();
    this.updateResults(f);
    if (this.params) this.explorer.update({ tracks: f.tracks, cracks: f.diag.firstCrack ? [f.diag.firstCrack] : [] }, this.params);
  }

  private updateResults(f: SolidFrame): void {
    const g = this.geometry!;
    const d = f.diag;
    const st = d.steady;
    const steady = !!st && st.looks > 0;
    const none = !steady && (d.finished || d.phase === 'done' || d.phase === 'stalled');
    const adjusted = this.params?.rolling.flattening === 'hitchcock' || this.params?.rolling.gapControl === 'reduction';
    const W0 = 2 * g.halfWidth0;
    const force = steady ? st.force : none ? undefined : d.now?.force;
    const halfW = steady ? st.halfWidth : none ? undefined : (d.now?.halfWidth ?? undefined);
    const perWidth = force != null ? force / (halfW != null ? 2 * halfW : W0) : undefined;
    const centre = steady ? 2 * st.halfThickness[0] : none ? undefined : d.now?.centreHalfThickness != null ? 2 * d.now.centreHalfThickness : undefined;
    const edge = steady ? 2 * st.halfThickness[st.halfThickness.length - 1] : undefined;
    const num = (v: number | undefined | null, k: number, digits: number) => (v != null && Number.isFinite(v) ? (v * k).toFixed(digits) : '—');
    const c0 = d.firstCrack;
    const rows: [string, string, string, boolean][] = [
      ...(g.stands > 1 ? ([['スタンド', `#${d.stand + 1} / ${g.stands}`, '', false]] as [string, string, string, boolean][]) : []),
      ['圧延荷重（全幅）', num(force, 1e-3, 2), 'kN', !steady],
      ['板幅あたりの荷重', num(perWidth, 1e-6, 3), 'kN/mm', !steady],
      ['スラブ法（平面ひずみ）', num(g.slabForce, 1e-6, 3), 'kN/mm', false],
      ...(g.stands > 1 ? ([['入側板厚', num(g.h0, 1e3, 3), 'mm', false]] as [string, string, string, boolean][]) : []),
      ['入側の板幅', num(W0, 1e3, 3), 'mm', false],
      ['出側の板幅', num(halfW != null ? 2 * halfW : undefined, 1e3, 3), 'mm', !steady],
      ['幅広がり W1 − W0', num(halfW != null ? 2 * halfW - W0 : undefined, 1e3, 3), 'mm', !steady],
      ['幅広がり W1/W0 − 1', num(halfW != null ? (2 * halfW) / W0 - 1 : undefined, 100, 2), '%', !steady],
      ['出側板厚（板幅の中央）', num(centre, 1e3, 4), 'mm', !steady],
      ['出側板厚（端）', num(edge, 1e3, 4), 'mm', false],
      ['先進率', num(steady ? st.forwardSlip : undefined, 100, 2), '%', false],
      ...(adjusted
        ? ([
            ["ロール半径 R'", num(d.rollRadius, 1e3, 1), 'mm', !d.rollsSettled],
            ['ロールギャップ', num(d.gap, 1e3, 4), 'mm', !d.rollsSettled],
          ] as [string, string, string, boolean][])
        : []),
      ['板の長さ', num(g.sheetLength, 1e3, 1), 'mm', false],
      ['定常の読み', String(st?.looks ?? 0), '回', false],
      ['最大損傷', d.maxDamage.toFixed(3), '', false],
      ['亀裂になった点', String(d.nFailed), '個', false],
      ['最初の亀裂', c0 ? (c0.t * 1e3).toFixed(2) : '—', 'ms', false],
      ['粒子数（1/4 モデル）', g.n.toLocaleString(), '個', false],
      ['時間刻み', (g.dt * 1e9).toFixed(1), 'ns', false],
      ['1 ステップの計算時間', f.msPerStep ? f.msPerStep.toFixed(2) : '—', 'ms', false],
    ];
    this.$('solid-results').replaceChildren(
      ...rows.map(([k, v, u, provisional]) => {
        const tr = el('tr');
        if (provisional) tr.className = 'provisional';
        const th = el('th', undefined, k);
        th.setAttribute('scope', 'row');
        tr.append(th, el('td', undefined, v), el('td', 'unit', u));
        return tr;
      }),
    );
    this.$('solid-results-note').textContent =
      NOTE + (steady ? '' : none ? `定常の読みが無かった。板の長さ（${+(this.settings.length / mm).toFixed(1)} mm）を延ばす。` : 'まだ定常の読みが無いので、薄い字は直前の読み。');
    this.showClock();
    const where = g.stands > 1 ? `#${d.stand + 1} / ${g.stands}　` : '';
    say(this.$('solid-phase'), d.stopped ? stopPhrase(d.stopped, this.standResults.length) : d.finished && g.stands > 1 ? `${g.stands} スタンドの圧延が終わった` : where + phaseText[d.phase]);
    this.standTable.update(g.stands, this.standResults, d.stand, d.finished, { h0: g.h0, width: W0 }, d.stopped);
    this.summarize(steady ? st : null);
  }

  private summarize(st: SolidFrame['diag']['steady']): void {
    const moment = this.finished ? 'done' : st ? 'steady' : '';
    if (!moment || moment === this.summaryMoment) return;
    this.summaryMoment = moment;
    const when = moment === 'done' ? '（パスの終わり）' : '（定常の読みが出たとき）';
    const g = this.geometry!;
    if (!st) {
      for (const p of this.summaries) p.textContent = `${when}定常の読みは無い`;
      return;
    }
    const inside = st.forceByZ.filter((q) => q > 0);
    let peak = 0;
    for (const p of st.pressureMap) if (p > peak) peak = p;
    const perWidth = st.force / (2 * st.halfWidth);
    this.summaries[0].textContent = `${when}定常の圧延荷重 ${(st.force * 1e-3).toFixed(2)} kN（全幅）、板幅あたり ${(perWidth * 1e-6).toFixed(2)} kN/mm。スラブ法（平面ひずみ）${(g.slabForce * 1e-6).toFixed(2)} kN/mm、比 ${(perWidth / g.slabForce).toFixed(2)}`;
    this.summaries[1].textContent = `${when}板幅方向の荷重は中央 ${(inside[0] * 1e-6).toFixed(2)} kN/mm から端の手前 ${((inside[inside.length - 2] ?? inside[0]) * 1e-6).toFixed(2)} kN/mm へ。幅広がり ${(st.spread * 100).toFixed(2)} %`;
    this.summaries[2].textContent = `${when}接触圧力の最大 ${(peak * 1e-6).toFixed(0)} MPa`;
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  private drawLegend(): void {
    const info = solidFieldInfo(this.field);
    const [lo, hi] = this.view.range;
    const stops: string[] = [];
    for (let k = 0; k <= 10; k++) stops.push(css(info.scale === 'diverging' ? split(k / 10) : temper(k / 10)));
    const unit = info.unit ? ` ${info.unit}` : '';
    const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
    const lg = this.$('solid-legend');
    lg.dataset.field = this.field;
    const failed = (this.last?.diag.nFailed ?? 0) > 0;
    const roles = new Set((this.last?.tracks ?? []).map((t) => t.role));
    const ys = this.view.yScale;
    const html = `
      <div class="bar" style="background:linear-gradient(90deg,${stops.join(',')})"></div>
      <div class="ends"><span>${fmt(lo)}${unit}</span><span>${info.label}</span><span>${fmt(hi)}${unit}</span></div>
      <div class="exag">板の表面の色。解くのは 1/4 で、板厚と板幅の中央（点線）で鏡映して表示${ys !== 1 ? `。板厚方向を ${ys} 倍に拡大（ロールの円弧も）` : ''}${this.settings.planeStrain ? '。板幅方向を止めた計算（平面ひずみ）' : ''}</div>
      ${failed ? '<div class="failed-key"><span class="swatch"></span>藍墨の面は亀裂になった点</div>' : ''}
      ${roles.has('first-crack') ? '<div class="failed-key"><span class="ring crack"></span>赤の点線の丸は最初の亀裂</div>' : ''}
      ${roles.has('max-damage') ? '<div class="failed-key"><span class="ring worst"></span>茶の点線の丸は損傷がいちばん大きい点</div>' : ''}`;
    if (lg.innerHTML !== html) lg.innerHTML = html;
  }

  private drawCharts(): void {
    const g = this.geometry;
    if (!g) return;
    const f = this.last;
    this.explorer.draw();
    const W0 = 2 * g.halfWidth0;
    // roll force over time, with the plane-strain slab method × the entry width for scale
    const t = (f?.history.t ?? []).map((v) => v * 1e3);
    const F = (f?.history.force ?? []).map((v) => v * 1e-3);
    const slabTotal = g.slabForce * W0 * 1e-3;
    drawChart(this.$<HTMLCanvasElement>('solid-chart-force'), {
      xLabel: '時間 [ms]',
      yLabel: '荷重 [kN]',
      series: [{ x: t, y: F, color: INK, label: '3 次元 MPM' }],
      hmarks: [{ y: slabTotal, label: g.stands > 1 ? `スラブ法 × 入側の板幅（#${g.stand + 1}）` : 'スラブ法 × 入側の板幅' }],
      // where a tandem's next stand starts
      marks: (f?.history.stand ?? []).flatMap((k, i, a) => (i > 0 && k !== a[i - 1] ? [{ x: t[i - 1], label: `#${k + 1}`, color: standColor(k) }] : [])),
      yRange: [0, Math.max(slabTotal * 1.35, ...F) || 1],
    });
    this.drawWidthCharts();
  }

  /** the steady means the width graphs show: the running stand's, or until it has any the last stand's that had */
  private shownSteady(): { st: SolidSteady; g: SolidGeometry } | null {
    const now = this.last?.diag.steady;
    if (now && now.looks > 0 && this.geometry) return { st: now, g: this.geometry };
    for (let k = this.standResults.length - 1; k >= 0; k--) {
      const st = this.standResults[k]?.steady;
      if (st && this.geometries[k]) return { st, g: this.geometries[k] };
    }
    return null;
  }

  private drawWidthCharts(): void {
    const shown = this.shownSteady();
    const st = shown?.st ?? null;
    const g = shown?.g ?? this.geometry!;
    const tag = g.stands > 1 && st ? `#${g.stand + 1}` : '';
    // the load across the width (steady mean), mirrored to the whole width
    const z: number[] = [];
    const q: number[] = [];
    if (st) {
      const n = st.forceByZ.length;
      for (let k = n - 1; k >= 0; k--) {
        z.push((-k * g.h) / mm);
        q.push(st.forceByZ[k] * 1e-6);
      }
      for (let k = 1; k < n; k++) {
        z.push((k * g.h) / mm);
        q.push(st.forceByZ[k] * 1e-6);
      }
    }
    const halfOut = st ? st.halfWidth / mm : g.halfWidth0 / mm;
    drawChart(this.$<HTMLCanvasElement>('solid-chart-width'), {
      xLabel: '板幅方向の位置 z [mm]',
      yLabel: '荷重 [kN/mm]',
      series: [{ x: z, y: q, color: INK, label: tag ? `定常の平均（${tag}）` : '定常の平均' }],
      hmarks: [{ y: g.slabForce * 1e-6, label: 'スラブ法（平面ひずみ）' }],
      marks: st
        ? [
            { x: -halfOut, label: '端', color: STEEL },
            { x: halfOut, label: '端', color: STEEL },
          ]
        : [],
      xRange: [-(g.halfWidth0 / mm) * 1.25, (g.halfWidth0 / mm) * 1.25],
      yRange: [0, Math.max(g.slabForce * 1e-6 * 1.5, ...q) || 1],
    });
    if (!st) this.emptyNote(this.$<HTMLCanvasElement>('solid-chart-width'));
    this.drawPressureMap(st, g, tag);
  }

  /** a graph of steady means, before there are any: say when it comes (or that it did not) */
  private emptyNote(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    const r = canvas.getBoundingClientRect();
    ctx.save();
    ctx.font = uiFont(11);
    ctx.fillStyle = STEEL;
    ctx.textAlign = 'center';
    ctx.fillText(this.finished ? '定常の読みが無かった（板の長さを延ばす）' : '定常になると出る', r.width / 2 + 20, r.height / 2 + 14);
    ctx.restore();
  }

  /** the contact pressure over the bite, seen from above: x along the rolling direction, z across the width */
  private drawPressureMap(st: SolidSteady | null, g: SolidGeometry, tag: string): void {
    const canvas = this.$<HTMLCanvasElement>('solid-chart-map');
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width));
    const H = Math.max(1, Math.round(r.height));
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = uiFont(11);
    ctx.fillStyle = STEEL;
    const cap = this.$('solid-map-range');
    if (!st) {
      ctx.textAlign = 'center';
      ctx.fillText(this.finished ? '定常の読みが無かった' : '定常になると出る', W / 2, H / 2);
      cap.textContent = '';
      return;
    }
    const L = 40;
    const Rm = 10;
    const Tm = 8;
    const B = 30;
    const x0 = -g.contactLength * 1.3;
    const x1 = g.contactLength * 0.3;
    const zMax = Math.max(st.halfWidth, g.halfWidth0) * 1.12;
    // one scale for both axes (the bite's true shape), unless the strip is so wide that the bite would be a sliver:
    // then the rolling direction is stretched to a third of the plot, and the caption says so
    const sz = Math.min((W - L - Rm) / (x1 - x0), (H - Tm - B) / (2 * zMax));
    const stretched = (x1 - x0) * sz < 0.33 * (W - L - Rm);
    const sx = stretched ? (0.33 * (W - L - Rm)) / (x1 - x0) : sz;
    const cx = L + (W - L - Rm) / 2;
    const cy = Tm + (H - Tm - B) / 2;
    const X = (x: number) => cx + (x - (x0 + x1) / 2) * sx;
    const Z = (z: number) => cy - z * sz;
    let max = 0;
    for (const p of st.pressureMap) if (p > max) max = p;
    const h = g.h;
    for (let b = 0; b < st.mapCols; b++) {
      const xa = g.mapX0 + (b - 0.5) * h;
      if (xa + h < x0 || xa > x1) continue;
      for (let k = 0; k < st.mapRows; k++) {
        const p = st.pressureMap[b * st.mapRows + k];
        if (!(p > 0.02 * max)) continue;
        ctx.fillStyle = css(temper(p / max));
        const za = k === 0 ? 0 : (k - 0.5) * h;
        const zb = (k + 0.5) * h;
        // both halves of the width
        ctx.fillRect(X(xa), Z(zb), h * sx + 0.6, (zb - za) * sz + 0.6);
        ctx.fillRect(X(xa), Z(-za), h * sx + 0.6, (zb - za) * sz + 0.6);
      }
    }
    // entry and exit lines, the strip's edges coming in
    ctx.strokeStyle = 'rgba(29,42,58,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const x of [-g.contactLength, 0]) {
      ctx.beginPath();
      ctx.moveTo(X(x), Tm);
      ctx.lineTo(X(x), H - B);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.fillText('入口', X(-g.contactLength), H - B + 13);
    ctx.fillText('出口', X(0), H - B + 13);
    ctx.fillStyle = STEEL;
    ctx.fillText('圧延方向 x →', cx, H - 4);
    ctx.save();
    ctx.translate(11, cy);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('板幅方向 z', 0, 0);
    ctx.restore();
    ctx.textAlign = 'right';
    ctx.fillText(`${(st.halfWidth / mm).toFixed(1)}`, L - 4, Z(st.halfWidth) + 4);
    ctx.fillText('0', L - 4, Z(0) + 4);
    ctx.fillText(`−${(st.halfWidth / mm).toFixed(1)}`, L - 4, Z(-st.halfWidth) + 4);
    cap.textContent = `${tag ? `${tag}　` : ''}0 〜 ${(max * 1e-6).toFixed(0)} MPa${stretched ? `（圧延方向を ${(sx / sz).toFixed(0)} 倍に拡大）` : ''}`;
    canvas.title = stretched ? '定常の平均' : '定常の平均。縦と横は同じ縮尺';
  }

  private drawLoop(): void {
    try {
      if (this.active) {
        if (this.dirty) {
          this.dirty = false;
          this.view.draw();
          this.drawLegend();
        }
        if (this.chartsDirty) {
          this.chartsDirty = false;
          this.drawCharts();
        }
      }
    } finally {
      requestAnimationFrame(() => this.drawLoop());
    }
  }

  drawMs(n = 20): number {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.view.draw();
    return (performance.now() - t0) / n;
  }

  /** what the headless checks read (window.__mpm.solid) */
  hook() {
    const self = this;
    return {
      get active() {
        return self.active;
      },
      get ready() {
        return self.geometry !== null && !self.awaitingReady;
      },
      get running() {
        return self.running;
      },
      get frames() {
        return self.frames;
      },
      get eta() {
        return self.eta.seconds;
      },
      get done() {
        return self.finished || (self.stopAfter !== null && (self.last?.diag.step ?? 0) >= self.stopAfter && !self.running);
      },
      get diag() {
        return self.last?.diag ?? null;
      },
      get geometry() {
        return self.geometry;
      },
      get settings() {
        return { ...self.settings };
      },
      get params() {
        return self.params ? cloneParams(self.params) : null;
      },
      get field() {
        return self.field;
      },
      get range() {
        return [...self.view.range];
      },
      get stand() {
        return self.last?.diag.stand ?? 0;
      },
      get stands() {
        return self.geometry?.stands ?? 1;
      },
      get standResults() {
        return self.standResults.slice();
      },
      get stopped() {
        return self.last?.diag.stopped ?? null;
      },
      get tracks() {
        return self.last?.tracks ?? [];
      },
      get explorer() {
        return self.explorer.shown;
      },
      screenOf: (role: 'first-crack' | 'max-damage') => self.view.screenOf(role),
      get url() {
        return self.query().toString();
      },
      get view() {
        const v = self.view;
        return { yaw: v.yaw, pitch: v.pitch, zoom: v.zoom, cut: v.cut, rolls: v.rolls, fit: v.fit, yScale: v.yScale, pan: [v.panX, v.panY], pivot: v.pivot };
      },
      screenOfPoint: (x: number, y: number, z: number) => self.view.screenOfPoint(x, y, z),
      setDim: (d: Dim) => self.setDim(d),
      setField: (id: SolidFieldName) => self.setField(id),
      run: () => self.run(),
      drawMs: (n?: number) => self.drawMs(n),
    };
  }
}

const NOTE =
  '荷重はロール 1 本あたり・板の全幅。定常の値は、頭端が出口の先に届いてから尾端が入口に来るまでの平均（500 ステップごと、tools/solid.mjs と同じ読み方）。板幅あたりの荷重は出側の板幅で割った値で、幅広がりのぶん平面ひずみより小さい。';
