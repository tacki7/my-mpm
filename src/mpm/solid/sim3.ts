// Three-dimensional MPM of a strip passing between two rigid rolls: x along rolling, y through the
// thickness, z across the width. The section model (solver.ts) is plane strain — the strip cannot get
// wider; the plan-view model (planview/sim.ts) resolves the width but averages through the thickness.
// This one resolves both, so the strip spreads, the load varies across the width, and the edges bulge.
//
// - A quarter of the strip is solved: the mid-thickness plane y = 0 and the mid-width plane z = 0 are
//   symmetry planes. The one layer of ghost nodes beyond each is folded onto its mirror image (the
//   normal momentum negated) before the grid update and takes the mirrored velocity back after it; the
//   planes' own nodes get no normal velocity. The top surface and the edge z = W/2 are free.
// - The scheme is the section model's, a dimension up: MLS-MPM with quadratic B-splines (27 nodes a
//   point), the stress as a deviator (Jaumann rotation, elastic trial, J2 radial return of
//   material.ts) and a pressure from the volume ratio, p = −K ln J, the volume following the grid's
//   mean volumetric rate with the elastic log volume relaxed toward its grid mean where the point
//   flows ('rate' volume averaging, docs/model.md「体積の平均化」) — without it the pressure locks.
// - The roll is a rigid cylinder along z (the top one; the bottom one is its mirror image). A point
//   whose top edge is inside it marks its nodes on the roll's side; a marked node that approaches the
//   surface loses its normal velocity relative to it, and its tangential velocity (along the arc and
//   along z) is limited by Coulomb friction. The friction along z is what holds the spread back.
// - Pusher, mass scaling, the mill-speed scaling of the strain rate and the damage indicators mean the
//   same as in the section model, and so are rolls that follow the pass (Hitchcock's flattening with the
//   roll force per unit width, a constant reduction on the strip's mean thickness: adjustRolls).
//   Strip tensions as in the section model: a stress on the end column's actual cross-section (the quarter's),
//   shared over the h0-long grips at the ends by a linear weight and each point's deformed section (updateTension,
//   gripScale). No crack faces: a failed point carries no deviator and no tension (it is counted, and the first one
//   is recorded). A tandem is a Sim3 per stand (tandem3.ts).
// - Roll bending (solid.rollBend): the roll is a beam on two supports (rollBend.ts) loaded by the contact force by z
//   column, low-passed as the flattening's force is; its axis sits higher by the deflection δ(z), so the gap opens
//   toward the middle of the width. Solved together with the pass every step (updateBend); 'steady' waits for the
//   deflection to settle as it does for the rolls' radius.
import { startOffset, tailMargin, biteGeometry, cloneParams, hitchcockRadius, ROLL_E, ROLL_NU, type DamageModel, type SimParams } from '../params.ts';
import { beamDeflection, type Beam } from './rollBend.ts';
import { CTL_EVERY, CTL_TOL_H, CTL_TOL_R, presetRolls } from '../solver.ts';
import { adiabaticRise, elasticConstants, hmFractureStrain, homologousTemperature, jcFractureStrain, plasticIncrement, staticStrength, strengthFactor, type Elastic } from '../material.ts';
import { GpuStepper } from './gpu/stepper.ts';
import { f64, grid3Buffers, grid3From, makeGrid3, u8, PHASES, PH_FOLA, PH_FOLB, PH_G2PU, PH_G2PV, PH_GRID, PH_P2G, PH_VMEAN, PT_COUNT, PT_FIRST, PT_FY, PT_IXHI, PT_IXLO, PT_NFAIL, PT_TQ, PT_WORK, SY_BACK_NOW, SY_BACK_SCALE, SY_BOUNDS, SY_COUNT, SY_CY, SY_FRONT_NOW, SY_FRONT_SCALE, SY_IXHI, SY_IXLO, SY_IXPREVHI, SY_IXPREVLO, SY_OMEGA, SY_PUSHING, SY_R, SY_STEP, SY_T, SY_VCY, SY_VR, type Grid3, type Grid3Buffers } from './grid3.ts';
import { PSTRIDE, P_ACTIVE, P_C, P_DCL, P_DHM, P_DJC, P_EP, P_ETA, P_F, P_FAILED, P_FAILSTEP, P_MASS, P_PRES, P_S, P_SEQ, P_STR, P_STREP, P_TEMP, P_TH, P_TOUCH, P_V, P_VOL0, P_VR, P_WORK, P_X, P_YSIZE, U, U_INTS } from './gpu/kernels.ts';

export interface SolidSettings {
  /** full strip width at the entry [m] */
  width: number;
  /** no lateral velocity anywhere (the plane-strain limit: what the section model solves) */
  planeStrain?: boolean;
  /**
   * The rolls bend under the load (rollBend.ts): the barrel's length and the distance between the supports [m]
   * (0 or absent: the barrel's ends). Absent, or a barrel of 0: rigid rolls
   */
  rollBend?: { barrel: number; span?: number };
  /**
   * The strip's crown at the entry [m]: the thickness at the mid-width (h0) less the thickness at the edge, as a
   * parabola across the width, h(z) = h0 − crownIn (z / half width)². Negative: thinner at the middle. Absent: flat
   */
  crownIn?: number;
  /**
   * The whole thickness solved, with both rolls (the mid-thickness plane is no plane of symmetry): the strip's
   * y runs from −h/2 to h/2 and the lattice has 2 NJ rows. Absent: the quarter model (the top half, y ≥ 0)
   */
  fullThickness?: boolean;
}

export interface Solid3Params extends SimParams {
  solid: SolidSettings;
}

/** 'adjusting': where 'steady' would be, while the rolls' radius (flattening) or the gap (constant reduction) still change */
export type SolidPhase = 'approach' | 'bite' | 'adjusting' | 'steady' | 'tail-out' | 'done' | 'stalled';

export interface SolidCrack {
  t: number;
  step: number;
  x: number;
  y: number;
  z: number;
  /** where it sat in the undeformed strip: from the head end backwards, from the mid-thickness, from the mid-width [m] */
  sheetX: number;
  sheetY: number;
  sheetZ: number;
  /** the point that failed (the index in the stand it failed in; a later stand's copy keeps it, tracker3.ts) */
  point: number;
  eta: number;
  seq: number;
  ep: number;
  criterion: DamageModel;
}

const INF = 1e30;

export function solidParams(base: SimParams, solid: SolidSettings): Solid3Params {
  return { ...cloneParams(base), solid: { ...solid } };
}

/**
 * What a pass's grid and clock come to without building it (Sim3's own values: tools/checks/solid3-tandem.mjs compares):
 * cell size, time step, contact length, the exit probe's x and the entry speed.
 */
/** the rolls a pass starts with: the params', or (rolls that follow the pass) the slab method's answer (solver.ts presetRolls) */
function startRolls(P: SimParams): { adjusted: boolean; gap: number; R: number; contactLength: number; force: number } {
  const r = P.rolling;
  const adjusted = r.flattening === 'hitchcock' || r.gapControl === 'reduction';
  if (!adjusted) {
    const geo = biteGeometry(r);
    return { adjusted, gap: geo.gap, R: r.rollRadius, contactLength: geo.contactLength, force: 0 };
  }
  const start = presetRolls(r, P.material);
  const dh = r.h0 - start.gap;
  return { adjusted, gap: start.gap, R: start.rollRadius, contactLength: Math.sqrt(start.rollRadius * dh - (dh * dh) / 4), force: start.force };
}

export function solidScales(P: SimParams): { h: number; dt: number; contactLength: number; xExitProbe: number; vIn: number; rollsAdjusted: boolean } {
  const r = P.rolling;
  const num = P.numerics;
  const el = elasticConstants(P.material);
  const start = startRolls(P);
  const Lc = start.contactLength;
  const h = r.h0 / num.cellsThrough;
  const rho = P.material.rho * num.massScale;
  const c = Math.sqrt((el.K + (4 / 3) * el.G) / rho);
  return { h, dt: (num.cfl * h) / (c + 1.5 * r.rollSpeed), contactLength: Lc, xExitProbe: Math.max(6 * h, Math.min(3 * r.h0, 2 * Lc)), vIn: r.rollSpeed * (1 - r.reduction), rollsAdjusted: start.adjusted };
}

/** the particle arrays of a Sim3 by name (a worker of a team attaches to the coordinator's) */
export type ParticleBuffers = Record<string, ArrayBufferLike>;

/** everything a team's worker shares with the coordinator: the state, the grids and the blocks of sums */
export interface Sim3Buffers {
  particles: ParticleBuffers;
  bend: ArrayBufferLike;
  bendVel: ArrayBufferLike;
  ySize: ArrayBufferLike;
  sync: ArrayBufferLike;
  part: ArrayBufferLike;
  accFz: ArrayBufferLike;
  accMap: ArrayBufferLike;
  stepFz: ArrayBufferLike;
  main: Grid3Buffers;
  own: Grid3Buffers;
  left: Grid3Buffers | null;
}

/** what a worker of a team hands back after a step (views on its shared blocks) */
export interface TeamSums {
  part: Float64Array;
  accFz: Float64Array;
  accMap: Float64Array;
  stepFz: Float64Array;
}

export interface Sim3Options {
  /** the arrays on SharedArrayBuffers: the coordinator of a team (team.ts) */
  shared?: boolean;
  /** a worker of a team: the arrays are the coordinator's, no points are made */
  attach?: Sim3Buffers;
  /** this worker's place in the team (0: the coordinator, which also steps its share) and the team's size */
  rank?: number;
  size?: number;
}

/** the names of the Float64 particle arrays (shared with a team's workers as they are) */
const PARTICLE_F64 = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'C', 'F', 'mass', 'vol0', 'sxx', 'syy', 'szz', 'sxy', 'syz', 'szx', 'pres', 'ep', 'temp', 'seq', 'eta', 'dJC', 'dHM', 'dCL', 'strength', 'strengthEp', 'vr', 'th'] as const;
const PARTICLE_U8 = ['active', 'failed', 'touch', 'owner'] as const;

export class Sim3 {
  readonly params: Solid3Params;
  readonly el: Elastic;
  /** the roll gap now (it changes while the rolls are adjusted) and the contact length the pass started with */
  gap: number;
  readonly contactLength: number;
  readonly h: number;
  readonly dp: number;
  readonly dt: number;
  readonly vIn: number;
  readonly xHead0: number;
  readonly xExitProbe: number;
  readonly halfWidth0: number;
  /** the entry thickness by lattice column across the width, as a fraction of h0 (the entry crown; 1 without) */
  readonly ySize: Float64Array;
  readonly inertiaRatio: number;
  /** the top roll: a cylinder along z through (0, cy); bent, its axis is at cy + bend[iz] over the z column iz */
  readonly roll: { cy: number; R: number; omega: number; vR: number; vcy: number };
  /** the roll as a beam (null: rigid), the deflection of its axis by z column [m] and its rate [m/s] (nodes iz, z = (iz − 1) h) */
  readonly beam: Beam | null;
  readonly bend: Float64Array;
  private readonly bendVel: Float64Array;
  /** the contact force by z column over this step [N], and the load low-passed [N/m] on the full width at z_k = k h */
  private readonly stepFz: Float64Array;
  private readonly bendQ: Float64Array;
  private bendRef = 0;
  private bendSince = 0;
  private bendSum = 0;
  private bendCount = 0;
  /** the deflection has settled (true with rigid rolls) */
  bendSettled: boolean;
  /** the rolls follow the pass (flattening 'hitchcock' or gapControl 'reduction'), and whether they have settled (true with rolls that do not) */
  readonly rollsAdjusted: boolean;
  rollsSettled: boolean;
  /** when the rolls settled [s] (−∞ with rolls that are not adjusted, NaN until then) */
  settledT = NaN;
  /** where the gap control measures the strip: one entry thickness past the roll centres, in a Hann window of half-width gaugeBand */
  readonly xGauge: number;
  readonly gaugeBand: number;
  private readonly ctlTauF: number;
  private readonly ctlTauH: number;
  private readonly ctlTauG: number;
  private readonly ctlWindow: number;
  private readonly ctlTransit: number;
  /** the roll force per unit width, low-passed [N/m], and its floor while the head comes through (the slab method's) */
  private ctlForce = 0;
  private readonly ctlForce0: number;
  /** the width the force is spread over: the mean of the entry width and the width at the gauge [m] */
  private ctlWidth: number;
  private ctlThick = NaN;
  private ctlThickRef = NaN;
  private ctlGapRef = NaN;
  private ctlRRef: number;
  private ctlRSince = 0;
  private ctlHSince = Infinity;
  // grid: node (ix, iy, iz) at (ox + ix h, (iy − gyOff) h, (iz − 1) h), index (ix nyN + iy) nzN + iz
  readonly ox: number;
  /**
   * The whole thickness solved (SolidSettings.fullThickness): no fold, mirror or held row at iy = 1, the strip's
   * y runs both ways and the bottom roll is the top roll seen through the mid-thickness plane (a node or point
   * below it is tested against the top roll with y → −y and vy → −vy, the answer turned back). The sums over
   * both rolls are halved where one roll's are read (rollShare)
   */
  readonly fullThickness: boolean;
  /** the row of nodes on y = 0: gy = y / h + gyOff (1 in the quarter model, whose row iy = 0 is the ghost layer) */
  readonly gyOff: number;
  /** the first row of nodes that is the strip's own (1 in the quarter model, 0 in the full one) */
  readonly iyLo: number;
  /** one roll's share of the sums over the rolls (½ in the full model, 1 in the quarter) */
  readonly rollShare: number;
  /** the lattice row on y = 0 in the full model (0 in the quarter: its rows start at the plane) */
  readonly jOff: number;
  /** a point past this y (or −yMax in the full model) has left the grid [m] */
  readonly yMax: number;
  readonly nxN: number;
  readonly nyN: number;
  readonly nzN: number;
  // lattice: point (i, j, k) = (along x from the tail, up from the mid-thickness, out from the mid-width), index (i NJ + j) NK + k
  readonly NI: number;
  readonly NJ: number;
  readonly NK: number;
  readonly n: number;
  t = 0;
  step = 0;
  pusherActive = true;
  stalled = false;
  /** tension stresses applied at this step, after ramping [Pa] */
  backNow = 0;
  frontNow = 0;
  /** end column section / Σ w A_p over the tail's and the head's grips (see gripScale) */
  private backScale = 1;
  private frontScale = 1;
  private backOffAt = -1;
  private frontOnAt = -1;
  /** ramp time of the tensions [s] */
  readonly tensionRamp: number;
  /** lattice columns in each end's grip (h0 long, at most half the strip) */
  readonly gripCols: number;
  plasticWork = 0;
  nFailed = 0;
  firstCrack: SolidCrack | null = null;
  /** a tandem's later stand: point q was copied from the stand before's point parentOf[q] (remap3); null in the first */
  parentOf: Int32Array | null = null;

  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  /** velocity gradient (APIC), row-major 3 × 3 */
  readonly C: Float64Array;
  /** deformation gradient, row-major 3 × 3 */
  readonly F: Float64Array;
  readonly mass: Float64Array;
  readonly vol0: Float64Array;
  // deviatoric stress
  readonly sxx: Float64Array;
  readonly syy: Float64Array;
  readonly szz: Float64Array;
  readonly sxy: Float64Array;
  readonly syz: Float64Array;
  readonly szx: Float64Array;
  readonly pres: Float64Array;
  readonly ep: Float64Array;
  readonly temp: Float64Array;
  readonly seq: Float64Array;
  readonly eta: Float64Array;
  readonly dJC: Float64Array;
  readonly dHM: Float64Array;
  readonly dCL: Float64Array;
  readonly active: Uint8Array;
  readonly failed: Uint8Array;
  readonly touch: Uint8Array;
  /**
   * the worker whose point it is this step (rank + 1; 0 none yet), decided by its base cell column at the scatter
   * (p2g). The later stages go by this, not by the position: the update moves the point, and a neighbour that reads
   * the moved position in the same stage would take the point as its own and update it twice (a race, seen)
   */
  readonly owner: Uint8Array;
  private readonly strength: Float64Array;
  private readonly strengthEp: Float64Array;
  private readonly vr: Float64Array;
  private readonly th: Float64Array;

