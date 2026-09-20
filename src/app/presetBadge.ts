// Whether the conditions on show are still the preset's own, and the badge in the masthead that says they are not.
// The comparison is the conditions URL's: every readable key and `cond` that conditionsQuery writes because a leaf
// differs from the preset (so the grid and the strip length count too, as the panel sets them).
import type { SimParams } from '../mpm/params.ts';
import { conditionsQuery } from './query.ts';

export function differsFromPreset(presetId: string, preset: SimParams, params: SimParams): boolean {
  for (const key of conditionsQuery(presetId, preset, params).keys()) if (key !== 'preset') return true;
  return false;
}

/** the grid, the mass scaling and the strip's length, which the measured ranges are quoted over, not against */
const NOT_THE_CONDITION = ['preset', 'cells', 'ms', 'L'];

/** true when the sheet, the rolls, the lubrication, the tensions, the material and the damage are the preset's */
export function samePassAsPreset(presetId: string, preset: SimParams, params: SimParams): boolean {
  for (const key of conditionsQuery(presetId, preset, params).keys()) if (!NOT_THE_CONDITION.includes(key)) return false;
  return true;
}

export class PresetBadge {
  private readonly el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    this.el.textContent = '変更あり';
    this.el.title = 'いまの条件は、選ばれている名前付きの条件と違う（パネルの値か URL で変えた）';
    this.el.hidden = true;
  }

  /** after the conditions were applied (or the preset changed) */
  update(presetId: string, preset: SimParams, params: SimParams): void {
    this.el.hidden = !differsFromPreset(presetId, preset, params);
  }
}
