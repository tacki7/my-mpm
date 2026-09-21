// Tandem rolling: the same pass repeated over a number of stands, the material state carried from one
// stand to the next (docs/model.md「タンデム」).
//
// Each stand is its own Sim, solved one after the other (not at the same time as in a real mill). Every
// stand has the same condition: rolls, μ, tensions, material, grid (cells through the thickness), and the
// reduction taken on its own entry thickness. Stand k + 1 starts with the sheet that came out of stand k:
// its entry thickness is that sheet's measured thickness (with the elastic recovery), its length is set
// by the mass, and every new point takes the state of an old point of the same lattice row, shared out
// by the material along the row ("remap"). The lattice is rebuilt because the sheet thins and lengthens:
// carried as they are, the points would sit 1/(1 − r)² times further apart along x than the grid
// (h = h0 / cells) is made for. The tandem stops early at a stall, a strip break or points lost off the grid.
//
// A stand need not roll its whole sheet (handoff 'steady'): once it rolls steadily and enough steadily rolled
// sheet is out, the next stand starts at once, with a sheet made of that stretch of sheet repeated along x
// and only as long as the next stand needs to get steady itself.
import { cloneParams, type SimParams } from './params.ts';
import { Sim, type Crack, type Diagnostics } from './solver.ts';

export const MAX_STANDS = 5;
/**
 * Steps between a stand's own readings (tools/run.mjs's --every): the roll force and torque over the window,
 * the exit gauge and the phase. A stand ends at the reading that finds it 'done', so the stands, their
 * results and the next stand's start are the same for every caller that steps the tandem.
 */
export const READ_STEPS = 2000;

/**
 * When a stand with another after it hands its sheet on: 'done' once the whole sheet is through (the sheet is
 * carried whole, mass kept), 'steady' as soon as it rolls steadily and STEADY_READS steady readings and a
 * steadily rolled stretch of sheet (steadySample) are there. A sheet too short for that is carried as in 'done'.
 */
export type Handoff = 'done' | 'steady';
/** steady readings a stand takes before a 'steady' handoff */
export const STEADY_READS = 2;

export type StandCrack = Crack & { stand: number };

/**
 * Why a tandem stopped before its last stand: the rolls could not draw the sheet in ('stalled'), a crack
 * went through the thickness and the sheet came apart ('separated': a mill stops at a strip break), or
 * points left the grid ('lost': there would be no whole sheet to carry over).
 */
export type TandemStop = 'stalled' | 'separated' | 'lost';

/** One finished stand. Lengths [m], force [N/m], torque [N·m/m], time [s] within the stand. */
export interface StandResult {
  stand: number;
  /** the stand's entry sheet */
  h0: number;
  sheetLength: number;
  particles: number;
  steps: number;
  t: number;
  /** how it ended: 'done', 'steady' (handed on while it rolled steadily, the rest of its sheet not rolled), or
   *  'stalled' (the rolls could not draw the sheet in; no stand after it) */
  phase: 'done' | 'steady' | 'stalled';
  /** means over the steady readings, as tools/run.mjs takes them over its reads; null without one */
  steadyForce: number | null;
  steadyTorque: number | null;
  exitThickness: number | null;
  forwardSlip: number | null;
  /** mean deformation resistance in the bite, 2k = (2/√3) σy along the contact length [Pa] (Sim.biteFlowStress) */
  meanFlowStress: number | null;
  /** thickness of the sheet that came out (area over length of its middle half; the next stand's h0) */
  /** the rolls at the stand's end: the radius in the contact (Hitchcock's R' with flattening 'hitchcock'), the gap
   *  (adjusted with gapControl 'reduction') [m], and whether they had settled (true with rolls that are not adjusted) */
  rollRadius: number;
  gap: number;
  rollsSettled: boolean;
  thicknessOut: number;
  /** the fraction of the stand's mass on points that left the grid (0 normally) */
  massLost: number;
  /** a crack goes through the thickness: three neighbouring lattice columns have a failed point in every row */
  separated: boolean;
  /** crack records that started in this stand */
  cracksBorn: number;
  /** the area that failed into cracks in this stand, new ones and older ones growing [m², per unit width]; a stand
   *  that only carries its cracks on adds 0 (the remap's recount on the finer lattice is not growth) */
  crackGrowth: number;
  /** over the points still on the grid (the ones that left it are in massLost) */
  maxDamage: number;
  nFailed: number;
  /** crack records so far, this stand's and the stands' before */
  cracks: number;
}