  /**
   * The grid the stages scatter into (g) and the one they gather from and update the nodes of (G). Alone they are
   * the same arrays. In a team (team.ts) every worker scatters its own points into its own copy g, and the owner of
   * a column of nodes sums the copies into the main grid G: its own and the copy of the worker below it (left),
   * whose points reach two of its columns. The nodes' update and the gathers then read G.
   */
  private readonly g: Grid3;
  private readonly G: Grid3;
  private readonly left: Grid3 | null;
  /** this worker's columns: the points whose base cell column is in [pLo, pHi), and the nodes of those columns */
  private pLo = -1e9;
  private pHi = 1e9;
  readonly rank: number;
  readonly size: number;
  /** the sync block the coordinator writes for the team's stages (grid3.ts SY_*) and this worker's partial sums (PT_*) */
  readonly sync: Float64Array;
  readonly part: Float64Array;
  /** the columns this worker's points scattered into last step (zeroed before the next scatter) */
  private ownPrevLo = 0;
  private ownPrevHi: number;
  private ixLo = 0;
  private ixHi = 0;
  private ixPrevLo = 0;
  private ixPrevHi: number;

  // roll force on the quarter model since the last read [N]·steps, and the same by z column and by (x, z) cell
  private accFy = 0;
  private accTq = 0;
  private accSteps = 0;
  private readonly accFz: Float64Array;
  /** normal contact force by (x column from binCol0, z column from the mid-width) since the last read */
  private readonly accMap: Float64Array;
  readonly binCol0: number;
  readonly nBinsX: number;
  private stallX = -INF;

  /** the step on a WebGPU device (attachGpu); null: the CPU's advance() */
  gpu: GpuStepper | null = null;
  /** the plastic work before the GPU took over (the device sums its own from zero) */
  private gpuWork0 = 0;
  /** the uniform block's constant part, filled when the GPU is attached */
  private gpuBase: ArrayBuffer | null = null;

  constructor(input: Solid3Params, opts: Sim3Options = {}) {
    const P: Solid3Params = { ...cloneParams(input), solid: { ...input.solid } };
    const attach = opts.attach ?? null;
    const shared = opts.shared === true || attach !== null;
    this.rank = opts.rank ?? 0;
    this.size = opts.size ?? 1;
    this.params = P;
    const r = P.rolling;
    const num = P.numerics;
    if (num.cellsThrough % 2 !== 0) throw new Error('cellsThrough must be even (the mid-thickness plane lies on a row of nodes)');
    this.el = elasticConstants(P.material);
    const start = startRolls(P);
    this.gap = start.gap;
    this.contactLength = start.contactLength;
    const h = r.h0 / num.cellsThrough;
    this.h = h;
    const dp = h / num.ppc;
    this.dp = dp;
    const hw = P.solid.width / 2;
    this.halfWidth0 = hw;

    const Lc = this.contactLength;
    // just short of the rolls (params.ts startOffset)
    const offset = startOffset(P, h, this.el.K, this.el.G);
    this.xHead0 = -Lc - offset;
    const xTail0 = this.xHead0 - r.sheetLength;
    const elongated = r.sheetLength / (1 - r.reduction);
    const xEnd = 2 * r.h0 + 2 * h + elongated * 1.1 + 8 * h;
    this.ox = xTail0 - tailMargin(h, offset);
    this.nxN = Math.ceil((xEnd - this.ox) / h) + 1;
    const full = P.solid.fullThickness === true;
    this.fullThickness = full;
    // the quarter: the ghost row, the plane's row, and rows up past the surface; the full strip: the same both ways
    const rowsUp = Math.ceil((r.h0 / 2 + 4 * h) / h);
    this.nyN = full ? 2 * rowsUp + 1 : rowsUp + 2;
    this.gyOff = full ? rowsUp : 1;
    this.iyLo = full ? 0 : 1;
    this.rollShare = full ? 0.5 : 1;
    this.yMax = (this.nyN - 3 - this.gyOff) * h;
    // room for the spread: a quarter of the half width, and four cells
    this.nzN = Math.ceil((hw * 1.25 + 4 * h) / h) + 2;
    const NN = this.nxN * this.nyN * this.nzN;
    if (attach) {
      this.G = grid3From(attach.main);
      this.g = grid3From(attach.own);
      this.left = attach.left ? grid3From(attach.left) : null;
      this.sync = new Float64Array(attach.sync);
      this.part = new Float64Array(attach.part);
    } else {
      this.G = makeGrid3(NN, shared);
      // a team's coordinator scatters into a copy of its own like the workers; alone, into the grid itself
      this.g = this.size > 1 ? makeGrid3(NN, shared) : this.G;
      this.left = null;
      this.sync = f64(SY_COUNT, shared);
      this.part = f64(PT_COUNT, shared);
      this.part[PT_FIRST] = -1;
    }
    this.ixPrevHi = this.nxN;
    this.ownPrevHi = this.nxN;

    const R = start.R;
    this.roll = { cy: R + this.gap / 2, R, omega: r.rollSpeed / R, vR: 0, vcy: 0 };
    const rb = P.solid.rollBend;
    if (rb && rb.barrel > 0) {
      const span = rb.span && rb.span > 0 ? rb.span : rb.barrel;
      if (span < P.solid.width) throw new Error('the strip is wider than the distance between the roll supports');
      this.beam = { D: 2 * r.rollRadius, span, E: r.rollE ?? ROLL_E, nu: r.rollNu ?? ROLL_NU };
    } else this.beam = null;
    this.bend = attach ? new Float64Array(attach.bend) : f64(this.nzN, shared);
    this.bendVel = attach ? new Float64Array(attach.bendVel) : f64(this.nzN, shared);
    this.stepFz = attach ? new Float64Array(attach.stepFz) : f64(this.nzN, shared);
    this.bendQ = new Float64Array(this.nzN);
    this.bendSettled = this.beam === null;
    this.xExitProbe = Math.max(6 * h, Math.min(3 * r.h0, 2 * Lc));
    // the control's pace, as the section model's (solver.ts)
    this.rollsAdjusted = start.adjusted;
    this.rollsSettled = !start.adjusted;
    if (this.rollsSettled) this.settledT = -Infinity;
    this.ctlForce0 = start.force;
    this.ctlWidth = P.solid.width;
    this.xGauge = r.h0;
    const transit = Lc / r.rollSpeed;
    const delay = this.xGauge / r.rollSpeed;
    this.ctlTauF = transit / 4;
    this.ctlTauH = delay / 2;
    this.ctlTauG = 2 * delay;
    this.ctlWindow = transit / 2;
    this.ctlTransit = transit;
    this.gaugeBand = Math.min((4 * dp) / (1 - r.reduction), 0.8 * r.h0);
    this.ctlRRef = R;

    const NI = Math.round(r.sheetLength / dp);
    const NJ = full ? Math.round(r.h0 / dp) : Math.round(r.h0 / 2 / dp);
    this.jOff = full ? NJ / 2 : 0;
    const NK = Math.max(1, Math.round(hw / dp));
    this.NI = NI;
    this.NJ = NJ;
    this.NK = NK;
    const n = NI * NJ * NK;
    this.n = n;
    const pb = attach?.particles ?? null;
    const A = (name: string, k = 1) => (pb ? new Float64Array(pb[name]) : f64(k * n, shared));
    this.px = A('px');
    this.py = A('py');
    this.pz = A('pz');
    this.vx = A('vx');
    this.vy = A('vy');
    this.vz = A('vz');
    this.C = A('C', 9);
    this.F = A('F', 9);
    this.mass = A('mass');
    this.vol0 = A('vol0');
    this.sxx = A('sxx');
    this.syy = A('syy');
    this.szz = A('szz');
    this.sxy = A('sxy');
    this.syz = A('syz');
    this.szx = A('szx');
    this.pres = A('pres');
    this.ep = A('ep');
    this.temp = A('temp');
    this.seq = A('seq');
    this.eta = A('eta');
    this.dJC = A('dJC');
    this.dHM = A('dHM');
    this.dCL = A('dCL');
    this.strength = A('strength');
    this.strengthEp = A('strengthEp');
    if (!pb) this.strengthEp.fill(NaN);
    this.vr = A('vr');
    this.th = A('th');
    this.active = pb ? new Uint8Array(pb.active) : u8(n, shared);
    if (!pb) this.active.fill(1);
    this.failed = pb ? new Uint8Array(pb.failed) : u8(n, shared);
    this.touch = pb ? new Uint8Array(pb.touch) : u8(n, shared);
    this.owner = pb ? new Uint8Array(pb.owner) : u8(n, shared);

    this.vIn = r.rollSpeed * (1 - r.reduction);
    const rho = P.material.rho * num.massScale;
    // the width is NK points exactly: their spacing across z is hw / NK (dp up to the rounding)
    const dz = hw / NK;
    // the entry crown: each column's points are packed (or spread) through the thickness by h(z) / h0, with the
    // volume and the mass to match; F stays I (a stress-free start), so the column's size through the thickness
    // is dp ySize[k] wherever a point's extent matters (section, exitMeasure, the drawn faces)
    const crown = P.solid.crownIn ?? 0;
    if (Math.abs(crown) >= r.h0) throw new Error('the entry crown must be smaller than the thickness');
    this.ySize = attach ? new Float64Array(attach.ySize) : f64(NK, shared);
    if (!attach) for (let k = 0; k < NK; k++) this.ySize[k] = 1 - (crown * ((k + 0.5) * dz) ** 2) / (hw * hw * r.h0);
    let p = 0;
    // a team's worker attaches to the coordinator's points
    if (!attach) for (let i = 0; i < NI; i++) {
      for (let j = 0; j < NJ; j++) {
        for (let k = 0; k < NK; k++, p++) {
          const sy = this.ySize[k];
          this.px[p] = xTail0 + (i + 0.5) * dp;
          this.py[p] = (j + 0.5 - this.jOff) * dp * sy;
          this.pz[p] = (k + 0.5) * dz;
          this.vx[p] = this.vIn;
          this.F[9 * p] = 1;
          this.F[9 * p + 4] = 1;
          this.F[9 * p + 8] = 1;
          this.vol0[p] = dp * sy * dp * dz;
          this.mass[p] = rho * dp * sy * dp * dz;
          this.temp[p] = P.material.tRoom;
        }
      }
    }
    this.dz = dz;

    const c = Math.sqrt((this.el.K + (4 / 3) * this.el.G) / rho);
    this.dt = (num.cfl * h) / (c + 1.5 * r.rollSpeed);
    // tensions ramp over ten passes of the (mass-scaled) elastic wave along the strip (solver.ts)
    this.tensionRamp = r.tensionRamp && r.tensionRamp > 0 ? r.tensionRamp : (10 * r.sheetLength) / c;
    this.gripCols = Math.max(1, Math.min(Math.round(r.h0 / dp), Math.floor(NI / 2)));
    const epMid = (1 / Math.sqrt(3)) * Math.log(1 / (1 - r.reduction));
    const twoK = (2 / Math.sqrt(3)) * staticStrength(P.material, epMid);
    this.inertiaRatio = (rho * r.rollSpeed * r.rollSpeed * r.reduction) / twoK;

    this.binCol0 = Math.round((-Lc - 3 * h - this.ox) / h);
    this.nBinsX = Math.ceil((Lc + 6 * h) / h);
    this.accFz = attach ? new Float64Array(attach.accFz) : f64(this.nzN, shared);
    this.accMap = attach ? new Float64Array(attach.accMap) : f64(this.nBinsX * this.nzN, shared);
  }

