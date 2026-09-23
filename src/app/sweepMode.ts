// The 「条件の比較」 tab: the 3D model's tandem rolled for a row of conditions whose entry thickness, width, roll
// diameter and friction go linearly from a first to a last value (src/mpm/solid/sweep.ts), several at once (one
// worker each, src/app/sweep.worker.ts), and what each came to after its last pass drawn side by side: the crown,
// each pass's force, the spread, the exit profiles one over another, the flatness and each pass's width, and a
// table with every number. The other conditions are the panel's (the shared ones and 「板と格子（3 次元）」).
import type { SimParams } from '../mpm/params.ts';
import type { Solid3Params } from '../mpm/solid/sim3.ts';
import { MAX_CASES, SWEEP_KEYS, baseValues, summarize, sweepCase, sweepValues, type SweepCaseResult, type SweepKey, type SweepSpec, type SweepSummary, type SweepValues } from '../mpm/solid/sweep.ts';
import { MAX_STANDS, type Handoff } from '../mpm/tandem.ts';
import { drawChart, type Series } from './charts.ts';
import { css, temper } from './colormap.ts';
import { etaText } from './eta.ts';
import { standColor } from './explorer.ts';
import { download } from './export.ts';
import { checkRange } from './fieldCheck.ts';
import { uiFont } from './font.ts';
import { say } from './liveText.ts';
import type { FromSweepWorker, ToSweepWorker } from './sweep.worker.ts';

const INK = '#1d2a3a';
const STEEL = '#8a949c';
const mm = 1e-3;
const CORES = Math.max(1, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4);
/** conditions rolled at once by default: the cores less one (the page), at most 8 */
const DEFAULT_JOBS = Math.max(1, Math.min(8, CORES - 1));

/** the URL's short names of the varied quantities (sv=h0:0.8:1.2,W:4:8) */
const SHORT: Record<SweepKey, string> = { h0: 'h0', width: 'W', rollDiameter: 'D', mu: 'mu' };
const HANDOFFS: [Handoff, string][] = [
  ['steady', '定常になったらすぐ（速い）'],
  ['crop', '中央部を切り出す（次の定常に要る長さ）'],
  ['done', '板が抜けてから（遅い）'],
];
/** what the spec starts as: the thickness from 0.8 to 1.2 mm, ten conditions, four passes */
const DEFAULT_VARY: Partial<Record<SweepKey, [number, number]>> = { h0: [0.8 * mm, 1.2 * mm] };

export interface SweepModeOptions {
  query: URLSearchParams;
  panelRoot: HTMLElement;
  /** the shared conditions (the panel's, as last applied) */
  conditions(): SimParams;
  /** the 3D model's params from the shared conditions and 「板と格子（3 次元）」, and those settings' URL keys */
  solidBase(conditions: SimParams): Solid3Params;
  solidQuery(conditions: SimParams): URLSearchParams;
  onEdit(): void;
}

type CaseState = 'waiting' | 'running' | 'done' | 'stopped' | 'error';
interface Case {
  values: SweepValues;
  P: Solid3Params | null;
  state: CaseState;
  /** 0..1 of the whole tandem, and the pass it is on */
  progress: number;
  stand: number;
  result: SweepCaseResult | null;
  summary: SweepSummary | null;
  seconds: number;
  message: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const fmt = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const legendItem = (color: string, text: string, kind = ''): string =>
  `<span class="item"><span class="swatch${kind ? ` ${kind}` : ''}" style="--c:${color}"></span>${text}</span>`;
function setLegend(e: HTMLElement, items: string[]): void {
  const html = items.join('');
  if (e.innerHTML !== html) e.innerHTML = html;
}
const duration = (s: number) => (s < 60 ? `${Math.round(s)} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒` : `${Math.floor(s / 3600)} 時間 ${Math.round((s % 3600) / 60)} 分`);

export class SweepMode {
  active = false;
  running = false;
  private spec: SweepSpec;
  private jobs = DEFAULT_JOBS;
  private cases: Case[] = [];
  private workers: { w: Worker; index: number | null }[] = [];
  /** the spec and base the cases were made from (the URL's), and the shared conditions then */
  private made: { spec: SweepSpec; base: Solid3Params; conditions: SimParams } | null = null;
  private elapsed = 0;
  private since = 0;
  private dirty = true;
  private readonly vary = new Map<SweepKey, { box: HTMLInputElement; from: HTMLInputElement; to: HTMLInputElement; row: HTMLElement; base: HTMLElement }>();
  private countInput!: HTMLInputElement;
  private standsInput!: HTMLInputElement;
  private handoffSelect!: HTMLSelectElement;
  private jobsInput!: HTMLInputElement;
  private readonly checks: (() => void)[] = [];
  private readonly legends: Record<'force' | 'profile' | 'width', HTMLElement>;

  private readonly o: SweepModeOptions;

