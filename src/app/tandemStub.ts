// TEMPORARY stand-in for src/mpm/tandem.ts (T39, in progress elsewhere) with the same API (v2 as agreed with
// T39: the stand reads and moves on inside advance()), so the page can be built before it lands. It does NOT
// carry the material state over: each stand is a fresh Sim with the measured exit thickness as its entry
// thickness and the rolled length, and parentOf maps a new point to the old one at the same relative lattice
// position. Replace the import with '../mpm/tandem.ts'.
import { cloneParams, type SimParams } from '../mpm/params.ts';
import { Sim, type Crack, type Diagnostics } from '../mpm/solver.ts';

export const MAX_STANDS = 5;

export interface StandResult {
  stand: number;
  h0: number;
  sheetLength: number;
  particles: number;
  steps: number;
  t: number;
  steadyForce: number | null;
  steadyTorque: number | null;
  exitThickness: number | null;
  forwardSlip: number | null;
  thicknessOut: number | null;
  maxDamage: number;
  nFailed: number;
  cracks: number;
}

export interface StandDone {
  stand: number;
  sim: Sim;
  next: Sim | null;
  parentOf: Int32Array | null;
  result: StandResult;
}

export class TandemSim {
  readonly stands: number;
  stand = 0;
  sim: Sim;
  results: StandResult[] = [];
  parentOf: Int32Array | null = null;
  tOffset = 0;
  stepOffset = 0;
  onStandDone: ((e: StandDone) => void) | null = null;
  private readonly base: SimParams;
  private reads: Diagnostics[] = [];
  private finished = false;
  private readonly every: number;

  constructor(params: SimParams, stands: number, every = 2000) {
    this.base = cloneParams(params);
    this.stands = Math.max(1, Math.min(MAX_STANDS, Math.round(stands)));
    this.every = every;
    this.sim = new Sim(params);
  }

  /** one step of the current stand; every `every` steps a read, and a stand read done is closed and the next one set up */
  advance(): void {
    this.sim.advance();
    // one stand: the stand-in stays out of the way (its reads would reset the page's force accumulators)
    if (this.stands === 1 || this.sim.step % this.every !== 0) return;
    // (the stand-in reads through sim.diagnostics(), which the page's own calls reset: T39 does not)
    this.reads.push(this.sim.diagnostics());
    if (!this.finished) this.next();
  }

  diagnostics(): Diagnostics & { stand: number; stands: number } {
    return { ...this.sim.diagnostics(), stand: this.stand, stands: this.stands };
  }

  get done(): boolean {
    return this.finished;
  }

  get cracks(): (Crack & { stand: number })[] {
    return this.sim.cracks.map((c) => ({ ...c, stand: this.stand }));
  }

  /** the current stand is done: close its result and move to the next stand (false after the last) */
  private next(): boolean {
    const ph = this.sim.phase();
    if (ph !== 'done' && ph !== 'stalled') return false;
    const s = this.sim;
    const steady = this.reads.filter((d) => d.phase === 'steady');
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const d = s.diagnostics();
    const result: StandResult = {
      stand: this.stand,
      h0: s.params.rolling.h0,
      sheetLength: s.params.rolling.sheetLength,
      particles: s.n,
      steps: s.step,
      t: s.t,
      steadyForce: mean(steady.map((r) => r.rollForce)),
      steadyTorque: mean(steady.map((r) => r.rollTorque)),
      exitThickness: mean(steady.filter((r) => r.exitThickness != null).map((r) => r.exitThickness!)),
      forwardSlip: mean(steady.filter((r) => r.forwardSlip != null).map((r) => r.forwardSlip!)),
      thicknessOut: mean(steady.filter((r) => r.exitThickness != null).map((r) => r.exitThickness!)),
      maxDamage: d.maxDamage,
      nFailed: d.nFailed,
      cracks: s.cracks.length,
    };
    this.results.push(result);
    const last = this.stand >= this.stands - 1 || ph === 'stalled';
    let next: Sim | null = null;
    let parentOf: Int32Array | null = null;
    if (!last) {
      const p = cloneParams(this.base);
      const h1 = result.thicknessOut ?? s.params.rolling.h0 * (1 - s.params.rolling.reduction);
      p.rolling.h0 = h1;
      p.rolling.sheetLength = (s.params.rolling.sheetLength * s.params.rolling.h0) / h1;
      next = new Sim(p);
      parentOf = new Int32Array(next.n);
      for (let i = 0; i < next.n; i++) {
        const li = Math.min(s.NI - 1, Math.floor(((next.li[i] + 0.5) * s.NI) / next.NI));
        const lj = Math.min(s.NJ - 1, Math.floor(((next.lj[i] + 0.5) * s.NJ) / next.NJ));
        parentOf[i] = s.lattice[li * s.NJ + lj];
      }
    }
    this.onStandDone?.({ stand: this.stand, sim: s, next, parentOf, result });
    if (last || !next) {
      this.finished = true;
      return false;
    }
    this.tOffset += s.t;
    this.stepOffset += s.step;
    this.sim = next;
    this.parentOf = parentOf;
    this.stand++;
    this.reads = [];
    return true;
  }
}
