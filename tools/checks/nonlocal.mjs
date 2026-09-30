// The nonlocal average of the damage increments (Sim.nonlocalAverage): a uniform
// field stays the same, Σ m·v is kept (the B-spline weights are a partition of
// unity), a single point spreads only within the kernel's reach (3 cells) and
// wider with more passes (about √passes), and the passes follow the length ℓ.
// The grip of a tension does not fail on the nonlocal path either (about 2 s).
// @check
import { ok, between, near, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const P = defaultParams();
P.numerics.cellsThrough = 6;
P.rolling.sheetLength = 6e-3;
const sim = new Sim(P);
const n = sim.n;
const fresh = (v) => [Float64Array.from({ length: n }, (_, p) => (typeof v === 'function' ? v(p) : v))];

// a uniform field
for (const passes of [1, 4]) {
  const u = fresh(1);
  sim.nonlocalAverage(u, passes);
  const worst = u[0].reduce((w, v) => Math.max(w, Math.abs(v - 1)), 0);
  between(worst, 0, 1e-12, `a uniform field stays uniform (${passes} passes, worst |v − 1|)`);
}

// one point in the middle of the sheet
const mid = (() => {
  let best = 0;
  let bd = Infinity;
  const cx = sim.x0.reduce((a, b) => a + b, 0) / n;
  for (let p = 0; p < n; p++) {
    const d = Math.hypot(sim.x0[p] - cx, sim.y0[p]);
    if (d < bd) [bd, best] = [d, p];
  }
  return best;
})();
const spread = (passes) => {
  const v = fresh((p) => (p === mid ? 1 : 0));
  const before = sim.mass[mid] * 1;
  sim.nonlocalAverage(v, passes);
  // along x (the lattice is the same both ways): the kernel reaches 3 cells, its spread (std) is per axis
  let sum = 0;
  let m2 = 0;
  let reach = 0;
  for (let p = 0; p < n; p++) {
    const w = sim.mass[p] * v[0][p];
    sum += w;
    const dx = Math.abs(sim.px[p] - sim.px[mid]);
    m2 += w * dx * dx;
    if (v[0][p] > 0) reach = Math.max(reach, dx, Math.abs(sim.py[p] - sim.py[mid]));
  }
  return { v: v[0], sum, before, std: Math.sqrt(m2 / sum), reach };
};
const one = spread(1);
near(one.sum, one.before, 1e-12, 'Σ m·v is kept by a pass');
ok(one.v[mid] < 1 && one.v[mid] > 0, 'the point keeps part of its value', `${one.v[mid].toFixed(3)}`);
between(one.reach / sim.h, 1, 3, 'one pass reaches no farther than the kernel (3 cells along each axis)');
between(one.std / sim.h, 0.5, 0.95, 'one pass spreads it by about 0.71 cell along an axis (std)');
const four = spread(4);
near(four.sum, four.before, 1e-12, 'Σ m·v is kept by four passes');
between(four.std / one.std, 1.6, 2.4, 'four passes spread it about twice as far (√4)');

// passes for a length
ok(sim.nonlocalPasses(0.1 * sim.h) === 1 && sim.nonlocalPasses(sim.h) === 2 && sim.nonlocalPasses(2 * sim.h) === 8, 'passes = max(1, round(2 (ℓ/h)²))');

// The grip of a tension does not fail (Sim.inGrip), on the nonlocal path as on the local one: it did until
// 2026-09-30, and a failed point in the grip went on carrying the tension with no deviator. With the front tension
// on and ℓ = h (4 cells, 6 mm), the head's last 2 × gripCols columns are given damage 1: the next step fails every
// one of them outside the grip and none inside.
{
  const Q = defaultParams();
  Q.numerics.cellsThrough = 4;
  Q.rolling.sheetLength = 6e-3;
  Q.rolling.frontTension = 100e6;
  Q.damage.nonlocalLength = Q.rolling.h0 / 4;
  const s = new Sim(Q);
  while (s.step < 40000 && !(s.frontNow > 0)) s.advance();
  ok(s.frontNow > 0 && s.params.damage.model === 'johnson-cook' && s.nonlocalPasses(Q.damage.nonlocalLength) === 2, 'the front tension is on, Johnson-Cook, 2 passes', `step ${s.step}, ${(s.frontNow * 1e-6).toFixed(2)} MPa`);
  const given = [];
  for (let p = 0; p < s.n; p++) {
    if (!s.active[p] || s.li[p] < s.NI - 2 * s.gripCols) continue;
    s.dJC[p] = 1;
    given.push(p);
  }
  const grip = given.filter((p) => s.inGrip(p));
  const outside = given.filter((p) => !s.inGrip(p));
  ok(grip.length > 0 && outside.length > 0, 'points given damage in and outside the grip', `${grip.length} in, ${outside.length} outside`);
  s.advance();
  const gripFailed = grip.filter((p) => s.failed[p] === 1).length;
  const outsideFailed = outside.filter((p) => s.failed[p] === 1).length;
  ok(gripFailed === 0, 'no point in the grip fails', `${gripFailed} of ${grip.length}`);
  ok(outsideFailed === outside.length, 'every point outside it does', `${outsideFailed} of ${outside.length}`);
  ok(s.frontNow > 0 && s.endLoad(2) > 0, 'the tension stays on the intact grip', `${(s.endLoad(2) * 1e-3).toFixed(2)} kN/m`);
}
done();