  constructor(o: SweepModeOptions) {
    this.o = o;
    this.spec = this.fromQuery(o.query);
    this.buildPanel();
    this.buildStage();
    this.legends = {
      force: this.legendUnder('sweep-chart-force'),
      profile: this.legendUnder('sweep-chart-profile'),
      width: this.legendUnder('sweep-chart-width'),
    };
    this.showSpec(this.spec);
    const ro = new ResizeObserver(() => (this.dirty = true));
    ro.observe(this.$('sweep-stage'));
    const loop = () => {
      if (this.active && this.dirty) {
        this.dirty = false;
        this.draw();
      }
      if (this.active && this.running) this.showClock();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private $<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }

  // ── the spec: the panel's fieldset and the URL ─────────────────────────────
  private fromQuery(q: URLSearchParams): SweepSpec {
    const vary: Partial<Record<SweepKey, [number, number]>> = {};
    const sv = q.get('sv');
    if (sv) {
      for (const part of sv.split(',')) {
        const [name, a, b] = part.split(':');
        const k = SWEEP_KEYS.find((f) => SHORT[f.key] === name);
        const v0 = parseFloat(a);
        const v1 = parseFloat(b);
        if (!k || !Number.isFinite(v0) || !Number.isFinite(v1)) continue;
        if (v0 < k.min || v0 > k.max || v1 < k.min || v1 > k.max) continue;
        vary[k.key] = [v0 / k.scale, v1 / k.scale];
      }
    }
    const int = (key: string, lo: number, hi: number, d: number) => {
      const v = parseInt(q.get(key) ?? '', 10);
      return Number.isInteger(v) && v >= lo && v <= hi ? v : d;
    };
    const h = q.get('sh');
    this.jobs = int('sj', 1, CORES, DEFAULT_JOBS);
    return {
      vary: sv ? vary : { ...DEFAULT_VARY },
      count: int('sn', 2, MAX_CASES, 10),
      stands: int('sp', 1, MAX_STANDS, 4),
      handoff: h === 'crop' || h === 'done' ? h : 'steady',
    };
  }

  private buildPanel(): void {
    const fs = el('fieldset', 'group sweep-only');
    fs.append(el('legend', undefined, '条件の振り方（比較）'));
    fs.append(el('p', 'hint', '選んだ量を、最初の条件から最後の条件まで等間隔に変える（いくつ選んでも同時に）。選ばない量は下の欄の値のまま'));
    for (const f of SWEEP_KEYS) {
      const row = el('div', 'field sweep-vary');
      const lab = el('label', 'check');
      const box = el('input');
      box.type = 'checkbox';
      box.name = `sweep-${f.key}`;
      lab.append(box, el('span', undefined, f.label));
      const inputs = el('span', 'field-input sweep-range');
      const mk = (end: string) => {
        const i = el('input');
        i.type = 'number';
        i.name = `sweep-${f.key}-${end}`;
        i.min = String(f.min);
        i.max = String(f.max);
        i.step = String(f.step);
        i.setAttribute('aria-label', `${f.label}の${end === 'from' ? '最初' : '最後'}の値${f.unit ? `（${f.unit}）` : ''}`);
        i.addEventListener('input', () => this.o.onEdit());
        return i;
      };
      const from = mk('from');
      const to = mk('to');
      inputs.append(from, el('span', 'sweep-arrow', '→'), to);
      if (f.unit) inputs.append(el('span', 'unit', f.unit));
      const base = el('span', 'hint sweep-base');
      row.append(lab, inputs, base);
      box.addEventListener('change', () => {
        this.lockVary();
        this.o.onEdit();
      });
      this.checks.push(checkRange(from, row, () => [f.min, f.max], f.unit), checkRange(to, row, () => [f.min, f.max], f.unit));
      fs.append(row);
      this.vary.set(f.key, { box, from, to, row, base });
    }
    const number = (name: string, label: string, lo: number, hi: number, unit: string, hint: string) => {
      const row = el('label', 'field');
      row.append(el('span', 'field-label', label));
      const box = el('span', 'field-input');
      const i = el('input');
      i.type = 'number';
      i.name = name;
      i.min = String(lo);
      i.max = String(hi);
      i.step = '1';
      i.addEventListener('input', () => this.o.onEdit());
      box.append(i);
      if (unit) box.append(el('span', 'unit', unit));
      row.append(box);
      if (hint) row.append(el('span', 'hint', hint));
      this.checks.push(checkRange(i, row, () => [lo, hi], unit));
      fs.append(row);
      return i;
    };
    this.countInput = number('sweep-count', '条件の数', 2, MAX_CASES, '', `2〜${MAX_CASES}。最初と最後の値を含む`);
    this.standsInput = number('sweep-stands', 'パス数', 1, MAX_STANDS, '', 'タンデムのスタンド数。どのスタンドも同じ圧下率（自分の入側板厚に対して）');
    const hRow = el('label', 'field');
    hRow.append(el('span', 'field-label', 'スタンドの引き継ぎ'));
    const hBox = el('span', 'field-input');
    this.handoffSelect = el('select');
    this.handoffSelect.name = 'sweep-handoff';
    for (const [v, t] of HANDOFFS) {
      const opt = el('option', undefined, t);
      opt.value = v;
      this.handoffSelect.append(opt);
    }
    this.handoffSelect.addEventListener('change', () => this.o.onEdit());
    hBox.append(this.handoffSelect);
    hRow.append(hBox);
    fs.append(hRow);
    this.jobsInput = number('sweep-jobs', '同時に回す数', 1, CORES, `/ ${CORES}`, `条件をいくつ並べて回すか（1 つに 1 スレッド）。この機械は ${CORES} コア`);
    fs.append(el('p', 'hint', '板の長さは条件ごとに「定常状態になるまで」。板幅（振らないとき）・セル数・入側の板クラウン・ロールの撓みは「板と格子（3 次元）」「ロールの撓み（3 次元）」の欄、材料・圧下率・張力・ロール偏平は共通の欄。計算は CPU（GPU・コア数の欄は使わない）。4 セル・板幅 4 mm・4 パスの 10 条件は 5 つ同時で約 50 分（M2）'));
    const note = this.o.panelRoot.querySelector('.note-more') ?? this.o.panelRoot.querySelector('.preset-note');
    if (note) note.after(fs);
    else this.o.panelRoot.prepend(fs);
    // the shared panel's stands and handoff are the section's and the 3D tab's; the sweep has its own
    for (const name of ['stands', 'handoff']) this.o.panelRoot.querySelector(`[name="${name}"]`)?.closest('label')?.classList.add('sweep-hide');
  }

  private showSpec(s: SweepSpec): void {
    const b = baseValues(this.o.solidBase(this.o.conditions()));
    for (const f of SWEEP_KEYS) {
      const v = this.vary.get(f.key)!;
      const r = s.vary[f.key];
      v.box.checked = !!r;
      v.from.value = String(+((r ? r[0] : b[f.key]) * f.scale).toPrecision(6));
      v.to.value = String(+((r ? r[1] : b[f.key]) * f.scale).toPrecision(6));
    }
    this.countInput.value = String(s.count);
    this.standsInput.value = String(s.stands);
    this.handoffSelect.value = s.handoff;
    this.jobsInput.value = String(this.jobs);
    this.lockVary();
  }

  /** a quantity not varied: its inputs are off, and the value it keeps is said */
  private lockVary(): void {
    const b = baseValues(this.o.solidBase(this.o.conditions()));
    for (const f of SWEEP_KEYS) {
      const v = this.vary.get(f.key)!;
      v.from.disabled = v.to.disabled = !v.box.checked;
      v.row.classList.toggle('off', !v.box.checked);
      v.base.textContent = v.box.checked ? '' : `振らない: ${+(b[f.key] * f.scale).toPrecision(4)}${f.unit ? ` ${f.unit}` : ''}（下の欄の値）`;
    }
    for (const c of this.checks) c();
  }

  private readSpec(): SweepSpec {
    const vary: Partial<Record<SweepKey, [number, number]>> = {};
    for (const f of SWEEP_KEYS) {
      const v = this.vary.get(f.key)!;
      if (!v.box.checked) continue;
      const clamp = (x: number) => Math.min(f.max, Math.max(f.min, x));
      const a = parseFloat(v.from.value);
      const b = parseFloat(v.to.value);
      if (Number.isFinite(a) && Number.isFinite(b)) vary[f.key] = [clamp(a) / f.scale, clamp(b) / f.scale];
    }
    const int = (i: HTMLInputElement, lo: number, hi: number, d: number) => {
      const v = parseInt(i.value, 10);
      return Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d;
    };
    this.jobs = int(this.jobsInput, 1, CORES, DEFAULT_JOBS);
    const h = this.handoffSelect.value;
    return {
      vary,
      count: int(this.countInput, 2, MAX_CASES, 10),
      stands: int(this.standsInput, 1, MAX_STANDS, 4),
      handoff: h === 'crop' || h === 'done' ? h : 'steady',
    };
  }

  /** the conditions URL: the 3D settings, the tab and the spec */
  query(): URLSearchParams {
    const c = this.made?.conditions ?? this.o.conditions();
    const q = this.o.solidQuery(c);
    q.delete('f3');
    q.set('dim', 'c');
    const s = this.made?.spec ?? this.spec;
    const parts = SWEEP_KEYS.filter((f) => s.vary[f.key]).map((f) => `${SHORT[f.key]}:${+(s.vary[f.key]![0] * f.scale).toPrecision(6)}:${+(s.vary[f.key]![1] * f.scale).toPrecision(6)}`);
    q.set('sv', parts.join(','));
    q.set('sn', String(s.count));
    q.set('sp', String(s.stands));
    if (s.handoff !== 'steady') q.set('sh', s.handoff);
    if (this.jobs !== DEFAULT_JOBS) q.set('sj', String(this.jobs));
    return q;
  }

  // ── the stage ──────────────────────────────────────────────────────────────
  private buildStage(): void {
    const stage = this.$('sweep-stage');
    const head = el('div', 'sweep-head');
    const title = el('h2', undefined, '条件の比較');
    title.id = 'sweep-title';
    const phase = el('p', 'phase');
    phase.id = 'sweep-phase';
    phase.setAttribute('aria-live', 'polite');
    const bar = el('div', 'sweep-bar');
    bar.id = 'sweep-bar';
    head.append(title, phase, bar);
    const charts = el('div', 'charts sweep-charts');
    for (const [id, cap] of [
      ['sweep-chart-crown', '板クラウン（最後のパスの出側、定常）'],
      ['sweep-chart-force', '圧延荷重（パスごと、全幅、定常）'],
      ['sweep-chart-spread', '幅広がり（全パスで W / W0 − 1）'],
      ['sweep-chart-profile', '出側の板厚の分布（最後のパス。板厚 − 端の板厚、3 列で均す）'],
      ['sweep-chart-flat', '平坦度（最後のパスの出側、中央 − 端）'],
      ['sweep-chart-width', '出側の板幅（パスごと）'],
    ] as const) {
      const fig = el('figure');
      const c = el('canvas');
      c.id = id;
      fig.append(el('figcaption', undefined, cap), c);
      charts.append(fig);
    }
    const wrap = el('div', 'sweep-table-wrap');
    const table = el('table', 'sweep-table');
    table.id = 'sweep-table';
    wrap.append(table);
    stage.append(head, charts, wrap);
    // the record column: the export
    const rec = this.$('sweep-export');
    const status = el('p', 'export-status');
    status.setAttribute('aria-live', 'polite');
    const csv = el('button', undefined, 'CSV に保存');
    csv.type = 'button';
    csv.id = 'sweep-csv';
    csv.addEventListener('click', () => {
      const text = this.csv();
      download(`sweep-${this.cases.length}.csv`, new Blob([text], { type: 'text/csv' }));
      status.textContent = `${this.cases.filter((c) => c.summary).length} 条件の結果を CSV にした`;
    });
    const url = el('input');
    url.type = 'text';
    url.readOnly = true;
    url.hidden = true;
    url.setAttribute('aria-label', '今の条件で比較のタブが始まる URL');
    const copy = el('button', undefined, '条件の URL をコピー');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const u = new URL(location.href);
      u.search = this.query().toString();
      url.value = u.href;
      url.hidden = false;
      try {
        await navigator.clipboard.writeText(u.href);
        status.textContent = '条件の URL をコピーした。開くと同じ振り方の比較のタブで始まる';
      } catch {
        status.textContent = 'クリップボードに書けなかった。下の欄の URL を選んでコピーする';
      }
    });
    const row = el('div', 'export-url');
    row.append(csv, copy, url);
    rec.append(el('h2', undefined, '結果の書き出し'), row, status);
  }

