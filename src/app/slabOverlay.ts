// References drawn over the charts: the slab method (von Kármán, src/mpm/slab.ts) for the
// roll force and the friction hill, and a moving average of the roll force — each chart
// point is one frame's mean, so the grid-crossing ripple of the MPM (period 2h/v_in,
// docs/validation.md "準静的と荷重の振動") shows in it and hides the steady value.
import { karman } from '../mpm/slab.ts';
import type { SimParams } from '../mpm/params.ts';
import { drawChart, type Series } from './charts.ts';
import type { Diagnostics } from '../mpm/solver.ts';

/** the contact tractions along x as the frames carry them [m], [Pa] */
export interface Profile {
  x: ArrayLike<number>;
  p: ArrayLike<number>;
  tau: ArrayLike<number>;
}

export interface SlabReference {
  /** roll force [N/m] and torque [N·m/m] per roll, neutral point [m] */
  force: number;
  torque: number;
  xNeutral: number;
  crossed: boolean;
  sticking: boolean;
  tensionAtYield: boolean;
  /** positions from the entry to the exit [m], pressure and friction stress on the strip [Pa] */
  x: Float64Array;
  p: Float64Array;
  tau: Float64Array;
  /** why the slab method is not drawn for this condition; null when it holds */
  outside: string | null;
}

let cacheKey = '';
let cache: SlabReference | null = null;

/** The slab method for the condition, solved once per condition (about 10–25 ms) and kept. */
export function slabReference(P: SimParams): SlabReference {
  const key = JSON.stringify([P.rolling, P.material]);
  if (cache && key === cacheKey) return cache;
  const s = karman(P.rolling, P.material);
  // the first reason that breaks the method: a tension at 2k makes the pressure negative at that
  // end (the branches then need not cross either), sticking breaks Coulomb friction, and without
  // a neutral point friction cannot draw the strip in
  const outside = s.tensionAtYield
    ? 'スラブ法: 張力が出口・入口の変形抵抗 2k に達する（圧力が負）ので比べない'
    : s.sticking
      ? 'スラブ法: 摩擦 μp が せん断降伏 k を超える（固着）ので比べない'
      : !s.crossed
        ? // the branches do not cross: the neutral point sits at an end of the bite. At the exit the
          // rolls are faster than the strip everywhere (friction cannot draw it in); at the entry the
          // strip is faster everywhere (a front tension pulls it through and the rolls brake it)
          Math.abs(s.xNeutral - s.x[0]) < Math.abs(s.xNeutral)
          ? 'スラブ法: 中立点が入口にある（板がロールより速く引き出され、全長で前進滑り）ので比べない'
          : 'スラブ法: 中立点が出口にある（摩擦で板を引き込めない）ので比べない'
        : null;
  cache = {
    force: s.force,
    torque: s.torque,
    xNeutral: s.xNeutral,
    crossed: s.crossed,
    sticking: s.sticking,
    tensionAtYield: s.tensionAtYield,
    x: s.x,
    p: s.p,
    tau: s.tau,
    outside,
  };
  cacheKey = key;
  return cache;
}

/**
 * Width of the moving average of the roll force [s]: two periods of the grid-crossing ripple,
 * 2 × 2h/v_in with h = h0 / cellsThrough and v_in = roll speed × (1 − r).
 */
export function smoothingWindow(P: SimParams): number {
  const h = P.rolling.h0 / P.numerics.cellsThrough;
  const vIn = P.rolling.rollSpeed * (1 - P.rolling.reduction);
  return (4 * h) / vIn;
}

/**
 * Centred moving average over a time window: the mean of y over the samples with t in
 * [t_i − h_i, t_i + h_i], so the line does not lag the frames (a trailing window would shift the
 * rise and fall of the load by half its width). The half-width h_i is window/2, cut down near
 * the ends so the window stays symmetric: h_i = min(window/2, t_i − t_0, t_last − t_i). A ramp
 * comes back as it is right up to the newest frame, which is therefore the raw value (the line
 * settles as later frames arrive). Non-finite samples are left out of the mean, as the charts
 * break their lines there. `t` must increase. A window of 0 returns y as it is.
 */
export function movingAverage(t: ArrayLike<number>, y: ArrayLike<number>, window: number): number[] {
  const n = t.length;
  if (!(window > 0)) return Array.from(y);
  const half = window / 2;
  // running sums of the finite samples: S[k] and C[k] over the samples before k
  const S = new Float64Array(n + 1);
  const C = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    const v = y[k];
    const fin = Number.isFinite(v);
    S[k + 1] = S[k] + (fin ? v : 0);
    C[k + 1] = C[k] + (fin ? 1 : 0);
  }
  const out = new Array<number>(n);
  const t0 = t[0];
  const tLast = t[n - 1];
  // both window edges move forward with i (the left edge is t_0, then t_i − half, then 2t_i − t_last)
  // times that differ by rounding only count as equal, or a window cut to t_i − t_0 could keep t_0 and
  // drop its mirror image on the other side
  const eps = 1e-9 * Math.max(Math.abs(t0), Math.abs(tLast), window);
  let lo = 0; // first sample in the window
  let hi = 0; // one past the last
  for (let i = 0; i < n; i++) {
    const h = Math.min(half, t[i] - t0, tLast - t[i]);
    while (hi < n && t[hi] <= t[i] + h + eps) hi++;
    while (t[lo] < t[i] - h - eps) lo++;
    const c = C[hi] - C[lo];
    out[i] = c > 0 ? (S[hi] - S[lo]) / c : NaN;
  }
  return out;
}

