// The stress explorer: the stress state of one material point, and the loading
// paths of the followed points drawn over the fracture locus εf(η), so it shows
// through which states a point reached D = 1. The paths come from the worker
// (tracker.ts); here they are only shown.
import { hmFractureStrain, jcFractureStrain } from '../mpm/material.ts';
import type { DamageModel, SimParams } from '../mpm/params.ts';
import { drawChart, type Series } from './charts.ts';
import type { Frame, Track, TrackRole } from './protocol.ts';
import { clFractureStrainPlaneStrain, lodeParameter, principal } from './stress.ts';

const ROLES: { role: TrackRole; label: string; color: string }[] = [
  { role: 'selected', label: '選んだ点', color: '#1d2a3a' },
  { role: 'first-crack', label: '最初の亀裂', color: '#c23b22' },
  { role: 'max-damage', label: '損傷最大', color: '#8d5a33' },
];
const colorOf = (r: TrackRole) => ROLES.find((x) => x.role === r)!.color;

/** a tandem's stands on the loading path of the point shown (the locus keeps its blue, cracks their vermilion; no
 * copper, which the most damaged point's brown is too near), neighbours well apart */
const STAND_COLORS = ['#4b5a68', '#3d7a6a', '#6b3f7a', '#b08a2e', '#a8467a'];
export const standColor = (k: number) => STAND_COLORS[k % STAND_COLORS.length];