  /** the coordinator's shared arrays for a worker of the team (team.ts adds the worker's own copy of the grid, its neighbour's and its blocks of sums) */
  shareBuffers(): Omit<Sim3Buffers, 'own' | 'left' | 'part' | 'accFz' | 'accMap' | 'stepFz'> {
    if (!(this.px.buffer instanceof SharedArrayBuffer)) throw new Error('the arrays are not shared (Sim3Options.shared)');
    const particles: ParticleBuffers = {};
    for (const k of PARTICLE_F64) particles[k] = (this[k] as Float64Array).buffer;
    for (const k of PARTICLE_U8) particles[k] = (this[k] as Uint8Array).buffer;
    return { particles, bend: this.bend.buffer, bendVel: this.bendVel.buffer, ySize: this.ySize.buffer, sync: this.sync.buffer, main: grid3Buffers(this.G) };
  }

  /** the coordinator's own copy of the grid (the worker of rank 1 reads it as its left neighbour) */
  ownGridBuffers(): Grid3Buffers {
    return grid3Buffers(this.g);
  }

  /** the number of nodes (the size of a grid copy) */
  get nodeCount(): number {
    return this.nxN * this.nyN * this.nzN;
  }

  /** spacing of the points across the width [m] */
  readonly dz: number;

  lattice(i: number, j: number, k: number): number {
    return (i * this.NJ + j) * this.NK + k;
  }

  /** one step alone: the stages in order (a team runs the same stages on every worker, team.ts) */
  advance(): void {
    this.beginStep();
    for (let ph = 0; ph < PHASES; ph++) {
      this.runPhase(ph);
      this.afterPhase(ph, []);
    }
    this.finishStep([]);
  }

  /** the coordinator's start of a step: the pusher, the stall check, the tensions, the team's columns, the sync block */
  beginStep(): void {
    if (this.pusherActive && this.headX() > this.xExitProbe) this.pusherActive = false;
    if (!this.pusherActive && !this.stalled && this.step % 200 === 0) this.checkStall();
    this.updateTension();
    if (this.size > 1 && this.step % 20 === 0) this.partition();
    this.pushSync();
  }