// ── the two charts ───────────────────────────────────────────────────────────

const INK = '#1d2a3a';
const INK_FAINT = 'rgba(29,42,58,0.28)';
const STEEL = '#8a949c';
const BLUE = '#1f3f7a';
const COPPER = '#9c4a1c';

/** what the force chart last drew (the headless checks read it) */
export interface ForceChartData {
  t: number[];
  raw: number[];
  smooth: number[];
  windowMs: number;
}

const item = (color: string, text: string, kind = '') =>
  `<span class="item"><span class="swatch${kind ? ` ${kind}` : ''}" style="--c:${color}"></span>${text}</span>`;
const fmtUs = (s: number) => `${Math.round(s * 1e6)} µs`;
/** replace a legend's items only when they change (it is redrawn every frame) */
function setLegend(el: HTMLElement, items: string[]): void {
  const html = items.join('');
  if (el.innerHTML !== html) el.innerHTML = html;
}

/**
 * The roll force over time: one frame's mean as a thin faint line, the moving average as the
 * main line, and the slab method's force as a dashed level (or why it is left out).
 */
export function drawForceChart(canvas: HTMLCanvasElement, legend: HTMLElement, t: number[], F: number[], P: SimParams): ForceChartData {
  const window = smoothingWindow(P);
  const smooth = movingAverage(t, F, window * 1e3);
  const slab = slabReference(P);
  const series: Series[] = [
    { x: t, y: F, color: INK_FAINT, label: '1 フレームの平均', width: 1 },
    { x: t, y: smooth, color: INK, label: '移動平均', width: 1.8 },
  ];
  if (!slab.outside && t.length > 1) {
    const f = slab.force * 1e-6;
    series.push({ x: [t[0], t[t.length - 1]], y: [f, f], color: STEEL, label: 'スラブ法', width: 1.4, dash: [6, 4] });
  }
  drawChart(canvas, { xLabel: '時間 [ms]', yLabel: '荷重 [kN/mm]', series });
  setLegend(legend, [
    item(INK, `移動平均（${fmtUs(window)}、揺れの周期の 2 倍）`),
    item(INK_FAINT, '1 フレームの平均', 'thin'),
    slab.outside
      ? `<span class="note">${slab.outside}</span>`
      : item(STEEL, `スラブ法（Kármán）${(slab.force * 1e-6).toFixed(2)} kN/mm`, 'dashed'),
    `<span class="note">MPM の荷重はスラブ法より 3〜6 % 高い（標準条件で 6 セル 3.22・10 セル 3.10 対 スラブ法 3.03 kN/mm）</span>`,
  ]);
  // copies: t and F are the page's history, which grows between frames
  return { t: t.slice(), raw: F.slice(), smooth, windowMs: window * 1e3 };
}

/**
 * The friction hill: the MPM's contact pressure and friction stress, with the slab method's
 * p(x) and τ(x) as thin dashed lines and its neutral point as a ring (or why they are left out).
 */
export function drawHillChart(
  canvas: HTMLCanvasElement,
  legend: HTMLElement,
  pr: Profile | null | undefined,
  contactLength: number,
  diag: Diagnostics | null | undefined,
  P: SimParams,
): void {
  const slab = slabReference(P);
  const xs = pr ? Array.from(pr.x, (x) => x * 1e3) : [];
  const series: Series[] = pr
    ? [
        { x: xs, y: Array.from(pr.p, (v) => v * 1e-6), color: BLUE, label: '圧力 p' },
        { x: xs, y: Array.from(pr.tau, (v) => v * 1e-6), color: COPPER, label: '摩擦応力 τ', dash: [5, 3] },
      ]
    : [];
  const dots: { x: number; y: number; color: string; r?: number; ring?: boolean }[] = [];
  if (!slab.outside) {
    const sx = Array.from(slab.x, (x) => x * 1e3);
    series.push({ x: sx, y: Array.from(slab.p, (v) => v * 1e-6), color: STEEL, label: 'スラブ法 p', width: 1.2, dash: [6, 4] });
    series.push({ x: sx, y: Array.from(slab.tau, (v) => v * 1e-6), color: STEEL, label: 'スラブ法 τ', width: 1.2, dash: [2, 3] });
    // the slab method's neutral point, on its pressure curve
    let i = 0;
    while (i < slab.x.length - 1 && slab.x[i + 1] < slab.xNeutral) i++;
    dots.push({ x: slab.xNeutral * 1e3, y: slab.p[i] * 1e-6, color: STEEL, r: 4, ring: true });
  }
  drawChart(canvas, {
    xLabel: '圧延方向の位置 [mm]（出口 = 0）',
    yLabel: '[MPa]',
    series,
    dots,
    marks: [
      { x: -contactLength * 1e3, label: '入口' },
      { x: 0, label: '出口' },
      ...(diag?.neutralX != null ? [{ x: diag.neutralX * 1e3, label: '中立点' }] : []),
    ],
  });
  setLegend(legend, [
    item(BLUE, '圧力 p'),
    item(COPPER, '摩擦応力 τ', 'dashed'),
    ...(slab.outside
      ? [`<span class="note">${slab.outside}</span>`]
      : [item(STEEL, 'スラブ法 p', 'dashed'), item(STEEL, 'スラブ法 τ', 'dotted'), item(STEEL, 'スラブ法の中立点', 'ring')]),
  ]);
}
