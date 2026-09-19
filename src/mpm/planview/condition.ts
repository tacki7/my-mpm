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
}

export const PLAN_DEFAULTS: PlanSettings = { width: 20e-3, cells: 10, notch: 0 };

export function planCondition(base: SimParams, s: PlanSettings): PlanSimParams {
  const P = planParams(base, s.width, s.cells);
  if (s.notch > 0) P.defects = [{ kind: 'void', x: base.rolling.sheetLength / 2, y: s.width / 2, ax: s.notch, ay: s.notch }];
  return P;
}
