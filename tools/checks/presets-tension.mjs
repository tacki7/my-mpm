// The front-tension preset breaks the strip past the exit, in the free strip between the
// rolls and the gripped head (not in the grip, where the tension is put in), while the rolls
// still hold it (neutral point inside the bite); the same rolling without front tension does
// not crack. Coarse grid (4 cells) to stay fast; docs/presets.md has 6 and 8 cells.
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { presetById } from '../../src/mpm/presets.ts';

function run(tf, maxSteps) {
  const P = presetById('front-tension').build();
  P.numerics.cellsThrough = 4;
  if (tf !== undefined) P.rolling.frontTension = tf;
  const sim = new Sim(P);
  const xn = [];
  let d;
  while (sim.step < maxSteps) {
    for (let k = 0; k < 250; k++) sim.advance();
    d = sim.diagnostics();
    if (d.phase === 'steady' && d.nFailed === 0 && d.neutralX != null) xn.push(d.neutralX);
    if (d.nFailed > 0 || d.phase === 'done') break;
  }
  return { sim, d, xn };
}

const cracked = run(undefined, 40000);
const { sim, d } = cracked;
ok(sim.cracks.length > 0, 'front tension 580 MPa: the strip cracks', `${d.nFailed} failed points at step ${d.step}`);
if (sim.cracks.length > 0) {
  const c = sim.cracks[0];
  const grip = sim.gripCols * sim.dp;
  ok(c.x > 0, 'the first crack is past the exit plane', `x ${(c.x * 1e3).toFixed(2)} mm`);
  ok(c.sheetX > grip + sim.dp, 'it is outside the gripped head', `${(c.sheetX * 1e3).toFixed(2)} mm from the head, grip ${(grip * 1e3).toFixed(2)} mm`);
  ok(sim.params.rolling.sheetLength - c.sheetX > grip + sim.dp, 'and not at the tail', `${((sim.params.rolling.sheetLength - c.sheetX) * 1e3).toFixed(2)} mm from the tail`);
  between(c.eta, 0.4, 1, 'it fails in tension (plane-strain tension η = 0.58)');
  const L = sim.contactLength;
  const xnMean = cracked.xn.reduce((a, b) => a + b, 0) / Math.max(1, cracked.xn.length);
  ok(cracked.xn.length > 5 && xnMean > -0.95 * L, 'the rolls still hold the strip before it breaks (neutral point inside the bite)', `mean xn ${(xnMean * 1e3).toFixed(2)} mm, contact ${(L * 1e3).toFixed(2)} mm, ${cracked.xn.length} samples`);
}
// the grip: points there are shown damaged but do not fail. On this grid the grip's own damage
// stays below 1 (0.54), on 6 cells it reaches 3 before the strip breaks: push it past 1 and go on
{
  const inGrip = [];
  for (let p = 0; p < sim.n; p++) if (sim.inGrip(p)) inGrip.push(p);
  const ep0 = inGrip.map((p) => sim.ep[p]);
  for (const p of inGrip) sim.dCL[p] = 1.5;
  for (let k = 0; k < 1000; k++) sim.advance();
  const flowed = inGrip.filter((p, i) => sim.ep[p] > ep0[i]).length;
  const failed = inGrip.filter((p) => sim.failed[p]).length;
  ok(inGrip.length > 0 && flowed > 0 && failed === 0, 'gripped points with damage past 1 keep flowing without failing', `${inGrip.length} in the grip, ${flowed} flowed, ${failed} failed`);
}
// the same rolling without front tension, a little past the step the tensioned one cracked
const calm = run(0, d.step + 1000);
ok(calm.d.nFailed === 0, 'without front tension the same rolling does not crack', `${calm.d.nFailed} failed by step ${calm.d.step}, max damage ${calm.d.maxDamage.toFixed(3)}`);
done();