  private legendUnder(id: string): HTMLElement {
    const d = el('div', 'chart-legend');
    this.$(id).after(d);
    return d;
  }

  // ── running ────────────────────────────────────────────────────────────────
  setActive(on: boolean): void {
    this.active = on;
    if (!on && this.running) this.pause();
    if (on) {
      this.lockVary();
      this.dirty = true;
      this.showClock();
      this.updateButtons();
      // ?autorun=1 with dim=c: the row starts as the tab is first shown
      if (!this.autoran && this.o.query.get('autorun') === '1') {
        this.autoran = true;
        this.run();
      }
    }
  }
  private autoran = false;

  get finished(): boolean {
    return this.cases.length > 0 && this.cases.every((c) => c.state === 'done' || c.state === 'stopped' || c.state === 'error');
  }

  /** the panel's conditions and spec are taken up at the next run (the 「条件を反映してやり直す」 button) */
  applyConditions(): void {
    this.stopWorkers();
    this.spec = this.readSpec();
    this.cases = [];
    this.made = null;
    this.elapsed = 0;
    this.running = false;
    this.dirty = true;
    if (this.active) {
      this.showClock();
      this.updateButtons();
    }
    this.lockVary();
  }

  private make(): void {
    const conditions = this.o.conditions();
    const base = this.o.solidBase(conditions);
    const spec = this.spec;
    this.made = { spec, base, conditions };
    this.cases = sweepValues(base, spec).map((values) => ({ values, P: null, state: 'waiting', progress: 0, stand: 0, result: null, summary: null, seconds: 0, message: '' }));
  }

