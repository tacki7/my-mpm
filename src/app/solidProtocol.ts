// Messages between the page and the three-dimensional model's worker (src/app/solid.worker.ts).
import type { SimParams } from '../mpm/params.ts';
import type { SolidCrack, SolidPhase, SolidSettings } from '../mpm/solid/sim3.ts';
import type { SolidLook, SolidSteady } from '../mpm/solid/steady.ts';
import type { Face } from '../mpm/solid/surface.ts';

/** what the strip's faces can be coloured by */
export type SolidFieldName = 'seq' | 'ep' | 'pres' | 'eta' | 'sxx' | 'syy' | 'szz' | 'damage' | 'spread';

export type ToSolidWorker =
  | { type: 'init'; params: SimParams; solid: SolidSettings; field: SolidFieldName; stopAfter: number | null }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'field'; field: SolidFieldName };

/** Fixed facts of a run, sent once after init. Lengths in m. */
export interface SolidGeometry {
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
  t: number;
  step: number;
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
  /** t [s] and roll force [N] of every look so far */
  history: { t: number[]; force: number[] };
  running: boolean;
  msPerStep: number;
}

export type FromSolidWorker = { type: 'ready'; geometry: SolidGeometry } | SolidFrame | { type: 'error'; message: string };
