// Messages between the page and the three-dimensional model's worker (src/app/solid.worker.ts).
import type { SimParams } from '../mpm/params.ts';
import type { SolidCrack, SolidPhase, SolidSettings } from '../mpm/solid/sim3.ts';
import type { SolidLook, SolidSteady } from '../mpm/solid/steady.ts';
import type { Stand3Result } from '../mpm/solid/tandem3.ts';
import type { Handoff, TandemStop } from '../mpm/tandem.ts';
import type { Face } from '../mpm/solid/surface.ts';

/** what the strip's faces can be coloured by */
export type SolidFieldName = 'seq' | 'ep' | 'pres' | 'eta' | 'sxx' | 'syy' | 'szz' | 'damage' | 'spread';

export type ToSolidWorker =
  | { type: 'init'; params: SimParams; solid: SolidSettings; stands: number; handoff: Handoff; field: SolidFieldName; stopAfter: number | null }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'field'; field: SolidFieldName };

/** Fixed facts of a stand, sent after init and again when a tandem's next stand starts. Lengths in m. */
export interface SolidGeometry {
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
  phase: SolidPhase;
  /** the last look (every READ_STEPS steps) */
  now: SolidLook | null;
  steady: SolidSteady | null;
  nFailed: number;
  maxDamage: number;
  firstCrack: SolidCrack | null;
  inertiaRatio: number;
}

export interface SolidFrame {
  type: 'frame';
  faces: Face[];
  field: SolidFieldName;
  /** half width along the strip (the edge's outer face) [m], by lattice column from the tail */
  edgeX: Float32Array;
  edgeHalfWidth: Float32Array;
  diag: SolidDiag;
  /** t [s] (the running clock), roll force [N] and stand of every look so far */
  history: { t: number[]; force: number[]; stand: number[] };
  running: boolean;
  msPerStep: number;
}

export type FromSolidWorker = { type: 'ready'; geometry: SolidGeometry } | { type: 'stand'; result: Stand3Result } | SolidFrame | { type: 'error'; message: string };
