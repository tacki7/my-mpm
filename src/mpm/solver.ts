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
import { ROLL_E, biteGeometry, cloneParams, hitchcockRadius, type DamageModel, type MaterialParams, type RollingParams, type SimParams } from './params.ts';
import { druckerWork, localization } from './bifurcation.ts';
import { karmanFlattened, karman } from './slab.ts';
import {
  adiabaticRise,
  elasticConstants,
  flowStress,
  gtnReturn,
  hmFractureStrain,
  homologousTemperature,
  jcFractureStrain,
  plasticIncrement,
  staticStrength,
  strengthFactor,
  type Elastic,
} from './material.ts';

/** the rolls' adjustment: steps between the gap control's thickness readings, and what counts as settled (relative) */
/** where the flattened rolls start: the MPM's roll force over the slab method's, about */
const PRESET_FORCE_RATIO = 1.09;
export const CTL_EVERY = 20;
export const CTL_TOL_R = 5e-3;
export const CTL_TOL_H = 5e-4;

export interface Roll {
  cx: number;
  cy: number;
  R: number;
  /** angular velocity [rad/s], counter-clockwise positive */
  omega: number;
  /**
   * The roll's shape on the move (adjustRolls): the rates of R and of cy [m/s]. Its surface then moves along its
   * normal by (ċ + Ṙ n)·n besides turning, and the contact has to know: without it the sheet sinks into a roll
   * whose R' grows (the sheet came out 20 µm thicker than the gap). Only the normal part: along the surface the
   * speed is the turning's (ċ·t is 20 % of it while the force builds up, and as a surface speed it upset the
   * friction: the force swung between 2.3 and 4.8 kN/mm). Absent or 0: the rigid roll as before
   */
  vR?: number;
  vcy?: number;
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
  /** tandem (src/mpm/tandem.ts): the stand it started in, set once that stand is over; absent in a single pass */
  stand?: number;
  /**
   * tandem: the area of material that failed into this crack in each stand [m², per unit width]: the mass of its
   * failed points over ρ, at the stand's end less at its start (after the remap), so the finer lattice of the next
   * stand does not count again what is already cracked. Absent in a single pass
   */
  areaByStand?: number[];
}

/** 'adjusting': where 'steady' would be, while the rolls' radius (flattening) or the gap (constant reduction) still change */
export type Phase = 'approach' | 'bite' | 'adjusting' | 'steady' | 'tail-out' | 'done' | 'stalled';

