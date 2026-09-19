// A failed point drops its stress in the step it fails, not one step later: the next p2g spreads
// the stored stress (sxx, syy, sxy, pres) to the grid, so a point still holding its tension then
// pulls on its neighbours once more after it has cracked. Checked right after every step on the
// points that failed in it, with the local and the nonlocal damage and both ways of treating a
// failed point. Also: with no failure criterion ('none') the damage shown is the largest of the
// three indicators that are integrated anyway (it was always 0).
// Coarse grid (4 cells, a 6 mm strip; front tension with a low Cockcroft-Latham limit so the head
// fails soon after it leaves the rolls).
// @check
import { ok, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { presetById } from '../../src/mpm/presets.ts';
import { defaultParams } from '../../src/mpm/params.ts';

function failing(failure, nonlocal, want) {
  const P = presetById('front-tension').build();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 6e-3;
  P.damage.clCrit = 0.05;
  P.damage.failure = failure;
  P.damage.nonlocalLength = nonlocal;
  const s = new Sim(P);
  const was = new Uint8Array(s.n);
  let fresh = 0;
  let worst = 0; // largest deviatoric stress or tension a point kept at the end of the step it failed in [Pa]
  let pressure = 0; // largest compressive pressure a freshly failed point kept [Pa]
  while (s.step < 20000 && fresh < want && s.phase() !== 'done') {
    s.advance();
    for (let p = 0; p < s.n; p++) {
      if (!s.failed[p] || was[p]) continue;
      was[p] = 1;
      fresh++;
      worst = Math.max(worst, Math.abs(s.sxx[p]), Math.abs(s.syy[p]), Math.abs(s.szz[p]), Math.abs(s.sxy[p]), s.seq[p], -s.pres[p]);
      pressure = Math.max(pressure, s.pres[p]);
    }
  }
  return { s, fresh, worst, pressure };
}

for (const [failure, nonlocal] of [
  ['tension-cut', 0],
  ['erode', 0.3e-3],
]) {
  const name = `${failure}, ${nonlocal ? `nonlocal ${nonlocal * 1e3} mm` : 'local'}`;
  const r = failing(failure, nonlocal, 20);
  ok(r.fresh >= 10, `${name}: points fail (front tension, CL 0.05)`, `${r.fresh} by step ${r.s.step}`);
  ok(r.worst === 0, `${name}: a point holds no deviatoric stress and no tension at the end of the step it fails in`, `largest kept ${(r.worst * 1e-6).toFixed(1)} MPa over ${r.fresh} points`);
  if (failure === 'erode') ok(r.pressure === 0, `${name}: eroded, it keeps no pressure either`, `${(r.pressure * 1e-6).toFixed(1)} MPa`);
  // the crack record keeps the stress state at failure (read before the stress is dropped)
  const c = r.s.cracks[0];
  ok(!!c && c.seq > 50e6 && c.s1 > 0, `${name}: the crack record keeps the stress at failure`, c ? `σeq ${(c.seq * 1e-6).toFixed(0)} MPa, σ1 ${(c.s1 * 1e-6).toFixed(0)} MPa, η ${c.eta.toFixed(2)}` : 'no crack');
}

// ── no failure criterion: the damage shown is the largest of the three integrated indicators
{
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 6e-3;
  P.damage.model = 'none';
  const s = new Sim(P);
  // stop with the strip in the bite (a 6 mm strip on this grid has hardly any steady phase)
  while (s.step < 20000 && !['steady', 'tail-out', 'done'].includes(s.phase())) s.advance();
  let most = 0;
  let same = true;
  for (let p = 0; p < s.n; p++) {
    if (!s.active[p]) continue;
    const m = Math.max(s.dJC[p], s.dHM[p], s.dCL[p]);
    most = Math.max(most, m);
    if (s.governingDamage(p) !== m) same = false;
  }
  const d = s.diagnostics();
  ok(most > 0 && same, "'none': each point's damage is the largest of JC, HM and CL", `largest ${most.toFixed(4)} (step ${s.step}, ${d.phase})`);
  ok(most > 0 && Math.abs(d.maxDamage - most) <= 1e-12 * most, "'none': the largest damage in the results is that value, not 0", `${d.maxDamage.toFixed(4)}`);
  ok(d.nFailed === 0, "'none': and nothing fails", `${d.nFailed} failed`);
}
done();