/** The current stand's steady readings so far and their means, as its StandResult will have them (null: none yet). */
export interface SteadyMeans {
  readings: number;
  force: number | null;
  torque: number | null;
  exitThickness: number | null;
  forwardSlip: number | null;
  meanFlowStress: number | null;
}

export interface StandDone {
  stand: number;
  /** the stand that finished, as it ended */
  sim: Sim;
  /** the next stand (null after the last, or after a stall) */
  next: Sim | null;
  /** next's point i came from sim's point parentOf[i] (null when there is no next) */
  parentOf: Int32Array | null;
  result: StandResult;
}

interface Reading {
  force: number;
  torque: number;
  exitThickness: number | null;
  forwardSlip: number | null;
  meanFlowStress: number | null;
}

export class TandemSim {
  readonly stands: number;
  /** steps between the stand's own readings */
  readonly every: number;
  readonly handoff: Handoff;
  /** the condition every stand shares (the first stand's sheet) */
  readonly base: SimParams;
  /** the stand now (0 first) and its Sim, replaced at every remap */
  stand = 0;
  sim: Sim;
  readonly results: StandResult[] = [];
  /** the last remap: the current sim's point i came from the stand before's point parentOf[i]; null in the first stand */
  parentOf: Int32Array | null = null;
  /** time and steps of the stands before the current one: the running clock is tOffset + sim.t */
  tOffset = 0;
  stepOffset = 0;
  /** called when a stand ends, inside advance(), before the remap replaces sim */
  onStandDone: ((e: StandDone) => void) | null = null;
  /** why the tandem stopped before its last stand; null while it runs and after a normal end */
  stopped: TandemStop | null = null;
  private steady: Reading[] = [];
  private finished = false;
  /** per crack id, the mass of its failed points when the current stand started (after the remap) */
  private crackBase: Float64Array = new Float64Array(0);

  constructor(params: SimParams, stands: number, every = READ_STEPS, handoff: Handoff = 'done') {
    if (!(Number.isInteger(stands) && stands >= 1 && stands <= MAX_STANDS)) throw new Error(`stands must be 1 to ${MAX_STANDS}`);
    if (!(Number.isInteger(every) && every > 0)) throw new Error('every must be a positive whole number of steps');
    this.stands = stands;
    this.every = every;
    this.handoff = handoff;
    this.base = cloneParams(params);
    this.sim = new Sim(params);
  }

  /**
   * One step of the current stand; every `every` steps its own reading. A stand with another after it ends
   * at the first step it is 'done' (or stalled): later, a front tension would pull the rolled sheet on and
   * out of the grid. The last stand ends at the reading that finds it done, as tools/run.mjs reads a
   * single pass. With handoff 'steady' a stand with another after it ends sooner, at the reading that finds it
   * steady with STEADY_READS steady readings and a steady stretch of sheet out (steadySample). Ending here: the stand's result, onStandDone, and the remap into the next stand (sim is
   * then a new Sim at step 0), or the stop. After the end, sim keeps stepping as a single pass does.
   */
  advance(): void {
    const sim = this.sim;
    sim.advance();
    if (this.finished) return;
    const read = sim.step % this.every === 0;
    if (!read && this.stand + 1 >= this.stands) return;
    const phase = sim.phase();
    const w = read ? sim.readWindow() : null;
    if (phase === 'steady' && w) {
      const ex = sim.exitMeasure();
      this.steady.push({
        force: w.force,
        torque: w.torque,
        exitThickness: ex ? ex.thickness : null,
        forwardSlip: ex ? ex.speed / sim.params.rolling.rollSpeed - 1 : null,
        meanFlowStress: sim.biteFlowStress(),
      });
    }
    if (phase === 'done' || phase === 'stalled') this.endStand(phase);
    else if (this.handoff === 'steady' && phase === 'steady' && read && this.stand + 1 < this.stands && this.steady.length >= STEADY_READS) {
      const sample = steadySample(sim);
      if (sample) this.endStand('steady', sample);
    }
  }