export type NeutralState = 'found' | 'sticking' | 'backward' | 'forward' | 'none';

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
  /** the rolls now: their radius in the contact (the flattened one) and the gap [m]; the params' while neither is adjusted */
  rollRadius: number;
  gap: number;
  /** the rolls' radius and the gap have settled and are held (true all along when neither is adjusted) */
  rollsSettled: boolean;
  /** thickness measured at the exit probe (null until the head reaches it) [m] */
  exitThickness: number | null;
  /** mean sheet speed at the exit probe / roll surface speed − 1 */
  forwardSlip: number | null;
  /**
   * neutral point: where the friction on the sheet, summed per bin since the last read, turns from +x
   * (the rolls draw the sheet in, entry side) to −x inside the bite (−Lc < x < 0); null when it does not [m]
   */
  neutralX: number | null;
  /**
   * why there is a neutral point or not, from the same sums: 'found'; 'sticking' (no zero in the bite and
   * the friction stays under μ p everywhere in it: the whole arc sticks); 'backward' (it drives the sheet
   * in all along: the sheet slides back on the rolls); 'forward' (it holds the sheet back all along);
   * 'none' (no contact since the last read)
   */
  neutralState: NeutralState;
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
  /** the roll gap and the contact length now (they change while the rolls are adjusted: adjustRolls) */
  gap: number;
  contactLength: number;
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
  /** length of the node arrays: the nodes, and with crackFields 'dfg' the second field's nodes after them */
  readonly NN: number;
  // 'dfg': the failed points' field φ at the nodes — its gradient G (toward the failed side) and the mass-weighted
  // centre of the failed points around each node; per point and stencil node (9 p + 3 i + j) the field it is on
  // (1: the second, at nNodes + node) and whether it has any node on the second (null / 0 when no point failed)
  private readonly gGx: Float64Array;
  private readonly gGy: Float64Array;
  private readonly gCx: Float64Array;
  private readonly gCy: Float64Array;
  private readonly gCw: Float64Array;
  private pf: Uint8Array | null = null;
  private pfBuf = new Uint8Array(0);
  private readonly pfAny: Uint8Array;
  private gGLo = 0;
  private gGHi = 0;
  // 'dfg': the node numbers [fLo, fHi) that can be on the second field this step (the box of the failed points'
  // stencils, set by assignFields); the loops over the second field's nodes stay inside it
  private fLo = 0;
  private fHi = 0;
  // assignFields: a point's weights and their gradients along x and y
  private readonly swx = new Float64Array(3);
  private readonly swy = new Float64Array(3);
  private readonly sdx = new Float64Array(3);
  private readonly sdy = new Float64Array(3);
  private fieldsPrev = false;
  /** 'dfg': node-steps this step where the two fields came together (contact) and where they moved apart */
  fieldContacts = 0;
  fieldApart = 0;
  private readonly projBuf = new Float64Array(20); // gridUpdate: each roll's projection of a node
  // per roll and node (roll k at k · nodes + node): the slip velocity left after the contact (weighted), which
  // followRoll's extra normal impulse may still reduce by Coulomb
  private readonly gslipX: Float64Array;
  private readonly gslipY: Float64Array;
  /** this step, per node, both rolls: the contact's normal and tangential impulse on the sheet [kg·m/s per m], and
   *  whether the node still slides on a roll after it (1) — the effective friction is Jt / Jn on sliding nodes */
  readonly contactJn: Float64Array;
  readonly contactJt: Float64Array;
  readonly contactSlip: Uint8Array;
  /**
   * The grid nodes the active points' stencils cover this step, [gLo, gHi), and last step's: only those are
   * written, so only last step's range needs clearing (the first step clears all) and only this step's is
   * visited. The rest of the grid keeps its cleared values, as if the whole grid were cleared every step.
   */
  private gLo = 0;
  private gHi = 0;
  private gPrevLo = 0;
  private gPrevHi = 0;
  // 'surface': per roll and node (roll k at k · nodes + node), Σ w m (requested normal velocity change) and Σ w m
  private readonly gfolN: Float64Array;
  private readonly gfolD: Float64Array;

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
  /** staticStrength at the plastic strain it was last computed for (NaN: not yet): σy = it × strengthFactor */
  private readonly strengthEp: Float64Array;
  private readonly strength: Float64Array;
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
  // a second window of the same sums, read and restarted only by readWindow() (src/mpm/tandem.ts): the page reads
  // diagnostics() every frame, and a tandem's stand results must not depend on how often it does
  private readonly win = { steps: 0, fy: [0, 0], tq: [0, 0] };
  // The rolls adjusted while the pass runs (docs/model.md「ロール偏平と圧下率一定」): the flattened radius follows the
  // roll force (low-passed over ctlTauF), the gap is driven by the thickness at the gauge just past the rolls
  // (low-passed over ctlTauH, integrated over ctlTauG). Both are held once they have stayed put for a window.
  /** any of the two is on */
  readonly rollsAdjusted: boolean;
  rollsSettled: boolean;
  /** when the rolls settled [s] (−∞ with rolls that are not adjusted, NaN until then) */
  settledT = NaN;
  /** where the gap control measures the thickness: half an entry thickness past the roll centres (the sheet has recovered by 0.4 h0) */
  readonly xGauge: number;
  private readonly ctlTauF: number;
  private readonly ctlTauH: number;
  private readonly ctlTauG: number;
  private readonly ctlWindow: number;
  private ctlForce = 0;
  /** the slab method's force with flattened rolls: the floor of the force R' follows while the head comes through */
  private ctlForce0 = 0;
  private ctlThick = NaN;
  private ctlThickRef = NaN;
  private ctlGapRef = NaN;
  /** R' low-passed over half a transit time, and since when R' has been within CTL_TOL_R of it; since when the thickness has been on its target */
  private ctlRRef = 0;
  private ctlRSince = 0;
  private ctlHSince = Infinity;
  private readonly ctlTransit: number;
  /** half-width of the gauge's band along x: two lattice columns of the rolled sheet either way. The edge of the
   *  outermost points dips by 0.5 % for a quarter of the grid's period (four columns); over the whole period it does not */
  private readonly gaugeBand: number;
  // the last averages, repeated when nothing was stepped in between (e.g. a read while paused)
  private lastForce = 0;
  private lastTorque = 0;
  private lastPush = 0;
  private lastNeutral: number | null = null;
  private lastNeutralState: NeutralState = 'none';
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
  private readonly accN: Float64Array; // normal force per bin since the last diagnostics read

  constructor(input: SimParams) {
    const P = cloneParams(input);
    this.params = P;
    const r = P.rolling;
    const num = P.numerics;
    this.el = elasticConstants(P.material);
    const geo = biteGeometry(r);
    // rolls that follow the pass start from the slab method's answer (presetRolls): the sheet is laid out before
    // that bite, not the rigid rolls' (a later stand's R' is twice R, and its arc would start inside the sheet)
    const adjusted = r.flattening === 'hitchcock' || r.gapControl === 'reduction';
    const start = adjusted ? presetRolls(r, P.material) : null;
    this.gap = start ? start.gap : geo.gap;
    this.contactLength = start ? Math.sqrt(start.rollRadius * (r.h0 - start.gap) - (r.h0 - start.gap) ** 2 / 4) : geo.contactLength;

    const h = r.h0 / num.cellsThrough;
    this.h = h;
    this.invH = 1 / h;
    const dp = h / num.ppc;
    this.dp = dp;

    // Sheet starts with its head a little before the entry of the bite.
    const Lc = this.contactLength;
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
    // 'dfg': the second velocity field of the crack faces sits in the node arrays after the first, at nNodes + node
    const NN = (num.crackFields ?? 'none') === 'dfg' ? 2 * nNodes : nNodes;
    this.NN = NN;
    this.gm = new Float64Array(NN);
    this.gvx = new Float64Array(NN);
    this.gvy = new Float64Array(NN);
    this.gpen = [new Float64Array(NN), new Float64Array(NN)];
    this.gpush = new Uint8Array(NN);
    this.gcon = new Uint8Array(NN);
    this.gslipX = new Float64Array(2 * NN);
    this.gslipY = new Float64Array(2 * NN);
    this.contactJn = new Float64Array(NN);
    this.contactJt = new Float64Array(NN);
    this.contactSlip = new Uint8Array(NN);
    this.gfolN = new Float64Array(2 * NN);
    this.gfolD = new Float64Array(2 * NN);
    this.gJ = new Float64Array(NN);
    this.gJe = new Float64Array(NN);
    this.gB = new Float64Array(NN);
    this.gMv = new Float64Array(NN);
    this.gGx = new Float64Array(NN > nNodes ? nNodes : 0);
    this.gGy = new Float64Array(NN > nNodes ? nNodes : 0);
    this.gCx = new Float64Array(NN > nNodes ? nNodes : 0);
    this.gCy = new Float64Array(NN > nNodes ? nNodes : 0);
    this.gCw = new Float64Array(NN > nNodes ? nNodes : 0);
    this.gPrevHi = nNodes;

    const R = start ? start.rollRadius : r.rollRadius;
    const cy = R + this.gap / 2;
    const omega = r.rollSpeed / R;
    this.rolls = [
      { cx: 0, cy, R, omega }, // top: counter-clockwise → bottom surface moves +x
      { cx: 0, cy: -cy, R, omega: -omega },
    ];
    // 3 h0 past the exit, but not more than 2 contact lengths: on a thick plate (h0 10 mm, Lc 2.7 mm) 3 h0 is
    // 30 mm and the head never got there before the tail entered the bite (no steady phase, no exit gauge).
    // Thin sheets are unchanged (3 h0 < 2 Lc)
    this.xExitProbe = Math.max(6 * h, Math.min(3 * r.h0, 2 * this.contactLength));
    this.rollsAdjusted = adjusted;
    this.ctlForce0 = start ? start.force : 0;
    this.rollsSettled = !this.rollsAdjusted;
    if (this.rollsSettled) this.settledT = -Infinity;
    this.xGauge = r.h0;
    // the time the sheet takes through the bite sets the pace: the force over a quarter of it, the gauge's delay
    // (xGauge at the exit speed) for the thickness, the gap over four delays (an integrator on a pure delay d is
    // stable above 2 d / π; this one settles in about three of its own times without overshoot)
    const transit = this.contactLength / r.rollSpeed;
    const delay = this.xGauge / r.rollSpeed;
    this.ctlTauF = transit / 4;
    this.ctlTauH = delay / 2;
    this.ctlTauG = 2 * delay;
    this.ctlWindow = transit / 2;
    this.ctlTransit = transit;
    this.gaugeBand = Math.min((4 * dp) / (1 - r.reduction), 0.8 * r.h0);
    this.ctlRRef = R;

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
    this.strengthEp = F().fill(NaN);
    this.strength = F();
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
    this.pfAny = new Uint8Array(NN > nNodes ? n : 0);

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
    // (−Lc − 6h − ox)/h = (max(2h0, 4h) + L)/h, a whole number of columns up to round-off (floor made
    // 179.999… into 179 and moved the window one column back)
    this.binCol0 = Math.round((-Lc - 6 * h - this.ox) / h);
    this.binX0 = this.ox + (this.binCol0 - 0.5) * h;
    this.nBins = Math.ceil((Lc + 12 * h) / h);
    this.binN = new Float64Array(this.nBins);
    this.binT = new Float64Array(this.nBins);
    this.lastP = new Float64Array(this.nBins);
    this.lastTau = new Float64Array(this.nBins);
    this.accTau = new Float64Array(this.nBins);
    this.accN = new Float64Array(this.nBins);
  }

  /** Advance one explicit step. */
  advance(): void {
    const { gm, gvx, gvy, gpush } = this;
    const [gpen0, gpen1] = this.gpen;
    // clear what last step wrote (the whole grid at the first step)
    const lo = this.gPrevLo;
    const hi = this.gPrevHi;
    gm.fill(0, lo, hi);
    gvx.fill(0, lo, hi);
    gvy.fill(0, lo, hi);
    gpen0.fill(INF, lo, hi);
    gpen1.fill(INF, lo, hi);
    gpush.fill(0, lo, hi);
    this.gcon.fill(0, lo, hi);
    this.contactJn.fill(0, lo, hi);
    this.contactJt.fill(0, lo, hi);
    this.contactSlip.fill(0, lo, hi);
    // the second field's nodes, when last step had them
    const N = this.nxN * this.nyN;
    const lo2 = lo + N;
    const hi2 = hi + N;
    if (this.fieldsPrev) {
      gm.fill(0, lo2, hi2);
      gvx.fill(0, lo2, hi2);
      gvy.fill(0, lo2, hi2);
      gpen0.fill(INF, lo2, hi2);
      gpen1.fill(INF, lo2, hi2);
      gpush.fill(0, lo2, hi2);
      this.gcon.fill(0, lo2, hi2);
      this.contactJn.fill(0, lo2, hi2);
      this.contactJt.fill(0, lo2, hi2);
      this.contactSlip.fill(0, lo2, hi2);
    }
    this.updatePusher();
    if (!this.pusherActive && !this.stalled && this.step % 50 === 0) this.checkStall();
    this.pf = this.NN > N ? this.assignFields() : null;
    this.p2g();
    this.gridUpdate();
    if (this.params.numerics.jbar) {
      this.gJ.fill(0, lo, hi);
      if (this.params.numerics.volumetric !== 'total') {
        this.gJe.fill(0, lo, hi);
        this.gB.fill(0, lo, hi);
        this.gMv.fill(0, lo, hi);
      }
      if (this.fieldsPrev) {
        this.gJ.fill(0, lo2, hi2);
        this.gJe.fill(0, lo2, hi2);
        this.gB.fill(0, lo2, hi2);
        this.gMv.fill(0, lo2, hi2);
      }
    }
    this.g2pVelocity();
    this.g2pUpdate();
    this.gPrevLo = this.gLo;
    this.gPrevHi = this.gHi;
    this.fieldsPrev = this.pf !== null;
    this.t += this.dt;
    this.step++;
    if (!this.rollsSettled) this.adjustRolls();
  }

  /**
   * The rolls follow the pass (docs/model.md「ロール偏平と圧下率一定」), every step until they have settled:
   * - flattening 'hitchcock': R' = R (1 + C P / Δh) with P the roll force low-passed over a quarter of the bite's
   *   transit time and Δh = h0 − gap. The arc stays a circle through the same lowest point (the centre moves
   *   out by R' − R), the surface speed stays (ω = v / R')
   * - gapControl 'reduction': the gap is integrated on the error of the thickness at the gauge (xGauge, every
   *   CTL_EVERY steps) against h0 (1 − r)
   * Both start from the slab method's answer (presetRolls). Settled, and held from then on: with the head past
   * the exit probe, for a window (half a transit time) R' within CTL_TOL_R of Hitchcock's radius for the force
   * now and of its own mean, and the thickness within CTL_TOL_H of its target.
   */
  private adjustRolls(): void {
    const r = this.params.rolling;
    const flat = r.flattening === 'hitchcock';
    const red = r.gapControl === 'reduction';
    const target = r.h0 * (1 - r.reduction);
    const t = this.t;
    const building = this.headX() < this.xExitProbe;
    // not on the head end: it comes out thicker and wavy, and a gap driven by it swings the force
    if (red && !building && this.step % CTL_EVERY === 0) {
      const m = this.exitMeasure(this.xGauge);
      if (m) {
        const k = Math.min(1, (CTL_EVERY * this.dt) / this.ctlTauH);
        this.ctlThick = Number.isNaN(this.ctlThick) ? m.thickness : this.ctlThick + (m.thickness - this.ctlThick) * k;
        this.gap -= (this.ctlThick - target) * Math.min(1, (CTL_EVERY * this.dt) / this.ctlTauG);
        // the means over half a transit time: the sheet's thickness varies with the lattice's period on the grid
        // (± 0.15 % at 4 cells and r 40 %) and the gap follows it; what has to be on the target is the mean
        const km = Math.min(1, (2 * CTL_EVERY * this.dt) / this.ctlTransit);
        this.ctlThickRef = Number.isNaN(this.ctlThickRef) ? this.ctlThick : this.ctlThickRef + (this.ctlThick - this.ctlThickRef) * km;
        this.ctlGapRef = Number.isNaN(this.ctlGapRef) ? this.gap : this.ctlGapRef + (this.gap - this.ctlGapRef) * km;
      }
      // on its target since (∞: not on it): the mean within CTL_TOL_H, the thickness now within four times that
      const on = Math.abs(this.ctlThickRef - target) <= CTL_TOL_H * target && Math.abs(this.ctlThick - target) <= 4 * CTL_TOL_H * target;
      if (!on) this.ctlHSince = Infinity;
      else if (this.ctlHSince === Infinity) this.ctlHSince = t;
    }
    // R' goes to Hitchcock's radius over ctlTauF once more, so that its rate (the contact's surface speed) is
    // smooth: straight from the low-passed force it carries the force's step-to-step noise, and the force swung
    const top0 = this.rolls[0];
    // until the head is at the exit probe the force is still building up: not below the slab method's
    const force = building ? Math.max(this.ctlForce, this.ctlForce0) : this.ctlForce;
    const goal = flat ? hitchcockRadius(r, force, r.h0 - this.gap) : r.rollRadius;
    const R = top0.R + (goal - top0.R) * Math.min(1, this.dt / this.ctlTauF);
    this.setRolls(R);
    // put: within CTL_TOL_R of its own mean over half a transit time (the roll force wanders by ± 2 % over thousands of
    // steps, R' with it by ± 0.6 %: a band about where R' was some time ago would never hold)
    this.ctlRRef += (R - this.ctlRRef) * Math.min(1, (2 * this.dt) / this.ctlTransit);
    if (building || Math.abs(R - this.ctlRRef) > CTL_TOL_R * R || Math.abs(R - goal) > CTL_TOL_R * R) this.ctlRSince = t;
    if (building) {
      this.ctlHSince = Infinity;
      return;
    }
    if ((!flat || t - this.ctlRSince >= this.ctlWindow) && (!red || t - this.ctlHSince >= this.ctlWindow)) {
      this.rollsSettled = true;
      this.settledT = this.t;
      // held from here, the gap at its mean: the surface moves no more
      if (red) this.gap = this.ctlGapRef;
      this.setRolls(R, false);
    }
  }

  /** the rolls at radius R and the gap now; `moving`: the contact sees the surface move there over this step */
  private setRolls(R: number, moving = true): void {
    const r = this.params.rolling;
    const dh = r.h0 - this.gap;
    const cy = R + this.gap / 2;
    const [top, bottom] = this.rolls;
    top.vR = bottom.vR = moving ? (R - top.R) / this.dt : 0;
    top.vcy = moving ? (cy - top.cy) / this.dt : 0;
    bottom.vcy = -top.vcy;
    top.R = bottom.R = R;
    top.cy = cy;
    bottom.cy = -cy;
    top.omega = r.rollSpeed / R;
    bottom.omega = -top.omega;
    this.contactLength = Math.sqrt(R * dh - (dh * dh) / 4);
  }

  private p2g(): void {
    const { n, active, px, py, vx, vy, mass, vol0, gm, gvx, gvy, gpush, tag, dt, h, invH, ox, oy, nyN, pf, pfAny } = this;
    const nNodes = this.nxN * nyN;
    const { f00, f01, f10, f11, sxx, syy, sxy, pres, c00, c01, c10, c11, touch } = this;
    const halfDp = 0.5 * this.dp;
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
    // the lowest and highest stencil base (bx, by) index: the stencils cover [loBase, hiBase + 2 nyN + 3)
    let loBase = INF;
    let hiBase = -INF;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const xp = px[p];
      const yp = py[p];
      const gx = (xp - ox) * invH;
      const gy = (yp - oy) * invH;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const base = bx * nyN + by;
      if (base < loBase) loBase = base;
      if (base > hiBase) hiBase = base;
      const fx = gx - bx;
      const fy = gy - by;
      const wx0 = 0.5 * (1.5 - fx) * (1.5 - fx);
      const wx1 = 0.75 - (fx - 1) * (fx - 1);
      const wx2 = 0.5 * (fx - 0.5) * (fx - 0.5);
      const wy0 = 0.5 * (1.5 - fy) * (1.5 - fy);
      const wy1 = 0.75 - (fy - 1) * (fy - 1);
      const wy2 = 0.5 * (fy - 0.5) * (fy - 0.5);

      const F01 = f01[p];
      const F11 = f11[p];
      const J = f00[p] * F11 - F01 * f10[p];
      const vol = vol0[p] * J;
      const pr = pres[p];
      const k = -dt * vol * k4;
      const m = mass[p];
      const a00 = k * (sxx[p] - pr) + m * c00[p];
      const a01 = k * sxy[p] + m * c01[p];
      const a10 = k * sxy[p] + m * c10[p];
      const a11 = k * (syy[p] - pr) + m * c11[p];
      let mvx = m * vx[p];
      const mvy = m * vy[p];
      const tg = tag[p];
      if (tractionB !== 0 && li[p] < grip) mvx += dt * tractionB * this.gripWeight(li[p], 1) * Math.hypot(F01, F11);
      else if (tractionF !== 0 && li[p] >= NI - grip) mvx += dt * tractionF * this.gripWeight(li[p], 2) * Math.hypot(F01, F11);

      // penetration of this point into each roll (its half size along the deformed y edge). Only a
      // penetration (pen < 0) is used: the nodes' gpen and the touch flags are read by their sign. A point
      // whose squared distance to a roll centre is beyond (R + an upper bound of its half size)², with a
      // relative margin far above rounding, cannot penetrate that roll: no square roots for it.
      const e0x = xp - r0.cx;
      const e0y = yp - r0.cy;
      const e1x = xp - r1.cx;
      const e1y = yp - r1.cy;
      const rpMax = halfDp * (Math.abs(F01) + Math.abs(F11));
      const reach0 = (r0.R + rpMax) * (r0.R + rpMax) * (1 + 1e-9);
      const reach1 = (r1.R + rpMax) * (r1.R + rpMax) * (1 + 1e-9);
      let pen0 = INF;
      let pen1 = INF;
      let n0x = 0;
      let n0y = 0;
      let n1x = 0;
      let n1y = 0;
      const near0 = e0x * e0x + e0y * e0y <= reach0;
      const near1 = e1x * e1x + e1y * e1y <= reach1;
      if (near0 || near1) {
        const rp = halfDp * Math.hypot(F01, F11);
        if (near0) {
          const d0 = Math.hypot(e0x, e0y);
          pen0 = d0 - r0.R - rp;
          n0x = e0x / d0;
          n0y = e0y / d0;
        }
        if (near1) {
          const d1 = Math.hypot(e1x, e1y);
          pen1 = d1 - r1.R - rp;
          n1x = e1x / d1;
          n1y = e1y / d1;
        }
      }
      const in0 = pen0 < 0;
      const in1 = pen1 < 0;
      touch[p] = (in0 ? 1 : 0) | (in1 ? 2 : 0);
      const pushMark = pushing && tg === 1;
      // 'dfg': this point's nodes on the second field sit at nNodes + node
      const fb = pf !== null && pfAny[p] ? 9 * p : -1;

      for (let i = 0; i < 3; i++) {
        const wx = i === 0 ? wx0 : i === 1 ? wx1 : wx2;
        const dx = (i - fx) * h;
        const col = (bx + i) * nyN + by;
        for (let j = 0; j < 3; j++) {
          const w = wx * (j === 0 ? wy0 : j === 1 ? wy1 : wy2);
          const dy = (j - fy) * h;
          const idx = fb >= 0 && pf![fb + 3 * i + j] ? col + j + nNodes : col + j;
          gm[idx] += w * m;
          gvx[idx] += w * (mvx + a00 * dx + a01 * dy);
          gvy[idx] += w * (mvy + a10 * dx + a11 * dy);
          // along the roll normal n (roll centre → point): the node lies toward the roll, or within h/2 beyond the point
          if (in0 && pen0 < gpen0[idx] && (!rollSide || dx * n0x + dy * n0y <= hh)) gpen0[idx] = pen0;
          if (in1 && pen1 < gpen1[idx] && (!rollSide || dx * n1x + dy * n1y <= hh)) gpen1[idx] = pen1;
          if (pushMark) gpush[idx] = 1;
        }
      }
    }
    if (loBase === INF) {
      this.gLo = 0;
      this.gHi = 0;
    } else {
      this.gLo = loBase;
      this.gHi = hiBase + 2 * nyN + 3;
    }
  }

  /**
   * Roll k's contact on a node with velocity (vx, vy) at (xi, yi): the approaching normal velocity
   * relative to the roll surface is removed and the tangential one limited by Coulomb friction.
   * Writes the new velocity, the node relative to the roll centre, the unit normal, the gap to the
   * surface and the slip velocity left (relative to the surface) at out[o..o+8] (o = 10 slot); false when
   * the node separates (no contact).
   */
  private projectRoll(k: number, vx: number, vy: number, xi: number, yi: number, mu: number, out: Float64Array, slot: number): boolean {
    const roll = this.rolls[k];
    const rx = xi - roll.cx;
    const ry = yi - roll.cy;
    const d = Math.hypot(rx, ry);
    const nx = rx / d;
    const ny = ry / d;
    // roll surface velocity at the foot of the node
    let ux = -roll.omega * roll.R * ny;
    let uy = roll.omega * roll.R * nx;
    if (roll.vR || roll.vcy) {
      const un = (roll.vcy ?? 0) * ny + (roll.vR ?? 0);
      ux += un * nx;
      uy += un * ny;
    }
    const relx = vx - ux;
    const rely = vy - uy;
    const vn = relx * nx + rely * ny;
    if (vn >= 0) return false; // separating
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
    const o = 10 * slot;
    out[o] = ux + sx;
    out[o + 1] = uy + sy;
    out[o + 2] = rx;
    out[o + 3] = ry;
    out[o + 4] = nx;
    out[o + 5] = ny;
    out[o + 6] = d - roll.R;
    out[o + 7] = sx;
    out[o + 8] = sy;
    return true;
  }

  /**
   * 'dfg': which velocity field each point is on at each of its 9 stencil nodes (1: the second), or null when no
   * point has failed (then everything is the single field, bit for bit). φ = 1 on failed points; at the nodes its
   * gradient G_i = Σ V_p φ_p ∇w(x_i − x_p) points toward the failed points, and C_i is their centre (weights w m).
   * A node splits where |G_i| > 0; there a point is on the far side of the crack (the second field) when it lies
   * beyond C_i along G_i ('centroid'), or when its own interpolated gradient opposes G_i ('gradient'). Only the
   * box of the failed points' stencils (their base columns c0..c1 and rows r0..r1, nodes to c1 + 2 and r1 + 2) is
   * cleared and filled, and only the points whose stencils reach into it are visited; the failed points are found by
   * the typed array's own search. The sums run over the failed points in the same order as a plain loop would.
   */
  private assignFields(): Uint8Array | null {
    const { n, active, failed, px, py, mass, vol0, f00, f01, f10, f11, invH, ox, oy, nyN, gGx, gGy, gCx, gCy, gCw } = this;
    let c0 = Infinity;
    let c1 = -Infinity;
    let r0 = Infinity;
    let r1 = -Infinity;
    for (let p = failed.indexOf(1); p >= 0; p = failed.indexOf(1, p + 1)) {
      if (!active[p]) continue;
      const bx = Math.floor((px[p] - ox) * invH - 0.5);
      const by = Math.floor((py[p] - oy) * invH - 0.5);
      if (bx < c0) c0 = bx;
      if (bx > c1) c1 = bx;
      if (by < r0) r0 = by;
      if (by > r1) r1 = by;
    }
    // last step's region is cleared first (what it wrote), then this step's
    gGx.fill(0, this.gGLo, this.gGHi);
    gGy.fill(0, this.gGLo, this.gGHi);
    gCx.fill(0, this.gGLo, this.gGHi);
    gCy.fill(0, this.gGLo, this.gGHi);
    gCw.fill(0, this.gGLo, this.gGHi);
    if (c0 === Infinity) {
      this.gGLo = this.gGHi = 0;
      this.fLo = this.fHi = 0;
      return null;
    }
    // every node of the box lies in [c0 nyN + r0, (c1 + 2) nyN + r1 + 3)
    this.gGLo = this.fLo = c0 * nyN + r0;
    this.gGHi = this.fHi = (c1 + 2) * nyN + r1 + 3;
    const pf = this.pfBuf.length === 9 * n ? this.pfBuf : (this.pfBuf = new Uint8Array(9 * n));
    this.pfAny.fill(0);
    const { swx: wx, swy: wy, sdx: dx, sdy: dy } = this;
    const weights = (p: number): number => {
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
      // d w / d(x_i) = −d w / d(x_p): the weight falls off as the node moves away from the point
      dx[0] = (1.5 - fx) * invH;
      dx[1] = 2 * (fx - 1) * invH;
      dx[2] = -(fx - 0.5) * invH;
      dy[0] = (1.5 - fy) * invH;
      dy[1] = 2 * (fy - 1) * invH;
      dy[2] = -(fy - 0.5) * invH;
      return bx * nyN + by;
    };
    for (let p = failed.indexOf(1); p >= 0; p = failed.indexOf(1, p + 1)) {
      if (!active[p]) continue;
      const V = vol0[p] * (f00[p] * f11[p] - f01[p] * f10[p]);
      const m = mass[p];
      const base = weights(p);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const idx = base + i * nyN + j;
          gGx[idx] += V * dx[i] * wy[j];
          gGy[idx] += V * wx[i] * dy[j];
          const wm = wx[i] * wy[j] * m;
          gCx[idx] += wm * px[p];
          gCy[idx] += wm * py[p];
          gCw[idx] += wm;
        }
      }
    }
    const byCentroid = (this.params.numerics.crackSide ?? 'centroid') === 'centroid';
    let any = false;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const bx = Math.floor((px[p] - ox) * invH - 0.5);
      if (bx + 2 < c0 || bx > c1 + 2) continue;
      const by = Math.floor((py[p] - oy) * invH - 0.5);
      if (by + 2 < r0 || by > r1 + 2) continue;
      if (byCentroid) {
        // the side needs no weights: the point beyond C_i along G_i, at each node where G_i ≠ 0
        const b = bx * nyN + by;
        let far = 0;
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            const idx = b + i * nyN + j;
            const Gx = gGx[idx];
            const Gy = gGy[idx];
            let f = 0;
            if (Gx !== 0 || Gy !== 0) {
              const w = gCw[idx];
              f = (px[p] - gCx[idx] / w) * Gx + (py[p] - gCy[idx] / w) * Gy > 0 ? 1 : 0;
            }
            pf[9 * p + 3 * i + j] = f;
            far |= f;
          }
        }
        if (far) {
          this.pfAny[p] = 1;
          any = true;
        }
        continue;
      }
      const base = weights(p);
      let gpx = 0;
      let gpy = 0;
      let split = false;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const idx = base + i * nyN + j;
          if (gGx[idx] !== 0 || gGy[idx] !== 0) split = true;
          gpx += wx[i] * wy[j] * gGx[idx];
          gpy += wx[i] * wy[j] * gGy[idx];
        }
      }
      if (!split) continue;
      let far = 0;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const idx = base + i * nyN + j;
          const Gx = gGx[idx];
          const Gy = gGy[idx];
          let f = 0;
          if (Gx !== 0 || Gy !== 0) {
            if (byCentroid) {
              const w = gCw[idx];
              f = (px[p] - gCx[idx] / w) * Gx + (py[p] - gCy[idx] / w) * Gy > 0 ? 1 : 0;
            } else f = gpx * Gx + gpy * Gy < 0 ? 1 : 0;
          }
          pf[9 * p + 3 * i + j] = f;
          far |= f;
        }
      }
      if (far) {
        this.pfAny[p] = 1;
        any = true;
      }
    }
    return any ? pf : null;
  }

  /**
   * 'dfg': the two fields at a node where both have mass meet by frictionless contact before anything else acts
   * on them. The normal n = G/|G| points from the node's side of the crack (first field) to the far side
   * (second); when they approach, (v1 − v2)·n > 0, their normal velocities are made equal, keeping the
   * momentum; when they separate they are left alone. On momenta (the node update divides by the mass after).
   */
  private fieldContact(mMin: number): void {
    const { gm, gvx, gvy, gGx, gGy } = this;
    const N = this.nxN * this.nyN;
    const to = Math.min(this.gHi, this.fHi);
    for (let node = Math.max(this.gLo, this.fLo); node < to; node++) {
      const i2 = node + N;
      const m1 = gm[node];
      const m2 = gm[i2];
      if (m1 <= mMin || m2 <= mMin) continue;
      const Gx = gGx[node];
      const Gy = gGy[node];
      const G = Math.hypot(Gx, Gy);
      if (G === 0) continue;
      const nx = Gx / G;
      const ny = Gy / G;
      const v1n = (gvx[node] * nx + gvy[node] * ny) / m1;
      const v2n = (gvx[i2] * nx + gvy[i2] * ny) / m2;
      if (v1n - v2n <= 0) {
        this.fieldApart++;
        continue;
      }
      this.fieldContacts++;
      // the common normal velocity (centre of mass); each field's normal momentum is set to it
      const vc = (m1 * v1n + m2 * v2n) / (m1 + m2);
      const d1 = m1 * (vc - v1n);
      const d2 = m2 * (vc - v2n);
      gvx[node] += d1 * nx;
      gvy[node] += d1 * ny;
      gvx[i2] += d2 * nx;
      gvy[i2] += d2 * ny;
    }
  }

  private gridUpdate(): void {
    const { gm, gvx, gvy, gpush, nyN, h, ox, oy, dt } = this;
    const mu = this.params.rolling.mu;
    const pushing = this.pusherActive;
    const vPush = this.vIn;
    const invDt = 1 / dt;
    const { binN, binT, accTau, accN, binCol0, nBins } = this;
    let pushImpulse = 0;
    const fyAcc = [0, 0];
    const tqAcc = [0, 0];
    const nNodes = this.nxN * nyN;
    const mMin = 1e-12 * this.mass[0];
    const proj = this.projBuf;
    const NN = this.NN;
    const two = this.pf !== null;
    // every step, so a step with no second field reads 0 (not the last step that had one)
    this.fieldContacts = 0;
    this.fieldApart = 0;
    if (two) this.fieldContact(mMin);
    for (let half = 0; half < (two ? 2 : 1); half++) {
    const off = half * nNodes;
    // the second field has mass only in the failed points' box (its other nodes stay cleared)
    const from = half === 0 ? this.gLo : Math.max(this.gLo, this.fLo);
    const to = half === 0 ? this.gHi : Math.min(this.gHi, this.fHi);
    for (let node = from; node < to; node++) {
      const idx = node + off;
      const m = gm[idx];
      if (m <= mMin) {
        gvx[idx] = 0;
        gvy[idx] = 0;
        continue;
      }
      let vx = gvx[idx] / m;
      let vy = gvy[idx] / m;
      const col = Math.floor(node / nyN);
      const xi = ox + col * h;
      const yi = oy + (node % nyN) * h;
      // Each roll projects the velocity before contact. A node both rolls would hold (a gap of a cell or
      // two) takes the nearer roll only, or the mean of the two at the same distance (on the mid-plane):
      // one after the other favoured the roll projected last and broke the pass's symmetry.
      const on0 = this.gpen[0][idx] < 0 && this.projectRoll(0, vx, vy, xi, yi, mu, proj, 0);
      const on1 = this.gpen[1][idx] < 0 && this.projectRoll(1, vx, vy, xi, yi, mu, proj, 1);
      let w0 = on0 ? 1 : 0;
      let w1 = on1 ? 1 : 0;
      if (on0 && on1) {
        const g = proj[6] - proj[16]; // distances to the two surfaces
        w0 = Math.abs(g) <= 1e-12 * h ? 0.5 : g < 0 ? 1 : 0;
        w1 = 1 - w0;
      }
      if (w0 > 0 || w1 > 0) {
        let nvx = 0;
        let nvy = 0;
        for (let k = 0; k < 2; k++) {
          const wk = k === 0 ? w0 : w1;
          if (!(wk > 0)) continue;
          const o = 10 * k;
          const [kvx, kvy, rx, ry, nx, ny] = [proj[o], proj[o + 1], proj[o + 2], proj[o + 3], proj[o + 4], proj[o + 5]];
          this.gcon[idx] |= 1 << k;
          nvx += wk * kvx;
          nvy += wk * kvy;
          // impulse on the sheet → force; the roll gets the opposite
          const fx = wk * m * (kvx - vx) * invDt;
          const fy = wk * m * (kvy - vy) * invDt;
          fyAcc[k] += -fy;
          tqAcc[k] += -(rx * fy - ry * fx);
          // the impulse on the sheet, and the slip left for followRoll's Coulomb bound
          const jn = (fx * nx + fy * ny) * dt;
          this.contactJn[idx] += jn;
          this.contactJt[idx] += Math.hypot(fx * dt - jn * nx, fy * dt - jn * ny);
          const kIdx = k * NN + idx;
          this.gslipX[kIdx] = wk * proj[o + 7];
          this.gslipY[kIdx] = wk * proj[o + 8];
          if (proj[o + 7] !== 0 || proj[o + 8] !== 0) this.contactSlip[idx] = 1;
          const b = col - binCol0;
          if (b >= 0 && b < nBins) {
            const fn = fx * nx + fy * ny;
            binN[b] += fn;
            accN[b] += fn;
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
    }
    if (this.params.numerics.contact === 'surface') this.followRoll(fyAcc, tqAcc);
    this.accSteps++;
    this.binSteps++;
    this.accFy[0] += fyAcc[0];
    this.accFy[1] += fyAcc[1];
    this.accTorque[0] += tqAcc[0];
    this.accTorque[1] += tqAcc[1];
    const win = this.win;
    win.steps++;
    win.fy[0] += fyAcc[0];
    win.fy[1] += fyAcc[1];
    win.tq[0] += tqAcc[0];
    win.tq[1] += tqAcc[1];
    if (!this.rollsSettled) this.ctlForce += ((Math.abs(fyAcc[0]) + Math.abs(fyAcc[1])) / 2 - this.ctlForce) * Math.min(1, this.dt / this.ctlTauF);
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
    const { c00, c01, c10, c11, f00, f01, f10, f11, failed, pres, vr, pf, pfAny } = this;
    const nNodes = this.nxN * nyN;
    const k4 = 4 * invH * invH;
    const num = this.params.numerics;
    const jbar = num.jbar;
    const rate = num.volumetric !== 'total';
    const cIn = num.volRelax ?? 1;
    const cContact = num.volRelaxContact ?? 1;
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
      // 'dfg': the point's nodes on the second field sit at nNodes + node
      const fb = pf !== null && pfAny[p] ? 9 * p : -1;
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
          const idx = fb >= 0 && pf![fb + 3 * i + j] ? col + j + nNodes : col + j;
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
      c00[p] = l00;
      c01[p] = l01;
      c10[p] = l10;
      c11[p] = l11;
      vx[p] = nvx;
      vy[p] = nvy;
      if (!jbar) continue;
      if (rate) {
        const m = mass[p];
        const th = l00 + l11;
        this.dJ[p] = th;
        // inverted points take no part in the averages (ln J needs J > 0), nor do failed points in tension (they
        // keep their own rate: an opening crack must not dilate its intact neighbours). A failed point under
        // compression (a closed crack) does: on its own rate the grid's point-to-point scatter gave it 1 GPa spikes
        // in the bite, and reading the averages without adding to them left nothing to resist its own volume
        // modes (the pass blew up)
        const Jo = f00[p] * f11[p] - f01[p] * f10[p];
        if ((failed[p] && !(pres[p] > 0)) || !(Jo > 0)) continue;
        const mth = m * th;
        // elastic log volume ln J − ev = −p/K for an intact point (p was set from this F last step)
        const mfe = -m * pres[p] * invK;
        // relaxation fraction β = c · 3K Δεp / σeq, with the contact coefficient near a roll
        let mb = 0;
        const v = vr[p];
        if (v > 0) {
          const ax = px[p] - r0.cx;
          const ay = py[p] - r0.cy;
          const bx1 = px[p] - r1.cx;
          const by1 = py[p] - r1.cy;
          const c = ax * ax + ay * ay < b0 || bx1 * bx1 + by1 * by1 < b1 ? cContact : cIn;
          const b = c * v;
          mb = m * (b < 1 ? b : 1);
        }
        if (fb >= 0) {
          // a point near a crack adds to the averages of the field it is on at each node
          for (let i = 0; i < 3; i++) {
            const wx = i === 0 ? wx0 : i === 1 ? wx1 : wx2;
            for (let j = 0; j < 3; j++) {
              const w = wx * (j === 0 ? wy0 : j === 1 ? wy1 : wy2);
              const idx = (bx + i) * nyN + by + j + (pf![fb + 3 * i + j] ? nNodes : 0);
              gJ[idx] += w * mth;
              gJe[idx] += w * mfe;
              gB[idx] += w * mb;
              gMv[idx] += w * m;
            }
          }
          continue;
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
      const Jold = f00[p] * f11[p] - f01[p] * f10[p];
      const dJ = ((1 + dt * l00) * (1 + dt * l11) - dt * dt * l01 * l10) * Jold;
      this.dJ[p] = dJ;
      const mdJ = mass[p] * dJ;
      if (fb >= 0) {
        for (let i = 0; i < 3; i++) {
          const wx = i === 0 ? wx0 : i === 1 ? wx1 : wx2;
          for (let j = 0; j < 3; j++) gJ[(bx + i) * nyN + by + j + (pf![fb + 3 * i + j] ? nNodes : 0)] += wx * (j === 0 ? wy0 : j === 1 ? wy1 : wy2) * mdJ;
        }
        continue;
      }
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
    const halves = pf !== null ? 2 : 1;
    for (let half = 0; half < halves; half++) {
      const from = half === 0 ? this.gLo : nNodes + Math.max(this.gLo, this.fLo);
      const to = half === 0 ? this.gHi : nNodes + Math.min(this.gHi, this.fHi);
      for (let idx = from; idx < to; idx++) {
        const m = gMa[idx];
        if (m > 0) gJ[idx] /= m;
      }
    }
    // 'rate': nodal relaxation fraction β_i and β_i f̄_i (f̄_i: mass-weighted mean elastic log volume).
    // The point then relaxes by Δf_p = Σ_i w_ip β_i (f̄_i − f_p): symmetric in the mass-weighted sense,
    // so it conserves Σ m f (no volume leaks where β varies) and leaves a uniform field alone.
    if (rate) {
      for (let half = 0; half < halves; half++) {
        const from = half === 0 ? this.gLo : nNodes + Math.max(this.gLo, this.fLo);
        const to = half === 0 ? this.gHi : nNodes + Math.min(this.gHi, this.fHi);
        for (let idx = from; idx < to; idx++) {
          const m = gMv[idx];
          if (m > 0) {
            const b = gB[idx] / m;
            gB[idx] = b;
            gJe[idx] = (b * gJe[idx]) / m;
          }
        }
      }
    }
  }

  /**
   * 'surface': the edge of a point that is inside a roll must not move further into it. The point's
   * velocity interpolates the constrained nodes on its roll side and free nodes deeper in the sheet,
   * which move toward the mid-plane more slowly than the roll surface (the flow converges less at
   * depth), so it would lag behind the surface and sink into the roll. Its edge moves along the normal n
   * (roll centre → point) at (v − u)·n − rp D_nn (the point also gets thinner at the rate D_nn); what it
   * lacks, over the weight the point puts on its constrained nodes, is asked of those nodes
   * (mass-weighted mean of the requests per node), which then carry the velocity the field has there
   * rather than the surface's. The impulse goes to the roll force, torque and profile like the contact's.
   */
  private followRoll(fyAcc: number[], tqAcc: number[]): void {
    const { n, active, touch, px, py, gvx, gvy, gm, gcon, gfolN, gfolD, mass, h, invH, ox, oy, nyN, dt, pf, pfAny, NN } = this;
    const nNodes = this.nxN * nyN;
    const mu = this.params.rolling.mu;
    const k4 = 4 * invH * invH;
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
      // 'dfg': the point's nodes on the second field sit at nNodes + node
      const fb = pf !== null && pfAny[p] ? 9 * p : -1;
      for (let k = 0; k < 2; k++) {
        if (!(touch[p] & (1 << k))) continue;
        const roll = this.rolls[k];
        const rx = px[p] - roll.cx;
        const ry = py[p] - roll.cy;
        const d = Math.hypot(rx, ry);
        const nx = rx / d;
        const ny = ry / d;
        let ux = -roll.omega * roll.R * ny;
        let uy = roll.omega * roll.R * nx;
        if (roll.vR || roll.vcy) {
          const un = (roll.vcy ?? 0) * ny + (roll.vR ?? 0);
          ux += un * nx;
          uy += un * ny;
        }
        let e = 0;
        let W = 0;
        let dnn = 0; // n·L·n, L the APIC velocity gradient (4/h²) Σ w v ⊗ (x_i − x_p)
        for (let a = 0; a < 3; a++) {
          for (let c = 0; c < 3; c++) {
            const idx = (bx + a) * nyN + by + c + (fb >= 0 && pf![fb + 3 * a + c] ? nNodes : 0);
            const wi = w[a * 3 + c];
            const vn = (gvx[idx] - ux) * nx + (gvy[idx] - uy) * ny;
            e += wi * vn;
            dnn += wi * (gvx[idx] * nx + gvy[idx] * ny) * ((a - fx) * nx + (c - fy) * ny) * h;
            if (gcon[idx] & (1 << k)) W += wi;
          }
        }
        // the edge, half the point's deformed height toward the roll
        const edge = e - 0.5 * this.dp * Math.hypot(this.f01[p], this.f11[p]) * k4 * dnn;
        if (edge >= 0 || W <= 0) continue;
        const want = -edge / W;
        for (let a = 0; a < 3; a++) {
          for (let c = 0; c < 3; c++) {
            const idx = (bx + a) * nyN + by + c + (fb >= 0 && pf![fb + 3 * a + c] ? nNodes : 0);
            if (!(gcon[idx] & (1 << k))) continue;
            const wm = w[a * 3 + c] * mass[p];
            // a node the point does not weigh (fx or fy exactly 0.5) gets no request: 0/0 otherwise
            if (!(wm > 0)) continue;
            // per roll: a node both rolls hold (a gap of a cell or two) takes each roll's requests along its own normal
            const kIdx = k * NN + idx;
            if (gfolD[kIdx] === 0) touched.push(kIdx);
            gfolN[kIdx] += wm * want;
            gfolD[kIdx] += wm;
          }
        }
      }
    }
    const invDt = 1 / dt;
    for (const kIdx of touched) {
      const dv = gfolN[kIdx] / gfolD[kIdx];
      gfolN[kIdx] = 0;
      gfolD[kIdx] = 0;
      const k = kIdx < NN ? 0 : 1;
      const idx = kIdx - k * NN;
      const node = idx < nNodes ? idx : idx - nNodes;
      const roll = this.rolls[k];
      const col = Math.floor(node / nyN);
      const rx = ox + col * h - roll.cx;
      const ry = oy + (node % nyN) * h - roll.cy;
      const d = Math.hypot(rx, ry);
      const nx = rx / d;
      const ny = ry / d;
      gvx[idx] += dv * nx;
      gvy[idx] += dv * ny;
      const mi = gm[idx];
      this.contactJn[idx] += mi * dv;
      // Coulomb counts this normal impulse too: a sliding node's slip shrinks by μ dv more (down to sticking)
      const sx = this.gslipX[kIdx];
      const sy = this.gslipY[kIdx];
      const sl = Math.hypot(sx, sy);
      let tx = 0;
      let ty = 0;
      if (sl > 0) {
        const ds = Math.min(sl, mu * dv);
        tx = (-ds * sx) / sl;
        ty = (-ds * sy) / sl;
        gvx[idx] += tx;
        gvy[idx] += ty;
        // down to sticking: exactly 0, or a rounding residue (1e-20) would count the node as sliding
        const stuck = ds >= sl;
        this.gslipX[kIdx] = stuck ? 0 : sx + tx;
        this.gslipY[kIdx] = stuck ? 0 : sy + ty;
        this.contactJt[idx] += mi * ds;
      }
      const f = mi * dv * invDt; // on the sheet, along n
      const fx = f * nx + mi * tx * invDt;
      const fy = f * ny + mi * ty * invDt;
      fyAcc[k] += -fy;
      tqAcc[k] += -(rx * fy - ry * fx);
      const b = col - this.binCol0;
      if (b >= 0 && b < this.nBins) {
        this.binN[b] += f;
        this.accN[b] += f;
        if (sl > 0) {
          // tangent with +x orientation
          const tnx = ny < 0 ? -ny : ny;
          const tny = ny < 0 ? nx : -nx;
          const ft = mi * (tx * tnx + ty * tny) * invDt;
          this.binT[b] += ft;
          this.accTau[b] += ft;
        }
      }
    }
    // a node still slides if some roll that holds it left it a slip
    for (const kIdx of touched) {
      const idx = kIdx < NN ? kIdx : kIdx - NN;
      let slides = 0;
      for (let k = 0; k < 2; k++) {
        const j = k * NN + idx;
        if (gcon[idx] & (1 << k) && (this.gslipX[j] !== 0 || this.gslipY[j] !== 0)) slides = 1;
      }
      this.contactSlip[idx] = slides;
    }
  }

  /** Grid → particles, pass 2: move, update F and the stress, accumulate damage. */
  private g2pUpdate(): void {
    const { n, active, px, py, vx, vy, gJ, gJe, gB, dt, h, invH, ox, oy, nxN, nyN, pf, pfAny } = this;
    const nNodes = nxN * nyN;
    const { c00, c01, c10, c11, dJ, f00, f01, f10, f11, failed, pres, vr, sxx, syy, szz, sxy, temp, vol0, ev, por, drW, drE, dJC, dHM, dCL, duct, locHit, strengthEp, strength } = this;
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
      const l00 = c00[p];
      const l01 = c01[p];
      const l10 = c10[p];
      const l11 = c11[p];
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
        // 'dfg': a point near a crack reads the averages of the field it is on at each node
        const fb = pf !== null && pfAny[p] ? 9 * p : -1;
        for (let i = 0; i < 3; i++) {
          const wx = i === 0 ? 0.5 * (1.5 - fx) * (1.5 - fx) : i === 1 ? 0.75 - (fx - 1) * (fx - 1) : 0.5 * (fx - 0.5) * (fx - 0.5);
          const col = (bx + i) * nyN + by;
          if (fb >= 0) {
            for (let j = 0; j < 3; j++) {
              const w = wx * (j === 0 ? wy0 : j === 1 ? wy1 : wy2);
              const idx = col + j + (pf![fb + 3 * i + j] ? nNodes : 0);
              Jbar += w * gJ[idx];
              if (rate) {
                rA += w * gJe[idx];
                rB += w * gB[idx];
              }
            }
            continue;
          }
          Jbar += wx * (wy0 * gJ[col] + wy1 * gJ[col + 1] + wy2 * gJ[col + 2]);
          if (rate) {
            rA += wx * (wy0 * gJe[col] + wy1 * gJe[col + 1] + wy2 * gJe[col + 2]);
            rB += wx * (wy0 * gB[col] + wy1 * gB[col + 1] + wy2 * gB[col + 2]);
          }
        }
        if (rate) {
          // smoothed rate (Jbar holds it here) plus the relaxation of the elastic log volume toward
          // its grid mean; J advances exactly by exp(Δt θ), so the volume follows the smoothed rate
          const Jold = f00[p] * f11[p] - f01[p] * f10[p];
          if ((failed[p] && !(pres[p] > 0)) || !(Jold > 0)) {
            // not in the averages (inverted, or failed in tension): its own rate, F ← (I + ΔtL) F
            th = l00 + l11;
          } else {
            th = Jbar + (rA + (rB * pres[p]) / K) / dt; // ln Jold − ev = −p/K
            const Jtr = ((1 + dt * l00) * (1 + dt * l11) - dt * dt * l01 * l10) * Jold;
            const r = (Jold * Math.exp(dt * th)) / Jtr;
            cor = r > 0 ? Math.sqrt(r) : 1;
          }
        } else {
          const r = Jbar / dJ[p];
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
      const F00 = f00[p];
      const F01 = f01[p];
      const F10 = f10[p];
      const F11 = f11[p];
      const g00 = cor * (1 + dt * l00);
      const g01 = cor * dt * l01;
      const g10 = cor * dt * l10;
      const g11 = cor * (1 + dt * l11);
      const n00 = g00 * F00 + g01 * F10;
      const n01 = g00 * F01 + g01 * F11;
      const n10 = g10 * F00 + g11 * F10;
      const n11 = g10 * F01 + g11 * F11;
      f00[p] = n00;
      f01[p] = n01;
      f10[p] = n10;
      f11[p] = n11;
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
      let sx = sxx[p];
      let sy = syy[p];
      let sh = sxy[p];
      let sz = szz[p];
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
      if (gtn) pr += K * ev[p]; // only the elastic part of the volume change is stressed

      let q = Math.sqrt(1.5 * (sx * sx + sy * sy + sz * sz + 2 * sh * sh));
      let dep = 0;
      let flowRate = -1;
      const isFailed = failed[p] === 1;
      vr[p] = 0;
      if (isFailed) {
        sx = sy = sz = sh = 0;
        q = 0;
        if (failMode === 'erode' || pr < 0) pr = 0;
      } else if (gtn) {
        const r = gtnReturn(mat, gtn, K, G, q, -pr, this.ep[p], por[p], epsDot, temp[p]);
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
          ev[p] += r.dEv;
          const f = por[p] + r.df;
          por[p] = f < 0 ? 0 : f < 1 ? f : 1;
          const w = r.q * r.dEq + r.sm * r.dEv;
          this.plasticWork += w * vol0[p] * J;
          if (mat.chi > 0) temp[p] += adiabaticRise(mat.chi, w, J, mat.rho, mat.cp);
        }
      } else {
        // the elastic check of plasticIncrement with the point's kept strength: the same σy, no pow
        const ep = this.ep[p];
        if (strengthEp[p] !== ep) {
          strength[p] = staticStrength(mat, ep);
          strengthEp[p] = ep;
        }
        // At room temperature the temperature factor is exactly 1 and, with C ≥ 0, the rate factor is ≥ 1, so
        // q ≤ the static strength already means q ≤ σy (rounding is monotonic): no log of the rate then
        const s0 = strength[p];
        const cool = temp[p] <= mat.tRoom && mat.jcC >= 0;
        dep = (cool && q <= s0) || q <= s0 * strengthFactor(mat, epsDot, temp[p]) ? 0 : plasticIncrement(mat, G, q, ep, epsDot, temp[p]);
        if (dep > 0) {
          const s = 1 - (3 * G * dep) / q;
          sx *= s;
          sy *= s;
          sz *= s;
          sh *= s;
          q -= 3 * G * dep;
          this.ep[p] += dep;
          this.plasticWork += q * dep * vol0[p] * J;
          if (mat.chi > 0) temp[p] += adiabaticRise(mat.chi, q * dep, J, mat.rho, mat.cp);
          flowRate = epsDot;
          drW[p] = DRUCKER_DECAY * drW[p] + druckerWork(sx - rx, sy - ry, sh - rh, sz - sz0, sx, sy, sh, sz, q, dep);
          drE[p] = DRUCKER_DECAY * drE[p] + dep * dep;
        }
      }
      this.flowRate[p] = flowRate;
      sxx[p] = sx;
      syy[p] = sy;
      szz[p] = sz;
      sxy[p] = sh;
      pres[p] = pr;

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
        if (q > 0) vr[p] = (3 * K * dep) / q;
        if (dmg.model === 'localization' && localization(this.el, this.hardening(p), sx, sy, sh, sz).ratio <= 0) locHit[p] = 1;
        const du = 1 / duct[p];
        const Ts = homologousTemperature(mat, temp[p]);
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
          dJC[p] += (dep / jcFractureStrain(dmg, eta, epsDotStar, Ts)) * du;
          dHM[p] += (dep / hmFractureStrain(eta)) * du;
        }
        if (s1 > 0) dCL[p] += ((s1 / q) * dep * du) / dmg.clCrit;
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

  /**
   * How far past the roll centres the sheet has gone through the settled rolls [m]: the roll surface's travel
   * since (the sheet leaves a little faster, by the forward slip). ∞ with rolls that are not adjusted, NaN until
   * they have settled.
   */
  settledLength(): number {
    return (this.t - this.settledT) * this.params.rolling.rollSpeed;
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
    return this.rollsSettled ? 'steady' : 'adjusting';
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

  /**
   * Mean deformation resistance of the sheet in the bite now [Pa]: the plane-strain flow stress 2k = (2/√3) σy,
   * averaged along the contact length (entry plane to the roll centres), as the slab method's twoKMean is, but
   * with σy at each point's own εp and temperature (so with the strain of the stands before, the redundant shear
   * and the heating). The strain rate is the slab method's nominal one at the point's x, at the mill speed
   * (|ε̇| = (2/√3) v hf 2 tan φ / h²): the points do not keep theirs. With the points' own σeq instead the mean
   * is within 0.1 % (docs/validation.md「平均変形抵抗」). A point's weight is its area over the gap's height
   * at its x, so that the mean is along x, not over the area (the bite is thicker at the entry). Failed points
   * carry no flow stress and are left out. null with no point in the bite.
   */
  biteFlowStress(): number | null {
    const { n, active, failed, px, ep, temp, vol0, f00, f01, f10, f11 } = this;
    const r = this.params.rolling;
    const mat = this.params.material;
    const R = this.rolls[0].R;
    const hf = this.gap;
    const c = 2 / Math.sqrt(3);
    let sum = 0;
    let weight = 0;
    for (let p = 0; p < n; p++) {
      const x = px[p];
      if (!active[p] || failed[p] || x < -this.contactLength || x > 0) continue;
      const root = Math.sqrt(R * R - x * x);
      const h = hf + 2 * (R - root);
      const rate = (c * r.millSpeed * hf * 2 * (-x / root)) / (h * h);
      const w = (vol0[p] * (f00[p] * f11[p] - f01[p] * f10[p])) / h;
      sum += w * c * flowStress(mat, ep[p], rate, temp[p]).sy;
      weight += w;
    }
    return weight > 0 ? sum / weight : null;
  }

  /**
   * Thickness and mean speed of the sheet at the exit probe, or at x (null until material is there): the points'
   * outer edges, top − bottom, in a band of h. With rolls that follow the pass the thickness is by area
   * (areaThickness, the band its window): the edges read 0.1 to 0.4 % over the area (more on a coarse lattice, and
   * with the sheet's waviness), and the next stand's entry thickness is by area (thicknessOut) — the gap is held
   * on the thickness the tandem hands on.
   */
  exitMeasure(x = this.xExitProbe, band = this.rollsAdjusted ? this.gaugeBand : this.h): { thickness: number; speed: number } | null {
    const { n, active, px, py, vx } = this;
    let top = -INF;
    let bot = INF;
    let sv = 0;
    let c = 0;
    for (let p = 0; p < n; p++) {
      if (!active[p] || this.failed[p]) continue;
      if (Math.abs(px[p] - x) > band) continue;
      const y = py[p];
      const rp = 0.5 * this.dp * Math.hypot(this.f01[p], this.f11[p]);
      if (y + rp > top) top = y + rp;
      if (y - rp < bot) bot = y - rp;
      sv += vx[p];
      c++;
    }
    if (c < this.NJ) return null;
    if (this.rollsAdjusted) {
      const area = this.areaThickness(x, band);
      return area === null ? null : { thickness: area, speed: sv / c };
    }
    return { thickness: top - bot, speed: sv / c };
  }

  /**
   * Thickness of the sheet about x by area [m]: the points' current area (vol0 J) under a Hann window of
   * half-width w, over the window's length. What thicknessOut() (src/mpm/tandem.ts) reads over a stretch of sheet,
   * here at a place: no edge of a point comes into it, so it does not read the sheet's waviness or its rise off
   * the pass line as thickness (the edges' top − bottom in a band does). Null until the sheet fills the window.
   */
  areaThickness(x: number, w: number): number | null {
    const { n, active, px, vol0, f00, f01, f10, f11 } = this;
    if (!(this.headX() >= x + w) || !(this.tailX() <= x - w)) return null;
    let sum = 0;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const u = (px[p] - x) / w;
      if (u <= -1 || u >= 1) continue;
      sum += 0.5 * (1 + Math.cos(Math.PI * u)) * vol0[p] * (f00[p] * f11[p] - f01[p] * f10[p]);
    }
    return sum / w;
  }

  /**
   * The roll force [N/m] and torque [N·m/m] over the steps since the last call (mean of both rolls, as
   * diagnostics() takes them over its own window), and restart. Apart from diagnostics(): reading one does not
   * restart the other. Null when no step was taken.
   */
  readWindow(): { force: number; torque: number; steps: number } | null {
    const w = this.win;
    const steps = w.steps;
    if (steps === 0) return null;
    const force = (Math.abs(w.fy[0]) + Math.abs(w.fy[1])) / 2 / steps;
    const torque = (-w.tq[0] + w.tq[1]) / 2 / steps;
    w.steps = 0;
    w.fy[0] = w.fy[1] = w.tq[0] = w.tq[1] = 0;
    return { force, torque, steps };
  }

  /** Diagnostics; the force averages and the kinetic-energy interval restart after each call. */
  diagnostics(): Diagnostics {
    if (this.accSteps > 0) {
      const steps = this.accSteps;
      this.lastForce = (Math.abs(this.accFy[0]) + Math.abs(this.accFy[1])) / 2 / steps;
      // top roll turns counter-clockwise (ω > 0): driving torque opposes the resisting torque of the sheet
      this.lastTorque = (-this.accTorque[0] + this.accTorque[1]) / 2 / steps;
      this.lastPush = this.accPush / steps;
      [this.lastNeutral, this.lastNeutralState] = this.neutralPoint(this.accTau, this.accN);
    }
    const fy = this.lastForce;
    const tq = this.lastTorque;
    const push = this.lastPush;
    this.accSteps = 0;
    this.accFy = [0, 0];
    this.accTorque = [0, 0];
    this.accPush = 0;
    this.accTau.fill(0);
    this.accN.fill(0);
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
      rollRadius: this.rolls[0].R,
      gap: this.gap,
      rollsSettled: this.rollsSettled,
      pusherForce: push,
      pusherActive: this.pusherActive,
      backTension: this.backNow,
      frontTension: this.frontNow,
      exitThickness: ex ? ex.thickness : null,
      forwardSlip: ex ? ex.speed / this.params.rolling.rollSpeed - 1 : null,
      neutralX: this.lastNeutral,
      neutralState: this.lastNeutralState,
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
   * Neutral point from the tangential and normal force per bin: the end of the entry-side zone
   * where friction drives the sheet (+x), taken where the running sum from the entry peaks (robust
   * to a stray sign flip) and refined to the zero crossing between that bin and the next. Only a
   * zero inside the bite counts; otherwise null, with the reason (see Diagnostics.neutralState).
   */
  private neutralPoint(tau: Float64Array, fn: Float64Array): [number | null, NeutralState] {
    const { binX0, binW } = this;
    const Lc = this.contactLength;
    const mu = this.params.rolling.mu;
    let cum = 0;
    let best = 0;
    let bb = -1;
    let contact = false;
    for (let b = 0; b < tau.length; b++) {
      cum += tau[b];
      if (cum > best) {
        best = cum;
        bb = b;
      }
      if (fn[b] > 0) contact = true;
    }
    if (!contact) return [null, 'none'];
    if (bb >= 0 && bb + 1 < tau.length && tau[bb + 1] < 0) {
      const t0 = tau[bb];
      const t1 = tau[bb + 1];
      const x = binX0 + (bb + 0.5) * binW + (binW * t0) / (t0 - t1);
      if (x > -Lc && x < 0) return [x, 'found'];
    }
    // no zero in the bite: the whole arc sticks (friction under μ p in every bin, 1 % for round-off:
    // a slipping node carries μ p exactly), or friction acts one way all along
    let sticking = true;
    let sum = 0;
    for (let b = 0; b < tau.length; b++) {
      const xb = binX0 + (b + 0.5) * binW;
      if (!(xb > -Lc && xb < 0) || !(fn[b] > 0)) continue;
      if (Math.abs(tau[b]) >= 0.99 * mu * fn[b]) sticking = false;
      sum += tau[b];
    }
    return [null, sticking ? 'sticking' : sum > 0 ? 'backward' : 'forward'];
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
    // a record whose points are all gone (a tandem's next stand only takes the points on the grid) stays where it started
    return this.cracks.map((k) => ({ id: k.id, x: c[k.id] ? sx[k.id] / c[k.id] : k.x, y: c[k.id] ? sy[k.id] / c[k.id] : k.y, count: k.count }));
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

/**
 * Where rolls that follow the pass start: the slab method's answer with the strain the sheet brings in
 * (rolling.entryStrain, a tandem's later stands), so that the pass has only the difference to find (R' within 2 %
 * on the standard pass). Flattened: karmanFlattened's R' and force. Constant reduction: the gap less the sheet's
 * elastic recovery, h (1 − ν²) 2k / E with 2k the slab method's at the exit.
 */
export function presetRolls(r: RollingParams, m: MaterialParams): { rollRadius: number; gap: number; force: number } {
  const flat = r.flattening === 'hitchcock';
  const ep0 = r.entryStrain ?? 0;
  // the MPM's force is 1.07 to 1.14 times the slab method's on thin sheet (docs/validation.md): Hitchcock's radius
  // for PRESET_FORCE_RATIO times the method's force, solved together (a softer roll by that ratio is the same thing)
  const soft = { ...r, rollE: (r.rollE ?? ROLL_E) / PRESET_FORCE_RATIO };
  const guess = flat ? karmanFlattened(soft, m, 400, ep0) : { slab: karman(r, m, 400, ep0), rollRadius: r.rollRadius };
  const target = r.h0 * (1 - r.reduction);
  const twoK = guess.slab.twoK;
  const gap = r.gapControl === 'reduction' ? target * (1 - ((1 - m.nu * m.nu) * twoK[twoK.length - 1]) / m.E) : target;
  return { rollRadius: guess.rollRadius, gap, force: flat ? PRESET_FORCE_RATIO * guess.slab.force : 0 };
}