  run(): void {
    if (this.running || this.finished) return;
    if (!this.cases.length) this.make();
    this.running = true;
    this.since = performance.now();
    while (this.workers.length < Math.min(this.jobs, this.cases.length)) this.workers.push(this.startWorker());
    for (const w of this.workers) {
      if (w.index !== null) this.post(w.w, { type: 'resume' });
      else this.give(w);
    }
    this.dirty = true;
    this.updateButtons();
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.elapsed += (performance.now() - this.since) / 1e3;
    for (const w of this.workers) if (w.index !== null) this.post(w.w, { type: 'pause' });
    this.dirty = true;
    this.showClock();
    this.updateButtons();
  }

  private post(w: Worker, m: ToSweepWorker): void {
    w.postMessage(m);
  }

  private startWorker(): { w: Worker; index: number | null } {
    const w = new Worker(new URL('./sweep.worker.ts', import.meta.url), { type: 'module' });
    const slot = { w, index: null as number | null };
    w.onmessage = (e: MessageEvent<FromSweepWorker>) => this.onMessage(slot, e.data);
    w.onerror = (e) => {
      if (slot.index === null) return;
      const c = this.cases[slot.index];
      c.state = 'error';
      c.message = e.message;
      slot.index = null;
      this.give(slot);
    };
    return slot;
  }

