// Where a pass begins and ends (Sim.phase, Sim3.phase, PlanSim.phase; docs/validation.md「終わる位置」): the strip starts
// with its head just short of the bite (START_STEPS = 100 steps before the corner meets the roll: a point is against
// the roll by step 2 × START_STEPS at the latest), and the pass is 'done' as soon as the tail is past the exit plane
// and no point is against a roll any more — before the tail is 2 h0 past, where it ended before. Each model's `touching`
// reads the contact flags of the last step (the section's touch bits, the 3D model's touch, the plan view's contact
// pressure). The steps saved are the tail's way from that point to 2 h0. Section 6 cells L 8 mm (~6 s), 3D W 2 mm
// R 10 mm 4 cells (~20 s), plan view W 10 mm L 8 mm (~10 s).
// Calibrated on a copy (2026-09-30): with each model's `touching` forced true (the end at 2 h0 as before) the
// "before 2 h0", "no point against a roll" and "steps saved" items fail (3 per model).
// @check
import { ok, between, done } from './lib.mjs';
import { defaultParams, START_STEPS } from '../../src/mpm/params.ts';
import { Sim } from '../../src/mpm/solver.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { PlanSim, planParams } from '../../src/mpm/planview/sim.ts';

const LOOK = 50;

/**
 * Run a model to 'done' looking every LOOK steps: the first look with a point against a roll, the phases in order,
 * the tail and the contact at 'done'; then on until the tail is 2 h0 past the exit (the end before T121)
 */
function run(sim, maxSteps) {
  const h0 = sim.params.rolling.h0;
  let firstTouch = null;
  const phases = [];
  let ph;
  do {
    for (let k = 0; k < LOOK; k++) sim.advance();
    if (firstTouch === null && sim.touching()) firstTouch = sim.step;
    ph = sim.phase();
    if (phases[phases.length - 1] !== ph) phases.push(ph);
  } while (ph !== 'done' && ph !== 'stalled' && sim.step < maxSteps);
  const doneStep = sim.step;
  const tail = sim.tailX();
  const touching = sim.touching();
  while (sim.tailX() <= 2 * h0 && sim.step < doneStep + 20000) sim.advance();
  return { h0, firstTouch, phases, doneStep, tail, touching, saved: sim.step - doneStep };
}

function judge(name, r) {
  ok(r.firstTouch !== null && r.firstTouch <= 2 * START_STEPS, `${name}: a point is against a roll by 2 × START_STEPS (the head starts just short of the bite)`, `first at step ${r.firstTouch}`);
  ok(r.phases[r.phases.length - 1] === 'done' && r.phases[r.phases.length - 2] === 'tail-out', `${name}: 'tail-out' then 'done'`, r.phases.join(' '));
  between(r.tail, 0, r.h0, `${name}: at 'done' the tail is past the exit plane and before 2 h0 (it ended early) [m]`);
  ok(!r.touching, `${name}: at 'done' no point is against a roll`);
  ok(r.saved >= LOOK, `${name}: the way on to 2 h0 past the exit, no longer computed, is steps`, `${r.saved} steps of ${r.doneStep} saved (${((100 * r.saved) / (r.doneStep + r.saved)).toFixed(1)} %)`);
}

// ── the section model: the standard preset on 6 cells, an 8 mm strip
{
  const P = defaultParams();
  P.numerics.cellsThrough = 6;
  P.rolling.sheetLength = 8e-3;
  judge('section', run(new Sim(P), 60000));
}

// ── the 3D model: W 2 mm on a 10 mm roll, 4 cells (the roll-bend check's pass)
{
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 12e-3;
  P.rolling.rollRadius = 10e-3;
  P.damage.model = 'none';
  judge('3D', run(new Sim3(solidParams(P, { width: 2e-3, planeStrain: false })), 60000));
}

// ── the plan view: W 10 mm, 10 cells over the half-width, an 8 mm strip
{
  const P = defaultParams();
  P.rolling.sheetLength = 8e-3;
  P.damage.model = 'none';
  judge('plan view', run(new PlanSim(planParams(P, 10e-3, 10)), 60000));
}

done();
