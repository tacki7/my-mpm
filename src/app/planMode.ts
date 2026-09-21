// The plan view on the page: the 「断面」「平面図」 switch, the width settings in the conditions panel,
// the plan-view worker, its picture, results table and crack record, and the conditions URL with the
// plan keys. The section model's page is left as it is; main.ts only routes the shared buttons here
// while the plan view is shown.
import { cloneParams, type SimParams } from '../mpm/params.ts';
import type { PlanSettings } from '../mpm/planview/condition.ts';
import type { PlanPhase } from '../mpm/planview/sim.ts';
import { steadyGap, steadyLength } from '../mpm/planview/steady.ts';
import { css, split, temper } from './colormap.ts';
import { checkRange } from './fieldCheck.ts';
import { edited, showNumber } from './numberInput.ts';
import type { FromPlanWorker, PlanFieldName, PlanFrame, PlanGeometry, ToPlanWorker } from './planProtocol.ts';
import { PLAN_SETTINGS, checkedSettings, maxEdgeWidth, maxNotch, planSettingsOf, planSettingsQuery } from './planQuery.ts';
import { PLAN_FIELDS, PlanView, planFieldInfo } from './planView.ts';
import { conditionsQuery } from './query.ts';
import { radioGroup } from './radioGroup.ts';
import { say } from './liveText.ts';

export type ViewMode = 'section' | 'plan';

const mm = 1e-3;

const phaseText: Record<PlanPhase, string> = {
  approach: 'ロールに向かっている',
  bite: '噛み込み中',
  steady: '定常圧延',
  'tail-out': '尾端が抜けるところ',
  done: '圧延が終わった',
};

export interface PlanModeOptions {
  query: URLSearchParams;
  /** where the width settings go (the conditions panel) */
  panelRoot: HTMLElement;
  /** the conditions the section model runs (the panel's unapplied edits stay pending: both views run the same) */
  conditions(): SimParams;
  presetId(): string;
  preset(): SimParams;
  onEdit(): void;
  /** called after the view changed */
  onMode(mode: ViewMode): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class PlanMode {
  mode: ViewMode = 'section';
  settings: PlanSettings;
  private readonly o: PlanModeOptions;
  private readonly view: PlanView;
  private worker: Worker | null = null;
  private geometry: PlanGeometry | null = null;
  private last: PlanFrame | null = null;
  private params: SimParams | null = null;
  private field: PlanFieldName;
  private running = false;
  private frames = 0;
  private dirty = false;
  private crackSeen = 0;
  private awaitingReady = false;
  private readonly stopAfter: number | null;
  private readonly inputs = new Map<keyof PlanSettings, HTMLInputElement>();
  private readonly checks: (() => void)[] = [];
  private readonly switchButtons: HTMLButtonElement[] = [];
  private shownSettings: PlanSettings | null = null;

  constructor(o: PlanModeOptions, stopAfter: number | null) {
    this.o = o;
    this.stopAfter = stopAfter;
    const p0 = o.conditions();
    this.settings = planSettingsOf(o.query, p0.rolling.sheetLength, p0.numerics.ppc);
    this.field = (PLAN_FIELDS.find((f) => f.id === o.query.get('pfield'))?.id ?? 'sxx') as PlanFieldName;
    this.view = new PlanView(this.$<HTMLCanvasElement>('plan-canvas'));
    this.buildSwitch();
    this.buildSettings();
    this.buildTabs();
    this.buildTools();
    this.buildUrl();
    new ResizeObserver(() => {
      this.view.resize();
      this.dirty = true;
    }).observe(this.$('plan-canvas'));
    requestAnimationFrame(() => this.drawLoop());
  }

  private $<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }

  get active(): boolean {
    return this.mode === 'plan';
  }

  /** the plan view has been started (it has a worker and conditions) */
  get started(): boolean {
    return this.worker !== null;
  }

