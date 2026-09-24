// Tandem rolling with the three-dimensional model, and the strip length a stand needs to roll steadily: what
// tandem.ts is to the section model (docs/model.md「3 次元モデル」).
//
// Each stand is its own Sim3, solved one after the other, every stand with the same condition (rolls, μ,
// material, cells through the thickness, the reduction taken on its own entry thickness). Stand k + 1 starts
// with the strip that came out of stand k: its entry thickness and width are that strip's measured ones, and
// every new point takes the state of an old point of the same lattice row through the thickness, the same
// share of the way across the width, and along x by the material (handoff 'done': the whole strip, mass
// kept) or from the steadily rolled stretch repeated (handoff 'steady': the next stand starts as soon as this
// one has STEADY_LOOKS steady looks and enough steady strip out, with a strip only as long as it needs itself).
// or the middle of the strip cut out (handoff 'crop': as long as the next stand needs to get steady, handed on as soon
// as that stretch is out of the rolls, the tail not rolled). The strip's shape goes with it (remap3): with 'done' and
// 'crop' column by column along x (the plan view's outline, the crown, the edge's barrel, the ends), with 'steady'
// the steady section's.
//
// One stand is a plain pass: the same steps and looks as Sim3 with a SolidSampler.
import { elasticConstants } from '../material.ts';
import { cloneParams } from '../params.ts';
import { MAX_STANDS, type Handoff, type TandemStop } from '../tandem.ts';
import { Sim3, solidScales, type Sim3Options, type Solid3Params } from './sim3.ts';
import type { Team } from './team.ts';
import { READ_STEPS, SolidSampler, type SolidLook, type SolidSteady } from './steady.ts';

export { MAX_STANDS };

/** steady looks a stand takes before a 'steady' handoff (as many steps as the section model's two readings) */
export const STEADY_LOOKS = 4;

/** One finished stand. Lengths [m], force [N] on one roll over the whole width, time [s] within the stand. */
export interface Stand3Result {
  stand: number;
  /** the stand's entry strip */
  h0: number;
  width: number;
  sheetLength: number;
  particles: number;
  steps: number;
  t: number;
  /** how it ended: 'done', 'steady' (handed on while it rolled steadily), 'cropped' (handed on once the middle stretch
   *  the next stand takes was out: handoff 'crop'), or 'stalled' */
  phase: 'done' | 'steady' | 'cropped' | 'stalled';
  /** means over the steady looks (steady.ts); null without one */
  steady: SolidSteady | null;
  /** the strip that came out: volume over length and width, and the edge's mean half width doubled (the next stand's entry) */
  thicknessOut: number;
  widthOut: number;
  /** the fraction of the stand's mass on points that left the grid (0 normally) */
  massLost: number;
  /** three neighbouring lattice columns have a failed point at every place of the section between them */
  separated: boolean;
  maxDamage: number;
  nFailed: number;
  /** the rolls at the stand's end: the radius in the contact (R' with flattening), the gap, and whether they had settled (true with rolls that are not adjusted) */
  rollRadius: number;
  gap: number;
  rollsSettled: boolean;
}

export interface Stand3Done {
  stand: number;
  sim: Sim3;
  next: Sim3 | null;
  result: Stand3Result;
}

/**
 * The strip length a stand needs to get to a 'steady' handoff (tandem.ts steadyLength, with the 3D model's looks):
 * what fills the bite, what has to be out by then (the head at 3 h0 + a contact length for steadySample3, or
 * STEADY_LOOKS looks after the exit probe, whichever is later), one look more, and one h0 over. It does not
 * depend on the width.
 */
export function steadyLength3(P: Solid3Params): number {
  const s = solidScales(P);
  const r = P.rolling;
  const look = READ_STEPS * s.dt * s.vIn;
  const out = Math.max((3 * r.h0 + s.contactLength) * (1 - r.reduction), s.xExitProbe * (1 - r.reduction) + STEADY_LOOKS * look);
  // rolls that follow the pass are held once the force is flat (Sim3.forceFlat: FLAT_WINDOWS quarter transits after
  // the head is out, about one transit where the force still climbs as they flatten), and the stretch is the strip
  // rolled after that; under gapControl 'reduction' up to one more transit for the gauge to come onto the target
  // (Sim3.gaugeWait)
  const settle = s.rollsAdjusted ? (r.gapControl === 'reduction' ? 2 : 1) * s.contactLength : 0;
  const base = s.contactLength + out + settle + look + r.h0;
  // a front tension ramps up after the head is out, and 'steady' waits for it (tandem.ts steadyLength)
  if (r.frontTension === 0) return base;
  if (r.tensionRamp && r.tensionRamp > 0) return base + r.tensionRamp * s.vIn;
  const el = elasticConstants(P.material);
  const c = Math.sqrt((el.K + (4 / 3) * el.G) / (P.material.rho * P.numerics.massScale));
  return base / (1 - (10 / c) * s.vIn);
}