  /** the current stand's Sim.diagnostics() with the stand: read it as often as you like, the results do not depend on it */
  diagnostics(): Diagnostics & { stand: number; stands: number } {
    return { ...this.sim.diagnostics(), stand: this.stand, stands: this.stands };
  }

  /** true once the last stand has ended, or a stand stalled */
  get done(): boolean {
    return this.finished;
  }

  /** every crack record so far, with the stand it started in (ids run on across the stands) */
  get cracks(): StandCrack[] {
    return this.sim.cracks.map((c) => ({ ...c, stand: c.stand ?? this.stand }));
  }

  private endStand(phase: 'done' | 'steady' | 'stalled', sample: [number, number] | null = null): void {
    const old = this.sim;
    const { growth, ...result } = this.close(old, phase, sample);
    this.results.push(result);
    // a tandem of more than one stand marks its records with the stand and the area; a single stand leaves them as the
    // single pass has them
    if (this.stands > 1) {
      for (const c of old.cracks) {
        if (c.stand === undefined) c.stand = this.stand;
        const a = c.areaByStand ?? [];
        while (a.length < this.stand) a.push(0);
        a[this.stand] = growth[c.id];
        c.areaByStand = a;
      }
    }
    const more = this.stand + 1 < this.stands;
    if (more) {
      this.stopped =
        phase === 'stalled' ? 'stalled' : result.separated ? 'separated' : result.massLost > 0 || !(result.thicknessOut > 0) ? 'lost' : null;
    }
    const [next, parentOf] = more && !this.stopped ? remap(old, this.base, result.thicknessOut, sample, this.every) : [null, null];
    if (next) this.crackBase = crackMass(next);
    this.onStandDone?.({ stand: this.stand, sim: old, next, parentOf, result });
    if (!next) {
      this.finished = true;
      return;
    }
    this.tOffset += old.t;
    this.stepOffset += old.step;
    this.sim = next;
    this.parentOf = parentOf;
    this.stand++;
    this.steady = [];
  }

  /**
   * The current stand's steady means so far, over its own readings (every `every` steps, as tools/run-summary.mjs
   * takes them): what its result will say. After the last stand they stay; a new stand starts with none.
   */
  steadyMeans(): SteadyMeans {
    const s = this.steady;
    // as tools/run-summary.mjs: the plain mean over the readings (a thickness of 0 counts as none)
    const mean = (a: number[]) => (a.length ? a.reduce((x, v) => x + v, 0) / Math.max(1, a.length) : null);
    return {
      readings: s.length,
      force: mean(s.map((d) => d.force)),
      torque: mean(s.map((d) => d.torque)),
      exitThickness: mean(s.filter((d) => d.exitThickness).map((d) => d.exitThickness as number)),
      forwardSlip: mean(s.filter((d) => d.forwardSlip != null).map((d) => d.forwardSlip as number)),
      meanFlowStress: mean(s.filter((d) => d.meanFlowStress != null).map((d) => d.meanFlowStress as number)),
    };
  }

  private close(sim: Sim, phase: 'done' | 'steady' | 'stalled', sample: [number, number] | null): StandResult & { growth: number[] } {
    const m = this.steadyMeans();
    let maxDamage = 0;
    let nFailed = 0;
    let mass = 0;
    let lost = 0;
    for (let p = 0; p < sim.n; p++) {
      mass += sim.mass[p];
      if (!sim.active[p]) {
        lost += sim.mass[p];
        continue;
      }
      const D = sim.governingDamage(p);
      if (D > maxDamage) maxDamage = D;
      if (sim.failed[p]) nFailed++;
    }
    // the area each crack gained in this stand: its failed mass now, less at the start, over ρ
    const rho = sim.params.material.rho * sim.params.numerics.massScale;
    const now = crackMass(sim);
    const growth = Array.from(now, (m, id) => (m - (this.crackBase[id] ?? 0)) / rho);
    let born = 0;
    for (const c of sim.cracks) if ((c.stand ?? this.stand) === this.stand) born++;
    const r = sim.params.rolling;
    return {
      stand: this.stand,
      h0: r.h0,
      sheetLength: r.sheetLength,
      particles: sim.n,
      steps: sim.step,
      t: sim.t,
      phase,
      steadyForce: m.force,
      steadyTorque: m.torque,
      exitThickness: m.exitThickness,
      forwardSlip: m.forwardSlip,
      meanFlowStress: m.meanFlowStress,
      rollRadius: sim.rolls[0].R,
      gap: sim.gap,
      rollsSettled: sim.rollsSettled,
      thicknessOut: thicknessOut(sim, sample),
      massLost: lost / mass,
      separated: separated(sim),
      cracksBorn: born,
      crackGrowth: growth.reduce((x, v) => x + v, 0),
      maxDamage,
      nFailed,
      cracks: sim.cracks.length,
      growth,
    };
  }
}

