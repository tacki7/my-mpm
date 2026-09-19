// 2D plane-strain MPM of a sheet passing between two rigid rolls.
//
// Scheme (see docs/model.md for the equations and their sources):
// - quadratic B-spline shape functions, MLS-MPM / APIC transfers (Hu et al. 2018),
//   explicit time integration (as the Uintah MPM of Banerjee, arXiv:1201.2439)
// - hypoelastic-plastic material: Jaumann-rotated deviatoric stress, pressure
//   from the logarithmic volume change, J2 radial return with Johnson-Cook or
//   Swift hardening
// - or the Gurson-Tvergaard-Needleman yield condition with porosity growth and
//   nucleation; the plastic volume change is kept per point and taken out of the
//   pressure
// - damage indicators accumulated on the plastic strain increment (Johnson-Cook,
//   Hancock-MacKenzie, Cockcroft-Latham, porosity / fc); a particle whose governing
//   indicator reaches 1 fails and carries no deviatoric stress from then on
// - the rolls are analytic rigid cylinders; contact is a Coulomb-friction
//   velocity projection on the grid nodes on the roll side of a penetrating
//   particle, which also carry the normal velocity it needs to follow the roll
//
// World frame: x along rolling (the exit plane of the rigid rolls is x = 0),
// y through the thickness (mid-plane y = 0). Everything per unit width.
import { biteGeometry, cloneParams, type DamageModel, type SimParams } from './params.ts';
import { druckerWork, localization } from './bifurcation.ts';
import {
  adiabaticRise,
  elasticConstants,
  flowStress,
  gtnReturn,
  hmFractureStrain,
  homologousTemperature,
  jcFractureStrain,
  plasticIncrement,
  type Elastic,
} from './material.ts';

export interface Roll {
  cx: number;
  cy: number;
  R: number;
  /** angular velocity [rad/s], counter-clockwise positive */
  omega: number;
}

export interface Crack {
  id: number;
  /** time and step of the first failure of this crack */
  t: number;
  step: number;
  /** world position where it initiated [m] */
  x: number;
  y: number;
  /** where that material point sat in the undeformed sheet: from the head end backwards, from the mid-plane [m] */
  sheetX: number;
  sheetY: number;
  /** stress state of the first failed point at failure */
  eta: number;
  s1: number;
  seq: number;
  ep: number;
  criterion: DamageModel;
  /** failed points that belong to this crack */
  count: number;
}

export type Phase = 'approach' | 'bite' | 'steady' | 'tail-out' | 'done' | 'stalled';

export interface Diagnostics {
  t: number;
  step: number;
  dt: number;
  nActive: number;
  phase: Phase;
  headX: number;
  tailX: number;
  /** roll separating force per unit width, mean of both rolls, averaged since the last read [N/m] */
  rollForce: number;
  /** roll torque per unit width, mean of both rolls (driving = positive) [N·m/m] */
  rollTorque: number;
  /** force the pusher applied to the tail since the last read [N/m] */
  pusherForce: number;
  pusherActive: boolean;
  /** tension stresses applied now, after ramping [Pa] */
  backTension: number;
  frontTension: number;
  /** thickness measured at the exit probe (null until the head reaches it) [m] */
  exitThickness: number | null;
  /** mean sheet speed at the exit probe / roll surface speed − 1 */
  forwardSlip: number | null;
  /** neutral point: where the friction on the sheet turns from +x (entry side) to −x, averaged since the last read; null without one [m] */
  neutralX: number | null;
  maxDamage: number;
  nFailed: number;
  cracks: number;
  plasticWork: number; // [J/m]
  /**
   * How far from quasi-static the condition is, before running: the inertia pressure of the
   * (mass-scaled) strip ρ ms V² r over the mean plane-strain flow stress 2k̄ of the pass
   */
  inertiaRatio: number;
  /**
   * The same, measured: the kinetic energy the rolls put into the strip per second, ṁ (v1² − v0²)/2,
   * over the plastic work per second, since the last read (steady phase only; null otherwise).
   * Each diagnostics() call closes the interval, so reading it from a second place shortens it.
   */
  kineticRatio: number | null;
}

export interface PressureProfile {
  /** bin centres [m] */
  x: Float64Array;
  /** normal and tangential (+x) force on the sheet per unit length along x [Pa], mean of both rolls */
  p: Float64Array;
  tau: Float64Array;
}

export type FieldName =
  | 'seq'
  | 'pres'
  | 'eta'
  | 's1'
  | 'ep'
  | 'damage'
  | 'dJC'
  | 'dHM'
  | 'dCL'
  | 'porosity'
  | 'dT'
  | 'loc'
  | 'drucker'
  | 'sxx'
  | 'syy'
  | 'sxy'
  | 'szz'
  | 'vx'
  | 'lagrange';

const INF = 1e30;
const DRUCKER_DECAY = 1 - 1 / 64;

export class Sim {
  readonly params: SimParams;
  readonly el: Elastic;
  readonly h: number; // grid spacing
  readonly invH: number;
  readonly dp: number; // initial particle spacing
  readonly ox: number; // grid origin
  readonly oy: number;
  readonly nxN: number; // nodes along x
  readonly nyN: number;
  readonly dt: number;
  readonly rolls: Roll[];
  readonly gap: number;
  readonly contactLength: number;
  readonly xExitProbe: number;
  readonly xHead0: number;
  readonly vIn: number; // initial / pusher speed

  // grid
  readonly gm: Float64Array;
  readonly gvx: Float64Array;
  readonly gvy: Float64Array;
  readonly gpen: Float64Array[]; // per roll: min over contributing particles of (distance to roll surface − particle half size)
  readonly gpush: Uint8Array;
  readonly gJ: Float64Array; // J-bar: mass-weighted trial volume ratio ('total') or volumetric rate ('rate')
  readonly gJe: Float64Array; // 'rate': β_i × mass-weighted mean of the elastic log volume ln J − ev
  readonly gB: Float64Array; // 'rate': mass-weighted relaxation fraction β_i
  readonly gMv: Float64Array; // 'rate': nodal mass of the points in the averages (intact, J > 0)
  readonly gcon: Uint8Array; // this step: bit k set when roll k constrains the node
  private readonly gfolN: Float64Array; // 'surface': Σ w m (requested normal velocity change) per node
  private readonly gfolD: Float64Array; // Σ w m

  // particles (lattice order: index = i * NJ + j, i from the tail)
  readonly n: number;
  readonly NI: number;
  readonly NJ: number;
  /** lattice columns at each end that stand for the grip (coiler / pay-off reel), h0 long: a tension is shared by
   *  them, and a point there does not fail (damage is still shown) */
  readonly gripCols: number;
  readonly lattice: Int32Array; // lattice cell → particle index (−1: void)
  readonly li: Int32Array;
  readonly lj: Int32Array;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly c00: Float64Array;
  readonly c01: Float64Array;
  readonly c10: Float64Array;
  readonly c11: Float64Array;
  readonly f00: Float64Array;
  readonly f01: Float64Array;
  readonly f10: Float64Array;
  readonly f11: Float64Array;
  readonly mass: Float64Array;
  readonly vol0: Float64Array;
  readonly x0: Float64Array; // initial position
  readonly y0: Float64Array;
  // deviatoric stress (plane strain: zz is out of plane) and pressure (compression positive)
  readonly sxx: Float64Array;
  readonly syy: Float64Array;
  readonly sxy: Float64Array;
  readonly szz: Float64Array;
  readonly pres: Float64Array;
  readonly ep: Float64Array;
  readonly temp: Float64Array;
  readonly seq: Float64Array;
  readonly eta: Float64Array;
  readonly s1: Float64Array;
  readonly dJC: Float64Array;
  readonly dHM: Float64Array;
  readonly dCL: Float64Array;
  /** nonlocal damage: this step's increments of JC, HM, CL, averaged over the grid before they add up */
  private nlInc: Float64Array[] | null = null;
  private nlMass: Float64Array | null = null;
  private nlGrid: Float64Array | null = null;
  readonly por: Float64Array; // porosity f (GTN)
  readonly ev: Float64Array; // plastic volume strain Σ tr Δεp (GTN): p = −K (ln J − ev)
  readonly flowRate: Float64Array; // equivalent strain rate [1/s] of the last step if the point flowed (J2), −1 if not
  // Drucker's σ̇ : Dp / ε̇p² = Σ Δσ:Δεp / Σ Δεp² over the recent plastic steps (weight DRUCKER_DECAY = 1 − 1/64 per step):
  // one step alone is dominated by the noise of the elastic trial
  readonly drW: Float64Array;
  readonly drE: Float64Array;
  readonly locHit: Uint8Array; // 1 once the acoustic tensor turned singular (damage model 'localization')
  readonly duct: Float64Array; // ductility multiplier (defects)
  readonly dJ: Float64Array; // trial volume ratio J ('total') or volumetric rate tr L ('rate') of the current step
  readonly vr: Float64Array; // 'rate': 3K Δεp / σeq of the last step (the relaxation fraction per unit coefficient)
  readonly active: Uint8Array;
  readonly failed: Uint8Array;
  readonly tag: Uint8Array; // 1 tail column, 2 head column
  readonly touch: Uint8Array; // this step: bit k set when the point's edge is inside roll k (P2G)
  readonly crackId: Int32Array;