/** The params with lengthMode 'steady' carried out (a copy; sheetLength = steadyLength3 up to a whole 0.1 mm). */
export function withSteadyLength3(params: Solid3Params): Solid3Params {
  const P: Solid3Params = { ...cloneParams(params), solid: { ...params.solid } };
  if (P.rolling.lengthMode === 'steady') P.rolling.sheetLength = Math.ceil(steadyLength3(P) * 1e4 - 1e-9) / 1e4;
  return P;
}

export class Tandem3 {
  readonly stands: number;
  readonly handoff: Handoff;
  /** the condition every stand shares (the first stand's strip) */
  readonly base: Solid3Params;
  stand = 0;
  sim: Sim3;
  sampler = new SolidSampler();
  readonly results: Stand3Result[] = [];
  /** time and steps of the stands before the current one */
  tOffset = 0;
  stepOffset = 0;
  /** called when a stand ends, inside advance(), before the next stand's Sim3 replaces sim */
  onStandDone: ((e: Stand3Done) => void) | null = null;
  stopped: TandemStop | null = null;
  private finished = false;
  /** the device the stands step on (useGpu); null: the CPU */
  private device: GPUDevice | null = null;
  /** the team of workers the stands step with (useTeam); null: this thread alone */
  private team: Team | null = null;
  /** how every stand's Sim3 is made (a team's coordinator: `{ shared: true, size }`) */
  private readonly simOpts: Sim3Options;
  /** handoff 'crop': the current stand's middle stretch the next stand takes (lattice columns [first, last]); null otherwise,
   *  or when the strip is no longer than that (it is carried whole) */
  crop: [number, number] | null = null;

  constructor(params: Solid3Params, stands = 1, handoff: Handoff = 'done', simOpts: Sim3Options = {}) {
    if (!(Number.isInteger(stands) && stands >= 1 && stands <= MAX_STANDS)) throw new Error(`stands must be 1 to ${MAX_STANDS}`);
    this.stands = stands;
    this.handoff = handoff;
    this.base = withSteadyLength3(params);
    this.simOpts = simOpts;
    this.sim = new Sim3(this.base, simOpts);
    this.crop = this.cropOf(this.sim);
  }

  private cropOf(sim: Sim3): [number, number] | null {
    return this.handoff === 'crop' && this.stand + 1 < this.stands ? cropColumns3(sim) : null;
  }

  /** true once the last stand has ended, or the tandem stopped */
  get done(): boolean {
    return this.finished;
  }

  /** the current stand and the ones after it step on the device (Sim3.attachGpu); advanceBatch() from then on */
  async useGpu(device: GPUDevice): Promise<void> {
    this.device = device;
    await this.sim.attachGpu(device);
  }

  /** the current stand and the ones after it step with the team (Team.attach; the Sim3s made with its size); advanceTeam() from then on */
  async useTeam(team: Team): Promise<void> {
    this.team = team;
    await team.attach(this.sim);
  }

  /** advance() with the team (Team.step); a stand that ends hands the team to the next */
  async advanceTeam(): Promise<SolidLook | null> {
    if (this.finished) return null;
    const sim = this.sim;
    const team = this.team;
    if (!team) throw new Error('no team (useTeam)');
    team.step();
    const look = this.lookAfterStep();
    if (this.sim !== sim) await team.attach(this.sim);
    return look;
  }