  /**
   * The team's columns: [ixPrevLo, ixPrevHi) cut into `size` runs of columns holding about the same number of points
   * (their base cell columns; the first and last runs open at the ends, so that a point just outside is still
   * somebody's). Every 20 steps: the points move a small part of a cell in that time.
   */
  private partition(): void {
    const { n, active, px, ox, h, size } = this;
    const lo = this.ixPrevLo;
    const hi = Math.max(lo + 1, this.ixPrevHi);
    const hist = new Int32Array(hi - lo);
    let total = 0;
    const invH = 1 / h;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      let c = Math.floor((px[p] - ox) * invH - 0.5) - lo;
      if (c < 0) c = 0;
      else if (c >= hi - lo) c = hi - lo - 1;
      hist[c]++;
      total++;
    }
    const b = this.sync;
    b[SY_BOUNDS] = -1e9;
    let w = 1;
    let sum = 0;
    for (let c = 0; c < hi - lo && w < size; c++) {
      sum += hist[c];
      if (sum >= (w * total) / size) b[SY_BOUNDS + w++] = lo + c + 1;
    }
    for (; w < size; w++) b[SY_BOUNDS + w] = hi;
    b[SY_BOUNDS + size] = 1e9;
  }

  /** what the stages read of the coordinator's state, for the workers (and this instance's own columns) */
  private pushSync(): void {
    const b = this.sync;
    b[SY_CY] = this.roll.cy;
    b[SY_R] = this.roll.R;
    b[SY_OMEGA] = this.roll.omega;
    b[SY_VR] = this.roll.vR;
    b[SY_VCY] = this.roll.vcy;
    b[SY_PUSHING] = this.pusherActive ? 1 : 0;
    b[SY_BACK_NOW] = this.backNow;
    b[SY_BACK_SCALE] = this.backScale;
    b[SY_FRONT_NOW] = this.frontNow;
    b[SY_FRONT_SCALE] = this.frontScale;
    b[SY_T] = this.t;
    b[SY_STEP] = this.step;
    b[SY_IXLO] = this.ixLo;
    b[SY_IXHI] = this.ixHi;
    b[SY_IXPREVLO] = this.ixPrevLo;
    b[SY_IXPREVHI] = this.ixPrevHi;
    if (this.size > 1) {
      this.pLo = b[SY_BOUNDS + this.rank];
      this.pHi = b[SY_BOUNDS + this.rank + 1];
    }
  }

  /** a worker's read of the sync block before a stage */
  private pullSync(): void {
    const b = this.sync;
    this.roll.cy = b[SY_CY];
    this.roll.R = b[SY_R];
    this.roll.omega = b[SY_OMEGA];
    this.roll.vR = b[SY_VR];
    this.roll.vcy = b[SY_VCY];
    this.pusherActive = b[SY_PUSHING] === 1;
    this.backNow = b[SY_BACK_NOW];
    this.backScale = b[SY_BACK_SCALE];
    this.frontNow = b[SY_FRONT_NOW];
    this.frontScale = b[SY_FRONT_SCALE];
    this.t = b[SY_T];
    this.step = b[SY_STEP];
    this.ixLo = b[SY_IXLO];
    this.ixHi = b[SY_IXHI];
    this.ixPrevLo = b[SY_IXPREVLO];
    this.ixPrevHi = b[SY_IXPREVHI];
    this.pLo = b[SY_BOUNDS + this.rank];
    this.pHi = b[SY_BOUNDS + this.rank + 1];
  }

  /** the first and one past the last of this worker's columns among the active ones */
  private get colLo(): number {
    return Math.max(this.ixLo, this.pLo);
  }
  private get colHi(): number {
    return Math.min(this.ixHi, this.pHi);
  }

  /** one stage of the step over this worker's points and columns (grid3.ts PH_*) */
  runPhase(ph: number): void {
    // a worker reads the coordinator's sync block before every stage (the active columns change after the scatter)
    if (this.rank > 0) this.pullSync();
    switch (ph) {
      case PH_P2G:
        this.zeroOwn();
        this.p2g();
        break;
      case PH_GRID:
        this.reduce(['m', 'vx', 'vy', 'vz'], 'pen', 'push');
        this.zeroMainContact();
        this.foldMomentum();
        this.gridNodes();
        break;
      case PH_FOLA:
        this.followScatter();
        break;
      case PH_FOLB:
        this.reduce(['folN', 'folD']);
        this.followNodes();
        this.mirrorBack();
        break;
      case PH_G2PV:
        this.g2pVelocity();
        break;
      case PH_VMEAN:
        this.reduce(['Th', 'Je', 'B', 'Mv']);
        this.volumeMeans();
        break;
      case PH_G2PU:
        this.g2pUpdate();
        break;
    }
  }

  /** the coordinator, after a stage of every worker: the active columns from the scatters (the workers read them at the next stage) */
  afterPhase(ph: number, parts: Float64Array[]): void {
    if (ph !== PH_P2G) return;
    let lo = this.part[PT_IXLO];
    let hi = this.part[PT_IXHI];
    for (const q of parts) {
      if (q[PT_IXLO] < lo) lo = q[PT_IXLO];
      if (q[PT_IXHI] > hi) hi = q[PT_IXHI];
    }
    if (hi < 0) {
      this.ixLo = 0;
      this.ixHi = 0;
    } else {
      this.ixLo = Math.max(0, lo);
      this.ixHi = Math.min(this.nxN, hi + 3);
    }
    this.sync[SY_IXLO] = this.ixLo;
    this.sync[SY_IXHI] = this.ixHi;
  }

  /**
   * The coordinator's end of a step: the workers' sums merged (the force on the roll, the plastic work, the failed
   * points and the first of them, the force by column and cell), the controls, the clock.
   */
  finishStep(helpers: TeamSums[]): void {
    const own = this.part;
    let fy = own[PT_FY];
    let tq = own[PT_TQ];
    let work = own[PT_WORK];
    let nFailed = own[PT_NFAIL];
    let first = own[PT_FIRST];
    for (const hlp of helpers) {
      const q = hlp.part;
      fy += q[PT_FY];
      tq += q[PT_TQ];
      work += q[PT_WORK];
      nFailed += q[PT_NFAIL];
      if (q[PT_FIRST] >= 0 && (first < 0 || q[PT_FIRST] < first)) first = q[PT_FIRST];
      for (let i = 0; i < this.accFz.length; i++) this.accFz[i] += hlp.accFz[i];
      for (let i = 0; i < this.accMap.length; i++) this.accMap[i] += hlp.accMap[i];
      for (let i = 0; i < this.stepFz.length; i++) this.stepFz[i] += hlp.stepFz[i];
      hlp.accFz.fill(0);
      hlp.accMap.fill(0);
      hlp.stepFz.fill(0);
      q.fill(0, PT_FY, PT_COUNT);
      q[PT_FIRST] = -1;
    }
    own.fill(0, PT_FY, PT_COUNT);
    own[PT_FIRST] = -1;
    // the sheet pushes the roll up: the force on the roll is minus the force on the sheet (one roll's: rollShare)
    fy *= this.rollShare;
    tq *= this.rollShare;
    this.accFy += -fy;
    this.accTq += tq;
    if (!this.rollsSettled) this.ctlForce += ((-2 * fy) / this.ctlWidth - this.ctlForce) * Math.min(1, this.dt / this.ctlTauF);
    this.accSteps++;
    this.plasticWork += work;
    this.nFailed += nFailed;
    if (first >= 0 && !this.firstCrack) this.recordFirstCrack(first);
    this.ixPrevLo = this.ixLo;
    this.ixPrevHi = this.ixHi;
    this.t += this.dt;
    this.step++;
    if (!this.rollsSettled) this.adjustRolls();
    if (this.beam) this.updateBend();
  }

  /** this worker's copy of the grid, cleared where its points scattered last step */
  private zeroOwn(): void {
    const slab = this.nyN * this.nzN;
    const lo = this.ownPrevLo * slab;
    const hi = this.ownPrevHi * slab;
    const g = this.g;
    g.m.fill(0, lo, hi);
    g.vx.fill(0, lo, hi);
    g.vy.fill(0, lo, hi);
    g.vz.fill(0, lo, hi);
    g.pen.fill(INF, lo, hi);
    g.push.fill(0, lo, hi);
    g.con.fill(0, lo, hi);
    g.folN.fill(0, lo, hi);
    g.folD.fill(0, lo, hi);
    g.Th.fill(0, lo, hi);
    g.Je.fill(0, lo, hi);
    g.B.fill(0, lo, hi);
    g.Mv.fill(0, lo, hi);
  }

  /** the main grid's contact marks of this worker's columns, from last step and this one (alone: done by zeroOwn) */
  private zeroMainContact(): void {
    if (this.G === this.g) return;
    const slab = this.nyN * this.nzN;
    const lo = Math.max(this.pLo, Math.min(this.ixPrevLo, this.ixLo));
    const hi = Math.min(this.pHi, Math.max(this.ixPrevHi, this.ixHi));
    if (hi > lo) this.G.con.fill(0, lo * slab, hi * slab);
  }

  /**
   * The team's sums onto the main grid over this worker's columns: its own copy, plus the copy of the worker below
   * over the two columns its points reach (sums; the penetration the least, the push mark either). Alone: nothing.
   */
  private reduce(sum: (keyof Grid3)[], min?: 'pen', or?: 'push'): void {
    const { g, G, left } = this;
    if (G === g) return;
    const slab = this.nyN * this.nzN;
    const lo = this.colLo;
    const hi = this.colHi;
    if (hi <= lo) return;
    const a = lo * slab;
    const b = hi * slab;
    for (const k of sum) G[k].set(g[k].subarray(a, b), a);
    if (min) G[min].set(g[min].subarray(a, b), a);
    if (or) G[or].set(g[or].subarray(a, b), a);
    if (!left) return;
    const c = Math.min(hi, lo + 2) * slab;
    for (const k of sum) {
      const dst = G[k] as Float64Array;
      const src = left[k] as Float64Array;
      for (let i = a; i < c; i++) dst[i] += src[i];
    }
    if (min) {
      const dst = G[min];
      const src = left[min];
      for (let i = a; i < c; i++) if (src[i] < dst[i]) dst[i] = src[i];
    }
    if (or) {
      const dst = G[or];
      const src = left[or];
      for (let i = a; i < c; i++) if (src[i]) dst[i] = 1;
    }
  }

  /**
   * K steps on the GPU (attachGpu), the same stages as advance() (gpu/kernels.ts), with the controls that take a
   * step's result run once for the batch on the CPU with dt × K: the roll's adjustment and bending on the batch's
   * mean force, the tensions and the pusher from the state at the batch's start, the stall check when the batch
   * holds a multiple of 200 steps. The roll, the tensions and the deflection are therefore uniform over a batch:
   * K is at most CTL_EVERY, and a batch ends at a multiple of CTL_EVERY (the gauge is read there). The state
   * (the arrays) is read back after every batch, so everything that reads the strip works as after advance();
   * a point that fails does so at its step on the device, but the crack's record is the state at the read.
   */
  async advanceBatch(K: number): Promise<void> {
    const g = this.gpu;
    if (!g || !this.gpuBase) throw new Error('no GPU attached');
    if (!(Number.isInteger(K) && K >= 1 && K <= CTL_EVERY)) throw new Error(`a batch is 1 to ${CTL_EVERY} steps`);
    if (Math.floor((this.step + K - 1) / CTL_EVERY) !== Math.floor(this.step / CTL_EVERY)) throw new Error('a batch must end at a multiple of CTL_EVERY');
    const { nxN, nyN, nzN, dt, accFz, accMap, stepFz, binCol0, nBinsX } = this;
    const dtEff = K * dt;
    if (this.pusherActive && this.headX() > this.xExitProbe) this.pusherActive = false;
    if (!this.pusherActive && !this.stalled && Math.floor((this.step + K - 1) / 200) > Math.floor((this.step - 1) / 200)) this.checkStall();
    this.updateTension();
    const base = new Uint32Array(this.gpuBase);
    for (let s = 0; s < K; s++) {
      const e = g.uniform(s);
      e.u.set(base);
      e.f[U.cy] = this.roll.cy;
      e.f[U.R] = this.roll.R;
      e.f[U.gapHalf] = this.roll.cy - this.roll.R;
      e.f[U.omega] = this.roll.omega;
      e.f[U.vR] = this.roll.vR;
      e.f[U.vcy] = this.roll.vcy;
      e.u[U.pushing] = this.pusherActive ? 1 : 0;
      e.f[U.tractionB] = -this.backNow * this.backScale;
      e.f[U.tractionF] = this.frontNow * this.frontScale;
      e.u[U.backOn] = this.backNow > 0 ? 1 : 0;
      e.u[U.frontOn] = this.frontNow > 0 ? 1 : 0;
      e.u[U.stepIndex] = this.step + s;
    }
    const bend = new Float32Array(2 * nzN);
    if (this.beam) {
      bend.set(this.bend, 0);
      bend.set(this.bendVel, nzN);
    }
    const out = await g.run(K, bend);
    this.pull(out.particles);
    const acc = out.acc;
    let fy = 0;
    let tq = 0;
    for (let ix = 0; ix < nxN; ix++) {
      fy += acc[2 * ix];
      tq += acc[2 * ix + 1];
    }
    const ng = nxN * nyN * nzN;
    const o1 = 2 * nxN;
    const o2 = o1 + ng;
    for (let idx = 0; idx < ng; idx++) {
      const fc = acc[o1 + idx];
      const ff = acc[o2 + idx];
      if (fc === 0 && ff === 0) continue;
      const ix = Math.floor(idx / (nyN * nzN));
      const iz = idx % nzN;
      accFz[iz] += fc + ff;
      if (this.beam) stepFz[iz] += fc;
      const b = ix - binCol0;
      if (b >= 0 && b < nBinsX) accMap[b * nzN + iz] += fc + ff;
    }
    fy *= this.rollShare;
    tq *= this.rollShare;
    this.accFy += -fy;
    this.accTq += tq;
    this.accSteps += K;
    if (!this.rollsSettled) this.ctlForce += ((-2 * fy) / K / this.ctlWidth - this.ctlForce) * Math.min(1, dtEff / this.ctlTauF);
    this.ixPrevLo = 0;
    this.ixPrevHi = nxN;
    this.t += dtEff;
    this.step += K;
    if (!this.rollsSettled) this.adjustRolls(dtEff);
    if (this.beam) this.updateBend(dtEff, K);
  }

  /** The step goes to the device from here: the state is uploaded once, and read back after every batch. */
  async attachGpu(device: GPUDevice): Promise<void> {
    this.detachGpu();
    const g = new GpuStepper(device, { n: this.n, nxN: this.nxN, nyN: this.nyN, nzN: this.nzN });
    const err = await g.compileErrors();
    if (err) {
      g.destroy();
      throw new Error('WGSL: ' + err);
    }
    g.upload(this.pack());
    this.gpuWork0 = this.plasticWork;
    this.gpuBase = this.uniformBase();
    this.gpu = g;
  }

  detachGpu(): void {
    this.gpu?.destroy();
    this.gpu = null;
    this.gpuBase = null;
  }

  /** the uniform block's constant part (gpu/kernels.ts U) */
  private uniformBase(): ArrayBuffer {
    const buf = new ArrayBuffer(256);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const mat = this.params.material;
    const r = this.params.rolling;
    const dmg = this.params.damage;
    const v: Record<string, number> = {
      n: this.n, nxN: this.nxN, nyN: this.nyN, nzN: this.nzN,
      h: this.h, invH: 1 / this.h, ox: this.ox, dt: this.dt,
      dp: this.dp, mu: r.mu, planeStrain: this.params.solid.planeStrain ? 1 : 0, vPush: this.vIn,
      mMin: 1e-12 * this.mass[0], K: this.el.K, G: this.el.G, jcA: mat.jcA, jcB: mat.jcB, jcN: mat.jcN, jcC: mat.jcC, jcM: mat.jcM,
      epsDot0: mat.epsDot0, tRoom: mat.tRoom, tMelt: mat.tMelt, rho: mat.rho, cp: mat.cp, chi: mat.chi, rateScale: r.millSpeed / r.rollSpeed,
      xMin: this.ox + 2 * this.h, xMax: (this.nxN - 3) * this.h + this.ox, yMax: this.yMax, yMin: this.fullThickness ? -this.yMax : -INF, zMax: (this.nzN - 4) * this.h,
      tailEnd: this.NJ * this.NK, ng: this.nxN * this.nyN * this.nzN, swift: mat.hardening === 'swift' ? 1 : 0, swK: mat.swK, swE0: mat.swE0, swN: mat.swN,
      bending: this.beam ? 1 : 0, gripCols: this.gripCols, NI: this.NI, dz: this.dz,
      dmgModel: dmg.model === 'none' ? 0 : dmg.model === 'hancock-mackenzie' ? 2 : dmg.model === 'cockcroft-latham' ? 3 : 1,
      etaCutoff: dmg.etaCutoff, D1: dmg.D1, D2: dmg.D2, D3: dmg.D3, D4: dmg.D4, D5: dmg.D5, clCrit: dmg.clCrit,
    };
    for (const [k, i] of Object.entries(U)) {
      if (!(k in v)) continue;
      if (U_INTS.has(i)) u[i] = v[k];
      else f[i] = v[k];
    }
    return buf;
  }

  /** the arrays packed for the device (gpu/kernels.ts offsets) */
  private pack(): Float32Array {
    const { n, NK } = this;
    const a = new Float32Array(n * PSTRIDE);
    for (let p = 0; p < n; p++) {
      const b = p * PSTRIDE;
      a[b + P_X] = this.px[p]; a[b + P_X + 1] = this.py[p]; a[b + P_X + 2] = this.pz[p];
      a[b + P_V] = this.vx[p]; a[b + P_V + 1] = this.vy[p]; a[b + P_V + 2] = this.vz[p];
      for (let k = 0; k < 9; k++) {
        a[b + P_C + k] = this.C[9 * p + k];
        a[b + P_F + k] = this.F[9 * p + k];
      }
      a[b + P_S] = this.sxx[p]; a[b + P_S + 1] = this.syy[p]; a[b + P_S + 2] = this.szz[p]; a[b + P_S + 3] = this.sxy[p]; a[b + P_S + 4] = this.syz[p]; a[b + P_S + 5] = this.szx[p];
      a[b + P_PRES] = this.pres[p]; a[b + P_MASS] = this.mass[p]; a[b + P_VOL0] = this.vol0[p]; a[b + P_EP] = this.ep[p]; a[b + P_TEMP] = this.temp[p];
      a[b + P_STR] = this.strength[p]; a[b + P_STREP] = this.strengthEp[p]; a[b + P_VR] = this.vr[p]; a[b + P_TH] = this.th[p];
      a[b + P_SEQ] = this.seq[p]; a[b + P_ETA] = this.eta[p]; a[b + P_TOUCH] = this.touch[p]; a[b + P_ACTIVE] = this.active[p]; a[b + P_FAILED] = this.failed[p];
      a[b + P_WORK] = 0; a[b + P_YSIZE] = this.ySize[p % NK]; a[b + P_DJC] = this.dJC[p]; a[b + P_DHM] = this.dHM[p]; a[b + P_DCL] = this.dCL[p]; a[b + P_FAILSTEP] = -1;
    }
    return a;
  }

  /** the device's state back into the arrays, with the failures it found and the plastic work it summed */
  private pull(a: Float32Array): void {
    const { n } = this;
    let work = 0;
    let nFailed = 0;
    let first = -1;
    let firstStep = Infinity;
    for (let p = 0; p < n; p++) {
      const b = p * PSTRIDE;
      this.px[p] = a[b + P_X]; this.py[p] = a[b + P_X + 1]; this.pz[p] = a[b + P_X + 2];
      this.vx[p] = a[b + P_V]; this.vy[p] = a[b + P_V + 1]; this.vz[p] = a[b + P_V + 2];
      for (let k = 0; k < 9; k++) {
        this.C[9 * p + k] = a[b + P_C + k];
        this.F[9 * p + k] = a[b + P_F + k];
      }
      this.sxx[p] = a[b + P_S]; this.syy[p] = a[b + P_S + 1]; this.szz[p] = a[b + P_S + 2]; this.sxy[p] = a[b + P_S + 3]; this.syz[p] = a[b + P_S + 4]; this.szx[p] = a[b + P_S + 5];
      this.pres[p] = a[b + P_PRES]; this.ep[p] = a[b + P_EP]; this.temp[p] = a[b + P_TEMP];
      this.strength[p] = a[b + P_STR]; this.strengthEp[p] = a[b + P_STREP]; this.vr[p] = a[b + P_VR]; this.th[p] = a[b + P_TH];
      this.seq[p] = a[b + P_SEQ]; this.eta[p] = a[b + P_ETA]; this.touch[p] = a[b + P_TOUCH]; this.active[p] = a[b + P_ACTIVE];
      this.dJC[p] = a[b + P_DJC]; this.dHM[p] = a[b + P_DHM]; this.dCL[p] = a[b + P_DCL];
      const failed = a[b + P_FAILED] !== 0;
      this.failed[p] = failed ? 1 : 0;
      if (failed) {
        nFailed++;
        const fs = a[b + P_FAILSTEP];
        if (fs >= 0 && fs < firstStep) {
          firstStep = fs;
          first = p;
        }
      }
      work += a[b + P_WORK];
    }
    this.plasticWork = this.gpuWork0 + work;
    this.nFailed = nFailed;
    if (!this.firstCrack && first >= 0) {
      const p = first;
      const i = Math.floor(p / (this.NJ * this.NK));
      const j = Math.floor(p / this.NK) % this.NJ;
      const k = p % this.NK;
      this.firstCrack = {
        t: firstStep * this.dt,
        step: firstStep,
        x: this.px[p],
        y: this.py[p],
        z: this.pz[p],
        sheetX: (this.NI - 1 - i + 0.5) * this.dp,
        sheetY: (j + 0.5 - this.jOff) * this.dp,
        sheetZ: (k + 0.5) * this.dz,
        point: p,
        eta: this.eta[p],
        seq: this.seq[p],
        ep: this.ep[p],
        criterion: this.params.damage.model,
      };
    }
  }

  /**
   * The roll bends under the contact force of this step: the force by z column (the quarter's; the mid-width node's
   * counts twice, the strip on the other side of z = 0 being its mirror image) low-passed over ctlTauF as the
   * flattening's force is, then the beam's deflection at the columns (rollBend.ts). The contact sees the surface
   * move at the deflection's rate. Settled once the mid-width deflection has held still over ctlWindow, as R does.
   */
  private updateBend(dt = this.dt, steps = 1): void {
    const { nzN, h, stepFz, bendQ, bend, bendVel } = this;
    const k = Math.min(1, dt / this.ctlTauF);
    for (let iz = 1; iz < nzN; iz++) {
      const q = ((iz === 1 ? 2 : 1) * this.rollShare * stepFz[iz]) / steps / h;
      bendQ[iz - 1] += (q - bendQ[iz - 1]) * k;
      stepFz[iz] = 0;
    }
    const d = beamDeflection(bendQ, h, this.beam!, nzN - 1);
    for (let iz = 1; iz < nzN; iz++) {
      bendVel[iz] = (d[iz - 1] - bend[iz]) / dt;
      bend[iz] = d[iz - 1];
    }
    bend[0] = bend[2];
    bendVel[0] = bendVel[2];
    // the force ripples a few % as the points cross the cells, so the deflection is averaged over windows of
    // ctlWindow: settled when one window's mean is within 2 % (or the gap control's tolerance on 2δ) of the last one's
    this.bendSum += bend[1];
    this.bendCount++;
    if (this.t - this.bendSince >= this.ctlWindow) {
      const mean = this.bendSum / this.bendCount;
      const tol = Math.max(0.02 * Math.abs(mean), 0.5 * CTL_TOL_H * this.params.rolling.h0);
      this.bendSettled = this.headX() >= this.xExitProbe && Math.abs(mean - this.bendRef) <= tol;
      this.bendRef = mean;
      this.bendSum = 0;
      this.bendCount = 0;
      this.bendSince = this.t;
    }
  }

  /** the deflection of the roll's axis over z [m] (linear between the columns) and its rate [m/s] */
  bendAt(z: number): number {
    if (!this.beam) return 0;
    const g = z / this.h;
    const k = Math.max(0, Math.min(this.nzN - 3, Math.floor(g)));
    const f = Math.max(0, Math.min(1, g - k));
    return this.bend[k + 1] * (1 - f) + this.bend[k + 2] * f;
  }

  private bendVelAt(z: number): number {
    if (!this.beam) return 0;
    const g = z / this.h;
    const k = Math.max(0, Math.min(this.nzN - 3, Math.floor(g)));
    const f = Math.max(0, Math.min(1, g - k));
    return this.bendVel[k + 1] * (1 - f) + this.bendVel[k + 2] * f;
  }

  /**
   * The rolls follow the pass, every step until they have settled (solver.ts adjustRolls, the same control):
   * - flattening 'hitchcock': R' = R (1 + C P / Δh) with P the roll force per unit width — the whole force over the
   *   mean of the entry width and the width at the gauge — low-passed over a quarter of the bite's transit time.
   *   One radius for the whole width: the roll stays a cylinder
   * - gapControl 'reduction': the gap is integrated on the error of the strip's mean thickness at the gauge (by
   *   volume, over the width there: gauge()) against h0 (1 − r)
   * Settled, and held from then on, as in the section model.
   */
  private adjustRolls(dt = this.dt): void {
    const r = this.params.rolling;
    const flat = r.flattening === 'hitchcock';
    const red = r.gapControl === 'reduction';
    const target = r.h0 * (1 - r.reduction);
    const t = this.t;
    const building = this.headX() < this.xExitProbe;
    if (!building && this.step % CTL_EVERY === 0) {
      const m = this.gauge();
      if (m) this.ctlWidth = this.halfWidth0 + m.halfWidth;
      if (red) {
        if (m) {
          const k = Math.min(1, (CTL_EVERY * this.dt) / this.ctlTauH);
          this.ctlThick = Number.isNaN(this.ctlThick) ? m.thickness : this.ctlThick + (m.thickness - this.ctlThick) * k;
          this.gap -= (this.ctlThick - target) * Math.min(1, (CTL_EVERY * this.dt) / this.ctlTauG);
          const km = Math.min(1, (2 * CTL_EVERY * this.dt) / this.ctlTransit);
          this.ctlThickRef = Number.isNaN(this.ctlThickRef) ? this.ctlThick : this.ctlThickRef + (this.ctlThick - this.ctlThickRef) * km;
          this.ctlGapRef = Number.isNaN(this.ctlGapRef) ? this.gap : this.ctlGapRef + (this.gap - this.ctlGapRef) * km;
        }
        const on = Math.abs(this.ctlThickRef - target) <= CTL_TOL_H * target && Math.abs(this.ctlThick - target) <= 4 * CTL_TOL_H * target;
        if (!on) this.ctlHSince = Infinity;
        else if (this.ctlHSince === Infinity) this.ctlHSince = t;
      }
    }
    const force = building ? Math.max(this.ctlForce, this.ctlForce0) : this.ctlForce;
    const goal = flat ? hitchcockRadius(r, force, r.h0 - this.gap) : r.rollRadius;
    const R = this.roll.R + (goal - this.roll.R) * Math.min(1, dt / this.ctlTauF);
    this.setRoll(R, true, dt);
    this.ctlRRef += (R - this.ctlRRef) * Math.min(1, (2 * dt) / this.ctlTransit);
    if (building || Math.abs(R - this.ctlRRef) > CTL_TOL_R * R || Math.abs(R - goal) > CTL_TOL_R * R) this.ctlRSince = t;
    if (building) {
      this.ctlHSince = Infinity;
      return;
    }
    if ((!flat || t - this.ctlRSince >= this.ctlWindow) && (!red || t - this.ctlHSince >= this.ctlWindow)) {
      this.rollsSettled = true;
      this.settledT = t;
      if (red) this.gap = this.ctlGapRef;
      this.setRoll(R, false);
    }
  }

  /** the roll at radius R and the gap now; `moving`: the contact sees the surface move there over this step */
  private setRoll(R: number, moving = true, dt = this.dt): void {
    const roll = this.roll;
    const cy = R + this.gap / 2;
    roll.vR = moving ? (R - roll.R) / dt : 0;
    roll.vcy = moving ? (cy - roll.cy) / dt : 0;
    roll.R = R;
    roll.cy = cy;
    roll.omega = this.params.rolling.rollSpeed / R;
  }

  /** how far past the roll centres the strip has gone through the settled rolls [m] (∞ with rolls that are not adjusted, NaN until they have settled) */
  settledLength(): number {
    return (this.t - this.settledT) * this.params.rolling.rollSpeed;
  }

  /**
   * The strip about x (the gauge) under a Hann window of half-width w: the half width (the edge points' outer
   * faces) and the mean thickness over the width, by volume (Σ vol0 J over the window's length and that half
   * width, doubled: what tandem3.ts stripOut reads over a stretch). Null until the strip fills the window.
   */
  gauge(x = this.xGauge, w = this.gaugeBand): { thickness: number; halfWidth: number } | null {
    if (!(this.headX() >= x + w) || !(this.tailX() <= x - w)) return null;
    const { n, active, px, pz, vol0, F, NK, dz } = this;
    let vol = 0;
    let hw = 0;
    let wsum = 0;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const u = (px[p] - x) / w;
      if (u <= -1 || u >= 1) continue;
      const g = 0.5 * (1 + Math.cos(Math.PI * u));
      vol += g * vol0[p] * det3(F, 9 * p);
      if (p % NK === NK - 1) {
        hw += g * (pz[p] + 0.5 * dz * F[9 * p + 8]);
        wsum += g;
      }
    }
    if (!(wsum > 0)) return null;
    hw /= wsum;
    return { thickness: (2 * this.rollShare * vol) / (w * hw), halfWidth: hw };
  }

  private p2g(): void {
    const { n, active, px, py, pz, vx, vy, vz, C, F, mass, vol0, dt, h, ox, nyN, nzN, pLo, pHi, owner, gyOff, fullThickness: full } = this;
    const me = this.rank + 1;
    const { m: gm, vx: gvx, vy: gvy, vz: gvz, pen: gpen, push: gpush } = this.g;
    const { sxx, syy, szz, sxy, syz, szx, pres, touch } = this;
    const invH = 1 / h;
    const k4 = 4 * invH * invH;
    const halfDp = 0.5 * this.dp;
    const hh = 0.5 * h;
    const { cy, R } = this.roll;
    const bending = this.beam !== null;
    const pushing = this.pusherActive;
    const tailEnd = this.NJ * this.NK; // the points of the tail column come first
    // force per gripped point [N] per unit of its deformed section and of its grip weight (see gripScale)
    const grip = this.gripCols;
    const NI = this.NI;
    const tractionB = -this.backNow * this.backScale;
    const tractionF = this.frontNow * this.frontScale;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    let ixLo = 1 << 30;
    let ixHi = -1;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const xp = px[p];
      const yp = py[p];
      const zp = pz[p];
      const gx = (xp - ox) * invH;
      const gy = yp * invH + gyOff;
      const gz = zp * invH + 1;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const bz = Math.floor(gz - 0.5);
      if (bx < pLo || bx >= pHi) continue;
      // the full strip's lower half sees the bottom roll: the top roll through the mid-thickness plane
      const sr = full && yp < 0 ? -1 : 1;
      owner[p] = me;
      if (bx < ixLo) ixLo = bx;
      if (bx > ixHi) ixHi = bx;
      const fx = gx - bx;
      const fy = gy - by;
      const fz = gz - bz;
      wx[0] = 0.5 * (1.5 - fx) * (1.5 - fx);
      wx[1] = 0.75 - (fx - 1) * (fx - 1);
      wx[2] = 0.5 * (fx - 0.5) * (fx - 0.5);
      wy[0] = 0.5 * (1.5 - fy) * (1.5 - fy);
      wy[1] = 0.75 - (fy - 1) * (fy - 1);
      wy[2] = 0.5 * (fy - 0.5) * (fy - 0.5);
      wz[0] = 0.5 * (1.5 - fz) * (1.5 - fz);
      wz[1] = 0.75 - (fz - 1) * (fz - 1);
      wz[2] = 0.5 * (fz - 0.5) * (fz - 0.5);

      const o = 9 * p;
      const F00 = F[o], F01 = F[o + 1], F02 = F[o + 2], F10 = F[o + 3], F11 = F[o + 4], F12 = F[o + 5], F20 = F[o + 6], F21 = F[o + 7], F22 = F[o + 8];
      const J = F00 * (F11 * F22 - F12 * F21) - F01 * (F10 * F22 - F12 * F20) + F02 * (F10 * F21 - F11 * F20);
      const m = mass[p];
      const kk = -dt * vol0[p] * J * k4;
      const pr = pres[p];
      const a00 = kk * (sxx[p] - pr) + m * C[o];
      const a01 = kk * sxy[p] + m * C[o + 1];
      const a02 = kk * szx[p] + m * C[o + 2];
      const a10 = kk * sxy[p] + m * C[o + 3];
      const a11 = kk * (syy[p] - pr) + m * C[o + 4];
      const a12 = kk * syz[p] + m * C[o + 5];
      const a20 = kk * szx[p] + m * C[o + 6];
      const a21 = kk * syz[p] + m * C[o + 7];
      const a22 = kk * (szz[p] - pr) + m * C[o + 8];
      let mvx = m * vx[p];
      const mvy = m * vy[p];
      const mvz = m * vz[p];
      if (tractionB !== 0 || tractionF !== 0) {
        const i = Math.floor(p / tailEnd);
        if (tractionB !== 0 && i < grip) mvx += dt * tractionB * this.gripWeight(i, 1) * this.section(p);
        else if (tractionF !== 0 && i >= NI - grip) mvx += dt * tractionF * this.gripWeight(i, 2) * this.section(p);
      }

      // penetration of the point's top edge (its half size along the deformed y edge) into the roll
      const ex = xp;
      const ey = sr * yp - cy - (bending ? this.bendAt(zp) : 0);
      let pen = INF;
      let nx = 0;
      let ny = 0;
      const rpMax = halfDp * (Math.abs(F01) + Math.abs(F11));
      // no square root for a point that cannot reach the roll (an upper bound of its half size, a margin far above rounding)
      const d2 = ex * ex + ey * ey;
      if (d2 <= (R + rpMax) * (R + rpMax) * (1 + 1e-9)) {
        const d = Math.sqrt(d2);
        pen = d - R - halfDp * Math.hypot(F01, F11);
        nx = ex / d;
        ny = ey / d;
      }
      const inRoll = pen < 0;
      touch[p] = inRoll ? 1 : 0;
      const pushMark = pushing && p < tailEnd;

      for (let i = 0; i < 3; i++) {
        const dx = (i - fx) * h;
        const wi = wx[i];
        for (let j = 0; j < 3; j++) {
          const dy = (j - fy) * h;
          const wij = wi * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN + bz;
          const onSide = inRoll && dx * nx + sr * dy * ny <= hh;
          const bxv = mvx + a00 * dx + a01 * dy;
          const byv = mvy + a10 * dx + a11 * dy;
          const bzv = mvz + a20 * dx + a21 * dy;
          for (let k = 0; k < 3; k++) {
            const dzz = (k - fz) * h;
            const w = wij * wz[k];
            const idx = row + k;
            gm[idx] += w * m;
            gvx[idx] += w * (bxv + a02 * dzz);
            gvy[idx] += w * (byv + a12 * dzz);
            gvz[idx] += w * (bzv + a22 * dzz);
            if (onSide && pen < gpen[idx]) gpen[idx] = pen;
            if (pushMark) gpush[idx] = 1;
          }
        }
      }
    }
    // the columns this worker's points reached (cleared next step), and its share of the active range
    this.part[PT_IXLO] = ixLo;
    this.part[PT_IXHI] = ixHi;
    if (ixHi < 0) {
      this.ownPrevLo = 0;
      this.ownPrevHi = 0;
    } else {
      this.ownPrevLo = Math.max(0, ixLo);
      this.ownPrevHi = Math.min(this.nxN, ixHi + 3);
    }
  }

  /** the ghost layers (iy = 0, iz = 0) onto their mirror images (iy = 2, iz = 2): sums, the normal momentum negated */
  private foldMomentum(): void {
    const { nyN, nzN, iyLo } = this;
    const { m: gm, vx: gvx, vy: gvy, vz: gvz, pen: gpen, push: gpush } = this.G;
    for (let ix = this.colLo, hi = this.colHi; ix < hi; ix++) {
      const col = ix * nyN * nzN;
      if (!this.fullThickness) for (let iz = 0; iz < nzN; iz++) {
        const g = col + iz; // iy = 0
        if (gm[g] === 0) continue;
        const m = g + 2 * nzN;
        gm[m] += gm[g];
        gvx[m] += gvx[g];
        gvy[m] -= gvy[g];
        gvz[m] += gvz[g];
        if (gpen[g] < gpen[m]) gpen[m] = gpen[g];
        if (gpush[g]) gpush[m] = 1;
        gm[g] = 0;
      }
      for (let iy = iyLo; iy < nyN; iy++) {
        const g = col + iy * nzN; // iz = 0
        if (gm[g] === 0) continue;
        const m = g + 2;
        gm[m] += gm[g];
        gvx[m] += gvx[g];
        gvy[m] += gvy[g];
        gvz[m] -= gvz[g];
        if (gpen[g] < gpen[m]) gpen[m] = gpen[g];
        if (gpush[g]) gpush[m] = 1;
        gm[g] = 0;
      }
    }
  }

  /** the nodes of this worker's columns: the velocities, the contact with the roll (Coulomb), the pusher */
  private gridNodes(): void {
    const { nyN, nzN, h, ox, dt, accFz, accMap, binCol0, nBinsX, gyOff, iyLo, fullThickness: full } = this;
    const { m: gm, vx: gvx, vy: gvy, vz: gvz, pen: gpen, push: gpush, con: gcon, slipX: gslipX, slipY: gslipY, slipZ: gslipZ } = this.G;
    const mu = this.params.rolling.mu;
    const planeStrain = this.params.solid.planeStrain === true;
    const pushing = this.pusherActive;
    const vPush = this.vIn;
    const invDt = 1 / dt;
    const { cy, R, omega } = this.roll;
    // the surface of a roll that is being adjusted moves along its normal by vcy n_y + vR besides turning (solver.ts Roll)
    const un0 = this.roll.vR;
    const vcy0 = this.roll.vcy;
    const { bend, bendVel, stepFz } = this;
    const bending = this.beam !== null;
    const mMin = 1e-12 * this.mass[0];
    let fyAcc = 0;
    let tqAcc = 0;
    for (let ix = this.colLo, hi = this.colHi; ix < hi; ix++) {
      const xi = ox + ix * h;
      const b = ix - binCol0;
      for (let iy = iyLo; iy < nyN; iy++) {
        const yi = (iy - gyOff) * h;
        // below the mid-thickness plane of the full strip: the bottom roll, as the top roll seen through the plane
        const sr = full && yi < 0 ? -1 : 1;
        const row = (ix * nyN + iy) * nzN;
        for (let iz = 1; iz < nzN; iz++) {
          const idx = row + iz;
          const m = gm[idx];
          if (m <= mMin) {
            gvx[idx] = 0;
            gvy[idx] = 0;
            gvz[idx] = 0;
            continue;
          }
          let vx = gvx[idx] / m;
          let vy = sr * (gvy[idx] / m);
          let vz = gvz[idx] / m;
          if (iy === 1 && !full) vy = 0;
          if (iz === 1 || planeStrain) vz = 0;
          if (gpen[idx] < 0) {
            const rx = xi;
            const ry = sr * yi - cy - bend[iz];
            const vcy = vcy0 + bendVel[iz];
            const d = Math.hypot(rx, ry);
            const nx = rx / d;
            const ny = ry / d;
            // the roll's surface velocity at the foot of the node (the top roll turns so that its lowest point moves +x)
            const ux = -omega * R * ny + un0 * nx + vcy * ny * nx;
            const uy = omega * R * nx + un0 * ny + vcy * ny * ny;
            const relx = vx - ux;
            const rely = vy - uy;
            const vn = relx * nx + rely * ny;
            // n points away from the roll's axis: moving into the roll is vn < 0
            if (vn < 0) {
              const tx = relx - vn * nx;
              const ty = rely - vn * ny;
              const tz = vz;
              const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
              let s = 0;
              if (vt > -mu * vn) s = 1 + (mu * vn) / vt;
              const nvx = ux + s * tx;
              const nvy = uy + s * ty;
              const nvz = s * tz;
              gcon[idx] = 1;
              gslipX[idx] = s * tx;
              gslipY[idx] = sr * (s * ty);
              gslipZ[idx] = iz === 1 || planeStrain ? 0 : s * tz;
              const fx = m * (nvx - vx) * invDt;
              const fy = m * (nvy - vy) * invDt;
              fyAcc += fy;
              tqAcc += -(rx * fy - ry * fx);
              const fn = fx * nx + fy * ny;
              accFz[iz] += fn;
              if (bending) stepFz[iz] += fn;
              if (b >= 0 && b < nBinsX) accMap[b * nzN + iz] += fn;
              vx = nvx;
              vy = iy === 1 && !full ? 0 : nvy;
              vz = iz === 1 || planeStrain ? 0 : nvz;
            }
          }
          if (pushing && gpush[idx] && vx < vPush) vx = vPush;
          gvx[idx] = vx;
          gvy[idx] = sr * vy;
          gvz[idx] = vz;
        }
      }
    }
    this.part[PT_FY] += fyAcc;
    this.part[PT_TQ] += tqAcc;
  }

  /** the mirrored velocity back to the ghost layers: iz = 0 from iz = 2, then iy = 0 from iy = 2 (the corner too) */
  private mirrorBack(): void {
    const { nyN, nzN, iyLo } = this;
    const { vx: gvx, vy: gvy, vz: gvz } = this.G;
    for (let ix = this.colLo, hi = this.colHi; ix < hi; ix++) {
      const col = ix * nyN * nzN;
      for (let iy = iyLo; iy < nyN; iy++) {
        const g = col + iy * nzN;
        gvx[g] = gvx[g + 2];
        gvy[g] = gvy[g + 2];
        gvz[g] = -gvz[g + 2];
      }
      if (!this.fullThickness) for (let iz = 0; iz < nzN; iz++) {
        const g = col + iz;
        const m = g + 2 * nzN;
        gvx[g] = gvx[m];
        gvy[g] = -gvy[m];
        gvz[g] = gvz[m];
      }
    }
  }

  /**
   * The top edge of a point that is inside the roll must not move further into it (solver.ts followRoll): the
   * point's velocity mixes the held nodes on its roll side with free nodes deeper in the sheet, which move toward
   * the mid-plane more slowly than the surface, so the point would lag and sink into the roll (the strip came out
   * 2 % over the gap). Its edge moves along the normal n (axis → point) at (v − u)·n − rp D_nn; what it lacks, over
   * the weight the point puts on its held nodes, is asked of those nodes (the mass-weighted mean of the requests),
   * with Coulomb's share of the added normal impulse taken from a sliding node's slip. A ghost node's request goes
   * to its mirror image. Two stages: the points' requests scattered (followScatter), then the nodes' velocities
   * (followNodes), which add to the force on the sheet along y and the torque on the roll.
   */
  private followScatter(): void {
    const { n, active, touch, px, py, pz, F, mass, h, ox, nyN, nzN, owner, gyOff, fullThickness: full } = this;
    const me = this.rank + 1;
    const { vx: gvx, vy: gvy, con: gcon } = this.G;
    const { folN: gfolN, folD: gfolD } = this.g;
    const invH = 1 / h;
    const k4 = 4 * invH * invH;
    const { cy, R, omega } = this.roll;
    const halfDp = 0.5 * this.dp;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    for (let p = 0; p < n; p++) {
      if (!active[p] || !touch[p] || owner[p] !== me) continue;
      const sr = full && py[p] < 0 ? -1 : 1;
      const gx = (px[p] - ox) * invH;
      const gy = py[p] * invH + gyOff;
      const gz = pz[p] * invH + 1;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const bz = Math.floor(gz - 0.5);
      const fx = gx - bx;
      const fy = gy - by;
      const fz = gz - bz;
      wx[0] = 0.5 * (1.5 - fx) * (1.5 - fx);
      wx[1] = 0.75 - (fx - 1) * (fx - 1);
      wx[2] = 0.5 * (fx - 0.5) * (fx - 0.5);
      wy[0] = 0.5 * (1.5 - fy) * (1.5 - fy);
      wy[1] = 0.75 - (fy - 1) * (fy - 1);
      wy[2] = 0.5 * (fy - 0.5) * (fy - 0.5);
      wz[0] = 0.5 * (1.5 - fz) * (1.5 - fz);
      wz[1] = 0.75 - (fz - 1) * (fz - 1);
      wz[2] = 0.5 * (fz - 0.5) * (fz - 0.5);
      const rx = px[p];
      const ry = sr * py[p] - cy - this.bendAt(pz[p]);
      const d = Math.hypot(rx, ry);
      const nx = rx / d;
      const ny = ry / d;
      const un = (this.roll.vcy + this.bendVelAt(pz[p])) * ny + this.roll.vR;
      const ux = -omega * R * ny + un * nx;
      const uy = omega * R * nx + un * ny;
      let e = 0;
      let W = 0;
      let dnn = 0;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const wij = wx[i] * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN;
          const along = ((i - fx) * nx + sr * (j - fy) * ny) * h;
          for (let k = 0; k < 3; k++) {
            const w = wij * wz[k];
            // the ghost layer holds its mirror image's velocity already only after the copy back: read the mirror
            const iz = bz + k;
            const idx = row + (iz === 0 ? 2 : iz);
            const vnode = gvx[idx] * nx + sr * gvy[idx] * ny;
            e += w * (vnode - ux * nx - uy * ny);
            dnn += w * vnode * along;
            if (gcon[idx]) W += w;
          }
        }
      }
      const o = 9 * p;
      const edge = e - halfDp * Math.hypot(F[o + 1], F[o + 4]) * k4 * dnn;
      if (edge >= 0 || W <= 0) continue;
      const want = -edge / W;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const wij = wx[i] * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN;
          for (let k = 0; k < 3; k++) {
            const iz = bz + k;
            const idx = row + (iz === 0 ? 2 : iz);
            if (!gcon[idx]) continue;
            const wm = wij * wz[k] * mass[p];
            if (!(wm > 0)) continue;
            gfolN[idx] += wm * want;
            gfolD[idx] += wm;
          }
        }
      }
    }
  }

  private followNodes(): void {
    const { h, ox, nyN, nzN, dt, accFz, accMap, binCol0, nBinsX, gyOff, fullThickness: full } = this;
    const { vx: gvx, vy: gvy, vz: gvz, m: gm, folN: gfolN, folD: gfolD, slipX: gslipX, slipY: gslipY, slipZ: gslipZ } = this.G;
    const mu = this.params.rolling.mu;
    const { cy } = this.roll;
    const invDt = 1 / dt;
    const slab = nyN * nzN;
    let fyAdd = 0;
    let tqAdd = 0;
    for (let ix = this.colLo, hi = this.colHi; ix < hi; ix++) for (let idx = ix * slab, end = idx + slab; idx < end; idx++) {
      if (!(gfolD[idx] > 0)) continue;
      const dv = gfolN[idx] / gfolD[idx];
      const iy = Math.floor((idx - ix * slab) / nzN);
      const iz = idx - ix * slab - iy * nzN;
      const rx = ox + ix * h;
      const yi = (iy - gyOff) * h;
      const sr = full && yi < 0 ? -1 : 1;
      const ry = sr * yi - cy;
      const d = Math.hypot(rx, ry);
      const nx = rx / d;
      const ny = ry / d;
      gvx[idx] += dv * nx;
      gvy[idx] += sr * (dv * ny);
      const mi = gm[idx];
      const sx = gslipX[idx];
      const sy = sr * gslipY[idx];
      const sz = gslipZ[idx];
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      let tx = 0;
      let ty = 0;
      if (sl > 0) {
        const ds = Math.min(sl, mu * dv);
        const c = -ds / sl;
        tx = c * sx;
        ty = c * sy;
        gvx[idx] += tx;
        gvy[idx] += sr * ty;
        gvz[idx] += c * sz;
        const stuck = ds >= sl;
        gslipX[idx] = stuck ? 0 : sx + tx;
        gslipY[idx] = stuck ? 0 : sr * (sy + ty);
        gslipZ[idx] = stuck ? 0 : sz + c * sz;
      }
      const f = mi * dv * invDt;
      const fx = f * nx + mi * tx * invDt;
      const fy = f * ny + mi * ty * invDt;
      fyAdd += fy;
      tqAdd += -(rx * fy - ry * fx);
      accFz[iz] += f;
      const b = ix - binCol0;
      if (b >= 0 && b < nBinsX) accMap[b * nzN + iz] += f;
    }
    this.part[PT_FY] += fyAdd;
    this.part[PT_TQ] += tqAdd;
  }

  private g2pVelocity(): void {
    const { n, active, px, py, pz, vx, vy, vz, C, F, mass, h, ox, nyN, nzN, failed, pres, vr, th, owner, gyOff } = this;
    const me = this.rank + 1;
    const { vx: gvx, vy: gvy, vz: gvz } = this.G;
    const { Th: gTh, Je: gJe, B: gB, Mv: gMv } = this.g;
    const invH = 1 / h;
    const k4 = 4 * invH * invH;
    const invK = 1 / this.el.K;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    for (let p = 0; p < n; p++) {
      if (!active[p] || owner[p] !== me) continue;
      const gx = (px[p] - ox) * invH;
      const gy = py[p] * invH + gyOff;
      const gz = pz[p] * invH + 1;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const bz = Math.floor(gz - 0.5);
      const fx = gx - bx;
      const fy = gy - by;
      const fz = gz - bz;
      wx[0] = 0.5 * (1.5 - fx) * (1.5 - fx);
      wx[1] = 0.75 - (fx - 1) * (fx - 1);
      wx[2] = 0.5 * (fx - 0.5) * (fx - 0.5);
      wy[0] = 0.5 * (1.5 - fy) * (1.5 - fy);
      wy[1] = 0.75 - (fy - 1) * (fy - 1);
      wy[2] = 0.5 * (fy - 0.5) * (fy - 0.5);
      wz[0] = 0.5 * (1.5 - fz) * (1.5 - fz);
      wz[1] = 0.75 - (fz - 1) * (fz - 1);
      wz[2] = 0.5 * (fz - 0.5) * (fz - 0.5);
      let nvx = 0, nvy = 0, nvz = 0;
      let b00 = 0, b01 = 0, b02 = 0, b10 = 0, b11 = 0, b12 = 0, b20 = 0, b21 = 0, b22 = 0;
      for (let i = 0; i < 3; i++) {
        const dx = (i - fx) * h;
        for (let j = 0; j < 3; j++) {
          const dy = (j - fy) * h;
          const wij = wx[i] * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN + bz;
          for (let k = 0; k < 3; k++) {
            const w = wij * wz[k];
            const dzz = (k - fz) * h;
            const idx = row + k;
            const gx1 = w * gvx[idx];
            const gy1 = w * gvy[idx];
            const gz1 = w * gvz[idx];
            nvx += gx1;
            nvy += gy1;
            nvz += gz1;
            b00 += gx1 * dx;
            b01 += gx1 * dy;
            b02 += gx1 * dzz;
            b10 += gy1 * dx;
            b11 += gy1 * dy;
            b12 += gy1 * dzz;
            b20 += gz1 * dx;
            b21 += gz1 * dy;
            b22 += gz1 * dzz;
          }
        }
      }
      const o = 9 * p;
      C[o] = k4 * b00;
      C[o + 1] = k4 * b01;
      C[o + 2] = k4 * b02;
      C[o + 3] = k4 * b10;
      C[o + 4] = k4 * b11;
      C[o + 5] = k4 * b12;
      C[o + 6] = k4 * b20;
      C[o + 7] = k4 * b21;
      C[o + 8] = k4 * b22;
      vx[p] = nvx;
      vy[p] = nvy;
      vz[p] = nvz;
      const theta = C[o] + C[o + 4] + C[o + 8];
      th[p] = theta;
      // inverted points and points failed in tension keep their own rate (solver.ts g2pVelocity)
      const J = det3(F, o);
      if ((failed[p] && !(pres[p] > 0)) || !(J > 0)) continue;
      const m = mass[p];
      const mth = m * theta;
      const mfe = -m * pres[p] * invK;
      const v = vr[p];
      const mb = v > 0 ? m * (v < 1 ? v : 1) : 0;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const wij = wx[i] * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN + bz;
          for (let k = 0; k < 3; k++) {
            const w = wij * wz[k];
            const idx = row + k;
            gTh[idx] += w * mth;
            gJe[idx] += w * mfe;
            gB[idx] += w * mb;
            gMv[idx] += w * m;
          }
        }
      }
    }
  }

  /** the volume averaging's sums by node: the ghost layers' onto their mirror images, the means, and the means back to the ghosts */
  private volumeMeans(): void {
    const { nyN, nzN, iyLo } = this;
    const full = this.fullThickness;
    const { Th: gTh, Je: gJe, B: gB, Mv: gMv } = this.G;
    for (let ix = this.colLo, hi = this.colHi; ix < hi; ix++) {
      const col = ix * nyN * nzN;
      if (!full) for (let iz = 0; iz < nzN; iz++) {
        const g = col + iz;
        if (gMv[g] === 0) continue;
        const m = g + 2 * nzN;
        gTh[m] += gTh[g];
        gJe[m] += gJe[g];
        gB[m] += gB[g];
        gMv[m] += gMv[g];
        gMv[g] = 0;
      }
      for (let iy = iyLo; iy < nyN; iy++) {
        const g = col + iy * nzN;
        if (gMv[g] === 0) continue;
        const m = g + 2;
        gTh[m] += gTh[g];
        gJe[m] += gJe[g];
        gB[m] += gB[g];
        gMv[m] += gMv[g];
        gMv[g] = 0;
      }
      for (let idx = col + iyLo * nzN; idx < col + nyN * nzN; idx++) {
        const m = gMv[idx];
        if (m > 0) {
          gTh[idx] /= m;
          const b = gB[idx] / m;
          gB[idx] = b;
          gJe[idx] = (b * gJe[idx]) / m;
        }
      }
      for (let iy = iyLo; iy < nyN; iy++) {
        const g = col + iy * nzN;
        gTh[g] = gTh[g + 2];
        gJe[g] = gJe[g + 2];
        gB[g] = gB[g + 2];
      }
      if (!full) for (let iz = 0; iz < nzN; iz++) {
        const g = col + iz;
        const m = g + 2 * nzN;
        gTh[g] = gTh[m];
        gJe[g] = gJe[m];
        gB[g] = gB[m];
      }
    }
  }

  private g2pUpdate(): void {
    const { n, active, px, py, pz, vx, vy, vz, C, F, dt, h, ox, nxN, nyN, nzN, failed, pres, vr, owner, part, gyOff, fullThickness: full } = this;
    const me = this.rank + 1;
    const { Th: gTh, Je: gJe, B: gB } = this.G;
    const { sxx, syy, szz, sxy, syz, szx, temp, vol0, dJC, dHM, dCL, strength, strengthEp } = this;
    const P = this.params;
    const mat = P.material;
    const dmg = P.damage;
    const { K, G } = this.el;
    const invH = 1 / h;
    const rateScale = P.rolling.millSpeed / P.rolling.rollSpeed;
    const xMax = (nxN - 3) * h + ox;
    const xMin = ox + 2 * h;
    const yMax = this.yMax;
    const yMin = full ? -yMax : -INF;
    const zMax = (nzN - 4) * h;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    for (let p = 0; p < n; p++) {
      if (!active[p] || owner[p] !== me) continue;
      const o = 9 * p;
      const l00 = C[o], l01 = C[o + 1], l02 = C[o + 2], l10 = C[o + 3], l11 = C[o + 4], l12 = C[o + 5], l20 = C[o + 6], l21 = C[o + 7], l22 = C[o + 8];
      const Jold = det3(F, o);
      let cor = 1;
      if (!((failed[p] && !(pres[p] > 0)) || !(Jold > 0))) {
        const gx = (px[p] - ox) * invH;
        const gy = py[p] * invH + gyOff;
        const gz = pz[p] * invH + 1;
        const bx = Math.floor(gx - 0.5);
        const by = Math.floor(gy - 0.5);
        const bz = Math.floor(gz - 0.5);
        const fx = gx - bx;
        const fy = gy - by;
        const fz = gz - bz;
        wx[0] = 0.5 * (1.5 - fx) * (1.5 - fx);
        wx[1] = 0.75 - (fx - 1) * (fx - 1);
        wx[2] = 0.5 * (fx - 0.5) * (fx - 0.5);
        wy[0] = 0.5 * (1.5 - fy) * (1.5 - fy);
        wy[1] = 0.75 - (fy - 1) * (fy - 1);
        wy[2] = 0.5 * (fy - 0.5) * (fy - 0.5);
        wz[0] = 0.5 * (1.5 - fz) * (1.5 - fz);
        wz[1] = 0.75 - (fz - 1) * (fz - 1);
        wz[2] = 0.5 * (fz - 0.5) * (fz - 0.5);
        let thBar = 0;
        let rA = 0;
        let rB = 0;
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            const wij = wx[i] * wy[j];
            const row = ((bx + i) * nyN + by + j) * nzN + bz;
            for (let k = 0; k < 3; k++) {
              const w = wij * wz[k];
              const idx = row + k;
              thBar += w * gTh[idx];
              rA += w * gJe[idx];
              rB += w * gB[idx];
            }
          }
        }
        // the smoothed rate and the relaxation of the elastic log volume toward its grid mean (ln J − ev = −p/K)
        const theta = thBar + (rA + (rB * pres[p]) / K) / dt;
        const g00 = 1 + dt * l00, g11 = 1 + dt * l11, g22 = 1 + dt * l22;
        const detG = g00 * (g11 * g22 - dt * dt * l12 * l21) - dt * l01 * (dt * l10 * g22 - dt * dt * l12 * l20) + dt * l02 * (dt * dt * l10 * l21 - g11 * dt * l20);
        const ratio = Math.exp(dt * theta) / detG;
        cor = ratio > 0 ? Math.cbrt(ratio) : 1;
      }
      const nxp = px[p] + dt * vx[p];
      const nyp = py[p] + dt * vy[p];
      const nzp = pz[p] + dt * vz[p];
      px[p] = nxp;
      // a point across a plane of symmetry is folded back; the full strip's y is free both ways
      py[p] = nyp < 0 && !full ? -nyp : nyp;
      pz[p] = nzp < 0 ? -nzp : nzp;
      if (nxp < xMin || nxp > xMax || nyp > yMax || nyp < yMin || nzp > zMax) {
        active[p] = 0;
        continue;
      }

      // F ← c (I + dt L) F
      const g00 = cor * (1 + dt * l00), g01 = cor * dt * l01, g02 = cor * dt * l02;
      const g10 = cor * dt * l10, g11 = cor * (1 + dt * l11), g12 = cor * dt * l12;
      const g20 = cor * dt * l20, g21 = cor * dt * l21, g22 = cor * (1 + dt * l22);
      const F00 = F[o], F01 = F[o + 1], F02 = F[o + 2], F10 = F[o + 3], F11 = F[o + 4], F12 = F[o + 5], F20 = F[o + 6], F21 = F[o + 7], F22 = F[o + 8];
      F[o] = g00 * F00 + g01 * F10 + g02 * F20;
      F[o + 1] = g00 * F01 + g01 * F11 + g02 * F21;
      F[o + 2] = g00 * F02 + g01 * F12 + g02 * F22;
      F[o + 3] = g10 * F00 + g11 * F10 + g12 * F20;
      F[o + 4] = g10 * F01 + g11 * F11 + g12 * F21;
      F[o + 5] = g10 * F02 + g11 * F12 + g12 * F22;
      F[o + 6] = g20 * F00 + g21 * F10 + g22 * F20;
      F[o + 7] = g20 * F01 + g21 * F11 + g22 * F21;
      F[o + 8] = g20 * F02 + g21 * F12 + g22 * F22;
      const J = det3(F, o);

      // deviatoric rate of deformation and spin
      const tr3 = (l00 + l11 + l22) / 3;
      const exx = l00 - tr3;
      const eyy = l11 - tr3;
      const ezz = l22 - tr3;
      const exy = 0.5 * (l01 + l10);
      const eyz = 0.5 * (l12 + l21);
      const ezx = 0.5 * (l20 + l02);
      const wxy = 0.5 * (l01 - l10);
      const wyz = 0.5 * (l12 - l21);
      const wzx = 0.5 * (l20 - l02);
      const epsDot = Math.sqrt((2 / 3) * (exx * exx + eyy * eyy + ezz * ezz + 2 * (exy * exy + eyz * eyz + ezx * ezx))) * rateScale;

      // Jaumann: s ← s + dt (W s − s W), W = [[0, wxy, −wzx], [−wxy, 0, wyz], [wzx, −wyz, 0]]
      let sx = sxx[p], sy = syy[p], sz = szz[p], sa = sxy[p], sb = syz[p], sc = szx[p];
      {
        const rxx = 2 * (wxy * sa - wzx * sc);
        const ryy = 2 * (-wxy * sa + wyz * sb);
        const rzz = 2 * (wzx * sc - wyz * sb);
        const rxy = wxy * (sy - sx) - wzx * sb + wyz * sc;
        const ryz = wyz * (sz - sy) - wxy * sc + wzx * sa;
        const rzx = wzx * (sx - sz) - wyz * sa + wxy * sb;
        sx += dt * rxx;
        sy += dt * ryy;
        sz += dt * rzz;
        sa += dt * rxy;
        sb += dt * ryz;
        sc += dt * rzx;
      }
      const g2 = 2 * G * dt;
      sx += g2 * exx;
      sy += g2 * eyy;
      sz += g2 * ezz;
      sa += g2 * exy;
      sb += g2 * eyz;
      sc += g2 * ezx;
      let pr = J > 0 ? -K * Math.log(J) : 0;
      let q = Math.sqrt(1.5 * (sx * sx + sy * sy + sz * sz + 2 * (sa * sa + sb * sb + sc * sc)));
      let dep = 0;
      vr[p] = 0;
      if (failed[p]) {
        sx = sy = sz = sa = sb = sc = 0;
        q = 0;
        if (pr < 0) pr = 0;
      } else {
        const ep = this.ep[p];
        if (strengthEp[p] !== ep) {
          strength[p] = staticStrength(mat, ep);
          strengthEp[p] = ep;
        }
        const s0 = strength[p];
        const cool = temp[p] <= mat.tRoom && mat.jcC >= 0;
        dep = (cool && q <= s0) || q <= s0 * strengthFactor(mat, epsDot, temp[p]) ? 0 : plasticIncrement(mat, G, q, ep, epsDot, temp[p]);
        if (dep > 0) {
          const s = 1 - (3 * G * dep) / q;
          sx *= s;
          sy *= s;
          sz *= s;
          sa *= s;
          sb *= s;
          sc *= s;
          q -= 3 * G * dep;
          this.ep[p] += dep;
          part[PT_WORK] += q * dep * vol0[p] * J;
          if (mat.chi > 0) temp[p] += adiabaticRise(mat.chi, q * dep, J, mat.rho, mat.cp);
        }
      }
      sxx[p] = sx;
      syy[p] = sy;
      szz[p] = sz;
      sxy[p] = sa;
      syz[p] = sb;
      szx[p] = sc;
      pres[p] = pr;
      const eta = q > 1e3 ? -pr / q : 0;
      this.seq[p] = q;
      this.eta[p] = eta;
      if (dep > 0) {
        if (q > 0) vr[p] = (3 * K * dep) / q;
        if (eta > dmg.etaCutoff) {
          dJC[p] += dep / jcFractureStrain(dmg, eta, epsDot / mat.epsDot0, homologousTemperature(mat, temp[p]));
          dHM[p] += dep / hmFractureStrain(eta);
        }
        const s1 = maxPrincipal(sx - pr, sy - pr, sz - pr, sa, sb, sc);
        if (s1 > 0) dCL[p] += ((s1 / q) * dep) / dmg.clCrit;
        if (dmg.model !== 'none' && this.governingDamage(p) >= 1 && !this.inGrip(p)) this.fail(p);
      }
    }
  }

  /** the damage indicator of the chosen criterion (Johnson-Cook's where the criterion has none of its own) */
  /** the largest principal Cauchy stress of point p [Pa] */
  maxPrincipal(p: number): number {
    const pr = this.pres[p];
    return maxPrincipal(this.sxx[p] - pr, this.syy[p] - pr, this.szz[p] - pr, this.sxy[p], this.syz[p], this.szx[p]);
  }

  governingDamage(p: number): number {
    const m = this.params.damage.model;
    return m === 'hancock-mackenzie' ? this.dHM[p] : m === 'cockcroft-latham' ? this.dCL[p] : this.dJC[p];
  }

  private fail(p: number): void {
    // the ends are held by nothing here, but the pusher's column must stay whole
    if (p < this.NJ * this.NK) return;
    this.failed[p] = 1;
    this.part[PT_NFAIL]++;
    if (this.part[PT_FIRST] < 0 || p < this.part[PT_FIRST]) this.part[PT_FIRST] = p;
  }

  /** the first point to fail (the lowest index of the step's), at the end of the step it failed in */
  private recordFirstCrack(p: number): void {
    const i = Math.floor(p / (this.NJ * this.NK));
    const j = Math.floor(p / this.NK) % this.NJ;
    const k = p % this.NK;
    this.firstCrack = {
      t: this.t,
      step: this.step,
      x: this.px[p],
      y: this.py[p],
      z: this.pz[p],
      sheetX: (this.NI - 1 - i + 0.5) * this.dp,
      sheetY: (j + 0.5 - this.jOff) * this.dp,
      sheetZ: (k + 0.5) * this.dz,
      point: p,
      eta: this.eta[p],
      seq: this.seq[p],
      ep: this.ep[p],
      criterion: this.params.damage.model,
    };
  }

  /** the point's deformed cross-section normal to x [m²]: dp dz × the yz cofactor of F (|F e_y × F e_z|'s x-component) */
  section(p: number): number {
    const o = 9 * p;
    const { F } = this;
    return this.dp * this.ySize[p % this.NK] * this.dz * Math.abs(F[o + 4] * F[o + 8] - F[o + 5] * F[o + 7]);
  }

  /** the entry half thickness at z [m] (the entry crown's parabola; h0 / 2 without) */
  entryHalfThickness(z: number): number {
    const { h0 } = this.params.rolling;
    const crown = this.params.solid.crownIn ?? 0;
    return 0.5 * (h0 - (crown * z * z) / (this.halfWidth0 * this.halfWidth0));
  }

  /** Young's modulus of the strip [Pa] */
  get youngs(): number {
    const { K, G } = this.el;
    return (9 * K * G) / (3 * K + G);
  }

  /** In the gripped length of an end while a tension is applied there: damage is shown there but does not fail the point. */
  inGrip(p: number): boolean {
    const i = Math.floor(p / (this.NJ * this.NK));
    return (this.frontNow > 0 && i >= this.NI - this.gripCols) || (this.backNow > 0 && i < this.gripCols);
  }

  /**
   * Share of the end load for a point of lattice column i in the grip of the tail (1) or the head (2): largest at
   * the end column, falling linearly towards the inner end of the grip (solver.ts gripWeight).
   */
  gripWeight(i: number, end: number): number {
    const g = this.gripCols;
    const j = end === 1 ? g - 1 - i : i - (this.NI - g);
    return (j + 0.5) / g;
  }

  /** Total load the tail (1) or head (2) grip puts on the quarter strip this step [N], signed along x. */
  endLoad(tg: number): number {
    const { n, active, NI } = this;
    const m = this.NJ * this.NK;
    const g = this.gripCols;
    const t = tg === 1 ? -this.backNow * this.backScale : this.frontNow * this.frontScale;
    let f = 0;
    for (let p = 0; p < n; p++) {
      const i = Math.floor(p / m);
      if (!active[p] || (tg === 1 ? i >= g : i < NI - g)) continue;
      f += t * this.gripWeight(i, tg) * this.section(p);
    }
    return f;
  }

  /** The end column's actual cross-section (the quarter's): Σ of its active points' deformed sections [m²] */
  endSection(tg: number): number {
    const m = this.NJ * this.NK;
    const from = tg === 1 ? 0 : this.n - m;
    let a = 0;
    for (let p = from; p < from + m; p++) if (this.active[p]) a += this.section(p);
    return a;
  }

  /**
   * Tension stresses for this step (solver.ts updateTension): back tension ramps up from the start and is let go
   * once the tail reaches the entry plane; front tension is switched on when the head passes the exit probe and
   * ramps up from then.
   */
  private updateTension(): void {
    const r = this.params.rolling;
    const t = this.t;
    const ramp = this.tensionRamp;
    if (r.backTension !== 0) {
      if (this.backOffAt < 0 && this.tailX() >= -this.contactLength) this.backOffAt = t;
      let back = r.backTension * Math.min(1, t / ramp);
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
   * The end column's section over Σ w A_p of the points in that end's grip (w the grip weight, A_p the deformed
   * section): each gripped point's load is σ w A_p times this, so the total is σ × the end column's section whatever
   * the grip's columns look like. 0 when the end column has left the grid.
   */
  private gripScale(tg: number): number {
    const a = this.endSection(tg);
    if (!(a > 0)) return 0;
    const { n, active, NI } = this;
    const m = this.NJ * this.NK;
    const g = this.gripCols;
    let sum = 0;
    for (let p = 0; p < n; p++) {
      const i = Math.floor(p / m);
      if (!active[p] || (tg === 1 ? i >= g : i < NI - g)) continue;
      sum += this.gripWeight(i, tg) * this.section(p);
    }
    return sum > 0 ? a / sum : 0;
  }

  /** The tensions asked for are fully on (solver.ts tensionsOn): 'steady' waits for them */
  tensionsOn(): boolean {
    const r = this.params.rolling;
    // the tension the last step applied: updateTension() reads t at the start of the step
    const t = this.t - this.dt;
    if (r.frontTension !== 0 && (this.frontOnAt < 0 || t - this.frontOnAt < this.tensionRamp)) return false;
    return r.backTension === 0 || t >= this.tensionRamp;
  }

  /** front of the head column (+∞ once it has left the grid) */
  headX(): number {
    const { n, active, px } = this;
    let x = -INF;
    for (let p = n - this.NJ * this.NK; p < n; p++) if (active[p] && px[p] > x) x = px[p];
    return x === -INF ? INF : x;
  }

  /** back of the tail column (+∞ once it has left the grid) */
  tailX(): number {
    const { active, px } = this;
    let x = INF;
    for (let p = 0; p < this.NJ * this.NK; p++) if (active[p] && px[p] < x) x = px[p];
    return x;
  }

  phase(): SolidPhase {
    if (this.stalled) return 'stalled';
    const head = this.headX();
    const tail = this.tailX();
    if (tail > 2 * this.params.rolling.h0 || tail === INF) return 'done';
    if (head < -this.contactLength) return 'approach';
    if (head < this.xExitProbe) return 'bite';
    if (tail > -this.contactLength) return 'tail-out';
    return this.rollsSettled && this.bendSettled && this.tensionsOn() ? 'steady' : 'adjusting';
  }

  /** the sheet no longer moves though it is between the rolls (the rolls cannot draw it in) */
  private checkStall(): void {
    const tail = this.tailX();
    if (tail === INF || tail > -this.contactLength) return;
    if (tail - this.stallX < 0.02 * this.vIn * 200 * this.dt) this.stalled = true;
    this.stallX = tail;
  }

  /**
   * The roll force and torque on one roll over the whole width since the last read (means over the steps
   * [N, N m]), the normal force per unit width by z column [N/m] (from the mid-width out; the column on the
   * mid-width plane holds half a cell), and the contact pressure by (x, z) cell [Pa]. Restarts the sums.
   */
  readContact(): { force: number; torque: number; steps: number; byZ: Float64Array; map: Float64Array } | null {
    const s = this.accSteps;
    if (s === 0) return null;
    const { nzN, h, nBinsX, rollShare } = this;
    const byZ = new Float64Array(nzN - 1);
    for (let iz = 1; iz < nzN; iz++) byZ[iz - 1] = (rollShare * this.accFz[iz]) / s / (iz === 1 ? h / 2 : h);
    const map = new Float64Array(nBinsX * (nzN - 1));
    for (let b = 0; b < nBinsX; b++) for (let iz = 1; iz < nzN; iz++) map[b * (nzN - 1) + iz - 1] = (rollShare * this.accMap[b * nzN + iz]) / s / (h * (iz === 1 ? h / 2 : h));
    const out = { force: (2 * this.accFy) / s, torque: (2 * this.accTq) / s, steps: s, byZ, map };
    this.accFy = 0;
    this.accTq = 0;
    this.accSteps = 0;
    this.accFz.fill(0);
    this.accMap.fill(0);
    return out;
  }

  /**
   * The strip at x (the exit probe), in a band of one cell: the half width (the edge points' outer faces), the
   * half thickness by lattice column across the width (the top points' upper faces), and the mean speed.
   * null until material is there.
   */
  exitMeasure(x = this.xExitProbe, band = this.h): { halfWidth: number; halfThickness: Float64Array; speed: number; z: Float64Array; speedByZ: Float64Array; stressByZ: Float64Array } | null {
    const { active, px, py, pz, vx, sxx, pres, F, NI, NJ, NK, dp, dz, ySize } = this;
    const thick = new Float64Array(NK);
    const count = new Int32Array(NK);
    // by column across the width: where it is (z of the surface point), the speed and the longitudinal stress
    // (section-weighted through the thickness) — what the strip's flatness is read from (steady.ts)
    const zc = new Float64Array(NK);
    const vc = new Float64Array(NK);
    const sc = new Float64Array(NK);
    const ac = new Float64Array(NK);
    const nc = new Int32Array(NK);
    let w = 0;
    let nw = 0;
    let v = 0;
    let nv = 0;
    for (let i = 0; i < NI; i++) {
      // the column's first point tells where it is
      const p0 = this.lattice(i, 0, 0);
      if (!active[p0] || Math.abs(px[p0] - x) > 2 * band) continue;
      for (let k = 0; k < NK; k++) {
        const p = this.lattice(i, NJ - 1, k);
        if (!active[p] || Math.abs(px[p] - x) > band / 2) continue;
        const top = py[p] + 0.5 * dp * ySize[k] * F[9 * p + 4];
        if (this.fullThickness) {
          // half the distance between the top face and the bottom one
          const q = this.lattice(i, 0, k);
          if (!active[q]) continue;
          thick[k] += 0.5 * (top - (py[q] - 0.5 * dp * ySize[k] * F[9 * q + 4]));
        } else thick[k] += top;
        zc[k] += pz[p];
        count[k]++;
        v += vx[p];
        nv++;
        for (let j = 0; j < NJ; j++) {
          const q = this.lattice(i, j, k);
          if (!active[q]) continue;
          const A = this.section(q);
          vc[k] += vx[q];
          nc[k]++;
          sc[k] += (sxx[q] - pres[q]) * A;
          ac[k] += A;
        }
      }
      for (let j = 0; j < NJ; j++) {
        const p = this.lattice(i, j, NK - 1);
        if (!active[p] || Math.abs(px[p] - x) > band / 2) continue;
        w += pz[p] + 0.5 * dz * F[9 * p + 8];
        nw++;
      }
    }
    if (nw === 0 || nv === 0) return null;
    for (let k = 0; k < NK; k++) {
      thick[k] = count[k] ? thick[k] / count[k] : NaN;
      zc[k] = count[k] ? zc[k] / count[k] : NaN;
      vc[k] = nc[k] ? vc[k] / nc[k] : NaN;
      sc[k] = ac[k] > 0 ? sc[k] / ac[k] : NaN;
    }
    return { halfWidth: w / nw, halfThickness: thick, speed: v / nv, z: zc, speedByZ: vc, stressByZ: sc };
  }

  /** the half width along the strip: the edge points' outer faces, the mean through the thickness, by lattice column (NaN where none is on the grid) */
  edgeProfile(): { x: Float64Array; halfWidth: Float64Array } {
    const { active, px, pz, F, NI, NJ, NK, dz } = this;
    const x = new Float64Array(NI);
    const hw = new Float64Array(NI);
    for (let i = 0; i < NI; i++) {
      let sx = 0;
      let sw = 0;
      let c = 0;
      for (let j = 0; j < NJ; j++) {
        const p = this.lattice(i, j, NK - 1);
        if (!active[p]) continue;
        sx += px[p];
        sw += pz[p] + 0.5 * dz * F[9 * p + 8];
        c++;
      }
      x[i] = c ? sx / c : NaN;
      hw[i] = c ? sw / c : NaN;
    }
    return { x, halfWidth: hw };
  }

  maxDamage(): number {
    let m = 0;
    for (let p = 0; p < this.n; p++) if (this.active[p] && !this.failed[p]) m = Math.max(m, this.governingDamage(p));
    return m;
  }
}

function det3(F: Float64Array, o: number): number {
  return F[o] * (F[o + 4] * F[o + 8] - F[o + 5] * F[o + 7]) - F[o + 1] * (F[o + 3] * F[o + 8] - F[o + 5] * F[o + 6]) + F[o + 2] * (F[o + 3] * F[o + 7] - F[o + 4] * F[o + 6]);
}

/** largest eigenvalue of the symmetric tensor [[a, d, f], [d, b, e], [f, e, c]] (trigonometric form) */
export function maxPrincipal(a: number, b: number, c: number, d: number, e: number, f: number): number {
  const m = (a + b + c) / 3;
  const p1 = d * d + e * e + f * f;
  const a0 = a - m;
  const b0 = b - m;
  const c0 = c - m;
  const p2 = a0 * a0 + b0 * b0 + c0 * c0 + 2 * p1;
  if (p2 <= 0) return m;
  const pp = Math.sqrt(p2 / 6);
  const detB = (a0 * (b0 * c0 - e * e) - d * (d * c0 - e * f) + f * (d * e - b0 * f)) / (pp * pp * pp);
  const r = Math.max(-1, Math.min(1, detB / 2));
  return m + 2 * pp * Math.cos(Math.acos(r) / 3);
}
