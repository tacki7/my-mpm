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
// The new strip is a rectangular block: the exit section's shape (the edge's bulge, the thickness falling or
// rising toward the edge) is not carried, its mean thickness and width are.
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
  /** how it ended: 'done', 'steady' (handed on while it rolled steadily), or 'stalled' */
  phase: 'done' | 'steady' | 'stalled';
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
  // rolls that follow the pass settle 1.5 transit times after the head is out, and the stretch is the strip rolled after that (tandem.ts)
  const settle = s.rollsAdjusted ? 2 * s.contactLength + 3 * r.h0 * (1 - r.reduction) : 0;
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

  constructor(params: Solid3Params, stands = 1, handoff: Handoff = 'done', simOpts: Sim3Options = {}) {
    if (!(Number.isInteger(stands) && stands >= 1 && stands <= MAX_STANDS)) throw new Error(`stands must be 1 to ${MAX_STANDS}`);
    this.stands = stands;
    this.handoff = handoff;
    this.base = withSteadyLength3(params);
    this.simOpts = simOpts;
    this.sim = new Sim3(this.base, simOpts);
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
    }
    return look;
  }

  private endStand(phase: 'done' | 'steady' | 'stalled', sample: [number, number] | null = null): void {
    const old = this.sim;
    const result = close(old, this.stand, phase, this.sampler.means(old), sample);
    this.results.push(result);
    const more = this.stand + 1 < this.stands;
    if (more) {
      const whole = result.thicknessOut > 0 && result.widthOut > 0;
      this.stopped = phase === 'stalled' ? 'stalled' : result.separated ? 'separated' : result.massLost > 0 || !whole ? 'lost' : null;
    }
    const next = more && !this.stopped ? remap3(old, this.base, result.thicknessOut, result.widthOut, sample, this.simOpts) : null;
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
  }
}

