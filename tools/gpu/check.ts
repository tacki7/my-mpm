// The GPU step (src/mpm/solid/gpu) against the CPU's, in a browser with WebGPU (tools/browser/gpu.mjs drives it):
// - in sync: the same state stepped once on each side, field by field (the largest |GPU − CPU| over the field's
//   largest |CPU|), then a batch of CTL_EVERY steps the same way
// - whole passes to steady on each side, the steady means compared (force, thickness, spread, slip, the bend)
// The conditions cover the tensions, the roll's adjustment (Hitchcock + reduction control), the bending and a
// damage model, so that every uniform and every kernel path is exercised.
import { defaultParams, type SimParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams, type Solid3Params } from '../../src/mpm/solid/sim3.ts';
import { CTL_EVERY } from '../../src/mpm/solver.ts';
import { READ_STEPS, SolidSampler, type SolidSteady } from '../../src/mpm/solid/steady.ts';
import { requestGpu } from '../../src/mpm/solid/gpu/stepper.ts';

export type Variant = 'plain' | 'tension' | 'adjust' | 'bend' | 'damage';

/** the damage variant's D2 (the section model's checks make a crack with 0.15 at 6 cells; the coarse 3D lattice needs less) */
let D2 = 0.05;

function params(v: Variant, W: number, cells: number): Solid3Params {
  const P: SimParams = defaultParams();
  P.numerics.cellsThrough = cells;
  // the adjusted rolls hunt about the gauge's window for a while (±1.5 µm on the gap at 4 cells): a 12 mm strip
  // is out before they settle, and 24 mm settles on one side only
  P.rolling.sheetLength = v === 'adjust' ? 36e-3 : 12e-3;
  P.damage.model = v === 'damage' ? 'johnson-cook' : 'none';
  if (v === 'damage') P.damage.D2 = D2;
  if (v === 'tension') {
    P.rolling.backTension = 30e6;
    P.rolling.frontTension = 30e6;
  }
  if (v === 'adjust') {
    P.rolling.flattening = 'hitchcock';
    P.rolling.gapControl = 'reduction';
  }
  const solid = { width: W * 1e-3, ...(v === 'bend' ? { rollBend: { barrel: 0.3, span: 0.4 } } : {}) };
  return solidParams(P, solid);
}

const FIELDS: [string, (s: Sim3) => ArrayLike<number>, number][] = [
  ['px', (s) => s.px, 1], ['py', (s) => s.py, 1], ['pz', (s) => s.pz, 1],
  ['vx', (s) => s.vx, 1], ['vy', (s) => s.vy, 1], ['vz', (s) => s.vz, 1],
  ['C', (s) => s.C, 9], ['F', (s) => s.F, 9],
  ['sxx', (s) => s.sxx, 1], ['syy', (s) => s.syy, 1], ['szz', (s) => s.szz, 1], ['sxy', (s) => s.sxy, 1], ['syz', (s) => s.syz, 1], ['szx', (s) => s.szx, 1],
  ['pres', (s) => s.pres, 1], ['ep', (s) => s.ep, 1], ['temp', (s) => s.temp, 1], ['seq', (s) => s.seq, 1], ['eta', (s) => s.eta, 1],
  ['dJC', (s) => s.dJC, 1], ['dHM', (s) => s.dHM, 1], ['dCL', (s) => s.dCL, 1], ['touch', (s) => s.touch, 1], ['active', (s) => s.active, 1], ['failed', (s) => s.failed, 1],
];

