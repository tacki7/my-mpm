// Messages between the page and the simulation worker.
import type { SimParams } from '../mpm/params.ts';
import type { Crack, Diagnostics, FieldName } from '../mpm/solver.ts';

export type ToWorker =
  | { type: 'init'; params: SimParams; field: FieldName; stopAfter: number | null }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'field'; field: FieldName }
  /** the material point the stress explorer follows (null: none) */
  | { type: 'select'; particle: number | null };

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

/** Stress state of one material point (Cauchy stress, Pa; lengths m). */
export interface PointState {
  sxx: number;
  syy: number;
  sxy: number;
  szz: number;
  /** pressure, compression positive */
  pres: number;
  seq: number;
  eta: number;
  s1: number;
  ep: number;
  dJC: number;
  dHM: number;
  dCL: number;
  /** the indicator that decides failure */
  damage: number;
  failed: boolean;
  /** where the point sat in the undeformed sheet: from the head end backwards, from the mid-plane */
  sheetX: number;
  sheetY: number;
  /** current position */
  x: number;
  y: number;
  /** the rate and temperature of the Johnson-Cook fracture strain at this point */
  epsDotStar: number;
  Ts: number;
  /** ductility multiplier of a weak defect (1 elsewhere) */
  duct: number;
}

export type TrackRole = 'selected' | 'first-crack' | 'max-damage';

/** A followed point: its state now and its loading path, flat (η, εp, D) triples ending at the current state. */
export interface Track {
  role: TrackRole;
  id: number;
  state: PointState;
  path: number[];
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
  /** points followed by the stress explorer */
  tracks: Track[];
  running: boolean;
  msPerStep: number;
}

export type FromWorker =
  | { type: 'ready'; geometry: Geometry }
  | Frame
  | { type: 'error'; message: string };
