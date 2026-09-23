// The steady values of the three-dimensional model, read the same way by tools/solid.mjs and the page's
// worker: a look every READ_STEPS steps; the looks taken while the pass is 'steady' are averaged (the
// contact sums weighted by their steps).
import type { Sim3, SolidPhase } from './sim3.ts';

export const READ_STEPS = 500;

export interface SolidLook {
  phase: SolidPhase;
  /** roll force on one roll over the whole width [N], torque [N m] */
  force: number;
  torque: number;
  /** half width and mid-width half thickness at the exit probe [m]; null until the head is there */
  halfWidth: number | null;
  centreHalfThickness: number | null;
}

export interface SolidSteady {
  looks: number;
  /** roll force on one roll over the whole width [N] and its torque [N m] */
  force: number;
  torque: number;
  /** normal force per unit width by grid column from the mid-width out [N/m] */
  forceByZ: number[];
  /** contact pressure by (x column, z column) [Pa], x columns from binX0 [m], both h apart */
  pressureMap: number[];
  mapCols: number;
  mapRows: number;
  /** at the exit probe: half width [m], spread W1/W0 − 1, the half thickness by lattice column from the mid-width out [m], forward slip */
  halfWidth: number;
  spread: number;
  halfThickness: number[];
  forwardSlip: number;
  /** the roll's deflection away from the strip at the mid-width and at the strip's edge (its entry half width) [m]; null with rigid rolls */
  rollBend: { centre: number; edge: number } | null;
}

export class SolidSampler {
  private steps = 0;
  private looks = 0;
  private force = 0;
  private torque = 0;
  private byZ: Float64Array | null = null;
  private map: Float64Array | null = null;
  private hw = 0;
  private slip = 0;
  private thick: Float64Array | null = null;
  private thickN: Int32Array | null = null;
  private gauges = 0;
  private bendCentre = 0;
  private bendEdge = 0;
  last: SolidLook | null = null;

  /** steady looks so far */
  get count(): number {
    return this.looks;
  }

  /** call when sim.step is a multiple of READ_STEPS */
  look(sim: Sim3): SolidLook {
    const phase = sim.phase();
    const c = sim.readContact();
    const ex = sim.exitMeasure();
    const look: SolidLook = {
      phase,
      force: c?.force ?? 0,
      torque: c?.torque ?? 0,
      halfWidth: ex?.halfWidth ?? null,
      centreHalfThickness: ex && Number.isFinite(ex.halfThickness[0]) ? ex.halfThickness[0] : null,
    };
    this.last = look;
    if (phase !== 'steady' || !c) return look;
    this.looks++;
    this.steps += c.steps;
    this.force += c.force * c.steps;
    this.torque += c.torque * c.steps;
    this.byZ ??= new Float64Array(c.byZ.length);
    this.map ??= new Float64Array(c.map.length);
    for (let i = 0; i < c.byZ.length; i++) this.byZ[i] += c.byZ[i] * c.steps;
    for (let i = 0; i < c.map.length; i++) this.map[i] += c.map[i] * c.steps;
    if (sim.beam) {
      this.bendCentre += sim.bend[1] * c.steps;
      this.bendEdge += sim.bendAt(sim.halfWidth0) * c.steps;
    }
    if (ex) {
      this.gauges++;
      this.hw += ex.halfWidth;
      this.slip += ex.speed / sim.params.rolling.rollSpeed - 1;
      this.thick ??= new Float64Array(ex.halfThickness.length);
      this.thickN ??= new Int32Array(ex.halfThickness.length);
      for (let k = 0; k < ex.halfThickness.length; k++) {
        if (!Number.isFinite(ex.halfThickness[k])) continue;
        this.thick[k] += ex.halfThickness[k];
        this.thickN[k]++;
      }
    }
    return look;
  }

  means(sim: Sim3): SolidSteady | null {
    if (this.looks === 0 || this.gauges === 0) return null;
    const s = this.steps;
    const hw = this.hw / this.gauges;
    return {
      looks: this.looks,
      force: this.force / s,
      torque: this.torque / s,
      forceByZ: Array.from(this.byZ!, (v) => v / s),
      pressureMap: Array.from(this.map!, (v) => v / s),
      mapCols: sim.nBinsX,
      mapRows: sim.nzN - 1,
      halfWidth: hw,
      spread: hw / sim.halfWidth0 - 1,
      halfThickness: Array.from(this.thick!, (v, k) => (this.thickN![k] ? v / this.thickN![k] : NaN)),
      forwardSlip: this.slip / this.gauges,
      rollBend: sim.beam ? { centre: this.bendCentre / s, edge: this.bendEdge / s } : null,
    };
  }
}