  /** the next waiting condition to an idle worker */
  private give(slot: { w: Worker; index: number | null }): void {
    if (!this.running || !this.made) return;
    const i = this.cases.findIndex((c) => c.state === 'waiting');
    if (i < 0) {
      if (this.finished) this.finish();
      return;
    }
    const c = this.cases[i];
    c.state = 'running';
    c.P = sweepCase(this.made.base, c.values);
    slot.index = i;
    this.post(slot.w, { type: 'run', index: i, P: c.P, values: c.values, stands: this.made.spec.stands, handoff: this.made.spec.handoff });
    this.dirty = true;
  }

  private onMessage(slot: { w: Worker; index: number | null }, m: FromSweepWorker): void {
    const c = this.cases[m.index];
    if (!c || slot.index !== m.index) return;
    if (m.type === 'progress') {
      c.progress = m.progress;
      c.stand = m.stand;
    } else {
      if (m.type === 'done') {
        c.result = m.result;
        c.summary = summarize(m.result);
        c.seconds = m.seconds;
        c.progress = 1;
        c.stand = m.result.stands.length - 1;
        c.state = m.result.stopped ? 'stopped' : 'done';
        c.message = m.result.stopped ?? '';
      } else {
        c.state = 'error';
        c.message = m.message;
      }
      slot.index = null;
      this.give(slot);
    }
    this.dirty = true;
  }

  private finish(): void {
    if (this.running) this.elapsed += (performance.now() - this.since) / 1e3;
    this.running = false;
    this.stopWorkers();
    this.showClock();
    this.updateButtons();
  }

  private stopWorkers(): void {
    for (const w of this.workers) w.w.terminate();
    this.workers = [];
  }

  // ── the masthead ───────────────────────────────────────────────────────────
  updateButtons(): void {
    if (!this.active) return;
    const run = this.$<HTMLButtonElement>('run');
    run.disabled = this.running || this.finished;
    this.$<HTMLButtonElement>('pause').disabled = !this.running;
    run.textContent = this.cases.some((c) => c.state !== 'waiting') && !this.finished ? '続ける' : '比較を始める';
  }

  private seconds(): number {
    return this.elapsed + (this.running ? (performance.now() - this.since) / 1e3 : 0);
  }

  /** the whole row's fraction done (each condition counted alike) */
  private fraction(): number {
    return this.cases.length ? this.cases.reduce((a, c) => a + (c.state === 'waiting' ? 0 : c.state === 'running' ? c.progress : 1), 0) / this.cases.length : 0;
  }

  get eta(): number | null {
    const f = this.fraction();
    const t = this.seconds();
    return this.running && f > 0.02 && t > 5 ? (t * (1 - f)) / f : null;
  }