/**
 * Thickness of a sheet that has come out of the rolls: the current area of the middle half of its lattice
 * columns (Σ vol0 J) over their length along x (the columns' mean x, first to last, and one column pitch
 * more). The edges of the outermost points (the exit probe's measure) come out 0.3 % thinner than this
 * after the standard pass: the surface rows thin more than the inner ones, and their deformed height is
 * not the rows' spacing. The area measure is what the mass needs (the next stand's length is M / (ρ h)).
 * With `sample` (a 'steady' handoff: the rest of the sheet is not rolled yet) the columns are the sample's.
 */
export function thicknessOut(sim: Sim, sample: [number, number] | null = null): number {
  const { NI, NJ, lattice, px, vol0, f00, f01, f10, f11, active } = sim;
  const i0 = sample ? sample[0] : Math.floor(NI / 4);
  const i1 = sample ? sample[1] + 1 : Math.max(i0 + 2, Math.ceil((3 * NI) / 4));
  let area = 0;
  const meanX = (i: number) => {
    let s = 0;
    let c = 0;
    for (let j = 0; j < NJ; j++) {
      const p = lattice[i * NJ + j];
      if (p < 0 || !active[p]) continue;
      s += px[p];
      c++;
    }
    return s / c;
  };
  for (let i = i0; i < i1; i++) {
    for (let j = 0; j < NJ; j++) {
      const p = lattice[i * NJ + j];
      if (p < 0 || !active[p]) continue;
      area += vol0[p] * (f00[p] * f11[p] - f01[p] * f10[p]);
    }
  }
  const length = ((meanX(i1 - 1) - meanX(i0)) * (i1 - i0)) / (i1 - 1 - i0);
  // NaN when an end column of the middle half has no point on the grid (the caller stops: 'lost')
  return area / length;
}

/**
 * The steadily rolled stretch of sheet that is out of the rolls, as lattice columns [first, last] (last nearer
 * the head), or null while it is shorter than 2 h0. It starts one entry thickness past the roll centres (the
 * stresses settle over that distance) and ends a contact length short of the head: the head end went through
 * the bite with no sheet ahead of it, and its damage is 2 to 4 times the steady sheet's over about 0.6 contact
 * lengths (docs/validation.md「タンデム」). Every column of the stretch has to have a point on the grid.
 */
export function steadySample(sim: Sim): [number, number] | null {
  const { NI, NJ, lattice, px, active } = sim;
  const x0 = sim.params.rolling.h0;
  // with rolls that follow the pass (flattening, constant reduction): only what went through the settled rolls
  const x1 = Math.min(sim.headX() - sim.contactLength, sim.settledLength());
  if (Number.isNaN(x1)) return null;
  let first = -1;
  let last = -1;
  let xFirst = 0;
  let xLast = 0;
  for (let i = NI - 1; i >= 0; i--) {
    let s = 0;
    let c = 0;
    for (let j = 0; j < NJ; j++) {
      const p = lattice[i * NJ + j];
      if (p < 0 || !active[p]) continue;
      s += px[p];
      c++;
    }
    const x = c ? s / c : NaN;
    if (x > x1) continue;
    if (!(x >= x0)) {
      // behind the stretch, or a column with no point on the grid inside it
      if (c) break;
      return null;
    }
    if (last < 0) {
      last = i;
      xLast = x;
    }
    first = i;
    xFirst = x;
  }
  return last - first >= 2 && xLast - xFirst >= 2 * x0 ? [first, last] : null;
}