  // ── building ───────────────────────────────────────────────────────────────
  private buildSwitch(): void {
    const box = el('div', 'view-switch');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'モデル');
    for (const [mode, label] of [
      ['section', '断面'],
      ['plan', '平面図'],
    ] as [ViewMode, string][]) {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.dataset.mode = mode;
      b.setAttribute('aria-pressed', String(mode === this.mode));
      b.addEventListener('click', () => this.setMode(mode));
      box.append(b);
      this.switchButtons.push(b);
    }
    const controls = document.querySelector('.masthead .controls')!;
    controls.prepend(box);
  }

  private buildSettings(): void {
    const fs = el('fieldset', 'group plan-only');
    fs.append(el('legend', undefined, '板幅（平面図）'));
    // the edge's ductility scatter is its own fieldset: it is a material condition, not a size
    const edge = el('fieldset', 'group plan-only');
    edge.append(el('legend', undefined, '端の延性のばらつき（平面図）'));
    for (const f of PLAN_SETTINGS) {
      const row = el('label', 'field');
      row.append(el('span', 'field-label', f.label));
      const box = el('span', 'field-input');
      const inp = el('input');
      inp.type = 'number';
      inp.name = `plan-${f.key}`;
      inp.step = String(f.step);
      inp.min = String(f.min);
      inp.max = String(f.max);
      inp.addEventListener('input', () => {
        this.o.onEdit();
        for (const c of this.checks) c(); // the notch's range follows the width
      });
      box.append(inp);
      if (f.unit) box.append(el('span', 'unit', f.unit));
      row.append(box);
      if (f.hint) row.append(el('span', 'hint', f.hint));
      const range = (): [number, number] => {
        if (f.key !== 'notch' && f.key !== 'edgeWidth') return [f.min, f.max];
        const w = parseFloat(this.inputs.get('width')?.value ?? '');
        const width = Number.isFinite(w) ? w : this.settings.width / mm;
        return [f.min, Math.min(f.max, f.key === 'notch' ? maxNotch(width) : maxEdgeWidth(width))];
      };
      this.checks.push(checkRange(inp, row, range, f.unit));
      (f.group === 'edge' ? edge : fs).append(row);
      this.inputs.set(f.key, inp);
    }
    fs.append(el('p', 'hint', '板厚・圧下率・摩擦・材料・破壊の基準・亀裂の面は上の条件を使う（板厚方向のセル数は断面だけ）'));
    edge.append(el('p', 'hint', '端の組織・介在物・トリミングの傷の代わり。ばらつきを入れると耳割れが帯ではなく離れた割れになる（docs/model.md）'));
    // right after the preset's note (and its button), where the view's own settings are looked for first
    const note = this.o.panelRoot.querySelector('.note-more') ?? this.o.panelRoot.querySelector('.preset-note');
    if (note) note.after(fs);
    else this.o.panelRoot.prepend(fs);
    fs.after(edge);
    this.showSettings(this.settings);
  }

  private showSettings(s: PlanSettings): void {
    this.shownSettings = { ...s };
    for (const f of PLAN_SETTINGS) showNumber(this.inputs.get(f.key)!, s[f.key] / f.scale);
    for (const c of this.checks) c();
  }

  /** the panel's width settings (clamped, then checked together for this condition); an input not edited keeps the value it showed */
  private readSettings(params: SimParams): PlanSettings {
    const s = { ...(this.shownSettings ?? this.settings) };
    for (const f of PLAN_SETTINGS) {
      const inp = this.inputs.get(f.key)!;
      if (!edited(inp)) continue;
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) continue;
      const c = Math.min(f.max, Math.max(f.min, v));
      s[f.key] = f.int ? Math.round(c) : c * f.scale;
    }
    return checkedSettings(s, params.rolling.sheetLength, params.numerics.ppc);
  }

  /** the one view control the plan picture has: frame the bite (the default) or the whole strip */
  private buildTools(): void {
    const b = el('button', undefined, '全体を見る');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.title = '板の全長を入れて見る（もう一度押すとロールバイトに戻る）';
    b.addEventListener('click', () => {
      const whole = this.view.fit === 'bite';
      this.view.fit = whole ? 'strip' : 'bite';
      b.setAttribute('aria-pressed', String(whole));
      b.textContent = whole ? 'バイトを見る' : '全体を見る';
      this.dirty = true;
    });
    this.$('plan-tools').append(b);
  }

  private buildTabs(): void {
    const tabs = this.$('plan-tabs');
    for (const f of PLAN_FIELDS) {
      const b = el('button', undefined, f.tab ?? f.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.field = f.id;
      b.addEventListener('click', () => this.setField(f.id));
      tabs.append(b);
    }
    this.markTabs();
    radioGroup(tabs);
  }

  private markTabs(): void {
    for (const b of this.$('plan-tabs').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.field === this.field));
  }

  private buildUrl(): void {
    const box = this.$('plan-export');
    const say = el('p', 'export-status');
    say.setAttribute('aria-live', 'polite');
    const url = el('input');
    url.type = 'text';
    url.readOnly = true;
    url.hidden = true;
    url.setAttribute('aria-label', '今の条件で平面図が始まる URL');
    const copy = el('button', undefined, '条件の URL をコピー');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const u = new URL(location.href);
      u.search = this.query().toString();
      url.value = u.href;
      url.hidden = false;
      try {
        await navigator.clipboard.writeText(u.href);
        say.textContent = '条件の URL をコピーした。開くと同じ条件の平面図で始まる';
      } catch {
        say.textContent = 'クリップボードに書けなかった。下の欄の URL を選んでコピーする';
      }
    });
    const row = el('div', 'export-url');
    row.append(copy, url);
    box.append(el('h2', undefined, '結果の書き出し'), row, say);
  }

  /** the conditions URL: the section model's keys, and the view and width settings */
  query(): URLSearchParams {
    const q = conditionsQuery(this.o.presetId(), this.o.preset(), this.params ?? this.o.conditions());
    q.delete('stands'); // the plan view rolls one stand
    q.set('view', 'plan');
    for (const [k, v] of planSettingsQuery(this.settings)) q.set(k, v);
    if (this.field !== 'sxx') q.set('pfield', this.field);
    return q;
  }

  // ── mode, worker ───────────────────────────────────────────────────────────
  setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    document.body.dataset.view = mode;
    for (const b of this.switchButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    if (mode === 'plan') {
      if (!this.worker) this.restart(this.o.conditions(), false);
      this.showClock();
      this.view.resize();
      this.dirty = true;
      this.updateButtons();
    } else if (this.running) this.pause();
    this.o.onMode(mode);
  }

  private send(m: ToPlanWorker): void {
    this.worker?.postMessage(m);
  }

  private startWorker(): void {
    this.worker = new Worker(new URL('./plan.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromPlanWorker>) => {
      const m = e.data;
      if (m.type === 'ready') {
        this.awaitingReady = false;
        this.geometry = m.geometry;
        this.view.geometry = m.geometry;
        this.dirty = true;
        if (this.o.query.get('autorun') === '1' && this.frames === 0 && this.active) this.run();
      } else if (m.type === 'frame') {
        if (!this.awaitingReady) this.onFrame(m);
      } else if (m.type === 'error') this.showError(m.message);
    };
    this.worker.onerror = (e) => this.showError(e.message);
  }

  /**
   * Start over with these conditions (the ones the section model runs) and the width settings: the
   * panel's (its edits applied) or, with readPanel false, the ones shown (the edits stay pending).
   */
  restart(params: SimParams, readPanel = true): void {
    if (!this.worker) this.startWorker();
    this.settings = checkedSettings(readPanel ? this.readSettings(params) : this.settings, params.rolling.sheetLength, params.numerics.ppc);
    this.showSettings(this.settings);
    this.params = cloneParams(params);
    this.last = null;
    this.view.frame = null;
    this.running = false;
    this.frames = 0;
    this.crackSeen = 0;
    this.$('plan-crack-log').replaceChildren();
    this.awaitingReady = true;
    this.send({ type: 'init', params: this.params, plan: { ...this.settings }, field: this.field, stopAfter: this.stopAfter });
    this.updateButtons();
  }

  /**
   * 「条件を反映してやり直す」 or a new preset: restart with these conditions and the panel's width
   * settings, or, before the plan view has ever run, only take the settings (it starts with them).
   */
  applyConditions(params: SimParams): void {
    if (this.started) return this.restart(params);
    this.settings = this.readSettings(params);
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

  setField(id: PlanFieldName): void {
    this.field = id;
    this.markTabs();
    this.send({ type: 'field', field: id });
    this.dirty = true;
  }

  private get finished(): boolean {
    return this.last?.diag.phase === 'done';
  }

  updateButtons(): void {
    if (!this.active) return;
    (this.$('run') as HTMLButtonElement).disabled = this.running || this.finished;
    (this.$('pause') as HTMLButtonElement).disabled = !this.running;
    this.$('run').textContent = this.frames > 1 && !this.finished ? '続ける' : '圧延を始める';
  }

  /** the shared clock, from this view's last frame (0 before its first), while this view is shown */
  showClock(): void {
    if (!this.active) return;
    const d = this.last?.diag;
    this.$('clock').textContent = `t = ${((d?.t ?? 0) * 1e3).toFixed(2)} ms　${(d?.step ?? 0).toLocaleString()} step`;
  }

  private showError(msg: string): void {
    this.$('plan-phase').textContent = `計算が止まった: ${msg}`;
    this.running = false;
    this.updateButtons();
  }

  // ── frames ─────────────────────────────────────────────────────────────────
  private onFrame(f: PlanFrame): void {
    this.last = f;
    this.frames++;
    this.running = f.running;
    this.view.frame = f;
    this.dirty = true;
    this.updateButtons();
    this.updateResults(f);
    this.updateCracks(f);
  }

  private updateResults(f: PlanFrame): void {
    const g = this.geometry!;
    const d = f.diag;
    const st = d.steady;
    const steady = st.samples > 0;
    // finished without a steady look: the last look is the tail leaving, not a value to read
    const none = !steady && d.phase === 'done';
    const hw = g.halfWidth0;
    // steady means once there are looks in the window, otherwise the last look (marked)
    const mid = steady ? st.forcePerWidthByZ[0] : none ? undefined : d.now?.forceMid;
    const half = steady ? st.forceHalfWidth : none ? undefined : d.now?.forceHalfWidth;
    const spread = steady ? st.spread : none ? undefined : d.now?.spread;
    const thick = steady ? st.centreExitThickness : none ? undefined : d.now?.centreThick;
    const num = (v: number | undefined, k: number, digits: number) => (v != null && Number.isFinite(v) ? (v * k).toFixed(digits) : '—');
    const c0 = f.cracks[0];
    const rows: [string, string, string, boolean][] = [
      ['中央の単位幅荷重', num(mid, 1e-6, 3), 'kN/mm', !steady],
      ['半幅平均の単位幅荷重', num(half != null ? half / hw : undefined, 1e-6, 3), 'kN/mm', !steady],
      ['幅広がり（端ごと）', num(spread != null ? spread * hw : undefined, 1e3, 3), 'mm', !steady],
      ['幅広がり W1/W0 − 1', num(spread, 100, 2), '%', !steady],
      ['中央の出側板厚', num(thick, 1e3, 4), 'mm', !steady],
      ['定常の読み', `${st.samples} / ${st.looks}`, '回', false],
      ['最大損傷', d.maxDamage.toFixed(3), '', false],
      ['亀裂になった点', String(d.nFailed), '個', false],
      // where it is: the crack record below
      ['最初の亀裂', c0 ? (c0.t * 1e3).toFixed(2) : '—', 'ms', false],
      ['粒子数', String(g.n), '個', false],
      ['時間刻み', (g.dt * 1e9).toFixed(1), 'ns', false],
      ['1 ステップの計算時間', f.msPerStep ? f.msPerStep.toFixed(2) : '—', 'ms', false],
    ];
    const tb = this.$('plan-results');
    tb.replaceChildren(
      ...rows.map(([k, v, u, provisional]) => {
        const tr = el('tr');
        if (provisional) tr.className = 'provisional';
        const th = el('th', undefined, k);
        th.setAttribute('scope', 'row');
        tr.append(th, el('td', undefined, v), el('td', 'unit', u));
        return tr;
      }),
    );
    // a strip too short for the window: the tail comes within the gap of the entry before the head is the gap past the exit
    const L = this.params!.rolling.sheetLength;
    const gap = steadyGap(g.halfWidth0);
    const enough = steadyLength(g.halfWidth0);
    const short = L < enough - 1e-12;
    const mmOf = (v: number) => +(v * 1e3).toFixed(3);
    this.$('plan-results-note').textContent =
      `定常の値は、頭端が出口の先に、尾端が入口の手前にそれぞれ ${mmOf(gap)} mm（8 mm か半幅の大きい方）以上ある間の平均（${SAMPLE_NOTE}）。` +
      WIDTH_LOAD_NOTE +
      (steady
        ? ''
        : none
          ? `この板の長さ（${mmOf(L)} mm）では定常の読みが無かった。板の長さを ${mmOf(enough)} mm 以上にする。`
          : short
            ? `板の長さ ${mmOf(L)} mm では定常の読みが出ない見込み（${mmOf(enough)} mm 以上に）。薄い字は直前の読み。`
            : 'まだ無いので、薄い字は直前の読み。');
    this.showClock();
    say(this.$('plan-phase'), phaseText[d.phase]);
  }

  private updateCracks(f: PlanFrame): void {
    const ol = this.$('plan-crack-log');
    const g = this.geometry!;
    if (f.cracks.length === 0) {
      if (!ol.firstChild) ol.append(el('li', 'empty', 'まだ亀裂はない。延性を下げる（Cockcroft-Latham の限界値を小さく）か、端に切り欠きを入れると端から割れやすい。'));
      return;
    }
    if (this.crackSeen === 0) ol.replaceChildren();
    for (let i = this.crackSeen; i < f.cracks.length; i++) {
      const c = f.cracks[i];
      const li = el('li');
      const stamp = el('span', 'stamp pressed', String(c.id + 1));
      stamp.setAttribute('aria-hidden', 'true');
      const body = el('div');
      body.append(el('span', 'sr-only', `亀裂 ${c.id + 1}：`));
      const fromEdge = g.halfWidth0 - c.sheetZ;
      const where = fromEdge < 1.5e-3 ? '端' : fromEdge > 0.5 * g.halfWidth0 ? '板幅の中ほど' : '端寄り';
      body.append(
        el('strong', undefined, `${(c.t * 1e3).toFixed(2)} ms　${where}`),
        el('span', undefined, `頭端から ${(c.sheetX * 1e3).toFixed(2)} mm、端から ${(fromEdge * 1e3).toFixed(2)} mm の点`),
        el('span', undefined, `η ${c.eta.toFixed(2)}　σeq ${(c.seq * 1e-6).toFixed(0)} MPa　εp ${c.ep.toFixed(3)}`),
      );
      li.append(stamp, body);
      ol.append(li);
    }
    this.crackSeen = f.cracks.length;
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  private drawLegend(): void {
    const info = planFieldInfo(this.field);
    const [lo, hi] = this.view.range;
    const stops: string[] = [];
    for (let k = 0; k <= 10; k++) stops.push(css(info.scale === 'diverging' ? split(k / 10) : temper(k / 10)));
    const unit = info.unit ? ` ${info.unit}` : '';
    const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
    const lg = this.$('plan-legend');
    lg.dataset.field = this.field;
    const failed = (this.last?.diag.nFailed ?? 0) > 0;
    const html = `
      <div class="bar" style="background:linear-gradient(90deg,${stops.join(',')})"></div>
      <div class="ends"><span>${fmt(lo)}${unit}</span><span>${info.label}</span><span>${fmt(hi)}${unit}</span></div>
      <div class="exag">上から見た板。解くのは半幅で、板幅の中央で鏡映して全幅を表示</div>
      ${failed ? '<div class="failed-key"><span class="swatch"></span>藍墨の点は亀裂になった点。朱の印は亀裂の番号（右の記録と同じ）</div>' : ''}`;
    if (lg.innerHTML !== html) lg.innerHTML = html;
  }

  private drawLoop(): void {
    try {
      if (this.dirty && this.active) {
        this.dirty = false;
        this.view.draw();
        this.drawLegend();
      }
    } finally {
      requestAnimationFrame(() => this.drawLoop());
    }
  }

  /** mean time of one redraw of the current frame over n redraws [ms] */
  drawMs(n = 20): number {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.view.draw();
    return (performance.now() - t0) / n;
  }

  /** what the headless checks read (window.__mpm.plan) */
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
      get done() {
        return self.finished || (self.stopAfter !== null && (self.last?.diag.step ?? 0) >= self.stopAfter && !self.running);
      },
      get diag() {
        return self.last?.diag ?? null;
      },
      get cracks() {
        return self.last?.cracks ?? [];
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
      get url() {
        return self.query().toString();
      },
      setMode: (m: ViewMode) => self.setMode(m),
      setField: (id: PlanFieldName) => self.setField(id),
      run: () => self.run(),
      drawMs: (n?: number) => self.drawMs(n),
    };
  }
}

const SAMPLE_NOTE = '250 ステップごと、tools/planview.mjs と同じ読み方';
// the load's distribution across the width is not quantitative, its total is (docs/model.md「平面図モデル」の「使える範囲」)
const WIDTH_LOAD_NOTE =
  '半幅平均は平面ひずみと ±1 % で合うが、中央の単位幅荷重は定量でない: 端の影響が端から 21〜28 mm に及び、標準条件の板幅 20〜60 mm では中央が平面ひずみより約 3 割高く出る。';