function close(sim: Sim3, stand: number, phase: 'done' | 'steady' | 'stalled', steady: SolidSteady | null, sample: [number, number] | null): Stand3Result {
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
  return { thickness: (2 * vol) / (length * hw), width: 2 * hw };
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
 * The next stand's Sim3 with the strip that came out of `old` (tandem.ts remap, a dimension up): entry thickness
 * h1 and width w1 (measured), a new regular lattice; with the whole strip its length is what the mass gives,
 * with a `sample` what the next stand needs to get steady (steadyLength3), the sample's columns repeated along x,
 * each old column with as many new ones as the masses' ratio. A new point's parent: the same row through the
 * thickness, the same share of the way across the width, along x by the material. It takes the parent's stresses,
 * pressure, εp, temperature, damage indicators and failure, and starts undeformed up to its volume
 * (F = ∛J I with ln J = −p / K, so the pressure stays what it was).
 * The strip's shape comes along: a new point's y and z are the old column's, read at the new point's place in the
 * lattice (bilinear in the old lattice's indices, extrapolated past the outermost centres), so the crown and the
 * edge's barrel go into the next stand instead of a rectangular block (which lost 8–16 µm of shape at W 6 mm). The
 * shape is the old strip's section averaged along x (over the steady sample, or the middle half of a whole strip):
 * the lattice-period stripes of the old pass (±2 µm at 4 cells) are not carried, since they would make the next
 * stand's gauge hunt and rolls that follow the pass never settle. Along x the new lattice is regular; the head's
 * and the tail's shapes are not carried.
 */
export function remap3(old: Sim3, base: Solid3Params, h1: number, w1: number, sample: [number, number] | null = null, simOpts: Sim3Options = {}): Sim3 {
  const P: Solid3Params = { ...cloneParams(base), solid: { ...base.solid, width: w1 } };
  const rho = P.material.rho * P.numerics.massScale;
  P.rolling.h0 = h1;
  P.defects = [];
  // the section's shape comes from the old strip (below), not from the entry crown input
  delete P.solid.crownIn;
  delete P.rolling.lengthMode;
  // the strain the strip brings in: where rolls that follow the pass start from, and what the slab method's line needs
  {
    const m = old.NJ * old.NK;
    let ep = 0;
    let c = 0;
    for (let p = 0; p < old.n; p++) {
      const i = Math.floor(p / m);
      if (!old.active[p] || (sample && (i < sample[0] || i > sample[1]))) continue;
      ep += old.ep[p];
      c++;
    }
    P.rolling.entryStrain = c ? ep / c : 0;
  }
  // the quarter's mass
  let M = 0;
  if (sample) {
    P.rolling.sheetLength = steadyLength3(P);
    M = (rho * h1 * w1 * P.rolling.sheetLength) / 4;
  } else {
    for (let p = 0; p < old.n; p++) if (old.active[p]) M += old.mass[p];
    P.rolling.sheetLength = (4 * M) / (rho * h1 * w1);
  }
  const sim = new Sim3(P, simOpts);
  const n = sim.n;
  const K = sim.el.K;
  // new columns per old column: the ratio of the masses of a lattice column, old to new
  const share = (old.dp * old.params.rolling.h0 * old.halfWidth0) / (sim.dp * h1 * sim.halfWidth0);
  const len = sample ? sample[1] - sample[0] + 1 : 0;
  const mass = M / n;
  const cell = sim.dp * sim.dp * sim.dz;
  let nFailed = 0;
  const parentOf = new Int32Array(n);
  // the old strip's section: y and z of each (row, column) averaged over the sampled columns along x
  const meanY = new Float64Array(old.NJ * old.NK);
  const meanZ = new Float64Array(old.NJ * old.NK);
  {
    const i0 = sample ? sample[0] : Math.floor(old.NI / 4);
    const i1 = sample ? sample[1] : Math.ceil((3 * old.NI) / 4) - 1;
    const cnt = new Int32Array(old.NJ * old.NK);
    for (let io = i0; io <= i1; io++) {
      for (let j = 0; j < old.NJ; j++) {
        for (let k = 0; k < old.NK; k++) {
          const p = old.lattice(io, j, k);
          if (!old.active[p]) continue;
          meanY[j * old.NK + k] += old.py[p];
          meanZ[j * old.NK + k] += old.pz[p];
          cnt[j * old.NK + k]++;
        }
      }
    }
    for (let q = 0; q < meanY.length; q++) {
      const c = cnt[q];
      const j = Math.floor(q / old.NK);
      const k = q % old.NK;
      // a section with no active point anywhere: the undeformed lattice position
      meanY[q] = c ? meanY[q] / c : (j + 0.5) * old.dp;
      meanZ[q] = c ? meanZ[q] / c : (k + 0.5) * old.dz;
    }
  }
  // the mean section's shape at a continuous lattice index (jf, kf): bilinear between the four centres around it,
  // linear past the outermost ones (a new point nearer the surface than any old centre)
  const at = (arr: Float64Array, jf: number, kf: number): number => {
    const j0 = Math.max(0, Math.min(old.NJ - 2, Math.floor(jf)));
    const k0 = Math.max(0, Math.min(old.NK - 2, Math.floor(kf)));
    const tj = old.NJ > 1 ? jf - j0 : 0;
    const tk = old.NK > 1 ? kf - k0 : 0;
    const j1 = Math.min(old.NJ - 1, j0 + 1);
    const k1 = Math.min(old.NK - 1, k0 + 1);
    return (
      (1 - tj) * (1 - tk) * arr[j0 * old.NK + k0] +
      (1 - tj) * tk * arr[j0 * old.NK + k1] +
      tj * (1 - tk) * arr[j1 * old.NK + k0] +
      tj * tk * arr[j1 * old.NK + k1]
    );
  };
  for (let q = 0; q < n; q++) {
    const i = Math.floor(q / (sim.NJ * sim.NK));
    const j = Math.floor(q / sim.NK) % sim.NJ;
    const k = q % sim.NK;
    const fromHead = sim.NI - 1 - i + 0.5;
    const io = sample ? sample[1] - (Math.floor(fromHead / share) % len) : old.NI - 1 - Math.min(old.NI - 1, Math.floor((fromHead / sim.NI) * old.NI));
    const jf = ((j + 0.5) / sim.NJ) * old.NJ - 0.5;
    const kf = ((k + 0.5) / sim.NK) * old.NK - 0.5;
    const jo = Math.max(0, Math.min(old.NJ - 1, Math.round(jf)));
    const ko = Math.max(0, Math.min(old.NK - 1, Math.round(kf)));
    const p = old.lattice(io, jo, ko);
    parentOf[q] = p;
    // the shape: y and z where the old column has them; the symmetry planes are not crossed
    sim.py[q] = Math.max(0.25 * sim.dp, at(meanY, jf, kf));
    sim.pz[q] = Math.max(0.25 * sim.dz, at(meanZ, jf, kf));
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
    const s = Math.cbrt(J);
    sim.F[9 * q] = s;
    sim.F[9 * q + 4] = s;
    sim.F[9 * q + 8] = s;
    sim.vol0[q] = cell / J;
    sim.mass[q] = mass;
  }
  sim.nFailed = nFailed;
  sim.firstCrack = old.firstCrack;
  sim.parentOf = parentOf;
  return sim;
}