  t = 0;
  step = 0;
  pusherActive = true;
  /** tension stresses applied at this step, after ramping [Pa] */
  backNow = 0;
  frontNow = 0;
  /** end column height / Σ w |F e_y| dp over the tail's and the head's grips (see gripScale) */
  private backScale = 1;
  private frontScale = 1;
  /** time the front tension was switched on (head past the exit probe), and the back tension released (tail at the entry); −1: not yet */
  private frontOnAt = -1;
  private backOffAt = -1;
  /** ramp time of the tensions [s] */
  readonly tensionRamp: number;
  plasticWork = 0;
  /** true once the sheet has stopped after the pusher let go (friction could not draw it in) */
  stalled = false;
  private slowSince = -1;
  readonly inertiaRatio: number;
  private lastWork = 0;
  private lastWorkT = 0;
  readonly cracks: Crack[] = [];

  // accumulators since the last diagnostics read
  private accSteps = 0;
  private accFy = [0, 0];
  private accTorque = [0, 0];
  private accPush = 0;
  // the last averages, repeated when nothing was stepped in between (e.g. a read while paused)
  private lastForce = 0;
  private lastTorque = 0;
  private lastPush = 0;
  private lastNeutral: number | null = null;
  // contact traction bins (both rolls), one per grid column
  readonly binCol0: number; // grid column of the first bin
  readonly binX0: number; // left edge of the first bin
  readonly binW: number;
  readonly nBins: number;
  private readonly binN: Float64Array;
  private readonly binT: Float64Array;
  private binSteps = 0;
  private readonly lastP: Float64Array; // the last profile, repeated when nothing was stepped in between
  private readonly lastTau: Float64Array;
  private readonly accTau: Float64Array; // tangential force per bin since the last diagnostics read

  constructor(input: SimParams) {
    const P = cloneParams(input);
    this.params = P;
    const r = P.rolling;
    const num = P.numerics;
    this.el = elasticConstants(P.material);
    const geo = biteGeometry(r);
    this.gap = geo.gap;
    this.contactLength = geo.contactLength;

    const h = r.h0 / num.cellsThrough;
    this.h = h;
    this.invH = 1 / h;
    const dp = h / num.ppc;
    this.dp = dp;

    // Sheet starts with its head a little before the entry of the bite.
    const Lc = geo.contactLength;
    this.xHead0 = -Lc - Math.max(2 * r.h0, 4 * h);
    const xTail0 = this.xHead0 - r.sheetLength;
    // Enough room for the whole sheet to come out on the exit side.
    const elongated = r.sheetLength / (1 - r.reduction);
    const xEnd = 2 * r.h0 + 2 * h + elongated * 1.1 + 8 * h;
    const yHalf = r.h0 / 2 + 4 * h;
    this.ox = xTail0 - 6 * h;
    this.oy = -yHalf;
    this.nxN = Math.ceil((xEnd - this.ox) / h) + 1;
    this.nyN = Math.ceil((2 * yHalf) / h) + 1;
    const nNodes = this.nxN * this.nyN;
    this.gm = new Float64Array(nNodes);
    this.gvx = new Float64Array(nNodes);
    this.gvy = new Float64Array(nNodes);
    this.gpen = [new Float64Array(nNodes), new Float64Array(nNodes)];
    this.gpush = new Uint8Array(nNodes);
    this.gcon = new Uint8Array(nNodes);
    this.gfolN = new Float64Array(nNodes);
    this.gfolD = new Float64Array(nNodes);
    this.gJ = new Float64Array(nNodes);
    this.gJe = new Float64Array(nNodes);
    this.gB = new Float64Array(nNodes);
    this.gMv = new Float64Array(nNodes);

    const R = r.rollRadius;
    const cy = R + this.gap / 2;
    const omega = r.rollSpeed / R;
    this.rolls = [
      { cx: 0, cy, R, omega }, // top: counter-clockwise → bottom surface moves +x
      { cx: 0, cy: -cy, R, omega: -omega },
    ];
    this.xExitProbe = Math.max(3 * r.h0, 6 * h);

    // Material points on a regular lattice.
    const NI = Math.round(r.sheetLength / dp);
    const NJ = Math.round(r.h0 / dp);
    this.NI = NI;
    // h0 of strip at each end, but never more than half the strip
    this.gripCols = Math.max(1, Math.min(Math.round(r.h0 / dp), Math.floor(NI / 2)));
    this.NJ = NJ;
    const lattice = new Int32Array(NI * NJ).fill(-1);
    const keep: number[] = [];
    const ductOf: number[] = [];
    for (let i = 0; i < NI; i++) {
      for (let j = 0; j < NJ; j++) {
        const X = xTail0 + (i + 0.5) * dp;
        const Y = -r.h0 / 2 + (j + 0.5) * dp;
        const sx = this.xHead0 - X; // sheet coordinate from the head
        let inVoid = false;
        let duct = 1;
        for (const d of P.defects) {
          const u = (sx - d.x) / d.ax;
          const v = (Y - d.y) / d.ay;
          if (u * u + v * v <= 1) {
            if (d.kind === 'void') inVoid = true;
            else duct = Math.min(duct, d.ductility ?? 0.3);
          }
        }
        if (inVoid) continue;
        lattice[i * NJ + j] = keep.length;
        keep.push(i * NJ + j);
        ductOf.push(duct);
      }
    }
    const n = keep.length;
    this.n = n;
    this.lattice = lattice;
    const F = () => new Float64Array(n);
    this.li = new Int32Array(n);
    this.lj = new Int32Array(n);
    this.px = F();
    this.py = F();
    this.vx = F();
    this.vy = F();
    this.c00 = F();
    this.c01 = F();
    this.c10 = F();
    this.c11 = F();
    this.f00 = F();
    this.f01 = F();
    this.f10 = F();
    this.f11 = F();
    this.mass = F();
    this.vol0 = F();
    this.x0 = F();
    this.y0 = F();
    this.sxx = F();
    this.syy = F();
    this.sxy = F();
    this.szz = F();
    this.pres = F();
    this.ep = F();
    this.temp = F();
    this.seq = F();
    this.eta = F();
    this.s1 = F();
    this.dJC = F();
    this.dHM = F();
    this.dCL = F();
    this.por = F();
    this.ev = F();
    this.flowRate = F().fill(-1);
    this.drW = F();
    this.drE = F();
    this.locHit = new Uint8Array(n);
    this.duct = F();
    this.dJ = F();
    this.vr = F();
    this.active = new Uint8Array(n);
    this.failed = new Uint8Array(n);
    this.tag = new Uint8Array(n);
    this.touch = new Uint8Array(n);
    this.crackId = new Int32Array(n).fill(-1);

    // Entry speed from mass flow, a little under the roll speed.
    this.vIn = r.rollSpeed * (1 - r.reduction);
    const rho = P.material.rho * num.massScale;
    for (let k = 0; k < n; k++) {
      const cell = keep[k];
      const i = Math.floor(cell / NJ);
      const j = cell - i * NJ;
      this.li[k] = i;
      this.lj[k] = j;
      const X = xTail0 + (i + 0.5) * dp;
      const Y = -r.h0 / 2 + (j + 0.5) * dp;
      this.px[k] = X;
      this.py[k] = Y;
      this.x0[k] = X;
      this.y0[k] = Y;
      this.vx[k] = this.vIn;
      this.f00[k] = 1;
      this.f11[k] = 1;
      this.vol0[k] = dp * dp;
      this.mass[k] = rho * dp * dp;
      this.temp[k] = P.material.tRoom;
      this.duct[k] = ductOf[k];
      if (P.damage.yield === 'gtn') this.por[k] = P.damage.gtn.f0;
      this.active[k] = 1;
      this.tag[k] = i === 0 ? 1 : i === NI - 1 ? 2 : 0;
    }

    // Explicit time step from the (mass-scaled) dilatational wave speed.
    const c = Math.sqrt((this.el.K + (4 / 3) * this.el.G) / rho);
    this.dt = (num.cfl * h) / (c + 1.5 * r.rollSpeed);
    // Tensions are ramped over ten passes of the (mass-scaled) elastic wave along the sheet
    // unless given: a step load rings, and the ringing alone can crack the head.
    this.tensionRamp = r.tensionRamp && r.tensionRamp > 0 ? r.tensionRamp : (10 * r.sheetLength) / c;
    // mean plane-strain flow stress of the pass: at half the pass's equivalent strain, no rate factor
    const epMid = (1 / Math.sqrt(3)) * Math.log(1 / (1 - r.reduction));
    const twoK = (2 / Math.sqrt(3)) * flowStress(P.material, epMid, 0, P.material.tRoom).sy;
    this.inertiaRatio = (rho * r.rollSpeed * r.rollSpeed * r.reduction) / twoK;

    // Contact traction bins over the bite and a little around it, one per grid
    // column and centred on it: bins whose edges fall on the columns collect 0, 1
    // or 2 of them by round-off, which made the friction hill saw-toothed.
    this.binW = h;
    this.binCol0 = Math.floor((-Lc - 6 * h - this.ox) / h);
    this.binX0 = this.ox + (this.binCol0 - 0.5) * h;
    this.nBins = Math.ceil((Lc + 12 * h) / h);
    this.binN = new Float64Array(this.nBins);
    this.binT = new Float64Array(this.nBins);
    this.lastP = new Float64Array(this.nBins);
    this.lastTau = new Float64Array(this.nBins);
    this.accTau = new Float64Array(this.nBins);
  }

