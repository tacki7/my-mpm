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
  /** at the exit probe, by lattice column from the mid-width out: where the column is [m], its speed [m/s], its longitudinal stress [Pa] */
  exitZ: number[];
  exitSpeedByZ: number[];
  exitStressByZ: number[];
  /**
   * The strip's flatness by lattice column, in I-units (10⁻⁵ of strain): the elongation each fibre would have if it
   * were free of the others, ln(v / v_in) − σxx / E (the strip leaves as one body, so a fibre rolled longer carries
   * less tension than its neighbours: what a shape meter reads), less the mean over the width. Positive at the
   * middle: centre buckle; positive at the edge: wavy edge. Read at the exit probe, 3 h0 past the rolls: further
   * along a short strip the free head end lets the stress go (docs/model.md「板クラウンと平坦度」)
   */
  flatness: number[];
  /**
   * The strip's crown at the entry (the input) and at the exit [m]: the thickness at the mid-width less the edge's,
   * the exit's from a parabola fitted to the columns' thicknesses (the lattice's stripes across the width, ±2 µm at
   * 4 cells, would swamp the difference of two columns)
   */
  crownIn: number;
  crownOut: number;
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
  private colZ: Float64Array | null = null;
  private colV: Float64Array | null = null;
  private colS: Float64Array | null = null;
  private colN: Int32Array | null = null;
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
      const nk = ex.halfThickness.length;
      this.thick ??= new Float64Array(nk);
      this.thickN ??= new Int32Array(nk);
      this.colZ ??= new Float64Array(nk);
      this.colV ??= new Float64Array(nk);
      this.colS ??= new Float64Array(nk);
      this.colN ??= new Int32Array(nk);
      for (let k = 0; k < nk; k++) {
        if (Number.isFinite(ex.halfThickness[k])) {
          this.thick[k] += ex.halfThickness[k];
          this.thickN[k]++;
        }
        if (Number.isFinite(ex.speedByZ[k]) && Number.isFinite(ex.stressByZ[k])) {
          this.colZ[k] += ex.z[k];
          this.colV[k] += ex.speedByZ[k];
          this.colS[k] += ex.stressByZ[k];
          this.colN[k]++;
        }
      }
    }
    return look;
  }

  means(sim: Sim3): SolidSteady | null {
    if (this.looks === 0 || this.gauges === 0) return null;
    const s = this.steps;
    const hw = this.hw / this.gauges;
    const halfThickness = Array.from(this.thick!, (v, k) => (this.thickN![k] ? v / this.thickN![k] : NaN));
    const per = (arr: Float64Array) => Array.from(arr, (v, k) => (this.colN![k] ? v / this.colN![k] : NaN));
    const exitSpeedByZ = per(this.colV!);
    const exitStressByZ = per(this.colS!);
    // each fibre's elongation less the mean over the columns that have a reading, in I-units
    const centred = (e: number[]): number[] => {
      const good = e.filter(Number.isFinite);
      const mean = good.length ? good.reduce((a, b) => a + b, 0) / good.length : NaN;
      return e.map((v) => (v - mean) * 1e5);
    };
    const E = sim.youngs;
    const flatness = centred(exitSpeedByZ.map((v, k) => Math.log(v / sim.vIn) - exitStressByZ[k] / E));
    // the exit crown: 2 h(z) = a + b z² fitted over the columns, crown = −b hw² with hw the edge column's z
    const exitZ = per(this.colZ!);
    let crownOut = NaN;
    {
      let n = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      let hwOut = 0;
      for (let k = 0; k < halfThickness.length; k++) {
        const x = exitZ[k] * exitZ[k];
        const y = 2 * halfThickness[k];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        n++;
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
        hwOut = Math.max(hwOut, exitZ[k]);
      }
      const det = n * sxx - sx * sx;
      if (n >= 3 && det > 0) crownOut = (-(n * sxy - sx * sy) / det) * hwOut * hwOut;
    }
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
      halfThickness,
      forwardSlip: this.slip / this.gauges,
      rollBend: sim.beam ? { centre: this.bendCentre / s, edge: this.bendEdge / s } : null,
      exitZ,
      exitSpeedByZ,
      exitStressByZ,
      flatness,
      crownIn: sim.params.solid.crownIn ?? 0,
      crownOut,
    };
  }
}