/** per field: the largest |GPU − CPU| over the field's largest |CPU| (0 where the field is all zero on both sides) */
function compare(c: Sim3, g: Sim3): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, get, stride] of FIELDS) {
    const a = get(c);
    const b = get(g);
    let md = 0;
    let mx = 0;
    let at = -1;
    for (let p = 0; p < c.n; p++) {
      if (!c.active[p] && !g.active[p]) continue;
      for (let k = 0; k < stride; k++) {
        const i = stride * p + k;
        const d = Math.abs(a[i] - b[i]);
        if (d > md) {
          md = d;
          at = i;
        }
        mx = Math.max(mx, Math.abs(a[i]));
      }
    }
    out[name] = mx > 0 ? md / mx : md;
    if (at >= 0 && out[name] > 1e-3) {
      out[name + '@'] = at;
      out[name + ':cpu'] = a[at];
      out[name + ':gpu'] = b[at];
      const p = Math.floor(at / stride);
      out[name + ':y'] = c.py[p];
      out[name + ':x'] = c.px[p];
      out[name + ':touch'] = c.touch[p];
    }
  }
  const scal = (name: string, a: number, b: number) => {
    out[name] = Math.abs(a) > 0 ? Math.abs(a - b) / Math.abs(a) : Math.abs(a - b);
  };
  scal('roll.R', c.roll.R, g.roll.R);
  scal('roll.cy', c.roll.cy, g.roll.cy);
  scal('gap', c.gap, g.gap);
  scal('backNow', c.backNow, g.backNow);
  scal('frontNow', c.frontNow, g.frontNow);
  scal('plasticWork', c.plasticWork, g.plasticWork);
  scal('nFailed', c.nFailed, g.nFailed);
  scal('bend', c.bend[1], g.bend[1]);
  const rc = c.readContact();
  const rg = g.readContact();
  scal('force', rc?.force ?? 0, rg?.force ?? 0);
  scal('torque', rc?.torque ?? 0, rg?.torque ?? 0);
  return out;
}

export interface SyncResult {
  variant: Variant;
  steps: number;
  one: Record<string, number>;
  batch: Record<string, number>;
}

/** the same state stepped once, then CTL_EVERY steps, on each side */
export async function sync(device: GPUDevice, v: Variant, W = 2, cells = 4, steps = 1600, noFollow: boolean | 'cpu' | 'gpu' = false): Promise<SyncResult> {
  const c = new Sim3(params(v, W, cells));
  const g = new Sim3(params(v, W, cells));
  const off = (s: Sim3) => ((s as unknown as { followRoll: () => [number, number] }).followRoll = () => [0, 0]);
  for (let i = 0; i < steps; i++) {
    c.advance();
    g.advance();
  }
  c.readContact();
  g.readContact();
  // the stage left out of the compared step only (the states before it are the same)
  if (noFollow === true || noFollow === 'cpu') off(c);
  await g.attachGpu(device);
  g.gpu!.skipFollow = noFollow === true || noFollow === 'gpu';
  c.advance();
  await g.advanceBatch(1);
  const one = compare(c, g);
  // the batch from the CPU's state again, so that the two errors do not add
  const g2 = new Sim3(params(v, W, cells));
  for (let i = 0; i < steps + 1; i++) g2.advance();
  g2.readContact();
  await g2.attachGpu(device);
  g2.gpu!.skipFollow = noFollow === true || noFollow === 'gpu';
  const K = CTL_EVERY - ((steps + 1) % CTL_EVERY);
  for (let i = 0; i < K; i++) c.advance();
  await g2.advanceBatch(K);
  const batch = compare(c, g2);
  g.detachGpu();
  g2.detachGpu();
  return { variant: v, steps, one, batch };
}

export interface PassResult {
  variant: Variant;
  cpu: SolidSteady | null;
  gpu: SolidSteady | null;
  cpuMs: number;
  gpuMs: number;
  cpuSteps: number;
  gpuSteps: number;
  cpuCrack: number | null;
  gpuCrack: number | null;
  cpuFailed: number;
  gpuFailed: number;
  /** at the end: the phase, the roll's radius and the gap (the adjusted rolls), the deflection at the mid-width */
  cpuEnd: EndState;
  gpuEnd: EndState;
  cpuTrace: Row[];
  gpuTrace: Row[];
}

interface EndState {
  phase: string;
  R: number;
  gap: number;
  settled: boolean;
  bend: number;
  nFailed: number;
}

function endState(s: Sim3): EndState {
  return { phase: s.phase(), R: s.roll.R, gap: s.gap, settled: s.rollsSettled, bend: s.bend[1], nFailed: s.nFailed };
}

/** steps per GPU batch (CTL_EVERY, the worker's; 1 tells the batch-coarse controls from a difference in the step) */
let BATCH = CTL_EVERY;

/** a look's row of the control trajectory: step, phase, force, gap, R, the gauge's thickness, the exit probe's, the head */
type Row = [number, string, number, number, number, number, number, number, number, number];

