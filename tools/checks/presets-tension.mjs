// The front-tension preset shows a threshold: the strip past the exit breaks once the front
// tension exceeds the rolled strip's plane-strain flow stress 2k (the slab method's value at
// the exit), and not below it. Where it breaks is not the point — it moves with the grid and,
// at high tension, with the grip's length (docs/presets.md). Also the grip rule: gripped points
// do not fail while a tension is on, and do before it is. Coarse grid (4 cells) to stay fast.
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { presetById } from '../../src/mpm/presets.ts';
import { karman } from '../../src/mpm/slab.ts';

function build(tf) {
  const P = presetById('front-tension').build();
  P.numerics.cellsThrough = 4;
  if (tf !== undefined) P.rolling.frontTension = tf;
  return P;
}
const P0 = build();
const slab = karman({ ...P0.rolling, frontTension: 0 }, P0.material);
const twoK = slab.twoK[slab.twoK.length - 1];
between(P0.rolling.frontTension / twoK, 1.05, 1.15, 'the preset pulls at about 1.1 × the exit strip\'s 2k', `${(P0.rolling.frontTension * 1e-6).toFixed(0)} MPa, 2k ${(twoK * 1e-6).toFixed(0)} MPa`);

function run(P, maxSteps) {
  const sim = new Sim(P);
  let d;
  let phaseAtCrack = null;
  while (sim.step < maxSteps) {
    for (let k = 0; k < 250; k++) sim.advance();
    d = sim.diagnostics();
    if (d.nFailed > 0 && !phaseAtCrack) phaseAtCrack = d.phase;
    if (d.nFailed > 0 || d.phase === 'done') break;
  }
  return { sim, d, phaseAtCrack };
}

// ── above 2k: it breaks while rolling steadily, past the exit, in tension
const above = run(P0, 40000);
const c = above.sim.cracks[0];
ok(!!c && above.phaseAtCrack === 'steady', 'the preset (1.1 × 2k) breaks the strip while it is rolled steadily', c ? `step ${c.step}, phase ${above.phaseAtCrack}` : 'no crack');
if (c) {
  ok(c.x > 0, 'past the exit plane', `x ${(c.x * 1e3).toFixed(2)} mm, ${(c.sheetX * 1e3).toFixed(2)} mm from the head`);
  between(c.eta, 0.4, 1, 'in tension (plane-strain tension η = 0.58)');
}

// ── the grip rule: with the front tension on, gripped points pushed past D = 1 keep flowing without failing.
// Read it before the strip breaks: once it has, the faces of the crack separate (the default 'dfg') and the head
// piece flies free, so its points stop flowing and the positive control (flowed > 0) would say nothing
{
  const sim = new Sim(build());
  while (sim.step < 40000 && !(sim.frontNow > 0 && sim.phase() === 'steady')) sim.advance();
  for (let k = 0; k < 250; k++) sim.advance();
  const grip = [];
  for (let p = 0; p < sim.n; p++) if (sim.li[p] >= sim.NI - sim.gripCols && sim.active[p]) grip.push(p);
  const ep0 = grip.map((p) => sim.ep[p]);
  for (const p of grip) sim.dCL[p] = 1.5;
  for (let k = 0; k < 1000; k++) sim.advance();
  const flowed = grip.filter((p, i) => sim.ep[p] > ep0[i]).length;
  const failed = grip.filter((p) => sim.failed[p]).length;
  ok(sim.frontNow > 0 && sim.diagnostics().nFailed === 0 && flowed > 0 && failed === 0, 'front tension on, before the strip breaks: gripped points with damage past 1 keep flowing without failing', `${grip.length} in the head grip, ${flowed} flowed, ${failed} failed`);
}
// ... and before the front tension is switched on (the head still in the bite) they are ordinary points
{
  const sim = new Sim(build());
  while (sim.phase() !== 'bite' && sim.step < 20000) sim.advance();
  for (let k = 0; k < 500; k++) sim.advance();
  const grip = [];
  for (let p = 0; p < sim.n; p++) if (sim.li[p] >= sim.NI - sim.gripCols && sim.active[p]) grip.push(p);
  for (const p of grip) sim.dCL[p] = 1.5;
  for (let k = 0; k < 300; k++) sim.advance();
  const failed = grip.filter((p) => sim.failed[p]).length;
  ok(sim.frontNow === 0 && failed > 0, 'front tension not yet on: the head grip is not protected', `${failed} of ${grip.length} failed while the head is in the bite`);
}

// ── below 2k: no break, a little past the step the preset broke
const below = run(build(0.9 * twoK), above.sim.step + 1000);
ok(below.d.nFailed === 0, '0.9 × 2k: the strip does not break', `${below.d.nFailed} failed by step ${below.d.step}, max damage ${below.d.maxDamage.toFixed(3)}`);
done();