/** A crack through the thickness: three neighbouring lattice columns that have a failed point in every row between them. */
export function separated(sim: Sim): boolean {
  const { NI, NJ, lattice, failed } = sim;
  const rows = (i: number) => {
    const hit = new Uint8Array(NJ);
    for (let j = 0; j < NJ; j++) {
      const p = lattice[i * NJ + j];
      if (p >= 0 && failed[p]) hit[j] = 1;
    }
    return hit;
  };
  for (let i = 0; i + 2 < NI; i++) {
    const [a, b, c] = [rows(i), rows(i + 1), rows(i + 2)];
    let all = true;
    for (let j = 0; j < NJ && all; j++) all = a[j] === 1 || b[j] === 1 || c[j] === 1;
    if (all) return true;
  }
  return false;
}

/**
 * The next stand's Sim with the sheet that came out of `old` (docs/model.md「タンデム」):
 * - entry thickness h1 (measured), length M / (ρ h1) with M the old sheet's mass (so the density stays), no
 *   defects (the old points carry their ductility), a new regular lattice
 * - each new point takes the state of an old point in the same lattice row (the rows stay rows through a
 *   pass), shared out by the material along the row (every old point gets NI'/NI new ones ± 1): stresses and pressure, εp,
 *   temperature, the damage indicators, porosity and plastic volume, Drucker's sums, the localization flag,
 *   ductility, failure and crack
 * - the new point starts undeformed up to its volume: F = √J I with ln J = ev − p / K, so the pressure
 *   p = −K (ln J − ev) is what it was (F = I would set it to 0 at the first step: the pressure lives in J),
 *   and vol0 = dp² / J so that it fills its lattice cell now; the mass is the old total over the new points
 * - the crack records carry over (ids as they were; counts over the new points), and the points leave with
 *   the pusher's speed like a first stand
 * - with `sample` (a 'steady' handoff, the old sheet only partly rolled): the new sheet is the sample's columns
 *   repeated along x, as steady rolling would go on making them, each old point still with (h0 / h1)² new
 *   ones (the masses' ratio), so that what varies along the sheet (the grid's period in the damage, cracks)
 *   keeps its length and its share of the sheet. Its length is what the next stand needs to get to a 'steady'
 *   handoff itself (steadyLength), not the mass's
 */