/** the mean J over the active points (volume-weighted), and over the ones behind the bite (x < −contact length: not yet deformed) */
function meanJ(s: Sim3): [number, number] {
  let v = 0, v0 = 0, vb = 0, vb0 = 0;
  for (let p = 0; p < s.n; p++) {
    if (!s.active[p]) continue;
    const o = 9 * p;
    const J = s.F[o] * (s.F[o + 4] * s.F[o + 8] - s.F[o + 5] * s.F[o + 7]) - s.F[o + 1] * (s.F[o + 3] * s.F[o + 8] - s.F[o + 5] * s.F[o + 6]) + s.F[o + 2] * (s.F[o + 3] * s.F[o + 7] - s.F[o + 4] * s.F[o + 6]);
    v += s.vol0[p] * J;
    v0 += s.vol0[p];
    if (s.px[p] < -s.contactLength) {
      vb += s.vol0[p] * J;
      vb0 += s.vol0[p];
    }
  }
  return [v / v0, vb0 ? vb / vb0 : NaN];
}

async function pass(sim: Sim3, device: GPUDevice | null, trace?: Row[]): Promise<{ means: SolidSteady | null; ms: number; steps: number }> {
  const sampler = new SolidSampler();
  let looks = 0;
  const t0 = performance.now();
  if (device) await sim.attachGpu(device);
  while (sim.step < 60000) {
    if (device) {
      for (let k = 0; k < READ_STEPS; k += BATCH) await sim.advanceBatch(BATCH);
    } else {
      for (let k = 0; k < READ_STEPS; k++) sim.advance();
    }
    if (trace) {
      const m = sim.gauge();
      const ex = sim.exitMeasure();
      trace.push([sim.step, sim.phase(), sampler.last?.force ?? NaN, sim.gap, sim.roll.R, m?.thickness ?? NaN, ex ? 2 * ex.halfThickness[0] : NaN, sim.headX(), ...meanJ(sim)]);
    }
    const look = sampler.look(sim);
    if (look.phase === 'steady') looks++;
    if (looks >= 4 || look.phase === 'done' || look.phase === 'stalled') break;
  }
  const ms = performance.now() - t0;
  sim.detachGpu();
  return { means: sampler.means(sim), ms, steps: sim.step };
}

/** whole passes to steady on each side (device null: the CPU against itself with h0 moved by 1e-7, the noise the condition's controls carry) */
export async function passes(device: GPUDevice | null, v: Variant, W = 2, cells = 4): Promise<PassResult> {
  const c = new Sim3(params(v, W, cells));
  const P = params(v, W, cells);
  if (!device) P.rolling.h0 *= 1 + 1e-7;
  const g = new Sim3(P);
  const cpuTrace: Row[] = [];
  const gpuTrace: Row[] = [];
  const rc = await pass(c, null, cpuTrace);
  const rg = await pass(g, device, gpuTrace);
  return {
    variant: v, cpu: rc.means, gpu: rg.means, cpuMs: rc.ms, gpuMs: rg.ms, cpuSteps: rc.steps, gpuSteps: rg.steps,
    cpuCrack: c.firstCrack?.step ?? null, gpuCrack: g.firstCrack?.step ?? null, cpuFailed: c.nFailed, gpuFailed: g.nFailed,
    cpuEnd: endState(c), gpuEnd: endState(g), cpuTrace, gpuTrace,
  };
}

const api = {
  async gpu() {
    const r = await requestGpu();
    return r ? r.info : null;
  },
  async sync(v: Variant, W?: number, cells?: number, steps?: number, noFollow?: boolean | 'cpu' | 'gpu') {
    const r = await requestGpu();
    if (!r) throw new Error('no WebGPU');
    const out = await sync(r.device, v, W, cells, steps, noFollow);
    r.device.destroy();
    return out;
  },
  async passes(v: Variant, W?: number, cells?: number, d2?: number, batch?: number) {
    const r = await requestGpu();
    if (!r) throw new Error('no WebGPU');
    if (d2 !== undefined) D2 = d2;
    if (batch !== undefined) BATCH = batch;
    const out = await passes(r.device, v, W, cells);
    r.device.destroy();
    return out;
  },
  async noise(v: Variant, W?: number, cells?: number, d2?: number) {
    if (d2 !== undefined) D2 = d2;
    return passes(null, v, W, cells);
  },
};
(window as unknown as { __gpucheck: typeof api }).__gpucheck = api;
