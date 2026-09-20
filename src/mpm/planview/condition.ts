// A plan-view condition from the section model's conditions (rolling, material, damage, numerics)
// and the width settings; tools/planview.mjs and the page build it the same way.
import type { SimParams } from '../params.ts';
import { planParams, type PlanSimParams } from './sim.ts';

export interface PlanSettings {
  /** full strip width at the entry [m] */
  width: number;
  /** grid cells across the half width */
  cells: number;
  /** radius of a semicircular notch cut into the edge half-way along the strip [m] (0: none) */
  notch: number;
  /** the scattered edge band, from each edge [m] (docs/model.md「端の延性のばらつき」) */
  edgeWidth: number;
  /** the largest relative drop of the ductility in that band (0: no scatter, the default) */
  edgeAmount: number;
  /** how far along the rolling direction one drawn value holds [m] (0: per point) */
  edgeLength: number;
  /** the seed, so that the same conditions give the same strip */
  edgeSeed: number;
}

export const PLAN_DEFAULTS: PlanSettings = {
  width: 20e-3,
  cells: 10,
  notch: 0,
  edgeWidth: 1e-3,
  edgeAmount: 0,
  edgeLength: 1e-3,
  edgeSeed: 1,
};

/**
 * The section model's defects are not carried over (their y is a thickness position, not a place
 * across the width); the plan view's only defect is the edge notch.
 */
export function planCondition(base: SimParams, s: PlanSettings): PlanSimParams {
  const P = planParams(base, s.width, s.cells);
  P.defects = s.notch > 0 ? [{ kind: 'void', x: base.rolling.sheetLength / 2, y: s.width / 2, ax: s.notch, ay: s.notch }] : [];
  // amount 0 leaves the ductility alone (the default), and the strip is the one every earlier run had
  P.plan.edgeScatter = { width: s.edgeWidth, amount: s.edgeAmount, length: s.edgeLength, seed: s.edgeSeed };
  return P;
}