  showClock(): void {
    if (!this.active) return;
    const n = this.cases.length;
    const done = this.cases.filter((c) => c.state === 'done' || c.state === 'stopped' || c.state === 'error').length;
    const now = this.cases.filter((c) => c.state === 'running').length;
    this.$('clock').textContent = n ? `条件 ${done} / ${n} 済み　${this.running ? `${now} つ計算中　` : ''}${duration(this.seconds())}` : '条件の比較';
    this.$('eta').textContent = etaText(this.eta, n > 0, this.finished);
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  /** the conditions' colours: the temper colours from bronze to blue, in the order of the conditions */
  private caseColor(i: number): string {
    const n = Math.max(1, this.cases.length - 1);
    return css(temper(0.42 + (0.58 * i) / n));
  }

  /** the x of the comparison: the one quantity varied (its values), or the conditions' numbers */
  private axis(): { label: string; x: (i: number) => number; ends: [number, number]; ticks?: number[] } {
    const spec = this.made?.spec ?? this.spec;
    const varied = SWEEP_KEYS.filter((f) => spec.vary[f.key]);
    if (varied.length === 1) {
      const f = varied[0];
      const r = spec.vary[f.key]!;
      return { label: `${f.label}${f.unit ? ` [${f.unit}]` : ''}`, x: (i) => this.cases[i].values[f.key] * f.scale, ends: [r[0] * f.scale, r[1] * f.scale] };
    }
    const n = Math.max(2, Math.min(MAX_CASES, spec.count));
    const every = Math.ceil(n / 10);
    return { label: '条件の番号', x: (i) => i + 1, ends: [1, n], ticks: Array.from({ length: n }, (_, i) => i + 1).filter((k) => (k - 1) % every === 0) };
  }

  private draw(): void {
    this.drawHead();
    this.drawTable();
    const ax = this.axis();
    const idx = this.cases.map((_, i) => i).filter((i) => this.cases[i].summary);
    // before the row is made: the spec's ends
    const xs = this.cases.length ? this.cases.map((_, i) => ax.x(i)) : ax.ends;
    const xLo = Math.min(...xs);
    const xHi = Math.max(...xs);
    const pad = (xHi - xLo) * 0.06 || 1;
    const xRange: [number, number] = [xLo - pad, xHi + pad];
    const stands = this.made?.spec.stands ?? this.spec.stands;
    const dotsOf = (y: (s: SweepSummary) => number, color?: (i: number) => string) =>
      idx.filter((i) => Number.isFinite(y(this.cases[i].summary!))).map((i) => ({ x: ax.x(i), y: y(this.cases[i].summary!), color: color ? color(i) : this.caseColor(i), r: 3.5 }));
    const line = (y: (s: SweepSummary) => number, color: string, label: string, width?: number): Series => ({
      x: idx.map((i) => ax.x(i)),
      y: idx.map((i) => y(this.cases[i].summary!)),
      color,
      label,
      ...(width ? { width } : {}),
    });
    const scalar = (id: string, yLabel: string, y: (s: SweepSummary) => number, zero = false) => {
      const ys = idx.map((i) => y(this.cases[i].summary!)).filter(Number.isFinite);
      const lo = Math.min(...ys, zero ? 0 : Infinity);
      const hi = Math.max(...ys, zero ? 0 : -Infinity);
      const p = Math.max((hi - lo) * 0.2, Math.abs(hi) * 0.05, 1e-6);
      drawChart(this.$<HTMLCanvasElement>(id), {
        xLabel: ax.label,
        yLabel,
        series: [line(y, INK, yLabel, 1.4)],
        dots: dotsOf(y),
        ...(zero ? { hmarks: [{ y: 0, label: '0' }] } : {}),
        xRange,
        ...(ax.ticks ? { xTicks: ax.ticks } : {}),
        ...(ys.length ? { yRange: [lo - p, hi + p] as [number, number] } : {}),
      });
      if (!ys.length) this.emptyNote(id);
    };
    scalar('sweep-chart-crown', '板クラウン [µm]', (s) => s.crownOut * 1e6, true);
    scalar('sweep-chart-spread', '幅広がり [%]', (s) => s.spread * 100);
    scalar('sweep-chart-flat', '平坦度 [I 単位]', (s) => s.flatness, true);
    // each pass: one line per pass in the stands' colours
    const perPass = (id: string, yLabel: string, y: (s: SweepSummary, k: number) => number, legend: HTMLElement) => {
      const series: Series[] = [];
      const dots: { x: number; y: number; color: string; r: number }[] = [];
      for (let k = 0; k < stands; k++) {
        series.push(line((s) => y(s, k), standColor(k), `#${k + 1}`));
        dots.push(...dotsOf((s) => y(s, k), () => standColor(k)).map((d) => ({ ...d, r: 2.5 })));
      }
      const ys = dots.map((d) => d.y);
      drawChart(this.$<HTMLCanvasElement>(id), {
        xLabel: ax.label,
        yLabel,
        series,
        dots,
        xRange,
        ...(ax.ticks ? { xTicks: ax.ticks } : {}),
        ...(ys.length ? { yRange: [0, Math.max(...ys) * 1.15] as [number, number] } : {}),
      });
      setLegend(legend, Array.from({ length: stands }, (_, k) => legendItem(standColor(k), `パス #${k + 1}`)));
      if (!ys.length) this.emptyNote(id);
    };
    perPass('sweep-chart-force', '荷重 [kN]', (s, k) => (s.force[k] ?? NaN) * 1e-3, this.legends.force);
    perPass('sweep-chart-width', '板幅 [mm]', (s, k) => (s.width[k] ?? NaN) / mm, this.legends.width);
    // the exit profiles, one per condition in its colour
    const prof = idx.map((i) => {
      const s = this.cases[i].summary!;
      return { x: s.profileZ.map((z) => z / mm), y: s.profile.map((v) => v * 1e6), color: this.caseColor(i), label: `#${i + 1}`, width: 1.4 };
    });
    // nothing yet: the widest strip of the row, half each side (at its entry width)
    const widest = Math.max(...(this.cases.length ? this.cases.map((c) => c.values.width) : [this.o.solidBase(this.o.conditions()).solid.width])) / mm;
    const zMax = prof.length ? Math.max(...prof.flatMap((p) => p.x.map(Math.abs))) : widest / 2;
    const py = prof.flatMap((p) => p.y);
    const lo = Math.min(0, ...py);
    const hi = Math.max(0, ...py);
    const pp = Math.max((hi - lo) * 0.2, 2);
    drawChart(this.$<HTMLCanvasElement>('sweep-chart-profile'), {
      xLabel: '板幅方向の位置 z [mm]',
      yLabel: '板厚 − 端の板厚 [µm]',
      series: prof,
      hmarks: [{ y: 0, label: '端' }],
      xRange: [-zMax * 1.1, zMax * 1.1],
      yRange: [lo - pp, hi + pp],
    });
    if (!prof.length) this.emptyNote('sweep-chart-profile');
    const n = this.cases.length;
    setLegend(this.legends.profile, n <= 4 ? this.cases.map((_, i) => legendItem(this.caseColor(i), `#${i + 1}（${this.valueText(i)}）`)) : [legendItem(this.caseColor(0), `#1（${this.valueText(0)}）`), ...(n > 2 ? [legendItem(this.caseColor(Math.floor((n - 1) / 2)), '…')] : []), legendItem(this.caseColor(n - 1), `#${n}（${this.valueText(n - 1)}）`)]);
  }

  /** a condition's varied values, short */
  private valueText(i: number): string {
    const spec = this.made?.spec ?? this.spec;
    const v = this.cases[i].values;
    const parts = SWEEP_KEYS.filter((f) => spec.vary[f.key]).map((f) => `${f.label.replace(/（.*）/, '')} ${+(v[f.key] * f.scale).toPrecision(4)}${f.unit ? ` ${f.unit}` : ''}`);
    return parts.join('・') || '同じ条件';
  }

  private emptyNote(id: string): void {
    const canvas = this.$<HTMLCanvasElement>(id);
    const ctx = canvas.getContext('2d')!;
    const r = canvas.getBoundingClientRect();
    ctx.save();
    ctx.font = uiFont(11);
    ctx.fillStyle = STEEL;
    ctx.textAlign = 'center';
    ctx.fillText(this.cases.length ? '条件の計算が終わると出る' : '「比較を始める」で計算する', r.width / 2 + 20, r.height / 2 + 14);
    ctx.restore();
  }

  private drawHead(): void {
    const spec = this.made?.spec ?? this.spec;
    const varied = SWEEP_KEYS.filter((f) => spec.vary[f.key]).map((f) => f.label);
    const title = `条件の比較（3 次元・${spec.stands} パス・${spec.count} 条件${varied.length ? `、${varied.join('・')}を振る` : ''}）`;
    const t = this.$('sweep-title');
    if (t.textContent !== title) t.textContent = title;
    const n = this.cases.length;
    const done = this.cases.filter((c) => c.state === 'done').length;
    const bad = this.cases.filter((c) => c.state === 'stopped' || c.state === 'error').length;
    say(this.$('sweep-phase'), !n ? '条件の欄の振り方で、「比較を始める」を押すと計算する' : this.finished ? `${n} 条件の計算が終わった${bad ? `（${bad} 条件は途中で止まった）` : ''}` : this.running ? `計算中: ${done} / ${n} 条件済み` : `一時停止: ${done} / ${n} 条件済み`);
    // one cell per condition: its colour, how far it is
    const bar = this.$('sweep-bar');
    if (bar.childElementCount !== n) {
      bar.replaceChildren(...this.cases.map((_, i) => {
        const c = el('span', 'sweep-cell');
        c.append(el('span', 'sweep-fill'));
        c.title = `#${i + 1}`;
        return c;
      }));
    }
    this.cases.forEach((c, i) => {
      const cell = bar.children[i] as HTMLElement;
      cell.dataset.state = c.state;
      cell.style.setProperty('--c', this.caseColor(i));
      (cell.firstChild as HTMLElement).style.width = `${Math.round((c.state === 'waiting' ? 0 : c.state === 'running' ? c.progress : 1) * 100)}%`;
      cell.title = `#${i + 1}（${this.valueText(i)}）: ${this.stateText(c)}`;
    });
  }

  private stateText(c: Case): string {
    const stands = this.made?.spec.stands ?? this.spec.stands;
    switch (c.state) {
      case 'waiting':
        return '待ち';
      case 'running':
        return `パス #${c.stand + 1} / ${stands}　${Math.round(c.progress * 100)} %`;
      case 'done':
        return `済み（${duration(c.seconds)}）`;
      case 'stopped':
        return `止まった: ${STOP_TEXT[c.message] ?? c.message}`;
      case 'error':
        return `計算できない: ${c.message}`;
    }
  }

  private drawTable(): void {
    const spec = this.made?.spec ?? this.spec;
    const varied = SWEEP_KEYS.filter((f) => spec.vary[f.key]);
    const stands = spec.stands;
    const head = ['', ...varied.map((f) => `${f.label}${f.unit ? ` [${f.unit}]` : ''}`), '状態', ...Array.from({ length: stands }, (_, k) => `荷重 #${k + 1} [kN]`), 'クラウン [µm]', '幅広がり [%]', '出側板厚 [mm]', '平坦度 [I]', '最大損傷'];
    const rows = this.cases.map((c, i) => {
      const s = c.summary;
      return [
        `#${i + 1}`,
        ...varied.map((f) => String(+(c.values[f.key] * f.scale).toPrecision(4))),
        this.stateText(c),
        ...Array.from({ length: stands }, (_, k) => (s ? fmt((s.force[k] ?? NaN) * 1e-3, 2) : '')),
        s ? fmt(s.crownOut * 1e6, 2) : '',
        s ? fmt(s.spread * 100, 2) : '',
        s ? fmt(s.thicknessOut / mm, 4) : '',
        s ? fmt(s.flatness, 0) : '',
        s ? fmt(s.maxDamage, 3) : '',
      ];
    });
    const table = this.$('sweep-table');
    const key = JSON.stringify([head, rows]);
    if (table.dataset.key === key) return;
    table.dataset.key = key;
    const thead = el('thead');
    const tr = el('tr');
    for (const h of head) tr.append(el('th', undefined, h));
    thead.append(tr);
    const tbody = el('tbody');
    rows.forEach((r, i) => {
      const row = el('tr');
      row.dataset.state = this.cases[i].state;
      r.forEach((v, k) => {
        const td = el(k === 0 ? 'th' : 'td', undefined, v);
        if (k === 0) {
          td.setAttribute('scope', 'row');
          td.prepend(el('span', 'sweep-swatch'));
          td.style.setProperty('--c', this.caseColor(i));
        }
        row.append(td);
      });
      tbody.append(row);
    });
    table.replaceChildren(thead, tbody);
  }

  private csv(): string {
    const spec = this.made?.spec ?? this.spec;
    const stands = spec.stands;
    const head = ['case', 'h0_mm', 'width_mm', 'rollDiameter_mm', 'mu', 'state', 'seconds', ...Array.from({ length: stands }, (_, k) => `force${k + 1}_kN`), ...Array.from({ length: stands }, (_, k) => `widthOut${k + 1}_mm`), ...Array.from({ length: stands }, (_, k) => `crown${k + 1}_um`), 'crownOut_um', 'spread_percent', 'thicknessOut_mm', 'flatness_I', 'maxDamage'];
    const n = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '');
    const lines = this.cases.map((c, i) => {
      const s = c.summary;
      const per = (f: (s: SweepSummary, k: number) => number, d: number) => Array.from({ length: stands }, (_, k) => (s ? n(f(s, k), d) : ''));
      return [
        i + 1,
        n(c.values.h0 / mm, 4),
        n(c.values.width / mm, 3),
        n(c.values.rollDiameter / mm, 2),
        n(c.values.mu, 4),
        c.state,
        n(c.seconds, 1),
        ...per((s, k) => (s.force[k] ?? NaN) * 1e-3, 4),
        ...per((s, k) => (s.width[k] ?? NaN) / mm, 4),
        ...per((s, k) => (s.crown[k] ?? NaN) * 1e6, 3),
        s ? n(s.crownOut * 1e6, 3) : '',
        s ? n(s.spread * 100, 3) : '',
        s ? n(s.thicknessOut / mm, 5) : '',
        s ? n(s.flatness, 1) : '',
        s ? n(s.maxDamage, 4) : '',
      ].join(',');
    });
    return [head.join(','), ...lines].join('\n') + '\n';
  }