  /** Advance one explicit step. */
  advance(): void {
    const { gm, gvx, gvy, gpush } = this;
    const [gpen0, gpen1] = this.gpen;
    gm.fill(0);
    gvx.fill(0);
    gvy.fill(0);
    gpen0.fill(INF);
    gpen1.fill(INF);
    gpush.fill(0);
    this.gcon.fill(0);
    this.updatePusher();
    if (!this.pusherActive && !this.stalled && this.step % 50 === 0) this.checkStall();
    this.p2g();
    this.gridUpdate();
    if (this.params.numerics.jbar) {
      this.gJ.fill(0);
      if (this.params.numerics.volumetric !== 'total') {
        this.gJe.fill(0);
        this.gB.fill(0);
        this.gMv.fill(0);
      }
    }
    this.g2pVelocity();
    this.g2pUpdate();
    this.t += this.dt;
    this.step++;
  }

  private p2g(): void {
    const { n, active, px, py, vx, vy, mass, vol0, gm, gvx, gvy, gpush, tag, dt, h, invH, ox, oy, nyN } = this;
    const [gpen0, gpen1] = this.gpen;
    const [r0, r1] = this.rolls;
    const k4 = 4 * invH * invH;
    this.updateTension();
    // force per gripped point [N/m] per unit of its current height and of its grip weight (see gripScale):
    // the total is the end stress times the end column's height
    const grip = this.gripCols;
    const tractionB = -this.backNow * this.dp * this.backScale;
    const tractionF = this.frontNow * this.dp * this.frontScale;
    const { li, NI } = this;
    const pushing = this.pusherActive;
    // 'surface': a penetrating point marks only the nodes on its roll side and its nearest row (the top roll is roll 0)
    const rollSide = this.params.numerics.contact === 'surface';
    const hh = 0.5 * h;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const xp = px[p];
      const yp = py[p];
      const gx = (xp - ox) * invH;
      const gy = (yp - oy) * invH;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const fx = gx - bx;
      const fy = gy - by;
      const wx0 = 0.5 * (1.5 - fx) * (1.5 - fx);
      const wx1 = 0.75 - (fx - 1) * (fx - 1);
      const wx2 = 0.5 * (fx - 0.5) * (fx - 0.5);
      const wy0 = 0.5 * (1.5 - fy) * (1.5 - fy);
      const wy1 = 0.75 - (fy - 1) * (fy - 1);
      const wy2 = 0.5 * (fy - 0.5) * (fy - 0.5);

      const J = this.f00[p] * this.f11[p] - this.f01[p] * this.f10[p];
      const vol = vol0[p] * J;
      const pr = this.pres[p];
      const k = -dt * vol * k4;
      const m = mass[p];
      const a00 = k * (this.sxx[p] - pr) + m * this.c00[p];
      const a01 = k * this.sxy[p] + m * this.c01[p];
      const a10 = k * this.sxy[p] + m * this.c10[p];
      const a11 = k * (this.syy[p] - pr) + m * this.c11[p];
      let mvx = m * vx[p];
      const mvy = m * vy[p];
      const tg = tag[p];
      if (tractionB !== 0 && li[p] < grip) mvx += dt * tractionB * this.gripWeight(li[p], 1) * Math.hypot(this.f01[p], this.f11[p]);
      else if (tractionF !== 0 && li[p] >= NI - grip) mvx += dt * tractionF * this.gripWeight(li[p], 2) * Math.hypot(this.f01[p], this.f11[p]);

      // penetration of this point into each roll (its half size along the deformed y edge)
      const rp = 0.5 * this.dp * Math.hypot(this.f01[p], this.f11[p]);
      const d0 = Math.hypot(xp - r0.cx, yp - r0.cy);
      const d1 = Math.hypot(xp - r1.cx, yp - r1.cy);
      const pen0 = d0 - r0.R - rp;
      const pen1 = d1 - r1.R - rp;
      this.touch[p] = (pen0 < 0 ? 1 : 0) | (pen1 < 0 ? 2 : 0);
      const n0x = (xp - r0.cx) / d0;
      const n0y = (yp - r0.cy) / d0;
      const n1x = (xp - r1.cx) / d1;
      const n1y = (yp - r1.cy) / d1;
      const pushMark = pushing && tg === 1;

      for (let i = 0; i < 3; i++) {
        const wx = i === 0 ? wx0 : i === 1 ? wx1 : wx2;
        const dx = (i - fx) * h;
        const col = (bx + i) * nyN + by;
        for (let j = 0; j < 3; j++) {
          const w = wx * (j === 0 ? wy0 : j === 1 ? wy1 : wy2);
          const dy = (j - fy) * h;
          const idx = col + j;
          gm[idx] += w * m;
          gvx[idx] += w * (mvx + a00 * dx + a01 * dy);
          gvy[idx] += w * (mvy + a10 * dx + a11 * dy);
          // along the roll normal n (roll centre → point): the node lies toward the roll, or within h/2 beyond the point
          if (pen0 < gpen0[idx] && (!rollSide || dx * n0x + dy * n0y <= hh)) gpen0[idx] = pen0;
          if (pen1 < gpen1[idx] && (!rollSide || dx * n1x + dy * n1y <= hh)) gpen1[idx] = pen1;
          if (pushMark) gpush[idx] = 1;
        }
      }
    }
  }

  private gridUpdate(): void {
    const { gm, gvx, gvy, gpush, nxN, nyN, h, ox, oy, dt } = this;
    const mu = this.params.rolling.mu;
    const pushing = this.pusherActive;
    const vPush = this.vIn;
    const invDt = 1 / dt;
    const { binN, binT, accTau, binCol0, nBins } = this;
    let pushImpulse = 0;
    const fyAcc = [0, 0];
    const tqAcc = [0, 0];
    const nNodes = nxN * nyN;
    const mMin = 1e-12 * this.mass[0];
    for (let idx = 0; idx < nNodes; idx++) {
      const m = gm[idx];
      if (m <= mMin) {
        gvx[idx] = 0;
        gvy[idx] = 0;
        continue;
      }
      let vx = gvx[idx] / m;
      let vy = gvy[idx] / m;
      const col = Math.floor(idx / nyN);
      const xi = ox + col * h;
      const yi = oy + (idx % nyN) * h;
      for (let k = 0; k < 2; k++) {
        if (this.gpen[k][idx] >= 0) continue;
        const roll = this.rolls[k];
        const rx = xi - roll.cx;
        const ry = yi - roll.cy;
        const d = Math.hypot(rx, ry);
        const nx = rx / d;
        const ny = ry / d;
        // roll surface velocity at the foot of the node
        const ux = -roll.omega * roll.R * ny;
        const uy = roll.omega * roll.R * nx;
        const relx = vx - ux;
        const rely = vy - uy;
        const vn = relx * nx + rely * ny;
        if (vn >= 0) continue; // separating
        this.gcon[idx] |= 1 << k;
        const tx = relx - vn * nx;
        const ty = rely - vn * ny;
        const vt = Math.hypot(tx, ty);
        let sx = 0;
        let sy = 0;
        if (vt > -mu * vn) {
          const s = 1 + (mu * vn) / vt; // Coulomb: slip, tangential velocity reduced by μ|vn|
          sx = tx * s;
          sy = ty * s;
        }
        const nvx = ux + sx;
        const nvy = uy + sy;
        // impulse on the sheet → force; the roll gets the opposite
        const fx = m * (nvx - vx) * invDt;
        const fy = m * (nvy - vy) * invDt;
        fyAcc[k] += -fy;
        tqAcc[k] += -(rx * fy - ry * fx);
        const b = col - binCol0;
        if (b >= 0 && b < nBins) {
          binN[b] += fx * nx + fy * ny;
          // tangent with +x orientation
          let tnx = -ny;
          let tny = nx;
          if (tnx < 0) {
            tnx = -tnx;
            tny = -tny;
          }
          const ft = fx * tnx + fy * tny;
          binT[b] += ft;
          accTau[b] += ft;
        }
        vx = nvx;
        vy = nvy;
      }
      if (pushing && gpush[idx] && vx < vPush) {
        pushImpulse += m * (vPush - vx);
        vx = vPush;
      }
      gvx[idx] = vx;
      gvy[idx] = vy;
    }
    if (this.params.numerics.contact === 'surface') this.followRoll(fyAcc, tqAcc);
    this.accSteps++;
    this.binSteps++;
    this.accFy[0] += fyAcc[0];
    this.accFy[1] += fyAcc[1];
    this.accTorque[0] += tqAcc[0];
    this.accTorque[1] += tqAcc[1];
    this.accPush += pushImpulse * invDt;
  }

  /**
   * Grid → particles, pass 1: velocity and its gradient. With J-bar on, a volumetric
   * quantity is also scattered to the grid (mass-weighted) so pass 2 can use its
   * smoothed value — plastic flow is isochoric, and the pointwise volume change
   * locks (spurious pressure checkerboard) otherwise. 'total': the trial volume
   * ratio J. 'rate': the volumetric rate tr L, and for the relaxation the elastic
   * log volume ln J − ev with each point's relaxation fraction.
   */
  private g2pVelocity(): void {
    const { n, active, px, py, vx, vy, gm, gvx, gvy, gJ, gJe, gB, gMv, mass, dt, h, invH, ox, oy, nyN } = this;
    const k4 = 4 * invH * invH;
    const num = this.params.numerics;
    const jbar = num.jbar;
    const rate = num.volumetric !== 'total';
    const cIn = num.volRelax ?? 1;
    const cContact = num.volRelaxContact ?? 5;
    // contact band: within 2h of a roll surface, i.e. |x − c| < R + 2h (squared, no sqrt per point)
    const [r0, r1] = this.rolls;
    const b0 = (r0.R + 2 * h) * (r0.R + 2 * h);
    const b1 = (r1.R + 2 * h) * (r1.R + 2 * h);
    const invK = 1 / this.el.K;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const gx = (px[p] - ox) * invH;
      const gy = (py[p] - oy) * invH;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const fx = gx - bx;
      const fy = gy - by;
      const wx0 = 0.5 * (1.5 - fx) * (1.5 - fx);
      const wx1 = 0.75 - (fx - 1) * (fx - 1);
      const wx2 = 0.5 * (fx - 0.5) * (fx - 0.5);
      const wy0 = 0.5 * (1.5 - fy) * (1.5 - fy);
      const wy1 = 0.75 - (fy - 1) * (fy - 1);
      const wy2 = 0.5 * (fy - 0.5) * (fy - 0.5);
      let nvx = 0;
      let nvy = 0;
      let b00 = 0;
      let b01 = 0;
      let b10 = 0;
      let b11 = 0;
      for (let i = 0; i < 3; i++) {
        const wx = i === 0 ? wx0 : i === 1 ? wx1 : wx2;
        const dx = (i - fx) * h;
        const col = (bx + i) * nyN + by;
        for (let j = 0; j < 3; j++) {
          const w = wx * (j === 0 ? wy0 : j === 1 ? wy1 : wy2);
          const dy = (j - fy) * h;
          const idx = col + j;
          const gvxi = gvx[idx];
          const gvyi = gvy[idx];
          nvx += w * gvxi;
          nvy += w * gvyi;
          b00 += w * gvxi * dx;
          b01 += w * gvxi * dy;
          b10 += w * gvyi * dx;
          b11 += w * gvyi * dy;
        }
      }
      // velocity gradient L = C (APIC / MLS)
      const l00 = k4 * b00;
      const l01 = k4 * b01;
      const l10 = k4 * b10;
      const l11 = k4 * b11;
      this.c00[p] = l00;
      this.c01[p] = l01;
      this.c10[p] = l10;
      this.c11[p] = l11;
      vx[p] = nvx;
      vy[p] = nvy;
      if (!jbar) continue;
      if (rate) {
        const m = mass[p];
        const th = l00 + l11;
        this.dJ[p] = th;
        // failed and inverted points take no part in the averages (they keep their own rate):
        // a crack must not dilate its intact neighbours, and ln J needs J > 0
        const Jo = this.f00[p] * this.f11[p] - this.f01[p] * this.f10[p];
        if (this.failed[p] || !(Jo > 0)) continue;
        const mth = m * th;
        // elastic log volume ln J − ev = −p/K for an intact point (p was set from this F last step)
        const mfe = -m * this.pres[p] * invK;
        // relaxation fraction β = c · 3K Δεp / σeq, with the contact coefficient near a roll
        let mb = 0;
        const v = this.vr[p];
        if (v > 0) {
          const ax = px[p] - r0.cx;
          const ay = py[p] - r0.cy;
          const bx1 = px[p] - r1.cx;
          const by1 = py[p] - r1.cy;
          const c = ax * ax + ay * ay < b0 || bx1 * bx1 + by1 * by1 < b1 ? cContact : cIn;
          const b = c * v;
          mb = m * (b < 1 ? b : 1);
        }
        for (let i = 0; i < 3; i++) {
          const wx = i === 0 ? wx0 : i === 1 ? wx1 : wx2;
          const col = (bx + i) * nyN + by;
          const w0 = wx * wy0;
          const w1 = wx * wy1;
          const w2 = wx * wy2;
          gJ[col] += w0 * mth;
          gJ[col + 1] += w1 * mth;
          gJ[col + 2] += w2 * mth;
          gJe[col] += w0 * mfe;
          gJe[col + 1] += w1 * mfe;
          gJe[col + 2] += w2 * mfe;
          gB[col] += w0 * mb;
          gB[col + 1] += w1 * mb;
          gB[col + 2] += w2 * mb;
          gMv[col] += w0 * m;
          gMv[col + 1] += w1 * m;
          gMv[col + 2] += w2 * m;
        }
        continue;
      }
      // trial total volume ratio of this step (averaging the total, not the increment, cannot drift)
      const Jold = this.f00[p] * this.f11[p] - this.f01[p] * this.f10[p];
      const dJ = ((1 + dt * l00) * (1 + dt * l11) - dt * dt * l01 * l10) * Jold;
      this.dJ[p] = dJ;
      const mdJ = mass[p] * dJ;
      for (let i = 0; i < 3; i++) {
        const wx = i === 0 ? wx0 : i === 1 ? wx1 : wx2;
        const col = (bx + i) * nyN + by;
        gJ[col] += wx * wy0 * mdJ;
        gJ[col + 1] += wx * wy1 * mdJ;
        gJ[col + 2] += wx * wy2 * mdJ;
      }
    }
    if (!jbar) return;
    const gMa = rate ? gMv : gm;
    for (let idx = 0; idx < gJ.length; idx++) {
      const m = gMa[idx];
      if (m > 0) gJ[idx] /= m;
    }
    // 'rate': nodal relaxation fraction β_i and β_i f̄_i (f̄_i: mass-weighted mean elastic log volume).
    // The point then relaxes by Δf_p = Σ_i w_ip β_i (f̄_i − f_p): symmetric in the mass-weighted sense,
    // so it conserves Σ m f (no volume leaks where β varies) and leaves a uniform field alone.
    if (rate) {
      for (let idx = 0; idx < gB.length; idx++) {
        const m = gMv[idx];
        if (m > 0) {
          const b = gB[idx] / m;
          gB[idx] = b;
          gJe[idx] = (b * gJe[idx]) / m;
        }
      }
    }
  }

  /**
   * 'surface': a point whose edge is inside a roll must not move further into it. Its velocity
   * interpolates the constrained nodes on its roll side and free nodes deeper in the sheet, which move
   * toward the mid-plane more slowly than the roll surface (the flow converges less at depth), so it
   * would lag behind the surface and sink into the roll. The deficit of its normal velocity, over the
   * weight it puts on its constrained nodes, is asked of those nodes (mass-weighted mean of the requests
   * per node) — the constrained nodes then carry the velocity the field has there, not the surface's.
   * The impulse goes to the roll force, torque and profile like the contact's.
   */
  private followRoll(fyAcc: number[], tqAcc: number[]): void {
    const { n, active, touch, px, py, gvx, gvy, gm, gcon, gfolN, gfolD, mass, h, invH, ox, oy, nyN, dt } = this;
    const w = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const touched: number[] = [];
    for (let p = 0; p < n; p++) {
      if (!active[p] || !touch[p]) continue;
      const gx = (px[p] - ox) * invH;
      const gy = (py[p] - oy) * invH;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const fx = gx - bx;
      const fy = gy - by;
      const wx = [0.5 * (1.5 - fx) * (1.5 - fx), 0.75 - (fx - 1) * (fx - 1), 0.5 * (fx - 0.5) * (fx - 0.5)];
      const wy = [0.5 * (1.5 - fy) * (1.5 - fy), 0.75 - (fy - 1) * (fy - 1), 0.5 * (fy - 0.5) * (fy - 0.5)];
      for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) w[a * 3 + c] = wx[a] * wy[c];
      for (let k = 0; k < 2; k++) {
        if (!(touch[p] & (1 << k))) continue;
        const roll = this.rolls[k];
        const rx = px[p] - roll.cx;
        const ry = py[p] - roll.cy;
        const d = Math.hypot(rx, ry);
        const nx = rx / d;
        const ny = ry / d;
        const ux = -roll.omega * roll.R * ny;
        const uy = roll.omega * roll.R * nx;
        let e = 0;
        let W = 0;
        for (let a = 0; a < 3; a++) {
          for (let c = 0; c < 3; c++) {
            const idx = (bx + a) * nyN + by + c;
            const wi = w[a * 3 + c];
            e += wi * ((gvx[idx] - ux) * nx + (gvy[idx] - uy) * ny);
            if (gcon[idx] & (1 << k)) W += wi;
          }
        }
        if (e >= 0 || W <= 0) continue;
        const want = -e / W;
        for (let a = 0; a < 3; a++) {
          for (let c = 0; c < 3; c++) {
            const idx = (bx + a) * nyN + by + c;
            if (!(gcon[idx] & (1 << k))) continue;
            const wm = w[a * 3 + c] * mass[p];
            if (gfolD[idx] === 0) touched.push(idx);
            gfolN[idx] += wm * want;
            gfolD[idx] += wm;
          }
        }
      }
    }
    const invDt = 1 / dt;
    for (const idx of touched) {
      const dv = gfolN[idx] / gfolD[idx];
      gfolN[idx] = 0;
      gfolD[idx] = 0;
      const k = gcon[idx] & 1 ? 0 : 1;
      const roll = this.rolls[k];
      const col = Math.floor(idx / nyN);
      const rx = ox + col * h - roll.cx;
      const ry = oy + (idx % nyN) * h - roll.cy;
      const d = Math.hypot(rx, ry);
      const nx = rx / d;
      const ny = ry / d;
      gvx[idx] += dv * nx;
      gvy[idx] += dv * ny;
      const f = gm[idx] * dv * invDt; // on the sheet, along n
      fyAcc[k] += -f * ny;
      tqAcc[k] += -(rx * f * ny - ry * f * nx);
      const b = col - this.binCol0;
      if (b >= 0 && b < this.nBins) this.binN[b] += f;
    }
  }

  /** Grid → particles, pass 2: move, update F and the stress, accumulate damage. */
  private g2pUpdate(): void {
    const { n, active, px, py, vx, vy, gJ, gJe, gB, dt, h, invH, ox, oy, nxN, nyN } = this;
    const P = this.params;
    const mat = P.material;
    const dmg = P.damage;
    const jbar = P.numerics.jbar;
    const rate = P.numerics.volumetric !== 'total';
    const { K, G } = this.el;
    const rateScale = P.rolling.millSpeed / P.rolling.rollSpeed;
    const failMode = dmg.failure;
    const gtn = dmg.yield === 'gtn' ? dmg.gtn : null;
    const nl = dmg.nonlocalLength > 0 ? (this.nlInc ??= [0, 1, 2].map(() => new Float64Array(n))) : null;
    if (nl) for (const a of nl) a.fill(0);
    const xMax = (nxN - 3) * h + ox;
    const yMax = (nyN - 3) * h + oy;
    const xMin = ox + 2 * h;
    const yMin = oy + 2 * h;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const xp = px[p];
      const yp = py[p];
      const l00 = this.c00[p];
      const l01 = this.c01[p];
      const l10 = this.c10[p];
      const l11 = this.c11[p];
      // volumetric correction: det(c g F) = c² J_trial = the scheme's J
      let cor = 1;
      // 'rate': the scheme's volumetric rate, which replaces tr D in the deviatoric update too
      let th = 0;
      if (jbar) {
        const gx = (xp - ox) * invH;
        const gy = (yp - oy) * invH;
        const bx = Math.floor(gx - 0.5);
        const by = Math.floor(gy - 0.5);
        const fx = gx - bx;
        const fy = gy - by;
        const wy0 = 0.5 * (1.5 - fy) * (1.5 - fy);
        const wy1 = 0.75 - (fy - 1) * (fy - 1);
        const wy2 = 0.5 * (fy - 0.5) * (fy - 0.5);
        let Jbar = 0;
        let rA = 0; // 'rate': Σ w β_i f̄_i
        let rB = 0; // 'rate': Σ w β_i
        for (let i = 0; i < 3; i++) {
          const wx = i === 0 ? 0.5 * (1.5 - fx) * (1.5 - fx) : i === 1 ? 0.75 - (fx - 1) * (fx - 1) : 0.5 * (fx - 0.5) * (fx - 0.5);
          const col = (bx + i) * nyN + by;
          Jbar += wx * (wy0 * gJ[col] + wy1 * gJ[col + 1] + wy2 * gJ[col + 2]);
          if (rate) {
            rA += wx * (wy0 * gJe[col] + wy1 * gJe[col + 1] + wy2 * gJe[col + 2]);
            rB += wx * (wy0 * gB[col] + wy1 * gB[col + 1] + wy2 * gB[col + 2]);
          }
        }
        if (rate) {
          // smoothed rate (Jbar holds it here) plus the relaxation of the elastic log volume toward
          // its grid mean; J advances exactly by exp(Δt θ), so the volume follows the smoothed rate
          const Jold = this.f00[p] * this.f11[p] - this.f01[p] * this.f10[p];
          if (this.failed[p] || !(Jold > 0)) {
            // not in the averages: its own rate, F ← (I + ΔtL) F
            th = l00 + l11;
          } else {
            th = Jbar + (rA + (rB * this.pres[p]) / K) / dt; // ln Jold − ev = −p/K
            const Jtr = ((1 + dt * l00) * (1 + dt * l11) - dt * dt * l01 * l10) * Jold;
            const r = (Jold * Math.exp(dt * th)) / Jtr;
            cor = r > 0 ? Math.sqrt(r) : 1;
          }
        } else {
          const r = Jbar / this.dJ[p];
          cor = r > 0 ? Math.sqrt(r) : 1;
        }
      }
      const nx = xp + dt * vx[p];
      const ny = yp + dt * vy[p];
      px[p] = nx;
      py[p] = ny;
      if (nx < xMin || nx > xMax || ny < yMin || ny > yMax) {
        active[p] = 0;
        continue;
      }

      // deformation gradient F ← c (I + dt L) F
      const F00 = this.f00[p];
      const F01 = this.f01[p];
      const F10 = this.f10[p];
      const F11 = this.f11[p];
      const g00 = cor * (1 + dt * l00);
      const g01 = cor * dt * l01;
      const g10 = cor * dt * l10;
      const g11 = cor * (1 + dt * l11);
      const n00 = g00 * F00 + g01 * F10;
      const n01 = g00 * F01 + g01 * F11;
      const n10 = g10 * F00 + g11 * F10;
      const n11 = g10 * F01 + g11 * F11;
      this.f00[p] = n00;
      this.f01[p] = n01;
      this.f10[p] = n10;
      this.f11[p] = n11;
      const J = n00 * n11 - n01 * n10;

      // rate of deformation (deviatoric part — the volumetric part enters through J) and spin.
      // 'rate': the in-plane trace of D is replaced by the scheme's rate θ, so the deviator sees the
      // same volume change as the pressure (s_zz rate 2G(−θ/3); plane strain σzz = ν(σxx + σyy) holds)
      let dxx = l00;
      let dyy = l11;
      if (jbar && rate) {
        const shift = 0.5 * (th - l00 - l11);
        dxx += shift;
        dyy += shift;
      }
      const dxy = 0.5 * (l01 + l10);
      const w = 0.5 * (l01 - l10);
      const tr3 = (dxx + dyy) / 3;
      const ex = dxx - tr3;
      const ey = dyy - tr3;
      const ez = -tr3;
      // physical equivalent strain rate for rate-dependent laws
      const epsDot = Math.sqrt((2 / 3) * (ex * ex + ey * ey + ez * ez + 2 * dxy * dxy)) * rateScale;

      // Jaumann rotation of the deviatoric stress, then the elastic trial
      let sx = this.sxx[p];
      let sy = this.syy[p];
      let sh = this.sxy[p];
      let sz = this.szz[p];
      const sz0 = sz;
      const rot = dt * w;
      const rx = sx + 2 * rot * sh;
      const ry = sy - 2 * rot * sh;
      const rh = sh + rot * (sy - sx);
      const g2 = 2 * G * dt;
      sx = rx + g2 * ex;
      sy = ry + g2 * ey;
      sz = sz + g2 * ez;
      sh = rh + g2 * dxy;
      let pr = J > 0 ? -K * Math.log(J) : 0;
      if (gtn) pr += K * this.ev[p]; // only the elastic part of the volume change is stressed

      let q = Math.sqrt(1.5 * (sx * sx + sy * sy + sz * sz + 2 * sh * sh));
      let dep = 0;
      let flowRate = -1;
      const isFailed = this.failed[p] === 1;
      this.vr[p] = 0;
      if (isFailed) {
        sx = sy = sz = sh = 0;
        q = 0;
        if (failMode === 'erode' || pr < 0) pr = 0;
      } else if (gtn) {
        const r = gtnReturn(mat, gtn, K, G, q, -pr, this.ep[p], this.por[p], epsDot, this.temp[p]);
        if (r) {
          const s = q > 0 ? r.q / q : 0;
          sx *= s;
          sy *= s;
          sz *= s;
          sh *= s;
          q = r.q;
          pr = -r.sm;
          dep = r.dEm;
          this.ep[p] += dep;
          this.ev[p] += r.dEv;
          const f = this.por[p] + r.df;
          this.por[p] = f < 0 ? 0 : f < 1 ? f : 1;
          const w = r.q * r.dEq + r.sm * r.dEv;
          this.plasticWork += w * this.vol0[p] * J;
          if (mat.chi > 0) this.temp[p] += adiabaticRise(mat.chi, w, J, mat.rho, mat.cp);
        }
      } else {
        dep = plasticIncrement(mat, G, q, this.ep[p], epsDot, this.temp[p]);
        if (dep > 0) {
          const s = 1 - (3 * G * dep) / q;
          sx *= s;
          sy *= s;
          sz *= s;
          sh *= s;
          q -= 3 * G * dep;
          this.ep[p] += dep;
          this.plasticWork += q * dep * this.vol0[p] * J;
          if (mat.chi > 0) this.temp[p] += adiabaticRise(mat.chi, q * dep, J, mat.rho, mat.cp);
          flowRate = epsDot;
          this.drW[p] = DRUCKER_DECAY * this.drW[p] + druckerWork(sx - rx, sy - ry, sh - rh, sz - sz0, sx, sy, sh, sz, q, dep);
          this.drE[p] = DRUCKER_DECAY * this.drE[p] + dep * dep;
        }
      }
      this.flowRate[p] = flowRate;
      this.sxx[p] = sx;
      this.syy[p] = sy;
      this.szz[p] = sz;
      this.sxy[p] = sh;
      this.pres[p] = pr;

      // stress state of the Cauchy stress σ = s − p I
      const cxx = sx - pr;
      const cyy = sy - pr;
      const czz = sz - pr;
      const cc = 0.5 * (cxx + cyy);
      const rr = Math.sqrt(0.25 * (cxx - cyy) * (cxx - cyy) + sh * sh);
      const s1 = Math.max(cc + rr, czz);
      const eta = q > 1e3 ? -pr / q : 0;
      this.seq[p] = q;
      this.eta[p] = eta;
      this.s1[p] = s1;

      if (dep > 0) {
        // pressure-projection stabilisation: the unresolved elastic volume relaxes at the rate the
        // plastic secant viscosity σeq/(3ε̇p) allows, β = c · 3K Δεp / σeq per step (docs/model.md)
        if (q > 0) this.vr[p] = (3 * K * dep) / q;
        if (dmg.model === 'localization' && localization(this.el, this.hardening(p), sx, sy, sh, sz).ratio <= 0) this.locHit[p] = 1;
        const du = 1 / this.duct[p];
        const Ts = homologousTemperature(mat, this.temp[p]);
        const epsDotStar = epsDot / mat.epsDot0;
        if (nl) {
          // nonlocal: keep the increments; they are averaged and added after this pass
          if (eta > dmg.etaCutoff) {
            nl[0][p] = (dep / jcFractureStrain(dmg, eta, epsDotStar, Ts)) * du;
            nl[1][p] = (dep / hmFractureStrain(eta)) * du;
          }
          if (s1 > 0) nl[2][p] = ((s1 / q) * dep * du) / dmg.clCrit;
          continue;
        }
        if (eta > dmg.etaCutoff) {
          this.dJC[p] += (dep / jcFractureStrain(dmg, eta, epsDotStar, Ts)) * du;
          this.dHM[p] += (dep / hmFractureStrain(eta)) * du;
        }
        if (s1 > 0) this.dCL[p] += ((s1 / q) * dep * du) / dmg.clCrit;
        if (dmg.model !== 'none' && this.governingDamage(p) >= 1 && !this.inGrip(p)) this.fail(p);
      }
    }
    if (nl) this.addNonlocalDamage(nl);
  }

  /** Grid passes of the nonlocal average for a length ℓ: one pass spreads by about 0.71 h along each axis (std). */
  nonlocalPasses(length: number): number {
    return Math.max(1, Math.round(2 * (length / this.h) ** 2));
  }

  private addNonlocalDamage(inc: Float64Array[]): void {
    this.nonlocalAverage(inc, this.nonlocalPasses(this.params.damage.nonlocalLength));
    const { n, active, failed } = this;
    const model = this.params.damage.model;
    for (let p = 0; p < n; p++) {
      if (!active[p] || failed[p]) continue;
      this.dJC[p] += inc[0][p];
      this.dHM[p] += inc[1][p];
      this.dCL[p] += inc[2][p];
      if (model !== 'none' && this.governingDamage(p) >= 1) this.fail(p);
    }
  }

  /**
   * Average per-point values over the grid, in place: each pass scatters them to the nodes
   * mass-weighted and gathers them back with the quadratic B-spline weights of the points'
   * current positions (as J-bar does for the volume). Failed points neither give nor take.
   * A uniform field stays the same and Σ m·v is kept (the weights are a partition of unity).
   */
  nonlocalAverage(values: Float64Array[], passes: number): void {
    const { n, active, failed, px, py, mass, invH, ox, oy, nyN } = this;
    const k = values.length;
    const nNodes = this.nxN * nyN;
    const gm = (this.nlMass ??= new Float64Array(nNodes));
    const gv = this.nlGrid && this.nlGrid.length === nNodes * k ? this.nlGrid : (this.nlGrid = new Float64Array(nNodes * k));
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const cell = (p: number) => {
      const gx = (px[p] - ox) * invH;
      const gy = (py[p] - oy) * invH;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const fx = gx - bx;
      const fy = gy - by;
      wx[0] = 0.5 * (1.5 - fx) * (1.5 - fx);
      wx[1] = 0.75 - (fx - 1) * (fx - 1);
      wx[2] = 0.5 * (fx - 0.5) * (fx - 0.5);
      wy[0] = 0.5 * (1.5 - fy) * (1.5 - fy);
      wy[1] = 0.75 - (fy - 1) * (fy - 1);
      wy[2] = 0.5 * (fy - 0.5) * (fy - 0.5);
      return bx * nyN + by;
    };
    for (let pass = 0; pass < passes; pass++) {
      gm.fill(0);
      gv.fill(0);
      for (let p = 0; p < n; p++) {
        if (!active[p] || failed[p]) continue;
        const base = cell(p);
        const m = mass[p];
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            const idx = base + i * nyN + j;
            const wm = wx[i] * wy[j] * m;
            gm[idx] += wm;
            for (let c = 0; c < k; c++) gv[idx * k + c] += wm * values[c][p];
          }
        }
      }
      for (let idx = 0; idx < nNodes; idx++) {
        const m = gm[idx];
        if (m > 0) for (let c = 0; c < k; c++) gv[idx * k + c] /= m;
      }
      for (let p = 0; p < n; p++) {
        if (!active[p] || failed[p]) continue;
        const base = cell(p);
        for (let c = 0; c < k; c++) {
          let v = 0;
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) v += wx[i] * wy[j] * gv[(base + i * nyN + j) * k + c];
          values[c][p] = v;
        }
      }
    }
  }

  /** Hardening modulus dσy/dεp [Pa] if the point flowed in the last step (J2), otherwise ∞. */
  hardening(p: number): number {
    const rate = this.flowRate[p];
    return rate < 0 ? Infinity : flowStress(this.params.material, this.ep[p], rate, this.temp[p]).H;
  }

  /** In the gripped length of an end while a tension is applied there: damage is shown there but does not fail the point. */
  inGrip(p: number): boolean {
    const i = this.li[p];
    return (this.frontNow > 0 && i >= this.NI - this.gripCols) || (this.backNow > 0 && i < this.gripCols);
  }

  /** Total load the tail (1) or head (2) grip puts on the strip this step [N/m], signed along x. */
  endLoad(tg: number): number {
    const { n, active, li, NI, dp } = this;
    const g = this.gripCols;
    const t = tg === 1 ? -this.backNow * dp * this.backScale : this.frontNow * dp * this.frontScale;
    let f = 0;
    for (let p = 0; p < n; p++) {
      if (!active[p] || (tg === 1 ? li[p] >= g : li[p] < NI - g)) continue;
      f += t * this.gripWeight(li[p], tg) * Math.hypot(this.f01[p], this.f11[p]);
    }
    return f;
  }

  /**
   * Share of the end load for a point of lattice column i in the grip of the tail (1) or the head (2):
   * largest at the end column, falling linearly towards the inner end of the grip, so the load goes
   * into the strip gradually instead of stepping up at the grip's inner edge.
   */
  gripWeight(i: number, end: number): number {
    const g = this.gripCols;
    const j = end === 1 ? g - 1 - i : i - (this.NI - g);
    return (j + 0.5) / g;
  }

  /**
   * Damage of point p by the chosen criterion (1 = it fails). With no criterion ('none') nothing
   * fails, and the damage shown is the largest of the three indicators, which are integrated anyway.
   */
  governingDamage(p: number): number {
    switch (this.params.damage.model) {
      case 'johnson-cook':
        return this.dJC[p];
      case 'hancock-mackenzie':
        return this.dHM[p];
      case 'cockcroft-latham':
        return this.dCL[p];
      case 'gtn':
        return this.por[p] / this.params.damage.gtn.fc;
      case 'localization':
        return this.locHit[p];
      default:
        return Math.max(this.dJC[p], this.dHM[p], this.dCL[p]);
    }
  }

  /**
   * Mark point p failed, join or start a crack (its record keeps the stress state at failure), then
   * drop the stress now as the next constitutive update would: the stored stress is what the next
   * p2g spreads to the grid, and a cracked point must not pull on its neighbours one step more.
   */
  private fail(p: number): void {
    this.failed[p] = 1;
    this.addToCrack(p);
    this.sxx[p] = this.syy[p] = this.szz[p] = this.sxy[p] = 0;
    if (this.params.damage.failure === 'erode' || this.pres[p] < 0) this.pres[p] = 0;
    this.seq[p] = 0;
    this.eta[p] = 0;
    this.s1[p] = -this.pres[p];
  }

  private addToCrack(p: number): void {
    // Join a crack that already has a failed point within two lattice spacings
    // (in the undeformed sheet), otherwise start a new one.
    const { NI, NJ, lattice, crackId } = this;
    const i0 = this.li[p];
    const j0 = this.lj[p];
    let id = -1;
    for (let i = Math.max(0, i0 - 2); i <= Math.min(NI - 1, i0 + 2) && id < 0; i++) {
      for (let j = Math.max(0, j0 - 2); j <= Math.min(NJ - 1, j0 + 2); j++) {
        const q = lattice[i * NJ + j];
        if (q >= 0 && crackId[q] >= 0) {
          id = crackId[q];
          break;
        }
      }
    }
    if (id >= 0) {
      crackId[p] = id;
      this.cracks[id].count++;
      return;
    }
    id = this.cracks.length;
    crackId[p] = id;
    this.cracks.push({
      id,
      t: this.t,
      step: this.step,
      x: this.px[p],
      y: this.py[p],
      sheetX: this.xHead0 - this.x0[p],
      sheetY: this.y0[p],
      eta: this.eta[p],
      s1: this.s1[p],
      seq: this.seq[p],
      ep: this.ep[p],
      criterion: this.params.damage.model,
      count: 1,
    });
  }

  /** Front of the head column (+∞ once it has left the grid). */
  headX(): number {
    let x = -INF;
    const { n, tag, active, px } = this;
    for (let p = n - 1; p >= 0 && tag[p] === 2; p--) if (active[p] && px[p] > x) x = px[p];
    return x === -INF ? INF : x;
  }

  /** Back of the tail column (+∞ once it has left the grid). */
  tailX(): number {
    let x = INF;
    const { n, tag, active, px } = this;
    for (let p = 0; p < n && tag[p] === 1; p++) if (active[p] && px[p] < x) x = px[p];
    return x;
  }

  phase(): Phase {
    if (this.stalled) return 'stalled';
    const head = this.headX();
    const tail = this.tailX();
    if (tail > 2 * this.params.rolling.h0 || tail === INF) return 'done';
    if (head < -this.contactLength) return 'approach';
    if (head < this.xExitProbe) return 'bite';
    if (tail > -this.contactLength) return 'tail-out';
    return 'steady';
  }

  /**
   * Tension stresses for this step. Back tension ramps up from the start and is released
   * (ramped down) once the tail reaches the entry plane — the sheet behind the rolls is
   * gone, nothing can pull it back. Front tension is switched on when the head passes the
   * exit probe (the strip is gripped by the coiler) and ramps up from then.
   */
  private updateTension(): void {
    const r = this.params.rolling;
    const t = this.t;
    const ramp = this.tensionRamp;
    if (r.backTension !== 0) {
      if (this.backOffAt < 0 && this.tailX() >= -this.contactLength) this.backOffAt = t;
      let back = r.backTension * Math.min(1, t / ramp);
      // let go within the time the tail takes to cross the bite, not the (possibly longer) ramp
      const release = Math.min(ramp, this.contactLength / this.vIn);
      if (this.backOffAt >= 0) back *= Math.max(0, 1 - (t - this.backOffAt) / release);
      this.backScale = this.gripScale(1);
      this.backNow = this.backScale > 0 ? back : 0;
    }
    if (r.frontTension !== 0) {
      if (this.frontOnAt < 0 && this.headX() > this.xExitProbe) this.frontOnAt = t;
      const front = this.frontOnAt >= 0 ? r.frontTension * Math.min(1, (t - this.frontOnAt) / ramp) : 0;
      this.frontScale = this.gripScale(2);
      this.frontNow = this.frontScale > 0 ? front : 0;
    }
  }

  /**
   * Height of an end column (tag 1 tail, 2 head) over Σ w |F e_y| dp of the points in that end's grip
   * (w the grip weight). Each gripped point's load is σ w |F e_y| dp times this, so the total is σ × the
   * end column's actual height whatever the heights of the grip's columns, sheared or with points missing.
   * 0 when the end column has no active point left (it has left the grid).
   */
  private gripScale(tg: number): number {
    const { n, tag, active, py, dp, li, NI } = this;
    const g = this.gripCols;
    let top = -INF;
    let bot = INF;
    const from = tg === 1 ? 0 : n - 1;
    const step = tg === 1 ? 1 : -1;
    for (let p = from; p >= 0 && p < n && tag[p] === tg; p += step) {
      if (!active[p]) continue;
      const e = dp * Math.hypot(this.f01[p], this.f11[p]);
      if (py[p] + e / 2 > top) top = py[p] + e / 2;
      if (py[p] - e / 2 < bot) bot = py[p] - e / 2;
    }
    if (top <= bot) return 0;
    let sum = 0;
    for (let p = from; p >= 0 && p < n && (tg === 1 ? li[p] < g : li[p] >= NI - g); p += step) {
      if (!active[p]) continue;
      sum += this.gripWeight(li[p], tg) * dp * Math.hypot(this.f01[p], this.f11[p]);
    }
    return sum > 0 ? (top - bot) / sum : 0;
  }

  /** Release the pusher once the head is well out of the bite (friction has to draw the sheet from then on). */
  updatePusher(): void {
    if (this.pusherActive && this.headX() > this.xExitProbe) this.pusherActive = false;
  }

  /** Thickness and mean speed of the sheet at the exit probe (null until material is there). */
  exitMeasure(): { thickness: number; speed: number } | null {
    const { n, active, px, py, vx } = this;
    const band = this.h;
    let top = -INF;
    let bot = INF;
    let sv = 0;
    let c = 0;
    for (let p = 0; p < n; p++) {
      if (!active[p] || this.failed[p]) continue;
      if (Math.abs(px[p] - this.xExitProbe) > band) continue;
      const y = py[p];
      const rp = 0.5 * this.dp * Math.hypot(this.f01[p], this.f11[p]);
      if (y + rp > top) top = y + rp;
      if (y - rp < bot) bot = y - rp;
      sv += vx[p];
      c++;
    }
    if (c < this.NJ) return null;
    return { thickness: top - bot, speed: sv / c };
  }

  /** Diagnostics; the force averages and the kinetic-energy interval restart after each call. */
  diagnostics(): Diagnostics {
    if (this.accSteps > 0) {
      const steps = this.accSteps;
      this.lastForce = (Math.abs(this.accFy[0]) + Math.abs(this.accFy[1])) / 2 / steps;
      // top roll turns counter-clockwise (ω > 0): driving torque opposes the resisting torque of the sheet
      this.lastTorque = (-this.accTorque[0] + this.accTorque[1]) / 2 / steps;
      this.lastPush = this.accPush / steps;
      this.lastNeutral = this.neutralPoint(this.accTau);
    }
    const fy = this.lastForce;
    const tq = this.lastTorque;
    const push = this.lastPush;
    this.accSteps = 0;
    this.accFy = [0, 0];
    this.accTorque = [0, 0];
    this.accPush = 0;
    this.accTau.fill(0);
    let nActive = 0;
    let nFailed = 0;
    let maxD = 0;
    for (let p = 0; p < this.n; p++) {
      if (this.active[p]) nActive++;
      if (this.failed[p]) nFailed++;
      const d = this.governingDamage(p);
      if (d > maxD) maxD = d;
    }
    const ex = this.exitMeasure();
    const phase = this.phase();
    let kineticRatio: number | null = null;
    const dt = this.t - this.lastWorkT;
    if (phase === 'steady' && ex && dt > 0 && this.plasticWork > this.lastWork) {
      const r = this.params.rolling;
      const v1 = ex.speed;
      const v0 = (v1 * ex.thickness) / r.h0; // mass flow
      const mdot = this.params.material.rho * this.params.numerics.massScale * r.h0 * v0;
      kineticRatio = (0.5 * mdot * (v1 * v1 - v0 * v0)) / ((this.plasticWork - this.lastWork) / dt);
    }
    this.lastWork = this.plasticWork;
    this.lastWorkT = this.t;
    return {
      t: this.t,
      step: this.step,
      dt: this.dt,
      nActive,
      phase,
      headX: this.headX(),
      tailX: this.tailX(),
      rollForce: fy,
      rollTorque: tq,
      pusherForce: push,
      pusherActive: this.pusherActive,
      backTension: this.backNow,
      frontTension: this.frontNow,
      exitThickness: ex ? ex.thickness : null,
      forwardSlip: ex ? ex.speed / this.params.rolling.rollSpeed - 1 : null,
      neutralX: this.lastNeutral,
      maxDamage: maxD,
      nFailed,
      cracks: this.cracks.length,
      plasticWork: this.plasticWork,
      inertiaRatio: this.inertiaRatio,
      kineticRatio,
    };
  }

  /**
   * After the pusher has let go the sheet must be drawn in by friction. If its mean speed
   * stays under 5 % of the roll speed for as long as the roll surface takes to cross the
   * contact length, the rolls cannot draw it in (μ too small for the bite angle): stalled.
   */
  private checkStall(): void {
    const { n, active, vx, mass } = this;
    let mv = 0;
    let m = 0;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      mv += mass[p] * vx[p];
      m += mass[p];
    }
    const r = this.params.rolling;
    if (m > 0 && Math.abs(mv / m) < 0.05 * r.rollSpeed) {
      if (this.slowSince < 0) this.slowSince = this.t;
      else if (this.t - this.slowSince > this.contactLength / r.rollSpeed) this.stalled = true;
    } else this.slowSince = -1;
  }

  /**
   * Neutral point from the tangential force per bin: the end of the entry-side
   * zone where friction drives the sheet (+x), taken where the running sum from
   * the entry peaks (robust to a stray sign flip) and refined to the zero crossing
   * between that bin and the next. Null when friction never turns from + to −.
   */
  private neutralPoint(tau: Float64Array): number | null {
    let cum = 0;
    let best = 0;
    let bb = -1;
    for (let b = 0; b < tau.length; b++) {
      cum += tau[b];
      if (cum > best) {
        best = cum;
        bb = b;
      }
    }
    if (bb < 0 || bb + 1 >= tau.length || !(tau[bb + 1] < 0)) return null;
    const t0 = tau[bb];
    const t1 = tau[bb + 1];
    return this.binX0 + (bb + 0.5) * this.binW + (this.binW * t0) / (t0 - t1);
  }

  /**
   * Contact traction along x, averaged since the last call (which resets it).
   * With nothing stepped in between (e.g. a read while paused) the last one is repeated.
   */
  pressureProfile(): PressureProfile {
    const { nBins, binW, binSteps, lastP, lastTau } = this;
    if (binSteps > 0) {
      for (let b = 0; b < nBins; b++) {
        lastP[b] = this.binN[b] / (2 * binSteps * binW);
        lastTau[b] = this.binT[b] / (2 * binSteps * binW);
      }
      this.binN.fill(0);
      this.binT.fill(0);
      this.binSteps = 0;
    }
    const x = new Float64Array(nBins);
    for (let b = 0; b < nBins; b++) x[b] = this.binX0 + (b + 0.5) * binW;
    return { x, p: lastP.slice(), tau: lastTau.slice() };
  }

  /** Current centroid of each crack's failed points. */
  crackCentroids(): { id: number; x: number; y: number; count: number }[] {
    const sx = new Float64Array(this.cracks.length);
    const sy = new Float64Array(this.cracks.length);
    const c = new Float64Array(this.cracks.length);
    for (let p = 0; p < this.n; p++) {
      const id = this.crackId[p];
      if (id < 0) continue;
      sx[id] += this.px[p];
      sy[id] += this.py[p];
      c[id]++;
    }
    return this.cracks.map((k) => ({ id: k.id, x: sx[k.id] / c[k.id], y: sy[k.id] / c[k.id], count: k.count }));
  }

  /** Per-particle values of a display field (MPa for stresses). */
  readField(name: FieldName, out: Float32Array): void {
    const MPa = 1e-6;
    for (let p = 0; p < this.n; p++) {
      let v = 0;
      switch (name) {
        case 'seq':
          v = this.seq[p] * MPa;
          break;
        case 'pres':
          v = this.pres[p] * MPa;
          break;
        case 'eta':
          v = this.eta[p];
          break;
        case 's1':
          v = this.s1[p] * MPa;
          break;
        case 'ep':
          v = this.ep[p];
          break;
        case 'damage':
          v = this.governingDamage(p);
          break;
        case 'dJC':
          v = this.dJC[p];
          break;
        case 'dHM':
          v = this.dHM[p];
          break;
        case 'dCL':
          v = this.dCL[p];
          break;
        case 'porosity':
          v = this.por[p];
          break;
        case 'dT':
          v = this.temp[p] - this.params.material.tRoom;
          break;
        case 'loc':
          v = localization(this.el, this.hardening(p), this.sxx[p], this.syy[p], this.sxy[p], this.szz[p]).ratio;
          break;
        case 'drucker':
          v = this.flowRate[p] >= 0 && this.drE[p] > 0 ? (this.drW[p] / this.drE[p]) * MPa : 0;
          break;
        case 'sxx':
          v = (this.sxx[p] - this.pres[p]) * MPa;
          break;
        case 'syy':
          v = (this.syy[p] - this.pres[p]) * MPa;
          break;
        case 'sxy':
          v = this.sxy[p] * MPa;
          break;
        case 'szz':
          v = (this.szz[p] - this.pres[p]) * MPa;
          break;
        case 'vx':
          v = this.vx[p];
          break;
        case 'lagrange': {
          // checkerboard of the undeformed lattice: shows how the material flowed
          const bi = Math.floor(this.li[p] / (2 * this.params.numerics.ppc));
          const bj = Math.floor(this.lj[p] / this.params.numerics.ppc);
          v = (bi + bj) % 2;
          break;
        }
      }
      out[p] = v;
    }
  }
}
