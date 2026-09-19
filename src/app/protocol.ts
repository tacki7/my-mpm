// Messages between the page and the simulation worker.
import type { SimParams } from '../mpm/params.ts';
import type { Crack, Diagnostics, FieldName } from '../mpm/solver.ts';
import type { StandResult } from '../mpm/tandem.ts';

export type ToWorker =
  /** stands: a tandem of that many stands (1: the single stand as before) */
  | { type: 'init'; params: SimParams; stands: number; field: FieldName; stopAfter: number | null }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'field'; field: FieldName }
  /** the material point the stress explorer follows (null: none) */
  | { type: 'select'; particle: number | null }
  /** send the in-plane principal stresses with each frame (for the direction glyphs) */
  | { type: 'dirs'; on: boolean };

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
  /** the stand it started in (0 in a single pass), and its time and step on the whole pass's clock */
  stand: number;
  tPass: number;
  stepPass: number;
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
  /** porosity (GTN; 0 with von Mises) */
  por: number;
  /** min det of the acoustic tensor / elastic (1 when the point is not flowing) and whether it has reached 0 (damage model 'localization') */
  loc: number;
  locHit: boolean;
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
  /** the stand of each (η, εp, D) sample (0 first; all 0 with one stand) */
  stand: number[];
}

export interface Frame {
  type: 'frame';
  /** x, y per particle [m] */
  pos: Float32Array;
  /** deformation gradient of each particle, F00 F01 F10 F11 (its cell is drawn as F times the initial square) */
  F: Float32Array;
  /** in-plane principal stresses when asked for: angle of σI from x [rad], σI ≥ σII [MPa] */
  dirs: Float32Array | null;
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
  /** the stand shown (0 first) of `stands`; the time and steps of the stands before (the whole pass: offset + diag) */
  stand: number;
  stands: number;
  tOffset: number;
  stepOffset: number;
  /** the finished stands */
  results: StandResult[];
  /** the whole pass is over (one stand: its phase is done or stalled; a tandem: the last stand is closed) */
  passDone: boolean;
}

/** A stand finished: its last frame and geometry (the page keeps them), its result, and the next stand's geometry. */
export interface StandMessage {
  type: 'stand';
  stand: number;
  frame: Frame;
  geometry: Geometry;
  result: StandResult;
  next: Geometry | null;
  /** the same stand's picture again (another field or the principal directions): only the frame changes */
  refresh?: boolean;
}

export type FromWorker =
  | { type: 'ready'; geometry: Geometry }
  | Frame
  | StandMessage
  | { type: 'error'; message: string };