  /**
   * K steps of the current stand on the GPU (Sim3.advanceBatch), and the look when they end at a multiple of
   * READ_STEPS, as advance() does after each step. A stand that ends hands the device to the next.
   */
  async advanceBatch(K: number): Promise<SolidLook | null> {
    if (this.finished) return null;
    const sim = this.sim;
    if (Math.floor((sim.step + K - 1) / READ_STEPS) !== Math.floor(sim.step / READ_STEPS)) throw new Error('a batch must end at a multiple of READ_STEPS');
    await sim.advanceBatch(K);
    const look = this.lookAfterStep();
    if (this.sim !== sim) {
      sim.detachGpu();
      if (this.device) await this.sim.attachGpu(this.device);
    }
    return look;
  }

  /**
   * One step of the current stand, and its look every READ_STEPS steps (returned; null otherwise). A stand ends at
   * the look that finds it done or stalled, or (handoff 'steady', another stand after it) steady with STEADY_LOOKS
   * steady looks and a steady stretch of strip out. After the end nothing more is stepped.
   */
  advance(): SolidLook | null {
    if (this.finished) return null;
    this.sim.advance();
    return this.lookAfterStep();
  }

  private lookAfterStep(): SolidLook | null {
    const sim = this.sim;
    if (sim.step % READ_STEPS !== 0) return null;
    const look = this.sampler.look(sim);
    if (look.phase === 'done' || look.phase === 'stalled') this.endStand(look.phase);
    else if (this.handoff === 'steady' && look.phase === 'steady' && this.stand + 1 < this.stands && this.sampler.count >= STEADY_LOOKS) {
      const sample = steadySample3(sim);
      if (sample) this.endStand('steady', sample);
    } else if (this.crop && cropOut3(sim, this.crop)) this.endStand('cropped', null, this.crop);
    return look;
  }

  private endStand(phase: 'done' | 'steady' | 'cropped' | 'stalled', sample: [number, number] | null = null, crop: [number, number] | null = null): void {
    const old = this.sim;
    const result = close(old, this.stand, phase, this.sampler.means(old), sample ?? crop);
    this.results.push(result);
    const more = this.stand + 1 < this.stands;
    if (more) {
      const whole = result.thicknessOut > 0 && result.widthOut > 0;
      this.stopped = phase === 'stalled' ? 'stalled' : result.separated ? 'separated' : result.massLost > 0 || !whole ? 'lost' : null;
    }
    const next = more && !this.stopped ? remap3(old, this.base, result.thicknessOut, result.widthOut, sample, this.simOpts, crop) : null;
    this.onStandDone?.({ stand: this.stand, sim: old, next, result });
    if (!next) {
      this.finished = true;
      return;
    }
    this.tOffset += old.t;
    this.stepOffset += old.step;
    this.sim = next;
    this.sampler = new SolidSampler();
    this.stand++;
    this.crop = this.cropOf(next);
  }
}

function close(sim: Sim3, stand: number, phase: 'done' | 'steady' | 'cropped' | 'stalled', steady: SolidSteady | null, sample: [number, number] | null): Stand3Result {
  let mass = 0;
  let lost = 0;
  for (let p = 0; p < sim.n; p++) {
    mass += sim.mass[p];
    if (!sim.active[p]) lost += sim.mass[p];
  }
  const out = stripOut(sim, sample);
  const r = sim.params.rolling;
  return {
    stand,
    h0: r.h0,
    width: sim.params.solid.width,
    sheetLength: r.sheetLength,
    particles: sim.n,
    steps: sim.step,
    t: sim.t,
    phase,
    steady,
    thicknessOut: out.thickness,
    widthOut: out.width,
    massLost: lost / mass,
    separated: separated3(sim),
    maxDamage: sim.maxDamage(),
    nFailed: sim.nFailed,
    rollRadius: sim.roll.R,
    gap: sim.gap,
    rollsSettled: sim.rollsSettled,
  };
}

/** mean x of lattice column i (NaN when one of its points has left the grid) */
function columnX(sim: Sim3, i: number): number {
  const m = sim.NJ * sim.NK;
  let s = 0;
  for (let p = i * m; p < (i + 1) * m; p++) {
    if (!sim.active[p]) return NaN;
    s += sim.px[p];
  }
  return s / m;
}

/**
 * Thickness and width of the strip that has come out: over the middle half of the lattice columns (or the
 * sample's), the width is the edge's mean half width doubled (the edge points' outer faces, as the exit probe
 * takes it) and the thickness is the volume (Σ vol0 J, the quarter's) over the length along x and that half width,
 * doubled: what the mass needs (tandem.ts thicknessOut). NaN when a column has lost a point.
 */
