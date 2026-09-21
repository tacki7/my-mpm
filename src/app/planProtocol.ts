// Messages between the page and the plan-view worker (src/app/plan.worker.ts).
import type { SimParams } from '../mpm/params.ts';
import type { PlanSettings } from '../mpm/planview/condition.ts';
import type { PlanCrack, PlanPhase } from '../mpm/planview/sim.ts';
import type { SteadyMeans } from '../mpm/planview/steady.ts';

/** what the plan view can colour the points by */
export type PlanFieldName = 'sxx' | 'szz' | 'seq' | 'eta' | 'damage' | 'spread';

export type ToPlanWorker =
  | { type: 'init'; params: SimParams; plan: PlanSettings; field: PlanFieldName; stopAfter: number | null }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'field'; field: PlanFieldName };

/** Fixed facts of a plan-view run, sent once after init. Lengths in m. */
export interface PlanGeometry {
  n: number;
  dp: number;
  h: number;
  dt: number;
  h0: number;
  gap: number;
  contactLength: number;
  xExitProbe: number;
  halfWidth0: number;
}

/** The last look (every SAMPLE_STEPS steps) and the steady means so far. */
export interface PlanDiag {
  t: number;
  step: number;
  phase: PlanPhase;
  /** how far the strip is through its pass, 0..1 (src/mpm/progress.ts) */
  progress: number;
  /** at the last look: roll force per roll on the half width since the look before [N], force per unit width
   *  of the middle band [N/m], half width at the exit probe over the initial one − 1, mid thickness there [m] */
  now: { forceHalfWidth: number; forceMid: number; spread: number; centreThick: number } | null;
  steady: SteadyMeans;
  nFailed: number;
  maxDamage: number;
}

export interface PlanCrackView extends PlanCrack {
  /** current centroid of its failed points [m] */
  cx: number;
  cz: number;
}

export interface PlanFrame {
  type: 'frame';
  /** x, z per point [m] (the half width, z ≥ 0) */
  pos: Float32Array;
  /** in-plane deformation gradient F00 F01 F10 F11 (x, z) */
  F: Float32Array;
  /** the selected field per point, in display units (MPa, mm or none) */
  val: Float32Array;
  field: PlanFieldName;
  /** bit 0 active, bit 1 failed */
  flags: Uint8Array;
  diag: PlanDiag;
  cracks: PlanCrackView[];
  running: boolean;
  msPerStep: number;
}

export type FromPlanWorker = { type: 'ready'; geometry: PlanGeometry } | PlanFrame | { type: 'error'; message: string };
