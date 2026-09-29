// Whether a rolled strip lies flat, and if not, the waves it takes: at the edges (耳波, wavy edge), at the middle
// (中伸び・腹伸び, centre buckle) or between (クォーター伸び, quarter buckle). From the steady flatness (steady.ts: each
// lattice column's free elongation, in I-units), read as the shop floor and the textbooks read a shape meter
// (docs/model.md「平坦度の形」):
//
// - the elongation across the width as y*(ζ) = λ₂ ζ² + λ₄ ζ⁴, ζ = z / (B/2), y*(0) = 0 (a 4th-order fit, eq. 4.57 of
//   the reference); Λ₂ = y*(1) the edge's and Λ₄ = y*(1/√2) the quarter's elongation over the middle's, and the
//   pattern from them (fig. 4.20): Λ₂ > 0 and Λ₂ ≥ Λ₄ simple wavy edge; Λ₄ > Λ₂, Λ₄ > 0 quarter (compound); else the
//   middle is the longest, centre buckle
// - whether it buckles (Shohet's limits, eq. 4.53): the difference of elongation Δε stays in the strip as residual
//   stress — the strip looks flat — while −40 (h/B)² < Δε < 80 (h/B)² (h the exit thickness, B the width)
// - how steep the waves are (eq. 4.52, fig. 4.17): λ[%] = a √(|Δε|[%] − b), b the insensitive band just above and
//   a = 0.582 √(B/h − 50) for B/h < 160, about 6 above (the theory's 2/π · 10 = 6.37 with no band, eq. 4.51: a wave
//   of height δ and pitch l is longer by (π/2)² (δ/l)², eq. 4.46). Below B/h = 50 no waves form at all
//
// The reference is a textbook on strip crown and flatness (§4.3「圧延材のラテラルフローと張力フィードバックを考慮した
// 板クラウン・平坦度の予測」, figs. 4.14–4.20); the limits and a are fits to aluminium and stainless strip rolling. The
// pitch is not in the flatness (a buckling analysis would give it), so it is the viewer's, and so is the phase: every
// fibre waves in step (both edges up together), the symmetric mode of the quarter model.

export type FlatKind = 'flat' | 'edge' | 'centre' | 'quarter';

export interface FlatShape {
  /** the fit y*(ζ) = l2 ζ² + l4 ζ⁴ [strain], and Λ₂ = y*(1), Λ₄ = y*(1/√2) */
  l2: number;
  l4: number;
  edge: number;
  quarter: number;
  /** the pattern the elongation has (fig. 4.20), whether or not it buckles */
  pattern: Exclude<FlatKind, 'flat'>;
  /** the difference of elongation that drives it: the longest fibre's over the shortest's [strain] */
  drive: number;
  /** Shohet's limit on that side [strain]: 80 (h/B)² for the edges and quarters, 40 (h/B)² for the middle */
  band: number;
  /** width over thickness, and the shape coefficient a (fig. 4.17) */
  bh: number;
  a: number;
  /** what the strip shows: `pattern` when it buckles, else 'flat' */
  kind: FlatKind;
  /** the steepest wave δ / l (a fraction; 0 when flat), and where across the half-width (0 the middle, 1 the edge) */
  steepness: number;
  at: number;
  /** each fibre's steepness across the width, ζ from −1 to 1 (the strip's drawn waves) */
  zeta: number[];
  lambda: number[];
}

/** the shape coefficient a of eq. 4.52 for a width over thickness (fig. 4.17; 0 below B/h = 50: no waves) */
export function shapeCoefficient(bh: number): number {
  if (bh <= 50) return 0;
  return bh < 160 ? 0.582 * Math.sqrt(bh - 50) : 6;
}

/** a steepness from a difference of elongation over the band (eq. 4.52: λ[%] = a √(Δε[%] − b)), a fraction */
export function steepnessOf(de: number, band: number, a: number): number {
  return de > band ? (a * Math.sqrt((de - band) * 100)) / 100 : 0;
}

const SAMPLES = 41;

/**
 * The shape from the steady flatness by lattice column (`exitZ` from the mid-width out [m], `flatness` in I-units),
 * the exit's half-width and thickness [m]. `ignoreBand`: the waves the whole difference of elongation would make
 * (the theory's λ = (2/π) √Δε, no band, no a) — for a strip too narrow or too flat to buckle, a look at what it holds
 */
