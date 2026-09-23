// A sweep of conditions (the 「条件の比較」 tab, tools/sweep.mjs): the same tandem of the 3D model rolled for a row of
// conditions whose entry thickness, width, roll diameter and friction go linearly from one value to another
// (any of the four at once), and what each came to after its last pass, side by side.
//
// Each condition is a plain Tandem3 run (the 3D tab's, with the length 'steady' so that every condition reads its
// steady means whatever its thickness and rolls); the page runs several at once, one worker each. Rolling one
// is sweepRun.ts (this module is the page's too, without the model).
import { cloneParams } from '../params.ts';
import type { Solid3Params } from './sim3.ts';
import type { Handoff } from '../tandem.ts';
import type { Stand3Result } from './tandem3.ts';

export type SweepKey = 'h0' | 'width' | 'rollDiameter' | 'mu';

/** the quantities a sweep can vary: how they are shown (unit, the factor from SI) and the range an input may take */
export const SWEEP_KEYS: readonly { key: SweepKey; label: string; unit: string; scale: number; min: number; max: number; step: number }[] = [
  { key: 'h0', label: '板厚（母板）', unit: 'mm', scale: 1e3, min: 0.2, max: 5, step: 0.05 },
  { key: 'width', label: '板幅', unit: 'mm', scale: 1e3, min: 1, max: 200, step: 0.5 },
  { key: 'rollDiameter', label: 'ロール径', unit: 'mm', scale: 1e3, min: 20, max: 1500, step: 5 },
  { key: 'mu', label: '摩擦係数', unit: '', scale: 1, min: 0, max: 0.5, step: 0.01 },
];

export interface SweepSpec {
  /** the quantities varied, each from its first value to its last [SI]; the others are the base's */
  vary: Partial<Record<SweepKey, [number, number]>>;
  /** how many conditions (2 to MAX_CASES), the first and the last at the ends */
  count: number;
  /** passes of the tandem, and how the strip goes from one to the next */
  stands: number;
  handoff: Handoff;
}

export const MAX_CASES = 20;

/** one condition's values [SI] */
export type SweepValues = Record<SweepKey, number>;

export function baseValues(P: Solid3Params): SweepValues {
  return { h0: P.rolling.h0, width: P.solid.width, rollDiameter: 2 * P.rolling.rollRadius, mu: P.rolling.mu };
}

/** the conditions' values, the varied ones linear from first to last */
export function sweepValues(base: Solid3Params, spec: SweepSpec): SweepValues[] {
  const n = Math.max(2, Math.min(MAX_CASES, Math.round(spec.count)));
  const b = baseValues(base);
  const out: SweepValues[] = [];
  for (let i = 0; i < n; i++) {
    const v = { ...b };
    for (const { key } of SWEEP_KEYS) {
      const r = spec.vary[key];
      if (r) v[key] = r[0] + ((r[1] - r[0]) * i) / (n - 1);
    }
    out.push(v);
  }
  return out;
}

/**
 * One condition's params: the base with the values, the length 'steady' (every condition gets its steady reads). A
 * barrel of bending rolls shorter than 1.5 of the width (the spread's room) is lengthened to that.
 */
export function sweepCase(base: Solid3Params, v: SweepValues): Solid3Params {
  const P: Solid3Params = { ...cloneParams(base), solid: { ...base.solid } };
  P.rolling.h0 = v.h0;
  P.rolling.rollRadius = v.rollDiameter / 2;
  P.rolling.mu = v.mu;
  P.rolling.lengthMode = 'steady';
  P.solid.width = v.width;
  const bend = P.solid.rollBend;
  if (bend && bend.barrel > 0 && bend.barrel < 1.5 * v.width) {
    const barrel = 1.5 * v.width;
    P.solid.rollBend = { barrel, ...(bend.span ? { span: Math.max(bend.span, barrel) } : {}) };
  }
  return P;
}

/** what a condition came to: its stands' results, and why it stopped short (null: every pass rolled) */
export interface SweepCaseResult {
  values: SweepValues;
  stands: Stand3Result[];
  stopped: string | null;
}

/** the numbers the comparison shows for one condition (SI; NaN where a pass had no steady reads) */
export interface SweepSummary {
  /** each pass's steady roll force over the whole width [N] and per width of the strip that came out [N/m] */
  force: number[];
  forcePerWidth: number[];
  /** each pass's exit crown (the fitted parabola's, steady) [m], and the width that came out [m] */
  crown: number[];
  width: number[];
  /** after the last pass: the crown [m], the width's growth over all passes (W_last / W0 − 1), the thickness at the mid-width [m] */
  crownOut: number;
  spread: number;
  thicknessOut: number;
  /** the flatness after the last pass, mid-width less edge [I-units] */
  flatness: number;
  maxDamage: number;
  /** the last pass's exit thickness less the edge's across the width, mirrored: z [m], Δh [m] (three columns averaged) */
  profileZ: number[];
  profile: number[];
}

export function summarize(c: SweepCaseResult): SweepSummary {
  const st = c.stands.map((r) => r.steady);
  const last = c.stands[c.stands.length - 1];
  const ls = last?.steady ?? null;
  const smooth = (v: number[]): number[] =>
    v.map((_, k) => {
      const w = v.slice(Math.max(0, k - 1), k + 2).filter(Number.isFinite);
      return w.length ? w.reduce((a, b) => a + b, 0) / w.length : NaN;
    });
  const profileZ: number[] = [];
  const profile: number[] = [];
  if (ls) {
    const h = smooth(ls.halfThickness);
    const edge = h[h.length - 1];
    for (let k = h.length - 1; k >= 0; k--) (profileZ.push(-ls.exitZ[k]), profile.push(2 * (h[k] - edge)));
    for (let k = 0; k < h.length; k++) (profileZ.push(ls.exitZ[k]), profile.push(2 * (h[k] - edge)));
  }
  const fl = ls ? smooth(ls.flatness) : [];
  return {
    force: st.map((s) => s?.force ?? NaN),
    forcePerWidth: st.map((s) => (s ? s.force / (2 * s.halfWidth) : NaN)),
    crown: st.map((s) => s?.crownOut ?? NaN),
    width: c.stands.map((r, k) => (st[k] ? 2 * st[k]!.halfWidth : r.widthOut)),
    crownOut: ls?.crownOut ?? NaN,
    spread: ls ? (2 * ls.halfWidth) / c.values.width - 1 : NaN,
    thicknessOut: ls ? 2 * ls.halfThickness[0] : NaN,
    flatness: fl.length ? fl[0] - fl[fl.length - 1] : NaN,
    maxDamage: Math.max(0, ...c.stands.map((r) => r.maxDamage)),
    profileZ,
    profile,
  };
}
