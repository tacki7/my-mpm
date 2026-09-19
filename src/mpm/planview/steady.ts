// The steady values of a plan-view run, read the same way by tools/planview.mjs and the page
// (src/app/plan.worker.ts), so the two agree to the last digit: a look every SAMPLE_STEPS steps,
// kept while the phase is steady, the head is at least a gap past the exit and the tail at least a gap
// before the entry. The gap is 8 mm or the half width, whichever is more: the middle's load per unit
// width settles only when the head has gone about a half width past the exit, and falls again as the
// tail comes within about a half width of the entry (8 mm at narrow strips), so a strip needs about
// twice the gap and more to have steady looks. docs/validation.md "平面図モデル".
import type { PlanPhase, PlanSim } from './sim.ts';

/** steps between two looks */
export const SAMPLE_STEPS = 250;
/** the least gap between the head and the exit, and between the tail and the entry, for a look to count [m] */
export const GAP_MIN = 8e-3;

/** the gap for a strip of this half width [m]: GAP_MIN, or the half width when that is more */
export function steadyGap(halfWidth: number): number {
  return Math.max(GAP_MIN, halfWidth);
}

/** a strip at least this long has steady looks, about ten at the standard pass (twice the gap and 8 mm) [m] */
export function steadyLength(halfWidth: number): number {
  return 2 * steadyGap(halfWidth) + 8e-3;
}

/** one look at the strip: force per unit width by band of lattice columns, σxx by z in the bite and past the exit, spread, pressure jumps */
export interface PlanSnapshot {
  /**
   * Roll force per unit width [N/m], mid → edge, in ten bands of whole lattice columns (fewer when the half
   * width has fewer than ten columns): a band's value is the mean of its columns'. A column's is the sum over
   * its points in contact of p_c × the point's length along x (plan area over its width across). Bands of a
   * fixed width in z held 2 or 3 columns by turns and showed a false ±5–15 % ripple.
   */
  forcePerWidth: number[];
  /** the same per lattice column, mid → edge [N/m] */
  forcePerWidthByColumn: number[];
  /** σxx mid → edge in the bite, x ∈ (−1, 0) mm, and 1–5 mm past the exit probe [Pa] */
  sxxBite: number[];
  sxxPast: number[];
  /** half width at the exit probe [m] */
  halfWidth: number;
  /** thickness of the middle band at the exit probe [m] */
  centreThick: number;
  /** mean pressure of the points in contact and its jumps between lattice neighbours [Pa] */
  pressureMean: number;
  jumpMax: number;
  jumpP95: number;
}

export function snapshot(sim: PlanSim): PlanSnapshot {
  const nb = 10;
  const Wz = sim.halfWidth0 * 1.05;
  const band = (z: number) => Math.min(nb - 1, Math.floor((z / Wz) * nb));
  // force per unit width: by lattice column, then bands of whole columns
  const NK = sim.NK;
  const nf = Math.min(nb, NK);
  const bandOf = (k: number) => Math.min(nf - 1, Math.floor((k * nf) / NK));
  const fc = new Float64Array(NK);
  const bite = Array.from({ length: nb }, () => [0, 0]);
  const past = Array.from({ length: nb }, () => [0, 0]);
  const jumps: number[] = [];
  let pMean = 0;
  let nIn = 0;
  const x2 = sim.xExitProbe + 1e-3;
  const x3 = sim.xExitProbe + 5e-3;
  const neighbour = (p: number, di: number, dk: number) => {
    const i = sim.li[p] + di;
    const k = sim.lk[p] + dk;
    if (i < 0 || i >= sim.NI || k < 0 || k >= sim.NK) return -1;
    return sim.lattice[i * sim.NK + k];
  };
  for (let p = 0; p < sim.n; p++) {
    if (!sim.active[p]) continue;
    const x = sim.px[p];
    const b = band(sim.pz[p]);
    const detF = sim.f00[p] * sim.f11[p] - sim.f01[p] * sim.f10[p];
    if (sim.pc[p] > 0) {
      // p_c × the point's length along x: its plan area dp² det F over its width across dp |F e_z|
      fc[sim.lk[p]] += (sim.pc[p] * sim.dp * detF) / Math.hypot(sim.f01[p], sim.f11[p]);
      pMean += sim.pres[p];
      nIn++;
      // the pressure against the lattice neighbours ahead and outward
      for (const q of [neighbour(p, 1, 0), neighbour(p, 0, 1)]) if (q >= 0 && sim.active[q] && sim.pc[q] > 0) jumps.push(Math.abs(sim.pres[p] - sim.pres[q]));
    }
    const sxx = sim.sxx[p] - sim.pres[p];
    if (x > -1e-3 && x < 0) (bite[b][0] += sxx), bite[b][1]++;
    if (x > x2 && x < x3) (past[b][0] += sxx), past[b][1]++;
  }
  jumps.sort((a, b) => a - b);
  const exit = sim.exitProfile(sim.xExitProbe, sim.xExitProbe + 2 * sim.h, 5);
  const fb = new Float64Array(nf);
  const cols = new Float64Array(nf);
  for (let k = 0; k < NK; k++) {
    fb[bandOf(k)] += fc[k];
    cols[bandOf(k)]++;
  }
  return {
    forcePerWidth: Array.from(fb, (f, i) => f / cols[i]),
    forcePerWidthByColumn: Array.from(fc),
    sxxBite: bite.map(([s, c]) => (c ? s / c : NaN)),
    sxxPast: past.map(([s, c]) => (c ? s / c : NaN)),
    halfWidth: exit.halfWidth,
    centreThick: exit.bins[0].thick,
    pressureMean: nIn ? pMean / nIn : NaN,
    jumpMax: jumps.length ? jumps[jumps.length - 1] : NaN,
    jumpP95: jumps.length ? jumps[Math.floor(0.95 * (jumps.length - 1))] : NaN,
  };
}