export function stripOut(sim: Sim3, sample: [number, number] | null = null): { thickness: number; width: number } {
  const { NI, NJ, NK, vol0, F, pz, dz } = sim;
  const i0 = sample ? sample[0] : Math.floor(NI / 4);
  const i1 = sample ? sample[1] + 1 : Math.max(i0 + 2, Math.ceil((3 * NI) / 4));
  const m = NJ * NK;
  let vol = 0;
  let hw = 0;
  for (let i = i0; i < i1; i++) {
    for (let p = i * m; p < (i + 1) * m; p++) {
      const o = 9 * p;
      vol += vol0[p] * (F[o] * (F[o + 4] * F[o + 8] - F[o + 5] * F[o + 7]) - F[o + 1] * (F[o + 3] * F[o + 8] - F[o + 5] * F[o + 6]) + F[o + 2] * (F[o + 3] * F[o + 7] - F[o + 4] * F[o + 6]));
    }
    for (let j = 0; j < NJ; j++) {
      const p = sim.lattice(i, j, NK - 1);
      hw += pz[p] + 0.5 * dz * F[9 * p + 8];
    }
  }
  hw /= (i1 - i0) * NJ;
  const length = ((columnX(sim, i1 - 1) - columnX(sim, i0)) * (i1 - i0)) / (i1 - 1 - i0);
  return { thickness: (2 * sim.rollShare * vol) / (length * hw), width: 2 * hw };
}

/**
 * The steadily rolled stretch of strip that is out of the rolls, as lattice columns [first, last] (last nearer the
 * head), or null while it is shorter than 2 h0: from one entry thickness past the roll centres to a contact length
 * short of the head (tandem.ts steadySample). Every point of the stretch has to be on the grid.
 */
