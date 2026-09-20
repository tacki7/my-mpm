// The plan view's total roll load is right; how it is spread across the width is not (T49, T71).
// A 40 mm wide strip (W/h0 40, half width 20 cells of 1 mm, 56 mm long: the steady window needs
// twice max(8 mm, half width) and 8 mm) rolls in the standard condition, and the load over the
// whole half width, divided by the half width, has to be the section model's plane-strain load,
// 3.17 kN/mm, within 3 %. Measured 3.201 (W/h0 20 to 200 and both grids give 3.185 to 3.201,
// docs/validation.md「平面図モデル」).
//
// What this does not look at is the middle: it is 4.24 kN/mm here, +33 % over plane strain, and
// moves 5 % with the grid alone (3.935 to 3.756 at W/h0 100 when h halves), so it is not a gate.
// The check reads the total, so it does not care where along the width the load sits: a copy that
// forces v_z = 0 everywhere (no flow across the width) has the middle at 3.18 instead of 4.24 and
// the same total, 3.190 instead of 3.201. What it does catch is a wrong total: a copy with the
// contact pressure 5 % up (the point's pressure in the x force and in the load) gives 3.346 and fails.
// @check
import { ok, between, done } from './lib.mjs';
import { PlanSim } from '../../src/mpm/planview/sim.ts';
import { PLAN_DEFAULTS, planCondition } from '../../src/mpm/planview/condition.ts';
import { SAMPLE_STEPS, SteadySampler } from '../../src/mpm/planview/steady.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const PLANE_STRAIN = 3.17; // kN/mm, the section model (10 cells 3.11, 6 cells 3.24), docs/validation.md

const base = defaultParams();
base.rolling.sheetLength = 56e-3;
base.damage.model = 'none';
const sim = new PlanSim(planCondition(base, { ...PLAN_DEFAULTS, width: 40e-3, cells: 20 }));
const sampler = new SteadySampler(null);
while (sim.step < 200000) {
  for (let k = 0; k < SAMPLE_STEPS; k++) sim.advance();
  if (sampler.look(sim) === 'done') break;
}
const m = sampler.means(sim.halfWidth0);
ok(m.samples > 0, 'the strip is long enough for a steady window', `${m.samples} of ${m.looks} looks, ${sim.step} steps`);
const mean = m.forceHalfWidth / sim.halfWidth0 * 1e-6; // N over m → kN/mm
between(mean, PLANE_STRAIN * 0.97, PLANE_STRAIN * 1.03, 'half-width mean load is the plane-strain load ±3 %');
console.log(`      (the middle is ${(m.forcePerWidthByZ[0] * 1e-6).toFixed(2)} kN/mm here, not checked)`);
done();
