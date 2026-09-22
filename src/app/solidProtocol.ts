// Messages between the page and the three-dimensional model's worker (src/app/solid.worker.ts).
import type { SimParams } from '../mpm/params.ts';
import type { SolidCrack, SolidPhase, SolidSettings } from '../mpm/solid/sim3.ts';
import type { SolidLook, SolidSteady } from '../mpm/solid/steady.ts';
import type { Stand3Result } from '../mpm/solid/tandem3.ts';
import type { Handoff, TandemStop } from '../mpm/tandem.ts';
import type { Face } from '../mpm/solid/surface.ts';
import type { GpuInfo } from '../mpm/solid/gpu/stepper.ts';
import type { Track } from './protocol.ts';

/** what the strip's faces can be coloured by */
export type SolidFieldName = 'seq' | 'ep' | 'pres' | 'eta' | 'sxx' | 'syy' | 'szz' | 'damage' | 'spread';
/** the order of the fields in a face's `vals`: every frame carries all of them, so the page colours the strip by
 *  itself (a field tab needs no round trip to the worker) and a recorded frame can be shown in any field */
export const SOLID_FIELD_IDS: readonly SolidFieldName[] = ['seq', 'ep', 'pres', 'eta', 'sxx', 'syy', 'szz', 'damage', 'spread'];

export type ToSolidWorker =
  | { type: 'init'; params: SimParams; solid: SolidSettings; stands: number; handoff: Handoff; stopAfter: number | null; compute: Compute; threads: number }
  | { type: 'run' }
  | { type: 'pause' }
  /** the interval between frames [ms]; 0 for the worker's own (src/app/frameRate.ts) */
  | { type: 'frame-ms'; ms: number };

/** where the step runs: the CPU (advance, f64), or a WebGPU device (Sim3.advanceBatch, f32, batches of steps) */
export type Compute = 'cpu' | 'gpu';

/** Fixed facts of a stand, sent after init and again when a tandem's next stand starts. Lengths in m. */
export interface SolidGeometry {
  /** where the step runs, and the device; `gpuNote`: why it is the CPU although the GPU was asked for */
  compute: Compute;
  gpu: GpuInfo | null;
  gpuNote: string | null;
  /** the threads the CPU's step runs on (a team, src/mpm/solid/team.ts; 1 alone); `threadsNote`: why fewer than asked for */
  threads: number;
  threadsNote: string | null;
  /** the stand (0 first) of `stands` */
  stand: number;
  stands: number;
  /** the strip's length (with the length 'steady': what the steady looks need) */
  sheetLength: number;
  n: number;
  lattice: [number, number, number];
  h: number;
  dt: number;
  h0: number;
  gap: number;
  rollRadius: number;
  contactLength: number;
  xExitProbe: number;
  halfWidth0: number;
  /** the strip's crown at the entry [m] (Sim3 crownIn: a parabola, h0 at the mid-width) */
  crownIn: number;
  /** the whole thickness solved with both rolls (Sim3 fullThickness); else the top quarter, mirrored in the picture */
  fullThickness: boolean;
  /** the contact pressure map's first x column [m] */
  mapX0: number;
  /** the plane-strain slab method's roll force per unit width for these conditions [N/m] */
  slabForce: number;
}

export interface SolidDiag {
  /** the running clock over the stands so far */
  t: number;
  step: number;
  stand: number;
  /** the last stand has ended, a stand stalled, or the tandem stopped (`stopped` says why) */
  finished: boolean;
  stopped: TandemStop | null;
  /** the rolls now: the radius in the contact (R' while a flattened roll follows the force), the gap, and whether they have settled (true with rolls that are not adjusted) */
  rollRadius: number;
  gap: number;
  rollsSettled: boolean;
  /** the roll's deflection away from the strip now, at the mid-width and at the strip's edge [m]; null with a rigid roll */
  rollBend: { centre: number; edge: number; settled: boolean } | null;
  phase: SolidPhase;
  /** how far the running stand is through its pass, 0..1 (src/mpm/progress.ts) */
  progress: number;
  /** the last look (every READ_STEPS steps) */
  now: SolidLook | null;
  steady: SolidSteady | null;
  nFailed: number;
  maxDamage: number;
  firstCrack: SolidCrack | null;
  inertiaRatio: number;
  /** the strip tensions applied now, after ramping [Pa] (Sim3.updateTension): the back one is let go once the tail is at the rolls */
  backTension: number;
  frontTension: number;
}

export interface SolidFrame {
  type: 'frame';
  faces: Face[];
  /** half width along the strip (the edge's outer face) [m], by lattice column from the tail */
  edgeX: Float32Array;
  edgeHalfWidth: Float32Array;
  diag: SolidDiag;
  /**
   * t [s] (the running clock), roll force [N] and stand of the looks since the frame before: rows `from` onward
   * of the run's history, which the page keeps whole (a frame carrying it all would grow with the run, and the
   * tape keeps hundreds of frames)
   */
  history: { from: number; t: number[]; force: number[]; stand: number[] };
  /** the points on the fracture locus: the first to fail and the most damaged (tracker3.ts) */
  tracks: Track[];
  running: boolean;
  msPerStep: number;
}

export type FromSolidWorker = { type: 'ready'; geometry: SolidGeometry } | { type: 'stand'; result: Stand3Result } | SolidFrame | { type: 'error'; message: string };