export function steadySample3(sim: Sim3): [number, number] | null {
  const x0 = sim.params.rolling.h0;
  // with rolls that follow the pass: only what went through the settled rolls
  const x1 = Math.min(sim.headX() - sim.contactLength, sim.settledLength());
  if (Number.isNaN(x1)) return null;
  let first = -1;
  let last = -1;
  let xFirst = 0;
  let xLast = 0;
  for (let i = sim.NI - 1; i >= 0; i--) {
    const x = columnX(sim, i);
    if (x > x1) continue;
    if (!(x >= x0)) {
      if (!Number.isNaN(x)) break;
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

/** A crack through the whole section: three neighbouring lattice columns that have a failed point at every (j, k) between them. */
export function separated3(sim: Sim3): boolean {
  if (sim.nFailed === 0) return false;
  const { NI, failed } = sim;
  const m = sim.NJ * sim.NK;
  for (let i = 0; i + 2 < NI; i++) {
    let all = true;
    for (let q = 0; q < m && all; q++) all = failed[i * m + q] === 1 || failed[(i + 1) * m + q] === 1 || failed[(i + 2) * m + q] === 1;
    if (all) return true;
  }
  return false;
}

/**
 * Handoff 'crop': the middle of the strip the next stand takes, as lattice columns [first, last] of `sim` (the stand
 * about to roll it), or null when the strip is not longer than that (it is carried whole, as with 'done'). As long
 * as the next stand needs to get steady (steadyLength3 at the entry thickness h0 (1 − r)): a column's pitch grows from
 * dp to dp / (1 − r) through the pass, less the spread (a tenth over for it), and a column over at each end.
 */
export function cropColumns3(sim: Sim3): [number, number] | null {
  const P = sim.params;
  const r = P.rolling;
  const next: Solid3Params = { ...cloneParams(P), solid: { ...P.solid } };
  next.rolling.h0 = r.h0 * (1 - r.reduction);
  delete next.rolling.lengthMode;
  const need = steadyLength3(next);
  const cols = Math.ceil(((need * (1 - r.reduction)) / sim.dp) * 1.1) + 2;
  if (cols >= sim.NI - 2) return null;
  const first = Math.floor((sim.NI - cols) / 2);
  return [first, first + cols - 1];
}

/** the crop is out of the rolls: every point of its columns on the grid and its tail end past the exit probe */
export function cropOut3(sim: Sim3, crop: [number, number]): boolean {
  for (let i = crop[0]; i <= crop[1]; i++) if (Number.isNaN(columnX(sim, i))) return false;
  return columnX(sim, crop[0]) >= sim.xExitProbe;
}

/**
 * The next stand's Sim3 with the strip that came out of `old` (tandem.ts remap, a dimension up): entry thickness
 * h1 and width w1 (measured), a new regular lattice; with the whole strip its length is what the mass gives,
 * with a `crop` (handoff 'crop') what the mass of the crop's columns gives, with a `sample` what the next stand
 * needs to get steady (steadyLength3), the sample's columns repeated along x, each old column with as many new
 * ones as the masses' ratio. A new point's parent: the same row through the thickness, the same share of the way
 * across the width, along x by the material. It takes the parent's stresses, pressure, εp, temperature, damage
 * indicators and failure, and starts undeformed up to its volume (F = ∛J I with ln J = −p / K, so the pressure
 * stays what it was).
 * The strip's shape comes along: a new point's y and z are the old strip's, read at the new point's place in the
 * lattice (bilinear in the old lattice's indices, extrapolated past the outermost centres), so the crown and the
 * edge's barrel go into the next stand instead of a rectangular block (which lost 8–16 µm of shape at W 6 mm).
 * - with a `sample` the shape is the old strip's section averaged along x over the sample: the steady section,
 *   the same all along the new strip
 * - with the whole strip or a crop it is column by column along x: the section averaged over the middle half, and
 *   each column's own departure from it (in y, z and x: the plan view's outline, the thickness and the width
 *   along the strip, the ends' faces) smoothed along x over about 2 h1 (two running means of 2w + 1 columns). The
 *   lattice-period stripes of the old pass (±2 µm at 4 cells) are not carried (they made the next stand's gauge hunt
 *   and rolls that follow the pass never settle); what varies over millimetres is. A new point's volume is its
 *   share of the section where it sits (the spacing of the carried y and z against the new lattice's), scaled so
 *   that the strip's volume is the lattice's, and its mass is the strip's over the points (equal).
 */
export function remap3(
  old: Sim3,
  base: Solid3Params,
  h1: number,
  w1: number,
  sample: [number, number] | null = null,
  simOpts: Sim3Options = {},
  crop: [number, number] | null = null,
): Sim3 {
  const P: Solid3Params = { ...cloneParams(base), solid: { ...base.solid, width: w1 } };
  const rho = P.material.rho * P.numerics.massScale;
  P.rolling.h0 = h1;
  P.defects = [];
  // the section's shape comes from the old strip (below), not from the entry crown input
  delete P.solid.crownIn;
  delete P.rolling.lengthMode;
  const m = old.NJ * old.NK;
  // the old columns the new strip is made of (tail to head)
  const c0 = crop ? crop[0] : 0;
  const c1 = crop ? crop[1] : old.NI - 1;
  const range = sample ?? crop;
  // the strain the strip brings in: where rolls that follow the pass start from, and what the slab method's line needs
  {
    let ep = 0;
    let c = 0;
    for (let p = 0; p < old.n; p++) {
      const i = Math.floor(p / m);
      if (!old.active[p] || (range && (i < range[0] || i > range[1]))) continue;
      ep += old.ep[p];
      c++;
    }
    P.rolling.entryStrain = c ? ep / c : 0;
  }
  // the solved part's mass (the quarter's, or the half's with the whole thickness)
  const parts = old.fullThickness ? 2 : 4;
  let M = 0;
  if (sample) {
    P.rolling.sheetLength = steadyLength3(P);
    M = (rho * h1 * w1 * P.rolling.sheetLength) / parts;
  } else {
    for (let p = c0 * m; p < (c1 + 1) * m; p++) if (old.active[p]) M += old.mass[p];
    P.rolling.sheetLength = (parts * M) / (rho * h1 * w1);
  }
  const sim = new Sim3(P, simOpts);
  const n = sim.n;
  const K = sim.el.K;
  // new columns per old column: the ratio of the masses of a lattice column, old to new
  const share = (old.dp * old.params.rolling.h0 * old.halfWidth0) / (sim.dp * h1 * sim.halfWidth0);
  const len = sample ? sample[1] - sample[0] + 1 : 0;
  const nc = c1 - c0 + 1;
  const mass = M / n;
  const cell = sim.dp * sim.dp * sim.dz;
  let nFailed = 0;
  const parentOf = new Int32Array(n);
  // the old strip's section: y and z of each (row, column) averaged over the sample, or the middle half of the columns
  const meanY = new Float64Array(m);
  const meanZ = new Float64Array(m);
  {
    const i0 = sample ? sample[0] : c0 + Math.floor(nc / 4);
    const i1 = sample ? sample[1] : Math.max(i0, c0 + Math.ceil((3 * nc) / 4) - 1);
    const cnt = new Int32Array(m);
    for (let io = i0; io <= i1; io++) {
      for (let q = 0; q < m; q++) {
        const p = io * m + q;
        if (!old.active[p]) continue;
        meanY[q] += old.py[p];
        meanZ[q] += old.pz[p];
        cnt[q]++;
      }
    }
    for (let q = 0; q < m; q++) {
      const c = cnt[q];
      const j = Math.floor(q / old.NK);
      const k = q % old.NK;
      // a section with no active point anywhere: the undeformed lattice position
      meanY[q] = c ? meanY[q] / c : (j + 0.5 - old.jOff) * old.dp;
      meanZ[q] = c ? meanZ[q] / c : (k + 0.5) * old.dz;
    }
  }
  // the shape at a continuous lattice index (jf, kf) of a section (m values from `o`): bilinear between the four
  // centres around it, linear past the outermost ones (a new point nearer the surface than any old centre)
  const at = (arr: Float64Array, o: number, jf: number, kf: number): number => {
    const j0 = Math.max(0, Math.min(old.NJ - 2, Math.floor(jf)));
    const k0 = Math.max(0, Math.min(old.NK - 2, Math.floor(kf)));
    const tj = old.NJ > 1 ? jf - j0 : 0;
    const tk = old.NK > 1 ? kf - k0 : 0;
    const j1 = Math.min(old.NJ - 1, j0 + 1);
    const k1 = Math.min(old.NK - 1, k0 + 1);
    return (
      (1 - tj) * (1 - tk) * arr[o + j0 * old.NK + k0] +
      (1 - tj) * tk * arr[o + j0 * old.NK + k1] +
      tj * (1 - tk) * arr[o + j1 * old.NK + k0] +
      tj * tk * arr[o + j1 * old.NK + k1]
    );
  };
  // column by column (the whole strip or a crop): each old column's departure from the mean section in y, z and x
  // (x from the column's mean), smoothed along x
  const along = !sample;
  const dY = along ? new Float64Array(nc * m) : null;
  const dZ = along ? new Float64Array(nc * m) : null;
  const dX = along ? new Float64Array(nc * m) : null;
  if (dY && dZ && dX) {
    for (let c = 0; c < nc; c++) {
      const io = c0 + c;
      let sx = 0;
      let cx = 0;
      for (let q = 0; q < m; q++) {
        const p = io * m + q;
        if (!old.active[p]) continue;
        sx += old.px[p];
        cx++;
      }
      if (!cx) continue;
      const xm = sx / cx;
      for (let q = 0; q < m; q++) {
        const p = io * m + q;
        if (!old.active[p]) continue;
        dY[c * m + q] = old.py[p] - meanY[q];
        dZ[c * m + q] = old.pz[p] - meanZ[q];
        dX[c * m + q] = old.px[p] - xm;
      }
    }
    // two running means of 2w + 1 columns (a triangle about 4w columns wide, 2 h1 of the rolled strip), cut short at the ends
    const pitch = old.dp / (1 - old.params.rolling.reduction);
    const w = Math.max(1, Math.round(h1 / (2 * pitch)));
    const tmp = new Float64Array(nc);
    for (const arr of [dY, dZ, dX]) {
      for (let q = 0; q < m; q++) {
        for (let pass = 0; pass < 2; pass++) {
          for (let c = 0; c < nc; c++) {
            let s = 0;
            let cn = 0;
            for (let d = Math.max(0, c - w); d <= Math.min(nc - 1, c + w); d++) {
              s += arr[d * m + q];
              cn++;
            }
            tmp[c] = s / cn;
          }
          for (let c = 0; c < nc; c++) arr[c * m + q] = tmp[c];
        }
      }
    }
  }
  // the carried shape at (continuous old column iof, jf, kf): the mean section and, along, the column's departure
  // (linear between the two columns around iof)
  const shapeAt = (mean: Float64Array, dev: Float64Array | null, iof: number, jf: number, kf: number): number => {
    let v = at(mean, 0, jf, kf);
    if (dev) {
      const f = Math.max(0, Math.min(nc - 1, iof - c0));
      const a = Math.min(nc - 1, Math.floor(f));
      const b = Math.min(nc - 1, a + 1);
      const t = f - a;
      v += (1 - t) * at(dev, a * m, jf, kf) + t * at(dev, b * m, jf, kf);
    }
    return v;
  };
  const zeros = new Float64Array(m);
  // a new point's share of the section (along only): the carried rows' and columns' spacing against the new lattice's
  const cellShare = along ? new Float64Array(n) : null;
  let shareSum = 0;
  for (let q = 0; q < n; q++) {
    const i = Math.floor(q / (sim.NJ * sim.NK));
    const j = Math.floor(q / sim.NK) % sim.NJ;
    const k = q % sim.NK;
    const fromHead = sim.NI - 1 - i + 0.5;
    const s = (fromHead / sim.NI) * nc;
    const io = sample ? sample[1] - (Math.floor(fromHead / share) % len) : c1 - Math.min(nc - 1, Math.floor(s));
    const iof = c1 + 0.5 - s;
    const jf = ((j + 0.5) / sim.NJ) * old.NJ - 0.5;
    const kf = ((k + 0.5) / sim.NK) * old.NK - 0.5;
    const jo = Math.max(0, Math.min(old.NJ - 1, Math.round(jf)));
    const ko = Math.max(0, Math.min(old.NK - 1, Math.round(kf)));
    const p = old.lattice(io, jo, ko);
    parentOf[q] = p;
    // the shape: y and z where the old strip has them; the symmetry planes are not crossed
    const yq = shapeAt(meanY, dY, iof, jf, kf);
    sim.py[q] = sim.fullThickness ? yq : Math.max(0.25 * sim.dp, yq);
    sim.pz[q] = Math.max(0.25 * sim.dz, shapeAt(meanZ, dZ, iof, jf, kf));
    if (dX) sim.px[q] += shapeAt(zeros, dX, iof, jf, kf);
    if (cellShare) {
      const hj = (0.5 * old.NJ) / sim.NJ;
      const hk = (0.5 * old.NK) / sim.NK;
      const fy = (shapeAt(meanY, dY, iof, jf + hj, kf) - shapeAt(meanY, dY, iof, jf - hj, kf)) / sim.dp;
      const fz = (shapeAt(meanZ, dZ, iof, jf, kf + hk) - shapeAt(meanZ, dZ, iof, jf, kf - hk)) / sim.dz;
      cellShare[q] = Math.max(0.5, Math.min(2, fy)) * Math.max(0.5, Math.min(2, fz));
      shareSum += cellShare[q];
    }
    sim.sxx[q] = old.sxx[p];
    sim.syy[q] = old.syy[p];
    sim.szz[q] = old.szz[p];
    sim.sxy[q] = old.sxy[p];
    sim.syz[q] = old.syz[p];
    sim.szx[q] = old.szx[p];
    sim.pres[q] = old.pres[p];
    sim.ep[q] = old.ep[p];
    sim.temp[q] = old.temp[p];
    sim.seq[q] = old.seq[p];
    sim.eta[q] = old.eta[p];
    sim.dJC[q] = old.dJC[p];
    sim.dHM[q] = old.dHM[p];
    sim.dCL[q] = old.dCL[p];
    // the pusher's column stays whole (Sim3.fail)
    sim.failed[q] = i === 0 ? 0 : old.failed[p];
    if (sim.failed[q]) nFailed++;
    const J = Math.exp(-old.pres[p] / K);
    const sc = Math.cbrt(J);
    sim.F[9 * q] = sc;
    sim.F[9 * q + 4] = sc;
    sim.F[9 * q + 8] = sc;
    sim.vol0[q] = cell / J;
    sim.mass[q] = mass;
  }
  // the points' volumes by their share of the section, the strip's volume the lattice's
  if (cellShare) for (let q = 0; q < n; q++) sim.vol0[q] *= (cellShare[q] * n) / shareSum;
  sim.nFailed = nFailed;
  sim.firstCrack = old.firstCrack;
  sim.parentOf = parentOf;
  return sim;
}