export function remap(old: Sim, base: SimParams, h1: number, sample: [number, number] | null = null, every = READ_STEPS): [Sim, Int32Array] {
  const P = cloneParams(base);
  const rho = P.material.rho * P.numerics.massScale;
  P.rolling.h0 = h1;
  P.defects = [];
  // the strain the sheet brings in: where rolls that follow the pass start from (and the sheet before them)
  if (P.rolling.flattening === 'hitchcock' || P.rolling.gapControl === 'reduction') {
    let ep = 0;
    let c = 0;
    for (let p = 0; p < old.n; p++) {
      if (!old.active[p] || (sample && (old.li[p] < sample[0] || old.li[p] > sample[1]))) continue;
      ep += old.ep[p];
      c++;
    }
    P.rolling.entryStrain = c ? ep / c : 0;
  }
  let M = 0;
  if (sample) {
    P.rolling.sheetLength = steadyLength(P, every);
    M = rho * h1 * P.rolling.sheetLength;
  } else {
    for (let p = 0; p < old.n; p++) if (old.active[p]) M += old.mass[p];
    P.rolling.sheetLength = M / (rho * h1);
  }
  const sim = new Sim(P);
  const n = sim.n;
  const K = sim.el.K;

  // the old points by lattice row, head first (in the lattice's order: the order of the material along the row)
  const rows: number[][] = Array.from({ length: old.NJ }, () => []);
  for (let p = 0; p < old.n; p++) {
    if (old.active[p] && (!sample || (old.li[p] >= sample[0] && old.li[p] <= sample[1]))) rows[old.lj[p]].push(p);
  }
  for (const r of rows) r.sort((a, b) => old.li[b] - old.li[a]);
  // new points per old point along a row: the ratio of the masses of a lattice column's point, old to new
  const share = sample ? (old.dp * old.params.rolling.h0) / (sim.dp * h1) : 0;

  const parentOf = new Int32Array(n);
  for (let q = 0; q < n; q++) {
    // the same row (NJ is cells × ppc in both), or the nearest one that has points
    const j0 = sim.NJ === old.NJ ? sim.lj[q] : Math.round(((sim.lj[q] + 0.5) * old.NJ) / sim.NJ - 0.5);
    let j = j0;
    for (let d = 1; rows[j].length === 0 && d < old.NJ; d++) {
      if (j0 - d >= 0 && rows[j0 - d].length) j = j0 - d;
      else if (j0 + d < old.NJ && rows[j0 + d].length) j = j0 + d;
    }
    // along the row by the material: the new points are evenly spaced and of equal mass, so the k-th of a
    // row's new points takes the old point as far along the row's old points (equal masses too). Nearest in
    // the current position instead would weight the ends by how far they were stretched (the head and the
    // tail are not rolled steadily), and the damage there would move by 10 to 20 %
    // (cell-centred shares, so that every old point, the end ones too, gets NI' / NI of the new ones ± 1)
    const row = rows[j];
    if (sample) {
      // the sample over and over, from the head
      parentOf[q] = row[Math.floor((sim.NI - 1 - sim.li[q] + 0.5) / share) % row.length];
      continue;
    }
    const u = (sim.NI - 1 - sim.li[q] + 0.5) / sim.NI;
    parentOf[q] = row[Math.min(row.length - 1, Math.floor(u * row.length))];
  }

  const mass = M / n;
  const dp2 = sim.dp * sim.dp;
  for (let q = 0; q < n; q++) {
    const p = parentOf[q];
    sim.sxx[q] = old.sxx[p];
    sim.syy[q] = old.syy[p];
    sim.sxy[q] = old.sxy[p];
    sim.szz[q] = old.szz[p];
    sim.pres[q] = old.pres[p];
    sim.ep[q] = old.ep[p];
    sim.temp[q] = old.temp[p];
    sim.seq[q] = old.seq[p];
    sim.eta[q] = old.eta[p];
    sim.s1[q] = old.s1[p];
    sim.dJC[q] = old.dJC[p];
    sim.dHM[q] = old.dHM[p];
    sim.dCL[q] = old.dCL[p];
    sim.por[q] = old.por[p];
    sim.ev[q] = old.ev[p];
    sim.drW[q] = old.drW[p];
    sim.drE[q] = old.drE[p];
    sim.locHit[q] = old.locHit[p];
    sim.duct[q] = old.duct[p];
    sim.failed[q] = old.failed[p];
    sim.crackId[q] = old.crackId[p];
    const lnJ = old.ev[p] - old.pres[p] / K;
    const J = Math.exp(lnJ);
    const s = Math.sqrt(J);
    sim.f00[q] = s;
    sim.f11[q] = s;
    sim.vol0[q] = dp2 / J;
    sim.mass[q] = mass;
  }

  // the crack records, with the new points counted
  for (const c of old.cracks) sim.cracks.push({ ...c, count: 0, ...(c.areaByStand ? { areaByStand: c.areaByStand.slice() } : {}) });
  for (let q = 0; q < n; q++) if (sim.crackId[q] >= 0) sim.cracks[sim.crackId[q]].count++;
  return [sim, parentOf];
}

/**
 * The sheet length a stand needs to get to a 'steady' handoff (P is the stand's condition, h0 its entry
 * thickness): what fills the bite (a contact length at most), what has to come out by then (the head at
 * 3 h0 + a contact length for steadySample, or STEADY_READS readings after the exit probe, whichever is later,
 * and one reading more, for the readings fall where they fall), × (1 − r) back to entry length, and one h0 over.
 */
export function steadyLength(P: SimParams, every: number): number {
  // a Sim of any length has the stand's dt, contact length, exit probe and entry speed
  const probe = new Sim(P);
  const r = P.rolling;
  const read = every * probe.dt * probe.vIn;
  const out = Math.max((3 * r.h0 + probe.contactLength) * (1 - r.reduction), probe.xExitProbe * (1 - r.reduction) + STEADY_READS * read);
  // rolls that follow the pass settle 1.5 transit times after the head is out (docs/validation.md「ロール偏平と圧下率一定」),
  // and the stretch is the sheet rolled after that
  const settle = probe.rollsAdjusted ? 2 * probe.contactLength + 3 * r.h0 * (1 - r.reduction) : 0;
  return probe.contactLength + out + settle + read + r.h0;
}

/** per crack id, the mass of the failed points in it (every point, on the grid or not) */
function crackMass(sim: Sim): Float64Array {
  const m = new Float64Array(sim.cracks.length);
  for (let p = 0; p < sim.n; p++) {
    const id = sim.crackId[p];
    if (id >= 0 && sim.failed[p]) m[id] += sim.mass[p];
  }
  return m;
}
