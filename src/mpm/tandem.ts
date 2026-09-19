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
import { cloneParams, type SimParams } from './params.ts';
import { Sim, type Crack, type Diagnostics } from './solver.ts';

export const MAX_STANDS = 5;
/**
 * Steps between a stand's own readings (tools/run.mjs's --every): the roll force and torque over the window,
 * the exit gauge and the phase. A stand ends at the reading that finds it 'done', so the stands, their
 * results and the next stand's start are the same for every caller that steps the tandem.
 */
export const READ_STEPS = 2000;

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
  /** how it ended: 'done', or 'stalled' (the rolls could not draw the sheet in; no stand after it) */
  phase: 'done' | 'stalled';
  /** means over the steady readings, as tools/run.mjs takes them over its reads; null without one */
  steadyForce: number | null;
  steadyTorque: number | null;
  exitThickness: number | null;
  forwardSlip: number | null;
  /** thickness of the sheet that came out (area over length of its middle half; the next stand's h0) */
  thicknessOut: number;
  /** the fraction of the stand's mass on points that left the grid (0 normally) */
  massLost: number;
  /** a crack goes through the thickness: three neighbouring lattice columns have a failed point in every row */
  separated: boolean;
  maxDamage: number;
  nFailed: number;
  /** crack records so far, this stand's and the stands' before */
  cracks: number;
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
}

export class TandemSim {
  readonly stands: number;
  /** steps between the stand's own readings */
  readonly every: number;
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

  constructor(params: SimParams, stands: number, every = READ_STEPS) {
    if (!(Number.isInteger(stands) && stands >= 1 && stands <= MAX_STANDS)) throw new Error(`stands must be 1 to ${MAX_STANDS}`);
    if (!(Number.isInteger(every) && every > 0)) throw new Error('every must be a positive whole number of steps');
    this.stands = stands;
    this.every = every;
    this.base = cloneParams(params);
    this.sim = new Sim(params);
  }

  /**
   * One step of the current stand; every `every` steps its own reading. A stand with another after it ends
   * at the first step it is 'done' (or stalled): later, a front tension would pull the rolled sheet on and
   * out of the grid. The last stand ends at the reading that finds it done, as tools/run.mjs reads a
   * single pass. Ending here: the stand's result, onStandDone, and the remap into the next stand (sim is
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
      });
    }
    if (phase === 'done' || phase === 'stalled') this.endStand(phase);
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

  private endStand(phase: 'done' | 'stalled'): void {
    const old = this.sim;
    const result = this.close(old, phase);
    this.results.push(result);
    // a tandem of more than one stand marks its records with the stand; a single stand leaves them as the single pass has them
    if (this.stands > 1) for (const c of old.cracks) if (c.stand === undefined) c.stand = this.stand;
    const more = this.stand + 1 < this.stands;
    if (more) {
      this.stopped =
        phase === 'stalled' ? 'stalled' : result.separated ? 'separated' : result.massLost > 0 || !(result.thicknessOut > 0) ? 'lost' : null;
    }
    const [next, parentOf] = more && !this.stopped ? remap(old, this.base, result.thicknessOut) : [null, null];
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

  private close(sim: Sim, phase: 'done' | 'stalled'): StandResult {
    const s = this.steady;
    // as tools/run-summary.mjs: the plain mean over the readings (a thickness of 0 counts as none)
    const mean = (a: number[]) => (a.length ? a.reduce((x, v) => x + v, 0) / Math.max(1, a.length) : null);
    let maxDamage = 0;
    let nFailed = 0;
    let mass = 0;
    let lost = 0;
    for (let p = 0; p < sim.n; p++) {
      const D = sim.governingDamage(p);
      if (D > maxDamage) maxDamage = D;
      if (sim.failed[p]) nFailed++;
      mass += sim.mass[p];
      if (!sim.active[p]) lost += sim.mass[p];
    }
    const r = sim.params.rolling;
    return {
      stand: this.stand,
      h0: r.h0,
      sheetLength: r.sheetLength,
      particles: sim.n,
      steps: sim.step,
      t: sim.t,
      phase,
      steadyForce: mean(s.map((d) => d.force)),
      steadyTorque: mean(s.map((d) => d.torque)),
      exitThickness: mean(s.filter((d) => d.exitThickness).map((d) => d.exitThickness as number)),
      forwardSlip: mean(s.filter((d) => d.forwardSlip != null).map((d) => d.forwardSlip as number)),
      thicknessOut: thicknessOut(sim),
      massLost: lost / mass,
      separated: separated(sim),
      maxDamage,
      nFailed,
      cracks: sim.cracks.length,
    };
  }
}

/**
 * Thickness of a sheet that has come out of the rolls: the current area of the middle half of its lattice
 * columns (Σ vol0 J) over their length along x (the columns' mean x, first to last, and one column pitch
 * more). The edges of the outermost points (the exit probe's measure) come out 0.3 % thinner than this
 * after the standard pass: the surface rows thin more than the inner ones, and their deformed height is
 * not the rows' spacing. The area measure is what the mass needs (the next stand's length is M / (ρ h)).
 */
export function thicknessOut(sim: Sim): number {
  const { NI, NJ, lattice, px, vol0, f00, f01, f10, f11, active } = sim;
  const i0 = Math.floor(NI / 4);
  const i1 = Math.max(i0 + 2, Math.ceil((3 * NI) / 4));
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
 */
export function remap(old: Sim, base: SimParams, h1: number): [Sim, Int32Array] {
  const P = cloneParams(base);
  let M = 0;
  for (let p = 0; p < old.n; p++) if (old.active[p]) M += old.mass[p];
  const rho = P.material.rho * P.numerics.massScale;
  P.rolling.h0 = h1;
  P.rolling.sheetLength = M / (rho * h1);
  P.defects = [];
  const sim = new Sim(P);
  const n = sim.n;
  const K = sim.el.K;

  // the old points by lattice row, head first (in the lattice's order: the order of the material along the row)
  const rows: number[][] = Array.from({ length: old.NJ }, () => []);
  for (let p = 0; p < old.n; p++) if (old.active[p]) rows[old.lj[p]].push(p);
  for (const r of rows) r.sort((a, b) => old.li[b] - old.li[a]);

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
  for (const c of old.cracks) sim.cracks.push({ ...c, count: 0 });
  for (let q = 0; q < n; q++) if (sim.crackId[q] >= 0) sim.cracks[sim.crackId[q]].count++;
  return [sim, parentOf];
}