  /** what the headless checks read (window.__mpm.sweep) */
  hook() {
    const self = this;
    return {
      get active() {
        return self.active;
      },
      get running() {
        return self.running;
      },
      get done() {
        return self.finished;
      },
      get eta() {
        return self.eta;
      },
      get spec() {
        return JSON.parse(JSON.stringify(self.made?.spec ?? self.spec));
      },
      get jobs() {
        return self.jobs;
      },
      get cases() {
        return self.cases.map((c) => ({ values: { ...c.values }, state: c.state, progress: c.progress, stand: c.stand, seconds: c.seconds, message: c.message }));
      },
      get summaries() {
        return self.cases.map((c) => (c.summary ? JSON.parse(JSON.stringify(c.summary)) : null));
      },
      /** the conditions' 3D params as rolled (null before a condition starts) */
      get params() {
        return self.cases.map((c) => (c.P ? JSON.parse(JSON.stringify(c.P)) : null));
      },
      get url() {
        return self.query().toString();
      },
      get workers() {
        return self.workers.length;
      },
      csv: () => self.csv(),
      run: () => self.run(),
      pause: () => self.pause(),
    };
  }
}

const STOP_TEXT: Record<string, string> = { stalled: 'ロールが噛み込めない', separated: '板が破断した', lost: '点が格子の外に出た', steps: 'ステップ数の上限' };