export function flatShape(
  exitZ: ArrayLike<number>,
  flatness: ArrayLike<number>,
  halfWidth: number,
  thickness: number,
  ignoreBand = false,
): FlatShape | null {
  const pts: { u: number; f: number }[] = [];
  for (let k = 0; k < flatness.length; k++) {
    if (Number.isFinite(flatness[k]) && Number.isFinite(exitZ[k]) && halfWidth > 0) pts.push({ u: (exitZ[k] / halfWidth) ** 2, f: flatness[k] * 1e-5 });
  }
  if (pts.length < 3 || !(thickness > 0)) return null;
  // y = c + l2 u + l4 u², u = ζ²: least squares for the three, then y* = y − c (the middle at 0)
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const { u, f } of pts) {
    s0 += 1; s1 += u; s2 += u * u; s3 += u * u * u; s4 += u * u * u * u;
    t0 += f; t1 += f * u; t2 += f * u * u;
  }
  const det3 = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const D = det3(M);
  if (!D) return null;
  const col = (i: number, v: number[]) => M.map((r, j) => r.map((x, k) => (k === i ? v[j] : x)));
  const l2 = det3(col(1, [t0, t1, t2])) / D;
  const l4 = det3(col(2, [t0, t1, t2])) / D;
  const y = (zeta: number) => l2 * zeta ** 2 + l4 * zeta ** 4;
  const edge = y(1);
  const quarter = y(Math.SQRT1_2);
  const pattern: FlatShape['pattern'] = edge > 0 && edge >= quarter ? 'edge' : quarter > 0 && quarter > edge ? 'quarter' : 'centre';
  // the fibres across the half-width, their elongation over the shortest
  const half: number[] = [];
  for (let i = 0; i < SAMPLES; i++) half.push(y(i / (SAMPLES - 1)));
  const least = Math.min(...half);
  const drive = Math.max(...half) - least;
  const bh = (2 * halfWidth) / thickness;
  const hb2 = (thickness / (2 * halfWidth)) ** 2;
  const band = (pattern === 'centre' || (pattern === 'quarter' && edge <= 0) ? 40 : 80) * hb2;
  const a = shapeCoefficient(bh);
  const buckles = ignoreBand ? drive > 0 : a > 0 && drive > band;
  // each fibre waves by its own excess over the band (the fibres within the band of the shortest stay flat)
  const each = half.map((v) => (!buckles ? 0 : ignoreBand ? (2 / Math.PI) * Math.sqrt(v - least) : steepnessOf(v - least, band, a)));
  let top = 0;
  for (let i = 1; i < SAMPLES; i++) if (each[i] > each[top]) top = i;
  const zeta: number[] = [];
  const lambda: number[] = [];
  for (let i = SAMPLES - 1; i > 0; i--) (zeta.push(-i / (SAMPLES - 1)), lambda.push(each[i]));
  for (let i = 0; i < SAMPLES; i++) (zeta.push(i / (SAMPLES - 1)), lambda.push(each[i]));
  return {
    l2, l4, edge, quarter, pattern, drive, band, bh, a,
    kind: buckles ? pattern : 'flat',
    steepness: each[top],
    at: top / (SAMPLES - 1),
    zeta,
    lambda,
  };
}

/** the defect in words, as the shop floor says it */
export const FLAT_NAMES: Record<FlatKind, string> = {
  flat: '平坦（座屈しない）',
  edge: '耳波（端伸び）',
  centre: '腹伸び（中伸び）',
  quarter: 'クォーター伸び（複合伸び）',
};

/** the wave's height at (x, ζ) for a pitch p [any length unit]: δ(ζ)/2 · sin(2π x / p), δ = λ p */
export function waveHeight(s: FlatShape, x: number, zeta: number, pitch: number): number {
  const zs = s.zeta;
  let lam: number;
  if (zeta <= zs[0]) lam = s.lambda[0];
  else if (zeta >= zs[zs.length - 1]) lam = s.lambda[zs.length - 1];
  else {
    const f = ((zeta - zs[0]) / (zs[zs.length - 1] - zs[0])) * (zs.length - 1);
    const k = Math.min(zs.length - 2, Math.floor(f));
    lam = s.lambda[k] + (f - k) * (s.lambda[k + 1] - s.lambda[k]);
  }
  return ((lam * pitch) / 2) * Math.sin((2 * Math.PI * x) / pitch);
}