const MPa = 1e-6;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Explorer {
  private readonly onSelect: (id: number | null) => void;
  private readonly onChange: () => void;
  private readonly buttons = new Map<TrackRole, HTMLButtonElement>();
  private readonly table: HTMLTableElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly note: HTMLElement;
  private role: TrackRole = 'max-damage';
  private chosen = false; // the user picked a role or a point
  private tracks: Track[] = [];
  private firstCrack: Frame['cracks'][number] | null = null;
  private params: SimParams | null = null;

  /**
   * root: the section for the state table; figure: holds the locus canvas (#chart-locus).
   * onSelect: follow this point in the worker; onChange: the chart needs a redraw.
   */
  constructor(root: HTMLElement, figure: HTMLElement, onSelect: (id: number | null) => void, onChange: () => void) {
    this.onSelect = onSelect;
    this.onChange = onChange;
    root.append(el('h2', undefined, '応力状態'));
    const roles = el('div', 'explorer-roles');
    roles.setAttribute('role', 'radiogroup');
    roles.setAttribute('aria-label', '表示する点');
    for (const r of ROLES) {
      const b = el('button', undefined, r.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.role = r.role;
      b.style.setProperty('--role-color', r.color);
      b.addEventListener('click', () => {
        this.chosen = true;
        this.setRole(r.role);
      });
      roles.append(b);
      this.buttons.set(r.role, b);
    }
    root.append(roles);
    root.append(el('p', 'explorer-hint', 'ロールバイトの粒子をクリックすると、その点を追う'));
    this.table = el('table', 'explorer-state');
    this.table.id = 'explorer-state';
    root.append(this.table);
    this.canvas = figure.querySelector('canvas')!;
    this.legend = el('div', 'locus-legend');
    figure.append(this.legend);
    this.note = el('p', 'locus-note');
    figure.append(this.note);
    this.setRole(this.role, false);
  }

  /** A click on the roll bite: follow that point (−1: nothing there, keep what is followed). */
  select(id: number): void {
    if (id < 0) return;
    this.chosen = true;
    this.onSelect(id);
    this.setRole('selected');
  }

  reset(): void {
    this.tracks = [];
    this.firstCrack = null;
    this.chosen = false;
    this.setRole('max-damage');
    this.table.replaceChildren();
  }

  /** The point shown in the table, if the worker follows it. */
  get shown(): Track | null {
    return this.tracks.find((t) => t.role === this.role) ?? null;
  }

  get shownRole(): TrackRole {
    return this.role;
  }

  /** Rings for the roll-bite view. */
  marks(): { id: number; kind: TrackRole }[] {
    return this.tracks.map((t) => ({ id: t.id, kind: t.role }));
  }

  update(f: Frame, params: SimParams): void {
    this.tracks = f.tracks;
    this.firstCrack = f.cracks[0] ?? null;
    this.params = params;
    // until the user chooses, show the first crack as soon as there is one
    if (!this.chosen && this.role !== 'first-crack' && this.tracks.some((t) => t.role === 'first-crack')) this.setRole('first-crack');
    for (const r of ROLES) this.buttons.get(r.role)!.disabled = !this.tracks.some((t) => t.role === r.role);
    this.renderTable();
  }

  private setRole(role: TrackRole, notify = true): void {
    this.role = role;
    for (const [r, b] of this.buttons) b.setAttribute('aria-checked', String(r === role));
    this.renderTable();
    if (notify) this.onChange();
  }

  private renderTable(): void {
    const t = this.shown;
    if (!t) {
      const tr = el('tr');
      const td = el('td', 'empty', this.role === 'selected' ? 'まだ点を選んでいない' : this.role === 'first-crack' ? 'まだ亀裂はない' : 'まだ塑性変形していない');
      td.colSpan = 3;
      tr.append(td);
      this.table.replaceChildren(tr);
      return;
    }
    const s = t.state;
    const pr = principal(s.sxx, s.syy, s.sxy, s.szz);
    const model = this.params?.damage.model;
    // the criterion that fails the point; with none, the indicator the damage D shows (the largest)
    const most = Math.max(s.dJC, s.dHM, s.dCL);
    const mark = (m: DamageModel, v: number) => (model === m ? '判定' : model === 'none' && most > 0 && v === most ? '最大' : '');
    const rows: [string, string, number, string, string][] = [
      ['position', '位置', s.sheetX, `先端から ${(s.sheetX * 1e3).toFixed(2)} mm、中心から ${(s.sheetY * 1e3).toFixed(3)} mm`, ''],
      ['sxx', '圧延方向 σxx', s.sxx, (s.sxx * MPa).toFixed(0), 'MPa'],
      ['syy', '板厚方向 σyy', s.syy, (s.syy * MPa).toFixed(0), 'MPa'],
      ['sxy', 'せん断 σxy', s.sxy, (s.sxy * MPa).toFixed(0), 'MPa'],
      ['szz', '板幅方向 σzz', s.szz, (s.szz * MPa).toFixed(0), 'MPa'],
      ['seq', '相当応力 σeq', s.seq, (s.seq * MPa).toFixed(0), 'MPa'],
      ['pres', '静水圧 p', s.pres, (s.pres * MPa).toFixed(0), 'MPa'],
      ['s1', '最大主応力 σ1', s.s1, (s.s1 * MPa).toFixed(0), 'MPa'],
      ['eta', '三軸度 η', s.eta, s.eta.toFixed(3), ''],
      ['lode', 'Lode パラメータ', lodeParameter(pr), lodeParameter(pr).toFixed(3), ''],
      ['ep', '塑性ひずみ εp', s.ep, s.ep.toFixed(4), ''],
      ['dJC', '損傷 JC', s.dJC, s.dJC.toFixed(3), mark('johnson-cook', s.dJC)],
      ['dHM', '損傷 HM', s.dHM, s.dHM.toFixed(3), mark('hancock-mackenzie', s.dHM)],
      ['dCL', '損傷 CL', s.dCL, s.dCL.toFixed(3), mark('cockcroft-latham', s.dCL)],
      ...(this.params?.damage.yield === 'gtn' || model === 'gtn'
        ? ([['por', '空孔率 f', s.por, s.por.toFixed(4), model === 'gtn' ? '判定' : '']] as [string, string, number, string, string][])
        : []),
      ...(model === 'localization'
        ? ([
            ['loc', '局所化 det A / 弾性の値', s.loc, s.loc === 1 ? '1（流れていない）' : s.loc.toExponential(2), '判定'],
            ['locHit', 'せん断帯', s.locHit ? 1 : 0, s.locHit ? '生じうる（det A ≤ 0 になった）' : 'まだ', ''],
          ] as [string, string, number, string, string][])
        : []),
      ['failed', '状態', s.failed ? 1 : 0, s.failed ? '亀裂' : '健全', ''],
    ];
    if (s.failed) {
      // the stress is gone now: say what it was when the point failed
      const n = t.path.length;
      const c = t.role === 'first-crack' ? this.firstCrack : null;
      const at = c
        ? `η ${c.eta.toFixed(3)}、σ1 ${(c.s1 * MPa).toFixed(0)} MPa、σeq ${(c.seq * MPa).toFixed(0)} MPa、εp ${c.ep.toFixed(4)}`
        : n >= 3
          ? `η ${t.path[n - 3].toFixed(3)}、εp ${t.path[n - 2].toFixed(4)}`
          : '';
      if (at) rows.push(['atFailure', '破壊した時（今は応力を持たない）', c ? c.eta : t.path[n - 3], at, '']);
    }
    const cols = el('colgroup');
    cols.append(el('col', 'label'), el('col'), el('col', 'unit'));
    this.table.replaceChildren(
      cols,
      ...rows.map(([key, label, raw, text, unit]) => {
        const tr = el('tr');
        tr.dataset.key = key;
        tr.dataset.value = String(raw);
        if (key === 'position' || key === 'atFailure') {
          // a sentence: one cell across the table, the label in front
          const td = el('td', 'wide');
          td.colSpan = 3;
          td.append(el('span', undefined, label), text);
          tr.append(td);
          return tr;
        }
        const td = el('td', undefined, text);
        if (key === 'failed' && s.failed) td.classList.add('failed');
        tr.append(el('th', undefined, label), td, el('td', 'unit', unit));
        return tr;
      }),
    );
    this.table.dataset.id = String(t.id);
    this.table.dataset.role = t.role;
  }

  /** Draw the fracture locus and the paths (call when the page redraws). */
  draw(): void {
    const P = this.params;
    if (!P) return;
    const d = P.damage;
    const shown = this.shown;
    // the locus at the shown point's rate, temperature and defect ductility
    const st = shown?.state;
    const rate = st ? Math.max(1, st.epsDotStar) : 1;
    const Ts = st?.Ts ?? 0;
    const duct = st?.duct ?? 1;
    let lo = -1;
    let hi = 1;
    let epMax = 0;
    for (const t of this.tracks) {
      for (let i = 0; i < t.path.length; i += 3) {
        lo = Math.min(lo, t.path[i]);
        hi = Math.max(hi, t.path[i]);
        epMax = Math.max(epMax, t.path[i + 1]);
      }
    }
    lo = Math.max(-2, lo - 0.1);
    hi = Math.min(2, hi + 0.1);
    const N = 121;
    const eta = Array.from({ length: N }, (_, k) => lo + ((hi - lo) * k) / (N - 1));
    const fns: { model: string; label: string; fn: (e: number) => number }[] = [
      { model: 'johnson-cook', label: 'Johnson-Cook', fn: (e) => jcFractureStrain(d, e, rate, Ts) * duct },
      { model: 'hancock-mackenzie', label: 'Hancock-MacKenzie', fn: (e) => hmFractureStrain(e) * duct },
      { model: 'cockcroft-latham', label: 'Cockcroft-Latham（平面ひずみの近似）', fn: (e) => clFractureStrainPlaneStrain(d.clCrit, e) * duct },
    ];
    const curves = fns.map((c) => ({ ...c, y: eta.map(c.fn) }));
    const gov = curves.find((c) => c.model === d.model);
    const govAt = gov ? gov.y[Math.round(((1 / 3 - lo) / (hi - lo)) * (N - 1))] ?? 0 : 0;
    // strain axis (horizontal) from 0 to epTop; triaxiality η on the vertical axis
    const epTop = Math.max(0.3, 1.3 * epMax, Math.min(3, 1.2 * (Number.isFinite(govAt) ? govAt : 0)));
    const series: Series[] = curves.map((c) => ({
      x: c.y,
      y: eta,
      color: c === gov ? '#2c4a8c' : 'rgba(138,148,156,0.9)',
      label: c.label,
      dash: c === gov ? undefined : [4, 3],
    }));
    const dots: NonNullable<Parameters<typeof drawChart>[1]['dots']> = [];
    for (const t of this.tracks) {
      // path as (εp, η): the strain across, the triaxiality up
      const ep: number[] = [];
      const et: number[] = [];
      for (let i = 0; i < t.path.length; i += 3) {
        et.push(t.path[i]);
        ep.push(t.path[i + 1]);
      }
      const firstStand = t.stand?.[0] ?? 0;
      const byStand = t === shown && (t.stand ?? []).some((k) => k !== firstStand);
      if (byStand) {
        // a tandem: the shown point's path in one colour per stand, each stand's first sample numbered
        // (a stand's piece starts at the last sample of the stand before, so the line stays joined)
        let from = 0;
        for (let i = 1; i <= et.length; i++) {
          if (i < et.length && t.stand[i] === t.stand[from]) continue;
          const k = t.stand[from];
          const a = Math.max(0, from - 1);
          series.push({ x: ep.slice(a, i), y: et.slice(a, i), color: standColor(k), label: `#${k + 1}` });
          dots.push({ x: ep[from], y: et[from], color: standColor(k), r: 3, label: `#${k + 1}` });
          from = i;
        }
      } else series.push({ x: ep, y: et, color: colorOf(t.role), label: t.role });
      // the shown point, also as D·εf(η): the strain that would give its damage under proportional
      // loading at the current η — it meets the locus exactly when D = 1
      if (t === shown && gov) {
        const f = gov.fn;
        // (where εf is far right of the chart — compression — the line would only spike: leave a gap)
        const dEf = et.map((e, i) => (f(e) > 2 * epTop ? NaN : t.path[3 * i + 2] * f(e)));
        series.push({ x: dEf, y: et, color: colorOf(t.role), label: 'D·εf', dash: [2, 3] });
        if (t.state.failed && et.length) dots.push({ x: dEf[dEf.length - 1], y: et[et.length - 1], color: colorOf(t.role), r: 5, ring: true });
      }
      if (et.length) {
        const last = et.length - 1;
        dots.push({ x: ep[last], y: et[last], color: colorOf(t.role), r: t.role === this.role ? 4.5 : 3.5, ring: t.state.failed });
      }
    }
    drawChart(this.canvas, {
      xLabel: 'εp',
      yLabel: '応力三軸度 η',
      series,
      dots,
      hmarks: d.model === 'johnson-cook' || d.model === 'hancock-mackenzie' ? [{ y: d.etaCutoff, label: '損傷しない ↓' }] : [],
      xRange: [0, epTop],
      yRange: [lo, hi],
    });
    const item = (color: string, text: string, dotted = false) =>
      `<span class="item"><span class="swatch${dotted ? ' dotted' : ''}" style="--c:${color}"></span>${text}</span>`;
    const shownStands = shown ? [...new Set(shown.stand ?? [])] : [];
    const items = [
      item('#2c4a8c', `εf(η) ${gov ? gov.label : d.model === 'gtn' ? '（判定は空孔率）' : d.model === 'localization' ? '（判定は音響テンソル）' : '（判定しない）'}`),
      ...(shownStands.length > 1 ? shownStands.map((k) => item(standColor(k), `#${k + 1}`)) : []),
      ...this.tracks.map((t) => item(colorOf(t.role), `${ROLES.find((r) => r.role === t.role)!.label}（D ${t.state.damage.toFixed(2)}）`)),
      ...(shown && gov ? [item(colorOf(shown.role), 'D·εf(η)（D = 1 で曲線に届く）', true)] : []),
    ];
    this.legend.innerHTML = items.join('');
    const parts = [];
    if (d.model === 'gtn') parts.push(`判定は空孔率（f ≥ fc ${d.gtn.fc}）なので εf(η) の曲線は無い。D = f/fc。`);
    if (d.model === 'localization') parts.push('判定は音響テンソルの特異（det A / 弾性の値 ≤ 0 でせん断帯が生じうる）なので εf(η) の曲線は無い。硬化する材料では起きない。');
    if (d.model === 'none') parts.push('判定しない（亀裂にしない）。損傷 D は JC・HM・CL の 3 つの最大。');
    if (d.model === 'johnson-cook') parts.push(`JC の曲線は表示中の点のひずみ速度 ε̇* ${rate.toPrecision(3)}・温度 T* ${Ts.toFixed(2)} で描く。`);
    if (duct !== 1) parts.push(`弱い部分の点なので延性 ${duct} 倍。`);
    if (gov)
      parts.push('実線は (εp, η) の経路。D = ∫ dεp / εf(η) なので η が変わると曲線の手前や先で D = 1 になる。点線は同じ損傷を今の η の比例負荷で与えるひずみ D·εf(η) で、D = 1 のとき曲線に載る。');
    else parts.push('線は (εp, η) の経路。');
    this.note.textContent = parts.join('');
  }
}