/** Means of the steady looks (NaN, or empty arrays, while there are none). */
export interface SteadyMeans {
  samples: number;
  /** looks in the steady phase, inside the window or not */
  looks: number;
  /** roll force per roll on the half width [N] */
  forceHalfWidth: number;
  /** mid → edge, bands of whole lattice columns [N/m] */
  forcePerWidthByZ: number[];
  /** mid → edge, per lattice column [N/m] */
  forcePerWidthByColumn: number[];
  /** W1/W0 − 1 */
  spread: number;
  centreExitThickness: number;
  sxxBite: number[];
  sxxPast: number[];
  pressureMean: number;
  pressureJumpMax: number;
  pressureJumpP95: number;
}

const mean = (a: number[]) => {
  const v = a.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};

/**
 * Collects the looks of a run: call `look(sim)` after every SAMPLE_STEPS steps (from step 0). It reads
 * the phase and the roll force since the last look (sim.readForce), and keeps a snapshot when it counts.
 */
export class SteadySampler {
  /** the gap given (null: steadyGap of the strip's half width) */
  readonly gap: number | null;
  private readonly kept: { F: number; snap: PlanSnapshot }[] = [];
  private steadyLooks = 0;
  /** roll force per roll on the half width read at the last look [N] */
  lastForce = NaN;

  constructor(gap: number | null = null) {
    this.gap = gap;
  }

  look(sim: PlanSim): PlanPhase {
    const phase = sim.phase();
    const F = sim.readForce();
    this.lastForce = F;
    if (phase !== 'steady') return phase;
    this.steadyLooks++;
    const gap = this.gap ?? steadyGap(sim.halfWidth0);
    if (sim.headX() >= gap && sim.tailX() <= -sim.contactLength - gap) this.kept.push({ F, snap: snapshot(sim) });
    return phase;
  }

  means(halfWidth0: number): SteadyMeans {
    const s = this.kept;
    const meanOf = (f: (x: PlanSnapshot) => number) => mean(s.map((k) => f(k.snap)));
    const meanVec = (f: (x: PlanSnapshot) => number[]) => (s.length ? f(s[0].snap).map((_, i) => mean(s.map((k) => f(k.snap)[i]))) : []);
    return {
      samples: s.length,
      looks: this.steadyLooks,
      forceHalfWidth: mean(s.map((k) => k.F)),
      forcePerWidthByZ: meanVec((x) => x.forcePerWidth),
      forcePerWidthByColumn: meanVec((x) => x.forcePerWidthByColumn),
      spread: s.length ? meanOf((x) => x.halfWidth) / halfWidth0 - 1 : NaN,
      centreExitThickness: s.length ? meanOf((x) => x.centreThick) : NaN,
      sxxBite: meanVec((x) => x.sxxBite),
      sxxPast: meanVec((x) => x.sxxPast),
      pressureMean: s.length ? meanOf((x) => x.pressureMean) : NaN,
      pressureJumpMax: s.length ? meanOf((x) => x.jumpMax) : NaN,
      pressureJumpP95: s.length ? meanOf((x) => x.jumpP95) : NaN,
    };
  }
}
