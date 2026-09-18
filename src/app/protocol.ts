// Messages between the page and the simulation worker.
import type { SimParams } from '../mpm/params.ts';
import type { Crack, Diagnostics, FieldName } from '../mpm/solver.ts';

export type ToWorker =
  | { type: 'init'; params: SimParams; field: FieldName; stopAfter: number | null }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'field'; field: FieldName };

/** Fixed facts of a run, sent once after init. Lengths in m. */
export interface Geometry {
  n: number;
  h0: number;
  gap: number;
  dp: number;
  h: number;
  dt: number;
  contactLength: number;
  xExitProbe: number;
  rolls: { cx: number; cy: number; R: number; omega: number }[];
  rollSpeed: number;
}

export interface CrackView extends Crack {
  /** current centroid of its failed points [m] */
  cx: number;
  cy: number;
}

export interface Frame {
  type: 'frame';
  /** x, y per particle [m] */
  pos: Float32Array;
  /** deformed size of each particle along x, y as multiples of the initial spacing */
  ext: Float32Array;
  /** the selected field per particle */
  val: Float32Array;
  field: FieldName;
  /** bit 0 active, bit 1 failed */
  flags: Uint8Array;
  diag: Diagnostics;
  /** contact tractions along x [m] → [Pa] */
  profile: { x: number[]; p: number[]; tau: number[] };
  cracks: CrackView[];
  running: boolean;
  msPerStep: number;
}

export type FromWorker =
  | { type: 'ready'; geometry: Geometry }
  | Frame
  | { type: 'error'; message: string };
